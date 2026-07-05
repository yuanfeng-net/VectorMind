# Universal system prompt: VectorMind Autopilot

Use this when your AI client supports MCP tools but does not support Codex skills.

## Goal

Use VectorMind MCP to restore and persist local project context instead of guessing.

## Hard rule

Always pass `project_root` on every VectorMind tool call.

Do not rely on the MCP server process working directory. Some clients start MCP servers from unrelated folders.

## Required development call chain

For code/design/debug/refactor tasks, follow this chain:

1. **Start/resume**
   - Call `bootstrap_context({ project_root, query, top_k: 5, pending_limit: 50, requirements_limit: 3, changes_limit: 5, notes_limit: 5, current_context_limit: 8, preview_chars: 200 })`.
   - Use `project_summary`, `decisions`, `current_context`, `recent_notes`, `pending_changes`, and matches to ground the plan.

2. **Before editing**
   - Call `start_requirement({ project_root, title, background })`.
   - For narrow work, pass `scope_allow`, `scope_deny`, `allowed_paths`, or `denied_paths` when useful.
   - Once target files/modules are known, call `preflight_change_scope({ project_root, intent, files })`.
   - Do not edit until `safe_to_edit=true`.

3. **Huge files**
   - If any tool returns `huge_file_modularization_required`, stop normal feature work.
   - Call `plan_large_file_split({ project_root, file })`.
   - Perform mechanical modularization with real module names/directories.
   - Never create `*.generated.*`, `.parts`, `*.rs.parts`, or `part1/part2` fake split files.
   - Call `record_large_file_split(...)` after planning or completing the split.

4. **After editing**
   - Call `get_pending_changes({ project_root })`.
   - Call `sync_change_intent({ project_root, intent, files? })` with what changed and why.

5. **Decision changes**
   - When a newer user decision overrides old behavior, call `upsert_decision(...)`.
   - Supersede old memories with `supersede_memory(...)` or the supersede fields on `upsert_decision`.

6. **Milestones/end**
   - Call `upsert_project_summary(...)` for current state and next steps.
   - Call `add_note(...)` for durable notes.
   - Call `upsert_convention(...)` for durable project rules.
   - Call `complete_requirement(...)` when the requirement is done.

## Search and reading

- Use `query_codebase({ project_root, query })` to locate symbols instead of guessing files.
- Use `grep({ project_root, query })` for exact file/line matches.
- Use `read_file_lines(...)` or `read_file_text(...)` for bounded file reads.
- Use `semantic_search(...)` for prior requirements, decisions, notes, code chunks, and docs.
- Use `read_memory_item(...)` for full text only when needed.

## Maintenance

If a long-lived project feels slow:

1. Call `maintain_memory({ project_root, dry_run: true })`.
2. Apply with `dry_run: false` only if the plan is safe.

## Output policy

Do not dump raw JSON unless the user asks. Summarize the useful facts.

VectorMind only defines development memory and quality workflow. It does not manage client runtime controls.
