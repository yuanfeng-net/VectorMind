import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { ExtractedSymbol } from "./types.js";
import { MEMORY_ITEMS_FTS_TABLE } from "./memory-recall.js";
import { shouldIgnoreDbFilePath } from "./path-rules.js";

export const FTS_TABLE_NAME = MEMORY_ITEMS_FTS_TABLE;

export type PreparedDatabaseStatements = {
  insertRequirementStmt: Database.Statement;
  getActiveRequirementStmt: Database.Statement;
  getActiveRequirementByIdStmt: Database.Statement;
  getActiveRequirementByGoalKeyStmt: Database.Statement;
  listActiveRequirementsStmt: Database.Statement;
  listRecentRequirementsStmt: Database.Statement;
  completeAllActiveRequirementsStmt: Database.Statement;
  completeRequirementByIdStmt: Database.Statement;
  completeRequirementMemoryItemByReqIdStmt: Database.Statement;
  listChangeLogsForRequirementStmt: Database.Statement;
  insertChangeLogStmt: Database.Statement;
  upsertSyncedFileStateStmt: Database.Statement;
  getSyncedFileStateStmt: Database.Statement;
  insertMcpGuardEventStmt: Database.Statement;
  insertMcpToolMetricStmt: Database.Statement;
  insertMemoryItemStmt: Database.Statement;
  getMemoryItemByIdStmt: Database.Statement;
  getRequirementMemoryItemIdStmt: Database.Statement;
  getConventionByKeyStmt: Database.Statement;
  insertConventionStmt: Database.Statement;
  updateConventionByIdStmt: Database.Statement;
  listConventionsStmt: Database.Statement;
  upsertDecisionStmt: Database.Statement;
  getDecisionByKeyStmt: Database.Statement;
  listCurrentDecisionsStmt: Database.Statement;
  upsertProjectSummaryStmt: Database.Statement;
  getProjectSummaryStmt: Database.Statement;
  getLatestChangeIntentForFileStmt: Database.Statement;
  deleteFileChunkItemsStmt: Database.Statement;
  upsertPendingChangeStmt: Database.Statement;
  listPendingChangesStmt: Database.Statement;
  countPendingChangesStmt: Database.Statement;
  deletePendingChangeStmt: Database.Statement;
  deleteAllPendingChangesStmt: Database.Statement;
  deleteOldPendingChangesStmt: Database.Statement;
  deleteOldestPendingChangesStmt: Database.Statement;
  deleteSymbolsForFileStmt: Database.Statement;
  upsertSymbolStmt: Database.Statement;
  searchSymbolsStmt: Database.Statement;
  insertTokenSavingsStmt: Database.Statement;
  summarizeTokenSavingsStmt: Database.Statement;
  summarizeTokenSavingsByToolStmt: Database.Statement;
  listRecentTokenSavingsStmt: Database.Statement;
  getKvStmt: Database.Statement;
  setKvStmt: Database.Statement;
};

export type DatabaseRuntime = {
  db: Database.Database;
  dbPath: string;
  ftsAvailable: boolean;
  ftsTableName: string;
  indexFileSymbolsTx: ((filePath: string, symbols: ExtractedSymbol[]) => void) | null;
  statements: PreparedDatabaseStatements;
};

let db: Database.Database;
let dbPath = "";
let ftsAvailable = false;
let insertRequirementStmt: Database.Statement;
let getActiveRequirementStmt: Database.Statement;
let getActiveRequirementByIdStmt: Database.Statement;
let getActiveRequirementByGoalKeyStmt: Database.Statement;
let listActiveRequirementsStmt: Database.Statement;
let listRecentRequirementsStmt: Database.Statement;
let completeAllActiveRequirementsStmt: Database.Statement;
let completeRequirementByIdStmt: Database.Statement;
let completeRequirementMemoryItemByReqIdStmt: Database.Statement;
let listChangeLogsForRequirementStmt: Database.Statement;
let insertChangeLogStmt: Database.Statement;
let upsertSyncedFileStateStmt: Database.Statement;
let getSyncedFileStateStmt: Database.Statement;
let insertMcpGuardEventStmt: Database.Statement;
let insertMcpToolMetricStmt: Database.Statement;
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

