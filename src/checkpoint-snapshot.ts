import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type { ChangeLogRow, MemoryItemRow, PendingChangeRow } from "./types.js";
import { isHiddenFromDefaultRecall, parseMetadataJson, toChangeLogPreview, toMemoryItemPreview } from "./memory-recall.js";
import { oneLine, sliceTextForOutput } from "./tool-output.js";

export const CHECKPOINT_SNAPSHOT_VERSION = 2;
export const CHECKPOINT_SNAPSHOT_MAX_CHARS = 24_000;
export const CHECKPOINT_METADATA_MAX_CHARS = 1_200;
export const CHECKPOINT_DECISION_LIMIT = 10;
export const CHECKPOINT_RECENT_CHANGE_LIMIT = 10;
export const CHECKPOINT_CHANGE_FILES_LIMIT = 20;
export const CHECKPOINT_MEMORY_KINDS = [
  "requirement",
  "change_intent",
  "note",
  "decision",
  "memory_compaction",
  "project_summary",
  "convention",
  "fix_pattern",
] as const;
export const LEGACY_CHECKPOINT_MEMORY_KINDS = [
  "requirement",
  "change_intent",
  "note",
  "decision",
  "memory_compaction",
  "project_summary",
  "convention",
] as const;

type JsonRecord = Record<string, unknown>;
type CollectionKey = "decisions" | "recent_memory" | "recent_changes" | "pending_changes";

export type CheckpointCollectionState = {
  total: number;
  returned: number;
  truncated: boolean;
  window_truncated?: boolean;
  total_is_lower_bound?: boolean;
};

export type CheckpointSnapshotBasis = {
  snapshot_version: number;
  recent_limit: number;
  decision_limit: number;
  recent_change_limit: number;
  pending_limit: number;
  included_kinds: string[];
};

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

