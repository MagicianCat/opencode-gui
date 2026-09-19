import type * as vscode from "vscode";
import type { PlatformClient } from "../../platform/PlatformClient";
import { GenerationStateStore } from "./GenerationStateStore";
import type { GenerationState } from "./GenerationState";
import { aggregateFileTypes } from "./GenerationAggregator";

/** 超时阈值：超过该时长无更新且未收到 Stop 的 Generation 以 PARTIAL 上报。 */
const PARTIAL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Generation 上传器（扩展进程）。周期性扫描本地 Generation 状态：
 *  - 已结束（COMPLETED/FAILED/CANCELLED）→ 聚合并上报；
 *  - 超时未结束（RUNNING 但长时间无更新）→ 标记 PARTIAL 上报；
 * 上报成功后删除本地状态。失败保留待下轮重试。
 */
export class GenerationTelemetry implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly store = new GenerationStateStore();

  constructor(
    private readonly client: PlatformClient,
    private readonly logger: Pick<Console, "error"> = console,
    private readonly partialTimeoutMs: number = PARTIAL_TIMEOUT_MS,
  ) {}

  start(): void { void this.flush(); this.timer = setInterval(() => void this.flush(), 5000); }
  dispose(): void { if (this.timer) clearInterval(this.timer); }

  private async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const state of await this.store.listAll()) await this.process(state);
    } catch (error) {
      this.logger.error(error);
    } finally {
      this.running = false;
    }
  }

  private async process(state: GenerationState): Promise<void> {
    if (state.status === "RUNNING") {
      if (Date.now() - state.updatedAtMs < this.partialTimeoutMs) return; // 仍在进行
      state.status = "PARTIAL"; // 超时未收到 Stop，按 PARTIAL 上报避免滞留
    }
    try {
      await this.client.recordGeneration(toPayload(state));
      await this.store.remove(state.generationId);
    } catch (error) {
      this.logger.error(error); // 保留状态，下轮重试
    }
  }
}

/** 把本地状态映射为后端 POST /telemetry/generations 的 payload。 */
export function toPayload(state: GenerationState): Record<string, unknown> {
  const fileTypes = aggregateFileTypes(state.fileDiffs);
  const code = state.fileDiffs.reduce(
    (acc, d) => ({
      linesAdded: acc.linesAdded + d.linesAdded,
      linesDeleted: acc.linesDeleted + d.linesDeleted,
      filesCreated: acc.filesCreated + (d.created ? 1 : 0),
      filesModified: acc.filesModified + (d.modified ? 1 : 0),
    }),
    { linesAdded: 0, linesDeleted: 0, filesCreated: 0, filesModified: 0 },
  );
  const skillKeys = [...new Set(state.skillInvocations.map(s => s.skillKey))];
  return {
    generationId: state.generationId,
    sessionId: state.sessionId,
    clientInstallationId: state.clientInstallationId,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    durationMs: state.durationMs,
    projectKey: state.projectKey,
    projectName: state.projectName,
    projectSource: state.projectSource,
    skillKeys,
    usage: state.usage,
    code,
    fileTypes,
    toolCallCount: state.toolCallCount,
    toolFailureCount: state.toolFailureCount,
    status: state.status,
  };
}
