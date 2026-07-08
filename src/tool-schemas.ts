import { z } from "zod";

import {
  MAINTENANCE_COMPACT_AFTER_DAYS,
  MAINTENANCE_MAX_INDEX_FILES,
  MAINTENANCE_MAX_MEMORY_ITEMS,
} from "./config.js";
const ProjectRootArgSchema = z.object({
  project_root: z.string().optional(),
});
const OutputFormatSchema = z.object({
  format: z.enum(["compact", "json"]).optional().default("compact"),
});

export type OutputFormat = z.infer<typeof OutputFormatSchema>["format"];

const RequirementItemSchema = z.string().min(1);
const FixPatternSchema = z.object({
  symptom: z.string().min(1),
  root_cause: z.string().min(1),
  invariant: z.string().min(1),
  applies_when: z.array(z.string().min(1)).optional(),
  avoid_regression: z.array(z.string().min(1)).optional(),
  verification: z.array(z.string().min(1)).optional(),
  verification_gaps: z.array(z.string().min(1)).optional(),
});
const PlannedChangeSchema = z.object({
  file: z.string().min(1).optional(),
  change: z.string().min(1),
  requirement_refs: z.array(z.string().min(1)).optional(),
  supporting_change: z.boolean().optional().default(false),
  change_type: z
    .enum(["requirement", "supporting_change", "mechanical_modularization", "validation", "formatting", "test", "build_fix"])
    .optional()
    .default("requirement"),
});

export const StartRequirementArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    title: z.string().min(1),
    background: z.string().optional().default(""),
    close_previous: z.boolean().optional().default(true),
    scope_allow: z.array(z.string().min(1)).optional(),
    scope_deny: z.array(z.string().min(1)).optional(),
    allowed_paths: z.array(z.string().min(1)).optional(),
    denied_paths: z.array(z.string().min(1)).optional(),
    requirement_items: z.array(RequirementItemSchema).optional(),
  }),
);

export const SyncChangeIntentArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    intent: z.string().min(1),
    files: z.array(z.string().min(1)).optional(),
    affected_files: z.array(z.string().min(1)).optional(),
    verification: z.array(z.string().min(1)).optional(),
    verification_gaps: z.array(z.string().min(1)).optional(),
    fix_pattern: FixPatternSchema.optional(),
  }),
);

export const PreflightChangeScopeArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    intent: z.string().optional().default(""),
    files: z.array(z.string().min(1)).optional(),
    planned_files: z.array(z.string().min(1)).optional(),
    change_mode: z
      .enum(["feature", "bugfix", "refactor", "mechanical_modularization", "emergency_hotfix"])
      .optional()
      .default("feature"),
    scope_allow: z.array(z.string().min(1)).optional(),
    scope_deny: z.array(z.string().min(1)).optional(),
    allowed_paths: z.array(z.string().min(1)).optional(),
    denied_paths: z.array(z.string().min(1)).optional(),
    requirement_items: z.array(RequirementItemSchema).optional(),
    planned_changes: z.array(PlannedChangeSchema).optional(),
  }),
);

export const PreflightOperationScopeArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    operation: z.string().min(1),
    intent: z.string().optional().default(""),
    commands: z.array(z.string().min(1)).optional(),
    files: z.array(z.string().min(1)).optional(),
    targets: z.array(z.string().min(1)).optional(),
    script_hints: z.array(z.string().min(1)).optional(),
    constraints_limit: z.number().int().min(1).max(50).optional().default(12),
    preview_chars: z.number().int().min(50).max(10_000).optional().default(180),
  }),
);

export const PlanLargeFileSplitArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    file: z.string().min(1),
    intent: z.string().optional().default("mechanical modularization"),
    target_dir: z.string().optional(),
    max_modules: z.number().int().min(2).max(30).optional().default(12),
  }),
);

export const RecordLargeFileSplitArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    file: z.string().min(1),
    status: z.enum(["planned", "in_progress", "partial", "resolved"]),
    summary: z.string().min(1),
    modules: z.array(z.string().min(1)).optional(),
    remaining_lines: z.number().int().min(0).optional(),
  }),
);

export const QueryCodebaseArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    query: z.string().min(1),
  }),
);

