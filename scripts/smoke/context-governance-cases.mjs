import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export async function runContextGovernanceCases(ctx) {
  const { client, useToolProjectRoot, toolProjectRoot, readText } = ctx;
  const rootArgs = useToolProjectRoot ? { project_root: toolProjectRoot } : {};
  const token = `VM_FOCUSED_CONTEXT_${Date.now()}`;

  const relevantNote = await client.callTool({
    name: "add_note",
    arguments: {
      ...rootArgs,
      title: "focused-context-relevant",
      content: `Only this note should be recalled for ${token}.`,
      tags: ["smoke", "context-governance"],
    },
  });
  console.log("\n--- add_note (focused context relevant) ---\n");
  console.log(readText(relevantNote));

  const unrelatedNote = await client.callTool({
    name: "add_note",
    arguments: {
      ...rootArgs,
      title: "focused-context-unrelated",
      content: "Typography palette history must not leak into an unrelated focused bootstrap.",
      tags: ["smoke", "context-governance"],
    },
  });
  console.log("\n--- add_note (focused context unrelated) ---\n");
  console.log(readText(unrelatedNote));

  const focused = await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...rootArgs,
      query: token,
      top_k: 3,
      format: "json",
    },
  });
  console.log("\n--- bootstrap_context (focused governance) ---\n");
  const focusedText = readText(focused);
  console.log(focusedText);
  try {
    const parsed = JSON.parse(focusedText);
    if (parsed?.context_policy?.mode !== "focused") {
      throw new Error("expected default context_policy.mode=focused");
    }
    if (parsed?.pending_included !== false || parsed?.context_policy?.include_recent !== false) {
      throw new Error("expected focused bootstrap to omit broad pending and recent-history sections");
    }
    if (!Array.isArray(parsed?.items)) {
      throw new Error("expected focused bootstrap items to be an array");
    }
    if (parsed?.context_policy?.current_anchor_included !== (parsed.items.length > 0)) {
      throw new Error("expected current_anchor_included to reflect whether an active requirement exists");
    }
    if (parsed.items.some((item) => item?.requirement?.status !== "active")) {
      throw new Error("expected focused bootstrap to anchor only active requirements, never a recent completed requirement");
    }
    for (const field of ["recent_notes", "conventions", "current_context", "pending_changes"]) {
      if (!Array.isArray(parsed?.[field]) || parsed[field].length !== 0) {
        throw new Error(`expected focused bootstrap field ${field} to be empty`);
      }
    }
    if (!Array.isArray(parsed?.decisions) || !Array.isArray(parsed?.current_constraints)) {
      throw new Error("expected focused bootstrap to include bounded decisions and current constraints arrays");
    }
    const semanticText = JSON.stringify(parsed?.semantic ?? {});
    if (!semanticText.includes(token) || semanticText.includes("Typography palette history")) {
      throw new Error("expected focused semantic recall to contain only query-relevant context");
    }
  } catch (err) {
    console.error("\n[smoke] focused context governance check failed:", err);
    process.exitCode = 1;
    return false;
  }

  const bounded = await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...rootArgs,
      query: token,
      context_mode: "full",
      requirements_limit: 10,
      changes_limit: 10,
      notes_limit: 20,
      decisions_limit: 20,
      current_context_limit: 20,
      include_pending: true,
      max_output_chars: 500,
    },
  });
  console.log("\n--- bootstrap_context (bounded compact output) ---\n");
  const boundedText = readText(bounded);
  console.log(boundedText);
  if (boundedText.length > 500 || !boundedText.includes("context budget: truncated")) {
    console.error(`\n[smoke] expected compact bootstrap <=500 chars with truncation marker, got ${boundedText.length}`);
    process.exitCode = 1;
    return false;
  }

  const title = `Context governance idempotency ${Date.now()}`;
  const background = "Repeated start_requirement calls for the same requirement must reuse the active record.";
  const first = await client.callTool({
    name: "start_requirement",
    arguments: { ...rootArgs, title, background },
  });
  const second = await client.callTool({
    name: "start_requirement",
    arguments: { ...rootArgs, title, background },
  });
  console.log("\n--- start_requirement (idempotent duplicate) ---\n");
  console.log(readText(second));
  try {
    const firstParsed = JSON.parse(readText(first));
    const secondParsed = JSON.parse(readText(second));
    if (
      firstParsed?.requirement?.id !== secondParsed?.requirement?.id ||
      secondParsed?.reused !== true ||
      secondParsed?.closed_previous !== false
    ) {
      throw new Error(`expected exact duplicate start_requirement to reuse the active requirement: first=${JSON.stringify(firstParsed)} second=${JSON.stringify(secondParsed)}`);
    }
  } catch (err) {
    console.error("\n[smoke] start_requirement idempotency check failed:", err);
    process.exitCode = 1;
    return false;
  }

  const sharedGoalKey = `smoke-goal-${Date.now()}`;
  const keyedFirst = await client.callTool({
    name: "start_requirement",
    arguments: { ...rootArgs, title: "Implement keyed lifecycle", background: "Initial wording.", goal_key: sharedGoalKey },
  });
  const keyedSecond = await client.callTool({
    name: "start_requirement",
    arguments: { ...rootArgs, title: "Continue the same lifecycle goal", background: "Updated wording.", goal_key: sharedGoalKey },
  });
  try {
    const firstParsed = JSON.parse(readText(keyedFirst));
    const secondParsed = JSON.parse(readText(keyedSecond));
    if (firstParsed?.requirement?.id !== secondParsed?.requirement?.id || secondParsed?.reused !== true) {
      throw new Error("expected explicit goal_key to reuse the active requirement across wording changes");
    }
  } catch (err) {
    console.error("\n[smoke] goal_key lifecycle reuse check failed:", err);
    process.exitCode = 1;
    return false;
  }

  const lifecycleFile = path.join(toolProjectRoot, "goal-lifecycle-smoke.txt");
  fs.writeFileSync(lifecycleFile, `${sharedGoalKey}\n`, "utf8");
  const lifecycleSync = await client.callTool({
    name: "sync_change_intent",
    arguments: {
      ...rootArgs,
      intent: "Verify goal-key lifecycle synchronization and atomic completion.",
      files: ["goal-lifecycle-smoke.txt"],
      complete_requirement: true,
    },
  });
  const lifecycleSyncParsed = JSON.parse(readText(lifecycleSync));
  if (lifecycleSyncParsed?.requirement_completed !== true) {
    throw new Error("expected sync_change_intent complete_requirement=true to close the active requirement");
  }
  const postRequirement = await client.callTool({
    name: "start_requirement",
    arguments: {
      ...rootArgs,
      title: "Post lifecycle smoke active requirement",
      background: "Keep an active requirement for downstream completion and recall smoke cases.",
      goal_key: `post-${sharedGoalKey}`,
    },
  });
  const postRequirementId = JSON.parse(readText(postRequirement))?.requirement?.id;

  const concurrentA = await client.callTool({
    name: "start_requirement",
    arguments: {
      ...rootArgs,
      title: "Concurrent requirement A",
      background: "Verify explicit requirement selection.",
      goal_key: `concurrent-a-${sharedGoalKey}`,
      close_previous: false,
    },
  });
  const concurrentAId = JSON.parse(readText(concurrentA))?.requirement?.id;
  const concurrentB = await client.callTool({
    name: "start_requirement",
    arguments: {
      ...rootArgs,
      title: "Concurrent requirement B",
      background: "Remain active while requirement A is synchronized.",
      goal_key: `concurrent-b-${sharedGoalKey}`,
      close_previous: false,
    },
  });
  const concurrentBId = JSON.parse(readText(concurrentB))?.requirement?.id;
  const concurrentFile = path.join(toolProjectRoot, "concurrent-a-smoke.txt");
  fs.writeFileSync(concurrentFile, "A\n", "utf8");
  const concurrentPreflight = await client.callTool({
    name: "preflight_change_scope",
    arguments: { ...rootArgs, req_id: concurrentAId, intent: "Update requirement A only.", files: ["concurrent-a-smoke.txt"], format: "json" },
  });
  if (JSON.parse(readText(concurrentPreflight))?.active_requirement?.id !== concurrentAId) {
    throw new Error("expected explicit req_id preflight to select requirement A while requirement B is current");
  }
  const concurrentSync = await client.callTool({
    name: "sync_change_intent",
    arguments: {
      ...rootArgs,
      req_id: concurrentAId,
      intent: "Synchronize requirement A without touching requirement B.",
      files: ["concurrent-a-smoke.txt"],
      complete_requirement: true,
    },
  });
  if (JSON.parse(readText(concurrentSync))?.linked_to_requirement?.id !== concurrentAId) {
    throw new Error("expected explicit req_id sync to remain linked to requirement A");
  }

  const concurrentHugePath = path.join(toolProjectRoot, "src", "concurrent-controller.ts");
  fs.mkdirSync(path.dirname(concurrentHugePath), { recursive: true });
  fs.writeFileSync(
    concurrentHugePath,
    Array.from({ length: 25 }, (_, domain) => [
      `export class Context${domain}Controller {`,
      ...Array.from({ length: 120 }, (_, method) => `  method${method}() { return ${domain + method}; }`),
      "}",
    ].join("\n")).join("\n") + "\n",
    "utf8",
  );
  const concurrentSplitPlan = await client.callTool({
    name: "plan_large_file_split",
    arguments: {
      ...rootArgs,
      req_id: concurrentBId,
      file: "src/concurrent-controller.ts",
      intent: "Verify concurrent split plans bind to requirement B.",
      max_modules: 30,
      format: "json",
    },
  });
  const concurrentSplitPlanId = Number(JSON.parse(readText(concurrentSplitPlan))?.plan_id ?? 0);
  if (concurrentSplitPlanId <= 0) throw new Error("expected a persisted concurrent split plan");
  const concurrentSplitRecord = await client.callTool({
    name: "record_large_file_split",
    arguments: {
      ...rootArgs,
      req_id: concurrentBId,
      plan_id: concurrentSplitPlanId,
      file: "src/concurrent-controller.ts",
      status: "in_progress",
      summary: "Verify concurrent split records bind to the explicitly selected requirement.",
    },
  });
  const concurrentSplitParsed = JSON.parse(readText(concurrentSplitRecord));
  if (concurrentSplitParsed?.linked_to_requirement?.id !== concurrentBId) {
    throw new Error("expected record_large_file_split req_id to select requirement B while other requirements remain active");
  }

  const nested = path.join(toolProjectRoot, "repos", "nested-app");
  fs.mkdirSync(path.join(toolProjectRoot, ".vectormind"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "package.json"), "{}\n", "utf8");
  const nestedBootstrap = await client.callTool({
    name: "bootstrap_context",
    arguments: { project_root: nested, query: token, format: "json" },
  });
  const nestedParsed = JSON.parse(readText(nestedBootstrap));
  if (path.resolve(nestedParsed?.project_root ?? "") !== path.resolve(toolProjectRoot) || nestedParsed?.project_context_advisory) {
    throw new Error("expected nested repository paths to canonicalize to the existing VectorMind root");
  }
  const nestedExact = await client.callTool({
    name: "bootstrap_context",
    arguments: { project_root: nested, project_root_mode: "exact", query: token, format: "json" },
  });
  const nestedExactParsed = JSON.parse(readText(nestedExact));
  if (path.resolve(nestedExactParsed?.project_root ?? "") !== path.resolve(nested)) {
    throw new Error("expected project_root_mode=exact to isolate an independent nested repository");
  }
  await client.callTool({
    name: "bootstrap_context",
    arguments: { project_root: toolProjectRoot, project_root_mode: "exact", query: token, format: "json" },
  });

  const db = new Database(path.join(toolProjectRoot, ".vectormind", "vectormind.db"), { readonly: true });
  try {
    const lifecycle = db.prepare("SELECT status, goal_key FROM requirements WHERE id = ?").get(lifecycleSyncParsed?.linked_to_requirement?.id);
    if (lifecycle?.status !== "completed" || lifecycle?.goal_key !== sharedGoalKey) {
      throw new Error("expected completed goal-key requirement to persist its lifecycle state");
    }
    const concurrentRows = db.prepare("SELECT id, status FROM requirements WHERE id IN (?, ?, ?) ORDER BY id").all(
      postRequirementId,
      concurrentAId,
      concurrentBId,
    );
    const byId = new Map(concurrentRows.map((row) => [row.id, row.status]));
    if (byId.get(concurrentAId) !== "completed" || byId.get(concurrentBId) !== "active") {
      throw new Error("expected requirement A to complete without closing concurrent requirement B");
    }
    const splitMemory = db.prepare("SELECT req_id FROM memory_items WHERE id = ?").get(concurrentSplitParsed?.plan?.id);
    if (splitMemory?.req_id !== concurrentBId) {
      throw new Error("expected large-file split memory to persist the explicitly selected requirement id");
    }
    const metrics = db.prepare("SELECT COUNT(*) AS count, MAX(output_chars) AS max_output_chars FROM mcp_tool_metrics").get();
    if (Number(metrics?.count ?? 0) < 1 || Number(metrics?.max_output_chars ?? 0) < 1) {
      throw new Error("expected MCP tool performance metrics to be persisted");
    }
  } finally {
    db.close();
  }

  return true;
}
