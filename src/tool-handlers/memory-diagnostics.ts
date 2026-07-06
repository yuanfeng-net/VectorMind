import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import type { MemoryItemRow, PendingChangeRow, RequirementRow } from "../types.js";
import {
  AnalyzeMemoryConflictsArgsSchema,
  CompareCheckpointContextArgsSchema,
  MemoryQualityReportArgsSchema,
} from "../tool-schemas.js";
import { flushPendingChangeBuffer } from "../file-indexing.js";
import { isHiddenFromDefaultRecall, parseMetadataJson, toMemoryItemPreview, toRequirementPreview } from "../memory-recall.js";
import { mergePendingWithGit } from "../pending-changes.js";
import { logActivity } from "../activity-log.js";
import { oneLine, toolJson } from "../tool-output.js";
import { toolCompactOrJson } from "../token-savings.js";

type MemoryPreview = ReturnType<typeof toMemoryItemPreview>;

type ConflictItem = {
  id?: number;
  kind?: string;
  title?: string | null;
  status?: string | null;
  preview?: string;
};

type MemoryConflict = {
  code: string;
  severity: "low" | "medium" | "high";
  summary: string;
  suggested_action: string;
  items: ConflictItem[];
};

function compactConflictText(data: {
  ok: boolean;
  read_only: boolean;
  advisory_only: boolean;
  scanned: number;
  conflicts: MemoryConflict[];
}): string {
  const lines = [
    `memory_conflicts conflicts=${data.conflicts.length} scanned=${data.scanned} read_only=${data.read_only}`,
  ];
  for (const c of data.conflicts.slice(0, 50)) {
    lines.push(`- [${c.severity}] ${c.code}: ${oneLine(c.summary, 180)}`);
    for (const item of c.items.slice(0, 4)) {
      const id = item.id != null ? `#${item.id}` : "";
      const kind = item.kind ?? "item";
      const title = item.title ? ` ${oneLine(item.title, 80)}` : "";
      const status = item.status ? ` status=${item.status}` : "";
      const preview = item.preview ? `: ${oneLine(item.preview, 140)}` : "";
      lines.push(`  - ${id} ${kind}${title}${status}${preview}`.trimEnd());
    }
    lines.push(`  action: ${oneLine(c.suggested_action, 180)}`);
  }
  if (!data.conflicts.length) lines.push("- no likely memory conflicts found");
  lines.push("hint: conflict detection is read-only evidence; verify with repo facts and model judgment");
  return lines.join("\n");
}

function compactQualityText(data: {
  ok: boolean;
  read_only: boolean;
  totals: Record<string, number>;
  hidden: { superseded: number; compacted: number };
  duplicate_titles: unknown[];
  duplicate_hashes: unknown[];
  oversized_checkpoints: unknown[];
  stale_index_samples: unknown[];
  orphaned_memory_items: unknown[];
}): string {
  const totals = Object.entries(data.totals)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const lines = [
    `memory_quality read_only=${data.read_only} totals ${totals || "none"}`,
    `hidden superseded=${data.hidden.superseded} compacted=${data.hidden.compacted}`,
    `issues duplicate_titles=${data.duplicate_titles.length} duplicate_hashes=${data.duplicate_hashes.length} oversized_checkpoints=${data.oversized_checkpoints.length} stale_indexes=${data.stale_index_samples.length} orphaned=${data.orphaned_memory_items.length}`,
  ];
  for (const [label, items] of [
    ["duplicate_title", data.duplicate_titles],
    ["duplicate_hash", data.duplicate_hashes],
    ["oversized_checkpoint", data.oversized_checkpoints],
    ["stale_index", data.stale_index_samples],
    ["orphaned_memory", data.orphaned_memory_items],
  ] as const) {
    for (const item of items.slice(0, 5)) {
      lines.push(`- ${label}: ${oneLine(JSON.stringify(item), 220)}`);
    }
  }
  lines.push("hint: report is diagnostic only; use maintain_memory/prune_index separately when needed");
  return lines.join("\n");
}

