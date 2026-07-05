import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandler, ToolHandlerContext } from "./tool-handlers/context.js";
import { handleStartRequirement, handlePreflightChangeScope, handleSyncChangeIntent, handleGetPendingChanges, handleCompleteRequirement } from "./tool-handlers/requirements.js";
import { handlePruneIndex, handleMaintainMemory } from "./tool-handlers/maintenance.js";
import { handlePlanLargeFileSplit, handleRecordLargeFileSplit } from "./tool-handlers/large-files.js";
import { handleBootstrapContext, handleGetBrainDump, handleReadMemoryItem, handleSemanticSearch } from "./tool-handlers/memory.js";
import { handleGrep, handleListProjectFiles, handleReadFileText, handleReadCodexTextFile, handleReadFileLines, handleQueryCodebase } from "./tool-handlers/files.js";
import { handleUpsertProjectSummary, handleAddNote, handleUpsertDecision, handleSupersedeMemory, handleUpsertConvention } from "./tool-handlers/notes-decisions.js";
import { handleGetActivityLog, handleGetActivitySummary, handleClearActivityLog, handleDetectRtk, handleInstallRtk, handleGetTokenSavings } from "./tool-handlers/diagnostics.js";
import { handleCreateCheckpoint, handleListCheckpoints, handleMemoryTimeline, handleRestoreCheckpointContext } from "./tool-handlers/context-recovery.js";

export type { ToolHandlerContext } from "./tool-handlers/context.js";
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  start_requirement: handleStartRequirement,
  prune_index: handlePruneIndex,
  maintain_memory: handleMaintainMemory,
  preflight_change_scope: handlePreflightChangeScope,
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
};
export function registerToolHandlers(server: Server, context: ToolHandlerContext): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      await context.ensureInitializedForArgs(rawArgs);

      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        };
      }

      return await handler(rawArgs, context);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: String(err) }],
      };
    }
  });
}
