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
  BUILTIN_FRONTEND_OUTPUT_PURITY_INSTRUCTIONS,
  BUILTIN_GIT_COMMIT_SUMMARY_INSTRUCTIONS,
  BUILTIN_LOW_OVERHEAD_WORKFLOW_INSTRUCTIONS,
  BUILTIN_PAYLOAD_GUARD_INSTRUCTIONS,
  BUILTIN_PLAN_LITE_INSTRUCTIONS,
  BUILTIN_REQUIREMENT_BOUNDARY_AND_MODULARITY_INSTRUCTIONS,
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

type PendingChangeRow = {
  file_path: string;
  last_event: string;
  updated_at: string;
  source?: "watcher" | "git";
  git_status?: string;
  file_state_hash?: string;
};

type ExtractedSymbol = {
  name: string;
  type: string;
  signature: string;
};

type RtkDetection = {
  available: boolean;
  version?: string;
  command: string;
  note: string;
  gain_ok?: boolean;
  gain_preview?: string;
  path?: string;
  source?: "path" | "package_shim";
  exec_command?: string;
  exec_args_prefix?: string[];
  exec_shell?: boolean;
};

const SERVER_NAME = "vector-mind";
const SERVER_VERSION = "1.0.46";

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

const DEVELOPMENT_WARN_FILE_LINES = (() => {
  const raw = process.env.VECTORMIND_WARN_FILE_LINES?.trim();
  if (!raw) return 800;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 100) return 800;
  return Math.min(50_000, n);
})();

const DEVELOPMENT_BLOCK_FILE_LINES = (() => {
  const raw = process.env.VECTORMIND_BLOCK_FILE_LINES?.trim();
  if (!raw) return 1200;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < DEVELOPMENT_WARN_FILE_LINES) return Math.max(1200, DEVELOPMENT_WARN_FILE_LINES);
  return Math.min(100_000, n);
})();

const DEVELOPMENT_WARN_FILE_BYTES = (() => {
  const raw = process.env.VECTORMIND_WARN_FILE_BYTES?.trim();
  if (!raw) return 120_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 10_000) return 120_000;
  return Math.min(20_000_000, n);
})();

