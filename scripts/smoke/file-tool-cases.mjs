import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function runFileToolCases(ctx) {
  const { client, useToolProjectRoot, toolProjectRoot, token, skillPath, readText } = ctx;
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

  const outsideDir = path.join(path.dirname(toolProjectRoot), `vectormind-outside-${Date.now()}`);
  const linkPath = path.join(toolProjectRoot, `vm-outside-link-${Date.now()}`);
  try {
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "outside-project-root");
    fs.symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    const escapedRead = await client.callTool({
      name: "read_file_text",
      arguments: {
        ...(useToolProjectRoot ? { project_root: toolProjectRoot } : {}),
        path: path.relative(toolProjectRoot, path.join(linkPath, "secret.txt")),
        max_chars: 100,
      },
    });
    const escapedText = readText(escapedRead);
    if (!escapedRead?.isError && !/outside the allowed root|under the allowed root/i.test(escapedText)) {
      throw new Error(`expected linked path escape to be rejected, got: ${escapedText}`);
    }
  } catch (err) {
    const code = err?.code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      console.log(`\n[smoke] linked-path containment skipped: ${code}`);
    } else {
      console.error("\n[smoke] linked-path containment check failed:", err);
      process.exitCode = 1;
      return;
    }
  } finally {
    try {
      fs.unlinkSync(linkPath);
    } catch {}
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }

  return true;
}
