import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import Database from "better-sqlite3";

import type { PendingChangeRow } from "./types.js";
import { IGNORED_LIKE_PATTERNS, shouldIgnoreDbFilePath } from "./path-rules.js";
import { PENDING_MAX_ENTRIES, PENDING_TTL_DAYS } from "./config.js";
import { logActivity } from "./activity-log.js";

type PendingChangesContext = {
  getDb: () => Database.Database | undefined;
  getProjectRoot: () => string;
  getCountPendingChangesStatement: () => Database.Statement;
  getDeleteOldPendingChangesStatement: () => Database.Statement | null;
  getDeleteOldestPendingChangesStatement: () => Database.Statement | null;
  getFileStateHash: (dbOrAbsPath: string) => string | null;
  getLatestSyncedFileHash: (dbFilePath: string) => string | null;
};

let pendingChangesContext: PendingChangesContext | null = null;

export function configurePendingChanges(context: PendingChangesContext): void {
  pendingChangesContext = context;
}

function requirePendingChangesContext(): PendingChangesContext {
  if (!pendingChangesContext) throw new Error("[VectorMind] pending changes context is not configured");
  return pendingChangesContext;
}

function hasDb(): boolean {
  return !!requirePendingChangesContext().getDb();
}

function getDb(): Database.Database {
  const db = requirePendingChangesContext().getDb();
  if (!db) throw new Error("[VectorMind] database is not initialized");
  return db;
}

function getProjectRoot(): string {
  return requirePendingChangesContext().getProjectRoot();
}

function getCountPendingChangesStatement(): Database.Statement {
  return requirePendingChangesContext().getCountPendingChangesStatement();
}

function getDeleteOldPendingChangesStatement(): Database.Statement | null {
  return requirePendingChangesContext().getDeleteOldPendingChangesStatement();
}

function getDeleteOldestPendingChangesStatement(): Database.Statement | null {
  return requirePendingChangesContext().getDeleteOldestPendingChangesStatement();
}

function getFileStateHash(dbOrAbsPath: string): string | null {
  return requirePendingChangesContext().getFileStateHash(dbOrAbsPath);
}

function getLatestSyncedFileHash(dbFilePath: string): string | null {
  return requirePendingChangesContext().getLatestSyncedFileHash(dbFilePath);
}

function isProbablyGitRepository(): boolean {
  try {
    return fs.existsSync(path.join(getProjectRoot(), ".git"));
  } catch {
    return false;
  }
}

function normalizeGitStatusPath(raw: string): string {
  const first = raw.split("\0")[0] ?? "";
  return first.replace(/\\/g, "/");
}

export function parseGitStatusPorcelainZ(stdout: string): Array<{ status: string; filePath: string }> {
  const parts = stdout.split("\0").filter((part) => part.length > 0);
  const parsed: Array<{ status: string; filePath: string }> = [];
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i] ?? "";
    if (record.length < 3) continue;
    const status = record.slice(0, 2);
    const filePath = normalizeGitStatusPath(record.slice(3));
    if (status.startsWith("R") || status.startsWith("C")) {
      // Porcelain v1 -z reverses the human-readable order: the first path is
      // the destination and the following NUL field is the source.
      i += 1;
    }
    if (filePath) parsed.push({ status, filePath });
  }
  return parsed;
}

function collectGitPendingChanges(): PendingChangeRow[] {
  if (!isProbablyGitRepository()) return [];
  const git = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
    cwd: getProjectRoot(),
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 2_000_000,
  });
  if (git.error || git.status !== 0 || !git.stdout) return [];

  const rows: PendingChangeRow[] = [];
  for (const { status, filePath } of parseGitStatusPorcelainZ(git.stdout)) {
    if (!filePath || filePath === ".vectormind" || filePath.startsWith(".vectormind/")) continue;
    if (shouldIgnoreDbFilePath(filePath)) continue;
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

export function mergePendingWithGit(
  pending: PendingChangeRow[],
  opts: { offset: number; limit: number },
): { total: number; page: PendingChangeRow[]; remaining: number; truncated: boolean } {
  const byPath = new Map<string, PendingChangeRow>();
  for (const p of pending) {
    if (shouldIgnoreDbFilePath(p.file_path)) continue;
    byPath.set(p.file_path, { ...p, source: p.source ?? "watcher" });
  }

  const gitRows = collectGitPendingChanges();
  for (const g of gitRows) {
    if (shouldIgnoreDbFilePath(g.file_path)) continue;
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
  const remaining = Math.max(0, all.length - opts.offset - page.length);
  return { total: all.length, page, remaining, truncated: remaining > 0 };
}

function pruneIgnoredPendingChanges(): void {
  if (!hasDb()) return;
  try {
    if (!IGNORED_LIKE_PATTERNS.length) return;
    const where = IGNORED_LIKE_PATTERNS
      .map(() => "LOWER(REPLACE(file_path, '\\\\', '/')) LIKE ?")
      .join(" OR ");
    getDb().prepare(`DELETE FROM pending_changes WHERE ${where}`).run(...IGNORED_LIKE_PATTERNS);
  } catch (err) {
    console.error("[vectormind] prune pending_changes failed:", err);
  }
}

export function prunePendingChanges(): void {
  if (!hasDb()) return;
  try {
    const before = Number((getCountPendingChangesStatement().get() as { total: number } | undefined)?.total ?? 0);
    pruneIgnoredPendingChanges();

    if (PENDING_TTL_DAYS > 0) {
      getDeleteOldPendingChangesStatement()?.run(`-${PENDING_TTL_DAYS} days`);
    }

    if (PENDING_MAX_ENTRIES > 0) {
      const total = Number((getCountPendingChangesStatement().get() as { total: number } | undefined)?.total ?? 0);
      const overflow = total - PENDING_MAX_ENTRIES;
      if (overflow > 0) {
        getDeleteOldestPendingChangesStatement()?.run(overflow);
      }
    }

    const after = Number((getCountPendingChangesStatement().get() as { total: number } | undefined)?.total ?? 0);
    if (before !== after) {
      logActivity("pending_prune", { before, after });
    }
  } catch (err) {
    console.error("[vectormind] prune pending_changes failed:", err);
  }
}
