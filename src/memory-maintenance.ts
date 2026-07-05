import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { MemoryItemRow } from "./types.js";
import type { MaintainMemoryArgs } from "./tool-schemas.js";
import {
  IGNORED_LIKE_PATTERNS,
  NOISE_FILE_BASENAMES,
  NOISE_FILE_SUFFIXES,
  isContentIndexableFile,
  isSymbolIndexableFile,
  shouldIgnoreContentFile,
  shouldIgnoreDbFilePath,
} from "./path-rules.js";
import {
  MAINTENANCE_AUTO_ENABLED,
  MAINTENANCE_COMPACT_AFTER_DAYS,
  MAINTENANCE_INTERVAL_HOURS,
  MAINTENANCE_MAX_INDEX_FILES,
  MAINTENANCE_MAX_MEMORY_ITEMS,
} from "./config.js";
import { logActivity } from "./activity-log.js";
import { oneLine, safeJson } from "./tool-output.js";

type MemoryMaintenanceContext = {
  getDb: () => Database.Database | undefined;
  getProjectRoot: () => string;
  getDbPath: () => string;
  getKvStatement: () => Database.Statement | undefined;
  getSetKvStatement: () => Database.Statement | undefined;
  getDeleteFileChunkItemsStatement: () => Database.Statement;
  getDeleteSymbolsForFileStatement: () => Database.Statement;
  getInsertMemoryItemStatement: () => Database.Statement;
  sha256Hex: (input: string) => string;
  parseMetadataJson: (raw: string | null | undefined) => Record<string, unknown>;
  metadataStatus: (row: { metadata_json: string | null | undefined }) => string | null;
  isHiddenFromDefaultRecall: (row: { metadata_json: string | null | undefined }) => boolean;
};

let memoryMaintenanceContext: MemoryMaintenanceContext | null = null;

export function configureMemoryMaintenance(context: MemoryMaintenanceContext): void {
  memoryMaintenanceContext = context;
}

function requireMemoryMaintenanceContext(): MemoryMaintenanceContext {
  if (!memoryMaintenanceContext) throw new Error("[VectorMind] memory maintenance context is not configured");
  return memoryMaintenanceContext;
}

function hasDb(): boolean {
  return !!requireMemoryMaintenanceContext().getDb();
}

function getDb(): Database.Database {
  const db = requireMemoryMaintenanceContext().getDb();
  if (!db) throw new Error("[VectorMind] database is not initialized");
  return db;
}

function getProjectRoot(): string {
  return requireMemoryMaintenanceContext().getProjectRoot();
}

function getDbPath(): string {
  return requireMemoryMaintenanceContext().getDbPath();
}

function getKvStatement(): Database.Statement | undefined {
  return requireMemoryMaintenanceContext().getKvStatement();
}

function getSetKvStatement(): Database.Statement | undefined {
  return requireMemoryMaintenanceContext().getSetKvStatement();
}

function getDeleteFileChunkItemsStatement(): Database.Statement {
  return requireMemoryMaintenanceContext().getDeleteFileChunkItemsStatement();
}

function getDeleteSymbolsForFileStatement(): Database.Statement {
  return requireMemoryMaintenanceContext().getDeleteSymbolsForFileStatement();
}

function getInsertMemoryItemStatement(): Database.Statement {
  return requireMemoryMaintenanceContext().getInsertMemoryItemStatement();
}

function sha256Hex(input: string): string {
  return requireMemoryMaintenanceContext().sha256Hex(input);
}

function parseMetadataJson(raw: string | null | undefined): Record<string, unknown> {
  return requireMemoryMaintenanceContext().parseMetadataJson(raw);
}

function metadataStatus(row: { metadata_json: string | null | undefined }): string | null {
  return requireMemoryMaintenanceContext().metadataStatus(row);
}

function isHiddenFromDefaultRecall(row: { metadata_json: string | null | undefined }): boolean {
  return requireMemoryMaintenanceContext().isHiddenFromDefaultRecall(row);
}

