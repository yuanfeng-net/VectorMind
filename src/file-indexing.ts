import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { ExtractedSymbol } from "./types.js";
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

const pendingChangeBuffer = new Map<string, PendingChangeEvent>();
let pendingChangeFlushTimer: NodeJS.Timeout | null = null;
let pendingEventsSincePrune = 0;

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
function indexFileContentChunks(
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

  const tx = getDb().transaction(() => {
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
  });

  try {
    tx();
  } catch (err) {
    console.error("[vectormind] failed to index file chunks:", dbFilePath, err);
  }
  return chunks.length;
}
type PendingChangeEvent = "add" | "change" | "unlink";

export function flushPendingChangeBuffer(): void {
  if (!hasDb()) return;
  if (pendingChangeFlushTimer) {
    clearTimeout(pendingChangeFlushTimer);
    pendingChangeFlushTimer = null;
  }
  if (!pendingChangeBuffer.size) return;
  const entries = Array.from(pendingChangeBuffer.entries());
  pendingChangeBuffer.clear();

  try {
    const tx = getDb().transaction(() => {
      for (const [filePath, event] of entries) {
        getUpsertPendingChangeStatement().run(filePath, event);
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

export function recordPendingChange(absPath: string, event: PendingChangeEvent): void {
  if (shouldIgnorePath(absPath, getProjectRoot())) return;
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

export function indexFile(absPath: string, reason: IndexReason): void {
  if (shouldIgnorePath(absPath, getProjectRoot())) return;
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
      getIndexFileSymbolsTx()?.(filePath, symbols);
    } catch (err) {
      console.error("[vectormind] failed to index symbols:", filePath, err);
    }
  }
  if (indexContent) {
    chunkCount = indexFileContentChunks(filePath, absPath, content);
  }

  logActivity("index_file", {
    file_path: filePath,
    reason,
    symbols: symbolCount,
    chunks: chunkCount,
    bytes: stat.size,
  });
}

export function removeFileIndexes(absPath: string): void {
  if (shouldIgnorePath(absPath, getProjectRoot())) return;
  const filePath = normalizeToDbPath(absPath);
  try {
    getDeleteSymbolsForFileStatement().run(filePath);
  } catch (err) {
    console.error("[vectormind] failed to remove symbols:", filePath, err);
  }
  try {
    getDeleteFileChunkItemsStatement().run(filePath);
  } catch (err) {
    console.error("[vectormind] failed to remove file chunks:", filePath, err);
  }
  logActivity("remove_file", { file_path: filePath });
}
type IndexReason = "add" | "change" | "manual";
