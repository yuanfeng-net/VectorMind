import Database from "better-sqlite3";

import type { MemoryItemRow } from "./types.js";
import { parseMetadataJson } from "./memory-recall.js";
import { safeJson } from "./tool-output.js";

type MemoryMutationContext = {
  getDb: () => Database.Database | undefined;
  getMemoryItemByIdStatement: () => Database.Statement;
  getCompleteRequirementMemoryItemByReqIdStatement: () => Database.Statement;
  getCompleteAllActiveRequirementMemoryItemsStatement: () => Database.Statement;
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

function getCompleteAllActiveRequirementMemoryItemsStatement(): Database.Statement {
  return requireMemoryMutationContext().getCompleteAllActiveRequirementMemoryItemsStatement();
}
export function completeRequirementMemoryItemsByReqId(reqId: number): void {
  try {
    getCompleteRequirementMemoryItemByReqIdStatement().run(safeJson({ status: "completed" }), reqId);
  } catch (err) {
    console.error("[vectormind] failed to complete requirement memory item:", err);
  }
}

export function completeAllActiveRequirementMemoryItems(): void {
  try {
    getCompleteAllActiveRequirementMemoryItemsStatement().run(
      safeJson({ status: "completed" }),
      safeJson({ status: "active" }),
    );
  } catch (err) {
    console.error("[vectormind] failed to complete all active requirement memory items:", err);
  }
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
