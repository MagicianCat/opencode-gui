$ErrorActionPreference = "Stop"

$codeBuddyHome = Join-Path $env:USERPROFILE ".codebuddy"
$stateRoot = Join-Path $codeBuddyHome "yantu-assistant\windows-installer"
$stateFile = Join-Path $stateRoot "state.json"
if (-not (Test-Path -LiteralPath $stateFile)) {
  Write-Host "未发现研途助手 Windows 旁路安装记录。"
  exit 0
}
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
if ((Test-Path -LiteralPath $state.backupFile) -and $state.hooksFile) {
  Copy-Item -LiteralPath $state.backupFile -Destination $state.hooksFile -Force
  Write-Host "已恢复原始 CodeBuddy Hook 配置。"
}
if ($state.runtimeRoot -and (Test-Path -LiteralPath $state.runtimeRoot)) {
  Remove-Item -LiteralPath $state.runtimeRoot -Recurse -Force
}
Remove-Item -LiteralPath $stateRoot -Recurse -Force
Write-Host "研途助手 Hook 旁路已卸载。请重新启动 CodeBuddy IDE。" -ForegroundColor Green
