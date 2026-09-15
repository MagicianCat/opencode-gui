import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Recommendation } from "../shared/messages";

export interface LocalSkill { skillKey: string; version?: string; directory: string; scope: "project" | "global"; }
export interface PlatformSkill extends LocalSkill { version: string; skillVersionId?: number; installationId?: string; }

export async function scanSkills(projectRoot?: string): Promise<LocalSkill[]> {
  const roots: Array<{ directory: string; scope: "project" | "global" }> = [{ directory: path.join(os.homedir(), ".codebuddy", "skills"), scope: "global" }];
  if (projectRoot) roots.unshift({ directory: path.join(projectRoot, ".codebuddy", "skills"), scope: "project" });
  const results: LocalSkill[] = [];
  for (const root of roots) {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(root.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root.directory, entry.name);
      try { await fs.access(path.join(directory, "SKILL.md")); } catch { continue; }
      const metadata = await readMetadata(path.join(directory, "skill.yaml"));
      results.push({ skillKey: metadata.skillKey ?? entry.name, version: metadata.version, directory, scope: root.scope });
    }
  }
  return results;
}

/** Scan only skills installed by Yantu, using the marker written by SkillInstaller. */
export async function scanPlatformSkills(projectRoot?: string): Promise<PlatformSkill[]> {
  const roots: Array<{ directory: string; scope: "project" | "global" }> = [{ directory: path.join(os.homedir(), ".codebuddy", "skills"), scope: "global" }];
  if (projectRoot) roots.unshift({ directory: path.join(projectRoot, ".codebuddy", "skills"), scope: "project" });
  const results: PlatformSkill[] = [];
  for (const root of roots) {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(root.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root.directory, entry.name);
      try { await fs.access(path.join(directory, "SKILL.md")); } catch { continue; }
      try {
        const marker = JSON.parse(await fs.readFile(path.join(directory, ".yantu-platform-skill.json"), "utf8")) as Record<string, unknown>;
        const skillKey = typeof marker.skillKey === "string" ? marker.skillKey : undefined;
        const version = typeof marker.version === "string" ? marker.version : undefined;
        if (marker.source !== "yantu-platform" || !skillKey || !version) continue;
        results.push({ skillKey, version, skillVersionId: typeof marker.skillVersionId === "number" ? marker.skillVersionId : undefined, installationId: typeof marker.installationId === "string" ? marker.installationId : undefined, directory, scope: root.scope });
      } catch { /* an unmarked/local skill is intentionally ignored */ }
    }
  }
  return results;
}

export function addInstallStatus(recommendations: Recommendation[], local: LocalSkill[]): Recommendation[] {
  return recommendations.map(item => {
    const matches = local.filter(skill => skill.skillKey === item.skillKey);
    const project = matches.find(skill => skill.scope === "project");
    const global = matches.find(skill => skill.scope === "global");
    const installed = project ?? global;
    if (!installed) return { ...item, status: "missing" };
    if (item.version && installed.version && compareVersions(installed.version, item.version) < 0) return { ...item, status: "update", localVersion: installed.version };
    return { ...item, status: project ? "project" : "global", localVersion: installed.version };
  });
}

async function readMetadata(file: string): Promise<{ skillKey?: string; version?: string }> {
  try {
    const text = await fs.readFile(file, "utf8");
    const value = (key: string) => text.match(new RegExp(`^\\s*${key}\\s*:\\s*["']?([^\\n#"']+)`, "m"))?.[1]?.trim();
    return { skillKey: value("skillKey"), version: value("version") };
  } catch { return {}; }
}

export function compareVersions(left: string, right: string): number {
  const a = left.replace(/^v/, "").split(/[.-]/); const b = right.replace(/^v/, "").split(/[.-]/);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const av = Number(a[i] ?? 0); const bv = Number(b[i] ?? 0); if (!Number.isNaN(av) && !Number.isNaN(bv) && av !== bv) return av - bv; const cmp = String(a[i] ?? "").localeCompare(String(b[i] ?? "")); if (cmp) return cmp; }
  return 0;
}
