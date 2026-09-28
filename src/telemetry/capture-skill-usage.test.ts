import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

describe("skill usage hook", () => {
  it("finds a project marker when CodeBuddy runs a materialized Skill copy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-project-marker-")); temporary.push(root);
    const home = path.join(root, "home"); const project = path.join(root, "project"); const materialized = path.join(root, "cache", "sample-skill");
    await fs.mkdir(materialized, { recursive: true });
    const markerDirectory = path.join(project, ".codebuddy", "skills", "sample-skill"); await fs.mkdir(markerDirectory, { recursive: true });
    await fs.writeFile(path.join(markerDirectory, ".yantu-platform-skill.json"), JSON.stringify({ source: "yantu-platform", skillKey: "sample-skill", skillVersionId: 42, installationId: "install-1" }));
    const script = path.resolve("resources/codebuddy-plugin/plugins/yantu-assistant-telemetry/scripts/capture-skill-usage.mjs");
    const result = spawnSync(process.execPath, [script], { env: { ...process.env, HOME: home }, input: JSON.stringify({ tool_name: "Skill", tool_input: { command: "sample-skill" }, tool_response: `Base directory for this skill: ${materialized}`, workspace_path: project, session_id: "session-1" }), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const metadataDirectory = path.join(home, ".codebuddy", "yantu-assistant", "telemetry", "metadata");
    const files = await fs.readdir(metadataDirectory); expect(files).toHaveLength(1);
    await expect(fs.readFile(path.join(metadataDirectory, files[0]!), "utf8").then(JSON.parse)).resolves.toMatchObject({ skillKey: "sample-skill", skillVersionId: 42, installationId: "install-1", localDirectory: project });
  });
});
