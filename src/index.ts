#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import chokidar, { type FSWatcher } from "chokidar";
import Database from "better-sqlite3";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServerInstructions } from "./server-instructions.js";
import { listToolDefinitions } from "./tool-catalog.js";
import { registerToolHandlers } from "./tool-handlers.js";
import type {
  ExtractedSymbol,
  MemoryItemRow,
  RequirementRow,
  RootSource,
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
import { shouldIgnorePath } from "./path-rules.js";
import {
  configurePendingChanges,
  prunePendingChanges,
} from "./pending-changes.js";
import { configureTokenSavings } from "./token-savings.js";
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
} from "./memory-maintenance.js";
import { configureMemoryMutations } from "./memory-mutations.js";
import {
  MEMORY_ITEMS_FTS_TABLE,
  configureMemoryRecall,
  isHiddenFromDefaultRecall,
  metadataStatus,
  parseMetadataJson,
} from "./memory-recall.js";
import {
  configureDevelopmentWarnings,
} from "./development-warnings.js";
import {
  configureActivityLogProjectRoot,
} from "./activity-log.js";
import {
  INDEX_AUTO_PRUNE_IGNORED,
  ROOTS_LIST_TIMEOUT_MS,
  SERVER_NAME,
  SERVER_VERSION,
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

registerToolHandlers(server, {
  ensureInitializedForArgs,
  getDb: () => db,
  getProjectRoot: () => projectRoot,
  getRootSource: () => rootSource,
  getDbPath: () => dbPath,
  isWatcherEnabled: () => !!watcher,
  isWatcherReady: () => watcherReady,
  isFtsAvailable: () => ftsAvailable,
  ftsTableName: FTS_TABLE_NAME,
  getIndexFileSymbolsTx: () => indexFileSymbolsTx,
  getStatements: () => ({
    insertRequirementStmt,
    completeAllActiveRequirementsStmt,
    insertChangeLogStmt,
    insertMemoryItemStmt,
    getActiveRequirementStmt,
    listPendingChangesStmt,
    countPendingChangesStmt,
    deletePendingChangeStmt,
    deleteAllPendingChangesStmt,
    deleteFileChunkItemsStmt,
    deleteSymbolsForFileStmt,
    searchSymbolsStmt,
    getProjectSummaryStmt,
    listRecentRequirementsStmt,
    listChangeLogsForRequirementStmt,
    listRecentNotesStmt,
    completeAllActiveRequirementMemoryItemsStmt,
    completeRequirementByIdStmt,
    getMemoryItemByIdStmt,
    upsertProjectSummaryStmt,
    getConventionByKeyStmt,
    insertConventionStmt,
    updateConventionByIdStmt,
    upsertDecisionStmt,
    getDecisionByKeyStmt,
    getRequirementMemoryItemIdStmt,
  }),
  normalizeToDbPath,
  sha256Hex,
  escapeLike,
  getFileStateHash,
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
