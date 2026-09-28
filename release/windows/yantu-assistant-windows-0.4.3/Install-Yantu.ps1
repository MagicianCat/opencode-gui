$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$codeBuddy = Get-Command codebuddy -ErrorAction SilentlyContinue
if (-not $codeBuddy) { throw "未找到 codebuddy 命令。请先安装 CodeBuddy IDE，并将 CodeBuddy CLI 加入 PATH。" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "未找到 node 命令。当前 Hook 运行需要 Node.js 18 或更高版本。" }

$vsix = Get-ChildItem -LiteralPath $bundleRoot -Filter "yantu-assistant-*.vsix" | Select-Object -First 1
if (-not $vsix) { throw "安装包中缺少 yantu-assistant VSIX。" }

$running = Get-Process | Where-Object { $_.ProcessName -match "CodeBuddy" }
if ($running) { throw "请先完全退出 CodeBuddy IDE，再重新运行安装脚本。" }

Write-Host "[1/5] 安装研途助手 VSIX..."
& $codeBuddy.Source --install-extension $vsix.FullName --force
if ($LASTEXITCODE -ne 0) { throw "VSIX 安装失败，退出码：$LASTEXITCODE" }

Write-Host "[2/5] 安装本地 Hook 载体..."
$carrierMarketplace = Join-Path $bundleRoot "hook-carrier"
& $codeBuddy.Source plugin marketplace add $carrierMarketplace --name yantu-hook-probe-local 2>$null
& $codeBuddy.Source plugin install "yantu-hook-probe@yantu-hook-probe-local" --scope user
if ($LASTEXITCODE -ne 0) {
  & $codeBuddy.Source plugin update "yantu-hook-probe@yantu-hook-probe-local" --scope user
  if ($LASTEXITCODE -ne 0) { throw "Hook 载体安装失败，退出码：$LASTEXITCODE" }
}

Write-Host "[3/5] 定位 CodeBuddy Hook..."
$codeBuddyHome = Join-Path $env:USERPROFILE ".codebuddy"
$installedPluginsFile = Join-Path $codeBuddyHome "plugins\installed_plugins.json"
if (-not (Test-Path -LiteralPath $installedPluginsFile)) { throw "未找到 CodeBuddy 插件清单：$installedPluginsFile" }
$installed = Get-Content -LiteralPath $installedPluginsFile -Raw | ConvertFrom-Json
$entries = $installed.plugins."yantu-hook-probe@yantu-hook-probe-local"
$entry = $entries | Where-Object { $_.scope -eq "user" } | Select-Object -First 1
if (-not $entry.installPath) { throw "CodeBuddy 插件清单中没有用户级 Hook 载体。" }
$hooksFile = Join-Path $entry.installPath "hooks\hooks.json"
if (-not (Test-Path -LiteralPath $hooksFile)) { throw "未找到 Hook 配置：$hooksFile" }

Write-Host "[4/5] 安装采样脚本并注入 Hook..."
$runtimeRoot = Join-Path $codeBuddyHome "yantu-assistant\hook-runtime"
$telemetrySource = Join-Path $bundleRoot "telemetry"
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
Copy-Item -Path (Join-Path $telemetrySource "*") -Destination $runtimeRoot -Recurse -Force

$stateRoot = Join-Path $codeBuddyHome "yantu-assistant\windows-installer"
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$backupFile = Join-Path $stateRoot "hooks.json.backup"
$stateFile = Join-Path $stateRoot "state.json"
if (-not (Test-Path -LiteralPath $backupFile)) { Copy-Item -LiteralPath $hooksFile -Destination $backupFile }

function HookCommand([string]$scriptName, [string]$argument) {
  $script = Join-Path $runtimeRoot $scriptName
  $escaped = $script.Replace('"', '\"')
  if ($argument) { return "node `"$escaped`" $argument" }
  return "node `"$escaped`""
}
function CommandHook([string]$command, [int]$timeout) {
  return [ordered]@{ type = "command"; command = $command; timeout = $timeout }
}

$hooks = [ordered]@{
  hooks = [ordered]@{
    UserPromptSubmit = @([ordered]@{ hooks = @(CommandHook (HookCommand "capture-generation.mjs" "UserPromptSubmit") 5) })
    PostToolUse = @(
      [ordered]@{ "x-yantu-bypass-id" = "yantu-windows-bypass"; matcher = "Skill"; hooks = @(
        (CommandHook (HookCommand "capture-skill-usage.mjs" "") 5),
        (CommandHook (HookCommand "capture-generation.mjs" "Skill") 5)
      ) },
      [ordered]@{ matcher = "Write|Edit"; hooks = @(CommandHook (HookCommand "capture-file-diff.mjs" "Post") 10) }
    )
    PreToolUse = @([ordered]@{ matcher = "Write|Edit"; hooks = @(CommandHook (HookCommand "capture-file-diff.mjs" "Pre") 5) })
    PostToolUseFailure = @([ordered]@{ hooks = @(CommandHook (HookCommand "capture-generation.mjs" "ToolFailure") 5) })
    Stop = @([ordered]@{ hooks = @(CommandHook (HookCommand "capture-generation.mjs" "Stop") 10) })
  }
}
$temporaryHooks = "$hooksFile.yantu-tmp"
$hooks | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporaryHooks -Encoding UTF8
Move-Item -LiteralPath $temporaryHooks -Destination $hooksFile -Force
[ordered]@{ schemaVersion = 1; hooksFile = $hooksFile; backupFile = $backupFile; runtimeRoot = $runtimeRoot; installedAt = (Get-Date).ToUniversalTime().ToString("o") } |
  ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stateFile -Encoding UTF8

Write-Host "[5/5] 校验安装结果..."
$installedHooks = Get-Content -LiteralPath $hooksFile -Raw
if ($installedHooks -notmatch "yantu-windows-bypass") { throw "Hook 写入校验失败。" }
Write-Host "研途助手安装完成。现在打开 CodeBuddy IDE 即可使用。" -ForegroundColor Green
Write-Host "平台地址：http://10.154.76.195:8090"
