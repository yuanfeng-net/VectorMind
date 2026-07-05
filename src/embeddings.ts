import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import type { MemoryItemRow } from "./types.js";

type EmbeddingsContext = {
  getMemoryItemByIdStatement: () => Database.Statement;
  getEmbeddingMetaStatement: () => Database.Statement;
  getUpsertEmbeddingStatement: () => Database.Statement;
  sha256Hex: (input: string) => string;
};

let embeddingsContext: EmbeddingsContext | null = null;

export function configureEmbeddings(context: EmbeddingsContext): void {
  embeddingsContext = context;
}

function requireEmbeddingsContext(): EmbeddingsContext {
  if (!embeddingsContext) throw new Error("[VectorMind] embeddings context is not configured");
  return embeddingsContext;
}

function getMemoryItemByIdStatement(): Database.Statement {
  return requireEmbeddingsContext().getMemoryItemByIdStatement();
}

function getEmbeddingMetaStatement(): Database.Statement {
  return requireEmbeddingsContext().getEmbeddingMetaStatement();
}

function getUpsertEmbeddingStatement(): Database.Statement {
  return requireEmbeddingsContext().getUpsertEmbeddingStatement();
}

function sha256Hex(input: string): string {
  return requireEmbeddingsContext().sha256Hex(input);
}

export const embeddingsEnabled = !["0", "false", "off", "disabled"].includes(
  (process.env.VECTORMIND_EMBEDDINGS ?? "off").toLowerCase(),
);

export const embedFilesMode = (process.env.VECTORMIND_EMBED_FILES ?? "all").toLowerCase();

export const embedModelName = process.env.VECTORMIND_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";

const embedCacheDir =
  process.env.VECTORMIND_EMBED_CACHE_DIR ??
  path.join(os.homedir(), ".cache", "vectormind");

const allowRemoteModels = !["0", "false", "off"].includes(
  (process.env.VECTORMIND_ALLOW_REMOTE_MODELS ?? "true").toLowerCase(),
);

let embedderPromise:
  | Promise<(text: string) => Promise<Float32Array>>
  | null = null;

export async function getEmbedder(): Promise<(text: string) => Promise<Float32Array>> {
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

  const item = getMemoryItemByIdStatement().get(memoryId) as MemoryItemRow | undefined;
  if (!item) return;

  const input = buildEmbeddingInput(item);
  const inputHash = sha256Hex(input);

  const existing = getEmbeddingMetaStatement().get(memoryId) as
    | { memory_id: number; dim: number; content_hash: string | null }
    | undefined;
  if (existing?.content_hash === inputHash) return;

  const embedder = await getEmbedder();
  const vector = await embedder(input);

  const dim = vector.length;
  const bytes = Buffer.from(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
  getUpsertEmbeddingStatement().run(memoryId, dim, bytes, inputHash);
}

const embeddingQueue: number[] = [];

const embeddingQueued = new Set<number>();

let embeddingWorkerRunning = false;

export function enqueueEmbedding(memoryId: number): void {
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

export function dotProduct(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
