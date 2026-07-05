export const SERVER_NAME = "vector-mind";
export const SERVER_VERSION = "1.0.50";

export const prettyJsonOutput = ["1", "true", "on", "yes"].includes(
  (process.env.VECTORMIND_PRETTY_JSON ?? "").trim().toLowerCase(),
);

export const debugLogEnabled = ["1", "true", "on", "yes"].includes(
  (process.env.VECTORMIND_DEBUG_LOG ?? "").trim().toLowerCase(),
);

export const debugLogMaxEntries = (() => {
  const raw = process.env.VECTORMIND_DEBUG_LOG_MAX?.trim();
  if (!raw) return 200;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(5000, n);
})();

export const PENDING_FLUSH_MS = (() => {
  const raw = process.env.VECTORMIND_PENDING_FLUSH_MS?.trim();
  if (!raw) return 200;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 200;
  return n;
})();

export const PENDING_TTL_DAYS = (() => {
  const raw = process.env.VECTORMIND_PENDING_TTL_DAYS?.trim();
  if (!raw) return 30;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 30;
  return n;
})();

export const PENDING_MAX_ENTRIES = (() => {
  const raw = process.env.VECTORMIND_PENDING_MAX?.trim();
  if (!raw) return 5000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 5000;
  return n;
})();

export const PENDING_PRUNE_EVERY = (() => {
  const raw = process.env.VECTORMIND_PENDING_PRUNE_EVERY?.trim();
  if (!raw) return 500;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 500;
  return n;
})();

export const DEVELOPMENT_WARN_FILE_LINES = (() => {
  const raw = process.env.VECTORMIND_WARN_FILE_LINES?.trim();
  if (!raw) return 800;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 100) return 800;
  return Math.min(50_000, n);
})();

export const DEVELOPMENT_BLOCK_FILE_LINES = (() => {
  const raw = process.env.VECTORMIND_BLOCK_FILE_LINES?.trim();
  if (!raw) return 1200;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < DEVELOPMENT_WARN_FILE_LINES) return Math.max(1200, DEVELOPMENT_WARN_FILE_LINES);
  return Math.min(100_000, n);
})();

export const DEVELOPMENT_HUGE_FILE_LINES = (() => {
  const raw = process.env.VECTORMIND_HUGE_FILE_LINES?.trim();
  if (!raw) return 3000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < DEVELOPMENT_BLOCK_FILE_LINES) {
    return Math.max(3000, DEVELOPMENT_BLOCK_FILE_LINES);
  }
  return Math.min(200_000, n);
})();

export const DEVELOPMENT_WARN_FILE_BYTES = (() => {
  const raw = process.env.VECTORMIND_WARN_FILE_BYTES?.trim();
  if (!raw) return 120_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 10_000) return 120_000;
  return Math.min(20_000_000, n);
})();

export const DEVELOPMENT_WARN_PENDING_FILES = (() => {
  const raw = process.env.VECTORMIND_WARN_PENDING_FILES?.trim();
  if (!raw) return 12;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 12;
  return Math.min(500, n);
})();

export const RIPGREP_RESOLVE_TIMEOUT_MS = 5_000;
export const RIPGREP_SEARCH_TIMEOUT_MS = 30_000;
export const RIPGREP_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export const INDEX_MAX_CODE_BYTES = (() => {
  const raw = process.env.VECTORMIND_INDEX_MAX_CODE_BYTES?.trim();
  if (!raw) return 400_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 400_000;
  return n;
})();

export const INDEX_MAX_DOC_BYTES = (() => {
  const raw = process.env.VECTORMIND_INDEX_MAX_DOC_BYTES?.trim();
  if (!raw) return 600_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 600_000;
  return n;
})();

export const INDEX_SKIP_MINIFIED = (() => {
  const raw = (process.env.VECTORMIND_INDEX_SKIP_MINIFIED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "on", "yes"].includes(raw);
})();

export const INDEX_AUTO_PRUNE_IGNORED = (() => {
  const raw = (process.env.VECTORMIND_INDEX_AUTO_PRUNE_IGNORED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "on", "yes"].includes(raw);
})();

export const MAINTENANCE_AUTO_ENABLED = (() => {
  const raw = (process.env.VECTORMIND_MAINTENANCE_AUTO ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "on", "yes"].includes(raw);
})();

export const MAINTENANCE_INTERVAL_HOURS = (() => {
  const raw = process.env.VECTORMIND_MAINTENANCE_INTERVAL_HOURS?.trim();
  if (!raw) return 24;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 24;
  return Math.min(24 * 30, n);
})();

export const MAINTENANCE_COMPACT_AFTER_DAYS = (() => {
  const raw = process.env.VECTORMIND_COMPACT_AFTER_DAYS?.trim();
  if (!raw) return 45;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 45;
  return Math.min(3650, n);
})();

export const MAINTENANCE_MAX_MEMORY_ITEMS = (() => {
  const raw = process.env.VECTORMIND_MAINTENANCE_MAX_MEMORY_ITEMS?.trim();
  if (!raw) return 250;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 250;
  return Math.min(5000, n);
})();

export const MAINTENANCE_MAX_INDEX_FILES = (() => {
  const raw = process.env.VECTORMIND_MAINTENANCE_MAX_INDEX_FILES?.trim();
  if (!raw) return 1500;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1500;
  return Math.min(50_000, n);
})();

export const ROOTS_LIST_TIMEOUT_MS = (() => {
  const raw = process.env.VECTORMIND_ROOTS_TIMEOUT_MS?.trim();
  if (!raw) return 750;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 750;
  return n;
})();

export const BOOTSTRAP_SEMANTIC_TIMEOUT_MS = (() => {
  const raw = process.env.VECTORMIND_SEMANTIC_TIMEOUT_MS?.trim();
  if (!raw) return 2500;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 2500;
  return n;
})();
