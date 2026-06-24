export type BuiltinConventionSpec = {
  key: string;
  content: string;
  tags?: string[];
};

const DEVELOPMENT_GUIDELINE_SCOPE =
  "开发规范范围：本约定只定义开发规范、项目记忆规范、代码组织规范与交付质量要求。";

export const BUILTIN_CONVENTIONS: BuiltinConventionSpec[] = [
  {
    key: "builtin:development_guideline_scope",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} VectorMind 的内置内容用于统一项目协作、代码组织、交付质量和长期记忆。`,
    tags: ["builtin", "development-guideline", "scope"],
  },
  {
    key: "builtin:branch_write_boundary",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 所有代码或文件改动默认在当前活跃分支中进行；禁止创建、切换或使用临时分支、临时子分支，除非用户明确要求或既有工作流已经这样安排。`,
    tags: ["builtin", "branch", "write-boundary"],
  },
  {
    key: "builtin:file_edit_serialization",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 为避免并发覆盖，同一会话内同一文件应串行编辑；多文件任务应先明确目标文件集合并按稳定顺序处理。`,
    tags: ["builtin", "editing", "serialization", "locking"],
  },
  {
    key: "builtin:plan_lite_trigger_scope",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 多步骤任务可使用轻量执行列表；只有当需求缺少会实质改变结果的关键条件、存在多个互斥且无法合理默认的方向，或继续执行可能造成明显返工/数据风险时，才进入澄清模式。目标和范围足够明确时，应直接执行。`,
    tags: ["builtin", "plan-lite", "scope", "clarification"],
  },
  {
    key: "builtin:destructive_operation_scope",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 只有真正可能导致现有源文件、配置、数据、用户内容或尚未保全改动被删除、覆盖、清空、回退、替换的动作才视为破坏性操作。不应把普通 build/rebuild、test、lint、package、生成可重复产物、读取、搜索或常规修改视为破坏性操作。`,
    tags: ["builtin", "destructive", "scope"],
  },
  {
    key: "builtin:architecture_boundary_first",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 在项目搭建、功能实现、模块扩展、重构、文件新增或修改前，应判断需求所属边界，并让目录结构、模块划分、文件归属、命名方式和依赖方向与该边界一致。常见边界包括接口层、应用层、领域层、基础设施层、共享层、配置层、脚本层和测试层。`,
    tags: ["builtin", "architecture", "boundary", "classification"],
  },
  {
    key: "builtin:architecture_single_responsibility",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 单个模块和单个文件必须保持单一主职责。不得把路由、业务规则、数据访问、状态管理、渲染、工具函数、配置装配等多类职责混写在同一文件中；若职责已经混杂，应立即拆分，不得继续把新需求堆进该文件。实现文件接近 800 行时应优先拆模块；超过 1200 行时默认禁止继续追加新功能，除非本次任务就是有计划地拆分它。`,
    tags: ["builtin", "architecture", "single-responsibility", "modularity"],
  },
  {
    key: "builtin:requirement_scope_no_extra_work",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 当前用户要求是唯一需求边界：只实现用户明确提出的行为、验收点和必要配套改动；不得自行叠加看似合理但用户未提出的新流程、新状态、新页面、新接口、新字段、新角色模型、新审核链路或新业务规则。`,
    tags: ["builtin", "requirement", "scope", "no-extra-work"],
  },
  {
    key: "builtin:completed_work_preservation",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 已完成、已验收或当前需求未要求修改的功能默认保持不变；即使代码名称、模块位置或语义看起来相关，也不得为了顺手整理、统一风格、猜测后续需求而改动。必须触碰时，只能做当前需求必需的最小适配，并在改动意图中说明原因。`,
    tags: ["builtin", "requirement", "completed-work", "preservation"],
  },
  {
    key: "builtin:no_god_file_growth",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 新增功能不得集中写进一个万能文件；路由/控制、业务规则、数据访问、状态管理、UI 渲染、工具函数和配置装配应按既有目录边界拆分。若目标文件已经很大，应优先创建同层子模块或提取服务/组件/工具，并让原文件只保留薄入口或装配代码。`,
    tags: ["builtin", "architecture", "god-file", "modularity"],
  },
  {
    key: "builtin:architecture_dependency_discipline",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 依赖方向必须稳定且可解释：接口层可依赖应用层，应用层可依赖领域层和抽象，基础设施层实现应用层或领域层定义的接口；领域层不得依赖 UI、路由、框架细节、数据库实现或临时脚本；共享层不得反向依赖具体业务模块；禁止循环依赖、跨层穿透和隐式双向耦合。`,
    tags: ["builtin", "architecture", "dependencies", "layering"],
  },
  {
    key: "builtin:frontend_output_purity_scope",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 生成、修改、重构页面、组件、模板、前端视图或其他会直接进入用户可见界面的展示代码时，页面代码、模板内容、静态数据、默认文案、注释与渲染输出中不得包含本次对话的提示词、系统指令、工具说明、思考内容、任务分解、执行计划或其他元指令回显。`,
    tags: ["builtin", "frontend", "ui", "purity", "prompt-leakage"],
  },
  {
    key: "builtin:frontend_business_code_only",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 前端最终交付应仅包含完成该业务所必需的页面/前端代码与必要配置；不得为了说明 AI 正在做什么、解释实现过程或填补未知需求，而额外加入与真实业务无关的说明文案、占位描述或演示话术。`,
    tags: ["builtin", "frontend", "ui", "business-only"],
  },
  {
    key: "builtin:git_commit_summary_required",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 用户要求执行 git 提交、创建 commit、生成提交信息或代为完成版本提交时，应在提交前或提交说明中包含本次更改的内容描述或总结，说明主要改动、影响范围以及必要的验证结果。`,
    tags: ["builtin", "git", "commit", "summary"],
  },
  {
    key: "builtin:low_overhead_execution_scope",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 编译、构建、启动、停止、运行、测试重跑、打包、发布、安装、同步产物、进程检查等以执行为主的任务，若目标路径、命令、产物位置或操作对象已经明确，应优先直接使用最少必要的 shell 或宿主工具完成，不得先机械调用大范围检索，除非检索对解除当前阻塞必不可少。`,
    tags: ["builtin", "performance", "execution", "direct-path"],
  },
  {
    key: "builtin:payload_guard_bounded_io",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 当前线程明显过重、频繁 compact、用户反馈变慢或出现上下文膨胀信号时，应优先使用有界工具与有界读取，例如 list_project_files、grep、query_codebase、read_file_lines、read_file_text；避免无边界全仓递归列表、整文件直出和长命令大段输出，除非用户明确要求原始输出。`,
    tags: ["builtin", "performance", "payload", "bounded-io"],
  },
  {
    key: "builtin:thread_handoff_trigger_scope",
    content:
      `${DEVELOPMENT_GUIDELINE_SCOPE} 线程切换建议只应基于可观察信号与后续任务重量；当前线程明显过重且后续仍需大范围分析、跨模块排查、发布核对、回归测试梳理、大改动规划或长链路续做时，可以建议切换到新线程。`,
    tags: ["builtin", "performance", "thread-handoff", "scope"],
  },
];
