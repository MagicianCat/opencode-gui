import { promises as fs } from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import { HttpError, type PlatformClient } from "../platform/PlatformClient";
import { TelemetryQueue, type SkillUsageMetadata } from "./TelemetryQueue";

export class TelemetryUploader implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly failedCommandLogAt = new Map<string, number>();
  private readonly queue: TelemetryQueue;
  constructor(private readonly client: PlatformClient,
    private readonly logger: Pick<Console, "info" | "error"> = console, queue?: TelemetryQueue) {
    this.queue = queue ?? new TelemetryQueue();
  }
  start(): void { void this.flush(); this.timer = setInterval(() => void this.flush(), 1500); }
  dispose(): void { if (this.timer) clearInterval(this.timer); }

  private async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const file of await this.queue.pendingMetadata()) await this.uploadMetadata(file);
      for (const file of await this.queue.pendingCommands()) await this.uploadCommand(file);
      for (const file of await this.queue.pendingConversations()) await this.uploadConversation(file);
    } catch (error) { this.logger.error(error); } finally { this.running = false; }
  }

  private async uploadMetadata(file: string): Promise<void> {
    const metadata = await this.queue.readMetadata(file);
    await this.client.recordSkillUsage(metadata);
    await this.queue.remove(file);
  }

  private async uploadCommand(file: string): Promise<void> {
    const metadata = await this.queue.readCommand(file);
    try {
      await this.client.recordCommandUsage(metadata);
      await this.queue.remove(file);
      this.failedCommandLogAt.delete(metadata.eventId);
      await this.queue.commandDiagnostic("uploaded", { eventId: metadata.eventId, commandName: metadata.commandName });
      this.logger.info(`ASDM 命令上传成功：${metadata.commandName}，事件 ${metadata.eventId}`);
    } catch (error) {
      const now = Date.now();
      const previous = this.failedCommandLogAt.get(metadata.eventId) ?? 0;
      if (now - previous < 60_000) return;
      this.failedCommandLogAt.set(metadata.eventId, now);
      if (this.failedCommandLogAt.size > 1_000) this.failedCommandLogAt.delete(this.failedCommandLogAt.keys().next().value!);
      const reason = error instanceof HttpError ? `HTTP_${error.status}` : error instanceof Error ? error.name : "UNKNOWN";
      await this.queue.commandDiagnostic("upload_failed", { eventId: metadata.eventId,
        commandName: metadata.commandName, reason });
      this.logger.error(`ASDM 命令上传失败：${metadata.commandName}，事件 ${metadata.eventId}，原因 ${reason}`);
    }
  }

  private async uploadConversation(file: string): Promise<void> {
    const baseName = path.basename(file, ".json.gz");
    const eventId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(baseName)
      ? baseName.slice(0, 36) : baseName;
    try { await this.client.uploadSkillUsageConversation(eventId, await fs.readFile(file)); await this.queue.remove(file); } catch { /* conversation is best effort */ }
  }
}