export function pruneIgnoredIndexesByPathPatterns(): { chunks_deleted: number; symbols_deleted: number } {
  if (!hasDb()) return { chunks_deleted: 0, symbols_deleted: 0 };
  try {
    if (!IGNORED_LIKE_PATTERNS.length) return { chunks_deleted: 0, symbols_deleted: 0 };
    const where = IGNORED_LIKE_PATTERNS
      .map(() => "LOWER(REPLACE(file_path, '\\\\', '/')) LIKE ?")
      .join(" OR ");

    const chunksDeleted = getDb()
    .prepare(
        `DELETE FROM memory_items
         WHERE file_path IS NOT NULL
           AND (kind = 'code_chunk' OR kind = 'doc_chunk')
           AND (${where})`,
      )
      .run(...IGNORED_LIKE_PATTERNS).changes;

    const symbolsDeleted = getDb()
    .prepare(
        `DELETE FROM symbols
         WHERE file_path IS NOT NULL
           AND (${where})`,
      )
      .run(...IGNORED_LIKE_PATTERNS).changes;

    if (chunksDeleted || symbolsDeleted) {
      logActivity("index_prune", {
        reason: "ignored_paths",
        chunks_deleted: chunksDeleted,
        symbols_deleted: symbolsDeleted,
      });
    }

    return { chunks_deleted: chunksDeleted, symbols_deleted: symbolsDeleted };
  } catch (err) {
    console.error("[vectormind] prune indexes failed:", err);
    return { chunks_deleted: 0, symbols_deleted: 0 };
  }
}

export function pruneFilenameNoiseIndexes(): { chunks_deleted: number; symbols_deleted: number } {
  if (!hasDb()) return { chunks_deleted: 0, symbols_deleted: 0 };

  try {
    const suffixWhere = NOISE_FILE_SUFFIXES.map(() => "LOWER(file_path) LIKE ?").join(" OR ");
    const baseWhere = NOISE_FILE_BASENAMES.map(() => "(LOWER(file_path) = ? OR LOWER(file_path) LIKE ?)").join(" OR ");

    const suffixArgs = NOISE_FILE_SUFFIXES.map((s) => `%${s}`);
    const baseArgs = NOISE_FILE_BASENAMES.flatMap((n) => [n, `%/${n}`]);

    const whereParts: string[] = [];
    const args: string[] = [];
    if (suffixWhere) {
      whereParts.push(`(${suffixWhere})`);
      args.push(...suffixArgs);
    }
    if (baseWhere) {
      whereParts.push(`(${baseWhere})`);
      args.push(...baseArgs);
    }
    if (!whereParts.length) return { chunks_deleted: 0, symbols_deleted: 0 };
    const where = whereParts.join(" OR ");

    const chunksDeleted = getDb()
    .prepare(
        `DELETE FROM memory_items
         WHERE file_path IS NOT NULL
           AND (kind = 'code_chunk' OR kind = 'doc_chunk')
           AND (${where})`,
      )
      .run(...args).changes;

    const symbolsDeleted = getDb()
    .prepare(
        `DELETE FROM symbols
         WHERE file_path IS NOT NULL
           AND (${where})`,
      )
      .run(...args).changes;

    if (chunksDeleted || symbolsDeleted) {
      logActivity("index_prune", {
        reason: "filename_noise",
        chunks_deleted: chunksDeleted,
        symbols_deleted: symbolsDeleted,
      });
    }

    return { chunks_deleted: chunksDeleted, symbols_deleted: symbolsDeleted };
  } catch (err) {
    console.error("[vectormind] prune filename noise failed:", err);
    return { chunks_deleted: 0, symbols_deleted: 0 };
  }
}

export type MaintenanceIndexPruneResult = {
  ignored_paths: { chunks_deleted: number; symbols_deleted: number };
  filename_noise: { chunks_deleted: number; symbols_deleted: number };
  stale_files: {
    files_checked: number;
    files_matched: number;
    chunks_deleted: number;
    symbols_deleted: number;
    samples: string[];
  };
};

export type MaintenanceCompactionResult = {
  cutoff: string;
  candidates: number;
  compacted: number;
  summary_memory_id: number | null;
  archived: number;
  samples: Array<{ id: number; kind: string; title: string | null; file_path: string | null; updated_at: string }>;
};