function compactCheckpointDiffText(data: {
  ok: boolean;
  read_only: boolean;
  checkpoint: MemoryPreview;
  diff: {
    active_requirement_changed: boolean;
    project_summary_changed: boolean;
    decisions_added: MemoryPreview[];
    decisions_removed: MemoryPreview[];
    decisions_changed: MemoryPreview[];
    recent_memory_added: MemoryPreview[];
    recent_memory_no_longer_recent: MemoryPreview[];
    pending_added: string[];
    pending_removed: string[];
  };
}): string {
  const d = data.diff;
  const lines = [
    `checkpoint_diff #${data.checkpoint.id} ${oneLine(data.checkpoint.title ?? "checkpoint", 100)} read_only=${data.read_only}`,
    `active_changed=${d.active_requirement_changed} summary_changed=${d.project_summary_changed}`,
    `decisions added=${d.decisions_added.length} removed=${d.decisions_removed.length} changed=${d.decisions_changed.length}`,
    `recent_memory added=${d.recent_memory_added.length} no_longer_recent=${d.recent_memory_no_longer_recent.length}`,
    `pending added=${d.pending_added.length} removed=${d.pending_removed.length}`,
  ];
  for (const item of d.decisions_added.slice(0, 5)) lines.push(`- decision_added: #${item.id} ${oneLine(item.title ?? "", 100)}`);
  for (const item of d.decisions_removed.slice(0, 5)) lines.push(`- decision_removed: #${item.id} ${oneLine(item.title ?? "", 100)}`);
  for (const item of d.recent_memory_added.slice(0, 5)) lines.push(`- memory_added: #${item.id} ${item.kind} ${oneLine(item.title ?? "", 100)}`);
  for (const p of d.pending_added.slice(0, 5)) lines.push(`- pending_added: ${p}`);
  lines.push("hint: checkpoint diff is read-only; it does not restore, mutate, or expand the current requirement");
  return lines.join("\n");
}

function metadataStatus(row: MemoryItemRow): string {
  const meta = parseMetadataJson(row.metadata_json);
  if (typeof meta.status === "string") return meta.status;
  if (meta.superseded === true) return "superseded";
  if (meta.compacted === true) return "compacted";
  return "current";
}

function itemConflictPreview(row: MemoryItemRow): ConflictItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: metadataStatus(row),
    preview: oneLine(row.content ?? "", 160),
  };
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function shouldCheckDuplicateTitle(kind: string): boolean {
  return ["requirement", "note", "decision", "convention", "project_summary", "checkpoint"].includes(kind);
}

