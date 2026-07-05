# VectorMind MCP

VectorMind 是一个给 AI 编程助手用的本地项目记忆 MCP。

它把“当前在做什么、为什么这样改、哪些决定已经更新、哪些文件不能乱动”保存到项目本地，帮助 AI 在长周期开发里少丢上下文、少猜路径、少把旧功能改回来。

当前版本：`1.0.49`

## 1.0.49 的效果

- 普通新功能遇到 3000 行以上实现文件，会被拦住，不再继续往巨量文件里堆代码。
- AI 会先收到 `huge_file_modularization_required`，并被要求进入机械搬迁式模块化拆分流程。
- 拆分会使用真实模块名和清晰目录，按完整函数、类型、类、impl、声明块搬迁。
- 拆分时禁止创建 `*.generated.*`、`.parts`、`*.rs.parts`、`part1/part2` 这类假拆分文件。
- 只有明确进入 `mechanical_modularization` 模式时，AI 才能继续操作巨量文件做拆分。
- 拆分计划和拆分结果会被记录，后续会话能知道这个文件正在或已经被拆，不会每次都只重复提示。
- 这只影响开发规范、文件边界和上下文记忆，不处理客户端运行权限或审批权限。

## 主要能力

- **恢复上下文**：新会话可恢复项目总结、最新决策、近期需求、近期改动、待同步变化。
- **记录需求**：每次开发先记录一个清晰需求，后续改动归属到这个需求下。
- **记录改动原因**：改完代码后保存“改了什么、为什么改”。
- **最新决策优先**：新规则可以覆盖旧记录，减少 AI 按旧需求回退功能。
- **项目知识沉淀**：保存项目总结、笔记、约定、构建命令、命名规则、TODO。
- **代码定位**：维护文件和符号索引，帮助 AI 找函数、类、配置、关键逻辑。
- **安全读文件/搜索**：提供有边界的文件列表、按行读取、文本搜索，避免一次塞入太多内容。
- **本地记忆搜索**：搜索需求、改动、决策、笔记、代码片段和文档片段。
- **Pending Changes**：发现“文件变了但还没记录原因”的改动。
- **开发边界检查**：改代码前检查目标文件是否超出当前需求，避免乱改相关但未要求的功能。
- **巨量文件拆分引导**：检测到巨量实现文件时，要求先做机械搬迁式模块化拆分，使用真实模块目录，禁止 `*.generated.*`、`.parts`、`*.rs.parts`、`part1/part2` 这类假拆分。
- **记忆维护**：压缩过旧记忆、清理无效索引，减轻大项目长期使用后的检索压力。
- **低 token 输出**：默认返回 compact 结果，也集成 `rtk` 来减少命令输出占用。
- **内置开发规范**：提供计划、架构、UI 输出、git 提交、长线程、大文件、需求边界等开发规范；只定义开发质量要求，不接管客户端操作权限。

## 安装

```bash
npx -y @coreyuan/vector-mind
```

或全局安装：

```bash
npm install -g @coreyuan/vector-mind
```

全局安装后会提供：

```text
vector-mind
rtk
```

## Codex 配置示例

在 `~/.codex/config.toml` 中添加：

```toml
[mcp_servers.vector-mind]
type = "stdio"
command = "npx"
args = ["-y", "@coreyuan/vector-mind"]
```

配置后重启 Codex，并开启新会话。

## Claude Desktop 配置示例

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

## 推荐用法

你不需要记工具名，直接这样告诉 AI 即可：

```text
先用 VectorMind 恢复这个项目的上下文，再继续做。
```

```text
这是最新决定：任务申请不再需要上级审核，申请后直接通过。请写入 VectorMind，并标记旧审核需求已过时。
```

```text
改完后，把这次改动原因同步到 VectorMind。
```

多项目使用时，建议明确项目路径：

```text
这个任务的项目路径是 H:\2025\YourProject，请 VectorMind 使用这个 project_root。
```

每个项目的数据默认保存在：

```text
<project>/.vectormind/
```

## 主要工具

| 能力 | 工具 |
| --- | --- |
| 恢复上下文 | `bootstrap_context`, `get_brain_dump` |
| 需求管理 | `start_requirement`, `complete_requirement` |
| 改动记录 | `sync_change_intent`, `get_pending_changes` |
| 开发边界检查 | `preflight_change_scope`, `development_warnings` |
| 巨量文件拆分 | `plan_large_file_split`, `record_large_file_split` |
| 最新决策 | `upsert_decision`, `supersede_memory` |
| 项目知识 | `upsert_project_summary`, `add_note`, `upsert_convention` |
| 搜索记忆 | `semantic_search`, `read_memory_item` |
| 代码定位 | `query_codebase`, `grep` |
| 读项目文件 | `list_project_files`, `read_file_lines`, `read_file_text` |
| 读 Codex 文本 | `read_codex_text_file` |
| 记忆维护 | `maintain_memory`, `prune_index` |
| token 节省 | `detect_rtk`, `install_rtk`, `get_token_savings` |
| 调试 | `get_activity_summary`, `get_activity_log`, `clear_activity_log` |

## 开发与发布

```bash
npm install
npm run build
npm run smoke -- --roots=off --use-tool-project-root
npm publish --access public
```

## 一句话

VectorMind 让 AI 记住需求、决策、改动原因和项目边界，在长期开发中少丢上下文、少乱改、少回退到旧逻辑。
