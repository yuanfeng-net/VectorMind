#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import chokidar, { type FSWatcher } from "chokidar";
import Database from "better-sqlite3";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildServerInstructions } from "./server-instructions.js";
import { listToolDefinitions } from "./tool-catalog.js";
import type {
  ChangeLogRow,
  ExtractedSymbol,
  MemoryItemRow,
  RequirementRow,
  RootSource,
  SymbolRow,
} from "./types.js";
import {
  isProbablySystemDir,
  isProbablyVscodeInstallDir,
  normalizeToDbPath as normalizePathText,
  parseFileUriToPath,
  resolveRootFromEnvOrThrow,
  resolveRootFromToolArgOrThrow,
  resolveSafeFallbackRootDir,
} from "./root.js";
import { buildLargeFileSplitPlan } from "./large-file-split.js";
import {
  IGNORED_LIKE_PATTERNS,
  looksLikeMinifiedBundle,
  shouldIgnoreDbFilePath,
  shouldIgnorePath,
} from "./path-rules.js";
import {
  listProjectFilesInternal,
  normalizeExtensionsFilter,
  readTextFileLines,
  readTextFileSlice,
  resolveCodexTextPath,
  resolveProjectPathUnderRoot,
  resolveReadPathUnderProjectRoot,
} from "./project-files.js";
import { hasUppercaseAscii, runIndexedGrepSearch, runRipgrepSearch } from "./grep.js";
import { compactInstallRtkText, detectRtk, installRtk } from "./rtk-tools.js";
import {
  configurePendingChanges,
  mergePendingWithGit,
  prunePendingChanges,
} from "./pending-changes.js";
import {
  configureTokenSavings,
  tokenSavingsSummary,
  toolCompactOrJson,
  toolText,
} from "./token-savings.js";
import {
  configureFileIndexing,
  flushPendingChangeBuffer,
  indexFile,
  recordPendingChange,
  removeFileIndexes,
} from "./file-indexing.js";
import {
  configureMemoryMaintenance,
  pruneFilenameNoiseIndexes,
  pruneIgnoredIndexesByPathPatterns,
  runAutoMaintenanceIfDue,
  runMemoryMaintenance,
} from "./memory-maintenance.js";
import {
  completeAllActiveRequirementMemoryItems,
  completeRequirementMemoryItemsByReqId,
  configureMemoryMutations,
  supersedeMemoryItemIds,
  supersedeRequirementIds,
} from "./memory-mutations.js";
import {
  BOOTSTRAP_DEFAULT_CONTEXT_KINDS,
  MEMORY_ITEMS_FTS_TABLE,
  buildFtsMatchQuery,
  configureMemoryRecall,
  getConventionPreviews,
  getCurrentContextPreviews,
  getDecisionPreviews,
  isHiddenFromDefaultRecall,
  makePreviewText,
  metadataStatus,
  parseMetadataJson,
  semanticSearchHybridInternal,
  toChangeLogPreview,
  toMemoryItemPreview,
  toRequirementPreview,
} from "./memory-recall.js";
import {
  buildCrossProjectPathWarnings,
  buildDevelopmentWarnings,
  buildFileReadDevelopmentWarnings,
  buildMatchedFileDevelopmentWarnings,
  buildRequirementScopeContract,
  buildRequirementStartWarnings,
  buildScopeDriftWarnings,
  configureDevelopmentWarnings,
  countFileLinesBounded,
  getRequirementScopeContract,
  isDevelopmentWarningBlockingForChangeMode,
  isLikelySourceImplementationFile,
  mergeScopeContracts,
  type ChangeMode,
} from "./development-warnings.js";
import {
  compactBootstrapText,
  compactBrainDumpText,
  compactGrepText,
  compactLargeFileSplitPlanText,
  compactListProjectFilesText,
  compactMaintenanceText,
  compactPreflightChangeScopeText,
  compactQueryCodebaseText,
  compactReadFileLinesText,
  compactReadTextFileText,
  compactSemanticSearchText,
  compactTokenSavingsText,
  safeJson,
  toolJson,
} from "./tool-output.js";
import {
  clearActivityLog,
  configureActivityLogProjectRoot,
  logActivity,
  snapshotActivityLog,
  summarizeActivityEvent,
} from "./activity-log.js";
import {
  AddNoteArgsSchema,
  BootstrapContextArgsSchema,
  ClearActivityLogArgsSchema,
  CompleteRequirementArgsSchema,
  DEFAULT_PREVIEW_CHARS,
  DetectRtkArgsSchema,
  GetActivityLogArgsSchema,
  GetActivitySummaryArgsSchema,
  GetBrainDumpArgsSchema,
  GetPendingChangesArgsSchema,
  GetTokenSavingsArgsSchema,
  GrepArgsSchema,
  InstallRtkArgsSchema,
  ListProjectFilesArgsSchema,
  MaintainMemoryArgsSchema,
  MAX_PENDING_LIMIT,
  PlanLargeFileSplitArgsSchema,
  PreflightChangeScopeArgsSchema,
  PruneIndexArgsSchema,
  QueryCodebaseArgsSchema,
  ReadCodexTextFileArgsSchema,
  ReadFileLinesArgsSchema,
  ReadFileTextArgsSchema,
  ReadMemoryItemArgsSchema,
  RecordLargeFileSplitArgsSchema,
  SemanticSearchArgsSchema,
  StartRequirementArgsSchema,
  SupersedeMemoryArgsSchema,
  SyncChangeIntentArgsSchema,
  UpsertConventionArgsSchema,
  UpsertDecisionArgsSchema,
  UpsertProjectSummaryArgsSchema,
} from "./tool-schemas.js";
import {
  BOOTSTRAP_SEMANTIC_TIMEOUT_MS,
  DEVELOPMENT_HUGE_FILE_LINES,
  INDEX_AUTO_PRUNE_IGNORED,
  INDEX_MAX_CODE_BYTES,
  INDEX_MAX_DOC_BYTES,
  INDEX_SKIP_MINIFIED,
  ROOTS_LIST_TIMEOUT_MS,
  SERVER_NAME,
  SERVER_VERSION,
  debugLogEnabled,
  debugLogMaxEntries,
} from "./config.js";





let initialized = false;
let rootSource: RootSource = "cwd";
let projectRoot = "";
let dbPath = "";

configureActivityLogProjectRoot(() => projectRoot);

let db: Database.Database;
let watcher: FSWatcher | null = null;
let watcherReady = false;
let initializationPromise: Promise<void> | null = null;

let insertRequirementStmt: Database.Statement;
let getActiveRequirementStmt: Database.Statement;
let listActiveRequirementsStmt: Database.Statement;
let listRecentRequirementsStmt: Database.Statement;
let completeAllActiveRequirementsStmt: Database.Statement;
let completeRequirementByIdStmt: Database.Statement;
let completeAllActiveRequirementMemoryItemsStmt: Database.Statement;
let completeRequirementMemoryItemByReqIdStmt: Database.Statement;
let listChangeLogsForRequirementStmt: Database.Statement;
let insertChangeLogStmt: Database.Statement;
let insertMemoryItemStmt: Database.Statement;
let getMemoryItemByIdStmt: Database.Statement;
let getRequirementMemoryItemIdStmt: Database.Statement;
let getConventionByKeyStmt: Database.Statement;
let insertConventionStmt: Database.Statement;
let updateConventionByIdStmt: Database.Statement;
let listConventionsStmt: Database.Statement;
let upsertDecisionStmt: Database.Statement;
let getDecisionByKeyStmt: Database.Statement;
let listCurrentDecisionsStmt: Database.Statement;
let upsertProjectSummaryStmt: Database.Statement;
let getProjectSummaryStmt: Database.Statement;
let listRecentNotesStmt: Database.Statement;
let listRecentContextItemsStmt: Database.Statement;
let getLatestChangeIntentForFileStmt: Database.Statement;
let deleteFileChunkItemsStmt: Database.Statement;
let upsertPendingChangeStmt: Database.Statement;
let listPendingChangesStmt: Database.Statement;
let countPendingChangesStmt: Database.Statement;
let deletePendingChangeStmt: Database.Statement;
let deleteAllPendingChangesStmt: Database.Statement;
let deleteOldPendingChangesStmt: Database.Statement | null = null;
let deleteOldestPendingChangesStmt: Database.Statement | null = null;
let deleteSymbolsForFileStmt: Database.Statement;
let upsertSymbolStmt: Database.Statement;
let searchSymbolsStmt: Database.Statement;
let insertTokenSavingsStmt: Database.Statement;
let summarizeTokenSavingsStmt: Database.Statement;
let summarizeTokenSavingsByToolStmt: Database.Statement;
let listRecentTokenSavingsStmt: Database.Statement;
let getKvStmt: Database.Statement;
let setKvStmt: Database.Statement;

let indexFileSymbolsTx:
  | ((filePath: string, symbols: ExtractedSymbol[]) => void)
  | null = null;


const FTS_TABLE_NAME = MEMORY_ITEMS_FTS_TABLE;
let ftsAvailable = false;

function normalizeToDbPath(inputPath: string): string {
  const normalized = normalizePathText(inputPath);
  if (!normalized || normalized === ".") return ".";
  const abs = path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath);
  const rel = path.relative(projectRoot, abs);
  const inCwd = !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  const candidate = inCwd ? rel : abs;
  return candidate.replace(/\\/g, "/");
}

configureDevelopmentWarnings({
  getProjectRoot: () => projectRoot,
  normalizeToDbPath,
  listActiveRequirements: (limit) => listActiveRequirementsStmt.all(limit) as RequirementRow[],
  getRequirementMemoryItemId: (reqId) => getRequirementMemoryItemIdStmt.get(reqId) as { id: number } | undefined,
  getMemoryItemById: (id) => getMemoryItemByIdStmt.get(id) as MemoryItemRow | undefined,
  parseMetadataJson,
});

configureTokenSavings({
  getDb: () => db,
  getInsertTokenSavingsStatement: () => insertTokenSavingsStmt,
  getSummarizeTokenSavingsStatement: () => summarizeTokenSavingsStmt,
  getSummarizeTokenSavingsByToolStatement: () => summarizeTokenSavingsByToolStmt,
  getListRecentTokenSavingsStatement: () => listRecentTokenSavingsStmt,
});

configurePendingChanges({
  getDb: () => db,
  getProjectRoot: () => projectRoot,
  getCountPendingChangesStatement: () => countPendingChangesStmt,
  getDeleteOldPendingChangesStatement: () => deleteOldPendingChangesStmt,
  getDeleteOldestPendingChangesStatement: () => deleteOldestPendingChangesStmt,
  getFileStateHash,
  getLatestSyncedFileHash,
});

