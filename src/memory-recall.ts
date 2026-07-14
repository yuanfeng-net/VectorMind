import Database from "better-sqlite3";

import { BUILTIN_CONVENTIONS } from "./builtin-conventions.js";
import { MAX_DECISIONS_LIMIT } from "./tool-schemas.js";
import type { ChangeLogRow, MemoryItemRow, RequirementRow } from "./types.js";
import { shouldIgnoreDbFilePath } from "./path-rules.js";
import { safeJson, sliceTextForOutput } from "./tool-output.js";

export const MEMORY_ITEMS_FTS_TABLE = "memory_items_fts";

type MemoryRecallContext = {
  getDb: () => Database.Database | undefined;
  getListConventionsStatement: () => Database.Statement;
  getListCurrentDecisionsStatement: () => Database.Statement;
  getListActiveRequirementsStatement: () => Database.Statement;
  getRequirementMemoryItemIdStatement: () => Database.Statement;
  getMemoryItemByIdStatement: () => Database.Statement;
  isFtsAvailable: () => boolean;
  sha256Hex: (input: string) => string;
};

let memoryRecallContext: MemoryRecallContext | null = null;

export function configureMemoryRecall(context: MemoryRecallContext): void {
  memoryRecallContext = context;
}

function requireMemoryRecallContext(): MemoryRecallContext {
  if (!memoryRecallContext) throw new Error("[VectorMind] memory recall context is not configured");
  return memoryRecallContext;
}

function getDb(): Database.Database {
  const db = requireMemoryRecallContext().getDb();
  if (!db) throw new Error("[VectorMind] database is not initialized");
  return db;
}

function getListConventionsStatement(): Database.Statement {
  return requireMemoryRecallContext().getListConventionsStatement();
}

function getListCurrentDecisionsStatement(): Database.Statement {
  return requireMemoryRecallContext().getListCurrentDecisionsStatement();
}

function getListActiveRequirementsStatement(): Database.Statement {
  return requireMemoryRecallContext().getListActiveRequirementsStatement();
}

function getRequirementMemoryItemIdStatement(): Database.Statement {
  return requireMemoryRecallContext().getRequirementMemoryItemIdStatement();
}

function getMemoryItemByIdStatement(): Database.Statement {
  return requireMemoryRecallContext().getMemoryItemByIdStatement();
}

function isFtsAvailable(): boolean {
  return requireMemoryRecallContext().isFtsAvailable();
}

function sha256Hex(input: string): string {
  return requireMemoryRecallContext().sha256Hex(input);
}

function escapeLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (m) => `\\${m}`);
}
type SemanticSearchMode = "fts" | "like" | "token" | "hybrid";

type MemoryItemSearchRow = Pick<
  MemoryItemRow,
  | "id"
  | "kind"
  | "title"
  | "content"
  | "file_path"
  | "start_line"
  | "end_line"
  | "req_id"
  | "metadata_json"
  | "updated_at"
>;

type SemanticSearchMatch = {
  score: number;
  item: {
    id: number;
    kind: string;
    title: string | null;
    file_path: string | null;
    start_line: number | null;
    end_line: number | null;
    req_id: number | null;
    preview: string;
    content?: string;
    content_truncated?: boolean;
    metadata_json: string | null;
    updated_at: string;
  };
};

type SemanticSearchResult = {
  query: string;
  top_k: number;
  mode: SemanticSearchMode;
  matches: SemanticSearchMatch[];
};

type SemanticSearchOpts = {
  query: string;
  topK: number;
  kinds: string[] | null;
  includeContent: boolean;
  previewChars: number;
  contentMaxChars: number;
};

const SEMANTIC_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

export const BOOTSTRAP_DEFAULT_CONTEXT_KINDS = [
  "decision",
  "convention",
  "project_summary",
  "memory_compaction",
  "note",
  "requirement",
  "change_intent",
  "large_file_split_plan",
];

const TOKEN_SEARCH_DEFAULT_KINDS = [
  "decision",
  "convention",
  "project_summary",
  "memory_compaction",
  "note",
  "requirement",
  "change_intent",
  "large_file_split_plan",
  "code_chunk",
  "doc_chunk",
];

