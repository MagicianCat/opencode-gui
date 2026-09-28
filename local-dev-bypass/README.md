# CodeBuddy 本地开发旁路 Hook

该目录只用于 CodeBuddy 内部环境的本地联调，不进入正式 VSIX。

旁路会把采样 Hook 临时追加到当前已加载的本地 Hook 探针，并在卸载时恢复原始配置。

```bash
pnpm run dev:codebuddy-bypass:install
# 重启 CodeBuddy IDE 后测试
pnpm run dev:codebuddy-bypass:status
pnpm run dev:codebuddy-bypass:uninstall
```

默认目标是 `yantu-assistant-telemetry@yantu-internal` 的用户级安装。也可以通过
`CODEBUDDY_BYPASS_TARGET_HOOKS` 指定一个本地 `hooks.json`。
