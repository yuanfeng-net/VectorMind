# VectorMind 能力矩阵

VectorMind 的目标不是替代 AI，也不是接管客户端权限，而是让 AI 在长期开发里更少丢上下文、更少乱改、更少把旧需求改回来。它只提供上下文证据和质量信号，不削弱模型自己的推理、决策、创造和实现能力。

| 能力 | 解决的问题 | 主要工具 | 当前限制 |
| --- | --- | --- | --- |
| 上下文恢复 | 新会话不知道项目现状、最近做过什么 | `bootstrap_context`, `get_brain_dump` | 需要 AI/客户端主动调用 |
| 需求边界 | 新需求顺手改到无关模块 | `start_requirement`, `preflight_change_scope`, `complete_requirement` | 不能替代宿主的文件写入 hook |
| 改动意图 | 文件变了但不知道为什么 | `sync_change_intent`, `get_pending_changes` | 需要改完后同步 |
| 最新决策优先 | 旧规则被重新召回，功能被改回老版本 | `upsert_decision`, `supersede_memory` | 需要把关键决策写入 MCP |
| 项目知识沉淀 | 构建命令、约定、架构信息散在聊天里 | `upsert_project_summary`, `add_note`, `upsert_convention` | 内容质量取决于写入是否清晰 |
| 上下文时间线 | 不知道某个需求/决策前后发生了什么 | `memory_timeline` | 只提供证据，不替模型判断因果 |
| 会话检查点 | 长会话压缩、交接后难以恢复阶段状态 | `create_checkpoint`, `list_checkpoints`, `restore_checkpoint_context` | 恢复是只读上下文，不改变当前状态 |
| 记忆诊断 | 怀疑旧记忆冲突、重复、checkpoint 漂移 | `analyze_memory_conflicts`, `memory_quality_report`, `compare_checkpoint_context` | 只读报告，不自动清理、不扩大需求范围 |
| 代码定位 | AI 猜文件、全仓乱搜 | `query_codebase`, `grep` | 符号索引依赖文件变更和索引质量 |
| 有界读文件 | 大文件一次性塞满上下文 | `list_project_files`, `read_file_lines`, `read_file_text`, `read_codex_text_file` | 只读文本，不替代编辑器 |
| 巨量文件治理 | 几千/几万行文件继续堆功能 | `plan_large_file_split`, `record_large_file_split` | 给计划和约束，不自动改代码 |
| 记忆维护 | 大库越用越慢、旧索引干扰检索 | `maintain_memory`, `prune_index` | 默认保守，深度清理需手动触发 |
| 输出降噪 | 工具输出太大拖慢会话 | compact 输出、`get_token_savings`, `rtk` | 需要客户端/模型优先使用 compact |
| 调试排查 | 不知道 MCP 最近做了什么 | `get_activity_summary`, `get_activity_log`, `clear_activity_log` | 详细日志需开启 debug |

## 推荐调用链路

开发任务建议遵循：

1. `bootstrap_context`
2. `start_requirement`
3. `preflight_change_scope`
4. 修改文件
5. `get_pending_changes`
6. `sync_change_intent`
7. 需要时：`upsert_decision` / `supersede_memory`
8. 需要追溯时：`memory_timeline`
9. 长会话/交接时：`create_checkpoint` / `restore_checkpoint_context`
10. 怀疑记忆异常时：`analyze_memory_conflicts` / `memory_quality_report` / `compare_checkpoint_context`
11. 完成时：`upsert_project_summary` / `complete_requirement`

## 已知不足

- MCP 不能强制所有 AI 一定调用工具；它提供规则、工具和警告，但最终执行取决于宿主客户端和模型。
- 目前搜索是本地 FTS / token / LIKE 召回，稳定轻量，但不是外部 embedding 服务。
- 巨量文件拆分是“计划 + 约束 + 记录”，不是 AST 自动重构器。
- 关键业务规则必须被写成 decision / convention / requirement scope，才能在后续会话里稳定生效。
