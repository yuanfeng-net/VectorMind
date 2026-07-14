import fs from "node:fs";
import path from "node:path";

export async function runQualityGuardCases(ctx) {
  const { client, useToolProjectRoot, toolProjectRoot, readText } = ctx;
  const expectToolError = async (request, expectedMessage) => {
    let result;
    try {
      result = await client.callTool(request);
    } catch (err) {
      throw new Error(`unexpected MCP transport/server failure while expecting a business rejection: ${String(err)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(readText(result));
    } catch (err) {
      throw new Error(`expected structured JSON business rejection: ${String(err)}`);
    }
    if (result?.isError !== true && parsed?.ok !== false) {
      throw new Error(`expected tool rejection, got: ${readText(result)}`);
    }
    if (!String(parsed?.error ?? "").includes(expectedMessage)) {
      throw new Error(`expected error containing ${JSON.stringify(expectedMessage)}, got: ${readText(result)}`);
    }
    return parsed;
  };
  const pairedFlowPath = path.join(toolProjectRoot, "src", "paired-flow", "entry.ts");
  fs.mkdirSync(path.dirname(pairedFlowPath), { recursive: true });
  fs.writeFileSync(
    pairedFlowPath,
    [
      "export function pairedFlowEntrySmoke() {",
      "  return 'entry-validation-commit';",
      "}",
      "",
    ].join("\n"),
  );
  await new Promise((r) => setTimeout(r, 1000));

  const syncFixPattern = await client.callTool({
    name: "sync_change_intent",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: align paired workflow entry, validation, and commit paths",
      files: ["src/paired-flow/entry.ts"],
      verification: ["smoke build path reviewed"],
      verification_gaps: ["manual end-to-end exercise not performed in smoke"],
      fix_pattern: {
        symptom: "A visible workflow succeeds in one path but fails in another related path.",
        root_cause: "Related entry, validation, and commit paths used inconsistent assumptions.",
        invariant: "Keep paired workflow entry, validation, and commit paths aligned for the same visible flow.",
        applies_when: [
          "Changing any entry, validation, commit, display, or save path in a paired workflow.",
        ],
        avoid_regression: [
          "Only update one path while leaving related workflow paths on the old assumption.",
          "Validate display behavior but skip the commit or save path.",
        ],
      },
    },
  });
  console.log("\n--- sync_change_intent (fix pattern) ---\n");
  const syncFixPatternText = readText(syncFixPattern);
  console.log(syncFixPatternText);
  let fixPatternMemoryId = 0;
  try {
    const parsed = JSON.parse(syncFixPatternText);
    fixPatternMemoryId = Number(parsed?.created_fix_pattern?.id ?? 0);
    if (parsed?.ok !== true || fixPatternMemoryId <= 0) {
      throw new Error("expected sync_change_intent to create a fix_pattern memory");
    }
  } catch (err) {
    console.error("\n[smoke] fix_pattern sync check failed:", err);
    process.exitCode = 1;
    return;
  }

  const readFixPattern = await client.callTool({
    name: "read_memory_item",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      id: fixPatternMemoryId,
    },
  });
  console.log("\n--- read_memory_item (fix pattern) ---\n");
  const readFixPatternText = readText(readFixPattern);
  console.log(readFixPatternText);
  try {
    const parsed = JSON.parse(readFixPatternText);
    const meta = JSON.parse(parsed?.item?.metadata_json ?? "{}");
    if (
      parsed?.item?.kind !== "fix_pattern" ||
      meta?.advisory_only !== true ||
      meta?.does_not_control_host_runtime !== true ||
      meta?.does_not_replace_model_judgment !== true ||
      meta?.does_not_change_ok_or_safe_to_edit !== true ||
      !meta?.fix_pattern?.invariant
    ) {
      throw new Error("expected stored fix_pattern advisory metadata");
    }
  } catch (err) {
    console.error("\n[smoke] fix_pattern memory read check failed:", err);
    process.exitCode = 1;
    return;
  }

  const bootFixPattern = await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "paired workflow validation and commit paths",
      format: "json",
    },
  });
  console.log("\n--- bootstrap_context (fix pattern recall) ---\n");
  const bootFixPatternText = readText(bootFixPattern);
  console.log(bootFixPatternText);
  try {
    const parsed = JSON.parse(bootFixPatternText);
    const patterns = parsed?.quality_signals?.relevant_fix_patterns ?? [];
    if (!parsed?.quality_signals?.advisory_only || !Array.isArray(patterns) || !patterns.some((p) => p?.memory_id === fixPatternMemoryId)) {
      throw new Error("expected bootstrap_context to recall relevant advisory fix_pattern");
    }
  } catch (err) {
    console.error("\n[smoke] bootstrap fix_pattern recall check failed:", err);
    process.exitCode = 1;
    return;
  }

  const semanticFixPatternDefault = await client.callTool({
    name: "semantic_search",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "paired workflow validation and commit paths",
      top_k: 10,
      format: "json",
    },
  });
  console.log("\n--- semantic_search (fix pattern default hidden) ---\n");
  const semanticFixPatternDefaultText = readText(semanticFixPatternDefault);
  console.log(semanticFixPatternDefaultText);
  try {
    const parsed = JSON.parse(semanticFixPatternDefaultText);
    const matches = parsed?.matches ?? [];
    if (Array.isArray(matches) && matches.some((m) => m?.item?.id === fixPatternMemoryId)) {
      throw new Error("expected default semantic_search not to recall fix_pattern");
    }
  } catch (err) {
    console.error("\n[smoke] default semantic_search fix_pattern hiding check failed:", err);
    process.exitCode = 1;
    return;
  }

  const semanticFixPatternExplicit = await client.callTool({
    name: "semantic_search",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "paired workflow validation and commit paths",
      kinds: ["fix_pattern"],
      top_k: 10,
      format: "json",
    },
  });
  console.log("\n--- semantic_search (fix pattern explicit) ---\n");
  const semanticFixPatternExplicitText = readText(semanticFixPatternExplicit);
  console.log(semanticFixPatternExplicitText);
  try {
    const parsed = JSON.parse(semanticFixPatternExplicitText);
    const matches = parsed?.matches ?? [];
    if (!Array.isArray(matches) || !matches.some((m) => m?.item?.id === fixPatternMemoryId)) {
      throw new Error("expected explicit semantic_search kinds=['fix_pattern'] to recall fix_pattern");
    }
  } catch (err) {
    console.error("\n[smoke] explicit semantic_search fix_pattern recall check failed:", err);
    process.exitCode = 1;
    return;
  }

  const preflightFixPattern = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: update paired workflow validation and commit paths",
      files: ["src/paired-flow/entry.ts"],
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (fix pattern recall) ---\n");
  const preflightFixPatternText = readText(preflightFixPattern);
  console.log(preflightFixPatternText);
  try {
    const parsed = JSON.parse(preflightFixPatternText);
    const patterns = parsed?.quality_signals?.relevant_fix_patterns ?? [];
    if (!Array.isArray(patterns) || !patterns.some((p) => p?.memory_id === fixPatternMemoryId)) {
      throw new Error("expected preflight_change_scope to recall relevant advisory fix_pattern");
    }
    if (parsed?.quality_signals?.does_not_change_ok_or_safe_to_edit !== true) {
      throw new Error("expected fix_pattern quality signal not to change ok/safe_to_edit");
    }
    if (parsed?.safe_to_edit !== true || parsed?.ok !== true) {
      throw new Error("expected advisory fix_pattern and scope warnings not to block editing");
    }
  } catch (err) {
    console.error("\n[smoke] preflight fix_pattern recall check failed:", err);
    process.exitCode = 1;
    return;
  }

  const preflightFixPatternUnrelated = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: refresh typography token naming",
      files: ["src/theme/tokens.ts"],
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (fix pattern unrelated) ---\n");
  const preflightFixPatternUnrelatedText = readText(preflightFixPatternUnrelated);
  console.log(preflightFixPatternUnrelatedText);
  try {
    const parsed = JSON.parse(preflightFixPatternUnrelatedText);
    const patterns = parsed?.quality_signals?.relevant_fix_patterns ?? [];
    if (Array.isArray(patterns) && patterns.length > 0) {
      throw new Error("expected unrelated preflight not to recall fix_pattern");
    }
  } catch (err) {
    console.error("\n[smoke] unrelated fix_pattern recall check failed:", err);
    process.exitCode = 1;
    return;
  }

  const supersedeFixPattern = await client.callTool({
    name: "supersede_memory",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      superseded_memory_ids: [fixPatternMemoryId],
      reason: "smoke: retire advisory fix pattern to verify hidden recall",
    },
  });
  console.log("\n--- supersede_memory (fix pattern) ---\n");
  console.log(readText(supersedeFixPattern));

  const preflightFixPatternSuperseded = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: update paired workflow validation and commit paths",
      files: ["src/paired-flow/entry.ts"],
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (fix pattern superseded) ---\n");
  const preflightFixPatternSupersededText = readText(preflightFixPatternSuperseded);
  console.log(preflightFixPatternSupersededText);
  try {
    const parsed = JSON.parse(preflightFixPatternSupersededText);
    const patterns = parsed?.quality_signals?.relevant_fix_patterns ?? [];
    if (Array.isArray(patterns) && patterns.some((p) => p?.memory_id === fixPatternMemoryId)) {
      throw new Error("expected superseded fix_pattern not to be recalled");
    }
  } catch (err) {
    console.error("\n[smoke] superseded fix_pattern recall check failed:", err);
    process.exitCode = 1;
    return;
  }

  const pending2 = await client.callTool({
    name: "get_pending_changes",
    arguments: useToolProjectRoot ? { project_root: toolProjectRoot } : {},
  });
  console.log("\n--- get_pending_changes (after) ---\n");
  console.log(readText(pending2));

  const bigFilePath = path.join(toolProjectRoot, "src", "god_file.ts");
  fs.mkdirSync(path.dirname(bigFilePath), { recursive: true });
  fs.writeFileSync(
    bigFilePath,
    Array.from({ length: 1250 }, (_, i) => `export const smokeValue${i} = ${i};`).join("\n") + "\n",
  );
  await new Promise((r) => setTimeout(r, 1000));

  const preflightBig = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: verify large-file pre-edit guard",
      files: ["src/god_file.ts"],
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (large-file development warnings) ---\n");
  const preflightBigText = readText(preflightBig);
  console.log(preflightBigText);
  try {
    const parsed = JSON.parse(preflightBigText);
    const warnings = parsed?.development_warnings;
    if (parsed?.safe_to_edit !== true || parsed?.ok !== true) {
      throw new Error("expected very_large_file to remain advisory");
    }
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "very_large_file")) {
      throw new Error("expected preflight_change_scope to include very_large_file development warning");
    }
  } catch (err) {
    console.error("\n[smoke] preflight large-file development warning check failed:", err);
    process.exitCode = 1;
    return;
  }

  const pendingBig = await client.callTool({
    name: "get_pending_changes",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      limit: 50,
    },
  });
  console.log("\n--- get_pending_changes (development warnings) ---\n");
  const pendingBigText = readText(pendingBig);
  console.log(pendingBigText);
  try {
    const parsed = JSON.parse(pendingBigText);
    const warnings = parsed?.development_warnings;
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "very_large_file")) {
      throw new Error("expected very_large_file development warning");
    }
  } catch (err) {
    console.error("\n[smoke] development warning check failed:", err);
    process.exitCode = 1;
    return;
  }

  const syncBig = await client.callTool({
    name: "sync_change_intent",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: verify large-file development warnings",
      files: ["src/god_file.ts"],
    },
  });
  console.log("\n--- sync_change_intent (development warnings) ---\n");
  const syncBigText = readText(syncBig);
  console.log(syncBigText);
  try {
    const parsed = JSON.parse(syncBigText);
    const warnings = parsed?.development_warnings;
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "very_large_file")) {
      throw new Error("expected sync_change_intent to include very_large_file development warning");
    }
  } catch (err) {
    console.error("\n[smoke] sync development warning check failed:", err);
    process.exitCode = 1;
    return;
  }

  const readBig = await client.callTool({
    name: "read_file_lines",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      path: "src/god_file.ts",
      from_line: 1,
      total_count: 5,
      format: "json",
    },
  });
  console.log("\n--- read_file_lines (large-file development warnings) ---\n");
  const readBigText = readText(readBig);
  console.log(readBigText);
  try {
    const parsed = JSON.parse(readBigText);
    const warnings = parsed?.development_warnings;
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "large_file_read")) {
      throw new Error("expected read_file_lines to include large_file_read development warning");
    }
  } catch (err) {
    console.error("\n[smoke] read large-file development warning check failed:", err);
    process.exitCode = 1;
    return;
  }

  const grepBig = await client.callTool({
    name: "grep",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "smokeValue1249",
      mode: "literal",
      include_paths: ["src/god_file.ts"],
      max_results: 5,
      format: "json",
    },
  });
  console.log("\n--- grep (large-file development warnings) ---\n");
  const grepBigText = readText(grepBig);
  console.log(grepBigText);
  try {
    const parsed = JSON.parse(grepBigText);
    const warnings = parsed?.development_warnings;
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "large_file_read")) {
      throw new Error("expected grep to include large_file_read development warning");
    }
  } catch (err) {
    console.error("\n[smoke] grep large-file development warning check failed:", err);
    process.exitCode = 1;
    return;
  }

  const hugeFilePath = path.join(toolProjectRoot, "src", "huge_controller.ts");
  fs.writeFileSync(
    hugeFilePath,
    Array.from({ length: 25 }, (_, domain) => [
      `export class Domain${domain}Controller {`,
      ...Array.from({ length: 120 }, (_, method) => `  method${method}() { return ${domain + method}; }`),
      "}",
    ].join("\n")).join("\n") + "\n",
  );
  const generatedHugePath = path.join(toolProjectRoot, "src", "generated_client.ts");
  fs.writeFileSync(
    generatedHugePath,
    "// @generated - do not edit\n" + Array.from({ length: 3005 }, (_, index) => `export const generated${index} = ${index};`).join("\n") + "\n",
    "utf8",
  );
  await new Promise((r) => setTimeout(r, 1000));

  const generatedPreflight = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: generated source must not enter mechanical modularization",
      files: ["src/generated_client.ts"],
      format: "json",
    },
  });
  const generatedPreflightParsed = JSON.parse(readText(generatedPreflight));
  if (
    generatedPreflightParsed?.safe_to_edit !== false ||
    !generatedPreflightParsed?.development_warnings?.some((warning) => warning?.code === "generated_source_not_editable")
  ) {
    throw new Error("expected generated source to point to regeneration instead of huge-file modularization");
  }

  const preflightHuge = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: normal feature should require huge-file modularization",
      files: ["src/huge_controller.ts"],
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (huge-file normal mode) ---\n");
  const preflightHugeText = readText(preflightHuge);
  console.log(preflightHugeText);
  try {
    const parsed = JSON.parse(preflightHugeText);
    const warnings = parsed?.development_warnings;
    if (parsed?.safe_to_edit !== false || parsed?.ok !== false) {
      throw new Error("expected normal feature editing of a huge file to be blocked");
    }
    if (parsed?.advisory_only !== false || parsed?.workflow_gate?.active !== true || parsed?.workflow_gate?.required_action !== "mechanical_modularization") {
      throw new Error("expected huge-file feature editing to expose an active mechanical-modularization workflow gate");
    }
    if (parsed?.required_action !== "mechanical_modularization") {
      throw new Error("expected required_action=mechanical_modularization for huge files");
    }
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "huge_file_modularization_required")) {
      throw new Error("expected huge_file_modularization_required development warning");
    }
  } catch (err) {
    console.error("\n[smoke] huge-file normal preflight check failed:", err);
    process.exitCode = 1;
    return;
  }

  const minimalHugeBugfix = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: minimal bugfix without adding responsibilities",
      files: ["src/huge_controller.ts"],
      change_mode: "bugfix",
      adds_responsibility: false,
      defer_split_reason: "Smoke verifies the bounded minimal-bugfix channel before the planned split.",
      format: "json",
    },
  });
  const minimalHugeBugfixParsed = JSON.parse(readText(minimalHugeBugfix));
  if (minimalHugeBugfixParsed?.safe_to_edit !== true || minimalHugeBugfixParsed?.workflow_gate?.minimal_bugfix_allowed !== true) {
    throw new Error("expected a no-new-responsibility bugfix with a durable deferral reason to avoid expanding into a split plan");
  }
  const smallDeferralPath = path.join(toolProjectRoot, "src", "small_deferral.ts");
  fs.writeFileSync(smallDeferralPath, "export const smallDeferral = true;\n", "utf8");
  await expectToolError({
    name: "sync_change_intent",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "Smoke rejects a deferral outside the synced file set.",
      files: ["src/huge_controller.ts"],
      large_file_split_deferrals: [{ file: "src/small_deferral.ts", reason: "invalid unrelated deferral" }],
    },
  }, "must belong to this sync_change_intent file set");
  await expectToolError({
    name: "sync_change_intent",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "Smoke rejects a deferral for a small file without a split plan.",
      files: ["src/small_deferral.ts"],
      large_file_split_deferrals: [{ file: "src/small_deferral.ts", reason: "invalid small-file deferral" }],
    },
  }, "requires a currently huge file or an unfinished split plan");
  const minimalBugfixSync = await client.callTool({
    name: "sync_change_intent",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "Smoke records a minimal huge-file bugfix deferral without adding responsibilities.",
      files: ["src/huge_controller.ts"],
      large_file_split_deferrals: [{
        file: "src/huge_controller.ts",
        reason: "Smoke keeps the mechanical split as durable follow-up work.",
      }],
    },
  });
  const minimalBugfixSyncParsed = JSON.parse(readText(minimalBugfixSync));
  if (minimalBugfixSyncParsed?.large_file_split_deferrals?.[0]?.file !== "src/huge_controller.ts") {
    throw new Error("expected sync_change_intent to persist the minimal bugfix split deferral");
  }

  const preflightHugeSplit = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: mechanically split huge file",
      files: ["src/huge_controller.ts"],
      change_mode: "mechanical_modularization",
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (huge-file split mode) ---\n");
  const preflightHugeSplitText = readText(preflightHugeSplit);
  console.log(preflightHugeSplitText);
  try {
    const parsed = JSON.parse(preflightHugeSplitText);
    if (parsed?.safe_to_edit !== false || parsed?.workflow_gate?.required_action !== "valid_split_plan") {
      throw new Error("expected mechanical_modularization without split_plan_id to remain blocked");
    }
  } catch (err) {
    console.error("\n[smoke] huge-file split-mode preflight check failed:", err);
    process.exitCode = 1;
    return;
  }

  const hugeSplitPlan = await client.callTool({
    name: "plan_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      file: "src/huge_controller.ts",
      intent: "smoke: mechanically split huge controller",
      max_modules: 30,
      format: "json",
    },
  });
  console.log("\n--- plan_large_file_split (json) ---\n");
  const hugeSplitPlanText = readText(hugeSplitPlan);
  console.log(hugeSplitPlanText);
  let splitModules = [];
  let splitPlanId = 0;
  let splitRequirementId = 0;
  let deferredPlanId = 0;
  try {
    const parsed = JSON.parse(hugeSplitPlanText);
    if (parsed?.ok !== true) throw new Error("expected plan_large_file_split ok=true");
    splitPlanId = Number(parsed?.plan_id ?? 0);
    splitRequirementId = Number(parsed?.requirement?.id ?? 0);
    if (
      splitPlanId <= 0 ||
      parsed?.coverage?.complete !== true ||
      parsed?.analysis_mode !== "heuristic_stream" ||
      parsed?.confidence !== "low" ||
      parsed?.module_constraints?.satisfied !== true ||
      parsed?.modules?.some(
        (module) =>
          module?.declaration_count > parsed.module_constraints.max_declarations_per_module ||
          module?.estimated_lines >= parsed.module_constraints.max_estimated_lines_per_module,
      )
    ) {
      throw new Error("expected a persisted, complete, streaming split plan");
    }
    if (parsed?.required_action !== "mechanical_modularization") {
      throw new Error("expected split plan required_action=mechanical_modularization");
    }
    if (!Array.isArray(parsed?.forbidden_patterns) || !parsed.forbidden_patterns.includes("*.parts")) {
      throw new Error("expected split plan to forbid *.parts");
    }
    if (!Array.isArray(parsed?.forbidden_patterns) || !parsed.forbidden_patterns.includes("[0-9]_*")) {
      throw new Error("expected split plan to forbid ordinal-prefixed module files");
    }
    splitModules = Array.isArray(parsed?.modules) ? parsed.modules : [];
    if (!splitModules.length) throw new Error("expected split plan modules");
    if (splitModules.some((m) => String(m?.target_path ?? "").includes(".parts"))) {
      throw new Error("split plan must not create .parts target paths");
    }
    if (splitModules.some((m) => /part\d*$/i.test(String(m?.module ?? "")))) {
      throw new Error("split plan must not use partN module names");
    }
    if (splitModules.some((m) => /(^|\/)\d+[\s._-]+[A-Za-z_$]/.test(String(m?.target_path ?? "").replace(/\\/g, "/")))) {
      throw new Error("split plan must not use ordinal-prefixed target paths");
    }
  } catch (err) {
    console.error("\n[smoke] plan_large_file_split check failed:", err);
    process.exitCode = 1;
    return;
  }

  const reusedHugeSplitPlan = await client.callTool({
    name: "plan_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      file: "src/huge_controller.ts",
      intent: "smoke: retry the same plan without duplicating memory",
      max_modules: 30,
      format: "json",
    },
  });
  const reusedHugeSplitPlanParsed = JSON.parse(readText(reusedHugeSplitPlan));
  if (reusedHugeSplitPlanParsed?.plan_id !== splitPlanId || reusedHugeSplitPlanParsed?.reused !== true) {
    throw new Error("expected an unchanged source state to reuse the persisted split plan");
  }
  const splitPlanMemory = await client.callTool({
    name: "read_memory_item",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      id: splitPlanId,
      limit: 1000,
    },
  });
  const splitPlanMemoryParsed = JSON.parse(readText(splitPlanMemory));
  if (String(splitPlanMemoryParsed?.item?.metadata_json ?? "").length > 5000) {
    throw new Error("expected large-file split metadata to remain compact");
  }
  const fakeRelocationPath = path.join(toolProjectRoot, "src", "fake_relocation.ts");
  fs.writeFileSync(
    fakeRelocationPath,
    Array.from({ length: 3005 }, (_, index) => `export function billingOperation${index}() { return ${index}; }`).join("\n") + "\n",
    "utf8",
  );
  const fakeRelocationPlan = await client.callTool({
    name: "plan_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      file: "src/fake_relocation.ts",
      intent: "Smoke must not move one god file into another god file.",
      max_modules: 30,
      format: "json",
    },
  });
  const fakeRelocationPlanParsed = JSON.parse(readText(fakeRelocationPlan));
  if (
    fakeRelocationPlanParsed?.ok !== false ||
    fakeRelocationPlanParsed?.plan_status !== "needs_refinement" ||
    !fakeRelocationPlanParsed?.module_constraints?.oversized_modules?.length
  ) {
    throw new Error("expected a single oversized target module to keep the split plan in needs_refinement");
  }
  const fakeRelocationPlanId = Number(fakeRelocationPlanParsed?.plan_id ?? 0);
  const adjustedFakePlan = await client.callTool({
    name: "plan_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      file: "src/fake_relocation.ts",
      max_modules: 29,
      max_declarations_per_module: 1000,
      max_lines_per_module: 100000,
      format: "json",
    },
  });
  const adjustedFakePlanParsed = JSON.parse(readText(adjustedFakePlan));
  if (
    Number(adjustedFakePlanParsed?.plan_id ?? 0) === fakeRelocationPlanId ||
    adjustedFakePlanParsed?.module_constraints?.max_declarations_per_module !== 200 ||
    adjustedFakePlanParsed?.module_constraints?.max_estimated_lines_per_module !== 1200
  ) {
    throw new Error("expected planning parameter changes to avoid stale reuse while caller limits remain capped at safe values");
  }

  await expectToolError({
    name: "plan_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      file: "src/fake_relocation.ts",
      max_modules: 30,
      module_overrides: [{
        module: "invalid_target",
        target_path: "src/fake_relocation/invalid_target.txt",
        line_ranges: [{ start: 1, end: 3005 }],
      }],
      format: "json",
    },
  }, "Invalid module override target_path");

  const incompleteOverridePlan = await client.callTool({
    name: "plan_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      file: "src/fake_relocation.ts",
      max_modules: 30,
      module_overrides: [{
        module: "billing_subset",
        target_path: "src/fake_relocation/billing_subset.ts",
        line_ranges: [{ start: 1, end: 190 }],
      }],
      format: "json",
    },
  });
  const incompleteOverridePlanParsed = JSON.parse(readText(incompleteOverridePlan));
  if (
    incompleteOverridePlanParsed?.plan_status !== "needs_refinement" ||
    incompleteOverridePlanParsed?.coverage?.assigned_declarations !== 190 ||
    incompleteOverridePlanParsed?.coverage?.detected_declarations !== 3005 ||
    incompleteOverridePlanParsed?.coverage?.complete !== false
  ) {
    throw new Error("expected incomplete overrides to report the actual uniquely assigned declaration count");
  }

  const refinedOverrides = Array.from({ length: Math.ceil(3005 / 190) }, (_, index) => {
    const start = index * 190 + 1;
    const end = Math.min(3005, (index + 1) * 190);
    return {
      module: `billing_group_${index + 1}`,
      target_path: `src/fake_relocation/billing_group_${index + 1}.ts`,
      line_ranges: [{ start, end }],
    };
  });
  const refinedFakePlan = await client.callTool({
    name: "plan_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      file: "src/fake_relocation.ts",
      max_modules: 30,
      module_overrides: refinedOverrides,
      format: "json",
    },
  });
  const refinedFakePlanParsed = JSON.parse(readText(refinedFakePlan));
  deferredPlanId = Number(refinedFakePlanParsed?.plan_id ?? 0);
  if (
    refinedFakePlanParsed?.ok !== true ||
    refinedFakePlanParsed?.plan_status !== "planned" ||
    refinedFakePlanParsed?.coverage?.complete !== true ||
    deferredPlanId <= 0
  ) {
    throw new Error("expected module_overrides to recover needs_refinement into a complete planned split");
  }
  const supersededFakePlan = await client.callTool({
    name: "read_memory_item",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      id: Number(adjustedFakePlanParsed?.plan_id ?? 0),
      limit: 1000,
    },
  });
  const supersededFakePlanParsed = JSON.parse(readText(supersededFakePlan));
  if (JSON.parse(supersededFakePlanParsed?.item?.metadata_json ?? "{}")?.status !== "superseded") {
    throw new Error("expected the refined plan to supersede the previous needs_refinement plan");
  }

  const originalFakeContent = fs.readFileSync(fakeRelocationPath, "utf8");
  fs.writeFileSync(fakeRelocationPath, originalFakeContent.replace("billingOperation0", "cillingOperation0"), "utf8");
  const changedContentPlan = await client.callTool({
    name: "plan_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      file: "src/fake_relocation.ts",
      max_modules: 30,
      module_overrides: refinedOverrides,
      format: "json",
    },
  });
  const changedContentPlanParsed = JSON.parse(readText(changedContentPlan));
  if (
    Number(changedContentPlanParsed?.plan_id ?? 0) === deferredPlanId ||
    changedContentPlanParsed?.source_content_hash === refinedFakePlanParsed?.source_content_hash ||
    fs.statSync(fakeRelocationPath).size !== Buffer.byteLength(originalFakeContent)
  ) {
    throw new Error("expected same-size source content changes to invalidate a persisted split plan by SHA-256");
  }
  deferredPlanId = Number(changedContentPlanParsed?.plan_id ?? 0);

  const splitPlanBootstrap = await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "src/huge_controller.ts mechanical modularization",
      format: "json",
    },
  });
  const splitPlanBootstrapParsed = JSON.parse(readText(splitPlanBootstrap));
  if (!splitPlanBootstrapParsed?.current_context?.some((item) => item?.id === splitPlanId)) {
    throw new Error("expected focused bootstrap to restore the active persisted large-file split plan");
  }

  const preflightHugeWithPlan = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: mechanically split huge file with persisted evidence",
      files: ["src/huge_controller.ts"],
      change_mode: "mechanical_modularization",
      split_plan_id: splitPlanId,
      format: "json",
    },
  });
  const preflightHugeWithPlanParsed = JSON.parse(readText(preflightHugeWithPlan));
  if (preflightHugeWithPlanParsed?.safe_to_edit !== true || preflightHugeWithPlanParsed?.split_plan_validation?.valid !== true) {
    throw new Error("expected a matching persisted split plan to satisfy the huge-file workflow gate");
  }

  const minimalHugeBugfixWithPlan = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: minimal bugfix with persisted split deferral",
      files: ["src/huge_controller.ts"],
      change_mode: "bugfix",
      split_plan_id: splitPlanId,
      adds_responsibility: false,
      defer_split_reason: "Smoke verifies that the persisted split remains scheduled after the minimal bugfix.",
      format: "json",
    },
  });
  const minimalHugeBugfixWithPlanParsed = JSON.parse(readText(minimalHugeBugfixWithPlan));
  if (minimalHugeBugfixWithPlanParsed?.safe_to_edit !== true || minimalHugeBugfixWithPlanParsed?.workflow_gate?.minimal_bugfix_allowed !== true) {
    throw new Error("expected a plan-backed no-new-responsibility bugfix to use the bounded channel");
  }

  const recordOrdinalSplit = await client.callTool({
    name: "record_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      plan_id: splitPlanId,
      file: "src/huge_controller.ts",
      status: "planned",
      summary: "Smoke should reject ordinal-prefixed module paths.",
      modules: ["src/huge_controller/1_config.ts"],
    },
  });
  console.log("\n--- record_large_file_split (ordinal prefix rejected) ---\n");
  const recordOrdinalSplitText = readText(recordOrdinalSplit);
  console.log(recordOrdinalSplitText);
  try {
    const parsed = JSON.parse(recordOrdinalSplitText);
    if (parsed?.ok !== false || !String(parsed?.error ?? "").includes("Ordinal-prefixed")) {
      throw new Error("expected record_large_file_split to reject ordinal-prefixed module paths");
    }
  } catch (err) {
    console.error("\n[smoke] record ordinal-prefixed split rejection check failed:", err);
    process.exitCode = 1;
    return;
  }

  const missingInProgressModule = await client.callTool({
    name: "record_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      plan_id: splitPlanId,
      file: "src/huge_controller.ts",
      status: "in_progress",
      summary: "Smoke rejects nonexistent in-progress module evidence.",
      modules: [splitModules[0].target_path],
    },
  });
  const missingInProgressModuleParsed = JSON.parse(readText(missingInProgressModule));
  if (missingInProgressModuleParsed?.ok !== false || !String(missingInProgressModuleParsed?.error ?? "").includes("must exist")) {
    throw new Error("expected in-progress module paths to exist before recording them");
  }

  const recordHugeSplit = await client.callTool({
    name: "record_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      plan_id: splitPlanId,
      file: "src/huge_controller.ts",
      status: "in_progress",
      summary: "Smoke started the planned mechanical split.",
    },
  });
  console.log("\n--- record_large_file_split ---\n");
  const recordHugeSplitText = readText(recordHugeSplit);
  console.log(recordHugeSplitText);
  try {
    const parsed = JSON.parse(recordHugeSplitText);
    if (parsed?.ok !== true || Number(parsed?.note?.id ?? 0) <= 0) {
      throw new Error("expected record_large_file_split to create a note");
    }
  } catch (err) {
    console.error("\n[smoke] record_large_file_split check failed:", err);
    process.exitCode = 1;
    return;
  }
  await expectToolError({
    name: "plan_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      file: "src/huge_controller.ts",
      max_modules: 29,
      format: "json",
    },
  }, "already owns this requirement/file");

  const regressedHugeSplit = await client.callTool({
    name: "record_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      plan_id: splitPlanId,
      file: "src/huge_controller.ts",
      status: "planned",
      summary: "Smoke must reject state regression.",
    },
  });
  const regressedHugeSplitParsed = JSON.parse(readText(regressedHugeSplit));
  if (regressedHugeSplitParsed?.ok !== false || !String(regressedHugeSplitParsed?.error ?? "").includes("Invalid split plan status transition")) {
    throw new Error("expected in_progress -> planned status regression to be rejected");
  }

  for (const module of splitModules) {
    const modulePath = path.join(toolProjectRoot, module.target_path);
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, `export const splitSmoke = ${JSON.stringify(module.module)};\n`, "utf8");
  }
  fs.writeFileSync(
    hugeFilePath,
    Array.from({ length: 20 }, (_, index) => `export const orchestration${index} = ${index};`).join("\n") + "\n",
    "utf8",
  );
  const resolvedHugeSplit = await client.callTool({
    name: "record_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      plan_id: splitPlanId,
      file: "src/huge_controller.ts",
      status: "resolved",
      summary: "Smoke completed the persisted mechanical split.",
      modules: splitModules.map((module) => module.target_path),
      verification: ["formatter passed", "build passed", "relevant tests passed"],
      verification_gaps: [],
    },
  });
  const resolvedHugeSplitParsed = JSON.parse(readText(resolvedHugeSplit));
  if (resolvedHugeSplitParsed?.ok !== true || resolvedHugeSplitParsed?.plan?.id !== splitPlanId || resolvedHugeSplitParsed?.status !== "resolved") {
    throw new Error("expected resolved split verification to update the same persisted plan entity");
  }

  await client.callTool({
    name: "complete_requirement",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      req_id: splitRequirementId,
    },
  });
  const deferredPlanMemory = await client.callTool({
    name: "read_memory_item",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      id: deferredPlanId,
      limit: 1000,
    },
  });
  const deferredPlanMemoryParsed = JSON.parse(readText(deferredPlanMemory));
  const deferredPlanMetadata = JSON.parse(deferredPlanMemoryParsed?.item?.metadata_json ?? "{}");
  if (deferredPlanMetadata?.status !== "deferred" || !deferredPlanMetadata?.deferred_reason) {
    throw new Error("expected requirement completion to mark unfinished split plans deferred");
  }
  const defaultDeferredSearch = await client.callTool({
    name: "semantic_search",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "fake_relocation billing_group",
      top_k: 20,
      format: "json",
    },
  });
  const defaultDeferredSearchParsed = JSON.parse(readText(defaultDeferredSearch));
  if (defaultDeferredSearchParsed?.matches?.some((match) => match?.item?.id === deferredPlanId)) {
    throw new Error("expected deferred split plans to stay out of default semantic recall");
  }
  const explicitDeferredSearch = await client.callTool({
    name: "semantic_search",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "fake_relocation billing_group",
      kinds: ["large_file_split_plan"],
      top_k: 20,
      format: "json",
    },
  });
  const explicitDeferredSearchParsed = JSON.parse(readText(explicitDeferredSearch));
  if (!explicitDeferredSearchParsed?.matches?.some((match) => match?.item?.id === deferredPlanId)) {
    throw new Error("expected explicitly requested deferred split plans to remain searchable");
  }
  const defaultDeferredBootstrap = await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "fake_relocation billing_group",
      top_k: 20,
      format: "json",
    },
  });
  const defaultDeferredBootstrapParsed = JSON.parse(readText(defaultDeferredBootstrap));
  if (defaultDeferredBootstrapParsed?.semantic?.matches?.some((match) => match?.item?.id === deferredPlanId)) {
    throw new Error("expected deferred split plans to stay out of default bootstrap recall");
  }
  const explicitDeferredBootstrap = await client.callTool({
    name: "bootstrap_context",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "fake_relocation billing_group",
      kinds: ["large_file_split_plan"],
      top_k: 20,
      format: "json",
    },
  });
  const explicitDeferredBootstrapParsed = JSON.parse(readText(explicitDeferredBootstrap));
  if (!explicitDeferredBootstrapParsed?.semantic?.matches?.some((match) => match?.item?.id === deferredPlanId)) {
    throw new Error("expected explicitly requested deferred split plans to remain available to bootstrap recall");
  }


  return true;
}
