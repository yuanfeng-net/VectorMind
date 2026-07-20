---
name: vector-mind-autopilot
description: "Apply a bounded VectorMind MCP workflow for local requirement-driven memory. Always pass project_root, restore focused context once per project goal, start/preflight once per requirement, and sync once after edits without routing every read through MCP."
---

# VectorMind Autopilot

Use this skill for coding work when VectorMind MCP is configured.

## Goal

Make the assistant restore and persist project context locally so long-running development work has less context loss, less scope drift, and fewer stale-rule regressions. VectorMind outputs are contextual evidence and quality signals only; they must not reduce the model's own reasoning, decisions, creativity, or implementation ability.

## Autonomy floor

Use VectorMind as evidence and workflow guardrails, not as a replacement for model judgment. Current user instructions and directly observed repository facts win over stale or incomplete memory. If a tool result looks wrong, inspect further and decide from evidence.

## Hard rule: always pass `project_root`

Always include `project_root` on every VectorMind tool call.

Why: some clients start MCP servers from unrelated folders. Passing `project_root` keeps each project isolated under:

```text
<project>/.vectormind/
```

## How to choose `project_root`

1. If the user gave a path, use it.
2. Otherwise infer it from active files/workspace paths.
3. If needed, walk upward to a marker like `.git`, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or `*.sln`.
4. Validate once with `bootstrap_context({ project_root, query })`; prefer `root_source: "tool_arg"` and a `db_path` under `<project>/.vectormind/`.

## Bounded lifecycle

For development, debugging, refactoring, design, or code-change tasks:

### Activation contract

- Seeing this skill in the available-skill list is not enough. When VectorMind tools are available and historical context can help, use the focused bootstrap once before broad repository exploration.
- If VectorMind tools are unavailable, make at most one bounded discovery attempt, then continue with native tools. Do not repeatedly search for or reconnect the MCP server inside the task.
- Pure execution with explicit targets may skip bootstrap.

Normal work should use no more than four VectorMind workflow calls:

1. one focused bootstrap when historical context is needed;
2. one requirement start for a genuinely new requirement;
3. one preflight for the complete planned file set;
4. one final change-intent sync.

Do not repeat lifecycle calls after every compaction, tool error, validation step, build, retry, or follow-up.

### 1. Start / resume

Call at most once per project goal:

```text
bootstrap_context({ project_root, query, top_k: 3, context_mode: "focused", max_output_chars: 6000 })
```

Use the project summary, active requirement anchor, and query-relevant matches to ground the plan. Default focused mode intentionally omits completed recent-history anchors, pending files, and broad constraints because they frequently distract from the current goal. If no memory passes focused relevance filtering, continue from current repository facts instead of using an unrelated fallback.
Use `include_recent=true` or `context_mode="full"` only when the task explicitly requires recent cross-turn history. Use `include_pending=true` only for scope diagnosis; normal completion should call `get_pending_changes` directly if needed.
If `quality_signals.relevant_fix_patterns` appears, treat it as a historical regression reminder only. Do not let it expand the current requirement, change `ok`/`safe_to_edit`, or override direct repository facts.

Skip bootstrap for pure execution-first tasks with explicit targets, and when the current project goal has already been bootstrapped in this conversation.

For concrete operation commands where stale defaults could matter (deploy/publish/build/test/migrate/service/git/batch scripts), call:

```text
preflight_operation_scope({ project_root, operation, intent, commands?, files?, targets?, script_hints? })
```

Call it immediately before the first concrete operation command. Do not run an exploratory `git status`, deployment inspection, publish command, build, or test first and preflight afterward; include those first commands in the single planned command set.

Treat `stale_default_conflict` or `operation_constraint_conflict` as advisory quality signals: align the plan with current constraints, directly observed repo facts, or explicit user instructions before running commands.

### 2. Before editing

Call once for a new user requirement:

```text
start_requirement({ project_root, title, background })
```

Keep the returned `requirement.id` or a caller-provided `goal_key`. Pass `req_id` or `goal_key` to preflight and sync whenever multiple tasks, agents, or sessions may overlap in the same project.

