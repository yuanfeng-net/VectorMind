#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import * as readline from "node:readline";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import chokidar, { type FSWatcher } from "chokidar";
import Database from "better-sqlite3";
import { z } from "zod";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BUILTIN_CONVENTIONS } from "./builtin-conventions.js";
import {
  BUILTIN_ARCHITECTURE_AND_CODE_ORGANIZATION_INSTRUCTIONS,
  BUILTIN_DESTRUCTIVE_OPERATION_GUARD_INSTRUCTIONS,
  BUILTIN_LOW_OVERHEAD_WORKFLOW_INSTRUCTIONS,
  BUILTIN_PAYLOAD_GUARD_INSTRUCTIONS,
  BUILTIN_PLAN_LITE_INSTRUCTIONS,
  BUILTIN_THREAD_HANDOFF_SWITCH_INSTRUCTIONS,
  BUILTIN_WRITE_POLICY_INSTRUCTIONS,
} from "./builtin-instructions.js";

type RequirementRow = {
  id: number;
  title: string;
  status: string;
  context_data: string | null;
  created_at: string;
};

type ChangeLogRow = {
  id: number;
  req_id: number;
  file_path: string;
  intent_summary: string;
  timestamp: string;
};

type SymbolRow = {
  name: string;
  type: string;
  file_path: string;
  signature: string | null;
};

type MemoryItemRow = {
  id: number;
  kind: string;
  title: string | null;
  content: string;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  req_id: number | null;
  metadata_json: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
};

type ExtractedSymbol = {
  name: string;
  type: string;
  signature: string;
};

const SERVER_NAME = "vector-mind";
const SERVER_VERSION = "1.0.37";

type RootSource = "tool_arg" | "env" | "mcp_roots" | "cwd" | "fallback";

const rootFromEnv = process.env.VECTORMIND_ROOT?.trim() ?? "";

const prettyJsonOutput = ["1", "true", "on", "yes"].includes(
  (process.env.VECTORMIND_PRETTY_JSON ?? "").trim().toLowerCase(),
);

const debugLogEnabled = ["1", "true", "on", "yes"].includes(
  (process.env.VECTORMIND_DEBUG_LOG ?? "").trim().toLowerCase(),
);
const debugLogMaxEntries = (() => {
  const raw = process.env.VECTORMIND_DEBUG_LOG_MAX?.trim();
  if (!raw) return 200;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(5000, n);
})();

const PENDING_FLUSH_MS = (() => {
  const raw = process.env.VECTORMIND_PENDING_FLUSH_MS?.trim();
  if (!raw) return 200;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 200;
  return n;
})();

const PENDING_TTL_DAYS = (() => {
  const raw = process.env.VECTORMIND_PENDING_TTL_DAYS?.trim();
  if (!raw) return 30;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 30;
  return n;
})();

const PENDING_MAX_ENTRIES = (() => {
  const raw = process.env.VECTORMIND_PENDING_MAX?.trim();
  if (!raw) return 5000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 5000;
  return n;
})();

const PENDING_PRUNE_EVERY = (() => {
  const raw = process.env.VECTORMIND_PENDING_PRUNE_EVERY?.trim();
  if (!raw) return 500;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 500;
  return n;
})();

const RIPGREP_RESOLVE_TIMEOUT_MS = 5_000;
const RIPGREP_SEARCH_TIMEOUT_MS = 30_000;
const RIPGREP_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

let cachedRipgrepCommand: string | null | undefined;
let cachedRipgrepResolveError: string | null = null;

function getCodexHomeDir(): string {
  const raw = process.env.CODEX_HOME?.trim();
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), ".codex");
}

function getAgentsHomeDir(): string {
  const raw = process.env.AGENTS_HOME?.trim();
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), ".agents");
}

function getAllowedCodexTextRoots(): string[] {
  const codexHome = getCodexHomeDir();
  const agentsHome = getAgentsHomeDir();
  return Array.from(
    new Set(
      [
        path.join(codexHome, "skills"),
        path.join(codexHome, "prompts"),
        path.join(codexHome, "rules"),
        path.join(agentsHome, "skills"),
      ].map((p) => path.resolve(p)),
    ),
  );
}

const INDEX_MAX_CODE_BYTES = (() => {
  const raw = process.env.VECTORMIND_INDEX_MAX_CODE_BYTES?.trim();
  if (!raw) return 400_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 400_000;
  return n;
})();

const INDEX_MAX_DOC_BYTES = (() => {
  const raw = process.env.VECTORMIND_INDEX_MAX_DOC_BYTES?.trim();
  if (!raw) return 600_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 600_000;
  return n;
})();

const INDEX_SKIP_MINIFIED = (() => {
  const raw = (process.env.VECTORMIND_INDEX_SKIP_MINIFIED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "on", "yes"].includes(raw);
})();

const INDEX_AUTO_PRUNE_IGNORED = (() => {
  const raw = (process.env.VECTORMIND_INDEX_AUTO_PRUNE_IGNORED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "on", "yes"].includes(raw);
})();

const ROOTS_LIST_TIMEOUT_MS = (() => {
  const raw = process.env.VECTORMIND_ROOTS_TIMEOUT_MS?.trim();
  if (!raw) return 750;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 750;
  return n;
})();

const BOOTSTRAP_SEMANTIC_TIMEOUT_MS = (() => {
  const raw = process.env.VECTORMIND_SEMANTIC_TIMEOUT_MS?.trim();
  if (!raw) return 2500;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 2500;
  return n;
})();

let initialized = false;
let rootSource: RootSource = "cwd";
let projectRoot = "";
let dbPath = "";

let db: Database.Database;
let watcher: FSWatcher | null = null;
let watcherReady = false;
let initializationPromise: Promise<void> | null = null;

let insertRequirementStmt: Database.Statement;
let getActiveRequirementStmt: Database.Statement;
let listRecentRequirementsStmt: Database.Statement;
let completeAllActiveRequirementsStmt: Database.Statement;
let completeRequirementByIdStmt: Database.Statement;
let completeAllActiveRequirementMemoryItemsStmt: Database.Statement;
let completeRequirementMemoryItemByReqIdStmt: Database.Statement;
let listChangeLogsForRequirementStmt: Database.Statement;
let insertChangeLogStmt: Database.Statement;
let insertMemoryItemStmt: Database.Statement;
let getMemoryItemByIdStmt: Database.Statement;
let getRequirementMemoryItemIdStmt: Database.Statement;
let getConventionByKeyStmt: Database.Statement;
let insertConventionStmt: Database.Statement;
let updateConventionByIdStmt: Database.Statement;
let listConventionsStmt: Database.Statement;
let upsertProjectSummaryStmt: Database.Statement;
let getProjectSummaryStmt: Database.Statement;
let listRecentNotesStmt: Database.Statement;
let deleteFileChunkItemsStmt: Database.Statement;
let getEmbeddingMetaStmt: Database.Statement;
let upsertEmbeddingStmt: Database.Statement;
let upsertPendingChangeStmt: Database.Statement;
let listPendingChangesStmt: Database.Statement;
let listPendingChangesPageStmt: Database.Statement;
let countPendingChangesStmt: Database.Statement;
let deletePendingChangeStmt: Database.Statement;
let deleteAllPendingChangesStmt: Database.Statement;
let deleteOldPendingChangesStmt: Database.Statement | null = null;
let deleteOldestPendingChangesStmt: Database.Statement | null = null;
let deleteSymbolsForFileStmt: Database.Statement;
let upsertSymbolStmt: Database.Statement;
let searchSymbolsStmt: Database.Statement;

let indexFileSymbolsTx:
  | ((filePath: string, symbols: ExtractedSymbol[]) => void)
  | null = null;

type ActivityEvent = {
  id: number;
  ts: string;
  type: string;
  project_root: string;
  data: Record<string, unknown>;
};

let activitySeq = 0;
const activityLog: ActivityEvent[] = [];

function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[max-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const sliced = value.slice(0, 20).map((v) => sanitizeForLog(v, depth + 1));
    return value.length > 20 ? [...sliced, `[+${value.length - 20} more]`] : sliced;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).slice(0, 40);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = sanitizeForLog(obj[k], depth + 1);
    if (Object.keys(obj).length > 40) out["__more_keys__"] = Object.keys(obj).length - 40;
    return out;
  }
  try {
    return String(value);
  } catch {
    return "[unserializable]";
  }
}

function logActivity(type: string, data: Record<string, unknown>): void {
  if (!debugLogEnabled) return;
  activityLog.push({
    id: ++activitySeq,
    ts: new Date().toISOString(),
    type,
    project_root: projectRoot || "",
    data: sanitizeForLog(data) as Record<string, unknown>,
  });
  while (activityLog.length > debugLogMaxEntries) activityLog.shift();
}

function snapshotActivityLog(opts: { sinceId: number; limit: number }): { events: ActivityEvent[]; last_id: number } {
  const sinceId = Math.max(0, opts.sinceId);
  const limit = Math.max(1, Math.min(500, opts.limit));
  const lastId = activitySeq;
  const events = activityLog.filter((e) => e.id > sinceId).slice(0, limit);
  return { events, last_id: lastId };
}

function clearActivityLog(): void {
  activityLog.length = 0;
  activitySeq = 0;
}

function summarizeActivityEvent(e: ActivityEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case "index_file":
      return `index ${String(d.file_path ?? "")} reason=${String(d.reason ?? "")} symbols=${String(
        d.symbols ?? "",
      )} chunks=${String(d.chunks ?? "")}`;
    case "remove_file":
      return `remove ${String(d.file_path ?? "")}`;
    case "pending_flush":
      return `pending_flush entries=${String(d.entries ?? "")}`;
    case "pending_prune":
      return `pending_prune ${String(d.before ?? "")}->${String(d.after ?? "")}`;
    case "bootstrap_context":
      return `bootstrap q=${String(d.query ?? "")} pending=${String(d.pending_returned ?? "")}/${String(
        d.pending_total ?? "",
      )} reqs=${String(d.requirements_returned ?? "")} semantic=${String(d.semantic_mode ?? "")}+${
        String(d.semantic_matches ?? "")
      }`;
    case "get_brain_dump":
      return `brain_dump pending=${String(d.pending_returned ?? "")}/${String(d.pending_total ?? "")} reqs=${String(
        d.requirements_returned ?? "",
      )} notes=${String(d.notes_returned ?? "")}`;
    case "get_pending_changes":
      return `pending_list returned=${String(d.returned ?? "")} total=${String(d.total ?? "")}`;
    case "semantic_search":
      return `semantic_search mode=${String(d.mode ?? "")} q=${String(d.query ?? "")} matches=${String(
        d.matches ?? "",
      )}`;
    case "grep":
      return `grep backend=${String(d.backend ?? "")} q=${String(d.query ?? "")} matches=${String(
        d.matches ?? "",
      )} truncated=${String(d.truncated ?? "")}`;
    case "query_codebase":
      return `query_codebase q=${String(d.query ?? "")} matches=${String(d.matches ?? "")}`;
    case "read_file_lines":
      return `read_file_lines file=${String(d.file_path ?? "")} returned=${String(d.returned ?? "")} truncated=${String(
        d.truncated ?? "",
      )}`;
    case "read_file_text":
      return `read_file_text file=${String(d.file_path ?? "")} returned=${String(d.returned_chars ?? "")}/${String(
        d.total_chars ?? "",
      )} truncated=${String(d.truncated ?? "")}`;
    case "list_project_files":
      return `list_project_files path=${String(d.path ?? "")} returned=${String(d.returned ?? "")} scanned=${String(
        d.scanned ?? "",
      )} truncated=${String(d.truncated ?? "")}`;
    case "read_codex_text_file":
      return `read_codex_text_file file=${String(d.file_path ?? "")} returned=${String(
        d.returned_chars ?? "",
      )}/${String(d.total_chars ?? "")} truncated=${String(d.truncated ?? "")}`;
    case "start_requirement":
      return `start_requirement #${String(d.req_id ?? "")} ${String(d.title ?? "")}`;
    case "sync_change_intent":
      return `sync_change_intent #${String(d.req_id ?? "")} files=${String(d.files_total ?? "")}`;
    case "complete_requirement":
      return `complete_requirement ${String(d.all_active ? "all_active" : d.req_id ?? "")}`;
    default:
      return e.type;
  }
}

const FTS_TABLE_NAME = "memory_items_fts";
let ftsAvailable = false;

function isProbablyVscodeInstallDir(dir: string): boolean {
  const lower = dir.replace(/\\/g, "/").toLowerCase();
  return lower.includes("/microsoft vs code");
}

