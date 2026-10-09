import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import type * as vscode from "vscode";
import { TelemetryQueue, type SkillUsageMetadata } from "./TelemetryQueue";
import { GenerationStateStore } from "./generation/GenerationStateStore";
import { emptyGeneration, type GenerationState } from "./generation/GenerationState";
import { ProjectResolver } from "./project/ProjectResolver";

const gzipAsync = promisify(gzip);
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_REMEMBERED_CALLS = 2_000;

interface LogContext { conversationId?: string; workspace?: string; turnStartedAt?: string; turnInput?: string; generationId?: string; remainder: string; }
interface PersistedState { offsets: Record<string, number>; seenCallIds: string[]; }
interface PlatformMarker { source: "yantu-platform"; skillKey: string; skillVersionId?: number; installationId?: string; }

export interface LogMonitorOptions {
  homeDirectory?: string;
  appDataDirectory?: string;
  pollIntervalMs?: number;
  logRoots?: string[];
  queue?: TelemetryQueue;
  generationStore?: GenerationStateStore;
  now?: () => Date;
}

/** Watches CodeBuddy's own extension logs for use_skill calls; no Hook whitelist is required. */
export class CodeBuddyLogSkillMonitor implements vscode.Disposable {
  private readonly home: string;
  private readonly roots: string[];
  private readonly intervalMs: number;
  private readonly queue: TelemetryQueue;
  private readonly generationStore: GenerationStateStore;
  private readonly projectResolver: ProjectResolver;
  private readonly now: () => Date;
  private readonly stateFile: string;
  private readonly diagnosticFile: string;
  private readonly contexts = new Map<string, LogContext>();
  private readonly toolNames = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly captureTasks = new Set<Promise<void>>();
  private readonly generations = new Map<string, GenerationState>();
  private operationChain: Promise<void> = Promise.resolve();
  private clientInstallationId?: string;
  private offsets: Record<string, number> = {};
  private timer?: NodeJS.Timeout;
  private running = false;
  private initialized = false;

