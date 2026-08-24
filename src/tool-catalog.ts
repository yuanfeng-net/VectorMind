import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  AddNoteArgsSchema,
  AnalyzeMemoryConflictsArgsSchema,
  BootstrapContextArgsSchema,
  ClearActivityLogArgsSchema,
  CompareCheckpointContextArgsSchema,
  CompleteRequirementArgsSchema,
  CreateCheckpointArgsSchema,
  DetectRtkArgsSchema,
  GetActivityLogArgsSchema,
  GetActivitySummaryArgsSchema,
  GetBrainDumpArgsSchema,
  GetPendingChangesArgsSchema,
  GetRequirementStatusArgsSchema,
  GetTokenSavingsArgsSchema,
  GrepArgsSchema,
  InstallRtkArgsSchema,
  ListCheckpointsArgsSchema,
  ListProjectFilesArgsSchema,
  MaintainMemoryArgsSchema,
  MemoryTimelineArgsSchema,
  MemoryQualityReportArgsSchema,
  PlanLargeFileSplitArgsSchema,
  PreflightChangeScopeArgsSchema,
  PreflightOperationScopeArgsSchema,
  PruneIndexArgsSchema,
  QueryCodebaseArgsSchema,
  ReadCodexTextFileArgsSchema,
  ReadFileLinesArgsSchema,
  ReadFileTextArgsSchema,
  ReadMemoryItemArgsSchema,
  RecordLargeFileSplitArgsSchema,
  RestoreCheckpointContextArgsSchema,
  ResumeRequirementArgsSchema,
  SemanticSearchArgsSchema,
  StartRequirementArgsSchema,
  SupersedeMemoryArgsSchema,
  SyncChangeIntentArgsSchema,
  UpdateRequirementVerificationArgsSchema,
  UpsertConventionArgsSchema,
  UpsertDecisionArgsSchema,
  UpsertProjectSummaryArgsSchema,
} from "./tool-schemas.js";

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof toJsonSchemaCompat>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  _meta?: Record<string, unknown>;
};

type ToolBehavior = {
  tags: string[];
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint: boolean;
  openWorldHint?: boolean;
  advisoryOnly?: boolean;
  workflowGate?: boolean;
};

const CORE_TOOL_ORDER = [
  "bootstrap_context",
  "start_requirement",
  "get_requirement_status",
  "resume_requirement",
  "preflight_change_scope",
  "plan_large_file_split",
  "record_large_file_split",
  "sync_change_intent",
  "update_requirement_verification",
  "preflight_operation_scope",
  "read_memory_item",
  "upsert_decision",
  "supersede_memory",
  "complete_requirement",
] as const;

export function resolveToolProfile(value = process.env.VECTORMIND_TOOL_PROFILE): "core" | "full" {
  return value?.trim().toLocaleLowerCase() === "full" ? "full" : "core";
}

