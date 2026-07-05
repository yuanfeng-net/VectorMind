#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import chokidar, { type FSWatcher } from "chokidar";
import type Database from "better-sqlite3";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServerInstructions } from "./server-instructions.js";
import { listToolDefinitions } from "./tool-catalog.js";
import { registerToolHandlers } from "./tool-handlers.js";
import type {
  ExtractedSymbol,
  MemoryItemRow,
  RequirementRow,
  RootSource,
} from "./types.js";
import {
  isProbablySystemDir,
  isProbablyVscodeInstallDir,
  normalizeToDbPath as normalizePathText,
  parseFileUriToPath,
  resolveRootFromEnvOrThrow,
  resolveRootFromToolArgOrThrow,
  resolveSafeFallbackRootDir,
} from "./root.js";
import { shouldIgnorePath } from "./path-rules.js";
import {
  configurePendingChanges,
  prunePendingChanges,
} from "./pending-changes.js";
import { configureTokenSavings } from "./token-savings.js";
import {
  configureFileIndexing,
  flushPendingChangeBuffer,
  indexFile,
  recordPendingChange,
  removeFileIndexes,
} from "./file-indexing.js";
import {
  configureMemoryMaintenance,
  pruneFilenameNoiseIndexes,
  pruneIgnoredIndexesByPathPatterns,
  runAutoMaintenanceIfDue,
} from "./memory-maintenance.js";
import { configureMemoryMutations } from "./memory-mutations.js";
import {
  configureMemoryRecall,
  isHiddenFromDefaultRecall,
  metadataStatus,
  parseMetadataJson,
} from "./memory-recall.js";
import {
  configureDevelopmentWarnings,
} from "./development-warnings.js";
import {
  configureActivityLogProjectRoot,
} from "./activity-log.js";
import {
  FTS_TABLE_NAME,
  openDatabaseRuntime,
  type PreparedDatabaseStatements,
} from "./database-runtime.js";
import {
  INDEX_AUTO_PRUNE_IGNORED,
  ROOTS_LIST_TIMEOUT_MS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./config.js";





let initialized = false;
let rootSource: RootSource = "cwd";
let projectRoot = "";
let dbPath = "";

configureActivityLogProjectRoot(() => projectRoot);

let db: Database.Database;
let watcher: FSWatcher | null = null;
let watcherReady = false;
let initializationPromise: Promise<void> | null = null;

let statements: PreparedDatabaseStatements;

let indexFileSymbolsTx:
  | ((filePath: string, symbols: ExtractedSymbol[]) => void)
  | null = null;


let ftsAvailable = false;

function normalizeToDbPath(inputPath: string): string {
  const normalized = normalizePathText(inputPath);
  if (!normalized || normalized === ".") return ".";
  const abs = path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath);
  const rel = path.relative(projectRoot, abs);
  const inCwd = !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  const candidate = inCwd ? rel : abs;
  return candidate.replace(/\\/g, "/");
}

configureDevelopmentWarnings({
  getProjectRoot: () => projectRoot,
  normalizeToDbPath,
  listActiveRequirements: (limit) => statements.listActiveRequirementsStmt.all(limit) as RequirementRow[],
  getRequirementMemoryItemId: (reqId) => statements.getRequirementMemoryItemIdStmt.get(reqId) as { id: number } | undefined,
  getMemoryItemById: (id) => statements.getMemoryItemByIdStmt.get(id) as MemoryItemRow | undefined,
  parseMetadataJson,
});

configureTokenSavings({
  getDb: () => db,
  getInsertTokenSavingsStatement: () => statements.insertTokenSavingsStmt,
  getSummarizeTokenSavingsStatement: () => statements.summarizeTokenSavingsStmt,
  getSummarizeTokenSavingsByToolStatement: () => statements.summarizeTokenSavingsByToolStmt,
  getListRecentTokenSavingsStatement: () => statements.listRecentTokenSavingsStmt,
});

