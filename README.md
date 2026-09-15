# 研途助手 CodeBuddy 扩展

CodeBuddy IDE 左侧边栏中的公司内部研发助手。扩展通过平台 Agent 提供流式对话和 Skill 推荐，可识别项目及全局已安装的 Skill，并安全下载、校验和安装缺失项。

## 本地开发

要求 Node.js 20 或 22、pnpm 10.13.1。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:integration
pnpm package
```

默认连接：

- API：`http://127.0.0.1:8090/api/v1`
- Web：`http://127.0.0.1:5173`

可以通过 CodeBuddy 设置中的 `yantuAssistant.apiBaseUrl` 和 `yantuAssistant.webBaseUrl` 覆盖。

## 安全边界

- refresh token 仅保存在 ExtensionContext SecretStorage，access token 仅驻留 Extension Host 内存。
- Webview 不接收 Token，也不直接访问平台 API。
- 不向平台发送编辑器内容、代码文件或本地 Skill 清单。
- Skill Bundle 和内层 Artifact 均校验 SHA-256，并拒绝路径穿越、绝对路径、符号链接、重复路径和超限 ZIP。

## 后端接口依赖

IDE 登录使用 `/auth/ide/authorizations` 与 `/auth/ide/token`；安装使用 Agent Run Bundle 的 `skillKeys`、`artifactFileName` 和 `artifactSha256`。这些接口需与平台后端同步发布。

本项目基于 MIT 许可的 `saffron-health/opencode-gui` 改造，保留原许可证与著作权声明。
