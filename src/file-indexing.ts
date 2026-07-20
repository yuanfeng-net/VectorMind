import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { ExtractedSymbol, PendingChangeRow } from "./types.js";
import {
  INDEX_MAX_CODE_BYTES,
  INDEX_MAX_DOC_BYTES,
  INDEX_SKIP_MINIFIED,
  PENDING_FLUSH_MS,
  PENDING_PRUNE_EVERY,
} from "./config.js";
import {
  getContentChunkKind,
  isContentIndexableFile,
  isSymbolIndexableFile,
  looksLikeGeneratedFile,
  looksLikeMinifiedBundle,
  shouldIgnorePath,
} from "./path-rules.js";
import { extractSymbols } from "./symbols.js";
import { logActivity } from "./activity-log.js";
import { safeJson } from "./tool-output.js";
import { resolvePathWithinRoot } from "./path-containment.js";

type FileIndexingContext = {
  getDb: () => Database.Database | undefined;
  getProjectRoot: () => string;
  normalizeToDbPath: (inputPath: string) => string;
  getIndexFileSymbolsTx: () => ((filePath: string, symbols: ExtractedSymbol[]) => void) | null;
  getDeleteFileChunkItemsStatement: () => Database.Statement;
  getInsertMemoryItemStatement: () => Database.Statement;
  getUpsertPendingChangeStatement: () => Database.Statement;
  getDeleteSymbolsForFileStatement: () => Database.Statement;
  sha256Hex: (input: string) => string;
  prunePendingChanges: () => void;
};

let fileIndexingContext: FileIndexingContext | null = null;

type BufferedPendingChange = {
  projectRootKey: string;
  filePath: string;
  event: PendingChangeEvent;
  updatedAt: string;
};

const pendingChangeBuffer = new Map<string, BufferedPendingChange>();
let pendingChangeFlushTimer: NodeJS.Timeout | null = null;
let pendingEventsSincePrune = 0;

