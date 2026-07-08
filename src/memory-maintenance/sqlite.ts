import fs from "node:fs";

import { MEMORY_ITEMS_FTS_TABLE } from "../memory-recall.js";
import { getDb, getDbPath, getKvStatement, getSetKvStatement } from "./context.js";
import type { MaintenanceDbSize } from "./types.js";

export function kvGet(key: string): string | null {
  try {
    const row = getKvStatement()?.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}
export function kvSet(key: string, value: string): void {
  try {
    getSetKvStatement()?.run(key, value);
  } catch (err) {
    console.error("[vectormind] kv set failed:", err);
  }
}
function fileSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
export function getDbSize(): MaintenanceDbSize {
  const dbFile = getDbPath();
  const walFile = `${dbFile}-wal`;
  const shmFile = `${dbFile}-shm`;
  const dbBytes = fileSizeOrZero(dbFile);
  const walBytes = fileSizeOrZero(walFile);
  const shmBytes = fileSizeOrZero(shmFile);
  return {
    db_bytes: dbBytes,
    wal_bytes: walBytes,
    shm_bytes: shmBytes,
    total_bytes: dbBytes + walBytes + shmBytes,
  };
}

export function optimizeFts(opts: { dryRun: boolean }): boolean {
  if (opts.dryRun) return false;
  try {
    getDb().exec(`INSERT INTO ${MEMORY_ITEMS_FTS_TABLE}(${MEMORY_ITEMS_FTS_TABLE}) VALUES('optimize')`);
    return true;
  } catch (err) {
    console.error("[vectormind] fts optimize failed:", err);
    return false;
  }
}

export function checkpointWal(opts: { dryRun: boolean }): boolean {
  if (opts.dryRun) return false;
  try {
    getDb().pragma("wal_checkpoint(TRUNCATE)");
    return true;
  } catch (err) {
    console.error("[vectormind] wal checkpoint failed:", err);
    return false;
  }
}
