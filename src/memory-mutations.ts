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

export function completeRequirementMemoryItemsByReqId(reqId: number): boolean {
  const transaction = getDb().transaction(() => {
    const updated = getDb().prepare(
      `UPDATE requirements
          SET status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'active'`,
    ).run(reqId);
    if (updated.changes === 0) return false;
    deferIncompleteLargeFileSplitPlansByReqId(reqId);
    getCompleteRequirementMemoryItemByReqIdStatement().run("completed", reqId);
    return true;
  });
  return transaction();
}

export function completeAllActiveRequirementMemoryItems(): number[] {
  const transaction = getDb().transaction(() => {
    const activeRows = getDb().prepare(
      `SELECT id FROM requirements WHERE status = 'active' ORDER BY created_at DESC, id DESC`,
    ).all() as Array<{ id: number }>;
    const completed: number[] = [];
    for (const row of activeRows) {
      const updated = getDb().prepare(
        `UPDATE requirements
            SET status = 'completed', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'active'`,
      ).run(row.id);
      if (updated.changes !== 1) continue;
      deferIncompleteLargeFileSplitPlansByReqId(row.id);
      getCompleteRequirementMemoryItemByReqIdStatement().run("completed", row.id);
      completed.push(row.id);
    }
    return completed;
  });
  return transaction.immediate();
}

function patchMemoryItemMetadata(id: number, patch: Record<string, unknown>): boolean {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (!entries.length) return false;
  const sqlArgs = entries.flatMap(([key, value]) => [`$.${key}`, safeJson(value)]);
  const info = getDb().prepare(
    `UPDATE memory_items
        SET metadata_json = json_set(
              CASE
                WHEN json_valid(COALESCE(metadata_json, '{}')) THEN COALESCE(metadata_json, '{}')
                ELSE '{}'
              END,
              ${entries.map(() => "?, json(?)").join(", ")}
            ),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).run(...sqlArgs, id);
  return info.changes > 0;
}

export function supersedeMemoryItemIds(
  ids: number[],
  replacement: { req_id?: number; memory_id?: number; decision_id?: number; reason: string },
): number[] {
  const updated: number[] = [];
  const uniqueIds = Array.from(new Set(ids)).filter((n) => Number.isFinite(n) && n > 0);
  const supersededAt = new Date().toISOString();
  getDb().transaction(() => {
    for (const id of uniqueIds) {
      const changed = patchMemoryItemMetadata(id, {
        status: "superseded",
        superseded: true,
        superseded_at: supersededAt,
        superseded_reason: replacement.reason,
        superseded_by_req_id: replacement.req_id ?? null,
        superseded_by_memory_id: replacement.memory_id ?? null,
        superseded_by_decision_id: replacement.decision_id ?? null,
      });
      if (changed) updated.push(id);
    }
  })();
  return updated;
}

export function supersedeRequirementIds(
  reqIds: number[],
  replacement: { req_id?: number; memory_id?: number; decision_id?: number; reason: string },
): number[] {
  const updatedReqs: number[] = [];
  const uniqueReqIds = Array.from(new Set(reqIds)).filter((n) => Number.isFinite(n) && n > 0);
  getDb().transaction(() => {
    for (const reqId of uniqueReqIds) {
      const info = getDb().prepare(
        `UPDATE requirements SET status = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(reqId);
      if (info.changes > 0) updatedReqs.push(reqId);
      const rows = getDb()
        .prepare(`SELECT id FROM memory_items WHERE req_id = ? OR (kind = 'requirement' AND req_id = ?)`)
        .all(reqId, reqId) as Array<{ id: number }>;
      supersedeMemoryItemIds(
        rows.map((r) => r.id),
        replacement,
      );
    }
  })();
  return updatedReqs;
}
