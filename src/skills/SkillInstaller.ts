import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readSafeZip, type ZipEntry } from "./SafeZip";

export interface BundleItem { skillKey: string; version?: string; versionId?: number; artifactFileName: string; artifactSha256: string; }
export interface BundleDescriptor { sha256: string; items: BundleItem[]; }

export class SkillInstaller {
  constructor(private readonly cleanup: typeof fs.rm = fs.rm) {}
  async install(bundle: Buffer, descriptor: BundleDescriptor, skillsDirectory: string): Promise<string[]> {
    assertHash(bundle, descriptor.sha256, "Bundle");
    const outer = readSafeZip(bundle); const staged: Array<{ target: string; stage: string; backup?: string; committed: boolean }> = [];
    await fs.mkdir(skillsDirectory, { recursive: true });
    try {
      for (const item of descriptor.items) {
        validateSkillKey(item.skillKey);
        const artifactPath = item.artifactFileName.startsWith(`${item.skillKey}/`) ? item.artifactFileName : `${item.skillKey}/${item.artifactFileName}`;
        const artifact = outer.find(entry => !entry.directory && entry.name === artifactPath);
        if (!artifact) throw new Error(`Bundle 缺少 ${item.skillKey} 的 Artifact`);
        assertHash(artifact.data, item.artifactSha256, item.skillKey);
        const entries = readSafeZip(artifact.data); const files = normalizeSkillEntries(entries, item.skillKey);
        if (!files.some(entry => entry.name === "SKILL.md")) throw new Error(`${item.skillKey} 缺少 SKILL.md`);
        const stage = path.join(skillsDirectory, `.yantu-stage-${randomUUID()}`); await fs.mkdir(stage);
        for (const entry of files) { const destination = path.join(stage, ...entry.name.split("/")); assertInside(stage, destination); if (entry.directory) await fs.mkdir(destination, { recursive: true }); else { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, entry.data, { flag: "wx" }); } }
        await fs.writeFile(path.join(stage, ".yantu-platform-skill.json"), JSON.stringify({ schemaVersion: 1, source: "yantu-platform", skillKey: item.skillKey, skillVersionId: item.versionId ?? null, version: item.version ?? null, artifactSha256: item.artifactSha256, installationId: randomUUID(), installedAt: new Date().toISOString() }) + "\n", { flag: "wx" });
        staged.push({ target: path.join(skillsDirectory, item.skillKey), stage, committed: false });
      }
      for (const operation of staged) {
        if (await exists(operation.target)) { operation.backup = path.join(skillsDirectory, `.yantu-backup-${randomUUID()}`); await fs.rename(operation.target, operation.backup); }
        await fs.rename(operation.stage, operation.target); operation.committed = true;
      }
    } catch (error) {
      for (const operation of [...staged].reverse()) {
        if (operation.committed && await exists(operation.target)) await fs.rm(operation.target, { recursive: true, force: true });
        if (operation.backup && await exists(operation.backup)) await fs.rename(operation.backup, operation.target);
        if (await exists(operation.stage)) await fs.rm(operation.stage, { recursive: true, force: true });
      }
      throw error;
    }
    await Promise.all(staged.map(async item => { if (!item.backup) return; try { await this.cleanup(item.backup, { recursive: true, force: true }); } catch { /* committed install remains valid; stale backup is recoverable */ } }));
    return descriptor.items.map(item => item.skillKey);
  }
}

export function parseBundleDescriptor(value: Record<string, unknown>): BundleDescriptor {
  const hash = value.sha256; const rawItems = value.items;
  if (typeof hash !== "string" || !Array.isArray(rawItems)) throw new Error("Bundle 元数据不完整");
  const items = rawItems.map(raw => { const item = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {}; if (typeof item.skillKey !== "string" || typeof item.artifactFileName !== "string" || typeof item.artifactSha256 !== "string") throw new Error("Bundle Artifact 校验信息不完整"); return { skillKey: item.skillKey, version: typeof item.version === "string" ? item.version : undefined, versionId: typeof item.versionId === "number" ? item.versionId : undefined, artifactFileName: item.artifactFileName, artifactSha256: item.artifactSha256 }; });
  return { sha256: hash, items };
}

function normalizeSkillEntries(entries: ZipEntry[], skillKey: string): ZipEntry[] {
  const files = entries.filter(entry => entry.name !== "/"); const first = files[0]?.name.split("/")[0]; const strip = first && files.every(entry => entry.name === `${first}/` || entry.name.startsWith(`${first}/`)) ? `${first}/` : "";
  return files.map(entry => ({ ...entry, name: strip ? entry.name.slice(strip.length) : entry.name })).filter(entry => entry.name.length > 0);
}
function assertHash(data: Buffer, expected: string, label: string): void { const actual = createHash("sha256").update(data).digest("hex"); if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} SHA-256 校验失败`); }
function validateSkillKey(key: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) throw new Error(`Skill key 不安全: ${key}`); }
function assertInside(root: string, target: string): void { const relative = path.relative(root, target); if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("解压目标越界"); }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
