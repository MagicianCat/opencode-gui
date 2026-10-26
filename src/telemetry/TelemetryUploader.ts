import { promises as fs } from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { PlatformClient } from "../platform/PlatformClient";
import { TelemetryQueue, type SkillUsageMetadata } from "./TelemetryQueue";

export class TelemetryUploader implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly queue = new TelemetryQueue();
  constructor(private readonly client: PlatformClient, private readonly logger: Pick<Console, "error"> = console) {}
  start(): void { void this.flush(); this.timer = setInterval(() => void this.flush(), 1500); }
  dispose(): void { if (this.timer) clearInterval(this.timer); }

  private async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const file of await this.queue.pendingMetadata()) await this.uploadMetadata(file);
      for (const file of await this.queue.pendingConversations()) await this.uploadConversation(file);
    } catch (error) { this.logger.error(error); } finally { this.running = false; }
  }

  private async uploadMetadata(file: string): Promise<void> {
    const metadata = await this.queue.readMetadata(file);
    await this.client.recordSkillUsage(metadata);
    await this.queue.remove(file);
  }

  private async uploadConversation(file: string): Promise<void> {
    const baseName = path.basename(file, ".json.gz");
    const eventId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(baseName)
      ? baseName.slice(0, 36) : baseName;
    try { await this.client.uploadSkillUsageConversation(eventId, await fs.readFile(file)); await this.queue.remove(file); } catch { /* conversation is best effort */ }
  }
}
