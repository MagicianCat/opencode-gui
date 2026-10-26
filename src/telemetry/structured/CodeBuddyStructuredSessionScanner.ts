import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileDiffMetric, GenerationTokenUsage } from "../generation/GenerationState";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 500;

type Json = Record<string, unknown>;
export interface StructuredSkillCall { skillKey: string; toolCallId: string; invokedAt: string; }
export interface StructuredConversationMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string; }
export interface StructuredTurn {
  nativeInstallationId: string;
  workspaceHash: string;
  conversationId: string;
  requestId: string;
  startedAt: string;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  endedAt?: string;
  usage?: GenerationTokenUsage;
  modelId?: string;
  modelName?: string;
  toolCallCount: number;
  skillCalls: StructuredSkillCall[];
  fileDiffs?: FileDiffMetric[];
  workspace?: string;
  conversationMessages: StructuredConversationMessage[];
}

/** Read-only adapter for TkCoding 4.11's history and file-tree metadata. */
export class CodeBuddyStructuredSessionScanner {
  private readonly dataRoot: string;
  private readonly cursorFile: string;
  private readonly backfillMs: number;
  private readonly now: () => Date;
  private readonly fingerprints: Record<string, string> = {};
  private initialized = false;
  private pending: Record<string, string> = {};

  constructor(options: { homeDirectory?: string; localAppDataDirectory?: string; backfillDays?: number; now?: () => Date } = {}) {
    const home = options.homeDirectory ?? os.homedir();
    this.dataRoot = path.join(options.localAppDataDirectory ?? process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "CodeBuddyExtension", "Data");
    this.cursorFile = path.join(home, ".codebuddy", "yantu-assistant", "telemetry", "structured-cursor.json");
    this.backfillMs = (options.backfillDays ?? 7) * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  async scan(): Promise<StructuredTurn[]> {
    if (!this.initialized) {
      const saved = await this.readJson(this.cursorFile);
      if (saved) Object.assign(this.fingerprints, saved);
      this.initialized = true;
    }
    this.pending = {};
    const turns: StructuredTurn[] = [];
    let visited = 0;
    for (const installation of await this.directories(this.dataRoot)) {
      const root = path.join(this.dataRoot, installation, "CodeBuddyIDE", installation);
      const history = path.join(root, "history");
      for (const workspaceHash of await this.directories(history)) {
        if (!/^[\w-]{1,128}$/.test(workspaceHash)) continue;
        for (const conversationId of await this.directories(path.join(history, workspaceHash))) {
          if (!/^[\w-]{1,256}$/.test(conversationId)) continue;
          const sessionDir = path.join(history, workspaceHash, conversationId);
          const indexFile = path.join(sessionDir, "index.json");
          const treeFile = path.join(root, "file-tree", workspaceHash, conversationId, "file-tree.json");
          const indexStat = await fs.stat(indexFile).catch(() => undefined);
          if (!indexStat || indexStat.mtimeMs < this.now().getTime() - this.backfillMs) continue;
          if (++visited > MAX_SESSIONS) return turns;
          const treeStat = await fs.stat(treeFile).catch(() => undefined);
          const fingerprint = `${indexStat.size}:${indexStat.mtimeMs}|${treeStat?.size ?? 0}:${treeStat?.mtimeMs ?? 0}`;
          const key = `${installation}/${workspaceHash}/${conversationId}`;
          if (this.fingerprints[`session:${key}`] === fingerprint) continue;
          const index = await this.readJson(indexFile);
          if (!index || !Array.isArray(index.requests)) continue;
          const fileTree = await this.readArray(treeFile);
          const requests = index.requests;
          const sessionTurns: StructuredTurn[] = [];
          const sessionPending: Record<string, string> = {};
          const conversationMessages: StructuredConversationMessage[] = [];
          let hasUnstableMessages = false;
          let hasRunningRequest = false;
          for (const requestValue of requests) {
            const request = object(requestValue);
            const requestId = string(request?.id);
            const startedAt = timestamp(request?.startedAt);
            if (!requestId || !startedAt) continue;
            const withinBackfill = Date.parse(startedAt) >= this.now().getTime() - this.backfillMs;
            const state = string(request?.state)?.toLowerCase();
            const status = state === "complete" ? "COMPLETED" : state === "failed" ? "FAILED" :
              state === "cancelled" || state === "canceled" ? "CANCELLED" : "RUNNING";
            if (status === "RUNNING" && withinBackfill) hasRunningRequest = true;
            const messages = await this.messages(sessionDir, request, requestId);
            if (!messages) {
              if (!withinBackfill) continue;
              hasUnstableMessages = true;
            }
            const calls = new Map<string, StructuredSkillCall>();
            const turnMessages: StructuredConversationMessage[] = [];
            const toolIds = new Set<string>();
            let modelId: string | undefined;
            let modelName: string | undefined;
            let endedAt: string | undefined;
            for (const msg of messages ?? []) {
              const extra = object(msg.extra);
              if (extra?.requestId && extra.requestId !== requestId) continue;
              modelId = string(extra?.modelId) ?? modelId;
              modelName = string(extra?.modelName) ?? modelName;
              const createdAt = timestamp(msg.createdAt);
              if (createdAt && (!endedAt || createdAt > endedAt)) endedAt = createdAt;
              const role = string(msg.role)?.toLowerCase();
              const content = messageText(msg.message);
              if ((role === "user" || role === "assistant") && createdAt && content) {
                const id = role === "user" && !conversationMessages.some(message => message.id === `${requestId}-user`)
                  ? `${requestId}-user` : string(msg.id) ?? `${requestId}-${conversationMessages.length}`;
                const textMessage: StructuredConversationMessage = { id, role, content, createdAt };
                turnMessages.push(textMessage);
                conversationMessages.push(textMessage);
              }
              for (const tool of toolEntries(msg.message ?? msg)) {
                const callId = string(tool.toolCallId) ?? string(tool.callId) ?? string(tool.id);
                if (!callId) continue;
                toolIds.add(callId);
                if ((string(tool.toolName) ?? string(tool.name)) !== "use_skill") continue;
                const args = object(tool.args) ?? object(tool.arguments);
                const skillKey = string(args?.command);
                if (skillKey && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillKey))
                  calls.set(callId, { skillKey, toolCallId: callId, invokedAt: createdAt ?? startedAt });
              }
            }
            if (!withinBackfill) continue;
            const diffs = fileTree ? fileMetrics(fileTree, requestId) : undefined;
            const messageEvidence = turnMessages.map(message => [message.id, message.role,
              createHash("sha256").update(message.content).digest("hex")]);
            const requestFingerprint = createHash("sha256").update(JSON.stringify(request) +
              JSON.stringify(diffs ?? null) + JSON.stringify([...calls.values()]) +
              JSON.stringify([modelId, modelName, endedAt, messageEvidence])).digest("hex");
            const requestKey = `request:${key}/${requestId}`;
            if (this.fingerprints[requestKey] === requestFingerprint) continue;
            const rawUsage = object(request.usage);
            sessionTurns.push({ nativeInstallationId: installation, workspaceHash, conversationId, requestId, startedAt, status,
              endedAt: status === "RUNNING" ? undefined : endedAt,
              usage: rawUsage && status !== "RUNNING" ? usage(rawUsage) : undefined,
              modelId, modelName, toolCallCount: toolIds.size, skillCalls: [...calls.values()],
              fileDiffs: diffs?.length ? diffs : undefined, workspace: string(index.workspacePath) ?? string(index.workspace) ??
                string(request.workspacePath), conversationMessages });
            sessionPending[requestKey] = requestFingerprint;
          }
          turns.push(...sessionTurns);
          Object.assign(this.pending, sessionPending);
          if (!hasRunningRequest && !hasUnstableMessages && this.now().getTime() - indexStat.mtimeMs > 30_000)
            this.pending[`session:${key}`] = fingerprint;
        }
      }
    }
    return turns;
  }