Continue using the active requirement for follow-ups, builds, verification, and retries. Exact duplicate starts are reused by the server, but clients should still avoid unnecessary calls.
For narrow tasks, pass `scope_allow`, `scope_deny`, `allowed_paths`, or `denied_paths` when useful.
If the user request has clear bullets, acceptance points, or numbered items, also pass `requirement_items` so later edits can be checked against the actual request.

Once the complete planned file/module set is known, call once:

```text
preflight_change_scope({ project_root, req_id?, goal_key?, intent, files })
```

For explicit requirements, pass `planned_changes` with `requirement_refs`. Mark purely mechanical/test/build/formatting support as `supporting_change=true`.

Treat ordinary `safe_to_edit=false` scope findings as pre-edit warnings, not reasoning overrides. A `workflow_gate.code="huge_file_modularization_required"` result is the bounded exception: stop normal feature editing for that file and follow the mechanical modularization workflow. The MCP still does not control host execution.
Repeat preflight only if the planned scope materially changes.

If a tool output includes `project_context_advisory` / `cross_project_reference`, treat that project as a separate context. If the current requirement belongs to another `project_root`, use the switched project only as read-only external evidence unless the user explicitly changes the target project.

### 3. Huge files

If any VectorMind tool returns `huge_file_modularization_required`:

1. Stop normal feature editing for that file.
2. Call `plan_large_file_split({ project_root, req_id?, goal_key?, file })`, passing the selected requirement identity when tasks may overlap. Preserve the returned `plan_id`; the plan is persisted with declaration coverage, a true source-content SHA-256, and a fingerprint of the effective planning boundaries.
3. If heuristic planning returns `needs_refinement`, call `plan_large_file_split` again with semantic `module_overrides` using declaration names or line ranges. Overrides must assign every detected declaration exactly once, stay under the target directory, and satisfy the fixed safety ceilings. The refined plan supersedes the failed plan; do not record progress against `needs_refinement`.
4. Rerun preflight with `change_mode="mechanical_modularization"` and `split_plan_id` (or `split_plan_ids` for multiple huge files). Only a complete plan whose source state still matches satisfies the gate.
5. Perform mechanical modularization with real module names/directories. Keep the split attached to the current requirement; do not start a second requirement unless parent/child lifecycle is explicitly supported.
6. Never create `*.generated.*`, `.parts`, `*.rs.parts`, or `part1/part2` fake split files.
7. Use `record_large_file_split({ project_root, req_id?, goal_key?, plan_id, ... })` to update the same persisted plan when work is in progress, partial, or resolved. Status transitions are monotonic (`planned -> in_progress|partial|resolved`, `in_progress -> partial|resolved`, `partial -> in_progress|resolved`); submitted module paths must exist. Resolved status requires real module paths, a reduced source file, verification evidence, and no verification gaps.

A minimal bugfix may use `change_mode="bugfix"` with `adds_responsibility=false` and a concrete `defer_split_reason` without first expanding the task into a full split plan. This channel must not add new responsibilities. Include `large_file_split_deferrals: [{ file, reason }]` in the final `sync_change_intent` so the debt remains durable; each deferred file must be part of that sync and must still be huge or have an unfinished split plan. `emergency_hotfix` uses the same durable deferral record and is reserved for urgent minimal fixes. Completing a requirement automatically marks any unfinished split plans `deferred` so stale plans do not remain active context.

### 4. After editing

Call once after editing:

```text
sync_change_intent({ project_root, req_id?, goal_key?, intent, files })
```

The intent should say what changed, why, and any follow-up. Include `large_file_split_deferrals` when a minimal bugfix or emergency hotfix deferred a huge-file split. Call `get_pending_changes({ project_root })` first only when the changed file list is unknown or an explicit scope audit is needed.

If later verification produces stronger evidence after a requirement was completed, do not reopen it only to rewrite history. Update the latest linked change intent with:

```text
update_requirement_verification({
  project_root,
  req_id?,
  goal_key?,
  verification?,
  verification_gaps?,
  resolved_verification_gaps?,
  replace_verification?,
  replace_verification_gaps?
})
```

