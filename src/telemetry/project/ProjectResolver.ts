import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProjectIdentity {
  projectKey: string;
  projectName: string;
  projectSource: "GIT_REMOTE" | "LOCAL";
}

/**
 * 解析项目标识。优先 git remote.origin.url 标准化后取 SHA256（跨机器/路径稳定）；
 * 无 Git 时退化为 SHA256(clientInstallationId + 规范化工作区路径)。
 */
export class ProjectResolver {
  constructor(private readonly clientInstallationId: () => string | undefined) {}

  async resolve(cwd: string): Promise<ProjectIdentity> {
    const remote = await this.gitRemote(cwd);
    if (remote) {
      const normalized = normalizeGitRemote(remote);
      return {
        projectKey: sha256(normalized),
        projectName: repoBasename(remote) || repoBasename(normalized) || "unknown",
        projectSource: "GIT_REMOTE",
      };
    }
    const install = this.clientInstallationId() ?? "unknown-install";
    const normalizedPath = normalizePath(cwd);
    return {
      projectKey: sha256(`${install}:${normalizedPath}`),
      projectName: pathBasename(normalizedPath) || "unknown",
      projectSource: "LOCAL",
    };
  }

  private async gitRemote(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { timeout: 3000 });
      const value = stdout.trim();
      return value || null;
    } catch {
      return null;
    }
  }
}

/** 去掉协议、凭证、.git 后缀、尾斜杠，统一小写 host，使同一 repo 不同写法得到同一 key。 */
export function normalizeGitRemote(remote: string): string {
  let value = remote.trim();
  // git@github.com:org/repo.git -> github.com/org/repo
  const scp = value.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) value = `${scp[1]}/${scp[2]}`;
  value = value.replace(/^[a-zA-Z]+:\/\//, "");
  value = value.replace(/^[^/@]+@/, ""); // strip credentials
  value = value.replace(/\.git$/, "");
  value = value.replace(/\/+$/, "");
  return value.toLowerCase();
}

function repoBasename(raw: string): string {
  const segment = String(raw || "").split(/[/:]/).filter(Boolean).pop() ?? "";
  return segment.replace(/\.git$/, "");
}
function pathBasename(p: string): string { return p.split(/[\\/]/).filter(Boolean).pop() ?? ""; }
function normalizePath(p: string): string { return p.replace(/[\\/]+$/, ""); }
function sha256(input: string): string { return createHash("sha256").update(input).digest("hex"); }
