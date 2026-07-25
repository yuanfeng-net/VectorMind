# VectorMind MCP

VectorMind 是面向 AI 编程助手的本地项目记忆 MCP。它把需求、决策、改动原因、项目约定和文件状态保存在项目目录内，帮助长周期开发减少上下文丢失、跨项目串线和旧逻辑回退。

当前版本：`1.1.0`

## 核心能力

- **恢复项目上下文**：按当前目标找回项目摘要、需求、决策、约定和相关记忆。
- **引导需求明确性**：通过 MCP server instructions 提醒 AI 只在获得完整授权后行动，无完整授权时先询问用户。
- **约束改动范围**：编辑前核对需求条目、计划文件和巨量文件治理要求。
- **记录改动意图**：把变更文件、实现原因、验证结果和遗留缺口归档到对应需求。
- **管理需求生命周期**：支持串行任务、显式并行任务、恢复已完成任务和更新验证结果。
- **更新权威决策**：新决策可以 supersede 旧需求或旧记忆，避免后续会话按过时规则实现。
- **隔离多个项目**：记忆、pending buffer、索引和数据库都按 `project_root` 隔离。
- **安全读取项目文件**：使用 canonical realpath 校验，拒绝通过符号链接或 junction 越过项目边界。
- **保存长期会话检查点**：创建有界、版本化 checkpoint，并只读恢复或比较上下文。
- **诊断记忆质量**：检查冲突、重复、过大 checkpoint、陈旧索引和孤立记忆。
- **控制上下文体积**：默认使用精简工具集和紧凑输出，大结果会保留关键 ID 与完成状态。

完整能力表见 [docs/capability-matrix.md](docs/capability-matrix.md)。

## 快速安装

推荐直接把项目地址发给你的 AI 编程助手，让它自动完成安装和配置：

```text
请安装并配置 VectorMind MCP：
https://github.com/yuanfeng-net/VectorMind

请自动识别我当前使用的 AI 编程客户端，完成安装、MCP 配置和可用性验证。
除非缺少必要权限，否则不需要让我手动执行命令。
```

通常只需要发送 GitHub 地址并说明“帮我安装”即可。AI 会根据仓库说明识别当前客户端、更新对应的 MCP 配置并验证是否可用，用户不需要记安装命令或手动编辑配置文件。

## 手动安装与配置（可选）

需要自己配置时，运行环境要求 Node.js `20.19.0` 或更高版本。

直接运行 MCP：

```bash
npx -y @coreyuan/vector-mind
```

或全局安装：

```bash
npm install -g @coreyuan/vector-mind
```

全局安装后提供三个命令：

```text
vector-mind        # MCP stdio 服务
vector-mind-admin  # 生产模式管理面板
rtk                # RTK 兼容入口
```

### 手动配置 Codex

在 `~/.codex/config.toml` 添加：

```toml
[mcp_servers.vector-mind]
type = "stdio"
command = "npx"
args = ["-y", "@coreyuan/vector-mind"]
```

配置后重启 Codex，并在新任务中使用。

### 手动配置 Claude Desktop

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

## 管理面板

全局安装后直接启动：

```bash
vector-mind-admin
```

默认地址为 [http://127.0.0.1:16860](http://127.0.0.1:16860)。默认只监听回环地址，并为回环请求建立当前页面会话，不需要手动输入令牌。

从源码运行：

```bash
npm ci
npm run build
npm run admin:start
```

开发模式使用 Vite 中间件和 HMR：

```bash
npm run admin:dev
```

可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VECTORMIND_ADMIN_HOST` | `127.0.0.1` | 管理服务监听地址 |
| `VECTORMIND_ADMIN_PORT` | `16860` | 管理服务端口 |
| `VECTORMIND_ADMIN_TOKEN` | 无 | 非回环监听时必须显式设置 |

监听非回环地址时，服务会在启动阶段强制检查 `VECTORMIND_ADMIN_TOKEN`。令牌不会通过 `/api/config` 返回；浏览器输入的令牌只保存在当前标签页的 `sessionStorage`。受保护接口同时校验令牌和同源 `Origin`，缺失 `Origin` 不会绕过令牌验证。

管理面板的完整说明见 [admin-panel/README.md](admin-panel/README.md)。

## 使用方式

用户不需要记忆或手动输入任何 VectorMind 工具命令。像平常一样用自然语言说明任务目标、约束和期望结果即可，AI 客户端会在需要时自动恢复相关上下文、检查改动范围并记录变更原因。

如果同一会话需要同时处理多个互不相关的任务，只需向 AI 明确说明哪些任务需要并行保留，以及各自对应的项目和目标；内部需求标识和工具调用由客户端管理。

VectorMind 的质量信号只是上下文证据，不替模型或用户做决定。

## 需求明确性软引导

VectorMind 会在 MCP 握手中向 AI 提供需求明确性规则。AI 只有在获得完整授权后才应行动：当前消息明确提出工作，或当前消息明确指向唯一未完成的用户请求；无论采用哪条路径，选定请求都必须明确相关目标、对象、范围和动作。已完成请求不能授权新动作，无完整授权时，AI 应在调用工具或采取行动前先向用户询问。

这项能力属于 advisory guidance。VectorMind 提供判断边界，由 AI 结合当前消息和用户请求自行判断，不接管模型推理或宿主运行时。需求已经明确时，AI 可以继续采用合理的实现默认，不需要重复确认。

## 巨量文件规则

当实现文件达到巨量阈值时，VectorMind 会要求先做机械搬迁式模块化拆分，再继续增加职责：

- 使用真实模块名和清晰目录。
- 保持对外行为不变，并验证拆分后的模块边界。
- 禁止 `*.generated.*`、`.parts`、`*.rs.parts`、`part1/part2`、`1_xxx/2_xxx` 等假拆分或排序式命名。
- 拆分计划和实际结果会持久化，后续会话可以继续同一计划。

## 它不做什么

VectorMind 只提供本地项目记忆、开发规范和质量证据。它不会：

- 接管 Codex、Claude 或其他客户端的运行控制。
- 替模型完成推理、设计和实现决策。
- 修改客户端权限、确认弹窗或执行策略。
- 对模糊需求或客户端工具实施运行时硬拦截；需求明确性规则属于软引导。
- 把 checkpoint 当作文件、数据库或模型状态回滚。

当前用户指令和直接观察到的仓库事实始终高于历史记忆。

## 开发与发布

```bash
npm ci
npm run build
npm run smoke
npm run verify
```

- `npm run smoke` 会先重建核心产物，再运行 security、checkpoint、operation 和完整 MCP smoke。
- `npm run verify` 会运行核心构建、管理面板测试与生产构建，以及全部 smoke。
- `prepublishOnly` 强制执行完整 `verify`。
- 发布前可用 `npm pack --dry-run --ignore-scripts --json` 检查核心产物、管理服务和预构建客户端是否进入包。

发布：

```bash
npm publish --access public
```

## 一句话

VectorMind 让 AI 记住需求、决策、改动原因和项目边界，在长期开发中少丢上下文、少乱改、少回退到旧逻辑。