function initMemoryItemsFts(): void {
  ftsAvailable = false;

  try {
    const initializeFts = db.transaction(() => {
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
    });
    initializeFts.immediate();

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

type MigrationFileEntry = {
  file_path: string;
  event?: string;
  source?: string;
  file_state_hash?: string | null;
};

type MigrationChangeLogRow = {
  id: number;
  req_id: number | null;
  file_path: string | null;
  intent_summary: string | null;
  files_json: string | null;
  file_count: number | null;
  timestamp: string | null;
};

type MigrationMemoryItemRow = {
  id: number;
  title: string | null;
  content: string;
  file_path: string | null;
  req_id: number | null;
  metadata_json: string | null;
  updated_at: string | null;
};

function safeParseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableStringValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  return stringValue(value);
}

function mergeStringArrays(values: unknown[]): string[] {
  const merged: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.length > 0 && !merged.includes(item)) merged.push(item);
    }
  }
  return merged;
}

function migrationFileKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function addMigrationFileEntry(
  filesByPath: Map<string, MigrationFileEntry>,
  filePath: unknown,
  metadata: Record<string, unknown> = {},
): void {
  const normalizedFilePath = stringValue(filePath)?.replace(/\\/g, "/");
  if (!normalizedFilePath || normalizedFilePath === "(multiple)" || normalizedFilePath === "(unspecified)") return;
  if (shouldIgnoreDbFilePath(normalizedFilePath)) return;

  const key = migrationFileKey(normalizedFilePath);
  const existing = filesByPath.get(key) ?? { file_path: normalizedFilePath };
  const event = stringValue(metadata.event);
  const source = stringValue(metadata.source);
  const fileStateHash = nullableStringValue(metadata.file_state_hash);
  if (event && !existing.event) existing.event = event;
  if (source && !existing.source) existing.source = source;
  if (fileStateHash !== undefined && existing.file_state_hash === undefined) existing.file_state_hash = fileStateHash;
  filesByPath.set(key, existing);
}

function addMigrationFilesFromMetadata(
  filesByPath: Map<string, MigrationFileEntry>,
  metadata: Record<string, unknown>,
): void {
  const files = metadata.files;
  if (!Array.isArray(files)) return;
  for (const item of files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    addMigrationFileEntry(filesByPath, entry.file_path, entry);
  }
}

function migrationFilesJson(filesByPath: Map<string, MigrationFileEntry>): string {
  return JSON.stringify([...filesByPath.values()].map((file) => ({
    file_path: file.file_path,
    event: file.event,
    source: file.source,
    file_state_hash: file.file_state_hash ?? null,
  })));
}

function repairDuplicateChangeLogs(): number {
  const groups = db
    .prepare(
      `SELECT req_id, timestamp, intent_summary, MIN(id) AS keep_id, COUNT(*) AS row_count
       FROM change_logs
       GROUP BY req_id, timestamp, intent_summary
       HAVING COUNT(*) > 1`,
    )
    .all() as Array<{
      req_id: number | null;
      timestamp: string | null;
      intent_summary: string | null;
      keep_id: number;
      row_count: number;
    }>;
  if (!groups.length) return 0;

  const selectGroupRows = db.prepare(
    `SELECT id, req_id, file_path, intent_summary, files_json, file_count, timestamp
     FROM change_logs
     WHERE req_id IS ? AND timestamp IS ? AND intent_summary IS ?
     ORDER BY id ASC`,
  );
  const updateKeepRow = db.prepare(
    `UPDATE change_logs
     SET file_path = ?, files_json = ?, file_count = ?
     WHERE id = ?`,
  );
  const deleteRow = db.prepare(`DELETE FROM change_logs WHERE id = ?`);

  let removedRows = 0;
  const tx = db.transaction(() => {
    for (const group of groups) {
      const rows = selectGroupRows.all(group.req_id, group.timestamp, group.intent_summary) as MigrationChangeLogRow[];
      if (rows.length <= 1) continue;
      const distinctLegacyFiles = new Set(rows.map((row) => row.file_path).filter((value): value is string => !!value));
      const hasAggregateRows = rows.some((row) => {
        try {
          const parsed = row.files_json ? JSON.parse(row.files_json) : null;
          return Array.isArray(parsed) && parsed.length > 0;
        } catch {
          return false;
        }
      });
      if (hasAggregateRows || distinctLegacyFiles.size < 2) continue;

      const filesByPath = new Map<string, MigrationFileEntry>();
      for (const row of rows) {
        addMigrationFilesFromMetadata(filesByPath, safeParseObject(row.files_json));
        addMigrationFileEntry(filesByPath, row.file_path);
      }

      const files = [...filesByPath.values()];
      const primaryFilePath = files.length === 1 ? files[0].file_path : files.length > 1 ? "(multiple)" : null;
      const keepId = Number(group.keep_id);
      updateKeepRow.run(primaryFilePath, migrationFilesJson(filesByPath), files.length, keepId);
      for (const row of rows) {
        if (row.id === keepId) continue;
        deleteRow.run(row.id);
        removedRows += 1;
      }
    }
  });
  tx();
  return removedRows;
}