export const GrepArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    // Pattern to search for. Defaults to regex mode for parity with tools like ripgrep.
    query: z.string().min(1),
    mode: z.enum(["regex", "literal"]).optional().default("regex"),
    // If case_sensitive is omitted and smart_case=true, uppercase => case-sensitive, otherwise case-insensitive.
    smart_case: z.boolean().optional().default(true),
    case_sensitive: z.boolean().optional(),
    // Compatibility knob for the indexed fallback when ripgrep is unavailable.
    literal_hint: z.string().optional().default(""),
    // Compatibility knob for the indexed fallback when ripgrep is unavailable.
    kinds: z.array(z.string().min(1)).optional(),
    include_paths: z.array(z.string().min(1)).optional(),
    exclude_paths: z.array(z.string().min(1)).optional(),
    max_results: z.number().int().min(1).max(5000).optional().default(200),
    // Compatibility knob for the indexed fallback when ripgrep is unavailable.
    max_candidates: z.number().int().min(1).max(50_000).optional(),
  }),
);

export const ReadFileLinesArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    // Relative to project_root, or an absolute path under project_root.
    path: z.string().min(1),
    from_line: z.number().int().min(1).optional().default(1),
    to_line: z.number().int().min(1).optional(),
    // Convenience for "head": if set, reads from_line..(from_line+total_count-1) unless to_line is provided.
    total_count: z.number().int().min(1).optional(),
    // Hard limits to avoid huge token blow-ups.
    max_lines: z.number().int().min(1).max(2000).optional().default(400),
    max_chars: z.number().int().min(200).max(200_000).optional().default(20_000),
  }),
);

export const ReadFileTextArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    // Relative to project_root, or an absolute path under project_root.
    path: z.string().min(1),
    // Character offset in the decoded UTF-8 text.
    offset: z.number().int().min(0).optional().default(0),
    // Hard limit on returned text to avoid huge outputs.
    max_chars: z.number().int().min(1).max(200_000).optional().default(20_000),
    // Safety guard for raw reads; use read_file_lines on larger files.
    max_file_bytes: z.number().int().min(1_000).max(5_000_000).optional().default(1_000_000),
  }),
);

export const ReadCodexTextFileArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    // Absolute path, file:// URI, or a path under CODEX_HOME / AGENTS_HOME allowed roots.
    path: z.string().min(1),
    offset: z.number().int().min(0).optional().default(0),
    max_chars: z.number().int().min(1).max(200_000).optional().default(20_000),
    max_file_bytes: z.number().int().min(1_000).max(5_000_000).optional().default(1_000_000),
  }),
);

export const ListProjectFilesArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    // Relative directory/file path under project_root. "." means the project root.
    path: z.string().optional().default("."),
    recursive: z.boolean().optional().default(false),
    max_depth: z.number().int().min(1).max(20).optional().default(4),
    include_files: z.boolean().optional().default(true),
    include_dirs: z.boolean().optional().default(true),
    include_hidden: z.boolean().optional().default(false),
    respect_ignore: z.boolean().optional().default(true),
    include_paths: z.array(z.string().min(1)).optional(),
    exclude_paths: z.array(z.string().min(1)).optional(),
    extensions: z.array(z.string().min(1)).optional(),
    max_results: z.number().int().min(1).max(5000).optional().default(200),
    include_stats: z.boolean().optional().default(false),
  }),
);

export const UpsertProjectSummaryArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    summary: z.string().min(1),
  }),
);

export const AddNoteArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    title: z.string().optional().default(""),
    content: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
  }),
);

export const PruneIndexArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    dry_run: z.boolean().optional().default(true),
    prune_ignored_paths: z.boolean().optional().default(true),
    prune_minified_bundles: z.boolean().optional().default(false),
    max_files: z.number().int().min(1).max(50_000).optional().default(2000),
    vacuum: z.boolean().optional().default(false),
  }),
);

export const UpsertConventionArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    key: z.string().min(1),
    content: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
  }),
);

export const UpsertDecisionArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    key: z.string().min(1),
    title: z.string().optional().default(""),
    content: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
    supersedes_req_ids: z.array(z.number().int().positive()).optional(),
    supersedes_memory_ids: z.array(z.number().int().positive()).optional(),
    related_files: z.array(z.string().min(1)).optional(),
  }),
);

export const SupersedeMemoryArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    superseded_req_ids: z.array(z.number().int().positive()).optional(),
    superseded_memory_ids: z.array(z.number().int().positive()).optional(),
    replacement_req_id: z.number().int().positive().optional(),
    replacement_memory_id: z.number().int().positive().optional(),
    reason: z.string().min(1),
  }),
);

