import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";

import { getAllowedCodexTextRoots, parseFileUriToPath } from "./root.js";
import { shouldIgnoreDbFilePath } from "./path-rules.js";
import { passesPathFilters } from "./path-filters.js";

export function resolveProjectPathUnderRoot(
  projectRoot: string,
  normalizeToDbPath: (inputPath: string) => string,
  inputPath: string,
  opts: { allowRoot?: boolean } = {},
): { absPath: string; dbFilePath: string } {
  const normalizedInput = inputPath.trim() || ".";
  const abs = path.isAbsolute(normalizedInput) ? normalizedInput : path.join(projectRoot, normalizedInput);
  const absPath = path.resolve(abs);
  const root = path.resolve(projectRoot);
  const rel = path.relative(root, absPath);
  const insideRoot = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!insideRoot) {
    throw new Error(`[VectorMind] Path must be under project_root: ${inputPath}`);
  }
  if (rel === "" && !opts.allowRoot) {
    throw new Error(`[VectorMind] Path must not be the project_root itself: ${inputPath}`);
  }
  return {
    absPath,
    dbFilePath: rel === "" ? "." : normalizeToDbPath(absPath),
  };
}

export function resolveReadPathUnderProjectRoot(
  projectRoot: string,
  normalizeToDbPath: (inputPath: string) => string,
  inputPath: string,
): { absPath: string; dbFilePath: string } {
  return resolveProjectPathUnderRoot(projectRoot, normalizeToDbPath, inputPath, { allowRoot: false });
}

