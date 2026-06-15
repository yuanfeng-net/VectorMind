# VectorMind MCP

VectorMind 是一个给 AI 编程助手使用的本地项目记忆 MCP。

它不只是“记笔记”，而是把需求、决策、代码改动、文件变化、项目约定、代码定位、上下文恢复都串起来，让 AI 在长期开发中更稳定地理解项目。

适合这些场景：

- 一个项目要连续开发很多天。
- 需求经常变更，旧逻辑容易被误用。
- AI 经常忘记前面为什么这样改。
- 换新会话后，希望 AI 能接着上次上下文继续做。
- 想让 AI 少猜路径、少乱翻文件、少输出大量无用日志。

当前版本：

```text
1.0.41
```

---

## 它能做什么

### 1. 项目上下文恢复

新会话开始时，VectorMind 可以把项目最近的状态恢复给 AI：

- 当前项目总结
- 最新决策
- 最近需求
- 最近改动原因
- 待同步文件变化
- 和当前任务相关的历史记录

这样 AI 不需要只靠当前聊天窗口猜项目背景。

---

### 2. 需求驱动开发

每个开发任务都可以先记录成一个需求。

AI 在改代码前知道：

- 这次要做什么
- 为什么要做
- 当前任务是否已经完成
- 后续改动应该归属到哪个需求

这能避免“改了很多文件，但没人知道当时为什么改”的问题。

---

### 3. 改动意图记录

每次改完代码后，VectorMind 可以记录这次改动的原因。

比如：

```text
将任务申请流程改为提交后直接通过，并移除上级审核分支。
```

以后 AI 再看到这些文件时，不只是知道“代码变了”，还能知道“为什么这么变”。

---

### 4. 最新决策优先

这是 VectorMind 很重要的一类能力。

例如：

> 一开始任务申请需要上级审核，后来改成申请直接通过。

后续 AI 再修改审核相关功能时，应该优先相信最新决策，而不是旧需求。

VectorMind 支持把新决策写成“当前权威决定”，并把旧需求或旧记录标记为过时。这样可以减少 AI 把功能改回老版本的问题。

---

### 5. 项目总结、笔记和约定

VectorMind 可以长期保存项目级信息，例如：

- 项目整体说明
- 架构说明
- 业务规则
- 命名规范
- 构建命令
- 不要再改回去的产品决策
- 后续 TODO

这些内容会在后续会话中自动参与上下文恢复。

---

### 6. 代码库定位

VectorMind 会维护项目文件和代码符号索引，让 AI 更容易回答：

- 这个函数在哪？
- 这个类在哪定义？
- 哪些文件提到了这个功能？
- 某个配置在哪里？

它提供比“让 AI 猜路径”更稳定的代码定位方式。

---

### 7. 项目文件阅读与搜索

VectorMind 提供适合 AI 使用的文件工具：

- 列出项目文件
- 读取指定文件片段
- 按行读取代码
- 搜索项目文本
- 读取 Codex skill / prompt / rule 文件

这些工具都有输出限制，避免一次性把大量文件内容塞进上下文。

---

### 8. 本地语义检索

VectorMind 可以从本地记忆中搜索相关内容，包括：

- 需求
- 改动意图
- 决策
- 笔记
- 项目总结
- 代码片段
- 文档片段

默认即可本地检索；如果需要，也可以开启 embeddings 增强语义召回。

---

### 9. Pending Changes 跟踪

VectorMind 会记录“文件已经变化，但还没有同步改动意图”的状态。

这样 AI 可以在改完文件后检查：

- 哪些文件还没记录原因
- 哪些改动还没归到当前需求
- 是否漏同步了某些文件

同时也会结合 Git 工作区状态作为补充，降低文件监听漏掉变化的风险。

---

### 10. 低 token 输出

VectorMind 的常用工具默认返回 compact 输出，而不是大段 JSON。

好处：

- 新会话恢复更轻
- 搜索结果更短
- 文件读取更可控
- 不容易把上下文撑爆

需要完整结构化数据时，也可以显式要求 JSON。

---

### 11. RTK 集成

VectorMind 包里带了一个 `rtk` 命令入口。

