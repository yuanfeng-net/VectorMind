import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ProjectContextAdvisory, ToolHandler, ToolHandlerContext } from "./tool-handlers/context.js";
import { handleStartRequirement, handlePreflightChangeScope, handleSyncChangeIntent, handleGetPendingChanges, handleCompleteRequirement } from "./tool-handlers/requirements.js";
import { handlePruneIndex, handleMaintainMemory } from "./tool-handlers/maintenance.js";
import { handlePlanLargeFileSplit, handleRecordLargeFileSplit } from "./tool-handlers/large-files.js";
import { handleBootstrapContext, handleGetBrainDump, handleReadMemoryItem, handleSemanticSearch } from "./tool-handlers/memory.js";
import { handleGrep, handleListProjectFiles, handleReadFileText, handleReadCodexTextFile, handleReadFileLines, handleQueryCodebase } from "./tool-handlers/files.js";
import { handleUpsertProjectSummary, handleAddNote, handleUpsertDecision, handleSupersedeMemory, handleUpsertConvention } from "./tool-handlers/notes-decisions.js";
import { handleGetActivityLog, handleGetActivitySummary, handleClearActivityLog, handleDetectRtk, handleInstallRtk, handleGetTokenSavings } from "./tool-handlers/diagnostics.js";
import { handleCreateCheckpoint, handleListCheckpoints, handleMemoryTimeline, handleRestoreCheckpointContext } from "./tool-handlers/context-recovery.js";
import { handleAnalyzeMemoryConflicts, handleCompareCheckpointContext, handleMemoryQualityReport } from "./tool-handlers/memory-diagnostics.js";
import { handlePreflightOperationScope } from "./tool-handlers/operations.js";
import { runAutoMaintenanceIfDue } from "./memory-maintenance.js";
import { oneLine, toolJson } from "./tool-output.js";

export type { ToolHandlerContext } from "./tool-handlers/context.js";
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  start_requirement: handleStartRequirement,
  prune_index: handlePruneIndex,
  maintain_memory: handleMaintainMemory,
  preflight_change_scope: handlePreflightChangeScope,
  preflight_operation_scope: handlePreflightOperationScope,
  plan_large_file_split: handlePlanLargeFileSplit,
  record_large_file_split: handleRecordLargeFileSplit,
  sync_change_intent: handleSyncChangeIntent,
  bootstrap_context: handleBootstrapContext,
  get_brain_dump: handleGetBrainDump,
  get_pending_changes: handleGetPendingChanges,
  complete_requirement: handleCompleteRequirement,
  read_memory_item: handleReadMemoryItem,
  get_activity_log: handleGetActivityLog,
  get_activity_summary: handleGetActivitySummary,
  clear_activity_log: handleClearActivityLog,
  detect_rtk: handleDetectRtk,
  install_rtk: handleInstallRtk,
  get_token_savings: handleGetTokenSavings,
  grep: handleGrep,
  list_project_files: handleListProjectFiles,
  read_file_text: handleReadFileText,
  read_codex_text_file: handleReadCodexTextFile,
  read_file_lines: handleReadFileLines,
  query_codebase: handleQueryCodebase,
  upsert_project_summary: handleUpsertProjectSummary,
  add_note: handleAddNote,
  upsert_decision: handleUpsertDecision,
  supersede_memory: handleSupersedeMemory,
  upsert_convention: handleUpsertConvention,
  semantic_search: handleSemanticSearch,
  memory_timeline: handleMemoryTimeline,
  create_checkpoint: handleCreateCheckpoint,
  list_checkpoints: handleListCheckpoints,
  restore_checkpoint_context: handleRestoreCheckpointContext,
  analyze_memory_conflicts: handleAnalyzeMemoryConflicts,
  memory_quality_report: handleMemoryQualityReport,
  compare_checkpoint_context: handleCompareCheckpointContext,
};

function attachProjectContextAdvisory(result: CallToolResult, advisory: ProjectContextAdvisory | null): CallToolResult {
  if (!advisory) return result;
  const content = result.content?.map((item, index) => {
    if (index !== 0 || item.type !== "text" || typeof item.text !== "string") return item;
    const text = item.text.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(item.text) as Record<string, unknown>;
        return {
          ...item,
          text: toolJson({
            ...parsed,
            project_context_advisory: advisory,
          }),
        };
      } catch {
        // Fall back to compact-text injection below.
      }
    }

    const advisoryLine =
      `project_context_advisory ${advisory.code}: external_reference=true read_only_reference=true previous="${oneLine(advisory.previous_project_root, 90)}" current="${oneLine(advisory.current_project_root, 90)}"`;
    return {
      ...item,
      text: `${advisoryLine}\n${item.text}`,
    };
  });
  return { ...result, content };
}

export function registerToolHandlers(server: Server, context: ToolHandlerContext): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      await context.ensureInitializedForArgs(rawArgs);
      if (toolName !== "maintain_memory") runAutoMaintenanceIfDue();

      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        return attachProjectContextAdvisory({
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        }, context.consumeProjectContextAdvisory());
      }

      const result = await handler(rawArgs, context);
      return attachProjectContextAdvisory(result, context.consumeProjectContextAdvisory());
    } catch (err) {
      return attachProjectContextAdvisory({
        isError: true,
        content: [{ type: "text", text: String(err) }],
      }, context.consumeProjectContextAdvisory());
    }
  });
}
