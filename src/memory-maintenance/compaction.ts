import type { MemoryItemRow } from "../types.js";
import { logActivity } from "../activity-log.js";
import { oneLine, safeJson } from "../tool-output.js";
import {
  getDb,
  getInsertMemoryItemStatement,
  isHiddenFromDefaultRecall,
  metadataStatus,
  parseMetadataJson,
  sha256Hex,
} from "./context.js";
import type { MaintenanceCompactionResult } from "./types.js";

function selectCompactionCandidates(opts: {
  compactAfterDays: number;
  maxMemoryItems: number;
  compactNotes: boolean;
}): Array<MemoryItemRow & { req_status?: string | null }> {
  const kinds = opts.compactNotes
    ? ["requirement", "change_intent", "note"]
    : ["requirement", "change_intent"];
  const placeholders = kinds.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT
         m.id, m.kind, m.title, m.content, m.file_path, m.start_line, m.end_line,
         m.req_id, m.metadata_json, m.content_hash, m.created_at, m.updated_at,
         r.status AS req_status
       FROM memory_items m
       LEFT JOIN requirements r ON r.id = m.req_id
       WHERE m.kind IN (${placeholders})
         AND m.updated_at < datetime('now', ?)
       ORDER BY m.updated_at ASC, m.id ASC
       LIMIT ?`,
    )
    .all(...kinds, `-${opts.compactAfterDays} days`, Math.min(20_000, opts.maxMemoryItems * 5)) as Array<
    MemoryItemRow & { req_status?: string | null }
  >;

  return rows
    .filter((row) => !isHiddenFromDefaultRecall(row))
    .filter((row) => metadataStatus(row) !== "current" && metadataStatus(row) !== "active")
    .filter((row) => row.req_status !== "active")
    .filter((row) => row.kind !== "note" || opts.compactNotes)
    .slice(0, opts.maxMemoryItems);
}
function compactionLine(row: MemoryItemRow): string {
  const date = oneLine(row.updated_at || row.created_at, 19);
  const title = row.title ? ` ${oneLine(row.title, 80)}` : "";
  const file = row.file_path ? ` file=${row.file_path}${row.start_line != null ? `:${row.start_line}` : ""}` : "";
  const req = row.req_id != null ? ` req#${row.req_id}` : "";
  return `- ${date} #${row.id} ${row.kind}${req}${file}${title}: ${oneLine(row.content, 220)}`;
}
export function compactOldMemoryItems(opts: {
  dryRun: boolean;
  compactAfterDays: number;
  maxMemoryItems: number;
  compactNotes: boolean;
}): MaintenanceCompactionResult {
  const candidates = selectCompactionCandidates(opts);
  const cutoff = new Date(Date.now() - opts.compactAfterDays * 86_400_000).toISOString();
  const samples = candidates.slice(0, 20).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    file_path: row.file_path,
    updated_at: row.updated_at,
  }));

  if (opts.dryRun || !candidates.length) {
    return {
      cutoff,
      candidates: candidates.length,
      compacted: 0,
      summary_memory_id: null,
      archived: 0,
      samples,
    };
  }

  const now = new Date().toISOString();
  const lines = [
    `Auto-compacted ${candidates.length} old VectorMind memory items.`,
    `Cutoff: items updated before ${cutoff} (${opts.compactAfterDays} days).`,
    "",
    "This compact summary keeps old history searchable while detailed stale items are hidden from default recall.",
    "Durable decisions, conventions, and project summaries are never compacted by this automatic pass.",
    "",
    ...candidates.map(compactionLine),
  ];
  const content = lines.join("\n");
  const title = `Memory compaction ${now.slice(0, 10)}`;
  const metadata = {
    source: "maintenance",
    status: "current",
    compacted_item_ids: candidates.map((c) => c.id),
    compact_after_days: opts.compactAfterDays,
    compact_notes: opts.compactNotes,
    generated_at: now,
  };

  let summaryMemoryId = 0;
  let archived = 0;
  const archiveStmt = getDb().prepare(
    `INSERT OR IGNORE INTO memory_item_archive
       (memory_id, original_kind, original_title, original_content, original_file_path,
        original_start_line, original_end_line, original_req_id, original_metadata_json,
        original_content_hash, original_created_at, original_updated_at, archive_reason, compacted_into_id)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateMemoryStmt = getDb().prepare(
    `UPDATE memory_items
     SET content = ?, metadata_json = ?, content_hash = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  );

  const tx = getDb().transaction(() => {
    const info = getInsertMemoryItemStatement().run(
      "memory_compaction",
      title,
      content,
      null,
      null,
      null,
      null,
      safeJson(metadata),
      sha256Hex(content),
    );
    summaryMemoryId = Number(info.lastInsertRowid);

    for (const row of candidates) {
      const archiveInfo = archiveStmt.run(
        row.id,
        row.kind,
        row.title,
        row.content,
        row.file_path,
        row.start_line,
        row.end_line,
        row.req_id,
        row.metadata_json,
        row.content_hash,
        row.created_at,
        row.updated_at,
        "auto_compaction",
        summaryMemoryId,
      );
      if (archiveInfo.changes > 0) archived += 1;

      const patchedMeta = {
        ...parseMetadataJson(row.metadata_json),
        status: "compacted",
        compacted: true,
        compacted_at: now,
        compacted_into_memory_id: summaryMemoryId,
      };
      const stub = [
        `[compacted into memory item #${summaryMemoryId}]`,
        `Original ${row.kind} #${row.id} was older than ${opts.compactAfterDays} days and is excluded from default recall.`,
        `Summary: ${oneLine(row.title || row.content, 260)}`,
      ].join("\n");
      updateMemoryStmt.run(stub, safeJson(patchedMeta), sha256Hex(stub), row.id);
    }
  });

  try {
    tx();
  } catch (err) {
    console.error("[vectormind] compact old memory failed:", err);
    summaryMemoryId = 0;
  }

  if (summaryMemoryId) {
    logActivity("memory_maintenance", {
      reason: "compact_old_memories",
      compacted: candidates.length,
      summary_memory_id: summaryMemoryId,
      archived,
    });
  }

  return {
    cutoff,
    candidates: candidates.length,
    compacted: summaryMemoryId ? candidates.length : 0,
    summary_memory_id: summaryMemoryId || null,
    archived,
    samples,
  };
}
