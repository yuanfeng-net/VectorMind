# VectorMind MCP（Requirement-Driven）

VectorMind 是一个 **“以需求为核心”的 MCP 上下文记忆工具**：把每一次代码修改都绑定到一个明确的需求意图（Intent），让你在和 AI 反复对话、切换会话、隔天继续时，**不再靠 AI 盲猜“为什么改这段代码”**。

## 它解决什么问题

- **AI 经常丢上下文**：隔一段时间/换个会话，AI 不知道当前在做哪个需求、改动做到哪一步。
- **改动没有“为什么”**：Git 记录了“改了什么”，但很少记录“为什么这么改/当时的目标是什么”。
- **代码库定位靠猜**：想找某个类/函数在哪里，AI 容易给出错误路径或过时结论。

VectorMind 通过本地文件监听 + SQLite 关系记忆，把“需求 → 改动意图 → 文件/符号索引”串起来，帮助 AI **恢复进度、追溯意图、快速定位代码**。

## 关键能力（What you get）

- **需求追踪（requirements）**：在写代码前创建/激活一个需求，明确目标与业务背景。
- **改动意图归档（change_logs）**：每次保存后把“改动意图 + 影响文件”写入数据库，并关联到当前激活需求。
- **符号索引（symbols）**：实时维护类/函数/类型等符号表，用于快速 query 定位定义位置。
- **项目总结 & 笔记（memory_items）**：把“项目总结/关键决策/约束/待办”等上下文以结构化条目持久化到本地。
- **代码片段 & 文档分块索引（memory_items）**：监听文件变更，把代码/文档切成可检索的 chunk 存入本地。
- **上下文检索（semantic_search）**：默认使用本地 SQLite FTS 做召回（无需模型）；可选开启 embeddings，用向量相似度增强语义召回。
- **会话恢复（brain dump）**：新会话开始时一键拉取最近需求与对应的改动意图，AI 直接接着做。

## 工作流（强烈推荐）

1) **新会话开始**：AI 先调用 `bootstrap_context({ query: 当前目标 })`（或 `get_brain_dump()`）恢复上下文并做一次语义召回  
2) **准备开始写代码前**：AI 调用 `start_requirement(title, background)`  
3) **每次改完并保存后**：AI 调用 `get_pending_changes()` 查看待同步文件，再调用 `sync_change_intent(intent, files)`（可省略 files 让服务端自动关联所有 pending）  
4) **阶段性收口**（重要）：AI 在对话里写好总结，然后调用 `upsert_project_summary(summary)`/`add_note(...)` 持久化  
5) **需求完成时**：AI 调用 `complete_requirement()` 把需求标记为 `completed`（避免一直显示“处理中”）  
5) **需要找代码定义时**：AI 调用 `query_codebase(query)`（不要靠猜）  
6) **需要按语义找上下文/代码/文档时**：AI 调用 `semantic_search(query, ...)`（不要靠猜）

> 本 MCP Server 会在初始化时下发 `instructions`，提示 AI 按以上流程调用工具（避免盲猜）。
> 这些 `instructions` 是**随包内置**的：只要用户安装并连接这个 MCP，就会自动拿到这层基础提示词；**不需要**他们再去写本地 config / policy 文件。

## MCP Tools

> 提示：所有 tools 都支持可选参数 `project_root?: string`。当你的 MCP Client 无法提供正确的 workspace root（例如 Codex VS Code 插件 cwd/roots 不可靠）时，**务必显式传入**。  
> `project_root` 既可以是目录，也可以是某个文件路径/`file://` URI（服务端会向上查找 `.git/`、`package.json`、`pyproject.toml` 等标记来推断项目根目录）。

### `start_requirement`
- 入参：`{ title: string, background?: string, close_previous?: boolean }`
- 用途：创建并激活一个需求（后续改动意图会自动关联到最新 `active` 需求）
- 说明：默认 `close_previous=true`，会把之前所有 `active` 需求标记为 `completed`（符合“单一 active 需求”的工作流）

### `complete_requirement`
- 入参：`{ req_id?: number, all_active?: boolean }`
- 用途：把某个需求（或当前 active 需求）标记为 `completed`，避免一直显示“处理中”

### `read_memory_item`
- 入参：`{ id: number, offset?: number, limit?: number }`
- 用途：按 `id` 读取某条 `memory_items` 的全文内容（支持 offset/limit 分段），用于“需要时再取全文”，避免 `bootstrap_context/semantic_search` 每次都带大段文本导致 tokens 暴涨