function repairDuplicateChangeIntentMemoryItems(): number {
  const groups = db
    .prepare(
      `SELECT req_id, content, MIN(id) AS keep_id, COUNT(*) AS row_count
       FROM memory_items
       WHERE kind = 'change_intent'
       GROUP BY req_id, content
       HAVING COUNT(*) > 1`,
    )
    .all() as Array<{
      req_id: number | null;
      content: string;
      keep_id: number;
      row_count: number;
    }>;
  if (!groups.length) return 0;

  const selectGroupRows = db.prepare(
    `SELECT id, title, content, file_path, req_id, metadata_json, updated_at
     FROM memory_items
     WHERE kind = 'change_intent'
       AND req_id IS ?
       AND content IS ?
     ORDER BY id ASC`,
  );
  const updateKeepRow = db.prepare(
    `UPDATE memory_items
     SET file_path = ?, metadata_json = ?
     WHERE id = ?`,
  );
  const deleteRow = db.prepare(`DELETE FROM memory_items WHERE id = ?`);

  let removedRows = 0;
  const tx = db.transaction(() => {
    for (const group of groups) {
      const rows = selectGroupRows.all(group.req_id, group.content) as MigrationMemoryItemRow[];
      if (rows.length <= 1) continue;

      const filesByPath = new Map<string, MigrationFileEntry>();
      const metadataList = rows.map((row) => safeParseObject(row.metadata_json));
      const distinctLegacyFiles = new Set(rows.map((row) => row.file_path).filter((value): value is string => !!value));
      if (metadataList.some((metadata) => Array.isArray(metadata.files)) || distinctLegacyFiles.size < 2) continue;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const metadata = metadataList[i] ?? {};
        addMigrationFilesFromMetadata(filesByPath, metadata);
        addMigrationFileEntry(filesByPath, row.file_path, metadata);
      }

      const files = [...filesByPath.values()];
      const keepId = Number(group.keep_id);
      const keepRow = rows.find((row) => row.id === keepId) ?? rows[0];
      const keepMetadata = safeParseObject(keepRow.metadata_json);
      const sourceChangeIds = new Set<number>();
      for (const metadata of metadataList) {
        if (typeof metadata.change_log_id === "number") sourceChangeIds.add(metadata.change_log_id);
        if (Array.isArray(metadata.source_change_ids)) {
          for (const id of metadata.source_change_ids) {
            if (typeof id === "number") sourceChangeIds.add(id);
          }
        }
      }

      const nextMetadata: Record<string, unknown> = {
        ...keepMetadata,
        files: files.map((file) => ({
          file_path: file.file_path,
          event: file.event,
          source: file.source,
          file_state_hash: file.file_state_hash ?? null,
        })),
        file_count: files.length,
      };
      const verification = mergeStringArrays(metadataList.map((metadata) => metadata.verification));
      const verificationGaps = mergeStringArrays(metadataList.map((metadata) => metadata.verification_gaps));
      if (verification.length) nextMetadata.verification = verification;
      if (verificationGaps.length) nextMetadata.verification_gaps = verificationGaps;
      if (sourceChangeIds.size) nextMetadata.source_change_ids = [...sourceChangeIds];
      if (files.length === 1) {
        const onlyFile = files[0];
        nextMetadata.event = onlyFile.event;
        nextMetadata.source = onlyFile.source;
        nextMetadata.file_state_hash = onlyFile.file_state_hash ?? null;
      } else {
        delete nextMetadata.event;
        delete nextMetadata.source;
        delete nextMetadata.file_state_hash;
      }

      updateKeepRow.run(files.length === 1 ? files[0].file_path : null, JSON.stringify(nextMetadata), keepId);
      for (const row of rows) {
        if (row.id === keepId) continue;
        deleteRow.run(row.id);
        removedRows += 1;
      }
    }
  });
  tx();
  return removedRows;
}