const DECISION_CANDIDATE_KEYWORDS = [
  "用户确认",
  "用户要求",
  "明确",
  "架构决策",
  "最终",
  "默认",
  "只保留",
  "统一",
  "不需要",
  "无需",
  "不再",
  "改成",
  "改为",
  "替换为",
  "废弃",
  "过时",
  "移除旧",
  "decision",
  "decided",
  "confirmed",
  "must",
  "default",
  "only",
  "single",
  "no longer",
  "instead",
];

export function parseMetadataJson(metadata: string | null | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function metadataStatus(row: { metadata_json?: string | null }): string {
  const meta = parseMetadataJson(row.metadata_json);
  return typeof meta.status === "string" ? meta.status : "";
}

function isSupersededMemory(row: { metadata_json?: string | null }): boolean {
  const meta = parseMetadataJson(row.metadata_json);
  return meta.superseded === true || meta.status === "superseded";
}

function isCompactedMemory(row: { metadata_json?: string | null }): boolean {
  const meta = parseMetadataJson(row.metadata_json);
  return meta.compacted === true || meta.status === "compacted";
}

export function isHiddenFromDefaultRecall(row: { metadata_json?: string | null }): boolean {
  return isSupersededMemory(row) || isCompactedMemory(row);
}

function semanticRecencyWeight(updatedAt: string | null | undefined): number {
  if (!updatedAt) return 0;
  const t = Date.parse(updatedAt.endsWith("Z") ? updatedAt : `${updatedAt}Z`);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (Date.now() - t) / 86_400_000);
  if (ageDays <= 1) return 0.8;
  if (ageDays <= 7) return 0.45;
  if (ageDays <= 30) return 0.2;
  return 0;
}

function semanticKindWeight(kind: string): number {
  switch (kind) {
    case "decision":
      return 16;
    case "convention":
      return 2.6;
    case "project_summary":
      return 2.2;
    case "note":
      return 1.1;
    case "requirement":
      return 0.4;
    case "change_intent":
      return 0.2;
    case "fix_pattern":
      return 1.8;
    case "memory_compaction":
      return 0.7;
    case "large_file_split_plan":
      return 1.6;
    default:
      return 0;
  }
}

function adjustSemanticScore(row: MemoryItemSearchRow, rawScore: number): number {
  if (isHiddenFromDefaultRecall(row)) return rawScore - 1000;
  let score = rawScore + semanticKindWeight(row.kind) + semanticRecencyWeight(row.updated_at);
  const status = metadataStatus(row);
  if (status === "current") score += row.kind === "decision" ? 24 : 1.2;
  if (status === "active") score += 1.2;
  if (row.kind === "change_intent" && row.file_path && shouldIgnoreDbFilePath(row.file_path)) {
    // Human-synced intent for generated/build/runtime files is often the only durable
    // "why" for that change. Do not let built-in path ignores hide the decision trail.
    score += 0.4;
  }
  return score;
}

function normalizeSearchText(input: string | null | undefined): string {
  return (input ?? "").normalize("NFKC").toLowerCase();
}

function extractSearchTokens(raw: string): string[] {
  const text = normalizeSearchText(raw);
  const tokens = new Set<string>();

  for (const token of text.match(/[a-z0-9_./:@#-]{2,}/g) ?? []) {
    if (!SEMANTIC_TOKEN_STOPWORDS.has(token)) tokens.add(token);
    for (const part of token.split(/[^a-z0-9]+/).filter((p) => p.length >= 2)) {
      if (!SEMANTIC_TOKEN_STOPWORDS.has(part)) tokens.add(part);
    }
  }

  for (const seq of text.match(/\p{Script=Han}+/gu) ?? []) {
    if (seq.length >= 2 && seq.length <= 18) tokens.add(seq);
    for (const n of [2, 3, 4]) {
      if (seq.length < n) continue;
      for (let i = 0; i <= seq.length - n; i++) {
        tokens.add(seq.slice(i, i + n));
      }
    }
  }

  return Array.from(tokens)
    .filter((token) => token.length >= 2 && !SEMANTIC_TOKEN_STOPWORDS.has(token))
    .sort((a, b) => b.length - a.length)
    .slice(0, 48);
}

function countNeedleOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) >= 0) {
    count++;
    idx += Math.max(1, needle.length);
    if (count >= 8) break;
  }
  return count;
}

