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
  readonly root = path.join(os.homedir(), ".codebuddy", "yantu-assistant", "telemetry");
  readonly metadataDirectory = path.join(this.root, "metadata");
  readonly conversationDirectory = path.join(this.root, "conversations");

  async enqueue(metadata: SkillUsageMetadata): Promise<void> {
    await fs.mkdir(this.metadataDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.metadataDirectory, `.${metadata.eventId}.tmp`);
    const target = path.join(this.metadataDirectory, `${metadata.eventId}.json`);
    await fs.writeFile(temporary, JSON.stringify(metadata) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  }

  async pendingMetadata(): Promise<string[]> { return this.files(this.metadataDirectory, ".json"); }
  async pendingConversations(): Promise<string[]> { return this.files(this.conversationDirectory, ".json.gz"); }
  async readMetadata(file: string): Promise<SkillUsageMetadata> { return JSON.parse(await fs.readFile(file, "utf8")) as SkillUsageMetadata; }
  async remove(file: string): Promise<void> { try { await fs.unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }

  private async files(directory: string, suffix: string): Promise<string[]> {
    try { return (await fs.readdir(directory)).filter(name => name.endsWith(suffix)).map(name => path.join(directory, name)); } catch { return []; }
  }
}