function boundedScalar(value: unknown, maxChars = 240): unknown {
  if (typeof value === "string") return oneLine(value, maxChars);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

function summarizeMetadataValue(value: unknown, depth = 0): unknown {
  const scalar = boundedScalar(value);
  if (scalar !== undefined) return scalar;
  if (Array.isArray(value)) {
    const sample = value.slice(0, 8).map((item) => {
      const itemScalar = boundedScalar(item, 160);
      if (itemScalar !== undefined) return itemScalar;
      return isRecord(item) ? { keys: Object.keys(item).slice(0, 8) } : typeof item;
    });
    return { count: value.length, sample, truncated: value.length > sample.length || undefined };
  }
  if (!isRecord(value)) return String(value);
  const keys = Object.keys(value);
  if (depth >= 1) return { keys: keys.slice(0, 12), key_count: keys.length };
  const result: JsonRecord = {};
  for (const [key, child] of Object.entries(value).slice(0, 16)) {
    result[key] = summarizeMetadataValue(child, depth + 1);
  }
  if (keys.length > 16) result._truncated_keys = keys.length - 16;
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function boundedMetadataJson(
  raw: string | null | undefined,
  options: { maxChars?: number; omitKeys?: readonly string[] } = {},
): string | null {
  if (!raw) return null;
  const maxChars = Math.max(256, options.maxChars ?? CHECKPOINT_METADATA_MAX_CHARS);
  let parsed: JsonRecord | null = null;
  try {
    const value = JSON.parse(raw);
    parsed = isRecord(value) ? value : null;
  } catch {
    parsed = null;
  }

  const omitted = new Set(options.omitKeys ?? []);
  if (parsed && omitted.size === 0 && raw.length <= maxChars) return raw;

  const hash = sha256(raw);
  const summary: JsonRecord = {};
  if (parsed) {
    for (const [key, value] of Object.entries(parsed)) {
      if (omitted.has(key)) {
        summary[`${key}_stored`] = value !== undefined;
        if (key === "snapshot" && isRecord(value)) {
          summary.snapshot_version = finiteInteger(value.snapshot_version, 1);
          if (typeof value.created_at === "string") summary.snapshot_created_at = oneLine(value.created_at, 100);
        }
        continue;
      }
      summary[key] = summarizeMetadataValue(value);
    }
  } else {
    summary._unparsed_preview = oneLine(raw, 320);
  }
  summary._metadata_hash = hash;
  summary._metadata_original_chars = raw.length;
  const serialized = JSON.stringify(summary);
  if (serialized.length <= maxChars) return serialized;

  const fallback: JsonRecord = {
    _metadata_truncated: true,
    _metadata_original_chars: raw.length,
    _metadata_hash: hash,
  };
  if (parsed) {
    for (const [key, value] of Object.entries(parsed)) {
      if (omitted.has(key)) {
        fallback[`${key}_stored`] = value !== undefined;
        continue;
      }
      const scalar = boundedScalar(value, 160);
      const candidateValue = scalar !== undefined
        ? scalar
        : Array.isArray(value)
          ? { count: value.length }
          : isRecord(value)
            ? { keys: Object.keys(value).slice(0, 8), key_count: Object.keys(value).length }
            : undefined;
      if (candidateValue === undefined) continue;
      const candidate = { ...fallback, [key]: candidateValue };
      if (JSON.stringify(candidate).length <= maxChars) fallback[key] = candidateValue;
    }
  }
  return JSON.stringify(fallback);
}

function normalizeMemoryPreview(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const content = typeof value.content === "string" ? sliceTextForOutput(value.content, 1_200) : null;
  return {
    id: finiteInteger(value.id, 0),
    kind: typeof value.kind === "string" ? oneLine(value.kind, 80) : "memory",
    title: typeof value.title === "string" ? oneLine(value.title, 500) : null,
    file_path: typeof value.file_path === "string" ? oneLine(value.file_path, 1_000) : null,
    start_line: typeof value.start_line === "number" ? value.start_line : null,
    end_line: typeof value.end_line === "number" ? value.end_line : null,
    req_id: typeof value.req_id === "number" ? value.req_id : null,
    preview: typeof value.preview === "string" ? oneLine(value.preview, 1_200) : "",
    content: content?.text,
    content_truncated: content ? content.truncated || value.content_truncated === true : undefined,
    metadata_json: boundedMetadataJson(
      typeof value.metadata_json === "string" ? value.metadata_json : null,
      { omitKeys: ["snapshot"] },
    ),
    updated_at: typeof value.updated_at === "string" ? oneLine(value.updated_at, 100) : "",
  };
}

export function toCheckpointSnapshotMemoryPreview(row: MemoryItemRow): JsonRecord {
  return normalizeMemoryPreview(toMemoryItemPreview(row, false, 180, 1_200)) ?? {};
}

export function toCheckpointRecordPreview(
  row: MemoryItemRow,
  includeContent: boolean,
  previewChars: number,
  contentMaxChars: number,
): ReturnType<typeof toMemoryItemPreview> {
  const boundedContentMaxChars = contentMaxChars <= 0 ? 8_000 : Math.min(contentMaxChars, 8_000);
  const preview = toMemoryItemPreview(row, includeContent, previewChars, boundedContentMaxChars);
  return {
    ...preview,
    metadata_json: boundedMetadataJson(row.metadata_json, { omitKeys: ["snapshot"] }),
  };
}

function normalizeRequirementPreview(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const contextData = typeof value.context_data === "string" ? sliceTextForOutput(value.context_data, 1_200) : null;
  return {
    id: finiteInteger(value.id, 0),
    title: typeof value.title === "string" ? oneLine(value.title, 500) : "",
    status: typeof value.status === "string" ? oneLine(value.status, 80) : "",
    created_at: typeof value.created_at === "string" ? oneLine(value.created_at, 100) : "",
    memory_item_id: typeof value.memory_item_id === "number" ? value.memory_item_id : null,
    context_preview: typeof value.context_preview === "string" ? oneLine(value.context_preview, 1_200) : null,
    context_data: contextData?.text,
    context_truncated: contextData ? contextData.truncated || value.context_truncated === true : undefined,
  };
}

function normalizeChangePreview(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const rawFiles = Array.isArray(value.files)
    ? value.files.filter((item): item is string => typeof item === "string")
    : [];
  const files = rawFiles.slice(0, CHECKPOINT_CHANGE_FILES_LIMIT).map((item) => oneLine(item, 1_000));
  const fileCount = Math.max(finiteInteger(value.file_count, rawFiles.length), rawFiles.length);
  return {
    id: finiteInteger(value.id, 0),
    file_path: typeof value.file_path === "string" ? oneLine(value.file_path, 1_000) : null,
    files: files.length ? files : undefined,
    file_count: fileCount || undefined,
    files_returned: files.length,
    files_truncated: fileCount > files.length || undefined,
    timestamp: typeof value.timestamp === "string" ? oneLine(value.timestamp, 100) : "",
    intent_preview: typeof value.intent_preview === "string" ? oneLine(value.intent_preview, 1_200) : "",
  };
}

export function toCheckpointChangePreview(change: ChangeLogRow): JsonRecord {
  return normalizeChangePreview(toChangeLogPreview(change, false, 180, 1_200)) ?? {};
}

function normalizePendingChange(value: unknown): JsonRecord | null {
  if (!isRecord(value) || typeof value.file_path !== "string") return null;
  return {
    file_path: oneLine(value.file_path, 1_000),
    last_event: typeof value.last_event === "string" ? oneLine(value.last_event, 80) : "change",
    updated_at: typeof value.updated_at === "string" ? oneLine(value.updated_at, 100) : "",
    source: typeof value.source === "string" ? oneLine(value.source, 40) : undefined,
    git_status: typeof value.git_status === "string" ? oneLine(value.git_status, 40) : undefined,
    file_state_hash: typeof value.file_state_hash === "string" ? oneLine(value.file_state_hash, 160) : undefined,
  };
}

export function checkpointPendingRows(rows: PendingChangeRow[]): JsonRecord[] {
  return rows.map(normalizePendingChange).filter((item): item is JsonRecord => item !== null);
}

export function checkpointSnapshotBasis(recentLimit: number, pendingLimit: number): CheckpointSnapshotBasis {
  return {
    snapshot_version: CHECKPOINT_SNAPSHOT_VERSION,
    recent_limit: Math.max(0, Math.trunc(recentLimit)),
    decision_limit: CHECKPOINT_DECISION_LIMIT,
    recent_change_limit: CHECKPOINT_RECENT_CHANGE_LIMIT,
    pending_limit: Math.max(0, Math.trunc(pendingLimit)),
    included_kinds: [...CHECKPOINT_MEMORY_KINDS],
  };
}

export function getVisibleCheckpointMemory(
  db: Database.Database,
  limit: number,
  excludeIds: readonly number[] = [],
  includedKinds: readonly string[] = CHECKPOINT_MEMORY_KINDS,
): { rows: MemoryItemRow[]; truncated: boolean } {
  if (limit <= 0) return { rows: [], truncated: false };
  const pageSize = 200;
  const scanCap = 10_000;
  const target = limit + 1;
  const excluded = new Set(excludeIds);
  const kinds = includedKinds.length ? includedKinds : CHECKPOINT_MEMORY_KINDS;
  const placeholders = kinds.map(() => "?").join(", ");
  const stmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind IN (${placeholders})
     ORDER BY updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  );
  const visible: MemoryItemRow[] = [];
  let offset = 0;
  while (visible.length < target && offset < scanCap) {
    const rows = stmt.all(...kinds, pageSize, offset) as MemoryItemRow[];
    if (!rows.length) break;
    for (const row of rows) {
      if (!excluded.has(row.id) && !isHiddenFromDefaultRecall(row)) visible.push(row);
      if (visible.length >= target) break;
    }
    offset += rows.length;
    if (rows.length < pageSize) break;
  }
  return { rows: visible.slice(0, limit), truncated: visible.length > limit || offset >= scanCap };
}

export function getVisibleCheckpointDecisions(
  db: Database.Database,
  limit: number,
): { rows: MemoryItemRow[]; truncated: boolean } {
  if (limit <= 0) return { rows: [], truncated: false };
  const pageSize = 200;
  const scanCap = 10_000;
  const target = limit + 1;
  const stmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'decision'
     ORDER BY updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  );
  const visible: MemoryItemRow[] = [];
  let offset = 0;
  while (visible.length < target && offset < scanCap) {
    const rows = stmt.all(pageSize, offset) as MemoryItemRow[];
    if (!rows.length) break;
    for (const row of rows) {
      if (!isHiddenFromDefaultRecall(row)) visible.push(row);
      if (visible.length >= target) break;
    }
    offset += rows.length;
    if (rows.length < pageSize) break;
  }
  return { rows: visible.slice(0, limit), truncated: visible.length > limit || offset >= scanCap };
}

