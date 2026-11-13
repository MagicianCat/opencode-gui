import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAsdmCommand } from "./AsdmCommandResolver";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-asdm-resolver-"));
  roots.push(root);
  return root;
}
async function entry(root: string, alias: string, toolset: string, action = "code-review"): Promise<string> {
  const target = path.join(root, ".asdm", "toolsets", toolset, "actions", `${action}.md`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "action");
  const commands = path.join(root, ".codebuddy", "commands");
  await fs.mkdir(commands, { recursive: true });
  await fs.writeFile(path.join(commands, `${alias}.md`), `@.asdm/toolsets/${toolset}/actions/${action}.md\n`);
  return target;
}

describe("ASDM command origin", () => {
  it("uses the entry path for Chinese aliases and preserves asset and toolset identity", async () => {
    const root = await project();
    await entry(root, "code-review", "code-dev-sc274");
    const target = await entry(root, "代码评审工具集-code-review", "代码评审工具集");
    await fs.writeFile(path.join(root, ".asdm", ".yantu-platform-asdm.json"), JSON.stringify({ assetId: 123 }));
    const result = await resolveAsdmCommand(root, "代码评审工具集-code-review", {
      triggerType: "TYPED", readActionPaths: [target],
    });
    expect(result.command).toMatchObject({ commandName: "代码评审工具集-code-review",
      toolsetName: "代码评审工具集", actionName: "code-review", asdmAssetId: 123,
      sourceStatus: "source_resolved" });
    expect((await resolveAsdmCommand(root, "code-review", { triggerType: "MENU" })).command?.toolsetName)
      .toBe("code-dev-sc274");
  });

  it("rejects unrelated typed reads and conflicting menu paths", async () => {
    const root = await project();
    await entry(root, "代码评审工具集-code-review", "代码评审工具集");
    const other = await entry(root, "other", "another-toolset");
    expect((await resolveAsdmCommand(root, "代码评审工具集-code-review", {
      triggerType: "TYPED", readActionPaths: [other],
    })).reason).toBe("typed_action_mismatch");
    expect((await resolveAsdmCommand(root, "代码评审工具集-code-review", {
      triggerType: "MENU", promptPath: ".asdm/toolsets/another-toolset/actions/code-review.md",
    })).reason).toBe("prompt_mapping_mismatch");
  });

  it("keeps local usage when the platform marker is missing or invalid", async () => {
    const root = await project();
    await entry(root, "code-review", "code-dev");
    expect((await resolveAsdmCommand(root, "code-review", { triggerType: "MENU" })).command)
      .toMatchObject({ toolsetName: "code-dev", sourceStatus: "source_missing" });
    await fs.writeFile(path.join(root, ".asdm", ".yantu-platform-asdm.json"), '{"assetId":-1}');
    expect((await resolveAsdmCommand(root, "code-review", { triggerType: "MENU" })).command)
      .toMatchObject({ toolsetName: "code-dev", sourceStatus: "asset_marker_invalid" });
  });

  it("rejects unsafe entry paths and symlinked action files", async () => {
    const root = await project();
    await entry(root, "code-review", "code-dev");
    const commandFile = path.join(root, ".codebuddy", "commands", "code-review.md");
    await fs.writeFile(commandFile, "@.asdm/toolsets/../actions/code-review.md");
    expect((await resolveAsdmCommand(root, "code-review", { triggerType: "MENU" })).reason).toBe("entry_invalid");
    await fs.writeFile(commandFile, "@.asdm/toolsets/code-dev/actions/code-review.md");
    const actionFile = path.join(root, ".asdm", "toolsets", "code-dev", "actions", "code-review.md");
    await fs.unlink(actionFile);
    await fs.symlink(commandFile, actionFile);
    expect((await resolveAsdmCommand(root, "code-review", { triggerType: "MENU" })).reason).toBe("action_file_missing");
  });
});
