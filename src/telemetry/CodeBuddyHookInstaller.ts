import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type * as vscode from "vscode";

const execFileAsync = promisify(execFile);
const marketplace = "yantu-assistant-local";
const plugin = "yantu-assistant-telemetry";

export async function ensureCodeBuddyHook(extensionUri: vscode.Uri, logger: Pick<Console, "info" | "error"> = console): Promise<void> {
  const marketplacePath = path.join(extensionUri.fsPath, "resources", "codebuddy-plugin");
  try {
    await execFileAsync("codebuddy", ["plugin", "marketplace", "add", marketplacePath, "--name", marketplace]);
  } catch { /* already registered is expected on subsequent activations */ }
  try {
    const listed = await execFileAsync("codebuddy", ["plugin", "list", "--json"]);
    const installed = JSON.parse(listed.stdout) as Array<{ id?: string }>;
    const id = `${plugin}@${marketplace}`;
    if (installed.some(item => item.id === id)) await execFileAsync("codebuddy", ["plugin", "update", id, "--scope", "user"]);
    else await execFileAsync("codebuddy", ["plugin", "install", id, "--scope", "user"]);
    logger.info(`CodeBuddy Hook 已就绪：${id}`);
  } catch (error) {
    logger.error(`CodeBuddy Hook 自动安装失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
