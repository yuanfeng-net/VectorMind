# VectorMind 能力矩阵

VectorMind 的目标不是替代 AI，也不是接管客户端权限，而是让 AI 在长期开发里更少丢上下文、更少乱改、更少把旧需求改回来。它提供上下文证据和质量信号；普通信号是 advisory，巨量文件治理是明确且有限的 workflow gate，但仍不控制宿主运行或替代模型推理。

运行时基线为 Node.js `20.19.0+`。发布验证通过 `npm run verify` 同时覆盖核心构建、管理面板和 MCP smoke；管理面板以预构建客户端随主包发布，并在非回环监听时要求显式令牌。`sync_change_intent` 对 pending 采用有界分批消费；只有调用方显式复用同一个 `idempotency_key` 时才把请求视为重试。

| 能力 | 解决的问题 | 主要工具 | 当前限制 |
| --- | --- | --- | --- |
| 上下文恢复 | 新会话不知道项目现状、最近做过什么 | `bootstrap_context`, `get_brain_dump` | focused 只锚定 active requirement；已完成历史需显式展开 |
| 需求明确性引导 | AI 在没有明确当前要求时自行理解并工作 | 默认 MCP server instructions、内置 convention | advisory guidance：仅完整授权才可行动；授权来自当前消息明确提出工作，或明确指向唯一未完成的用户请求，且选定请求须明确相关目标、对象、范围和动作；已完成请求不得授权新动作；无完整授权时先询问 |
| 需求边界 | 新需求顺手改到无关模块或并发任务串线 | `start_requirement`, `get_requirement_status`, `resume_requirement`, `preflight_change_scope`, `complete_requirement` | 默认串行；并行时传 `close_previous=false`，并始终保留 `req_id` 或 `goal_key` |
| 改动意图 | 文件变了但不知道为什么，或完成后出现更强验证证据 | `sync_change_intent`, `update_requirement_verification`, `get_pending_changes` | 需要改完后同步；已完成需求可补写验证但不可改写文件意图 |
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
| 提示注入/凭据外传 | 仓库、Issue 或文档内容诱导 AI 执行命令、读取凭据并发送到外部 | 文件读取、内存读取、`grep`、符号查询返回带覆盖范围的 `security_scan`；`preflight_operation_scope` 返回 `security_risk_detected` | 文档与模型写入的记忆始终 advisory，不能覆盖当前用户请求；高置信度敏感数据外传默认 blocker，且模型参数不能授权绕过。可信部署绑定宿主 `VECTORMIND_DEPLOYMENT_HOST` 登记的规范 IP，或严格绑定已登记且哈希校验通过的 `prepare_secure_ssh -F` 配置；`server.txt` 仅作为 SSH 准备候选。`.env` 可沿变量化 copy/move、软硬链接、编码、tar/zip/7z、`dd`、环境变量落盘、脚本/PowerShell 写入与重定向传播到 SSH、SFTP inline `put`、stdin、管道、curl/wget、`nc`、`openssl s_client` 和 PowerShell HTTP sink；常见用户级凭据文件始终按主机凭据处理。软硬链接派生物永不获得可信例外；独立凭据读取或其他外传也不能被可信部署掩盖。只有受限 OpenSSH/SSH-style rsync 命令形式可获得例外；控制套接字、Agent/stdio/端口转发、跨命令执行环境、alias/function、变量化危险选项、解释器或命令替换配置篡改、不同或混合目标均阻断。默认 `ssh -G` 绑定实际用户、端口和安全选项；普通 build/test/git 不执行该子进程。HTTP(S)、主机私钥、云凭据、`server.txt` 和环境变量永不获得部署例外；裸命令名依赖宿主 PATH，不宣称文件哈希身份验证；MCP 不接管宿主 OS 命令权限 |
| 安全 SSH 部署准备 | 部署配置中混入密码，或没有 key 时错误回退密码认证 | `prepare_secure_ssh` | 宿主侧读取并解析配置，只返回目标元数据、宿主绝对路径和必要时的公钥；私钥/密码内容不进入工具输出；强制 `BatchMode`、publickey、host-key 检查并禁用密码认证。MCP 自建配置和生成密钥默认 24 小时 TTL，淘汰/退出时清理；复用的用户身份文件不会删除。生成公钥须安装后才能部署；MCP 不尝试密码登录 |

## 推荐调用链路

开发任务建议遵循：

1. `bootstrap_context({ project_root, query, context_mode: "focused" })`
2. `start_requirement(...)`，保存返回的 `requirement.id` 或 `goal_key`
3. `preflight_change_scope({ project_root, req_id?, goal_key?, intent, files })`
4. 若出现 `huge_file_modularization_required`，调用 `plan_large_file_split` 保存 `plan_id`，携带该计划重新 preflight，执行机械拆分并用 `record_large_file_split` 更新同一计划
5. 修改文件
6. 仅在文件列表未知或诊断范围漂移时调用 `get_pending_changes`
7. `sync_change_intent({ project_root, req_id?, goal_key?, intent, files })`
8. 后续验证结果变化时调用 `update_requirement_verification({ project_root, req_id?, goal_key?, verification?, verification_gaps? })`
9. 需要时：`upsert_decision` / `supersede_memory`
10. 需要追溯时：`memory_timeline`
11. 长会话/交接时：`create_checkpoint` / `restore_checkpoint_context`
11. 怀疑记忆异常时：`analyze_memory_conflicts` / `memory_quality_report` / `compare_checkpoint_context`
12. 完成时：`upsert_project_summary` / `complete_requirement`

## 已知不足

- MCP 不能强制所有 AI 一定调用工具；它提供规则、工具和警告，但最终执行取决于宿主客户端和模型。
- 目前搜索是本地 FTS / token / LIKE 召回，稳定轻量，但不是外部 embedding 服务。
- 巨量文件拆分会自动触发“计划 + 约束 + 记录”工作流，但不是脱离模型验证的 AST 自动重构器。
- 拆分计划是低置信度启发式证据；单个目标模块仍过大时计划保持 `needs_refinement`，不会把 god file 原样搬家。
- 嵌套仓库默认沿用当前 canonical VectorMind root；需要独立记忆库时传 `project_root_mode="exact"`。
- 关键业务规则必须被写成 decision / convention / requirement scope，才能在后续会话里稳定生效。