function getCoreMemoryRows(context: ToolHandlerContext, args: {
  query?: string;
  decision_key?: string;
  scan_limit: number;
}): MemoryItemRow[] {
  const db = context.getDb();
  const clauses = [
    "kind IN ('requirement', 'change_intent', 'note', 'decision', 'checkpoint', 'memory_compaction', 'project_summary', 'convention')",
  ];
  const params: unknown[] = [];
  if (args.query) {
    const like = `%${context.escapeLike(args.query)}%`;
    clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR metadata_json LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  if (args.decision_key) {
    const like = `%${context.escapeLike(args.decision_key)}%`;
    clauses.push("(title = ? OR metadata_json LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
    params.push(args.decision_key, like, like);
  }
  params.push(args.scan_limit);
  return db
    .prepare(
      `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
       FROM memory_items
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params) as MemoryItemRow[];
}

function getCurrentSnapshot(context: ToolHandlerContext, recentLimit: number, pendingLimit: number) {
  flushPendingChangeBuffer();
  const db = context.getDb();
  const {
    getActiveRequirementStmt,
    getProjectSummaryStmt,
    listCurrentDecisionsStmt,
    listPendingChangesStmt,
  } = context.getStatements();
  const active = getActiveRequirementStmt.get() as RequirementRow | undefined;
  const projectSummary = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
  const decisions = (listCurrentDecisionsStmt.all(20) as MemoryItemRow[])
    .filter((row) => !isHiddenFromDefaultRecall(row))
    .map((row) => toMemoryItemPreview(row, false, 180, 1200));
  const recentMemory = db
    .prepare(
      `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
       FROM memory_items
       WHERE kind IN ('requirement', 'change_intent', 'note', 'decision', 'checkpoint', 'memory_compaction', 'project_summary', 'convention')
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(Math.max(recentLimit * 4, recentLimit)) as MemoryItemRow[];
  const visibleRecent = recentMemory
    .filter((row) => !isHiddenFromDefaultRecall(row))
    .slice(0, recentLimit)
    .map((row) => toMemoryItemPreview(row, false, 180, 1200));
  const pendingRows = listPendingChangesStmt.all() as PendingChangeRow[];
  const pending = pendingLimit > 0 ? mergePendingWithGit(pendingRows, { offset: 0, limit: pendingLimit }).page : [];
  return {
    active_requirement: active ? toRequirementPreview(active, false, 180, 1200) : null,
    project_summary: projectSummary ? toMemoryItemPreview(projectSummary, false, 180, 1200) : null,
    decisions,
    recent_memory: visibleRecent,
    pending_changes: pending,
  };
}

function previewArrayById(items: unknown): Map<number, MemoryPreview> {
  const result = new Map<number, MemoryPreview>();
  if (!Array.isArray(items)) return result;
  for (const raw of items) {
    const item = raw as MemoryPreview;
    if (typeof item?.id === "number") result.set(item.id, item);
  }
  return result;
}

function diffPreviewMaps(before: Map<number, MemoryPreview>, after: Map<number, MemoryPreview>) {
  const added: MemoryPreview[] = [];
  const removed: MemoryPreview[] = [];
  const changed: MemoryPreview[] = [];
  for (const [id, item] of after) {
    const old = before.get(id);
    if (!old) added.push(item);
    else if ((old.preview ?? "") !== (item.preview ?? "") || old.updated_at !== item.updated_at) changed.push(item);
  }
  for (const [id, item] of before) {
    if (!after.has(id)) removed.push(item);
  }
  return { added, removed, changed };
}

function pendingPaths(items: unknown): Set<string> {
  const result = new Set<string>();
  if (!Array.isArray(items)) return result;
  for (const item of items as Array<{ file_path?: unknown }>) {
    if (typeof item.file_path === "string") result.add(item.file_path);
  }
  return result;
}

export async function handleAnalyzeMemoryConflicts(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = AnalyzeMemoryConflictsArgsSchema.parse(rawArgs);
  const rows = getCoreMemoryRows(context, args);
  const conflicts: MemoryConflict[] = [];
  const visibleRows = rows.filter((row) => args.include_hidden || !isHiddenFromDefaultRecall(row));

  const activeReqs = context.getDb()
    .prepare(`SELECT id, title, status, context_data, created_at FROM requirements WHERE status = 'active' ORDER BY created_at DESC, id DESC`)
    .all() as RequirementRow[];
  if (activeReqs.length > 1) {
    conflicts.push({
      code: "multiple_active_requirements",
      severity: "medium",
      summary: `There are ${activeReqs.length} active requirements. This can make scope recovery ambiguous.`,
      suggested_action: "Complete old requirements or start a new requirement with close_previous=true if appropriate.",
      items: activeReqs.slice(0, 8).map((r) => ({ id: r.id, kind: "requirement", title: r.title, status: r.status })),
    });
  }

  const titleGroups = new Map<string, MemoryItemRow[]>();
  for (const row of visibleRows) {
    if (!shouldCheckDuplicateTitle(row.kind)) continue;
    const key = `${row.kind}:${normalizeKey(row.title)}`;
    if (!row.title || key.endsWith(":")) continue;
    const list = titleGroups.get(key) ?? [];
    list.push(row);
    titleGroups.set(key, list);
  }
  for (const group of titleGroups.values()) {
    const contentKeys = new Set(group.map((row) => row.content_hash ?? context.sha256Hex(row.content)));
    if (group.length > 1 && contentKeys.size > 1) {
      conflicts.push({
        code: "duplicate_visible_title",
        severity: "low",
        summary: `${group.length} visible ${group[0]?.kind ?? "memory"} records share the title "${group[0]?.title ?? ""}" but differ in content.`,
        suggested_action: "Review whether older records should be superseded or merged; do not change source code based on this report alone.",
        items: group.slice(0, 6).map(itemConflictPreview),
      });
    }
  }

  const currentDecisions = rows.filter((row) => row.kind === "decision" && !isHiddenFromDefaultRecall(row) && metadataStatus(row) === "current");
  for (const decision of currentDecisions) {
    const meta = parseMetadataJson(decision.metadata_json);
    const memoryIds = Array.isArray(meta.supersedes_memory_ids) ? meta.supersedes_memory_ids : [];
    for (const rawId of memoryIds) {
      const id = Number(rawId);
      if (!Number.isFinite(id) || id <= 0) continue;
      const target = context.getStatements().getMemoryItemByIdStmt.get(id) as MemoryItemRow | undefined;
      if (target && !isHiddenFromDefaultRecall(target)) {
        conflicts.push({
          code: "superseded_target_still_visible",
          severity: "high",
          summary: `Decision #${decision.id} says memory #${target.id} is superseded, but the target is still visible to default recall.`,
          suggested_action: "Run supersede_memory for the target or inspect why metadata was not updated.",
          items: [itemConflictPreview(decision), itemConflictPreview(target)],
        });
      }
    }
    const reqIds = Array.isArray(meta.supersedes_req_ids) ? meta.supersedes_req_ids : [];
    for (const rawId of reqIds) {
      const id = Number(rawId);
      if (!Number.isFinite(id) || id <= 0) continue;
      const req = context.getDb()
        .prepare(`SELECT id, title, status, context_data, created_at FROM requirements WHERE id = ?`)
        .get(id) as RequirementRow | undefined;
      if (req?.status === "active") {
        conflicts.push({
          code: "superseded_requirement_still_active",
          severity: "high",
          summary: `Decision #${decision.id} says requirement #${req.id} is superseded, but it is still active.`,
          suggested_action: "Complete or supersede the old requirement if the newer decision is confirmed.",
          items: [itemConflictPreview(decision), { id: req.id, kind: "requirement", title: req.title, status: req.status }],
        });
      }
    }
  }

  if (args.query || args.decision_key) {
    const hiddenMatches = rows.filter((row) => isHiddenFromDefaultRecall(row));
    const visibleMatches = rows.filter((row) => !isHiddenFromDefaultRecall(row));
    if (hiddenMatches.length > 0 && visibleMatches.length > 0) {
      conflicts.push({
        code: "mixed_current_and_hidden_matches",
        severity: "low",
        summary: "The same query matched both visible current memory and hidden old memory. This is usually safe, but useful when auditing stale-rule regressions.",
        suggested_action: "Prefer visible/current records and use memory_timeline if ordering is unclear.",
        items: [...visibleMatches.slice(0, 3), ...hiddenMatches.slice(0, 3)].map(itemConflictPreview),
      });
    }
  }

  const outputValue = {
    ok: true,
    read_only: true,
    advisory_only: true,
    basis: {
      query: args.query ?? null,
      decision_key: args.decision_key ?? null,
      include_hidden: args.include_hidden,
      scan_limit: args.scan_limit,
    },
    scanned: rows.length,
    conflicts: conflicts.slice(0, args.limit),
  };
  logActivity("analyze_memory_conflicts", {
    query: args.query ?? null,
    decision_key: args.decision_key ?? null,
    scanned: rows.length,
    conflicts: outputValue.conflicts.length,
  });
  return {
    content: [{ type: "text", text: toolCompactOrJson("analyze_memory_conflicts", outputValue, compactConflictText(outputValue), args.format) }],
  };
}

export async function handleMemoryQualityReport(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = MemoryQualityReportArgsSchema.parse(rawArgs);
  const db = context.getDb();
  const rows = db
    .prepare(
      `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
       FROM memory_items
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(args.scan_limit) as MemoryItemRow[];
  const totals: Record<string, number> = {};
  let superseded = 0;
  let compacted = 0;
  for (const row of rows) {
    totals[row.kind] = (totals[row.kind] ?? 0) + 1;
    const status = metadataStatus(row);
    if (status === "superseded") superseded += 1;
    if (status === "compacted") compacted += 1;
  }

  const visible = rows.filter((row) => !isHiddenFromDefaultRecall(row));
  const duplicateTitleMap = new Map<string, MemoryItemRow[]>();
  for (const row of visible) {
    if (!shouldCheckDuplicateTitle(row.kind)) continue;
    const key = `${row.kind}:${normalizeKey(row.title)}`;
    if (!row.title || key.endsWith(":")) continue;
    const list = duplicateTitleMap.get(key) ?? [];
    list.push(row);
    duplicateTitleMap.set(key, list);
  }
  const duplicateTitles = Array.from(duplicateTitleMap.values())
    .filter((group) => group.length > 1)
    .slice(0, args.limit)
    .map((group) => ({
      kind: group[0]?.kind,
      title: group[0]?.title,
      count: group.length,
      ids: group.slice(0, 10).map((row) => row.id),
    }));

  const duplicateHashes = db
    .prepare(
      `WITH recent AS (
         SELECT id, kind, content_hash, updated_at
         FROM memory_items
         ORDER BY updated_at DESC, id DESC
         LIMIT ?
       )
       SELECT kind, content_hash, COUNT(*) as count, GROUP_CONCAT(id) as ids
       FROM recent
       WHERE content_hash IS NOT NULL AND content_hash != ''
         AND kind NOT IN ('change_intent', 'code_chunk', 'doc_chunk')
       GROUP BY kind, content_hash
       HAVING COUNT(*) > 1
       ORDER BY count DESC
       LIMIT ?`,
    )
    .all(args.scan_limit, args.limit) as Array<{ kind: string; content_hash: string; count: number; ids: string }>;

  const oversizedCheckpoints = rows
    .filter((row) => row.kind === "checkpoint")
    .map((row) => ({
      id: row.id,
      title: row.title,
      chars: (row.content?.length ?? 0) + (row.metadata_json?.length ?? 0),
      updated_at: row.updated_at,
    }))
    .filter((item) => item.chars > args.max_checkpoint_chars)
    .slice(0, args.limit);

  const projectRoot = context.getProjectRoot();
  const staleIndexSamples: Array<{ id: number; kind: string; file_path: string }> = [];
  for (const row of rows) {
    if (staleIndexSamples.length >= args.limit) break;
    if (row.kind !== "code_chunk" && row.kind !== "doc_chunk") continue;
    if (!row.file_path) continue;
    const abs = path.resolve(projectRoot, row.file_path);
    if (!fs.existsSync(abs)) staleIndexSamples.push({ id: row.id, kind: row.kind, file_path: row.file_path });
  }

  const orphanedMemoryItems = db
    .prepare(
      `WITH recent AS (
         SELECT id, kind, title, req_id, updated_at
         FROM memory_items
         ORDER BY updated_at DESC, id DESC
         LIMIT ?
       )
       SELECT m.id, m.kind, m.title, m.req_id
       FROM recent m
       LEFT JOIN requirements r ON r.id = m.req_id
       WHERE m.req_id IS NOT NULL AND r.id IS NULL
       ORDER BY m.updated_at DESC, m.id DESC
       LIMIT ?`,
    )
    .all(args.scan_limit, args.limit) as Array<{ id: number; kind: string; title: string | null; req_id: number }>;

  const outputValue = {
    ok: true,
    read_only: true,
    dry_run: true,
    advisory_only: true,
    scanned: rows.length,
    totals,
    hidden: {
      superseded,
      compacted,
    },
    duplicate_titles: duplicateTitles,
    duplicate_hashes: duplicateHashes,
    oversized_checkpoints: oversizedCheckpoints,
    stale_index_samples: staleIndexSamples,
    orphaned_memory_items: orphanedMemoryItems,
    recommendations: [
      "Use supersede_memory/upsert_decision only after verifying a stale memory is truly obsolete.",
      "Use maintain_memory({ dry_run: true }) for old-memory compaction and prune_index({ dry_run: true }) for stale indexes.",
      "Keep checkpoints compact; checkpoint diff is for diagnosis, not restore-by-default.",
    ],
  };
  logActivity("memory_quality_report", {
    scanned: rows.length,
    duplicate_titles: duplicateTitles.length,
    stale_indexes: staleIndexSamples.length,
  });
  return {
    content: [{ type: "text", text: toolCompactOrJson("memory_quality_report", outputValue, compactQualityText(outputValue), args.format) }],
  };
}

export async function handleCompareCheckpointContext(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = CompareCheckpointContextArgsSchema.parse(rawArgs);
  const db = context.getDb();
  const clauses = ["kind = 'checkpoint'"];
  const params: unknown[] = [];
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
  const checkpointSnapshot = (meta.snapshot && typeof meta.snapshot === "object" ? meta.snapshot : {}) as Record<string, unknown>;
  const currentSnapshot = getCurrentSnapshot(context, args.recent_limit, args.pending_limit);

  const beforeDecisions = previewArrayById(checkpointSnapshot.decisions);
  const afterDecisions = previewArrayById(currentSnapshot.decisions);
  const decisionDiff = diffPreviewMaps(beforeDecisions, afterDecisions);
  const beforeRecent = previewArrayById(checkpointSnapshot.recent_memory);
  const afterRecent = previewArrayById(currentSnapshot.recent_memory);
  const recentDiff = diffPreviewMaps(beforeRecent, afterRecent);
  const beforePending = pendingPaths(checkpointSnapshot.pending_changes);
  const afterPending = pendingPaths(currentSnapshot.pending_changes);
  const pendingAdded = Array.from(afterPending).filter((p) => !beforePending.has(p));
  const pendingRemoved = Array.from(beforePending).filter((p) => !afterPending.has(p));

  const checkpointActive = checkpointSnapshot.active_requirement as { id?: number; title?: string; status?: string } | null | undefined;
  const currentActive = currentSnapshot.active_requirement as { id?: number; title?: string; status?: string } | null | undefined;
  const checkpointSummary = checkpointSnapshot.project_summary as { id?: number; preview?: string; updated_at?: string } | null | undefined;
  const currentSummary = currentSnapshot.project_summary as { id?: number; preview?: string; updated_at?: string } | null | undefined;
  const diff = {
    active_requirement_changed:
      (checkpointActive?.id ?? null) !== (currentActive?.id ?? null) ||
      (checkpointActive?.title ?? "") !== (currentActive?.title ?? "") ||
      (checkpointActive?.status ?? "") !== (currentActive?.status ?? ""),
    project_summary_changed:
      (checkpointSummary?.id ?? null) !== (currentSummary?.id ?? null) ||
      (checkpointSummary?.preview ?? "") !== (currentSummary?.preview ?? "") ||
      (checkpointSummary?.updated_at ?? "") !== (currentSummary?.updated_at ?? ""),
    decisions_added: decisionDiff.added,
    decisions_removed: decisionDiff.removed,
    decisions_changed: decisionDiff.changed,
    recent_memory_added: recentDiff.added,
    recent_memory_no_longer_recent: recentDiff.removed,
    pending_added: pendingAdded,
    pending_removed: pendingRemoved,
  };

  const outputValue = {
    ok: true,
    read_only: true,
    advisory_only: true,
    checkpoint: toMemoryItemPreview(row, false, args.preview_chars, args.content_max_chars),
    checkpoint_snapshot: checkpointSnapshot,
    current_snapshot: currentSnapshot,
    diff,
  };
  logActivity("compare_checkpoint_context", {
    checkpoint_id: row.id,
    active_changed: diff.active_requirement_changed,
    decisions_added: diff.decisions_added.length,
    memory_added: diff.recent_memory_added.length,
  });
  return {
    content: [{ type: "text", text: toolCompactOrJson("compare_checkpoint_context", outputValue, compactCheckpointDiffText(outputValue), args.format) }],
  };
}