const DEVELOPMENT_WARN_PENDING_FILES = (() => {
  const raw = process.env.VECTORMIND_WARN_PENDING_FILES?.trim();
  if (!raw) return 12;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 12;
  return Math.min(500, n);
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

const MAINTENANCE_AUTO_ENABLED = (() => {
  const raw = (process.env.VECTORMIND_MAINTENANCE_AUTO ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "on", "yes"].includes(raw);
})();

const MAINTENANCE_INTERVAL_HOURS = (() => {
  const raw = process.env.VECTORMIND_MAINTENANCE_INTERVAL_HOURS?.trim();
  if (!raw) return 24;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 24;
  return Math.min(24 * 30, n);
})();

const MAINTENANCE_COMPACT_AFTER_DAYS = (() => {
  const raw = process.env.VECTORMIND_COMPACT_AFTER_DAYS?.trim();
  if (!raw) return 45;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 45;
  return Math.min(3650, n);
})();

const MAINTENANCE_MAX_MEMORY_ITEMS = (() => {
  const raw = process.env.VECTORMIND_MAINTENANCE_MAX_MEMORY_ITEMS?.trim();
  if (!raw) return 250;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 250;
  return Math.min(5000, n);
})();

const MAINTENANCE_MAX_INDEX_FILES = (() => {
  const raw = process.env.VECTORMIND_MAINTENANCE_MAX_INDEX_FILES?.trim();
  if (!raw) return 1500;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1500;
  return Math.min(50_000, n);
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

const SEMANTIC_EMBEDDINGS_TIMEOUT_MS = (() => {
  const raw = process.env.VECTORMIND_EMBEDDINGS_TIMEOUT_MS?.trim();
  if (!raw) return 1500;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 1500;
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
let listActiveRequirementsStmt: Database.Statement;
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
let upsertDecisionStmt: Database.Statement;
let getDecisionByKeyStmt: Database.Statement;
let listCurrentDecisionsStmt: Database.Statement;
let upsertProjectSummaryStmt: Database.Statement;
let getProjectSummaryStmt: Database.Statement;
let listRecentNotesStmt: Database.Statement;
let listRecentContextItemsStmt: Database.Statement;
let getLatestChangeIntentForFileStmt: Database.Statement;
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
let insertTokenSavingsStmt: Database.Statement;
let summarizeTokenSavingsStmt: Database.Statement;
let summarizeTokenSavingsByToolStmt: Database.Statement;
let listRecentTokenSavingsStmt: Database.Statement;
let getKvStmt: Database.Statement;
let setKvStmt: Database.Statement;

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
    case "memory_maintenance":
      return `memory_maintenance trigger=${String(d.trigger ?? "")} compacted=${String(
        d.compacted ?? "",
      )} stale=${String(d.stale_files ?? "")} chunks_deleted=${String(d.chunks_deleted ?? "")}`;
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

function isProbablyGitRepository(): boolean {
  try {
    return fs.existsSync(path.join(projectRoot, ".git"));
  } catch {
    return false;
  }
}

function normalizeGitStatusPath(raw: string): string {
  const first = raw.split("\0")[0] ?? "";
  return first.trim().replace(/\\/g, "/").replace(/^"(.*)"$/, "$1");
}

function collectGitPendingChanges(limit: number): PendingChangeRow[] {
  if (limit <= 0 || !isProbablyGitRepository()) return [];
  const git = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 2_000_000,
  });
  if (git.error || git.status !== 0 || !git.stdout) return [];

  const parts = git.stdout.split("\0").filter(Boolean);
  const rows: PendingChangeRow[] = [];
  for (let i = 0; i < parts.length && rows.length < limit; i++) {
    const rec = parts[i] ?? "";
    const status = rec.slice(0, 2);
    let rawPath = rec.slice(3);
    if (status.startsWith("R") || status.startsWith("C")) {
      // Porcelain -z rename/copy records include the destination in the next NUL field.
      rawPath = parts[i + 1] ?? rawPath;
      i += 1;
    }
    const filePath = normalizeGitStatusPath(rawPath);
    if (!filePath || filePath === ".vectormind" || filePath.startsWith(".vectormind/")) continue;
    rows.push({
      file_path: filePath,
      last_event: status.includes("D") ? "unlink" : status === "??" ? "add" : "change",
      updated_at: new Date().toISOString(),
      source: "git",
      git_status: status.trim() || "modified",
      file_state_hash: getFileStateHash(filePath) ?? undefined,
    });
  }
  return rows;
}

function mergePendingWithGit(
  pending: PendingChangeRow[],
  opts: { offset: number; limit: number },
): { total: number; page: PendingChangeRow[]; truncated: boolean } {
  const byPath = new Map<string, PendingChangeRow>();
  for (const p of pending) {
    if (shouldIgnoreDbFilePath(p.file_path)) continue;
    byPath.set(p.file_path, { ...p, source: p.source ?? "watcher" });
  }

  const gitRows = collectGitPendingChanges(Math.max(500, opts.offset + opts.limit * 4));
  for (const g of gitRows) {
    const latestSyncedHash = getLatestSyncedFileHash(g.file_path);
    if (latestSyncedHash && g.file_state_hash && latestSyncedHash === g.file_state_hash) continue;
    const existing = byPath.get(g.file_path);
    if (!existing) {
      byPath.set(g.file_path, g);
      continue;
    }
    byPath.set(g.file_path, {
      ...existing,
      source: existing.source === "watcher" ? "watcher" : g.source,
      git_status: g.git_status,
      file_state_hash: g.file_state_hash,
    });
  }

  const all = Array.from(byPath.values()).sort((a, b) => {
    const at = Date.parse(a.updated_at) || 0;
    const bt = Date.parse(b.updated_at) || 0;
    if (bt !== at) return bt - at;
    return a.file_path.localeCompare(b.file_path);
  });
  const page = all.slice(opts.offset, opts.offset + opts.limit);
  return { total: all.length, page, truncated: all.length > opts.offset + opts.limit };
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
    const baseWhere = NOISE_FILE_BASENAMES.map(() => "(LOWER(file_path) = ? OR LOWER(file_path) LIKE ?)").join(" OR ");

    const suffixArgs = NOISE_FILE_SUFFIXES.map((s) => `%${s}`);
    const baseArgs = NOISE_FILE_BASENAMES.flatMap((n) => [n, `%/${n}`]);

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

type MaintenanceIndexPruneResult = {
  ignored_paths: { chunks_deleted: number; symbols_deleted: number };
  filename_noise: { chunks_deleted: number; symbols_deleted: number };
  stale_files: {
    files_checked: number;
    files_matched: number;
    chunks_deleted: number;
    symbols_deleted: number;
    samples: string[];
  };
  hidden_embeddings: { embeddings_deleted: number };
};

type MaintenanceCompactionResult = {
  cutoff: string;
  candidates: number;
  compacted: number;
  summary_memory_id: number | null;
  archived: number;
  samples: Array<{ id: number; kind: string; title: string | null; file_path: string | null; updated_at: string }>;
};

type MaintenanceResult = {
  ok: true;
  dry_run: boolean;
  trigger: "manual" | "auto";
  generated_at: string;
  project_root: string;
  db_path: string;
  config: {
    compact_after_days: number;
    max_memory_items: number;
    max_index_files: number;
    compact_notes: boolean;
  };
  compacted_memory: MaintenanceCompactionResult;
  pruned: MaintenanceIndexPruneResult;
  vacuumed: boolean;
};

function kvGet(key: string): string | null {
  try {
    const row = getKvStmt?.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function kvSet(key: string, value: string): void {
  try {
    setKvStmt?.run(key, value);
  } catch (err) {
    console.error("[vectormind] kv set failed:", err);
  }
}

function distinctChunkAndSymbolFilePaths(limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT file_path
       FROM (
         SELECT file_path, MAX(updated_at) AS updated_at
         FROM memory_items
         WHERE file_path IS NOT NULL
           AND (kind = 'code_chunk' OR kind = 'doc_chunk')
         GROUP BY file_path
         UNION
         SELECT file_path, CURRENT_TIMESTAMP AS updated_at
         FROM symbols
         WHERE file_path IS NOT NULL
         GROUP BY file_path
       )
       WHERE file_path IS NOT NULL
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{ file_path: string }>;
  return Array.from(new Set(rows.map((r) => r.file_path).filter(Boolean)));
}

function classifyStaleIndexFile(filePath: string): string | null {
  if (!filePath) return "empty_path";
  if (shouldIgnoreDbFilePath(filePath)) return "ignored_path";
  if (shouldIgnoreContentFile(filePath)) return "filename_noise";

  const absPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  const rel = path.relative(projectRoot, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "outside_project";
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return "missing_file";
  }
  if (!stat.isFile()) return "not_file";
  if (!isContentIndexableFile(absPath) && !isSymbolIndexableFile(absPath)) return "not_indexable";
  return null;
}

function pruneStaleFileIndexes(opts: {
  dryRun: boolean;
  maxIndexFiles: number;
}): MaintenanceIndexPruneResult["stale_files"] {
  const filePaths = distinctChunkAndSymbolFilePaths(Math.min(50_000, opts.maxIndexFiles * 3));
  const matched: Array<{ file_path: string; reason: string }> = [];
  for (const fp of filePaths) {
    if (matched.length >= opts.maxIndexFiles) break;
    const reason = classifyStaleIndexFile(fp);
    if (reason) matched.push({ file_path: fp, reason });
  }

  let chunksDeleted = 0;
  let symbolsDeleted = 0;
  const samples = matched.slice(0, 20).map((m) => `${m.file_path} (${m.reason})`);

  if (!opts.dryRun && matched.length) {
    const tx = db.transaction(() => {
      for (const m of matched) {
        chunksDeleted += deleteFileChunkItemsStmt.run(m.file_path).changes;
        symbolsDeleted += deleteSymbolsForFileStmt.run(m.file_path).changes;
      }
    });
    try {
      tx();
    } catch (err) {
      console.error("[vectormind] prune stale indexes failed:", err);
    }
  } else if (opts.dryRun && matched.length) {
    const countChunksStmt = db.prepare(
      `SELECT COUNT(1) AS c
       FROM memory_items
       WHERE file_path = ?
         AND (kind = 'code_chunk' OR kind = 'doc_chunk')`,
    );
    const countSymbolsStmt = db.prepare(`SELECT COUNT(1) AS c FROM symbols WHERE file_path = ?`);
    for (const m of matched) {
      chunksDeleted += Number((countChunksStmt.get(m.file_path) as { c: number } | undefined)?.c ?? 0);
      symbolsDeleted += Number((countSymbolsStmt.get(m.file_path) as { c: number } | undefined)?.c ?? 0);
    }
  }

  if (!opts.dryRun && (chunksDeleted || symbolsDeleted)) {
    logActivity("index_prune", {
      reason: "stale_files",
      files_matched: matched.length,
      chunks_deleted: chunksDeleted,
      symbols_deleted: symbolsDeleted,
      samples,
    });
  }

  return {
    files_checked: filePaths.length,
    files_matched: matched.length,
    chunks_deleted: chunksDeleted,
    symbols_deleted: symbolsDeleted,
    samples,
  };
}

function countIgnoredIndexDeletes(): { chunks_deleted: number; symbols_deleted: number } {
  if (!IGNORED_LIKE_PATTERNS.length) return { chunks_deleted: 0, symbols_deleted: 0 };
  const where = IGNORED_LIKE_PATTERNS
    .map(() => "LOWER(REPLACE(file_path, '\\\\', '/')) LIKE ?")
    .join(" OR ");
  const chunksDeleted = Number(
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
  const symbolsDeleted = Number(
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
  return { chunks_deleted: chunksDeleted, symbols_deleted: symbolsDeleted };
}

function countFilenameNoiseIndexDeletes(): { chunks_deleted: number; symbols_deleted: number } {
  const suffixWhere = NOISE_FILE_SUFFIXES.map(() => "LOWER(file_path) LIKE ?").join(" OR ");
  const baseWhere = NOISE_FILE_BASENAMES.map(() => "(LOWER(file_path) = ? OR LOWER(file_path) LIKE ?)").join(" OR ");
  const suffixArgs = NOISE_FILE_SUFFIXES.map((s) => `%${s}`);
  const baseArgs = NOISE_FILE_BASENAMES.flatMap((n) => [n, `%/${n}`]);
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
  const chunksDeleted = Number(
    (
      db
        .prepare(
          `SELECT COUNT(1) AS c
           FROM memory_items
           WHERE file_path IS NOT NULL
             AND (kind = 'code_chunk' OR kind = 'doc_chunk')
             AND (${where})`,
        )
        .get(...args) as { c: number } | undefined
    )?.c ?? 0,
  );
  const symbolsDeleted = Number(
    (
      db
        .prepare(
          `SELECT COUNT(1) AS c
           FROM symbols
           WHERE file_path IS NOT NULL
             AND (${where})`,
        )
        .get(...args) as { c: number } | undefined
    )?.c ?? 0,
  );
  return { chunks_deleted: chunksDeleted, symbols_deleted: symbolsDeleted };
}

function hiddenEmbeddingIds(limit = 10_000): number[] {
  const rows = db
    .prepare(
      `SELECT e.memory_id AS memory_id, m.metadata_json AS metadata_json
       FROM embeddings e
       JOIN memory_items m ON m.id = e.memory_id
       WHERE m.metadata_json LIKE '%compacted%'
          OR m.metadata_json LIKE '%superseded%'
       LIMIT ?`,
    )
    .all(limit) as Array<{ memory_id: number; metadata_json: string | null }>;
  return rows
    .filter((r) => isHiddenFromDefaultRecall({ metadata_json: r.metadata_json }))
    .map((r) => r.memory_id);
}

function pruneHiddenEmbeddings(dryRun: boolean): MaintenanceIndexPruneResult["hidden_embeddings"] {
  const ids = hiddenEmbeddingIds();
  if (!ids.length) return { embeddings_deleted: 0 };
  if (!dryRun) {
    const deleteStmt = db.prepare(`DELETE FROM embeddings WHERE memory_id = ?`);
    const tx = db.transaction(() => {
      for (const id of ids) deleteStmt.run(id);
    });
    try {
      tx();
    } catch (err) {
      console.error("[vectormind] prune hidden embeddings failed:", err);
    }
  }
  return { embeddings_deleted: ids.length };
}

function selectCompactionCandidates(opts: {
  compactAfterDays: number;
  maxMemoryItems: number;
  compactNotes: boolean;
}): Array<MemoryItemRow & { req_status?: string | null }> {
  const kinds = opts.compactNotes
    ? ["requirement", "change_intent", "note"]
    : ["requirement", "change_intent"];
  const placeholders = kinds.map(() => "?").join(", ");
  const rows = db
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

function compactOldMemoryItems(opts: {
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
  const archiveStmt = db.prepare(
    `INSERT OR IGNORE INTO memory_item_archive
       (memory_id, original_kind, original_title, original_content, original_file_path,
        original_start_line, original_end_line, original_req_id, original_metadata_json,
        original_content_hash, original_created_at, original_updated_at, archive_reason, compacted_into_id)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateMemoryStmt = db.prepare(
    `UPDATE memory_items
     SET content = ?, metadata_json = ?, content_hash = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  );
  const deleteEmbeddingStmt = db.prepare(`DELETE FROM embeddings WHERE memory_id = ?`);

  const tx = db.transaction(() => {
    const info = insertMemoryItemStmt.run(
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
      deleteEmbeddingStmt.run(row.id);
    }
  });

  try {
    tx();
    if (summaryMemoryId) enqueueEmbedding(summaryMemoryId);
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

function runMemoryMaintenance(
  args: z.infer<typeof MaintainMemoryArgsSchema>,
  trigger: "manual" | "auto" = "manual",
): MaintenanceResult {
  const compactedMemory = args.compact_old_memories
    ? compactOldMemoryItems({
        dryRun: args.dry_run,
        compactAfterDays: args.compact_after_days,
        maxMemoryItems: args.max_memory_items,
        compactNotes: args.compact_notes,
      })
    : {
        cutoff: new Date(Date.now() - args.compact_after_days * 86_400_000).toISOString(),
        candidates: 0,
        compacted: 0,
        summary_memory_id: null,
        archived: 0,
        samples: [],
      };

  const ignoredPaths = args.prune_ignored_paths
    ? args.dry_run
      ? countIgnoredIndexDeletes()
      : pruneIgnoredIndexesByPathPatterns()
    : { chunks_deleted: 0, symbols_deleted: 0 };

  const filenameNoise = args.prune_filename_noise
    ? args.dry_run
      ? countFilenameNoiseIndexDeletes()
      : pruneFilenameNoiseIndexes()
    : { chunks_deleted: 0, symbols_deleted: 0 };

  const staleFiles = args.prune_stale_indexes
    ? pruneStaleFileIndexes({ dryRun: args.dry_run, maxIndexFiles: args.max_index_files })
    : { files_checked: 0, files_matched: 0, chunks_deleted: 0, symbols_deleted: 0, samples: [] };

  const hiddenEmbeddings = args.prune_hidden_embeddings
    ? pruneHiddenEmbeddings(args.dry_run)
    : { embeddings_deleted: 0 };

  let vacuumed = false;
  if (!args.dry_run && args.vacuum) {
    try {
      db.exec("VACUUM");
      vacuumed = true;
    } catch (err) {
      console.error("[vectormind] maintenance vacuum failed:", err);
    }
  }

  const result: MaintenanceResult = {
    ok: true,
    dry_run: args.dry_run,
    trigger,
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    db_path: dbPath,
    config: {
      compact_after_days: args.compact_after_days,
      max_memory_items: args.max_memory_items,
      max_index_files: args.max_index_files,
      compact_notes: args.compact_notes,
    },
    compacted_memory: compactedMemory,
    pruned: {
      ignored_paths: ignoredPaths,
      filename_noise: filenameNoise,
      stale_files: staleFiles,
      hidden_embeddings: hiddenEmbeddings,
    },
    vacuumed,
  };

  logActivity("memory_maintenance", {
    trigger,
    dry_run: args.dry_run,
    compacted: result.compacted_memory.compacted,
    stale_files: result.pruned.stale_files.files_matched,
    chunks_deleted:
      result.pruned.ignored_paths.chunks_deleted +
      result.pruned.filename_noise.chunks_deleted +
      result.pruned.stale_files.chunks_deleted,
  });

  return result;
}

function runAutoMaintenanceIfDue(): void {
  if (!MAINTENANCE_AUTO_ENABLED || !db) return;
  const lastRaw = kvGet("maintenance.last_auto_at");
  const last = lastRaw ? Date.parse(lastRaw) : 0;
  const dueMs = MAINTENANCE_INTERVAL_HOURS * 3_600_000;
  if (Number.isFinite(last) && last > 0 && Date.now() - last < dueMs) return;

  try {
    runMemoryMaintenance(
      {
        project_root: projectRoot,
        dry_run: false,
        format: "compact",
        compact_old_memories: true,
        compact_notes: false,
        prune_stale_indexes: true,
        prune_ignored_paths: true,
        prune_filename_noise: true,
        prune_hidden_embeddings: true,
        compact_after_days: MAINTENANCE_COMPACT_AFTER_DAYS,
        max_memory_items: MAINTENANCE_MAX_MEMORY_ITEMS,
        max_index_files: MAINTENANCE_MAX_INDEX_FILES,
        vacuum: false,
      },
      "auto",
    );
    kvSet("maintenance.last_auto_at", new Date().toISOString());
  } catch (err) {
    console.error("[vectormind] auto maintenance failed:", err);
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

type DevelopmentWarning = {
  code:
    | "large_file"
    | "very_large_file"
    | "many_pending_files"
    | "broad_change_surface"
    | "unspecified_change_target"
    | "large_file_read"
    | "cross_project_path"
    | "multiple_active_requirements"
    | "broad_requirement_scope";
  severity: "info" | "warning" | "blocker";
  message: string;
  files?: string[];
  details?: Record<string, unknown>;
};

type DevelopmentWarningFileInput = {
  file_path: string;
  last_event?: string;
  event?: string;
  updated_at?: string;
};

type PathScopeCheck = {
  input_path: string;
  abs_path: string;
  in_project: boolean;
  project_root: string;
};

function isLikelySourceImplementationFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return new Set([
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
    ".vue",
    ".svelte",
  ]).has(ext);
}

function countFileLinesBounded(absPath: string, maxBytes: number): { lines: number; truncated: boolean } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const bytesToRead = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(absPath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const read = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    let lines = read > 0 ? 1 : 0;
    for (let i = 0; i < read; i++) {
      if (buffer[i] === 10) lines += 1;
    }
    return { lines, truncated: stat.size > bytesToRead };
  } finally {
    fs.closeSync(fd);
  }
}

function isPathInsideProjectRoot(absPath: string): boolean {
  const root = path.resolve(projectRoot);
  const rel = path.relative(root, path.resolve(absPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function checkPathScope(inputPath: string): PathScopeCheck {
  const normalizedInput = inputPath.trim() || ".";
  const absPath = path.resolve(path.isAbsolute(normalizedInput) ? normalizedInput : path.join(projectRoot, normalizedInput));
  return {
    input_path: inputPath,
    abs_path: absPath,
    in_project: isPathInsideProjectRoot(absPath),
    project_root: path.resolve(projectRoot),
  };
}

function buildCrossProjectPathWarnings(paths: string[] | null | undefined): DevelopmentWarning[] {
  const checks = (paths ?? []).map((p) => checkPathScope(p)).filter((c) => !c.in_project);
  if (!checks.length) return [];
  return [
    {
      code: "cross_project_path",
      severity: "warning",
      message:
        "A path points outside the current project_root. Switch project_root intentionally before reading/searching another repo; do not mix unrelated project context into the current requirement.",
      files: checks.slice(0, 10).map((c) => c.input_path),
      details: {
        project_root: path.resolve(projectRoot),
        paths: checks.slice(0, 10),
        total_paths: checks.length,
      },
    },
  ];
}

function buildFileReadDevelopmentWarnings(filePath: string, absPath: string, stat?: fs.Stats): DevelopmentWarning[] {
  const warnings: DevelopmentWarning[] = [];
  if (!isPathInsideProjectRoot(absPath)) {
    warnings.push(...buildCrossProjectPathWarnings([filePath]));
    return warnings;
  }
  if (!isLikelySourceImplementationFile(filePath)) return warnings;

  let st = stat;
  try {
    st ??= fs.statSync(absPath);
  } catch {
    return warnings;
  }
  if (!st.isFile()) return warnings;

  const lineInfo = countFileLinesBounded(absPath, 2_000_000);
  const lineCount = lineInfo?.lines ?? 0;
  const tooManyLines = lineCount >= DEVELOPMENT_BLOCK_FILE_LINES;
  const warnLines = lineCount >= DEVELOPMENT_WARN_FILE_LINES;
  const warnBytes = st.size >= DEVELOPMENT_WARN_FILE_BYTES;
  if (!tooManyLines && !warnLines && !warnBytes) return warnings;

  warnings.push({
    code: "large_file_read",
    severity: tooManyLines ? "blocker" : "warning",
    message: tooManyLines
      ? "You are reading a very large implementation file. Do not keep patching new feature code into it; identify a narrow function and split new behavior into focused modules unless this task is explicitly a planned extraction."
      : "You are reading a large implementation file. Keep the target narrow and prefer extracting focused modules before adding responsibilities.",
    files: [filePath],
    details: {
      lines: lineInfo?.truncated ? `${lineCount}+` : lineCount,
      bytes: st.size,
      warn_lines: DEVELOPMENT_WARN_FILE_LINES,
      block_lines: DEVELOPMENT_BLOCK_FILE_LINES,
      warn_bytes: DEVELOPMENT_WARN_FILE_BYTES,
    },
  });
  return warnings;
}

function buildMatchedFileDevelopmentWarnings(filePaths: Array<string | null | undefined>): DevelopmentWarning[] {
  const seen = new Set<string>();
  const warnings: DevelopmentWarning[] = [];
  for (const fp of filePaths) {
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    const abs = path.isAbsolute(fp) ? path.resolve(fp) : path.join(projectRoot, fp);
    warnings.push(...buildFileReadDevelopmentWarnings(normalizeToDbPath(fp), abs));
    if (warnings.length >= 8) break;
  }
  return warnings;
}

function buildRequirementStartWarnings(args: {
  title: string;
  background: string;
  close_previous: boolean;
}): DevelopmentWarning[] {
  const warnings: DevelopmentWarning[] = [];
  const activeReqs = listActiveRequirementsStmt.all(10) as RequirementRow[];

  if (!args.close_previous && activeReqs.length > 0) {
    warnings.push({
      code: "multiple_active_requirements",
      severity: "warning",
      message:
        "Starting a requirement without closing previous active requirements can mix unrelated context. Only keep multiple active requirements when the user explicitly asked for parallel work.",
      details: {
        active_requirements: activeReqs.slice(0, 5).map((r) => ({ id: r.id, title: r.title, status: r.status })),
      },
    });
  }

  const text = `${args.title}\n${args.background}`.toLowerCase();
  const broadTerms = [
    "顺便",
    "一起",
    "所有",
    "全部",
    "整体",
    "重构",
    "统一",
    "优化一下",
    "顺手",
    "相关的",
    "all ",
    "everything",
    "refactor",
    "cleanup",
    "clean up",
  ];
  const matched = broadTerms.filter((term) => text.includes(term));
  if (matched.length >= 2 || text.length > 1800) {
    warnings.push({
      code: "broad_requirement_scope",
      severity: "warning",
      message:
        "The requirement wording looks broad. Treat the current user request as the only boundary; do not add extra workflows, fields, pages, interfaces, or touch completed related features unless explicitly required.",
      details: { matched_terms: matched.slice(0, 10), text_length: text.length },
    });
  }

  return warnings;
}

function buildDevelopmentWarnings(
  files: DevelopmentWarningFileInput[],
  opts: { includeUnspecified?: boolean } = {},
): DevelopmentWarning[] {
  const warnings: DevelopmentWarning[] = [];
  const uniqueFiles = Array.from(
    new Set(
      files
        .map((f) => f.file_path)
        .filter((f) => !!f && f !== "(unspecified)")
        .map((f) => normalizeToDbPath(f)),
    ),
  );

  if (opts.includeUnspecified || files.some((f) => f.file_path === "(unspecified)")) {
    warnings.push({
      code: "unspecified_change_target",
      severity: "warning",
      message:
        "No changed file target was captured. For development work, sync concrete files so the current requirement owns only its real changes.",
    });
  }

  if (uniqueFiles.length >= DEVELOPMENT_WARN_PENDING_FILES) {
    warnings.push({
      code: "many_pending_files",
      severity: "warning",
      message:
        "This requirement touches many files. Re-check the user request and keep only files required by the current requirement.",
      files: uniqueFiles.slice(0, 20),
      details: { total_files: uniqueFiles.length, threshold: DEVELOPMENT_WARN_PENDING_FILES },
    });
  }

  const topDirs = new Set(
    uniqueFiles
      .map((f) => f.replace(/\\/g, "/").split("/").filter(Boolean)[0] ?? "")
      .filter(Boolean),
  );
  if (uniqueFiles.length >= 6 && topDirs.size >= 4) {
    warnings.push({
      code: "broad_change_surface",
      severity: "warning",
      message:
        "Changed files span several top-level areas. Avoid modifying completed or merely related features unless the current requirement explicitly needs it.",
      files: uniqueFiles.slice(0, 20),
      details: { top_level_dirs: Array.from(topDirs).slice(0, 12), total_dirs: topDirs.size },
    });
  }

  for (const relPath of uniqueFiles) {
    if (!isLikelySourceImplementationFile(relPath)) continue;
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const lineInfo = countFileLinesBounded(absPath, 2_000_000);
    const lineCount = lineInfo?.lines ?? 0;
    const tooManyLines = lineCount >= DEVELOPMENT_BLOCK_FILE_LINES;
    const warnLines = lineCount >= DEVELOPMENT_WARN_FILE_LINES;
    const warnBytes = stat.size >= DEVELOPMENT_WARN_FILE_BYTES;
    if (!tooManyLines && !warnLines && !warnBytes) continue;

    warnings.push({
      code: tooManyLines ? "very_large_file" : "large_file",
      severity: tooManyLines ? "blocker" : "warning",
      message: tooManyLines
        ? "This implementation file is already very large. Do not add new feature code here by default; split into a focused module/service/component and keep this file as a thin entry."
        : "This implementation file is getting large. Prefer extracting focused modules instead of continuing to pile unrelated responsibilities into it.",
      files: [relPath],
      details: {
        lines: lineInfo?.truncated ? `${lineCount}+` : lineCount,
        bytes: stat.size,
        warn_lines: DEVELOPMENT_WARN_FILE_LINES,
        block_lines: DEVELOPMENT_BLOCK_FILE_LINES,
        warn_bytes: DEVELOPMENT_WARN_FILE_BYTES,
      },
    });
  }

  return warnings;
}

function compactDevelopmentWarningsText(warnings: DevelopmentWarning[]): string[] {
  if (!warnings.length) return [];
  const lines = ["development warnings:"];
  for (const w of warnings.slice(0, 8)) {
    const files = w.files?.length ? ` files=${w.files.slice(0, 5).join(",")}` : "";
    lines.push(`- ${w.severity} ${w.code}: ${oneLine(w.message, 180)}${files}`);
  }
  return lines;
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

const OutputFormatSchema = z.object({
  format: z.enum(["compact", "json"]).optional().default("compact"),
});

type OutputFormat = z.infer<typeof OutputFormatSchema>["format"];

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

const QueryCodebaseArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    query: z.string().min(1),
  }),
);

const GrepArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
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

const ReadFileLinesArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
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

const ReadFileTextArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
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

const ReadCodexTextFileArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    // Absolute path, file:// URI, or a path under CODEX_HOME / AGENTS_HOME allowed roots.
    path: z.string().min(1),
    offset: z.number().int().min(0).optional().default(0),
    max_chars: z.number().int().min(1).max(200_000).optional().default(20_000),
    max_file_bytes: z.number().int().min(1_000).max(5_000_000).optional().default(1_000_000),
  }),
);

const ListProjectFilesArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
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

const UpsertDecisionArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    key: z.string().min(1),
    title: z.string().optional().default(""),
    content: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
    supersedes_req_ids: z.array(z.number().int().positive()).optional(),
    supersedes_memory_ids: z.array(z.number().int().positive()).optional(),
    related_files: z.array(z.string().min(1)).optional(),
  }),
);

const SupersedeMemoryArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    superseded_req_ids: z.array(z.number().int().positive()).optional(),
    superseded_memory_ids: z.array(z.number().int().positive()).optional(),
    replacement_req_id: z.number().int().positive().optional(),
    replacement_memory_id: z.number().int().positive().optional(),
    reason: z.string().min(1),
  }),
);

const MaintainMemoryArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
  z.object({
    dry_run: z.boolean().optional().default(true),
    compact_old_memories: z.boolean().optional().default(true),
    compact_notes: z.boolean().optional().default(false),
    prune_stale_indexes: z.boolean().optional().default(true),
    prune_ignored_paths: z.boolean().optional().default(true),
    prune_filename_noise: z.boolean().optional().default(true),
    prune_hidden_embeddings: z.boolean().optional().default(true),
    compact_after_days: z.number().int().min(1).max(3650).optional().default(MAINTENANCE_COMPACT_AFTER_DAYS),
    max_memory_items: z.number().int().min(1).max(5000).optional().default(MAINTENANCE_MAX_MEMORY_ITEMS),
    max_index_files: z.number().int().min(1).max(50_000).optional().default(MAINTENANCE_MAX_INDEX_FILES),
    vacuum: z.boolean().optional().default(false),
  }),
);

const DEFAULT_PENDING_LIMIT = 10;
const MAX_PENDING_LIMIT = 2000;

const PendingPagingSchema = z.object({
  pending_offset: z.number().int().min(0).optional().default(0),
  pending_limit: z.number().int().min(1).max(MAX_PENDING_LIMIT).optional().default(DEFAULT_PENDING_LIMIT),
});

const DEFAULT_PREVIEW_CHARS = 120;
const PreviewSchema = z.object({
  preview_chars: z.number().int().min(50).max(10_000).optional().default(DEFAULT_PREVIEW_CHARS),
});

const DEFAULT_CONTENT_MAX_CHARS = 1200;
const ContentMaxSchema = z.object({
  content_max_chars: z.number().int().min(0).max(200_000).optional().default(DEFAULT_CONTENT_MAX_CHARS),
});

const DEFAULT_RECENT_REQUIREMENTS = 2;
const DEFAULT_RECENT_CHANGES_PER_REQ = 3;
const DEFAULT_RECENT_NOTES = 3;
const DEFAULT_CONVENTIONS_LIMIT = 0;
const DEFAULT_DECISIONS_LIMIT = 5;
const DEFAULT_CURRENT_CONTEXT_LIMIT = 8;
const MAX_DECISIONS_LIMIT = 50;
const MAX_CURRENT_CONTEXT_LIMIT = 50;

const BrainDumpLimitsSchema = z.object({
  requirements_limit: z.number().int().min(1).max(20).optional().default(DEFAULT_RECENT_REQUIREMENTS),
  changes_limit: z.number().int().min(1).max(100).optional().default(DEFAULT_RECENT_CHANGES_PER_REQ),
  notes_limit: z.number().int().min(0).max(50).optional().default(DEFAULT_RECENT_NOTES),
  conventions_limit: z.number().int().min(0).max(200).optional().default(DEFAULT_CONVENTIONS_LIMIT),
  decisions_limit: z.number().int().min(0).max(MAX_DECISIONS_LIMIT).optional().default(DEFAULT_DECISIONS_LIMIT),
  current_context_limit: z
    .number()
    .int()
    .min(0)
    .max(MAX_CURRENT_CONTEXT_LIMIT)
    .optional()
    .default(DEFAULT_CURRENT_CONTEXT_LIMIT),
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
  .merge(OutputFormatSchema)
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
    top_k: z.number().int().min(1).max(50).optional().default(3),
    kinds: z.array(z.string().min(1)).optional(),
    include_content: z.boolean().optional().default(false),
    pending_offset: z.number().int().min(0).optional().default(0),
    pending_limit: z.number().int().min(1).max(MAX_PENDING_LIMIT).optional().default(DEFAULT_PENDING_LIMIT),
  })
    .merge(OutputFormatSchema)
    .merge(PreviewSchema)
    .merge(ContentMaxSchema)
    .merge(BrainDumpLimitsSchema),
);

const SemanticSearchArgsSchema = ProjectRootArgSchema.merge(OutputFormatSchema).merge(
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

const GetTokenSavingsArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    limit: z.number().int().min(1).max(100).optional().default(10),
    format: z.enum(["compact", "json"]).optional().default("compact"),
  }),
);

const DetectRtkArgsSchema = ProjectRootArgSchema;

const InstallRtkArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    dry_run: z.boolean().optional().default(true),
    method: z.enum(["auto", "cargo", "brew", "shell_script"]).optional().default("auto"),
    init: z
      .enum(["none", "global_no_patch", "global_auto_patch", "global_hook_only", "local", "codex_global", "codex_local"])
      .optional()
      .default("none"),
    uninstall_wrong_cargo_rtk: z.boolean().optional().default(false),
    timeout_ms: z.number().int().min(10_000).max(1_800_000).optional().default(600_000),
  }),
);

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

