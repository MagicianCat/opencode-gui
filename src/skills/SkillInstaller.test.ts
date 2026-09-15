import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillInstaller } from "./SkillInstaller";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
describe("SkillInstaller", () => {
  it("verifies nested hashes and installs a valid skill", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-install-")); temporary.push(root);
    const artifact = storedZip("sample/SKILL.md", Buffer.from("# Sample")); const bundle = storedZip("sample/artifacts/sample.zip", artifact);
    const installed = await new SkillInstaller().install(bundle, { sha256: sha(bundle), items: [{ skillKey: "sample", artifactFileName: "artifacts/sample.zip", artifactSha256: sha(artifact) }] }, path.join(root, "skills"));
    expect(installed).toEqual(["sample"]); expect(await fs.readFile(path.join(root, "skills", "sample", "SKILL.md"), "utf8")).toBe("# Sample");
    expect(JSON.parse(await fs.readFile(path.join(root, "skills", "sample", ".yantu-platform-skill.json"), "utf8"))).toMatchObject({ source: "yantu-platform", skillKey: "sample", version: null });
  });
  it("rejects a mismatched outer hash before writing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-install-")); temporary.push(root); const bundle = storedZip("x", Buffer.from("x"));
    await expect(new SkillInstaller().install(bundle, { sha256: "00", items: [] }, path.join(root, "skills"))).rejects.toThrow(/SHA-256/);
  });
  it("keeps committed replacement when backup cleanup fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-install-")); temporary.push(root); const skills = path.join(root, "skills"); await fs.mkdir(path.join(skills, "sample"), { recursive: true }); await fs.writeFile(path.join(skills, "sample", "SKILL.md"), "old");
    const artifact = storedZip("SKILL.md", Buffer.from("new")); const bundle = storedZip("sample/sample.zip", artifact); const cleanup = async () => { throw new Error("cleanup failed"); };
    await expect(new SkillInstaller(cleanup as typeof fs.rm).install(bundle, { sha256: sha(bundle), items: [{ skillKey: "sample", artifactFileName: "sample.zip", artifactSha256: sha(artifact) }] }, skills)).resolves.toEqual(["sample"]);
    expect(await fs.readFile(path.join(skills, "sample", "SKILL.md"), "utf8")).toBe("new");
  });
});
function sha(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function storedZip(name: string, data: Buffer): Buffer { const filename = Buffer.from(name); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26); const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + filename.length, 12); eocd.writeUInt32LE(30 + filename.length + data.length, 16); return Buffer.concat([local, filename, data, central, filename, eocd]); }
