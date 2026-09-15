import * as assert from "assert";
import * as vscode from "vscode";

suite("研途助手扩展集成测试", () => {
  test("扩展可发现并激活", async () => {
    const extension = vscode.extensions.getExtension("skill-platform.yantu-assistant");
    assert.ok(extension, "extension should be installed");
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });
  test("Activity Bar 视图命令可执行", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.yantu-assistant");
    assert.ok(true);
  });
  test("不再注册 OpenCode 选区命令", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.strictEqual(commands.includes("opencode.addSelectionToPrompt"), false);
  });
  test("配置项具有本地默认值", () => {
    const config = vscode.workspace.getConfiguration("yantuAssistant");
    assert.strictEqual(config.get("apiBaseUrl"), "http://127.0.0.1:8090/api/v1");
    assert.strictEqual(config.get("webBaseUrl"), "http://127.0.0.1:5173");
  });
});