export const MaintainMemoryArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    dry_run: z.boolean().optional().default(true),
    compact_old_memories: z.boolean().optional().default(true),
    compact_notes: z.boolean().optional().default(false),
    prune_stale_indexes: z.boolean().optional().default(true),
    prune_ignored_paths: z.boolean().optional().default(true),
    prune_filename_noise: z.boolean().optional().default(true),
    compact_after_days: z.number().int().min(1).max(3650).optional().default(MAINTENANCE_COMPACT_AFTER_DAYS),
    max_memory_items: z.number().int().min(1).max(5000).optional().default(MAINTENANCE_MAX_MEMORY_ITEMS),
    max_index_files: z.number().int().min(1).max(50_000).optional().default(MAINTENANCE_MAX_INDEX_FILES),
    vacuum: z.boolean().optional().default(false),
  }),
);
const DEFAULT_PENDING_LIMIT = 10;
export const MAX_PENDING_LIMIT = 2000;
const PendingPagingSchema = z.object({
  pending_offset: z.number().int().min(0).optional().default(0),
  pending_limit: z.number().int().min(1).max(MAX_PENDING_LIMIT).optional().default(DEFAULT_PENDING_LIMIT),
});

export const DEFAULT_PREVIEW_CHARS = 120;
const PreviewSchema = z.object({
  preview_chars: z.number().int().min(50).max(10_000).optional().default(DEFAULT_PREVIEW_CHARS),
});
const DEFAULT_CONTENT_MAX_CHARS = 1200;
const ContentMaxSchema = z.object({
  content_max_chars: z.number().int().min(0).max(200_000).optional().default(DEFAULT_CONTENT_MAX_CHARS),
});
const DEFAULT_RECENT_REQUIREMENTS = 2;
const DEFAULT_RECENT_CHANGES_PER_REQ = 3;
const DEFAULT_RECENT_NOTES = 3;
const DEFAULT_CONVENTIONS_LIMIT = 0;
const DEFAULT_DECISIONS_LIMIT = 5;
const DEFAULT_CURRENT_CONTEXT_LIMIT = 8;
export const MAX_DECISIONS_LIMIT = 50;
const MAX_CURRENT_CONTEXT_LIMIT = 50;
const BrainDumpLimitsSchema = z.object({
  requirements_limit: z.number().int().min(1).max(20).optional().default(DEFAULT_RECENT_REQUIREMENTS),
  changes_limit: z.number().int().min(1).max(100).optional().default(DEFAULT_RECENT_CHANGES_PER_REQ),
  notes_limit: z.number().int().min(0).max(50).optional().default(DEFAULT_RECENT_NOTES),
  conventions_limit: z.number().int().min(0).max(200).optional().default(DEFAULT_CONVENTIONS_LIMIT),
  decisions_limit: z.number().int().min(0).max(MAX_DECISIONS_LIMIT).optional().default(DEFAULT_DECISIONS_LIMIT),
  current_context_limit: z
    .number()
    .int()
    .min(0)
    .max(MAX_CURRENT_CONTEXT_LIMIT)
    .optional()
    .default(DEFAULT_CURRENT_CONTEXT_LIMIT),
});

export const GetPendingChangesArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    offset: z.number().int().min(0).optional().default(0),
    limit: z.number().int().min(1).max(MAX_PENDING_LIMIT).optional().default(DEFAULT_PENDING_LIMIT),
  }),
);

export const CompleteRequirementArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    req_id: z.number().int().positive().optional(),
    all_active: z.boolean().optional().default(false),
  }),
);

export const GetActivityLogArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    since_id: z.number().int().min(0).optional().default(0),
    limit: z.number().int().min(1).max(500).optional().default(30),
    verbose: z.boolean().optional().default(false),
  }),
);

export const GetActivitySummaryArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    since_id: z.number().int().min(0).optional().default(0),
    max_files: z.number().int().min(0).max(200).optional().default(20),
  }),
);

export const ClearActivityLogArgsSchema = ProjectRootArgSchema;

export const GetBrainDumpArgsSchema = ProjectRootArgSchema.merge(PendingPagingSchema)
  .merge(OutputFormatSchema)
  .merge(PreviewSchema)
  .merge(ContentMaxSchema)
  .merge(BrainDumpLimitsSchema)
  .merge(
    z.object({
      include_content: z.boolean().optional().default(false),
    }),
  );

export const BootstrapContextArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    query: z.string().optional(),
    top_k: z.number().int().min(1).max(50).optional().default(3),
    kinds: z.array(z.string().min(1)).optional(),
    include_content: z.boolean().optional().default(false),
    pending_offset: z.number().int().min(0).optional().default(0),
    pending_limit: z.number().int().min(1).max(MAX_PENDING_LIMIT).optional().default(DEFAULT_PENDING_LIMIT),
  })
    .merge(OutputFormatSchema)
    .merge(PreviewSchema)
    .merge(ContentMaxSchema)
    .merge(BrainDumpLimitsSchema),
);

