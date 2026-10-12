// CodeBuddy Generation Token Usage Provider（hook 进程内运行，纯 .mjs）。
// 主用 LocalStateUsageProvider：读 ~/.codebuddy/projects/{slug}/{sessionId}.jsonl，
// 按 user-prompt 边界聚合该轮 Generation 的多次模型调用 usage，得到整轮 Token。
// 证据见设计文档 §5 / §16：CodeBuddy 已按多轮模型调用累加，transcript 的 providerData.usage 是真实上游 usage。
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const projectsRoot = path.join(os.homedir(), ".codebuddy", "projects");

/**
 * 从 jsonl transcript 聚合一轮 Generation 的 Token。
 * @param {string} sessionId  会话 id（jsonl 文件名）
 * @param {number} generationStartMs  Generation 起始时间（UserPromptSubmit 时间戳，epoch ms）
 * @returns {Promise<object|null>} GenerationTokenUsage 或 null（拿不到时）
 */
export async function aggregateGenerationUsage(sessionId, generationStartMs) {
  const file = await findTranscript(sessionId);
  if (!file) return null;
  const records = await readJsonl(file);
  // 只统计本轮 Generation 内的模型调用：timestamp >= generationStartMs。
  const usages = [];
  let lastCallTokens = 0;
  for (const rec of records) {
    if (rec.type !== "function_call") continue;
    if (typeof rec.timestamp === "number" && generationStartMs && rec.timestamp < generationStartMs) continue;
    const usage = rec.providerData?.usage;
    if (!usage) continue;
    usages.push(usage);
    lastCallTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  if (usages.length === 0) return null;

  let inputTokens = 0, outputTokens = 0, totalTokens = 0, cacheReadTokens = 0, thinkingTokens = 0;
  for (const u of usages) {
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    totalTokens += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    for (const d of u.inputTokensDetails ?? []) cacheReadTokens += d.cached_tokens ?? 0;
    for (const d of u.outputTokensDetails ?? []) thinkingTokens += d.reasoning_tokens ?? 0;
  }
  return {
    inputTokens, outputTokens, totalTokens,
    cacheReadTokens, cacheWriteTokens: 0,
    cacheMissTokens: Math.max(0, inputTokens - cacheReadTokens),
    thinkingTokens,
    modelCallCount: usages.length,
    lastTokens: lastCallTokens,
    source: "CODEBUDDY_UPSTREAM_USAGE",
    quality: "EXACT",
  };
}

/** 按 sessionId 在 projects/{slug}/{sessionId}.jsonl 中定位 transcript（slug 未知，需遍历）。 */
async function findTranscript(sessionId) {
  if (!sessionId) return null;
  let slugs;
  try { slugs = await fs.readdir(projectsRoot); } catch { return null; }
  for (const slug of slugs) {
    const candidate = path.join(projectsRoot, slug, `${sessionId}.jsonl`);
    try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  return null;
}

/**
 * 从 transcript 找最后一个 user prompt（Generation 起点）。
 * 返回 { startedAtMs, startedAtIso, cwd } 或 null。
 */
export async function findLastUserPrompt(sessionId) {
  const file = await findTranscript(sessionId);
  if (!file) return null;
  const records = await readJsonl(file);
  let last = null;
  for (const rec of records) {
    if (rec.type === "message" && rec.role === "user" && typeof rec.timestamp === "number") last = rec;
  }
  if (!last) return null;
  return {
    startedAtMs: last.timestamp,
    startedAtIso: new Date(last.timestamp).toISOString(),
    cwd: typeof last.cwd === "string" ? last.cwd : undefined,
  };
}

/** 从 transcript 统计该轮的 Skill 调用与 tool 计数（generationStartMs 之后）。 */
export async function aggregateToolActivity(sessionId, generationStartMs) {
  const file = await findTranscript(sessionId);
  if (!file) return { skillKeys: [], toolCallCount: 0 };
  const records = await readJsonl(file);
  const skillKeys = [];
  let toolCallCount = 0;
  for (const rec of records) {
    if (rec.type !== "function_call") continue;
    if (typeof rec.timestamp === "number" && generationStartMs && rec.timestamp < generationStartMs) continue;
    toolCallCount += 1;
    const name = rec.name;
    if (name === "Skill" || name === "use_skill" || name === "skill") {
      const key = extractSkillKey(rec);
      if (key) skillKeys.push(key);
    }
  }
  return { skillKeys: [...new Set(skillKeys)], toolCallCount };
}

function extractSkillKey(rec) {
  try {
    const args = typeof rec.arguments === "string" ? JSON.parse(rec.arguments) : rec.arguments;
    const key = args?.command ?? args?.skill ?? args?.name;
    return typeof key === "string" && key ? key : null;
  } catch { return null; }
}

async function readJsonl(file) {
  const records = [];
  let text;
  try { text = await fs.readFile(file, "utf8"); } catch { return records; }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { records.push(JSON.parse(trimmed)); } catch { /* skip corrupt line */ }
  }
  return records;
}
