import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import type { RequirementRow } from "../types.js";
import { GetRequirementStatusArgsSchema, ResumeRequirementArgsSchema, UpdateRequirementVerificationArgsSchema } from "../tool-schemas.js";
import { parseMetadataJson } from "../memory-recall.js";
import { logActivity } from "../activity-log.js";
import { safeJson, toolJson } from "../tool-output.js";

type RequirementStatusRow = RequirementRow & { updated_at?: string };

function sortedUniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((left, right) =>
    left.localeCompare(right)
  );
}

function resolveRequirement(
  context: ToolHandlerContext,
  args: { req_id?: number; goal_key?: string },
): RequirementStatusRow | undefined {
  if (args.req_id) {
    return context.getDb().prepare(
      `SELECT id, title, status, context_data, goal_key, created_at, updated_at
         FROM requirements WHERE id = ? LIMIT 1`,
    ).get(args.req_id) as RequirementStatusRow | undefined;
  }
  if (args.goal_key?.trim()) {
    return context.getDb().prepare(
      `SELECT id, title, status, context_data, goal_key, created_at, updated_at
         FROM requirements WHERE goal_key = ?
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, id DESC
         LIMIT 1`,
    ).get(args.goal_key.trim()) as RequirementStatusRow | undefined;
  }
  return undefined;
}

function missingSelector(): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: toolJson({
      ok: false,
      code: "REQUIREMENT_SELECTOR_REQUIRED",
      error: "Pass req_id or goal_key.",
    }) }],
  };
}

export async function handleGetRequirementStatus(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = GetRequirementStatusArgsSchema.parse(rawArgs);
  if (!args.req_id && !args.goal_key?.trim()) return missingSelector();
  const requirement = resolveRequirement(context, args);
  const activeCount = Number((context.getDb().prepare(
    `SELECT COUNT(*) AS count FROM requirements WHERE status = 'active'`,
  ).get() as { count: number } | undefined)?.count ?? 0);
  if (!requirement) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({
        ok: false,
        code: "REQUIREMENT_NOT_FOUND_IN_PROJECT",
        error: "No requirement matched the requested identity in this project root.",
        project_root: context.getProjectRoot(),
        requested: { req_id: args.req_id ?? null, goal_key: args.goal_key?.trim() || null },
        active_count: activeCount,
      }) }],
    };
  }
  const memoryRow = context.getDb().prepare(
    `SELECT metadata_json FROM memory_items WHERE kind = 'requirement' AND req_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(requirement.id) as { metadata_json: string | null } | undefined;
  const memoryStatus = memoryRow ? String(parseMetadataJson(memoryRow.metadata_json).status ?? "") : "";
  return {
    content: [{ type: "text", text: toolJson({
      ok: true,
      project_root: context.getProjectRoot(),
      requirement: {
        id: requirement.id,
        title: requirement.title,
        goal_key: requirement.goal_key,
        status: requirement.status,
        memory_status: memoryStatus || null,
        created_at: requirement.created_at,
        updated_at: requirement.updated_at ?? null,
      },
      resumable: requirement.status === "completed",
      active_count: activeCount,
    }) }],
  };
}

export async function handleResumeRequirement(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = ResumeRequirementArgsSchema.parse(rawArgs);
  if (!args.req_id && !args.goal_key?.trim()) return missingSelector();
  const requirement = resolveRequirement(context, args);
  if (!requirement) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({
        ok: false,
        code: "REQUIREMENT_NOT_FOUND_IN_PROJECT",
        error: "No requirement matched the requested identity in this project root.",
        project_root: context.getProjectRoot(),
      }) }],
    };
  }
  if (requirement.status === "active") {
    return { content: [{ type: "text", text: toolJson({
      ok: true,
      requirement: { id: requirement.id, title: requirement.title, goal_key: requirement.goal_key, status: "active" },
      resumed: false,
      reused_active: true,
    }) }] };
  }
  if (requirement.status !== "completed") {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({
        ok: false,
        code: requirement.status === "superseded"
          ? "REQUIREMENT_SUPERSEDED"
          : "REQUIREMENT_NOT_RESUMABLE",
        error: requirement.status === "superseded"
          ? "Superseded requirements cannot be resumed. Start a replacement requirement instead."
          : `Requirement status ${requirement.status} is not resumable.`,
        requirement: { id: requirement.id, goal_key: requirement.goal_key, status: requirement.status },
      }) }],
    };
  }

  const db = context.getDb();
  try {
    db.transaction(() => {
      const updated = db.prepare(
        `UPDATE requirements
            SET status = 'active', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'completed'`,
      ).run(requirement.id);
      if (updated.changes !== 1) throw new Error("requirement status changed before resume");
      const memory = db.prepare(
        `SELECT id, metadata_json FROM memory_items WHERE kind = 'requirement' AND req_id = ? ORDER BY id DESC LIMIT 1`,
      ).get(requirement.id) as { id: number; metadata_json: string | null } | undefined;
      if (memory) {
        const metadata = { ...parseMetadataJson(memory.metadata_json), status: "active", resumed_at: new Date().toISOString() };
        db.prepare(`UPDATE memory_items SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(JSON.stringify(metadata), memory.id);
      }
    })();
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({
        ok: false,
        code: "REQUIREMENT_RESUME_FAILED",
        error: String(err),
        requirement: { id: requirement.id, goal_key: requirement.goal_key },
      }) }],
    };
  }
  logActivity("resume_requirement", { req_id: requirement.id, goal_key: requirement.goal_key });
  return { content: [{ type: "text", text: toolJson({
    ok: true,
    requirement: { id: requirement.id, title: requirement.title, goal_key: requirement.goal_key, status: "active" },
    resumed: true,
  }) }] };
}