configureMemoryMaintenance({
  getDb: () => db,
  getProjectRoot: () => projectRoot,
  getDbPath: () => dbPath,
  getKvStatement: () => getKvStmt,
  getSetKvStatement: () => setKvStmt,
  getDeleteFileChunkItemsStatement: () => deleteFileChunkItemsStmt,
  getDeleteSymbolsForFileStatement: () => deleteSymbolsForFileStmt,
  getInsertMemoryItemStatement: () => insertMemoryItemStmt,
  sha256Hex,
  parseMetadataJson,
  metadataStatus,
  isHiddenFromDefaultRecall,
});

configureMemoryRecall({
  getDb: () => db,
  getListConventionsStatement: () => listConventionsStmt,
  getListCurrentDecisionsStatement: () => listCurrentDecisionsStmt,
  getListActiveRequirementsStatement: () => listActiveRequirementsStmt,
  getRequirementMemoryItemIdStatement: () => getRequirementMemoryItemIdStmt,
  getMemoryItemByIdStatement: () => getMemoryItemByIdStmt,
  getListRecentContextItemsStatement: () => listRecentContextItemsStmt,
  isFtsAvailable: () => ftsAvailable,
  sha256Hex,
});

configureMemoryMutations({
  getDb: () => db,
  getMemoryItemByIdStatement: () => getMemoryItemByIdStmt,
  getCompleteRequirementMemoryItemByReqIdStatement: () => completeRequirementMemoryItemByReqIdStmt,
  getCompleteAllActiveRequirementMemoryItemsStatement: () => completeAllActiveRequirementMemoryItemsStmt,
});

configureFileIndexing({
  getDb: () => db,
  getProjectRoot: () => projectRoot,
  normalizeToDbPath,
  getIndexFileSymbolsTx: () => indexFileSymbolsTx,
  getDeleteFileChunkItemsStatement: () => deleteFileChunkItemsStmt,
  getInsertMemoryItemStatement: () => insertMemoryItemStmt,
  getUpsertPendingChangeStatement: () => upsertPendingChangeStmt,
  getDeleteSymbolsForFileStatement: () => deleteSymbolsForFileStmt,
  sha256Hex,
  prunePendingChanges,
});


function escapeLike(pattern: string): string {
  return pattern.replace(/[\\\\%_]/g, (m) => `\\${m}`);
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function getFileStateHash(dbOrAbsPath: string): string | null {
  try {
    const abs = path.isAbsolute(dbOrAbsPath) ? dbOrAbsPath : path.join(projectRoot, dbOrAbsPath);
    const st = fs.statSync(abs);
    if (!st.isFile()) return sha256Hex(`non-file:${st.mtimeMs}:${st.size}`);
    if (st.size <= 5_000_000) {
      return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    }
    return sha256Hex(`large:${st.size}:${Math.floor(st.mtimeMs)}`);
  } catch {
    return sha256Hex("missing");
  }
}

function getLatestSyncedFileHash(dbFilePath: string): string | null {
  const row = getLatestChangeIntentForFileStmt?.get(dbFilePath) as MemoryItemRow | undefined;
  if (!row) return null;
  const meta = parseMetadataJson(row.metadata_json);
  return typeof meta.file_state_hash === "string" ? meta.file_state_hash : null;
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions: buildServerInstructions(),
  },
);

async function resolveProjectRootFromMcpRoots(): Promise<string | null> {
  const caps = server.getClientCapabilities();
  if (!caps?.roots) return null;

  try {
    const result = await server.listRoots({}, { timeout: ROOTS_LIST_TIMEOUT_MS });
    for (const r of result.roots ?? []) {
      const p = parseFileUriToPath(r.uri);
      if (!p) continue;
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) return p;
      } catch {
        // ignore invalid roots
      }
    }
  } catch {
    // client may not support roots
  }
  return null;
}

async function resolveProjectRoot(): Promise<{ root: string; source: RootSource }> {
  const envResolved = resolveRootFromEnvOrThrow();
  if (envResolved) return envResolved;

  const rootFromMcp = await resolveProjectRootFromMcpRoots();
  if (rootFromMcp) return { root: rootFromMcp, source: "mcp_roots" };

  const cwd = process.cwd();
  if (isProbablyVscodeInstallDir(cwd) || isProbablySystemDir(cwd)) {
    return { root: resolveSafeFallbackRootDir(), source: "fallback" };
  }
  return { root: cwd, source: "cwd" };
}

function initMemoryItemsFts(): void {
  ftsAvailable = false;

  try {
    const existed = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(FTS_TABLE_NAME);
    const alreadyExists = !!existed;

    if (!alreadyExists) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE ${FTS_TABLE_NAME} USING fts5(
            kind,
            title,
            content,
            file_path,
            metadata_json,
            content='memory_items',
            content_rowid='id',
            tokenize='trigram'
          );
        `);
      } catch {
        db.exec(`
          CREATE VIRTUAL TABLE ${FTS_TABLE_NAME} USING fts5(
            kind,
            title,
            content,
            file_path,
            metadata_json,
            content='memory_items',
            content_rowid='id'
          );
        `);
      }

      try {
        db.exec(`INSERT INTO ${FTS_TABLE_NAME}(${FTS_TABLE_NAME}) VALUES('rebuild');`);
      } catch (err) {
        console.error("[vectormind] fts rebuild failed:", err);
      }
    }

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS vectormind_memory_items_fts_ai
      AFTER INSERT ON memory_items BEGIN
        INSERT INTO ${FTS_TABLE_NAME}(rowid, kind, title, content, file_path, metadata_json)
        VALUES (new.id, new.kind, new.title, new.content, new.file_path, new.metadata_json);
      END;

      CREATE TRIGGER IF NOT EXISTS vectormind_memory_items_fts_ad
      AFTER DELETE ON memory_items BEGIN
        INSERT INTO ${FTS_TABLE_NAME}(${FTS_TABLE_NAME}, rowid, kind, title, content, file_path, metadata_json)
        VALUES ('delete', old.id, old.kind, old.title, old.content, old.file_path, old.metadata_json);
      END;

      CREATE TRIGGER IF NOT EXISTS vectormind_memory_items_fts_au
      AFTER UPDATE ON memory_items BEGIN
        INSERT INTO ${FTS_TABLE_NAME}(${FTS_TABLE_NAME}, rowid, kind, title, content, file_path, metadata_json)
        VALUES ('delete', old.id, old.kind, old.title, old.content, old.file_path, old.metadata_json);
        INSERT INTO ${FTS_TABLE_NAME}(rowid, kind, title, content, file_path, metadata_json)
        VALUES (new.id, new.kind, new.title, new.content, new.file_path, new.metadata_json);
      END;
    `);

    db.prepare(`SELECT rowid FROM ${FTS_TABLE_NAME} LIMIT 1`).get();
    ftsAvailable = true;
  } catch (err) {
    ftsAvailable = false;
  }
}

