import type { ToolHandlerContext } from "./tool-handlers/context.js";
import type { MemoryItemRow, RequirementRow } from "./types.js";
import { isHiddenFromDefaultRecall, parseMetadataJson } from "./memory-recall.js";
import { oneLine, safeJson } from "./tool-output.js";

export type FixPatternInput = {
  symptom: string;
  root_cause: string;
  invariant: string;
  applies_when?: string[];
  avoid_regression?: string[];
  verification?: string[];
  verification_gaps?: string[];
};

export type FixPatternMatchInput = {
  intent?: string;
  files?: string[];
  planned_changes?: Array<{ file?: string; change?: string; requirement_refs?: string[] }>;
  requirement?: RequirementRow | null;
  limit?: number;
  candidateLimit?: number;
};

export type RelevantFixPattern = {
  memory_id: number;
  symptom: string;
  root_cause: string;
  invariant: string;
  applies_when: string[];
  avoid_regression: string[];
  relevance_score: number;
  reason: string;
  updated_at: string;
};

export type FixPatternQualitySignals = {
  advisory_only: true;
  does_not_control_model_reasoning: true;
  does_not_control_host_runtime: true;
  does_not_replace_model_judgment: true;
  does_not_change_ok_or_safe_to_edit: true;
  does_not_expand_requirement_scope: true;
  relevant_fix_patterns: RelevantFixPattern[];
  note: string;
};

const STOPWORDS = new Set([
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
  "add",
  "change",
  "changed",
  "changing",
  "fix",
  "path",
  "paths",
  "refresh",
  "smoke",
  "test",
  "update",
]);

const GENERIC_PATH_SEGMENTS = new Set([
  "src",
  "lib",
  "app",
  "core",
  "test",
  "tests",
  "spec",
  "specs",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "rs",
  "go",
  "py",
  "cs",
  "java",
  "kt",
  "php",
  "rb",
  "md",
]);

function normalizeText(input: string | null | undefined): string {
  return (input ?? "").normalize("NFKC").toLowerCase();
}

