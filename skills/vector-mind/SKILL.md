---
name: vector-mind
description: Use VectorMind MCP to keep per-project local context (requirements, change intents, notes, project summary, code/doc chunks) and avoid guessing. Use at session start to bootstrap_context, before edits to start_requirement, after saves to sync_change_intent, and use semantic_search/query_codebase for recall/navigation.
---

# VectorMind MCP Autopilot

## Overview

VectorMind is an MCP server that maintains a **local, per-project** context store (SQLite + optional embeddings) so the assistant can restore “what we’re doing / why we changed this” across sessions.

VectorMind data lives under the project root: `.vectormind/` (for example: `.vectormind/vectormind.db`).

## When to Use

Use this skill for any coding session where:
- You want the assistant to resume work accurately across chats/days
- You care about recording “intent/why” for code changes (not just git diffs)
- You want semantic recall over requirements/notes/summaries/code/docs

## Required Workflow (do this by default)

### 1) At the start of every new session (or resume)

- Unless the task is purely execution-first (for example compile/build/run/launch/package/publish/test rerun with already-known targets), call `bootstrap_context({ query: "<current goal>", top_k: 5 })` first.
- Use the returned summary/decisions/current_context/notes/pending changes/semantic matches to ground your plan.
- For pure execution-first tasks with explicit targets, prefer the minimum necessary shell or host tools first; only call retrieval/search tools when code or context lookup is actually needed to unblock execution.

### 2) Before editing code/files for a new task

- Call `start_requirement({ title: "<short title>", background: "<constraints/acceptance criteria>" })`.
- Treat this active requirement as the only change boundary. Do not add extra flows, fields, screens, APIs, or business rules the user did not ask for.
- Do not keep adding new feature code into an already-large file. Split into focused modules/services/components when a file is taking multiple responsibilities.

### 3) After editing + saving files

- Call `get_pending_changes()`
- Then call `sync_change_intent({ intent: "<what changed + why + next steps>", files?: <omit to auto-link pending> })`.
- If either tool returns `development_warnings`, address them before continuing or explain why the current requirement truly needs that scope.

### 4) Don’t guess paths or history

- Need a symbol location? Call `query_codebase({ query: "<name>" })`.
- Need an `rg -n`-style search with exact file+line+col matches? Call `grep({ query: "<pattern>" })` first; it now prefers ripgrep against real project files and only falls back to indexed search if ripgrep is unavailable.
- Need to read a file segment (like `Get-Content -TotalCount` / `head`)? Call `read_file_lines({ path: "<file>", total_count: 240 })` or `read_file_lines({ from_line, to_line })`.
- Avoid whole-file dumps, full-repo recursive listings, or broad raw match echo unless the user explicitly wants the raw output.
- Avoid editing completed or merely related features while working on a new requirement unless the current user request explicitly requires it.
- Need to recall context/notes/code/docs? Call `semantic_search({ query: "<question>", top_k: 8 })`.
- If a large or long-lived project feels slow, call `maintain_memory({ dry_run: true })` first, then apply with `dry_run: false` only when the plan looks safe.

### 5) Persist durable state before ending

- Call `upsert_project_summary({ summary: "<current state + next steps>" })`.
- Call `add_note({ title?, content, tags? })` for decisions/constraints/TODOs.
- When a newer user decision overrides older behavior, call `upsert_decision({ key, title, content, ... })` and supersede stale records when possible.

## Output Policy

- Don’t paste raw JSON tool output unless the user asks for verification/debugging.
- If tool output conflicts with assumptions, trust the tool output.
- This skill covers VectorMind memory usage and development-quality guidance.

## Setup Notes

This skill requires the VectorMind MCP server to be enabled in your client.

### Claude Desktop (example)

Add this under `mcpServers` in your Claude config, then restart Claude:

```json
{
  "mcpServers": {
    "vector-mind": {
      "command": "npx",
      "args": ["-y", "@coreyuan/vector-mind"]
    }
  }
}
```

### myclaude / Claude Code (optional: auto-suggest trigger)

If you use a rules file like `.claude/skills/skill-rules.json`, add a `vector-mind` entry with keywords like:
- “我现在要做什么”
- “继续/恢复/接着做”
- “总结项目/写总结/记录意图”
- “别猜/用工具/查符号/语义检索”

---

Remember: think in English, respond to user in Chinese.
