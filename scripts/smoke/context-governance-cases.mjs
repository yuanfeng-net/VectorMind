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

  const unrelatedDecisionToken = `VM_UNRELATED_DECISION_${Date.now()}`;
  await client.callTool({
    name: "upsert_decision",
    arguments: {
      ...rootArgs,
      key: `focused-unrelated-${Date.now()}`,
      title: "Unrelated focused decision",
      content: `A separate subsystem uses ${unrelatedDecisionToken}; it must not enter focused recall for another query.`,
    },
  });
  await client.callTool({
    name: "add_note",
    arguments: {
      ...rootArgs,
      title: "???????? corrupted recall smoke",
      content: `???????????????? ${token}`,
      tags: ["smoke", "context-governance", "corrupted"],
    },
  });
  await client.callTool({
    name: "upsert_decision",
    arguments: {
      ...rootArgs,
      key: `corrupted-decision-${Date.now()}`,
      title: "???????? corrupted decision",
      content: "????????????????????????",
    },
  });

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
    if (!["off", "warming", "ready"].includes(parsed?.index_state?.watcher) ||
        !["matches", "no_matches", "timeout_or_unavailable"].includes(parsed?.index_state?.semantic_search)) {
      throw new Error(`expected explicit bootstrap index_state, got ${JSON.stringify(parsed?.index_state)}`);
    }
    if (parsed?.operation_preflight?.detected !== false ||
        parsed?.operation_preflight?.bootstrap_is_not_operation_preflight !== true) {
      throw new Error("expected non-operation focused bootstrap to expose an inactive operation-preflight signal");
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
    if (JSON.stringify(parsed.decisions).includes(unrelatedDecisionToken) ||
        JSON.stringify(parsed.current_constraints).includes(unrelatedDecisionToken)) {
      throw new Error("expected focused bootstrap to filter unrelated decisions and constraints");
    }
    const semanticText = JSON.stringify(parsed?.semantic ?? {});
    if (!semanticText.includes(token) ||
        semanticText.includes("Typography palette history") ||
        semanticText.includes("????????")) {
      throw new Error("expected focused semantic recall to contain only query-relevant context");
    }
  } catch (err) {
    console.error("\n[smoke] focused context governance check failed:", err);
    process.exitCode = 1;
    return false;
  }

  const lowCoverageToken = `LOWCOVERAGESENTINEL${Date.now()}`;
  const highCoverageToken = `HIGHCOVERAGESENTINEL${Date.now()}`;
  await client.callTool({
    name: "upsert_decision",
    arguments: {
      ...rootArgs,
      key: `low-coverage-${Date.now()}`,
      title: "控制台组织权限",
      content: `控制台组织权限沿用现有团队层级。${lowCoverageToken}`,
    },
  });
  await client.callTool({
    name: "upsert_decision",
    arguments: {
      ...rootArgs,
      key: `high-coverage-${Date.now()}`,
      title: "星图目录资源坐标",
      content: `星图目录保存节点代号和资源坐标。${highCoverageToken}`,
    },
  });
  const focusedDomain = await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...rootArgs,
      query: "控制台星图目录页面保存节点代号和资源坐标",
      top_k: 5,
      format: "json",
    },
  });
  const focusedDomainText = readText(focusedDomain);
  if (!focusedDomainText.includes(highCoverageToken) || focusedDomainText.includes(lowCoverageToken)) {
    throw new Error("expected focused recall to keep high-coverage evidence and reject a low-coverage shared phrase");
  }

  const technicalAnchorToken = `TECHNICALANCHOR${Date.now()}`;
  await client.callTool({
    name: "upsert_decision",
    arguments: {
      ...rootArgs,
      key: `technical-anchor-${Date.now()}`,
      title: "Structured failure marker",
      content: `Investigate structured marker ERR_9F2A before changing behavior. ${technicalAnchorToken}`,
    },
  });
  const technicalAnchorBootstrap = readText(await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...rootArgs,
      query: "trace the unrelated runtime path for ERR_9F2A",
      top_k: 5,
      format: "json",
    },
  }));
  if (!technicalAnchorBootstrap.includes(technicalAnchorToken)) {
    throw new Error("expected a structured technical identifier to remain a strong focused-recall anchor");
  }

  const operationBootstrap = await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...rootArgs,
      query: "deploy the current build with docker compose and then git push",
      top_k: 3,
      format: "json",
    },
  });
  const operationBootstrapParsed = JSON.parse(readText(operationBootstrap));
  if (operationBootstrapParsed?.operation_preflight?.required_before_commands !== true ||
      operationBootstrapParsed?.operation_preflight?.tool !== "preflight_operation_scope" ||
      operationBootstrapParsed?.operation_preflight?.bootstrap_is_not_operation_preflight !== true) {
    throw new Error("expected operation bootstrap to require preflight_operation_scope before commands");
  }
  const operationBootstrapCompact = readText(await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...rootArgs,
      query: "deploy the current build with docker compose and then git push",
      top_k: 3,
    },
  }));
  if (!operationBootstrapCompact.includes("operation preflight required") ||
      !operationBootstrapCompact.includes("bootstrap_context does not satisfy this step")) {
    throw new Error("expected compact bootstrap to state that context recall does not satisfy operation preflight");
  }

  const directSemantic = await client.callTool({
    name: "semantic_search",
    arguments: { ...rootArgs, query: token, top_k: 10, format: "json" },
  });
  if (JSON.stringify(JSON.parse(readText(directSemantic))?.matches ?? []).includes("????????")) {
    throw new Error("expected default semantic_search to filter obviously corrupted memory text");
  }
  const operationWithCorruptMemory = await client.callTool({
    name: "preflight_operation_scope",
    arguments: { ...rootArgs, operation: "context corruption smoke", intent: token, format: "json" },
  });
  if (JSON.stringify(JSON.parse(readText(operationWithCorruptMemory))?.current_constraints ?? []).includes("????????")) {
    throw new Error("expected operation constraints to filter obviously corrupted memory text");
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

  const rootAnchor = `transport_${Date.now()}`;
  const rootFirst = await client.callTool({
    name: "start_requirement",
    arguments: {
      ...rootArgs,
      title: `Implement ${rootAnchor} request lifecycle`,
      background: `Build the initial ${rootAnchor} request path and preserve its acceptance criteria.`,
    },
  });
  const rootSecond = await client.callTool({
    name: "start_requirement",
    arguments: {
      ...rootArgs,
      title: `Debug ${rootAnchor} timeout retries`,
      background: `Continue the same ${rootAnchor} goal after observing a timeout in the real entry path.`,
    },
  });
  try {
    const firstParsed = JSON.parse(readText(rootFirst));
    const secondParsed = JSON.parse(readText(rootSecond));
    if (firstParsed?.requirement?.id === secondParsed?.requirement?.id || secondParsed?.reused === true) {
      throw new Error("expected a shared technical word to remain a separate requirement without an explicit goal_key");
    }
  } catch (err) {
    console.error("\n[smoke] requirement isolation check failed:", err);
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

  const stalePrevious = await client.callTool({
    name: "start_requirement",
    arguments: {
      ...rootArgs,
      title: "Stale previous requirement guard",
      background: "A superseded requirement must never be changed to completed by previous_req_id.",
      goal_key: `stale-previous-${sharedGoalKey}`,
      close_previous: false,
    },
  });
  const stalePreviousId = JSON.parse(readText(stalePrevious))?.requirement?.id;
  await client.callTool({
    name: "supersede_memory",
    arguments: {
      ...rootArgs,
      superseded_req_ids: [stalePreviousId],
      reason: "Smoke-test stale previous_req_id lifecycle protection.",
    },
  });
  const staleCloseAttempt = JSON.parse(readText(await client.callTool({
    name: "start_requirement",
    arguments: {
      ...rootArgs,
      title: "Must not close a superseded requirement",
      background: "Reject the stale previous requirement instead of overwriting its lifecycle state.",
      goal_key: `stale-close-attempt-${sharedGoalKey}`,
      previous_req_id: stalePreviousId,
    },
  })));
  const staleStatus = JSON.parse(readText(await client.callTool({
    name: "get_requirement_status",
    arguments: { ...rootArgs, req_id: stalePreviousId },
  })));
  if (staleCloseAttempt?.ok !== false || !String(staleCloseAttempt?.error ?? "").includes("not active") ||
      staleStatus?.requirement?.status !== "superseded") {
    throw new Error(`expected stale previous_req_id to remain superseded: ${JSON.stringify({ staleCloseAttempt, staleStatus })}`);
  }

  const lifecycleFile = path.join(toolProjectRoot, "goal-lifecycle-smoke.txt");
  fs.writeFileSync(lifecycleFile, `${sharedGoalKey}\n`, "utf8");
  const lifecyclePreflightArgs = {
    ...rootArgs,
    req_id: JSON.parse(readText(keyedFirst))?.requirement?.id,
    intent: "Verify goal-key lifecycle synchronization and atomic completion.",
    files: ["goal-lifecycle-smoke.txt"],
    format: "json",
  };
  const lifecyclePreflightFirst = await client.callTool({
    name: "preflight_change_scope",
    arguments: lifecyclePreflightArgs,
  });
  const lifecyclePreflightSecond = await client.callTool({
    name: "preflight_change_scope",
    arguments: lifecyclePreflightArgs,
  });
  const lifecyclePreflightFirstParsed = JSON.parse(readText(lifecyclePreflightFirst));
  const lifecyclePreflightSecondParsed = JSON.parse(readText(lifecyclePreflightSecond));
  if (lifecyclePreflightFirstParsed?.reused !== false ||
      lifecyclePreflightSecondParsed?.reused !== true ||
      lifecyclePreflightFirstParsed?.idempotency_key !== lifecyclePreflightSecondParsed?.idempotency_key) {
    throw new Error("expected repeated identical preflight_change_scope calls to reuse the cached result");
  }

  const lifecycleSyncArgs = {
    ...rootArgs,
    req_id: JSON.parse(readText(keyedFirst))?.requirement?.id,
    idempotency_key: `lifecycle-sync-${sharedGoalKey}`,
    intent: "Verify goal-key lifecycle synchronization and atomic completion.",
    files: ["goal-lifecycle-smoke.txt"],
    complete_requirement: true,
  };
  const lifecycleSync = await client.callTool({
    name: "sync_change_intent",
    arguments: lifecycleSyncArgs,
  });
  const lifecycleSyncDuplicate = await client.callTool({
    name: "sync_change_intent",
    arguments: lifecycleSyncArgs,
  });
  const lifecycleSyncParsed = JSON.parse(readText(lifecycleSync));
  const lifecycleSyncDuplicateParsed = JSON.parse(readText(lifecycleSyncDuplicate));
  if (lifecycleSyncParsed?.reused !== false ||
      lifecycleSyncDuplicateParsed?.reused !== true ||
      lifecycleSyncParsed?.created_change?.change_log_id !== lifecycleSyncDuplicateParsed?.created_change?.change_log_id ||
      lifecycleSyncParsed?.idempotency_key !== lifecycleSyncDuplicateParsed?.idempotency_key) {
    throw new Error(`expected repeated identical sync_change_intent calls to reuse one persisted change intent: ${JSON.stringify({ lifecycleSyncParsed, lifecycleSyncDuplicateParsed })}`);
  }
  if (lifecycleSyncDuplicateParsed?.requirement_completed !== true) {
    throw new Error("expected the same explicit idempotency key to replay successfully after requirement completion");
  }
  const lifecycleSyncConflict = JSON.parse(readText(await client.callTool({
    name: "sync_change_intent",
    arguments: { ...lifecycleSyncArgs, intent: `${lifecycleSyncArgs.intent} changed` },
  })));
  if (lifecycleSyncConflict?.ok !== false || !String(lifecycleSyncConflict?.error ?? "").includes("idempotency_key conflict")) {
    throw new Error("expected reuse of an idempotency key with different arguments to fail with a conflict");
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
  const concurrentAStatus = JSON.parse(readText(await client.callTool({
    name: "get_requirement_status",
    arguments: { ...rootArgs, req_id: concurrentAId },
  })));
  const concurrentBStatus = JSON.parse(readText(await client.callTool({
    name: "get_requirement_status",
    arguments: { ...rootArgs, req_id: concurrentBId },
  })));
  if (concurrentAStatus?.requirement?.status !== "active" || concurrentBStatus?.requirement?.status !== "active") {
    throw new Error(`expected both explicitly parallel requirements to remain active: ${JSON.stringify({ concurrentAStatus, concurrentBStatus })}`);
  }
  const focusedConcurrent = JSON.parse(readText(await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...rootArgs,
      query: `concurrent-a-${sharedGoalKey}`,
      context_mode: "focused",
      include_recent: false,
      format: "json",
    },
  })));
  if (focusedConcurrent?.items?.[0]?.requirement?.id !== concurrentAId) {
    throw new Error(`expected focused bootstrap to select an older relevant active requirement before truncation: ${JSON.stringify(focusedConcurrent?.items)}`);
  }
  const ambiguousPreflight = await client.callTool({
    name: "preflight_change_scope",
    arguments: { ...rootArgs, intent: "This must not bind implicitly.", files: ["concurrent-a-smoke.txt"], format: "json" },
  });
  const ambiguousPreflightParsed = JSON.parse(readText(ambiguousPreflight));
  if (ambiguousPreflightParsed?.safe_to_edit !== false ||
      ambiguousPreflightParsed?.requirement_resolution?.ambiguous !== true ||
      ambiguousPreflightParsed?.active_requirement !== null) {
    throw new Error("expected implicit preflight selection to fail when multiple requirements are active");
  }
  const ambiguousSync = await client.callTool({
    name: "sync_change_intent",
    arguments: { ...rootArgs, intent: "This must not bind implicitly.", files: ["concurrent-a-smoke.txt"] },
  });
  const ambiguousSyncParsed = JSON.parse(readText(ambiguousSync));
  if (ambiguousSyncParsed?.ok !== false || !String(ambiguousSyncParsed?.error ?? "").includes("Multiple active requirements")) {
    throw new Error("expected implicit sync selection to fail when multiple requirements are active");
  }
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
    const lifecycleIntentCount = db.prepare(
      `SELECT COUNT(*) AS count
         FROM memory_items
        WHERE kind = 'change_intent'
          AND req_id = ?
          AND json_extract(metadata_json, '$.idempotency_key') = ?`,
    ).get(lifecycleSyncParsed?.linked_to_requirement?.id, lifecycleSyncParsed?.idempotency_key);
    if (Number(lifecycleIntentCount?.count ?? 0) !== 1) {
      throw new Error("expected idempotent sync to persist exactly one change_intent row");
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