function cleanList(values: unknown, limit = 8): string[] {
  if (!Array.isArray(values)) return [];
  const result: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = raw.replace(/\s+/g, " ").trim();
    if (!value) continue;
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

export function normalizeFixPattern(input: FixPatternInput): FixPatternInput {
  return {
    symptom: input.symptom.replace(/\s+/g, " ").trim(),
    root_cause: input.root_cause.replace(/\s+/g, " ").trim(),
    invariant: input.invariant.replace(/\s+/g, " ").trim(),
    applies_when: cleanList(input.applies_when),
    avoid_regression: cleanList(input.avoid_regression),
    verification: cleanList(input.verification),
    verification_gaps: cleanList(input.verification_gaps),
  };
}

export function buildFixPatternContent(pattern: FixPatternInput, intent: string, files: string[]): string {
  const p = normalizeFixPattern(pattern);
  const lines = [
    "Fix pattern advisory memory.",
    "",
    `Symptom: ${p.symptom}`,
    `Root cause: ${p.root_cause}`,
    `Invariant: ${p.invariant}`,
  ];
  if (p.applies_when?.length) {
    lines.push("", "Applies when:");
    for (const item of p.applies_when) lines.push(`- ${item}`);
  }
  if (p.avoid_regression?.length) {
    lines.push("", "Avoid regression:");
    for (const item of p.avoid_regression) lines.push(`- ${item}`);
  }
  if (p.verification?.length) {
    lines.push("", "Verified:");
    for (const item of p.verification) lines.push(`- ${item}`);
  }
  if (p.verification_gaps?.length) {
    lines.push("", "Verification gaps:");
    for (const item of p.verification_gaps) lines.push(`- ${item}`);
  }
  if (files.length) {
    lines.push("", "Source files:");
    for (const file of files.slice(0, 20)) lines.push(`- ${file}`);
  }
  lines.push("", `Source change intent: ${intent}`);
  lines.push(
    "",
    "Boundary: advisory quality signal only; do not expand the current requirement scope based only on this memory.",
  );
  return lines.join("\n");
}

export function buildFixPatternMetadata(args: {
  pattern: FixPatternInput;
  intent: string;
  files: string[];
  requirement_id: number;
  source_change_ids: number[];
  verification?: string[];
  verification_gaps?: string[];
}): string | null {
  const pattern = normalizeFixPattern({
    ...args.pattern,
    verification: args.pattern.verification?.length ? args.pattern.verification : args.verification,
    verification_gaps: args.pattern.verification_gaps?.length
      ? args.pattern.verification_gaps
      : args.verification_gaps,
  });
  return safeJson({
    status: "current",
    memory_type: "fix_pattern",
    advisory_only: true,
    does_not_control_model_reasoning: true,
    does_not_control_host_runtime: true,
    does_not_replace_model_judgment: true,
    does_not_change_ok_or_safe_to_edit: true,
    does_not_expand_requirement_scope: true,
    requirement_id: args.requirement_id,
    source_change_ids: args.source_change_ids,
    source_files: args.files,
    source_intent_preview: oneLine(args.intent, 240),
    fix_pattern: pattern,
  });
}

function extractTokens(raw: string): string[] {
  const text = normalizeText(raw);
  const tokens = new Set<string>();

  for (const token of text.match(/[a-z0-9_./:@#-]{2,}/g) ?? []) {
    if (!STOPWORDS.has(token)) tokens.add(token);
    for (const part of token.split(/[^a-z0-9]+/).filter((p) => p.length >= 2)) {
      if (!STOPWORDS.has(part)) tokens.add(part);
    }
  }

  for (const seq of text.match(/\p{Script=Han}+/gu) ?? []) {
    if (seq.length >= 2 && seq.length <= 18) tokens.add(seq);
    for (const n of [2, 3, 4]) {
      if (seq.length < n) continue;
      for (let i = 0; i <= seq.length - n; i++) tokens.add(seq.slice(i, i + n));
    }
  }

  return Array.from(tokens)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
    .sort((a, b) => b.length - a.length)
    .slice(0, 80);
}

function pathSegments(paths: string[]): Set<string> {
  const result = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeText(path).replaceAll("\\", "/");
    for (const part of normalized.split(/[/.#:_-]+/)) {
      if (part.length >= 2 && !STOPWORDS.has(part) && !GENERIC_PATH_SEGMENTS.has(part)) result.add(part);
    }
    if (normalized && normalized.split("/").length > 1) result.add(normalized);
  }
  return result;
}

function recencyWeight(updatedAt: string): number {
  const t = Date.parse(updatedAt.endsWith("Z") ? updatedAt : `${updatedAt}Z`);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (Date.now() - t) / 86_400_000);
  if (ageDays <= 2) return 1.2;
  if (ageDays <= 14) return 0.7;
  if (ageDays <= 60) return 0.35;
  return 0;
}

export function fixPatternFromRow(row: MemoryItemRow): FixPatternInput | null {
  const meta = parseMetadataJson(row.metadata_json);
  const raw = meta.fix_pattern;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.symptom !== "string" ||
    typeof obj.root_cause !== "string" ||
    typeof obj.invariant !== "string"
  ) {
    return null;
  }
  return normalizeFixPattern({
    symptom: obj.symptom,
    root_cause: obj.root_cause,
    invariant: obj.invariant,
    applies_when: cleanList(obj.applies_when),
    avoid_regression: cleanList(obj.avoid_regression),
    verification: cleanList(obj.verification),
    verification_gaps: cleanList(obj.verification_gaps),
  });
}

function matchInputText(input: FixPatternMatchInput): string {
  const planned = (input.planned_changes ?? [])
    .map((change) => `${change.change ?? ""} ${(change.requirement_refs ?? []).join(" ")}`)
    .join("\n");
  return [
    input.intent ?? "",
    planned,
    input.intent || input.files?.length || planned ? "" : input.requirement?.title ?? "",
    input.intent || input.files?.length || planned ? "" : input.requirement?.context_data ?? "",
  ].join("\n");
}

function rowText(row: MemoryItemRow, pattern: FixPatternInput): string {
  const meta = parseMetadataJson(row.metadata_json);
  const sourceFiles = cleanList(meta.source_files, 40);
  return [
    row.title ?? "",
    row.content,
    pattern.symptom,
    pattern.root_cause,
    pattern.invariant,
    pattern.applies_when?.join("\n") ?? "",
    pattern.avoid_regression?.join("\n") ?? "",
  ].join("\n");
}

function scoreFixPattern(row: MemoryItemRow, pattern: FixPatternInput, input: FixPatternMatchInput): {
  score: number;
  reasonParts: string[];
} {
  const inputText = matchInputText(input);
  const queryTokens = extractTokens(inputText);
  if (!queryTokens.length) return { score: 0, reasonParts: [] };

  const rowNormalized = normalizeText(rowText(row, pattern));
  let tokenMatches = 0;
  let score = 0;
  for (const token of queryTokens) {
    if (!rowNormalized.includes(token)) continue;
    tokenMatches += 1;
    score += Math.min(3.2, Math.max(0.8, token.length / 3));
  }

  const inputPaths = pathSegments(input.files ?? []);
  const meta = parseMetadataJson(row.metadata_json);
  const sourceFiles = cleanList(meta.source_files, 40);
  const sourcePathSegments = pathSegments(sourceFiles);
  let pathMatches = 0;
  for (const segment of inputPaths) {
    if (sourcePathSegments.has(segment)) pathMatches += 1;
  }
  if (pathMatches) score += Math.min(8, pathMatches * 2.2);

  if (tokenMatches >= Math.min(3, queryTokens.length)) score += 2;
  score += recencyWeight(row.updated_at);

  const reasonParts: string[] = [];
  if (tokenMatches) reasonParts.push(`${tokenMatches} text tokens`);
  if (pathMatches) reasonParts.push(`${pathMatches} path terms`);
  if (row.updated_at) reasonParts.push("recentness considered");
  return { score, reasonParts };
}

export function collectRelevantFixPatterns(
  context: ToolHandlerContext,
  input: FixPatternMatchInput,
): RelevantFixPattern[] {
  const text = matchInputText(input).trim();
  if (!text) return [];
  const limit = Math.max(0, Math.min(3, input.limit ?? 3));
  if (limit <= 0) return [];
  const candidateLimit = Math.max(limit, Math.min(50, input.candidateLimit ?? 50));
  const rows = context
    .getDb()
    .prepare(
      `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
       FROM memory_items
       WHERE kind = 'fix_pattern'
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(candidateLimit) as MemoryItemRow[];

  const matches = rows
    .filter((row) => !isHiddenFromDefaultRecall(row))
    .map((row) => {
      const pattern = fixPatternFromRow(row);
      if (!pattern) return null;
      const { score, reasonParts } = scoreFixPattern(row, pattern, input);
      if (score < 11) return null;
      return {
        memory_id: row.id,
        symptom: pattern.symptom,
        root_cause: pattern.root_cause,
        invariant: pattern.invariant,
        applies_when: pattern.applies_when ?? [],
        avoid_regression: pattern.avoid_regression ?? [],
        relevance_score: Number(score.toFixed(2)),
        reason: `Matched current intent/files against prior explicit fix_pattern memory (${reasonParts.join(", ") || "lexical overlap"}). Advisory only; do not expand current requirement scope from this signal.`,
        updated_at: row.updated_at,
      } satisfies RelevantFixPattern;
    })
    .filter((item): item is RelevantFixPattern => item !== null)
    .sort((a, b) => b.relevance_score - a.relevance_score || b.memory_id - a.memory_id)
    .slice(0, limit);

  return matches;
}

export function buildFixPatternQualitySignals(relevant: RelevantFixPattern[]): FixPatternQualitySignals {
  return {
    advisory_only: true,
    does_not_control_model_reasoning: true,
    does_not_control_host_runtime: true,
    does_not_replace_model_judgment: true,
    does_not_change_ok_or_safe_to_edit: true,
    does_not_expand_requirement_scope: true,
    relevant_fix_patterns: relevant,
    note:
      "Fix pattern matches are historical quality reminders only. They must not block work, change ok/safe flags, control host execution, or expand the current requirement scope.",
  };
}