function tokenLexicalScore(row: MemoryItemSearchRow, query: string, tokens: string[]): number {
  if (!tokens.length) return 0;
  const title = normalizeSearchText(row.title);
  const content = normalizeSearchText(row.content);
  const filePath = normalizeSearchText(row.file_path);
  const metadata = normalizeSearchText(row.metadata_json);
  const exact = normalizeSearchText(query).trim();

  let score = 0;
  if (exact.length >= 4) {
    if (title.includes(exact)) score += 8;
    if (content.includes(exact)) score += 6;
    if (filePath.includes(exact)) score += 4;
  }

  let matched = 0;
  for (const token of tokens) {
    let tokenScore = 0;
    if (title.includes(token)) tokenScore += 3.2;
    if (filePath.includes(token)) tokenScore += 2.4;
    const contentHits = countNeedleOccurrences(content, token);
    if (contentHits) tokenScore += Math.min(3.2, 0.75 + contentHits * 0.45);
    if (metadata.includes(token)) tokenScore += 0.8;
    if (tokenScore > 0) {
      matched++;
      score += tokenScore * Math.min(2.4, Math.max(1, token.length / 4));
    }
  }

  if (matched >= Math.min(3, tokens.length)) score += 2;
  score += matched / Math.max(1, tokens.length);
  return score;
}

function looksLikeDecisionContent(content: string): boolean {
  const text = normalizeSearchText(content);
  return DECISION_CANDIDATE_KEYWORDS.some((kw) => text.includes(normalizeSearchText(kw)));
}

function mergeSemanticMatches(
  sets: Array<SemanticSearchMatch[]>,
  opts: SemanticSearchOpts,
): SemanticSearchMatch[] {
  const best = new Map<number, SemanticSearchMatch>();
  for (const matches of sets) {
    for (const match of matches) {
      const prev = best.get(match.item.id);
      if (!prev || match.score > prev.score) best.set(match.item.id, match);
    }
  }
  return Array.from(best.values())
    .sort((a, b) => b.score - a.score || b.item.id - a.item.id)
    .slice(0, opts.topK);
}

function filterAndRankSemanticRows(
  rows: MemoryItemSearchRow[],
  scoreOf: (row: MemoryItemSearchRow) => number,
  opts: SemanticSearchOpts,
): SemanticSearchMatch[] {
  const explicitKinds = new Set(opts.kinds ?? []);
  return rows
    .map((r) => ({ row: r, score: adjustSemanticScore(r, scoreOf(r)) }))
    .filter(({ row }) => {
      if (isHiddenFromDefaultRecall(row)) return false;
      if (row.kind === "fix_pattern" && !explicitKinds.has("fix_pattern")) return false;
      if (
        row.kind === "large_file_split_plan" &&
        ["resolved", "deferred", "abandoned"].includes(metadataStatus(row)) &&
        !explicitKinds.has("large_file_split_plan")
      ) return false;
      if (shouldIgnoreDbFilePath(row.file_path) && row.kind !== "change_intent") return false;
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK)
    .map(({ row, score }) =>
      toSemanticMatch(row, score, opts.includeContent, opts.previewChars, opts.contentMaxChars),
    );
}

export function makePreviewText(content: string, max: number): string {
  if (max <= 0) return "";
  if (content.length <= max) return content;
  return `${content.slice(0, max)}...`;
}

function toSemanticMatch(
  row: MemoryItemSearchRow,
  score: number,
  includeContent: boolean,
  previewChars: number,
  contentMaxChars: number,
): SemanticSearchMatch {
  const preview = makePreviewText(row.content, previewChars);
  const contentSlice = includeContent ? sliceTextForOutput(row.content, contentMaxChars) : null;
  return {
    score,
    item: {
      id: row.id,
      kind: row.kind,
      title: row.title,
      file_path: row.file_path,
      start_line: row.start_line,
      end_line: row.end_line,
      req_id: row.req_id,
      preview,
      content: contentSlice ? contentSlice.text : undefined,
      content_truncated: contentSlice ? contentSlice.truncated : undefined,
      metadata_json: row.metadata_json,
      updated_at: row.updated_at,
    },
  };
}

export function toMemoryItemPreview(
  row: MemoryItemRow,
  includeContent: boolean,
  previewChars: number,
  contentMaxChars: number,
): {
  id: number;
  kind: string;
  title: string | null;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  req_id: number | null;
  preview: string;
  content?: string;
  content_truncated?: boolean;
  metadata_json: string | null;
  updated_at: string;
} {
  const preview = makePreviewText(row.content, previewChars);
  const contentSlice = includeContent ? sliceTextForOutput(row.content, contentMaxChars) : null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    file_path: row.file_path,
    start_line: row.start_line,
    end_line: row.end_line,
    req_id: row.req_id,
    preview,
    content: contentSlice ? contentSlice.text : undefined,
    content_truncated: contentSlice ? contentSlice.truncated : undefined,
    metadata_json: row.metadata_json,
    updated_at: row.updated_at,
  };
}

