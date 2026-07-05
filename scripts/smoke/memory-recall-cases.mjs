import path from "node:path";
import Database from "better-sqlite3";

export async function runMemoryRecallCases(ctx) {
  const { client, useToolProjectRoot, toolProjectRoot, testPath, token, readText } = ctx;
  const summary = await client.callTool({
    name: "upsert_project_summary",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      summary: `Smoke summary: created ${path.basename(testPath)} token=${token}`,
    },
  });
  console.log("\n--- upsert_project_summary ---\n");
  console.log(readText(summary));

  const note = await client.callTool({
    name: "add_note",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      title: "smoke-note",
      content: `Remember token: ${token}`,
      tags: ["smoke"],
    },
  });
  console.log("\n--- add_note ---\n");
  const noteText = readText(note);
  console.log(noteText);
  let noteId = 0;
  try {
    noteId = Number(JSON.parse(noteText)?.note?.id ?? 0);
    if (noteId <= 0) throw new Error("expected add_note to return note id");
  } catch (err) {
    console.error("\n[smoke] add_note id check failed:", err);
    process.exitCode = 1;
    return;
  }

  const staleDecisionToken = `VM_STALE_DECISION_${Date.now()}`;
  const staleByDecision = await client.callTool({
    name: "add_note",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      title: "stale-decision-note",
      content: `Old smoke rule should disappear from default recall: ${staleDecisionToken}`,
      tags: ["smoke", "stale"],
    },
  });
  console.log("\n--- add_note (stale decision note) ---\n");
  const staleByDecisionText = readText(staleByDecision);
  console.log(staleByDecisionText);
  let staleByDecisionId = 0;
  try {
    staleByDecisionId = Number(JSON.parse(staleByDecisionText)?.note?.id ?? 0);
    if (staleByDecisionId <= 0) throw new Error("expected stale note id");
  } catch (err) {
    console.error("\n[smoke] stale decision note id check failed:", err);
    process.exitCode = 1;
    return;
  }

  const currentDecision = await client.callTool({
    name: "upsert_decision",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      key: "smoke-current-rule",
      title: "Smoke current rule",
      content: `Current smoke rule overrides old behavior and keeps token searchable: ${staleDecisionToken}`,
      tags: ["smoke"],
      supersedes_memory_ids: [staleByDecisionId],
    },
  });
  console.log("\n--- upsert_decision (supersedes old memory) ---\n");
  const currentDecisionText = readText(currentDecision);
  console.log(currentDecisionText);
  let currentDecisionId = 0;
  try {
    const parsed = JSON.parse(currentDecisionText);
    currentDecisionId = Number(parsed?.decision?.id ?? 0);
    if (parsed?.ok !== true || currentDecisionId <= 0) {
      throw new Error("expected upsert_decision to return current decision id");
    }
    const superseded = parsed?.superseded_memory_items;
    if (!Array.isArray(superseded) || !superseded.includes(staleByDecisionId)) {
      throw new Error("expected upsert_decision to supersede stale note");
    }
  } catch (err) {
    console.error("\n[smoke] upsert_decision supersede check failed:", err);
    process.exitCode = 1;
    return;
  }

  const staleByToolToken = `VM_STALE_SUPERSEDE_${Date.now()}`;
  const staleByTool = await client.callTool({
    name: "add_note",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      title: "stale-supersede-note",
      content: `Old smoke note should be explicitly superseded: ${staleByToolToken}`,
      tags: ["smoke", "stale"],
    },
  });
  console.log("\n--- add_note (stale supersede note) ---\n");
  const staleByToolText = readText(staleByTool);
  console.log(staleByToolText);
  let staleByToolId = 0;
  try {
    staleByToolId = Number(JSON.parse(staleByToolText)?.note?.id ?? 0);
    if (staleByToolId <= 0) throw new Error("expected supersede note id");
  } catch (err) {
    console.error("\n[smoke] stale supersede note id check failed:", err);
    process.exitCode = 1;
    return;
  }

  const supersedeTool = await client.callTool({
    name: "supersede_memory",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      superseded_memory_ids: [staleByToolId],
      replacement_memory_id: currentDecisionId,
      reason: "Smoke current decision supersedes this old note",
    },
  });
  console.log("\n--- supersede_memory ---\n");
  const supersedeToolText = readText(supersedeTool);
  console.log(supersedeToolText);
  try {
    const parsed = JSON.parse(supersedeToolText);
    const superseded = parsed?.superseded_memory_items;
    if (parsed?.ok !== true || !Array.isArray(superseded) || !superseded.includes(staleByToolId)) {
      throw new Error("expected supersede_memory to supersede stale note");
    }
  } catch (err) {
    console.error("\n[smoke] supersede_memory check failed:", err);
    process.exitCode = 1;
    return;
  }

  const bulkStaleNoteIds = [];
  for (let i = 0; i < 18; i += 1) {
    const bulkNote = await client.callTool({
      name: "add_note",
      arguments: {
        ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
        title: `bulk-stale-note-${i}`,
        content: `Bulk hidden smoke note ${i} should not appear in default recall: ${Date.now()}`,
        tags: ["smoke", "stale", "bulk"],
      },
    });
    const bulkText = readText(bulkNote);
    try {
      const id = Number(JSON.parse(bulkText)?.note?.id ?? 0);
      if (id <= 0) throw new Error("expected bulk stale note id");
      bulkStaleNoteIds.push(id);
    } catch (err) {
      console.error("\n[smoke] bulk stale note id check failed:", err);
      process.exitCode = 1;
      return;
    }
  }
  const supersedeBulk = await client.callTool({
    name: "supersede_memory",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      superseded_memory_ids: bulkStaleNoteIds,
      replacement_memory_id: currentDecisionId,
      reason: "Smoke current decision supersedes bulk old notes",
    },
  });
  console.log("\n--- supersede_memory (bulk recent notes) ---\n");
  const supersedeBulkText = readText(supersedeBulk);
  console.log(supersedeBulkText);
  try {
    const parsed = JSON.parse(supersedeBulkText);
    const superseded = parsed?.superseded_memory_items;
    if (parsed?.ok !== true || !Array.isArray(superseded) || superseded.length !== bulkStaleNoteIds.length) {
      throw new Error("expected supersede_memory to supersede all bulk stale notes");
    }
  } catch (err) {
    console.error("\n[smoke] bulk supersede_memory check failed:", err);
    process.exitCode = 1;
    return;
  }

  const hiddenDb = new Database(path.join(toolProjectRoot, ".vectormind", "vectormind.db"));
  try {
    const insertHiddenNote = hiddenDb.prepare(
      `INSERT INTO memory_items
         (kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash)
       VALUES
         ('note', ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
    );
    const insertHiddenNotesTx = hiddenDb.transaction(() => {
      for (let i = 0; i < 260; i += 1) {
        insertHiddenNote.run(
          `direct-hidden-stale-note-${i}`,
          `Bulk hidden smoke note ${i} should be paged past by recent_notes: ${Date.now()}`,
          JSON.stringify({ status: "superseded", superseded: true, source: "smoke-direct" }),
          `direct-hidden-stale-note-${i}`,
        );
      }
    });
    insertHiddenNotesTx();
  } finally {
    hiddenDb.close();
  }

  const supersededRecall = await client.callTool({
    name: "semantic_search",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: staleDecisionToken,
      top_k: 8,
      format: "json",
    },
  });
  console.log("\n--- semantic_search (superseded memory hidden) ---\n");
  const supersededRecallText = readText(supersededRecall);
  console.log(supersededRecallText);
  try {
    const parsed = JSON.parse(supersededRecallText);
    const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
    if (matches.some((m) => m?.item?.id === staleByDecisionId)) {
      throw new Error("expected superseded note to be hidden from default recall");
    }
    if (!matches.some((m) => m?.item?.id === currentDecisionId)) {
      throw new Error("expected current decision to remain searchable");
    }
  } catch (err) {
    console.error("\n[smoke] superseded recall check failed:", err);
    process.exitCode = 1;
    return;
  }

  const search = await client.callTool({
    name: "semantic_search",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: token,
      top_k: 5,
      include_content: false,
    },
  });
  console.log("\n--- semantic_search (compact) ---\n");
  const searchText = readText(search);
  console.log(searchText);
  if (!searchText.includes("semantic ") || !searchText.includes("hint: use format=json")) {
    console.error("\n[smoke] expected default semantic_search output to be compact text");
    process.exitCode = 1;
    return;
  }

  const searchJson = await client.callTool({
    name: "semantic_search",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: token,
      top_k: 5,
      include_content: false,
      format: "json",
    },
  });
  console.log("\n--- semantic_search (json) ---\n");
  const searchJsonText = readText(searchJson);
  console.log(searchJsonText);
  try {
    const parsed = JSON.parse(searchJsonText);
    if (parsed?.ok !== true) throw new Error("expected ok=true from semantic_search");
    const matches = parsed?.matches;
    if (!Array.isArray(matches) || matches.length === 0) {
      throw new Error("expected semantic_search to return at least 1 match");
    }
    if (!["fts", "like", "token", "hybrid"].includes(parsed?.mode)) {
      throw new Error(`expected mode to be fts/like/token/hybrid (got ${parsed?.mode})`);
    }
    const haystack = JSON.stringify(matches);
    if (!haystack.includes(token)) {
      throw new Error("expected semantic_search matches to contain the token");
    }
  } catch (err) {
    console.error("\n[smoke] semantic_search check failed:", err);
    process.exitCode = 1;
    return;
  }

  const currentContextBoot = await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "recent context token should remain visible",
      current_context_limit: 10,
      requirements_limit: 3,
      changes_limit: 3,
      notes_limit: 3,
      top_k: 5,
      format: "json",
    },
  });
  console.log("\n--- bootstrap_context (current_context) ---\n");
  const currentContextText = readText(currentContextBoot);
  console.log(currentContextText);
  try {
    const parsed = JSON.parse(currentContextText);
    if (!Array.isArray(parsed?.current_context)) {
      throw new Error("expected current_context array");
    }
    const haystack = JSON.stringify(parsed.current_context);
    if (!haystack.includes(token)) {
      throw new Error("expected current_context to include recent synced/note context token");
    }
    const recentNotes = Array.isArray(parsed?.recent_notes) ? parsed.recent_notes : [];
    if (!recentNotes.some((n) => n?.id === noteId)) {
      throw new Error("expected recent_notes to page past hidden stale notes and include visible smoke note");
    }
    const fullPayload = JSON.stringify(parsed);
    for (const stalePhrase of [
      "Old smoke rule should disappear from default recall",
      "Old smoke note should be explicitly superseded",
      "Bulk hidden smoke note",
    ]) {
      if (fullPayload.includes(stalePhrase)) {
        throw new Error(`expected bootstrap_context to hide superseded recent note: ${stalePhrase}`);
      }
    }
  } catch (err) {
    console.error("\n[smoke] current_context check failed:", err);
    process.exitCode = 1;
    return;
  }

  const timeline = await client.callTool({
    name: "memory_timeline",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: token,
      window: 10,
      format: "json",
    },
  });
  console.log("\n--- memory_timeline ---\n");
  const timelineText = readText(timeline);
  console.log(timelineText);
  try {
    const parsed = JSON.parse(timelineText);
    if (parsed?.ok !== true || !Array.isArray(parsed?.items)) {
      throw new Error("expected memory_timeline to return items");
    }
    if (!JSON.stringify(parsed.items).includes(token)) {
      throw new Error("expected memory_timeline to include the smoke token");
    }
  } catch (err) {
    console.error("\n[smoke] memory_timeline check failed:", err);
    process.exitCode = 1;
    return;
  }

  const checkpoint = await client.callTool({
    name: "create_checkpoint",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      title: "smoke-checkpoint",
      summary: `Checkpoint token ${token}`,
      format: "json",
    },
  });
  console.log("\n--- create_checkpoint ---\n");
  const checkpointText = readText(checkpoint);
  console.log(checkpointText);
  let checkpointId = 0;
  try {
    const parsed = JSON.parse(checkpointText);
    checkpointId = Number(parsed?.checkpoint?.id ?? 0);
    if (parsed?.ok !== true || checkpointId <= 0) {
      throw new Error("expected create_checkpoint to return checkpoint id");
    }
    if (parsed?.snapshot?.note && !String(parsed.snapshot.note).includes("does not mutate")) {
      throw new Error("expected checkpoint snapshot to be advisory-only context");
    }
  } catch (err) {
    console.error("\n[smoke] create_checkpoint check failed:", err);
    process.exitCode = 1;
    return;
  }

  const checkpoints = await client.callTool({
    name: "list_checkpoints",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      limit: 5,
    },
  });
  console.log("\n--- list_checkpoints ---\n");
  const checkpointsText = readText(checkpoints);
  console.log(checkpointsText);
  if (!checkpointsText.includes("checkpoints returned=") || !checkpointsText.includes("smoke-checkpoint")) {
    console.error("\n[smoke] expected list_checkpoints compact output to include smoke-checkpoint");
    process.exitCode = 1;
    return;
  }

  const restored = await client.callTool({
    name: "restore_checkpoint_context",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      checkpoint_id: checkpointId,
      format: "json",
    },
  });
  console.log("\n--- restore_checkpoint_context ---\n");
  const restoredText = readText(restored);
  console.log(restoredText);
  try {
    const parsed = JSON.parse(restoredText);
    if (parsed?.ok !== true || parsed?.read_only !== true || parsed?.checkpoint?.id !== checkpointId) {
      throw new Error("expected restore_checkpoint_context to read checkpoint without mutation");
    }
    if (!JSON.stringify(parsed?.snapshot ?? {}).includes(token)) {
      throw new Error("expected restored checkpoint snapshot to include smoke token");
    }
  } catch (err) {
    console.error("\n[smoke] restore_checkpoint_context check failed:", err);
    process.exitCode = 1;
    return;
  }

  const completeActive = await client.callTool({
    name: "complete_requirement",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      all_active: true,
    },
  });
  console.log("\n--- complete_requirement (all active) ---\n");
  const completeActiveText = readText(completeActive);
  console.log(completeActiveText);
  try {
    const parsed = JSON.parse(completeActiveText);
    const completed = parsed?.completed;
    if (parsed?.ok !== true || !Array.isArray(completed) || completed.length < 1) {
      throw new Error("expected complete_requirement to complete active requirements");
    }
  } catch (err) {
    console.error("\n[smoke] complete_requirement check failed:", err);
    process.exitCode = 1;
    return;
  }


  return true;
}
