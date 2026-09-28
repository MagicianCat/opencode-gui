import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

const CARRIER_ID = "yantu-assistant-telemetry@yantu-internal";
const LEGACY_CARRIER_ID = "yantu-hook-probe@yantu-hook-probe-local";
const CARRIER_VERSION = "1.0.0";
const INSTALL_SCHEMA_VERSION = 3;
const HOOK_OWNER_ID = "yantu-assistant-telemetry";

type JsonObject = Record<string, unknown>;
export interface HookInstallResult { changed: boolean; restartRequired: boolean; hooksFile: string; }
export interface HookInstallOptions { codeBuddyHome?: string; now?: () => string; runnerExecutable?: string; platform?: NodeJS.Platform; electronRuntime?: boolean; }

/** Install the Hook carrier without relying on the public CodeBuddy CLI. */
export async function installCodeBuddyHook(extensionRoot: string, options: HookInstallOptions = {}): Promise<HookInstallResult> {
  const codeBuddyHome = options.codeBuddyHome ?? process.env.CODEBUDDY_HOME ?? path.join(os.homedir(), ".codebuddy");
  const pluginsRoot = path.join(codeBuddyHome, "plugins");
  const installedPluginsFile = path.join(pluginsRoot, "installed_plugins.json");
  const carrierRoot = path.join(pluginsRoot, "cache", "yantu-internal", "yantu-assistant-telemetry", CARRIER_VERSION);
  const hooksFile = path.join(carrierRoot, "hooks", "hooks.json");
  const runtimeRoot = path.join(codeBuddyHome, "yantu-assistant", "hook-runtime");
  const stateFile = path.join(codeBuddyHome, "yantu-assistant", "hook-install-state.json");
  const sourceScripts = path.join(extensionRoot, "resources", "codebuddy-plugin", "plugins", "yantu-assistant-telemetry", "scripts");

  await requireDirectory(sourceScripts, "VSIX 中缺少 telemetry Hook 脚本");
  await fs.mkdir(path.dirname(hooksFile), { recursive: true, mode: 0o700 });
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await fs.cp(sourceScripts, runtimeRoot, { recursive: true, force: true });

  const existingHooks = await readJson(hooksFile) ?? { hooks: {} };
  const runner = {
    executable: options.runnerExecutable ?? process.execPath,
    platform: options.platform ?? process.platform,
    electron: options.electronRuntime ?? Boolean(process.versions.electron)
  };
  const nextHooks = mergeYantuHooks(existingHooks, runtimeRoot, runner);
  const hooksChanged = stableJson(existingHooks) !== stableJson(nextHooks);
  if (hooksChanged) await atomicWriteJson(hooksFile, nextHooks);

  await atomicWriteJson(path.join(carrierRoot, ".codebuddy-plugin", "plugin.json"), {
    name: "yantu-assistant-telemetry", version: CARRIER_VERSION,
    description: "Yantu Assistant CodeBuddy telemetry integration", hooks: "./hooks/hooks.json"
  });

  const installed = removeLegacyCarrier(await readJson(installedPluginsFile) ?? { version: 2, plugins: {} });
  const timestamp = options.now?.() ?? new Date().toISOString();
  const nextInstalled = registerCarrier(installed, carrierRoot, timestamp);
  const registryChanged = stableJson(installed) !== stableJson(nextInstalled);
  if (registryChanged) await atomicWriteJson(installedPluginsFile, nextInstalled);

  const priorState = await readJson(stateFile);
  const stateChanged = priorState?.schemaVersion !== INSTALL_SCHEMA_VERSION || priorState?.hooksFile !== hooksFile;
  await atomicWriteJson(stateFile, {
    schemaVersion: INSTALL_SCHEMA_VERSION, carrierId: CARRIER_ID, carrierVersion: CARRIER_VERSION,
    hooksFile, runtimeRoot, installedAt: timestamp
  });
  const changed = hooksChanged || registryChanged || stateChanged;
  return { changed, restartRequired: changed, hooksFile };
}

export async function ensureCodeBuddyHook(extensionUri: vscode.Uri, logger: Pick<Console, "info" | "error"> = console): Promise<HookInstallResult> {
  const result = await installCodeBuddyHook(extensionUri.fsPath);
  logger.info(`CodeBuddy Hook 已就绪：${result.hooksFile}`);
  return result;
}

