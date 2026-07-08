import { PENDING_MAX_ENTRIES, PENDING_TTL_DAYS } from "../config.js";
import { logActivity } from "../activity-log.js";
import { IGNORED_LIKE_PATTERNS } from "../path-rules.js";
import { getDb } from "./context.js";
import type { MaintenancePendingPruneResult } from "./types.js";

function ignoredPathWhere(column = "file_path"): string {
  return IGNORED_LIKE_PATTERNS
    .map(() => `LOWER(REPLACE(${column}, '\\\\', '/')) LIKE ?`)
    .join(" OR ");
}
export function prunePendingNoise(opts: { dryRun: boolean }): MaintenancePendingPruneResult {
  let ignoredDeleted = 0;
  let oldDeleted = 0;
  let overflowDeleted = 0;
  try {
    const ignoredWhere = IGNORED_LIKE_PATTERNS.length ? ignoredPathWhere("file_path") : "";
    if (IGNORED_LIKE_PATTERNS.length) {
      if (opts.dryRun) {
        ignoredDeleted = Number(
          (getDb().prepare(`SELECT COUNT(1) AS c FROM pending_changes WHERE ${ignoredWhere}`).get(...IGNORED_LIKE_PATTERNS) as { c: number } | undefined)?.c ?? 0,
        );
      } else {
        ignoredDeleted = getDb().prepare(`DELETE FROM pending_changes WHERE ${ignoredWhere}`).run(...IGNORED_LIKE_PATTERNS).changes;
      }
    }

    if (PENDING_TTL_DAYS > 0) {
      if (opts.dryRun) {
        const where = ignoredWhere ? `updated_at < datetime('now', ?) AND NOT (${ignoredWhere})` : "updated_at < datetime('now', ?)";
        const params = ignoredWhere ? [`-${PENDING_TTL_DAYS} days`, ...IGNORED_LIKE_PATTERNS] : [`-${PENDING_TTL_DAYS} days`];
        oldDeleted = Number(
          (
            getDb()
              .prepare(`SELECT COUNT(1) AS c FROM pending_changes WHERE ${where}`)
              .get(...params) as { c: number } | undefined
          )?.c ?? 0,
        );
      } else {
        oldDeleted = Number(
          getDb()
            .prepare(`DELETE FROM pending_changes WHERE updated_at < datetime('now', ?)`)
            .run(`-${PENDING_TTL_DAYS} days`).changes,
        );
      }
    }

    const totalRows = Number(
      (getDb().prepare(`SELECT COUNT(1) AS c FROM pending_changes`).get() as { c: number } | undefined)?.c ?? 0,
    );
    const totalAfterIgnored = opts.dryRun ? Math.max(0, totalRows - ignoredDeleted - oldDeleted) : totalRows;
    const overflow = PENDING_MAX_ENTRIES > 0 ? totalAfterIgnored - PENDING_MAX_ENTRIES : 0;
    if (overflow > 0) {
      if (opts.dryRun) {
        overflowDeleted = overflow;
      } else {
        overflowDeleted = getDb()
          .prepare(
            `DELETE FROM pending_changes
             WHERE file_path IN (
               SELECT file_path FROM pending_changes
               ORDER BY updated_at ASC
               LIMIT ?
             )`,
          )
          .run(overflow).changes;
      }
    }
  } catch (err) {
    console.error("[vectormind] prune pending noise failed:", err);
  }
  if (!opts.dryRun && (ignoredDeleted || oldDeleted || overflowDeleted)) {
    logActivity("pending_prune", {
      reason: "maintenance",
      ignored_deleted: ignoredDeleted,
      old_deleted: oldDeleted,
      overflow_deleted: overflowDeleted,
    });
  }
  return {
    ignored_deleted: ignoredDeleted,
    old_deleted: oldDeleted,
    overflow_deleted: overflowDeleted,
  };
}
