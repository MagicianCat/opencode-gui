import * as vscode from "vscode";
import { YantuViewProvider } from "./YantuViewProvider";
import { PlatformClient } from "./platform/PlatformClient";
import { resolveMachineSetting } from "./platform/ServiceUrl";
import { TelemetryUploader } from "./telemetry/TelemetryUploader";
import { ensureCodeBuddyHook } from "./telemetry/CodeBuddyHookInstaller";
import { ensureClientInstallationId } from "./telemetry/ClientInstallationId";
import { GenerationTelemetry } from "./telemetry/generation/GenerationTelemetry";

let logger: vscode.LogOutputChannel;
export function getLogger(): vscode.LogOutputChannel { return logger; }
export function activate(context: vscode.ExtensionContext): void {
  logger = vscode.window.createOutputChannel("研途助手", { log: true }); context.subscriptions.push(logger);
  const config = () => machineSetting("apiBaseUrl", "http://127.0.0.1:8090/api/v1");
  const client = new PlatformClient({ apiBaseUrl: config, secrets: context.secrets });
  void ensureClientInstallationId(context).then(
    id => logger.info(`clientInstallationId 已就绪：${id}`),
    error => logger.error(`clientInstallationId 初始化失败：${error}`));
  const telemetry = new TelemetryUploader(client, { error: error => logger.error(String(error)) });
  telemetry.start(); context.subscriptions.push(telemetry);
  const generationTelemetry = new GenerationTelemetry(client, { error: error => logger.error(String(error)) });
  generationTelemetry.start(); context.subscriptions.push(generationTelemetry);
  void ensureCodeBuddyHook(context.extensionUri, { info: message => logger.info(message), error: message => logger.error(message) });
  const provider = new YantuViewProvider(context.extensionUri, client);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(YantuViewProvider.viewType, provider), provider);
  logger.info("研途助手已激活");
}
export function deactivate(): void { logger?.info("研途助手已停用"); }
export function machineSetting(key: string, fallback: string): string { const inspected = vscode.workspace.getConfiguration("yantuAssistant").inspect<string>(key); return inspected ? resolveMachineSetting(inspected) || fallback : fallback; }
