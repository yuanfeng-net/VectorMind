import type { MaintainMemoryArgs } from "../tool-schemas.js";
import {
  MAINTENANCE_AUTO_ENABLED,
  MAINTENANCE_CHECKPOINT_WAL,
  MAINTENANCE_COMPACT_AFTER_DAYS,
  MAINTENANCE_INTERVAL_HOURS,
  MAINTENANCE_MAX_INDEX_FILES,
  MAINTENANCE_MAX_MEMORY_ITEMS,
  MAINTENANCE_PURGE_HIDDEN_AFTER_DAYS,
  MAINTENANCE_TOKEN_SAVINGS_RETENTION_DAYS,
} from "../config.js";
import { logActivity } from "../activity-log.js";
import { compactOldMemoryItems } from "./compaction.js";
import { getDb, getDbPath, getProjectRoot, hasDb } from "./context.js";
import {
  countFilenameNoiseIndexDeletes,
  countIgnoredIndexDeletes,
  pruneFilenameNoiseIndexes,
  pruneIgnoredIndexesByPathPatterns,
  pruneStaleFileIndexes,
} from "./index-prune.js";
import { pruneTokenSavings } from "./metrics.js";
import { prunePendingNoise } from "./pending.js";
import { purgeHiddenMemory } from "./purge.js";
import { checkpointWal, getDbSize, kvGet, kvSet, optimizeFts } from "./sqlite.js";
import type { MaintenanceResult } from "./types.js";

export function runMemoryMaintenance(
  args: MaintainMemoryArgs,
  trigger: "manual" | "auto" = "manual",
): MaintenanceResult {
  const dbSizeBefore = getDbSize();
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
    ? pruneStaleFileIndexes({
        dryRun: args.dry_run,
        maxIndexFiles: args.max_index_files,
        skipReasons: [
          ...(args.prune_ignored_paths ? ["ignored_path"] : []),
          ...(args.prune_filename_noise ? ["filename_noise"] : []),
        ],
      })
    : { files_checked: 0, files_matched: 0, chunks_deleted: 0, symbols_deleted: 0, samples: [] };

  const pendingPruned = args.prune_pending_noise
    ? prunePendingNoise({ dryRun: args.dry_run })
    : { ignored_deleted: 0, old_deleted: 0, overflow_deleted: 0 };

  const purgedHiddenMemory = args.purge_hidden_memories
    ? purgeHiddenMemory({
        dryRun: args.dry_run,
        purgeAfterDays: args.purge_after_days,
        maxMemoryItems: args.max_memory_items,
        purgeArchives: args.purge_archives,
      })
    : {
        cutoff: new Date(Date.now() - args.purge_after_days * 86_400_000).toISOString(),
        memory_candidates: 0,
        memory_deleted: 0,
        archive_candidates: 0,
        archives_deleted: 0,
        samples: [],
      };

  const metricsPruned = args.prune_token_savings
    ? pruneTokenSavings({ dryRun: args.dry_run, retentionDays: args.token_savings_retention_days })
    : {
        cutoff: new Date(Date.now() - args.token_savings_retention_days * 86_400_000).toISOString(),
        token_savings_deleted: 0,
      };

  const ftsOptimized = args.optimize_fts ? optimizeFts({ dryRun: args.dry_run }) : false;
  let walCheckpointed = args.checkpoint_wal ? checkpointWal({ dryRun: args.dry_run }) : false;

  let vacuumed = false;
  if (!args.dry_run && args.vacuum) {
    try {
      getDb().exec("VACUUM");
      vacuumed = true;
      if (args.checkpoint_wal) walCheckpointed = checkpointWal({ dryRun: false }) || walCheckpointed;
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
      purge_hidden_after_days: args.purge_after_days,
      token_savings_retention_days: args.token_savings_retention_days,
    },
    compacted_memory: compactedMemory,
    pruned: {
      ignored_paths: ignoredPaths,
      filename_noise: filenameNoise,
      stale_files: staleFiles,
    },
    pending_pruned: pendingPruned,
    purged_hidden_memory: purgedHiddenMemory,
    metrics_pruned: metricsPruned,
    fts_optimized: ftsOptimized,
    wal_checkpointed: walCheckpointed,
    vacuumed,
    db_size_before: dbSizeBefore,
    db_size_after: getDbSize(),
  };

  logActivity("memory_maintenance", {
    trigger,
    dry_run: args.dry_run,
    compacted: result.compacted_memory.compacted,
    purged_hidden: result.purged_hidden_memory.memory_deleted,
    purged_archives: result.purged_hidden_memory.archives_deleted,
    pending_pruned:
      result.pending_pruned.ignored_deleted +
      result.pending_pruned.old_deleted +
      result.pending_pruned.overflow_deleted,
    stale_files: result.pruned.stale_files.files_matched,
    chunks_deleted:
      result.pruned.ignored_paths.chunks_deleted +
      result.pruned.filename_noise.chunks_deleted +
      result.pruned.stale_files.chunks_deleted,
    db_bytes_before: result.db_size_before.total_bytes,
    db_bytes_after: result.db_size_after.total_bytes,
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
        prune_pending_noise: true,
        purge_hidden_memories: true,
        purge_archives: true,
        prune_token_savings: true,
        optimize_fts: true,
        checkpoint_wal: MAINTENANCE_CHECKPOINT_WAL,
        compact_after_days: MAINTENANCE_COMPACT_AFTER_DAYS,
        purge_after_days: MAINTENANCE_PURGE_HIDDEN_AFTER_DAYS,
        max_memory_items: MAINTENANCE_MAX_MEMORY_ITEMS,
        max_index_files: MAINTENANCE_MAX_INDEX_FILES,
        token_savings_retention_days: MAINTENANCE_TOKEN_SAVINGS_RETENTION_DAYS,
        vacuum: false,
      },
      "auto",
    );
    kvSet("maintenance.last_auto_at", new Date().toISOString());
  } catch (err) {
    console.error("[vectormind] auto maintenance failed:", err);
  }
}
