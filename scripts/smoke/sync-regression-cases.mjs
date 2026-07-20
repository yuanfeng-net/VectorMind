import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

export async function runSyncRegressionCases(ctx) {
  const { client, useToolProjectRoot, toolProjectRoot, readText } = ctx;
  const rootArgs = useToolProjectRoot ? { project_root: toolProjectRoot } : {};
  const token = `${Date.now()}-${process.pid}`;
  const createdPaths = [];
  let outsideDir = null;
  let linkPath = null;

  const callJson = async (name, args) => {
    const text = readText(await client.callTool({ name, arguments: { ...rootArgs, ...args } }));
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: text };
    }
  };
  const startRequirement = async (label) => {
    const result = await callJson("start_requirement", {
      title: `Sync regression ${label} ${token}`,
      background: `Exercise generic sync_change_intent invariants for ${label}.`,
      goal_key: `sync-regression-${label}-${token}`,
      close_previous: false,
    });
    if (!result?.requirement?.id) throw new Error(`failed to start ${label} requirement: ${JSON.stringify(result)}`);
    return result.requirement.id;
  };
  const dbPath = path.join(toolProjectRoot, ".vectormind", "vectormind.db");

  try {
    await callJson("complete_requirement", { all_active: true });

    const atomicBaseline = await callJson("start_requirement", {
      title: `Atomic start baseline ${token}`,
      goal_key: `atomic-start-baseline-${token}`,
      close_previous: false,
    });
    const atomicBaselineId = atomicBaseline?.requirement?.id;
    const atomicFailureTitle = `Atomic start failure ${token}`;
    {
      const db = new Database(dbPath);
      try {
        const quotedTitle = atomicFailureTitle.replace(/'/g, "''");
        db.exec(`
          CREATE TRIGGER smoke_fail_requirement_memory
          BEFORE INSERT ON memory_items
          WHEN NEW.kind = 'requirement' AND NEW.title = '${quotedTitle}'
          BEGIN
            SELECT RAISE(ABORT, 'simulated requirement memory failure');
          END;
        `);
      } finally {
        db.close();
      }
    }
    let atomicFailure;
    try {
      atomicFailure = await callJson("start_requirement", {
        title: atomicFailureTitle,
        goal_key: `atomic-start-failure-${token}`,
      });
    } finally {
      const db = new Database(dbPath);
      try {
        db.exec("DROP TRIGGER IF EXISTS smoke_fail_requirement_memory");
      } finally {
        db.close();
      }
    }
    {
      const db = new Database(dbPath, { readonly: true });
      try {
        const baseline = db.prepare("SELECT status FROM requirements WHERE id = ?").get(atomicBaselineId);
        const failedRequirement = db.prepare("SELECT COUNT(*) AS count FROM requirements WHERE title = ?")
          .get(atomicFailureTitle);
        const baselineMemory = db.prepare(
          `SELECT json_extract(metadata_json, '$.status') AS status
             FROM memory_items WHERE kind = 'requirement' AND req_id = ? ORDER BY id DESC LIMIT 1`,
        ).get(atomicBaselineId);
        if (atomicFailure?.ok !== false || baseline?.status !== "active" || baselineMemory?.status !== "active" ||
            Number(failedRequirement?.count ?? 0) !== 0) {
          throw new Error(`expected failed atomic start to roll back every lifecycle write: ${JSON.stringify({ atomicFailure, baseline, baselineMemory, failedRequirement })}`);
        }
      } finally {
        db.close();
      }
    }
    await callJson("complete_requirement", { req_id: atomicBaselineId });

    const lostAllActive = await callJson("start_requirement", {
      title: `All-active lost update ${token}`,
      goal_key: `all-active-lost-update-${token}`,
      close_previous: false,
    });
    const lostAllActiveId = lostAllActive?.requirement?.id;
    {
      const db = new Database(dbPath);
      try {
        db.exec(`
          CREATE TRIGGER smoke_lose_all_active_update
          BEFORE UPDATE OF status ON requirements
          WHEN OLD.id = ${Number(lostAllActiveId)} AND OLD.status = 'active' AND NEW.status = 'completed'
          BEGIN
            UPDATE requirements SET status = 'superseded' WHERE id = OLD.id;
            UPDATE memory_items
               SET metadata_json = json_set(
                     CASE WHEN json_valid(COALESCE(metadata_json, '{}')) THEN COALESCE(metadata_json, '{}') ELSE '{}' END,
                     '$.status', 'superseded'
                   )
             WHERE kind = 'requirement' AND req_id = OLD.id;
            SELECT RAISE(IGNORE);
          END;
        `);
      } finally {
        db.close();
      }
    }
    let allActiveResult;
    try {
      allActiveResult = await callJson("complete_requirement", { all_active: true });
    } finally {
      const db = new Database(dbPath);
      try {
        db.exec("DROP TRIGGER IF EXISTS smoke_lose_all_active_update");
      } finally {
        db.close();
      }
    }
    {
      const db = new Database(dbPath, { readonly: true });
      try {
        const requirement = db.prepare("SELECT status FROM requirements WHERE id = ?").get(lostAllActiveId);
        const memory = db.prepare(
          `SELECT json_extract(metadata_json, '$.status') AS status
             FROM memory_items WHERE kind = 'requirement' AND req_id = ? ORDER BY id DESC LIMIT 1`,
        ).get(lostAllActiveId);
        const completedIds = new Set((allActiveResult?.completed ?? []).map((entry) => entry.id));
        if (allActiveResult?.ok !== true || completedIds.has(lostAllActiveId) ||
            requirement?.status !== "superseded" || memory?.status !== "superseded") {
          throw new Error(`expected all_active to skip a lost conditional update: ${JSON.stringify({ allActiveResult, requirement, memory })}`);
        }
      } finally {
        db.close();
      }
    }

    const concurrentFileName = `sync-concurrent-${token}.txt`;
    const concurrentFile = path.join(toolProjectRoot, concurrentFileName);
    createdPaths.push(concurrentFile);
    fs.writeFileSync(concurrentFile, "concurrent\n", "utf8");
    const concurrentA = await callJson("start_requirement", {
      title: `Concurrent requirement A ${token}`,
      goal_key: `sync-concurrent-a-${token}`,
    });
    const concurrentB = await callJson("start_requirement", {
      title: `Concurrent requirement B ${token}`,
      goal_key: `sync-concurrent-b-${token}`,
    });
    const concurrentAId = concurrentA?.requirement?.id;
    const concurrentBId = concurrentB?.requirement?.id;
    if (!concurrentAId || !concurrentBId || concurrentB?.closed_previous !== true) {
      throw new Error(`expected the default serial workflow to close requirement A: ${JSON.stringify({ concurrentA, concurrentB })}`);
    }
    const concurrentAStatus = await callJson("get_requirement_status", { req_id: concurrentAId });
    if (concurrentAStatus?.requirement?.status !== "completed" || concurrentAStatus?.active_count !== 1) {
      throw new Error(`expected accurate completed status and active count: ${JSON.stringify(concurrentAStatus)}`);
    }
    const completedPreflight = await callJson("preflight_change_scope", {
      req_id: concurrentAId,
      intent: "Finish an overlapping task after another requirement became active.",
      files: [concurrentFileName],
      format: "json",
    });
    if (completedPreflight?.safe_to_edit !== true || completedPreflight?.active_requirement?.id !== concurrentAId) {
      throw new Error(`expected explicit completed requirement preflight to succeed: ${JSON.stringify(completedPreflight)}`);
    }
    const completedSync = await callJson("sync_change_intent", {
      req_id: concurrentAId,
      intent: "Finish an overlapping task after another requirement became active.",
      files: [concurrentFileName],
      verification: ["Static checks passed."],
      verification_gaps: ["Full tests were not run."],
    });
    if (completedSync?.ok !== true || completedSync?.linked_to_requirement?.id !== concurrentAId) {
      throw new Error(`expected explicit completed requirement sync to succeed: ${JSON.stringify(completedSync)}`);
    }
    {
      const db = new Database(dbPath);
      try {
        db.prepare("UPDATE requirements SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(concurrentAId);
      } finally {
        db.close();
      }
    }
    const verificationUpdate = await callJson("update_requirement_verification", {
      req_id: concurrentAId,
      verification: ["Full suite passed: 41 tests."],
      verification_gaps: [],
      resolved_verification_gaps: ["Full tests were not run."],
    });
    if (verificationUpdate?.ok !== true || verificationUpdate?.requirement?.status !== "completed" ||
        !verificationUpdate?.verification?.includes("Static checks passed.") ||
        !verificationUpdate?.verification?.includes("Full suite passed: 41 tests.") ||
        verificationUpdate?.verification_gaps?.length !== 0 ||
        !verificationUpdate?.verification_update_memory_id) {
      throw new Error(`expected completed requirement verification to update atomically: ${JSON.stringify(verificationUpdate)}`);
    }
    {
      const db = new Database(dbPath, { readonly: true });
      try {
        const requirement = db.prepare("SELECT updated_at FROM requirements WHERE id = ?").get(concurrentAId);
        const change = db.prepare(
          `SELECT metadata_json FROM memory_items
            WHERE kind = 'change_intent' AND req_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
        ).get(concurrentAId);
        const audit = db.prepare(
          `SELECT COUNT(*) AS count FROM memory_items WHERE kind = 'verification_update' AND req_id = ?`,
        ).get(concurrentAId);
        const metadata = JSON.parse(change?.metadata_json ?? "{}");
        if (String(requirement?.updated_at ?? "") <= "2000-01-01 00:00:00" ||
            metadata.verification_gaps?.length !== 0 ||
            Number(audit?.count ?? 0) !== 1) {
          throw new Error(`expected durable verification evidence and refreshed requirement timestamp: ${JSON.stringify({ requirement, metadata, audit })}`);
        }
      } finally {
        db.close();
      }
    }
    const resumedA = await callJson("resume_requirement", { req_id: concurrentAId });
    if (resumedA?.ok !== true || resumedA?.resumed !== true || resumedA?.requirement?.status !== "active") {
      throw new Error(`expected completed requirement to resume without closing peers: ${JSON.stringify(resumedA)}`);
    }
    await callJson("complete_requirement", { req_id: concurrentAId });
    await callJson("complete_requirement", { req_id: concurrentBId });

    const superseded = await callJson("start_requirement", {
      title: `Superseded requirement ${token}`,
      goal_key: `sync-superseded-${token}`,
    });
    const supersededId = superseded?.requirement?.id;
    await callJson("supersede_memory", {
      superseded_req_ids: [supersededId],
      reason: "Exercise requirement recovery safety.",
    });
    const supersededStatus = await callJson("get_requirement_status", { req_id: supersededId });
    const supersededResume = await callJson("resume_requirement", { req_id: supersededId });
    const supersededVerification = await callJson("update_requirement_verification", {
      req_id: supersededId,
      verification: ["Must be rejected."],
    });
    if (supersededStatus?.requirement?.status !== "superseded" || supersededStatus?.resumable !== false ||
        supersededResume?.ok !== false || supersededResume?.code !== "REQUIREMENT_SUPERSEDED" ||
        supersededVerification?.ok !== false || supersededVerification?.code !== "REQUIREMENT_SUPERSEDED") {
      throw new Error(`expected superseded requirement recovery and verification to be rejected: ${JSON.stringify({ supersededStatus, supersededResume, supersededVerification })}`);
    }

    const temporaryScopeReqId = await startRequirement("temporary-planned-files-scope");
    const temporaryScope = await callJson("preflight_change_scope", {
      req_id: temporaryScopeReqId,
      intent: "Use the complete planned file set as a read-only exact scope contract.",
      planned_files: ["src/temporary-scope.ts"],
      format: "json",
    });
    if (temporaryScope?.ok !== true || temporaryScope?.scope_contract_persistence !== "temporary_read_only" ||
        !temporaryScope?.scope_contract?.allowed_paths?.includes("src/temporary-scope.ts") ||
        temporaryScope?.development_warnings?.some((warning) => warning?.code === "scope_contract_missing")) {
      throw new Error(`expected complete planned_files to suppress missing-contract noise with a temporary exact contract: ${JSON.stringify(temporaryScope)}`);
    }
    await callJson("complete_requirement", { req_id: temporaryScopeReqId });

    const historyFileName = `sync-history-${token}.txt`;
    const historyFile = path.join(toolProjectRoot, historyFileName);
    createdPaths.push(historyFile);
    const historyReqId = await startRequirement("history");
    const historyIds = [];
    for (const content of ["A", "B", "A"]) {
      fs.writeFileSync(historyFile, `${content}\n`, "utf8");
      const result = await callJson("sync_change_intent", {
        req_id: historyReqId,
        intent: "Record each observed file state as a new history event.",
        files: [historyFileName],
      });
      if (result?.ok !== true || result?.reused !== false || result?.idempotency_key !== null) {
        throw new Error(`expected a non-idempotent sync to create history: ${JSON.stringify(result)}`);
      }
      historyIds.push(result.created_change?.change_log_id);
    }
    if (new Set(historyIds).size !== 3) {
      throw new Error(`expected A -> B -> A without a key to create three history rows: ${historyIds.join(",")}`);
    }
    await callJson("complete_requirement", { req_id: historyReqId });

    const retryFileName = `sync-retry-${token}.txt`;
    const retryFile = path.join(toolProjectRoot, retryFileName);
    createdPaths.push(retryFile);
    fs.writeFileSync(retryFile, "retry\n", "utf8");
    const retryReqId = await startRequirement("retry");
    const retryArgs = {
      req_id: retryReqId,
      idempotency_key: `sync-retry-key-${token}`,
      intent: "Persist once and replay the identical client request.",
      files: [retryFileName],
      complete_requirement: true,
    };
    const firstRetry = await callJson("sync_change_intent", retryArgs);
    const secondRetry = await callJson("sync_change_intent", retryArgs);
    if (firstRetry?.ok !== true || firstRetry?.reused !== false ||
        secondRetry?.ok !== true || secondRetry?.reused !== true ||
        firstRetry?.created_change?.change_log_id !== secondRetry?.created_change?.change_log_id) {
      throw new Error(`expected completed requirement retry to reuse one sync: ${JSON.stringify({ firstRetry, secondRetry })}`);
    }
    const conflict = await callJson("sync_change_intent", { ...retryArgs, intent: `${retryArgs.intent} changed` });
    if (conflict?.ok !== false || !String(conflict?.error ?? "").includes("idempotency_key conflict")) {
      throw new Error(`expected changed arguments for one idempotency key to conflict: ${JSON.stringify(conflict)}`);
    }

    const pendingReqId = await startRequirement("pending-batch");
    const pendingPrefix = `pending-batch-${token}`;
    {
      const db = new Database(dbPath);
      try {
        const insert = db.prepare(
          `INSERT INTO pending_changes (file_path, last_event, updated_at)
           VALUES (?, 'unlink', ?)
           ON CONFLICT(file_path) DO UPDATE SET last_event = excluded.last_event, updated_at = excluded.updated_at`,
        );
        for (let index = 0; index < 3; index += 1) {
          insert.run(`${pendingPrefix}/missing-${index}.txt`, `9999-12-${31 - index} 23:59:59`);
        }
      } finally {
        db.close();
      }
    }
    const prematureComplete = await callJson("sync_change_intent", {
      req_id: pendingReqId,
      intent: "Do not complete while a bounded pending batch still has remaining work.",
      pending_limit: 2,
      complete_requirement: true,
    });
    if (prematureComplete?.ok !== false || !String(prematureComplete?.error ?? "").includes("pending change(s) remain")) {
      throw new Error(`expected premature completion to roll back: ${JSON.stringify(prematureComplete)}`);
    }
    {
      const db = new Database(dbPath, { readonly: true });
      try {
        const remaining = db.prepare("SELECT COUNT(*) AS count FROM pending_changes WHERE file_path LIKE ?")
          .get(`${pendingPrefix}/%`);
        if (Number(remaining?.count ?? 0) !== 3) {
          throw new Error(`expected rejected completion to preserve the whole batch, remaining=${remaining?.count}`);
        }
      } finally {
        db.close();
      }
    }
    const pendingFirst = await callJson("sync_change_intent", {
      req_id: pendingReqId,
      intent: "Consume one bounded pending batch.",
      pending_limit: 2,
    });
    if (pendingFirst?.ok !== true || pendingFirst?.pending_batch?.processed !== 2 ||
        pendingFirst?.pending_batch?.truncated !== true || pendingFirst?.synced_files?.length > 2 ||
        pendingFirst?.created?.length > 2) {
      throw new Error(`expected a bounded pending response with remaining work: ${JSON.stringify(pendingFirst)}`);
    }
    {
      const db = new Database(dbPath, { readonly: true });
      try {
        const remaining = db.prepare("SELECT COUNT(*) AS count FROM pending_changes WHERE file_path LIKE ?")
          .get(`${pendingPrefix}/%`);
        if (Number(remaining?.count ?? 0) !== 1) {
          throw new Error(`expected only processed pending rows to be deleted, remaining=${remaining?.count}`);
        }
      } finally {
        db.close();
      }
    }
    const pendingFinal = await callJson("sync_change_intent", {
      req_id: pendingReqId,
      intent: "Consume the remaining bounded pending batch.",
      pending_limit: 2,
    });
    if (pendingFinal?.ok !== true) {
      throw new Error(`expected the remaining pending batch to sync: ${JSON.stringify(pendingFinal)}`);
    }
    await callJson("complete_requirement", { req_id: pendingReqId });

    const aliasReqId = await startRequirement("affected-files-alias");
    const aliasFileName = `sync-alias-${token}.txt`;
    const aliasFile = path.join(toolProjectRoot, aliasFileName);
    createdPaths.push(aliasFile);
    fs.writeFileSync(aliasFile, "alias\n", "utf8");
    const aliasResult = await callJson("sync_change_intent", {
      req_id: aliasReqId,
      intent: "Merge files and affected_files aliases without empty-array shadowing.",
      files: [],
      affected_files: [aliasFileName],
      verification: Array.from({ length: 20 }, (_, index) => `verification-${index}-${"x".repeat(1900)}`),
      complete_requirement: true,
    });
    if (aliasResult?.ok !== true || aliasResult?.synced_files?.[0]?.file_path !== aliasFileName ||
        aliasResult?.verification_total !== 20 || aliasResult?.verification_truncated !== true ||
        JSON.stringify(aliasResult).length > 20_000) {
      throw new Error(`expected merged aliases and a bounded full response: ${JSON.stringify(aliasResult)}`);
    }

    const containmentReqId = await startRequirement("path-containment");
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-sync-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "outside\n", "utf8");
    linkPath = path.join(toolProjectRoot, `sync-outside-link-${token}`);
    fs.symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    const linkRelative = path.relative(toolProjectRoot, linkPath).replace(/\\/g, "/");
    const escaped = await callJson("sync_change_intent", {
      req_id: containmentReqId,
      intent: "This path must be rejected.",
      files: [`${linkRelative}/secret.txt`],
    });
    if (escaped?.ok !== false || !/project_root|outside|contain/i.test(String(escaped?.error ?? ""))) {
      throw new Error(`expected a linked path outside project_root to be rejected: ${JSON.stringify(escaped)}`);
    }

    {
      const db = new Database(dbPath);
      try {
        db.prepare(
          `INSERT INTO pending_changes (file_path, last_event, updated_at)
           VALUES (?, 'unlink', '9999-12-31 23:59:59')
           ON CONFLICT(file_path) DO UPDATE SET last_event = excluded.last_event, updated_at = excluded.updated_at`,
        ).run(`${linkRelative}/missing.txt`);
      } finally {
        db.close();
      }
    }
    const escapedMissing = await callJson("sync_change_intent", {
      req_id: containmentReqId,
      intent: "A missing unlink under an external link must also be rejected.",
      pending_limit: 1,
    });
    if (escapedMissing?.ok !== false || !/project_root|outside|contain/i.test(String(escapedMissing?.error ?? ""))) {
      throw new Error(`expected a missing unlink through an external link to be rejected: ${JSON.stringify(escapedMissing)}`);
    }
    await callJson("complete_requirement", { req_id: containmentReqId });
    const handoff = await callJson("start_requirement", {
      title: `Sync regression handoff ${token}`,
      background: "Leave one explicit active requirement for downstream lifecycle smoke coverage.",
      goal_key: `sync-regression-handoff-${token}`,
      close_previous: false,
    });
    if (!handoff?.requirement?.id) {
      throw new Error(`expected an active handoff requirement for downstream smoke cases: ${JSON.stringify(handoff)}`);
    }
    return true;
  } catch (err) {
    console.error("\n[smoke] sync regression cases failed:", err);
    process.exitCode = 1;
    return false;
  } finally {
    try {
      const db = new Database(dbPath);
      db.prepare("DELETE FROM pending_changes WHERE file_path LIKE ? OR file_path LIKE ?")
        .run(`pending-batch-${token}/%`, `%sync-outside-link-${token}%`);
      db.close();
    } catch {
      // Best-effort cleanup for failed smoke runs.
    }
    if (linkPath) {
      try { fs.unlinkSync(linkPath); } catch { /* best effort */ }
    }
    if (outsideDir) fs.rmSync(outsideDir, { recursive: true, force: true });
    for (const file of createdPaths) fs.rmSync(file, { force: true });
  }
}
