// Generation 生命周期采集脚本（CodeBuddy Hook，独立 node 进程，纯 .mjs 无外部依赖）。
// 用法：node capture-generation.mjs <event>，event ∈ UserPromptSubmit | Skill | ToolFailure | Stop
// 每个事件读取 stdin 的 hook payload，更新 ~/.codebuddy/yantu-assistant/telemetry/generations/{generationId}.json。
// 扩展进程的 GenerationTelemetry 负责后续聚合与上报。
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { aggregateGenerationUsage, findLastUserPrompt, aggregateToolActivity } from "./codebuddy-usage-provider.mjs";

const execFileAsync = promisify(execFile);
const root = path.join(os.homedir(), ".codebuddy", "yantu-assistant", "telemetry");
const generationsDir = path.join(root, "generations");
const installIdFile = path.join(os.homedir(), ".codebuddy", "yantu-assistant", "client-installation-id");

const event = process.argv[2] || "";

try {
  const payload = JSON.parse(await readStdin(4 * 1024 * 1024));
  switch (event) {
    case "UserPromptSubmit": await onUserPrompt(payload); break;
    case "Skill": await onSkill(payload); break;
    case "ToolFailure": await onToolFailure(payload); break;
    case "PostToolUse": await onPostToolUse(payload); break;
    case "Stop": await onStop(payload); break;
    default: break;
  }
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
} catch (error) {
  process.stderr.write(`generation hook (${event}) skipped: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

// ---- 事件处理 ----

async function onUserPrompt(payload) {
  const sessionId = str(payload.session_id) || "UNKNOWN";
  // generation id：CodeBuddy payload 里的 generation_id 优先，否则用 session+prompt 起始构造。
  const generationId = str(payload.generation_id) || str(payload.message_id) || `${sessionId}:${Date.now()}`;
  const cwd = await resolveCwd(payload);
  const now = new Date().toISOString();
  const state = {
    generationId, sessionId,
    clientInstallationId: await readInstallId(),
    cwd,
    startedAt: now,
    status: "RUNNING",
    ...(await resolveProject(cwd)),
    skillInvocations: [], fileDiffs: [],
    toolCallCount: 0, toolFailureCount: 0,
    updatedAtMs: Date.now(),
  };
  await save(state);
}

async function onSkill(payload) {
  const skillKey = payload.tool_input?.command;
  if (typeof skillKey !== "string") return;
  await mutateCurrent(payload, state => {
    state.skillInvocations.push({ skillKey, invokedAt: new Date().toISOString() });
    state.toolCallCount += 1;
  });
}

async function onPostToolUse(payload) {
  // 其它工具的调用计数（Write/Edit 的 diff 由 capture-file-diff.mjs 专门处理）。
  const toolName = str(payload.tool_name);
  if (toolName === "Skill" || toolName === "Write" || toolName === "Edit") return; // 已被专用脚本处理
  await mutateCurrent(payload, state => { state.toolCallCount += 1; });
}

async function onToolFailure(payload) {
  await mutateCurrent(payload, state => {
    state.toolCallCount += 1;
    state.toolFailureCount += 1;
  });
}

async function onStop(payload) {
  const sessionId = str(payload.session_id);
  // 先把命中的 RUNNING generation 标记为 COMPLETED（交互模式 UserPromptSubmit 已建过）。
  await mutateCurrent(payload, state => {
    state.status = "COMPLETED";
    state.endedAt = new Date().toISOString();
    state.durationMs = Date.parse(state.endedAt) - Date.parse(state.startedAt);
  });

  // 再取一次：交互模式上面已命中；非交互 -p 模式只有 Stop 触发、此前无 generation 文件。
  const generationId = str(payload.generation_id) || str(payload.message_id);
  let state = generationId ? await load(generationId) : null;
  if (!state) state = await latestCompleted(sessionId);
  if (!state) {
    // 兜底：UserPromptSubmit 从未触发（-p 非交互），从 transcript 整轮重建。
    state = await rebuildFromTranscript(payload, sessionId, generationId);
  }
  if (!state) return;

  // Token：Stop 后 transcript 已完整，按 Generation 起始时间聚合该轮 usage。
  if (!state.usage) {
    const startMs = Date.parse(state.startedAt);
    const usage = await aggregateGenerationUsage(state.sessionId, Number.isFinite(startMs) ? startMs : 0);
    if (usage) {
      // 重新加载再写，避免覆盖已写入的 endedAt/status。
      const current = await load(state.generationId);
      if (current) {
        current.usage = usage;
        await save(current);
      }
    }
  }
}

/**
 * 非交互模式兜底：只有 Stop 触发时，从 transcript 重建整轮 Generation。
 * 起点取 transcript 最后一个 user prompt；Skill/工具计数从 function_call 聚合。
 */
async function rebuildFromTranscript(payload, sessionId, generationId) {
  if (!sessionId) return null;
  const anchor = await findLastUserPrompt(sessionId);
  if (!anchor) return null;
  const cwd = anchor.cwd || (await resolveCwd(payload)) || str(payload.cwd) || "";
  const gid = generationId || `${sessionId}:${anchor.startedAtMs}`;
  const endedAt = new Date().toISOString();
  const { skillKeys, toolCallCount } = await aggregateToolActivity(sessionId, anchor.startedAtMs);
  const state = {
    generationId: gid,
    sessionId,
    clientInstallationId: await readInstallId(),
    cwd,
    startedAt: anchor.startedAtIso,
    endedAt,
    durationMs: Date.parse(endedAt) - anchor.startedAtMs,
    status: "COMPLETED",
    ...(await resolveProject(cwd)),
    skillInvocations: skillKeys.map(skillKey => ({ skillKey, invokedAt: anchor.startedAtIso })),
    fileDiffs: [],
    toolCallCount, toolFailureCount: 0,
    updatedAtMs: Date.now(),
    rebuiltFromTranscript: true,
  };
  await save(state);
  return state;
}

// ---- 状态读写 ----

async function mutateCurrent(payload, mutate) {
  const sessionId = str(payload.session_id);
  const generationId = str(payload.generation_id) || str(payload.message_id);
  // 优先按 generationId 精确命中；否则取该 session 最近一个 RUNNING 的 generation。
  let state = generationId ? await load(generationId) : null;
  if (!state) state = await latestRunning(sessionId);
  if (!state) return; // 无对应 Generation（可能是 Skill 在 Generation 外被单独触发）——忽略
  mutate(state);
  await save(state);
}

function fileFor(generationId) {
  return path.join(generationsDir, `${String(generationId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

async function load(generationId) {
  try { return JSON.parse(await fs.readFile(fileFor(generationId), "utf8")); } catch { return null; }
}

async function save(state) {
  await fs.mkdir(generationsDir, { recursive: true, mode: 0o700 });
  state.updatedAtMs = Date.now();
  const target = fileFor(state.generationId);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(tmp, target);
}

async function latestRunning(sessionId) {
  return latestByStatus(sessionId, "RUNNING");
}

async function latestCompleted(sessionId) {
  return latestByStatus(sessionId, "COMPLETED");
}

async function latestByStatus(sessionId, status) {
  if (!sessionId) return null;
  let names;
  try { names = await fs.readdir(generationsDir); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let s;
    try { s = JSON.parse(await fs.readFile(path.join(generationsDir, name), "utf8")); } catch { continue; }
    if (s.sessionId === sessionId && s.status === status) {
      if (!best || (s.updatedAtMs || 0) > (best.updatedAtMs || 0)) best = s;
    }
  }
  return best;
}

// ---- 项目解析 / 工具 ----

async function resolveProject(cwd) {
  const remote = await gitRemote(cwd);
  if (remote) {
    const normalized = normalizeGitRemote(remote);
    return { projectKey: sha256(normalized), projectName: repoBasename(remote) || repoBasename(normalized) || "unknown", projectSource: "GIT_REMOTE" };
  }
  const install = (await readInstallId()) || "unknown-install";
  const normalizedPath = String(cwd || "").replace(/[\\/]+$/, "");
  return { projectKey: sha256(`${install}:${normalizedPath}`), projectName: pathBasename(normalizedPath) || "unknown", projectSource: "LOCAL" };
}

async function gitRemote(cwd) {
  if (!cwd) return null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { timeout: 3000 });
    return stdout.trim() || null;
  } catch { return null; }
}

async function resolveCwd(payload) {
  // transcript 的 Workspace Folder 最权威；退化为 payload cwd。
  const candidates = [payload.cwd, payload.workspace_path, payload.workspace_folder, payload.tool_input?.cwd];
  for (const c of candidates) {
    if (typeof c === "string" && path.isAbsolute(c) && c !== path.parse(c).root) return path.normalize(c.trim());
  }
  return str(payload.cwd) || "";
}

async function readInstallId() {
  try { return (await fs.readFile(installIdFile, "utf8")).trim() || undefined; } catch { return undefined; }
}

function normalizeGitRemote(remote) {
  let v = remote.trim();
  const scp = v.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) v = `${scp[1]}/${scp[2]}`;
  v = v.replace(/^[a-zA-Z]+:\/\//, "").replace(/^[^/@]+@/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return v.toLowerCase();
}
function repoBasename(raw) {
  const seg = String(raw || "").split(/[/:]/).filter(Boolean).pop() || "";
  return seg.replace(/\.git$/, "");
}
function pathBasename(p) { return p.split(/[\\/]/).filter(Boolean).pop() || ""; }
function sha256(s) { return createHash("sha256").update(s).digest("hex"); }
function str(v) { return typeof v === "string" && v ? v : undefined; }

async function readStdin(maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("hook payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
