---
name: vector-mind-autopilot
description: "Automatically apply the VectorMind MCP workflow (local requirement-driven memory) and ALWAYS pass project_root in every VectorMind tool call (critical for Codex VS Code plugin where cwd/roots may be wrong): bootstrap_context on session start, start_requirement before edits, sync_change_intent after saves, and semantic_search/query_codebase instead of guessing. Use for coding work when VectorMind MCP is configured."
---

# VectorMind Autopilot (MCP)

## Goal

Make the assistant use VectorMind MCP by default so project context, intent, and progress are restored and persisted locally without the user manually asking for MCP calls.

## Hard Rule: Always include `project_root`

In many clients (especially the **Codex VS Code plugin**), the MCP server process may start with an unrelated `cwd` (e.g. `C:\\Windows\\System32`) and without `roots/list`. In that case VectorMind will fall back to the VS Code User directory, which breaks per-project isolation.

Therefore:

- **Always pass `project_root` on every VectorMind tool call** (including `bootstrap_context`, `get_brain_dump`, `get_pending_changes`, etc.).
- Reuse the same `project_root` consistently within the same task.
- If you switch to a different project in the same chat, pass the new `project_root` on the next tool call (VectorMind can re-bind per call).

### How to choose `project_root` (best-effort)

1) If the user mentions a project path explicitly, use that exact directory.
2) Otherwise, infer it from the **active file / open tabs paths** in the conversation context:
   - Prefer the workspace folder that contains the files being discussed.
   - If you can check the filesystem, walk upward until you find a marker like `.git/` (or a root file like `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.sln`), and use that directory.
3) Validate the choice once by calling `bootstrap_context({ project_root, query: "<goal>" })` and confirm:
   - `root_source` is `"tool_arg"`
   - `db_path` is under `<project_root>/.vectormind/`

If you still cannot determine it confidently, ask the user for the project root path (do not guess).

## Default Workflow (do this unless explicitly unnecessary)

### 1) Detect VectorMind MCP availability

- If the tools `bootstrap_context`, `start_requirement`, and `sync_change_intent` exist, treat VectorMind as available and use it.
- If VectorMind tools are missing or tool calls fail repeatedly, follow **Setup / Troubleshooting** and continue with best-effort reasoning (do not guess silently; tell the user what’s missing).

### 2) On every new session (or when the user says “继续/恢复/接着做”)

- Unless the task is purely execution-first (for example compile/build/run/launch/package/publish/test rerun with already-known targets), call `bootstrap_context({ project_root: <PROJECT_ROOT>, query: <the user's current goal>, top_k: 5 })` first.
  - Prefer keeping tool output small by default: `pending_limit: 50`, `requirements_limit: 3`, `changes_limit: 5`, `notes_limit: 5`, `preview_chars: 200`.
  - Avoid `include_content: true` unless you truly need full text (it increases tokens).
- Use the returned `project_summary`, `recent_notes`, `pending_changes`, and semantic `items` to ground your plan and avoid “blind guessing”.
- Do **not** paste raw JSON unless the user asks for it (summarize key facts instead).
- For pure execution-first tasks with explicit targets, prefer the minimum necessary shell or host tools first; only pull VectorMind retrieval tools back in when code/context lookup is actually needed to unblock execution.

### 3) Before editing code or files

- If this is a new task/feature, call `start_requirement({ project_root: <PROJECT_ROOT>, title, background })` before changing anything.
- Prefer short, specific titles (e.g., “Add avatar upload”) and put constraints in `background` (formats, edge cases, acceptance criteria).

### 4) After editing + saving files

- Call `get_pending_changes({ project_root: <PROJECT_ROOT> })` to see what changed but isn’t yet linked to an intent.
- Call `sync_change_intent({ project_root: <PROJECT_ROOT>, intent, files? })` to archive the “what/why” and associate the changes to the active requirement.
  - Prefer omitting `files` to let the server auto-link all pending changes, unless you intentionally want a subset.
  - Write `intent` as a concise, user-facing summary: what changed + why + any follow-ups.

### 5) When you need to find code or recall context

