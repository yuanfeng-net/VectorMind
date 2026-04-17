import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

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

  const bootStart = Date.now();
  const boot = await client.callTool(
    {
      name: "bootstrap_context",
      arguments: {
        ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
        query: "smoke test: what is VectorMind?",
        top_k: 5,
        conventions_limit: 40,
      },
    },
    undefined,
    { timeout: 10_000 },
  );
  const bootElapsedMs = Date.now() - bootStart;
  console.log("\n--- bootstrap_context ---\n");
  const bootText = readText(boot);
  console.log(bootText);
  try {
    const parsed = JSON.parse(bootText);
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
      "builtin:branch_write_boundary",
      "builtin:plan_lite_trigger_scope",
      "builtin:destructive_operation_scope",
      "builtin:architecture_boundary_first",
      "builtin:low_overhead_execution_scope",
      "builtin:payload_guard_trigger_scope",
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
    if (!serverInstructions?.includes("Built-in task-list / Plan-Lite policy:")) {
      throw new Error("expected server instructions to include Plan-Lite section");
    }
    if (!serverInstructions?.includes("轻量执行列表")) {
      throw new Error("expected server instructions to include the light task-list policy text");
    }
    if (!serverInstructions?.includes("Built-in destructive-operation guard policy:")) {
      throw new Error("expected server instructions to include destructive-operation guard section");
    }
    if (!serverInstructions?.includes("无法确认安全，禁止继续破坏性操作")) {
      throw new Error("expected server instructions to include the destructive-operation guard text");
    }
    if (!serverInstructions?.includes("Built-in architecture and code-organization policy:")) {
      throw new Error("expected server instructions to include architecture/code-organization section");
    }
    if (!serverInstructions?.includes("模块化单体、清晰分层")) {
      throw new Error("expected server instructions to include the architecture/code-organization policy text");
    }
    if (!serverInstructions?.includes("Built-in low-overhead execution and heavy-thread policy:")) {
      throw new Error("expected server instructions to include low-overhead/heavy-thread section");
    }
    if (!serverInstructions?.includes("执行为主的任务")) {
      throw new Error("expected server instructions to include the low-overhead execution policy text");
    }
    if (!serverInstructions?.includes("Built-in payload / oversized-thread guard policy:")) {
      throw new Error("expected server instructions to include payload guard section");
    }
    if (!serverInstructions?.includes("Request Entity Too Large")) {
      throw new Error("expected server instructions to include the payload guard text");
    }
    if (!serverInstructions?.includes("Built-in thread handoff / switch-gate policy:")) {
      throw new Error("expected server instructions to include thread handoff section");
    }
    if (!serverInstructions?.includes("不得依赖固定 token 阈值")) {
      throw new Error("expected server instructions to include the fixed-token-threshold guard text");
    }
    if (!serverInstructions?.includes("add_note(...)")) {
      throw new Error("expected server instructions to include the add_note handoff guidance");
    }
    if (!serverInstructions?.includes("不得尝试替用户创建新线程")) {
      throw new Error("expected server instructions to forbid creating a new thread for the user");
    }
    if (!serverInstructions?.includes("读取 note <id>")) {
      throw new Error("expected server instructions to include the note-id continuation text");
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
    if (!serverInstructions?.includes("switch to payload guard mode")) {
      throw new Error("expected server instructions to mention payload guard mode");
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
  console.log("\n--- semantic_search ---\n");
  const searchText = readText(search);
  console.log(searchText);
  try {
    const parsed = JSON.parse(searchText);
    if (parsed?.ok !== true) throw new Error("expected ok=true from semantic_search");
    const matches = parsed?.matches;
    if (!Array.isArray(matches) || matches.length === 0) {
      throw new Error("expected semantic_search to return at least 1 match");
    }
    if (enableEmbeddings !== true && !["fts", "like"].includes(parsed?.mode)) {
      throw new Error(`expected mode to be fts/like when embeddings are off (got ${parsed?.mode})`);
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
  console.log("\n--- list_project_files ---\n");
  const listFilesText = readText(listFiles);
  console.log(listFilesText);
  try {
    const parsed = JSON.parse(listFilesText);
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
  console.log("\n--- read_file_text ---\n");
  const readTextResultText = readText(readTextResult);
  console.log(readTextResultText);
  try {
    const parsed = JSON.parse(readTextResultText);
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
  console.log("\n--- read_codex_text_file ---\n");
  const readCodexTextResult = readText(readCodexText);
  console.log(readCodexTextResult);
  try {
    const parsed = JSON.parse(readCodexTextResult);
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
  console.log("\n--- grep ---\n");
  const grepText = readText(grep);
  console.log(grepText);
  try {
    const parsed = JSON.parse(grepText);
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
  console.log("\n--- read_file_lines ---\n");
  const readLinesText = readText(readLines);
  console.log(readLinesText);
  try {
    const parsed = JSON.parse(readLinesText);
    if (parsed?.ok !== true) throw new Error("expected ok=true from read_file_lines");
    const text = String(parsed?.text ?? "");
    if (!text.includes(token)) throw new Error("expected read_file_lines text to contain the token");
  } catch (err) {
    console.error("\n[smoke] read_file_lines check failed:", err);
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
