import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import type { MemoryItemRow } from "../types.js";
import { AddNoteArgsSchema, DEFAULT_PREVIEW_CHARS, SupersedeMemoryArgsSchema, UpsertConventionArgsSchema, UpsertDecisionArgsSchema, UpsertProjectSummaryArgsSchema } from "../tool-schemas.js";
import { supersedeMemoryItemIds, supersedeRequirementIds } from "../memory-mutations.js";
import { makePreviewText } from "../memory-recall.js";
import { logActivity } from "../activity-log.js";
import { safeJson, toolJson } from "../tool-output.js";
import { sanitizePersistentMemoryText } from "../memory-safety.js";
export async function handleUpsertProjectSummary(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const sha256Hex = context.sha256Hex;
  const { getProjectSummaryStmt, upsertProjectSummaryStmt } = context.getStatements();

  const args = UpsertProjectSummaryArgsSchema.parse(rawArgs);
  const sanitized = sanitizePersistentMemoryText(args.summary.trim());
  const summary = sanitized.text;
  const contentHash = sha256Hex(summary);
  upsertProjectSummaryStmt.run(summary, safeJson({ source: "assistant" }), contentHash);

  const row = getProjectSummaryStmt.get() as MemoryItemRow | undefined;

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          project_summary: row ? { id: row.id, updated_at: row.updated_at } : null,
          redaction: { applied: sanitized.redacted, categories: sanitized.categories },
        }),
      },
    ],
  };
}
export async function handleAddNote(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const sha256Hex = context.sha256Hex;
  const { insertMemoryItemStmt } = context.getStatements();

  const args = AddNoteArgsSchema.parse(rawArgs);
  const sanitizedTitle = sanitizePersistentMemoryText(args.title?.trim() ?? "");
  const sanitizedContent = sanitizePersistentMemoryText(args.content.trim());
  const title = sanitizedTitle.text;
  const content = sanitizedContent.text;
  const info = insertMemoryItemStmt.run(
    "note",
    title || null,
    content,
    null,
    null,
    null,
    null,
    safeJson({ source: "assistant_generated", tags: args.tags ?? [] }),
    sha256Hex(content),
  );
  const id = Number(info.lastInsertRowid);

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          note: { id },
          redaction: {
            applied: sanitizedTitle.redacted || sanitizedContent.redacted,
            categories: [...new Set([...sanitizedTitle.categories, ...sanitizedContent.categories])].sort(),
          },
        }),
      },
    ],
  };
}
export async function handleUpsertDecision(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const normalizeToDbPath = context.normalizeToDbPath;
  const sha256Hex = context.sha256Hex;
  const { upsertDecisionStmt, getDecisionByKeyStmt } = context.getStatements();

  const args = UpsertDecisionArgsSchema.parse(rawArgs);
  const key = args.key.trim();
  const sanitizedTitle = sanitizePersistentMemoryText(args.title.trim() || key);
  const sanitizedContent = sanitizePersistentMemoryText(args.content.trim());
  const title = sanitizedTitle.text;
  const content = sanitizedContent.text;
  const meta = {
    source: "assistant_generated",
    status: "current",
    key,
    title,
    tags: args.tags ?? [],
    supersedes_req_ids: args.supersedes_req_ids ?? [],
    supersedes_memory_ids: args.supersedes_memory_ids ?? [],
    related_files: (args.related_files ?? []).map((f) => normalizeToDbPath(f)),
  };
  upsertDecisionStmt.run(key, `${title}\n\n${content}`, safeJson(meta), sha256Hex(`${title}\n\n${content}`));
  const row = getDecisionByKeyStmt.get(key) as MemoryItemRow | undefined;

  const superseded_requirements = supersedeRequirementIds(args.supersedes_req_ids ?? [], {
    decision_id: row?.id,
    reason: `Superseded by decision ${key}: ${title}`,
  });
  const superseded_memory_items = supersedeMemoryItemIds(args.supersedes_memory_ids ?? [], {
    decision_id: row?.id,
    reason: `Superseded by decision ${key}: ${title}`,
  });

  logActivity("upsert_decision", {
    key,
    decision_id: row?.id ?? null,
    superseded_requirements,
    superseded_memory_items,
  });

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          decision: row ? { id: row.id, key, updated_at: row.updated_at } : null,
          superseded_requirements,
          superseded_memory_items,
          redaction: {
            applied: sanitizedTitle.redacted || sanitizedContent.redacted,
            categories: [...new Set([...sanitizedTitle.categories, ...sanitizedContent.categories])].sort(),
          },
        }),
      },
    ],
  };
}
export async function handleSupersedeMemory(
  rawArgs: Record<string, unknown>,
  _context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = SupersedeMemoryArgsSchema.parse(rawArgs);
  const supersededReqIds = args.superseded_req_ids ?? [];
  const supersededMemoryIds = args.superseded_memory_ids ?? [];
  if (!supersededReqIds.length && !supersededMemoryIds.length) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            error: "Provide superseded_req_ids and/or superseded_memory_ids.",
          }),
        },
      ],
    };
  }
  const superseded_requirements = supersedeRequirementIds(supersededReqIds, {
    req_id: args.replacement_req_id,
    memory_id: args.replacement_memory_id,
    reason: args.reason,
  });
  const superseded_memory_items = supersedeMemoryItemIds(supersededMemoryIds, {
    req_id: args.replacement_req_id,
    memory_id: args.replacement_memory_id,
    reason: args.reason,
  });
  logActivity("supersede_memory", {
    superseded_requirements,
    superseded_memory_items,
    replacement_req_id: args.replacement_req_id ?? null,
    replacement_memory_id: args.replacement_memory_id ?? null,
  });
  return {
    content: [
      {
        type: "text",
        text: toolJson({ ok: true, superseded_requirements, superseded_memory_items }),
      },
    ],
  };
}
export async function handleUpsertConvention(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const sha256Hex = context.sha256Hex;
  const { getConventionByKeyStmt, insertConventionStmt, updateConventionByIdStmt } = context.getStatements();

  const args = UpsertConventionArgsSchema.parse(rawArgs);
  const key = args.key.trim();
  const sanitized = sanitizePersistentMemoryText(args.content.trim());
  const content = sanitized.text;
  const contentHash = sha256Hex(content);
  const meta = safeJson({ source: "assistant_generated", tags: args.tags ?? [] });
  const existing = getConventionByKeyStmt.get(key) as MemoryItemRow | undefined;
  if (existing) {
    updateConventionByIdStmt.run(content, meta, contentHash, existing.id);
  } else {
    insertConventionStmt.run(key, content, meta, contentHash);
  }
  const row = getConventionByKeyStmt.get(key) as MemoryItemRow | undefined;

  logActivity("upsert_convention", { key, content_preview: makePreviewText(content, 200) });

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          convention: row
            ? {
                id: row.id,
                key: row.title,
                updated_at: row.updated_at,
                preview: makePreviewText(row.content, DEFAULT_PREVIEW_CHARS),
              }
            : null,
          redaction: { applied: sanitized.redacted, categories: sanitized.categories },
        }),
      },
    ],
  };
}
