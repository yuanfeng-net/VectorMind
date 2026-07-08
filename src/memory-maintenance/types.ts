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

export type MaintenancePendingPruneResult = {
  ignored_deleted: number;
  old_deleted: number;
  overflow_deleted: number;
};

export type MaintenancePurgeHiddenResult = {
  cutoff: string;
  memory_candidates: number;
  memory_deleted: number;
  archive_candidates: number;
  archives_deleted: number;
  samples: Array<{ id: number; kind: string; title: string | null; file_path: string | null; updated_at: string }>;
};

export type MaintenanceMetricsPruneResult = {
  cutoff: string;
  token_savings_deleted: number;
};

export type MaintenanceDbSize = {
  db_bytes: number;
  wal_bytes: number;
  shm_bytes: number;
  total_bytes: number;
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
    purge_hidden_after_days: number;
    token_savings_retention_days: number;
  };
  compacted_memory: MaintenanceCompactionResult;
  pruned: MaintenanceIndexPruneResult;
  pending_pruned: MaintenancePendingPruneResult;
  purged_hidden_memory: MaintenancePurgeHiddenResult;
  metrics_pruned: MaintenanceMetricsPruneResult;
  fts_optimized: boolean;
  wal_checkpointed: boolean;
  vacuumed: boolean;
  db_size_before: MaintenanceDbSize;
  db_size_after: MaintenanceDbSize;
};
