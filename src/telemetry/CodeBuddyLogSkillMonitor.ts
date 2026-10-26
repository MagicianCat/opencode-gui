import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import type * as vscode from "vscode";
import { TelemetryQueue, type SkillUsageMetadata } from "./TelemetryQueue";
import { GenerationStateStore } from "./generation/GenerationStateStore";
import { emptyGeneration, type FileDiffMetric, type GenerationState, type GenerationTokenUsage } from "./generation/GenerationState";
import { ProjectResolver } from "./project/ProjectResolver";
import { CodeBuddyStructuredSessionScanner, type StructuredTurn } from "./structured/CodeBuddyStructuredSessionScanner";

const gzipAsync = promisify(gzip);
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_REMEMBERED_CALLS = 2_000;
const MAX_TURN_ITEMS = 10_000;
const MAX_CHANGE_FILE_BYTES = 1024 * 1024;

interface StepUsage extends GenerationTokenUsage { step: number; }
interface PlatformSkillInvocation { skillKey: string; skillVersionId?: number; invokedAt: string; toolCallId: string; }
interface TurnRuntime {
  requestId: string;
  conversationId: string;
  generationId: string;
  startedAt: string;
  input?: string;
  workspace?: string;
  modelId?: string;
  modelName?: string;
  modelSteps: Set<number>;
  stepUsages: Map<number, StepUsage>;
  toolCallIds: Set<string>;
  toolFailureIds: Set<string>;
  platformSkills: Map<string, PlatformSkillInvocation>;
  cancelled: boolean;
  endedAt?: string;
  status?: GenerationState["status"];
  exactUsage?: GenerationTokenUsage;
  fileDiffs?: FileDiffMetric[];
}
interface LogContext { conversationId?: string; workspace?: string; currentTurn?: TurnRuntime;
  pendingModel?: { id?: string; name?: string }; turns: Map<string, TurnRuntime>; remainder: string; }
interface PersistedState { offsets: Record<string, number>; seenCallIds: string[]; }
interface PlatformMarker { source: "yantu-platform"; skillKey: string; skillVersionId?: number; installationId?: string; }

export interface LogMonitorOptions {
  homeDirectory?: string;
  appDataDirectory?: string;
  pollIntervalMs?: number;
  logRoots?: string[];
  queue?: TelemetryQueue;
  generationStore?: GenerationStateStore;
  changesRoot?: string;
  localAppDataDirectory?: string;
  extensionLogRoot?: string;
  activeWorkspaceDirectory?: string;
  structuredScanner?: CodeBuddyStructuredSessionScanner;
  structuredPollIntervalMs?: number;
  structuredEnabled?: boolean;
  now?: () => Date;
}