const DEFAULT_READ_ONLY_BEHAVIOR: ToolBehavior = {
  tags: ["read_only", "advisory_only", "bounded_output"],
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const TOOL_BEHAVIOR: Record<string, ToolBehavior> = {
  start_requirement: { tags: ["write_memory", "requirement_boundary", "advisory_only", "duplicate_safe"], readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  get_requirement_status: { tags: ["read_only", "requirement_lifecycle", "recovery"], readOnlyHint: true, idempotentHint: true },
  resume_requirement: { tags: ["write_memory", "requirement_lifecycle", "recovery"], readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  preflight_change_scope: {
    tags: ["read_only", "requirement_boundary", "advisory_quality_signals", "conditional_workflow_gate", "bounded_output"],
    readOnlyHint: true,
    idempotentHint: true,
    advisoryOnly: false,
    workflowGate: true,
  },
  sync_change_intent: { tags: ["write_memory", "change_intent", "fix_pattern", "advisory_only", "explicit_idempotency_key"], readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  update_requirement_verification: { tags: ["write_memory", "requirement_lifecycle", "verification_evidence", "advisory_only"], readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  preflight_operation_scope: { tags: ["read_only", "operation_scope", "current_constraints", "advisory_only"], readOnlyHint: true, idempotentHint: true },
  plan_large_file_split: { tags: ["write_memory", "large_file_plan", "workflow_gate_evidence"], readOnlyHint: false, destructiveHint: true, idempotentHint: false, advisoryOnly: false, workflowGate: true },
  record_large_file_split: { tags: ["write_memory", "large_file_tracking", "advisory_only"], readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  complete_requirement: { tags: ["write_memory", "requirement_lifecycle", "advisory_only"], readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  clear_activity_log: { tags: ["diagnostic_state", "non_project_memory"], readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  install_rtk: { tags: ["optional_setup", "dry_run_by_default"], readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  upsert_project_summary: { tags: ["write_memory", "project_summary", "advisory_only"], readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  add_note: { tags: ["write_memory", "project_note", "advisory_only"], readOnlyHint: false, idempotentHint: false },
  upsert_decision: { tags: ["write_memory", "current_decision", "advisory_only"], readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  supersede_memory: { tags: ["write_memory", "stale_memory_control", "advisory_only"], readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  upsert_convention: { tags: ["write_memory", "project_convention", "advisory_only"], readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  maintain_memory: { tags: ["memory_maintenance", "dry_run_by_default", "advisory_only"], readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  prune_index: { tags: ["index_maintenance", "dry_run_by_default", "advisory_only"], readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  create_checkpoint: { tags: ["write_memory", "checkpoint", "advisory_only"], readOnlyHint: false, idempotentHint: false },
  restore_checkpoint_context: { tags: ["read_only", "checkpoint_context", "advisory_only"], readOnlyHint: true, idempotentHint: true },
  analyze_memory_conflicts: { tags: ["read_only", "memory_diagnostics", "advisory_only"], readOnlyHint: true, idempotentHint: true },
  memory_quality_report: { tags: ["read_only", "memory_quality", "advisory_only"], readOnlyHint: true, idempotentHint: true },
  compare_checkpoint_context: { tags: ["read_only", "checkpoint_diff", "advisory_only"], readOnlyHint: true, idempotentHint: true },
};

export function isToolReadOnly(toolName: string): boolean {
  return (TOOL_BEHAVIOR[toolName] ?? DEFAULT_READ_ONLY_BEHAVIOR).readOnlyHint;
}

function withToolBehavior(tool: ToolDefinition): ToolDefinition {
  const behavior = TOOL_BEHAVIOR[tool.name] ?? DEFAULT_READ_ONLY_BEHAVIOR;
  return {
    ...tool,
    annotations: {
      title: tool.name,
      readOnlyHint: behavior.readOnlyHint,
      destructiveHint: behavior.readOnlyHint ? false : (behavior.destructiveHint ?? false),
      idempotentHint: behavior.idempotentHint,
      openWorldHint: behavior.openWorldHint ?? false,
    },
    _meta: {
      ...tool._meta,
      "vectormind/behavior": {
        tags: behavior.tags,
        advisory_only: behavior.advisoryOnly ?? true,
        workflow_gate: behavior.workflowGate ?? false,
        does_not_control_model_reasoning: true,
        does_not_control_host_runtime: true,
      },
    },
  };
}

export async function listToolDefinitions() {
  const tools: ToolDefinition[] = [
      {
        name: "start_requirement",
        description:
          "Call once for a new code-change goal. The default serial workflow closes the previous active requirement, but a high-confidence overlap is rejected unless you reuse its goal_key or explicitly pass previous_req_id to confirm replacement. Pass close_previous=false only for intentional parallel work. Preserve requirement.id or goal_key because explicit identities can finish preflight/sync after another goal becomes active. Persistent text is secret-redacted while safe topology and credential-source references remain recallable.",
        inputSchema: toJsonSchemaCompat(StartRequirementArgsSchema),
      },
      {
        name: "get_requirement_status",
        description: "Read one requirement by req_id or goal_key, including whether it is active and resumable.",
        inputSchema: toJsonSchemaCompat(GetRequirementStatusArgsSchema),
      },
      {
        name: "resume_requirement",
        description: "Explicitly reactivate a completed requirement by req_id or goal_key without closing other active requirements. Superseded requirements cannot be resumed.",
        inputSchema: toJsonSchemaCompat(ResumeRequirementArgsSchema),
      },
      {
        name: "sync_change_intent",
        description:
          "Call once after edits. Pass req_id or goal_key from start_requirement when tasks can overlap. For transport/client retries, provide one stable explicit idempotency_key and reuse it only for that same logical call; calls without a key intentionally create new history. Pending files are consumed in bounded batches, and complete_requirement=true is accepted only when that batch leaves no pending entries. Include large_file_split_deferrals for plan-free minimal bugfix/hotfix debt.",
        inputSchema: toJsonSchemaCompat(SyncChangeIntentArgsSchema),
      },
      {
        name: "update_requirement_verification",
        description:
          "Update verification evidence on the latest change_intent for an active or completed requirement without reopening it. By default verification entries merge while verification_gaps are replaced, so later authoritative test results can clear stale gaps. Superseded requirements are rejected, and each update creates a linked verification_update audit record.",
        inputSchema: toJsonSchemaCompat(UpdateRequirementVerificationArgsSchema),
      },
      {
        name: "preflight_change_scope",
        description:
          "Call once before the first edit when the complete file/module set is known. Pass req_id or goal_key when tasks overlap. Normal mapping and large-file signals plus relevant fix_pattern quality_signals are advisory; huge_file_modularization_required requires a persisted matching split_plan_id for mechanical work. A minimal bugfix may defer planning only with adds_responsibility=false and defer_split_reason, then persist that debt in sync_change_intent.large_file_split_deferrals.",
        inputSchema: toJsonSchemaCompat(PreflightChangeScopeArgsSchema),
      },
      {
        name: "preflight_operation_scope",
        description:
          "Call ONCE immediately BEFORE the first concrete deploy/publish/build/test/migrate/service/git/batch command, including commands discovered after bootstrap_context. Pass the actual planned commands and targets. bootstrap_context is historical recall and never substitutes for this operation preflight. Routine local-data transfers are advisory when the operation intent explicitly names upload/import/publish/sync/backup/export; high-confidence sensitive-data transfer still blocks. A user-authorized exception requires security_acknowledged=true, a specific security_override_reason (20+ chars), security_allowed_hosts, and security_authorization_token injected by the host. The host must set VECTORMIND_SECURITY_AUTH_TOKEN; the model cannot self-authorize or bypass a blocker without a matching token.",
        inputSchema: toJsonSchemaCompat(PreflightOperationScopeArgsSchema),
      },
      {
        name: "plan_large_file_split",
        description:
          "Persist or reuse a bounded-memory heuristic split plan when preflight_change_scope returns huge_file_modularization_required. Pass req_id or goal_key when tasks overlap, preserve plan_id, and pass it back to mechanical preflight. Reports low-confidence declaration coverage, target-module size constraints, source-state hash, and refinement warnings.",
        inputSchema: toJsonSchemaCompat(PlanLargeFileSplitArgsSchema),
      },
      {
        name: "record_large_file_split",
        description:
          "Update a persisted large-file split plan by plan_id. Validates requirement/file identity, project-contained semantic module paths, actual remaining lines, and resolved verification evidence without creating conflicting status notes.",
        inputSchema: toJsonSchemaCompat(RecordLargeFileSplitArgsSchema),
      },
      {
        name: "get_brain_dump",
        description:
          "Restore recent requirements/changes/notes/summary/pending changes. Prefer bootstrap_context() at session start when you also want recall from the local memory store.",
        inputSchema: toJsonSchemaCompat(GetBrainDumpArgsSchema),
      },
      {
        name: "bootstrap_context",
        description:
          "Call at most once for a new project goal when historical context is needed. Default focused mode returns project summary plus query-relevant matches within a compact output budget; it is explicitly non-exhaustive, and no match never proves that a fact was not stored or does not exist in repository/runtime state. Recent history and pending files are opt-in. When operation_preflight.required_before_commands=true, call preflight_operation_scope immediately before concrete commands; bootstrap_context does not satisfy that step.",
        inputSchema: toJsonSchemaCompat(BootstrapContextArgsSchema),
      },
      {
        name: "get_pending_changes",
        description:
          "List files that changed locally but have not been acknowledged by sync_change_intent yet. Also returns development_warnings to catch god-file growth, broad change scope, and requirement-boundary drift.",
        inputSchema: toJsonSchemaCompat(GetPendingChangesArgsSchema),
      },
      {
        name: "complete_requirement",
        description:
          "Mark a requirement as completed (by id or the current active one). Use this when work for a requirement is done so it no longer shows as active.",
        inputSchema: toJsonSchemaCompat(CompleteRequirementArgsSchema),
      },
      {
        name: "read_memory_item",
        description:
          "Read a memory item by id. Use this to fetch full text only when needed (bootstrap_context/get_brain_dump/semantic_search return previews by default). Supports offset/limit chunking to avoid huge tool outputs.",
        inputSchema: toJsonSchemaCompat(ReadMemoryItemArgsSchema),
      },
      {
        name: "get_activity_log",
        description:
          "Get recent debug activity (indexing/search/pending) for troubleshooting. Enable logging with VECTORMIND_DEBUG_LOG=1. Use since_id/limit to page.",
        inputSchema: toJsonSchemaCompat(GetActivityLogArgsSchema),
      },
      {
        name: "get_activity_summary",
        description:
          "Get a compact summary of recent debug activity (counts + small samples). Enable logging with VECTORMIND_DEBUG_LOG=1. Use since_id to get incremental summaries.",
        inputSchema: toJsonSchemaCompat(GetActivitySummaryArgsSchema),
      },
      {
        name: "clear_activity_log",
        description:
          "Clear the in-memory debug activity log. Enable logging with VECTORMIND_DEBUG_LOG=1.",
        inputSchema: toJsonSchemaCompat(ClearActivityLogArgsSchema),
      },
      {
        name: "detect_rtk",
        description:
          "Detect whether rtk is available on PATH or via VectorMind's bundled RTK shim. When available, prefer the returned command as a shell prefix to reduce command-output tokens.",
        inputSchema: toJsonSchemaCompat(DetectRtkArgsSchema),
      },
      {
        name: "install_rtk",
        description:
          "Install the rtk-ai/rtk Rust Token Killer binary when it is missing. Defaults to dry_run=true and never patches hooks unless init is explicitly requested.",
        inputSchema: toJsonSchemaCompat(InstallRtkArgsSchema),
      },
      {
        name: "get_token_savings",
        description:
          "Show VectorMind compact-output token savings recorded by MCP tools. Use this to verify raw-vs-compact output reduction.",
        inputSchema: toJsonSchemaCompat(GetTokenSavingsArgsSchema),
      },
      {
        name: "grep",
        description:
          "Repo text search with precise file/line/col matches, powered by ripgrep against real project files plus built-in noise filters. Falls back to indexed search only when ripgrep is unavailable. Returns development_warnings for cross-project paths or huge implementation-file matches.",
        inputSchema: toJsonSchemaCompat(GrepArgsSchema),
      },
      {
        name: "list_project_files",
        description:
          "AI-friendly, ignore-aware file/directory listing under project_root with bounded output. Prefer this over Get-ChildItem/ls for local repository browsing.",
        inputSchema: toJsonSchemaCompat(ListProjectFilesArgsSchema),
      },
      {
        name: "read_codex_text_file",
        description:
          "Read bounded text from local Codex/agents files such as SKILL.md, prompt files, and rules under CODEX_HOME/AGENTS_HOME. Prefer this over assuming another local-file MCP resource server exists.",
        inputSchema: toJsonSchemaCompat(ReadCodexTextFileArgsSchema),
      },
      {
        name: "read_file_lines",
        description:
          "Read a specific line range from a file under project_root (with strict size limits). Prefer this over Get-Content for deterministic reads. Returns development_warnings when the target is a huge implementation file.",
        inputSchema: toJsonSchemaCompat(ReadFileLinesArgsSchema),
      },
      {
        name: "read_file_text",
        description:
          "Read bounded raw UTF-8 text from a file under project_root. Prefer this over Get-Content -Raw for small/medium text files; use read_file_lines for large files or line-specific reads.",
        inputSchema: toJsonSchemaCompat(ReadFileTextArgsSchema),
      },
      {
        name: "query_codebase",
        description:
          "Search the symbol index for class/function/type names (or substrings) to locate definitions by file path and signature. Use this when you need to find code; do not guess locations. Returns development_warnings when matches point at huge implementation files.",
        inputSchema: toJsonSchemaCompat(QueryCodebaseArgsSchema),
      },
      {
        name: "upsert_project_summary",
        description:
          "Save/update the project-level context summary (written by the AI in the conversation). Call this after major milestones/decisions so future sessions can recover context quickly.",
        inputSchema: toJsonSchemaCompat(UpsertProjectSummaryArgsSchema),
      },
      {
        name: "add_note",
        description:
          "Save a durable project note (decision, constraint, TODO, architecture detail). Use this to persist important context locally instead of relying on chat memory.",
        inputSchema: toJsonSchemaCompat(AddNoteArgsSchema),
      },
      {
        name: "upsert_decision",
        description:
          "Save/update the current authoritative project decision for a key. Use it when requirements change, reverse, or supersede older behavior so future sessions prefer the latest decision over old history.",
        inputSchema: toJsonSchemaCompat(UpsertDecisionArgsSchema),
      },
      {
        name: "supersede_memory",
        description:
          "Mark old requirements or memory items as superseded by a newer requirement/decision. Superseded items are hidden from default semantic recall to avoid reverting to stale behavior.",
        inputSchema: toJsonSchemaCompat(SupersedeMemoryArgsSchema),
      },
      {
        name: "upsert_convention",
        description:
          "Save/update a project convention (framework choice, build command, naming rules, etc). Conventions are durable and should be applied automatically in future sessions.",
        inputSchema: toJsonSchemaCompat(UpsertConventionArgsSchema),
      },
      {
        name: "semantic_search",
        description:
          "Semantic search across the local memory store (requirements, change intents, notes, project summary, and indexed code/doc chunks). Use this to retrieve relevant context instead of guessing.",
        inputSchema: toJsonSchemaCompat(SemanticSearchArgsSchema),
      },
      {
        name: "memory_timeline",
        description:
          "Read-only timeline around a memory item, requirement, file, timestamp, or query. Use this to understand what happened before/after a decision without letting old context override newer observed facts.",
        inputSchema: toJsonSchemaCompat(MemoryTimelineArgsSchema),
      },
      {
        name: "create_checkpoint",
        description:
          "Create a local context checkpoint/waypoint for long sessions. Stores a compact snapshot of active requirement, current decisions, recent memory, and pending changes. It is context evidence only and does not affect model reasoning or active client state.",
        inputSchema: toJsonSchemaCompat(CreateCheckpointArgsSchema),
      },
      {
        name: "list_checkpoints",
        description:
          "List local context checkpoints with bounded output. Use before restoring a long-session waypoint.",
        inputSchema: toJsonSchemaCompat(ListCheckpointsArgsSchema),
      },
      {
        name: "restore_checkpoint_context",
        description:
          "Read-only restore of checkpoint context. Returns the saved snapshot but does not mutate requirements, files, runtime state, or model decisions.",
        inputSchema: toJsonSchemaCompat(RestoreCheckpointContextArgsSchema),
      },
      {
        name: "analyze_memory_conflicts",
        description:
          "Read-only diagnostic for likely memory conflicts such as duplicate visible titles, multiple active requirements, or superseded targets that remain visible. It reports evidence only and never changes memory, source files, active requirements, or model decisions.",
        inputSchema: toJsonSchemaCompat(AnalyzeMemoryConflictsArgsSchema),
      },
      {
        name: "memory_quality_report",
        description:
          "Read-only quality report for the local memory store: counts, hidden memory, duplicates, oversized checkpoints, stale indexed files, and orphaned memory records. Use maintain_memory/prune_index separately if cleanup is desired.",
        inputSchema: toJsonSchemaCompat(MemoryQualityReportArgsSchema),
      },
      {
        name: "compare_checkpoint_context",
        description:
          "Read-only diff between a saved checkpoint snapshot and current context. Shows active requirement, project summary, decisions, recent memory, and pending-change differences without restoring or mutating anything.",
        inputSchema: toJsonSchemaCompat(CompareCheckpointContextArgsSchema),
      },
      {
        name: "maintain_memory",
        description:
          "Compact old completed memory, hard-prune safe hidden/superseded details, prune transient pending/index noise, optimize FTS, and checkpoint WAL to keep long-lived large projects fast. Defaults to dry_run=true; automatic safe maintenance also runs periodically.",
        inputSchema: toJsonSchemaCompat(MaintainMemoryArgsSchema),
      },
      {
        name: "prune_index",
        description:
          "Prune noisy auto-indexed items (code_chunk/doc_chunk + symbols). Useful after tightening ignore rules to shrink the index and improve search relevance.",
        inputSchema: toJsonSchemaCompat(PruneIndexArgsSchema),
      },
    ];
  const profile = resolveToolProfile();
  const visibleTools = profile === "core"
    ? CORE_TOOL_ORDER.map((name) => tools.find((tool) => tool.name === name)).filter(
        (tool): tool is ToolDefinition => tool !== undefined,
      )
    : tools;
  return {
    tools: visibleTools.map(withToolBehavior),
  };
}
