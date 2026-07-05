import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import Database from "better-sqlite3";

import {
  RIPGREP_MAX_BUFFER_BYTES,
  RIPGREP_RESOLVE_TIMEOUT_MS,
  RIPGREP_SEARCH_TIMEOUT_MS,
} from "./config.js";
import {
  IGNORED_PATH_SEGMENTS,
  NOISE_FILE_BASENAMES,
  NOISE_FILE_SUFFIXES,
  shouldIgnoreContentFile,
  shouldIgnoreDbFilePath,
} from "./path-rules.js";
import { passesPathFilters } from "./path-filters.js";

function escapeRegExp(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

let cachedRipgrepCommand: string | null | undefined;
let cachedRipgrepResolveError: string | null = null;

export function hasUppercaseAscii(s: string): boolean {
  return /[A-Z]/.test(s);
}

function extractLongestLiteralFromRegex(pattern: string): string {
  // Best-effort extraction: pull the longest literal run to use as an indexed candidate hint.
  // This is intentionally conservative; if we can't find a reasonable literal anchor, callers
  // should pass `literal_hint` or narrow with include_paths.
  let best = "";
  let cur = "";
  let inClass = false;

  const flush = () => {
    if (cur.length > best.length) best = cur;
    cur = "";
  };

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    if (!ch) break;

    if (inClass) {
      // Skip until the closing bracket.
      if (ch === "]") inClass = false;
      flush();
      continue;
    }
    if (ch === "[") {
      inClass = true;
      flush();
      continue;
    }

    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      if (!next) {
        flush();
        continue;
      }
      // Common regex escapes that are NOT literal characters.
      if (/[dDsSwWbB0-9]/.test(next)) {
        flush();
        i += 1;
        continue;
      }
      // Treat \x as literal x (e.g. \( \) \. \\).
      cur += next;
      i += 1;
      continue;
    }

    // Regex metacharacters.
    if (".*+?^$|(){}".includes(ch)) {
      flush();
      continue;
    }

    cur += ch;
  }

  flush();
  return best;
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1); // '\n'
  }
  return starts;
}

function lineIndexForOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = lineStarts[mid] ?? 0;
    if (v <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(0, lo - 1);
}

export type GrepMatch = {
  file_path: string;
  kind: string;
  line: number;
  col: number;
  preview: string;
  match: string;
};

export type GrepBackend = "ripgrep" | "indexed_fallback";

function compileGrepRegex(opts: {
  query: string;
  mode: "regex" | "literal";
  caseSensitive: boolean;
}): RegExp {
  const flags = `${opts.caseSensitive ? "" : "i"}gm`;
  const source = opts.mode === "literal" ? escapeRegExp(opts.query) : opts.query;
  return new RegExp(source, flags);
}

