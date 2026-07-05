import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";

import type { ToolHandlerContext } from "./context.js";
import type { ChangeLogRow, MemoryItemRow, PendingChangeRow, RequirementRow } from "../types.js";
import {
  CreateCheckpointArgsSchema,
  ListCheckpointsArgsSchema,
  MemoryTimelineArgsSchema,
  RestoreCheckpointContextArgsSchema,
} from "../tool-schemas.js";
import { flushPendingChangeBuffer } from "../file-indexing.js";
import { isHiddenFromDefaultRecall, parseMetadataJson, toChangeLogPreview, toMemoryItemPreview, toRequirementPreview } from "../memory-recall.js";
import { mergePendingWithGit } from "../pending-changes.js";
import { logActivity } from "../activity-log.js";
import { oneLine, safeJson, toolJson } from "../tool-output.js";
import { toolCompactOrJson } from "../token-savings.js";

function compactTimelineText(data: {
  ok: boolean;
  basis: Record<string, unknown>;
  returned: number;
  hidden_skipped: number;
  items: Array<ReturnType<typeof toMemoryItemPreview>>;
}): string {
  const filters = Object.entries(data.basis)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  const lines = [
    `memory_timeline returned=${data.returned} hidden_skipped=${data.hidden_skipped}${filters ? ` ${filters}` : ""}`,
  ];
  for (const item of data.items.slice(0, 100)) {
    const loc = item.file_path ? ` ${item.file_path}${item.start_line != null ? `:${item.start_line}` : ""}` : "";
    lines.push(
      `- ${item.updated_at ?? ""} #${item.id} ${item.kind}${item.title ? ` ${oneLine(item.title, 70)}` : ""}${loc}: ${oneLine(
        item.preview ?? "",
        180,
      )}`,
    );
  }
  if (!data.items.length) lines.push("- no timeline items");
  lines.push("hint: memory_timeline is read-only context evidence; use model judgment when evidence is incomplete");
  return lines.join("\n");
}

function compactCheckpointText(data: {
  ok: boolean;
  checkpoint?: ReturnType<typeof toMemoryItemPreview>;
  checkpoints?: Array<ReturnType<typeof toMemoryItemPreview>>;
  snapshot?: Record<string, unknown>;
  count?: number;
  restored?: boolean;
}): string {
  if (data.checkpoints) {
    const lines = [`checkpoints returned=${data.checkpoints.length}${data.count != null ? ` total_hint=${data.count}` : ""}`];
    for (const c of data.checkpoints.slice(0, 100)) {
      lines.push(`- ${c.updated_at ?? ""} #${c.id} ${oneLine(c.title ?? "checkpoint", 80)}: ${oneLine(c.preview ?? "", 180)}`);
    }
    if (!data.checkpoints.length) lines.push("- no checkpoints");
    return lines.join("\n");
  }

  const cp = data.checkpoint;
  const active = data.snapshot?.active_requirement as { id?: number; title?: string } | null | undefined;
  const pending = Array.isArray(data.snapshot?.pending_changes) ? data.snapshot.pending_changes.length : 0;
  const recent = Array.isArray(data.snapshot?.recent_memory) ? data.snapshot.recent_memory.length : 0;
  const decisions = Array.isArray(data.snapshot?.decisions) ? data.snapshot.decisions.length : 0;
  const lines = [
    `${data.restored ? "restore_checkpoint_context" : "create_checkpoint"} #${cp?.id ?? ""} ${oneLine(cp?.title ?? "", 100)}`,
    `active=${active?.id ? `req#${active.id} ${oneLine(active.title ?? "", 80)}` : "none"} decisions=${decisions} recent=${recent} pending=${pending}`,
  ];
  if (cp?.preview) lines.push(oneLine(cp.preview, 220));
  lines.push("hint: checkpoints restore context only; they do not mutate active requirements or override model judgment");
  return lines.join("\n");
}

function getVisibleRecentCoreMemory(db: Database.Database, limit: number): MemoryItemRow[] {
  if (limit <= 0) return [];
  const pageSize = 200;
  const scanCap = 10_000;
  const stmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind IN ('requirement', 'change_intent', 'note', 'decision', 'checkpoint', 'memory_compaction', 'project_summary', 'convention')
     ORDER BY updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  );
  const visible: MemoryItemRow[] = [];
  let offset = 0;
  while (visible.length < limit && offset < scanCap) {
    const rows = stmt.all(pageSize, offset) as MemoryItemRow[];
    if (!rows.length) break;
    for (const row of rows) {
      if (!isHiddenFromDefaultRecall(row)) visible.push(row);
      if (visible.length >= limit) break;
    }
    offset += rows.length;
    if (rows.length < pageSize) break;
  }
  return visible.slice(0, limit);
}

