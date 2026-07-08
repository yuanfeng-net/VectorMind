import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runFileToolCases } from "./smoke/file-tool-cases.mjs";
import { runMaintenanceCases } from "./smoke/maintenance-cases.mjs";
import { runMemoryRecallCases } from "./smoke/memory-recall-cases.mjs";
import { runQualityGuardCases } from "./smoke/quality-guard-cases.mjs";

function getFlag(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const rootsMode = (getFlag("roots") ?? "on").toLowerCase();
const enableRoots = rootsMode !== "off";

const keepFiles = hasFlag("keep-files");
const inPlace = hasFlag("in-place");
const useToolProjectRoot = hasFlag("use-tool-project-root");

const env = {
  ...process.env,
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(scriptDir, "..", "dist", "index.js");
const rtkShimEntry = path.resolve(scriptDir, "..", "dist", "rtk-shim.js");
const packageJsonPath = path.resolve(scriptDir, "..", "package.json");

if (!fs.existsSync(rtkShimEntry)) {
  console.error(`\n[smoke] expected RTK shim build output at ${rtkShimEntry}`);
  process.exitCode = 1;
  process.exit();
}

const runDir = inPlace
  ? process.cwd()
  : fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-smoke-"));

const toolProjectRoot = useToolProjectRoot
  ? fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-smoke-project-"))
  : runDir;

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-smoke-codex-"));
const agentsHome = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-smoke-agents-"));
fs.mkdirSync(path.join(codexHome, "prompts"), { recursive: true });
fs.mkdirSync(path.join(codexHome, "skills", "vm-smoke-skill"), { recursive: true });
fs.mkdirSync(path.join(codexHome, "rules"), { recursive: true });
fs.mkdirSync(path.join(agentsHome, "skills", "vm-agent-skill"), { recursive: true });

Object.assign(env, {
  CODEX_HOME: codexHome,
  AGENTS_HOME: agentsHome,
});

const transport = new StdioClientTransport({
  command: "node",
  args: [serverEntry],
  cwd: runDir,
  env,
  stderr: "inherit",
});

const client = new Client(
  { name: "vectormind-smoke", version: "0.0.0" },
  { capabilities: enableRoots ? { roots: {} } : {} },
);

function readText(result) {
  const first = result?.content?.find((c) => c.type === "text");
  return first?.text ?? JSON.stringify(result, null, 2);
}

async function main() {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const packageFiles = Array.isArray(pkg?.files) ? pkg.files : [];
    for (const expectedPackageFile of ["dist", "docs", "skills"]) {
      if (!packageFiles.includes(expectedPackageFile)) {
        throw new Error(`expected package.json files to include ${expectedPackageFile}`);
      }
    }
  } catch (err) {
    console.error("\n[smoke] package files check failed:", err);
    process.exitCode = 1;
    return;
  }

  if (rootsMode === "on") {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(runDir).toString(), name: "vectormind-smoke" }],
    }));
  } else if (rootsMode === "hang") {
    client.setRequestHandler(ListRootsRequestSchema, async () => new Promise(() => {}));
  }

  await client.connect(transport);

  const serverInstructions = client.getInstructions();
  if (serverInstructions) {
    console.log("\n--- server instructions ---\n");
    console.log(serverInstructions);
  }

  const toolList = await client.listTools();
  console.log("\n--- tools ---\n");
  console.log(toolList.tools.map((t) => t.name).sort().join(", "));
  if (!toolList.tools.some((t) => t.name === "read_codex_text_file")) {
    console.error("\n[smoke] expected tool list to include read_codex_text_file");
    process.exitCode = 1;
    return;
  }
  for (const toolName of [
    "detect_rtk",
    "install_rtk",
    "get_token_savings",
    "maintain_memory",
    "plan_large_file_split",
    "record_large_file_split",
    "memory_timeline",
    "create_checkpoint",
    "list_checkpoints",
    "restore_checkpoint_context",
    "analyze_memory_conflicts",
    "memory_quality_report",
    "compare_checkpoint_context",
    "preflight_operation_scope",
  ]) {
    if (!toolList.tools.some((t) => t.name === toolName)) {
      console.error(`\n[smoke] expected tool list to include ${toolName}`);
      process.exitCode = 1;
      return;
    }
  }
  try {
    const byName = new Map(toolList.tools.map((t) => [t.name, t]));
    const syncTool = byName.get("sync_change_intent");
    const preflightTool = byName.get("preflight_change_scope");
    const timelineTool = byName.get("memory_timeline");
    const checkpointTool = byName.get("create_checkpoint");
    const restoreTool = byName.get("restore_checkpoint_context");
    const conflictsTool = byName.get("analyze_memory_conflicts");
    const qualityTool = byName.get("memory_quality_report");
    const checkpointDiffTool = byName.get("compare_checkpoint_context");
    const operationScopeTool = byName.get("preflight_operation_scope");
    if (timelineTool?.annotations?.readOnlyHint !== true) {
      throw new Error("expected memory_timeline to be annotated readOnlyHint=true");
    }
    if (checkpointTool?.annotations?.readOnlyHint !== false) {
      throw new Error("expected create_checkpoint to be annotated readOnlyHint=false");
    }
    if (restoreTool?.annotations?.readOnlyHint !== true) {
      throw new Error("expected restore_checkpoint_context to be annotated readOnlyHint=true");
    }
    if (conflictsTool?.annotations?.readOnlyHint !== true) {
      throw new Error("expected analyze_memory_conflicts to be annotated readOnlyHint=true");
    }
    if (qualityTool?.annotations?.readOnlyHint !== true) {
      throw new Error("expected memory_quality_report to be annotated readOnlyHint=true");
    }
    if (checkpointDiffTool?.annotations?.readOnlyHint !== true) {
      throw new Error("expected compare_checkpoint_context to be annotated readOnlyHint=true");
    }
    if (operationScopeTool?.annotations?.readOnlyHint !== true) {
      throw new Error("expected preflight_operation_scope to be annotated readOnlyHint=true");
    }
    if (!syncTool?._meta?.["vectormind/behavior"]?.tags?.includes("fix_pattern")) {
      throw new Error("expected sync_change_intent behavior tags to include fix_pattern");
    }
    if (!String(preflightTool?.description ?? "").includes("relevant fix_pattern quality_signals")) {
      throw new Error("expected preflight_change_scope description to mention advisory fix_pattern signals");
    }
    if (!timelineTool?._meta?.["vectormind/behavior"]?.advisory_only) {
      throw new Error("expected tool behavior metadata to mark tools advisory_only");
    }
    if (!checkpointDiffTool?._meta?.["vectormind/behavior"]?.does_not_control_model_reasoning) {
      throw new Error("expected diagnostic tools to avoid model-reasoning control");
    }
    if (operationScopeTool?._meta?.["vectormind/behavior"]?.does_not_control_host_runtime !== true) {
      throw new Error("expected operation preflight not to control host runtime");
    }
  } catch (err) {
    console.error("\n[smoke] tool behavior annotations check failed:", err);
    process.exitCode = 1;
    return;
  }

  const bootStart = Date.now();
  const boot = await client.callTool(
    {
      name: "bootstrap_context",
      arguments: {
        ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
        query: "smoke test: what is VectorMind?",
        top_k: 5,
      },
    },
    undefined,
    { timeout: 10_000 },
  );
  const bootElapsedMs = Date.now() - bootStart;
  console.log("\n--- bootstrap_context (compact) ---\n");
  const bootText = readText(boot);
  console.log(bootText);
  if (!bootText.includes("ok ctx") || !bootText.includes("hint: use format=json")) {
    console.error("\n[smoke] expected default bootstrap_context output to be compact text");
    process.exitCode = 1;
    return;
  }

  const bootJson = await client.callTool(
    {
      name: "bootstrap_context",
      arguments: {
        ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
        query: "smoke test: what is VectorMind?",
        top_k: 5,
        conventions_limit: 40,
        format: "json",
      },
    },
    undefined,
    { timeout: 10_000 },
  );
  console.log("\n--- bootstrap_context (json) ---\n");
  const bootJsonText = readText(bootJson);
  console.log(bootJsonText);
  try {
    const parsed = JSON.parse(bootJsonText);
    const expectedRootSource = useToolProjectRoot ? "tool_arg" : rootsMode === "on" ? "mcp_roots" : "cwd";
    if (parsed?.root_source !== expectedRootSource) {
      throw new Error(`expected root_source=${expectedRootSource}, got ${parsed?.root_source}`);
    }
    if (rootsMode === "hang" && bootElapsedMs > 5_000) {
      throw new Error(`expected bootstrap_context to finish fast when roots hang (got ${bootElapsedMs}ms)`);
    }
    const expectedDbPath = path.join(toolProjectRoot, ".vectormind", "vectormind.db");
    if (!parsed?.db_path) {
      throw new Error("expected db_path in bootstrap_context output");
    }
    if (path.resolve(parsed.db_path) !== path.resolve(expectedDbPath)) {
      throw new Error(`expected db_path=${expectedDbPath}, got ${parsed.db_path}`);
    }
    if (!fs.existsSync(expectedDbPath)) {
      throw new Error(`expected db file to exist at ${expectedDbPath}`);
    }
    const conventions = Array.isArray(parsed?.conventions) ? parsed.conventions : [];
    if (!Array.isArray(parsed?.current_constraints)) {
      throw new Error("expected bootstrap_context to return current_constraints array");
    }
    const conventionKeys = new Set(
      conventions
        .map((item) => {
          if (typeof item?.key === "string") return item.key;
          if (typeof item?.title === "string") return item.title;
          if (typeof item?.metadata_json === "string") {
            try {
              const meta = JSON.parse(item.metadata_json);
              if (typeof meta?.key === "string") return meta.key;
            } catch {}
          }
          return null;
        })
        .filter((key) => typeof key === "string"),
    );
    for (const key of [
      "builtin:development_guideline_scope",
      "builtin:model_autonomy_floor",
      "builtin:plan_lite_trigger_scope",
      "builtin:destructive_operation_scope",
      "builtin:architecture_boundary_first",
      "builtin:requirement_scope_no_extra_work",
      "builtin:completed_work_preservation",
      "builtin:no_god_file_growth",
      "builtin:frontend_output_purity_scope",
      "builtin:git_commit_summary_required",
      "builtin:low_overhead_execution_scope",
      "builtin:payload_guard_bounded_io",
      "builtin:thread_handoff_trigger_scope",
    ]) {
      if (!conventionKeys.has(key)) {
        throw new Error(`expected bootstrap_context conventions to include ${key}`);
      }
    }
  } catch (err) {
    console.error("\n[smoke] root resolution check failed:", err);
    process.exitCode = 1;
    return;
  }

  try {
    if (!serverInstructions?.includes("Development guideline scope")) {
      throw new Error("expected server instructions to state development-guideline scope");
    }
    if (!serverInstructions?.includes("VectorMind autonomy floor")) {
      throw new Error("expected server instructions to state autonomy floor");
    }
    if (!serverInstructions?.includes("newer/direct evidence wins over stale memory")) {
      throw new Error("expected server instructions to keep model-judgment evidence priority");
    }
    if (serverInstructions?.includes("trust the tool output")) {
      throw new Error("expected server instructions to avoid tool-output-over-model wording");
    }
    if (!serverInstructions?.includes("Required VectorMind call chain for development work:")) {
      throw new Error("expected server instructions to include required VectorMind call chain");
    }
    for (const chainTerm of [
      "call bootstrap_context with project_root",
      "call start_requirement for the current user request",
      "call preflight_change_scope with the planned files/modules",
      "call get_pending_changes, then sync_change_intent",
      "call upsert_decision and supersede_memory",
      "complete_requirement when the requirement is done",
    ]) {
      if (!serverInstructions?.includes(chainTerm)) {
        throw new Error(`expected server instructions call chain to include: ${chainTerm}`);
      }
    }
    for (const projectRootExample of [
      "bootstrap_context({ project_root",
      "get_brain_dump({ project_root",
      "start_requirement({ project_root",
      "preflight_change_scope({ project_root",
      "get_pending_changes({ project_root",
      "sync_change_intent({ project_root",
      "upsert_decision({ project_root",
      "supersede_memory({ project_root",
      "query_codebase({ project_root",
      "semantic_search({ project_root",
      "memory_timeline({ project_root",
      "create_checkpoint({ project_root",
      "restore_checkpoint_context({ project_root",
      "analyze_memory_conflicts({ project_root",
      "memory_quality_report({ project_root",
      "compare_checkpoint_context({ project_root",
      "maintain_memory({ project_root",
    ]) {
      if (!serverInstructions?.includes(projectRootExample)) {
        throw new Error(`expected server instructions to include project_root example: ${projectRootExample}`);
      }
    }
    for (const staleExample of [
      "bootstrap_context({ query:",
      "start_requirement(title",
      "preflight_change_scope(intent",
      "get_pending_changes()",
      "sync_change_intent(intent",
      "query_codebase(query",
      "semantic_search(query",
      "maintain_memory({ dry_run",
    ]) {
      if (serverInstructions?.includes(staleExample)) {
        throw new Error(`expected server instructions to avoid project_root-less example: ${staleExample}`);
      }
    }
    for (const staleRuntimeHint of [
      "Call start_requirement(title, background)",
    ]) {
      if (serverInstructions?.includes(staleRuntimeHint)) {
        throw new Error(`expected server instructions to avoid stale runtime hint: ${staleRuntimeHint}`);
      }
    }
    if (!serverInstructions?.includes("Built-in task-list / Plan-Lite quality policy:")) {
      throw new Error("expected server instructions to include Plan-Lite quality section");
    }
    if (!serverInstructions?.includes("Built-in destructive-operation quality guard:")) {
      throw new Error("expected server instructions to include destructive-operation quality section");
    }
    if (!serverInstructions?.includes("Built-in architecture and code-organization quality policy:")) {
      throw new Error("expected server instructions to include architecture/code-organization quality section");
    }
    if (!serverInstructions?.includes("Built-in requirement boundary and modularity quality policy:")) {
      throw new Error("expected server instructions to include requirement-boundary/modularity quality section");
    }
    if (!serverInstructions?.includes("Do not keep piling new feature code into a large single file")) {
      throw new Error("expected server instructions to include anti-god-file guidance");
    }
    if (!serverInstructions?.includes("huge_file_modularization_required")) {
      throw new Error("expected server instructions to include huge-file modularization guidance");
    }
    if (!serverInstructions?.includes("Do not add extra business behavior")) {
      throw new Error("expected server instructions to include no-extra-demand guidance");
    }
    if (!serverInstructions?.includes("planned_changes with requirement_refs")) {
      throw new Error("expected server instructions to include requirement item mapping guidance");
    }
    if (!serverInstructions?.includes("cross_project_reference")) {
      throw new Error("expected server instructions to include cross-project reference guidance");
    }
    if (!serverInstructions?.includes("Built-in frontend output-purity quality policy:")) {
      throw new Error("expected server instructions to include frontend output-purity quality section");
    }
    if (!serverInstructions?.includes("Built-in git commit summary quality policy:")) {
      throw new Error("expected server instructions to include git commit summary quality section");
    }
    const forbiddenInstructionTerms = [
      "access " + "per" + "missions",
      "runtime " + "per" + "missions",
      "command " + "per" + "missions",
      "file" + "system/" + "net" + "work " + "per" + "missions",
      "appr" + "oval mechanisms",
      "sand" + "box behavior",
      "\u8bbf\u95ee\u6743\u9650",
      "\u8fd0\u884c\u6743\u9650",
      "\u547d\u4ee4\u6743\u9650",
      "\u6587\u4ef6\u6743\u9650",
      "\u7f51\u7edc\u6743\u9650",
      "\u5ba1\u6279\u673a\u5236",
      "sand" + "box",
    ];
    const leakedInstructionTerm = forbiddenInstructionTerms.find((term) => serverInstructions?.includes(term));
    if (leakedInstructionTerm) {
      throw new Error("expected server instructions to avoid runtime-control wording");
    }
    if (!serverInstructions?.includes("页面代码、模板内容")) {
      throw new Error("expected server instructions to keep frontend prompt-leakage quality rule");
    }
    if (!serverInstructions?.includes("本次更改的内容描述或总结")) {
      throw new Error("expected server instructions to keep git commit summary quality rule");
    }
    if (serverInstructions?.includes("THREAD_HANDOFF_PACK")) {
      throw new Error("expected server instructions to stop using the old THREAD_HANDOFF_PACK template");
    }
    if (!serverInstructions?.includes("list_project_files({ project_root, path, recursive?, max_depth? })")) {
      throw new Error("expected server instructions to recommend list_project_files");
    }
    if (!serverInstructions?.includes("read_file_text({ project_root, path, offset?, max_chars? })")) {
      throw new Error("expected server instructions to recommend read_file_text");
    }
    if (!serverInstructions?.includes("read_codex_text_file({ path })")) {
      throw new Error("expected server instructions to recommend read_codex_text_file");
    }
    if (!serverInstructions?.includes("uses ripgrep against real project files")) {
      throw new Error("expected server instructions to mention the ripgrep-backed grep behavior");
    }
    if (!serverInstructions?.includes("you may skip retrieval and go straight to the minimum necessary shell or host tools")) {
      throw new Error("expected server instructions to mention direct execution for execution-first tasks");
    }
    if (!serverInstructions?.includes("preflight_operation_scope({ project_root")) {
      throw new Error("expected server instructions to mention preflight_operation_scope with project_root");
    }
    if (!serverInstructions?.includes("current_constraints")) {
      throw new Error("expected server instructions to mention current_constraints");
    }
    if (!serverInstructions?.includes("stale_default_conflict/operation_constraint_conflict")) {
      throw new Error("expected server instructions to mention generic operation conflict warnings");
    }
    if (!serverInstructions?.includes("quality_signals.relevant_fix_patterns")) {
      throw new Error("expected server instructions to mention advisory fix pattern quality signals");
    }
    if (!serverInstructions?.includes("VectorMind does not infer fix patterns automatically")) {
      throw new Error("expected server instructions to say fix patterns are explicit only");
    }
    if (!serverInstructions?.includes("prefix shell commands with the command returned by detect_rtk")) {
      throw new Error("expected server instructions to mention detect_rtk returned command prefixes");
    }
    if (!serverInstructions?.includes("VectorMind's bundled RTK shim")) {
      throw new Error("expected server instructions to mention the bundled RTK shim fallback");
    }
    if (!serverInstructions?.includes("install_rtk")) {
      throw new Error("expected server instructions to mention install_rtk");
    }
    if (!serverInstructions?.includes("dry_run=true")) {
      throw new Error("expected server instructions to mention dry-run rtk installation");
    }
    if (!serverInstructions?.includes("get_token_savings")) {
      throw new Error("expected server instructions to mention get_token_savings");
    }
    if (!serverInstructions?.includes("Optional low-risk diagnostics")) {
      throw new Error("expected server instructions to mention optional low-risk diagnostics");
    }
    if (!serverInstructions?.includes("must not expand the current requirement or replace model judgment")) {
      throw new Error("expected diagnostic instructions to preserve model autonomy and requirement boundary");
    }
  } catch (err) {
    console.error("\n[smoke] server instructions check failed:", err);
    process.exitCode = 1;
    return;
  }

  const syncWithoutRequirement = await client.callTool({
    name: "sync_change_intent",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: verify no-active-requirement hint includes project_root",
      files: ["vm_smoke_test.md"],
    },
  });
  console.log("\n--- sync_change_intent (no active requirement) ---\n");
  const syncWithoutRequirementText = readText(syncWithoutRequirement);
  console.log(syncWithoutRequirementText);
  try {
    const parsed = JSON.parse(syncWithoutRequirementText);
    if (parsed?.ok !== false) {
      throw new Error("expected sync_change_intent without active requirement to fail");
    }
    if (!String(parsed?.error ?? "").includes("start_requirement({ project_root, title, background })")) {
      throw new Error("expected no-active-requirement error to include project_root call shape");
    }
  } catch (err) {
    console.error("\n[smoke] no-active-requirement hint check failed:", err);
    process.exitCode = 1;
    return;
  }

  const req = await client.callTool({
    name: "start_requirement",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      title: "VectorMind smoke test",
      background: "basic end-to-end flow",
    },
  });
  console.log("\n--- start_requirement ---\n");
  console.log(readText(req));

  const operationDecision = await client.callTool({
    name: "upsert_decision",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      key: "smoke-operation-current-rule",
      title: "Smoke operation current rule",
      content: "Current operation rule: do not use legacy-default pipeline for release smoke operations; use the current-target path instead.",
      tags: ["smoke", "operation"],
    },
  });
  console.log("\n--- upsert_decision (operation rule) ---\n");
  console.log(readText(operationDecision));

  const operationPreflight = await client.callTool({
    name: "preflight_operation_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      operation: "release smoke operation",
      intent: "run release using the legacy-default pipeline",
      commands: ["node scripts/release.mjs --target legacy-default"],
      script_hints: ["script has default legacy-default pipeline fallback"],
      targets: ["legacy-default"],
      format: "json",
    },
  });
  console.log("\n--- preflight_operation_scope (stale default conflict) ---\n");
  const operationPreflightText = readText(operationPreflight);
  console.log(operationPreflightText);
  try {
    const parsed = JSON.parse(operationPreflightText);
    const warnings = parsed?.warnings ?? [];
    if (parsed?.safe_to_proceed !== false || parsed?.ok !== false) {
      throw new Error("expected operation preflight to block stale default conflict");
    }
    if (
      parsed?.advisory_only !== true ||
      parsed?.read_only !== true ||
      parsed?.does_not_control_host_runtime !== true ||
      parsed?.does_not_replace_model_judgment !== true
    ) {
      throw new Error("expected operation preflight to expose advisory-only/non-runtime-control metadata");
    }
    if (!Array.isArray(parsed?.current_constraints) || parsed.current_constraints.length === 0) {
      throw new Error("expected operation preflight to return current_constraints");
    }
    if (!warnings.some((w) => w?.code === "stale_default_conflict")) {
      throw new Error("expected stale_default_conflict warning");
    }
  } catch (err) {
    console.error("\n[smoke] operation preflight check failed:", err);
    process.exitCode = 1;
    return;
  }

  const operationAlignedPreflight = await client.callTool({
    name: "preflight_operation_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      operation: "release smoke operation",
      intent: "run release using the current-target path",
      commands: ["node scripts/release.mjs --target current-target"],
      script_hints: ["script has explicit target current-target"],
      targets: ["current-target"],
      format: "json",
    },
  });
  console.log("\n--- preflight_operation_scope (aligned current target) ---\n");
  const operationAlignedPreflightText = readText(operationAlignedPreflight);
  console.log(operationAlignedPreflightText);
  try {
    const parsed = JSON.parse(operationAlignedPreflightText);
    const warnings = parsed?.warnings ?? [];
    if (parsed?.safe_to_proceed !== true || parsed?.ok !== true) {
      throw new Error("expected aligned operation preflight to proceed");
    }
    if (warnings.some((w) => w?.code === "stale_default_conflict" || w?.code === "operation_constraint_conflict")) {
      throw new Error("expected aligned operation not to trigger stale/default or negated-constraint conflict");
    }
  } catch (err) {
    console.error("\n[smoke] aligned operation preflight check failed:", err);
    process.exitCode = 1;
    return;
  }

  const preflightMissingContract = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: verify pre-edit scope contract is required",
      files: ["vm_smoke_test.md"],
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (missing scope contract) ---\n");
  const preflightMissingContractText = readText(preflightMissingContract);
  console.log(preflightMissingContractText);
  try {
    const parsed = JSON.parse(preflightMissingContractText);
    const warnings = parsed?.development_warnings;
    if (parsed?.safe_to_edit !== false || parsed?.ok !== false) {
      throw new Error("expected preflight_change_scope without scope contract to block editing");
    }
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "scope_contract_missing")) {
      throw new Error("expected preflight_change_scope to include scope_contract_missing warning");
    }
  } catch (err) {
    console.error("\n[smoke] missing scope contract preflight check failed:", err);
    process.exitCode = 1;
    return;
  }

  const rtk = await client.callTool({
    name: "detect_rtk",
    arguments: useToolProjectRoot ? { project_root: toolProjectRoot } : {},
  });
  console.log("\n--- detect_rtk ---\n");
  const rtkText = readText(rtk);
  console.log(rtkText);
  if (!rtkText.includes("rtk ") || !rtkText.includes("command=") && !rtkText.includes("rtk unavailable:")) {
    console.error("\n[smoke] expected detect_rtk to return an rtk status line");
    process.exitCode = 1;
    return;
  }

  const rtkInstallPlan = await client.callTool({
    name: "install_rtk",
    arguments: useToolProjectRoot ? { project_root: toolProjectRoot } : {},
  });
  console.log("\n--- install_rtk (dry_run) ---\n");
  const rtkInstallPlanText = readText(rtkInstallPlan);
  console.log(rtkInstallPlanText);
  if (!rtkInstallPlanText.includes("install_rtk ok=true dry_run=true") || !rtkInstallPlanText.includes("rtk gain")) {
    console.error("\n[smoke] expected install_rtk dry-run output to include planned verification commands");
    process.exitCode = 1;
    return;
  }

  await new Promise((r) => setTimeout(r, 1000));

  const token = `VM_SMOKE_${Date.now()}`;
  const testPath = path.join(toolProjectRoot, "vm_smoke_test.md");
  const skillPath = path.join(codexHome, "skills", "vm-smoke-skill", "SKILL.md");
  const promptPath = path.join(codexHome, "prompts", "vm-smoke-prompt.md");
  fs.writeFileSync(testPath, `# Smoke\n\n${token}\n\nThis file should be indexed.\n`);
  fs.writeFileSync(skillPath, `---\nname: vm-smoke-skill\n---\n\n# Smoke Skill\n\n${token}\n`);
  fs.writeFileSync(promptPath, `Smoke prompt token: ${token}\n`);

  await new Promise((r) => setTimeout(r, 1000));

  const pending1 = await client.callTool({
    name: "get_pending_changes",
    arguments: useToolProjectRoot ? { project_root: toolProjectRoot } : {},
  });
  console.log("\n--- get_pending_changes (before) ---\n");
  console.log(readText(pending1));

  const sync = await client.callTool({
    name: "sync_change_intent",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: `smoke: created/changed vm_smoke_test.md (${token})`,
    },
  });
  console.log("\n--- sync_change_intent (auto-link pending) ---\n");
  console.log(readText(sync));

  if (!(await runQualityGuardCases({ client, useToolProjectRoot, toolProjectRoot, readText }))) return;

  const outsideProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-outside-project-"));
  const outsideProjectFile = path.join(outsideProjectDir, "outside.ts");
  fs.writeFileSync(outsideProjectFile, "export const outsideProjectToken = true;\n");
  const grepOutside = await client.callTool({
    name: "grep",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "outsideProjectToken",
      mode: "literal",
      include_paths: [outsideProjectFile],
      max_results: 5,
      format: "json",
    },
  });
  console.log("\n--- grep (cross-project path warning) ---\n");
  const grepOutsideText = readText(grepOutside);
  console.log(grepOutsideText);
  try {
    const parsed = JSON.parse(grepOutsideText);
    const warnings = parsed?.development_warnings;
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "cross_project_path")) {
      throw new Error("expected grep to include cross_project_path development warning");
    }
  } catch (err) {
    console.error("\n[smoke] grep cross-project development warning check failed:", err);
    process.exitCode = 1;
    return;
  }

  const secondProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-second-project-"));
  fs.writeFileSync(path.join(secondProjectRoot, "package.json"), JSON.stringify({ name: "vm-second-project" }));
  const bootSecondProject = await client.callTool({
    name: "bootstrap_context",
    arguments: {
      project_root: secondProjectRoot,
      query: "smoke: verify cross-project advisory",
      format: "json",
    },
  });
  console.log("\n--- bootstrap_context (cross-project advisory) ---\n");
  const bootSecondProjectText = readText(bootSecondProject);
  console.log(bootSecondProjectText);
  try {
    const parsed = JSON.parse(bootSecondProjectText);
    const advisory = parsed?.project_context_advisory;
    if (advisory?.code !== "cross_project_reference" || advisory?.read_only_reference !== true) {
      throw new Error("expected project_context_advisory cross_project_reference read_only_reference=true");
    }
  } catch (err) {
    console.error("\n[smoke] cross-project advisory check failed:", err);
    process.exitCode = 1;
    return;
  }

  const bootBackProject = await client.callTool({
    name: "bootstrap_context",
    arguments: {
      project_root: toolProjectRoot,
      query: "smoke: switch back after cross-project advisory",
      format: "json",
    },
  });
  console.log("\n--- bootstrap_context (switch back after cross-project advisory) ---\n");
  console.log(readText(bootBackProject));

  const scopeReq = await client.callTool({
    name: "start_requirement",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      title: "Add billing export",
      background: "Add a billing export endpoint and small report helper.",
      allowed_paths: ["src/billing/**"],
      requirement_items: ["Add a billing export endpoint.", "Add a small report helper."],
    },
  });
  console.log("\n--- start_requirement (scope contract) ---\n");
  const scopeReqText = readText(scopeReq);
  console.log(scopeReqText);

  const preflightMappingMissing = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: add billing export endpoint",
      files: ["src/billing/export.ts"],
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (requirement mapping missing) ---\n");
  const preflightMappingMissingText = readText(preflightMappingMissing);
  console.log(preflightMappingMissingText);
  try {
    const parsed = JSON.parse(preflightMappingMissingText);
    const warnings = parsed?.development_warnings;
    if (parsed?.safe_to_edit !== false || parsed?.ok !== false) {
      throw new Error("expected missing requirement mapping to block editing");
    }
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "requirement_mapping_missing")) {
      throw new Error("expected requirement_mapping_missing warning");
    }
  } catch (err) {
    console.error("\n[smoke] requirement mapping missing check failed:", err);
    process.exitCode = 1;
    return;
  }

  const preflightMappingOk = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: add billing export endpoint",
      files: ["src/billing/export.ts"],
      planned_changes: [{ file: "src/billing/export.ts", change: "Add billing export endpoint.", requirement_refs: ["1"] }],
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (requirement mapping ok) ---\n");
  const preflightMappingOkText = readText(preflightMappingOk);
  console.log(preflightMappingOkText);
  try {
    const parsed = JSON.parse(preflightMappingOkText);
    const warnings = parsed?.development_warnings ?? [];
    if (parsed?.safe_to_edit !== true || parsed?.ok !== true) {
      throw new Error("expected mapped requirement change to be safe");
    }
    if (warnings.some((w) => w?.code === "requirement_mapping_missing")) {
      throw new Error("expected mapped requirement change not to warn");
    }
  } catch (err) {
    console.error("\n[smoke] requirement mapping ok check failed:", err);
    process.exitCode = 1;
    return;
  }

  const preflightMappingUnmappedFile = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: verify every target file is mapped",
      files: ["src/billing/export.ts", "src/billing/extra.ts"],
      planned_changes: [{ file: "src/billing/export.ts", change: "Add billing export endpoint.", requirement_refs: ["1"] }],
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (requirement mapping unmapped file) ---\n");
  const preflightMappingUnmappedFileText = readText(preflightMappingUnmappedFile);
  console.log(preflightMappingUnmappedFileText);
  try {
    const parsed = JSON.parse(preflightMappingUnmappedFileText);
    const warnings = parsed?.development_warnings ?? [];
    if (parsed?.safe_to_edit !== false || parsed?.ok !== false) {
      throw new Error("expected unmapped target file to block editing");
    }
    if (!warnings.some((w) => w?.code === "requirement_mapping_missing" && Array.isArray(w?.details?.unmapped_files) && w.details.unmapped_files.includes("src/billing/extra.ts"))) {
      throw new Error("expected requirement_mapping_missing with unmapped_files");
    }
  } catch (err) {
    console.error("\n[smoke] requirement mapping unmapped file check failed:", err);
    process.exitCode = 1;
    return;
  }

  const preflightMappingSupporting = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: add billing export test support",
      files: ["src/billing/export.test.ts"],
      planned_changes: [
        {
          file: "src/billing/export.test.ts",
          change: "Add test coverage for the billing export endpoint.",
          supporting_change: true,
          change_type: "test",
        },
      ],
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (requirement mapping supporting change) ---\n");
  const preflightMappingSupportingText = readText(preflightMappingSupporting);
  console.log(preflightMappingSupportingText);
  try {
    const parsed = JSON.parse(preflightMappingSupportingText);
    const warnings = parsed?.development_warnings ?? [];
    if (parsed?.safe_to_edit !== true || parsed?.ok !== true) {
      throw new Error("expected supporting change to be safe");
    }
    if (warnings.some((w) => w?.code === "requirement_mapping_missing")) {
      throw new Error("expected supporting change not to warn");
    }
  } catch (err) {
    console.error("\n[smoke] requirement mapping supporting change check failed:", err);
    process.exitCode = 1;
    return;
  }

  const preflightScopeDrift = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: add billing export helper",
      files: ["src/notifications/email.ts"],
      format: "json",
    },
  });
  console.log("\n--- preflight_change_scope (scope drift warning) ---\n");
  const preflightScopeDriftText = readText(preflightScopeDrift);
  console.log(preflightScopeDriftText);
  try {
    const parsed = JSON.parse(preflightScopeDriftText);
    const warnings = parsed?.development_warnings;
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "scope_drift")) {
      throw new Error("expected preflight_change_scope to include scope_drift development warning");
    }
  } catch (err) {
    console.error("\n[smoke] preflight scope drift development warning check failed:", err);
    process.exitCode = 1;
    return;
  }

  const outOfScopeModulePath = path.join(toolProjectRoot, "src", "notifications", "email.ts");
  fs.mkdirSync(path.dirname(outOfScopeModulePath), { recursive: true });
  fs.writeFileSync(
    outOfScopeModulePath,
    [
      "export function sendBillingExportSmokeEmail() {",
      "  return true;",
      "}",
      "",
    ].join("\n"),
  );
  await new Promise((r) => setTimeout(r, 1000));
  const syncScopeDrift = await client.callTool({
    name: "sync_change_intent",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: add billing export helper",
      files: ["src/notifications/email.ts"],
    },
  });
  console.log("\n--- sync_change_intent (scope drift warning) ---\n");
  const syncScopeDriftText = readText(syncScopeDrift);
  console.log(syncScopeDriftText);
  try {
    const parsed = JSON.parse(syncScopeDriftText);
    const warnings = parsed?.development_warnings;
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "scope_drift")) {
      throw new Error("expected sync_change_intent to include scope_drift development warning");
    }
  } catch (err) {
    console.error("\n[smoke] scope drift development warning check failed:", err);
    process.exitCode = 1;
    return;
  }

  const scopedRequirementMemoryId = (() => {
    try {
      return JSON.parse(scopeReqText)?.memory_item?.id;
    } catch {
      return null;
    }
  })();
  const closeScopedReq = await client.callTool({
    name: "start_requirement",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      title: "Close scoped smoke requirement",
      background: "Close previous scoped requirement to verify requirement metadata status patching.",
    },
  });
  console.log("\n--- start_requirement (close scoped previous) ---\n");
  console.log(readText(closeScopedReq));
  if (scopedRequirementMemoryId) {
    const scopedRequirementMemory = await client.callTool({
      name: "read_memory_item",
      arguments: {
        ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
        id: scopedRequirementMemoryId,
      },
    });
    console.log("\n--- read_memory_item (closed scoped requirement metadata) ---\n");
    const scopedRequirementMemoryText = readText(scopedRequirementMemory);
    console.log(scopedRequirementMemoryText);
    try {
      const parsed = JSON.parse(scopedRequirementMemoryText);
      const meta = JSON.parse(parsed?.item?.metadata_json ?? "{}");
      if (meta.status !== "completed") {
        throw new Error(`expected completed metadata status, got ${meta.status}`);
      }
      if (!Array.isArray(meta.scope_contract?.allowed_paths) || !meta.scope_contract.allowed_paths.includes("src/billing/**")) {
        throw new Error("expected completed requirement memory to preserve scope_contract.allowed_paths");
      }
      if (!Array.isArray(meta.requirement_items) || meta.requirement_items.length !== 2) {
        throw new Error("expected completed requirement memory to preserve requirement_items");
      }
    } catch (err) {
      console.error("\n[smoke] completed requirement metadata preservation check failed:", err);
      process.exitCode = 1;
      return;
    }
  }

  if (!(await runMemoryRecallCases({ client, useToolProjectRoot, toolProjectRoot, testPath, token, readText }))) return;

  if (!(await runFileToolCases({ client, useToolProjectRoot, toolProjectRoot, token, skillPath, readText }))) return;

  if (!(await runMaintenanceCases({ client, useToolProjectRoot, toolProjectRoot, token, testPath, keepFiles, inPlace, readText }))) return;

}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await transport.close();
    } catch {}
    if (!keepFiles && useToolProjectRoot) {
      try {
        fs.rmSync(toolProjectRoot, { recursive: true, force: true });
      } catch {}
    }
    if (!keepFiles) {
      try {
        fs.rmSync(codexHome, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(agentsHome, { recursive: true, force: true });
      } catch {}
    }
    if (!keepFiles && !inPlace) {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {}
    }
  });
