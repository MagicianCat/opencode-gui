import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const stateDir = process.env.CODEBUDDY_BYPASS_STATE_DIR || path.join(HOME, ".codebuddy", "yantu-assistant", "local-dev-bypass");
const stateFile = path.join(stateDir, "state.json");
const installedPluginsFile = process.env.CODEBUDDY_BYPASS_INSTALLED_PLUGINS || path.join(HOME, ".codebuddy", "plugins", "installed_plugins.json");
const captureScript = process.env.CODEBUDDY_BYPASS_CAPTURE_SCRIPT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources/codebuddy-plugin/plugins/yantu-assistant-telemetry/scripts/capture-skill-usage.mjs");
const bypassId = "yantu-local-dev-bypass";

const command = process.argv[2];
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (command === "install") await install();
  else if (command === "uninstall") await uninstall();
  else if (command === "status") await status();
  else {
    console.error("Usage: node codebuddy-hook-bypass.mjs <install|uninstall|status>");
    process.exitCode = 2;
  }
}

async function install() {
  if (await exists(stateFile)) {
    console.log(`已安装：${stateFile}`);
    return;
  }
  const targetHooks = process.env.CODEBUDDY_BYPASS_TARGET_HOOKS || await discoverTargetHooks();
  if (!targetHooks) throw new Error("未找到已安装且可加载的 CodeBuddy Hook 配置。请先安装本地 Hook 探针，或设置 CODEBUDDY_BYPASS_TARGET_HOOKS。");
  const original = await readJson(targetHooks);
  if (!original || typeof original !== "object") throw new Error(`Hook 配置无效：${targetHooks}`);
  const updated = addBypassHook(original, captureScript);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(`${targetHooks}.yantu-backup`, JSON.stringify(original, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await atomicWriteJson(targetHooks, updated);
  await atomicWriteJson(stateFile, { schemaVersion: 1, id: bypassId, targetHooks, backupFile: `${targetHooks}.yantu-backup`, captureScript, installedAt: new Date().toISOString() });
  console.log(`本地旁路 Hook 已安装：${targetHooks}`);
  console.log("重启 CodeBuddy IDE 后生效；卸载命令：pnpm run dev:codebuddy-bypass:uninstall");
}

async function uninstall() {
  const state = await readJson(stateFile);
  if (!state || state.id !== bypassId) {
    console.log("未发现本地旁路 Hook");
    return;
  }
  const backup = await readJson(state.backupFile);
  if (backup) await atomicWriteJson(state.targetHooks, backup);
  else await removeBypassHook(state.targetHooks);
  await fs.rm(state.backupFile, { force: true });
  await fs.rm(stateFile, { force: true });
  console.log("本地旁路 Hook 已卸载，原 Hook 配置已恢复");
}

async function status() {
  const state = await readJson(stateFile);
  console.log(JSON.stringify(state || { installed: false }, null, 2));
}

async function discoverTargetHooks() {
  const installed = await readJson(installedPluginsFile);
  const entries = installed?.plugins?.["yantu-assistant-telemetry@yantu-internal"];
  const installPath = Array.isArray(entries) ? entries.find(item => item?.scope === "user")?.installPath : undefined;
  return installPath ? path.join(installPath, "hooks", "hooks.json") : "";
}

export function addBypassHook(config, script) {
  const hooks = { ...(config.hooks || {}) };
  const postToolUse = Array.isArray(hooks.PostToolUse) ? [...hooks.PostToolUse] : [];
  if (!postToolUse.some(item => item?.["x-yantu-bypass-id"] === bypassId)) {
    postToolUse.push({
      "x-yantu-bypass-id": bypassId,
      matcher: "Skill|skill|use_skill",
      hooks: [{ type: "command", command: `node "${script}"`, timeout: 5 }]
    });
  }
  hooks.PostToolUse = postToolUse;
  return { ...config, hooks };
}

async function removeBypassHook(file) {
  const config = await readJson(file);
  if (config) await atomicWriteJson(file, { ...config, hooks: { ...(config.hooks || {}), PostToolUse: (config.hooks?.PostToolUse || []).filter(item => item?.["x-yantu-bypass-id"] !== bypassId) } });
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }
async function atomicWriteJson(file, value) { const tmp = `${file}.yantu-tmp-${process.pid}`; await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await fs.rename(tmp, file); }
