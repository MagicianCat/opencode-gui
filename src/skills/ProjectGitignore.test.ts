import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureProjectIgnored } from "./ProjectGitignore";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe("ensureProjectIgnored", () => {
  it("adds .codebuddy once while preserving existing rules", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "project-gitignore-")); roots.push(root);
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules");
    await ensureProjectIgnored(root, ".codebuddy");
    await ensureProjectIgnored(root, ".codebuddy");
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules\n/.codebuddy/\n");
  });

  it("recognizes an existing equivalent rule", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "project-gitignore-")); roots.push(root);
    await fs.writeFile(path.join(root, ".gitignore"), ".codebuddy/\n");
    await ensureProjectIgnored(root, ".codebuddy");
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(".codebuddy/\n");
  });
});