configurePendingChanges({
  getDb: () => db,
  getProjectRoot: () => projectRoot,
  getCountPendingChangesStatement: () => statements.countPendingChangesStmt,
  getDeleteOldPendingChangesStatement: () => statements.deleteOldPendingChangesStmt,
  getDeleteOldestPendingChangesStatement: () => statements.deleteOldestPendingChangesStmt,
  getFileStateHash,
  getLatestSyncedFileHash,
});

configureMemoryMaintenance({
  getDb: () => db,
  getProjectRoot: () => projectRoot,
  getDbPath: () => dbPath,
  getKvStatement: () => statements.getKvStmt,
  getSetKvStatement: () => statements.setKvStmt,
  getDeleteFileChunkItemsStatement: () => statements.deleteFileChunkItemsStmt,
  getDeleteSymbolsForFileStatement: () => statements.deleteSymbolsForFileStmt,
  getInsertMemoryItemStatement: () => statements.insertMemoryItemStmt,
  sha256Hex,
  parseMetadataJson,
  metadataStatus,
  isHiddenFromDefaultRecall,
});

configureMemoryRecall({
  getDb: () => db,
  getListConventionsStatement: () => statements.listConventionsStmt,
  getListCurrentDecisionsStatement: () => statements.listCurrentDecisionsStmt,
  getListActiveRequirementsStatement: () => statements.listActiveRequirementsStmt,
  getRequirementMemoryItemIdStatement: () => statements.getRequirementMemoryItemIdStmt,
  getMemoryItemByIdStatement: () => statements.getMemoryItemByIdStmt,
  getListRecentContextItemsStatement: () => statements.listRecentContextItemsStmt,
  isFtsAvailable: () => ftsAvailable,
  sha256Hex,
});

configureMemoryMutations({
  getDb: () => db,
  getMemoryItemByIdStatement: () => statements.getMemoryItemByIdStmt,
  getCompleteRequirementMemoryItemByReqIdStatement: () => statements.completeRequirementMemoryItemByReqIdStmt,
  getCompleteAllActiveRequirementMemoryItemsStatement: () => statements.completeAllActiveRequirementMemoryItemsStmt,
});

configureFileIndexing({
  getDb: () => db,
  getProjectRoot: () => projectRoot,
  normalizeToDbPath,
  getIndexFileSymbolsTx: () => indexFileSymbolsTx,
  getDeleteFileChunkItemsStatement: () => statements.deleteFileChunkItemsStmt,
  getInsertMemoryItemStatement: () => statements.insertMemoryItemStmt,
  getUpsertPendingChangeStatement: () => statements.upsertPendingChangeStmt,
  getDeleteSymbolsForFileStatement: () => statements.deleteSymbolsForFileStmt,
  sha256Hex,
  prunePendingChanges,
});


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
  const row = statements.getLatestChangeIntentForFileStmt?.get(dbFilePath) as MemoryItemRow | undefined;
  if (!row) return null;
  const meta = parseMetadataJson(row.metadata_json);
  return typeof meta.file_state_hash === "string" ? meta.file_state_hash : null;
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

function initDatabase(): void {
  const runtime = openDatabaseRuntime(projectRoot);
  db = runtime.db;
  dbPath = runtime.dbPath;
  ftsAvailable = runtime.ftsAvailable;
  indexFileSymbolsTx = runtime.indexFileSymbolsTx;
  statements = runtime.statements;

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
    ignored: (p) => shouldIgnorePath(p, projectRoot),
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

server.setRequestHandler(ListToolsRequestSchema, async () => listToolDefinitions());

registerToolHandlers(server, {
  ensureInitializedForArgs,
  getDb: () => db,
  getProjectRoot: () => projectRoot,
  getRootSource: () => rootSource,
  getDbPath: () => dbPath,
  isWatcherEnabled: () => !!watcher,
  isWatcherReady: () => watcherReady,
  isFtsAvailable: () => ftsAvailable,
  ftsTableName: FTS_TABLE_NAME,
  getIndexFileSymbolsTx: () => indexFileSymbolsTx,
  getStatements: () => statements,
  normalizeToDbPath,
  sha256Hex,
  escapeLike,
  getFileStateHash,
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