- If the user asks “X 在哪里定义的/哪个文件负责 Y”: call `query_codebase({ project_root: <PROJECT_ROOT>, query: "X" })` instead of guessing paths.
- If you need an “rg -n / Select-String”-style search with exact file+line+col matches: call `grep({ project_root: <PROJECT_ROOT>, query: "<pattern>" })` first. It prefers ripgrep against real project files with built-in noise filtering, and only falls back to indexed search if ripgrep is unavailable.
- If you need to read a specific file segment (like `Get-Content -TotalCount` / `head`): call `read_file_lines({ project_root: <PROJECT_ROOT>, path: "<file>", total_count: 240 })` or `read_file_lines({ ..., from_line, to_line })` first to keep output bounded.
- Avoid whole-file dumps, full-repo recursive listings, or broad raw match echo in normal flow; narrow the scope first and only surface the minimum needed lines/paths.
- If you need to recall prior context/notes/decisions/code/docs: call `semantic_search({ project_root: <PROJECT_ROOT>, query, top_k, kinds? })` instead of guessing.
  - Note: `semantic_search` works even when embeddings are off (uses local SQLite FTS/LIKE). Enable `VECTORMIND_EMBEDDINGS=on` if you want vector semantic recall.
- If you truly need full text for a specific match/note/summary, call `read_memory_item({ project_root: <PROJECT_ROOT>, id, offset, limit })` to fetch it in chunks instead of setting `include_content: true`.

### 6) After major milestones (or before ending the session)

- Call `upsert_project_summary({ project_root: <PROJECT_ROOT>, summary })` to keep a single, up-to-date project summary.
- Call `add_note({ project_root: <PROJECT_ROOT>, title?, content, tags? })` for durable decisions/constraints/TODOs that should survive across sessions.
- If the user confirms a requirement is finished, call `complete_requirement({ project_root: <PROJECT_ROOT> })` so it no longer shows as active.
- If the user states a durable project convention (framework, build command, naming rules, output paths), call `upsert_convention({ project_root: <PROJECT_ROOT>, key, content, tags? })`.

## Output Policy (user-visible)

- Don’t spam tool outputs. Summarize what matters (active requirement, pending changes, next steps).
- Show raw JSON only when the user requests debugging/verification.
- If debugging VectorMind behavior, prefer `get_activity_summary` first (small output), and only use `get_activity_log` with paging (and `verbose=true` only if necessary).
- This skill covers VectorMind memory usage and development-quality guidance only. It is unrelated to AI access permissions, runtime permissions, command permissions, filesystem/network permissions, approval mechanisms, or sandbox behavior.

## Setup / Troubleshooting

### Skill changes not taking effect

- Skills are discovered at **Codex startup**; they are not hot-reloaded per message.
- After installing/updating this skill, **restart Codex** (and in VS Code, fully restart the editor) and start a **new chat/Agent**.
- Quick verification: the new session’s `## Skills` list should include `vector-mind-autopilot`. If it doesn’t, Codex isn’t loading it yet.

### Don’t hardcode a single project in global config

- If you set `[mcp_servers.vector-mind].cwd` or `env.VECTORMIND_ROOT` inside the **global** `~/.codex/config.toml`, VectorMind will be locked to that one directory and will NOT create `<project>/.vectormind/` for other projects.
- For per-project isolation, remove those keys, restart Codex, and start Codex inside the target project directory (or use `codex -C <project>`).
- VectorMind resolves `project_root` when the MCP server starts; switching projects in the same client process may require restarting the client/editor to re-bind to the new project.
- As the assistant, do **not** auto-edit the user’s global config to hardcode per-project paths unless the user explicitly asks you to.

### VectorMind tools are missing

- Configure your MCP client to run VectorMind via stdio (published package example): `npx -y @coreyuan/vector-mind`.
- Codex CLI config location: `~/.codex/config.toml` (Windows: `C:\\Users\\<you>\\.codex\\config.toml`).
  - Example:
    - `[mcp_servers.vector-mind]`
    - `type = "stdio"`
    - `command = "npx"`
    - `args = ["-y", "@coreyuan/vector-mind"]`

### Tool calls fail with “Transport closed”

- Restart the MCP client (or the editor) so the MCP server reconnects.
- Re-check the MCP server config and that `npx -y @coreyuan/vector-mind` runs successfully in the same environment.

## Universal (non-Codex) usage

If your AI client does not support Codex skills, copy/paste `references/universal-system-prompt.md` into that client’s system prompt/custom instructions.
