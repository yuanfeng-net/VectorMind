import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import type { MemoryItemRow, RequirementRow } from "../types.js";
import { PreflightOperationScopeArgsSchema } from "../tool-schemas.js";
import { buildCurrentConstraints, evaluateOperationScope } from "../operation-scope.js";
import { compactPreflightOperationScopeText } from "../tool-output.js";
import { toolCompactOrJson } from "../token-savings.js";
import { flushPendingChangeBuffer } from "../file-indexing.js";
import { logActivity } from "../activity-log.js";

function memoryForRequirement(context: ToolHandlerContext, req: RequirementRow): MemoryItemRow | undefined {
  const { getRequirementMemoryItemIdStmt, getMemoryItemByIdStmt } = context.getStatements();
  const memId = (getRequirementMemoryItemIdStmt.get(req.id) as { id: number } | undefined)?.id;
  return memId == null ? undefined : getMemoryItemByIdStmt.get(memId) as MemoryItemRow | undefined;
}

function getCurrentConstraintsForOperation(context: ToolHandlerContext, limit: number, previewChars: number) {
  const {
    listCurrentDecisionsStmt,
    listConventionsStmt,
    listActiveRequirementsStmt,
  } = context.getStatements();
  const currentDecisions = listCurrentDecisionsStmt.all(Math.max(limit, 12)) as MemoryItemRow[];
  const conventions = listConventionsStmt.all(Math.min(Math.max(limit, 12), 50)) as MemoryItemRow[];
  const activeRequirements = (listActiveRequirementsStmt.all(10) as RequirementRow[])
    .map((requirement) => ({ requirement, memory: memoryForRequirement(context, requirement) }));
  const recentNotes = context.getDb().prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'note'
     ORDER BY updated_at DESC, id DESC
     LIMIT 50`,
  ).all() as MemoryItemRow[];
  return buildCurrentConstraints({
    currentDecisions,
    conventions,
    activeRequirements,
    recentNotes,
    limit,
    previewChars,
  });
}

export function collectCurrentConstraintsForBootstrap(context: ToolHandlerContext, limit: number, previewChars: number) {
  return getCurrentConstraintsForOperation(context, limit, previewChars);
}

export async function handlePreflightOperationScope(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = PreflightOperationScopeArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const currentConstraints = getCurrentConstraintsForOperation(context, args.constraints_limit, args.preview_chars);
  const result = evaluateOperationScope({
    operation: args.operation,
    intent: args.intent,
    commands: args.commands,
    files: args.files,
    targets: args.targets,
    script_hints: args.script_hints,
  }, currentConstraints);

  logActivity("preflight_operation_scope", {
    operation: args.operation,
    warnings: result.warnings.length,
    blockers: result.warnings.filter((w) => w.severity === "blocker").length,
    constraints: currentConstraints.length,
  });

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson(
          "preflight_operation_scope",
          result,
          compactPreflightOperationScopeText(result),
          args.format,
        ),
      },
    ],
  };
}
