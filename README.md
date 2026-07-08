# VectorMind MCP

VectorMind 是给 AI 编程助手用的本地项目记忆 MCP。

它会把“当前在做什么、为什么这样改、哪些决策已经更新、哪些文件不能乱动、哪些改动对应哪个需求点”保存到项目本地，帮助 AI 在长期开发里少丢上下文、少猜路径、少把旧功能改回来。

当前版本：`1.0.52`

## 它能做什么

- **恢复上下文**：新会话可以找回项目摘要、最近需求、最近改动、决策、约定和待同步文件。
- **守住需求边界**：修改前先确认当前需求和计划文件，减少乱改无关模块。
- **逐条核对需求**：当需求有明确条目时，改动计划必须能对应到这些条目，避免 AI 自己扩展需求。
- **隔离多项目上下文**：同一会话切换项目时，会提示这是另一个项目的只读参考，减少串项目、串记忆。
- **记录改动原因**：改完后保存“改了什么、为什么改”，后续会话能接上。
- **让新决策覆盖旧记忆**：需求反转或规则更新后，可以标记旧记忆过时，避免 AI 按旧规则回退功能。
- **查看上下文时间线**：按需求、文件、记忆或关键词查看前后发生了什么，帮助判断新旧关系。
- **保存会话检查点**：长会话或交接前保存 waypoint，后续只读恢复上下文，不改变模型判断。
- **诊断记忆质量**：检查记忆冲突、重复记忆和 checkpoint 差异，只给证据，不自动修改。
- **沉淀项目知识**：保存架构说明、构建命令、命名规则、注意事项和 TODO。
- **定位代码和搜索文本**：帮 AI 找函数、类、配置、关键逻辑，不靠猜。
- **安全读取文件**：按目录、按行、按大小读取，避免一次塞入过多上下文。
- **治理巨量文件**：遇到几千行实现文件，会要求先做真实模块拆分，不继续往大文件里堆代码。
- **维护长期记忆**：压缩过时记忆、清理无效索引，减轻大项目越用越慢的问题。
- **减少输出占用**：默认返回简洁结果，并可配合 `rtk` 降低命令输出负担。

更完整的能力表见：`docs/capability-matrix.md`

## 安装后怎么用

安装并配置好 MCP 后，正常跟 AI 聊天即可。

VectorMind 会在背后自动恢复上下文、记录需求、检查改动范围、保存改动原因和维护长期记忆。用户不需要记工具名，也不需要手动按步骤调用。

## 巨量文件规则

当实现文件达到巨量阈值时，VectorMind 会提示：

- 不要继续往这个文件里加新功能。
- 先做机械搬迁式模块化拆分。
- 使用真实模块名和清晰目录。
- 禁止 `*.generated.*`、`.parts`、`*.rs.parts`、`part1/part2`、`1_xxx/2_xxx` 这类假拆分或排序式命名。
- 拆分计划和结果会被记录，后续会话知道这个文件正在或已经被治理。

## 它不做什么

VectorMind 只定义开发规范、记忆和质量约束。

它的输出只是上下文证据和质量信号，不替模型做决定，不削弱模型自己的推理、判断、创造和实现能力。

它不接管 Codex、Claude 或其他客户端的运行控制，也不处理客户端自己的确认弹窗、执行策略或访问设置。

## 安装

```bash
npx -y @coreyuan/vector-mind
```

或全局安装：

```bash
npm install -g @coreyuan/vector-mind
```

全局安装后可用：

```text
vector-mind
rtk
```

## Codex 配置

在 `~/.codex/config.toml` 添加：

```toml
[mcp_servers.vector-mind]
type = "stdio"
command = "npx"
args = ["-y", "@coreyuan/vector-mind"]
```

配置后重启 Codex，并开启新会话。

## Claude Desktop 配置

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

## 多项目使用

多数情况下直接正常聊天即可。若同一窗口里同时处理多个项目，可以明确告诉 AI 当前项目路径：

```text
这个任务的项目路径是 H:\2025\YourProject，请 VectorMind 使用这个 project_root。
```

每个项目的数据默认保存在：

```text
<project>/.vectormind/
```

如果同一个 MCP 会话里切换了 `project_root`，VectorMind 会给出跨项目提示。这个提示只说明“这是另一个项目的上下文证据”，不会接管 AI 的判断，也不会改客户端权限。

## 背后的能力

这些能力主要给 AI 客户端自动调用，普通用户不用手动操作。

| 能力 | 背后工具 |
| --- | --- |
| 恢复上下文 | `bootstrap_context`, `get_brain_dump` |
| 需求管理 | `start_requirement`, `preflight_change_scope`, `complete_requirement` |
| 改动记录 | `sync_change_intent`, `get_pending_changes` |
| 决策更新 | `upsert_decision`, `supersede_memory` |
| 项目知识 | `upsert_project_summary`, `add_note`, `upsert_convention` |
| 时间线/检查点 | `memory_timeline`, `create_checkpoint`, `list_checkpoints`, `restore_checkpoint_context` |
| 记忆诊断 | `analyze_memory_conflicts`, `memory_quality_report`, `compare_checkpoint_context` |
| 代码定位 | `query_codebase`, `grep` |
| 读项目文件 | `list_project_files`, `read_file_lines`, `read_file_text` |
| 读 Codex 文本 | `read_codex_text_file` |
| 巨量文件拆分 | `plan_large_file_split`, `record_large_file_split` |
| 记忆维护 | `maintain_memory`, `prune_index` |
| 调试/降噪 | `get_activity_summary`, `get_activity_log`, `get_token_savings`, `detect_rtk` |

## 开发与发布

```bash
npm install
npm run build
npm run smoke -- --roots=off --use-tool-project-root
npm publish --access public
```

## 一句话

VectorMind 让 AI 记住需求、决策、改动原因和项目边界，在长期开发中少丢上下文、少乱改、少回退到旧逻辑。
