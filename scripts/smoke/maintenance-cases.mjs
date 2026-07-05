import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export async function runMaintenanceCases(ctx) {
  const { client, useToolProjectRoot, toolProjectRoot, token, testPath, keepFiles, inPlace, readText } = ctx;
  const savings = await client.callTool({
    name: "get_token_savings",
    arguments: useToolProjectRoot ? { project_root: toolProjectRoot } : {},
  });
  console.log("\n--- get_token_savings ---\n");
  const savingsText = readText(savings);
  console.log(savingsText);
  if (!savingsText.includes("token_savings") || !savingsText.includes("bootstrap_context")) {
    console.error("\n[smoke] expected get_token_savings compact output to include bootstrap_context savings");
    process.exitCode = 1;
    return;
  }

  const savingsJson = await client.callTool({
    name: "get_token_savings",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      format: "json",
    },
  });
  try {
    const parsed = JSON.parse(readText(savingsJson));
    if (parsed?.ok !== true) throw new Error("expected ok=true from get_token_savings json");
    if (!parsed?.summary || Number(parsed.summary.calls ?? 0) < 1) {
      throw new Error("expected token savings summary to have at least one call");
    }
  } catch (err) {
    console.error("\n[smoke] get_token_savings json check failed:", err);
    process.exitCode = 1;
    return;
  }

  const dbPath = path.join(toolProjectRoot, ".vectormind", "vectormind.db");
  const db = new Database(dbPath);
  const oldDate = "2000-01-01 00:00:00";
  const stalePath = "old_stale_index.md";
  const keepDecisionContent = `Current smoke decision must remain searchable token=${token}`;
  const oldRequirementInfo = db
    .prepare(
      `INSERT INTO requirements (title, status, context_data, created_at, updated_at)
       VALUES (?, 'completed', ?, ?, ?)`,
    )
    .run("Old smoke requirement", `Old background token=${token}`, oldDate, oldDate);
  const oldReqId = Number(oldRequirementInfo.lastInsertRowid);
  const oldMemInfo = db
    .prepare(
      `INSERT INTO memory_items
         (kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at)
       VALUES
         ('requirement', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      "Old smoke requirement",
      `Old completed requirement should be compacted token=${token}`,
      oldReqId,
      JSON.stringify({ status: "completed" }),
      "old-requirement-hash",
      oldDate,
      oldDate,
    );
  const oldMemId = Number(oldMemInfo.lastInsertRowid);
  db
    .prepare(
      `INSERT INTO memory_items
         (kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at)
       VALUES
         ('change_intent', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      "Old smoke change",
      `Old change intent should be compacted token=${token}`,
      "old-file.md",
      oldReqId,
      JSON.stringify({ event: "change", file_state_hash: "old" }),
      "old-change-hash",
      oldDate,
      oldDate,
    );
  db
    .prepare(
      `INSERT INTO memory_items
         (kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at)
       VALUES
         ('decision', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(
      "smoke-current-decision",
      keepDecisionContent,
      JSON.stringify({ status: "current", key: "smoke-current-decision" }),
      "decision-hash",
      oldDate,
      oldDate,
    );
  db
    .prepare(
      `INSERT INTO memory_items
         (kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at)
       VALUES
         ('doc_chunk', ?, ?, ?, 1, 1, NULL, ?, ?, ?, ?)`,
    )
    .run(
      `${stalePath}#L1-L1`,
      `Stale index should be pruned token=${token}`,
      stalePath,
      JSON.stringify({ ext: ".md" }),
      "stale-hash",
      oldDate,
      oldDate,
    );
  db.close();

  const maintainDry = await client.callTool({
    name: "maintain_memory",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      dry_run: true,
      compact_after_days: 1,
      max_memory_items: 20,
      max_index_files: 20,
      format: "json",
    },
  });
  console.log("\n--- maintain_memory (dry_run json) ---\n");
  const maintainDryText = readText(maintainDry);
  console.log(maintainDryText);
  try {
    const parsed = JSON.parse(maintainDryText);
    if (parsed?.ok !== true || parsed?.dry_run !== true) throw new Error("expected dry-run maintain_memory ok");
    if (Number(parsed?.compacted_memory?.candidates ?? 0) < 2) {
      throw new Error("expected old completed requirement/change intent candidates");
    }
    if (Number(parsed?.pruned?.stale_files?.files_matched ?? 0) < 1) {
      throw new Error("expected stale index candidate");
    }
  } catch (err) {
    console.error("\n[smoke] maintain_memory dry-run check failed:", err);
    process.exitCode = 1;
    return;
  }

  const maintainApply = await client.callTool({
    name: "maintain_memory",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      dry_run: false,
      compact_after_days: 1,
      max_memory_items: 20,
      max_index_files: 20,
      format: "json",
    },
  });
  console.log("\n--- maintain_memory (apply json) ---\n");
  const maintainApplyText = readText(maintainApply);
  console.log(maintainApplyText);
  try {
    const parsed = JSON.parse(maintainApplyText);
    if (parsed?.ok !== true || parsed?.dry_run !== false) throw new Error("expected apply maintain_memory ok");
    if (Number(parsed?.compacted_memory?.compacted ?? 0) < 2) {
      throw new Error("expected old memory items to be compacted");
    }
    if (Number(parsed?.compacted_memory?.summary_memory_id ?? 0) <= 0) {
      throw new Error("expected memory_compaction summary id");
    }
    if (Number(parsed?.pruned?.stale_files?.chunks_deleted ?? 0) < 1) {
      throw new Error("expected stale doc_chunk to be deleted");
    }
  } catch (err) {
    console.error("\n[smoke] maintain_memory apply check failed:", err);
    process.exitCode = 1;
    return;
  }

  const oldSearch = await client.callTool({
    name: "semantic_search",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "Old completed requirement should be compacted",
      top_k: 5,
      format: "json",
    },
  });
  console.log("\n--- semantic_search (after compaction) ---\n");
  const oldSearchText = readText(oldSearch);
  console.log(oldSearchText);
  try {
    const parsed = JSON.parse(oldSearchText);
    const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
    if (matches.some((m) => m?.item?.id === oldMemId)) {
      throw new Error("expected compacted original item to be hidden from default recall");
    }
    if (!matches.some((m) => m?.item?.kind === "memory_compaction")) {
      throw new Error("expected compacted summary to remain searchable");
    }
  } catch (err) {
    console.error("\n[smoke] compaction recall check failed:", err);
    process.exitCode = 1;
    return;
  }

  const decisionSearch = await client.callTool({
    name: "semantic_search",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "smoke-current-decision",
      top_k: 5,
      format: "json",
    },
  });
  console.log("\n--- semantic_search (decision preserved) ---\n");
  const decisionSearchText = readText(decisionSearch);
  console.log(decisionSearchText);
  try {
    const parsed = JSON.parse(decisionSearchText);
    const haystack = JSON.stringify(parsed?.matches ?? []);
    if (!haystack.includes(keepDecisionContent)) {
      throw new Error("expected old current decision to remain searchable after maintenance");
    }
  } catch (err) {
    console.error("\n[smoke] decision preservation check failed:", err);
    process.exitCode = 1;
    return;
  }

  if (!keepFiles && inPlace) {
    try {
      fs.unlinkSync(testPath);
      await new Promise((r) => setTimeout(r, 800));
      const cleanup = await client.callTool({
        name: "sync_change_intent",
        arguments: {
          ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
          intent: `smoke cleanup: removed ${path.basename(testPath)}`,
          files: [testPath],
        },
      });
      console.log("\n--- sync_change_intent (cleanup) ---\n");
      console.log(readText(cleanup));
    } catch {}
  }
  return true;
}