function isProbablySystemDir(dir: string): boolean {
  if (process.platform !== "win32") return false;
  const candidate = path.resolve(dir);
  const sysRootRaw = process.env.SystemRoot?.trim();
  const sysRoot = sysRootRaw ? path.resolve(sysRootRaw) : null;
  if (sysRoot) {
    const rel = path.relative(sysRoot, candidate);
    if (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  const windowsFallback = path.resolve("C:\\Windows");
  {
    const rel = path.relative(windowsFallback, candidate);
    if (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  const programFiles = [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    process.env["ProgramW6432"],
  ].filter(Boolean) as string[];
  for (const pf of programFiles) {
    const rel = path.relative(path.resolve(pf), candidate);
    if (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

function getVsCodeUserDirCandidate(): string | null {
  const platform = process.platform;
  if (platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    const roaming = appData || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(roaming, "Code", "User");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Code", "User");
  }
  return path.join(os.homedir(), ".config", "Code", "User");
}

function resolveSafeFallbackRootDir(): string {
  const candidate = getVsCodeUserDirCandidate();
  if (candidate) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const st = fs.statSync(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      // ignore
    }
  }
  return os.homedir();
}

function parseFileUriToPath(uri: string): string | null {
  try {
    return fileURLToPath(new URL(uri));
  } catch {
    return null;
  }
}

function isProjectRootMarkerPresent(dir: string): boolean {
  const markers = [
    ".git",
    ".hg",
    ".svn",
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "tsconfig.json",
    "pyproject.toml",
    "requirements.txt",
    "Pipfile",
    "poetry.lock",
    "go.mod",
    "Cargo.toml",
    "Cargo.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
  ];

  for (const m of markers) {
    try {
      if (fs.existsSync(path.join(dir, m))) return true;
    } catch {
      // ignore
    }
  }

  // Visual Studio solutions: check for any *.sln at this level.
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.toLowerCase().endsWith(".sln")) return true;
    }
  } catch {
    // ignore
  }

  return false;
}

function findNearestProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 50; i++) {
    if (isProjectRootMarkerPresent(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

function resolveRootFromToolArgOrThrow(raw: unknown): { root: string; source: RootSource } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const uriPath = trimmed.startsWith("file:") ? parseFileUriToPath(trimmed) : null;
  const abs = path.resolve(uriPath ?? trimmed);
  const parent = path.dirname(abs);
  let startDir: string;
  try {
    const st = fs.statSync(abs);
    startDir = st.isDirectory() ? abs : parent;
  } catch {
    // If the user provided a file path that doesn't exist yet, accept its parent directory.
    try {
      const st2 = fs.statSync(parent);
      if (!st2.isDirectory()) throw new Error("parent is not a directory");
      startDir = parent;
    } catch (err) {
      throw new Error(`[VectorMind] Invalid project_root: ${abs}. (${String(err)})`);
    }
  }

  const root = findNearestProjectRoot(startDir);
  try {
    const st = fs.statSync(root);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch (err) {
    throw new Error(`[VectorMind] Invalid project_root: ${root}. (${String(err)})`);
  }

  return { root, source: "tool_arg" };
}

function resolveRootFromEnvOrThrow(): { root: string; source: RootSource } | null {
  if (!rootFromEnv) return null;
  const abs = path.resolve(rootFromEnv);
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch (err) {
    throw new Error(
      `[VectorMind] Invalid VECTORMIND_ROOT: ${abs}. Set it to an existing project directory. (${String(err)})`,
    );
  }
  return { root: abs, source: "env" };
}

function normalizeToDbPath(inputPath: string): string {
  const abs = path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath);
  const rel = path.relative(projectRoot, abs);
  const inCwd = !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  const candidate = inCwd ? rel : abs;
  return candidate.replace(/\\/g, "/");
}

const IGNORED_PATH_SEGMENTS = new Set(
  [
    // VCS / tooling
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",

    // VectorMind artifacts
    ".vectormind",

    // Node ecosystem
    "node_modules",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".nx",
    ".cache",
    ".parcel-cache",

    // .NET / VS build artifacts
    "bin",
    "obj",
    ".vs",
    "testresults",

    // General build outputs
    "dist",
    "build",
    "buildfiles",
    "out",
    "target",
    "coverage",
    "artifacts",

    // Python caches/venvs
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "env",
    ".tox",
    ".nox",

    // C/C++ common build dirs
    "cmakefiles",
    "debug",
    "release",
    "x64",
    "x86",
  ].map((s) => s.toLowerCase()),
);

const NOISE_FILE_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".bundle.js",
  ".bundle.css",
  ".chunk.js",
  ".chunk.css",
];

const NOISE_FILE_BASENAMES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
];

const IGNORED_LIKE_PATTERNS = (() => {
  const patterns: string[] = [];
  for (const seg of IGNORED_PATH_SEGMENTS) {
    patterns.push(`${seg}/%`);
    patterns.push(`%/${seg}/%`);
  }
  return patterns;
})();

function pathHasIgnoredSegments(posixPath: string): boolean {
  const segments = posixPath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  for (const seg of segments) {
    if (IGNORED_PATH_SEGMENTS.has(seg)) return true;
  }
  return false;
}

function shouldIgnoreDbFilePath(filePath: string | null): boolean {
  if (!filePath) return false;
  return pathHasIgnoredSegments(filePath);
}

function pruneIgnoredPendingChanges(): void {
  if (!db) return;
  try {
    if (!IGNORED_LIKE_PATTERNS.length) return;
    const where = IGNORED_LIKE_PATTERNS
      .map(() => "LOWER(REPLACE(file_path, '\\\\', '/')) LIKE ?")
      .join(" OR ");
    db.prepare(`DELETE FROM pending_changes WHERE ${where}`).run(...IGNORED_LIKE_PATTERNS);
  } catch (err) {
    console.error("[vectormind] prune pending_changes failed:", err);
  }
}

let pendingEventsSincePrune = 0;

function prunePendingChanges(): void {
  if (!db) return;
  try {
    const before = Number((countPendingChangesStmt.get() as { total: number } | undefined)?.total ?? 0);
    pruneIgnoredPendingChanges();

    if (PENDING_TTL_DAYS > 0) {
      deleteOldPendingChangesStmt?.run(`-${PENDING_TTL_DAYS} days`);
    }

    if (PENDING_MAX_ENTRIES > 0) {
      const total = Number((countPendingChangesStmt.get() as { total: number } | undefined)?.total ?? 0);
      const overflow = total - PENDING_MAX_ENTRIES;
      if (overflow > 0) {
        deleteOldestPendingChangesStmt?.run(overflow);
      }
    }

    const after = Number((countPendingChangesStmt.get() as { total: number } | undefined)?.total ?? 0);
    if (before !== after) {
      logActivity("pending_prune", { before, after });
    }
  } catch (err) {
    console.error("[vectormind] prune pending_changes failed:", err);
  }
}

function pruneIgnoredIndexesByPathPatterns(): { chunks_deleted: number; symbols_deleted: number } {
  if (!db) return { chunks_deleted: 0, symbols_deleted: 0 };
  try {
    if (!IGNORED_LIKE_PATTERNS.length) return { chunks_deleted: 0, symbols_deleted: 0 };
    const where = IGNORED_LIKE_PATTERNS
      .map(() => "LOWER(REPLACE(file_path, '\\\\', '/')) LIKE ?")
      .join(" OR ");

    const chunksDeleted = db
      .prepare(
        `DELETE FROM memory_items
         WHERE file_path IS NOT NULL
           AND (kind = 'code_chunk' OR kind = 'doc_chunk')
           AND (${where})`,
      )
      .run(...IGNORED_LIKE_PATTERNS).changes;

    const symbolsDeleted = db
      .prepare(
        `DELETE FROM symbols
         WHERE file_path IS NOT NULL
           AND (${where})`,
      )
      .run(...IGNORED_LIKE_PATTERNS).changes;

    if (chunksDeleted || symbolsDeleted) {
      logActivity("index_prune", {
        reason: "ignored_paths",
        chunks_deleted: chunksDeleted,
        symbols_deleted: symbolsDeleted,
      });
    }

    return { chunks_deleted: chunksDeleted, symbols_deleted: symbolsDeleted };
  } catch (err) {
    console.error("[vectormind] prune indexes failed:", err);
    return { chunks_deleted: 0, symbols_deleted: 0 };
  }
}

function pruneFilenameNoiseIndexes(): { chunks_deleted: number; symbols_deleted: number } {
  if (!db) return { chunks_deleted: 0, symbols_deleted: 0 };

  try {
    const suffixWhere = NOISE_FILE_SUFFIXES.map(() => "LOWER(file_path) LIKE ?").join(" OR ");
    const baseWhere = NOISE_FILE_BASENAMES.map(() => "LOWER(file_path) LIKE ?").join(" OR ");

    const suffixArgs = NOISE_FILE_SUFFIXES.map((s) => `%${s}`);
    const baseArgs = NOISE_FILE_BASENAMES.map((n) => `%/${n}`);

    const whereParts: string[] = [];
    const args: string[] = [];
    if (suffixWhere) {
      whereParts.push(`(${suffixWhere})`);
      args.push(...suffixArgs);
    }
    if (baseWhere) {
      whereParts.push(`(${baseWhere})`);
      args.push(...baseArgs);
    }
    if (!whereParts.length) return { chunks_deleted: 0, symbols_deleted: 0 };
    const where = whereParts.join(" OR ");

    const chunksDeleted = db
      .prepare(
        `DELETE FROM memory_items
         WHERE file_path IS NOT NULL
           AND (kind = 'code_chunk' OR kind = 'doc_chunk')
           AND (${where})`,
      )
      .run(...args).changes;

    const symbolsDeleted = db
      .prepare(
        `DELETE FROM symbols
         WHERE file_path IS NOT NULL
           AND (${where})`,
      )
      .run(...args).changes;

    if (chunksDeleted || symbolsDeleted) {
      logActivity("index_prune", {
        reason: "filename_noise",
        chunks_deleted: chunksDeleted,
        symbols_deleted: symbolsDeleted,
      });
    }

    return { chunks_deleted: chunksDeleted, symbols_deleted: symbolsDeleted };
  } catch (err) {
    console.error("[vectormind] prune filename noise failed:", err);
    return { chunks_deleted: 0, symbols_deleted: 0 };
  }
}

function shouldIgnorePath(inputPath: string): boolean {
  const normalizedAbs = path.resolve(inputPath);
  const rel = path.relative(projectRoot, normalizedAbs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true;

  const relPosix = rel.replace(/\\/g, "/");
  if (pathHasIgnoredSegments(relPosix)) return true;

  // Backward-compat ignore (pre-1.0.2 stored the DB in repo root)
  if (
    relPosix === ".vectormind.db" ||
    relPosix.startsWith(".vectormind.db-") ||
    relPosix === ".vectormind.db-journal"
  ) {
    return true;
  }

  return false;
}

function isSymbolIndexableFile(filePath: string): boolean {
  if (shouldIgnoreContentFile(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  const allowed = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".cs",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
  ]);
  return allowed.has(ext);
}

function shouldIgnoreContentFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (NOISE_FILE_BASENAMES.includes(base)) return true;
  if (NOISE_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  return false;
}

function looksLikeGeneratedFile(content: string): boolean {
  const head = content.slice(0, 4000).toLowerCase();
  if (head.includes("@generated")) return true;
  if (head.includes("do not edit") && (head.includes("generated") || head.includes("auto-generated"))) {
    return true;
  }
  if (head.includes("this file was generated") && head.includes("do not edit")) return true;
  return false;
}

function looksLikeMinifiedBundle(content: string): boolean {
  if (content.length < 30_000) return false;

  let lines = 1;
  let currentLen = 0;
  let maxLineLen = 0;
  let longLines = 0;

  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 10 /* \\n */) {
      if (currentLen > maxLineLen) maxLineLen = currentLen;
      if (currentLen >= 800) longLines += 1;
      currentLen = 0;
      lines += 1;
      continue;
    }
    currentLen += 1;
  }
  if (currentLen > maxLineLen) maxLineLen = currentLen;
  if (currentLen >= 800) longLines += 1;

  const avgLineLen = content.length / Math.max(1, lines);

  if (lines <= 2 && maxLineLen >= 2000) return true;
  if (maxLineLen >= 6000) return true;
  if (avgLineLen >= 900) return true;
  if (lines <= 10 && longLines >= Math.ceil(lines * 0.6)) return true;

  return false;
}

function getContentChunkKind(filePath: string): "code_chunk" | "doc_chunk" | null {
  const ext = path.extname(filePath).toLowerCase();
  const docExt = new Set([
    ".md",
    ".mdx",
    ".txt",
    ".rst",
    ".adoc",
    ".org",
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".ini",
    ".env",
    ".sql",
  ]);
  if (docExt.has(ext)) return "doc_chunk";
  if (isSymbolIndexableFile(filePath)) return "code_chunk";
  return null;
}

function isContentIndexableFile(filePath: string): boolean {
  if (shouldIgnoreContentFile(filePath)) return false;
  return getContentChunkKind(filePath) !== null;
}

function extractSymbols(filePath: string, content: string): ExtractedSymbol[] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".py") return extractPythonSymbols(content);
  if (ext === ".rs") return extractRustSymbols(content);
  if (ext === ".go") return extractGoSymbols(content);
  if (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".mjs" ||
    ext === ".cjs"
  ) {
    return extractJsTsSymbols(content);
  }
  return extractCLikeSymbols(content);
}

function extractJsTsSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("//")) continue;

    let match: RegExpMatchArray | null;

    match = trimmed.match(/^(export\s+)?(default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (match) {
      symbols.push({ name: match[3], type: "class", signature: trimmed });
      continue;
    }

    match = trimmed.match(
      /^(export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    );
    if (match) {
      symbols.push({ name: match[3], type: "function", signature: trimmed });
      continue;
    }

    match = trimmed.match(/^(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      symbols.push({ name: match[2], type: "interface", signature: trimmed });
      continue;
    }

    match = trimmed.match(/^(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/);
    if (match) {
      symbols.push({ name: match[2], type: "type", signature: trimmed });
      continue;
    }

    match = trimmed.match(/^(export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      symbols.push({ name: match[2], type: "enum", signature: trimmed });
      continue;
    }

    match = trimmed.match(
      /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(.*=>/,
    );
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }

    match = trimmed.match(
      /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?function\s*\(/,
    );
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractPythonSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(/^class\s+([A-Za-z_][\w]*)\b/);
    if (match) {
      symbols.push({ name: match[1], type: "class", signature: trimmed });
      continue;
    }
    match = trimmed.match(/^(async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractRustSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(/^(pub\s+)?(struct|enum|trait)\s+([A-Za-z_][\w]*)\b/);
    if (match) {
      symbols.push({ name: match[3], type: match[2], signature: trimmed });
      continue;
    }
    match = trimmed.match(/^(pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractGoSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/);
    if (match) {
      symbols.push({ name: match[1], type: match[2], signature: trimmed });
      continue;
    }
    match = trimmed.match(/^func\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[1], type: "function", signature: trimmed });
      continue;
    }
    match = trimmed.match(/^func\s+\([^)]*\)\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[1], type: "method", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractCLikeSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*"))
      continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(
      /^(class|struct|interface|enum)\s+([A-Za-z_][\w]*)\b/,
    );
    if (match) {
      symbols.push({ name: match[2], type: match[1], signature: trimmed });
      continue;
    }

    match = trimmed.match(/^[A-Za-z_][\w:<>,\s\*&]*\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[1], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

type TextChunk = { startLine: number; endLine: number; content: string };

function chunkTextByLines(
  content: string,
  opts: { maxChars: number; maxLines: number },
): TextChunk[] {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];

  const chunks: TextChunk[] = [];
  let startLine = 1;
  let currentLines: string[] = [];
  let currentChars = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const nextChars = currentChars + line.length + 1;
    const nextLines = currentLines.length + 1;

    if (currentLines.length > 0 && (nextChars > opts.maxChars || nextLines > opts.maxLines)) {
      const endLine = startLine + currentLines.length - 1;
      chunks.push({ startLine, endLine, content: currentLines.join("\n") });
      startLine = idx + 1;
      currentLines = [];
      currentChars = 0;
    }

    currentLines.push(line);
    currentChars += line.length + 1;
  }

  if (currentLines.length > 0) {
    const endLine = startLine + currentLines.length - 1;
    chunks.push({ startLine, endLine, content: currentLines.join("\n") });
  }

  return chunks;
}

function indexFileContentChunks(
  dbFilePath: string,
  absPath: string,
  content: string,
  reason: IndexReason,
): number {
  const kind = getContentChunkKind(absPath);
  if (!kind) return 0;

  const opts =
    kind === "code_chunk"
      ? { maxChars: 10_000, maxLines: 200 }
      : { maxChars: 14_000, maxLines: 260 };
  const chunks = chunkTextByLines(content, opts);
  const ext = path.extname(absPath).toLowerCase();
  const metadata = safeJson({ ext });

  const tx = db.transaction(() => {
    deleteFileChunkItemsStmt.run(dbFilePath);
    for (const chunk of chunks) {
      const title = `${dbFilePath}#L${chunk.startLine}-L${chunk.endLine}`;
      const contentHash = sha256Hex(chunk.content);
      const info = insertMemoryItemStmt.run(
        kind,
        title,
        chunk.content,
        dbFilePath,
        chunk.startLine,
        chunk.endLine,
        null,
        metadata,
        contentHash,
      );
      const memoryId = Number(info.lastInsertRowid);
      if (shouldEmbedFileChunks(reason)) {
        enqueueEmbedding(memoryId);
      }
    }
  });

  try {
    tx();
  } catch (err) {
    console.error("[vectormind] failed to index file chunks:", dbFilePath, err);
  }
  return chunks.length;
}

type PendingChangeEvent = "add" | "change" | "unlink";

const pendingChangeBuffer = new Map<string, PendingChangeEvent>();
let pendingChangeFlushTimer: NodeJS.Timeout | null = null;

function flushPendingChangeBuffer(): void {
  if (!db) return;
  if (pendingChangeFlushTimer) {
    clearTimeout(pendingChangeFlushTimer);
    pendingChangeFlushTimer = null;
  }
  if (!pendingChangeBuffer.size) return;
  const entries = Array.from(pendingChangeBuffer.entries());
  pendingChangeBuffer.clear();

  try {
    const tx = db.transaction(() => {
      for (const [filePath, event] of entries) {
        upsertPendingChangeStmt.run(filePath, event);
      }
    });
    tx();
  } catch (err) {
    console.error("[vectormind] failed to flush pending change buffer:", err);
  }

  logActivity("pending_flush", {
    entries: entries.length,
    sample: entries.slice(0, 10).map(([file_path, last_event]) => ({ file_path, last_event })),
  });

  pendingEventsSincePrune += entries.length;
  if (pendingEventsSincePrune >= PENDING_PRUNE_EVERY) {
    pendingEventsSincePrune = 0;
    prunePendingChanges();
  }
}

function recordPendingChange(absPath: string, event: PendingChangeEvent): void {
  if (shouldIgnorePath(absPath)) return;
  const track = isSymbolIndexableFile(absPath) || isContentIndexableFile(absPath);
  if (!track) return;
  const filePath = normalizeToDbPath(absPath);
  pendingChangeBuffer.set(filePath, event);
  if (pendingChangeFlushTimer) return;
  if (PENDING_FLUSH_MS === 0) {
    flushPendingChangeBuffer();
    return;
  }
  pendingChangeFlushTimer = setTimeout(flushPendingChangeBuffer, PENDING_FLUSH_MS);
}

function indexFile(absPath: string, reason: IndexReason): void {
  if (shouldIgnorePath(absPath)) return;
  const indexSymbols = isSymbolIndexableFile(absPath);
  const indexContent = isContentIndexableFile(absPath);
  if (!indexSymbols && !indexContent) return;

  const kind = getContentChunkKind(absPath);
  if (!kind) return;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  const maxBytes = kind === "code_chunk" ? INDEX_MAX_CODE_BYTES : INDEX_MAX_DOC_BYTES;
  if (maxBytes > 0 && stat.size > maxBytes) return;

  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf8");
  } catch {
    return;
  }
  if (content.includes("\u0000")) return;

  const ext = path.extname(absPath).toLowerCase();
  const filePath = normalizeToDbPath(absPath);
  if (
    INDEX_SKIP_MINIFIED &&
    kind === "code_chunk" &&
    (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".css") &&
    looksLikeMinifiedBundle(content)
  ) {
    logActivity("index_skip", { file_path: filePath, reason: "minified_bundle", bytes: stat.size });
    return;
  }
  if (kind === "code_chunk" && stat.size >= 20_000 && looksLikeGeneratedFile(content)) {
    logActivity("index_skip", { file_path: filePath, reason: "generated_file", bytes: stat.size });
    return;
  }

  let symbolCount = 0;
  let chunkCount = 0;
  if (indexSymbols) {
    const symbols = extractSymbols(absPath, content);
    symbolCount = symbols.length;
    try {
      indexFileSymbolsTx?.(filePath, symbols);
    } catch (err) {
      console.error("[vectormind] failed to index symbols:", filePath, err);
    }
  }
  if (indexContent) {
    chunkCount = indexFileContentChunks(filePath, absPath, content, reason);
  }

  logActivity("index_file", {
    file_path: filePath,
    reason,
    symbols: symbolCount,
    chunks: chunkCount,
    bytes: stat.size,
  });
}

function removeFileIndexes(absPath: string): void {
  if (shouldIgnorePath(absPath)) return;
  const filePath = normalizeToDbPath(absPath);
  try {
    deleteSymbolsForFileStmt.run(filePath);
  } catch (err) {
    console.error("[vectormind] failed to remove symbols:", filePath, err);
  }
  try {
    deleteFileChunkItemsStmt.run(filePath);
  } catch (err) {
    console.error("[vectormind] failed to remove file chunks:", filePath, err);
  }
  logActivity("remove_file", { file_path: filePath });
}

const ProjectRootArgSchema = z.object({
  project_root: z.string().optional(),
});

const StartRequirementArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    title: z.string().min(1),
    background: z.string().optional().default(""),
    close_previous: z.boolean().optional().default(true),
  }),
);

const SyncChangeIntentArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    intent: z.string().min(1),
    files: z.array(z.string().min(1)).optional(),
    affected_files: z.array(z.string().min(1)).optional(),
  }),
);

const QueryCodebaseArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    query: z.string().min(1),
  }),
);

const GrepArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    // Pattern to search for. Defaults to regex mode for parity with tools like ripgrep.
    query: z.string().min(1),
    mode: z.enum(["regex", "literal"]).optional().default("regex"),
    // If case_sensitive is omitted and smart_case=true, uppercase => case-sensitive, otherwise case-insensitive.
    smart_case: z.boolean().optional().default(true),
    case_sensitive: z.boolean().optional(),
    // Compatibility knob for the indexed fallback when ripgrep is unavailable.
    literal_hint: z.string().optional().default(""),
    // Compatibility knob for the indexed fallback when ripgrep is unavailable.
    kinds: z.array(z.string().min(1)).optional(),
    include_paths: z.array(z.string().min(1)).optional(),
    exclude_paths: z.array(z.string().min(1)).optional(),
    max_results: z.number().int().min(1).max(5000).optional().default(200),
    // Compatibility knob for the indexed fallback when ripgrep is unavailable.
    max_candidates: z.number().int().min(1).max(50_000).optional(),
  }),
);

const ReadFileLinesArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    // Relative to project_root, or an absolute path under project_root.
    path: z.string().min(1),
    from_line: z.number().int().min(1).optional().default(1),
    to_line: z.number().int().min(1).optional(),
    // Convenience for "head": if set, reads from_line..(from_line+total_count-1) unless to_line is provided.
    total_count: z.number().int().min(1).optional(),
    // Hard limits to avoid huge token blow-ups.
    max_lines: z.number().int().min(1).max(2000).optional().default(400),
    max_chars: z.number().int().min(200).max(200_000).optional().default(20_000),
  }),
);

const ReadFileTextArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    // Relative to project_root, or an absolute path under project_root.
    path: z.string().min(1),
    // Character offset in the decoded UTF-8 text.
    offset: z.number().int().min(0).optional().default(0),
    // Hard limit on returned text to avoid huge outputs.
    max_chars: z.number().int().min(1).max(200_000).optional().default(20_000),
    // Safety guard for raw reads; use read_file_lines on larger files.
    max_file_bytes: z.number().int().min(1_000).max(5_000_000).optional().default(1_000_000),
  }),
);

const ReadCodexTextFileArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    // Absolute path, file:// URI, or a path under CODEX_HOME / AGENTS_HOME allowed roots.
    path: z.string().min(1),
    offset: z.number().int().min(0).optional().default(0),
    max_chars: z.number().int().min(1).max(200_000).optional().default(20_000),
    max_file_bytes: z.number().int().min(1_000).max(5_000_000).optional().default(1_000_000),
  }),
);

const ListProjectFilesArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    // Relative directory/file path under project_root. "." means the project root.
    path: z.string().optional().default("."),
    recursive: z.boolean().optional().default(false),
    max_depth: z.number().int().min(1).max(20).optional().default(4),
    include_files: z.boolean().optional().default(true),
    include_dirs: z.boolean().optional().default(true),
    include_hidden: z.boolean().optional().default(false),
    respect_ignore: z.boolean().optional().default(true),
    include_paths: z.array(z.string().min(1)).optional(),
    exclude_paths: z.array(z.string().min(1)).optional(),
    extensions: z.array(z.string().min(1)).optional(),
    max_results: z.number().int().min(1).max(5000).optional().default(200),
    include_stats: z.boolean().optional().default(false),
  }),
);

const UpsertProjectSummaryArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    summary: z.string().min(1),
  }),
);

const AddNoteArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    title: z.string().optional().default(""),
    content: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
  }),
);

const PruneIndexArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    dry_run: z.boolean().optional().default(true),
    prune_ignored_paths: z.boolean().optional().default(true),
    prune_minified_bundles: z.boolean().optional().default(false),
    max_files: z.number().int().min(1).max(50_000).optional().default(2000),
    vacuum: z.boolean().optional().default(false),
  }),
);

const UpsertConventionArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    key: z.string().min(1),
    content: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
  }),
);

const DEFAULT_PENDING_LIMIT = 50;
const MAX_PENDING_LIMIT = 2000;

const PendingPagingSchema = z.object({
  pending_offset: z.number().int().min(0).optional().default(0),
  pending_limit: z.number().int().min(1).max(MAX_PENDING_LIMIT).optional().default(DEFAULT_PENDING_LIMIT),
});

const DEFAULT_PREVIEW_CHARS = 200;
const PreviewSchema = z.object({
  preview_chars: z.number().int().min(50).max(10_000).optional().default(DEFAULT_PREVIEW_CHARS),
});

const DEFAULT_CONTENT_MAX_CHARS = 2000;
const ContentMaxSchema = z.object({
  content_max_chars: z.number().int().min(0).max(200_000).optional().default(DEFAULT_CONTENT_MAX_CHARS),
});

const DEFAULT_RECENT_REQUIREMENTS = 3;
const DEFAULT_RECENT_CHANGES_PER_REQ = 5;
const DEFAULT_RECENT_NOTES = 5;
const DEFAULT_CONVENTIONS_LIMIT = 20;

const BrainDumpLimitsSchema = z.object({
  requirements_limit: z.number().int().min(1).max(20).optional().default(DEFAULT_RECENT_REQUIREMENTS),
  changes_limit: z.number().int().min(1).max(100).optional().default(DEFAULT_RECENT_CHANGES_PER_REQ),
  notes_limit: z.number().int().min(0).max(50).optional().default(DEFAULT_RECENT_NOTES),
  conventions_limit: z.number().int().min(0).max(200).optional().default(DEFAULT_CONVENTIONS_LIMIT),
});

const GetPendingChangesArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    offset: z.number().int().min(0).optional().default(0),
    limit: z.number().int().min(1).max(MAX_PENDING_LIMIT).optional().default(DEFAULT_PENDING_LIMIT),
  }),
);

const CompleteRequirementArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    req_id: z.number().int().positive().optional(),
    all_active: z.boolean().optional().default(false),
  }),
);

const GetActivityLogArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    since_id: z.number().int().min(0).optional().default(0),
    limit: z.number().int().min(1).max(500).optional().default(30),
    verbose: z.boolean().optional().default(false),
  }),
);

const GetActivitySummaryArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    since_id: z.number().int().min(0).optional().default(0),
    max_files: z.number().int().min(0).max(200).optional().default(20),
  }),
);

const ClearActivityLogArgsSchema = ProjectRootArgSchema;

const GetBrainDumpArgsSchema = ProjectRootArgSchema.merge(PendingPagingSchema)
  .merge(PreviewSchema)
  .merge(ContentMaxSchema)
  .merge(BrainDumpLimitsSchema)
  .merge(
    z.object({
      include_content: z.boolean().optional().default(false),
    }),
  );

const BootstrapContextArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    query: z.string().optional(),
    top_k: z.number().int().min(1).max(50).optional().default(5),
    kinds: z.array(z.string().min(1)).optional(),
    include_content: z.boolean().optional().default(false),
    pending_offset: z.number().int().min(0).optional().default(0),
    pending_limit: z.number().int().min(1).max(MAX_PENDING_LIMIT).optional().default(DEFAULT_PENDING_LIMIT),
  })
    .merge(PreviewSchema)
    .merge(ContentMaxSchema)
    .merge(BrainDumpLimitsSchema),
);

const SemanticSearchArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    query: z.string().min(1),
    top_k: z.number().int().min(1).max(50).optional().default(8),
    kinds: z.array(z.string().min(1)).optional(),
    include_content: z.boolean().optional().default(false),
    preview_chars: z.number().int().min(50).max(10_000).optional().default(DEFAULT_PREVIEW_CHARS),
    content_max_chars: z.number().int().min(0).max(200_000).optional().default(DEFAULT_CONTENT_MAX_CHARS),
  }),
);

const ProjectRootOnlyArgsSchema = ProjectRootArgSchema;

const ReadMemoryItemArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    id: z.number().int().positive(),
    offset: z.number().int().min(0).optional().default(0),
    limit: z.number().int().min(1).max(200_000).optional().default(DEFAULT_CONTENT_MAX_CHARS),
  }),
);

