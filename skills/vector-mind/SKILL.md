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
- Use the returned summary/notes/pending changes/semantic matches to ground your plan.
- For pure execution-first tasks with explicit targets, prefer the minimum necessary shell or host tools first; only call retrieval/search tools when code or context lookup is actually needed to unblock execution.

### 2) Before editing code/files for a new task

- Call `start_requirement({ title: "<short title>", background: "<constraints/acceptance criteria>" })`.

### 3) After editing + saving files

- Call `get_pending_changes()`
- Then call `sync_change_intent({ intent: "<what changed + why + next steps>", files?: <omit to auto-link pending> })`.

### 4) Don’t guess paths or history

- Need a symbol location? Call `query_codebase({ query: "<name>" })`.
- Need an `rg -n`-style search with exact file+line+col matches? Call `grep({ query: "<pattern>" })` first; it now prefers ripgrep against real project files and only falls back to indexed search if ripgrep is unavailable.
- Need to read a file segment (like `Get-Content -TotalCount` / `head`)? Call `read_file_lines({ path: "<file>", total_count: 240 })` or `read_file_lines({ from_line, to_line })`.
- Avoid whole-file dumps, full-repo recursive listings, or broad raw match echo unless the user explicitly wants the raw output.
- Need to recall context/notes/code/docs? Call `semantic_search({ query: "<question>", top_k: 8 })`.

### 5) Persist durable state before ending

- Call `upsert_project_summary({ summary: "<current state + next steps>" })`.
- Call `add_note({ title?, content, tags? })` for decisions/constraints/TODOs.

## Output Policy

- Don’t paste raw JSON tool output unless the user asks for verification/debugging.
- If tool output conflicts with assumptions, trust the tool output.
- When generating or modifying page/UI/frontend code, never leak the current conversation’s prompts, instructions, chain-of-thought, task list, or tool guidance into source code, comments, mock data, placeholder copy, or rendered UI. Do not add explanatory/meta text that only exists to describe the AI workflow; final delivery should stay as pure business code plus only real business copy required by the product.
- If the current thread is already heavy or the user reports it has become slow, reduce retrieval churn, keep outputs shorter, and recommend moving substantial new analysis to a fresh thread after a short handoff summary.
- If the thread has already hit `413 Payload Too Large` / `Request Entity Too Large`, immediately switch to bounded reads + summaries only; avoid continuing with high-volume shell or file output in that same thread.
- Thread-switch judgment must not rely on a fixed token threshold; use observable signals plus the weight of the upcoming work.
- If the current thread is heavy, repeatedly compacting, slow, or has already hit `413 Payload Too Large` / `Request Entity Too Large`, and the next work still needs broad analysis / cross-module investigation / release validation / long continuation, pause once and ask whether to switch to a fresh thread before continuing.
- If the user declines that switch, continue in the current thread, keep light mode + bounded output, and do not raise the thread-switch reminder again in that same session.
- If the user accepts, do not attempt to create a new thread for the user and do not claim that a new thread has already been created.
- If the user accepts, or explicitly asks to pack the current conversation for a new thread, use `add_note(...)` to create a concise handoff note instead of dumping a long inline pack.
- The handoff note should cover at least: 当前目标、当前状态或已完成、未完成与下一步、关键约束、关键文件，以及如有则必须继续参考的相关 note ids.
- User-visible output should stay minimal: say it was packed, give the new handoff note id, optionally list other required note ids, then tell the user: `新线程里直接说明“读取 note <id> [和 note <id>] 继续”即可无缝接上。`

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