function trimGrepText(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars)}…`;
}

function buildGrepPreviewSnippet(lineText: string, col: number, maxChars = 500): string {
  const clean = lineText.replace(/\r$/, "");
  if (clean.length <= maxChars) return clean;

  const matchIndex = Math.max(0, col - 1);
  let start = Math.max(0, matchIndex - Math.floor(maxChars * 0.35));
  if (start + maxChars > clean.length) start = Math.max(0, clean.length - maxChars);
  const end = Math.min(clean.length, start + maxChars);

  let snippet = clean.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < clean.length) snippet = `${snippet}…`;
  return snippet;
}

function extractGrepMatchText(opts: {
  lineText: string;
  query: string;
  mode: "regex" | "literal";
  caseSensitive: boolean;
  col: number;
}): string {
  const clean = opts.lineText.replace(/\r$/, "");
  const startIndex = Math.max(0, opts.col - 1);

  if (opts.mode === "literal") {
    const slice = clean.slice(startIndex, startIndex + opts.query.length) || opts.query;
    return trimGrepText(slice, 200);
  }

  try {
    const flags = opts.caseSensitive ? "m" : "im";
    const anchored = new RegExp(opts.query, flags);
    const tail = clean.slice(startIndex);
    const found = anchored.exec(tail);
    if (found?.index === 0 && found[0]) return trimGrepText(found[0], 200);
  } catch {}

  const fallback = clean.slice(startIndex, Math.min(clean.length, startIndex + 200));
  return trimGrepText(fallback || opts.query, 200);
}

function toProcessText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return value.toString("utf8");
}

function formatProcessFailure(result: {
  error?: Error;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}): string {
  if (result.error) return `${result.error.name}: ${result.error.message}`;
  const stderr = toProcessText(result.stderr).trim();
  if (stderr) return stderr;
  const stdout = toProcessText(result.stdout).trim();
  if (stdout) return stdout;
  if (typeof result.status === "number") return `exit ${result.status}`;
  if (result.signal) return `signal ${result.signal}`;
  return "unknown failure";
}

function buildRipgrepEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.RIPGREP_CONFIG_PATH;
  return env;
}

function pushUniqueCandidate(candidates: string[], seen: Set<string>, raw: string | null | undefined): void {
  const value = raw?.trim();
  if (!value || seen.has(value)) return;
  seen.add(value);
  candidates.push(value);
}

function listChildDirsSafe(dirPath: string): string[] {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

function collectRipgrepCandidates(): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const override = process.env.VECTORMIND_RG_PATH?.trim();
  if (override) pushUniqueCandidate(candidates, seen, path.resolve(override));

  if (process.platform === "win32") {
    pushUniqueCandidate(candidates, seen, "rg.exe");
    pushUniqueCandidate(candidates, seen, "rg");
  } else {
    pushUniqueCandidate(candidates, seen, "rg");
  }

  for (const rawDir of (process.env.PATH ?? "").split(path.delimiter)) {
    const dir = rawDir.trim().replace(/^"+|"+$/g, "");
    if (!dir) continue;
    if (process.platform === "win32") {
      pushUniqueCandidate(candidates, seen, path.join(dir, "rg.exe"));
      pushUniqueCandidate(candidates, seen, path.join(dir, "rg"));
    } else {
      pushUniqueCandidate(candidates, seen, path.join(dir, "rg"));
    }
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    const programsDir = localAppData ? path.join(localAppData, "Programs") : "";
    if (programsDir && fs.existsSync(programsDir)) {
      for (const appDir of listChildDirsSafe(programsDir)) {
        pushUniqueCandidate(
          candidates,
          seen,
          path.join(appDir, "resources", "app", "node_modules", "@vscode", "ripgrep", "bin", "rg.exe"),
        );
        pushUniqueCandidate(
          candidates,
          seen,
          path.join(
            appDir,
            "resources",
            "app",
            "extensions",
            "kiro.kiro-agent",
            "node_modules",
            "@vscode",
            "ripgrep",
            "bin",
            "rg.exe",
          ),
        );
        for (const childDir of listChildDirsSafe(appDir)) {
          pushUniqueCandidate(
            candidates,
            seen,
            path.join(childDir, "resources", "app", "node_modules", "@vscode", "ripgrep", "bin", "rg.exe"),
          );
        }
      }
    }
  }

  return candidates;
}

function resolveRipgrepCommand(projectRoot: string):
  | { ok: true; command: string }
  | { ok: false; error: string; attempts: string[] } {
  if (typeof cachedRipgrepCommand !== "undefined") {
    if (cachedRipgrepCommand) return { ok: true, command: cachedRipgrepCommand };
    return { ok: false, error: cachedRipgrepResolveError ?? "ripgrep unavailable", attempts: [] };
  }

  const env = buildRipgrepEnv();
  const attempts: string[] = [];

  for (const candidate of collectRipgrepCandidates()) {
    const probe = spawnSync(candidate, ["--version"], {
      cwd: projectRoot || undefined,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: RIPGREP_RESOLVE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    if (probe.status === 0) {
      cachedRipgrepCommand = candidate;
      cachedRipgrepResolveError = null;
      return { ok: true, command: candidate };
    }
    attempts.push(`${candidate}: ${formatProcessFailure(probe)}`);
  }

  cachedRipgrepCommand = null;
  cachedRipgrepResolveError = attempts.slice(0, 8).join(" | ") || "ripgrep unavailable";
  return { ok: false, error: cachedRipgrepResolveError, attempts };
}

function appendBuiltInRipgrepExcludes(args: string[]): void {
  for (const segment of IGNORED_PATH_SEGMENTS) {
    args.push("-g", `!${segment}/**`);
    args.push("-g", `!**/${segment}/**`);
  }
  for (const baseName of NOISE_FILE_BASENAMES) {
    args.push("-g", `!**/${baseName}`);
  }
  for (const suffix of NOISE_FILE_SUFFIXES) {
    args.push("-g", `!**/*${suffix}`);
  }
}

export function runRipgrepSearch(opts: {
  query: string;
  mode: "regex" | "literal";
  smartCase: boolean;
  caseSensitive: boolean;
  includePaths: string[] | null;
  excludePaths: string[] | null;
  maxResults: number;
  projectRoot: string;
}):
  | {
      ok: true;
      backend: "ripgrep";
      rg_command: string;
      matches: GrepMatch[];
      truncated: boolean;
      total_matches: number;
    }
  | {
      ok: false;
      unavailable: boolean;
      error: string;
      attempts: string[];
      rg_command?: string;
      exit_status?: number | null;
    } {
  const resolved = resolveRipgrepCommand(opts.projectRoot);
  if (!resolved.ok) {
    return { ok: false, unavailable: true, error: resolved.error, attempts: resolved.attempts };
  }

  const args = ["--vimgrep", "--no-heading", "--color", "never", "-m", String(opts.maxResults)];
  args.push(opts.caseSensitive ? "-s" : "-i");
  if (opts.mode === "literal") args.push("-F");
  appendBuiltInRipgrepExcludes(args);
  args.push("--", opts.query, ".");

  const result = spawnSync(resolved.command, args, {
    cwd: opts.projectRoot,
    env: buildRipgrepEnv(),
    encoding: "utf8",
    windowsHide: true,
    timeout: RIPGREP_SEARCH_TIMEOUT_MS,
    maxBuffer: RIPGREP_MAX_BUFFER_BYTES,
  });

  if (result.error) {
    return {
      ok: false,
      unavailable: false,
      error: formatProcessFailure(result),
      attempts: [],
      rg_command: resolved.command,
      exit_status: result.status,
    };
  }

  const status = result.status ?? 0;
  if (status !== 0 && status !== 1) {
    return {
      ok: false,
      unavailable: false,
      error: formatProcessFailure(result),
      attempts: [],
      rg_command: resolved.command,
      exit_status: status,
    };
  }

  const matches: GrepMatch[] = [];
  let totalMatches = 0;
  let truncated = false;

  for (const rawLine of toProcessText(result.stdout).split(/\r?\n/)) {
    if (!rawLine) continue;
    const parsed = /^(.*?):(\d+):(\d+):(.*)$/.exec(rawLine);
    if (!parsed) continue;

    const filePath = path.posix
      .normalize(parsed[1].replace(/\\/g, "/"))
      .replace(/^\.\/+/, "");
    const lineNumber = Number.parseInt(parsed[2] ?? "0", 10);
    const colNumber = Number.parseInt(parsed[3] ?? "0", 10);
    const lineText = (parsed[4] ?? "").replace(/\r$/, "");

    if (!filePath || !Number.isFinite(lineNumber) || !Number.isFinite(colNumber)) continue;
    if (shouldIgnoreDbFilePath(filePath)) continue;
    if (shouldIgnoreContentFile(filePath)) continue;
    if (!passesPathFilters(filePath, opts.includePaths, opts.excludePaths)) continue;

    totalMatches += 1;
    if (matches.length >= opts.maxResults) {
      truncated = true;
      continue;
    }

    matches.push({
      file_path: filePath,
      kind: "file_match",
      line: lineNumber,
      col: colNumber,
      preview: buildGrepPreviewSnippet(lineText, colNumber),
      match: extractGrepMatchText({
        lineText,
        query: opts.query,
        mode: opts.mode,
        caseSensitive: opts.caseSensitive,
        col: colNumber,
      }),
    });
  }

  return {
    ok: true,
    backend: "ripgrep",
    rg_command: resolved.command,
    matches,
    truncated,
    total_matches: totalMatches,
  };
}

export function runIndexedGrepSearch(opts: {
  query: string;
  mode: "regex" | "literal";
  smartCase: boolean;
  caseSensitive: boolean;
  literalHint: string;
  kinds: string[];
  includePaths: string[] | null;
  excludePaths: string[] | null;
  maxResults: number;
  maxCandidates?: number;
  db: Database.Database;
  ftsAvailable: boolean;
  ftsTableName: string;
  buildFtsMatchQuery: (raw: string) => string;
  escapeLike: (pattern: string) => string;
}) {
  const hint = (() => {
    if (opts.mode === "literal") return opts.query;
    const explicit = opts.literalHint.trim();
    if (explicit) return explicit;
    return extractLongestLiteralFromRegex(opts.query);
  })();

  if (opts.mode === "regex" && hint.trim().length < 3) {
    throw new Error(
      "Regex has no sufficiently long literal anchor for indexed narrowing. Provide literal_hint (>= 3 chars) or narrow with include_paths.",
    );
  }

  let re: RegExp;
  try {
    re = compileGrepRegex({
      query: opts.query,
      mode: opts.mode,
      caseSensitive: opts.caseSensitive,
    });
  } catch (err) {
    throw new Error(`Invalid pattern: ${String(err)}`);
  }

  const maxCandidates = opts.maxCandidates ?? Math.min(50_000, Math.max(1000, opts.maxResults * 200));
  const candidates: Array<{
    id: number;
    kind: string;
    content: string;
    file_path: string | null;
    start_line: number | null;
    end_line: number | null;
  }> = (() => {
    if (opts.ftsAvailable) {
      const matchQuery = opts.buildFtsMatchQuery(hint);
      const placeholders = opts.kinds.map(() => "?").join(", ");
      const stmt = opts.db.prepare(`
        SELECT
          m.id as id,
          m.kind as kind,
          m.content as content,
          m.file_path as file_path,
          m.start_line as start_line,
          m.end_line as end_line
        FROM ${opts.ftsTableName}
        JOIN memory_items m ON m.id = ${opts.ftsTableName}.rowid
        WHERE ${opts.ftsTableName} MATCH ?
          AND m.kind IN (${placeholders})
        ORDER BY m.file_path ASC, m.start_line ASC, m.id ASC
        LIMIT ?
      `);
      return stmt.all(matchQuery, ...opts.kinds, maxCandidates) as Array<{
        id: number;
        kind: string;
        content: string;
        file_path: string | null;
        start_line: number | null;
        end_line: number | null;
      }>;
    }

    const needle = opts.mode === "literal" ? opts.query : hint;
    const escaped = opts.escapeLike(needle);
    const like = `%${escaped}%`;
    const placeholders = opts.kinds.map(() => "?").join(", ");
    const stmt = opts.db.prepare(`
      SELECT
        id,
        kind,
        content,
        file_path,
        start_line,
        end_line
      FROM memory_items
      WHERE content LIKE ? ESCAPE '\\'
        AND kind IN (${placeholders})
      ORDER BY file_path ASC, start_line ASC, id ASC
      LIMIT ?
    `);
    return stmt.all(like, ...opts.kinds, maxCandidates) as Array<{
      id: number;
      kind: string;
      content: string;
      file_path: string | null;
      start_line: number | null;
      end_line: number | null;
    }>;
  })();

  const matches: GrepMatch[] = [];
  let candidatesScanned = 0;
  let truncated = false;

  for (const c of candidates) {
    candidatesScanned += 1;
    if (!c.file_path || c.start_line == null) continue;
    if (shouldIgnoreDbFilePath(c.file_path)) continue;
    if (!passesPathFilters(c.file_path, opts.includePaths, opts.excludePaths)) continue;

    const content = c.content ?? "";
    const lineStarts = buildLineStarts(content);
    re.lastIndex = 0;

    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const idx = m.index ?? 0;
      const matched = m[0] ?? "";
      if (!matched) {
        if (re.lastIndex >= content.length) break;
        re.lastIndex += 1;
        continue;
      }

      const lineIdx = lineIndexForOffset(lineStarts, idx);
      const lineStart = lineStarts[lineIdx] ?? 0;
      const lineEnd =
        lineIdx + 1 < lineStarts.length
          ? (lineStarts[lineIdx + 1] ?? content.length) - 1
          : content.length;
      const previewRaw = content.slice(lineStart, Math.max(lineStart, lineEnd));

      matches.push({
        file_path: c.file_path,
        kind: c.kind,
        line: c.start_line + lineIdx,
        col: idx - lineStart + 1,
        preview: trimGrepText(previewRaw, 500),
        match: trimGrepText(matched, 200),
      });

      if (matches.length >= opts.maxResults) {
        truncated = true;
        break;
      }
    }

    if (truncated) break;
  }

  return {
    backend: "indexed_fallback" as const,
    hint,
    kinds: opts.kinds,
    include_paths: opts.includePaths ?? [],
    exclude_paths: opts.excludePaths ?? [],
    candidates: { total: candidates.length, scanned: candidatesScanned },
    matches,
    truncated,
  };
}