export async function handleMemoryTimeline(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = MemoryTimelineArgsSchema.parse(rawArgs);
  const db = context.getDb();
  const clauses = [
    "kind IN ('requirement', 'change_intent', 'note', 'decision', 'checkpoint', 'memory_compaction', 'project_summary', 'convention')",
  ];
  const params: unknown[] = [];
  const anchor = args.memory_id
    ? (context.getStatements().getMemoryItemByIdStmt.get(args.memory_id) as MemoryItemRow | undefined)
    : undefined;
  const reqId = args.req_id ?? anchor?.req_id ?? undefined;
  const filePath = args.file ? context.normalizeToDbPath(args.file) : anchor?.file_path ?? undefined;
  const aroundTime = args.around_time ?? anchor?.updated_at ?? undefined;

  if (args.memory_id && !args.req_id && !args.file && !args.query) {
    const subClauses = ["id = ?"];
    params.push(args.memory_id);
    if (reqId != null) {
      subClauses.push("req_id = ?");
      params.push(reqId);
    }
    if (filePath) {
      subClauses.push("file_path = ?");
      params.push(filePath);
    }
    clauses.push(`(${subClauses.join(" OR ")})`);
  } else {
    if (reqId != null) {
      clauses.push("req_id = ?");
      params.push(reqId);
    }
    if (filePath) {
      clauses.push("file_path = ?");
      params.push(filePath);
    }
  }

  if (args.query) {
    const like = `%${context.escapeLike(args.query)}%`;
    clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR metadata_json LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }

  const fetchLimit = Math.min(Math.max(args.window * 4, args.window), 400);
  const orderBy = aroundTime
    ? "ORDER BY ABS(strftime('%s', updated_at) - strftime('%s', ?)) ASC, updated_at DESC, id DESC"
    : "ORDER BY updated_at DESC, id DESC";
  if (aroundTime) params.push(aroundTime);
  params.push(fetchLimit);

  const rows = db
    .prepare(
      `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
       FROM memory_items
       WHERE ${clauses.join(" AND ")}
       ${orderBy}
       LIMIT ?`,
    )
    .all(...params) as MemoryItemRow[];

  let hiddenSkipped = 0;
  const visible = rows.filter((row) => {
    if (args.include_hidden || !isHiddenFromDefaultRecall(row)) return true;
    hiddenSkipped += 1;
    return false;
  });
  const ordered = visible
    .slice(0, args.window)
    .sort((a, b) => `${a.updated_at}:${a.id}`.localeCompare(`${b.updated_at}:${b.id}`));
  const items = ordered.map((row) => toMemoryItemPreview(row, args.include_content, args.preview_chars, args.content_max_chars));
  const outputValue = {
    ok: true,
    basis: {
      memory_id: args.memory_id ?? null,
      req_id: reqId ?? null,
      file: filePath ?? null,
      query: args.query ?? null,
      around_time: aroundTime ?? null,
      window: args.window,
      include_hidden: args.include_hidden,
    },
    returned: items.length,
    hidden_skipped: hiddenSkipped,
    items,
  };

  logActivity("memory_timeline", {
    memory_id: args.memory_id ?? null,
    req_id: reqId ?? null,
    file: filePath ?? null,
    query: args.query ?? null,
    returned: items.length,
  });

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson("memory_timeline", outputValue, compactTimelineText(outputValue), args.format),
      },
    ],
  };
}

