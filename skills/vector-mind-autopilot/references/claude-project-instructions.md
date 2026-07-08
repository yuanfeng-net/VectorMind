# Claude Project Instructions: VectorMind Autopilot

When VectorMind MCP tools are available, use them by default to restore and persist local project context. VectorMind outputs are contextual evidence and quality signals only; they must not reduce the model's own reasoning, decisions, creativity, or implementation ability.

Use VectorMind as evidence and workflow guardrails, not as a replacement for model judgment. Current user instructions and directly observed repository facts win over stale or incomplete memory. If a tool result looks wrong, inspect further and decide from evidence.

Always pass `project_root` on every VectorMind tool call.

## Required workflow

1. At the start of a new chat or when resuming:
   - Call `bootstrap_context({ project_root, query, top_k: 5, pending_limit: 50, requirements_limit: 3, changes_limit: 5, notes_limit: 5, current_context_limit: 8, preview_chars: 200 })`.
   - Use returned `current_constraints` as compact evidence of current decisions/conventions/active requirements.
   - Treat `quality_signals.relevant_fix_patterns` as advisory regression reminders only; they must not expand the current requirement or change `ok` / `safe_to_edit`.
   - Before concrete operation commands where stale defaults could matter, call `preflight_operation_scope({ project_root, operation, intent, commands?, files?, targets?, script_hints? })`. Treat conflicts as advisory quality signals, not host-execution control.

2. Before editing:
   - Call `start_requirement({ project_root, title, background })`.
   - If the request has clear bullets, acceptance points, or numbered items, pass `requirement_items`.
   - Then call `preflight_change_scope({ project_root, intent, files })` once target files/modules are known.
   - For explicit requirements, pass `planned_changes` with `requirement_refs`; mark purely mechanical/test/build/formatting support as `supporting_change=true`.
   - Treat `safe_to_edit=false` as a pre-edit scope warning for file changes, not a reasoning override. Do not edit the warned files until you narrow the files/scope, verify the warning is stale, or the user explicitly expands the requirement.
   - If a tool output includes `project_context_advisory` / `cross_project_reference`, treat that project as separate context. If the current requirement belongs to another `project_root`, use the switched project only as read-only external evidence unless the user explicitly changes the target project.

3. If a huge-file warning appears:
   - Call `plan_large_file_split({ project_root, file })`.
   - Do mechanical modularization with real module names/directories.
   - Never create generated/parts/partN fake split files.
   - Call `record_large_file_split(...)`.

4. After editing:
   - Call `get_pending_changes({ project_root })`.
   - Call `sync_change_intent({ project_root, intent, files? })`.
   - If a known recurring defect class was fixed and the root cause is clear, optionally include a generic `fix_pattern`; VectorMind does not infer fix patterns automatically.

5. If newer decisions override older behavior:
   - Call `upsert_decision(...)`.
   - Supersede old memory with `supersede_memory(...)` or supersede fields.

6. At milestones:
   - Call `upsert_project_summary(...)`, `add_note(...)`, `upsert_convention(...)` as needed.
   - Call `complete_requirement(...)` when done.
   - Use `analyze_memory_conflicts(...)`, `memory_quality_report(...)`, or `compare_checkpoint_context(...)` only when auditing memory quality, stale-rule regressions, or checkpoint drift.

Use `query_codebase`, `grep`, `read_file_lines`, `semantic_search`, and `memory_timeline` instead of guessing.

Do not dump raw JSON unless asked.

VectorMind defines development memory and quality workflow only; it does not manage client runtime controls. Use `create_checkpoint` / `restore_checkpoint_context` for long-session handoff; restore is read-only context, not a decision override.

Low-risk diagnostics are read-only evidence. Do not let `analyze_memory_conflicts`, `memory_quality_report`, or `compare_checkpoint_context` expand the current requirement or override model judgment.