### `upsert_convention`
- 入参：`{ key: string, content: string, tags?: string[] }`
- 用途：保存/更新“项目约定/规范”（框架选型、build 命令、产物路径、命名规则等），并在新会话通过 `bootstrap_context/get_brain_dump` 自动带出（仅 preview）

> 区分：
> - **内置全局规则**：写在 MCP 包源码里，会通过 `instructions` + `bootstrap_context/get_brain_dump` 自动下发给所有安装者
> - **项目级规则**：通过 `upsert_convention` 保存，只对当前 `project_root` 生效
>
> 当前包内置的全局规则包括：
> - 写操作规则只在代码开发、文件创建、修改、删除、移动等场景中生效，不干扰模型的分析、决策、实现路径与普通非写操作流程
> - 所有代码或文件改动仅允许在当前活跃分支中进行；禁止创建、切换或使用临时分支、临时子分支，除非用户明确要求
> - 修改文件前必须先取得独占签出；若环境没有真实签出/签入工具，也必须按当前会话内的独占声明与释放执行，不得虚构工具调用
> - 同一文件同一时刻只允许一个活跃线程持有签出；其他线程必须等待该文件签入后才能继续，等待期间每 10 秒检查一次状态，且不得处理其他任务或其他文件
> - 多文件任务必须先声明全部目标文件集合，并按固定顺序依次签出；未签出的文件不得开始改动
> - 文件签出超过 10 分钟且当前没有其他活跃线程仍在处理时，必须先确认该文件没有明显未完成编辑痕迹；确认后才可签入，否则保留签出并报告原因
> - 若无法确认已满足规则，必须停止写入并报告，不得绕过

### `sync_change_intent`
- 入参：`{ intent: string, files?: string[], affected_files?: string[] }`
- 用途：把“这次改动的意图摘要”写入 `change_logs`，并与当前激活需求关联  
- 说明：如果不传 `files`，服务端会自动把“最近未同步的文件变更（pending）”关联到本次意图；如果没有激活需求，会返回错误并提示先 `start_requirement`

### `get_brain_dump`
- 入参：`{ requirements_limit?: number, changes_limit?: number, notes_limit?: number, preview_chars?: number, include_content?: boolean, pending_offset?: number, pending_limit?: number }`
- 用途：返回最近需求/改动意图 + 项目总结/笔记 + pending changes（用于会话恢复）
- 说明：默认输出为 **compact**（返回 preview，不返回大段全文）；需要更长正文时：优先用 `read_memory_item` 按需取全文（分段），而不是在这里开全量 `include_content`

### `bootstrap_context`
- 入参：`{ query?: string, top_k?: number, kinds?: string[], include_content?: boolean, preview_chars?: number, content_max_chars?: number, requirements_limit?: number, changes_limit?: number, notes_limit?: number, pending_offset?: number, pending_limit?: number }`
- 用途：返回 brain dump + pending changes；如果传入 `query`，会额外返回本地记忆库的检索结果（推荐新会话开始就用它）
- 说明：
  - 为避免某些客户端（如 Claude Code）因 tool output 过大报错，`pending_changes` 默认会分页返回；可用 `pending_offset/pending_limit` 翻页。
  - 默认输出为 **compact**（返回 preview，不返回大段全文）；需要全文时：优先用 `read_memory_item` 按需取（分段），而不是在这里打开 `include_content`
  - `conventions` 会先返回**包内置的全局规则**，再补充当前项目自己保存的 convention

### `get_pending_changes`
- 入参：`{ offset?: number, limit?: number }`
- 用途：返回本地“已发生变更但尚未被 sync_change_intent 确认”的文件列表（便于 AI 不漏同步）

### `grep`
- 入参：`{ query: string, mode?: "regex"|"literal", smart_case?: boolean, case_sensitive?: boolean, literal_hint?: string, kinds?: string[], include_paths?: string[], exclude_paths?: string[], max_results?: number, max_candidates?: number }`
- 用途：优先使用 `ripgrep` 对真实项目文件做全文匹配，返回精确 `file_path + line + col`；会自动避开内置忽略目录和典型构建噪音；只有在本机找不到可执行 `rg` 时，才回退到索引搜索
- 说明：
  - 默认 `mode="regex"`（更接近 ripgrep 行为）；如果你要纯文本查找，传 `mode="literal"`
  - 默认 `smart_case=true`：未显式传 `case_sensitive` 时，“包含大写则大小写敏感，否则不敏感”（类似 `rg -S`）
  - `literal_hint` / `kinds` / `max_candidates` 主要是给“`ripgrep` 不可用时的索引回退”保留的兼容参数；正常 `ripgrep` 路径下通常不需要关心

