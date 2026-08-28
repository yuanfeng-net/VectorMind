**简体中文** | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [繁體中文](README.zh-TW.md)

# VectorMind MCP

VectorMind 是面向 AI 编程助手的本地项目记忆 MCP。它把需求、决策、改动原因、项目约定和文件状态保存在项目目录内，帮助长周期开发减少上下文丢失、跨项目串线和旧逻辑回退。

当前版本：`1.1.6`

## 核心能力

- **恢复项目上下文**：按当前目标找回项目摘要、需求、决策、约定和相关记忆。
- **引导需求明确性**：通过 MCP server instructions 提醒 AI 只在获得完整授权后行动，无完整授权时先询问用户。
- **约束改动范围**：编辑前核对需求条目、计划文件和巨量文件治理要求。
- **记录改动意图**：把变更文件、实现原因、验证结果和遗留缺口归档到对应需求。
- **管理需求生命周期**：支持串行任务、显式并行任务、恢复已完成任务和更新验证结果。
- **更新权威决策**：新决策可以 supersede 旧需求或旧记忆，避免后续会话按过时规则实现。
- **隔离多个项目**：记忆、pending buffer、索引和数据库都按 `project_root` 隔离。
- **安全读取项目文件**：使用 canonical realpath 校验，拒绝通过符号链接或 junction 越过项目边界。
- **安全扫描不可信内容与操作**：文件、内存、`grep` 和符号查询结果附带 `security_scan`；高置信度敏感数据外传只在具体操作预检中阻断，普通文档、文章、测试样例和明确的普通上传保持 advisory，不改变正常分析流程。
- **安全 SSH 部署准备**：`prepare_secure_ssh` 在宿主机内部读取服务器配置，只返回目标元数据和 SSH 配置路径，不回显密码或私钥；优先复用宿主 SSH key，没有可用 key 时生成临时 Ed25519 key，强制禁用密码认证，并要求先安装公钥。
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

安装并配置 MCP 后，管理面板会随 `vector-mind` MCP 进程自动在后台启动；不需要再单独运行服务。直接打开：

```text
http://127.0.0.1:16860
```

也可以手动启动或用于故障排查：

```bash
vector-mind-admin
```

