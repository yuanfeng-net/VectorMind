import { getDb } from "./context.js";
import type { MaintenanceMetricsPruneResult } from "./types.js";

export function pruneMetrics(opts: { dryRun: boolean; retentionDays: number }): MaintenanceMetricsPruneResult {
  const cutoff = new Date(Date.now() - opts.retentionDays * 86_400_000).toISOString();
  let deleted = 0;
  let toolMetricsDeleted = 0;
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
    if (opts.dryRun) {
      toolMetricsDeleted = Number(
        (getDb().prepare(`SELECT COUNT(1) AS c FROM mcp_tool_metrics WHERE created_at < datetime('now', ?)`).get(
          `-${opts.retentionDays} days`,
        ) as { c: number } | undefined)?.c ?? 0,
      );
    } else {
      toolMetricsDeleted = getDb()
        .prepare(`DELETE FROM mcp_tool_metrics WHERE created_at < datetime('now', ?)`).run(
          `-${opts.retentionDays} days`,
        ).changes;
    }
  } catch (err) {
    console.error("[vectormind] prune metrics failed:", err);
  }
  return { cutoff, token_savings_deleted: deleted, mcp_tool_metrics_deleted: toolMetricsDeleted };
}
