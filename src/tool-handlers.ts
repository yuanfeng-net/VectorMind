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

let toolCallQueue: Promise<void> = Promise.resolve();

export function enqueueToolCall<T>(task: () => Promise<T>): Promise<T> {
  const result = toolCallQueue.then(task, task);
  toolCallQueue = result.then(() => undefined, () => undefined);
  return result;
}

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

function firstTextContent(result: CallToolResult): string {
  const item = result.content?.find((content) => content.type === "text");
  return item?.type === "text" && typeof item.text === "string" ? item.text : "";
}

function maxToolOutputChars(): number {
  const configured = Number(process.env.VECTORMIND_MAX_TOOL_OUTPUT_CHARS ?? 100_000);
  return Number.isFinite(configured) ? Math.max(4_000, Math.min(500_000, Math.trunc(configured))) : 100_000;
}

export function boundToolResult(toolName: string, result: CallToolResult): CallToolResult {
  const limit = maxToolOutputChars();
  let structuredTruncated = false;
  const content = result.content?.map((item) => {
    if (item.type !== "text" || typeof item.text !== "string" || item.text.length <= limit) return item;
    const originalChars = item.text.length;
    const trimmed = item.text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      structuredTruncated = true;
      let parsed: Record<string, unknown> | null = null;
      try {
        const value = JSON.parse(trimmed);
        parsed = value && typeof value === "object" && !Array.isArray(value)
          ? value as Record<string, unknown>
          : null;
      } catch {
        parsed = null;
      }
      return {
        ...item,
        text: toolJson({
          ok: false,
          error: "Structured tool output exceeded the configured context budget. Narrow the query, lower limits, or use pagination.",
          tool: toolName,
          output_truncated: true,
          original_chars: originalChars,
          max_output_chars: limit,
          project_root: typeof parsed?.project_root === "string" ? parsed.project_root : undefined,
        }),
      };
    }
    const suffix = "\noutput budget: truncated; narrow the query or use pagination";
    return { ...item, text: `${item.text.slice(0, Math.max(0, limit - suffix.length)).trimEnd()}${suffix}` };
  });
  return { ...result, ...(structuredTruncated ? { isError: true } : {}), content };
}

function persistMcpToolMetric(
  toolName: string,
  durationMs: number,
  rawResult: CallToolResult,
  finalResult: CallToolResult,
  context: ToolHandlerContext,
): void {
  try {
    if (["0", "false", "off", "no"].includes((process.env.VECTORMIND_METRICS ?? "").trim().toLowerCase())) return;
    const stmt = context.getStatements().insertMcpToolMetricStmt;
    if (!stmt) return;
    stmt.run(
      toolName,
      durationMs,
      firstTextContent(rawResult).length,
      firstTextContent(finalResult).length,
      finalResult.isError ? 1 : 0,
      context.getRootSource(),
    );
  } catch {
    // Metrics must never affect the original MCP result.
  }
}