function getBuiltinConventionRows(): MemoryItemRow[] {
  return BUILTIN_CONVENTIONS.map((spec, idx) => ({
    id: -1000 - idx,
    kind: "convention",
    title: spec.key,
    content: spec.content,
    file_path: null,
    start_line: null,
    end_line: null,
    req_id: null,
    metadata_json: safeJson({ source: "builtin", key: spec.key, tags: spec.tags ?? [] }),
    content_hash: sha256Hex(spec.content),
    created_at: "builtin",
    updated_at: "builtin",
  }));
}

export function getConventionPreviews(
  conventionsLimit: number,
  previewChars: number,
  contentMaxChars: number,
): Array<ReturnType<typeof toMemoryItemPreview>> {
  if (conventionsLimit <= 0) return [];

  const builtin = getBuiltinConventionRows()
    .map((row) => toMemoryItemPreview(row, false, previewChars, contentMaxChars))
    .slice(0, conventionsLimit);

  if (builtin.length >= conventionsLimit) return builtin;

  const remaining = conventionsLimit - builtin.length;
  const stored = (getListConventionsStatement().all(remaining) as MemoryItemRow[]).map((c) =>
    toMemoryItemPreview(c, false, previewChars, contentMaxChars),
  );

  return [...builtin, ...stored];
}

export function getDecisionPreviews(
  decisionsLimit: number,
  previewChars: number,
  contentMaxChars: number,
): Array<ReturnType<typeof toMemoryItemPreview>> {
  if (decisionsLimit <= 0) return [];
  const rows = getListCurrentDecisionsStatement().all(Math.min(MAX_DECISIONS_LIMIT * 4, Math.max(decisionsLimit, decisionsLimit * 4))) as MemoryItemRow[];
  return rows
    .filter((d) => !isHiddenFromDefaultRecall(d))
    .slice(0, decisionsLimit)
    .map((d) => toMemoryItemPreview(d, false, previewChars, contentMaxChars));
}

