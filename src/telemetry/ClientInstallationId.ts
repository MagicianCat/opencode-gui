import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type * as vscode from "vscode";

const GLOBAL_STATE_KEY = "yantuAssistant.clientInstallationId";
const SHARED_FILE = path.join(os.homedir(), ".codebuddy", "yantu-assistant", "client-installation-id");

/**
 * clientInstallationId：区分 IDE/插件实例的稳定 id。
 * 扩展激活时从 globalState 读取（不存在则生成并持久化），并同步写一份到
 * ~/.codebuddy/yantu-assistant/client-installation-id，供独立 hook 进程读取。
 */
export async function ensureClientInstallationId(context: vscode.ExtensionContext): Promise<string> {
  let id = context.globalState.get<string>(GLOBAL_STATE_KEY);
  if (!id) {
    id = randomUUID();
    await context.globalState.update(GLOBAL_STATE_KEY, id);
  }
  await writeSharedFile(id);
  return id;
}

/** 从 globalState 拿（扩展进程内用）。 */
export function currentClientInstallationId(context: vscode.ExtensionContext): string | undefined {
  return context.globalState.get<string>(GLOBAL_STATE_KEY);
}

/** hook 进程读取共享文件（无 globalState 访问能力）。 */
export async function readClientInstallationIdFromDisk(): Promise<string | undefined> {
  try {
    const value = (await fs.readFile(SHARED_FILE, "utf8")).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function writeSharedFile(id: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SHARED_FILE), { recursive: true, mode: 0o700 });
    await fs.writeFile(SHARED_FILE, id, { mode: 0o600 });
  } catch { /* best effort：共享文件失败不阻断扩展激活 */ }
}
