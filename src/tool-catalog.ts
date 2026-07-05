import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  AddNoteArgsSchema,
  BootstrapContextArgsSchema,
  ClearActivityLogArgsSchema,
  CompleteRequirementArgsSchema,
  DetectRtkArgsSchema,
  GetActivityLogArgsSchema,
  GetActivitySummaryArgsSchema,
  GetBrainDumpArgsSchema,
  GetPendingChangesArgsSchema,
  GetTokenSavingsArgsSchema,
  GrepArgsSchema,
  InstallRtkArgsSchema,
  ListProjectFilesArgsSchema,
  MaintainMemoryArgsSchema,
  PlanLargeFileSplitArgsSchema,
  PreflightChangeScopeArgsSchema,
  PruneIndexArgsSchema,
  QueryCodebaseArgsSchema,
  ReadCodexTextFileArgsSchema,
  ReadFileLinesArgsSchema,
  ReadFileTextArgsSchema,
  ReadMemoryItemArgsSchema,
  RecordLargeFileSplitArgsSchema,
  SemanticSearchArgsSchema,
  StartRequirementArgsSchema,
  SupersedeMemoryArgsSchema,
  SyncChangeIntentArgsSchema,
  UpsertConventionArgsSchema,
  UpsertDecisionArgsSchema,
  UpsertProjectSummaryArgsSchema,
} from "./tool-schemas.js";

export async function listToolDefinitions() {
  return {
    tools: [
      {
        name: "start_requirement",
        description:
          "MUST call BEFORE editing code. Starts/activates the concrete user requirement so subsequent changes stay inside that requirement boundary and do not accumulate unrelated work. Supports scope_allow/scope_deny and allowed_paths/denied_paths to prevent unrelated domain drift.",
        inputSchema: toJsonSchemaCompat(StartRequirementArgsSchema),
      },
      {
        name: "sync_change_intent",
        description:
          "MUST call AFTER you edit code and save files. Archives the intent summary, links affected files to the current active requirement, and returns development_warnings for oversized files, broad change scope, or missing file targets.",
        inputSchema: toJsonSchemaCompat(SyncChangeIntentArgsSchema),
      },
      {
        name: "preflight_change_scope",
        description:
          "MUST call BEFORE editing once you know the intended files/modules. Checks planned files against the active requirement and optional generic scope_allow/scope_deny/allowed_paths/denied_paths. If ok=false/safe_to_edit=false, stop before editing and narrow the plan or scope contract. For huge files, use change_mode='mechanical_modularization' only when the task is to split the file.",
        inputSchema: toJsonSchemaCompat(PreflightChangeScopeArgsSchema),
      },
      {
        name: "plan_large_file_split",
        description:
          "Plan a mechanical modularization split for a huge implementation file. Produces real module names/directories and explicitly forbids generated/parts/partN files. Use this before normal feature work when preflight_change_scope returns huge_file_modularization_required.",
        inputSchema: toJsonSchemaCompat(PlanLargeFileSplitArgsSchema),
      },
      {
        name: "record_large_file_split",
        description:
          "Record the planned/in-progress/partial/resolved status of a huge-file mechanical modularization split so future sessions know the file is being decomposed and where modules moved.",
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
          "MUST call at the start of every new chat/session. Returns brain dump + pending changes + development_warnings, and (if you pass query) matches from the local memory store to avoid guessing.",
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
        name: "maintain_memory",
        description:
          "Compact old completed memory and prune stale/noisy indexes to keep long-lived large projects fast. Defaults to dry_run=true; automatic safe maintenance also runs periodically.",
        inputSchema: toJsonSchemaCompat(MaintainMemoryArgsSchema),
      },
      {
        name: "prune_index",
        description:
          "Prune noisy auto-indexed items (code_chunk/doc_chunk + symbols). Useful after tightening ignore rules to shrink the index and improve search relevance.",
        inputSchema: toJsonSchemaCompat(PruneIndexArgsSchema),
      },
    ],
  };
}
