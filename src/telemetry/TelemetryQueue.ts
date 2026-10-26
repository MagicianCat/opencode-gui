import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SkillUsageMetadata {
  eventId: string; skillKey: string; skillVersionId?: number; installationId?: string;
  invokedAt: string; localDirectory: string; clientSessionId: string; generationId?: string;
  client: string; clientVersion?: string; agentType?: string; model?: string;
  conversationFile?: string; transcriptPath?: string; messageIds?: string[];
}

export class TelemetryQueue {
  readonly root: string;
  readonly metadataDirectory: string;
  readonly conversationDirectory: string;

  constructor(homeDirectory = os.homedir()) {
    this.root = path.join(homeDirectory, ".codebuddy", "yantu-assistant", "telemetry");
    this.metadataDirectory = path.join(this.root, "metadata");
    this.conversationDirectory = path.join(this.root, "conversations");
  }

  async enqueue(metadata: SkillUsageMetadata): Promise<void> {
    await fs.mkdir(this.metadataDirectory, { recursive: true, mode: 0o700 });
    const base = path.join(this.metadataDirectory, `${metadata.eventId}.json`);
    let target = base;
    try {
      await fs.access(base);
      const fingerprint = createHash("sha256").update(JSON.stringify({ model: metadata.model,
        localDirectory: metadata.localDirectory, generationId: metadata.generationId,
        skillVersionId: metadata.skillVersionId })).digest("hex").slice(0, 16);
      target = path.join(this.metadataDirectory, `${metadata.eventId}-${fingerprint}.json`);
      await fs.access(target);
      return;
    } catch { /* select the first available filename */ }
    const temporary = path.join(this.metadataDirectory, `.${metadata.eventId}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(metadata) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  }

  async pendingMetadata(): Promise<string[]> { return this.files(this.metadataDirectory, ".json"); }
  async pendingConversations(): Promise<string[]> {
    const files = await this.files(this.conversationDirectory, ".json.gz");
    const timestamps = new Map(await Promise.all(files.map(async file => [file,
      (await fs.stat(file).catch(() => undefined))?.mtimeMs ?? 0] as const)));
    return files.sort((a, b) => {
      const priority = (file: string) => /^[0-9a-f-]{36}\.json\.gz$/i.test(path.basename(file)) ? 0 : 1;
      return priority(a) - priority(b) || (timestamps.get(a) ?? 0) - (timestamps.get(b) ?? 0) || a.localeCompare(b);
    });
  }
  async readMetadata(file: string): Promise<SkillUsageMetadata> { return JSON.parse(await fs.readFile(file, "utf8")) as SkillUsageMetadata; }
  async remove(file: string): Promise<void> { try { await fs.unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }

  private async files(directory: string, suffix: string): Promise<string[]> {
    try { return (await fs.readdir(directory)).filter(name => name.endsWith(suffix)).map(name => path.join(directory, name)); } catch { return []; }
  }
}
