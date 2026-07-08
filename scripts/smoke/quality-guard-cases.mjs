import fs from "node:fs";
import path from "node:path";

export async function runQualityGuardCases(ctx) {
  const { client, useToolProjectRoot, toolProjectRoot, readText } = ctx;
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
    if (parsed?.safe_to_edit !== false || parsed?.ok !== false) {
      throw new Error("expected advisory fix_pattern not to override existing preflight scope warnings");
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
    if (parsed?.safe_to_edit !== false || parsed?.ok !== false) {
      throw new Error("expected preflight_change_scope to block editing a very large file");
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
    Array.from({ length: 3200 }, (_, i) => {
      if (i % 400 === 0) return `export function loadConfigSmoke${i}() { return ${i}; }`;
      if (i % 400 === 100) return `export function syncApiSmoke${i}() { return ${i}; }`;
      if (i % 400 === 200) return `export function renderViewSmoke${i}() { return ${i}; }`;
      if (i % 400 === 300) return `export function normalizePathSmoke${i}() { return ${i}; }`;
      return `export const hugeSmokeValue${i} = ${i};`;
    }).join("\n") + "\n",
  );
  await new Promise((r) => setTimeout(r, 1000));

  const preflightHuge = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: normal feature should be blocked on huge files",
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
      throw new Error("expected normal preflight to block editing a huge file");
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
    const warnings = parsed?.development_warnings;
    if (parsed?.safe_to_edit !== true || parsed?.ok !== true) {
      throw new Error("expected mechanical_modularization preflight to allow the split");
    }
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "huge_file_modularization_required")) {
      throw new Error("expected huge warning to remain visible during split mode");
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
      format: "json",
    },
  });
  console.log("\n--- plan_large_file_split (json) ---\n");
  const hugeSplitPlanText = readText(hugeSplitPlan);
  console.log(hugeSplitPlanText);
  let splitModules = [];
  try {
    const parsed = JSON.parse(hugeSplitPlanText);
    if (parsed?.ok !== true) throw new Error("expected plan_large_file_split ok=true");
    if (parsed?.required_action !== "mechanical_modularization") {
      throw new Error("expected split plan required_action=mechanical_modularization");
    }
    if (!Array.isArray(parsed?.forbidden_patterns) || !parsed.forbidden_patterns.includes("*.parts")) {
      throw new Error("expected split plan to forbid *.parts");
    }
    splitModules = Array.isArray(parsed?.modules) ? parsed.modules : [];
    if (!splitModules.length) throw new Error("expected split plan modules");
    if (splitModules.some((m) => String(m?.target_path ?? "").includes(".parts"))) {
      throw new Error("split plan must not create .parts target paths");
    }
    if (splitModules.some((m) => /part\d*$/i.test(String(m?.module ?? "")))) {
      throw new Error("split plan must not use partN module names");
    }
  } catch (err) {
    console.error("\n[smoke] plan_large_file_split check failed:", err);
    process.exitCode = 1;
    return;
  }

  const recordHugeSplit = await client.callTool({
    name: "record_large_file_split",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      file: "src/huge_controller.ts",
      status: "planned",
      summary: "Smoke planned mechanical split into real modules.",
      modules: splitModules.slice(0, 4).map((m) => m.target_path),
      remaining_lines: 3200,
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


  return true;
}
