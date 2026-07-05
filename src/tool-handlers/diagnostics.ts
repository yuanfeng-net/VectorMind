import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import { debugLogEnabled, debugLogMaxEntries } from "../config.js";
import { ClearActivityLogArgsSchema, DetectRtkArgsSchema, GetActivityLogArgsSchema, GetActivitySummaryArgsSchema, GetTokenSavingsArgsSchema, InstallRtkArgsSchema } from "../tool-schemas.js";
import { compactInstallRtkText, detectRtk, installRtk } from "../rtk-tools.js";
import { tokenSavingsSummary } from "../token-savings.js";
import { flushPendingChangeBuffer } from "../file-indexing.js";
import { clearActivityLog, snapshotActivityLog, summarizeActivityEvent } from "../activity-log.js";
import { compactTokenSavingsText, toolJson } from "../tool-output.js";
export async function handleGetActivityLog(
  rawArgs: Record<string, unknown>,
  _context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = GetActivityLogArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const { events, last_id } = snapshotActivityLog({ sinceId: args.since_id, limit: args.limit });
  const outEvents = args.verbose
    ? events
    : events.map((e) => ({ id: e.id, ts: e.ts, type: e.type, summary: summarizeActivityEvent(e) }));
  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          enabled: debugLogEnabled,
          max_entries: debugLogMaxEntries,
          last_id,
          events: outEvents,
        }),
      },
    ],
  };
}
export async function handleGetActivitySummary(
  rawArgs: Record<string, unknown>,
  _context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = GetActivitySummaryArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const { events, last_id } = snapshotActivityLog({ sinceId: args.since_id, limit: 500 });

  const counts: Record<string, number> = {};
  const indexedFiles = new Set<string>();
  let semanticCount = 0;
  let queryCodebaseCount = 0;
  let pendingFlushes = 0;
  let pendingPrunes = 0;
  let lastSemantic: Record<string, unknown> | null = null;
  let lastQueryCodebase: Record<string, unknown> | null = null;

  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === "index_file") {
      const fp = String(e.data.file_path ?? "");
      if (fp) indexedFiles.add(fp);
    }
    if (e.type === "semantic_search") {
      semanticCount += 1;
      lastSemantic = e.data;
    }
    if (e.type === "query_codebase") {
      queryCodebaseCount += 1;
      lastQueryCodebase = e.data;
    }
    if (e.type === "pending_flush") pendingFlushes += 1;
    if (e.type === "pending_prune") pendingPrunes += 1;
  }

  const sampleFiles = Array.from(indexedFiles).slice(0, args.max_files);
  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          enabled: debugLogEnabled,
          last_id,
          since_id: args.since_id,
          counts,
          indexed_files: { unique: indexedFiles.size, sample: sampleFiles },
          searches: {
            semantic_search: { count: semanticCount, last: lastSemantic },
            query_codebase: { count: queryCodebaseCount, last: lastQueryCodebase },
          },
          pending: { flushes: pendingFlushes, prunes: pendingPrunes },
        }),
      },
    ],
  };
}
export async function handleClearActivityLog(
  rawArgs: Record<string, unknown>,
  _context: ToolHandlerContext,
): Promise<CallToolResult> {
  ClearActivityLogArgsSchema.parse(rawArgs);
  clearActivityLog();
  return { content: [{ type: "text", text: toolJson({ ok: true }) }] };
}
export async function handleDetectRtk(
  rawArgs: Record<string, unknown>,
  _context: ToolHandlerContext,
): Promise<CallToolResult> {
  DetectRtkArgsSchema.parse(rawArgs);
  const result = detectRtk();
  const text = result.available
    ? `rtk available: ${result.version ?? result.command}\ncommand=${result.command} source=${result.source ?? "unknown"} gain_ok=${result.gain_ok ?? false}${result.path ? ` path=${result.path}` : ""}\n${result.note}`
    : `rtk unavailable: ${result.command}\nsource=${result.source ?? "none"} gain_ok=${result.gain_ok ?? false}${result.version ? ` version=${result.version}` : ""}${result.path ? ` path=${result.path}` : ""}\n${result.note}`;
  return { content: [{ type: "text", text }] };
}
export async function handleInstallRtk(
  rawArgs: Record<string, unknown>,
  _context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = InstallRtkArgsSchema.parse(rawArgs);
  const result = installRtk(args);
  return { content: [{ type: "text", text: compactInstallRtkText(result) }] };
}
export async function handleGetTokenSavings(
  rawArgs: Record<string, unknown>,
  _context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = GetTokenSavingsArgsSchema.parse(rawArgs);
  const result = tokenSavingsSummary(args.limit);
  return {
    content: [
      {
        type: "text",
        text: args.format === "json" ? toolJson(result) : compactTokenSavingsText(result),
      },
    ],
  };
}
