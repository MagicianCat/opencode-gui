研途助手 CodeBuddy Windows 内网测试版

安装：
1. 确保电脑连接公司内网，并可访问 http://10.154.76.195:8090。
2. 完全退出 CodeBuddy IDE。
3. 右键 Install-Yantu.ps1，选择“使用 PowerShell 运行”。
4. 安装成功后打开 CodeBuddy IDE，在左侧“研途助手”中登录。

如果系统禁止执行本地 PowerShell 脚本，可在此目录打开 PowerShell 后执行：
powershell -ExecutionPolicy Bypass -File .\Install-Yantu.ps1

卸载 Hook 旁路：
powershell -ExecutionPolicy Bypass -File .\Uninstall-Yantu.ps1

注意：当前测试版需要 codebuddy 和 node 命令可用。