### `read_file_lines`
- 入参：`{ path: string, from_line?: number, to_line?: number, total_count?: number, max_lines?: number, max_chars?: number }`
- 用途：按行读取文件片段（带硬限制避免 tokens 爆炸），用于替代 `Get-Content -TotalCount ...` / `head`
- 说明：
  - `path` 可以是相对 `project_root` 的路径，也可以是 `project_root` 下的绝对路径（越界会报错）
  - 如果不传 `to_line`，会使用 `total_count`（默认 200）从 `from_line` 起读取

### `query_codebase`
- 入参：`{ query: string }`
- 用途：按名称/签名模糊搜索 `symbols`，返回匹配的 `file_path` 与 `signature`

### `upsert_project_summary`
- 入参：`{ summary: string }`
- 用途：保存/更新“项目级上下文总结”（由 AI 在对话里写好再保存），用于跨会话快速恢复
- 返回：默认仅返回 `{ id, updated_at }`（避免把长总结再回传一遍增加 tokens）

### `add_note`
- 入参：`{ title?: string, content: string, tags?: string[] }`
- 用途：保存一条“可持久化的项目笔记”（决策、约束、TODO、架构说明等）

### `semantic_search`
- 入参：`{ query: string, top_k?: number, kinds?: string[], include_content?: boolean, preview_chars?: number, content_max_chars?: number }`
- 用途：对本地记忆库进行检索（覆盖需求/意图/笔记/项目总结/代码 chunk/文档 chunk）。如启用 embeddings，会优先走向量相似度；否则使用本地 FTS/LIKE。

### `prune_index`
- 入参：`{ dry_run?: boolean, prune_ignored_paths?: boolean, prune_minified_bundles?: boolean, max_files?: number, vacuum?: boolean }`
- 用途：清理历史上误索引/噪音的 `code_chunk/doc_chunk` 与 `symbols`（例如构建产物目录、新增忽略规则后遗留内容）。默认 `dry_run=true` 只统计，不实际删除。

## 本地数据与监听

- 数据库：默认使用 MCP `roots/list` 提供的 workspace root（否则回退到 `process.cwd()`，也可用 `VECTORMIND_ROOT` 强制指定）创建 `.vectormind/vectormind.db`（默认已在 `.gitignore` 中忽略整个 `.vectormind/` 目录）
- 监听范围：默认监听 workspace root（同上）下文件变动（默认忽略 `.git/`、`node_modules/`（含子目录）、`.vs/`、`bin/`、`obj/`、`dist/`、`build/`、`out/`、`artifacts/`、`buildFiles/`、以及 `.turbo/`、`.nx/`、`.cache/`、`.parcel-cache/` 等常见噪音目录/产物）
- 自动清理：启动时会自动删除“已忽略目录”与常见噪音文件名（如 lockfile、`.min.js/.bundle.js/.chunk.js`）下历史遗留的 `code_chunk/doc_chunk` 与 `symbols`，避免数据库持续膨胀影响召回效果。
- 符号抽取：目前为轻量正则抽取（非 AST 解析），支持常见语言如 TS/JS、Python、Go、Rust、C/C++
- 检索：默认使用本地 SQLite FTS（无需模型）；当你设置 `VECTORMIND_EMBEDDINGS=on` 才会启用向量化（`@xenova/transformers`），并优先用向量相似度做语义召回（首次启用可能下载模型权重，向量与数据都在本地）

> 注意：当 `root_source` 为 `fallback`（例如被 VS Code/Codex 在 `C:\Windows\System32` 启动，且 client 不支持 `roots/list`）时，为避免错误目录被大量扫描，VectorMind 会 **禁用文件监听/索引**（`watcher_enabled=false`）。此时请使用 `project_root` 绑定到正确项目。

## 检索/向量化配置（可选）

