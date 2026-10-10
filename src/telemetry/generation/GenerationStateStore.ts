import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GenerationState } from "./GenerationState";

/**
 * Generation 状态文件存储。目录 ~/.codebuddy/yantu-assistant/telemetry/generations/。
 * 写采用 tmp + rename 保证原子性；读失败返回 null（损坏状态不阻塞采集）。
 */
export class GenerationStateStore {
  readonly directory: string;

  constructor(homeDirectory = os.homedir()) {
    this.directory = path.join(homeDirectory, ".codebuddy", "yantu-assistant", "telemetry", "generations");
  }

  private fileFor(generationId: string): string {
    const safe = generationId.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(this.directory, `${safe}.json`);
  }

  async load(generationId: string): Promise<GenerationState | null> {
    try {
      return JSON.parse(await fs.readFile(this.fileFor(generationId), "utf8")) as GenerationState;
    } catch {
      return null;
    }
  }

  async save(state: GenerationState): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    state.updatedAtMs = Math.max(Date.now(), (state.updatedAtMs || 0) + 1);
    const target = this.fileFor(state.generationId);
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, target);
  }

  /** 读-改-写：不存在则返回 null（调用方决定是否新建）。 */
  async update(generationId: string, mutate: (state: GenerationState) => void): Promise<GenerationState | null> {
    const state = await this.load(generationId);
    if (!state) return null;
    mutate(state);
    await this.save(state);
    return state;
  }

  async remove(generationId: string): Promise<void> {
    try { await fs.unlink(this.fileFor(generationId)); } catch { /* already gone */ }
  }

  /** 上传旧快照后仅删除未被更新的同版本状态，避免覆盖期间丢失最终指标。 */
  async removeIfUnchanged(generationId: string, expectedUpdatedAtMs: number): Promise<boolean> {
    const current = await this.load(generationId);
    if (!current || current.updatedAtMs !== expectedUpdatedAtMs) return false;
    try {
      await fs.unlink(this.fileFor(generationId));
      return true;
    } catch { return false; }
  }

  /** 列出全部状态文件（含已结束待上报与超时待 PARTIAL 的）。 */
  async listAll(): Promise<GenerationState[]> {
    let names: string[];
    try { names = await fs.readdir(this.directory); } catch { return []; }
    const states: GenerationState[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        states.push(JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8")) as GenerationState);
      } catch { /* skip corrupt */ }
    }
    return states;
  }
}
