# Claude Project Instructions: VectorMind Autopilot

When VectorMind MCP tools are available, use them by default to restore and persist local project context. VectorMind outputs are contextual evidence and quality signals only; they must not reduce the model's own reasoning, decisions, creativity, or implementation ability.

Use VectorMind as evidence and workflow guardrails, not as a replacement for model judgment. Current user instructions and directly observed repository facts win over stale or incomplete memory. If a tool result looks wrong, inspect further and decide from evidence.

Always pass `project_root` on every VectorMind tool call.

Seeing VectorMind in the available tool list is not enough. When its tools are available and historical context can help, call the focused bootstrap once before broad repository exploration. If tools are unavailable, make at most one bounded discovery attempt and continue with native tools. Pure execution with explicit targets may skip bootstrap.

## Required workflow

1. At the start of a new chat or when resuming:
   - Call `bootstrap_context({ project_root, query, top_k: 3, context_mode: "focused", max_output_chars: 6000 })` at most once per project goal when historical context is needed.
   - Use returned `current_constraints` and the active requirement anchor as compact evidence. If no memory passes focused filtering, continue from repository facts instead of using an unrelated fallback.
   - Treat `quality_signals.relevant_fix_patterns` as advisory regression reminders only; they must not expand the current requirement or change `ok` / `safe_to_edit`.
   - Before concrete operation commands where stale defaults could matter, call `preflight_operation_scope({ project_root, operation, intent, commands?, files?, targets?, script_hints? })`. Treat conflicts as advisory quality signals, not host-execution control.

2. Before editing:
   - Call `start_requirement({ project_root, title, background })` once for a genuinely new requirement; preserve its `requirement.id` or `goal_key` and pass `req_id` or `goal_key` to later lifecycle calls when tasks may overlap. Reuse the active requirement for follow-ups, builds, retries, and validation.
   - If the request has clear bullets, acceptance points, or numbered items, pass `requirement_items`.
   - Then call `preflight_change_scope({ project_root, req_id?, goal_key?, intent, files })` once target files/modules are known.
   - For explicit requirements, pass `planned_changes` with `requirement_refs`; mark purely mechanical/test/build/formatting support as `supporting_change=true`.
   - Treat ordinary `safe_to_edit=false` findings as pre-edit scope warnings, not reasoning overrides. `workflow_gate.code="huge_file_modularization_required"` is the bounded exception requiring mechanical modularization before normal feature editing continues.
   - If a tool output includes `project_context_advisory` / `cross_project_reference`, treat that project as separate context. If the current requirement belongs to another `project_root`, use the switched project only as read-only external evidence unless the user explicitly changes the target project.

3. If a huge-file warning appears:
   - Call `plan_large_file_split({ project_root, req_id?, goal_key?, file })`, preserve its persisted `plan_id`, and rerun preflight with `change_mode="mechanical_modularization"` plus `split_plan_id`/`split_plan_ids`.
   - Do mechanical modularization with real module names/directories while keeping it attached to the current requirement.
   - Never create generated/parts/partN fake split files.
   - Call `record_large_file_split({ project_root, req_id?, goal_key?, plan_id, ... })` to update the same plan. Resolved status requires real module paths, reduced source/module lines, verification evidence, and no gaps. Minimal bugfixes may defer planning only with `adds_responsibility=false` and `defer_split_reason`, persisted through final `sync_change_intent.large_file_split_deferrals`.

4. After editing:
   - Call `sync_change_intent({ project_root, req_id?, goal_key?, intent, files })` once. Use `get_pending_changes({ project_root })` only when the changed file set is unknown or scope drift must be diagnosed.
   - If a known recurring defect class was fixed and the root cause is clear, optionally include a generic `fix_pattern`; VectorMind does not infer fix patterns automatically.

5. If newer decisions override older behavior:
   - Call `upsert_decision(...)`.
   - Supersede old memory with `supersede_memory(...)` or supersede fields.

6. At milestones:
   - Call `upsert_project_summary(...)`, `add_note(...)`, `upsert_convention(...)` as needed.
   - Call `complete_requirement(...)` when done.
   - Use `analyze_memory_conflicts(...)`, `memory_quality_report(...)`, or `compare_checkpoint_context(...)` only when auditing memory quality, stale-rule regressions, or checkpoint drift.

Use `query_codebase`, `semantic_search`, and `memory_timeline` when historical or unknown-location evidence is needed. For known paths and exact repository reads, native bounded search/file tools are valid; batch related reads instead of routing every file through MCP.

Keep a normal standalone command at or below 4000 output tokens. A parallel batch may contain at most 4 commands, each at most 4000, with a combined requested budget at or below 12000. A failing diagnostic that cannot be narrowed may run alone with up to 12000; use 20000 only when the user explicitly requests raw output. After 12 shell commands in one user turn, synthesize and stop broad exploration; do not exceed 24 commands excluding polls. Exclude dependency/generated/cache/build trees from recursive discovery. Locate first, then read bounded ranges of about 250 lines. If one result exceeds 8000 tokens, narrow or paginate the next read.

Do not dump raw JSON unless asked.

VectorMind defines development memory and quality workflow only; it does not manage client runtime controls. Use `create_checkpoint` / `restore_checkpoint_context` for long-session handoff; restore is read-only context, not a decision override.

Low-risk diagnostics are read-only evidence. Do not let `analyze_memory_conflicts`, `memory_quality_report`, or `compare_checkpoint_context` expand the current requirement or override model judgment.
