## Claude “Skill” (Project Instructions): VectorMind Autopilot

Paste this into Claude’s **Project Instructions** (or **Custom Instructions**) to make usage “user invisible”.

### What to do

When the VectorMind MCP tools are available in this chat, use them by default to restore and persist local project context (do not guess).

### Required workflow

1) **At the start of every new chat/session** (or when the user says “继续/恢复/接着做”):
   - Call: `bootstrap_context({ project_root: "<项目根目录>", query: "<用户当前目标/问题>", top_k: 5, pending_limit: 50, requirements_limit: 3, changes_limit: 5, notes_limit: 5, preview_chars: 200 })`
   - Use returned `project_summary`, `recent_notes`, `pending_changes`, and semantic `items` to ground your plan.
   - Avoid `include_content: true` unless you truly need full text (it increases tokens).

2) **Before editing any code/files** for a new task/feature:
   - Call: `start_requirement({ project_root: "<项目根目录>", title: "<简短需求标题>", background: "<约束/验收标准/风险点>" })`

3) **After editing + saving files**:
   - Call: `get_pending_changes({ project_root: "<项目根目录>" })`
   - Then call: `sync_change_intent({ project_root: "<项目根目录>", intent: "<改了什么 + 为什么 + 下一步>", files?: <通常省略，让服务端自动关联 pending> })`

4) **When locating code**:
   - Call: `query_codebase({ project_root: "<项目根目录>", query: "<符号名/关键词>" })` instead of guessing file paths.

5) **When recalling history / notes / code / docs**:
   - Call: `semantic_search({ project_root: "<项目根目录>", query: "<问题>", top_k: 8, preview_chars: 200 })` instead of guessing.
   - If you need full text for a specific result, call: `read_memory_item({ project_root: "<项目根目录>", id: <memory_item_id>, offset: 0, limit: 2000 })` and page as needed.

6) **After major milestones**:
   - Call: `upsert_project_summary({ project_root: "<项目根目录>", summary: "<当前进度 + 已完成 + 未解决问题 + 下一步>" })`
   - Optionally call: `add_note({ project_root: "<项目根目录>", title?, content, tags? })` for durable decisions/constraints/TODOs.
   - If the requirement is finished, call: `complete_requirement({ project_root: "<项目根目录>" })`
   - If the user states a durable project convention (框架选型/build 命令/产物路径/命名规则), call: `upsert_convention({ project_root: "<项目根目录>", key: "<短 key>", content: "<约定内容>", tags?: [...] })`

### Output policy

- Don’t dump raw JSON tool output unless the user asks for debugging/verification.
- If tool output conflicts with your assumptions, trust the tool output.

### If tools are missing or calls fail

- Say so explicitly and tell the user to enable/configure the VectorMind MCP server for Claude (see `claude-desktop-mcp-config.json`).
