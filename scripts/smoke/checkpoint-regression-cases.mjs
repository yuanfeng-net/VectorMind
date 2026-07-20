import assert from "node:assert/strict";

import Database from "better-sqlite3";

import {
  boundedMetadataJson,
  checkpointSnapshotBasis,
  checkpointSnapshotFromMetadata,
  getVisibleCheckpointDecisions,
  normalizeCheckpointSnapshot,
  toCheckpointRecordPreview,
} from "../../dist/checkpoint-snapshot.js";

const hugeText = "verification:" + "x".repeat(100_000);
const nestedMetadata = JSON.stringify({
  status: "current",
  type: "checkpoint",
  advisory_only: true,
  verification: hugeText,
  snapshot: {
    snapshot_version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    recent_memory: [{ metadata_json: hugeText }],
  },
});

const boundedMetadata = boundedMetadataJson(nestedMetadata, { omitKeys: ["snapshot"] });
assert.ok(boundedMetadata);
assert.ok(boundedMetadata.length <= 1_200);
const parsedMetadata = JSON.parse(boundedMetadata);
assert.equal(parsedMetadata.snapshot_stored, true);
assert.equal(Object.prototype.hasOwnProperty.call(parsedMetadata, "snapshot"), false);

const memoryRow = {
  id: 42,
  kind: "checkpoint",
  title: "nested checkpoint",
  content: hugeText,
  file_path: null,
  start_line: null,
  end_line: null,
  req_id: null,
  metadata_json: nestedMetadata,
  content_hash: null,
  created_at: "2026-01-01 00:00:00",
  updated_at: "2026-01-01 00:00:00",
};
const recordPreview = toCheckpointRecordPreview(memoryRow, true, 10_000, 0);
assert.equal(recordPreview.content_truncated, true);
assert.ok((recordPreview.content?.length ?? 0) <= 8_000);
assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(recordPreview.metadata_json ?? "{}"), "snapshot"), false);

const pendingChanges = Array.from({ length: 2_000 }, (_, index) => ({
  file_path: `src/pending/${index}/${"p".repeat(240)}.ts`,
  last_event: "change",
  updated_at: "2026-01-01T00:00:00.000Z",
  source: "watcher",
}));
const changeFiles = Array.from({ length: 100 }, (_, index) => `src/change/${index}/${"f".repeat(120)}.ts`);
const basis = checkpointSnapshotBasis(50, 2_000);
const snapshot = normalizeCheckpointSnapshot({
  snapshot_version: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  advisory_only: true,
  note: "legacy checkpoint",
  summary: "CHECKPOINT_BUDGET_TOKEN",
  basis,
  project_summary: {
    id: 1,
    kind: "project_summary",
    title: "summary",
    preview: "CHECKPOINT_BUDGET_TOKEN",
    metadata_json: nestedMetadata,
    updated_at: "2026-01-01 00:00:00",
  },
  recent_memory: [
    {
      id: 2,
      kind: "checkpoint",
      title: "old checkpoint",
      preview: "must not recurse",
      metadata_json: nestedMetadata,
      updated_at: "2026-01-01 00:00:00",
    },
    {
      id: 3,
      kind: "note",
      title: "large metadata note",
      preview: "bounded note preview",
      metadata_json: nestedMetadata,
      updated_at: "2026-01-01 00:00:00",
    },
  ],
  recent_changes: [{
    id: 1,
    file_path: changeFiles[0],
    files: changeFiles,
    file_count: changeFiles.length,
    timestamp: "2026-01-01 00:00:00",
    intent_preview: "large file set",
  }],
  pending_changes: pendingChanges,
  collections: {
    decisions: { total: 0, returned: 0, truncated: false },
    recent_memory: { total: 2, returned: 2, truncated: false },
    recent_changes: { total: 1, returned: 1, truncated: false },
    pending_changes: { total: pendingChanges.length, returned: pendingChanges.length, truncated: false },
  },
}, { fallbackBasis: basis });

const snapshotText = JSON.stringify(snapshot);
assert.ok(snapshotText.length <= 24_500);
assert.ok(snapshotText.includes("CHECKPOINT_BUDGET_TOKEN"));
assert.equal(snapshot.recent_memory.some((item) => item.kind === "checkpoint"), false);
assert.equal(snapshot.collections.pending_changes.truncated, true);
assert.ok(snapshot.recent_changes[0].files.length <= 20);
for (const item of [snapshot.project_summary, ...snapshot.recent_memory].filter(Boolean)) {
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(item.metadata_json ?? "{}"), "snapshot"), false);
}

const invalid = checkpointSnapshotFromMetadata(JSON.stringify({ status: "current" }), basis);
assert.equal(invalid.valid, false);

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE memory_items (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    file_path TEXT,
    start_line INTEGER,
    end_line INTEGER,
    req_id INTEGER,
    metadata_json TEXT,
    content_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
const insertDecision = db.prepare(`
  INSERT INTO memory_items (
    kind, title, content, file_path, start_line, end_line, req_id,
    metadata_json, content_hash, created_at, updated_at
  ) VALUES ('decision', ?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)
`);
insertDecision.run("visible-older", "visible", JSON.stringify({ status: "current" }), "2000-01-01", "2000-01-01");
insertDecision.run("visible-newer", "visible", JSON.stringify({ status: "current" }), "2001-01-01", "2001-01-01");
for (let index = 0; index < 20; index += 1) {
  const timestamp = `2026-01-${String(index + 1).padStart(2, "0")}`;
  insertDecision.run(`hidden-${index}`, "hidden", JSON.stringify({ status: "superseded" }), timestamp, timestamp);
}
const visibleDecisions = getVisibleCheckpointDecisions(db, 1);
assert.equal(visibleDecisions.rows[0]?.title, "visible-newer");
assert.equal(visibleDecisions.truncated, true);
db.close();

console.log("checkpoint regression cases: ok");
