import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import type { MemoryItemRow, RequirementRow } from "../types.js";
import { PreflightOperationScopeArgsSchema } from "../tool-schemas.js";
import { buildCurrentConstraints, evaluateOperationScope } from "../operation-scope.js";
import { compactPreflightOperationScopeText } from "../tool-output.js";
import { toolCompactOrJson } from "../token-savings.js";
import { flushPendingChangeBuffer } from "../file-indexing.js";
import { logActivity } from "../activity-log.js";
import { focusedTextIsRelevant, isObviouslyCorruptedText } from "../context-governance.js";

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
  const cleanMemory = (row: MemoryItemRow) =>
    !isObviouslyCorruptedText(row.title, row.content, row.file_path);
  const currentDecisions = (listCurrentDecisionsStmt.all(Math.max(limit, 12)) as MemoryItemRow[])
    .filter(cleanMemory);
  const conventions = (listConventionsStmt.all(Math.min(Math.max(limit, 12), 50)) as MemoryItemRow[])
    .filter(cleanMemory);
  const activeRequirements = (listActiveRequirementsStmt.all(10) as RequirementRow[])
    .map((requirement) => ({ requirement, memory: memoryForRequirement(context, requirement) }))
    .filter(({ requirement, memory }) =>
      !isObviouslyCorruptedText(requirement.title, requirement.context_data, memory?.content),
    );
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
    recentNotes: recentNotes.filter(cleanMemory),
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
  const allCurrentConstraints = getCurrentConstraintsForOperation(context, args.constraints_limit, args.preview_chars);
  const plan = {
    operation: args.operation,
    intent: args.intent,
    commands: args.commands,
    files: args.files,
    targets: args.targets,
    script_hints: args.script_hints,
  };
  const result = evaluateOperationScope(plan, allCurrentConstraints, {
    acknowledged: args.security_acknowledged,
    reason: args.security_override_reason,
    allowed_hosts: args.security_allowed_hosts,
    authorization_token: args.security_authorization_token,
  });
  const operationQuery = [
    args.operation,
    args.intent,
    ...(args.commands ?? []),
    ...(args.files ?? []),
    ...(args.targets ?? []),
    ...(args.script_hints ?? []),
  ].join("\n");
  const warningConstraintIds = new Set(
    result.warnings.flatMap((warning) => warning.evidence ?? []).map((evidence) => evidence.constraint_id),
  );
  result.current_constraints = allCurrentConstraints
    .filter((constraint) =>
      warningConstraintIds.has(constraint.id) ||
      focusedTextIsRelevant(operationQuery, constraint.title, constraint.preview),
    )
    .slice(0, args.constraints_limit);

  logActivity("preflight_operation_scope", {
    operation: args.operation,
    warnings: result.warnings.length,
    blockers: result.warnings.filter((w) => w.severity === "blocker").length,
    constraints_checked: allCurrentConstraints.length,
    constraints_returned: result.current_constraints.length,
  });

  return {
    isError: !result.ok,
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
