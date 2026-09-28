import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

describe("PostToolUse name probe", () => {
  it("records names and keys without recording payload values", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-tool-probe-")); temporary.push(root);
    const home = path.join(root, "home"); const secret = "must-not-be-written";
    const script = path.resolve("resources/codebuddy-plugin/plugins/yantu-assistant-telemetry/scripts/probe-tool-name.mjs");
    const result = spawnSync(process.execPath, [script], { env: { ...process.env, HOME: home }, input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "PrivateSkillTool", tool_input: { command: secret }, tool_response: secret, prompt: secret }), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const log = await fs.readFile(path.join(home, ".codebuddy", "yantu-assistant", "telemetry", "probe", "post-tool-names.log"), "utf8");
    expect(log).toContain("PrivateSkillTool"); expect(log).toContain("command"); expect(log).not.toContain(secret);
  });
});
