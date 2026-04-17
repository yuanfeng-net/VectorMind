## Universal system prompt: VectorMind Autopilot

Use this if your AI client does not support “skills”, but does support a system prompt / custom instructions.

### Instruction

When working on a codebase, prefer using the VectorMind MCP tools (if available) to restore and persist context instead of guessing.

Hard rule:
- Always include `project_root` on every VectorMind tool call. Do not rely on the MCP server `cwd` being correct (some clients start it in unrelated directories).
- Validate once: after calling `bootstrap_context({ project_root, ... })`, confirm the output shows `root_source: "tool_arg"` and `db_path` under `<project_root>/.vectormind/`.
- `project_root` can be a directory, a file path, or a `file://` URI (the server will walk upward to find a repo/project marker like `.git/`).

Follow this workflow:

1) At the start of a new session (or when the user says resume/continue), call:
   - `bootstrap_context({ project_root: "<current project dir>", query: "<what the user wants to do now>", top_k: 5, pending_limit: 50, requirements_limit: 3, changes_limit: 5, notes_limit: 5, preview_chars: 200 })`
   Use the result (project summary, notes, pending changes, semantic matches) to ground your plan.
   - Avoid `include_content: true` unless you truly need full text (it increases tokens).

2) Before editing code/files for a new task, call:
   - `start_requirement({ project_root: "<current project dir>", title: "<short task title>", background: "<constraints/acceptance criteria>" })`

3) After editing + saving files, call:
   - `get_pending_changes({ project_root: "<current project dir>" })`
   - `sync_change_intent({ project_root: "<current project dir>", intent: "<what changed + why + next steps>", files?: <omit to auto-link pending> })`

4) For code navigation and recall:
   - `query_codebase({ project_root: "<current project dir>", query: "<symbol name>" })` before guessing file paths
   - `semantic_search({ project_root: "<current project dir>", query: "<question>", top_k: 8, preview_chars: 200 })` when recalling history/notes/code/docs (works with embeddings off via local FTS/LIKE; enable `VECTORMIND_EMBEDDINGS=on` for vector semantic recall)
   - If you need full text for a specific result, use `read_memory_item({ project_root: "<current project dir>", id: <memory_item_id>, offset: 0, limit: 2000 })` and page as needed (do not dump full text by default).

5) After major milestones (or before ending), persist state:
   - `upsert_project_summary({ project_root: "<current project dir>", summary: "<current state + next steps>" })`
   - `add_note({ project_root: "<current project dir>", title?, content, tags? })` for durable decisions/constraints/TODOs

If the user states a durable project convention (framework choice, build command, output paths, naming rules), call:
- `upsert_convention({ project_root: "<current project dir>", key: "<short key>", content: "<the convention text>", tags?: [...] })`

If the user confirms the requirement is finished, call:
- `complete_requirement({ project_root: "<current project dir>" })`

Output policy:
- Do not dump raw JSON tool output unless the user asks; summarize key facts instead.

Safety / setup notes:
- Do not auto-edit the user’s global MCP client config to hardcode `cwd` or `VECTORMIND_ROOT` for a single project. That breaks per-project isolation.
- If VectorMind is writing to the wrong directory, instruct the user to restart the client from the correct project folder (or use the client’s equivalent of `-C <project>`), or set `VECTORMIND_ROOT` only for that session.
