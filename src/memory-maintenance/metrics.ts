import { getDb } from "./context.js";
import type { MaintenanceMetricsPruneResult } from "./types.js";

export function pruneTokenSavings(opts: { dryRun: boolean; retentionDays: number }): MaintenanceMetricsPruneResult {
  const cutoff = new Date(Date.now() - opts.retentionDays * 86_400_000).toISOString();
  let deleted = 0;
  try {
    if (opts.dryRun) {
      deleted = Number(
        (
          getDb()
            .prepare(`SELECT COUNT(1) AS c FROM token_savings WHERE created_at < datetime('now', ?)`)
            .get(`-${opts.retentionDays} days`) as { c: number } | undefined
        )?.c ?? 0,
      );
    } else {
      deleted = getDb()
        .prepare(`DELETE FROM token_savings WHERE created_at < datetime('now', ?)`)
        .run(`-${opts.retentionDays} days`).changes;
    }
  } catch (err) {
    console.error("[vectormind] prune token_savings failed:", err);
  }
  return { cutoff, token_savings_deleted: deleted };
}