  async commit(): Promise<void> {
    Object.assign(this.fingerprints, this.pending);
    this.pending = {};
    await fs.mkdir(path.dirname(this.cursorFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.cursorFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.fingerprints), { mode: 0o600 });
    await fs.rename(temporary, this.cursorFile);
  }

  private async messages(sessionDir: string, request: Json, requestId: string): Promise<Json[] | undefined> {
    const result: Json[] = [];
    if (!Array.isArray(request.messages)) return result;
    for (const entry of request.messages) {
      const embedded = object(entry);
      const id = typeof entry === "string" ? entry : string(embedded?.id);
      const msg = embedded?.message ? embedded : id && /^[\w-]{1,256}$/.test(id)
        ? await this.readJson(path.join(sessionDir, "messages", `${id}.json`)) : undefined;
      if (!msg) return undefined; // JSON is still being written; retry this session on the next poll.
      if (object(msg.extra)?.requestId && object(msg.extra)?.requestId !== requestId) continue;
      result.push(id && !msg.id ? { ...msg, id } : msg);
    }
    return result;
  }

  private async directories(root: string): Promise<string[]> {
    try { return (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
    catch { return []; }
  }
  private async readJson(file: string): Promise<Json | undefined> {
    try {
      if ((await fs.stat(file)).size > MAX_JSON_BYTES) return undefined;
      return object(JSON.parse(await fs.readFile(file, "utf8")));
    } catch { return undefined; }
  }
  private async readArray(file: string): Promise<unknown[] | undefined> {
    try {
      if ((await fs.stat(file)).size > MAX_JSON_BYTES) return undefined;
      const data: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      return Array.isArray(data) ? data : Array.isArray(object(data)?.files) ? object(data)!.files as unknown[] : undefined;
    } catch { return undefined; }
  }
}

function object(value: unknown): Json | undefined {
  if (typeof value === "string" && value.startsWith("{")) {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}
function string(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function timestamp(value: unknown): string | undefined {
  const normalized = typeof value === "string" && /^\d{10,13}$/.test(value)
    ? Number(value) : value;
  const date = new Date(typeof normalized === "number" ? normalized : typeof normalized === "string" ? normalized : NaN);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function toolEntries(value: unknown, depth = 0): Json[] {
  if (depth > 4) return [];
  if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
    try { return toolEntries(JSON.parse(value), depth + 1); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(item => toolEntries(item, depth + 1));
  const data = object(value);
  if (!data) return [];
  const own = string(data.toolName) || string(data.toolCallId) ? [data] : [];
  return own.concat(["toolCalls", "tools", "content", "parts", "message", "data"].flatMap(key => toolEntries(data[key], depth + 1)));
}
function messageText(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (/^[\[{]/.test(value.trim())) {
      try { return messageText(JSON.parse(value)); } catch { /* plain text containing JSON syntax */ }
    }
    return value.slice(0, 100_000);
  }
  const data = object(value);
  if (data) {
    if (data.toolName || data.toolCallId || data.args || data.arguments) return undefined;
    const direct = string(data.text) ?? string(data.content);
    if (direct) return direct.slice(0, 100_000);
  }
  if (Array.isArray(value)) {
    const parts = value.filter(part => {
      const row = object(part);
      return row && (row.type === "text" || row.type === "text_message") &&
        !row.toolCallId && !row.args && typeof row.text === "string";
    }).map(part => string(object(part)?.text)!);
    if (parts.length) return parts.join("\n").slice(0, 100_000);
  }
  return undefined;
}
function usage(raw: Json): GenerationTokenUsage {
  const complete = number(raw.inputTokens) !== undefined && number(raw.outputTokens) !== undefined;
  return { inputTokens: number(raw.inputTokens), outputTokens: number(raw.outputTokens),
    totalTokens: number(raw.totalTokens), cacheReadTokens: number(raw.cacheTokens) ?? number(raw.cacheReadTokens),
    cacheWriteTokens: number(raw.cachedWriteTokens), cacheMissTokens: number(raw.cachedMissTokens),
    thinkingTokens: number(raw.thinkingTokens), lastTokens: number(raw.lastTokens),
    modelCallCount: number(raw.modelCallCount), source: "STRUCTURED_REQUEST_USAGE", quality: complete ? "EXACT" : "PARTIAL" };
}
function fileMetrics(files: unknown[], requestId: string): FileDiffMetric[] {
  const byFile = new Map<string, FileDiffMetric>();
  const seen = new Set<string>();
  for (const fileValue of files) {
    const file = object(fileValue);
    const filePath = string(file?.filePath);
    if (!filePath || !Array.isArray(file?.versions)) continue;
    for (const versionValue of file.versions) {
      const version = object(versionValue);
      const meta = object(version?.metadata);
      if (meta?.requestId !== requestId) continue;
      const versionId = string(version?.versionId) ?? string(meta?.toolCallId);
      const unique = `${filePath}|${versionId ?? ""}`;
      if (seen.has(unique)) continue;
      seen.add(unique);
      const diff = object(version?.diff);
      if (!diff) continue;
      const extension = path.extname(filePath).replace(/^\./, "").toLowerCase();
      const category = categories[extension] ?? "OTHER";
      const metric = byFile.get(filePath) ?? { filePath, extension, category, linesAdded: 0, linesDeleted: 0,
        created: false, modified: false };
      metric.linesAdded += Math.max(0, number(diff.addedLines) ?? 0);
      metric.linesDeleted += Math.max(0, number(diff.removedLines) ?? 0);
      metric.created ||= /create|add|new/i.test(string(meta?.changeType) ?? "");
      metric.modified ||= !metric.created;
      byFile.set(filePath, metric);
    }
  }
  return [...byFile.values()];
}
const categories: Record<string, string> = { java: "JAVA", kt: "KOTLIN", js: "JAVASCRIPT", jsx: "JAVASCRIPT",
  ts: "TYPESCRIPT", tsx: "TYPESCRIPT", vue: "VUE", html: "HTML", css: "CSS", sql: "SQL", xml: "XML",
  yaml: "YAML", yml: "YAML", json: "JSON", py: "PYTHON", go: "GO", sh: "SHELL", md: "MARKDOWN" };