export function resolveCodexTextPath(inputPath: string): { absPath: string; displayPath: string; allowedRoot: string } {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("[VectorMind] path is required");
  const uriPath = trimmed.startsWith("file:") ? parseFileUriToPath(trimmed) : null;
  const absPath = path.resolve(uriPath ?? trimmed);
  const allowedRoot = getAllowedCodexTextRoots().find((root) => {
    const rel = path.relative(root, absPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  if (!allowedRoot) {
    throw new Error(
      `[VectorMind] Path must be under one of the allowed local text roots: ${getAllowedCodexTextRoots().join(", ")}`,
    );
  }
  return { absPath, displayPath: absPath, allowedRoot };
}

function isHiddenBaseName(name: string): boolean {
  return name.startsWith(".") && name !== "." && name !== "..";
}

export function normalizeExtensionsFilter(values: string[] | undefined): string[] | null {
  if (!values?.length) return null;
  const normalized = values
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .map((v) => (v.startsWith(".") ? v : `.${v}`));
  return normalized.length ? Array.from(new Set(normalized)) : null;
}

export async function readTextFileLines(opts: {
  absPath: string;
  fromLine: number;
  toLine: number;
  maxLines: number;
  maxChars: number;
}): Promise<{ text: string; returned: number; truncated: boolean }> {
  let lineNo = 0;
  const lines: string[] = [];
  let totalChars = 0;
  let truncated = false;

  const stream = fs.createReadStream(opts.absPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < opts.fromLine) continue;
      if (lineNo > opts.toLine) break;

      const rendered = `${lineNo}:${line}`;
      totalChars += rendered.length + 1;
      if (lines.length >= opts.maxLines || totalChars > opts.maxChars) {
        truncated = true;
        break;
      }

      lines.push(rendered);
    }
  } finally {
    try {
      rl.close();
    } catch {}
    try {
      stream.destroy();
    } catch {}
  }

  return { text: lines.join("\n"), returned: lines.length, truncated };
}

export function readTextFileSlice(opts: {
  absPath: string;
  offset: number;
  maxChars: number;
  maxFileBytes: number;
}): { text: string; totalChars: number; returnedChars: number; truncated: boolean } {
  const st = fs.statSync(opts.absPath);
  if (!st.isFile()) throw new Error("Not a file");
  if (st.size > opts.maxFileBytes) {
    throw new Error(
      `File is too large for raw text read (${st.size} bytes > limit ${opts.maxFileBytes}). Use read_file_lines instead.`,
    );
  }

  const text = fs.readFileSync(opts.absPath, "utf8");
  const totalChars = text.length;
  const safeOffset = Math.min(opts.offset, totalChars);
  const slice = text.slice(safeOffset, safeOffset + opts.maxChars);
  const returnedChars = slice.length;
  const truncated = safeOffset + returnedChars < totalChars;
  return { text: slice, totalChars, returnedChars, truncated };
}

export type ProjectFileListEntry = {
  path: string;
  kind: "file" | "dir";
  depth: number;
  size?: number;
  mtime?: string;
};

export function listProjectFilesInternal(opts: {
  startAbsPath: string;
  startDbPath: string;
  recursive: boolean;
  maxDepth: number;
  includeFiles: boolean;
  includeDirs: boolean;
  includeHidden: boolean;
  respectIgnore: boolean;
  includePaths: string[] | null;
  excludePaths: string[] | null;
  extensions: string[] | null;
  maxResults: number;
  includeStats: boolean;
  normalizeToDbPath: (inputPath: string) => string;
}): { entries: ProjectFileListEntry[]; returned: number; scanned: number; truncated: boolean } {
  const entries: ProjectFileListEntry[] = [];
  let scanned = 0;
  let truncated = false;

  const pushEntry = (entry: ProjectFileListEntry): void => {
    if (entries.length >= opts.maxResults) {
      truncated = true;
      return;
    }
    entries.push(entry);
  };

  const startStat = fs.statSync(opts.startAbsPath);
  if (startStat.isFile()) {
    const relPath = opts.startDbPath;
    if ((!opts.respectIgnore || !shouldIgnoreDbFilePath(relPath)) && passesPathFilters(relPath, opts.includePaths, opts.excludePaths)) {
      const ext = path.extname(relPath).toLowerCase();
      if (!opts.extensions || opts.extensions.includes(ext)) {
        pushEntry({
          path: relPath,
          kind: "file",
          depth: 0,
          ...(opts.includeStats ? { size: startStat.size, mtime: startStat.mtime.toISOString() } : {}),
        });
      }
    }
    return { entries, returned: entries.length, scanned: 1, truncated };
  }

  const effectiveMaxDepth = opts.recursive ? opts.maxDepth : 1;
  const stack: Array<{ absPath: string; depth: number }> = [{ absPath: opts.startAbsPath, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(current.absPath, { withFileTypes: true });
    } catch {
      continue;
    }

    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (let idx = dirEntries.length - 1; idx >= 0; idx -= 1) {
      const child = dirEntries[idx];
      if (!child) continue;
      if (!opts.includeHidden && isHiddenBaseName(child.name)) continue;

      const childAbs = path.join(current.absPath, child.name);
      const childRel = opts.normalizeToDbPath(childAbs);
      if (opts.respectIgnore && shouldIgnoreDbFilePath(childRel)) continue;

      scanned += 1;
      const childDepth = current.depth + 1;
      const matchesPath = passesPathFilters(childRel, opts.includePaths, opts.excludePaths);

      if (child.isDirectory()) {
        if (opts.includeDirs && matchesPath) {
          let stats: fs.Stats | null = null;
          if (opts.includeStats) {
            try {
              stats = fs.statSync(childAbs);
            } catch {
              stats = null;
            }
          }
          pushEntry({
            path: childRel,
            kind: "dir",
            depth: childDepth,
            ...(stats ? { size: stats.size, mtime: stats.mtime.toISOString() } : {}),
          });
          if (truncated) break;
        }
        if (childDepth < effectiveMaxDepth) {
          stack.push({ absPath: childAbs, depth: childDepth });
        }
        continue;
      }

      if (!child.isFile()) continue;
      if (!opts.includeFiles || !matchesPath) continue;
      const ext = path.extname(childRel).toLowerCase();
      if (opts.extensions && !opts.extensions.includes(ext)) continue;

      let stats: fs.Stats | null = null;
      if (opts.includeStats) {
        try {
          stats = fs.statSync(childAbs);
        } catch {
          stats = null;
        }
      }
      pushEntry({
        path: childRel,
        kind: "file",
        depth: childDepth,
        ...(stats ? { size: stats.size, mtime: stats.mtime.toISOString() } : {}),
      });
      if (truncated) break;
    }
    if (truncated) break;
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, returned: entries.length, scanned, truncated };
}