function getFileStateHash(dbOrAbsPath: string): string | null {
  try {
    const abs = path.isAbsolute(dbOrAbsPath) ? dbOrAbsPath : path.join(projectRoot, dbOrAbsPath);
    const st = fs.statSync(abs);
    if (!st.isFile()) return sha256Hex(`non-file:${st.mtimeMs}:${st.size}`);
    if (st.size <= 5_000_000) {
      return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    }
    return sha256Hex(`large:${st.size}:${Math.floor(st.mtimeMs)}`);
  } catch {
    return sha256Hex("missing");
  }
}

function getLatestSyncedFileHash(dbFilePath: string): string | null {
  const row = getLatestChangeIntentForFileStmt?.get(dbFilePath) as MemoryItemRow | undefined;
  if (!row) return null;
  const meta = parseMetadataJson(row.metadata_json);
  return typeof meta.file_state_hash === "string" ? meta.file_state_hash : null;
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

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function recordTokenSavings(tool: string, rawText: string, outputText: string): void {
  if (!db || !insertTokenSavingsStmt) return;
  const rawTokens = estimateTokens(rawText);
  const outputTokens = estimateTokens(outputText);
  const savedTokens = Math.max(0, rawTokens - outputTokens);
  const savingsPct = rawTokens > 0 ? (savedTokens / rawTokens) * 100 : 0;
  try {
    insertTokenSavingsStmt.run(tool, rawTokens, outputTokens, savedTokens, savingsPct);
  } catch (err) {
    console.error("[vectormind] token savings record failed:", err);
  }
}

function toolText(tool: string, rawValue: unknown, compactText: string, format: "compact" | "json" = "compact"): string {
  const rawText = toolJson(rawValue);
  if (format === "json") return rawText;
  recordTokenSavings(tool, rawText, compactText);
  return compactText;
}

function toolCompactOrJson(tool: string, rawValue: unknown, compactText: string, format: OutputFormat): string {
  return toolText(tool, rawValue, compactText, format);
}

function oneLine(input: string | null | undefined, max = 120): string {
  const text = (input ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function compactMemoryLabel(item: ReturnType<typeof toMemoryItemPreview>, max = 120): string {
  const title = item.title ? ` ${oneLine(item.title, 48)}` : "";
  const loc = item.file_path ? ` ${item.file_path}${item.start_line != null ? `:${item.start_line}` : ""}` : "";
  const body = item.preview ? ` — ${oneLine(item.preview, max)}` : "";
  return `#${item.id} ${item.kind}${title}${loc}${body}`;
}

function compactRequirementLabel(req: ReturnType<typeof toRequirementPreview>): string {
  const ctx = req.context_preview ? ` — ${oneLine(req.context_preview, 100)}` : "";
  const mem = req.memory_item_id ? ` mem#${req.memory_item_id}` : "";
  return `req#${req.id}${mem} [${req.status}] ${oneLine(req.title, 80)}${ctx}`;
}

function compactChangeLabel(change: ReturnType<typeof toChangeLogPreview>): string {
  return `change#${change.id} ${change.file_path}: ${oneLine(change.intent_preview, 120)}`;
}

function compactPendingLabel(p: { file_path: string; last_event: string; updated_at: string }): string {
  const source = "source" in p && p.source === "git" ? " git" : "";
  const status = "git_status" in p && p.git_status ? ` ${p.git_status}` : "";
  return `${p.last_event}${source}${status} ${p.file_path}`;
}

function compactSemanticSearchText(data: { ok?: boolean } & SemanticSearchResult): string {
  const lines: string[] = [
    `semantic ${data.mode} ${data.matches.length}/${data.top_k} q="${oneLine(data.query, 100)}"`,
  ];
  for (const m of data.matches.slice(0, data.top_k)) {
    lines.push(`- score=${m.score.toFixed(3)} ${compactMemoryLabel(m.item, 160)}`);
  }
  if (!data.matches.length) lines.push("- no matches");
  lines.push("hint: use format=json for full metadata; read_memory_item(id) for full content");
  return lines.join("\n");
}

function compactGrepText(data: {
  ok?: boolean;
  backend: GrepBackend;
  fallback_reason?: string;
  ripgrep_error?: string;
  query: string;
  mode: "regex" | "literal";
  matches: GrepMatch[];
  total_matches?: number;
  truncated: boolean;
  development_warnings?: DevelopmentWarning[];
  candidates?: { total: number; scanned: number };
}): string {
  const total = data.total_matches ?? data.matches.length;
  const fallback = data.fallback_reason ? ` fallback=${data.fallback_reason}` : "";
  const candidateText = data.candidates ? ` candidates=${data.candidates.scanned}/${data.candidates.total}` : "";
  const lines = [
    `grep ${data.backend}${fallback} mode=${data.mode} matches=${data.matches.length}/${total} truncated=${data.truncated}${candidateText} q="${oneLine(data.query, 100)}"`,
  ];
  lines.push(...compactDevelopmentWarningsText(data.development_warnings ?? []));
  if (data.ripgrep_error) lines.push(`ripgrep_error ${oneLine(data.ripgrep_error, 180)}`);
  for (const m of data.matches.slice(0, 80)) {
    lines.push(`${m.file_path}:${m.line}:${m.col}: ${oneLine(m.preview, 220)}`);
  }
  if (!data.matches.length) lines.push("- no matches");
  if (data.truncated) lines.push("hint: refine query/include_paths or raise max_results; use format=json for full match objects");
  return lines.join("\n");
}

function compactListProjectFilesText(data: {
  path: string;
  path_kind: string;
  recursive: boolean;
  max_depth: number;
  returned: number;
  scanned: number;
  truncated: boolean;
  entries: ProjectFileListEntry[];
}): string {
  const lines = [
    `files path=${data.path} kind=${data.path_kind} returned=${data.returned} scanned=${data.scanned} recursive=${data.recursive} depth=${data.max_depth} truncated=${data.truncated}`,
  ];
  for (const e of data.entries.slice(0, 200)) {
    const stat = e.size != null ? ` ${e.size}B` : "";
    lines.push(`${e.kind === "dir" ? "d" : "f"} ${e.path}${stat}`);
  }
  if (!data.entries.length) lines.push("- empty");
  if (data.truncated) lines.push("hint: narrow path/filters or raise max_results; use format=json for full entry metadata");
  return lines.join("\n");
}

function compactReadTextFileText(data: {
  file_path: string;
  offset?: number;
  returned_chars: number;
  total_chars: number;
  truncated: boolean;
  development_warnings?: DevelopmentWarning[];
  text: string;
}): string {
  const offset = data.offset != null ? ` offset=${data.offset}` : "";
  const header = `file ${data.file_path}${offset} chars=${data.returned_chars}/${data.total_chars} truncated=${data.truncated}`;
  const hint = data.truncated ? "\nhint: continue with offset or read_file_lines; use format=json for metadata fields" : "";
  const warnings = compactDevelopmentWarningsText(data.development_warnings ?? []).join("\n");
  return `${header}${warnings ? `\n${warnings}` : ""}\n${data.text}${hint}`;
}

function compactReadFileLinesText(data: {
  file_path: string;
  from_line: number;
  to_line: number;
  returned: number;
  truncated: boolean;
  development_warnings?: DevelopmentWarning[];
  text: string;
}): string {
  const header = `lines ${data.file_path}:${data.from_line}-${data.to_line} returned=${data.returned} truncated=${data.truncated}`;
  const hint = data.truncated ? "\nhint: narrow range or raise max_lines/max_chars; use format=json for metadata fields" : "";
  const warnings = compactDevelopmentWarningsText(data.development_warnings ?? []).join("\n");
  return `${header}${warnings ? `\n${warnings}` : ""}\n${data.text}${hint}`;
}

function compactQueryCodebaseText(data: {
  query: string;
  matches: SymbolRow[];
  development_warnings?: DevelopmentWarning[];
}): string {
  const lines = [`query_codebase matches=${data.matches.length} q="${oneLine(data.query, 100)}"`];
  lines.push(...compactDevelopmentWarningsText(data.development_warnings ?? []));
  for (const m of data.matches.slice(0, 50)) {
    lines.push(`${m.file_path}: ${m.type} ${m.name}${m.signature ? ` — ${oneLine(m.signature, 160)}` : ""}`);
  }
  if (!data.matches.length) lines.push("- no matches");
  return lines.join("\n");
}

function compactMaintenanceText(data: MaintenanceResult): string {
  const prunedChunks =
    data.pruned.ignored_paths.chunks_deleted +
    data.pruned.filename_noise.chunks_deleted +
    data.pruned.stale_files.chunks_deleted;
  const prunedSymbols =
    data.pruned.ignored_paths.symbols_deleted +
    data.pruned.filename_noise.symbols_deleted +
    data.pruned.stale_files.symbols_deleted;
  const lines = [
    `maintain_memory ok dry_run=${data.dry_run} trigger=${data.trigger} compacted=${data.compacted_memory.compacted}/${data.compacted_memory.candidates} archived=${data.compacted_memory.archived} pruned_chunks=${prunedChunks} pruned_symbols=${prunedSymbols} hidden_embeddings=${data.pruned.hidden_embeddings.embeddings_deleted}`,
  ];
  if (data.compacted_memory.summary_memory_id) {
    lines.push(`summary memory_compaction #${data.compacted_memory.summary_memory_id}`);
  }
  if (data.compacted_memory.samples.length) {
    lines.push("memory candidates:");
    for (const s of data.compacted_memory.samples.slice(0, 8)) {
      lines.push(`- #${s.id} ${s.kind} ${s.file_path ?? ""} ${oneLine(s.title ?? "", 80)} ${s.updated_at}`);
    }
  }
  if (data.pruned.stale_files.samples.length) {
    lines.push("stale index samples:");
    for (const s of data.pruned.stale_files.samples.slice(0, 8)) lines.push(`- ${s}`);
  }
  lines.push("hint: dry_run=false applies changes; vacuum=true reclaims sqlite file space after pruning");
  return lines.join("\n");
}

function compactBootstrapText(data: {
  generated_at: string;
  project_root: string;
  root_source: RootSource;
  watcher_enabled: boolean;
  watcher_ready: boolean;
  project_summary: ReturnType<typeof toMemoryItemPreview> | null;
  decisions: Array<ReturnType<typeof toMemoryItemPreview>>;
  conventions: Array<ReturnType<typeof toMemoryItemPreview>>;
  current_context: Array<ReturnType<typeof toMemoryItemPreview>>;
  recent_notes: Array<ReturnType<typeof toMemoryItemPreview>>;
  pending_total: number;
  pending_offset: number;
  pending_limit: number;
  pending_truncated: boolean;
  pending_changes: PendingChangeRow[];
  development_warnings?: DevelopmentWarning[];
  items: Array<{
    requirement: ReturnType<typeof toRequirementPreview>;
    recent_changes: Array<ReturnType<typeof toChangeLogPreview>>;
  }>;
  semantic?: SemanticSearchResult | null;
}): string {
  const lines: string[] = [];
  lines.push(
    `ok ctx ${data.root_source} watcher=${data.watcher_enabled ? (data.watcher_ready ? "ready" : "starting") : "off"} root=${data.project_root}`,
  );
  if (data.project_summary) lines.push(`summary ${compactMemoryLabel(data.project_summary, 140)}`);
  if (data.decisions.length) {
    lines.push("current decisions:");
    for (const d of data.decisions.slice(0, 5)) lines.push(`- ${compactMemoryLabel(d, 160)}`);
  }
  if (data.current_context.length) {
    lines.push("current context:");
    for (const c of data.current_context.slice(0, 8)) lines.push(`- ${compactMemoryLabel(c, 160)}`);
  }
  if (data.pending_total) {
    lines.push(
      `pending ${data.pending_changes.length}/${data.pending_total}${data.pending_truncated ? " truncated" : ""}: ${data.pending_changes
        .slice(0, 8)
        .map(compactPendingLabel)
        .join("; ")}`,
    );
  } else {
    lines.push("pending 0");
  }
  lines.push(...compactDevelopmentWarningsText(data.development_warnings ?? []));
  if (data.items.length) {
    lines.push("requirements:");
    for (const item of data.items) {
      lines.push(`- ${compactRequirementLabel(item.requirement)}`);
      for (const c of item.recent_changes.slice(0, 3)) lines.push(`  - ${compactChangeLabel(c)}`);
    }
  } else {
    lines.push("requirements: none");
  }
  if (data.recent_notes.length) {
    lines.push("notes:");
    for (const n of data.recent_notes.slice(0, 3)) lines.push(`- ${compactMemoryLabel(n, 120)}`);
  }
  if (data.conventions.length) {
    lines.push(
      `conventions ${data.conventions.length}: ${data.conventions
        .slice(0, 5)
        .map((c) => c.title ?? `#${c.id}`)
        .join(", ")}`,
    );
  }
  if (data.semantic) {
    lines.push(`semantic ${data.semantic.mode} ${data.semantic.matches.length}/${data.semantic.top_k} for "${oneLine(data.semantic.query, 80)}":`);
    for (const m of data.semantic.matches.slice(0, 5)) {
      lines.push(`- score=${m.score.toFixed(3)} ${compactMemoryLabel(m.item, 120)}`);
    }
  }
  lines.push("hint: use format=json for full structured output; read_memory_item(id) for full content");
  return lines.join("\n");
}

function compactBrainDumpText(data: Parameters<typeof compactBootstrapText>[0]): string {
  return compactBootstrapText(data);
}

function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  if (process.platform === "win32") return `"${arg.replace(/"/g, '\\"')}"`;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function getPackageRtkShimPath(): string | null {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(currentDir, "rtk-shim.js");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // import.meta.url may be unavailable only in unexpected runtimes.
  }
  return null;
}

function runRtkProbe(spec: {
  source: "path" | "package_shim";
  displayCommand: string;
  execCommand: string;
  execArgsPrefix?: string[];
  execShell?: boolean;
  path?: string;
}): RtkDetection | null {
  const argsPrefix = spec.execArgsPrefix ?? [];
  const result = spawnSync(spec.execCommand, [...argsPrefix, "--version"], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    shell: spec.execShell ?? false,
  });
  if (result.status === 0) {
    const gain = spawnSync(spec.execCommand, [...argsPrefix, "gain"], {
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      shell: spec.execShell ?? false,
    });
    let resolvedPath = spec.path;
    if (spec.source === "path") {
      const whereCommand = process.platform === "win32" ? "where.exe" : "which";
      const whereResult = spawnSync(whereCommand, ["rtk"], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      });
      resolvedPath = whereResult.status === 0 ? oneLine(whereResult.stdout, 240) : resolvedPath;
    }
    const gainText = `${gain.stdout}${gain.stderr}`.trim();
    return {
      available: gain.status === 0,
      command: spec.displayCommand,
      version: `${result.stdout}${result.stderr}`.trim(),
      gain_ok: gain.status === 0,
      gain_preview: oneLine(gainText, 240),
      path: resolvedPath,
      source: spec.source,
      exec_command: spec.execCommand,
      exec_args_prefix: argsPrefix,
      exec_shell: spec.execShell ?? false,
      note:
        gain.status === 0
          ? spec.source === "package_shim"
            ? `Prefer prefixing shell commands with ${spec.displayCommand} for compact outputs. This is VectorMind's bundled RTK shim; first run auto-installs/caches rtk-ai/rtk if needed.`
            : "Prefer prefixing shell commands with rtk for compact outputs, e.g. rtk git status / rtk npm run build / rtk rg pattern ."
          : spec.source === "package_shim"
            ? "VectorMind's bundled RTK shim exists, but `gain` failed. Check npm/cache or set VECTORMIND_RTK_REAL to an existing rtk-ai/rtk binary."
            : "An rtk binary exists, but `rtk gain` failed. This may be the wrong rtk project. Use install_rtk with uninstall_wrong_cargo_rtk=true only when you intentionally want to replace it.",
    };
  }
  return null;
}