export async function handleCreateCheckpoint(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = CreateCheckpointArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();

  const db = context.getDb();
  const {
    getActiveRequirementStmt,
    getProjectSummaryStmt,
    insertMemoryItemStmt,
    listChangeLogsForRequirementStmt,
    listCurrentDecisionsStmt,
    listPendingChangesStmt,
  } = context.getStatements();
  const active = getActiveRequirementStmt.get() as RequirementRow | undefined;
  const projectSummary = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
  const decisions = (listCurrentDecisionsStmt.all(10) as MemoryItemRow[])
    .filter((row) => !isHiddenFromDefaultRecall(row))
    .map((row) => toMemoryItemPreview(row, false, 180, 1200));
  const recentRows = getVisibleRecentCoreMemory(db, args.recent_limit)
    .map((row) => toMemoryItemPreview(row, false, 180, 1200));
  const pendingRows = listPendingChangesStmt.all() as PendingChangeRow[];
  const pending = args.pending_limit > 0
    ? mergePendingWithGit(pendingRows, { offset: 0, limit: args.pending_limit }).page
    : [];
  const recentChanges = active
    ? (listChangeLogsForRequirementStmt.all(active.id, 10) as ChangeLogRow[]).map((row) => toChangeLogPreview(row, false, 180, 1200))
    : [];
  const snapshot = {
    created_at: new Date().toISOString(),
    advisory_only: true,
    note: "Checkpoint is context evidence only; it does not mutate active requirements or override model judgment.",
    active_requirement: active ? toRequirementPreview(active, false, 180, 1200) : null,
    project_summary: projectSummary ? toMemoryItemPreview(projectSummary, false, 180, 1200) : null,
    decisions,
    recent_memory: recentRows,
    recent_changes: recentChanges,
    pending_changes: pending,
  };
  const summary = args.summary.trim();
  const content = [
    args.title,
    summary ? `Summary: ${summary}` : "",
    active ? `Active requirement: #${active.id} ${active.title}` : "Active requirement: none",
    `Decisions: ${decisions.map((d) => d.title ?? `#${d.id}`).join(", ") || "none"}`,
    `Pending: ${pending.map((p) => p.file_path).join(", ") || "none"}`,
  ]
    .filter(Boolean)
    .join("\n");
  const meta = {
    status: "current",
    type: "checkpoint",
    advisory_only: true,
    snapshot,
  };
  const info = insertMemoryItemStmt.run(
    "checkpoint",
    args.title,
    content,
    null,
    null,
    null,
    active?.id ?? null,
    safeJson(meta),
    context.sha256Hex(`${args.title}\n${content}\n${JSON.stringify(snapshot)}`),
  );
  const checkpointId = Number(info.lastInsertRowid);
  const checkpoint = context.getStatements().getMemoryItemByIdStmt.get(checkpointId) as MemoryItemRow;
  const checkpointPreview = toMemoryItemPreview(checkpoint, false, 180, 1200);
  const outputValue = {
    ok: true,
    checkpoint: checkpointPreview,
    snapshot,
  };

  logActivity("create_checkpoint", {
    checkpoint_id: checkpointId,
    title: args.title,
    active_requirement_id: active?.id ?? null,
    pending: pending.length,
  });

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson("create_checkpoint", outputValue, compactCheckpointText(outputValue), args.format),
      },
    ],
  };
}

export async function handleListCheckpoints(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = ListCheckpointsArgsSchema.parse(rawArgs);
  const db = context.getDb();
  const rows = db
    .prepare(
      `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
       FROM memory_items
       WHERE kind = 'checkpoint'
       ORDER BY updated_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(args.limit, args.offset) as MemoryItemRow[];
  const checkpoints = rows.map((row) => toMemoryItemPreview(row, args.include_content, args.preview_chars, args.content_max_chars));
  const outputValue = {
    ok: true,
    offset: args.offset,
    limit: args.limit,
    checkpoints,
  };

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson("list_checkpoints", outputValue, compactCheckpointText(outputValue), args.format),
      },
    ],
  };
}

export async function handleRestoreCheckpointContext(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = RestoreCheckpointContextArgsSchema.parse(rawArgs);
  const db = context.getDb();
  const params: unknown[] = [];
  const clauses = ["kind = 'checkpoint'"];
  if (args.checkpoint_id) {
    clauses.push("id = ?");
    params.push(args.checkpoint_id);
  }
  if (args.title) {
    clauses.push("title = ?");
    params.push(args.title);
  }
  const row = db
    .prepare(
      `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
       FROM memory_items
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
    )
    .get(...params) as MemoryItemRow | undefined;
  if (!row) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({ ok: false, error: "checkpoint not found" }) }],
    };
  }
  const meta = parseMetadataJson(row.metadata_json);
  const snapshot = (meta.snapshot && typeof meta.snapshot === "object" ? meta.snapshot : {}) as Record<string, unknown>;
  const checkpoint = toMemoryItemPreview(row, args.include_content, args.preview_chars, args.content_max_chars);
  const outputValue = {
    ok: true,
    restored: true,
    read_only: true,
    checkpoint,
    snapshot,
  };

  logActivity("restore_checkpoint_context", {
    checkpoint_id: row.id,
    title: row.title,
  });

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson("restore_checkpoint_context", outputValue, compactCheckpointText(outputValue), args.format),
      },
    ],
  };
}