/** Watches CodeBuddy's own extension logs for use_skill calls; no Hook whitelist is required. */
export class CodeBuddyLogSkillMonitor implements vscode.Disposable {
  private readonly home: string;
  private readonly roots: string[];
  private readonly intervalMs: number;
  private readonly queue: TelemetryQueue;
  private readonly generationStore: GenerationStateStore;
  private readonly structuredScanner: CodeBuddyStructuredSessionScanner;
  private readonly structuredPollIntervalMs: number;
  private readonly structuredEnabled: boolean;
  private readonly extensionLogRoot: string;
  private readonly activeWorkspaceDirectory?: string;
  private readonly projectResolver: ProjectResolver;
  private readonly changesRoots: string[];
  private readonly now: () => Date;
  private readonly stateFile: string;
  private readonly diagnosticFile: string;
  private readonly contexts = new Map<string, LogContext>();
  private readonly toolNames = new Map<string, string>();
  private readonly historicalEventIds = new Map<string, string>();
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
  private lastStructuredPollAt = 0;

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
    this.structuredScanner = options.structuredScanner ?? new CodeBuddyStructuredSessionScanner({
      homeDirectory: this.home, localAppDataDirectory: options.localAppDataDirectory, now: options.now });
    this.structuredPollIntervalMs = options.structuredPollIntervalMs ?? 5_000;
    this.structuredEnabled = options.structuredEnabled ?? true;
    this.extensionLogRoot = options.extensionLogRoot ?? path.join(options.localAppDataDirectory ?? process.env.LOCALAPPDATA ??
      path.join(this.home, "AppData", "Local"), "CodeBuddyExtension", "Logs", "CodeBuddyIDE");
    this.activeWorkspaceDirectory = options.activeWorkspaceDirectory;
    this.projectResolver = new ProjectResolver(() => this.clientInstallationId);
    this.changesRoots = options.changesRoot
      ? [options.changesRoot]
      : ["Tkcoding", "CodeBuddy", "codebuddy"].map(name => path.join(appData, name, "User", "globalStorage", "tencent-cloud.coding-copilot", "file-changes"));
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
      if (!this.clientInstallationId) {
        try { this.clientInstallationId = (await fs.readFile(path.join(this.home, ".codebuddy", "yantu-assistant", "client-installation-id"), "utf8")).trim() || undefined; }
        catch { /* created asynchronously on first activation */ }
      }
      const files = await this.activeLogFiles();
      for (const file of files) await this.consumeFile(file);
      await Promise.all([...this.captureTasks]);
      if (this.structuredEnabled && Date.now() - this.lastStructuredPollAt >= this.structuredPollIntervalMs) {
        for (const turn of await this.structuredScanner.scan()) await this.applyStructured(turn);
        await this.structuredScanner.commit();
        this.lastStructuredPollAt = Date.now();
      }
      await this.saveState();
    } catch (error) {
      this.logger.error(`CodeBuddy 遥测采样失败：${error instanceof Error ? error.message : String(error)}`);
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
    try {
      const size = (await fs.stat(this.diagnosticFile)).size;
      const text = await this.readRange(this.diagnosticFile, Math.max(0, size - 8 * 1024 * 1024), size);
      for (const line of text.split("\n")) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.event === "captured" && typeof entry.callId === "string" && typeof entry.eventId === "string")
            this.historicalEventIds.set(entry.callId, entry.eventId);
        } catch { /* skip a partial or malformed diagnostic line */ }
      }
    } catch { /* first run */ }
    // Realtime logs start at EOF; the structured scanner backfills recent requests.
    for (const file of await this.activeLogFiles()) {
      if (!Number.isFinite(this.offsets[file])) this.offsets[file] = (await fs.stat(file)).size;
      if (file.startsWith(this.extensionLogRoot)) {
        const head = await this.readRange(file, 0, Math.min((await fs.stat(file)).size, 1024));
        const workspace = head.match(/(?:^|\n)Workspace Path:\s*([^\r\n]+)/)?.[1];
        if (workspace) this.context(file).workspace = workspace.trim();
      }
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
    const modelLine = line.match(/\[CraftInvokableAgent\].*?model:\s*(\{.*\})/);
    if (modelLine) {
      try {
        const model = JSON.parse(modelLine[1]!) as Record<string, unknown>;
        context.pendingModel = { id: this.string(model.id), name: this.string(model.name) };
      } catch { /* malformed model line */ }
      return;
    }
    let match = line.match(/CheckpointCoordinator\] initialize START: conversationId=([^,\s]+),\s*workspace=(.+)$/);
    if (match) {
      context.conversationId = match[1];
      context.workspace = match[2]?.trim();
      if (context.currentTurn?.conversationId === match[1]) context.currentTurn.workspace = context.workspace;
      return;
    }
    match = line.match(/\[AgentReporter\] onAgentStart:\s*userInput=(.*?)\s+agent=\S+\s+mode=\S+\s+conversationId=(\S+)(?:\s+requestId=(\S+))?/);
    if (match) {
      const startedAt = this.logTimestamp(line);
      context.conversationId = match[2];
      const requestId = match[3] || createHash("sha256").update(`${match[2]}\n${startedAt}`).digest("hex");
      context.currentTurn = {
        requestId,
        conversationId: match[2]!,
        generationId: this.generationId(requestId),
        startedAt,
        input: match[1],
        workspace: context.workspace,
        modelId: context.pendingModel?.id,
        modelName: context.pendingModel?.name,
        modelSteps: new Set(),
        stepUsages: new Map(),
        toolCallIds: new Set(),
        toolFailureIds: new Set(),
        platformSkills: new Map(),
        cancelled: false,
      };
      const turn = context.currentTurn;
      context.turns.set(requestId, turn);
      context.pendingModel = undefined;
      this.schedule(() => this.persistRuntime(turn));
      return;
    }
    match = line.match(/tool-call-streaming-start\s+开始解析:\s*(\S+)\s+-\s+(\S+)/);
    if (match) {
      const [callId, toolName] = [match[1]!, match[2]!];
      this.toolNames.set(callId, toolName);
      while (this.toolNames.size > MAX_REMEMBERED_CALLS) this.toolNames.delete(this.toolNames.keys().next().value!);
      if (context.currentTurn && [...context.turns.values()].filter(turn => !turn.endedAt).length === 1 &&
          context.currentTurn.toolCallIds.size < MAX_TURN_ITEMS && !context.currentTurn.toolCallIds.has(callId)) {
        const turn = context.currentTurn;
        turn.toolCallIds.add(callId);
        this.schedule(() => this.persistRuntime(turn));
      }
      return;
    }
    match = line.match(/onParameterStartParsing:\s*(\S+),\s*(\S+)/);
    if (match) {
      this.toolNames.set(match[1]!, match[2]!);
      while (this.toolNames.size > MAX_REMEMBERED_CALLS) this.toolNames.delete(this.toolNames.keys().next().value!);
      return;
    }

    match = line.match(/notifyStepStart,\s*step:\s*(\d+),\s*requestId:\s*([^,\s]+)/);
    if (match && context.turns.has(match[2]!)) {
      const turn = context.turns.get(match[2]!)!;
      if (turn.modelSteps.size < MAX_TURN_ITEMS) turn.modelSteps.add(Number(match[1]));
      this.schedule(() => this.persistRuntime(turn));
      return;
    }
    match = line.match(/notifyStepEnd,\s*step:\s*(\d+),\s*requestId:\s*([^,\s]+).*?usage:\s*(\{.*\})(?:,\s*isMaxTokenLimit|$)/);
    if (match && context.turns.has(match[2]!)) {
      const turn = context.turns.get(match[2]!)!;
      const usage = this.parseUsage(match[3], "PARTIAL", turn.modelSteps.size);
      if (usage && turn.stepUsages.size < MAX_TURN_ITEMS) turn.stepUsages.set(Number(match[1]), { ...usage, step: Number(match[1]) });
      this.schedule(() => this.persistRuntime(turn));
      return;
    }

    match = line.match(/\[Tool:[^\]]+\]\s+\[(\S+)\].*\[fullExecute\]\s+error(?:,|\s|$)/i);
    if (match && context.currentTurn) {
      const turn = context.currentTurn;
      if (turn.toolCallIds.size < MAX_TURN_ITEMS) turn.toolCallIds.add(match[1]!);
      if (turn.toolFailureIds.size < MAX_TURN_ITEMS) turn.toolFailureIds.add(match[1]!);
      this.schedule(() => this.persistRuntime(turn));
      return;
    }
    if (/notifyAgentCancel|Agent canceled by error|cancelled by abort|AgentState\.cancelled/i.test(line)) {
      if (context.currentTurn) context.currentTurn.cancelled = true;
      return;
    }

    match = line.match(/\[AgentReporter\]\s+onAgentEnd:.*conversationId=(\S+)\s+requestId=(\S+)\s+error=(true|false)/);
    if (match && context.turns.has(match[2]!)) {
      const turn = context.turns.get(match[2]!)!;
      turn.endedAt = this.logTimestamp(line);
      turn.status = match[3] === "false" ? "COMPLETED" : turn.cancelled ? "CANCELLED" : "FAILED";
      this.schedule(() => this.finalizeRuntime(turn));
      return;
    }
    match = line.match(/Agent execution successful with usage:\s*(\{.*\})/);
    if (match && context.currentTurn) {
      const turn = context.currentTurn;
      const usage = this.parseUsage(match[1], "EXACT", turn.modelSteps.size);
      if (usage) turn.exactUsage = usage;
      this.schedule(() => this.persistRuntime(turn));
      return;
    }

    match = line.match(/参数解析完成:\s*(\S+)\s+-\s*参数:\s*command\s+-\s*值:\s*(\S+)/);
    if (!match) return;
    const toolName = this.toolNames.get(match[1]!);
    this.toolNames.delete(match[1]!);
    if (toolName !== "use_skill") return;
    const [callId, skillKey] = [match[1]!, match[2]!];
    const active = [...context.turns.values()].filter(turn => !turn.endedAt);
    if (active.length !== 1) return; // ambiguous log association; structured messages can resolve it
    const eventId = this.stableEventId(active[0]!.conversationId, active[0]!.requestId, callId);
    if (this.seen.has(eventId) || this.seen.has(callId) || this.inFlight.has(eventId)) return;
    this.inFlight.add(eventId);
    this.schedule(() => this.capture(file, line, callId, skillKey, active[0], context.workspace), eventId);
  }

  private async capture(file: string, line: string, callId: string, skillKey: string,
      runtime: TurnRuntime | undefined, workspace?: string): Promise<void> {
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillKey)) return;
      const resolved = await this.resolveMarker(skillKey, workspace);
      if (!resolved) {
        await this.diagnostic("skip.non-platform-skill", { callId, skillKey, workspace, sourceLog: file });
        return;
      }
      const invokedAt = this.logTimestamp(line);
      const turn = runtime ?? this.syntheticRuntime(invokedAt, workspace);
      const eventId = this.stableEventId(turn.conversationId, turn.requestId, callId);
      if (turn.toolCallIds.size < MAX_TURN_ITEMS) turn.toolCallIds.add(callId);
      const conversationFile = turn.input ? await this.writeBestEffortConversation(eventId, turn, invokedAt) : undefined;
      const metadata: SkillUsageMetadata = {
        eventId,
        skillKey,
        skillVersionId: this.number(resolved.marker.skillVersionId),
        installationId: this.string(resolved.marker.installationId),
        invokedAt,
        localDirectory: this.normalizeWorkspace(workspace) || "UNKNOWN",
        clientSessionId: turn.conversationId,
        generationId: turn.generationId,
        client: "CodeBuddyIDE",
        model: turn.modelName,
        conversationFile,
      };
      await this.queue.enqueue(metadata);
      turn.platformSkills.set(callId, { skillKey, skillVersionId: this.number(resolved.marker.skillVersionId), invokedAt, toolCallId: callId });
      await this.persistRuntime(turn);
      // Persist deduplication only after the required event is safely queued.
      this.remember(eventId);
      this.historicalEventIds.set(callId, eventId);
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

  private async persistRuntime(runtime: TurnRuntime): Promise<void> {
    let state = this.generations.get(runtime.generationId) ?? await this.generationStore.load(runtime.generationId);
    if (!state) {
      state = emptyGeneration(runtime.generationId, runtime.conversationId, runtime.startedAt);
      state.clientInstallationId = this.clientInstallationId;
      state.cwd = this.normalizeWorkspace(runtime.workspace) || undefined;
      if (state.cwd && state.cwd !== path.parse(state.cwd).root) {
        const project = await this.projectResolver.resolve(state.cwd);
        state.projectKey = project.projectKey;
        state.projectName = project.projectName;
        state.projectSource = project.projectSource;
      }
    }
    const invocations = new Map(state.skillInvocations.map(call => [call.toolCallId ?? call.skillKey, call]));
    for (const call of runtime.platformSkills.values()) invocations.set(call.toolCallId, call);
    state.skillInvocations = [...invocations.values()];
    state.sourcesSeen = [...new Set([...(state.sourcesSeen ?? []), "LOG_EXTHOST" as const])];
    if (!state.modelId && runtime.modelId) state.modelId = runtime.modelId;
    if (!state.modelName && runtime.modelName) state.modelName = runtime.modelName;
    state.toolCallCount = Math.max(state.toolCallCount, runtime.toolCallIds.size);
    state.toolFailureCount = Math.max(state.toolFailureCount, runtime.toolFailureIds.size);
    if (state.structuredComplete && runtime.exactUsage) {
      if (state.usage?.quality === "EXACT" && this.usageMismatch(state.usage, runtime.exactUsage))
        state.tokenMismatch = true;
      if (state.usage?.quality !== "EXACT") state.usage = runtime.exactUsage;
    }
    if (!state.structuredComplete) {
      state.usage = runtime.exactUsage ?? this.aggregatePartialUsage(runtime) ?? state.usage;
      state.status = runtime.status ?? state.status;
      state.endedAt = runtime.endedAt ?? state.endedAt;
      state.durationMs = state.endedAt ? Math.max(0, Date.parse(state.endedAt) - Date.parse(state.startedAt)) : undefined;
      if (runtime.endedAt) state.durationSource = "LOG_END";
      state.captureQuality = runtime.exactUsage ? "LOG_FINAL" : "LOG_PARTIAL";
    }
    if (runtime.fileDiffs?.length && state.codeSource !== "FILE_TREE_REQUEST_DIFF") {
      state.fileDiffs = runtime.fileDiffs;
      state.codeSource = "ROAMING_FILE_CHANGES_TIME_WINDOW";
    }
    this.generations.set(runtime.generationId, state);
    await this.generationStore.save(state);
  }

  private async finalizeRuntime(runtime: TurnRuntime): Promise<void> {
    runtime.fileDiffs = await this.collectFileChanges(runtime);
    await this.persistRuntime(runtime);
  }

  private stableEventId(conversationId: string, requestId: string, callId: string): string {
    const bytes = Buffer.from(createHash("sha256").update(`CodeBuddyIDE|${conversationId}|${requestId}|${callId}`).digest().subarray(0, 16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x50;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private async applyStructured(turn: StructuredTurn): Promise<void> {
    const generationId = this.generationId(turn.requestId);
    const runtime = [...this.contexts.values()].flatMap(context => [...context.turns.values()])
      .find(item => item.requestId === turn.requestId && item.conversationId === turn.conversationId);
    let state = this.generations.get(generationId) ?? await this.generationStore.load(generationId);
    const workspace = turn.workspace ?? [runtime?.workspace, state?.cwd, this.activeWorkspaceDirectory]
      .find(candidate => candidate && this.matchesWorkspaceHash(candidate, turn.workspaceHash));
    if (!state) {
      state = emptyGeneration(generationId, turn.conversationId, turn.startedAt);
      state.clientInstallationId = this.clientInstallationId;
    }
    state.startedAt = turn.startedAt;
    const normalized = this.normalizeWorkspace(workspace);
    if (normalized && normalized !== path.parse(normalized).root && state.cwd !== normalized) {
      state.cwd = normalized;
      const project = await this.projectResolver.resolve(normalized);
      state.projectKey = project.projectKey;
      state.projectName = project.projectName;
      state.projectSource = project.projectSource;
    }
    if (turn.modelId) state.modelId = turn.modelId;
    if (turn.modelName) state.modelName = turn.modelName;
    state.sourcesSeen = [...new Set([...(state.sourcesSeen ?? []), "STRUCTURED" as const])];
    state.toolCallCount = Math.max(state.toolCallCount, turn.toolCallCount);
    if (turn.usage) {
      if (turn.usage.quality === "EXACT" && state.captureQuality === "LOG_FINAL" &&
          this.usageMismatch(state.usage, turn.usage))
        state.tokenMismatch = true;
      if (turn.usage.quality === "EXACT" || state.usage?.quality !== "EXACT")
        state.usage = { ...state.usage, ...turn.usage, modelCallCount: turn.usage.modelCallCount ?? state.usage?.modelCallCount };
    }
    if (turn.fileDiffs !== undefined) {
      state.fileDiffs = turn.fileDiffs;
      state.codeSource = "FILE_TREE_REQUEST_DIFF";
    }
    if (turn.status !== "RUNNING") {
      state.status = runtime?.status === "FAILED" || runtime?.status === "CANCELLED" ? runtime.status : turn.status;
      state.structuredComplete = true;
      state.captureQuality = "STRUCTURED";
      state.endedAt = runtime?.endedAt ?? turn.endedAt;
      state.durationMs = state.endedAt ? Math.max(0, Date.parse(state.endedAt) - Date.parse(state.startedAt)) : undefined;
      state.durationSource = runtime?.endedAt ? "LOG_END" : turn.endedAt ? "MESSAGE_ESTIMATED" : undefined;
      if (state.ingestLagMs === undefined && state.endedAt)
        state.ingestLagMs = Math.max(0, Date.now() - Date.parse(state.endedAt));
    }
    const invocations = new Map(state.skillInvocations.map(call => [call.toolCallId ?? call.skillKey, call]));
    let conversationWritten = false;
    for (const call of turn.skillCalls) {
      const resolved = await this.resolveMarker(call.skillKey, workspace);
      if (!resolved) continue;
      const eventId = this.historicalEventIds.get(call.toolCallId) ??
        this.stableEventId(turn.conversationId, turn.requestId, call.toolCallId);
      const skipLegacyEvent = this.seen.has(call.toolCallId) && !this.historicalEventIds.has(call.toolCallId);
      const conversationFile = !skipLegacyEvent && !conversationWritten && turn.conversationMessages.length
        ? await this.writeStructuredConversation(eventId, turn, call.invokedAt) : undefined;
      if (conversationFile) conversationWritten = true;
      if (!skipLegacyEvent) {
        await this.queue.enqueue({ eventId, skillKey: call.skillKey,
          skillVersionId: this.number(resolved.marker.skillVersionId), installationId: this.string(resolved.marker.installationId),
          invokedAt: call.invokedAt, localDirectory: normalized || "UNKNOWN", clientSessionId: turn.conversationId,
          generationId, client: "CodeBuddyIDE", model: turn.modelName ?? turn.modelId, conversationFile });
      }
      invocations.set(call.toolCallId, { skillKey: call.skillKey, skillVersionId: this.number(resolved.marker.skillVersionId),
        invokedAt: call.invokedAt, toolCallId: call.toolCallId });
      this.remember(eventId);
    }
    state.skillInvocations = [...invocations.values()];
    this.generations.set(generationId, state);
    await this.generationStore.save(state);
  }

  private generationId(requestId: string): string {
    return `log-${requestId}`;
  }

  private usageMismatch(a?: GenerationTokenUsage, b?: GenerationTokenUsage): boolean {
    if (!a || !b) return false;
    return (["inputTokens", "outputTokens", "totalTokens"] as const).some(metric =>
      a[metric] !== undefined && b[metric] !== undefined && a[metric] !== b[metric]);
  }

  private matchesWorkspaceHash(workspace: string, expected: string): boolean {
    const windowsPath = workspace.replace(/\//g, "\\").replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
    return createHash("md5").update(windowsPath).digest("hex") === expected;
  }

  private syntheticRuntime(invokedAt: string, workspace?: string): TurnRuntime {
    const requestId = createHash("sha256").update(`UNKNOWN\n${invokedAt}`).digest("hex");
    return {
      requestId, conversationId: "UNKNOWN", generationId: this.generationId(requestId), startedAt: invokedAt, workspace,
      modelSteps: new Set(), stepUsages: new Map(), toolCallIds: new Set(), toolFailureIds: new Set(),
      platformSkills: new Map(), cancelled: false,
    };
  }

  private parseUsage(raw: string | undefined, quality: "EXACT" | "PARTIAL", modelCallCount: number): GenerationTokenUsage | undefined {
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      return {
        inputTokens: this.number(value.inputTokens),
        outputTokens: this.number(value.outputTokens),
        totalTokens: this.number(value.totalTokens),
        cacheReadTokens: this.number(value.cacheTokens),
        cacheWriteTokens: this.number(value.cachedWriteTokens),
        cacheMissTokens: this.number(value.cachedMissTokens),
        thinkingTokens: this.number(value.thinkingTokens),
        lastTokens: this.number(value.lastTokens),
        modelCallCount,
        source: quality === "EXACT" ? "LOG_FINAL_USAGE" : "LOG_STEP_PARTIAL",
        quality,
      };
    } catch { return undefined; }
  }

  private aggregatePartialUsage(runtime: TurnRuntime): GenerationTokenUsage | undefined {
    const usages = [...runtime.stepUsages.values()];
    if (usages.length === 0 && runtime.modelSteps.size === 0) return undefined;
    const sum = (field: keyof GenerationTokenUsage): number => usages.reduce((total, usage) => {
      const value = usage[field];
      return total + (typeof value === "number" ? value : 0);
    }, 0);
    const last = usages.sort((a, b) => a.step - b.step).at(-1);
    return {
      inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens"),
      cacheReadTokens: sum("cacheReadTokens"), cacheWriteTokens: sum("cacheWriteTokens"),
      cacheMissTokens: sum("cacheMissTokens"), thinkingTokens: sum("thinkingTokens"),
      modelCallCount: runtime.modelSteps.size, lastTokens: last?.lastTokens,
      source: "LOG_STEP_PARTIAL", quality: "PARTIAL",
    };
  }

  private async collectFileChanges(runtime: TurnRuntime): Promise<FileDiffMetric[]> {
    if (!runtime.endedAt || !/^[A-Za-z0-9_-]{1,256}$/.test(runtime.conversationId)) return [];
    const startedAt = Date.parse(runtime.startedAt);
    const endedAt = Date.parse(runtime.endedAt);
    const byFile = new Map<string, FileDiffMetric>();
    for (const root of this.changesRoots) {
      const directory = path.join(root, runtime.conversationId);
      let names: string[];
      try { names = (await fs.readdir(directory)).slice(0, MAX_TURN_ITEMS); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const value = await this.readSmallJson(path.join(directory, name));
        if (!value) continue;
        const timestamp = this.changeTimestamp(value.timestamp);
        if (timestamp === undefined || timestamp < startedAt || timestamp > endedAt) continue;
        const filePath = this.string(value.filePath) ?? this.string(value.fileName);
        if (!filePath || filePath.length > 4096) continue;
        const existing = byFile.get(filePath) ?? this.emptyFileMetric(filePath);
        existing.linesAdded += this.nonNegative(value.addedLines);
        existing.linesDeleted += this.nonNegative(value.removedLines);
        const changeType = String(value.changeType ?? "").toLowerCase();
        existing.created ||= /create|add|new/.test(changeType);
        existing.modified ||= !existing.created || /modify|edit|update/.test(changeType);
        byFile.set(filePath, existing);
      }
    }
    return [...byFile.values()];
  }

  private emptyFileMetric(filePath: string): FileDiffMetric {
    const extension = path.extname(filePath).replace(/^\./, "").toLowerCase();
    const categories: Record<string, string> = {
      java: "JAVA", kt: "KOTLIN", kts: "KOTLIN", js: "JAVASCRIPT", jsx: "JAVASCRIPT", mjs: "JAVASCRIPT",
      ts: "TYPESCRIPT", tsx: "TYPESCRIPT", vue: "VUE", html: "HTML", css: "CSS", scss: "CSS", less: "CSS",
      sql: "SQL", xml: "XML", yaml: "YAML", yml: "YAML", json: "JSON", py: "PYTHON", go: "GO",
      sh: "SHELL", bash: "SHELL", md: "MARKDOWN", properties: "CONFIG", ini: "CONFIG", toml: "CONFIG",
    };
    return { filePath, extension, category: categories[extension] ?? "OTHER", linesAdded: 0, linesDeleted: 0, created: false, modified: false };
  }

  private changeTimestamp(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private nonNegative(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  private async readSmallJson(file: string): Promise<Record<string, unknown> | undefined> {
    try {
      if ((await fs.stat(file)).size > MAX_CHANGE_FILE_BYTES) return undefined;
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch { return undefined; }
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

  private async writeBestEffortConversation(eventId: string, runtime: TurnRuntime, capturedAt: string): Promise<string | undefined> {
    try {
      const directory = this.queue.conversationDirectory;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = path.join(directory, `${eventId}.json.gz`);
      const body = {
        schemaVersion: 1,
        clientSessionId: runtime.conversationId,
        capturedAt,
        partial: true,
        messages: [{ id: `${runtime.requestId}-user`, role: "user", content: runtime.input, createdAt: runtime.startedAt }],
      };
      await fs.writeFile(target, await gzipAsync(Buffer.from(JSON.stringify(body))), { flag: "wx", mode: 0o600 });
      return target;
    } catch { return undefined; }
  }

  private async writeStructuredConversation(eventId: string, turn: StructuredTurn, capturedAt: string): Promise<string | undefined> {
    try {
      const messages = turn.conversationMessages.filter(message => message.createdAt <= capturedAt);
      if (messages.length === 0) return undefined;
      await fs.mkdir(this.queue.conversationDirectory, { recursive: true, mode: 0o700 });
      const body = { schemaVersion: 1, clientSessionId: turn.conversationId, capturedAt, partial: false, messages };
      const zipped = await gzipAsync(Buffer.from(JSON.stringify(body)));
      const digest = createHash("sha256").update(zipped).digest("hex").slice(0, 16);
      const target = path.join(this.queue.conversationDirectory, `${eventId}-${digest}.json.gz`);
      await fs.writeFile(target, zipped, { mode: 0o600 });
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
    const recent = (await Promise.all([...new Set(result)].map(async file => ({ file,
      mtimeMs: (await fs.stat(file).catch(() => undefined))?.mtimeMs ?? 0 }))))
      .filter(item => this.now().getTime() - item.mtimeMs < 24 * 60 * 60 * 1000).map(item => item.file);
    if (recent.length) return recent;
    const fallback: string[] = [];
    for (const day of (await fs.readdir(this.extensionLogRoot).catch(() => [] as string[])).sort().slice(-2)) {
      const directory = path.join(this.extensionLogRoot, day);
      for (const name of await fs.readdir(directory).catch(() => [] as string[]))
        if (name.endsWith(".log")) fallback.push(path.join(directory, name));
    }
    return fallback.length ? fallback : result;
  }

  private context(file: string): LogContext {
    let context = this.contexts.get(file);
    if (!context) { context = { remainder: "", turns: new Map() }; this.contexts.set(file, context); }
    return context;
  }

  private remember(callId: string): void {
    this.seen.add(callId);
    while (this.seen.size > MAX_REMEMBERED_CALLS) this.seen.delete(this.seen.values().next().value!);
  }

  private logTimestamp(line: string): string {
    const match = line.match(/^\[?(\d{4}[-/]\d{2}[-/]\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,3}))?/);
    if (!match) return this.now().toISOString();
    const local = new Date(`${match[1]?.replaceAll("/", "-")}T${match[2]}.${(match[3] || "000").padEnd(3, "0")}`);
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
