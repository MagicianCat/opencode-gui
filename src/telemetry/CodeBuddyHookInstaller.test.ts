import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installCodeBuddyHook } from "./CodeBuddyHookInstaller";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-hook-installer-")); temporary.push(root);
  const extensionRoot = path.join(root, "extension");
  const source = path.join(extensionRoot, "resources", "codebuddy-plugin", "plugins", "yantu-assistant-telemetry", "scripts");
  await fs.mkdir(source, { recursive: true });
  for (const file of ["capture-skill-usage.mjs", "capture-generation.mjs", "capture-file-diff.mjs", "codebuddy-usage-provider.mjs", "probe-tool-name.mjs"]) await fs.writeFile(path.join(source, file), `// ${file}\n`);
  return { extensionRoot, home: path.join(root, ".codebuddy") };
}

describe("enterprise CodeBuddy Hook installer", () => {
  it("installs without a CodeBuddy CLI and preserves other plugins", async () => {
    const { extensionRoot, home } = await fixture();
    const registry = path.join(home, "plugins", "installed_plugins.json");
    await fs.mkdir(path.dirname(registry), { recursive: true });
    await fs.writeFile(registry, JSON.stringify({ version: 2, plugins: { "official@example": [{ scope: "user", installPath: "official" }], "yantu-hook-probe@yantu-hook-probe-local": [{ scope: "user", installPath: "legacy", version: "0.0.6" }] } }));
    const result = await installCodeBuddyHook(extensionRoot, { codeBuddyHome: home, now: () => "2026-09-24T00:00:00.000Z", runnerExecutable: "C:\\PrivateCodeBuddy\\CodeBuddy.exe", platform: "win32", electronRuntime: true });
    expect(result.changed).toBe(true);
    const installed = JSON.parse(await fs.readFile(registry, "utf8"));
    expect(installed.plugins["official@example"]).toHaveLength(1);
    expect(installed.plugins["yantu-assistant-telemetry@yantu-internal"][0].installPath).toContain("yantu-assistant-telemetry");
    expect(installed.plugins["yantu-hook-probe@yantu-hook-probe-local"]).toBeUndefined();
    const hooks = JSON.parse(await fs.readFile(result.hooksFile, "utf8"));
    expect(hooks.hooks.PostToolUse.some((entry: Record<string, unknown>) => entry["x-yantu-owner-id"] === "yantu-assistant-telemetry")).toBe(true);
    expect(hooks.hooks.PostToolUse[0].matcher).toBeUndefined();
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toContain("probe-tool-name.mjs");
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toContain("PrivateCodeBuddy");
    expect(hooks.hooks.PostToolUse[1].matcher).toBe("Skill|skill|use_skill");
    expect(installed.plugins["yantu-assistant-telemetry@yantu-internal"][0].version).toBe("1.0.0");
  });

  it("is idempotent after the first activation", async () => {
    const { extensionRoot, home } = await fixture();
    const first = await installCodeBuddyHook(extensionRoot, { codeBuddyHome: home, now: () => "2026-09-24T00:00:00.000Z" });
    const second = await installCodeBuddyHook(extensionRoot, { codeBuddyHome: home, now: () => "2026-09-24T00:00:00.000Z" });
    expect(first.restartRequired).toBe(true);
    expect(second.restartRequired).toBe(false);
  });
});
