import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AsdmInstaller } from "./AsdmInstaller";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function archive(files: Record<string, string>): Buffer {
  const root = mkdtempSync(path.join(tmpdir(), "asdm-archive-")); roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content);
  }
  const zip = path.join(tmpdir(), `asdm-test-${Date.now()}-${Math.random()}.zip`);
  execFileSync("zip", ["-q", "-r", zip, "."], { cwd: root });
  const bytes = readFileSync(zip); rmSync(zip); return bytes;
}

describe("AsdmInstaller", () => {
  it("installs only the .asdm directory and replaces an existing installation", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "asdm-project-")); roots.push(project);
    mkdirSync(path.join(project, ".asdm")); writeFileSync(path.join(project, ".asdm", "old.txt"), "old");
    await new AsdmInstaller().install(archive({ "package/.asdm/toolsets/action.md": "new", "package/README.md": "ignored" }), project, 42);
    expect(readFileSync(path.join(project, ".asdm", "toolsets", "action.md"), "utf8")).toBe("new");
    expect(existsSync(path.join(project, ".asdm", "old.txt"))).toBe(false);
    expect(existsSync(path.join(project, "README.md"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(project, ".asdm", ".yantu-platform-asdm.json"), "utf8"))).toMatchObject({ assetId: 42 });
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("/.asdm/\n/.codebuddy/\n");
  });

  it("preserves existing ignore rules and does not duplicate .asdm", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "asdm-project-")); roots.push(project);
    writeFileSync(path.join(project, ".gitignore"), "node_modules\n.asdm/\n");
    const zip = archive({ ".asdm/tool.md": "tool" });
    const installer = new AsdmInstaller();
    await installer.install(zip, project, 42);
    await installer.install(zip, project, 42);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("node_modules\n.asdm/\n/.codebuddy/\n");
  });

  it("adds the ignore rule for an already present .asdm folder", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "asdm-project-")); roots.push(project);
    mkdirSync(path.join(project, ".asdm"));
    writeFileSync(path.join(project, ".gitignore"), "node_modules");
    await new AsdmInstaller().ensureIgnored(project);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("node_modules\n/.asdm/\n");
  });

  it("generates commands only for direct Markdown actions", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "asdm-project-")); roots.push(project);
    const zip = archive({
      ".asdm/toolsets/system-design/actions/generate-specification.md": "action",
      ".asdm/toolsets/system-design/actions/nested/hidden.md": "nested",
      ".asdm/toolsets/system-design/spec/template.md": "spec",
      ".asdm/toolsets/code-dev/actions/code-review.md": "review",
      ".asdm/toolsets/code-dev/actions/notes.txt": "text",
    });
    await new AsdmInstaller().install(zip, project, 42);
    const commands = path.join(project, ".codebuddy", "commands");
    expect(readFileSync(path.join(commands, "generate-specification.md"), "utf8")).toBe("@.asdm/toolsets/system-design/actions/generate-specification.md");
    expect(readFileSync(path.join(commands, "code-review.md"), "utf8")).toBe("@.asdm/toolsets/code-dev/actions/code-review.md");
    expect(existsSync(path.join(commands, "hidden.md"))).toBe(false);
    expect(existsSync(path.join(commands, "notes.txt"))).toBe(false);
  });

  it("rejects a conflicting existing command before replacing .asdm", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "asdm-project-")); roots.push(project);
    mkdirSync(path.join(project, ".asdm")); writeFileSync(path.join(project, ".asdm", "old.md"), "old");
    mkdirSync(path.join(project, ".codebuddy", "commands"), { recursive: true });
    writeFileSync(path.join(project, ".codebuddy", "commands", "code-review.md"), "custom");
    await expect(new AsdmInstaller().install(archive({ ".asdm/toolsets/code-dev/actions/code-review.md": "review" }), project, 42)).rejects.toThrow("已有不同内容");
    expect(readFileSync(path.join(project, ".asdm", "old.md"), "utf8")).toBe("old");
  });

  it("gives duplicate action names distinct command files", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "asdm-project-")); roots.push(project);
    await new AsdmInstaller().install(archive({
      ".asdm/toolsets/code-dev/actions/code-review.md": "dev",
      ".asdm/toolsets/code-review/actions/code-review.md": "review",
    }), project, 42);
    const commands = path.join(project, ".codebuddy", "commands");
    expect(readFileSync(path.join(commands, "code-review.md"), "utf8")).toBe("@.asdm/toolsets/code-dev/actions/code-review.md");
    expect(readFileSync(path.join(commands, "code-review-code-review.md"), "utf8")).toBe("@.asdm/toolsets/code-review/actions/code-review.md");
  });

  it("rejects an archive without .asdm and leaves the project intact", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "asdm-project-")); roots.push(project);
    await expect(new AsdmInstaller().install(archive({ "README.md": "no tools" }), project, 42)).rejects.toThrow("没有 .asdm");
    expect(existsSync(path.join(project, ".asdm"))).toBe(false);
  });
});
