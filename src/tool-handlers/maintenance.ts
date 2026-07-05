import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import { INDEX_AUTO_PRUNE_IGNORED, INDEX_MAX_CODE_BYTES, INDEX_MAX_DOC_BYTES, INDEX_SKIP_MINIFIED } from "../config.js";
import { MaintainMemoryArgsSchema, PruneIndexArgsSchema } from "../tool-schemas.js";
import { toolCompactOrJson } from "../token-savings.js";
import { flushPendingChangeBuffer } from "../file-indexing.js";
import { pruneIgnoredIndexesByPathPatterns, runMemoryMaintenance } from "../memory-maintenance.js";
import { logActivity } from "../activity-log.js";
import { IGNORED_LIKE_PATTERNS, looksLikeMinifiedBundle } from "../path-rules.js";
import { compactMaintenanceText, toolJson } from "../tool-output.js";
export async function handlePruneIndex(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const db = context.getDb();
  const { deleteFileChunkItemsStmt, deleteSymbolsForFileStmt } = context.getStatements();

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
export async function handleMaintainMemory(
  rawArgs: Record<string, unknown>,
  _context: ToolHandlerContext,
): Promise<CallToolResult> {
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