- `VECTORMIND_ROOT=...`：强制指定“项目根目录”（当你的 MCP Client 无法提供 workspace roots 或启动目录不对时使用）
- `VECTORMIND_PRETTY_JSON=1`：让 tool 输出使用缩进 JSON（仅用于调试；会增加 tokens，默认不建议开启）
- `VECTORMIND_DEBUG_LOG=1`：开启 MCP 调试活动日志（索引了什么/检索了什么/同步了什么），并提供 `get_activity_summary/get_activity_log/clear_activity_log` 工具拉取/清空日志（默认关闭）
- `VECTORMIND_DEBUG_LOG_MAX=200`：调试日志最大保留条数（默认 200）
- `VECTORMIND_PENDING_FLUSH_MS=200`：pending 变更写入 SQLite 的缓冲/合并间隔（单位 ms；默认 200；设为 0 表示每次事件都立刻写入）
- `VECTORMIND_PENDING_TTL_DAYS=30`：pending 记录的自动过期天数（默认 30；设为 0 表示不过期）
- `VECTORMIND_PENDING_MAX=5000`：pending 表最大条目数（默认 5000；超过后会删除最旧记录以避免无限膨胀）
- `VECTORMIND_PENDING_PRUNE_EVERY=500`：每累计多少条 pending 事件触发一次 prune（默认 500；越小越及时但更频繁做清理）
- `VECTORMIND_INDEX_MAX_CODE_BYTES=400000`：单文件最大索引字节数（代码类，默认 400KB；超过会跳过索引，避免 bundle/产物膨胀）
- `VECTORMIND_INDEX_MAX_DOC_BYTES=600000`：单文件最大索引字节数（文档/配置类，默认 600KB；超过会跳过索引）
- `VECTORMIND_INDEX_SKIP_MINIFIED=1`：跳过疑似 minified/bundle 的 JS/CSS（默认开启；能显著减少构建产物噪音）
- `VECTORMIND_INDEX_AUTO_PRUNE_IGNORED=1`：启动时自动清理“已被忽略目录”下历史遗留的 chunk/symbol 索引（默认开启）
- `VECTORMIND_EMBEDDINGS=on|off`：是否启用向量化（默认 `off`；开启后会启动本地 embedding 模型，`semantic_search` 优先走向量相似度；关闭则走本地 FTS/LIKE，不会生成向量/启动模型）
- `VECTORMIND_EMBED_FILES=all|changed|none`：控制是否向量化“代码/文档 chunk”（默认 `all`；`none` 只影响 chunk，仍会向量化需求/意图/笔记/总结；`changed` 仅在 change/manual 时向量化 chunk）
- `VECTORMIND_EMBED_MODEL=...`：指定 embedding 模型（默认 `Xenova/all-MiniLM-L6-v2`）
- `VECTORMIND_EMBED_CACHE_DIR=...`：指定模型缓存目录
- `VECTORMIND_ALLOW_REMOTE_MODELS=false`：禁止下载远端模型（适合离线环境）

## 安装与运行

### 本地开发运行

```bash
npm install
npm run build
node dist/index.js
```

## 发布到 NPM（建议）

1) 修改 `package.json` 的 `name` 为你的实际包名（例如 `@coreyuan/vector-mind`）  
2) 登录并发布：

```bash
npm login
npm publish
```

> 说明：已配置 `prepublishOnly`（发布前自动 `npm run build`）与 `publishConfig.access=public`（适用于 scoped 包）。

## 快速测试（Smoke）

```bash
# 只测工具/索引/同步流程（不下载 embedding 模型）
npm run smoke

# 测试向量化 + 语义检索（首次会下载本地模型权重）
npm run smoke -- --embeddings=on
```

### 以 NPM 包方式运行（发布后）

```bash
npx -y @coreyuan/vector-mind
```

## 在 MCP Client 中配置（stdio）

不同客户端配置格式略有差异，但核心都是：用 `stdio` 启动一个命令。

- 本地构建版本（示例）：
  - `command`: `node`
  - `args`: `["/absolute/path/to/your/project/dist/index.js"]`

- 发布后（示例）：
  - `command`: `npx`
  - `args`: `["-y", "@coreyuan/vector-mind"]`

通常情况下客户端会通过 MCP `roots/list` 自动提供 workspace root，因此无需写死目录，配置如下：

> 如果客户端不支持或不响应 `roots/list`，VectorMind 会快速回退到 `process.cwd()`（可用 `VECTORMIND_ROOTS_TIMEOUT_MS` 调整 roots 请求超时时间，默认 750ms）。
```json
{
  "command": "npx",
  "args": ["-y", "@coreyuan/vector-mind"]
}
```

如果你发现 `.vectormind/vectormind.db` 落在了错误目录（或你的 MCP Client 不支持 `roots/list`），再加上：
```json
{
  "command": "npx",
  "args": ["-y", "@coreyuan/vector-mind"],
  "env": { "VECTORMIND_ROOT": "H:\\\\path\\\\to\\\\your-project" }
}
```

### Codex（`config.toml`）：不要固定 MCP Server 的 `cwd`（让它跟随项目）

Codex 目前不会通过 MCP `roots/list` 提供 workspace roots；因此要实现“每个项目一个 `<project>/.vectormind/`”，推荐两种方式：

1) **让 Codex 在你的项目目录启动**（或用 `codex -C <project>` 指定工作目录），然后 VectorMind 就会用 `process.cwd()` 作为 `project_root`。
2) **在每次工具调用里显式传 `project_root`**（当你的 Codex/VS Code 启动 MCP server 的工作目录不等于项目根目录时尤其有用）。

