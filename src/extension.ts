import * as vscode from "vscode";
import { YantuViewProvider } from "./YantuViewProvider";
import { PlatformClient } from "./platform/PlatformClient";
import { resolveMachineSetting } from "./platform/ServiceUrl";
import { TelemetryUploader } from "./telemetry/TelemetryUploader";
import { ensureCodeBuddyHook } from "./telemetry/CodeBuddyHookInstaller";
import { ensureClientInstallationId } from "./telemetry/ClientInstallationId";
import { GenerationTelemetry } from "./telemetry/generation/GenerationTelemetry";
import { buildConfig } from "./BuildConfig";

let logger: vscode.LogOutputChannel;
export function getLogger(): vscode.LogOutputChannel { return logger; }
export function activate(context: vscode.ExtensionContext): void {
  logger = vscode.window.createOutputChannel("研途助手", { log: true }); context.subscriptions.push(logger);
  const config = () => machineSetting("apiBaseUrl", buildConfig.apiBaseUrl);
  const client = new PlatformClient({ apiBaseUrl: config, secrets: context.secrets });
  void ensureClientInstallationId(context).then(
    id => logger.info(`clientInstallationId 已就绪：${id}`),
    error => logger.error(`clientInstallationId 初始化失败：${error}`));
  const telemetry = new TelemetryUploader(client, { error: error => logger.error(String(error)) });
  telemetry.start(); context.subscriptions.push(telemetry);
  const generationTelemetry = new GenerationTelemetry(client, { error: error => logger.error(String(error)) });
  generationTelemetry.start(); context.subscriptions.push(generationTelemetry);
  void ensureCodeBuddyHook(context.extensionUri, { info: message => logger.info(message), error: message => logger.error(message) }).then(async result => {
    if (!result.restartRequired) return;
    const action = await vscode.window.showInformationMessage("研途助手采样组件已安装，需要重启 CodeBuddy 后生效。", "立即重启", "稍后");
    if (action === "立即重启") await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }, error => logger.error(`CodeBuddy Hook 自动安装失败：${error instanceof Error ? error.message : String(error)}`));
  const provider = new YantuViewProvider(context.extensionUri, client, buildConfig.webBaseUrl);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(YantuViewProvider.viewType, provider), provider);
  logger.info("研途助手已激活");
}
export function deactivate(): void { logger?.info("研途助手已停用"); }
export function machineSetting(key: string, fallback: string): string { const inspected = vscode.workspace.getConfiguration("yantuAssistant").inspect<string>(key); return inspected ? resolveMachineSetting(inspected) || fallback : fallback; }
