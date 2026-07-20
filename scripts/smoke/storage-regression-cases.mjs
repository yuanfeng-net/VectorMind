import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabaseRuntime } from "../../dist/database-runtime.js";
import { configureFileIndexing, flushPendingChangeBuffer, indexFile, recordPendingChange } from "../../dist/file-indexing.js";
import { configureMemoryMutations, supersedeRequirementIds } from "../../dist/memory-mutations.js";
import { resolvePathWithinRoot } from "../../dist/path-containment.js";
import { parseGitStatusPorcelainZ } from "../../dist/pending-changes.js";

export async function runStorageRegressionCases() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-storage-regression-"));
  const runtime = openDatabaseRuntime(root);
  const normalizeToDbPath = (inputPath) => path.relative(root, path.resolve(inputPath)).replace(/\\/g, "/");
  try {
    const porcelain = [
      "R  renamed-destination.ts",
      "renamed-source.ts",
      ...Array.from({ length: 600 }, (_, index) => ` M bulk-${index}.ts`),
      "",
    ].join("\0");
    const parsedGit = parseGitStatusPorcelainZ(porcelain);
    if (parsedGit.length !== 601 || parsedGit[0]?.filePath !== "renamed-destination.ts" || parsedGit[1]?.filePath !== "bulk-0.ts") {
      throw new Error(`unexpected porcelain -z parsing: ${JSON.stringify(parsedGit.slice(0, 3))} total=${parsedGit.length}`);
    }

    configureFileIndexing({
      getDb: () => runtime.db,
      getProjectRoot: () => root,
      normalizeToDbPath,
      getIndexFileSymbolsTx: () => runtime.indexFileSymbolsTx,
      getDeleteFileChunkItemsStatement: () => runtime.statements.deleteFileChunkItemsStmt,
      getInsertMemoryItemStatement: () => runtime.statements.insertMemoryItemStmt,
      getUpsertPendingChangeStatement: () => runtime.statements.upsertPendingChangeStmt,
      getDeleteSymbolsForFileStatement: () => runtime.statements.deleteSymbolsForFileStmt,
      sha256Hex: (input) => crypto.createHash("sha256").update(input).digest("hex"),
      prunePendingChanges: () => {},
    });

    const indexedPath = path.join(root, "indexed.ts");
    fs.writeFileSync(indexedPath, "export function indexedSymbol() { return 1; }\n");
    indexFile(indexedPath, "manual");
    const before = runtime.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_items WHERE file_path = 'indexed.ts' AND kind IN ('code_chunk', 'doc_chunk')) AS chunks,
         (SELECT COUNT(*) FROM symbols WHERE file_path = 'indexed.ts') AS symbols`,
    ).get();
    if (Number(before?.chunks ?? 0) < 1 || Number(before?.symbols ?? 0) < 1) {
      throw new Error(`expected initial indexes, got ${JSON.stringify(before)}`);
    }

    fs.writeFileSync(indexedPath, Buffer.from("binary\0content"));
    indexFile(indexedPath, "manual");
    const after = runtime.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_items WHERE file_path = 'indexed.ts' AND kind IN ('code_chunk', 'doc_chunk')) AS chunks,
         (SELECT COUNT(*) FROM symbols WHERE file_path = 'indexed.ts') AS symbols`,
    ).get();
    if (Number(after?.chunks ?? 0) !== 0 || Number(after?.symbols ?? 0) !== 0) {
      throw new Error(`expected skipped file to invalidate old indexes, got ${JSON.stringify(after)}`);
    }

    configureMemoryMutations({
      getDb: () => runtime.db,
      getMemoryItemByIdStatement: () => runtime.statements.getMemoryItemByIdStmt,
      getCompleteRequirementMemoryItemByReqIdStatement: () => runtime.statements.completeRequirementMemoryItemByReqIdStmt,
    });
    const reqId = Number(runtime.db.prepare(
      `INSERT INTO requirements(title, context_data, status, goal_key) VALUES (?, ?, 'active', ?)`,
    ).run("Storage transaction regression", "Preserve metadata while superseding.", "storage-transaction-regression").lastInsertRowid);
    runtime.db.prepare(
      `INSERT INTO memory_items(kind, title, content, req_id, metadata_json, content_hash)
       VALUES ('requirement', ?, ?, ?, ?, ?)`,
    ).run(
      "Storage transaction regression",
      "Preserve metadata while superseding.",
      reqId,
      JSON.stringify({ status: "active", keep: "preserved" }),
      crypto.createHash("sha256").update(String(reqId)).digest("hex"),
    );
    supersedeRequirementIds([reqId], { reason: "regression verification" });
    const superseded = runtime.db.prepare(
      `SELECT r.status,
              json_extract(m.metadata_json, '$.status') AS memory_status,
              json_extract(m.metadata_json, '$.keep') AS preserved
         FROM requirements r
         JOIN memory_items m ON m.req_id = r.id AND m.kind = 'requirement'
        WHERE r.id = ?`,
    ).get(reqId);
    if (superseded?.status !== "superseded" || superseded?.memory_status !== "superseded" || superseded?.preserved !== "preserved") {
      throw new Error(`expected atomic supersede with metadata preservation, got ${JSON.stringify(superseded)}`);
    }

    const outsideBase = fs.mkdtempSync(path.join(path.dirname(root), "vectormind-dangling-target-"));
    const missingTarget = path.join(outsideBase, "future-directory");
    const danglingLink = path.join(root, "dangling-link");
    try {
      fs.symlinkSync(missingTarget, danglingLink, process.platform === "win32" ? "junction" : "dir");
      let rejected = false;
      try {
        resolvePathWithinRoot(root, path.join(danglingLink, "future.ts"), { allowMissing: true });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("expected dangling linked parent to be rejected");
    } catch (error) {
      const code = error?.code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") throw error;
    } finally {
      try {
        fs.unlinkSync(danglingLink);
      } catch {}
      fs.rmSync(outsideBase, { recursive: true, force: true });
    }

    const pendingRootA = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-pending-a-"));
    const pendingRootB = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-pending-b-"));
    let activeRoot = pendingRootA;
    let activeRuntime = openDatabaseRuntime(activeRoot);
    const configureActivePendingRuntime = () => configureFileIndexing({
      getDb: () => activeRuntime.db,
      getProjectRoot: () => activeRoot,
      normalizeToDbPath: (inputPath) => path.relative(activeRoot, path.resolve(inputPath)).replace(/\\/g, "/"),
      getIndexFileSymbolsTx: () => activeRuntime.indexFileSymbolsTx,
      getDeleteFileChunkItemsStatement: () => activeRuntime.statements.deleteFileChunkItemsStmt,
      getInsertMemoryItemStatement: () => activeRuntime.statements.insertMemoryItemStmt,
      getUpsertPendingChangeStatement: () => activeRuntime.statements.upsertPendingChangeStmt,
      getDeleteSymbolsForFileStatement: () => activeRuntime.statements.deleteSymbolsForFileStmt,
      sha256Hex: (input) => crypto.createHash("sha256").update(input).digest("hex"),
      prunePendingChanges: () => {},
    });
    try {
      configureActivePendingRuntime();
      const pendingFile = path.join(pendingRootA, "pending.ts");
      fs.writeFileSync(pendingFile, "export const pending = true;\n");
      activeRuntime.db.close();
      recordPendingChange(pendingFile, "change");
      const originalConsoleError = console.error;
      try {
        console.error = (...args) => {
          if (!String(args[0] ?? "").includes("failed to flush pending change buffer")) {
            originalConsoleError(...args);
          }
        };
        flushPendingChangeBuffer();
      } finally {
        console.error = originalConsoleError;
      }

      activeRoot = pendingRootB;
      activeRuntime = openDatabaseRuntime(activeRoot);
      configureActivePendingRuntime();
      flushPendingChangeBuffer();
      const wrongProjectCount = Number(activeRuntime.db.prepare("SELECT COUNT(*) AS count FROM pending_changes").get()?.count ?? 0);
      if (wrongProjectCount !== 0) throw new Error("pending retry leaked into another project database");
      activeRuntime.db.close();

      activeRoot = pendingRootA;
      activeRuntime = openDatabaseRuntime(activeRoot);
      configureActivePendingRuntime();
      flushPendingChangeBuffer();
      const originalProjectCount = Number(activeRuntime.db.prepare("SELECT COUNT(*) AS count FROM pending_changes").get()?.count ?? 0);
      if (originalProjectCount !== 1) throw new Error("pending retry did not return to its original project database");
    } finally {
      if (activeRuntime.db.open) activeRuntime.db.close();
      fs.rmSync(pendingRootA, { recursive: true, force: true });
      fs.rmSync(pendingRootB, { recursive: true, force: true });
    }
    console.log("storage regression cases: ok");
    return true;
  } catch (error) {
    console.error("\n[smoke] storage regression check failed:", error);
    process.exitCode = 1;
    return false;
  } finally {
    runtime.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
