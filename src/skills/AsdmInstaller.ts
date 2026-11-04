import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readSafeZip } from "./SafeZip";
import { ensureProjectIgnored } from "./ProjectGitignore";

export class AsdmInstaller {
  async ensureIgnored(projectRoot: string): Promise<void> { await ensureProjectIgnored(projectRoot, ".asdm"); }
  async install(archive: Buffer, projectRoot: string, assetId: number): Promise<void> {
    const entries = readSafeZip(archive);
    const roots = new Set(entries.map(entry => {
      const parts = entry.name.split("/");
      const index = parts.indexOf(".asdm");
      return index < 0 ? null : parts.slice(0, index).join("/");
    }).filter((root): root is string => root !== null));
    if (roots.size === 0) throw new Error("工具包中没有 .asdm 文件夹");
    if (roots.size > 1) throw new Error("工具包中存在多个 .asdm 文件夹，无法确定安装内容");
    const root = [...roots][0];
    const prefix = `${root ? `${root}/` : ""}.asdm/`;
    const files = entries.filter(entry => entry.name.startsWith(prefix) && !entry.directory);
    if (!files.length) throw new Error("工具包中的 .asdm 文件夹为空");
    const actions: Array<{ toolset: string; filename: string }> = [];
    for (const entry of files) {
      const relative = entry.name.slice(prefix.length);
      const parts = relative.split("/");
      if (parts.length !== 4 || parts[0] !== "toolsets" || parts[2] !== "actions" || !parts[3]?.endsWith(".md")) continue;
      actions.push({ toolset: parts[1]!, filename: parts[3] });
    }
    actions.sort((a, b) => a.filename.localeCompare(b.filename) || a.toolset.localeCompare(b.toolset));
    const commands = new Map<string, string>();
    for (const action of actions) {
      let name = action.filename;
      if (commands.has(name)) name = `${action.toolset}-${action.filename}`;
      let index = 2;
      while (commands.has(name)) name = `${action.toolset}-${index++}-${action.filename}`;
      commands.set(name, `@.asdm/toolsets/${action.toolset}/actions/${action.filename}`);
    }
    const commandsRoot = path.join(projectRoot, ".codebuddy", "commands");
    for (const [name, content] of commands) {
      try {
        const existing = await fs.readFile(path.join(commandsRoot, name), "utf8");
        if (existing !== content) throw new Error(`已有不同内容的 Command：${name}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const target = path.join(projectRoot, ".asdm");
    const stage = path.join(projectRoot, `.yantu-asdm-stage-${randomUUID()}`);
    const backup = path.join(projectRoot, `.yantu-asdm-backup-${randomUUID()}`);
    let backedUp = false;
    let committed = false;
    try {
      await fs.mkdir(stage);
      for (const entry of files) {
        const relative = entry.name.slice(prefix.length);
        if (relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`ZIP 路径不安全: ${entry.name}`);
        const destination = path.join(stage, ...relative.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, entry.data, { flag: "wx" });
      }
      await fs.writeFile(path.join(stage, ".yantu-platform-asdm.json"), JSON.stringify({ assetId, installedAt: new Date().toISOString() }), { flag: "wx" });
      try { await fs.lstat(target); await fs.rename(target, backup); backedUp = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await fs.rename(stage, target);
      committed = true;
    } catch (error) {
      if (backedUp) await fs.rename(backup, target);
      throw error;
    } finally {
      if (!committed) await fs.rm(stage, { recursive: true, force: true });
    }
    if (backedUp) await fs.rm(backup, { recursive: true, force: true }).catch(() => { /* Installation succeeded; stale backup is recoverable. */ });
    if (commands.size) await fs.mkdir(commandsRoot, { recursive: true });
    for (const [name, content] of commands) {
      try { await fs.writeFile(path.join(commandsRoot, name), content, { flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await fs.readFile(path.join(commandsRoot, name), "utf8") !== content) throw new Error(`已有不同内容的 Command：${name}`);
      }
    }
    await ensureProjectIgnored(projectRoot, ".asdm");
    await ensureProjectIgnored(projectRoot, ".codebuddy");
  }
}