The tool accepts active or completed requirements, rejects superseded requirements, and writes a linked `verification_update` audit record. Verification entries merge by default; verification gaps are authoritative replacement data by default so a later passing test run can clear stale gaps.

If the edit fixed a known recurring class of defect and the root cause is clear, you may include `fix_pattern` in `sync_change_intent`:

```text
sync_change_intent({
  project_root,
  intent,
  files?,
  verification?,
  verification_gaps?,
  fix_pattern: { symptom, root_cause, invariant, applies_when?, avoid_regression? }
})
```

Keep fix patterns generic and project-agnostic. VectorMind does not infer them automatically, and returned matches are advisory quality signals only.

### 5. Decisions and durable memory

When a user decision changes or reverses old behavior:

- Call `upsert_decision(...)`.
- Supersede old records through `supersede_memory(...)` or `upsert_decision` supersede fields.

For durable context:

- `upsert_project_summary(...)`
- `add_note(...)`
- `upsert_convention(...)`
- `complete_requirement(...)` when done
- `create_checkpoint(...)` before long-session handoff or heavy compaction
- `restore_checkpoint_context(...)` to read checkpoint context back without mutating active state
- `analyze_memory_conflicts(...)`, `memory_quality_report(...)`, or `compare_checkpoint_context(...)` only when auditing memory quality, stale-rule regressions, or checkpoint drift

## Code search and reading

- Use `query_codebase({ project_root, query })` when symbol/code location is unknown.
- Use `semantic_search(...)` for historical requirements, decisions, notes, code chunks, and docs.
- Native bounded `rg`, `git`, and host file tools are valid for known paths and exact repository reads. Do not route every search or file read through VectorMind.
- Batch related reads/searches instead of creating one model round trip per file or pattern.
- Use `memory_timeline(...)` to understand the order of related requirements, decisions, notes, and changes.
- Use `read_memory_item(...)` for full text only when needed.

## Maintenance

If a large/long-lived project feels slow:

1. Call `maintain_memory({ project_root, dry_run: true })`.
2. Apply with `dry_run: false` only if the plan is safe.

For low-risk diagnosis, use `memory_quality_report(...)`, `analyze_memory_conflicts(...)`, or `compare_checkpoint_context(...)` as read-only evidence. Do not use these reports to expand the current requirement or override model judgment.

## Output policy

- Do not paste raw JSON unless the user asks.
- Summarize active requirement, key warnings, changed files, validation, and next step.
- VectorMind defines development memory and quality workflow only. It does not manage client runtime controls.

## Host output budget

- Keep a normal standalone command at or below 4000 output tokens.
- Run at most 4 commands in parallel, each at most 4000, with the batch's combined requested budget at or below 12000.
- A failing diagnostic that cannot be narrowed may run alone with up to 12000. Use up to 20000 only when the user explicitly asks for raw output; never request routine 30000/40000 outputs.
- After 12 shell commands in one user turn, synthesize and stop broad exploration. Do not exceed 24 host commands in one user turn, excluding polls.
- Exclude dependency, generated, cache, and build trees from recursive discovery, including `node_modules`, `target`, `dist`, `build`, `bin`, `obj`, and `.git`.
- Locate first, then read bounded ranges of about 250 lines from large implementation files.
- If one result exceeds 8000 tokens, narrow or paginate the next read and do not follow it with another broad result.

## RTK policy

- Detect RTK at most once per session.
- Use RTK only for supported external CLIs when summarized output is acceptable.
- Never prefix PowerShell cmdlets such as `Get-Content`, `Get-ChildItem`, `Select-Object`, or `Test-Path` directly.
- Use `rtk proxy` for exact logs, JSON, failing diagnostics, or a PowerShell command host.

## Troubleshooting

- Skills are loaded when the client starts. Restart the client after installing/updating this skill.
- Do not hardcode one global `cwd` or `VECTORMIND_ROOT` for all projects.
- If VectorMind tools are missing, configure the MCP server, for example:

```toml
[mcp_servers.vector-mind]
type = "stdio"
command = "npx"
args = ["-y", "@coreyuan/vector-mind"]
```

If a client does not support skills, use `references/universal-system-prompt.md`.
