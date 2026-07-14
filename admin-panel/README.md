# VectorMind 管理面板

本目录是独立的 Node.js + React 管理后台，默认端口 `16860`。

## 启动

```bash
cd admin-panel
npm install
npm run dev
```

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

管理面板默认只监听 `127.0.0.1`，API 使用启动时生成的会话令牌并拒绝非本机 Origin。不要把它直接暴露到公网。

可选环境变量：

```text
VECTORMIND_ADMIN_HOST=127.0.0.1
VECTORMIND_ADMIN_PORT=16860
VECTORMIND_ADMIN_TOKEN=<固定的高强度随机令牌>
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
