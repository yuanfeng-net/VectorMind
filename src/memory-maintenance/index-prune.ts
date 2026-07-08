import fs from "node:fs";
import path from "node:path";

import { logActivity } from "../activity-log.js";
import {
  IGNORED_LIKE_PATTERNS,
  NOISE_FILE_BASENAMES,
  NOISE_FILE_SUFFIXES,
  isContentIndexableFile,
  isSymbolIndexableFile,
  shouldIgnoreContentFile,
  shouldIgnoreDbFilePath,
} from "../path-rules.js";
import {
  getDb,
  getDeleteFileChunkItemsStatement,
  getDeleteSymbolsForFileStatement,
  getProjectRoot,
  hasDb,
} from "./context.js";
import type { MaintenanceIndexPruneResult } from "./types.js";

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

function distinctChunkAndSymbolFilePaths(limit: number): string[] {
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
function classifyStaleIndexFile(filePath: string): string | null {
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
  skipReasons?: string[];
}): MaintenanceIndexPruneResult["stale_files"] {
  const filePaths = distinctChunkAndSymbolFilePaths(Math.min(50_000, opts.maxIndexFiles * 3));
  const matched: Array<{ file_path: string; reason: string }> = [];
  const skipReasons = new Set(opts.skipReasons ?? []);
  for (const fp of filePaths) {
    if (matched.length >= opts.maxIndexFiles) break;
    const reason = classifyStaleIndexFile(fp);
    if (reason && skipReasons.has(reason)) continue;
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