export function readCheckpointBasis(value: unknown, fallback: CheckpointSnapshotBasis): CheckpointSnapshotBasis {
  if (!isRecord(value)) return fallback;
  const kinds = Array.isArray(value.included_kinds)
    ? value.included_kinds.filter((item): item is string => typeof item === "string").slice(0, 30)
    : fallback.included_kinds;
  return {
    snapshot_version: finiteInteger(value.snapshot_version, fallback.snapshot_version),
    recent_limit: finiteInteger(value.recent_limit, fallback.recent_limit),
    decision_limit: finiteInteger(value.decision_limit, fallback.decision_limit),
    recent_change_limit: finiteInteger(value.recent_change_limit, fallback.recent_change_limit),
    pending_limit: finiteInteger(value.pending_limit, fallback.pending_limit),
    included_kinds: kinds.length ? kinds : fallback.included_kinds,
  };
}

function collectionState(rawCollections: unknown, key: CollectionKey, itemCount: number): CheckpointCollectionState {
  const raw = isRecord(rawCollections) && isRecord(rawCollections[key]) ? rawCollections[key] : {};
  const total = Math.max(itemCount, finiteInteger(raw.total, itemCount));
  return {
    total,
    returned: 0,
    truncated: raw.truncated === true,
    window_truncated: raw.window_truncated === true || undefined,
    total_is_lower_bound: raw.total_is_lower_bound === true || undefined,
  };
}