它可以帮助压缩 shell 命令输出，减少命令日志对 AI 上下文的占用。

常见用法：

```bash
rtk git status
rtk npm run build
rtk rg "keyword" src
```

---

### 12. 内置 AI 工作流提示

VectorMind MCP 会自动向支持的客户端下发工作流提示。

它会提醒 AI：

- 新会话先恢复上下文
- 写代码前先记录需求
- 改完后同步改动意图
- 需求变化时保存最新决策
- 不要盲猜代码位置
- 优先使用有边界的文件读取和搜索工具

也就是说，接入 MCP 后，不需要每次手动教 AI 一遍这些流程。

---

## 安装

推荐直接通过 npx 使用：

```bash
npx -y @coreyuan/vector-mind
```

也可以全局安装：

```bash
npm install -g @coreyuan/vector-mind
```

全局安装后会提供：

```text
vector-mind
rtk
```

---

## Codex 配置示例

在 `~/.codex/config.toml` 中添加：

```toml
[mcp_servers.vector-mind]
type = "stdio"
command = "npx"
args = ["-y", "@coreyuan/vector-mind"]
```

配置后重启 Codex。

---

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

---

## 推荐使用方式

### 新会话开始

可以这样对 AI 说：

```text
先用 VectorMind 恢复这个项目的上下文，再继续做。
```

### 开始新需求

```text
先记录这个需求：任务申请提交后直接通过，不需要上级审核。
```

### 改完代码后

```text
把这次改动原因同步到 VectorMind。
```

### 需求变更时

```text
这是最新决定：任务申请不再需要上级审核，申请后直接通过。请写入 VectorMind，并标记旧审核需求已过时。
```

这类“最新决定”非常重要。它能帮助 AI 后续优先使用新规则，而不是旧记录。

---

## 主要工具能力

你平时不需要记工具名，让 AI 自己调用即可。下面是 VectorMind 暴露的主要能力：

| 能力 | 工具 |
| --- | --- |
| 恢复上下文 | `bootstrap_context`, `get_brain_dump` |
| 记录需求 | `start_requirement`, `complete_requirement` |
| 记录改动原因 | `sync_change_intent`, `get_pending_changes` |
| 保存最新决策 | `upsert_decision`, `supersede_memory` |
| 保存长期信息 | `upsert_project_summary`, `add_note`, `upsert_convention` |
| 搜历史上下文 | `semantic_search`, `read_memory_item` |
| 找代码位置 | `query_codebase`, `grep` |
| 读项目文件 | `list_project_files`, `read_file_lines`, `read_file_text` |
| 读 Codex 配置/技能文件 | `read_codex_text_file` |
| 减少命令输出 token | `detect_rtk`, `install_rtk`, `get_token_savings` |
| 调试和清理 | `get_activity_summary`, `get_activity_log`, `clear_activity_log`, `prune_index` |

---

## 多项目使用

如果你同时在多个项目中使用 VectorMind，建议告诉 AI 当前项目路径：

```text
这个任务的项目路径是 H:\2025\YourProject，请 VectorMind 使用这个 project_root。
```

这样每个项目都会有自己的本地记忆，避免混在一起。

默认数据位置：

```text
<project>/.vectormind/
```

---

## 隐私说明

VectorMind 默认把数据保存在项目本地。

不开启 embeddings 时，记忆检索主要在本地完成，不需要上传代码。即使开启 embeddings，也可以通过环境配置控制模型和缓存位置。

---

## 更新后不生效怎么办

如果刚升级或发布了新版本，但客户端里看起来没变化：

1. 重启 Codex / VS Code / Claude 等客户端。
2. 开一个新会话。
3. 确认 MCP 配置仍然指向：

```bash
npx -y @coreyuan/vector-mind
```

---

## 开发与发布

```bash
npm install
npm run build
npm run smoke -- --roots=off --use-tool-project-root
npm publish --access public
```

---

## 一句话总结

VectorMind MCP 是一个面向 AI 编程助手的本地项目记忆系统。  
它让 AI 记住需求、决策、改动原因和项目约定，在长期开发中少丢上下文、少猜代码、少把旧功能改回来。