> `project_root` 可以作为 VectorMind 所有 tools 的可选参数；一旦提供，VectorMind 会切换到该项目并在 `<project_root>/.vectormind/` 下读写数据库与索引。

```toml
[mcp_servers.vector-mind]
type = "stdio"
command = "npx"
args = ["-y", "@coreyuan/vector-mind"]
# 不要设置 cwd：让它跟随 Codex 的工作目录（也就是你的项目目录）
```

**不要在全局 `config.toml` 里写死：**
- `cwd = "..."`（会把 VectorMind 锁死到一个项目）
- `env = { VECTORMIND_ROOT = "..." }`（同样会锁死到一个项目）

> 如果你确实要固定到单一项目（少见）：那就可以设置 `cwd` 或 `VECTORMIND_ROOT`；但这会破坏“多项目隔离”。

配置完成后，客户端会在初始化阶段拿到该服务器的 tools + instructions；AI 就能“知道它存在”，并在需要时调用，而不是盲猜。

## Skills（可选：让用户“无感”自动调用）

> 说明：Skill 不是跨所有 AI 通用标准，不同客户端的“Skill”格式不同；但 MCP Server 本身是通用的（支持 MCP 的客户端都能用）。

### Codex Skills（OpenAI Codex）

- 安装：把 `skills/vector-mind-autopilot` 复制到 `~/.codex/skills/vector-mind-autopilot`（Windows: `C:\Users\<you>\.codex\skills\vector-mind-autopilot`）
  - `skill-dist/vector-mind-autopilot.skill` 只是一个 zip 包；Codex 不会“放进去就识别”，需要解压到上面的目录结构里才会生效。
- 使用：**重启 Codex（或重启 VS Code）并开启一个新会话/新 Agent** 后正常聊天即可；如未触发，可在对话里提一次 `$vector-mind-autopilot`
  - 验证是否加载：新会话开头的 `## Skills` 列表里应包含 `vector-mind-autopilot`；如果你一直在同一个会话里对话，更新 skill 不会热加载。

### Claude Skills（Claude Code / myclaude）

- 安装：把仓库里的 `skills/vector-mind` 复制到 `~/.claude/skills/vector-mind`（Windows: `C:\Users\<you>\.claude\skills\vector-mind`）
- 使用：重启后就会被识别为一个 Skill（可配合 `.claude/skills/skill-rules.json` 加关键词触发）

### Claude Desktop（Project Instructions）

- MCP 配置参考：`skills/vector-mind-autopilot/references/claude-desktop-mcp-config.json`
- 指令参考（复制到 Project Instructions / Custom Instructions）：`skills/vector-mind-autopilot/references/claude-project-instructions.md`

## 典型示例

你：我想加“用户头像上传功能”。  
AI：调用 `start_requirement("用户头像上传功能", "支持 PNG/JPG")`。  
你/AI：改完 `upload.ts` 和 `user.model.ts` 并保存。  
AI：调用 `sync_change_intent("增加 Multer 配置，并在 user model 增加 avatar 字段", ["upload.ts","user.model.ts"])`。  
AI：在对话里写一段阶段总结后，调用 `upsert_project_summary("...")`。  
下次新会话：AI 先 `get_brain_dump()`，再用 `semantic_search("头像上传下一步是什么？")` 快速定位相关上下文与代码位置。

## 注意事项

- `sync_change_intent` 只会关联到“最近的 active 需求”；如需并行多需求，建议先把一个需求标记完成（当前版本未提供 completion tool）。
- 符号索引是启发式的，复杂语法/宏/生成代码可能不完整；如需更高精度，可扩展为 AST/语言服务器方案。

使用方式

你可以直接发这句来测试（推荐新会话第一句就这么发）：
```
请先调用 vector-mind 的 bootstrap_context({ query: "我现在要做什么？" })，把返回的 JSON 原样贴出来，然后再继续回答。
```
怎么确认它真的调用了：

对话里会出现一次 tool 调用记录/卡片（不同客户端 UI 不一样）
或者你让它把 bootstrap_context 返回的 JSON 原样输出（里面会有 ok: true；新版还会带 project_root/root_source/watcher_enabled/db_path 用来确认落库与监听是否在正确项目）

如果你希望“每次都自动调用”，就在你的固定/system 指令里加一句：

```
每次新会话开始先调用 bootstrap_context，再开始分析/改代码。
```

如果在项目根目录中没有生成.vectormind文件夹，需要手动发送以下命令给AI来绑定目录

```
每次调用 VectorMind 工具时，要主动把 project_root 参数传进去
```