function projectRootKey(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function bufferedChangeKey(rootKey: string, filePath: string): string {
  const normalizedFile = process.platform === "win32" ? filePath.toLowerCase() : filePath;
  return `${rootKey}\n${normalizedFile}`;
}

function isContainedIndexingPath(absPath: string, allowMissing = false): boolean {
  try {
    resolvePathWithinRoot(getProjectRoot(), absPath, { allowMissing });
    return true;
  } catch {
    return false;
  }
}

export function configureFileIndexing(context: FileIndexingContext): void {
  fileIndexingContext = context;
}

function requireFileIndexingContext(): FileIndexingContext {
  if (!fileIndexingContext) throw new Error("[VectorMind] file indexing context is not configured");
  return fileIndexingContext;
}

function hasDb(): boolean {
  return !!requireFileIndexingContext().getDb();
}

function getDb(): Database.Database {
  const db = requireFileIndexingContext().getDb();
  if (!db) throw new Error("[VectorMind] database is not initialized");
  return db;
}

function getProjectRoot(): string {
  return requireFileIndexingContext().getProjectRoot();
}

function normalizeToDbPath(inputPath: string): string {
  return requireFileIndexingContext().normalizeToDbPath(inputPath);
}

function getIndexFileSymbolsTx(): ((filePath: string, symbols: ExtractedSymbol[]) => void) | null {
  return requireFileIndexingContext().getIndexFileSymbolsTx();
}

function getDeleteFileChunkItemsStatement(): Database.Statement {
  return requireFileIndexingContext().getDeleteFileChunkItemsStatement();
}

function getInsertMemoryItemStatement(): Database.Statement {
  return requireFileIndexingContext().getInsertMemoryItemStatement();
}

function getUpsertPendingChangeStatement(): Database.Statement {
  return requireFileIndexingContext().getUpsertPendingChangeStatement();
}

function getDeleteSymbolsForFileStatement(): Database.Statement {
  return requireFileIndexingContext().getDeleteSymbolsForFileStatement();
}

function sha256Hex(input: string): string {
  return requireFileIndexingContext().sha256Hex(input);
}

function prunePendingChanges(): void {
  requireFileIndexingContext().prunePendingChanges();
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
function replaceFileContentChunks(
  dbFilePath: string,
  absPath: string,
  content: string,
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

  getDeleteFileChunkItemsStatement().run(dbFilePath);
  for (const chunk of chunks) {
    const title = `${dbFilePath}#L${chunk.startLine}-L${chunk.endLine}`;
    const contentHash = sha256Hex(chunk.content);
    getInsertMemoryItemStatement().run(
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
  }
  return chunks.length;
}

function invalidateFileIndexes(filePath: string, reason: string): void {
  try {
    getDb().transaction(() => {
      getDeleteSymbolsForFileStatement().run(filePath);
      getDeleteFileChunkItemsStatement().run(filePath);
    })();
    logActivity("index_invalidate", { file_path: filePath, reason });
  } catch (err) {
    console.error("[vectormind] failed to invalidate file indexes:", filePath, err);
  }
}
type PendingChangeEvent = "add" | "change" | "unlink";

export function peekPendingChangeBuffer(): PendingChangeRow[] {
  const currentRootKey = projectRootKey(getProjectRoot());
  return Array.from(pendingChangeBuffer.values())
    .filter((entry) => entry.projectRootKey === currentRootKey)
    .map((entry) => ({
      file_path: entry.filePath,
      last_event: entry.event,
      updated_at: entry.updatedAt,
      source: "watcher" as const,
    }));
}

export function flushPendingChangeBuffer(): void {
  if (pendingChangeFlushTimer) {
    clearTimeout(pendingChangeFlushTimer);
    pendingChangeFlushTimer = null;
  }
  if (!hasDb()) {
    if (pendingChangeBuffer.size) {
      pendingChangeFlushTimer = setTimeout(flushPendingChangeBuffer, Math.max(1_000, PENDING_FLUSH_MS));
    }
    return;
  }
  if (!pendingChangeBuffer.size) return;
  const currentRootKey = projectRootKey(getProjectRoot());
  const entries = Array.from(pendingChangeBuffer.entries())
    .filter(([, entry]) => entry.projectRootKey === currentRootKey);
  if (!entries.length) return;

  try {
    const tx = getDb().transaction(() => {
      for (const [, entry] of entries) {
        getUpsertPendingChangeStatement().run(entry.filePath, entry.event);
      }
    });
    tx();
    for (const [key, entry] of entries) {
      const current = pendingChangeBuffer.get(key);
      if (current?.event === entry.event && current.projectRootKey === entry.projectRootKey) {
        pendingChangeBuffer.delete(key);
      }
    }
  } catch (err) {
    console.error("[vectormind] failed to flush pending change buffer:", err);
    logActivity("pending_flush_failed", { entries: entries.length, error: String(err) });
    if (!pendingChangeFlushTimer) {
      pendingChangeFlushTimer = setTimeout(flushPendingChangeBuffer, Math.max(1_000, PENDING_FLUSH_MS));
    }
    return;
  }

  logActivity("pending_flush", {
    entries: entries.length,
    sample: entries.slice(0, 10).map(([, entry]) => ({
      file_path: entry.filePath,
      last_event: entry.event,
    })),
  });

  pendingEventsSincePrune += entries.length;
  if (pendingEventsSincePrune >= PENDING_PRUNE_EVERY) {
    pendingEventsSincePrune = 0;
    prunePendingChanges();
  }
}

export function recordPendingChange(absPath: string, event: PendingChangeEvent): void {
  if (shouldIgnorePath(absPath, getProjectRoot())) return;
  if (!isContainedIndexingPath(absPath, event === "unlink")) return;
  const track = isSymbolIndexableFile(absPath) || isContentIndexableFile(absPath);
  if (!track) return;
  const filePath = normalizeToDbPath(absPath);
  const rootKey = projectRootKey(getProjectRoot());
  pendingChangeBuffer.set(bufferedChangeKey(rootKey, filePath), {
    projectRootKey: rootKey,
    filePath,
    event,
    updatedAt: new Date().toISOString(),
  });
  if (pendingChangeFlushTimer) return;
  if (PENDING_FLUSH_MS === 0) {
    flushPendingChangeBuffer();
    return;
  }
  pendingChangeFlushTimer = setTimeout(flushPendingChangeBuffer, PENDING_FLUSH_MS);
}

export function indexFile(absPath: string, reason: IndexReason): void {
  if (shouldIgnorePath(absPath, getProjectRoot())) return;
  if (!isContainedIndexingPath(absPath)) return;
  const filePath = normalizeToDbPath(absPath);
  const indexSymbols = isSymbolIndexableFile(absPath);
  const indexContent = isContentIndexableFile(absPath);
  if (!indexSymbols && !indexContent) {
    invalidateFileIndexes(filePath, "not_indexable");
    return;
  }

  const kind = getContentChunkKind(absPath);
  if (!kind) {
    invalidateFileIndexes(filePath, "unsupported_content_kind");
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    invalidateFileIndexes(filePath, "missing_file");
    return;
  }
  if (!stat.isFile()) {
    invalidateFileIndexes(filePath, "not_a_file");
    return;
  }
  const maxBytes = kind === "code_chunk" ? INDEX_MAX_CODE_BYTES : INDEX_MAX_DOC_BYTES;
  if (maxBytes > 0 && stat.size > maxBytes) {
    invalidateFileIndexes(filePath, "size_limit");
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf8");
  } catch {
    return;
  }
  if (content.includes("\u0000")) {
    invalidateFileIndexes(filePath, "binary_content");
    return;
  }

  const ext = path.extname(absPath).toLowerCase();
  if (
    INDEX_SKIP_MINIFIED &&
    kind === "code_chunk" &&
    (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".css") &&
    looksLikeMinifiedBundle(content)
  ) {
    invalidateFileIndexes(filePath, "minified_bundle");
    logActivity("index_skip", { file_path: filePath, reason: "minified_bundle", bytes: stat.size });
    return;
  }
  if (kind === "code_chunk" && stat.size >= 20_000 && looksLikeGeneratedFile(content)) {
    invalidateFileIndexes(filePath, "generated_file");
    logActivity("index_skip", { file_path: filePath, reason: "generated_file", bytes: stat.size });
    return;
  }

  const symbols = indexSymbols ? extractSymbols(absPath, content) : [];
  let chunkCount = 0;
  try {
    getDb().transaction(() => {
      if (indexSymbols) getIndexFileSymbolsTx()?.(filePath, symbols);
      else getDeleteSymbolsForFileStatement().run(filePath);
      if (indexContent) chunkCount = replaceFileContentChunks(filePath, absPath, content);
      else getDeleteFileChunkItemsStatement().run(filePath);
    })();
  } catch (err) {
    console.error("[vectormind] failed to index file atomically:", filePath, err);
    return;
  }

  logActivity("index_file", {
    file_path: filePath,
    reason,
    symbols: symbols.length,
    chunks: chunkCount,
    bytes: stat.size,
  });
}

export function removeFileIndexes(absPath: string): void {
  if (shouldIgnorePath(absPath, getProjectRoot())) return;
  if (!isContainedIndexingPath(absPath, true)) return;
  const filePath = normalizeToDbPath(absPath);
  try {
    getDb().transaction(() => {
      getDeleteSymbolsForFileStatement().run(filePath);
      getDeleteFileChunkItemsStatement().run(filePath);
    })();
  } catch (err) {
    console.error("[vectormind] failed to remove file indexes:", filePath, err);
    return;
  }
  logActivity("remove_file", { file_path: filePath });
}
type IndexReason = "add" | "change" | "manual";