function normalizeProjectSummary(value: unknown): JsonRecord | null {
  return normalizeMemoryPreview(value);
}

export function isCheckpointSnapshot(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  return value.advisory_only === true
    || typeof value.created_at === "string"
    || Array.isArray(value.recent_memory)
    || Array.isArray(value.decisions);
}

export function normalizeCheckpointSnapshot(
  raw: JsonRecord,
  options: { maxChars?: number; fallbackBasis?: CheckpointSnapshotBasis } = {},
): JsonRecord {
  const maxChars = Math.max(4_000, options.maxChars ?? CHECKPOINT_SNAPSHOT_MAX_CHARS);
  const fallbackBasis = options.fallbackBasis ?? checkpointSnapshotBasis(10, 10);
  const basis = readCheckpointBasis(raw.basis, fallbackBasis);
  const decisions = (Array.isArray(raw.decisions) ? raw.decisions : [])
    .map(normalizeMemoryPreview)
    .filter((item): item is JsonRecord => item !== null);
  const recentMemory = (Array.isArray(raw.recent_memory) ? raw.recent_memory : [])
    .map(normalizeMemoryPreview)
    .filter((item): item is JsonRecord => item !== null && item.kind !== "checkpoint");
  const recentChanges = (Array.isArray(raw.recent_changes) ? raw.recent_changes : [])
    .map(normalizeChangePreview)
    .filter((item): item is JsonRecord => item !== null);
  const pendingChanges = (Array.isArray(raw.pending_changes) ? raw.pending_changes : [])
    .map(normalizePendingChange)
    .filter((item): item is JsonRecord => item !== null);
  const collections: Record<CollectionKey, CheckpointCollectionState> = {
    decisions: collectionState(raw.collections, "decisions", decisions.length),
    recent_memory: collectionState(raw.collections, "recent_memory", recentMemory.length),
    recent_changes: collectionState(raw.collections, "recent_changes", recentChanges.length),
    pending_changes: collectionState(raw.collections, "pending_changes", pendingChanges.length),
  };

  const rawSummary = typeof raw.summary === "string" ? raw.summary : null;
  const summary = rawSummary !== null ? sliceTextForOutput(rawSummary, 2_000) : null;
  const normalized: JsonRecord = {
    snapshot_version: CHECKPOINT_SNAPSHOT_VERSION,
    source_snapshot_version: finiteInteger(raw.snapshot_version, 1),
    created_at: typeof raw.created_at === "string" ? oneLine(raw.created_at, 100) : "",
    advisory_only: raw.advisory_only !== false,
    note: typeof raw.note === "string" ? oneLine(raw.note, 500) : "",
    summary: summary?.text,
    summary_truncated: summary ? summary.truncated || raw.summary_truncated === true : undefined,
    summary_total_chars: summary ? finiteInteger(raw.summary_total_chars, rawSummary?.length ?? 0) : undefined,
    basis,
    active_requirement: normalizeRequirementPreview(raw.active_requirement),
    project_summary: normalizeProjectSummary(raw.project_summary),
    collections,
    decisions: [] as JsonRecord[],
    recent_memory: [] as JsonRecord[],
    recent_changes: [] as JsonRecord[],
    pending_changes: [] as JsonRecord[],
  };

  const groups: Array<[CollectionKey, JsonRecord[]]> = [
    ["decisions", decisions],
    ["recent_memory", recentMemory],
    ["recent_changes", recentChanges],
    ["pending_changes", pendingChanges],
  ];
  for (const [key, items] of groups) {
    const target = normalized[key] as JsonRecord[];
    for (const item of items) {
      target.push(item);
      collections[key].returned = target.length;
      if (JSON.stringify(normalized).length > maxChars) {
        target.pop();
        collections[key].returned = target.length;
        break;
      }
    }
    collections[key].truncated = collections[key].truncated
      || collections[key].returned < collections[key].total
      || collections[key].returned < items.length;
  }

  normalized.snapshot_chars = JSON.stringify(normalized).length;
  normalized.snapshot_truncated = Object.values(collections).some((state) => state.truncated) || undefined;
  return normalized;
}

export function checkpointSnapshotFromMetadata(
  metadataJson: string | null | undefined,
  fallbackBasis: CheckpointSnapshotBasis,
): { valid: boolean; snapshot: JsonRecord; metadata: JsonRecord } {
  const metadata = parseMetadataJson(metadataJson);
  const rawSnapshot = metadata.snapshot;
  if (!isCheckpointSnapshot(rawSnapshot)) {
    return {
      valid: false,
      snapshot: normalizeCheckpointSnapshot({}, { fallbackBasis }),
      metadata,
    };
  }
  return {
    valid: true,
    snapshot: normalizeCheckpointSnapshot(rawSnapshot, { fallbackBasis }),
    metadata,
  };
}