function escapeLike(pattern: string): string {
  return pattern.replace(/[\\\\%_]/g, (m) => `\\${m}`);
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function toolJson(value: unknown): string {
  return JSON.stringify(value, null, prettyJsonOutput ? 2 : undefined);
}

function sliceTextForOutput(
  input: string,
  maxChars: number,
): { text: string; truncated: boolean; total_chars: number } {
  const total = input.length;
  if (maxChars <= 0) return { text: input, truncated: false, total_chars: total };
  if (total <= maxChars) return { text: input, truncated: false, total_chars: total };
  return { text: input.slice(0, maxChars), truncated: true, total_chars: total };
}

const embeddingsEnabled = !["0", "false", "off", "disabled"].includes(
  (process.env.VECTORMIND_EMBEDDINGS ?? "off").toLowerCase(),
);
const embedFilesMode = (process.env.VECTORMIND_EMBED_FILES ?? "all").toLowerCase();
const embedModelName = process.env.VECTORMIND_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const embedCacheDir =
  process.env.VECTORMIND_EMBED_CACHE_DIR ??
  path.join(os.homedir(), ".cache", "vectormind");
const allowRemoteModels = !["0", "false", "off"].includes(
  (process.env.VECTORMIND_ALLOW_REMOTE_MODELS ?? "true").toLowerCase(),
);

type IndexReason = "add" | "change" | "manual";

function shouldEmbedFileChunks(reason: IndexReason): boolean {
  if (!embeddingsEnabled) return false;
  if (embedFilesMode === "none" || embedFilesMode === "off" || embedFilesMode === "disabled")
    return false;
  if (embedFilesMode === "all") return true;
  return reason !== "add";
}

let embedderPromise:
  | Promise<(text: string) => Promise<Float32Array>>
  | null = null;

async function getEmbedder(): Promise<(text: string) => Promise<Float32Array>> {
  if (embedderPromise) return embedderPromise;

  embedderPromise = (async () => {
    fs.mkdirSync(embedCacheDir, { recursive: true });
    const mod: any = await import("@xenova/transformers");
    const env: any = mod.env;
    if (env) {
      if (typeof env.cacheDir === "string" || env.cacheDir === undefined) {
        env.cacheDir = embedCacheDir;
      }
      if (typeof env.allowRemoteModels === "boolean" || env.allowRemoteModels === undefined) {
        env.allowRemoteModels = allowRemoteModels;
      }
      if (typeof env.allowLocalModels === "boolean" || env.allowLocalModels === undefined) {
        env.allowLocalModels = true;
      }
    }

    const pipeline: any = mod.pipeline;
    const extractor: any = await pipeline("feature-extraction", embedModelName);

    return async (text: string): Promise<Float32Array> => {
      const input = text.trim() || " ";
      const out: any = await extractor(input, { pooling: "mean", normalize: true });

      const data = out?.data ?? out;
      if (data instanceof Float32Array) return data;
      if (ArrayBuffer.isView(data)) {
        return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      }
      if (Array.isArray(data)) {
        return Float32Array.from(data.flat(Infinity) as number[]);
      }
      if (typeof out?.tolist === "function") {
        return Float32Array.from((out.tolist() as number[]).flat(Infinity) as number[]);
      }
      throw new Error("Unexpected embedding output from embedder");
    };
  })();

  return embedderPromise;
}

function buildEmbeddingInput(item: MemoryItemRow): string {
  const headerParts: string[] = [];
  headerParts.push(`kind: ${item.kind}`);
  if (item.req_id != null) headerParts.push(`req_id: ${item.req_id}`);
  if (item.file_path) headerParts.push(`file: ${item.file_path}`);
  if (item.start_line != null && item.end_line != null) {
    headerParts.push(`lines: ${item.start_line}-${item.end_line}`);
  }
  if (item.title) headerParts.push(`title: ${item.title}`);

  const body = item.content ?? "";
  return `${headerParts.join(" | ")}\n\n${body}`.trim();
}

async function embedMemoryItemById(memoryId: number): Promise<void> {
  if (!embeddingsEnabled) return;

  const item = getMemoryItemByIdStmt.get(memoryId) as MemoryItemRow | undefined;
  if (!item) return;

  const input = buildEmbeddingInput(item);
  const inputHash = sha256Hex(input);

  const existing = getEmbeddingMetaStmt.get(memoryId) as
    | { memory_id: number; dim: number; content_hash: string | null }
    | undefined;
  if (existing?.content_hash === inputHash) return;

  const embedder = await getEmbedder();
  const vector = await embedder(input);

  const dim = vector.length;
  const bytes = Buffer.from(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
  upsertEmbeddingStmt.run(memoryId, dim, bytes, inputHash);
}

const embeddingQueue: number[] = [];
const embeddingQueued = new Set<number>();
let embeddingWorkerRunning = false;

function enqueueEmbedding(memoryId: number): void {
  if (!embeddingsEnabled) return;
  if (embeddingQueued.has(memoryId)) return;
  embeddingQueued.add(memoryId);
  embeddingQueue.push(memoryId);
  void runEmbeddingWorker();
}

async function runEmbeddingWorker(): Promise<void> {
  if (embeddingWorkerRunning) return;
  embeddingWorkerRunning = true;
  try {
    while (embeddingQueue.length) {
      const id = embeddingQueue.shift();
      if (id == null) break;
      embeddingQueued.delete(id);
      try {
        await embedMemoryItemById(id);
      } catch (err) {
        console.error("[vectormind] embedding failed:", { id, err });
      }
    }
  } finally {
    embeddingWorkerRunning = false;
  }
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

type SemanticSearchMode = "embeddings" | "fts" | "like";

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

function makePreviewText(content: string, max: number): string {
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

function toMemoryItemPreview(
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

function getConventionPreviews(
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
  const stored = (listConventionsStmt.all(remaining) as MemoryItemRow[]).map((c) =>
    toMemoryItemPreview(c, false, previewChars, contentMaxChars),
  );

  return [...builtin, ...stored];
}

function toRequirementPreview(
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
  const memRow = (getRequirementMemoryItemIdStmt.get(req.id) as { id: number } | undefined) ?? undefined;
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

function toChangeLogPreview(
  change: ChangeLogRow,
  includeContent: boolean,
  previewChars: number,
  contentMaxChars: number,
): {
  id: number;
  file_path: string;
  timestamp: string;
  intent_preview: string;
  intent_summary?: string;
  intent_truncated?: boolean;
} {
  const preview = makePreviewText(change.intent_summary, previewChars);
  const intentSlice = includeContent ? sliceTextForOutput(change.intent_summary, contentMaxChars) : null;
  return {
    id: change.id,
    file_path: change.file_path,
    timestamp: change.timestamp,
    intent_preview: preview,
    intent_summary: intentSlice ? intentSlice.text : undefined,
    intent_truncated: intentSlice ? intentSlice.truncated : undefined,
  };
}

function completeRequirementMemoryItemsByReqId(reqId: number): void {
  try {
    completeRequirementMemoryItemByReqIdStmt.run(safeJson({ status: "completed" }), reqId);
  } catch (err) {
    console.error("[vectormind] failed to complete requirement memory item:", err);
  }
}

function completeAllActiveRequirementMemoryItems(): void {
  try {
    completeAllActiveRequirementMemoryItemsStmt.run(
      safeJson({ status: "completed" }),
      safeJson({ status: "active" }),
    );
  } catch (err) {
    console.error("[vectormind] failed to complete all active requirement memory items:", err);
  }
}

async function semanticSearchInternal(opts: SemanticSearchOpts): Promise<SemanticSearchResult> {
  if (!embeddingsEnabled) {
    throw new Error("Embeddings are disabled");
  }

  const q = opts.query.trim();
  if (!q) return { query: "", top_k: opts.topK, mode: "embeddings", matches: [] };
  const embedder = await getEmbedder();
  const qVec = await embedder(q);

  const rawLimit = Math.min(500, Math.max(opts.topK, opts.topK * 8));

  let candidateRows: Array<{ memory_id: number; dim: number; vector: Buffer }> = [];
  if (opts.kinds?.length) {
    const placeholders = opts.kinds.map(() => "?").join(", ");
    const stmt = db.prepare(
      `SELECT e.memory_id as memory_id, e.dim as dim, e.vector as vector
       FROM embeddings e
       JOIN memory_items m ON m.id = e.memory_id
       WHERE m.kind IN (${placeholders})`,
    );
    candidateRows = stmt.all(...opts.kinds) as Array<{
      memory_id: number;
      dim: number;
      vector: Buffer;
    }>;
  } else {
    candidateRows = db
      .prepare(`SELECT memory_id, dim, vector FROM embeddings`)
      .all() as Array<{ memory_id: number; dim: number; vector: Buffer }>;
  }

  const top: Array<{ memory_id: number; score: number }> = [];
  for (const row of candidateRows) {
    const buf = row.vector;
    if (!buf || buf.byteLength % 4 !== 0) continue;
    const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (row.dim !== v.length || v.length !== qVec.length) continue;
    const score = dotProduct(qVec, v);

    if (top.length < rawLimit) {
      top.push({ memory_id: row.memory_id, score });
      top.sort((a, b) => b.score - a.score);
      continue;
    }
    if (score <= top[top.length - 1].score) continue;
    top[top.length - 1] = { memory_id: row.memory_id, score };
    top.sort((a, b) => b.score - a.score);
  }

  const matches = top
    .map((t) => {
      const item = getMemoryItemByIdStmt.get(t.memory_id) as MemoryItemRow | undefined;
      if (!item) return null;
      return toSemanticMatch(item, t.score, opts.includeContent, opts.previewChars, opts.contentMaxChars);
    })
    .filter(Boolean) as Array<{
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
      metadata_json: string | null;
      updated_at: string;
    };
  }>;

  const filtered = matches.filter((m) => !shouldIgnoreDbFilePath(m.item.file_path)).slice(0, opts.topK);
  return { query: q, top_k: opts.topK, mode: "embeddings", matches: filtered };
}

function buildFtsMatchQuery(raw: string): string {
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
  if (!ftsAvailable) {
    throw new Error("FTS is unavailable");
  }

  const q = opts.query.trim();
  if (!q) return { query: "", top_k: opts.topK, mode: "fts", matches: [] };
  const matchQuery = buildFtsMatchQuery(q);
  const rawLimit = Math.min(500, Math.max(opts.topK, opts.topK * 8));

  const rows: Array<FtsSearchRow> = (() => {
    if (opts.kinds?.length) {
      const placeholders = opts.kinds.map(() => "?").join(", ");
      const stmt = db.prepare(`
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
          bm25(${FTS_TABLE_NAME}) as rank
        FROM ${FTS_TABLE_NAME}
        JOIN memory_items m ON m.id = ${FTS_TABLE_NAME}.rowid
        WHERE ${FTS_TABLE_NAME} MATCH ?
          AND m.kind IN (${placeholders})
        ORDER BY rank ASC
        LIMIT ?
      `);
      return stmt.all(matchQuery, ...opts.kinds, rawLimit) as Array<FtsSearchRow>;
    }

    const stmt = db.prepare(`
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
        bm25(${FTS_TABLE_NAME}) as rank
      FROM ${FTS_TABLE_NAME}
      JOIN memory_items m ON m.id = ${FTS_TABLE_NAME}.rowid
      WHERE ${FTS_TABLE_NAME} MATCH ?
      ORDER BY rank ASC
      LIMIT ?
    `);
    return stmt.all(matchQuery, rawLimit) as Array<FtsSearchRow>;
  })();

  const matches = rows
    .map((r) => toSemanticMatch(r, -Number(r.rank), opts.includeContent, opts.previewChars, opts.contentMaxChars))
    .filter((m) => !shouldIgnoreDbFilePath(m.item.file_path))
    .slice(0, opts.topK);
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
      const stmt = db.prepare(`
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

    const stmt = db.prepare(`
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

  const matches = rows
    .map((r) => toSemanticMatch(r, Number(r.score), opts.includeContent, opts.previewChars, opts.contentMaxChars))
    .filter((m) => !shouldIgnoreDbFilePath(m.item.file_path))
    .slice(0, opts.topK);
  return { query: q, top_k: opts.topK, mode: "like", matches };
}

async function semanticSearchHybridInternal(opts: SemanticSearchOpts): Promise<SemanticSearchResult> {
  if (embeddingsEnabled) {
    try {
      return await semanticSearchInternal(opts);
    } catch (err) {
      console.error("[vectormind] embeddings semantic_search failed; falling back:", err);
    }
  }

  if (ftsAvailable) {
    try {
      return ftsSearchInternal(opts);
    } catch (err) {
      console.error("[vectormind] fts semantic_search failed; falling back:", err);
    }
  }

  return likeSearchInternal(opts);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasUppercaseAscii(s: string): boolean {
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

function normalizePathNeedle(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}

function passesPathFilters(filePath: string, includePaths: string[] | null, excludePaths: string[] | null): boolean {
  const fp = filePath.toLowerCase();

  if (excludePaths?.length) {
    for (const raw of excludePaths) {
      const n = normalizePathNeedle(raw);
      if (!n) continue;
      if (fp.includes(n)) return false;
    }
  }

  if (includePaths?.length) {
    for (const raw of includePaths) {
      const n = normalizePathNeedle(raw);
      if (!n) continue;
      if (fp.includes(n)) return true;
    }
    return false;
  }

  return true;
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

type GrepMatch = {
  file_path: string;
  kind: string;
  line: number;
  col: number;
  preview: string;
  match: string;
};

type GrepBackend = "ripgrep" | "indexed_fallback";

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

function resolveRipgrepCommand():
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

function runRipgrepSearch(opts: {
  query: string;
  mode: "regex" | "literal";
  smartCase: boolean;
  caseSensitive: boolean;
  includePaths: string[] | null;
  excludePaths: string[] | null;
  maxResults: number;
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
  const resolved = resolveRipgrepCommand();
  if (!resolved.ok) {
    return { ok: false, unavailable: true, error: resolved.error, attempts: resolved.attempts };
  }

  const args = ["--vimgrep", "--no-heading", "--color", "never", "-m", String(opts.maxResults)];
  args.push(opts.caseSensitive ? "-s" : "-i");
  if (opts.mode === "literal") args.push("-F");
  appendBuiltInRipgrepExcludes(args);
  args.push("--", opts.query, ".");

  const result = spawnSync(resolved.command, args, {
    cwd: projectRoot,
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

function runIndexedGrepSearch(opts: {
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
    if (ftsAvailable) {
      const matchQuery = buildFtsMatchQuery(hint);
      const placeholders = opts.kinds.map(() => "?").join(", ");
      const stmt = db.prepare(`
        SELECT
          m.id as id,
          m.kind as kind,
          m.content as content,
          m.file_path as file_path,
          m.start_line as start_line,
          m.end_line as end_line
        FROM ${FTS_TABLE_NAME}
        JOIN memory_items m ON m.id = ${FTS_TABLE_NAME}.rowid
        WHERE ${FTS_TABLE_NAME} MATCH ?
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
    const escaped = escapeLike(needle);
    const like = `%${escaped}%`;
    const placeholders = opts.kinds.map(() => "?").join(", ");
    const stmt = db.prepare(`
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

function resolveProjectPathUnderRoot(
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

function resolveReadPathUnderProjectRoot(inputPath: string): { absPath: string; dbFilePath: string } {
  return resolveProjectPathUnderRoot(inputPath, { allowRoot: false });
}

function resolveCodexTextPath(inputPath: string): { absPath: string; displayPath: string; allowedRoot: string } {
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

function normalizeExtensionsFilter(values: string[] | undefined): string[] | null {
  if (!values?.length) return null;
  const normalized = values
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .map((v) => (v.startsWith(".") ? v : `.${v}`));
  return normalized.length ? Array.from(new Set(normalized)) : null;
}

async function readTextFileLines(opts: {
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

function readTextFileSlice(opts: {
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

type ProjectFileListEntry = {
  path: string;
  kind: "file" | "dir";
  depth: number;
  size?: number;
  mtime?: string;
};

function listProjectFilesInternal(opts: {
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
      const childRel = normalizeToDbPath(childAbs);
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

function buildServerInstructions(): string {
  return [
    "VectorMind MCP is available in this session. Use it to avoid guessing project context.",
    "This package ships built-in baseline policy. If a client supports MCP instructions, these rules auto-apply as soon as the MCP is installed and connected; no user-side config file is required.",
    "The write-operation rules below are strict workflow constraints. Do not claim that the environment has real git branch locks, checkout APIs, or file-lock tools unless such tools are actually available in the current client/runtime. If such tools are absent, you must still enforce the same exclusivity semantics through explicit coordination and serialized same-file edits.",
    "Project root resolution order: tool argument project_root (recommended for clients without roots/list), then VECTORMIND_ROOT (avoid hardcoding in global config), then MCP roots/list (best-effort; falls back quickly if unsupported), then process.cwd() (so start your MCP client in the project directory for per-project isolation).",
    "If root_source is fallback, file watching/indexing is disabled (pass project_root to enable per-project tracking).",
    "",
    "Built-in write-operation policy:",
    BUILTIN_WRITE_POLICY_INSTRUCTIONS,
    "",
    "Built-in task-list / Plan-Lite policy:",
    BUILTIN_PLAN_LITE_INSTRUCTIONS,
    "",
    "Built-in destructive-operation guard policy:",
    BUILTIN_DESTRUCTIVE_OPERATION_GUARD_INSTRUCTIONS,
    "",
    "Built-in architecture and code-organization policy:",
    BUILTIN_ARCHITECTURE_AND_CODE_ORGANIZATION_INSTRUCTIONS,
    "",
    "Built-in low-overhead execution and heavy-thread policy:",
    BUILTIN_LOW_OVERHEAD_WORKFLOW_INSTRUCTIONS,
    "",
    "Built-in payload / oversized-thread guard policy:",
    BUILTIN_PAYLOAD_GUARD_INSTRUCTIONS,
    "",
    "Built-in thread handoff / switch-gate policy:",
    BUILTIN_THREAD_HANDOFF_SWITCH_INSTRUCTIONS,
    "",
    "Required workflow:",
    "- On every new conversation/session for analysis/design/development work: call bootstrap_context({ query: <current goal> }) first (or at least get_brain_dump()) to restore context and retrieve relevant matches from the local memory store (vector if enabled; otherwise FTS/LIKE).",
    "  - Output is compact by default. Use include_content=true only when you truly need full text (it increases tokens).",
    "  - Tune output size with: requirements_limit/changes_limit/notes_limit, preview_chars, pending_limit/pending_offset.",
    "  - Prefer read_memory_item(id, offset, limit) to fetch full text on demand instead of returning large content in other tool outputs.",
    "- For pure execution-first tasks with explicit targets (for example compile/build/run/launch/package/publish/test rerun), you may skip retrieval and go straight to the minimum necessary shell or host tools unless code/context lookup is actually needed to unblock execution.",
    "- To read local Codex skill/prompt/rule files (for example SKILL.md under CODEX_HOME or AGENTS_HOME), prefer read_codex_text_file({ path }) instead of assuming a filesystem MCP resource server exists.",
    "- For project file/directory browsing, prefer list_project_files({ path, recursive?, max_depth? }) over shelling out to Get-ChildItem/ls. It respects ignore rules and keeps output bounded.",
    "- For small/medium raw file reads, prefer read_file_text({ path, offset?, max_chars? }) over Get-Content -Raw. Use read_file_lines(...) when you need deterministic line ranges or the file may be large.",
    "- For raw repo text search with exact file+line+col matches, prefer grep({ query: <pattern> }). It uses ripgrep against real project files when available, applies built-in noise filters, and only falls back to indexed search if ripgrep is unavailable.",
    "- To read a bounded segment of a file, prefer read_file_lines({ path: <file>, from_line/to_line or total_count }) over unbounded file reads.",
    "- If the current thread is heavy, recently compacted, has become slow, or has already hit a 413 / Payload Too Large style error, switch to payload guard mode: avoid unbounded shell dumps, prefer bounded MCP tools, and summarize outputs instead of pasting large raw blocks.",
    "- In payload guard mode, do not use full-repo recursive listings, whole-file dumps, or broad raw match echo unless the user explicitly requests that raw output and accepts the size risk.",
    "- Thread-switch judgment must not rely on a fixed token threshold; use observable signals plus the weight of the upcoming work. If the current thread is heavy, repeatedly compacting, slow, or has already hit a 413 / Payload Too Large style error and the next work still needs broad analysis, cross-module investigation, release validation, or other substantial continuation, pause once and ask whether to switch to a fresh thread before continuing.",
    "- If the user declines that switch, continue in the current thread and do not raise the thread-switch reminder again in the same session.",
    "- If the user accepts, or explicitly asks you to pack the current conversation for a new thread, do not attempt to create a new thread on the user's behalf and do not claim that you already created one. Use add_note(...) to persist a concise handoff note, include other relevant existing note ids only when they are truly needed, then reply briefly with the new handoff note id and tell the user that in the new thread they can say '读取 note <id> [和 note <id>] 继续'.",
    "- BEFORE editing code: call start_requirement(title, background) to set the active requirement.",
    "- AFTER editing + saving: call get_pending_changes() to see unsynced files, then call sync_change_intent(intent, files). (You can omit files to auto-link all pending changes.)",
    "- After major milestones/decisions: call upsert_project_summary(summary) and/or add_note(...) to persist durable context locally.",
    "- If the user states a durable project convention (build commands, frameworks, naming rules, output paths): call upsert_convention(key, content, tags) so it is applied in future sessions.",
    "- When you need full text for a specific note/summary/match: call read_memory_item(id, offset, limit) and page through it.",
    "- When asked to locate code (class/function/type): call query_codebase(query) instead of guessing.",
    "- When you need to recall relevant context from history/code/docs: call semantic_search(query, ...) instead of guessing.",
    "- If the current thread is already heavy or the user reports it has become slow, switch to a lighter workflow: avoid redundant retrieval, keep outputs compact, and if the user refuses thread switching, continue in light mode without repeating the switch reminder in that same session.",
    "",
    "If tool output conflicts with assumptions, trust the tool output.",
  ].join("\n");
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions: buildServerInstructions(),
  },
);

async function resolveProjectRootFromMcpRoots(): Promise<string | null> {
  const caps = server.getClientCapabilities();
  if (!caps?.roots) return null;

  try {
    const result = await server.listRoots({}, { timeout: ROOTS_LIST_TIMEOUT_MS });
    for (const r of result.roots ?? []) {
      const p = parseFileUriToPath(r.uri);
      if (!p) continue;
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) return p;
      } catch {
        // ignore invalid roots
      }
    }
  } catch {
    // client may not support roots
  }
  return null;
}

async function resolveProjectRoot(): Promise<{ root: string; source: RootSource }> {
  const envResolved = resolveRootFromEnvOrThrow();
  if (envResolved) return envResolved;

  const rootFromMcp = await resolveProjectRootFromMcpRoots();
  if (rootFromMcp) return { root: rootFromMcp, source: "mcp_roots" };

  const cwd = process.cwd();
  if (isProbablyVscodeInstallDir(cwd) || isProbablySystemDir(cwd)) {
    return { root: resolveSafeFallbackRootDir(), source: "fallback" };
  }
  return { root: cwd, source: "cwd" };
}

function initMemoryItemsFts(): void {
  ftsAvailable = false;

  try {
    const existed = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(FTS_TABLE_NAME);
    const alreadyExists = !!existed;

    if (!alreadyExists) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE ${FTS_TABLE_NAME} USING fts5(
            kind,
            title,
            content,
            file_path,
            metadata_json,
            content='memory_items',
            content_rowid='id',
            tokenize='trigram'
          );
        `);
      } catch {
        db.exec(`
          CREATE VIRTUAL TABLE ${FTS_TABLE_NAME} USING fts5(
            kind,
            title,
            content,
            file_path,
            metadata_json,
            content='memory_items',
            content_rowid='id'
          );
        `);
      }

      try {
        db.exec(`INSERT INTO ${FTS_TABLE_NAME}(${FTS_TABLE_NAME}) VALUES('rebuild');`);
      } catch (err) {
        console.error("[vectormind] fts rebuild failed:", err);
      }
    }

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS vectormind_memory_items_fts_ai
      AFTER INSERT ON memory_items BEGIN
        INSERT INTO ${FTS_TABLE_NAME}(rowid, kind, title, content, file_path, metadata_json)
        VALUES (new.id, new.kind, new.title, new.content, new.file_path, new.metadata_json);
      END;

      CREATE TRIGGER IF NOT EXISTS vectormind_memory_items_fts_ad
      AFTER DELETE ON memory_items BEGIN
        INSERT INTO ${FTS_TABLE_NAME}(${FTS_TABLE_NAME}, rowid, kind, title, content, file_path, metadata_json)
        VALUES ('delete', old.id, old.kind, old.title, old.content, old.file_path, old.metadata_json);
      END;

      CREATE TRIGGER IF NOT EXISTS vectormind_memory_items_fts_au
      AFTER UPDATE ON memory_items BEGIN
        INSERT INTO ${FTS_TABLE_NAME}(${FTS_TABLE_NAME}, rowid, kind, title, content, file_path, metadata_json)
        VALUES ('delete', old.id, old.kind, old.title, old.content, old.file_path, old.metadata_json);
        INSERT INTO ${FTS_TABLE_NAME}(rowid, kind, title, content, file_path, metadata_json)
        VALUES (new.id, new.kind, new.title, new.content, new.file_path, new.metadata_json);
      END;
    `);

    db.prepare(`SELECT rowid FROM ${FTS_TABLE_NAME} LIMIT 1`).get();
    ftsAvailable = true;
  } catch (err) {
    ftsAvailable = false;
  }
}

function initDatabase(): void {
  const vmDir = path.join(projectRoot, ".vectormind");
  try {
    fs.mkdirSync(vmDir, { recursive: true });
  } catch {
    // ignore
  }

  const legacyDbPath = path.join(projectRoot, ".vectormind.db");
  const nextDbPath = path.join(vmDir, "vectormind.db");
  dbPath = nextDbPath;

  // One-time migration: move legacy root DB into .vectormind/ if the new DB doesn't exist yet.
  if (!fs.existsSync(nextDbPath) && fs.existsSync(legacyDbPath)) {
    const legacyWal = `${legacyDbPath}-wal`;
    const legacyShm = `${legacyDbPath}-shm`;
    const legacyJournal = `${legacyDbPath}-journal`;
    const nextWal = `${nextDbPath}-wal`;
    const nextShm = `${nextDbPath}-shm`;
    const nextJournal = `${nextDbPath}-journal`;

    try {
      fs.renameSync(legacyDbPath, nextDbPath);
      try {
        if (fs.existsSync(legacyWal) && !fs.existsSync(nextWal)) fs.renameSync(legacyWal, nextWal);
      } catch {}
      try {
        if (fs.existsSync(legacyShm) && !fs.existsSync(nextShm)) fs.renameSync(legacyShm, nextShm);
      } catch {}
      try {
        if (fs.existsSync(legacyJournal) && !fs.existsSync(nextJournal)) {
          fs.renameSync(legacyJournal, nextJournal);
        }
      } catch {}
    } catch {
      // If migration fails, fall back to opening the legacy DB in-place.
      dbPath = legacyDbPath;
    }
  }
  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      context_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id INTEGER,
      file_path TEXT,
      intent_summary TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(req_id) REFERENCES requirements(id)
    );

    CREATE TABLE IF NOT EXISTS symbols (
      name TEXT,
      type TEXT,
      file_path TEXT,
      signature TEXT,
      PRIMARY KEY(name, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_change_logs_req_id_timestamp
      ON change_logs(req_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_symbols_name
      ON symbols(name);

    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      file_path TEXT,
      start_line INTEGER,
      end_line INTEGER,
      req_id INTEGER,
      metadata_json TEXT,
      content_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_chunk_locator
      ON memory_items(kind, file_path, start_line, end_line);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_project_summary
      ON memory_items(kind) WHERE kind = 'project_summary';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_convention_key
      ON memory_items(kind, title) WHERE kind = 'convention';

    CREATE INDEX IF NOT EXISTS idx_memory_items_kind_updated_at
      ON memory_items(kind, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_items_file_path
      ON memory_items(file_path);

    CREATE INDEX IF NOT EXISTS idx_memory_items_req_id
      ON memory_items(req_id);

    CREATE TABLE IF NOT EXISTS embeddings (
      memory_id INTEGER PRIMARY KEY,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      content_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_embeddings_updated_at
      ON embeddings(updated_at DESC);

    CREATE TABLE IF NOT EXISTS pending_changes (
      file_path TEXT PRIMARY KEY,
      last_event TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_pending_changes_updated_at
      ON pending_changes(updated_at DESC);
  `);

  initMemoryItemsFts();

  insertRequirementStmt = db.prepare(
    `INSERT INTO requirements (title, context_data, status) VALUES (?, ?, 'active')`,
  );
  completeAllActiveRequirementsStmt = db.prepare(
    `UPDATE requirements SET status = 'completed' WHERE status = 'active'`,
  );
  completeRequirementByIdStmt = db.prepare(
    `UPDATE requirements SET status = 'completed' WHERE id = ?`,
  );
  getActiveRequirementStmt = db.prepare(
    `SELECT id, title, status, context_data, created_at
     FROM requirements
     WHERE status = 'active'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  );
  listRecentRequirementsStmt = db.prepare(
    `SELECT id, title, status, context_data, created_at
     FROM requirements
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  );
  completeAllActiveRequirementMemoryItemsStmt = db.prepare(
    `UPDATE memory_items
     SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE kind = 'requirement'
       AND metadata_json = ?`,
  );
  completeRequirementMemoryItemByReqIdStmt = db.prepare(
    `UPDATE memory_items
     SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE kind = 'requirement'
       AND req_id = ?`,
  );
  listChangeLogsForRequirementStmt = db.prepare(
    `SELECT id, req_id, file_path, intent_summary, timestamp
     FROM change_logs
     WHERE req_id = ?
     ORDER BY timestamp DESC, id DESC
     LIMIT ?`,
  );
  insertChangeLogStmt = db.prepare(
    `INSERT INTO change_logs (req_id, file_path, intent_summary) VALUES (?, ?, ?)`,
  );

  insertMemoryItemStmt = db.prepare(
    `INSERT INTO memory_items
       (kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  getMemoryItemByIdStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE id = ?`,
  );
  getConventionByKeyStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'convention' AND title = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
  );
  insertConventionStmt = db.prepare(
    `INSERT INTO memory_items (kind, title, content, metadata_json, content_hash)
     VALUES ('convention', ?, ?, ?, ?)`,
  );
  updateConventionByIdStmt = db.prepare(
    `UPDATE memory_items
     SET content = ?, metadata_json = ?, content_hash = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  );
  listConventionsStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'convention'
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  );
  getRequirementMemoryItemIdStmt = db.prepare(
    `SELECT id
     FROM memory_items
     WHERE kind = 'requirement' AND req_id = ?
     ORDER BY id DESC
     LIMIT 1`,
  );
  upsertProjectSummaryStmt = db.prepare(
    `INSERT INTO memory_items (kind, title, content, metadata_json, content_hash)
     VALUES ('project_summary', 'Project Summary', ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       metadata_json = excluded.metadata_json,
       content_hash = excluded.content_hash,
       updated_at = CURRENT_TIMESTAMP`,
  );
  getProjectSummaryStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'project_summary'
     LIMIT 1`,
  );
  listRecentNotesStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'note'
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  );
  deleteFileChunkItemsStmt = db.prepare(
    `DELETE FROM memory_items
     WHERE file_path = ?
       AND (kind = 'code_chunk' OR kind = 'doc_chunk')`,
  );

  getEmbeddingMetaStmt = db.prepare(
    `SELECT memory_id, dim, content_hash
     FROM embeddings
     WHERE memory_id = ?`,
  );
  upsertEmbeddingStmt = db.prepare(
    `INSERT INTO embeddings (memory_id, dim, vector, content_hash)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET
       dim = excluded.dim,
       vector = excluded.vector,
       content_hash = excluded.content_hash,
       updated_at = CURRENT_TIMESTAMP`,
  );

  upsertPendingChangeStmt = db.prepare(
    `INSERT INTO pending_changes (file_path, last_event)
     VALUES (?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       last_event = excluded.last_event,
       updated_at = CURRENT_TIMESTAMP`,
  );
  listPendingChangesStmt = db.prepare(
    `SELECT file_path, last_event, updated_at
     FROM pending_changes
     ORDER BY updated_at DESC`,
  );
  listPendingChangesPageStmt = db.prepare(
    `SELECT file_path, last_event, updated_at
     FROM pending_changes
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`,
  );
  countPendingChangesStmt = db.prepare(`SELECT COUNT(*) as total FROM pending_changes`);
  deletePendingChangeStmt = db.prepare(
    `DELETE FROM pending_changes WHERE file_path = ?`,
  );
  deleteAllPendingChangesStmt = db.prepare(`DELETE FROM pending_changes`);
  deleteOldPendingChangesStmt = db.prepare(
    `DELETE FROM pending_changes WHERE updated_at < datetime('now', ?)`,
  );
  deleteOldestPendingChangesStmt = db.prepare(
    `DELETE FROM pending_changes
     WHERE file_path IN (
       SELECT file_path FROM pending_changes
       ORDER BY updated_at ASC
       LIMIT ?
     )`,
  );

  deleteSymbolsForFileStmt = db.prepare(
    `DELETE FROM symbols WHERE file_path = ?`,
  );
  upsertSymbolStmt = db.prepare(
    `INSERT OR REPLACE INTO symbols (name, type, file_path, signature) VALUES (?, ?, ?, ?)`,
  );
  searchSymbolsStmt = db.prepare(
    `SELECT name, type, file_path, signature
     FROM symbols
     WHERE name LIKE ? ESCAPE '\\'
        OR signature LIKE ? ESCAPE '\\'
     ORDER BY
       CASE
         WHEN name = ? THEN 0
         WHEN name LIKE ? ESCAPE '\\' THEN 1
         ELSE 2
       END,
       name
     LIMIT ?`,
  );

  indexFileSymbolsTx = db.transaction((filePath: string, symbols: ExtractedSymbol[]) => {
    deleteSymbolsForFileStmt.run(filePath);
    for (const s of symbols) {
      upsertSymbolStmt.run(s.name, s.type, filePath, s.signature);
    }
  });

  // Clean up noisy pending changes recorded by older versions (build artifacts, node_modules, etc).
  prunePendingChanges();

  // Clean up noisy indexes recorded by older versions (build artifacts, etc).
  if (INDEX_AUTO_PRUNE_IGNORED) {
    pruneIgnoredIndexesByPathPatterns();
  }

  // Clean up common "file name noise" recorded by older versions.
  // (These files are ignored by current index rules; keep the DB consistent automatically.)
  pruneFilenameNoiseIndexes();
}

function initWatcher(): void {
  watcherReady = false;
  watcher = chokidar.watch(projectRoot, {
    ignored: (p) => shouldIgnorePath(p),
    // Avoid indexing the entire tree on startup; track changes after the server is running.
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on("add", (p: string) => {
    recordPendingChange(p, "add");
    indexFile(p, "add");
  });
  watcher.on("change", (p: string) => {
    recordPendingChange(p, "change");
    indexFile(p, "change");
  });
  watcher.on("unlink", (p: string) => {
    recordPendingChange(p, "unlink");
    removeFileIndexes(p);
  });
  watcher.on("ready", () => {
    watcherReady = true;
  });
  watcher.on("error", (err: unknown) => console.error("[vectormind] watcher error:", err));
}

async function initializeIfNeeded(forced?: { root: string; source: RootSource }): Promise<void> {
  if (initialized) return;
  const resolved = forced ?? (await resolveProjectRoot());
  projectRoot = resolved.root;
  rootSource = resolved.source;

  try {
    fs.mkdirSync(projectRoot, { recursive: true });
  } catch {
    // ignore
  }

  try {
    initDatabase();
    if (rootSource === "fallback") {
      // If we can't confidently determine the project root (e.g. Codex VS Code started us in System32),
      // don't watch/index the fallback directory. Callers should pass `project_root`.
      watcher = null;
      watcherReady = false;
    } else {
      initWatcher();
    }
    initialized = true;
    console.error(
      `[vectormind] project_root=${projectRoot} source=${rootSource} db=${dbPath} watcher=${watcher ? "on" : "off"}`,
    );
  } catch (err) {
    try {
      watcher?.close().catch(() => {});
    } catch {}
    watcher = null;
    try {
      db?.close();
    } catch {}
    // reset for retry
    initialized = false;
    throw err;
  }
}

async function ensureInitialized(forced?: { root: string; source: RootSource }): Promise<void> {
  if (initialized) return;
  if (!initializationPromise) {
    initializationPromise = initializeIfNeeded(forced).finally(() => {
      if (initialized) return;
      initializationPromise = null;
    });
  }
  await initializationPromise;
}

async function switchProjectRootIfNeeded(next: { root: string; source: RootSource }): Promise<void> {
  const same = projectRoot && path.resolve(projectRoot) === path.resolve(next.root) && initialized;
  if (same) return;

  try {
    flushPendingChangeBuffer();
  } catch (err) {
    console.error("[vectormind] pending buffer flush error:", err);
  }

  try {
    await watcher?.close();
  } catch (err) {
    console.error("[vectormind] watcher close error:", err);
  }
  watcher = null;
  watcherReady = false;
  try {
    db?.close();
  } catch (err) {
    console.error("[vectormind] db close error:", err);
  }

  initialized = false;
  initializationPromise = null;
  await ensureInitialized(next);
}

async function ensureInitializedForArgs(rawArgs: Record<string, unknown>): Promise<void> {
  const fromToolArg = resolveRootFromToolArgOrThrow(rawArgs.project_root);
  if (fromToolArg) {
    await switchProjectRootIfNeeded(fromToolArg);
    return;
  }
  await ensureInitialized();
}

server.oninitialized = () => {
  // Do not eagerly initialize: prefer initializing on first tool call so callers can
  // provide `project_root` when the MCP client doesn't support roots/list.
};

process.on("unhandledRejection", (reason) => {
  console.error("[vectormind] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[vectormind] uncaughtException:", err);
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "start_requirement",
        description:
          "MUST call BEFORE editing code. Starts/activates a requirement so all subsequent code changes can be linked to a concrete intent (do not edit code without an active requirement).",
        inputSchema: toJsonSchemaCompat(StartRequirementArgsSchema),
      },
      {
        name: "sync_change_intent",
        description:
          "MUST call AFTER you edit code and save files. Archives the intent summary and links affected files to the current active requirement. If you omit files, the server will auto-link all pending changed files since the last sync.",
        inputSchema: toJsonSchemaCompat(SyncChangeIntentArgsSchema),
      },
      {
        name: "get_brain_dump",
        description:
          "Restore recent requirements/changes/notes/summary/pending changes. Prefer bootstrap_context() at session start when you also want recall from the local memory store.",
        inputSchema: toJsonSchemaCompat(GetBrainDumpArgsSchema),
      },
      {
        name: "bootstrap_context",
        description:
          "MUST call at the start of every new chat/session. Returns brain dump + pending changes, and (if you pass query) matches from the local memory store to avoid guessing.",
        inputSchema: toJsonSchemaCompat(BootstrapContextArgsSchema),
      },
      {
        name: "get_pending_changes",
        description:
          "List files that changed locally but have not been acknowledged by sync_change_intent yet. Use this to see what needs syncing (or omit files in sync_change_intent to auto-link them).",
        inputSchema: toJsonSchemaCompat(GetPendingChangesArgsSchema),
      },
      {
        name: "complete_requirement",
        description:
          "Mark a requirement as completed (by id or the current active one). Use this when work for a requirement is done so it no longer shows as active.",
        inputSchema: toJsonSchemaCompat(CompleteRequirementArgsSchema),
      },
      {
        name: "read_memory_item",
        description:
          "Read a memory item by id. Use this to fetch full text only when needed (bootstrap_context/get_brain_dump/semantic_search return previews by default). Supports offset/limit chunking to avoid huge tool outputs.",
        inputSchema: toJsonSchemaCompat(ReadMemoryItemArgsSchema),
      },
      {
        name: "get_activity_log",
        description:
          "Get recent debug activity (indexing/search/pending) for troubleshooting. Enable logging with VECTORMIND_DEBUG_LOG=1. Use since_id/limit to page.",
        inputSchema: toJsonSchemaCompat(GetActivityLogArgsSchema),
      },
      {
        name: "get_activity_summary",
        description:
          "Get a compact summary of recent debug activity (counts + small samples). Enable logging with VECTORMIND_DEBUG_LOG=1. Use since_id to get incremental summaries.",
        inputSchema: toJsonSchemaCompat(GetActivitySummaryArgsSchema),
      },
      {
        name: "clear_activity_log",
        description:
          "Clear the in-memory debug activity log. Enable logging with VECTORMIND_DEBUG_LOG=1.",
        inputSchema: toJsonSchemaCompat(ClearActivityLogArgsSchema),
      },
      {
        name: "grep",
        description:
          "Repo text search with precise file/line/col matches, powered by ripgrep against real project files plus built-in noise filters. Falls back to indexed search only when ripgrep is unavailable.",
        inputSchema: toJsonSchemaCompat(GrepArgsSchema),
      },
      {
        name: "list_project_files",
        description:
          "AI-friendly, ignore-aware file/directory listing under project_root with bounded output. Prefer this over Get-ChildItem/ls for local repository browsing.",
        inputSchema: toJsonSchemaCompat(ListProjectFilesArgsSchema),
      },
      {
        name: "read_codex_text_file",
        description:
          "Read bounded text from local Codex/agents files such as SKILL.md, prompt files, and rules under CODEX_HOME/AGENTS_HOME. Prefer this over assuming a filesystem MCP resource server exists.",
        inputSchema: toJsonSchemaCompat(ReadCodexTextFileArgsSchema),
      },
      {
        name: "read_file_lines",
        description:
          "Read a specific line range from a file under project_root (with strict size limits). Prefer this over Get-Content for deterministic reads.",
        inputSchema: toJsonSchemaCompat(ReadFileLinesArgsSchema),
      },
      {
        name: "read_file_text",
        description:
          "Read bounded raw UTF-8 text from a file under project_root. Prefer this over Get-Content -Raw for small/medium text files; use read_file_lines for large files or line-specific reads.",
        inputSchema: toJsonSchemaCompat(ReadFileTextArgsSchema),
      },
      {
        name: "query_codebase",
        description:
          "Search the symbol index for class/function/type names (or substrings) to locate definitions by file path and signature. Use this when you need to find code—do not guess locations.",
        inputSchema: toJsonSchemaCompat(QueryCodebaseArgsSchema),
      },
      {
        name: "upsert_project_summary",
        description:
          "Save/update the project-level context summary (written by the AI in the conversation). Call this after major milestones/decisions so future sessions can recover context quickly.",
        inputSchema: toJsonSchemaCompat(UpsertProjectSummaryArgsSchema),
      },
      {
        name: "add_note",
        description:
          "Save a durable project note (decision, constraint, TODO, architecture detail). Use this to persist important context locally instead of relying on chat memory.",
        inputSchema: toJsonSchemaCompat(AddNoteArgsSchema),
      },
      {
        name: "upsert_convention",
        description:
          "Save/update a project convention (framework choice, build command, naming rules, etc). Conventions are durable and should be applied automatically in future sessions.",
        inputSchema: toJsonSchemaCompat(UpsertConventionArgsSchema),
      },
      {
        name: "semantic_search",
        description:
          "Semantic search across the local memory store (requirements, change intents, notes, project summary, and indexed code/doc chunks). Use this to retrieve relevant context instead of guessing.",
        inputSchema: toJsonSchemaCompat(SemanticSearchArgsSchema),
      },
      {
        name: "prune_index",
        description:
          "Prune noisy auto-indexed items (code_chunk/doc_chunk + symbols). Useful after tightening ignore rules to shrink the index and improve search relevance.",
        inputSchema: toJsonSchemaCompat(PruneIndexArgsSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    await ensureInitializedForArgs(rawArgs);

    if (toolName === "start_requirement") {
      const args = StartRequirementArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();

      if (args.close_previous) {
        try {
          completeAllActiveRequirementsStmt.run();
          completeAllActiveRequirementMemoryItems();
        } catch (err) {
          console.error("[vectormind] failed to close previous active requirements:", err);
        }
      }

      const info = insertRequirementStmt.run(args.title, args.background || null);
      const id = Number(info.lastInsertRowid);

      const background = args.background?.trim() ?? "";
      const content = background ? `${args.title}\n\n${background}` : args.title;
      const memoryInfo = insertMemoryItemStmt.run(
        "requirement",
        args.title,
        content,
        null,
        null,
        null,
        id,
        safeJson({ status: "active" }),
        sha256Hex(content),
      );
      const memory_id = Number(memoryInfo.lastInsertRowid);
      enqueueEmbedding(memory_id);

      logActivity("start_requirement", {
        req_id: id,
        title: args.title,
        closed_previous: args.close_previous,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              requirement: { id, title: args.title },
              memory_item: { id: memory_id },
              closed_previous: args.close_previous,
            }),
          },
        ],
      };
    }

    if (toolName === "prune_index") {
      const args = PruneIndexArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();

      const result = {
        ok: true as const,
        dry_run: args.dry_run,
        config: {
          index_max_code_bytes: INDEX_MAX_CODE_BYTES,
          index_max_doc_bytes: INDEX_MAX_DOC_BYTES,
          index_skip_minified: INDEX_SKIP_MINIFIED,
          index_auto_prune_ignored: INDEX_AUTO_PRUNE_IGNORED,
        },
        pruned: {
          ignored_paths: { chunks_deleted: 0, symbols_deleted: 0 },
          minified_bundles: { files_matched: 0, chunks_deleted: 0, symbols_deleted: 0 },
        },
      };

      if (args.prune_ignored_paths) {
        if (!IGNORED_LIKE_PATTERNS.length) {
          result.pruned.ignored_paths = { chunks_deleted: 0, symbols_deleted: 0 };
        } else if (args.dry_run) {
          const where = IGNORED_LIKE_PATTERNS
            .map(() => "LOWER(REPLACE(file_path, '\\\\', '/')) LIKE ?")
            .join(" OR ");
          const chunksWould = Number(
            (
              db
                .prepare(
                  `SELECT COUNT(1) AS c
                   FROM memory_items
                   WHERE file_path IS NOT NULL
                     AND (kind = 'code_chunk' OR kind = 'doc_chunk')
                     AND (${where})`,
                )
                .get(...IGNORED_LIKE_PATTERNS) as { c: number } | undefined
            )?.c ?? 0,
          );
          const symbolsWould = Number(
            (
              db
                .prepare(
                  `SELECT COUNT(1) AS c
                   FROM symbols
                   WHERE file_path IS NOT NULL
                     AND (${where})`,
                )
                .get(...IGNORED_LIKE_PATTERNS) as { c: number } | undefined
            )?.c ?? 0,
          );
          result.pruned.ignored_paths = { chunks_deleted: chunksWould, symbols_deleted: symbolsWould };
        } else {
          result.pruned.ignored_paths = pruneIgnoredIndexesByPathPatterns();
        }
      }

      if (args.prune_minified_bundles) {
        const maxFiles = args.max_files;
        const candidates = db
          .prepare(
            `SELECT file_path, content
             FROM memory_items
             WHERE kind = 'code_chunk'
               AND file_path IS NOT NULL
               AND (
                 LOWER(file_path) LIKE '%.js'
                 OR LOWER(file_path) LIKE '%.mjs'
                 OR LOWER(file_path) LIKE '%.cjs'
                 OR LOWER(file_path) LIKE '%.css'
               )
             ORDER BY updated_at DESC, id DESC
             LIMIT ?`,
          )
          .all(Math.min(50_000, maxFiles * 5)) as Array<{ file_path: string; content: string }>;

        const matched = new Set<string>();
        for (const row of candidates) {
          if (matched.size >= maxFiles) break;
          const fp = row.file_path;
          if (!fp || matched.has(fp)) continue;
          if (looksLikeMinifiedBundle(row.content)) matched.add(fp);
        }

        if (args.dry_run) {
          let chunksWould = 0;
          let symbolsWould = 0;
          const countChunksStmt = db.prepare(
            `SELECT COUNT(1) AS c
             FROM memory_items
             WHERE file_path = ?
               AND (kind = 'code_chunk' OR kind = 'doc_chunk')`,
          );
          const countSymbolsStmt = db.prepare(`SELECT COUNT(1) AS c FROM symbols WHERE file_path = ?`);
          for (const fp of matched) {
            chunksWould += Number((countChunksStmt.get(fp) as { c: number } | undefined)?.c ?? 0);
            symbolsWould += Number((countSymbolsStmt.get(fp) as { c: number } | undefined)?.c ?? 0);
          }
          result.pruned.minified_bundles = {
            files_matched: matched.size,
            chunks_deleted: chunksWould,
            symbols_deleted: symbolsWould,
          };
        } else {
          let chunksDeleted = 0;
          let symbolsDeleted = 0;
          const tx = db.transaction(() => {
            for (const fp of matched) {
              chunksDeleted += deleteFileChunkItemsStmt.run(fp).changes;
              symbolsDeleted += deleteSymbolsForFileStmt.run(fp).changes;
            }
          });
          try {
            tx();
          } catch (err) {
            console.error("[vectormind] prune minified bundles failed:", err);
          }
          if (matched.size) {
            logActivity("index_prune", {
              reason: "minified_bundles",
              files_matched: matched.size,
              chunks_deleted: chunksDeleted,
              symbols_deleted: symbolsDeleted,
            });
          }
          result.pruned.minified_bundles = {
            files_matched: matched.size,
            chunks_deleted: chunksDeleted,
            symbols_deleted: symbolsDeleted,
          };
        }
      }

      if (!args.dry_run && args.vacuum) {
        try {
          db.exec("VACUUM");
          logActivity("index_prune", { reason: "vacuum" });
        } catch (err) {
          console.error("[vectormind] vacuum failed:", err);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: toolJson(result),
          },
        ],
      };
    }

    if (toolName === "sync_change_intent") {
      const args = SyncChangeIntentArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const explicitFiles = (args.files ?? args.affected_files ?? []).filter(
        (f): f is string => typeof f === "string" && f.length > 0,
      );
      const active = getActiveRequirementStmt.get() as RequirementRow | undefined;
      if (!active) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: toolJson({
                ok: false,
                error:
                  "No active requirement. Call start_requirement(title, background) before syncing change intent.",
              }),
            },
          ],
        };
      }

      const created: Array<{
        file_path: string;
        event: string;
        source: "args" | "pending" | "unspecified";
        change_log_id: number;
        memory_item_id: number;
      }> = [];
      const synced_files: Array<{
        file_path: string;
        event: string;
        source: "args" | "pending" | "unspecified";
      }> = [];
      const insertTx = db.transaction(() => {
        const targets: Array<{
          rawFile: string;
          dbFilePath: string;
          event: string;
          source: "args" | "pending" | "unspecified";
        }> = [];

        if (explicitFiles.length) {
          for (const rawFile of explicitFiles) {
            const dbFilePath = normalizeToDbPath(rawFile);
            targets.push({ rawFile, dbFilePath, event: "manual", source: "args" });
          }
          for (const t of targets) {
            deletePendingChangeStmt.run(t.dbFilePath);
          }
        } else {
          const pendingAll = listPendingChangesStmt.all() as Array<{
            file_path: string;
            last_event: string;
            updated_at: string;
          }>;
          if (pendingAll.length) {
            const pending = pendingAll.filter((p) => !shouldIgnoreDbFilePath(p.file_path));
            if (pending.length) {
              for (const p of pending) {
                targets.push({
                  rawFile: p.file_path,
                  dbFilePath: p.file_path,
                  event: p.last_event,
                  source: "pending",
                });
              }
            } else {
              targets.push({
                rawFile: "(unspecified)",
                dbFilePath: "(unspecified)",
                event: "manual",
                source: "unspecified",
              });
            }
            deleteAllPendingChangesStmt.run();
          } else {
            targets.push({
              rawFile: "(unspecified)",
              dbFilePath: "(unspecified)",
              event: "manual",
              source: "unspecified",
            });
          }
        }

        for (const t of targets) {
          const isUnspecified = t.dbFilePath === "(unspecified)";
          const changeInfo = insertChangeLogStmt.run(active.id, t.dbFilePath, args.intent);
          const change_log_id = Number(changeInfo.lastInsertRowid);

          const memoryInfo = insertMemoryItemStmt.run(
            "change_intent",
            active.title,
            args.intent,
            isUnspecified ? null : t.dbFilePath,
            null,
            null,
            active.id,
            safeJson({ change_log_id, event: t.event, source: t.source }),
            sha256Hex(args.intent),
          );
          const memory_item_id = Number(memoryInfo.lastInsertRowid);
          enqueueEmbedding(memory_item_id);

          synced_files.push({ file_path: t.dbFilePath, event: t.event, source: t.source });
          created.push({
            file_path: t.dbFilePath,
            event: t.event,
            source: t.source,
            change_log_id,
            memory_item_id,
          });

          if (!isUnspecified && t.event !== "unlink") {
            const abs = path.isAbsolute(t.rawFile)
              ? t.rawFile
              : path.join(projectRoot, t.rawFile);
            indexFile(abs, "manual");
          }
        }
      });
      insertTx();

      logActivity("sync_change_intent", {
        req_id: active.id,
        title: active.title,
        intent_preview: makePreviewText(args.intent, 200),
        files: synced_files.slice(0, 25),
        files_total: synced_files.length,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              linked_to_requirement: { id: active.id, title: active.title },
              synced_files,
              created,
            }),
          },
        ],
      };
    }

    if (toolName === "bootstrap_context") {
      const args = BootstrapContextArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();

      const previewChars = args.preview_chars;
      const includeContent = args.include_content;
      const contentMaxChars = args.content_max_chars;
      const requirementsLimit = args.requirements_limit;
      const changesLimit = args.changes_limit;
      const notesLimit = args.notes_limit;
      const conventionsLimit = args.conventions_limit;

      const recent = listRecentRequirementsStmt.all(requirementsLimit) as RequirementRow[];
      const items = recent.map((req) => {
        const changes = listChangeLogsForRequirementStmt.all(req.id, changesLimit) as ChangeLogRow[];
        return {
          requirement: toRequirementPreview(req, includeContent, previewChars, contentMaxChars),
          recent_changes: changes.map((c) => toChangeLogPreview(c, includeContent, previewChars, contentMaxChars)),
        };
      });
      const projectSummaryRow = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
      const project_summary = projectSummaryRow
        ? toMemoryItemPreview(projectSummaryRow, includeContent, previewChars, contentMaxChars)
        : null;
      const recent_notes = (listRecentNotesStmt.all(notesLimit) as MemoryItemRow[]).map((n) =>
        toMemoryItemPreview(n, includeContent, previewChars, contentMaxChars),
      );
      const conventions = getConventionPreviews(conventionsLimit, previewChars, contentMaxChars);
      const pending_total = Number(
        (countPendingChangesStmt.get() as { total: number } | undefined)?.total ?? 0,
      );
      const pending_offset = args.pending_offset;
      const pending_limit = args.pending_limit;
      const pending_truncated = pending_total > pending_offset + pending_limit;

      const pending_changes = (listPendingChangesPageStmt.all(pending_limit, pending_offset) as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>).filter((p) => !shouldIgnoreDbFilePath(p.file_path));

      const q = args.query?.trim() ?? "";
      const semantic =
        q
          ? await Promise.race([
              semanticSearchHybridInternal({
                query: q,
                topK: args.top_k,
                kinds: args.kinds?.length ? args.kinds : null,
                includeContent,
                previewChars,
                contentMaxChars,
              }),
              new Promise<null>((resolve) => setTimeout(resolve, BOOTSTRAP_SEMANTIC_TIMEOUT_MS, null)),
            ]).catch((err) => {
              console.error("[vectormind] bootstrap semantic_search failed:", err);
              return null;
            })
          : null;

      logActivity("bootstrap_context", {
        query: q || null,
        pending_total,
        pending_returned: pending_changes.length,
        requirements_returned: items.length,
        conventions_returned: conventions.length,
        semantic_mode: semantic?.mode ?? null,
        semantic_matches: semantic?.matches?.length ?? 0,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              generated_at: new Date().toISOString(),
              project_root: projectRoot,
              root_source: rootSource,
              db_path: dbPath,
              watcher_enabled: !!watcher,
              watcher_ready: watcherReady,
              embeddings: {
                enabled: embeddingsEnabled,
                model: embedModelName,
                embed_files: embedFilesMode,
              },
              output: {
                include_content: includeContent,
                preview_chars: previewChars,
                content_max_chars: contentMaxChars,
                requirements_limit: requirementsLimit,
                changes_limit: changesLimit,
                notes_limit: notesLimit,
                conventions_limit: conventionsLimit,
              },
              project_summary,
              conventions,
              recent_notes,
              pending_total,
              pending_offset,
              pending_limit,
              pending_truncated,
              pending_changes,
              items,
              semantic,
            }),
          },
        ],
      };
    }

    if (toolName === "get_brain_dump") {
      const args = GetBrainDumpArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const previewChars = args.preview_chars;
      const includeContent = args.include_content;
      const contentMaxChars = args.content_max_chars;
      const requirementsLimit = args.requirements_limit;
      const changesLimit = args.changes_limit;
      const notesLimit = args.notes_limit;
      const conventionsLimit = args.conventions_limit;

      const recent = listRecentRequirementsStmt.all(requirementsLimit) as RequirementRow[];
      const items = recent.map((req) => {
        const changes = listChangeLogsForRequirementStmt.all(req.id, changesLimit) as ChangeLogRow[];
        return {
          requirement: toRequirementPreview(req, includeContent, previewChars, contentMaxChars),
          recent_changes: changes.map((c) => toChangeLogPreview(c, includeContent, previewChars, contentMaxChars)),
        };
      });
      const projectSummaryRow = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
      const project_summary = projectSummaryRow
        ? toMemoryItemPreview(projectSummaryRow, includeContent, previewChars, contentMaxChars)
        : null;
      const recent_notes = (listRecentNotesStmt.all(notesLimit) as MemoryItemRow[]).map((n) =>
        toMemoryItemPreview(n, includeContent, previewChars, contentMaxChars),
      );
      const conventions = getConventionPreviews(conventionsLimit, previewChars, contentMaxChars);
      const pending_total = Number(
        (countPendingChangesStmt.get() as { total: number } | undefined)?.total ?? 0,
      );
      const pending_offset = args.pending_offset;
      const pending_limit = args.pending_limit;
      const pending_truncated = pending_total > pending_offset + pending_limit;

      const pending_changes = (listPendingChangesPageStmt.all(pending_limit, pending_offset) as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>).filter((p) => !shouldIgnoreDbFilePath(p.file_path));

      logActivity("get_brain_dump", {
        pending_total,
        pending_returned: pending_changes.length,
        requirements_returned: items.length,
        notes_returned: recent_notes.length,
        conventions_returned: conventions.length,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              generated_at: new Date().toISOString(),
              project_root: projectRoot,
              root_source: rootSource,
              db_path: dbPath,
              watcher_enabled: !!watcher,
              watcher_ready: watcherReady,
              embeddings: {
                enabled: embeddingsEnabled,
                model: embedModelName,
                embed_files: embedFilesMode,
              },
              output: {
                include_content: includeContent,
                preview_chars: previewChars,
                content_max_chars: contentMaxChars,
                requirements_limit: requirementsLimit,
                changes_limit: changesLimit,
                notes_limit: notesLimit,
                conventions_limit: conventionsLimit,
              },
              project_summary,
              conventions,
              recent_notes,
              pending_total,
              pending_offset,
              pending_limit,
              pending_truncated,
              pending_changes,
              items,
            }),
          },
        ],
      };
    }

    if (toolName === "get_pending_changes") {
      const args = GetPendingChangesArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const total = Number((countPendingChangesStmt.get() as { total: number } | undefined)?.total ?? 0);
      const offset = args.offset;
      const limit = args.limit;
      const truncated = total > offset + limit;

      const pending = (listPendingChangesPageStmt.all(limit, offset) as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>).filter((p) => !shouldIgnoreDbFilePath(p.file_path));

      logActivity("get_pending_changes", {
        total,
        offset,
        limit,
        returned: pending.length,
        truncated,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({ ok: true, total, offset, limit, truncated, pending }),
          },
        ],
      };
    }

    if (toolName === "complete_requirement") {
      const args = CompleteRequirementArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();

      const updated: Array<{ id: number }> = [];
      if (args.all_active) {
        const activeRows = (db.prepare(
          `SELECT id FROM requirements WHERE status = 'active' ORDER BY created_at DESC, id DESC`,
        ).all() as Array<{ id: number }>).slice(0, 200);

        try {
          completeAllActiveRequirementsStmt.run();
          completeAllActiveRequirementMemoryItems();
        } catch (err) {
          console.error("[vectormind] complete all active requirements failed:", err);
        }

        for (const r of activeRows) updated.push({ id: r.id });
        logActivity("complete_requirement", { all_active: true, completed: updated.map((u) => u.id) });
        return { content: [{ type: "text", text: toolJson({ ok: true, completed: updated }) }] };
      }

      const targetId =
        args.req_id ?? (getActiveRequirementStmt.get() as RequirementRow | undefined)?.id ?? null;
      if (!targetId) {
        return { content: [{ type: "text", text: toolJson({ ok: true, completed: [] }) }] };
      }

      try {
        completeRequirementByIdStmt.run(targetId);
        completeRequirementMemoryItemsByReqId(targetId);
      } catch (err) {
        console.error("[vectormind] complete requirement failed:", err);
      }

      logActivity("complete_requirement", { req_id: targetId });
      return { content: [{ type: "text", text: toolJson({ ok: true, completed: [{ id: targetId }] }) }] };
    }

    if (toolName === "read_memory_item") {
      const args = ReadMemoryItemArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const row = getMemoryItemByIdStmt.get(args.id) as MemoryItemRow | undefined;
      if (!row) {
        return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not found" }) }] };
      }

      const total = row.content.length;
      const offset = args.offset;
      const limit = args.limit;
      const chunk = row.content.slice(offset, offset + limit);
      const truncated = offset + limit < total;

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              item: {
                id: row.id,
                kind: row.kind,
                title: row.title,
                file_path: row.file_path,
                start_line: row.start_line,
                end_line: row.end_line,
                req_id: row.req_id,
                metadata_json: row.metadata_json,
                updated_at: row.updated_at,
              },
              total_chars: total,
              offset,
              limit,
              truncated,
              content: chunk,
            }),
          },
        ],
      };
    }

    if (toolName === "get_activity_log") {
      const args = GetActivityLogArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const { events, last_id } = snapshotActivityLog({ sinceId: args.since_id, limit: args.limit });
      const outEvents = args.verbose
        ? events
        : events.map((e) => ({ id: e.id, ts: e.ts, type: e.type, summary: summarizeActivityEvent(e) }));
      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              enabled: debugLogEnabled,
              max_entries: debugLogMaxEntries,
              last_id,
              events: outEvents,
            }),
          },
        ],
      };
    }

    if (toolName === "get_activity_summary") {
      const args = GetActivitySummaryArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const { events, last_id } = snapshotActivityLog({ sinceId: args.since_id, limit: 500 });

      const counts: Record<string, number> = {};
      const indexedFiles = new Set<string>();
      let semanticCount = 0;
      let queryCodebaseCount = 0;
      let pendingFlushes = 0;
      let pendingPrunes = 0;
      let lastSemantic: Record<string, unknown> | null = null;
      let lastQueryCodebase: Record<string, unknown> | null = null;

      for (const e of events) {
        counts[e.type] = (counts[e.type] ?? 0) + 1;
        if (e.type === "index_file") {
          const fp = String(e.data.file_path ?? "");
          if (fp) indexedFiles.add(fp);
        }
        if (e.type === "semantic_search") {
          semanticCount += 1;
          lastSemantic = e.data;
        }
        if (e.type === "query_codebase") {
          queryCodebaseCount += 1;
          lastQueryCodebase = e.data;
        }
        if (e.type === "pending_flush") pendingFlushes += 1;
        if (e.type === "pending_prune") pendingPrunes += 1;
      }

      const sampleFiles = Array.from(indexedFiles).slice(0, args.max_files);
      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              enabled: debugLogEnabled,
              last_id,
              since_id: args.since_id,
              counts,
              indexed_files: { unique: indexedFiles.size, sample: sampleFiles },
              searches: {
                semantic_search: { count: semanticCount, last: lastSemantic },
                query_codebase: { count: queryCodebaseCount, last: lastQueryCodebase },
              },
              pending: { flushes: pendingFlushes, prunes: pendingPrunes },
            }),
          },
        ],
      };
    }

    if (toolName === "clear_activity_log") {
      ClearActivityLogArgsSchema.parse(rawArgs);
      clearActivityLog();
      return { content: [{ type: "text", text: toolJson({ ok: true }) }] };
    }

    if (toolName === "grep") {
      const args = GrepArgsSchema.parse(rawArgs);
      const q = args.query;
      const mode = args.mode;
      const smartCase = args.smart_case;
      const kinds = args.kinds?.length ? args.kinds : (["code_chunk", "doc_chunk"] as string[]);
      const includePaths = args.include_paths?.length ? args.include_paths : null;
      const excludePaths = args.exclude_paths?.length ? args.exclude_paths : null;
      const maxResults = args.max_results;

      const caseSensitive =
        args.case_sensitive ?? (smartCase ? hasUppercaseAscii(q) : true);
      const ripgrepResult = runRipgrepSearch({
        query: q,
        mode,
        smartCase,
        caseSensitive,
        includePaths,
        excludePaths,
        maxResults,
      });

      if (ripgrepResult.ok) {
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
        });

        return {
          content: [
            {
              type: "text",
              text: toolJson({
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
              }),
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
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
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
            }),
          },
        ],
      };
    }

    if (toolName === "list_project_files") {
      const args = ListProjectFilesArgsSchema.parse(rawArgs);
      const resolved = resolveProjectPathUnderRoot(args.path, { allowRoot: true });

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

      return {
        content: [
          {
            type: "text",
            text: toolJson({
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
            }),
          },
        ],
      };
    }

    if (toolName === "read_file_text") {
      const args = ReadFileTextArgsSchema.parse(rawArgs);
      const resolved = resolveReadPathUnderProjectRoot(args.path);

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

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              file_path: resolved.dbFilePath,
              offset: args.offset,
              returned_chars: result.returnedChars,
              total_chars: result.totalChars,
              truncated: result.truncated,
              text: result.text,
            }),
          },
        ],
      };
    }

    if (toolName === "read_codex_text_file") {
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

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              file_path: resolved.displayPath,
              allowed_root: resolved.allowedRoot,
              offset: args.offset,
              returned_chars: result.returnedChars,
              total_chars: result.totalChars,
              truncated: result.truncated,
              text: result.text,
            }),
          },
        ],
      };
    }

    if (toolName === "read_file_lines") {
      const args = ReadFileLinesArgsSchema.parse(rawArgs);
      const resolved = resolveReadPathUnderProjectRoot(args.path);

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

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              file_path: resolved.dbFilePath,
              from_line: fromLine,
              to_line: toLine,
              returned: result.returned,
              truncated: result.truncated,
              text: result.text,
            }),
          },
        ],
      };
    }

    if (toolName === "query_codebase") {
      const args = QueryCodebaseArgsSchema.parse(rawArgs);
      const q = args.query.trim();
      const escaped = escapeLike(q);
      const like = `%${escaped}%`;
      const rows = searchSymbolsStmt.all(like, like, q, like, 250) as SymbolRow[];
      const filtered = rows.filter((r) => !shouldIgnoreDbFilePath(r.file_path)).slice(0, 50);

      logActivity("query_codebase", {
        query: q,
        matches: filtered.length,
        sample: filtered.slice(0, 10).map((m) => ({ name: m.name, type: m.type, file_path: m.file_path })),
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({ ok: true, query: q, matches: filtered }),
          },
        ],
      };
    }

    if (toolName === "upsert_project_summary") {
      const args = UpsertProjectSummaryArgsSchema.parse(rawArgs);
      const summary = args.summary.trim();
      const contentHash = sha256Hex(summary);
      upsertProjectSummaryStmt.run(summary, safeJson({ source: "assistant" }), contentHash);

      const row = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
      if (row) enqueueEmbedding(row.id);

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              project_summary: row ? { id: row.id, updated_at: row.updated_at } : null,
            }),
          },
        ],
      };
    }

    if (toolName === "add_note") {
      const args = AddNoteArgsSchema.parse(rawArgs);
      const title = args.title?.trim() ?? "";
      const content = args.content.trim();
      const info = insertMemoryItemStmt.run(
        "note",
        title || null,
        content,
        null,
        null,
        null,
        null,
        safeJson({ tags: args.tags ?? [] }),
        sha256Hex(content),
      );
      const id = Number(info.lastInsertRowid);
      enqueueEmbedding(id);

      return {
        content: [
          {
            type: "text",
            text: toolJson({ ok: true, note: { id } }),
          },
        ],
      };
    }

    if (toolName === "upsert_convention") {
      const args = UpsertConventionArgsSchema.parse(rawArgs);
      const key = args.key.trim();
      const content = args.content.trim();
      const contentHash = sha256Hex(content);
      const meta = safeJson({ tags: args.tags ?? [] });
      const existing = getConventionByKeyStmt.get(key) as MemoryItemRow | undefined;
      if (existing) {
        updateConventionByIdStmt.run(content, meta, contentHash, existing.id);
      } else {
        insertConventionStmt.run(key, content, meta, contentHash);
      }
      const row = getConventionByKeyStmt.get(key) as MemoryItemRow | undefined;

      if (row) enqueueEmbedding(row.id);
      logActivity("upsert_convention", { key, content_preview: makePreviewText(content, 200) });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              convention: row
                ? {
                    id: row.id,
                    key: row.title,
                    updated_at: row.updated_at,
                    preview: makePreviewText(row.content, DEFAULT_PREVIEW_CHARS),
                  }
                : null,
            }),
          },
        ],
      };
    }

    if (toolName === "semantic_search") {
      const args = SemanticSearchArgsSchema.parse(rawArgs);
      const result = await semanticSearchHybridInternal({
        query: args.query,
        topK: args.top_k,
        kinds: args.kinds?.length ? args.kinds : null,
        includeContent: args.include_content,
        previewChars: args.preview_chars,
        contentMaxChars: args.content_max_chars,
      });

      logActivity("semantic_search", {
        query: result.query,
        mode: result.mode,
        top_k: result.top_k,
        matches: result.matches.length,
        sample: result.matches.slice(0, 10).map((m) => ({
          id: m.item.id,
          kind: m.item.kind,
          file_path: m.item.file_path,
          score: m.score,
        })),
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({ ok: true, ...result }),
          },
        ],
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: String(err) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown(signal: string): Promise<void> {
  try {
    flushPendingChangeBuffer();
    await watcher?.close();
  } catch (err) {
    console.error("[vectormind] watcher close error:", err);
  }
  try {
    db?.close();
  } catch (err) {
    console.error("[vectormind] db close error:", err);
  }
  process.exit(signal === "SIGTERM" ? 143 : 130);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