默认地址为 [http://127.0.0.1:16860](http://127.0.0.1:16860)。默认只监听回环地址，并为回环请求建立当前页面会话，不需要手动输入令牌。

项目索引会在页面加载和刷新时只读同步 Codex 桌面端 `$CODEX_HOME/.codex-global-state.json` 中的本地项目列表，并按 Codex 的项目顺序展示。不存在的目录会跳过；手动添加和目录扫描得到的项目不会被 Codex 同步删除。

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
| `VECTORMIND_ADMIN_AUTO_START` | `true` | 设为 `false`、`0`、`no`、`off` 或 `disabled` 时关闭随 MCP 自动启动 |

监听非回环地址时，服务会在启动阶段强制检查 `VECTORMIND_ADMIN_TOKEN`。令牌不会通过 `/api/config` 返回；浏览器输入的令牌只保存在当前标签页的 `sessionStorage`。受保护接口同时校验令牌和同源 `Origin`，缺失 `Origin` 不会绕过令牌验证。

管理面板的完整说明见 [admin-panel/README.md](admin-panel/README.md)。

## 使用方式

用户不需要记忆或手动输入任何 VectorMind 工具命令。像平常一样用自然语言说明任务目标、约束和期望结果即可，AI 客户端会在需要时自动恢复相关上下文、检查改动范围并记录变更原因。

如果同一会话需要同时处理多个互不相关的任务，只需向 AI 明确说明哪些任务需要并行保留，以及各自对应的项目和目标；内部需求标识和工具调用由客户端管理。

VectorMind 的质量信号只是上下文证据，不替模型或用户做决定。

### 安全扫描边界与开销

安全扫描用于识别提示注入、凭据访问、主机探测和本地敏感数据外传。它不会接管 MCP 其他工具，也不会主导 AI 的推理、设计或实现方向：

- 文件、内存、`grep`、语义搜索和符号查询返回的扫描结果属于 advisory 信号，明确标记 `advisory_only`、`coverage` 和 `complete`。
- 只有 `preflight_operation_scope` 发现高置信度敏感凭据外传时，才会对该具体操作返回 blocker；模型通过 MCP 写入的 decision、requirement、note 和 convention 没有宿主认证的用户来源，只能产生 warning，不能覆盖当前用户要求或令 `safe_to_proceed` 变为 false。普通读取、查询、代码生成和其他 MCP 功能不受影响。
- 部署说明、文件清单、`--exclude` 项、远端目标路径及 `ssh/scp -i` 身份文件不会被当作上传内容；本地 `.env` 成为部署源时默认阻断。可信目标接受宿主启动环境变量 `VECTORMIND_DEPLOYMENT_HOST` 权威登记的规范化 IPv4/IPv6 字面地址，或仅对明确使用 `prepare_secure_ssh` 生成、登记并通过哈希校验的 `-F` 配置建立受限信任；仓库内 `server.txt` 只是该工具的本地候选配置，不能单独建立信任。显式但非法的环境值会 fail closed。只有 `.env` 或由它复制、改名、编码、归档得到且全程可追踪的发布产物，通过可信系统 OpenSSH/SSH-style rsync 全部发往该 IP 时才获得例外；链接派生物即使可追踪也不会获得例外。SSH 私钥、云凭据、`server.txt` 和宿主环境变量永不获得部署例外。
- 只有敏感 SSH 上传且没有登记 `-F` 配置时才执行 `ssh -G`。校验会携带实际命令中的远端用户、端口和安全 `-o` 选项，使 `Match user` 等条件与真实部署一致。默认配置必须保持最终 `hostname` 等于目标 IP、纯公钥和 `BatchMode`，启用主机密钥校验，并禁用密码、keyboard-interactive、控制套接字复用、Agent/stdio/端口转发、跳板代理、`ProxyCommand`、`LocalCommand`、`KnownHostsCommand` 和空 known-host 文件。普通 build/test/git 和使用登记配置的部署不启动该子进程。
- 接受未被当前操作修改执行查找环境时 PATH 中的标准命令名，以及 `/usr/bin`、`/bin` 或 Windows System32 OpenSSH 的显式路径；裸命令名不宣称做文件哈希身份验证。`./scp`、`/tmp/ssh`、脚本伪装、SSH/SCP/SFTP 的自定义程序或控制套接字、转发选项、危险 `-o` 以及自定义 rsync transport 不获得例外。标准 `rsync -e ssh`、`/usr/bin/ssh` 和安全 `RSYNC_RSH=ssh` 保持兼容。
- 数据流按命令顺序传播到变量化 copy/move、软硬链接、base64、tar/zip/7z、`dd`、敏感环境变量落盘、常见脚本/PowerShell 文件写入和重定向等派生产物，并识别 `curl`、`wget`、PowerShell HTTP、SSH-family、SFTP inline `put`、`nc`、`openssl s_client`、管道和 stdin 上传 sink；无法解析输出的敏感处理会保守污染后续上传。覆盖、同路径重新打包、未知脚本触碰或 hash 重定向覆盖会使可信状态失效。软链接、硬链接、`mklink` 和 PowerShell 链接派生物会被追踪但永不获得可信部署例外，以避免预检与执行之间的 TOCTOU 风险。同一计划中的独立凭据读取或非可信网络外传会撤销整个可信例外，不能被另一条正确 IP 的部署掩盖。跨命令 PATH/动态加载器、alias/function、变量化 SSH 选项，以及 shell/PowerShell/cmd 间接调用或命令替换修改 SSH 配置都会撤销可信例外；只读 SSH 配置与备份操作不受影响。
- `prepare_secure_ssh` 的配置与自动生成密钥默认 24 小时过期，可用 `VECTORMIND_PREPARED_SSH_TTL_SECONDS` 调整；容量淘汰和进程退出会清理 MCP 自建临时目录，复用的用户私钥永不删除。配置路径通过 realpath containment；宿主绝对路径可返回，私钥内容不会返回模型。
- `preflight_operation_scope` 直接返回 `safe_to_proceed` 和 blocker，不要求额外密钥，也不增加签名 token。MCP 不接管 Codex 或其他客户端的终端权限；客户端应遵守 blocker，真正的 OS 级命令权限仍由宿主自身负责。
- 安全 blocker 没有模型参数内的授权绕过：标准 MCP 工具参数无法证明当前用户来源，因此不接收模型可见 token 或“用户已确认”文字作为可信授权。
- 扫描只产生有界的本地 CPU、文件读取和少量输出 token 开销，不增加 AI 推理轮次。无 finding 时 compact 输出不会展开安全详情；完整字段可通过 `format=json` 查看。

完整能力和边界见 [docs/capability-matrix.md](docs/capability-matrix.md)。

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
- `security-regression-cases.mjs` 覆盖提示注入、凭据路径、普通上传、敏感外传，以及 DNS/SSH/SCP/SFTP、PowerShell、Node/Python、base64、tar/zip/7z、`dd`、派生文件 stdin 和环境变量通道。
- 安全回归还验证宿主授权令牌、错误令牌旁路、目标主机 allowlist、文件 advisory 语义、grep 多文件覆盖和符号链接越界保护。
- `npm run verify` 已包含上述安全回归、checkpoint/operation 回归、管理面板测试和生产构建。
- `prepublishOnly` 强制执行完整 `verify`。
- 发布前可用 `npm pack --dry-run --ignore-scripts --json` 检查核心产物、管理服务和预构建客户端是否进入包。

发布：

```bash
npm publish --access public
```

## 许可证与权属

Copyright (c) 2025-2026 the VectorMind Licensor, publishing as yuanfeng-net. All rights reserved.

VectorMind 采用 [VectorMind Source-Available License 1.0](LICENSE)，属于源码可见软件，不是 OSI 定义的开源软件：

- 允许个人和企业安装、运行、内部使用、私下修改和制作必要备份；内部员工、关联公司、受约束的承包商以及代表用户运行的云端 CI/CD 和基础设施均可使用。
- 用户通过 VectorMind 创建或处理的代码、文档、记忆、报告和其他独立产物归用户所有，不因使用 VectorMind 而受到本许可证约束。
- 未经版权所有者书面许可，禁止公开镜像、转载、重新打包、改名发布或分发修改版。
- 禁止删除版权、许可证、作者归属、官方项目地址或 npm 来源信息。
- 禁止将 VectorMind 或其主要功能包装成对外提供的产品或服务，也不得冒充原创或官方版本。

官方仓库仅为 <https://github.com/yuanfeng-net/VectorMind>，官方 npm 包仅为
[`@coreyuan/vector-mind`](https://www.npmjs.com/package/@coreyuan/vector-mind)。完整授权边界以 [LICENSE](LICENSE) 英文正文为准；再分发、OEM、托管服务或其他商业授权按 [LICENSING.md](LICENSING.md) 申请。为保持维权所需的权属链清晰，外部代码贡献遵循 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 一句话

VectorMind 让 AI 记住需求、决策、改动原因和项目边界，在长期开发中少丢上下文、少乱改、少回退到旧逻辑。

聚焦上下文恢复会明确按相关性过滤，完整恢复也始终受输出上限约束；两种模式都不声称覆盖整个仓库或实时运行状态。因此，没有匹配结果不代表某项事实从未存在。域名、源主机、端口、部署目录和凭据文件引用等持久运行事实可以被恢复，而秘密值会在写入长期记忆、提取符号和建立文档索引之前递归脱敏。创建需求时还会报告或拒绝高置信度重叠，避免把尚未结束的事件静默拆分成新的生命周期。
