import Database from "better-sqlite3";
import crypto from "node:crypto";

import type { MemoryItemRow } from "./types.js";
import { parseMetadataJson } from "./memory-recall.js";
import { safeJson } from "./tool-output.js";

type MemoryMutationContext = {
  getDb: () => Database.Database | undefined;
  getMemoryItemByIdStatement: () => Database.Statement;
  getCompleteRequirementMemoryItemByReqIdStatement: () => Database.Statement;
};

let memoryMutationContext: MemoryMutationContext | null = null;

export function configureMemoryMutations(context: MemoryMutationContext): void {
  memoryMutationContext = context;
}

function requireMemoryMutationContext(): MemoryMutationContext {
  if (!memoryMutationContext) throw new Error("[VectorMind] memory mutation context is not configured");
  return memoryMutationContext;
}

function getDb(): Database.Database {
  const db = requireMemoryMutationContext().getDb();
  if (!db) throw new Error("[VectorMind] database is not initialized");
  return db;
}

function getMemoryItemByIdStatement(): Database.Statement {
  return requireMemoryMutationContext().getMemoryItemByIdStatement();
}

function getCompleteRequirementMemoryItemByReqIdStatement(): Database.Statement {
  return requireMemoryMutationContext().getCompleteRequirementMemoryItemByReqIdStatement();
}

const INCOMPLETE_SPLIT_PLAN_STATUSES = new Set(["planned", "in_progress", "partial", "needs_refinement"]);

export function deferIncompleteLargeFileSplitPlansByReqId(
  reqId: number,
  reason = "requirement_completed_before_split_resolved",
): number[] {
  const rows = getDb().prepare(
    `SELECT id, content, metadata_json
       FROM memory_items
      WHERE kind = 'large_file_split_plan' AND req_id = ?`,
  ).all(reqId) as Array<{ id: number; content: string; metadata_json: string | null }>;
  const updated: number[] = [];
  const now = new Date().toISOString();
  const updateStmt = getDb().prepare(
    `UPDATE memory_items
        SET content = ?, metadata_json = ?, content_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND kind = 'large_file_split_plan'`,
  );
  for (const row of rows) {
    const metadata = parseMetadataJson(row.metadata_json);
    if (!INCOMPLETE_SPLIT_PLAN_STATUSES.has(String(metadata.status))) continue;
    let content = row.content;
    try {
      const parsed = JSON.parse(row.content) as Record<string, unknown>;
      content = safeJson({
        ...parsed,
        status: "deferred",
        deferred: true,
        deferred_at: now,
        deferred_reason: reason,
      }) ?? row.content;
    } catch {
      // Legacy plan content remains readable; metadata carries the lifecycle state.
    }
    updateStmt.run(
      content,
      safeJson({
        ...metadata,
        status: "deferred",
        deferred: true,
        deferred_at: now,
        deferred_reason: reason,
      }),
      crypto.createHash("sha256").update(content).digest("hex"),
      row.id,
    );
    updated.push(row.id);
  }
  return updated;
}

export function completeRequirementMemoryItemsByReqId(reqId: number): void {
  const transaction = getDb().transaction(() => {
    getDb().prepare(`UPDATE requirements SET status = 'completed' WHERE id = ?`).run(reqId);
    deferIncompleteLargeFileSplitPlansByReqId(reqId);
    getCompleteRequirementMemoryItemByReqIdStatement().run("completed", reqId);
  });
  transaction();
}

export function completeAllActiveRequirementMemoryItems(): number[] {
  const activeRows = getDb().prepare(
    `SELECT id FROM requirements WHERE status = 'active' ORDER BY created_at DESC, id DESC`,
  ).all() as Array<{ id: number }>;
  const transaction = getDb().transaction(() => {
    for (const row of activeRows) {
      getDb().prepare(`UPDATE requirements SET status = 'completed' WHERE id = ?`).run(row.id);
      deferIncompleteLargeFileSplitPlansByReqId(row.id);
      getCompleteRequirementMemoryItemByReqIdStatement().run("completed", row.id);
    }
  });
  transaction();
  return activeRows.map((row) => row.id);
}

function patchMemoryItemMetadata(id: number, patch: Record<string, unknown>): void {
  const row = getMemoryItemByIdStatement().get(id) as MemoryItemRow | undefined;
  if (!row) return;
  const meta = { ...parseMetadataJson(row.metadata_json), ...patch };
  getDb().prepare(`UPDATE memory_items SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    safeJson(meta),
    id,
  );
}

export function supersedeMemoryItemIds(
  ids: number[],
  replacement: { req_id?: number; memory_id?: number; decision_id?: number; reason: string },
): number[] {
  const updated: number[] = [];
  for (const id of Array.from(new Set(ids)).filter((n) => Number.isFinite(n) && n > 0)) {
    const row = getMemoryItemByIdStatement().get(id) as MemoryItemRow | undefined;
    if (!row) continue;
    patchMemoryItemMetadata(id, {
      ...parseMetadataJson(row.metadata_json),
      status: "superseded",
      superseded: true,
      superseded_at: new Date().toISOString(),
      superseded_reason: replacement.reason,
      superseded_by_req_id: replacement.req_id ?? null,
      superseded_by_memory_id: replacement.memory_id ?? null,
      superseded_by_decision_id: replacement.decision_id ?? null,
    });
    updated.push(id);
  }
  return updated;
}

export function supersedeRequirementIds(
  reqIds: number[],
  replacement: { req_id?: number; memory_id?: number; decision_id?: number; reason: string },
): number[] {
  const updatedReqs: number[] = [];
  for (const reqId of Array.from(new Set(reqIds)).filter((n) => Number.isFinite(n) && n > 0)) {
    const info = getDb().prepare(`UPDATE requirements SET status = 'superseded' WHERE id = ?`).run(reqId);
    if (info.changes > 0) updatedReqs.push(reqId);
    const rows = getDb()
      .prepare(`SELECT id FROM memory_items WHERE req_id = ? OR (kind = 'requirement' AND req_id = ?)`)
      .all(reqId, reqId) as Array<{ id: number }>;
    supersedeMemoryItemIds(
      rows.map((r) => r.id),
      replacement,
    );
  }
  return updatedReqs;
}
