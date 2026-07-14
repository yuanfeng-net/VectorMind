import type { MemoryItemRow } from "../types.js";
import { logActivity } from "../activity-log.js";
import { getDb } from "./context.js";
import type { MaintenancePurgeHiddenResult } from "./types.js";

const SAFE_HARD_PURGE_KINDS = ["requirement", "change_intent", "note", "large_file_split_plan"];

function validMetadataExpr(alias: string): string {
  return `CASE WHEN json_valid(COALESCE(${alias}.metadata_json, '{}')) THEN COALESCE(${alias}.metadata_json, '{}') ELSE '{}' END`;
}

function hiddenMemoryWhere(alias = "m"): string {
  const meta = validMetadataExpr(alias);
  return `
    ${alias}.kind IN (${SAFE_HARD_PURGE_KINDS.map(() => "?").join(", ")})
    AND (
      json_extract(${meta}, '$.status') IN ('compacted', 'superseded')
      OR json_extract(${meta}, '$.compacted') = 1
      OR json_extract(${meta}, '$.superseded') = 1
    )
    AND (
      EXISTS (
        SELECT 1
        FROM memory_item_archive a
        WHERE a.memory_id = ${alias}.id
          AND COALESCE(a.original_updated_at, a.original_created_at, a.archived_at) < datetime('now', ?)
      )
      OR (
        NOT EXISTS (SELECT 1 FROM memory_item_archive a2 WHERE a2.memory_id = ${alias}.id)
        AND ${alias}.updated_at < datetime('now', ?)
      )
    )
  `;
}

function selectHiddenMemoryPurgeCandidates(purgeAfterDays: number, limit: number): MemoryItemRow[] {
  return getDb()
    .prepare(
      `SELECT m.id, m.kind, m.title, m.content, m.file_path, m.start_line, m.end_line,
              m.req_id, m.metadata_json, m.content_hash, m.created_at, m.updated_at
       FROM memory_items m
       WHERE ${hiddenMemoryWhere("m")}
       ORDER BY m.updated_at ASC, m.id ASC
       LIMIT ?`,
    )
    .all(...SAFE_HARD_PURGE_KINDS, `-${purgeAfterDays} days`, `-${purgeAfterDays} days`, Math.max(1, limit)) as MemoryItemRow[];
}

export function purgeHiddenMemory(opts: {
  dryRun: boolean;
  purgeAfterDays: number;
  maxMemoryItems: number;
  purgeArchives: boolean;
}): MaintenancePurgeHiddenResult {
  const cutoff = new Date(Date.now() - opts.purgeAfterDays * 86_400_000).toISOString();
  const candidates = selectHiddenMemoryPurgeCandidates(opts.purgeAfterDays, opts.maxMemoryItems);
  const samples = candidates.slice(0, 20).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    file_path: row.file_path,
    updated_at: row.updated_at,
  }));

  let memoryDeleted = 0;
  let archiveCandidates = 0;
  let archivesDeleted = 0;

  try {
    archiveCandidates = Number(
      (
        getDb()
          .prepare(
            `SELECT COUNT(1) AS c
             FROM memory_item_archive
             WHERE original_kind IN (${SAFE_HARD_PURGE_KINDS.map(() => "?").join(", ")})
               AND archive_reason = 'auto_compaction'
               AND COALESCE(original_updated_at, original_created_at, archived_at) < datetime('now', ?)`,
          )
          .get(...SAFE_HARD_PURGE_KINDS, `-${opts.purgeAfterDays} days`) as { c: number } | undefined
      )?.c ?? 0,
    );
  } catch (err) {
    console.error("[vectormind] count hidden archives failed:", err);
  }

  if (!opts.dryRun && (candidates.length || (opts.purgeArchives && archiveCandidates))) {
    const candidateIds = candidates.map((row) => row.id);
    const tx = getDb().transaction(() => {
      if (candidateIds.length) {
        const deleteMemory = getDb().prepare(`DELETE FROM memory_items WHERE id = ?`);
        for (const id of candidateIds) {
          memoryDeleted += deleteMemory.run(id).changes;
        }
      }
      if (opts.purgeArchives) {
        archivesDeleted = getDb()
          .prepare(
            `DELETE FROM memory_item_archive
             WHERE rowid IN (
               SELECT rowid
               FROM memory_item_archive
               WHERE original_kind IN (${SAFE_HARD_PURGE_KINDS.map(() => "?").join(", ")})
                 AND archive_reason = 'auto_compaction'
                 AND COALESCE(original_updated_at, original_created_at, archived_at) < datetime('now', ?)
               ORDER BY COALESCE(original_updated_at, original_created_at, archived_at) ASC, memory_id ASC
               LIMIT ?
             )`,
          )
          .run(...SAFE_HARD_PURGE_KINDS, `-${opts.purgeAfterDays} days`, Math.max(1, opts.maxMemoryItems)).changes;
      }
    });
    try {
      tx();
    } catch (err) {
      console.error("[vectormind] purge hidden memory failed:", err);
      memoryDeleted = 0;
      archivesDeleted = 0;
    }
  }

  if (!opts.dryRun && (memoryDeleted || archivesDeleted)) {
    logActivity("memory_maintenance", {
      reason: "purge_hidden_memory",
      memory_deleted: memoryDeleted,
      archives_deleted: archivesDeleted,
      purge_after_days: opts.purgeAfterDays,
    });
  }

  return {
    cutoff,
    memory_candidates: candidates.length,
    memory_deleted: memoryDeleted,
    archive_candidates: archiveCandidates,
    archives_deleted: archivesDeleted,
    samples,
  };
}