function detectRtk(): RtkDetection {
  const pathProbe = runRtkProbe({
    source: "path",
    displayCommand: "rtk",
    execCommand: "rtk",
    execShell: process.platform === "win32",
  });
  if (pathProbe?.available) return pathProbe;

  const shimPath = getPackageRtkShimPath();
  if (shimPath) {
    const displayCommand = `node ${shellQuoteArg(shimPath)}`;
    const shimProbe = runRtkProbe({
      source: "package_shim",
      displayCommand,
      execCommand: process.execPath,
      execArgsPrefix: [shimPath],
      path: shimPath,
    });
    if (shimProbe) return shimProbe;
  }

  if (pathProbe) return pathProbe;

  return {
    available: false,
    command: shimPath ? `node ${shellQuoteArg(shimPath)}` : "rtk",
    path: shimPath ?? undefined,
    source: shimPath ? "package_shim" : undefined,
    note: shimPath
      ? "rtk was not found on PATH, and VectorMind's bundled RTK shim could not verify rtk gain. VectorMind compact MCP output still works; check npm/cache or set VECTORMIND_RTK_REAL."
      : "rtk was not found on PATH and the package RTK shim is unavailable. VectorMind compact MCP output still works; install rtk to compact shell command output too.",
  };
}

function commandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(probe, [command], { encoding: "utf8", timeout: 2000, windowsHide: true });
  return result.status === 0;
}

