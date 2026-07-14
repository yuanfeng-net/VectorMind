# VectorMind 能力矩阵

VectorMind 的目标不是替代 AI，也不是接管客户端权限，而是让 AI 在长期开发里更少丢上下文、更少乱改、更少把旧需求改回来。它提供上下文证据和质量信号；普通信号是 advisory，巨量文件治理是明确且有限的 workflow gate，但仍不控制宿主运行或替代模型推理。

| 能力 | 解决的问题 | 主要工具 | 当前限制 |
| --- | --- | --- | --- |
| 上下文恢复 | 新会话不知道项目现状、最近做过什么 | `bootstrap_context`, `get_brain_dump` | focused 只锚定 active requirement；已完成历史需显式展开 |
| 需求边界 | 新需求顺手改到无关模块或并发任务串线 | `start_requirement`, `preflight_change_scope`, `complete_requirement` | 并发任务必须传递 `req_id` 或 `goal_key` |
| 改动意图 | 文件变了但不知道为什么 | `sync_change_intent`, `get_pending_changes` | 需要改完后同步 |
| 最新决策优先 | 旧规则被重新召回，功能被改回老版本 | `upsert_decision`, `supersede_memory` | 需要把关键决策写入 MCP |
| 项目知识沉淀 | 构建命令、约定、架构信息散在聊天里 | `upsert_project_summary`, `add_note`, `upsert_convention` | 内容质量取决于写入是否清晰 |
| 上下文时间线 | 不知道某个需求/决策前后发生了什么 | `memory_timeline` | 只提供证据，不替模型判断因果 |
| 会话检查点 | 长会话压缩、交接后难以恢复阶段状态 | `create_checkpoint`, `list_checkpoints`, `restore_checkpoint_context` | 恢复是只读上下文，不改变当前状态 |
| 记忆诊断 | 怀疑旧记忆冲突、重复、checkpoint 漂移 | `analyze_memory_conflicts`, `memory_quality_report`, `compare_checkpoint_context` | 只读报告，不自动清理、不扩大需求范围 |
| 代码定位 | AI 猜文件、全仓乱搜 | `query_codebase`, `grep` | 符号索引依赖文件变更和索引质量 |
| 有界读文件 | 大文件一次性塞满上下文 | `list_project_files`, `read_file_lines`, `read_file_text`, `read_codex_text_file` | 只读文本，不替代编辑器 |
| 巨量文件治理 | 几千/几万行文件继续堆功能 | `plan_large_file_split`, `record_large_file_split` | 低置信度启发式流式计划；强制目标模块大小约束，实际搬迁仍由 AI/开发者判断完成 |
| 记忆维护 | 大库越用越慢、旧索引干扰检索 | `maintain_memory`, `prune_index` | 默认保守，深度清理需手动触发 |
| 输出降噪 | 工具输出太大拖慢会话 | compact 输出、`get_token_savings`, `rtk` | 需要客户端/模型优先使用 compact |
| 调试排查 | 不知道 MCP 最近做了什么 | `get_activity_summary`, `get_activity_log`, `clear_activity_log` | 详细日志需开启 debug |

## 推荐调用链路

开发任务建议遵循：

1. `bootstrap_context({ project_root, query, context_mode: "focused" })`
2. `start_requirement(...)`，保存返回的 `requirement.id` 或 `goal_key`
3. `preflight_change_scope({ project_root, req_id?, goal_key?, intent, files })`
4. 若出现 `huge_file_modularization_required`，调用 `plan_large_file_split` 保存 `plan_id`，携带该计划重新 preflight，执行机械拆分并用 `record_large_file_split` 更新同一计划
5. 修改文件
6. 仅在文件列表未知或诊断范围漂移时调用 `get_pending_changes`
7. `sync_change_intent({ project_root, req_id?, goal_key?, intent, files })`
8. 需要时：`upsert_decision` / `supersede_memory`
9. 需要追溯时：`memory_timeline`
10. 长会话/交接时：`create_checkpoint` / `restore_checkpoint_context`
11. 怀疑记忆异常时：`analyze_memory_conflicts` / `memory_quality_report` / `compare_checkpoint_context`
12. 完成时：`upsert_project_summary` / `complete_requirement`

## 已知不足

- MCP 不能强制所有 AI 一定调用工具；它提供规则、工具和警告，但最终执行取决于宿主客户端和模型。
- 目前搜索是本地 FTS / token / LIKE 召回，稳定轻量，但不是外部 embedding 服务。
- 巨量文件拆分会自动触发“计划 + 约束 + 记录”工作流，但不是脱离模型验证的 AST 自动重构器。
- 拆分计划是低置信度启发式证据；单个目标模块仍过大时计划保持 `needs_refinement`，不会把 god file 原样搬家。
- 嵌套仓库默认沿用当前 canonical VectorMind root；需要独立记忆库时传 `project_root_mode="exact"`。
- 关键业务规则必须被写成 decision / convention / requirement scope，才能在后续会话里稳定生效。