function columnExists(table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

function initDatabase(): void {
  const vmDir = path.join(projectRoot, ".vectormind");
  try {
    fs.mkdirSync(vmDir, { recursive: true });
  } catch {
    // ignore
  }

  dbPath = path.join(vmDir, "vectormind.db");
  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      context_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id INTEGER,
      file_path TEXT,
      intent_summary TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(req_id) REFERENCES requirements(id)
    );

    CREATE TABLE IF NOT EXISTS symbols (
      name TEXT,
      type TEXT,
      file_path TEXT,
      signature TEXT,
      PRIMARY KEY(name, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_change_logs_req_id_timestamp
      ON change_logs(req_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_symbols_name
      ON symbols(name);

    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      file_path TEXT,
      start_line INTEGER,
      end_line INTEGER,
      req_id INTEGER,
      metadata_json TEXT,
      content_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_chunk_locator
      ON memory_items(kind, file_path, start_line, end_line);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_project_summary
      ON memory_items(kind) WHERE kind = 'project_summary';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_convention_key
      ON memory_items(kind, title) WHERE kind = 'convention';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_decision_key
      ON memory_items(kind, title) WHERE kind = 'decision';

    CREATE INDEX IF NOT EXISTS idx_memory_items_kind_updated_at
      ON memory_items(kind, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_items_file_path
      ON memory_items(file_path);

    CREATE INDEX IF NOT EXISTS idx_memory_items_req_id
      ON memory_items(req_id);

    CREATE TABLE IF NOT EXISTS pending_changes (
      file_path TEXT PRIMARY KEY,
      last_event TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_pending_changes_updated_at
      ON pending_changes(updated_at DESC);

    CREATE TABLE IF NOT EXISTS token_savings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      raw_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      saved_tokens INTEGER NOT NULL,
      savings_pct REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_token_savings_created_at
      ON token_savings(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_token_savings_tool
      ON token_savings(tool);

    CREATE TABLE IF NOT EXISTS memory_item_archive (
      memory_id INTEGER PRIMARY KEY,
      original_kind TEXT NOT NULL,
      original_title TEXT,
      original_content TEXT NOT NULL,
      original_file_path TEXT,
      original_start_line INTEGER,
      original_end_line INTEGER,
      original_req_id INTEGER,
      original_metadata_json TEXT,
      original_content_hash TEXT,
      original_created_at DATETIME,
      original_updated_at DATETIME,
      archive_reason TEXT NOT NULL,
      compacted_into_id INTEGER,
      archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memory_item_archive_compacted_into
      ON memory_item_archive(compacted_into_id);

    CREATE TABLE IF NOT EXISTS meta_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  if (!columnExists("requirements", "updated_at")) {
    db.exec(`ALTER TABLE requirements ADD COLUMN updated_at DATETIME`);
    db.exec(`UPDATE requirements SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL`);
  }
  db.exec(`
    UPDATE requirements SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_requirements_status_updated_at
      ON requirements(status, updated_at DESC, id DESC);
    CREATE TRIGGER IF NOT EXISTS vectormind_requirements_touch_updated_at
    AFTER UPDATE ON requirements
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE requirements SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
  `);

  initMemoryItemsFts();

  insertRequirementStmt = db.prepare(
    `INSERT INTO requirements (title, context_data, status) VALUES (?, ?, 'active')`,
  );
  completeAllActiveRequirementsStmt = db.prepare(
    `UPDATE requirements SET status = 'completed' WHERE status = 'active'`,
  );
  completeRequirementByIdStmt = db.prepare(
    `UPDATE requirements SET status = 'completed' WHERE id = ?`,
  );
  getActiveRequirementStmt = db.prepare(
    `SELECT id, title, status, context_data, created_at
     FROM requirements
     WHERE status = 'active'
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT 1`,
  );
  listActiveRequirementsStmt = db.prepare(
    `SELECT id, title, status, context_data, created_at
     FROM requirements
     WHERE status = 'active'
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT ?`,
  );
  listRecentRequirementsStmt = db.prepare(
    `SELECT id, title, status, context_data, created_at
     FROM requirements
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT ?`,
  );
  completeAllActiveRequirementMemoryItemsStmt = db.prepare(
    `UPDATE memory_items
     SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE kind = 'requirement'
       AND metadata_json = ?`,
  );
  completeRequirementMemoryItemByReqIdStmt = db.prepare(
    `UPDATE memory_items
     SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE kind = 'requirement'
       AND req_id = ?`,
  );
  listChangeLogsForRequirementStmt = db.prepare(
    `SELECT id, req_id, file_path, intent_summary, timestamp
     FROM change_logs
     WHERE req_id = ?
     ORDER BY timestamp DESC, id DESC
     LIMIT ?`,
  );
  insertChangeLogStmt = db.prepare(
    `INSERT INTO change_logs (req_id, file_path, intent_summary) VALUES (?, ?, ?)`,
  );

  insertMemoryItemStmt = db.prepare(
    `INSERT INTO memory_items
       (kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  getMemoryItemByIdStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE id = ?`,
  );
  getConventionByKeyStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'convention' AND title = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
  );
  insertConventionStmt = db.prepare(
    `INSERT INTO memory_items (kind, title, content, metadata_json, content_hash)
     VALUES ('convention', ?, ?, ?, ?)`,
  );
  updateConventionByIdStmt = db.prepare(
    `UPDATE memory_items
     SET content = ?, metadata_json = ?, content_hash = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  );
  listConventionsStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'convention'
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  );
  upsertDecisionStmt = db.prepare(
    `INSERT INTO memory_items (kind, title, content, metadata_json, content_hash)
     VALUES ('decision', ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       content = excluded.content,
       metadata_json = excluded.metadata_json,
       content_hash = excluded.content_hash,
       updated_at = CURRENT_TIMESTAMP`,
  );
  getDecisionByKeyStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'decision' AND title = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
  );
  listCurrentDecisionsStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'decision'
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  );
  getRequirementMemoryItemIdStmt = db.prepare(
    `SELECT id
     FROM memory_items
     WHERE kind = 'requirement' AND req_id = ?
     ORDER BY id DESC
     LIMIT 1`,
  );
  upsertProjectSummaryStmt = db.prepare(
    `INSERT INTO memory_items (kind, title, content, metadata_json, content_hash)
     VALUES ('project_summary', 'Project Summary', ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       metadata_json = excluded.metadata_json,
       content_hash = excluded.content_hash,
       updated_at = CURRENT_TIMESTAMP`,
  );
  getProjectSummaryStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'project_summary'
     LIMIT 1`,
  );
  listRecentNotesStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'note'
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  );
  listRecentContextItemsStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind IN ('note', 'requirement', 'change_intent')
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  );
  getLatestChangeIntentForFileStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'change_intent' AND file_path = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
  );
  deleteFileChunkItemsStmt = db.prepare(
    `DELETE FROM memory_items
     WHERE file_path = ?
       AND (kind = 'code_chunk' OR kind = 'doc_chunk')`,
  );

  upsertPendingChangeStmt = db.prepare(
    `INSERT INTO pending_changes (file_path, last_event)
     VALUES (?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       last_event = excluded.last_event,
       updated_at = CURRENT_TIMESTAMP`,
  );
  listPendingChangesStmt = db.prepare(
    `SELECT file_path, last_event, updated_at
     FROM pending_changes
     ORDER BY updated_at DESC`,
  );
  countPendingChangesStmt = db.prepare(`SELECT COUNT(*) as total FROM pending_changes`);
  deletePendingChangeStmt = db.prepare(
    `DELETE FROM pending_changes WHERE file_path = ?`,
  );
  deleteAllPendingChangesStmt = db.prepare(`DELETE FROM pending_changes`);
  deleteOldPendingChangesStmt = db.prepare(
    `DELETE FROM pending_changes WHERE updated_at < datetime('now', ?)`,
  );
  deleteOldestPendingChangesStmt = db.prepare(
    `DELETE FROM pending_changes
     WHERE file_path IN (
       SELECT file_path FROM pending_changes
       ORDER BY updated_at ASC
       LIMIT ?
     )`,
  );

  deleteSymbolsForFileStmt = db.prepare(
    `DELETE FROM symbols WHERE file_path = ?`,
  );
  upsertSymbolStmt = db.prepare(
    `INSERT OR REPLACE INTO symbols (name, type, file_path, signature) VALUES (?, ?, ?, ?)`,
  );
  searchSymbolsStmt = db.prepare(
    `SELECT name, type, file_path, signature
     FROM symbols
     WHERE name LIKE ? ESCAPE '\\'
        OR signature LIKE ? ESCAPE '\\'
     ORDER BY
       CASE
         WHEN name = ? THEN 0
         WHEN name LIKE ? ESCAPE '\\' THEN 1
         ELSE 2
       END,
       name
     LIMIT ?`,
  );

  insertTokenSavingsStmt = db.prepare(
    `INSERT INTO token_savings (tool, raw_tokens, output_tokens, saved_tokens, savings_pct)
     VALUES (?, ?, ?, ?, ?)`,
  );
  summarizeTokenSavingsStmt = db.prepare(
    `SELECT
       COUNT(*) as calls,
       COALESCE(SUM(raw_tokens), 0) as raw_tokens,
       COALESCE(SUM(output_tokens), 0) as output_tokens,
       COALESCE(SUM(saved_tokens), 0) as saved_tokens,
       COALESCE(AVG(savings_pct), 0) as avg_savings_pct
     FROM token_savings`,
  );
  summarizeTokenSavingsByToolStmt = db.prepare(
    `SELECT
       tool,
       COUNT(*) as calls,
       COALESCE(SUM(raw_tokens), 0) as raw_tokens,
       COALESCE(SUM(output_tokens), 0) as output_tokens,
       COALESCE(SUM(saved_tokens), 0) as saved_tokens,
       COALESCE(AVG(savings_pct), 0) as avg_savings_pct
     FROM token_savings
     GROUP BY tool
     ORDER BY saved_tokens DESC, calls DESC
     LIMIT ?`,
  );
  listRecentTokenSavingsStmt = db.prepare(
    `SELECT id, tool, raw_tokens, output_tokens, saved_tokens, savings_pct, created_at
     FROM token_savings
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  );
  getKvStmt = db.prepare(`SELECT value FROM meta_kv WHERE key = ?`);
  setKvStmt = db.prepare(
    `INSERT INTO meta_kv (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  );

  indexFileSymbolsTx = db.transaction((filePath: string, symbols: ExtractedSymbol[]) => {
    deleteSymbolsForFileStmt.run(filePath);
    for (const s of symbols) {
      upsertSymbolStmt.run(s.name, s.type, filePath, s.signature);
    }
  });

  // Clean up noisy pending changes recorded by older versions (build artifacts, node_modules, etc).
  prunePendingChanges();

  // Clean up noisy indexes recorded by older versions (build artifacts, etc).
  if (INDEX_AUTO_PRUNE_IGNORED) {
    pruneIgnoredIndexesByPathPatterns();
  }

  // Clean up common "file name noise" recorded by older versions.
  // (These files are ignored by current index rules; keep the DB consistent automatically.)
  pruneFilenameNoiseIndexes();

  // Bounded, throttled maintenance keeps long-lived project memory fast without
  // deleting durable decisions/conventions/project summaries.
  runAutoMaintenanceIfDue();
}

function initWatcher(): void {
  watcherReady = false;
  watcher = chokidar.watch(projectRoot, {
    ignored: (p) => shouldIgnorePath(p, projectRoot),
    // Avoid indexing the entire tree on startup; track changes after the server is running.
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on("add", (p: string) => {
    recordPendingChange(p, "add");
    indexFile(p, "add");
  });
  watcher.on("change", (p: string) => {
    recordPendingChange(p, "change");
    indexFile(p, "change");
  });
  watcher.on("unlink", (p: string) => {
    recordPendingChange(p, "unlink");
    removeFileIndexes(p);
  });
  watcher.on("ready", () => {
    watcherReady = true;
  });
  watcher.on("error", (err: unknown) => console.error("[vectormind] watcher error:", err));
}

async function initializeIfNeeded(forced?: { root: string; source: RootSource }): Promise<void> {
  if (initialized) return;
  const resolved = forced ?? (await resolveProjectRoot());
  projectRoot = resolved.root;
  rootSource = resolved.source;

  try {
    fs.mkdirSync(projectRoot, { recursive: true });
  } catch {
    // ignore
  }

  try {
    initDatabase();
    if (rootSource === "fallback") {
      // If we can't confidently determine the project root (e.g. Codex VS Code started us in System32),
      // don't watch/index the fallback directory. Callers should pass `project_root`.
      watcher = null;
      watcherReady = false;
    } else {
      initWatcher();
    }
    initialized = true;
    console.error(
      `[vectormind] project_root=${projectRoot} source=${rootSource} db=${dbPath} watcher=${watcher ? "on" : "off"}`,
    );
  } catch (err) {
    try {
      watcher?.close().catch(() => {});
    } catch {}
    watcher = null;
    try {
      db?.close();
    } catch {}
    // reset for retry
    initialized = false;
    throw err;
  }
}

async function ensureInitialized(forced?: { root: string; source: RootSource }): Promise<void> {
  if (initialized) return;
  if (!initializationPromise) {
    initializationPromise = initializeIfNeeded(forced).finally(() => {
      if (initialized) return;
      initializationPromise = null;
    });
  }
  await initializationPromise;
}

async function switchProjectRootIfNeeded(next: { root: string; source: RootSource }): Promise<void> {
  const same = projectRoot && path.resolve(projectRoot) === path.resolve(next.root) && initialized;
  if (same) return;

  try {
    flushPendingChangeBuffer();
  } catch (err) {
    console.error("[vectormind] pending buffer flush error:", err);
  }

  try {
    await watcher?.close();
  } catch (err) {
    console.error("[vectormind] watcher close error:", err);
  }
  watcher = null;
  watcherReady = false;
  try {
    db?.close();
  } catch (err) {
    console.error("[vectormind] db close error:", err);
  }

  initialized = false;
  initializationPromise = null;
  await ensureInitialized(next);
}

async function ensureInitializedForArgs(rawArgs: Record<string, unknown>): Promise<void> {
  const fromToolArg = resolveRootFromToolArgOrThrow(rawArgs.project_root);
  if (fromToolArg) {
    await switchProjectRootIfNeeded(fromToolArg);
    return;
  }
  await ensureInitialized();
}

server.oninitialized = () => {
  // Do not eagerly initialize: prefer initializing on first tool call so callers can
  // provide `project_root` when the MCP client doesn't support roots/list.
};

process.on("unhandledRejection", (reason) => {
  console.error("[vectormind] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[vectormind] uncaughtException:", err);
});

server.setRequestHandler(ListToolsRequestSchema, async () => listToolDefinitions());

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    await ensureInitializedForArgs(rawArgs);

    if (toolName === "start_requirement") {
      const args = StartRequirementArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const scope_contract = buildRequirementScopeContract({
        title: args.title,
        background: args.background,
        scope_allow: args.scope_allow,
        scope_deny: args.scope_deny,
        allowed_paths: args.allowed_paths,
        denied_paths: args.denied_paths,
      });
      const development_warnings = buildRequirementStartWarnings({
        title: args.title,
        background: args.background,
        close_previous: args.close_previous,
      });

      if (args.close_previous) {
        try {
          completeAllActiveRequirementsStmt.run();
          completeAllActiveRequirementMemoryItems();
        } catch (err) {
          console.error("[vectormind] failed to close previous active requirements:", err);
        }
      }

      const info = insertRequirementStmt.run(args.title, args.background || null);
      const id = Number(info.lastInsertRowid);

      const background = args.background?.trim() ?? "";
      const content = background ? `${args.title}\n\n${background}` : args.title;
      const memoryInfo = insertMemoryItemStmt.run(
        "requirement",
        args.title,
        content,
        null,
        null,
        null,
        id,
        safeJson({ status: "active", scope_contract }),
        sha256Hex(content),
      );
      const memory_id = Number(memoryInfo.lastInsertRowid);

      logActivity("start_requirement", {
        req_id: id,
        title: args.title,
        closed_previous: args.close_previous,
        scope_contract,
        development_warnings: development_warnings.length,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              requirement: { id, title: args.title },
              memory_item: { id: memory_id },
              closed_previous: args.close_previous,
              scope_contract,
              development_warnings,
            }),
          },
        ],
      };
    }

    if (toolName === "prune_index") {
      const args = PruneIndexArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();

      const result = {
        ok: true as const,
        dry_run: args.dry_run,
        config: {
          index_max_code_bytes: INDEX_MAX_CODE_BYTES,
          index_max_doc_bytes: INDEX_MAX_DOC_BYTES,
          index_skip_minified: INDEX_SKIP_MINIFIED,
          index_auto_prune_ignored: INDEX_AUTO_PRUNE_IGNORED,
        },
        pruned: {
          ignored_paths: { chunks_deleted: 0, symbols_deleted: 0 },
          minified_bundles: { files_matched: 0, chunks_deleted: 0, symbols_deleted: 0 },
        },
      };

      if (args.prune_ignored_paths) {
        if (!IGNORED_LIKE_PATTERNS.length) {
          result.pruned.ignored_paths = { chunks_deleted: 0, symbols_deleted: 0 };
        } else if (args.dry_run) {
          const where = IGNORED_LIKE_PATTERNS
            .map(() => "LOWER(REPLACE(file_path, '\\\\', '/')) LIKE ?")
            .join(" OR ");
          const chunksWould = Number(
            (
              db
                .prepare(
                  `SELECT COUNT(1) AS c
                   FROM memory_items
                   WHERE file_path IS NOT NULL
                     AND (kind = 'code_chunk' OR kind = 'doc_chunk')
                     AND (${where})`,
                )
                .get(...IGNORED_LIKE_PATTERNS) as { c: number } | undefined
            )?.c ?? 0,
          );
          const symbolsWould = Number(
            (
              db
                .prepare(
                  `SELECT COUNT(1) AS c
                   FROM symbols
                   WHERE file_path IS NOT NULL
                     AND (${where})`,
                )
                .get(...IGNORED_LIKE_PATTERNS) as { c: number } | undefined
            )?.c ?? 0,
          );
          result.pruned.ignored_paths = { chunks_deleted: chunksWould, symbols_deleted: symbolsWould };
        } else {
          result.pruned.ignored_paths = pruneIgnoredIndexesByPathPatterns();
        }
      }

      if (args.prune_minified_bundles) {
        const maxFiles = args.max_files;
        const candidates = db
          .prepare(
            `SELECT file_path, content
             FROM memory_items
             WHERE kind = 'code_chunk'
               AND file_path IS NOT NULL
               AND (
                 LOWER(file_path) LIKE '%.js'
                 OR LOWER(file_path) LIKE '%.mjs'
                 OR LOWER(file_path) LIKE '%.cjs'
                 OR LOWER(file_path) LIKE '%.css'
               )
             ORDER BY updated_at DESC, id DESC
             LIMIT ?`,
          )
          .all(Math.min(50_000, maxFiles * 5)) as Array<{ file_path: string; content: string }>;

        const matched = new Set<string>();
        for (const row of candidates) {
          if (matched.size >= maxFiles) break;
          const fp = row.file_path;
          if (!fp || matched.has(fp)) continue;
          if (looksLikeMinifiedBundle(row.content)) matched.add(fp);
        }

        if (args.dry_run) {
          let chunksWould = 0;
          let symbolsWould = 0;
          const countChunksStmt = db.prepare(
            `SELECT COUNT(1) AS c
             FROM memory_items
             WHERE file_path = ?
               AND (kind = 'code_chunk' OR kind = 'doc_chunk')`,
          );
          const countSymbolsStmt = db.prepare(`SELECT COUNT(1) AS c FROM symbols WHERE file_path = ?`);
          for (const fp of matched) {
            chunksWould += Number((countChunksStmt.get(fp) as { c: number } | undefined)?.c ?? 0);
            symbolsWould += Number((countSymbolsStmt.get(fp) as { c: number } | undefined)?.c ?? 0);
          }
          result.pruned.minified_bundles = {
            files_matched: matched.size,
            chunks_deleted: chunksWould,
            symbols_deleted: symbolsWould,
          };
        } else {
          let chunksDeleted = 0;
          let symbolsDeleted = 0;
          const tx = db.transaction(() => {
            for (const fp of matched) {
              chunksDeleted += deleteFileChunkItemsStmt.run(fp).changes;
              symbolsDeleted += deleteSymbolsForFileStmt.run(fp).changes;
            }
          });
          try {
            tx();
          } catch (err) {
            console.error("[vectormind] prune minified bundles failed:", err);
          }
          if (matched.size) {
            logActivity("index_prune", {
              reason: "minified_bundles",
              files_matched: matched.size,
              chunks_deleted: chunksDeleted,
              symbols_deleted: symbolsDeleted,
            });
          }
          result.pruned.minified_bundles = {
            files_matched: matched.size,
            chunks_deleted: chunksDeleted,
            symbols_deleted: symbolsDeleted,
          };
        }
      }

      if (!args.dry_run && args.vacuum) {
        try {
          db.exec("VACUUM");
          logActivity("index_prune", { reason: "vacuum" });
        } catch (err) {
          console.error("[vectormind] vacuum failed:", err);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: toolJson(result),
          },
        ],
      };
    }

    if (toolName === "maintain_memory") {
      const args = MaintainMemoryArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const result = runMemoryMaintenance(args, "manual");
      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson("maintain_memory", result, compactMaintenanceText(result), args.format),
          },
        ],
      };
    }

    if (toolName === "preflight_change_scope") {
      const args = PreflightChangeScopeArgsSchema.parse(rawArgs);
      const changeMode = args.change_mode as ChangeMode;
      flushPendingChangeBuffer();
      const files = (args.files ?? args.planned_files ?? []).filter(
        (f): f is string => typeof f === "string" && f.length > 0,
      );
      const active = getActiveRequirementStmt.get() as RequirementRow | undefined;
      const explicitContract = buildRequirementScopeContract({
        title: active?.title ?? "",
        background: active?.context_data ?? "",
        scope_allow: args.scope_allow,
        scope_deny: args.scope_deny,
        allowed_paths: args.allowed_paths,
        denied_paths: args.denied_paths,
      });
      const fileInputs = files.map((file_path) => ({ file_path }));
      const development_warnings = [
        ...buildDevelopmentWarnings(fileInputs, { includeUnspecified: fileInputs.length === 0 }),
        ...buildScopeDriftWarnings({
          requirement: active,
          contract: explicitContract,
          intent: args.intent,
          files: fileInputs,
          includeMissingContractHint: true,
        }),
      ];
      const scope_contract = mergeScopeContracts(
        active ? getRequirementScopeContract(active.id) : null,
        explicitContract,
      );

      logActivity("preflight_change_scope", {
        req_id: active?.id ?? null,
        intent_preview: makePreviewText(args.intent, 200),
        change_mode: changeMode,
        files: files.slice(0, 25),
        files_total: files.length,
        development_warnings: development_warnings.length,
      });

      const hasTargetFiles = fileInputs.length > 0;
      const hugeWarnings = development_warnings.filter((w) => w.code === "huge_file_modularization_required");
      const hasHugeFile = hugeWarnings.length > 0;
      const blockingWarnings = development_warnings.filter((w) =>
        isDevelopmentWarningBlockingForChangeMode(w, changeMode),
      );
      const hasBlockingWarnings = blockingWarnings.length > 0;
      const safeToEdit = hasTargetFiles && !hasBlockingWarnings;
      const recommendedAction = !hasTargetFiles
        ? "Identify the intended target files/modules and rerun preflight_change_scope before editing."
        : hasHugeFile && changeMode === "mechanical_modularization" && safeToEdit
          ? "Proceed only with mechanical modularization: call plan_large_file_split, move whole declarations into real named modules/directories, avoid generated/parts files, validate, then record_large_file_split."
          : hasHugeFile && changeMode === "emergency_hotfix" && safeToEdit
            ? "Proceed only with the smallest urgent fix, do not add new responsibilities, record why mechanical modularization was deferred, and plan/record the split next."
            : hasHugeFile
              ? "Stop normal feature work. Call plan_large_file_split and perform mechanical modularization first, or rerun preflight_change_scope with change_mode='mechanical_modularization' for the split itself."
              : hasBlockingWarnings
                ? "Stop before editing. Narrow the planned files or explicitly expand the current requirement/scope contract."
                : "Planned files are within the current generic scope checks.";
      const requiredAction = hasHugeFile && changeMode !== "mechanical_modularization"
        ? "mechanical_modularization"
        : undefined;
      const allowedChangeModes = hasHugeFile
        ? (["mechanical_modularization", "emergency_hotfix"] as ChangeMode[])
        : undefined;

      const outputValue = {
        ok: safeToEdit,
        safe_to_edit: safeToEdit,
        change_mode: changeMode,
        recommended_action: recommendedAction,
        required_action: requiredAction,
        allowed_change_modes: allowedChangeModes,
        active_requirement: active ? { id: active.id, title: active.title } : null,
        intent: args.intent,
        files: files.map(normalizeToDbPath),
        scope_contract,
        development_warnings,
      };

      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson(
              "preflight_change_scope",
              outputValue,
              compactPreflightChangeScopeText(outputValue),
              args.format,
            ),
          },
        ],
      };
    }

    if (toolName === "plan_large_file_split") {
      const args = PlanLargeFileSplitArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const resolved = resolveReadPathUnderProjectRoot(projectRoot, normalizeToDbPath, args.file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved.absPath);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: toolJson({ ok: false, error: `File not found: ${String(err)}` }) }],
        };
      }
      if (!stat.isFile()) {
        return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not a file" }) }] };
      }
      if (!isLikelySourceImplementationFile(resolved.dbFilePath)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: toolJson({
                ok: false,
                error: "Not a recognized source implementation file",
                file_path: resolved.dbFilePath,
              }),
            },
          ],
        };
      }

      const lineInfo = countFileLinesBounded(resolved.absPath, 8_000_000);
      const lineCount = lineInfo?.lines ?? 0;
      if (lineCount < DEVELOPMENT_HUGE_FILE_LINES) {
        return {
          content: [
            {
              type: "text",
              text: toolJson({
                ok: false,
                file_path: resolved.dbFilePath,
                line_count: lineInfo?.truncated ? `${lineCount}+` : lineCount,
                huge_threshold_lines: DEVELOPMENT_HUGE_FILE_LINES,
                recommended_action:
                  "This file is not above the huge-file threshold. Use normal focused modularity rules unless the user explicitly asked for refactoring.",
              }),
            },
          ],
        };
      }

      let targetDir = args.target_dir;
      if (targetDir) {
        targetDir = resolveProjectPathUnderRoot(projectRoot, normalizeToDbPath, targetDir, { allowRoot: true }).dbFilePath;
      }
      const plan = buildLargeFileSplitPlan({
        filePath: resolved.dbFilePath,
        absPath: resolved.absPath,
        intent: args.intent,
        targetDir,
        maxModules: args.max_modules,
        hugeThresholdLines: DEVELOPMENT_HUGE_FILE_LINES,
      });

      logActivity("plan_large_file_split", {
        file_path: plan.file_path,
        line_count: plan.line_count,
        target_dir: plan.target_dir,
        modules: plan.modules.map((m) => m.module),
      });

      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson("plan_large_file_split", plan, compactLargeFileSplitPlanText(plan), args.format),
          },
        ],
      };
    }

    if (toolName === "record_large_file_split") {
      const args = RecordLargeFileSplitArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const normalizedFile = normalizeToDbPath(args.file);
      const active = getActiveRequirementStmt.get() as RequirementRow | undefined;
      const modules = (args.modules ?? []).map(normalizeToDbPath);
      const content = [
        `Huge-file mechanical modularization ${args.status}: ${normalizedFile}`,
        "",
        args.summary,
        modules.length ? `\nModules:\n${modules.map((m) => `- ${m}`).join("\n")}` : "",
        args.remaining_lines != null ? `\nRemaining lines: ${args.remaining_lines}` : "",
      ].filter(Boolean).join("\n");
      const meta = {
        tags: ["large-file-split", "mechanical-modularization"],
        file: normalizedFile,
        status: args.status,
        modules,
        remaining_lines: args.remaining_lines ?? null,
        active_requirement_id: active?.id ?? null,
      };
      const info = insertMemoryItemStmt.run(
        "note",
        `large-file-split:${normalizedFile}:${args.status}`,
        content,
        normalizedFile,
        null,
        null,
        active?.id ?? null,
        safeJson(meta),
        sha256Hex(content),
      );
      const id = Number(info.lastInsertRowid);
      logActivity("record_large_file_split", {
        memory_item_id: id,
        file_path: normalizedFile,
        status: args.status,
        modules: modules.slice(0, 20),
        remaining_lines: args.remaining_lines ?? null,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              note: { id },
              file_path: normalizedFile,
              status: args.status,
              modules,
              remaining_lines: args.remaining_lines ?? null,
            }),
          },
        ],
      };
    }

    if (toolName === "sync_change_intent") {
      const args = SyncChangeIntentArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const explicitFiles = (args.files ?? args.affected_files ?? []).filter(
        (f): f is string => typeof f === "string" && f.length > 0,
      );
      const active = getActiveRequirementStmt.get() as RequirementRow | undefined;
      if (!active) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: toolJson({
                ok: false,
                error:
                  "No active requirement. Call start_requirement(title, background) before syncing change intent.",
              }),
            },
          ],
        };
      }

      const created: Array<{
        file_path: string;
        event: string;
        source: "args" | "pending" | "unspecified";
        change_log_id: number;
        memory_item_id: number;
      }> = [];
      const synced_files: Array<{
        file_path: string;
        event: string;
        source: "args" | "pending" | "unspecified";
      }> = [];
      const insertTx = db.transaction(() => {
        const targets: Array<{
          rawFile: string;
          dbFilePath: string;
          event: string;
          source: "args" | "pending" | "unspecified";
        }> = [];

        if (explicitFiles.length) {
          for (const rawFile of explicitFiles) {
            const dbFilePath = normalizeToDbPath(rawFile);
            targets.push({ rawFile, dbFilePath, event: "manual", source: "args" });
          }
          for (const t of targets) {
            deletePendingChangeStmt.run(t.dbFilePath);
          }
        } else {
          const pendingAll = listPendingChangesStmt.all() as Array<{
            file_path: string;
            last_event: string;
            updated_at: string;
          }>;
          const merged = mergePendingWithGit(pendingAll, { offset: 0, limit: MAX_PENDING_LIMIT });
          if (merged.page.length) {
            for (const p of merged.page) {
              targets.push({
                rawFile: p.file_path,
                dbFilePath: p.file_path,
                event: p.last_event,
                source: p.source === "git" ? "pending" : "pending",
              });
            }
            deleteAllPendingChangesStmt.run();
          } else {
            targets.push({
              rawFile: "(unspecified)",
              dbFilePath: "(unspecified)",
              event: "manual",
              source: "unspecified",
            });
          }
        }

        for (const t of targets) {
          const isUnspecified = t.dbFilePath === "(unspecified)";
          const changeInfo = insertChangeLogStmt.run(active.id, t.dbFilePath, args.intent);
          const change_log_id = Number(changeInfo.lastInsertRowid);

          const memoryInfo = insertMemoryItemStmt.run(
            "change_intent",
            active.title,
            args.intent,
            isUnspecified ? null : t.dbFilePath,
            null,
            null,
            active.id,
            safeJson({
              change_log_id,
              event: t.event,
              source: t.source,
              file_state_hash: isUnspecified ? null : getFileStateHash(t.rawFile),
            }),
            sha256Hex(args.intent),
          );
          const memory_item_id = Number(memoryInfo.lastInsertRowid);

          synced_files.push({ file_path: t.dbFilePath, event: t.event, source: t.source });
          created.push({
            file_path: t.dbFilePath,
            event: t.event,
            source: t.source,
            change_log_id,
            memory_item_id,
          });

          if (!isUnspecified && t.event !== "unlink") {
            const abs = path.isAbsolute(t.rawFile)
              ? t.rawFile
              : path.join(projectRoot, t.rawFile);
            indexFile(abs, "manual");
          }
        }
      });
      insertTx();
      const development_warnings = [
        ...buildDevelopmentWarnings(synced_files, {
          includeUnspecified: synced_files.some((f) => f.file_path === "(unspecified)"),
        }),
        ...buildScopeDriftWarnings({
          requirement: active,
          intent: args.intent,
          files: synced_files,
        }),
      ];

      logActivity("sync_change_intent", {
        req_id: active.id,
        title: active.title,
        intent_preview: makePreviewText(args.intent, 200),
        files: synced_files.slice(0, 25),
        files_total: synced_files.length,
        development_warnings: development_warnings.length,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              linked_to_requirement: { id: active.id, title: active.title },
              synced_files,
              created,
              development_warnings,
            }),
          },
        ],
      };
    }

    if (toolName === "bootstrap_context") {
      const args = BootstrapContextArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();

      const previewChars = args.preview_chars;
      const includeContent = args.include_content;
      const contentMaxChars = args.content_max_chars;
      const requirementsLimit = args.requirements_limit;
      const changesLimit = args.changes_limit;
      const notesLimit = args.notes_limit;
      const conventionsLimit = args.conventions_limit;
      const decisionsLimit = args.decisions_limit;
      const currentContextLimit = args.current_context_limit;

      const recent = listRecentRequirementsStmt.all(requirementsLimit) as RequirementRow[];
      const items = recent.map((req) => {
        const changes = listChangeLogsForRequirementStmt.all(req.id, changesLimit) as ChangeLogRow[];
        return {
          requirement: toRequirementPreview(req, includeContent, previewChars, contentMaxChars),
          recent_changes: changes.map((c) => toChangeLogPreview(c, includeContent, previewChars, contentMaxChars)),
        };
      });
      const projectSummaryRow = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
      const project_summary = projectSummaryRow
        ? toMemoryItemPreview(projectSummaryRow, includeContent, previewChars, contentMaxChars)
        : null;
      const recent_notes = (listRecentNotesStmt.all(notesLimit) as MemoryItemRow[]).map((n) =>
        toMemoryItemPreview(n, includeContent, previewChars, contentMaxChars),
      );
      const decisions = getDecisionPreviews(decisionsLimit, previewChars, contentMaxChars);
      const conventions = getConventionPreviews(conventionsLimit, previewChars, contentMaxChars);
      const current_context = getCurrentContextPreviews(currentContextLimit, previewChars, contentMaxChars);
      const pending_offset = args.pending_offset;
      const pending_limit = args.pending_limit;
      const pendingDbRows = listPendingChangesStmt.all() as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>;
      const mergedPending = mergePendingWithGit(pendingDbRows, { offset: pending_offset, limit: pending_limit });
      const pending_total = mergedPending.total;
      const pending_truncated = mergedPending.truncated;
      const pending_changes = mergedPending.page;
      const activeForScope = getActiveRequirementStmt.get() as RequirementRow | undefined;
      const development_warnings = [
        ...buildDevelopmentWarnings(pending_changes),
        ...(activeForScope
          ? buildScopeDriftWarnings({ requirement: activeForScope, files: pending_changes })
          : []),
      ];

      const q = args.query?.trim() ?? "";
      const semanticKinds = args.kinds?.length ? args.kinds : BOOTSTRAP_DEFAULT_CONTEXT_KINDS;
      const semantic =
        q
          ? await Promise.race([
              semanticSearchHybridInternal({
                query: q,
                topK: args.top_k,
                kinds: semanticKinds,
                includeContent,
                previewChars,
                contentMaxChars,
              }),
              new Promise<null>((resolve) => setTimeout(resolve, BOOTSTRAP_SEMANTIC_TIMEOUT_MS, null)),
            ]).catch((err) => {
              console.error("[vectormind] bootstrap semantic_search failed:", err);
              return null;
            })
          : null;

      logActivity("bootstrap_context", {
        query: q || null,
        pending_total,
        pending_returned: pending_changes.length,
        requirements_returned: items.length,
        decisions_returned: decisions.length,
        current_context_returned: current_context.length,
        conventions_returned: conventions.length,
        semantic_mode: semantic?.mode ?? null,
        semantic_matches: semantic?.matches?.length ?? 0,
      });

      const outputValue = {
        ok: true,
        generated_at: new Date().toISOString(),
        project_root: projectRoot,
        root_source: rootSource,
        db_path: dbPath,
        watcher_enabled: !!watcher,
        watcher_ready: watcherReady,
        output: {
          format: args.format,
          include_content: includeContent,
          preview_chars: previewChars,
          content_max_chars: contentMaxChars,
          requirements_limit: requirementsLimit,
          changes_limit: changesLimit,
          notes_limit: notesLimit,
          decisions_limit: decisionsLimit,
          current_context_limit: currentContextLimit,
          conventions_limit: conventionsLimit,
        },
        project_summary,
        decisions,
        conventions,
        current_context,
        recent_notes,
        pending_total,
        pending_offset,
        pending_limit,
        pending_truncated,
        pending_changes,
        development_warnings,
        items,
        semantic,
      };

      return {
        content: [
          {
            type: "text",
            text: toolText("bootstrap_context", outputValue, compactBootstrapText(outputValue), args.format),
          },
        ],
      };
    }

    if (toolName === "get_brain_dump") {
      const args = GetBrainDumpArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const previewChars = args.preview_chars;
      const includeContent = args.include_content;
      const contentMaxChars = args.content_max_chars;
      const requirementsLimit = args.requirements_limit;
      const changesLimit = args.changes_limit;
      const notesLimit = args.notes_limit;
      const conventionsLimit = args.conventions_limit;
      const decisionsLimit = args.decisions_limit;
      const currentContextLimit = args.current_context_limit;

      const recent = listRecentRequirementsStmt.all(requirementsLimit) as RequirementRow[];
      const items = recent.map((req) => {
        const changes = listChangeLogsForRequirementStmt.all(req.id, changesLimit) as ChangeLogRow[];
        return {
          requirement: toRequirementPreview(req, includeContent, previewChars, contentMaxChars),
          recent_changes: changes.map((c) => toChangeLogPreview(c, includeContent, previewChars, contentMaxChars)),
        };
      });
      const projectSummaryRow = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
      const project_summary = projectSummaryRow
        ? toMemoryItemPreview(projectSummaryRow, includeContent, previewChars, contentMaxChars)
        : null;
      const recent_notes = (listRecentNotesStmt.all(notesLimit) as MemoryItemRow[]).map((n) =>
        toMemoryItemPreview(n, includeContent, previewChars, contentMaxChars),
      );
      const decisions = getDecisionPreviews(decisionsLimit, previewChars, contentMaxChars);
      const conventions = getConventionPreviews(conventionsLimit, previewChars, contentMaxChars);
      const current_context = getCurrentContextPreviews(currentContextLimit, previewChars, contentMaxChars);
      const pending_offset = args.pending_offset;
      const pending_limit = args.pending_limit;
      const pendingDbRows = listPendingChangesStmt.all() as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>;
      const mergedPending = mergePendingWithGit(pendingDbRows, { offset: pending_offset, limit: pending_limit });
      const pending_total = mergedPending.total;
      const pending_truncated = mergedPending.truncated;
      const pending_changes = mergedPending.page;
      const activeForScope = getActiveRequirementStmt.get() as RequirementRow | undefined;
      const development_warnings = [
        ...buildDevelopmentWarnings(pending_changes),
        ...(activeForScope
          ? buildScopeDriftWarnings({ requirement: activeForScope, files: pending_changes })
          : []),
      ];

      logActivity("get_brain_dump", {
        pending_total,
        pending_returned: pending_changes.length,
        requirements_returned: items.length,
        notes_returned: recent_notes.length,
        decisions_returned: decisions.length,
        current_context_returned: current_context.length,
        conventions_returned: conventions.length,
      });

      const outputValue = {
        ok: true,
        generated_at: new Date().toISOString(),
        project_root: projectRoot,
        root_source: rootSource,
        db_path: dbPath,
        watcher_enabled: !!watcher,
        watcher_ready: watcherReady,
        output: {
          format: args.format,
          include_content: includeContent,
          preview_chars: previewChars,
          content_max_chars: contentMaxChars,
          requirements_limit: requirementsLimit,
          changes_limit: changesLimit,
          notes_limit: notesLimit,
          decisions_limit: decisionsLimit,
          current_context_limit: currentContextLimit,
          conventions_limit: conventionsLimit,
        },
        project_summary,
        decisions,
        conventions,
        current_context,
        recent_notes,
        pending_total,
        pending_offset,
        pending_limit,
        pending_truncated,
        pending_changes,
        development_warnings,
        items,
        semantic: null,
      };

      return {
        content: [
          {
            type: "text",
            text: toolText("get_brain_dump", outputValue, compactBrainDumpText(outputValue), args.format),
          },
        ],
      };
    }

    if (toolName === "get_pending_changes") {
      const args = GetPendingChangesArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const offset = args.offset;
      const limit = args.limit;
      const pendingDbRows = listPendingChangesStmt.all() as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>;
      const mergedPending = mergePendingWithGit(pendingDbRows, { offset, limit });
      const total = mergedPending.total;
      const truncated = mergedPending.truncated;
      const pending = mergedPending.page;
      const activeForScope = getActiveRequirementStmt.get() as RequirementRow | undefined;
      const development_warnings = [
        ...buildDevelopmentWarnings(pending),
        ...(activeForScope ? buildScopeDriftWarnings({ requirement: activeForScope, files: pending }) : []),
      ];

      logActivity("get_pending_changes", {
        total,
        offset,
        limit,
        returned: pending.length,
        truncated,
        development_warnings: development_warnings.length,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({ ok: true, total, offset, limit, truncated, pending, development_warnings }),
          },
        ],
      };
    }

    if (toolName === "complete_requirement") {
      const args = CompleteRequirementArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();

      const updated: Array<{ id: number }> = [];
      if (args.all_active) {
        const activeRows = (db.prepare(
          `SELECT id FROM requirements WHERE status = 'active' ORDER BY created_at DESC, id DESC`,
        ).all() as Array<{ id: number }>).slice(0, 200);

        try {
          completeAllActiveRequirementsStmt.run();
          completeAllActiveRequirementMemoryItems();
        } catch (err) {
          console.error("[vectormind] complete all active requirements failed:", err);
        }

        for (const r of activeRows) updated.push({ id: r.id });
        logActivity("complete_requirement", { all_active: true, completed: updated.map((u) => u.id) });
        return { content: [{ type: "text", text: toolJson({ ok: true, completed: updated }) }] };
      }

      const targetId =
        args.req_id ?? (getActiveRequirementStmt.get() as RequirementRow | undefined)?.id ?? null;
      if (!targetId) {
        return { content: [{ type: "text", text: toolJson({ ok: true, completed: [] }) }] };
      }

      try {
        completeRequirementByIdStmt.run(targetId);
        completeRequirementMemoryItemsByReqId(targetId);
      } catch (err) {
        console.error("[vectormind] complete requirement failed:", err);
      }

      logActivity("complete_requirement", { req_id: targetId });
      return { content: [{ type: "text", text: toolJson({ ok: true, completed: [{ id: targetId }] }) }] };
    }

    if (toolName === "read_memory_item") {
      const args = ReadMemoryItemArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const row = getMemoryItemByIdStmt.get(args.id) as MemoryItemRow | undefined;
      if (!row) {
        return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not found" }) }] };
      }

      const total = row.content.length;
      const offset = args.offset;
      const limit = args.limit;
      const chunk = row.content.slice(offset, offset + limit);
      const truncated = offset + limit < total;

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              item: {
                id: row.id,
                kind: row.kind,
                title: row.title,
                file_path: row.file_path,
                start_line: row.start_line,
                end_line: row.end_line,
                req_id: row.req_id,
                metadata_json: row.metadata_json,
                updated_at: row.updated_at,
              },
              total_chars: total,
              offset,
              limit,
              truncated,
              content: chunk,
            }),
          },
        ],
      };
    }

    if (toolName === "get_activity_log") {
      const args = GetActivityLogArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const { events, last_id } = snapshotActivityLog({ sinceId: args.since_id, limit: args.limit });
      const outEvents = args.verbose
        ? events
        : events.map((e) => ({ id: e.id, ts: e.ts, type: e.type, summary: summarizeActivityEvent(e) }));
      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              enabled: debugLogEnabled,
              max_entries: debugLogMaxEntries,
              last_id,
              events: outEvents,
            }),
          },
        ],
      };
    }

    if (toolName === "get_activity_summary") {
      const args = GetActivitySummaryArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const { events, last_id } = snapshotActivityLog({ sinceId: args.since_id, limit: 500 });

      const counts: Record<string, number> = {};
      const indexedFiles = new Set<string>();
      let semanticCount = 0;
      let queryCodebaseCount = 0;
      let pendingFlushes = 0;
      let pendingPrunes = 0;
      let lastSemantic: Record<string, unknown> | null = null;
      let lastQueryCodebase: Record<string, unknown> | null = null;

      for (const e of events) {
        counts[e.type] = (counts[e.type] ?? 0) + 1;
        if (e.type === "index_file") {
          const fp = String(e.data.file_path ?? "");
          if (fp) indexedFiles.add(fp);
        }
        if (e.type === "semantic_search") {
          semanticCount += 1;
          lastSemantic = e.data;
        }
        if (e.type === "query_codebase") {
          queryCodebaseCount += 1;
          lastQueryCodebase = e.data;
        }
        if (e.type === "pending_flush") pendingFlushes += 1;
        if (e.type === "pending_prune") pendingPrunes += 1;
      }

      const sampleFiles = Array.from(indexedFiles).slice(0, args.max_files);
      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              enabled: debugLogEnabled,
              last_id,
              since_id: args.since_id,
              counts,
              indexed_files: { unique: indexedFiles.size, sample: sampleFiles },
              searches: {
                semantic_search: { count: semanticCount, last: lastSemantic },
                query_codebase: { count: queryCodebaseCount, last: lastQueryCodebase },
              },
              pending: { flushes: pendingFlushes, prunes: pendingPrunes },
            }),
          },
        ],
      };
    }

    if (toolName === "clear_activity_log") {
      ClearActivityLogArgsSchema.parse(rawArgs);
      clearActivityLog();
      return { content: [{ type: "text", text: toolJson({ ok: true }) }] };
    }

    if (toolName === "detect_rtk") {
      DetectRtkArgsSchema.parse(rawArgs);
      const result = detectRtk();
      const text = result.available
        ? `rtk available: ${result.version ?? result.command}\ncommand=${result.command} source=${result.source ?? "unknown"} gain_ok=${result.gain_ok ?? false}${result.path ? ` path=${result.path}` : ""}\n${result.note}`
        : `rtk unavailable: ${result.command}\nsource=${result.source ?? "none"} gain_ok=${result.gain_ok ?? false}${result.version ? ` version=${result.version}` : ""}${result.path ? ` path=${result.path}` : ""}\n${result.note}`;
      return { content: [{ type: "text", text }] };
    }

    if (toolName === "install_rtk") {
      const args = InstallRtkArgsSchema.parse(rawArgs);
      const result = installRtk(args);
      return { content: [{ type: "text", text: compactInstallRtkText(result) }] };
    }

    if (toolName === "get_token_savings") {
      const args = GetTokenSavingsArgsSchema.parse(rawArgs);
      const result = tokenSavingsSummary(args.limit);
      return {
        content: [
          {
            type: "text",
            text: args.format === "json" ? toolJson(result) : compactTokenSavingsText(result),
          },
        ],
      };
    }

    if (toolName === "grep") {
      const args = GrepArgsSchema.parse(rawArgs);
      const q = args.query;
      const mode = args.mode;
      const smartCase = args.smart_case;
      const kinds = args.kinds?.length ? args.kinds : (["code_chunk", "doc_chunk"] as string[]);
      const includePaths = args.include_paths?.length ? args.include_paths : null;
      const excludePaths = args.exclude_paths?.length ? args.exclude_paths : null;
      const maxResults = args.max_results;
      const development_warnings = [
        ...buildCrossProjectPathWarnings(includePaths),
        ...buildCrossProjectPathWarnings(excludePaths),
      ];

      const caseSensitive =
        args.case_sensitive ?? (smartCase ? hasUppercaseAscii(q) : true);
      const ripgrepResult = runRipgrepSearch({
        projectRoot,
        query: q,
        mode,
        smartCase,
        caseSensitive,
        includePaths,
        excludePaths,
        maxResults,
      });

      if (ripgrepResult.ok) {
        const grepDevelopmentWarnings = [
          ...development_warnings,
          ...buildMatchedFileDevelopmentWarnings(ripgrepResult.matches.map((m) => m.file_path)),
        ];
        logActivity("grep", {
          backend: ripgrepResult.backend,
          rg_command: ripgrepResult.rg_command,
          query: q,
          mode,
          case_sensitive: caseSensitive,
          smart_case: smartCase,
          include_paths: includePaths ?? [],
          exclude_paths: excludePaths ?? [],
          matches: ripgrepResult.matches.length,
          total_matches: ripgrepResult.total_matches,
          truncated: ripgrepResult.truncated,
          development_warnings: grepDevelopmentWarnings.length,
        });

        const outputValue = {
          ok: true,
          backend: ripgrepResult.backend,
          rg_command: ripgrepResult.rg_command,
          query: q,
          mode,
          case_sensitive: caseSensitive,
          smart_case: smartCase,
          include_paths: includePaths ?? [],
          exclude_paths: excludePaths ?? [],
          matches: ripgrepResult.matches,
          total_matches: ripgrepResult.total_matches,
          truncated: ripgrepResult.truncated,
          development_warnings: grepDevelopmentWarnings,
        };

        return {
          content: [
            {
              type: "text",
              text: toolCompactOrJson("grep", outputValue, compactGrepText(outputValue), args.format),
            },
          ],
        };
      }

      if (!ripgrepResult.unavailable) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: toolJson({
                ok: false,
                backend: "ripgrep",
                error: ripgrepResult.error,
                rg_command: ripgrepResult.rg_command,
                exit_status: ripgrepResult.exit_status,
                query: q,
                mode,
              }),
            },
          ],
        };
      }

      let indexedResult: ReturnType<typeof runIndexedGrepSearch>;
      try {
        indexedResult = runIndexedGrepSearch({
          db,
          ftsAvailable,
          ftsTableName: FTS_TABLE_NAME,
          buildFtsMatchQuery,
          escapeLike,
          query: q,
          mode,
          smartCase,
          caseSensitive,
          literalHint: args.literal_hint,
          kinds,
          includePaths,
          excludePaths,
          maxResults,
          maxCandidates: args.max_candidates,
        });
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: toolJson({
                ok: false,
                backend: "indexed_fallback",
                fallback_reason: "ripgrep_unavailable",
                ripgrep_error: ripgrepResult.error,
                ripgrep_attempts: ripgrepResult.attempts,
                error: String(err),
                query: q,
                mode,
                literal_hint: args.literal_hint,
              }),
            },
          ],
        };
      }

      const grepDevelopmentWarnings = [
        ...development_warnings,
        ...buildMatchedFileDevelopmentWarnings(indexedResult.matches.map((m) => m.file_path)),
      ];
      logActivity("grep", {
        backend: indexedResult.backend,
        fallback_reason: "ripgrep_unavailable",
        ripgrep_error: ripgrepResult.error,
        query: q,
        mode,
        case_sensitive: caseSensitive,
        smart_case: smartCase,
        hint: indexedResult.hint,
        kinds,
        include_paths: includePaths ?? [],
        exclude_paths: excludePaths ?? [],
        candidates: indexedResult.candidates.total,
        candidates_scanned: indexedResult.candidates.scanned,
        matches: indexedResult.matches.length,
        truncated: indexedResult.truncated,
        development_warnings: grepDevelopmentWarnings.length,
      });

      const outputValue = {
        ok: true,
        backend: indexedResult.backend,
        fallback_reason: "ripgrep_unavailable",
        ripgrep_error: ripgrepResult.error,
        ripgrep_attempts: ripgrepResult.attempts,
        query: q,
        mode,
        case_sensitive: caseSensitive,
        smart_case: smartCase,
        hint: indexedResult.hint,
        kinds,
        include_paths: includePaths ?? [],
        exclude_paths: excludePaths ?? [],
        candidates: indexedResult.candidates,
        matches: indexedResult.matches,
        truncated: indexedResult.truncated,
        development_warnings: grepDevelopmentWarnings,
      };

      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson("grep", outputValue, compactGrepText(outputValue), args.format),
          },
        ],
      };
    }

    if (toolName === "list_project_files") {
      const args = ListProjectFilesArgsSchema.parse(rawArgs);
      const resolved = resolveProjectPathUnderRoot(projectRoot, normalizeToDbPath, args.path, { allowRoot: true });

      let st: fs.Stats;
      try {
        st = fs.statSync(resolved.absPath);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: toolJson({ ok: false, error: `Path not found: ${String(err)}` }) }],
        };
      }

      const includePaths = args.include_paths?.length ? args.include_paths : null;
      const excludePaths = args.exclude_paths?.length ? args.exclude_paths : null;
      const extensions = normalizeExtensionsFilter(args.extensions);
      const result = listProjectFilesInternal({
        normalizeToDbPath,
        startAbsPath: resolved.absPath,
        startDbPath: resolved.dbFilePath,
        recursive: args.recursive,
        maxDepth: args.max_depth,
        includeFiles: args.include_files,
        includeDirs: args.include_dirs,
        includeHidden: args.include_hidden,
        respectIgnore: args.respect_ignore,
        includePaths,
        excludePaths,
        extensions,
        maxResults: args.max_results,
        includeStats: args.include_stats,
      });

      logActivity("list_project_files", {
        path: resolved.dbFilePath,
        recursive: args.recursive,
        max_depth: args.max_depth,
        include_files: args.include_files,
        include_dirs: args.include_dirs,
        include_hidden: args.include_hidden,
        respect_ignore: args.respect_ignore,
        include_paths: includePaths ?? [],
        exclude_paths: excludePaths ?? [],
        extensions: extensions ?? [],
        returned: result.returned,
        scanned: result.scanned,
        truncated: result.truncated,
        path_kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other",
      });

      const outputValue = {
        ok: true,
        path: resolved.dbFilePath,
        path_kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other",
        recursive: args.recursive,
        max_depth: args.recursive ? args.max_depth : 1,
        include_files: args.include_files,
        include_dirs: args.include_dirs,
        include_hidden: args.include_hidden,
        respect_ignore: args.respect_ignore,
        include_paths: includePaths ?? [],
        exclude_paths: excludePaths ?? [],
        extensions: extensions ?? [],
        returned: result.returned,
        scanned: result.scanned,
        truncated: result.truncated,
        entries: result.entries,
      };

      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson(
              "list_project_files",
              outputValue,
              compactListProjectFilesText(outputValue),
              args.format,
            ),
          },
        ],
      };
    }

    if (toolName === "read_file_text") {
      const args = ReadFileTextArgsSchema.parse(rawArgs);
      const resolved = resolveReadPathUnderProjectRoot(projectRoot, normalizeToDbPath, args.path);

      let st: fs.Stats;
      try {
        st = fs.statSync(resolved.absPath);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: toolJson({ ok: false, error: `File not found: ${String(err)}` }) }],
        };
      }
      if (!st.isFile()) {
        return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not a file" }) }] };
      }

      let result: { text: string; totalChars: number; returnedChars: number; truncated: boolean };
      try {
        result = readTextFileSlice({
          absPath: resolved.absPath,
          offset: args.offset,
          maxChars: args.max_chars,
          maxFileBytes: args.max_file_bytes,
        });
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: String(err) }) }] };
      }

      logActivity("read_file_text", {
        file_path: resolved.dbFilePath,
        offset: args.offset,
        returned_chars: result.returnedChars,
        total_chars: result.totalChars,
        truncated: result.truncated,
      });

      const development_warnings = buildFileReadDevelopmentWarnings(resolved.dbFilePath, resolved.absPath, st);
      const outputValue = {
        ok: true,
        file_path: resolved.dbFilePath,
        offset: args.offset,
        returned_chars: result.returnedChars,
        total_chars: result.totalChars,
        truncated: result.truncated,
        development_warnings,
        text: result.text,
      };

      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson("read_file_text", outputValue, compactReadTextFileText(outputValue), args.format),
          },
        ],
      };
    }

    if (toolName === "read_codex_text_file") {
      const args = ReadCodexTextFileArgsSchema.parse(rawArgs);

      let resolved: { absPath: string; displayPath: string; allowedRoot: string };
      try {
        resolved = resolveCodexTextPath(args.path);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: String(err) }) }] };
      }

      let st: fs.Stats;
      try {
        st = fs.statSync(resolved.absPath);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: toolJson({ ok: false, error: `File not found: ${String(err)}` }) }],
        };
      }
      if (!st.isFile()) {
        return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not a file" }) }] };
      }

      let result: { text: string; totalChars: number; returnedChars: number; truncated: boolean };
      try {
        result = readTextFileSlice({
          absPath: resolved.absPath,
          offset: args.offset,
          maxChars: args.max_chars,
          maxFileBytes: args.max_file_bytes,
        });
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: String(err) }) }] };
      }

      logActivity("read_codex_text_file", {
        file_path: resolved.displayPath,
        allowed_root: resolved.allowedRoot,
        offset: args.offset,
        returned_chars: result.returnedChars,
        total_chars: result.totalChars,
        truncated: result.truncated,
      });

      const outputValue = {
        ok: true,
        file_path: resolved.displayPath,
        allowed_root: resolved.allowedRoot,
        offset: args.offset,
        returned_chars: result.returnedChars,
        total_chars: result.totalChars,
        truncated: result.truncated,
        text: result.text,
      };

      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson(
              "read_codex_text_file",
              outputValue,
              compactReadTextFileText(outputValue),
              args.format,
            ),
          },
        ],
      };
    }

    if (toolName === "read_file_lines") {
      const args = ReadFileLinesArgsSchema.parse(rawArgs);
      const resolved = resolveReadPathUnderProjectRoot(projectRoot, normalizeToDbPath, args.path);

      let fromLine = args.from_line;
      let toLine = args.to_line;
      if (toLine == null) {
        const total = args.total_count ?? 200;
        toLine = fromLine + total - 1;
      }
      if (toLine < fromLine) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: toolJson({
                ok: false,
                error: "to_line must be >= from_line",
                path: args.path,
                from_line: fromLine,
                to_line: toLine,
              }),
            },
          ],
        };
      }

      let st: fs.Stats;
      try {
        st = fs.statSync(resolved.absPath);
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: "text", text: toolJson({ ok: false, error: `File not found: ${String(err)}` }) },
          ],
        };
      }
      if (!st.isFile()) {
        return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not a file" }) }] };
      }

      const maxLines = Math.max(1, Math.min(2000, args.max_lines));
      const maxChars = Math.max(200, Math.min(200_000, args.max_chars));

      const result = await readTextFileLines({
        absPath: resolved.absPath,
        fromLine,
        toLine,
        maxLines,
        maxChars,
      });

      logActivity("read_file_lines", {
        file_path: resolved.dbFilePath,
        from_line: fromLine,
        to_line: toLine,
        returned: result.returned,
        truncated: result.truncated,
      });

      const development_warnings = buildFileReadDevelopmentWarnings(resolved.dbFilePath, resolved.absPath, st);
      const outputValue = {
        ok: true,
        file_path: resolved.dbFilePath,
        from_line: fromLine,
        to_line: toLine,
        returned: result.returned,
        truncated: result.truncated,
        development_warnings,
        text: result.text,
      };

      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson("read_file_lines", outputValue, compactReadFileLinesText(outputValue), args.format),
          },
        ],
      };
    }

    if (toolName === "query_codebase") {
      const args = QueryCodebaseArgsSchema.parse(rawArgs);
      const q = args.query.trim();
      const escaped = escapeLike(q);
      const like = `%${escaped}%`;
      const rows = searchSymbolsStmt.all(like, like, q, like, 250) as SymbolRow[];
      const filtered = rows.filter((r) => !shouldIgnoreDbFilePath(r.file_path)).slice(0, 50);
      const development_warnings = buildMatchedFileDevelopmentWarnings(filtered.map((m) => m.file_path));

      logActivity("query_codebase", {
        query: q,
        matches: filtered.length,
        development_warnings: development_warnings.length,
        sample: filtered.slice(0, 10).map((m) => ({ name: m.name, type: m.type, file_path: m.file_path })),
      });

      const outputValue = { ok: true, query: q, matches: filtered, development_warnings };

      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson("query_codebase", outputValue, compactQueryCodebaseText(outputValue), args.format),
          },
        ],
      };
    }

    if (toolName === "upsert_project_summary") {
      const args = UpsertProjectSummaryArgsSchema.parse(rawArgs);
      const summary = args.summary.trim();
      const contentHash = sha256Hex(summary);
      upsertProjectSummaryStmt.run(summary, safeJson({ source: "assistant" }), contentHash);

      const row = getProjectSummaryStmt.get() as MemoryItemRow | undefined;

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              project_summary: row ? { id: row.id, updated_at: row.updated_at } : null,
            }),
          },
        ],
      };
    }

    if (toolName === "add_note") {
      const args = AddNoteArgsSchema.parse(rawArgs);
      const title = args.title?.trim() ?? "";
      const content = args.content.trim();
      const info = insertMemoryItemStmt.run(
        "note",
        title || null,
        content,
        null,
        null,
        null,
        null,
        safeJson({ tags: args.tags ?? [] }),
        sha256Hex(content),
      );
      const id = Number(info.lastInsertRowid);

      return {
        content: [
          {
            type: "text",
            text: toolJson({ ok: true, note: { id } }),
          },
        ],
      };
    }

    if (toolName === "upsert_decision") {
      const args = UpsertDecisionArgsSchema.parse(rawArgs);
      const key = args.key.trim();
      const title = args.title.trim() || key;
      const content = args.content.trim();
      const meta = {
        status: "current",
        key,
        title,
        tags: args.tags ?? [],
        supersedes_req_ids: args.supersedes_req_ids ?? [],
        supersedes_memory_ids: args.supersedes_memory_ids ?? [],
        related_files: (args.related_files ?? []).map((f) => normalizeToDbPath(f)),
      };
      upsertDecisionStmt.run(key, `${title}\n\n${content}`, safeJson(meta), sha256Hex(`${title}\n\n${content}`));
      const row = getDecisionByKeyStmt.get(key) as MemoryItemRow | undefined;

      const superseded_requirements = supersedeRequirementIds(args.supersedes_req_ids ?? [], {
        decision_id: row?.id,
        reason: `Superseded by decision ${key}: ${title}`,
      });
      const superseded_memory_items = supersedeMemoryItemIds(args.supersedes_memory_ids ?? [], {
        decision_id: row?.id,
        reason: `Superseded by decision ${key}: ${title}`,
      });

      logActivity("upsert_decision", {
        key,
        decision_id: row?.id ?? null,
        superseded_requirements,
        superseded_memory_items,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              decision: row ? { id: row.id, key, updated_at: row.updated_at } : null,
              superseded_requirements,
              superseded_memory_items,
            }),
          },
        ],
      };
    }

    if (toolName === "supersede_memory") {
      const args = SupersedeMemoryArgsSchema.parse(rawArgs);
      const supersededReqIds = args.superseded_req_ids ?? [];
      const supersededMemoryIds = args.superseded_memory_ids ?? [];
      if (!supersededReqIds.length && !supersededMemoryIds.length) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: toolJson({
                ok: false,
                error: "Provide superseded_req_ids and/or superseded_memory_ids.",
              }),
            },
          ],
        };
      }
      const superseded_requirements = supersedeRequirementIds(supersededReqIds, {
        req_id: args.replacement_req_id,
        memory_id: args.replacement_memory_id,
        reason: args.reason,
      });
      const superseded_memory_items = supersedeMemoryItemIds(supersededMemoryIds, {
        req_id: args.replacement_req_id,
        memory_id: args.replacement_memory_id,
        reason: args.reason,
      });
      logActivity("supersede_memory", {
        superseded_requirements,
        superseded_memory_items,
        replacement_req_id: args.replacement_req_id ?? null,
        replacement_memory_id: args.replacement_memory_id ?? null,
      });
      return {
        content: [
          {
            type: "text",
            text: toolJson({ ok: true, superseded_requirements, superseded_memory_items }),
          },
        ],
      };
    }

    if (toolName === "upsert_convention") {
      const args = UpsertConventionArgsSchema.parse(rawArgs);
      const key = args.key.trim();
      const content = args.content.trim();
      const contentHash = sha256Hex(content);
      const meta = safeJson({ tags: args.tags ?? [] });
      const existing = getConventionByKeyStmt.get(key) as MemoryItemRow | undefined;
      if (existing) {
        updateConventionByIdStmt.run(content, meta, contentHash, existing.id);
      } else {
        insertConventionStmt.run(key, content, meta, contentHash);
      }
      const row = getConventionByKeyStmt.get(key) as MemoryItemRow | undefined;

      logActivity("upsert_convention", { key, content_preview: makePreviewText(content, 200) });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              convention: row
                ? {
                    id: row.id,
                    key: row.title,
                    updated_at: row.updated_at,
                    preview: makePreviewText(row.content, DEFAULT_PREVIEW_CHARS),
                  }
                : null,
            }),
          },
        ],
      };
    }

    if (toolName === "semantic_search") {
      const args = SemanticSearchArgsSchema.parse(rawArgs);
      const result = await semanticSearchHybridInternal({
        query: args.query,
        topK: args.top_k,
        kinds: args.kinds?.length ? args.kinds : null,
        includeContent: args.include_content,
        previewChars: args.preview_chars,
        contentMaxChars: args.content_max_chars,
      });

      logActivity("semantic_search", {
        query: result.query,
        mode: result.mode,
        top_k: result.top_k,
        matches: result.matches.length,
        sample: result.matches.slice(0, 10).map((m) => ({
          id: m.item.id,
          kind: m.item.kind,
          file_path: m.item.file_path,
          score: m.score,
        })),
      });

      const outputValue = { ok: true, ...result };

      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson("semantic_search", outputValue, compactSemanticSearchText(outputValue), args.format),
          },
        ],
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: String(err) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown(signal: string): Promise<void> {
  try {
    flushPendingChangeBuffer();
    await watcher?.close();
  } catch (err) {
    console.error("[vectormind] watcher close error:", err);
  }
  try {
    db?.close();
  } catch (err) {
    console.error("[vectormind] db close error:", err);
  }
  process.exit(signal === "SIGTERM" ? 143 : 130);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