function runInstallStep(command: string, args: string[], timeoutMs: number): {
  command: string;
  status: number | null;
  ok: boolean;
  output: string;
} {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    ok: result.status === 0,
    output: oneLine(output, 1200),
  };
}

function runDetectedRtkStep(detected: RtkDetection, args: string[], timeoutMs: number): {
  command: string;
  status: number | null;
  ok: boolean;
  output: string;
} {
  const execCommand = detected.exec_command ?? "rtk";
  const argsPrefix = detected.exec_args_prefix ?? [];
  const result = spawnSync(execCommand, [...argsPrefix, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: detected.exec_shell ?? (execCommand === "rtk" && process.platform === "win32"),
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    command: [detected.command, ...args].join(" "),
    status: result.status,
    ok: result.status === 0,
    output: oneLine(output, 1200),
  };
}

function appendRtkInitStep(
  steps: Array<{ command: string; status: number | null; ok: boolean; output: string }>,
  detected: RtkDetection,
  init: z.infer<typeof InstallRtkArgsSchema>["init"],
  timeoutMs: number,
): void {
  if (init === "none") return;
  if (init === "global_no_patch") steps.push(runDetectedRtkStep(detected, ["init", "-g", "--no-patch"], timeoutMs));
  if (init === "global_auto_patch") steps.push(runDetectedRtkStep(detected, ["init", "-g", "--auto-patch"], timeoutMs));
  if (init === "global_hook_only") {
    steps.push(runDetectedRtkStep(detected, ["init", "-g", "--hook-only", "--no-patch"], timeoutMs));
  }
  if (init === "local") steps.push(runDetectedRtkStep(detected, ["init"], timeoutMs));
  if (init === "codex_global") steps.push(runDetectedRtkStep(detected, ["init", "-g", "--codex"], timeoutMs));
  if (init === "codex_local") steps.push(runDetectedRtkStep(detected, ["init", "--codex"], timeoutMs));
}

function chooseRtkInstallMethod(method: "auto" | "cargo" | "brew" | "shell_script"): "cargo" | "brew" | "shell_script" {
  if (method !== "auto") return method;
  if (process.platform === "darwin" && commandExists("brew")) return "brew";
  if (commandExists("cargo")) return "cargo";
  return "shell_script";
}

function buildRtkInstallPlan(args: z.infer<typeof InstallRtkArgsSchema>): {
  method: "cargo" | "brew" | "shell_script";
  commands: string[];
  notes: string[];
} {
  const method = chooseRtkInstallMethod(args.method);
  const commands: string[] = [];
  const notes: string[] = [];

  if (args.uninstall_wrong_cargo_rtk) {
    commands.push("cargo uninstall rtk");
    notes.push("Only use uninstall_wrong_cargo_rtk after verifying the existing rtk is the wrong Cargo package.");
  }

  if (method === "brew") {
    commands.push("brew install rtk");
  } else if (method === "cargo") {
    commands.push("cargo install --git https://github.com/rtk-ai/rtk");
  } else {
    if (process.platform === "win32") {
      notes.push("shell_script install is Linux/macOS-oriented; on Windows prefer method=cargo after installing Rust/Cargo.");
      commands.push("cargo install --git https://github.com/rtk-ai/rtk");
    } else {
      commands.push("curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/master/install.sh | sh");
    }
  }

  commands.push("rtk --version");
  commands.push("rtk gain");

  if (args.init === "global_no_patch") commands.push("rtk init -g --no-patch");
  if (args.init === "global_auto_patch") commands.push("rtk init -g --auto-patch");
  if (args.init === "global_hook_only") commands.push("rtk init -g --hook-only --no-patch");
  if (args.init === "local") commands.push("rtk init");
  if (args.init === "codex_global") commands.push("rtk init -g --codex");
  if (args.init === "codex_local") commands.push("rtk init --codex");

  if (args.init !== "none") {
    notes.push("rtk init may modify Claude/RTK configuration. Use init=none for binary-only installation.");
  }

  return { method, commands, notes };
}

function installRtk(args: z.infer<typeof InstallRtkArgsSchema>): {
  ok: boolean;
  dry_run: boolean;
  already_available: boolean;
  method: string;
  commands: string[];
  notes: string[];
  steps: Array<{ command: string; status: number | null; ok: boolean; output: string }>;
  detected_before: ReturnType<typeof detectRtk>;
  detected_after?: ReturnType<typeof detectRtk>;
} {
  const detectedBefore = detectRtk();
  const plan = buildRtkInstallPlan(args);
  const steps: Array<{ command: string; status: number | null; ok: boolean; output: string }> = [];
  const notes = [...plan.notes];

  if (detectedBefore.available) {
    notes.push("rtk is already installed and verified with `rtk gain`; installation skipped.");
    if (!args.dry_run && args.init !== "none") {
      appendRtkInitStep(steps, detectedBefore, args.init, args.timeout_ms);
    }
    return {
      ok: true,
      dry_run: args.dry_run,
      already_available: true,
      method: plan.method,
      commands: plan.commands,
      notes,
      steps,
      detected_before: detectedBefore,
      detected_after: detectedBefore,
    };
  }

  if (args.dry_run) {
    notes.push("dry_run=true: no command was executed. Call install_rtk with dry_run=false to install.");
    return {
      ok: true,
      dry_run: true,
      already_available: false,
      method: plan.method,
      commands: plan.commands,
      notes,
      steps,
      detected_before: detectedBefore,
    };
  }

  if (plan.method === "brew") {
    steps.push(runInstallStep("brew", ["install", "rtk"], args.timeout_ms));
  } else if (plan.method === "cargo") {
    if (args.uninstall_wrong_cargo_rtk) {
      steps.push(runInstallStep("cargo", ["uninstall", "rtk"], args.timeout_ms));
    }
    steps.push(runInstallStep("cargo", ["install", "--git", "https://github.com/rtk-ai/rtk"], args.timeout_ms));
  } else if (process.platform === "win32") {
    notes.push("Windows fallback uses Cargo because the upstream shell installer targets POSIX shells.");
    if (args.uninstall_wrong_cargo_rtk) {
      steps.push(runInstallStep("cargo", ["uninstall", "rtk"], args.timeout_ms));
    }
    steps.push(runInstallStep("cargo", ["install", "--git", "https://github.com/rtk-ai/rtk"], args.timeout_ms));
  } else {
    const script =
      "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/master/install.sh | sh";
    steps.push(runInstallStep("sh", ["-c", script], args.timeout_ms));
  }

  const detectedAfterInstall = detectRtk();
  if (detectedAfterInstall.available && args.init !== "none") {
    appendRtkInitStep(steps, detectedAfterInstall, args.init, args.timeout_ms);
  }

  const detectedAfter = detectRtk();
  return {
    ok: detectedAfter.available,
    dry_run: false,
    already_available: false,
    method: plan.method,
    commands: plan.commands,
    notes,
    steps,
    detected_before: detectedBefore,
    detected_after: detectedAfter,
  };
}

function compactInstallRtkText(data: ReturnType<typeof installRtk>): string {
  const lines: string[] = [];
  lines.push(
    `install_rtk ok=${data.ok} dry_run=${data.dry_run} already_available=${data.already_available} method=${data.method}`,
  );
  lines.push(
    `before available=${data.detected_before.available} version=${data.detected_before.version ?? "none"} gain_ok=${data.detected_before.gain_ok ?? false}`,
  );
  if (data.detected_after) {
    lines.push(
      `after available=${data.detected_after.available} version=${data.detected_after.version ?? "none"} gain_ok=${data.detected_after.gain_ok ?? false}`,
    );
  }
  if (data.commands.length) {
    lines.push("commands:");
    for (const command of data.commands) lines.push(`- ${command}`);
  }
  if (data.steps.length) {
    lines.push("steps:");
    for (const step of data.steps) {
      lines.push(`- ${step.ok ? "ok" : "fail"} [${step.status ?? "null"}] ${step.command}: ${oneLine(step.output, 240)}`);
    }
  }
  if (data.notes.length) {
    lines.push("notes:");
    for (const note of data.notes) lines.push(`- ${note}`);
  }
  return lines.join("\n");
}

function tokenSavingsSummary(limit: number) {
  const summary = summarizeTokenSavingsStmt.get() as
    | {
        calls: number;
        raw_tokens: number;
        output_tokens: number;
        saved_tokens: number;
        avg_savings_pct: number;
      }
    | undefined;
  const by_tool = summarizeTokenSavingsByToolStmt.all(limit) as Array<{
    tool: string;
    calls: number;
    raw_tokens: number;
    output_tokens: number;
    saved_tokens: number;
    avg_savings_pct: number;
  }>;
  const recent = listRecentTokenSavingsStmt.all(limit) as Array<{
    id: number;
    tool: string;
    raw_tokens: number;
    output_tokens: number;
    saved_tokens: number;
    savings_pct: number;
    created_at: string;
  }>;
  return {
    ok: true,
    summary: summary ?? { calls: 0, raw_tokens: 0, output_tokens: 0, saved_tokens: 0, avg_savings_pct: 0 },
    by_tool,
    recent,
  };
}

function compactTokenSavingsText(data: ReturnType<typeof tokenSavingsSummary>): string {
  const s = data.summary;
  const pct = Number(s.raw_tokens) > 0 ? (Number(s.saved_tokens) / Number(s.raw_tokens)) * 100 : 0;
  const lines = [
    `token_savings calls=${s.calls} raw=${s.raw_tokens} out=${s.output_tokens} saved=${s.saved_tokens} (${pct.toFixed(1)}%)`,
  ];
  if (data.by_tool.length) {
    lines.push("by_tool:");
    for (const t of data.by_tool.slice(0, 10)) {
      lines.push(
        `- ${t.tool}: calls=${t.calls} saved=${t.saved_tokens} raw=${t.raw_tokens} out=${t.output_tokens} avg=${Number(
          t.avg_savings_pct,
        ).toFixed(1)}%`,
      );
    }
  }
  if (data.recent.length) {
    lines.push("recent:");
    for (const r of data.recent.slice(0, 10)) {
      lines.push(`- #${r.id} ${r.tool}: ${r.raw_tokens}->${r.output_tokens} saved=${r.saved_tokens}`);
    }
  }
  return lines.join("\n");
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

type SemanticSearchMode = "embeddings" | "fts" | "like" | "token" | "hybrid";

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

const BOOTSTRAP_DEFAULT_CONTEXT_KINDS = [
  "decision",
  "convention",
  "project_summary",
  "memory_compaction",
  "note",
  "requirement",
  "change_intent",
];

const TOKEN_SEARCH_DEFAULT_KINDS = [
  "decision",
  "convention",
  "project_summary",
  "memory_compaction",
  "note",
  "requirement",
  "change_intent",
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
  "直接通过",
  "不用审核",
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

function parseMetadataJson(metadata: string | null | undefined): Record<string, unknown> {
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

function metadataStatus(row: { metadata_json?: string | null }): string {
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

function isHiddenFromDefaultRecall(row: { metadata_json?: string | null }): boolean {
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
    case "memory_compaction":
      return 0.7;
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
  return rows
    .map((r) => ({ row: r, score: adjustSemanticScore(r, scoreOf(r)) }))
    .filter(({ row }) => {
      if (isHiddenFromDefaultRecall(row)) return false;
      if (shouldIgnoreDbFilePath(row.file_path) && row.kind !== "change_intent") return false;
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK)
    .map(({ row, score }) =>
      toSemanticMatch(row, score, opts.includeContent, opts.previewChars, opts.contentMaxChars),
    );
}

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

function getDecisionPreviews(
  decisionsLimit: number,
  previewChars: number,
  contentMaxChars: number,
): Array<ReturnType<typeof toMemoryItemPreview>> {
  if (decisionsLimit <= 0) return [];
  const rows = listCurrentDecisionsStmt.all(Math.min(MAX_DECISIONS_LIMIT * 4, Math.max(decisionsLimit, decisionsLimit * 4))) as MemoryItemRow[];
  return rows
    .filter((d) => !isHiddenFromDefaultRecall(d))
    .slice(0, decisionsLimit)
    .map((d) => toMemoryItemPreview(d, false, previewChars, contentMaxChars));
}

function getCurrentContextPreviews(
  currentContextLimit: number,
  previewChars: number,
  contentMaxChars: number,
): Array<ReturnType<typeof toMemoryItemPreview>> {
  if (currentContextLimit <= 0) return [];

  const picked = new Map<number, ReturnType<typeof toMemoryItemPreview>>();
  const addRow = (row: MemoryItemRow | undefined): void => {
    if (!row) return;
    if (isHiddenFromDefaultRecall(row)) return;
    if (shouldIgnoreDbFilePath(row.file_path) && row.kind !== "change_intent") return;
    if (!picked.has(row.id)) {
      picked.set(row.id, toMemoryItemPreview(row, false, previewChars, contentMaxChars));
    }
  };

  const activeReqs = listActiveRequirementsStmt.all(Math.max(currentContextLimit, 10)) as RequirementRow[];
  for (const req of activeReqs) {
    const memId = (getRequirementMemoryItemIdStmt.get(req.id) as { id: number } | undefined)?.id;
    if (memId != null) addRow(getMemoryItemByIdStmt.get(memId) as MemoryItemRow | undefined);
  }

  const recentRows = listRecentContextItemsStmt.all(Math.max(currentContextLimit * 8, 40)) as MemoryItemRow[];
  for (const row of recentRows) {
    if (picked.size >= currentContextLimit) break;
    if (row.kind === "requirement" || row.kind === "change_intent") {
      if (!looksLikeDecisionContent(`${row.title ?? ""}\n${row.content}`)) continue;
    }
    addRow(row);
  }

  return Array.from(picked.values()).slice(0, currentContextLimit);
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

function patchMemoryItemMetadata(id: number, patch: Record<string, unknown>): void {
  const row = getMemoryItemByIdStmt.get(id) as MemoryItemRow | undefined;
  if (!row) return;
  const meta = { ...parseMetadataJson(row.metadata_json), ...patch };
  db.prepare(`UPDATE memory_items SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    safeJson(meta),
    id,
  );
}

function supersedeMemoryItemIds(
  ids: number[],
  replacement: { req_id?: number; memory_id?: number; decision_id?: number; reason: string },
): number[] {
  const updated: number[] = [];
  for (const id of Array.from(new Set(ids)).filter((n) => Number.isFinite(n) && n > 0)) {
    const row = getMemoryItemByIdStmt.get(id) as MemoryItemRow | undefined;
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

function supersedeRequirementIds(
  reqIds: number[],
  replacement: { req_id?: number; memory_id?: number; decision_id?: number; reason: string },
): number[] {
  const updatedReqs: number[] = [];
  for (const reqId of Array.from(new Set(reqIds)).filter((n) => Number.isFinite(n) && n > 0)) {
    const info = db.prepare(`UPDATE requirements SET status = 'superseded' WHERE id = ?`).run(reqId);
    if (info.changes > 0) updatedReqs.push(reqId);
    const rows = db
      .prepare(`SELECT id FROM memory_items WHERE req_id = ? OR (kind = 'requirement' AND req_id = ?)`)
      .all(reqId, reqId) as Array<{ id: number }>;
    supersedeMemoryItemIds(
      rows.map((r) => r.id),
      replacement,
    );
  }
  return updatedReqs;
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

  const filtered = matches
    .filter((m) => {
      if (isHiddenFromDefaultRecall({ metadata_json: m.item.metadata_json })) return false;
      if (shouldIgnoreDbFilePath(m.item.file_path) && m.item.kind !== "change_intent") return false;
      return true;
    })
    .map((m) => ({
      ...m,
      score: adjustSemanticScore(
        {
          id: m.item.id,
          kind: m.item.kind,
          title: m.item.title,
          content: m.item.content ?? m.item.preview,
          file_path: m.item.file_path,
          start_line: m.item.start_line,
          end_line: m.item.end_line,
          req_id: m.item.req_id,
          metadata_json: m.item.metadata_json,
          updated_at: m.item.updated_at,
        },
        m.score,
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK);
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
    const memoryStmt = db.prepare(`
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
  if (ftsAvailable) {
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

async function semanticSearchHybridInternal(opts: SemanticSearchOpts): Promise<SemanticSearchResult> {
  const lexical = chooseLexicalResult(opts).result;
  if (!embeddingsEnabled) return lexical;

  const embeddingsResult = await Promise.race([
    semanticSearchInternal(opts),
    new Promise<null>((resolve) => setTimeout(resolve, SEMANTIC_EMBEDDINGS_TIMEOUT_MS, null)),
  ]).catch((err) => {
    console.error("[vectormind] embeddings semantic_search failed; falling back:", err);
    return null;
  });

  if (!embeddingsResult) return lexical;
  const merged = mergeSemanticMatches([lexical.matches, embeddingsResult.matches], opts);
  return {
    query: opts.query.trim(),
    top_k: opts.topK,
    mode: merged.length ? "hybrid" : embeddingsResult.mode,
    matches: merged,
  };
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
    "Development guideline scope: VectorMind instructions define development conventions, project-memory conventions, code-organization conventions, and delivery-quality expectations.",
    "Project root resolution order: tool argument project_root (recommended for clients without roots/list), then VECTORMIND_ROOT (avoid hardcoding in global config), then MCP roots/list (best-effort; falls back quickly if unsupported), then process.cwd() (so start your MCP client in the project directory for per-project isolation).",
    "If root_source is fallback, file watching/indexing is disabled (pass project_root to enable per-project tracking).",
    "",
    "Built-in write-operation quality policy:",
    BUILTIN_WRITE_POLICY_INSTRUCTIONS,
    "",
    "Built-in task-list / Plan-Lite quality policy:",
    BUILTIN_PLAN_LITE_INSTRUCTIONS,
    "",
    "Built-in destructive-operation quality guard:",
    BUILTIN_DESTRUCTIVE_OPERATION_GUARD_INSTRUCTIONS,
    "",
    "Built-in architecture and code-organization quality policy:",
    BUILTIN_ARCHITECTURE_AND_CODE_ORGANIZATION_INSTRUCTIONS,
    "",
    "Built-in requirement boundary and modularity quality policy:",
    BUILTIN_REQUIREMENT_BOUNDARY_AND_MODULARITY_INSTRUCTIONS,
    "",
    "Built-in frontend output-purity quality policy:",
    BUILTIN_FRONTEND_OUTPUT_PURITY_INSTRUCTIONS,
    "",
    "Built-in git commit summary quality policy:",
    BUILTIN_GIT_COMMIT_SUMMARY_INSTRUCTIONS,
    "",
    "Built-in low-overhead execution and heavy-thread quality policy:",
    BUILTIN_LOW_OVERHEAD_WORKFLOW_INSTRUCTIONS,
    "",
    "Built-in payload / oversized-thread quality guard:",
    BUILTIN_PAYLOAD_GUARD_INSTRUCTIONS,
    "",
    "Built-in thread handoff / switch-gate quality policy:",
    BUILTIN_THREAD_HANDOFF_SWITCH_INSTRUCTIONS,
    "",
    "VectorMind workflow:",
    "- Tool outputs are compact by default. Pass format=json only when you need full structured data.",
    "- On every new conversation/session for analysis/design/development work: call bootstrap_context({ query: <current goal> }) first (or at least get_brain_dump()) to restore compact context and retrieve relevant matches from the local memory store (vector if enabled; otherwise FTS/LIKE).",
    "  - Output is compact by default. Use include_content=true only when you truly need full text (it increases tokens).",
    "  - bootstrap_context/get_brain_dump always include a small recency anchor named current_context (latest active requirements, recent notes, and recent change intents) in addition to query matches; tune output size with: requirements_limit/changes_limit/notes_limit/decisions_limit/current_context_limit, preview_chars, pending_limit/pending_offset.",
    "  - Prefer read_memory_item(id, offset, limit) to fetch full text on demand instead of returning large content in other tool outputs.",
    "- For pure execution-first tasks with explicit targets (for example compile/build/run/launch/package/publish/test rerun), you may skip retrieval and go straight to the minimum necessary shell or host tools unless code/context lookup is actually needed to unblock execution.",
    "- If rtk is installed or VectorMind's bundled RTK shim is verified (detect_rtk with gain_ok=true), prefix shell commands with the command returned by detect_rtk. Usually this is rtk (rtk git status, rtk npm run build, rtk rg ...); in npx/MCP-only installs it may be a package shim command such as node <...>/rtk-shim.js.",
    "- If rtk is missing and the user asks to install it, use install_rtk first with dry_run=true to show the exact commands; execute with dry_run=false only when the user explicitly asks to install/init.",
    "- To read local Codex skill/prompt/rule files (for example SKILL.md under CODEX_HOME or AGENTS_HOME), prefer read_codex_text_file({ path }) instead of assuming another local-file MCP resource server exists.",
    "- For project file/directory browsing, prefer list_project_files({ path, recursive?, max_depth? }) over shelling out to Get-ChildItem/ls. It respects ignore rules and keeps output bounded.",
    "- For small/medium raw file reads, prefer read_file_text({ path, offset?, max_chars? }) over Get-Content -Raw. Use read_file_lines(...) when you need deterministic line ranges or the file may be large.",
    "- For raw repo text search with exact file+line+col matches, prefer grep({ query: <pattern> }). It uses ripgrep against real project files when available, applies built-in noise filters, and only falls back to indexed search if ripgrep is unavailable.",
    "- To read a bounded segment of a file, prefer read_file_lines({ path: <file>, from_line/to_line or total_count }) over unbounded file reads.",
    "- BEFORE editing code: call start_requirement(title, background) to set the active requirement.",
    "- Treat the active requirement as the only change boundary. Do not add extra business behavior, new flows, new fields, new interfaces, or touch completed/related features unless the user explicitly asked or the change is strictly necessary.",
    "- Do not keep piling new feature code into a large single file. Prefer small modules/services/components; if an implementation file is already large, split it before adding more responsibilities.",
    "- AFTER editing + saving: call get_pending_changes() to see unsynced files, then call sync_change_intent(intent, files). (You can omit files to auto-link all pending changes.)",
    "- If read_file_lines, grep, query_codebase, get_pending_changes, or sync_change_intent returns development_warnings, address those warnings before continuing or explain why the current requirement truly needs that scope.",
    "- After major milestones/decisions: call upsert_project_summary(summary) and/or add_note(...) to persist durable context locally.",
    "- When a requirement or user decision changes/reverses an older behavior, call upsert_decision(key, title, content, supersedes_req_ids?/supersedes_memory_ids?) and/or supersede_memory(...). Current decisions are shown in bootstrap_context/get_brain_dump and superseded memories are hidden from default semantic recall so stale requirements do not override newer facts.",
    "- If the user states a durable project convention (build commands, frameworks, naming rules, output paths): call upsert_convention(key, content, tags) so it is applied in future sessions.",
    "- When you need full text for a specific note/summary/match: call read_memory_item(id, offset, limit) and page through it.",
    "- When asked to locate code (class/function/type): call query_codebase(query) instead of guessing.",
    "- When you need to recall relevant context from history/code/docs: call semantic_search(query, ...) instead of guessing. It blends lexical/FTS recall with embeddings when enabled, so recent explicit wording and durable decisions are not hidden by older semantically similar matches.",
    "- VectorMind automatically runs small, throttled memory maintenance to compact old completed history and prune stale indexes in long-lived projects. For large repos that feel slow, call maintain_memory({ dry_run: true }) first, then maintain_memory({ dry_run: false }) if the plan looks correct.",
    "- Use get_token_savings({ format: 'compact' }) when you need to verify how many tokens VectorMind compact outputs saved.",
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

function columnExists(table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  } catch {
    return false;
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_decision_key
      ON memory_items(kind, title) WHERE kind = 'decision';

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

    CREATE TABLE IF NOT EXISTS token_savings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      raw_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      saved_tokens INTEGER NOT NULL,
      savings_pct REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_token_savings_created_at
      ON token_savings(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_token_savings_tool
      ON token_savings(tool);

    CREATE TABLE IF NOT EXISTS memory_item_archive (
      memory_id INTEGER PRIMARY KEY,
      original_kind TEXT NOT NULL,
      original_title TEXT,
      original_content TEXT NOT NULL,
      original_file_path TEXT,
      original_start_line INTEGER,
      original_end_line INTEGER,
      original_req_id INTEGER,
      original_metadata_json TEXT,
      original_content_hash TEXT,
      original_created_at DATETIME,
      original_updated_at DATETIME,
      archive_reason TEXT NOT NULL,
      compacted_into_id INTEGER,
      archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memory_item_archive_compacted_into
      ON memory_item_archive(compacted_into_id);

    CREATE TABLE IF NOT EXISTS meta_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  if (!columnExists("requirements", "updated_at")) {
    db.exec(`ALTER TABLE requirements ADD COLUMN updated_at DATETIME`);
    db.exec(`UPDATE requirements SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL`);
  }
  db.exec(`
    UPDATE requirements SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_requirements_status_updated_at
      ON requirements(status, updated_at DESC, id DESC);
    CREATE TRIGGER IF NOT EXISTS vectormind_requirements_touch_updated_at
    AFTER UPDATE ON requirements
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE requirements SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
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
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT 1`,
  );
  listActiveRequirementsStmt = db.prepare(
    `SELECT id, title, status, context_data, created_at
     FROM requirements
     WHERE status = 'active'
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT ?`,
  );
  listRecentRequirementsStmt = db.prepare(
    `SELECT id, title, status, context_data, created_at
     FROM requirements
     ORDER BY updated_at DESC, created_at DESC, id DESC
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
  upsertDecisionStmt = db.prepare(
    `INSERT INTO memory_items (kind, title, content, metadata_json, content_hash)
     VALUES ('decision', ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       content = excluded.content,
       metadata_json = excluded.metadata_json,
       content_hash = excluded.content_hash,
       updated_at = CURRENT_TIMESTAMP`,
  );
  getDecisionByKeyStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'decision' AND title = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
  );
  listCurrentDecisionsStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'decision'
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
  listRecentContextItemsStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind IN ('note', 'requirement', 'change_intent')
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  );
  getLatestChangeIntentForFileStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'change_intent' AND file_path = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
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

  insertTokenSavingsStmt = db.prepare(
    `INSERT INTO token_savings (tool, raw_tokens, output_tokens, saved_tokens, savings_pct)
     VALUES (?, ?, ?, ?, ?)`,
  );
  summarizeTokenSavingsStmt = db.prepare(
    `SELECT
       COUNT(*) as calls,
       COALESCE(SUM(raw_tokens), 0) as raw_tokens,
       COALESCE(SUM(output_tokens), 0) as output_tokens,
       COALESCE(SUM(saved_tokens), 0) as saved_tokens,
       COALESCE(AVG(savings_pct), 0) as avg_savings_pct
     FROM token_savings`,
  );
  summarizeTokenSavingsByToolStmt = db.prepare(
    `SELECT
       tool,
       COUNT(*) as calls,
       COALESCE(SUM(raw_tokens), 0) as raw_tokens,
       COALESCE(SUM(output_tokens), 0) as output_tokens,
       COALESCE(SUM(saved_tokens), 0) as saved_tokens,
       COALESCE(AVG(savings_pct), 0) as avg_savings_pct
     FROM token_savings
     GROUP BY tool
     ORDER BY saved_tokens DESC, calls DESC
     LIMIT ?`,
  );
  listRecentTokenSavingsStmt = db.prepare(
    `SELECT id, tool, raw_tokens, output_tokens, saved_tokens, savings_pct, created_at
     FROM token_savings
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  );
  getKvStmt = db.prepare(`SELECT value FROM meta_kv WHERE key = ?`);
  setKvStmt = db.prepare(
    `INSERT INTO meta_kv (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
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

  // Bounded, throttled maintenance keeps long-lived project memory fast without
  // deleting durable decisions/conventions/project summaries.
  runAutoMaintenanceIfDue();
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
          "MUST call BEFORE editing code. Starts/activates the concrete user requirement so subsequent changes stay inside that requirement boundary and do not accumulate unrelated work.",
        inputSchema: toJsonSchemaCompat(StartRequirementArgsSchema),
      },
      {
        name: "sync_change_intent",
        description:
          "MUST call AFTER you edit code and save files. Archives the intent summary, links affected files to the current active requirement, and returns development_warnings for oversized files, broad change scope, or missing file targets.",
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
          "MUST call at the start of every new chat/session. Returns brain dump + pending changes + development_warnings, and (if you pass query) matches from the local memory store to avoid guessing.",
        inputSchema: toJsonSchemaCompat(BootstrapContextArgsSchema),
      },
      {
        name: "get_pending_changes",
        description:
          "List files that changed locally but have not been acknowledged by sync_change_intent yet. Also returns development_warnings to catch god-file growth, broad change scope, and requirement-boundary drift.",
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
        name: "detect_rtk",
        description:
          "Detect whether rtk is available on PATH or via VectorMind's bundled RTK shim. When available, prefer the returned command as a shell prefix to reduce command-output tokens.",
        inputSchema: toJsonSchemaCompat(DetectRtkArgsSchema),
      },
      {
        name: "install_rtk",
        description:
          "Install the rtk-ai/rtk Rust Token Killer binary when it is missing. Defaults to dry_run=true and never patches hooks unless init is explicitly requested.",
        inputSchema: toJsonSchemaCompat(InstallRtkArgsSchema),
      },
      {
        name: "get_token_savings",
        description:
          "Show VectorMind compact-output token savings recorded by MCP tools. Use this to verify raw-vs-compact output reduction.",
        inputSchema: toJsonSchemaCompat(GetTokenSavingsArgsSchema),
      },
      {
        name: "grep",
        description:
          "Repo text search with precise file/line/col matches, powered by ripgrep against real project files plus built-in noise filters. Falls back to indexed search only when ripgrep is unavailable. Returns development_warnings for cross-project paths or huge implementation-file matches.",
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
          "Read bounded text from local Codex/agents files such as SKILL.md, prompt files, and rules under CODEX_HOME/AGENTS_HOME. Prefer this over assuming another local-file MCP resource server exists.",
        inputSchema: toJsonSchemaCompat(ReadCodexTextFileArgsSchema),
      },
      {
        name: "read_file_lines",
        description:
          "Read a specific line range from a file under project_root (with strict size limits). Prefer this over Get-Content for deterministic reads. Returns development_warnings when the target is a huge implementation file.",
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
          "Search the symbol index for class/function/type names (or substrings) to locate definitions by file path and signature. Use this when you need to find code; do not guess locations. Returns development_warnings when matches point at huge implementation files.",
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
        name: "upsert_decision",
        description:
          "Save/update the current authoritative project decision for a key. Use it when requirements change, reverse, or supersede older behavior so future sessions prefer the latest decision over old history.",
        inputSchema: toJsonSchemaCompat(UpsertDecisionArgsSchema),
      },
      {
        name: "supersede_memory",
        description:
          "Mark old requirements or memory items as superseded by a newer requirement/decision. Superseded items are hidden from default semantic recall to avoid reverting to stale behavior.",
        inputSchema: toJsonSchemaCompat(SupersedeMemoryArgsSchema),
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
        name: "maintain_memory",
        description:
          "Compact old completed memory and prune stale/noisy indexes to keep long-lived large projects fast. Defaults to dry_run=true; automatic safe maintenance also runs periodically.",
        inputSchema: toJsonSchemaCompat(MaintainMemoryArgsSchema),
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
      const development_warnings = buildRequirementStartWarnings({
        title: args.title,
        background: args.background,
        close_previous: args.close_previous,
      });

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
        development_warnings: development_warnings.length,
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
              development_warnings,
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

    if (toolName === "maintain_memory") {
      const args = MaintainMemoryArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const result = runMemoryMaintenance(args, "manual");
      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson("maintain_memory", result, compactMaintenanceText(result), args.format),
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
          const merged = mergePendingWithGit(pendingAll, { offset: 0, limit: MAX_PENDING_LIMIT });
          if (merged.page.length) {
            for (const p of merged.page) {
              targets.push({
                rawFile: p.file_path,
                dbFilePath: p.file_path,
                event: p.last_event,
                source: p.source === "git" ? "pending" : "pending",
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
            safeJson({
              change_log_id,
              event: t.event,
              source: t.source,
              file_state_hash: isUnspecified ? null : getFileStateHash(t.rawFile),
            }),
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
      const development_warnings = buildDevelopmentWarnings(synced_files, {
        includeUnspecified: synced_files.some((f) => f.file_path === "(unspecified)"),
      });

      logActivity("sync_change_intent", {
        req_id: active.id,
        title: active.title,
        intent_preview: makePreviewText(args.intent, 200),
        files: synced_files.slice(0, 25),
        files_total: synced_files.length,
        development_warnings: development_warnings.length,
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
              development_warnings,
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
      const decisionsLimit = args.decisions_limit;
      const currentContextLimit = args.current_context_limit;

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
      const decisions = getDecisionPreviews(decisionsLimit, previewChars, contentMaxChars);
      const conventions = getConventionPreviews(conventionsLimit, previewChars, contentMaxChars);
      const current_context = getCurrentContextPreviews(currentContextLimit, previewChars, contentMaxChars);
      const pending_offset = args.pending_offset;
      const pending_limit = args.pending_limit;
      const pendingDbRows = listPendingChangesStmt.all() as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>;
      const mergedPending = mergePendingWithGit(pendingDbRows, { offset: pending_offset, limit: pending_limit });
      const pending_total = mergedPending.total;
      const pending_truncated = mergedPending.truncated;
      const pending_changes = mergedPending.page;
      const development_warnings = buildDevelopmentWarnings(pending_changes);

      const q = args.query?.trim() ?? "";
      const semanticKinds = args.kinds?.length ? args.kinds : BOOTSTRAP_DEFAULT_CONTEXT_KINDS;
      const semantic =
        q
          ? await Promise.race([
              semanticSearchHybridInternal({
                query: q,
                topK: args.top_k,
                kinds: semanticKinds,
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
        decisions_returned: decisions.length,
        current_context_returned: current_context.length,
        conventions_returned: conventions.length,
        semantic_mode: semantic?.mode ?? null,
        semantic_matches: semantic?.matches?.length ?? 0,
      });

      const outputValue = {
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
          format: args.format,
          include_content: includeContent,
          preview_chars: previewChars,
          content_max_chars: contentMaxChars,
          requirements_limit: requirementsLimit,
          changes_limit: changesLimit,
          notes_limit: notesLimit,
          decisions_limit: decisionsLimit,
          current_context_limit: currentContextLimit,
          conventions_limit: conventionsLimit,
        },
        project_summary,
        decisions,
        conventions,
        current_context,
        recent_notes,
        pending_total,
        pending_offset,
        pending_limit,
        pending_truncated,
        pending_changes,
        development_warnings,
        items,
        semantic,
      };

      return {
        content: [
          {
            type: "text",
            text: toolText("bootstrap_context", outputValue, compactBootstrapText(outputValue), args.format),
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
      const decisionsLimit = args.decisions_limit;
      const currentContextLimit = args.current_context_limit;

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
      const decisions = getDecisionPreviews(decisionsLimit, previewChars, contentMaxChars);
      const conventions = getConventionPreviews(conventionsLimit, previewChars, contentMaxChars);
      const current_context = getCurrentContextPreviews(currentContextLimit, previewChars, contentMaxChars);
      const pending_offset = args.pending_offset;
      const pending_limit = args.pending_limit;
      const pendingDbRows = listPendingChangesStmt.all() as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>;
      const mergedPending = mergePendingWithGit(pendingDbRows, { offset: pending_offset, limit: pending_limit });
      const pending_total = mergedPending.total;
      const pending_truncated = mergedPending.truncated;
      const pending_changes = mergedPending.page;
      const development_warnings = buildDevelopmentWarnings(pending_changes);

      logActivity("get_brain_dump", {
        pending_total,
        pending_returned: pending_changes.length,
        requirements_returned: items.length,
        notes_returned: recent_notes.length,
        decisions_returned: decisions.length,
        current_context_returned: current_context.length,
        conventions_returned: conventions.length,
      });

      const outputValue = {
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
          format: args.format,
          include_content: includeContent,
          preview_chars: previewChars,
          content_max_chars: contentMaxChars,
          requirements_limit: requirementsLimit,
          changes_limit: changesLimit,
          notes_limit: notesLimit,
          decisions_limit: decisionsLimit,
          current_context_limit: currentContextLimit,
          conventions_limit: conventionsLimit,
        },
        project_summary,
        decisions,
        conventions,
        current_context,
        recent_notes,
        pending_total,
        pending_offset,
        pending_limit,
        pending_truncated,
        pending_changes,
        development_warnings,
        items,
        semantic: null,
      };

      return {
        content: [
          {
            type: "text",
            text: toolText("get_brain_dump", outputValue, compactBrainDumpText(outputValue), args.format),
          },
        ],
      };
    }

    if (toolName === "get_pending_changes") {
      const args = GetPendingChangesArgsSchema.parse(rawArgs);
      flushPendingChangeBuffer();
      const offset = args.offset;
      const limit = args.limit;
      const pendingDbRows = listPendingChangesStmt.all() as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>;
      const mergedPending = mergePendingWithGit(pendingDbRows, { offset, limit });
      const total = mergedPending.total;
      const truncated = mergedPending.truncated;
      const pending = mergedPending.page;
      const development_warnings = buildDevelopmentWarnings(pending);

      logActivity("get_pending_changes", {
        total,
        offset,
        limit,
        returned: pending.length,
        truncated,
        development_warnings: development_warnings.length,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({ ok: true, total, offset, limit, truncated, pending, development_warnings }),
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

    if (toolName === "detect_rtk") {
      DetectRtkArgsSchema.parse(rawArgs);
      const result = detectRtk();
      const text = result.available
        ? `rtk available: ${result.version ?? result.command}\ncommand=${result.command} source=${result.source ?? "unknown"} gain_ok=${result.gain_ok ?? false}${result.path ? ` path=${result.path}` : ""}\n${result.note}`
        : `rtk unavailable: ${result.command}\nsource=${result.source ?? "none"} gain_ok=${result.gain_ok ?? false}${result.version ? ` version=${result.version}` : ""}${result.path ? ` path=${result.path}` : ""}\n${result.note}`;
      return { content: [{ type: "text", text }] };
    }

    if (toolName === "install_rtk") {
      const args = InstallRtkArgsSchema.parse(rawArgs);
      const result = installRtk(args);
      return { content: [{ type: "text", text: compactInstallRtkText(result) }] };
    }

    if (toolName === "get_token_savings") {
      const args = GetTokenSavingsArgsSchema.parse(rawArgs);
      const result = tokenSavingsSummary(args.limit);
      return {
        content: [
          {
            type: "text",
            text: args.format === "json" ? toolJson(result) : compactTokenSavingsText(result),
          },
        ],
      };
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
      const development_warnings = [
        ...buildCrossProjectPathWarnings(includePaths),
        ...buildCrossProjectPathWarnings(excludePaths),
      ];

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

      const development_warnings = buildFileReadDevelopmentWarnings(resolved.dbFilePath, resolved.absPath, st);
      const outputValue = {
        ok: true,
        file_path: resolved.dbFilePath,
        offset: args.offset,
        returned_chars: result.returnedChars,
        total_chars: result.totalChars,
        truncated: result.truncated,
        development_warnings,
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

      const outputValue = {
        ok: true,
        file_path: resolved.displayPath,
        allowed_root: resolved.allowedRoot,
        offset: args.offset,
        returned_chars: result.returnedChars,
        total_chars: result.totalChars,
        truncated: result.truncated,
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

      const development_warnings = buildFileReadDevelopmentWarnings(resolved.dbFilePath, resolved.absPath, st);
      const outputValue = {
        ok: true,
        file_path: resolved.dbFilePath,
        from_line: fromLine,
        to_line: toLine,
        returned: result.returned,
        truncated: result.truncated,
        development_warnings,
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

    if (toolName === "query_codebase") {
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

      const outputValue = { ok: true, query: q, matches: filtered, development_warnings };

      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson("query_codebase", outputValue, compactQueryCodebaseText(outputValue), args.format),
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

    if (toolName === "upsert_decision") {
      const args = UpsertDecisionArgsSchema.parse(rawArgs);
      const key = args.key.trim();
      const title = args.title.trim() || key;
      const content = args.content.trim();
      const meta = {
        status: "current",
        key,
        title,
        tags: args.tags ?? [],
        supersedes_req_ids: args.supersedes_req_ids ?? [],
        supersedes_memory_ids: args.supersedes_memory_ids ?? [],
        related_files: (args.related_files ?? []).map((f) => normalizeToDbPath(f)),
      };
      upsertDecisionStmt.run(key, `${title}\n\n${content}`, safeJson(meta), sha256Hex(`${title}\n\n${content}`));
      const row = getDecisionByKeyStmt.get(key) as MemoryItemRow | undefined;
      if (row) enqueueEmbedding(row.id);

      const superseded_requirements = supersedeRequirementIds(args.supersedes_req_ids ?? [], {
        decision_id: row?.id,
        reason: `Superseded by decision ${key}: ${title}`,
      });
      const superseded_memory_items = supersedeMemoryItemIds(args.supersedes_memory_ids ?? [], {
        decision_id: row?.id,
        reason: `Superseded by decision ${key}: ${title}`,
      });

      logActivity("upsert_decision", {
        key,
        decision_id: row?.id ?? null,
        superseded_requirements,
        superseded_memory_items,
      });

      return {
        content: [
          {
            type: "text",
            text: toolJson({
              ok: true,
              decision: row ? { id: row.id, key, updated_at: row.updated_at } : null,
              superseded_requirements,
              superseded_memory_items,
            }),
          },
        ],
      };
    }

    if (toolName === "supersede_memory") {
      const args = SupersedeMemoryArgsSchema.parse(rawArgs);
      const supersededReqIds = args.superseded_req_ids ?? [];
      const supersededMemoryIds = args.superseded_memory_ids ?? [];
      if (!supersededReqIds.length && !supersededMemoryIds.length) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: toolJson({
                ok: false,
                error: "Provide superseded_req_ids and/or superseded_memory_ids.",
              }),
            },
          ],
        };
      }
      const superseded_requirements = supersedeRequirementIds(supersededReqIds, {
        req_id: args.replacement_req_id,
        memory_id: args.replacement_memory_id,
        reason: args.reason,
      });
      const superseded_memory_items = supersedeMemoryItemIds(supersededMemoryIds, {
        req_id: args.replacement_req_id,
        memory_id: args.replacement_memory_id,
        reason: args.reason,
      });
      logActivity("supersede_memory", {
        superseded_requirements,
        superseded_memory_items,
        replacement_req_id: args.replacement_req_id ?? null,
        replacement_memory_id: args.replacement_memory_id ?? null,
      });
      return {
        content: [
          {
            type: "text",
            text: toolJson({ ok: true, superseded_requirements, superseded_memory_items }),
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

      const outputValue = { ok: true, ...result };

      return {
        content: [
          {
            type: "text",
            text: toolCompactOrJson("semantic_search", outputValue, compactSemanticSearchText(outputValue), args.format),
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