export function getCurrentContextPreviews(
  currentContextLimit: number,
  previewChars: number,
  contentMaxChars: number,
): Array<ReturnType<typeof toMemoryItemPreview>> {
  if (currentContextLimit <= 0) return [];

  const picked = new Map<number, ReturnType<typeof toMemoryItemPreview>>();
  const addRow = (row: MemoryItemRow | undefined): void => {
    if (!row) return;
    if (isHiddenFromDefaultRecall(row)) return;
    if (
      row.kind === "large_file_split_plan" &&
      !["planned", "in_progress", "partial", "needs_refinement"].includes(metadataStatus(row) ?? "")
    ) return;
    if (shouldIgnoreDbFilePath(row.file_path) && row.kind !== "change_intent") return;
    if (!picked.has(row.id)) {
      picked.set(row.id, toMemoryItemPreview(row, false, previewChars, contentMaxChars));
    }
  };

  const activeReqs = getListActiveRequirementsStatement().all(Math.max(currentContextLimit, 10)) as RequirementRow[];
  for (const req of activeReqs) {
    const memId = (getRequirementMemoryItemIdStatement().get(req.id) as { id: number } | undefined)?.id;
    if (memId != null) addRow(getMemoryItemByIdStatement().get(memId) as MemoryItemRow | undefined);
  }

  const recentContextPageStmt = getDb().prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind IN ('note', 'requirement', 'change_intent', 'large_file_split_plan')
     ORDER BY updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  );
  const pageSize = 200;
  const scanCap = 10_000;
  let offset = 0;
  while (picked.size < currentContextLimit && offset < scanCap) {
    const recentRows = recentContextPageStmt.all(pageSize, offset) as MemoryItemRow[];
    if (!recentRows.length) break;
    for (const row of recentRows) {
      if (picked.size >= currentContextLimit) break;
      if (row.kind === "requirement" || row.kind === "change_intent") {
        if (!looksLikeDecisionContent(`${row.title ?? ""}\n${row.content}`)) continue;
      }
      addRow(row);
    }
    offset += recentRows.length;
    if (recentRows.length < pageSize) break;
  }

  return Array.from(picked.values()).slice(0, currentContextLimit);
}

export function toRequirementPreview(
  req: RequirementRow,
  includeContent: boolean,
  previewChars: number,
  contentMaxChars: number,
): {
  id: number;
  title: string;
  status: string;
  created_at: string;
  memory_item_id: number | null;
  context_preview: string | null;
  context_data?: string | null;
  context_truncated?: boolean;
} {
  const context = req.context_data ?? null;
  const contextPreview = context ? makePreviewText(context, previewChars) : null;
  const contextSlice = includeContent && context ? sliceTextForOutput(context, contentMaxChars) : null;
  const memRow = (getRequirementMemoryItemIdStatement().get(req.id) as { id: number } | undefined) ?? undefined;
  return {
    id: req.id,
    title: req.title,
    status: req.status,
    created_at: req.created_at,
    memory_item_id: memRow?.id ?? null,
    context_preview: contextPreview,
    context_data: contextSlice ? contextSlice.text : undefined,
    context_truncated: contextSlice ? contextSlice.truncated : undefined,
  };
}

export function toChangeLogPreview(
  change: ChangeLogRow,
  includeContent: boolean,
  previewChars: number,
  contentMaxChars: number,
): {
  id: number;
  file_path: string | null;
  files?: string[];
  file_count?: number;
  timestamp: string;
  intent_preview: string;
  intent_summary?: string;
  intent_truncated?: boolean;
} {
  const preview = makePreviewText(change.intent_summary, previewChars);
  const intentSlice = includeContent ? sliceTextForOutput(change.intent_summary, contentMaxChars) : null;
  const parsedFiles = (() => {
    if (!change.files_json) return [];
    try {
      const parsed = JSON.parse(change.files_json);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => (item && typeof item === "object" ? (item as { file_path?: unknown }).file_path : null))
        .filter((filePath): filePath is string => typeof filePath === "string" && filePath.length > 0);
    } catch {
      return [];
    }
  })();
  return {
    id: change.id,
    file_path: change.file_path,
    files: parsedFiles.length ? parsedFiles : undefined,
    file_count: change.file_count ?? (parsedFiles.length || undefined),
    timestamp: change.timestamp,
    intent_preview: preview,
    intent_summary: intentSlice ? intentSlice.text : undefined,
    intent_truncated: intentSlice ? intentSlice.truncated : undefined,
  };
}

export function buildFtsMatchQuery(raw: string): string {
  const terms = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!terms.length) return '""';
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
}

