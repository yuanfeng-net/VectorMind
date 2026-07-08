---
name: vector-mind-autopilot
description: "Automatically apply the VectorMind MCP workflow for local requirement-driven memory. Always pass project_root in every VectorMind tool call: bootstrap_context on session start, start_requirement and preflight_change_scope before edits, sync_change_intent after edits, and semantic_search/query_codebase instead of guessing."
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

## Required call chain

For development, debugging, refactoring, design, or code-change tasks:

### 1. Start / resume

Call:

```text
bootstrap_context({ project_root, query, top_k: 5, pending_limit: 50, requirements_limit: 3, changes_limit: 5, notes_limit: 5, current_context_limit: 8, preview_chars: 200 })
```

Use returned summaries, decisions, current context, notes, pending changes, and matches to ground the plan.
If `quality_signals.relevant_fix_patterns` appears, treat it as a historical regression reminder only. Do not let it expand the current requirement, change `ok`/`safe_to_edit`, or override direct repository facts.

Skip this only for pure execution-first tasks with explicit targets, such as a known build/test/package command.

For concrete operation commands where stale defaults could matter (deploy/publish/build/test/migrate/service/git/batch scripts), call:

```text
preflight_operation_scope({ project_root, operation, intent, commands?, files?, targets?, script_hints? })
```

Treat `stale_default_conflict` or `operation_constraint_conflict` as advisory quality signals: align the plan with current constraints, directly observed repo facts, or explicit user instructions before running commands.

### 2. Before editing

Call:

```text
start_requirement({ project_root, title, background })
```

For narrow tasks, pass `scope_allow`, `scope_deny`, `allowed_paths`, or `denied_paths` when useful.
If the user request has clear bullets, acceptance points, or numbered items, also pass `requirement_items` so later edits can be checked against the actual request.

Once planned files/modules are known, call:

```text
preflight_change_scope({ project_root, intent, files })
```

For explicit requirements, pass `planned_changes` with `requirement_refs`. Mark purely mechanical/test/build/formatting support as `supporting_change=true`.

Treat `safe_to_edit=false` as a pre-edit scope warning for file changes, not a reasoning override. Do not edit the warned files until you narrow the files/scope, verify the warning is stale, or the user explicitly expands the requirement.

If a tool output includes `project_context_advisory` / `cross_project_reference`, treat that project as a separate context. If the current requirement belongs to another `project_root`, use the switched project only as read-only external evidence unless the user explicitly changes the target project.

### 3. Huge files

If any VectorMind tool returns `huge_file_modularization_required`:

1. Stop normal feature work.
2. Call `plan_large_file_split({ project_root, file })`.
3. Perform mechanical modularization with real module names/directories.
4. Never create `*.generated.*`, `.parts`, `*.rs.parts`, or `part1/part2` fake split files.
5. Call `record_large_file_split(...)`.

### 4. After editing

Call:

```text
get_pending_changes({ project_root })
sync_change_intent({ project_root, intent, files? })
```

The intent should say what changed, why, and any follow-up.

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

- Use `query_codebase({ project_root, query })` for symbol/code location.
- Use `grep({ project_root, query })` for exact text matches.
- Use `read_file_lines(...)` or `read_file_text(...)` for bounded reads.
- Use `semantic_search(...)` for prior requirements, decisions, notes, code chunks, and docs.
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