function parseJsonToolOutput(result: CallToolResult): Record<string, unknown> | null {
  const text = firstTextContent(result).trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function warningCode(warning: unknown): string {
  if (!warning || typeof warning !== "object" || Array.isArray(warning)) return "";
  const code = (warning as Record<string, unknown>).code;
  return typeof code === "string" ? code : "";
}

function warningMessage(warning: unknown): string {
  if (!warning || typeof warning !== "object" || Array.isArray(warning)) return "";
  const record = warning as Record<string, unknown>;
  for (const key of ["message", "detail", "title", "reason"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const code = warningCode(warning);
  return code || "MCP guard warning";
}

function eventForWarningCode(code: string): { eventType: string; severity: string; title: string } {
  switch (code) {
    case "huge_file_modularization_required":
      return {
        eventType: "blocked_large_file",
        severity: "critical",
        title: "阻止大文件直接修改，要求先拆模块",
      };
    case "very_large_file":
    case "large_file":
    case "large_file_read":
      return {
        eventType: "large_file_guard",
        severity: "warn",
        title: "提醒大文件风险，避免继续堆叠实现",
      };
    case "scope_drift":
      return {
        eventType: "scope_drift_guard",
        severity: "warn",
        title: "发现需求范围漂移，提醒收窄改动",
      };
    case "requirement_mapping_missing":
      return {
        eventType: "requirement_mapping_guard",
        severity: "warn",
        title: "提示未映射到需求项的改动",
      };
    case "scope_contract_missing":
      return {
        eventType: "scope_contract_guard",
        severity: "warn",
        title: "缺少需求范围契约，提示确认改动边界",
      };
    case "cross_project_path":
      return {
        eventType: "cross_project_guard",
        severity: "warn",
        title: "发现跨项目路径引用，提醒隔离上下文",
      };
    default:
      return {
        eventType: code ? `development_warning:${code}` : "development_warning",
        severity: "info",
        title: code ? `MCP 开发防护提示：${code}` : "MCP 开发防护提示",
      };
  }
}

function normalizedGuardSeverity(value: unknown, fallback = "info"): string {
  if (value === "critical" || value === "warn" || value === "info") return value;
  if (value === "warning") return "warn";
  if (value === "blocker" || value === "error") return "critical";
  return fallback;
}

function eventForOperationWarningCode(code: string): { eventType: string; severity: string; title: string } {
  const title =
    code === "stale_default_conflict"
      ? "发现过期默认操作，阻止继续执行"
      : code === "operation_constraint_conflict"
        ? "发现操作约束冲突，阻止继续执行"
        : `MCP 操作防护提示：${code}`;
  return {
    eventType: `operation_guard:${code}`,
    severity: "warn",
    title,
  };
}

function parseCompactToolOutputEvents(toolName: string, text: string): Array<{
  eventType: string;
  severity: string;
  title: string;
  detail: string;
  metadata: Record<string, unknown>;
}> {
  const events: Array<{
    eventType: string;
    severity: string;
    title: string;
    detail: string;
    metadata: Record<string, unknown>;
  }> = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return events;
  const hasDevelopmentWarnings = lines.some((line) => /^development warnings:$/i.test(line));
  const hasOperationWarnings = lines.some((line) => /^operation warnings:$/i.test(line));

  const header = lines[0] ?? "";
  const okMatch = /\bok=(true|false)\b/.exec(header);
  const safeToEditMatch = /\bsafe_to_edit=(true|false)\b/.exec(header);
  const safeToProceedMatch = /\bsafe_to_proceed=(true|false)\b/.exec(header);
  const compactState = {
    ok: okMatch ? okMatch[1] === "true" : undefined,
    safe_to_edit: safeToEditMatch ? safeToEditMatch[1] === "true" : undefined,
    safe_to_proceed: safeToProceedMatch ? safeToProceedMatch[1] === "true" : undefined,
  };

  for (const line of lines) {
    const advisory = /^project_context_advisory\s+([^:\s]+):\s*(.*)$/i.exec(line);
    if (advisory) {
      events.push({
        eventType: "cross_project_reference",
        severity: "info",
        title: "识别跨项目上下文，只作为只读参考",
        detail: advisory[2] || "MCP 检测到 project_root 切换或跨项目引用，提醒不要把外部项目当作当前需求范围。",
        metadata: {
          tool_name: toolName,
          compact: true,
          advisory_code: advisory[1],
        },
      });
      continue;
    }

    const operationWarning = /^-\s+([a-z_-]+)\s+([^:\s]+)(?:\s+[^:]*)?:\s*(.*)$/i.exec(line);
    if (operationWarning && hasOperationWarnings) {
      const code = operationWarning[2];
      const base = eventForOperationWarningCode(code);
      const lineSeverity = normalizedGuardSeverity(operationWarning[1], base.severity);
      events.push({
        ...base,
        severity: lineSeverity,
        detail: operationWarning[3] || code,
        metadata: {
          tool_name: toolName,
          compact: true,
          warning: {
            code,
            severity: lineSeverity,
            message: operationWarning[3] || code,
          },
          ...compactState,
        },
      });
      continue;
    }

    const warning = /^-\s+([a-z_-]+)\s+([^:\s]+):\s*(.*)$/i.exec(line);
    if (warning && hasDevelopmentWarnings) {
      const code = warning[2];
      const base = eventForWarningCode(code);
      const lineSeverity = normalizedGuardSeverity(warning[1]);
      events.push({
        ...base,
        severity: base.severity === "info" ? lineSeverity : base.severity,
        detail: warning[3] || code,
        metadata: {
          tool_name: toolName,
          compact: true,
          warning: {
            code,
            severity: lineSeverity,
            message: warning[3] || code,
          },
          ...compactState,
        },
      });
      continue;
    }
  }

  return events;
}

function outputEventsForToolResult(toolName: string, result: CallToolResult): Array<{
  eventType: string;
  severity: string;
  title: string;
  detail: string;
  metadata: Record<string, unknown>;
}> {
  const text = firstTextContent(result).trim();
  const parsed = parseJsonToolOutput(result);
  if (!parsed) return parseCompactToolOutputEvents(toolName, text);

  const events: Array<{
    eventType: string;
    severity: string;
    title: string;
    detail: string;
    metadata: Record<string, unknown>;
  }> = [];
  const developmentWarnings = Array.isArray(parsed.development_warnings) ? parsed.development_warnings : [];
  for (const warning of developmentWarnings) {
    const code = warningCode(warning);
    const base = eventForWarningCode(code);
    events.push({
      ...base,
      detail: warningMessage(warning),
      metadata: {
        tool_name: toolName,
        warning,
        ok: parsed.ok,
        safe_to_edit: parsed.safe_to_edit,
        safe_to_proceed: parsed.safe_to_proceed,
      },
    });
  }

  const operationWarnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  for (const warning of operationWarnings) {
    const code = warningCode(warning);
    if (!code) continue;
    const base = eventForOperationWarningCode(code);
    events.push({
      ...base,
      detail: warningMessage(warning),
      metadata: {
        tool_name: toolName,
        warning,
        ok: parsed.ok,
        safe_to_proceed: parsed.safe_to_proceed,
      },
    });
  }

  if (parsed.project_context_advisory && typeof parsed.project_context_advisory === "object") {
    events.push({
      eventType: "cross_project_reference",
      severity: "info",
      title: "识别跨项目上下文，只作为只读参考",
      detail: "MCP 检测到 project_root 切换或跨项目引用，提醒不要把外部项目当作当前需求范围。",
      metadata: {
        tool_name: toolName,
        advisory: parsed.project_context_advisory,
      },
    });
  }

  return events;
}

function persistMcpGuardEvents(toolName: string, result: CallToolResult, context: ToolHandlerContext): void {
  const events = outputEventsForToolResult(toolName, result);
  if (!events.length) return;
  const stmt = context.getStatements().insertMcpGuardEventStmt;
  if (!stmt) return;
  try {
    const db = context.getDb();
    const tx = db.transaction(() => {
      for (const event of events) {
        stmt.run(
          toolName,
          event.eventType,
          event.severity,
          event.title,
          event.detail,
          JSON.stringify(event.metadata),
        );
      }
    });
    tx();
  } catch {
    // Guard-event persistence must never break the original MCP tool result.
  }
}

export function registerToolHandlers(server: Server, context: ToolHandlerContext): void {
  server.setRequestHandler(CallToolRequestSchema, (request) => enqueueToolCall(async () => {
    const toolName = request.params.name;
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    const startedAt = performance.now();

    try {
      await context.ensureInitializedForArgs(rawArgs);
      if (toolName !== "maintain_memory") runAutoMaintenanceIfDue();

      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        const rawResult = attachProjectContextAdvisory({
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        }, context.consumeProjectContextAdvisory());
        const finalResult = boundToolResult(toolName, rawResult);
        persistMcpToolMetric(toolName, performance.now() - startedAt, rawResult, finalResult, context);
        return finalResult;
      }

      const result = await handler(rawArgs, context);
      const rawResult = attachProjectContextAdvisory(result, context.consumeProjectContextAdvisory());
      const finalResult = boundToolResult(toolName, rawResult);
      persistMcpGuardEvents(toolName, finalResult, context);
      persistMcpToolMetric(toolName, performance.now() - startedAt, rawResult, finalResult, context);
      return finalResult;
    } catch (err) {
      const rawResult = attachProjectContextAdvisory({
        isError: true,
        content: [{ type: "text", text: String(err) }],
      }, context.consumeProjectContextAdvisory());
      const finalResult = boundToolResult(toolName, rawResult);
      persistMcpToolMetric(toolName, performance.now() - startedAt, rawResult, finalResult, context);
      return finalResult;
    }
  }));
}
