# VectorMind 管理面板

本目录是 Node.js + React 管理后台，默认端口 `16860`。界面可独立启动，但数据库修复功能会加载主项目构建出的核心运行时。

要求 Node.js `^20.19.0` 或 `>=22.12.0`。

## 启动

```bash
cd ..
npm install
npm run build
cd admin-panel
npm install
npm run dev
```

根目录的 `npm run build` 是数据库修复功能的前置步骤；缺少 `dist/database-runtime.js` 时，面板仍可查看数据，但不能执行修复。

打开：

```text
http://localhost:16860
```

生产模式：

```bash
npm run build
npm start
```

## 本机访问边界

管理面板默认只监听 `127.0.0.1`。回环模式会为回环连接自动建立当前页面会话，不需要手动输入令牌。

监听任何非回环地址时必须显式设置 `VECTORMIND_ADMIN_TOKEN`。服务端不会通过 `/api/config` 返回该令牌；在页面顶部输入后，令牌只保存在当前标签页的 `sessionStorage` 中。缺失 `Origin` 不会跳过令牌校验，带 `Origin` 的请求还必须与当前请求同源。

不要把管理面板直接暴露到公网。确需在受信任局域网访问时，使用高强度随机令牌并配合主机防火墙限制来源。

可选环境变量：

```text
VECTORMIND_ADMIN_HOST=127.0.0.1
VECTORMIND_ADMIN_PORT=16860
VECTORMIND_ADMIN_TOKEN=<固定的高强度随机令牌>
```

例如监听局域网地址：

```powershell
$env:VECTORMIND_ADMIN_HOST = "0.0.0.0"
$env:VECTORMIND_ADMIN_TOKEN = (New-Guid).Guid + (New-Guid).Guid
npm start
```

## 本地索引文件

项目列表储存在当前 Windows 用户目录：

```text
C:\Users\<user>\.vectormind-admin\projects.json
```

只保存项目路径、文件夹名称、展示名称和更新时间；每个项目自己的 MCP 记忆仍保存在该项目下：

```text
<project>\.vectormind\vectormind.db
```

## UI 参考图

根据草图使用图像生成工具扩展出的参考图已保存到：

```text
admin-panel/design/vector-mind-admin-ui-reference.png
```