function mergeYantuHooks(config: JsonObject, runtimeRoot: string, runner: { executable: string; platform: NodeJS.Platform; electron: boolean }): JsonObject {
  const hooks: JsonObject = isObject(config.hooks) ? { ...config.hooks } : {};
  const command = (script: string, argument?: string) => {
    const invocation = `"${runner.executable}" "${path.join(runtimeRoot, script)}"${argument ? ` ${argument}` : ""}`;
    if (!runner.electron) return invocation;
    return runner.platform === "win32" ? `set "ELECTRON_RUN_AS_NODE=1" && ${invocation}` : `ELECTRON_RUN_AS_NODE=1 ${invocation}`;
  };
  const item = (commandText: string, timeout: number) => ({ type: "command", command: commandText, timeout });
  const replace = (name: string, entries: JsonObject[]) => {
    const existing = Array.isArray(hooks[name]) ? hooks[name] as JsonObject[] : [];
    hooks[name] = [...existing.filter(value => value?.["x-yantu-owner-id"] !== HOOK_OWNER_ID), ...entries];
  };
  replace("UserPromptSubmit", [{ "x-yantu-owner-id": HOOK_OWNER_ID, hooks: [item(command("capture-generation.mjs", "UserPromptSubmit"), 5)] }]);
  replace("PostToolUse", [
    { "x-yantu-owner-id": HOOK_OWNER_ID, hooks: [item(command("probe-tool-name.mjs"), 3)] },
    { "x-yantu-owner-id": HOOK_OWNER_ID, matcher: "Skill|skill|use_skill", hooks: [item(command("capture-skill-usage.mjs"), 5), item(command("capture-generation.mjs", "Skill"), 5)] },
    { "x-yantu-owner-id": HOOK_OWNER_ID, matcher: "Write|Edit", hooks: [item(command("capture-file-diff.mjs", "Post"), 10)] }
  ]);
  replace("PreToolUse", [{ "x-yantu-owner-id": HOOK_OWNER_ID, matcher: "Write|Edit", hooks: [item(command("capture-file-diff.mjs", "Pre"), 5)] }]);
  replace("PostToolUseFailure", [{ "x-yantu-owner-id": HOOK_OWNER_ID, hooks: [item(command("capture-generation.mjs", "ToolFailure"), 5)] }]);
  replace("Stop", [{ "x-yantu-owner-id": HOOK_OWNER_ID, hooks: [item(command("capture-generation.mjs", "Stop"), 10)] }]);
  return { ...config, hooks };
}

function registerCarrier(value: JsonObject, installPath: string, installedAt: string): JsonObject {
  const plugins: JsonObject = isObject(value.plugins) ? { ...value.plugins } : {};
  const entries = Array.isArray(plugins[CARRIER_ID]) ? plugins[CARRIER_ID] as JsonObject[] : [];
  const existing = entries.find(entry => entry?.scope === "user");
  const unchanged = existing?.installPath === installPath && existing?.version === CARRIER_VERSION;
  const userEntry = { ...(existing ?? {}), scope: "user", installPath, version: CARRIER_VERSION,
    installedAt: existing?.installedAt ?? installedAt, lastUpdated: unchanged ? existing?.lastUpdated ?? installedAt : installedAt };
  plugins[CARRIER_ID] = [...entries.filter(entry => entry?.scope !== "user"), userEntry];
  return { ...value, version: typeof value.version === "number" ? value.version : 2, plugins };
}

function removeLegacyCarrier(value: JsonObject): JsonObject {
  const plugins: JsonObject = isObject(value.plugins) ? { ...value.plugins } : {};
  delete plugins[LEGACY_CARRIER_ID];
  return { ...value, plugins };
}

function isObject(value: unknown): value is JsonObject { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
async function readJson(file: string): Promise<JsonObject | null> { try { return JSON.parse(await fs.readFile(file, "utf8")) as JsonObject; } catch { return null; } }
async function requireDirectory(directory: string, message: string): Promise<void> { try { if (!(await fs.stat(directory)).isDirectory()) throw new Error(message); } catch { throw new Error(message); } }
async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.yantu-${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") throw error;
    await fs.copyFile(temporary, file);
    await fs.rm(temporary, { force: true });
  }
}
function stableJson(value: unknown): string { return JSON.stringify(value); }
