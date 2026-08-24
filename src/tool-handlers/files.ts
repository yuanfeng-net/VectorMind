import fs from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import type { SymbolRow } from "../types.js";
import { GrepArgsSchema, ListProjectFilesArgsSchema, QueryCodebaseArgsSchema, ReadCodexTextFileArgsSchema, ReadFileLinesArgsSchema, ReadFileTextArgsSchema } from "../tool-schemas.js";
import { buildCrossProjectPathWarnings, buildFileReadDevelopmentWarnings, buildMatchedFileDevelopmentWarnings } from "../development-warnings.js";
import { hasUppercaseAscii, runIndexedGrepSearch, runRipgrepSearch } from "../grep.js";
import { toolCompactOrJson } from "../token-savings.js";
import { buildFtsMatchQuery } from "../memory-recall.js";
import { logActivity } from "../activity-log.js";
import { listProjectFilesInternal, normalizeExtensionsFilter, readTextFileLines, readTextFileSlice, resolveCodexTextPath, resolveProjectPathUnderRoot, resolveReadPathUnderProjectRoot } from "../project-files.js";
import { shouldIgnoreDbFilePath } from "../path-rules.js";
import { scanUntrustedContent, scanUntrustedFiles, scanUntrustedFragment } from "../security-signals.js";
import { compactGrepText, compactListProjectFilesText, compactQueryCodebaseText, compactReadFileLinesText, compactReadTextFileText, toolJson } from "../tool-output.js";
export async function handleGrep(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const db = context.getDb();
  const projectRoot = context.getProjectRoot();
  const ftsAvailable = context.isFtsAvailable();
  const FTS_TABLE_NAME = context.ftsTableName;
  const escapeLike = context.escapeLike;

  const args = GrepArgsSchema.parse(rawArgs);
  const q = args.query;
  const mode = args.mode;
  const smartCase = args.smart_case;
  const kinds = args.kinds?.length ? args.kinds : (["code_chunk", "doc_chunk"] as string[]);
  const includePaths = args.include_paths?.length ? args.include_paths : null;
  const excludePaths = args.exclude_paths?.length ? args.exclude_paths : null;
  const maxResults = args.max_results;
  const development_warnings = [
    ...buildCrossProjectPathWarnings(includePaths),
    ...buildCrossProjectPathWarnings(excludePaths),
  ];

  const caseSensitive =
    args.case_sensitive ?? (smartCase ? hasUppercaseAscii(q) : true);
  const ripgrepResult = runRipgrepSearch({
    projectRoot,
    query: q,
    mode,
    smartCase,
    caseSensitive,
    includePaths,
    excludePaths,
    maxResults,
  });

  if (ripgrepResult.ok) {
    const grepDevelopmentWarnings = [
      ...development_warnings,
      ...buildMatchedFileDevelopmentWarnings(ripgrepResult.matches.map((m) => m.file_path)),
    ];
    logActivity("grep", {
      backend: ripgrepResult.backend,
      rg_command: ripgrepResult.rg_command,
      query: q,
      mode,
      case_sensitive: caseSensitive,
      smart_case: smartCase,
      include_paths: includePaths ?? [],
      exclude_paths: excludePaths ?? [],
      matches: ripgrepResult.matches.length,
      total_matches: ripgrepResult.total_matches,
      truncated: ripgrepResult.truncated,
      development_warnings: grepDevelopmentWarnings.length,
    });

    const outputValue = {
      ok: true,
      backend: ripgrepResult.backend,
      rg_command: ripgrepResult.rg_command,
      query: q,
      mode,
      case_sensitive: caseSensitive,
      smart_case: smartCase,
      include_paths: includePaths ?? [],
      exclude_paths: excludePaths ?? [],
      matches: ripgrepResult.matches,
      total_matches: ripgrepResult.total_matches,
      truncated: ripgrepResult.truncated,
      development_warnings: grepDevelopmentWarnings,
      security_scan: scanUntrustedFiles(projectRoot, ripgrepResult.matches.map((match) => match.file_path)),
    };

    return {
      content: [
        {
          type: "text",
          text: toolCompactOrJson("grep", outputValue, compactGrepText(outputValue), args.format),
        },
      ],
    };
  }

  if (!ripgrepResult.unavailable) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            backend: "ripgrep",
            error: ripgrepResult.error,
            rg_command: ripgrepResult.rg_command,
            exit_status: ripgrepResult.exit_status,
            query: q,
            mode,
          }),
        },
      ],
    };
  }

  let indexedResult: ReturnType<typeof runIndexedGrepSearch>;
  try {
    indexedResult = runIndexedGrepSearch({
      db,
      ftsAvailable,
      ftsTableName: FTS_TABLE_NAME,
      buildFtsMatchQuery,
      escapeLike,
      query: q,
      mode,
      smartCase,
      caseSensitive,
      literalHint: args.literal_hint,
      kinds,
      includePaths,
      excludePaths,
      maxResults,
      maxCandidates: args.max_candidates,
    });
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            backend: "indexed_fallback",
            fallback_reason: "ripgrep_unavailable",
            ripgrep_error: ripgrepResult.error,
            ripgrep_attempts: ripgrepResult.attempts,
            error: String(err),
            query: q,
            mode,
            literal_hint: args.literal_hint,
          }),
        },
      ],
    };
  }

  const grepDevelopmentWarnings = [
    ...development_warnings,
    ...buildMatchedFileDevelopmentWarnings(indexedResult.matches.map((m) => m.file_path)),
  ];
  logActivity("grep", {
    backend: indexedResult.backend,
    fallback_reason: "ripgrep_unavailable",
    ripgrep_error: ripgrepResult.error,
    query: q,
    mode,
    case_sensitive: caseSensitive,
    smart_case: smartCase,
    hint: indexedResult.hint,
    kinds,
    include_paths: includePaths ?? [],
    exclude_paths: excludePaths ?? [],
    candidates: indexedResult.candidates.total,
    candidates_scanned: indexedResult.candidates.scanned,
    matches: indexedResult.matches.length,
    truncated: indexedResult.truncated,
    development_warnings: grepDevelopmentWarnings.length,
  });

  const outputValue = {
    ok: true,
    backend: indexedResult.backend,
    fallback_reason: "ripgrep_unavailable",
    ripgrep_error: ripgrepResult.error,
    ripgrep_attempts: ripgrepResult.attempts,
    query: q,
    mode,
    case_sensitive: caseSensitive,
    smart_case: smartCase,
    hint: indexedResult.hint,
    kinds,
    include_paths: includePaths ?? [],
    exclude_paths: excludePaths ?? [],
    candidates: indexedResult.candidates,
    matches: indexedResult.matches,
    truncated: indexedResult.truncated,
    development_warnings: grepDevelopmentWarnings,
    security_scan: scanUntrustedFiles(projectRoot, indexedResult.matches.map((match) => match.file_path)),
  };

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson("grep", outputValue, compactGrepText(outputValue), args.format),
      },
    ],
  };
}
export async function handleListProjectFiles(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const projectRoot = context.getProjectRoot();
  const normalizeToDbPath = context.normalizeToDbPath;

  const args = ListProjectFilesArgsSchema.parse(rawArgs);
  const resolved = resolveProjectPathUnderRoot(projectRoot, normalizeToDbPath, args.path, { allowRoot: true });

  let st: fs.Stats;
  try {
    st = fs.statSync(resolved.absPath);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({ ok: false, error: `Path not found: ${String(err)}` }) }],
    };
  }

  const includePaths = args.include_paths?.length ? args.include_paths : null;
  const excludePaths = args.exclude_paths?.length ? args.exclude_paths : null;
  const extensions = normalizeExtensionsFilter(args.extensions);
  const result = listProjectFilesInternal({
    normalizeToDbPath,
    startAbsPath: resolved.absPath,
    startDbPath: resolved.dbFilePath,
    recursive: args.recursive,
    maxDepth: args.max_depth,
    includeFiles: args.include_files,
    includeDirs: args.include_dirs,
    includeHidden: args.include_hidden,
    respectIgnore: args.respect_ignore,
    includePaths,
    excludePaths,
    extensions,
    maxResults: args.max_results,
    includeStats: args.include_stats,
  });

  logActivity("list_project_files", {
    path: resolved.dbFilePath,
    recursive: args.recursive,
    max_depth: args.max_depth,
    include_files: args.include_files,
    include_dirs: args.include_dirs,
    include_hidden: args.include_hidden,
    respect_ignore: args.respect_ignore,
    include_paths: includePaths ?? [],
    exclude_paths: excludePaths ?? [],
    extensions: extensions ?? [],
    returned: result.returned,
    scanned: result.scanned,
    truncated: result.truncated,
    path_kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other",
  });

  const outputValue = {
    ok: true,
    path: resolved.dbFilePath,
    path_kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other",
    recursive: args.recursive,
    max_depth: args.recursive ? args.max_depth : 1,
    include_files: args.include_files,
    include_dirs: args.include_dirs,
    include_hidden: args.include_hidden,
    respect_ignore: args.respect_ignore,
    include_paths: includePaths ?? [],
    exclude_paths: excludePaths ?? [],
    extensions: extensions ?? [],
    returned: result.returned,
    scanned: result.scanned,
    truncated: result.truncated,
    entries: result.entries,
  };

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson(
          "list_project_files",
          outputValue,
          compactListProjectFilesText(outputValue),
          args.format,
        ),
      },
    ],
  };
}
export async function handleReadFileText(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const projectRoot = context.getProjectRoot();
  const normalizeToDbPath = context.normalizeToDbPath;

  const args = ReadFileTextArgsSchema.parse(rawArgs);
  const resolved = resolveReadPathUnderProjectRoot(projectRoot, normalizeToDbPath, args.path);

  let st: fs.Stats;
  try {
    st = fs.statSync(resolved.absPath);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({ ok: false, error: `File not found: ${String(err)}` }) }],
    };
  }
  if (!st.isFile()) {
    return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not a file" }) }] };
  }

  let result: { text: string; totalChars: number; returnedChars: number; truncated: boolean };
  try {
    result = readTextFileSlice({
      absPath: resolved.absPath,
      offset: args.offset,
      maxChars: args.max_chars,
      maxFileBytes: args.max_file_bytes,
    });
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: String(err) }) }] };
  }

  logActivity("read_file_text", {
    file_path: resolved.dbFilePath,
    offset: args.offset,
    returned_chars: result.returnedChars,
    total_chars: result.totalChars,
    truncated: result.truncated,
  });

  const development_warnings = buildFileReadDevelopmentWarnings(resolved.dbFilePath, resolved.absPath, st);
  const outputValue = {
    ok: true,
    file_path: resolved.dbFilePath,
    offset: args.offset,
    returned_chars: result.returnedChars,
    total_chars: result.totalChars,
    truncated: result.truncated,
    development_warnings,
    security_scan: args.offset === 0 && !result.truncated ? scanUntrustedContent(result.text) : scanUntrustedFragment(result.text),
    text: result.text,
  };

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson("read_file_text", outputValue, compactReadTextFileText(outputValue), args.format),
      },
    ],
  };
}
export async function handleReadCodexTextFile(
  rawArgs: Record<string, unknown>,
  _context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = ReadCodexTextFileArgsSchema.parse(rawArgs);

  let resolved: { absPath: string; displayPath: string; allowedRoot: string };
  try {
    resolved = resolveCodexTextPath(args.path);
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: String(err) }) }] };
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(resolved.absPath);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({ ok: false, error: `File not found: ${String(err)}` }) }],
    };
  }
  if (!st.isFile()) {
    return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not a file" }) }] };
  }

  let result: { text: string; totalChars: number; returnedChars: number; truncated: boolean };
  try {
    result = readTextFileSlice({
      absPath: resolved.absPath,
      offset: args.offset,
      maxChars: args.max_chars,
      maxFileBytes: args.max_file_bytes,
    });
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: String(err) }) }] };
  }

  logActivity("read_codex_text_file", {
    file_path: resolved.displayPath,
    allowed_root: resolved.allowedRoot,
    offset: args.offset,
    returned_chars: result.returnedChars,
    total_chars: result.totalChars,
    truncated: result.truncated,
  });

  const outputValue = {
    ok: true,
    file_path: resolved.displayPath,
    allowed_root: resolved.allowedRoot,
    offset: args.offset,
    returned_chars: result.returnedChars,
    total_chars: result.totalChars,
    truncated: result.truncated,
    security_scan: args.offset === 0 && !result.truncated ? scanUntrustedContent(result.text) : scanUntrustedFragment(result.text),
    text: result.text,
  };

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson(
          "read_codex_text_file",
          outputValue,
          compactReadTextFileText(outputValue),
          args.format,
        ),
      },
    ],
  };
}
export async function handleReadFileLines(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const projectRoot = context.getProjectRoot();
  const normalizeToDbPath = context.normalizeToDbPath;

  const args = ReadFileLinesArgsSchema.parse(rawArgs);
  const resolved = resolveReadPathUnderProjectRoot(projectRoot, normalizeToDbPath, args.path);

  let fromLine = args.from_line;
  let toLine = args.to_line;
  if (toLine == null) {
    const total = args.total_count ?? 200;
    toLine = fromLine + total - 1;
  }
  if (toLine < fromLine) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            error: "to_line must be >= from_line",
            path: args.path,
            from_line: fromLine,
            to_line: toLine,
          }),
        },
      ],
    };
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(resolved.absPath);
  } catch (err) {
    return {
      isError: true,
      content: [
        { type: "text", text: toolJson({ ok: false, error: `File not found: ${String(err)}` }) },
      ],
    };
  }
  if (!st.isFile()) {
    return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not a file" }) }] };
  }

  const maxLines = Math.max(1, Math.min(2000, args.max_lines));
  const maxChars = Math.max(200, Math.min(200_000, args.max_chars));

  const result = await readTextFileLines({
    absPath: resolved.absPath,
    fromLine,
    toLine,
    maxLines,
    maxChars,
  });

  logActivity("read_file_lines", {
    file_path: resolved.dbFilePath,
    from_line: fromLine,
    to_line: toLine,
    returned: result.returned,
    truncated: result.truncated,
  });

  const development_warnings = buildFileReadDevelopmentWarnings(resolved.dbFilePath, resolved.absPath, st);
  const outputValue = {
    ok: true,
    file_path: resolved.dbFilePath,
    from_line: fromLine,
    to_line: toLine,
    returned: result.returned,
    truncated: result.truncated,
    development_warnings,
    security_scan: fromLine === 1 && !result.truncated ? scanUntrustedContent(result.text) : scanUntrustedFragment(result.text),
    text: result.text,
  };

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson("read_file_lines", outputValue, compactReadFileLinesText(outputValue), args.format),
      },
    ],
  };
}
export async function handleQueryCodebase(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const escapeLike = context.escapeLike;
  const { searchSymbolsStmt } = context.getStatements();

  const args = QueryCodebaseArgsSchema.parse(rawArgs);
  const q = args.query.trim();
  const escaped = escapeLike(q);
  const like = `%${escaped}%`;
  const rows = searchSymbolsStmt.all(like, like, q, like, 250) as SymbolRow[];
  const filtered = rows.filter((r) => !shouldIgnoreDbFilePath(r.file_path)).slice(0, 50);
  const development_warnings = buildMatchedFileDevelopmentWarnings(filtered.map((m) => m.file_path));

  logActivity("query_codebase", {
    query: q,
    matches: filtered.length,
    development_warnings: development_warnings.length,
    sample: filtered.slice(0, 10).map((m) => ({ name: m.name, type: m.type, file_path: m.file_path })),
  });

  const outputValue = {
    ok: true,
    query: q,
    matches: filtered,
    development_warnings,
    security_scan: scanUntrustedContent(filtered.map((match) => `${match.name} ${match.signature ?? ""}`).join("\n")),
  };

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson("query_codebase", outputValue, compactQueryCodebaseText(outputValue), args.format),
      },
    ],
  };
}