function backfillSyncedFileStatesFromChangeIntentMemory(): number {
  const rows = db
    .prepare(
      `SELECT id, file_path, metadata_json, updated_at
       FROM memory_items
       WHERE kind = 'change_intent'
       ORDER BY updated_at ASC, id ASC`,
    )
    .all() as Array<{ id: number; file_path: string | null; metadata_json: string | null; updated_at: string | null }>;
  if (!rows.length) return 0;

  const upsert = db.prepare(
    `INSERT INTO synced_file_states (file_path, file_state_hash, source_change_id, updated_at)
     VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
     ON CONFLICT(file_path) DO UPDATE SET
       file_state_hash = excluded.file_state_hash,
       source_change_id = excluded.source_change_id,
       updated_at = CASE
         WHEN synced_file_states.updated_at IS NULL OR synced_file_states.updated_at <= excluded.updated_at
           THEN excluded.updated_at
         ELSE synced_file_states.updated_at
       END`,
  );

  let written = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const metadata = safeParseObject(row.metadata_json);
      const sourceChangeId = typeof metadata.change_log_id === "number"
        ? metadata.change_log_id
        : Array.isArray(metadata.source_change_ids) && typeof metadata.source_change_ids[0] === "number"
          ? metadata.source_change_ids[0]
          : null;
      const filesByPath = new Map<string, MigrationFileEntry>();
      addMigrationFilesFromMetadata(filesByPath, metadata);
      addMigrationFileEntry(filesByPath, row.file_path, metadata);
      for (const file of filesByPath.values()) {
        if (typeof file.file_state_hash !== "string") continue;
        upsert.run(file.file_path, file.file_state_hash, sourceChangeId, row.updated_at);
        written += 1;
      }
    }
  });
  tx();
  return written;
}

