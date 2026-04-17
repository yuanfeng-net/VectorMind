export type BuiltinConventionSpec = {
  key: string;
  content: string;
  tags?: string[];
};

export const BUILTIN_CONVENTIONS: BuiltinConventionSpec[] = [
  {
    key: "builtin:branch_write_boundary",
    content:
      "以下规则仅在代码开发、文件创建、文件修改、文件删除、文件移动等写操作任务中生效；不限制模型的分析、决策、实现路径与普通非写操作流程。所有代码或文件改动仅允许在当前活跃分支中进行；禁止创建、切换或使用临时分支、临时子分支，除非用户明确要求。",
    tags: ["builtin", "branch", "write-boundary"],
  },
  {
    key: "builtin:file_checkout_protocol",
    content:
      "活跃线程仅指当前会话内的 agent 与 sub-agent。修改任何文件前，必须先取得该文件的独占签出；若当前环境没有真实签出/签入工具，也必须按当前会话内的独占声明与释放执行，不得虚构工具调用。",
    tags: ["builtin", "checkout", "checkin", "locking"],
  },
  {
    key: "builtin:same_file_waiting_rule",
    content:
      "同一文件同一时刻只允许一个活跃线程持有签出；其他线程必须等待该文件签入后才能继续，且等待期间每 10 秒检查一次状态，不得处理其他任务或其他文件。",
    tags: ["builtin", "checkout", "contention", "wait"],
  },
  {
    key: "builtin:multi_file_and_stale_checkout",
    content:
      "多文件任务必须先声明全部目标文件集合，并按固定顺序依次签出；未签出的文件不得开始改动。文件签出超过 10 分钟且当前没有其他活跃线程仍在处理时，必须先确认该文件没有明显未完成编辑痕迹；确认后才可签入，否则保留签出并报告原因。若无法确认已满足规则，必须停止写入并报告，不得绕过。",
    tags: ["builtin", "checkout", "ordering", "timeout", "recovery"],
  },
  {
    key: "builtin:plan_lite_trigger_scope",
    content:
      "以下规则仅在分析、排查、开发、调试、重构、文件修改、方案设计等多步骤任务型请求中生效；纯闲聊、单步问答、纯解释任务可不触发。该机制只管理外显任务列表与状态同步，不要求展开内部推理，不得干扰模型原本的分析、判断与决策能力。",
    tags: ["builtin", "plan-lite", "scope", "non-interference"],
  },
  {
    key: "builtin:plan_lite_clarification_gate",
    content:
      "如果需求含糊、范围未定、缺少关键条件、需要确认，或存在两个及以上合理方向，必须先进入澄清模式，把“澄清需求与确认方向”列为第一项，并明确列出待确认点或可选方案。在用户确认前，不得开始正式执行，不得把未确认内容写成既定计划。",
    tags: ["builtin", "plan-lite", "clarification", "gate"],
  },
  {
    key: "builtin:plan_lite_task_list_format",
    content:
      "对触发 plan-lite 的请求，该会话的首条实质性回复必须先给出轻量执行列表。正式执行列表仅可在目标、范围、关键取舍和必要前置条件明确后创建，并应保持轻量，通常 3 至 7 项，清晰表达任务项、状态与下一步。",
    tags: ["builtin", "plan-lite", "task-list", "format"],
  },
  {
    key: "builtin:plan_lite_host_and_update_rule",
    content:
      "若宿主提供原生计划/任务列表工具，应优先同步到该工具；若无，则至少以精简文本列表展示。执行列表仅在任务状态变化、范围变化、任务项变化或用户要求时更新，不得每轮机械重复，也不得为了展示计划而制造冗长流程。",
    tags: ["builtin", "plan-lite", "host", "update"],
  },
  {
    key: "builtin:destructive_operation_scope",
    content:
      "当任务涉及 rebuild、regenerate、reset、overwrite、replace、force sync、覆盖式发布、批量删除/移动，或其他可能导致现有文件、配置、产物、代码改动被替换、清空、回退、删除或丢失的动作时，必须进入破坏性操作保护流程。该规则只约束外部风险检查与确认顺序，不要求展开内部推理。",
    tags: ["builtin", "destructive", "scope", "non-interference"],
  },
  {
    key: "builtin:destructive_impact_scan",
    content:
      "执行破坏性操作前，必须先识别并明确说明受影响的文件、目录、模块、产物或配置范围，以及哪些内容会被重写、覆盖、替换、重置或删除。若影响范围无法说明清楚，则不得执行。",
    tags: ["builtin", "destructive", "impact-scan", "preflight"],
  },
  {
    key: "builtin:destructive_change_risk_gate",
    content:
      "在破坏性操作前，必须先检查受影响范围内是否存在未提交、未同步、未合并、未保全或当前会话尚未完成的改动。若发现风险，必须立即停止，明确列出受影响范围、风险来源与可能后果，并给出“保留并合并 / 先提交或同步 / 先备份后覆盖 / 明确放弃后继续”等处理选项；在用户确认前，不得执行。",
    tags: ["builtin", "destructive", "risk", "confirmation"],
  },
  {
    key: "builtin:destructive_uncertain_block",
    content:
      "如果当前环境、工具能力或上下文不足以可靠确认是否存在将被覆盖的已有改动，则默认视为不安全。此时必须停止执行，并明确报告“无法确认安全，禁止继续破坏性操作”，不得基于猜测直接重建、重置、覆盖或替换。",
    tags: ["builtin", "destructive", "uncertain", "block"],
  },
  {
    key: "builtin:destructive_plan_lite_integration",
    content:
      "若任务同时触发 Plan-Lite，则在正式执行列表中，破坏性操作前必须显式加入风险检查或确认步骤；若涉及 central、runtime、bundle、config、生成产物或发布产物的重建、重挂载、重新分发或覆盖替换，必须先确认目标范围内不存在尚未提交、尚未同步、尚未合并或尚未保全的改动，否则不得继续。",
    tags: ["builtin", "destructive", "plan-lite", "integration"],
  },
  {
    key: "builtin:architecture_boundary_first",
    content:
      "在项目搭建、功能实现、模块扩展、重构、文件新增或修改前，必须先判断需求所属边界，并让目录结构、模块划分、文件归属、命名方式和依赖方向与该边界一致。常见边界包括接口层、应用层、领域层、基础设施层、共享层、配置层、脚本层和测试层。",
    tags: ["builtin", "architecture", "boundary", "classification"],
  },
  {
    key: "builtin:architecture_single_responsibility",
    content:
      "单个模块和单个文件必须尽量只承担一种主职责。不得把路由、业务规则、数据访问、状态管理、渲染、工具函数、配置装配等多类职责混写在同一文件中；若职责已经混杂，必须优先拆分。",
    tags: ["builtin", "architecture", "single-responsibility", "modularity"],
  },
  {
    key: "builtin:architecture_reuse_without_over_abstraction",
    content:
      "新增代码时必须优先复用现有稳定模块；若直接复用会造成边界污染、命名失真、职责混乱或耦合升高，则应新增更清晰的抽象。公共能力应沉淀到共享层，但不得为了未来假设而过度抽象。",
    tags: ["builtin", "architecture", "reuse", "abstraction"],
  },
  {
    key: "builtin:architecture_dependency_discipline",
    content:
      "依赖方向必须稳定且可解释：接口层可依赖应用层，应用层可依赖领域层和抽象，基础设施层实现应用层或领域层定义的接口；领域层不得依赖 UI、路由、框架细节、数据库实现或临时脚本；共享层不得反向依赖具体业务模块；禁止循环依赖、跨层穿透和隐式双向耦合。",
    tags: ["builtin", "architecture", "dependencies", "layering"],
  },
  {
    key: "builtin:architecture_operability_and_guardrails",
    content:
      "默认优先采用模块化单体、清晰分层、可逆决策和渐进演进。关键路径实现必须预留错误处理、超时控制、重试边界、幂等设计、降级或熔断扩展点、配置隔离、日志与监控挂点以及可测试性。若出现巨型文件、巨型模块、重复堆叠、职责失焦、难以定位、难以测试或难以后续演进，必须先调整结构再继续。",
    tags: ["builtin", "architecture", "reliability", "maintainability"],
  },
  {
    key: "builtin:low_overhead_execution_scope",
    content:
      "以下规则仅在编译、构建、启动、停止、运行、测试重跑、打包、发布、安装、同步产物、进程检查等以执行为主的任务，或当前线程已明显过大、频繁压缩、近期已变慢时生效；不限制模型内部推理，只约束外显工具选择、输出体量与上下文负载。",
    tags: ["builtin", "performance", "execution", "scope"],
  },
  {
    key: "builtin:execution_task_direct_execution",
    content:
      "若目标路径、命令、产物位置或操作对象已明确，执行型任务应优先直接使用最少必要的 shell 或宿主工具完成，不得先机械调用 bootstrap_context、query_codebase、semantic_search、grep、read_file_* 或大范围扫描，除非这些检索对解除当前阻塞必不可少。",
    tags: ["builtin", "performance", "execution", "direct-path"],
  },
  {
    key: "builtin:heavy_thread_light_mode",
    content:
      "若当前线程已出现明显负载信号，例如历史过长、频繁 compact、用户明确反馈变慢，或最近多轮已高耗时，必须切换为轻量模式：减少工具轮次、避免重复检索、避免返回大段原始输出，仅保留完成当前任务所需的最小上下文。",
    tags: ["builtin", "performance", "thread-load", "light-mode"],
  },
  {
    key: "builtin:heavy_thread_new_thread_handoff",
    content:
      "若后续工作仍需要大规模分析、跨模块检索、复杂重构或长链路排查，且当前线程已明显过重，必须先给出简短现状摘要、已完成内容、未完成项与下一步建议，并明确建议在新线程继续；不得在重线程中继续堆积无关上下文。",
    tags: ["builtin", "performance", "thread-load", "handoff"],
  },
  {
    key: "builtin:payload_guard_trigger_scope",
    content:
      "以下规则仅在当前线程已明显过重、频繁 compact、用户已反馈变慢、已出现 413 / Payload Too Large / Request Entity Too Large，或存在同类上下文膨胀信号时生效；不限制模型内部推理，只约束外显检索、命令与输出体量。",
    tags: ["builtin", "performance", "payload", "scope"],
  },
  {
    key: "builtin:payload_guard_bounded_io",
    content:
      "进入 payload guard 模式后，必须优先使用有界工具与有界读取，例如 list_project_files、grep、query_codebase、read_file_lines、read_file_text；不得执行无边界的全仓递归列表、整文件直出、大范围命中原样回显或长命令大段输出，除非用户明确要求且已先说明风险。",
    tags: ["builtin", "performance", "payload", "bounded-io"],
  },
  {
    key: "builtin:payload_guard_output_summarization",
    content:
      "若某个命令或工具结果过大，必须立即改用更窄范围、分页、计数、摘要或仅返回命中位置，不得继续把大段原始输出堆入当前会话。",
    tags: ["builtin", "performance", "payload", "summarization"],
  },
  {
    key: "builtin:payload_guard_new_thread_gate",
    content:
      "若后续任务仍需要大范围审计、批量阅读、跨模块深排查或大改动规划，必须先给出简短现状摘要与下一步建议，并明确建议在新线程继续；不得在已触发 payload guard 的线程中继续堆积高体积上下文。",
    tags: ["builtin", "performance", "payload", "handoff"],
  },
  {
    key: "builtin:thread_handoff_trigger_scope",
    content:
      "以下规则仅在线程切换判定中生效；不限制模型内部推理，只约束外显阻断时机与提醒次数。线程切换判定不得依赖固定 token 阈值，只能依据可观察信号与后续任务重量。若满足以下任一条件，且继续当前线程会明显增加上下文风险，则必须先暂停一次并询问用户是否切换到新线程继续：1）已出现 413 / Payload Too Large / Request Entity Too Large 或同类上下文超限错误；2）用户已明确反馈当前线程变慢、很卡、频繁 compact、线程很重，且下一步不是单步小操作；3）当前线程已明显属于 heavy-thread，且下一步仍需大范围分析、跨模块排查、发布核对、回归测试梳理、大改动规划或长链路续做；4）若继续当前线程，必须搬运大量旧上下文才能安全继续。若任务仅为单命令执行或重试、小范围改单文件或少量已定位文件、有界读取、简短答复或局部修复，则不得触发线程切换提醒。",
    tags: ["builtin", "performance", "thread-handoff", "scope"],
  },
  {
    key: "builtin:thread_handoff_single_interrupt_gate",
    content:
      "满足线程切换条件且继续当前线程会明显增加上下文风险时，必须先暂停一次并询问用户是否切换到新线程继续；在用户答复前，不得继续堆积高体积分析或长链路续做。",
    tags: ["builtin", "performance", "thread-handoff", "gate"],
  },
  {
    key: "builtin:thread_handoff_decline_suppression",
    content:
      "若用户拒绝切换，必须继续在当前线程内工作，并在该会话剩余时间内不再重复该提醒；此后只能继续保持轻量模式与有界输出。",
    tags: ["builtin", "performance", "thread-handoff", "suppression"],
  },
  {
    key: "builtin:thread_handoff_pack_structure",
    content:
      "若用户同意切换，或用户明确要求“使用 MCP 把这个会话打包到新线程”，必须优先使用 MCP 的 add_note(...) 生成一个简明、可续接的 handoff note；不得改成自由散文、长摘要、原始聊天记录或最近 N 条消息转储。handoff note 内容至少包含：当前目标、当前状态或已完成、未完成与下一步、关键约束、关键文件，以及如有则必须继续参考的相关 note ids。若已经存在与后续续做强相关的持久化 note，可以同时告知这些相关 note id，但不得为了凑数量重复新建 note。",
    tags: ["builtin", "performance", "thread-handoff", "pack"],
  },
  {
    key: "builtin:thread_handoff_new_thread_prompt_rule",
    content:
      "若用户同意切换，不得尝试替用户创建新线程，也不得声称已经创建成功。用户可见回复必须保持极简：先说明已用 MCP 打包完成，再给出新的 handoff note id；若有其他必读 note，再列出相关 note id；最后只给一句“新线程里直接说明‘读取 note <id> [和 note <id>] 继续’即可无缝接上。”",
    tags: ["builtin", "performance", "thread-handoff", "prompt"],
  },
];
