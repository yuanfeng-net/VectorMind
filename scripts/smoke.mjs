import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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

const embeddings = (getFlag("embeddings") ?? "off").toLowerCase();
const enableEmbeddings = embeddings === "on" || embeddings === "true" || embeddings === "1";

const allowRemoteModels = (getFlag("allow-remote-models") ?? "true").toLowerCase();
const keepFiles = hasFlag("keep-files");
const inPlace = hasFlag("in-place");
const useToolProjectRoot = hasFlag("use-tool-project-root");

const env = {
  ...process.env,
  VECTORMIND_EMBEDDINGS: enableEmbeddings ? "on" : "off",
  VECTORMIND_ALLOW_REMOTE_MODELS: allowRemoteModels,
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(scriptDir, "..", "dist", "index.js");
const rtkShimEntry = path.resolve(scriptDir, "..", "dist", "rtk-shim.js");

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
  for (const toolName of ["detect_rtk", "install_rtk", "get_token_savings", "maintain_memory"]) {
    if (!toolList.tools.some((t) => t.name === toolName)) {
      console.error(`\n[smoke] expected tool list to include ${toolName}`);
      process.exitCode = 1;
      return;
    }
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
    if (!serverInstructions?.includes("Do not add extra business behavior")) {
      throw new Error("expected server instructions to include no-extra-demand guidance");
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
    if (!serverInstructions?.includes("list_project_files({ path, recursive?, max_depth? })")) {
      throw new Error("expected server instructions to recommend list_project_files");
    }
    if (!serverInstructions?.includes("read_file_text({ path, offset?, max_chars? })")) {
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
  } catch (err) {
    console.error("\n[smoke] server instructions check failed:", err);
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
  console.log(readText(note));

  if (enableEmbeddings) {
    console.log("\n(waiting a bit for background embedding...)\n");
    await new Promise((r) => setTimeout(r, 8000));
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
    if (enableEmbeddings !== true && !["fts", "like", "token", "hybrid"].includes(parsed?.mode)) {
      throw new Error(`expected mode to be fts/like/token/hybrid when embeddings are off (got ${parsed?.mode})`);
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
  } catch (err) {
    console.error("\n[smoke] current_context check failed:", err);
    process.exitCode = 1;
    return;
  }

  const listFiles = await client.callTool({
    name: "list_project_files",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      path: ".",
      recursive: true,
      max_depth: 2,
      include_files: true,
      include_dirs: false,
      max_results: 50,
      include_paths: ["vm_smoke_test.md"],
    },
  });
  console.log("\n--- list_project_files (compact) ---\n");
  const listFilesText = readText(listFiles);
  console.log(listFilesText);
  if (!listFilesText.includes("files path=") || !listFilesText.includes("vm_smoke_test.md")) {
    console.error("\n[smoke] expected default list_project_files output to be compact text");
    process.exitCode = 1;
    return;
  }

  const listFilesJson = await client.callTool({
    name: "list_project_files",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      path: ".",
      recursive: true,
      max_depth: 2,
      include_files: true,
      include_dirs: false,
      max_results: 50,
      include_paths: ["vm_smoke_test.md"],
      format: "json",
    },
  });
  console.log("\n--- list_project_files (json) ---\n");
  const listFilesJsonText = readText(listFilesJson);
  console.log(listFilesJsonText);
  try {
    const parsed = JSON.parse(listFilesJsonText);
    if (parsed?.ok !== true) throw new Error("expected ok=true from list_project_files");
    const entries = parsed?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("expected list_project_files to return at least 1 entry");
    }
    if (!entries.some((e) => e?.path === "vm_smoke_test.md" && e?.kind === "file")) {
      throw new Error("expected list_project_files entries to contain vm_smoke_test.md");
    }
  } catch (err) {
    console.error("\n[smoke] list_project_files check failed:", err);
    process.exitCode = 1;
    return;
  }

  const readTextResult = await client.callTool({
    name: "read_file_text",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      path: "vm_smoke_test.md",
      max_chars: 1000,
    },
  });
  console.log("\n--- read_file_text (compact) ---\n");
  const readTextResultText = readText(readTextResult);
  console.log(readTextResultText);
  if (!readTextResultText.includes("file vm_smoke_test.md") || !readTextResultText.includes(token)) {
    console.error("\n[smoke] expected default read_file_text output to be compact text");
    process.exitCode = 1;
    return;
  }

  const readTextResultJson = await client.callTool({
    name: "read_file_text",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      path: "vm_smoke_test.md",
      max_chars: 1000,
      format: "json",
    },
  });
  console.log("\n--- read_file_text (json) ---\n");
  const readTextResultJsonText = readText(readTextResultJson);
  console.log(readTextResultJsonText);
  try {
    const parsed = JSON.parse(readTextResultJsonText);
    if (parsed?.ok !== true) throw new Error("expected ok=true from read_file_text");
    const text = String(parsed?.text ?? "");
    if (!text.includes(token)) throw new Error("expected read_file_text text to contain the token");
    if (parsed?.file_path !== "vm_smoke_test.md") {
      throw new Error(`expected read_file_text file_path=vm_smoke_test.md, got ${parsed?.file_path}`);
    }
  } catch (err) {
    console.error("\n[smoke] read_file_text check failed:", err);
    process.exitCode = 1;
    return;
  }

  const readCodexText = await client.callTool({
    name: "read_codex_text_file",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      path: pathToFileURL(skillPath).toString(),
      max_chars: 1000,
    },
  });
  console.log("\n--- read_codex_text_file (compact) ---\n");
  const readCodexTextResult = readText(readCodexText);
  console.log(readCodexTextResult);
  if (!readCodexTextResult.includes("file ") || !readCodexTextResult.includes(token)) {
    console.error("\n[smoke] expected default read_codex_text_file output to be compact text");
    process.exitCode = 1;
    return;
  }

  const readCodexTextJson = await client.callTool({
    name: "read_codex_text_file",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      path: pathToFileURL(skillPath).toString(),
      max_chars: 1000,
      format: "json",
    },
  });
  console.log("\n--- read_codex_text_file (json) ---\n");
  const readCodexTextJsonResult = readText(readCodexTextJson);
  console.log(readCodexTextJsonResult);
  try {
    const parsed = JSON.parse(readCodexTextJsonResult);
    if (parsed?.ok !== true) throw new Error("expected ok=true from read_codex_text_file");
    const text = String(parsed?.text ?? "");
    if (!text.includes(token)) throw new Error("expected read_codex_text_file text to contain the token");
    if (!String(parsed?.file_path ?? "").toLowerCase().endsWith("skill.md")) {
      throw new Error(`expected read_codex_text_file file_path to end with SKILL.md, got ${parsed?.file_path}`);
    }
  } catch (err) {
    console.error("\n[smoke] read_codex_text_file check failed:", err);
    process.exitCode = 1;
    return;
  }

  const grep = await client.callTool({
    name: "grep",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: token,
      mode: "literal",
      max_results: 20,
      include_paths: ["vm_smoke_test.md"],
    },
  });
  console.log("\n--- grep (compact) ---\n");
  const grepText = readText(grep);
  console.log(grepText);
  if (!grepText.includes("grep ") || !grepText.includes("vm_smoke_test.md:3:")) {
    console.error("\n[smoke] expected default grep output to be compact text");
    process.exitCode = 1;
    return;
  }

  const grepJson = await client.callTool({
    name: "grep",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: token,
      mode: "literal",
      max_results: 20,
      include_paths: ["vm_smoke_test.md"],
      format: "json",
    },
  });
  console.log("\n--- grep (json) ---\n");
  const grepJsonText = readText(grepJson);
  console.log(grepJsonText);
  try {
    const parsed = JSON.parse(grepJsonText);
    if (parsed?.ok !== true) throw new Error("expected ok=true from grep");
    if (!["ripgrep", "indexed_fallback"].includes(String(parsed?.backend ?? ""))) {
      throw new Error(`expected grep backend to be ripgrep or indexed_fallback, got ${parsed?.backend}`);
    }
    const matches = parsed?.matches;
    if (!Array.isArray(matches) || matches.length === 0) throw new Error("expected grep to return at least 1 match");
    const m0 = matches[0];
    if (m0?.file_path !== "vm_smoke_test.md") {
      throw new Error(`expected grep file_path=vm_smoke_test.md, got ${m0?.file_path}`);
    }
    if (m0?.line !== 3) {
      throw new Error(`expected grep first match line=3, got ${m0?.line}`);
    }
    if (parsed?.backend === "ripgrep" && typeof parsed?.rg_command !== "string") {
      throw new Error("expected ripgrep-backed grep to expose rg_command");
    }
  } catch (err) {
    console.error("\n[smoke] grep check failed:", err);
    process.exitCode = 1;
    return;
  }

  const readLines = await client.callTool({
    name: "read_file_lines",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      path: "vm_smoke_test.md",
      total_count: 10,
    },
  });
  console.log("\n--- read_file_lines (compact) ---\n");
  const readLinesText = readText(readLines);
  console.log(readLinesText);
  if (!readLinesText.includes("lines vm_smoke_test.md") || !readLinesText.includes(token)) {
    console.error("\n[smoke] expected default read_file_lines output to be compact text");
    process.exitCode = 1;
    return;
  }

  const readLinesJson = await client.callTool({
    name: "read_file_lines",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      path: "vm_smoke_test.md",
      total_count: 10,
      format: "json",
    },
  });
  console.log("\n--- read_file_lines (json) ---\n");
  const readLinesJsonText = readText(readLinesJson);
  console.log(readLinesJsonText);
  try {
    const parsed = JSON.parse(readLinesJsonText);
    if (parsed?.ok !== true) throw new Error("expected ok=true from read_file_lines");
    const text = String(parsed?.text ?? "");
    if (!text.includes(token)) throw new Error("expected read_file_lines text to contain the token");
  } catch (err) {
    console.error("\n[smoke] read_file_lines check failed:", err);
    process.exitCode = 1;
    return;
  }

  const queryCodebase = await client.callTool({
    name: "query_codebase",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "main",
    },
  });
  console.log("\n--- query_codebase (compact) ---\n");
  const queryCodebaseText = readText(queryCodebase);
  console.log(queryCodebaseText);
  if (!queryCodebaseText.includes("query_codebase matches=")) {
    console.error("\n[smoke] expected default query_codebase output to be compact text");
    process.exitCode = 1;
    return;
  }

  const queryCodebaseJson = await client.callTool({
    name: "query_codebase",
    arguments: {
      ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
      query: "main",
      format: "json",
    },
  });
  try {
    const parsed = JSON.parse(readText(queryCodebaseJson));
    if (parsed?.ok !== true) throw new Error("expected ok=true from query_codebase json");
    if (!Array.isArray(parsed?.matches)) throw new Error("expected query_codebase json matches array");
  } catch (err) {
    console.error("\n[smoke] query_codebase json check failed:", err);
    process.exitCode = 1;
    return;
  }

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