function repairHistoricalDuplicateChangeRecords(): void {
  const migrationKey = "migration:aggregate_change_records:v1";
  try {
    if (db.prepare(`SELECT 1 FROM meta_kv WHERE key = ? LIMIT 1`).get(migrationKey)) return;
    const removedChangeLogs = repairDuplicateChangeLogs();
    const removedChangeIntentMemory = repairDuplicateChangeIntentMemoryItems();
    const syncedFileStates = backfillSyncedFileStatesFromChangeIntentMemory();
    const result = JSON.stringify({
      removed_change_logs: removedChangeLogs,
      removed_change_intent_memory: removedChangeIntentMemory,
      synced_file_states: syncedFileStates,
      ran_at: new Date().toISOString(),
    });
    db.transaction(() => {
      db.prepare(
        `INSERT INTO meta_kv (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)`,
      ).run(migrationKey, result);
      db.prepare(
        `INSERT INTO meta_kv (key, value, updated_at)
         VALUES ('maintenance:dedupe_change_records:last_run', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      ).run(result);
    })();
  } catch (err) {
    console.error("[vectormind] historical duplicate change-record repair failed:", err);
  }
}

export function openDatabaseRuntime(projectRoot: string): DatabaseRuntime {
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
      goal_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id INTEGER,
      file_path TEXT,
      intent_summary TEXT,
      files_json TEXT,
      file_count INTEGER DEFAULT 1,
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

    CREATE TABLE IF NOT EXISTS synced_file_states (
      file_path TEXT PRIMARY KEY,
      file_state_hash TEXT,
      source_change_id INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_synced_file_states_updated_at
      ON synced_file_states(updated_at DESC);

    CREATE TABLE IF NOT EXISTS mcp_guard_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT DEFAULT 'info',
      title TEXT NOT NULL,
      detail TEXT,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_guard_events_created_at
      ON mcp_guard_events(created_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_mcp_guard_events_type_created_at
      ON mcp_guard_events(event_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS mcp_tool_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      duration_ms REAL NOT NULL,
      raw_output_chars INTEGER NOT NULL,
      output_chars INTEGER NOT NULL,
      is_error INTEGER NOT NULL DEFAULT 0,
      root_source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_tool_metrics_created_at
      ON mcp_tool_metrics(created_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_mcp_tool_metrics_tool_created_at
      ON mcp_tool_metrics(tool_name, created_at DESC);

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

  const migrateLegacyColumns = db.transaction(() => {
    if (!columnExists("requirements", "updated_at")) {
      db.exec(`ALTER TABLE requirements ADD COLUMN updated_at DATETIME`);
      db.exec(`UPDATE requirements SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL`);
    }
    if (!columnExists("requirements", "goal_key")) {
      db.exec(`ALTER TABLE requirements ADD COLUMN goal_key TEXT`);
    }
    if (!columnExists("change_logs", "files_json")) {
      db.exec(`ALTER TABLE change_logs ADD COLUMN files_json TEXT`);
    }
    if (!columnExists("change_logs", "file_count")) {
      db.exec(`ALTER TABLE change_logs ADD COLUMN file_count INTEGER DEFAULT 1`);
      db.exec(`UPDATE change_logs SET file_count = 1 WHERE file_count IS NULL`);
    }
  });
  migrateLegacyColumns.immediate();
  db.transaction(() => {
    db.exec(`
      UPDATE requirements SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL;
      UPDATE requirements
         SET updated_at = (
           SELECT MAX(mi.updated_at)
             FROM memory_items mi
            WHERE mi.kind = 'requirement' AND mi.req_id = requirements.id
         )
       WHERE (
           SELECT MAX(mi.updated_at)
             FROM memory_items mi
            WHERE mi.kind = 'requirement' AND mi.req_id = requirements.id
         ) IS NOT NULL
         AND datetime((
           SELECT MAX(mi.updated_at)
             FROM memory_items mi
            WHERE mi.kind = 'requirement' AND mi.req_id = requirements.id
         )) > datetime(COALESCE(requirements.updated_at, requirements.created_at, '1970-01-01 00:00:00'));
      UPDATE requirements
         SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
       WHERE status = 'active'
         AND goal_key IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM requirements newer
            WHERE newer.status = 'active'
              AND newer.goal_key = requirements.goal_key
              AND newer.id > requirements.id
         );
      UPDATE memory_items
         SET metadata_json = json_set(
             CASE
               WHEN json_valid(COALESCE(metadata_json, '{}')) THEN COALESCE(metadata_json, '{}')
               ELSE '{}'
             END,
             '$.status',
             'superseded',
             '$.superseded',
             json('true')
           ),
           updated_at = CURRENT_TIMESTAMP
       WHERE kind = 'requirement'
         AND req_id IN (
           SELECT id FROM requirements WHERE status = 'superseded'
         )
         AND COALESCE(json_extract(
           CASE
             WHEN json_valid(COALESCE(metadata_json, '{}')) THEN COALESCE(metadata_json, '{}')
             ELSE '{}'
           END,
           '$.status'
         ), 'active') <> 'superseded';
      CREATE INDEX IF NOT EXISTS idx_requirements_status_updated_at
        ON requirements(status, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_requirements_goal_key_status
        ON requirements(goal_key, status, updated_at DESC, id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_requirements_active_goal_key_unique
        ON requirements(goal_key) WHERE status = 'active' AND goal_key IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS vectormind_requirements_touch_updated_at
      AFTER UPDATE ON requirements
      FOR EACH ROW
      WHEN NEW.updated_at = OLD.updated_at
      BEGIN
        UPDATE requirements SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
    `);
  })();

  initMemoryItemsFts();
  repairHistoricalDuplicateChangeRecords();

  insertRequirementStmt = db.prepare(
    `INSERT INTO requirements (title, context_data, goal_key, status) VALUES (?, ?, ?, 'active')`,
  );
  completeAllActiveRequirementsStmt = db.prepare(
    `UPDATE requirements SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE status = 'active'`,
  );
  completeRequirementByIdStmt = db.prepare(
    `UPDATE requirements SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  );
  getActiveRequirementStmt = db.prepare(
    `SELECT id, title, status, context_data, goal_key, created_at
     FROM requirements
     WHERE status = 'active'
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT 1`,
  );
  getActiveRequirementByIdStmt = db.prepare(
    `SELECT id, title, status, context_data, goal_key, created_at
     FROM requirements
     WHERE status = 'active' AND id = ?
     LIMIT 1`,
  );
  getActiveRequirementByGoalKeyStmt = db.prepare(
    `SELECT id, title, status, context_data, goal_key, created_at
     FROM requirements
     WHERE status = 'active' AND goal_key = ?
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT 1`,
  );
  listActiveRequirementsStmt = db.prepare(
    `SELECT id, title, status, context_data, goal_key, created_at
     FROM requirements
     WHERE status = 'active'
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT ?`,
  );
  listRecentRequirementsStmt = db.prepare(
    `SELECT id, title, status, context_data, goal_key, created_at
     FROM requirements
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT ?`,
  );
  completeRequirementMemoryItemByReqIdStmt = db.prepare(
    `UPDATE memory_items
     SET metadata_json = json_set(
         CASE
           WHEN json_valid(COALESCE(metadata_json, '{}')) THEN COALESCE(metadata_json, '{}')
           ELSE '{}'
         END,
         '$.status',
         ?
       ),
       updated_at = CURRENT_TIMESTAMP
     WHERE kind = 'requirement'
       AND req_id = ?`,
  );
  listChangeLogsForRequirementStmt = db.prepare(
    `SELECT id, req_id, file_path, intent_summary, files_json, file_count, timestamp
     FROM change_logs
     WHERE req_id = ?
     ORDER BY timestamp DESC, id DESC
     LIMIT ?`,
  );
  insertChangeLogStmt = db.prepare(
    `INSERT INTO change_logs (req_id, file_path, intent_summary, files_json, file_count)
     VALUES (?, ?, ?, ?, ?)`,
  );
  upsertSyncedFileStateStmt = db.prepare(
    `INSERT INTO synced_file_states (file_path, file_state_hash, source_change_id, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(file_path) DO UPDATE SET
       file_state_hash = excluded.file_state_hash,
       source_change_id = excluded.source_change_id,
       updated_at = CURRENT_TIMESTAMP`,
  );
  getSyncedFileStateStmt = db.prepare(
    `SELECT file_path, file_state_hash, source_change_id, updated_at
     FROM synced_file_states
     WHERE file_path = ?
     LIMIT 1`,
  );
  insertMcpGuardEventStmt = db.prepare(
    `INSERT INTO mcp_guard_events
       (tool_name, event_type, severity, title, detail, metadata_json)
     VALUES
       (?, ?, ?, ?, ?, ?)`,
  );
  insertMcpToolMetricStmt = db.prepare(
    `INSERT INTO mcp_tool_metrics
      (tool_name, duration_ms, raw_output_chars, output_chars, is_error, root_source)
     VALUES (?, ?, ?, ?, ?, ?)`,
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


  return {
    db,
    dbPath,
    ftsAvailable,
    ftsTableName: FTS_TABLE_NAME,
    indexFileSymbolsTx,
    statements: {
    insertRequirementStmt,
    getActiveRequirementStmt,
    getActiveRequirementByIdStmt,
    getActiveRequirementByGoalKeyStmt,
    listActiveRequirementsStmt,
    listRecentRequirementsStmt,
    completeAllActiveRequirementsStmt,
    completeRequirementByIdStmt,
    completeRequirementMemoryItemByReqIdStmt,
    listChangeLogsForRequirementStmt,
    insertChangeLogStmt,
    upsertSyncedFileStateStmt,
    getSyncedFileStateStmt,
    insertMcpGuardEventStmt,
    insertMcpToolMetricStmt,
    insertMemoryItemStmt,
    getMemoryItemByIdStmt,
    getRequirementMemoryItemIdStmt,
    getConventionByKeyStmt,
    insertConventionStmt,
    updateConventionByIdStmt,
    listConventionsStmt,
    upsertDecisionStmt,
    getDecisionByKeyStmt,
    listCurrentDecisionsStmt,
    upsertProjectSummaryStmt,
    getProjectSummaryStmt,
    getLatestChangeIntentForFileStmt,
    deleteFileChunkItemsStmt,
    upsertPendingChangeStmt,
    listPendingChangesStmt,
    countPendingChangesStmt,
    deletePendingChangeStmt,
    deleteAllPendingChangesStmt,
    deleteOldPendingChangesStmt,
    deleteOldestPendingChangesStmt,
    deleteSymbolsForFileStmt,
    upsertSymbolStmt,
    searchSymbolsStmt,
    insertTokenSavingsStmt,
    summarizeTokenSavingsStmt,
    summarizeTokenSavingsByToolStmt,
    listRecentTokenSavingsStmt,
    getKvStmt,
    setKvStmt,
    },
  };
}
