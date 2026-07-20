import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runFileToolCases } from "./smoke/file-tool-cases.mjs";
import { runMaintenanceCases } from "./smoke/maintenance-cases.mjs";
import { runMemoryRecallCases } from "./smoke/memory-recall-cases.mjs";
import { runQualityGuardCases } from "./smoke/quality-guard-cases.mjs";
import { runContextGovernanceCases } from "./smoke/context-governance-cases.mjs";
import { runSyncRegressionCases } from "./smoke/sync-regression-cases.mjs";
import { runStorageRegressionCases } from "./smoke/storage-regression-cases.mjs";
import { listToolDefinitions } from "../dist/tool-catalog.js";
import { filterFocusedSemanticResult } from "../dist/context-governance.js";
import { compactBootstrapText, compactSemanticSearchText } from "../dist/tool-output.js";
import { openDatabaseRuntime } from "../dist/database-runtime.js";
import { boundToolResult, enqueueToolCall } from "../dist/tool-handlers.js";

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
  VECTORMIND_TOOL_PROFILE: "full",
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
    const previousToolProfile = process.env.VECTORMIND_TOOL_PROFILE;
    delete process.env.VECTORMIND_TOOL_PROFILE;
    const coreToolDefinitions = await listToolDefinitions();
    const coreToolNames = coreToolDefinitions.tools.map((tool) => tool.name);
    const coreToolPayloadChars = JSON.stringify(coreToolDefinitions).length;
    if (previousToolProfile === undefined) delete process.env.VECTORMIND_TOOL_PROFILE;
    else process.env.VECTORMIND_TOOL_PROFILE = previousToolProfile;
    const expectedCoreTools = [
      "bootstrap_context",
      "start_requirement",
      "get_requirement_status",
      "resume_requirement",
      "preflight_change_scope",
      "plan_large_file_split",
      "record_large_file_split",
      "sync_change_intent",
      "update_requirement_verification",
      "preflight_operation_scope",
      "read_memory_item",
      "upsert_decision",
      "supersede_memory",
      "complete_requirement",
    ];
    if (JSON.stringify(coreToolNames) !== JSON.stringify(expectedCoreTools)) {
      throw new Error(`unexpected core tool profile: ${JSON.stringify(coreToolNames)}`);
    }
    if (coreToolPayloadChars > 50_000) {
      throw new Error(`expected bounded default core tool metadata, got ${coreToolPayloadChars} chars`);
    }
    const preflightBehavior = coreToolDefinitions.tools.find((tool) => tool.name === "preflight_change_scope")
      ?._meta?.["vectormind/behavior"];
    if (preflightBehavior?.workflow_gate !== true || preflightBehavior?.advisory_only !== false) {
      throw new Error("expected preflight_change_scope metadata to distinguish its conditional workflow gate from advisory tools");
    }
    const queueOrder = [];
    await Promise.all([
      enqueueToolCall(async () => {
        queueOrder.push("a:start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        queueOrder.push("a:end");
      }),
      enqueueToolCall(async () => {
        queueOrder.push("b:start");
        queueOrder.push("b:end");
      }),
    ]);
    if (queueOrder.join(",") !== "a:start,a:end,b:start,b:end") {
      throw new Error(`expected MCP tool calls to serialize across project-root switches, got ${queueOrder.join(",")}`);
    }

    const previousMaxToolOutput = process.env.VECTORMIND_MAX_TOOL_OUTPUT_CHARS;
    process.env.VECTORMIND_MAX_TOOL_OUTPUT_CHARS = "4000";
    const boundedJsonResult = boundToolResult("smoke_large_json", {
      content: [{ type: "text", text: JSON.stringify({ ok: true, payload: "x".repeat(5000) }) }],
    });
    if (previousMaxToolOutput === undefined) delete process.env.VECTORMIND_MAX_TOOL_OUTPUT_CHARS;
    else process.env.VECTORMIND_MAX_TOOL_OUTPUT_CHARS = previousMaxToolOutput;
    const boundedJson = JSON.parse(readText(boundedJsonResult));
    if (boundedJsonResult.isError === true || boundedJson?.ok !== true || boundedJson?.output_truncated !== true || readText(boundedJsonResult).length >= 4000) {
      throw new Error("expected oversized successful structured output to remain a bounded success");
    }

    const migrationRoot = path.join(runDir, "migration-project");
    fs.mkdirSync(migrationRoot, { recursive: true });
    const initialRuntime = openDatabaseRuntime(migrationRoot);
    const migrationDbPath = initialRuntime.dbPath;
    initialRuntime.db.close();
    const legacyDb = new Database(migrationDbPath);
    legacyDb.prepare("DELETE FROM meta_kv WHERE key = ?").run("migration:aggregate_change_records:v1");
    legacyDb.exec("DROP INDEX IF EXISTS idx_requirements_active_goal_key_unique");
    const older = legacyDb.prepare("INSERT INTO requirements (title, context_data, goal_key, status) VALUES (?, ?, ?, 'active')")
      .run("Legacy duplicate older", "old", "legacy-duplicate-goal");
    legacyDb.prepare("INSERT INTO requirements (title, context_data, goal_key, status) VALUES (?, ?, ?, 'active')")
      .run("Legacy duplicate newer", "new", "legacy-duplicate-goal");
    legacyDb.prepare("INSERT INTO memory_items (kind, title, content, req_id, metadata_json, content_hash) VALUES ('requirement', ?, ?, ?, ?, ?)")
      .run("Legacy duplicate older", "old", Number(older.lastInsertRowid), JSON.stringify({ status: "active" }), "legacy-duplicate-hash");
    const legitimateTimestamp = "2026-01-01 00:00:00";
    for (const [index, filePath] of ["src/retry-a.ts", "src/retry-b.ts"].entries()) {
      legacyDb.prepare(
        "INSERT INTO change_logs (req_id, file_path, intent_summary, files_json, file_count, timestamp) VALUES (?, ?, ?, ?, 1, ?)",
      ).run(
        Number(older.lastInsertRowid),
        filePath,
        "Legitimate repeated sync",
        JSON.stringify([{ file_path: filePath, event: "manual", source: "args", file_state_hash: `hash-${index}` }]),
        legitimateTimestamp,
      );
      legacyDb.prepare(
        "INSERT INTO memory_items (kind, title, content, file_path, req_id, metadata_json, content_hash, updated_at) VALUES ('change_intent', ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "Legitimate repeated sync",
        "Legitimate repeated sync",
        filePath,
        Number(older.lastInsertRowid),
        JSON.stringify({ files: [{ file_path: filePath, file_state_hash: `hash-${index}` }] }),
        `legitimate-${index}`,
        `2026-01-01 00:00:0${index}`,
      );
    }
    legacyDb.close();
    const migratedRuntime = openDatabaseRuntime(migrationRoot);
    const migrated = migratedRuntime.db.prepare(`
      SELECT r.status, m.metadata_json
      FROM requirements r
      JOIN memory_items m ON m.req_id = r.id AND m.kind = 'requirement'
      WHERE r.id = ?
    `).get(Number(older.lastInsertRowid));
    const legitimateChangeLogs = migratedRuntime.db.prepare(
      "SELECT COUNT(*) AS count FROM change_logs WHERE req_id = ? AND intent_summary = ?",
    ).get(Number(older.lastInsertRowid), "Legitimate repeated sync");
    const legitimateChangeIntents = migratedRuntime.db.prepare(
      "SELECT COUNT(*) AS count FROM memory_items WHERE kind = 'change_intent' AND req_id = ? AND content = ?",
    ).get(Number(older.lastInsertRowid), "Legitimate repeated sync");
    const preservedSyncedState = migratedRuntime.db.prepare(
      "SELECT updated_at FROM synced_file_states WHERE file_path = ?",
    ).get("src/retry-a.ts");
    migratedRuntime.db.close();
    if (migrated?.status !== "superseded" || JSON.parse(migrated?.metadata_json ?? "{}")?.status !== "superseded") {
      throw new Error("expected duplicate active-goal migration to supersede both requirement and requirement memory metadata");
    }
    if (
      Number(legitimateChangeLogs?.count ?? 0) !== 2 ||
      Number(legitimateChangeIntents?.count ?? 0) !== 2 ||
      preservedSyncedState?.updated_at !== "2026-01-01 00:00:00"
    ) {
      throw new Error("expected aggregate-format repeated sync history and original synced-state timestamps to survive migration");
    }
    const fallbackSemantic = filterFocusedSemanticResult("billing export", {
      query: "billing export",
      top_k: 3,
      mode: "token",
      matches: [{ score: 1, item: { id: 1, kind: "note", title: "Typography history", preview: "Unrelated palette note." } }],
    });
    if (!fallbackSemantic?.focused_no_match || fallbackSemantic.matches.length !== 0 || !compactSemanticSearchText(fallbackSemantic).includes("no query-relevant memory")) {
      throw new Error("expected focused semantic filtering to return no unrelated fallback memory");
    }
    const compactFallbackBootstrap = compactBootstrapText({
      generated_at: new Date().toISOString(),
      project_root: runDir,
      root_source: "tool_arg",
      watcher_enabled: false,
      watcher_ready: false,
      project_summary: null,
      decisions: [],
      conventions: [],
      current_constraints: [],
      current_context: [],
      recent_notes: [],
      pending_total: 0,
      pending_offset: 0,
      pending_limit: 10,
      pending_truncated: false,
      pending_changes: [],
      items: [],
      semantic: fallbackSemantic,
    });
    if (!compactFallbackBootstrap.includes("no query-relevant memory passed focused filtering")) {
      throw new Error("expected bootstrap compact output to state that focused recall found no relevant memory");
    }
    const coreEnv = { ...env };
    delete coreEnv.VECTORMIND_TOOL_PROFILE;
    const coreTransport = new StdioClientTransport({
      command: "node",
      args: [serverEntry],
      cwd: runDir,
      env: coreEnv,
      stderr: "inherit",
    });
    const coreClient = new Client({ name: "vectormind-core-profile-smoke", version: "0.0.0" }, { capabilities: {} });
    await coreClient.connect(coreTransport);
    try {
      const actualCoreTools = (await coreClient.listTools()).tools.map((tool) => tool.name);
      if (JSON.stringify(actualCoreTools) !== JSON.stringify(expectedCoreTools)) {
        throw new Error(`unexpected default MCP server tool profile: ${JSON.stringify(actualCoreTools)}`);
      }
    } finally {
      await coreClient.close();
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
    if (!serverInstructions.includes("never run a concrete operation first") ||
        !serverInstructions.includes("deploy/publish/build/test/migrate/service/git/batch")) {
      throw new Error("expected server instructions to require operation preflight before the first concrete command");
    }
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
    "update_requirement_verification",
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
    const verificationUpdateTool = byName.get("update_requirement_verification");
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
    if (verificationUpdateTool?.annotations?.readOnlyHint !== false ||
        !verificationUpdateTool?._meta?.["vectormind/behavior"]?.tags?.includes("verification_evidence")) {
      throw new Error("expected update_requirement_verification to be a verification-evidence write tool");
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
    if (!serverInstructions || serverInstructions.length > 800) {
      throw new Error(`expected minimal server instructions <=800 chars, got ${serverInstructions?.length ?? 0}`);
    }
    for (const requiredTerm of [
      "always pass project_root",
      "bounded evidence",
      "directly observed repository facts win over stale memory",
      "compact/focused defaults",
      "core tool profile minimizes schema load",
      "VECTORMIND_TOOL_PROFILE=full",
      "Each tool description defines its own lifecycle",
    ]) {
      if (!serverInstructions.toLocaleLowerCase().includes(requiredTerm.toLocaleLowerCase())) {
        throw new Error(`expected compact server instructions to include: ${requiredTerm}`);
      }
    }
    for (const forbiddenBloatTerm of [
      "Built-in task-list / Plan-Lite quality policy:",
      "Built-in architecture and code-organization quality policy:",
      "Built-in frontend output-purity quality policy:",
      "页面代码、模板内容",
      "本次更改的内容描述或总结",
      "bootstrap_context",
      "start_requirement",
      "preflight_change_scope",
      "sync_change_intent",
      "12000",
      "30000",
      "RTK",
    ]) {
      if (serverInstructions.includes(forbiddenBloatTerm)) {
        throw new Error(`expected generic policy bloat to stay out of MCP instructions: ${forbiddenBloatTerm}`);
      }
    }
    if (serverInstructions.includes("trust the tool output")) {
      throw new Error("expected server instructions to avoid tool-output-over-model wording");
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
    if (parsed?.safe_to_edit !== true || parsed?.ok !== true) {
      throw new Error("expected missing scope contract to remain advisory when an active requirement exists");
    }
    if (!Array.isArray(warnings) || !warnings.some((w) => w?.code === "scope_contract_missing")) {
      throw new Error("expected preflight_change_scope to include scope_contract_missing warning");
    }
  } catch (err) {
    console.error("\n[smoke] missing scope contract preflight check failed:", err);
    process.exitCode = 1;
    return;
  }
  try {
    const dbPath = path.join(toolProjectRoot, ".vectormind", "vectormind.db");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM mcp_guard_events WHERE tool_name = 'preflight_change_scope' AND event_type = 'scope_contract_guard'")
        .get();
      if (Number(row?.count ?? 0) < 1) {
        throw new Error("expected preflight_change_scope scope_contract_missing warning to persist a guard event");
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error("\n[smoke] persisted MCP guard event check failed:", err);
    process.exitCode = 1;
    return;
  }

  const compactPreflightMissingContract = await client.callTool({
    name: "preflight_change_scope",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: "smoke: verify compact scope contract guard persists",
      files: ["vm_smoke_test.md"],
    },
  });
  console.log("\n--- preflight_change_scope (compact missing scope contract) ---\n");
  const compactPreflightMissingContractText = readText(compactPreflightMissingContract);
  console.log(compactPreflightMissingContractText);
  try {
    if (!/preflight_change_scope ok=true safe_to_edit=true/.test(compactPreflightMissingContractText)) {
      throw new Error("expected compact missing-contract preflight to remain advisory");
    }
    if (!/scope_contract_missing/.test(compactPreflightMissingContractText)) {
      throw new Error("expected compact preflight_change_scope to include scope_contract_missing warning");
    }
    const dbPath = path.join(toolProjectRoot, ".vectormind", "vectormind.db");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS count FROM mcp_guard_events WHERE tool_name = 'preflight_change_scope' AND event_type = 'scope_contract_guard' AND metadata_json LIKE '%\"compact\":true%'",
        )
        .get();
      if (Number(row?.count ?? 0) < 1) {
        throw new Error("expected compact preflight_change_scope warning to persist a guard event");
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error("\n[smoke] compact persisted MCP guard event check failed:", err);
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

  const multiSyncIntent = `smoke: aggregate multi-file sync_change_intent (${token})`;
  const multiSyncFiles = ["vm_multi_a.ts", "vm_multi_b.ts", "./vm_multi_b.ts", "vm_multi_c.ts"];
  for (const filePath of ["vm_multi_a.ts", "vm_multi_b.ts", "vm_multi_c.ts"]) {
    fs.writeFileSync(path.join(toolProjectRoot, filePath), `export const ${filePath.replace(/\W+/g, "_")} = "${token}";\n`);
  }
  const multiSync = await client.callTool({
    name: "sync_change_intent",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      intent: multiSyncIntent,
      files: multiSyncFiles,
    },
  });
  console.log("\n--- sync_change_intent (multi-file aggregate) ---\n");
  const multiSyncText = readText(multiSync);
  console.log(multiSyncText);
  try {
    const parsed = JSON.parse(multiSyncText);
    if (parsed?.ok !== true) throw new Error("expected multi-file sync to succeed");
    if (Number(parsed?.created_change?.file_count ?? 0) !== 3) {
      throw new Error(`expected created_change.file_count=3, got ${parsed?.created_change?.file_count}`);
    }
    if (!Array.isArray(parsed?.created) || parsed.created.length !== 3) {
      throw new Error(`expected exactly 3 deduped created file links, got ${parsed?.created?.length}`);
    }

    const dbPath = path.join(toolProjectRoot, ".vectormind", "vectormind.db");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const changeLogRows = db
        .prepare("SELECT id, file_path, files_json, file_count FROM change_logs WHERE intent_summary = ?")
        .all(multiSyncIntent);
      if (changeLogRows.length !== 1) {
        throw new Error(`expected one change_logs row for multi-file intent, got ${changeLogRows.length}`);
      }
      const filesJson = JSON.parse(changeLogRows[0].files_json ?? "[]");
      if (changeLogRows[0].file_path !== "(multiple)" || Number(changeLogRows[0].file_count ?? 0) !== 3) {
        throw new Error("expected aggregate change_logs row to be marked (multiple) with file_count=3");
      }
      if (!Array.isArray(filesJson) || filesJson.length !== 3) {
        throw new Error(`expected files_json to contain 3 unique files, got ${filesJson.length}`);
      }
      const memoryRows = db
        .prepare("SELECT id, file_path, metadata_json FROM memory_items WHERE kind = 'change_intent' AND content = ?")
        .all(multiSyncIntent);
      if (memoryRows.length !== 1) {
        throw new Error(`expected one change_intent memory row for multi-file intent, got ${memoryRows.length}`);
      }
      const meta = JSON.parse(memoryRows[0].metadata_json ?? "{}");
      if (memoryRows[0].file_path !== null || Number(meta.file_count ?? 0) !== 3 || !Array.isArray(meta.files) || meta.files.length !== 3) {
        throw new Error("expected aggregate change_intent metadata to describe 3 files and use null file_path");
      }
      const syncedStateRows = db
        .prepare("SELECT COUNT(*) AS count FROM synced_file_states WHERE file_path IN ('vm_multi_a.ts','vm_multi_b.ts','vm_multi_c.ts')")
        .get();
      if (Number(syncedStateRows?.count ?? 0) !== 3) {
        throw new Error(`expected 3 synced_file_states rows, got ${syncedStateRows?.count}`);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error("\n[smoke] multi-file sync aggregation check failed:", err);
    process.exitCode = 1;
    return;
  }

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

  const legacyDuplicateIntent = `smoke: repair legacy duplicate change records (${token})`;
  const legacyDbPath = path.join(toolProjectRoot, ".vectormind", "vectormind.db");
  {
    const db = new Database(legacyDbPath);
    try {
      db.prepare("DELETE FROM meta_kv WHERE key = ?").run("migration:aggregate_change_records:v1");
      const reqInfo = db
        .prepare(
          `INSERT INTO requirements (title, status, context_data, created_at, updated_at)
           VALUES ('Legacy duplicate repair smoke', 'completed', 'legacy duplicate repair smoke', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        )
        .run();
      const reqId = Number(reqInfo.lastInsertRowid);
      const timestamp = "2001-01-01 00:00:00";
      const files = ["legacy_dup_a.ts", "legacy_dup_b.ts", "legacy_dup_c.ts"];
      const changeIds = files.map((filePath) =>
        Number(
          db
            .prepare(
              `INSERT INTO change_logs (req_id, file_path, intent_summary, files_json, file_count, timestamp)
               VALUES (?, ?, ?, NULL, 1, ?)`,
            )
            .run(reqId, filePath, legacyDuplicateIntent, timestamp).lastInsertRowid,
        ),
      );
      files.forEach((filePath, index) => {
        db
          .prepare(
            `INSERT INTO memory_items
               (kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at)
             VALUES
               ('change_intent', 'Legacy duplicate repair smoke', ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            legacyDuplicateIntent,
            filePath,
            reqId,
            JSON.stringify({
              change_log_id: changeIds[index],
              event: "manual",
              source: "args",
              file_state_hash: `legacy-hash-${index}`,
            }),
            `legacy-duplicate-hash-${index}`,
            timestamp,
            timestamp,
          );
      });
    } finally {
      db.close();
    }
  }

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
  try {
    const db = new Database(legacyDbPath, { readonly: true, fileMustExist: true });
    try {
      const changeLogRows = db
        .prepare("SELECT id, file_path, files_json, file_count FROM change_logs WHERE intent_summary = ?")
        .all(legacyDuplicateIntent);
      if (changeLogRows.length !== 1) {
        throw new Error(`expected legacy duplicate change_logs to be repaired to 1 row, got ${changeLogRows.length}`);
      }
      const filesJson = JSON.parse(changeLogRows[0].files_json ?? "[]");
      if (changeLogRows[0].file_path !== "(multiple)" || Number(changeLogRows[0].file_count ?? 0) !== 3 || filesJson.length !== 3) {
        throw new Error("expected repaired legacy change_logs row to contain 3 files");
      }
      const memoryRows = db
        .prepare("SELECT id, file_path, metadata_json FROM memory_items WHERE kind = 'change_intent' AND content = ?")
        .all(legacyDuplicateIntent);
      if (memoryRows.length !== 1) {
        throw new Error(`expected legacy duplicate change_intent memory to be repaired to 1 row, got ${memoryRows.length}`);
      }
      const meta = JSON.parse(memoryRows[0].metadata_json ?? "{}");
      if (memoryRows[0].file_path !== null || Number(meta.file_count ?? 0) !== 3 || !Array.isArray(meta.files) || meta.files.length !== 3) {
        throw new Error("expected repaired legacy change_intent metadata to contain 3 files");
      }
      const syncedStateRows = db
        .prepare("SELECT COUNT(*) AS count FROM synced_file_states WHERE file_path IN ('legacy_dup_a.ts','legacy_dup_b.ts','legacy_dup_c.ts')")
        .get();
      if (Number(syncedStateRows?.count ?? 0) !== 3) {
        throw new Error(`expected repaired legacy change_intent to backfill 3 synced file states, got ${syncedStateRows?.count}`);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error("\n[smoke] legacy duplicate change-record repair check failed:", err);
    process.exitCode = 1;
    return;
  }

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
    if (parsed?.safe_to_edit !== true || parsed?.ok !== true) {
      throw new Error("expected missing requirement mapping to remain advisory");
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
    if (parsed?.safe_to_edit !== true || parsed?.ok !== true) {
      throw new Error("expected unmapped target file to remain advisory");
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
      close_previous: true,
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

  if (!(await runContextGovernanceCases({ client, useToolProjectRoot, toolProjectRoot, readText }))) return;

  if (!(await runSyncRegressionCases({ client, useToolProjectRoot, toolProjectRoot, readText }))) return;

  if (!(await runMemoryRecallCases({ client, useToolProjectRoot, toolProjectRoot, testPath, token, readText }))) return;

  if (!(await runFileToolCases({ client, useToolProjectRoot, toolProjectRoot, token, skillPath, readText }))) return;

  if (!(await runMaintenanceCases({ client, useToolProjectRoot, toolProjectRoot, token, testPath, keepFiles, inPlace, readText }))) return;

  if (!(await runStorageRegressionCases())) return;

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