function ftsSearchInternal(opts: SemanticSearchOpts): SemanticSearchResult {
  if (!isFtsAvailable()) {
    throw new Error("FTS is unavailable");
  }

  const q = opts.query.trim();
  if (!q) return { query: "", top_k: opts.topK, mode: "fts", matches: [] };
  const matchQuery = buildFtsMatchQuery(q);
  const rawLimit = Math.min(500, Math.max(opts.topK, opts.topK * 8));

  const rows: Array<FtsSearchRow> = (() => {
    if (opts.kinds?.length) {
      const placeholders = opts.kinds.map(() => "?").join(", ");
      const stmt = getDb().prepare(`
        SELECT
          m.id as id,
          m.kind as kind,
          m.title as title,
          m.content as content,
          m.file_path as file_path,
          m.start_line as start_line,
          m.end_line as end_line,
          m.req_id as req_id,
          m.metadata_json as metadata_json,
          m.updated_at as updated_at,
          bm25(${MEMORY_ITEMS_FTS_TABLE}) as rank
        FROM ${MEMORY_ITEMS_FTS_TABLE}
        JOIN memory_items m ON m.id = ${MEMORY_ITEMS_FTS_TABLE}.rowid
        WHERE ${MEMORY_ITEMS_FTS_TABLE} MATCH ?
          AND m.kind IN (${placeholders})
        ORDER BY rank ASC
        LIMIT ?
      `);
      return stmt.all(matchQuery, ...opts.kinds, rawLimit) as Array<FtsSearchRow>;
    }

    const stmt = getDb().prepare(`
      SELECT
        m.id as id,
        m.kind as kind,
        m.title as title,
        m.content as content,
        m.file_path as file_path,
        m.start_line as start_line,
        m.end_line as end_line,
        m.req_id as req_id,
        m.metadata_json as metadata_json,
        m.updated_at as updated_at,
        bm25(${MEMORY_ITEMS_FTS_TABLE}) as rank
      FROM ${MEMORY_ITEMS_FTS_TABLE}
      JOIN memory_items m ON m.id = ${MEMORY_ITEMS_FTS_TABLE}.rowid
      WHERE ${MEMORY_ITEMS_FTS_TABLE} MATCH ?
      ORDER BY rank ASC
      LIMIT ?
    `);
    return stmt.all(matchQuery, rawLimit) as Array<FtsSearchRow>;
  })();

  const matches = filterAndRankSemanticRows(rows, (r) => -Number((r as FtsSearchRow).rank), opts);
  return { query: q, top_k: opts.topK, mode: "fts", matches };
}

type FtsSearchRow = MemoryItemSearchRow & { rank: number };
type LikeSearchRow = MemoryItemSearchRow & { score: number };