  constructor(
    private readonly logger: Pick<Console, "info" | "error"> = console,
    options: LogMonitorOptions = {},
  ) {
    this.home = options.homeDirectory ?? os.homedir();
    const appData = options.appDataDirectory ?? process.env.APPDATA ?? path.join(this.home, "AppData", "Roaming");
    this.roots = options.logRoots ?? ["Tkcoding", "CodeBuddy", "codebuddy"].map(name => path.join(appData, name, "logs"));
    this.intervalMs = options.pollIntervalMs ?? 1_000;
    this.queue = options.queue ?? new TelemetryQueue(this.home);
    this.generationStore = options.generationStore ?? new GenerationStateStore(this.home);
    this.projectResolver = new ProjectResolver(() => this.clientInstallationId);
    this.now = options.now ?? (() => new Date());
    const telemetryRoot = path.join(this.home, ".codebuddy", "yantu-assistant", "telemetry");
    this.stateFile = path.join(telemetryRoot, "codebuddy-log-monitor-state.json");
    this.diagnosticFile = path.join(telemetryRoot, "diagnostics", "codebuddy-log-monitor.jsonl");
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.initialized) await this.initialize();
      const files = await this.activeLogFiles();
      for (const file of files) await this.consumeFile(file);
      await Promise.all([...this.captureTasks]);
      await this.saveState();
    } catch (error) {
      this.logger.error(`CodeBuddy 日志采样失败：${error instanceof Error ? error.message : String(error)}`);
      await this.diagnostic("poll.error", { error: error instanceof Error ? error.message : String(error) });
    } finally { this.running = false; }
  }

  private async initialize(): Promise<void> {
    try {
      this.clientInstallationId = (await fs.readFile(path.join(this.home, ".codebuddy", "yantu-assistant", "client-installation-id"), "utf8")).trim() || undefined;
    } catch { /* installation id is best effort */ }
    const state = await this.readJson(this.stateFile) as PersistedState | undefined;
    this.offsets = state?.offsets ?? {};
    for (const callId of state?.seenCallIds ?? []) this.seen.add(callId);
    // New installations start at EOF and never backfill old conversations.
    for (const file of await this.activeLogFiles()) {
      if (!Number.isFinite(this.offsets[file])) this.offsets[file] = (await fs.stat(file)).size;
    }
    this.initialized = true;
    this.logger.info(`CodeBuddy 日志采样已启动，发现 ${Object.keys(this.offsets).length} 个日志文件`);
  }

  private async consumeFile(file: string): Promise<void> {
    const size = (await fs.stat(file)).size;
    let offset = Number.isFinite(this.offsets[file]) ? this.offsets[file]! : size;
    if (size < offset) { offset = 0; this.context(file).remainder = ""; }
    while (offset < size) {
      const end = Math.min(size, offset + MAX_CHUNK_BYTES);
      const chunk = await this.readRange(file, offset, end);
      this.consumeChunk(file, chunk);
      offset = end;
    }
    this.offsets[file] = offset;
  }

  private consumeChunk(file: string, chunk: string): void {
    const context = this.context(file);
    const lines = (context.remainder + chunk).split(/\r?\n/);
    context.remainder = lines.pop() ?? "";
    for (const line of lines) this.handleLine(file, line);
  }

  private handleLine(file: string, line: string): void {
    const context = this.context(file);
    let match = line.match(/CheckpointCoordinator\] initialize START: conversationId=([^,\s]+),\s*workspace=(.+)$/);
    if (match) {
      context.conversationId = match[1];
      context.workspace = match[2]?.trim();
      return;
    }
    match = line.match(/\[AgentReporter\] onAgentStart:\s*userInput=(.*?)\s+agent=\S+\s+mode=\S+\s+conversationId=([^\s]+)/);
    if (match) {
      const previousGenerationId = context.generationId;
      const endedAt = this.logTimestamp(line);
      if (previousGenerationId) this.schedule(() => this.completeGeneration(previousGenerationId, endedAt));
      context.turnStartedAt = endedAt;
      context.turnInput = match[1];
      context.conversationId = match[2];
      context.generationId = this.generationId(context.conversationId, context.turnStartedAt);
      return;
    }
    match = line.match(/tool-call-streaming-start\s+开始解析:\s*(\S+)\s+-\s+(\S+)/);
    if (match) { this.toolNames.set(match[1]!, match[2]!); return; }
    match = line.match(/onParameterStartParsing:\s*(\S+),\s*(\S+)/);
    if (match) { this.toolNames.set(match[1]!, match[2]!); return; }
    match = line.match(/参数解析完成:\s*(\S+)\s+-\s*参数:\s*command\s+-\s*值:\s*(\S+)/);
    if (!match || this.toolNames.get(match[1]!) !== "use_skill") return;
    const [callId, skillKey] = [match[1]!, match[2]!];
    if (this.seen.has(callId) || this.inFlight.has(callId)) return;
    this.inFlight.add(callId);
    this.schedule(() => this.capture(file, line, callId, skillKey, { ...context }), callId);
  }

  private async capture(file: string, line: string, callId: string, skillKey: string, context: LogContext): Promise<void> {
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillKey)) return;
      const resolved = await this.resolveMarker(skillKey, context.workspace);
      if (!resolved) {
        await this.diagnostic("skip.non-platform-skill", { callId, skillKey, workspace: context.workspace, sourceLog: file });
        return;
      }
      const eventId = randomUUID();
      const invokedAt = this.logTimestamp(line);
      const generationId = context.generationId ?? this.generationId(context.conversationId || "UNKNOWN", context.turnStartedAt || invokedAt);
      const conversationFile = context.turnInput ? await this.writeBestEffortConversation(eventId, context, invokedAt) : undefined;
      const metadata: SkillUsageMetadata = {
        eventId,
        skillKey,
        skillVersionId: this.number(resolved.marker.skillVersionId),
        installationId: this.string(resolved.marker.installationId),
        invokedAt,
        localDirectory: this.normalizeWorkspace(context.workspace) || "UNKNOWN",
        clientSessionId: context.conversationId || "UNKNOWN",
        generationId,
        client: "CodeBuddyIDE",
        conversationFile,
      };
      await this.queue.enqueue(metadata);
      await this.updateGeneration(generationId, context, skillKey, this.number(resolved.marker.skillVersionId), invokedAt);
      // Persist deduplication only after the required event is safely queued.
      this.remember(callId);
      await this.diagnostic("captured", { eventId, callId, skillKey, scope: resolved.scope, localDirectory: metadata.localDirectory });
      this.logger.info(`已采集平台 Skill 调用：${skillKey}（${resolved.scope}）`);
    } catch (error) {
      await this.diagnostic("capture.error", { callId, skillKey, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private schedule(operation: () => Promise<void>, callId?: string): void {
    const task = this.operationChain.then(operation).finally(() => {
      if (callId) this.inFlight.delete(callId);
      this.captureTasks.delete(task);
    });
    this.operationChain = task.catch(() => undefined);
    this.captureTasks.add(task);
  }

  private async updateGeneration(generationId: string, context: LogContext, skillKey: string,
      skillVersionId: number | undefined, invokedAt: string): Promise<void> {
    let state = this.generations.get(generationId) ?? await this.generationStore.load(generationId);
    if (!state) {
      state = emptyGeneration(generationId, context.conversationId || "UNKNOWN", context.turnStartedAt || invokedAt);
      state.status = "PARTIAL";
      state.clientInstallationId = this.clientInstallationId;
      state.cwd = this.normalizeWorkspace(context.workspace) || undefined;
      if (state.cwd && state.cwd !== path.parse(state.cwd).root) {
        const project = await this.projectResolver.resolve(state.cwd);
        state.projectKey = project.projectKey;
        state.projectName = project.projectName;
        state.projectSource = project.projectSource;
      }
    }
    if (!state.skillInvocations.some(item => item.skillKey === skillKey)) {
      state.skillInvocations.push({ skillKey, skillVersionId, invokedAt });
    }
    state.toolCallCount += 1;
    state.status = "PARTIAL";
    this.generations.set(generationId, state);
    await this.generationStore.save(state);
  }

  private async completeGeneration(generationId: string, endedAt: string): Promise<void> {
    const state = this.generations.get(generationId) ?? await this.generationStore.load(generationId);
    if (!state || state.skillInvocations.length === 0) return;
    state.status = "COMPLETED";
    state.endedAt = endedAt;
    state.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(state.startedAt));
    this.generations.set(generationId, state);
    await this.generationStore.save(state);
  }

  private generationId(conversationId: string, startedAt: string): string {
    return `log-${createHash("sha256").update(`${conversationId}\n${startedAt}`).digest("hex")}`;
  }

  private async resolveMarker(skillKey: string, workspace?: string): Promise<{ marker: PlatformMarker; scope: "project" | "global" } | undefined> {
    const normalizedWorkspace = this.normalizeWorkspace(workspace);
    const candidates: Array<{ file: string; scope: "project" | "global" }> = [];
    if (normalizedWorkspace && normalizedWorkspace !== path.parse(normalizedWorkspace).root) {
      candidates.push({ file: path.join(normalizedWorkspace, ".codebuddy", "skills", skillKey, ".yantu-platform-skill.json"), scope: "project" });
    }
    candidates.push({ file: path.join(this.home, ".codebuddy", "skills", skillKey, ".yantu-platform-skill.json"), scope: "global" });
    for (const candidate of candidates) {
      const marker = await this.readJson(candidate.file) as PlatformMarker | undefined;
      if (marker?.source === "yantu-platform" && marker.skillKey === skillKey) return { marker, scope: candidate.scope };
    }
    return undefined;
  }

  private async writeBestEffortConversation(eventId: string, context: LogContext, capturedAt: string): Promise<string | undefined> {
    try {
      const directory = this.queue.conversationDirectory;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = path.join(directory, `${eventId}.json.gz`);
      const body = {
        schemaVersion: 1,
        clientSessionId: context.conversationId || "UNKNOWN",
        capturedAt,
        partial: true,
        messages: [{ role: "user", content: context.turnInput, createdAt: context.turnStartedAt }],
      };
      await fs.writeFile(target, await gzipAsync(Buffer.from(JSON.stringify(body))), { flag: "wx", mode: 0o600 });
      return target;
    } catch { return undefined; }
  }

  private async activeLogFiles(): Promise<string[]> {
    const result: string[] = [];
    for (const root of this.roots) {
      let sessions: string[];
      try { sessions = (await fs.readdir(root)).sort().slice(-3); } catch { continue; }
      for (const session of sessions) {
        const sessionRoot = path.join(root, session);
        let windows: string[];
        try { windows = await fs.readdir(sessionRoot); } catch { continue; }
        for (const windowName of windows.filter(name => /^window\d+$/i.test(name))) {
          const extensionHost = path.join(sessionRoot, windowName, "exthost");
          let extensions: string[];
          try { extensions = await fs.readdir(extensionHost); } catch { continue; }
          for (const extensionName of extensions.filter(name => /(coding-copilot|codebuddy|tkcoding)/i.test(name))) {
            const directory = path.join(extensionHost, extensionName);
            let names: string[];
            try { names = await fs.readdir(directory); } catch { continue; }
            result.push(...names.filter(name => /\.log$/i.test(name)).map(name => path.join(directory, name)));
          }
        }
      }
    }
    return [...new Set(result)];
  }

  private context(file: string): LogContext {
    let context = this.contexts.get(file);
    if (!context) { context = { remainder: "" }; this.contexts.set(file, context); }
    return context;
  }

  private remember(callId: string): void {
    this.seen.add(callId);
    while (this.seen.size > MAX_REMEMBERED_CALLS) this.seen.delete(this.seen.values().next().value!);
  }

  private logTimestamp(line: string): string {
    const match = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,3}))?/);
    if (!match) return this.now().toISOString();
    const local = new Date(`${match[1]}T${match[2]}.${(match[3] || "000").padEnd(3, "0")}`);
    return Number.isNaN(local.getTime()) ? this.now().toISOString() : local.toISOString();
  }

  private normalizeWorkspace(value?: string): string {
    if (!value || value === "/") return value || "";
    let normalized = value.trim().replace(/^file:\/\//i, "");
    try { normalized = decodeURIComponent(normalized); } catch { /* retain raw path */ }
    if (process.platform === "win32") normalized = normalized.replace(/^\/(\w:)/, "$1").replace(/\//g, "\\");
    return path.normalize(normalized);
  }

  private async readRange(file: string, start: number, end: number): Promise<string> {
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
  }

  private async saveState(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ offsets: this.offsets, seenCallIds: [...this.seen] }), { mode: 0o600 });
    await fs.rename(temporary, this.stateFile);
  }

  private async diagnostic(event: string, fields: Record<string, unknown>): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.diagnosticFile), { recursive: true, mode: 0o700 });
      await fs.appendFile(this.diagnosticFile, JSON.stringify({ timestamp: this.now().toISOString(), event, ...fields }) + "\n", { mode: 0o600 });
    } catch { /* diagnostics never block sampling */ }
  }

  private async readJson(file: string): Promise<unknown> { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return undefined; } }
  private string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
  private number(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
}