export const SemanticSearchArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    query: z.string().min(1),
    top_k: z.number().int().min(1).max(50).optional().default(8),
    kinds: z.array(z.string().min(1)).optional(),
    include_content: z.boolean().optional().default(false),
    preview_chars: z.number().int().min(50).max(10_000).optional().default(DEFAULT_PREVIEW_CHARS),
    content_max_chars: z.number().int().min(0).max(200_000).optional().default(DEFAULT_CONTENT_MAX_CHARS),
  }),
);

export const MemoryTimelineArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    memory_id: z.number().int().positive().optional(),
    req_id: z.number().int().positive().optional(),
    file: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    around_time: z.string().min(1).optional(),
    window: z.number().int().min(1).max(100).optional().default(20),
    include_hidden: z.boolean().optional().default(false),
    include_content: z.boolean().optional().default(false),
    preview_chars: z.number().int().min(50).max(10_000).optional().default(DEFAULT_PREVIEW_CHARS),
    content_max_chars: z.number().int().min(0).max(200_000).optional().default(DEFAULT_CONTENT_MAX_CHARS),
  }),
);

export const CreateCheckpointArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    title: z.string().min(1),
    summary: z.string().optional().default(""),
    recent_limit: z.number().int().min(0).max(50).optional().default(10),
    pending_limit: z.number().int().min(0).max(MAX_PENDING_LIMIT).optional().default(DEFAULT_PENDING_LIMIT),
  }),
);

export const ListCheckpointsArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    offset: z.number().int().min(0).optional().default(0),
    limit: z.number().int().min(1).max(100).optional().default(20),
    include_content: z.boolean().optional().default(false),
    preview_chars: z.number().int().min(50).max(10_000).optional().default(DEFAULT_PREVIEW_CHARS),
    content_max_chars: z.number().int().min(0).max(200_000).optional().default(DEFAULT_CONTENT_MAX_CHARS),
  }),
);

export const RestoreCheckpointContextArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    checkpoint_id: z.number().int().positive().optional(),
    title: z.string().min(1).optional(),
    include_content: z.boolean().optional().default(false),
    preview_chars: z.number().int().min(50).max(10_000).optional().default(DEFAULT_PREVIEW_CHARS),
    content_max_chars: z.number().int().min(0).max(200_000).optional().default(DEFAULT_CONTENT_MAX_CHARS),
  }),
);

export const AnalyzeMemoryConflictsArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    query: z.string().min(1).optional(),
    decision_key: z.string().min(1).optional(),
    include_hidden: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(100).optional().default(20),
    scan_limit: z.number().int().min(20).max(10_000).optional().default(1000),
  }),
);

export const MemoryQualityReportArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    limit: z.number().int().min(1).max(100).optional().default(20),
    scan_limit: z.number().int().min(50).max(50_000).optional().default(2000),
    max_checkpoint_chars: z.number().int().min(1000).max(2_000_000).optional().default(50_000),
  }),
);

export const CompareCheckpointContextArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    checkpoint_id: z.number().int().positive().optional(),
    title: z.string().min(1).optional(),
    recent_limit: z.number().int().min(0).max(50).optional().default(20),
    pending_limit: z.number().int().min(0).max(MAX_PENDING_LIMIT).optional().default(DEFAULT_PENDING_LIMIT),
    preview_chars: z.number().int().min(50).max(10_000).optional().default(DEFAULT_PREVIEW_CHARS),
    content_max_chars: z.number().int().min(0).max(200_000).optional().default(DEFAULT_CONTENT_MAX_CHARS),
  }),
);

export const GetTokenSavingsArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    limit: z.number().int().min(1).max(100).optional().default(10),
    format: z.enum(["compact", "json"]).optional().default("compact"),
  }),
);

export const DetectRtkArgsSchema = ProjectRootArgSchema;

export const InstallRtkArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    dry_run: z.boolean().optional().default(true),
    method: z.enum(["auto", "cargo", "brew", "shell_script"]).optional().default("auto"),
    init: z
      .enum(["none", "global_no_patch", "global_auto_patch", "global_hook_only", "local", "codex_global", "codex_local"])
      .optional()
      .default("none"),
    uninstall_wrong_cargo_rtk: z.boolean().optional().default(false),
    timeout_ms: z.number().int().min(10_000).max(1_800_000).optional().default(600_000),
  }),
);

export const ReadMemoryItemArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    id: z.number().int().positive(),
    offset: z.number().int().min(0).optional().default(0),
    limit: z.number().int().min(1).max(200_000).optional().default(DEFAULT_CONTENT_MAX_CHARS),
  }),
);

export type MaintainMemoryArgs = z.infer<typeof MaintainMemoryArgsSchema>;
export type InstallRtkArgs = z.infer<typeof InstallRtkArgsSchema>;