function likeSearchInternal(opts: SemanticSearchOpts): SemanticSearchResult {
  const q = opts.query.trim();
  if (!q) return { query: "", top_k: opts.topK, mode: "like", matches: [] };
  const escaped = escapeLike(q);
  const like = `%${escaped}%`;
  const rawLimit = Math.min(500, Math.max(opts.topK, opts.topK * 8));

  const rows: Array<LikeSearchRow> = (() => {
    if (opts.kinds?.length) {
      const placeholders = opts.kinds.map(() => "?").join(", ");
      const stmt = getDb().prepare(`
        SELECT
          id,
          kind,
          title,
          content,
          file_path,
          start_line,
          end_line,
          req_id,
          metadata_json,
          updated_at,
          CASE
            WHEN title LIKE ? ESCAPE '\\' THEN 3
            WHEN file_path LIKE ? ESCAPE '\\' THEN 2
            ELSE 1
          END AS score
        FROM memory_items
        WHERE (content LIKE ? ESCAPE '\\'
            OR title LIKE ? ESCAPE '\\'
            OR file_path LIKE ? ESCAPE '\\')
          AND kind IN (${placeholders})
        ORDER BY score DESC, updated_at DESC, id DESC
        LIMIT ?
      `);
      return stmt.all(like, like, like, like, like, ...opts.kinds, rawLimit) as Array<LikeSearchRow>;
    }

    const stmt = getDb().prepare(`
      SELECT
        id,
        kind,
        title,
        content,
        file_path,
        start_line,
        end_line,
        req_id,
        metadata_json,
        updated_at,
        CASE
          WHEN title LIKE ? ESCAPE '\\' THEN 3
          WHEN file_path LIKE ? ESCAPE '\\' THEN 2
          ELSE 1
        END AS score
      FROM memory_items
      WHERE (content LIKE ? ESCAPE '\\'
          OR title LIKE ? ESCAPE '\\'
          OR file_path LIKE ? ESCAPE '\\')
      ORDER BY score DESC, updated_at DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(like, like, like, like, like, rawLimit) as Array<LikeSearchRow>;
  })();

  const matches = filterAndRankSemanticRows(rows, (r) => Number((r as LikeSearchRow).score), opts);
  return { query: q, top_k: opts.topK, mode: "like", matches };
}

function tokenSearchInternal(opts: SemanticSearchOpts): SemanticSearchResult {
  const q = opts.query.trim();
  if (!q) return { query: "", top_k: opts.topK, mode: "token", matches: [] };

  const tokens = extractSearchTokens(q);
  if (!tokens.length) return { query: q, top_k: opts.topK, mode: "token", matches: [] };

  const rawLimit = Math.min(160, Math.max(opts.topK * 12, 80));
  const searchTokens = tokens.slice(0, 8);
  const effectiveKinds = opts.kinds?.length ? opts.kinds : TOKEN_SEARCH_DEFAULT_KINDS;
  const kindClause = effectiveKinds.length
    ? `AND kind IN (${effectiveKinds.map(() => "?").join(", ")})`
    : "";
  const recencyBoost = `
      + CASE
          WHEN updated_at >= datetime('now', '-2 days') THEN 4
          WHEN updated_at >= datetime('now', '-14 days') THEN 2
          WHEN updated_at >= datetime('now', '-60 days') THEN 1
          ELSE 0
        END`;
  const candidateScore = `
      (
        CASE kind
          WHEN 'decision' THEN 9
          WHEN 'convention' THEN 7
          WHEN 'project_summary' THEN 6
          WHEN 'note' THEN 5
          WHEN 'requirement' THEN 4
          WHEN 'change_intent' THEN 3
          ELSE 0
        END
        ${recencyBoost}
      )`;

  const includesIndexedChunks = effectiveKinds.some((k) => k === "code_chunk" || k === "doc_chunk");
  if (!includesIndexedChunks) {
    const candidateLimit = Math.min(1600, Math.max(rawLimit * 5, 800));
    const stmt = getDb().prepare(`
      SELECT
        id,
        kind,
        title,
        content,
        file_path,
        start_line,
        end_line,
        req_id,
        metadata_json,
        updated_at
      FROM memory_items
      WHERE 1=1
        ${kindClause}
      ORDER BY
        ${candidateScore} DESC,
        updated_at DESC,
        id DESC
      LIMIT ?
    `);
    const candidates = stmt.all(...effectiveKinds, candidateLimit) as MemoryItemSearchRow[];
    const scoreMap = new Map<number, number>();
    const rows = candidates.filter((row) => {
      const score = tokenLexicalScore(row, q, tokens);
      if (score <= 0) return false;
      scoreMap.set(row.id, score);
      return true;
    });
    const matches = filterAndRankSemanticRows(rows, (r) => scoreMap.get(r.id) ?? 0, opts);
    return { query: q, top_k: opts.topK, mode: "token", matches };
  }

  const memoryFirstKinds = effectiveKinds.filter((k) => k !== "code_chunk" && k !== "doc_chunk");
  const memoryFirstLimit = Math.min(1200, Math.max(rawLimit * 4, 300));
  let memoryFirstRows: MemoryItemSearchRow[] = [];
  const memoryFirstScores = new Map<number, number>();
  if (memoryFirstKinds.length) {
    const memoryKindClause = `AND kind IN (${memoryFirstKinds.map(() => "?").join(", ")})`;
    const memoryStmt = getDb().prepare(`
      SELECT
        id,
        kind,
        title,
        content,
        file_path,
        start_line,
        end_line,
        req_id,
        metadata_json,
        updated_at
      FROM memory_items
      WHERE 1=1
        ${memoryKindClause}
      ORDER BY
        ${candidateScore} DESC,
        updated_at DESC,
        id DESC
      LIMIT ?
    `);
    const candidates = memoryStmt.all(...memoryFirstKinds, memoryFirstLimit) as MemoryItemSearchRow[];
    memoryFirstRows = candidates.filter((row) => {
      const score = tokenLexicalScore(row, q, tokens);
      if (score <= 0) return false;
      memoryFirstScores.set(row.id, score);
      return true;
    });
  }

  const conditions: string[] = [];
  const values: string[] = [];
  for (const token of searchTokens) {
    const like = `%${escapeLike(token)}%`;
    conditions.push(`content LIKE ? ESCAPE '\\'`);
    values.push(like);
    conditions.push(`title LIKE ? ESCAPE '\\'`);
    values.push(like);
    conditions.push(`file_path LIKE ? ESCAPE '\\'`);
    values.push(like);
  }
  if (!conditions.length) return { query: q, top_k: opts.topK, mode: "token", matches: [] };

  const stmt = getDb().prepare(`
    SELECT
      id,
      kind,
      title,
      content,
      file_path,
      start_line,
      end_line,
      req_id,
      metadata_json,
      updated_at
    FROM memory_items
    WHERE (${conditions.join(" OR ")})
      ${kindClause}
    ORDER BY
      ${candidateScore} DESC,
      updated_at DESC,
      id DESC
    LIMIT ?
  `);

  const rows = stmt.all(
    ...values,
    ...effectiveKinds,
    rawLimit,
  ) as MemoryItemSearchRow[];
  const scoreMap = new Map<number, number>(memoryFirstScores);
  for (const row of rows) {
    if (!scoreMap.has(row.id)) scoreMap.set(row.id, tokenLexicalScore(row, q, tokens));
  }
  const rowMap = new Map<number, MemoryItemSearchRow>();
  for (const row of memoryFirstRows) rowMap.set(row.id, row);
  for (const row of rows) rowMap.set(row.id, row);
  const matches = filterAndRankSemanticRows(Array.from(rowMap.values()), (r) => scoreMap.get(r.id) ?? 0, opts);
  return { query: q, top_k: opts.topK, mode: "token", matches };
}

function chooseLexicalResult(
  opts: SemanticSearchOpts,
): { result: SemanticSearchResult; mode: "fts" | "like" | "token" | "hybrid" } {
  const tokenResult = tokenSearchInternal(opts);
  const tokenTopScore = tokenResult.matches[0]?.score ?? 0;
  const tokenEnough = tokenResult.matches.length >= Math.min(opts.topK, 3) && tokenTopScore >= 8;
  if (tokenEnough || tokenResult.matches.length >= opts.topK) {
    return { result: tokenResult, mode: "token" };
  }

  let textResult: SemanticSearchResult | null = null;
  if (isFtsAvailable()) {
    try {
      textResult = ftsSearchInternal(opts);
    } catch (err) {
      console.error("[vectormind] fts semantic_search failed; falling back:", err);
    }
  }
  if (!textResult) {
    textResult = likeSearchInternal(opts);
  }

  const merged = mergeSemanticMatches([textResult.matches, tokenResult.matches], opts);
  const tokenIds = new Set(tokenResult.matches.map((m) => m.item.id));
  const ftsKept = textResult.matches.some((m) => !tokenIds.has(m.item.id));
  if (tokenResult.matches.length && ftsKept) {
    return {
      result: { query: opts.query.trim(), top_k: opts.topK, mode: "hybrid", matches: merged },
      mode: "hybrid",
    };
  }
  if (tokenResult.matches.length) {
    return { result: { query: opts.query.trim(), top_k: opts.topK, mode: "token", matches: merged }, mode: "token" };
  }
  return { result: textResult, mode: textResult.mode === "fts" ? "fts" : "like" };
}

export async function semanticSearchHybridInternal(opts: SemanticSearchOpts): Promise<SemanticSearchResult> {
  return chooseLexicalResult(opts).result;
}