export type MaintenanceResult = {
  ok: true;
  dry_run: boolean;
  trigger: "manual" | "auto";
  generated_at: string;
  project_root: string;
  db_path: string;
  config: {
    compact_after_days: number;
    max_memory_items: number;
    max_index_files: number;
    compact_notes: boolean;
  };
  compacted_memory: MaintenanceCompactionResult;
  pruned: MaintenanceIndexPruneResult;
  vacuumed: boolean;
};

export function kvGet(key: string): string | null {
  try {
    const row = getKvStatement()?.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function kvSet(key: string, value: string): void {
  try {
    getSetKvStatement()?.run(key, value);
  } catch (err) {
    console.error("[vectormind] kv set failed:", err);
  }
}

export function distinctChunkAndSymbolFilePaths(limit: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT file_path
       FROM (
         SELECT file_path, MAX(updated_at) AS updated_at
         FROM memory_items
         WHERE file_path IS NOT NULL
           AND (kind = 'code_chunk' OR kind = 'doc_chunk')
         GROUP BY file_path
         UNION
         SELECT file_path, CURRENT_TIMESTAMP AS updated_at
         FROM symbols
         WHERE file_path IS NOT NULL
         GROUP BY file_path
       )
       WHERE file_path IS NOT NULL
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{ file_path: string }>;
  return Array.from(new Set(rows.map((r) => r.file_path).filter(Boolean)));
}

export function classifyStaleIndexFile(filePath: string): string | null {
  if (!filePath) return "empty_path";
  if (shouldIgnoreDbFilePath(filePath)) return "ignored_path";
  if (shouldIgnoreContentFile(filePath)) return "filename_noise";

  const absPath = path.isAbsolute(filePath) ? filePath : path.join(getProjectRoot(), filePath);
  const rel = path.relative(getProjectRoot(), absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "outside_project";
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return "missing_file";
  }
  if (!stat.isFile()) return "not_file";
  if (!isContentIndexableFile(absPath) && !isSymbolIndexableFile(absPath)) return "not_indexable";
  return null;
}

export function pruneStaleFileIndexes(opts: {
  dryRun: boolean;
  maxIndexFiles: number;
}): MaintenanceIndexPruneResult["stale_files"] {
  const filePaths = distinctChunkAndSymbolFilePaths(Math.min(50_000, opts.maxIndexFiles * 3));
  const matched: Array<{ file_path: string; reason: string }> = [];
  for (const fp of filePaths) {
    if (matched.length >= opts.maxIndexFiles) break;
    const reason = classifyStaleIndexFile(fp);
    if (reason) matched.push({ file_path: fp, reason });
  }

  let chunksDeleted = 0;
  let symbolsDeleted = 0;
  const samples = matched.slice(0, 20).map((m) => `${m.file_path} (${m.reason})`);

  if (!opts.dryRun && matched.length) {
    const tx = getDb().transaction(() => {
      for (const m of matched) {
        chunksDeleted += getDeleteFileChunkItemsStatement().run(m.file_path).changes;
        symbolsDeleted += getDeleteSymbolsForFileStatement().run(m.file_path).changes;
      }
    });
    try {
      tx();
    } catch (err) {
      console.error("[vectormind] prune stale indexes failed:", err);
    }
  } else if (opts.dryRun && matched.length) {
    const countChunksStmt = getDb().prepare(
      `SELECT COUNT(1) AS c
       FROM memory_items
       WHERE file_path = ?
         AND (kind = 'code_chunk' OR kind = 'doc_chunk')`,
    );
    const countSymbolsStmt = getDb().prepare(`SELECT COUNT(1) AS c FROM symbols WHERE file_path = ?`);
    for (const m of matched) {
      chunksDeleted += Number((countChunksStmt.get(m.file_path) as { c: number } | undefined)?.c ?? 0);
      symbolsDeleted += Number((countSymbolsStmt.get(m.file_path) as { c: number } | undefined)?.c ?? 0);
    }
  }

  if (!opts.dryRun && (chunksDeleted || symbolsDeleted)) {
    logActivity("index_prune", {
      reason: "stale_files",
      files_matched: matched.length,
      chunks_deleted: chunksDeleted,
      symbols_deleted: symbolsDeleted,
      samples,
    });
  }

  return {
    files_checked: filePaths.length,
    files_matched: matched.length,
    chunks_deleted: chunksDeleted,
    symbols_deleted: symbolsDeleted,
    samples,
  };
}

export function countIgnoredIndexDeletes(): { chunks_deleted: number; symbols_deleted: number } {
  if (!IGNORED_LIKE_PATTERNS.length) return { chunks_deleted: 0, symbols_deleted: 0 };
  const where = IGNORED_LIKE_PATTERNS
    .map(() => "LOWER(REPLACE(file_path, '\\\\', '/')) LIKE ?")
    .join(" OR ");
  const chunksDeleted = Number(
    (
      getDb()
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
  const symbolsDeleted = Number(
    (
      getDb()
    .prepare(
          `SELECT COUNT(1) AS c
           FROM symbols
           WHERE file_path IS NOT NULL
             AND (${where})`,
        )
        .get(...IGNORED_LIKE_PATTERNS) as { c: number } | undefined
    )?.c ?? 0,
  );
  return { chunks_deleted: chunksDeleted, symbols_deleted: symbolsDeleted };
}

export function countFilenameNoiseIndexDeletes(): { chunks_deleted: number; symbols_deleted: number } {
  const suffixWhere = NOISE_FILE_SUFFIXES.map(() => "LOWER(file_path) LIKE ?").join(" OR ");
  const baseWhere = NOISE_FILE_BASENAMES.map(() => "(LOWER(file_path) = ? OR LOWER(file_path) LIKE ?)").join(" OR ");
  const suffixArgs = NOISE_FILE_SUFFIXES.map((s) => `%${s}`);
  const baseArgs = NOISE_FILE_BASENAMES.flatMap((n) => [n, `%/${n}`]);
  const whereParts: string[] = [];
  const args: string[] = [];
  if (suffixWhere) {
    whereParts.push(`(${suffixWhere})`);
    args.push(...suffixArgs);
  }
  if (baseWhere) {
    whereParts.push(`(${baseWhere})`);
    args.push(...baseArgs);
  }
  if (!whereParts.length) return { chunks_deleted: 0, symbols_deleted: 0 };
  const where = whereParts.join(" OR ");
  const chunksDeleted = Number(
    (
      getDb()
    .prepare(
          `SELECT COUNT(1) AS c
           FROM memory_items
           WHERE file_path IS NOT NULL
             AND (kind = 'code_chunk' OR kind = 'doc_chunk')
             AND (${where})`,
        )
        .get(...args) as { c: number } | undefined
    )?.c ?? 0,
  );
  const symbolsDeleted = Number(
    (
      getDb()
    .prepare(
          `SELECT COUNT(1) AS c
           FROM symbols
           WHERE file_path IS NOT NULL
             AND (${where})`,
        )
        .get(...args) as { c: number } | undefined
    )?.c ?? 0,
  );
  return { chunks_deleted: chunksDeleted, symbols_deleted: symbolsDeleted };
}

export function selectCompactionCandidates(opts: {
  compactAfterDays: number;
  maxMemoryItems: number;
  compactNotes: boolean;
}): Array<MemoryItemRow & { req_status?: string | null }> {
  const kinds = opts.compactNotes
    ? ["requirement", "change_intent", "note"]
    : ["requirement", "change_intent"];
  const placeholders = kinds.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT
         m.id, m.kind, m.title, m.content, m.file_path, m.start_line, m.end_line,
         m.req_id, m.metadata_json, m.content_hash, m.created_at, m.updated_at,
         r.status AS req_status
       FROM memory_items m
       LEFT JOIN requirements r ON r.id = m.req_id
       WHERE m.kind IN (${placeholders})
         AND m.updated_at < datetime('now', ?)
       ORDER BY m.updated_at ASC, m.id ASC
       LIMIT ?`,
    )
    .all(...kinds, `-${opts.compactAfterDays} days`, Math.min(20_000, opts.maxMemoryItems * 5)) as Array<
    MemoryItemRow & { req_status?: string | null }
  >;

  return rows
    .filter((row) => !isHiddenFromDefaultRecall(row))
    .filter((row) => metadataStatus(row) !== "current" && metadataStatus(row) !== "active")
    .filter((row) => row.req_status !== "active")
    .filter((row) => row.kind !== "note" || opts.compactNotes)
    .slice(0, opts.maxMemoryItems);
}

export function compactionLine(row: MemoryItemRow): string {
  const date = oneLine(row.updated_at || row.created_at, 19);
  const title = row.title ? ` ${oneLine(row.title, 80)}` : "";
  const file = row.file_path ? ` file=${row.file_path}${row.start_line != null ? `:${row.start_line}` : ""}` : "";
  const req = row.req_id != null ? ` req#${row.req_id}` : "";
  return `- ${date} #${row.id} ${row.kind}${req}${file}${title}: ${oneLine(row.content, 220)}`;
}

export function compactOldMemoryItems(opts: {
  dryRun: boolean;
  compactAfterDays: number;
  maxMemoryItems: number;
  compactNotes: boolean;
}): MaintenanceCompactionResult {
  const candidates = selectCompactionCandidates(opts);
  const cutoff = new Date(Date.now() - opts.compactAfterDays * 86_400_000).toISOString();
  const samples = candidates.slice(0, 20).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    file_path: row.file_path,
    updated_at: row.updated_at,
  }));

  if (opts.dryRun || !candidates.length) {
    return {
      cutoff,
      candidates: candidates.length,
      compacted: 0,
      summary_memory_id: null,
      archived: 0,
      samples,
    };
  }

  const now = new Date().toISOString();
  const lines = [
    `Auto-compacted ${candidates.length} old VectorMind memory items.`,
    `Cutoff: items updated before ${cutoff} (${opts.compactAfterDays} days).`,
    "",
    "This compact summary keeps old history searchable while detailed stale items are hidden from default recall.",
    "Durable decisions, conventions, and project summaries are never compacted by this automatic pass.",
    "",
    ...candidates.map(compactionLine),
  ];
  const content = lines.join("\n");
  const title = `Memory compaction ${now.slice(0, 10)}`;
  const metadata = {
    source: "maintenance",
    status: "current",
    compacted_item_ids: candidates.map((c) => c.id),
    compact_after_days: opts.compactAfterDays,
    compact_notes: opts.compactNotes,
    generated_at: now,
  };

  let summaryMemoryId = 0;
  let archived = 0;
  const archiveStmt = getDb().prepare(
    `INSERT OR IGNORE INTO memory_item_archive
       (memory_id, original_kind, original_title, original_content, original_file_path,
        original_start_line, original_end_line, original_req_id, original_metadata_json,
        original_content_hash, original_created_at, original_updated_at, archive_reason, compacted_into_id)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateMemoryStmt = getDb().prepare(
    `UPDATE memory_items
     SET content = ?, metadata_json = ?, content_hash = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  );

  const tx = getDb().transaction(() => {
    const info = getInsertMemoryItemStatement().run(
      "memory_compaction",
      title,
      content,
      null,
      null,
      null,
      null,
      safeJson(metadata),
      sha256Hex(content),
    );
    summaryMemoryId = Number(info.lastInsertRowid);

    for (const row of candidates) {
      const archiveInfo = archiveStmt.run(
        row.id,
        row.kind,
        row.title,
        row.content,
        row.file_path,
        row.start_line,
        row.end_line,
        row.req_id,
        row.metadata_json,
        row.content_hash,
        row.created_at,
        row.updated_at,
        "auto_compaction",
        summaryMemoryId,
      );
      if (archiveInfo.changes > 0) archived += 1;

      const patchedMeta = {
        ...parseMetadataJson(row.metadata_json),
        status: "compacted",
        compacted: true,
        compacted_at: now,
        compacted_into_memory_id: summaryMemoryId,
      };
      const stub = [
        `[compacted into memory item #${summaryMemoryId}]`,
        `Original ${row.kind} #${row.id} was older than ${opts.compactAfterDays} days and is excluded from default recall.`,
        `Summary: ${oneLine(row.title || row.content, 260)}`,
      ].join("\n");
      updateMemoryStmt.run(stub, safeJson(patchedMeta), sha256Hex(stub), row.id);
    }
  });

  try {
    tx();
  } catch (err) {
    console.error("[vectormind] compact old memory failed:", err);
    summaryMemoryId = 0;
  }

  if (summaryMemoryId) {
    logActivity("memory_maintenance", {
      reason: "compact_old_memories",
      compacted: candidates.length,
      summary_memory_id: summaryMemoryId,
      archived,
    });
  }

  return {
    cutoff,
    candidates: candidates.length,
    compacted: summaryMemoryId ? candidates.length : 0,
    summary_memory_id: summaryMemoryId || null,
    archived,
    samples,
  };
}

export function runMemoryMaintenance(
  args: MaintainMemoryArgs,
  trigger: "manual" | "auto" = "manual",
): MaintenanceResult {
  const compactedMemory = args.compact_old_memories
    ? compactOldMemoryItems({
        dryRun: args.dry_run,
        compactAfterDays: args.compact_after_days,
        maxMemoryItems: args.max_memory_items,
        compactNotes: args.compact_notes,
      })
    : {
        cutoff: new Date(Date.now() - args.compact_after_days * 86_400_000).toISOString(),
        candidates: 0,
        compacted: 0,
        summary_memory_id: null,
        archived: 0,
        samples: [],
      };

  const ignoredPaths = args.prune_ignored_paths
    ? args.dry_run
      ? countIgnoredIndexDeletes()
      : pruneIgnoredIndexesByPathPatterns()
    : { chunks_deleted: 0, symbols_deleted: 0 };

  const filenameNoise = args.prune_filename_noise
    ? args.dry_run
      ? countFilenameNoiseIndexDeletes()
      : pruneFilenameNoiseIndexes()
    : { chunks_deleted: 0, symbols_deleted: 0 };

  const staleFiles = args.prune_stale_indexes
    ? pruneStaleFileIndexes({ dryRun: args.dry_run, maxIndexFiles: args.max_index_files })
    : { files_checked: 0, files_matched: 0, chunks_deleted: 0, symbols_deleted: 0, samples: [] };

  let vacuumed = false;
  if (!args.dry_run && args.vacuum) {
    try {
      getDb().exec("VACUUM");
      vacuumed = true;
    } catch (err) {
      console.error("[vectormind] maintenance vacuum failed:", err);
    }
  }

  const result: MaintenanceResult = {
    ok: true,
    dry_run: args.dry_run,
    trigger,
    generated_at: new Date().toISOString(),
    project_root: getProjectRoot(),
    db_path: getDbPath(),
    config: {
      compact_after_days: args.compact_after_days,
      max_memory_items: args.max_memory_items,
      max_index_files: args.max_index_files,
      compact_notes: args.compact_notes,
    },
    compacted_memory: compactedMemory,
    pruned: {
      ignored_paths: ignoredPaths,
      filename_noise: filenameNoise,
      stale_files: staleFiles,
    },
    vacuumed,
  };

  logActivity("memory_maintenance", {
    trigger,
    dry_run: args.dry_run,
    compacted: result.compacted_memory.compacted,
    stale_files: result.pruned.stale_files.files_matched,
    chunks_deleted:
      result.pruned.ignored_paths.chunks_deleted +
      result.pruned.filename_noise.chunks_deleted +
      result.pruned.stale_files.chunks_deleted,
  });

  return result;
}

export function runAutoMaintenanceIfDue(): void {
  if (!MAINTENANCE_AUTO_ENABLED || !hasDb()) return;
  const lastRaw = kvGet("maintenance.last_auto_at");
  const last = lastRaw ? Date.parse(lastRaw) : 0;
  const dueMs = MAINTENANCE_INTERVAL_HOURS * 3_600_000;
  if (Number.isFinite(last) && last > 0 && Date.now() - last < dueMs) return;

  try {
    runMemoryMaintenance(
      {
        project_root: getProjectRoot(),
        dry_run: false,
        format: "compact",
        compact_old_memories: true,
        compact_notes: false,
        prune_stale_indexes: true,
        prune_ignored_paths: true,
        prune_filename_noise: true,
        compact_after_days: MAINTENANCE_COMPACT_AFTER_DAYS,
        max_memory_items: MAINTENANCE_MAX_MEMORY_ITEMS,
        max_index_files: MAINTENANCE_MAX_INDEX_FILES,
        vacuum: false,
      },
      "auto",
    );
    kvSet("maintenance.last_auto_at", new Date().toISOString());
  } catch (err) {
    console.error("[vectormind] auto maintenance failed:", err);
  }
}