export async function handleUpdateRequirementVerification(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = UpdateRequirementVerificationArgsSchema.parse(rawArgs);
  if (!args.req_id && !args.goal_key?.trim()) return missingSelector();
  if (args.verification === undefined && args.verification_gaps === undefined &&
      args.resolved_verification_gaps === undefined) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({
        ok: false,
        code: "VERIFICATION_EVIDENCE_REQUIRED",
        error: "Pass verification, verification_gaps, or resolved_verification_gaps.",
      }) }],
    };
  }

  const db = context.getDb();
  try {
    const update = db.transaction(() => {
      const requirement = resolveRequirement(context, args);
      if (!requirement) {
        return { ok: false as const, code: "REQUIREMENT_NOT_FOUND_IN_PROJECT", error: "No requirement matched the requested identity in this project root." };
      }
      if (requirement.status === "superseded") {
        return { ok: false as const, code: "REQUIREMENT_SUPERSEDED", error: "Superseded requirements cannot accept verification updates." };
      }
      if (requirement.status !== "active" && requirement.status !== "completed") {
        return { ok: false as const, code: "REQUIREMENT_NOT_WRITABLE", error: `Requirement status ${requirement.status} cannot accept verification updates.` };
      }

      const change = db.prepare(
        `SELECT id, title, content, metadata_json
           FROM memory_items
          WHERE kind = 'change_intent' AND req_id = ?
          ORDER BY updated_at DESC, id DESC
          LIMIT 1`,
      ).get(requirement.id) as { id: number; title: string | null; content: string; metadata_json: string | null } | undefined;
      if (!change) {
        return { ok: false as const, code: "CHANGE_INTENT_NOT_FOUND", error: "No change_intent exists for this requirement. Sync the change intent before recording verification." };
      }

      const previousMetadata = parseMetadataJson(change.metadata_json);
      const previousVerification = Array.isArray(previousMetadata.verification)
        ? previousMetadata.verification.filter((value): value is string => typeof value === "string")
        : [];
      const previousGaps = Array.isArray(previousMetadata.verification_gaps)
        ? previousMetadata.verification_gaps.filter((value): value is string => typeof value === "string")
        : [];
      const suppliedVerification = sortedUniqueStrings(args.verification ?? []);
      const suppliedGaps = sortedUniqueStrings(args.verification_gaps ?? []);
      const resolvedGaps = new Set(sortedUniqueStrings(args.resolved_verification_gaps ?? []));
      const verification = args.replace_verification
        ? suppliedVerification
        : sortedUniqueStrings([...previousVerification, ...suppliedVerification]);
      const gapBase = args.verification_gaps !== undefined && args.replace_verification_gaps
        ? suppliedGaps
        : sortedUniqueStrings([...previousGaps, ...suppliedGaps]);
      const verificationGaps = gapBase.filter((gap) => !resolvedGaps.has(gap));
      const updatedAt = new Date().toISOString();
      const updateContent = safeJson({
        requirement_id: requirement.id,
        change_intent_memory_id: change.id,
        verification,
        verification_gaps: verificationGaps,
        resolved_verification_gaps: Array.from(resolvedGaps),
        updated_at: updatedAt,
      }) ?? "{}";
      const updateMetadata = safeJson({
        status: "recorded",
        source_change_intent_id: change.id,
        requirement_status: requirement.status,
        verification,
        verification_gaps: verificationGaps,
        resolved_verification_gaps: Array.from(resolvedGaps),
        updated_at: updatedAt,
      });
      const updateInfo = context.getStatements().insertMemoryItemStmt.run(
        "verification_update",
        `Verification update: ${requirement.title}`,
        updateContent,
        null,
        null,
        null,
        requirement.id,
        updateMetadata,
        context.sha256Hex(updateContent),
      );
      const verificationUpdateId = Number(updateInfo.lastInsertRowid);
      const nextMetadata = safeJson({
        ...previousMetadata,
        verification,
        verification_gaps: verificationGaps,
        verification_updated_at: updatedAt,
        latest_verification_update_id: verificationUpdateId,
      });
      const changed = db.prepare(
        `UPDATE memory_items
            SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND kind = 'change_intent' AND req_id = ?`,
      ).run(nextMetadata, change.id, requirement.id);
      if (changed.changes !== 1) throw new Error("change_intent changed before verification update");
      const touched = db.prepare(
        `UPDATE requirements SET updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status IN ('active', 'completed')`,
      ).run(requirement.id);
      if (touched.changes !== 1) throw new Error("requirement status changed before verification update");
      return {
        ok: true as const,
        requirement: { id: requirement.id, title: requirement.title, status: requirement.status },
        change_intent_memory_id: change.id,
        verification_update_memory_id: verificationUpdateId,
        previous_verification: sortedUniqueStrings(previousVerification),
        previous_verification_gaps: sortedUniqueStrings(previousGaps),
        verification,
        verification_gaps: verificationGaps,
        resolved_verification_gaps: Array.from(resolvedGaps),
      };
    }).immediate();

    if (!update.ok) {
      return { isError: true, content: [{ type: "text", text: toolJson({ ...update, project_root: context.getProjectRoot() }) }] };
    }
    logActivity("update_requirement_verification", {
      req_id: update.requirement.id,
      change_intent_memory_id: update.change_intent_memory_id,
      verification_update_memory_id: update.verification_update_memory_id,
      verification: update.verification.length,
      verification_gaps: update.verification_gaps.length,
    });
    return { content: [{ type: "text", text: toolJson({ ...update, project_root: context.getProjectRoot() }) }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({
        ok: false,
        code: "VERIFICATION_UPDATE_FAILED",
        error: String(err),
      }) }],
    };
  }
}
