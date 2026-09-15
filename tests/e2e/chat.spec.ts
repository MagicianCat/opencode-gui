import { expect, test } from "@playwright/test";

test("renders login and authenticated chat vertical slice", async ({ page }) => {
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    Object.assign(window, { __sent: sent, acquireVsCodeApi: () => ({ postMessage: (message: unknown) => sent.push(message) }) });
  });
  await page.goto("/src/webview/index.html");
  await expect(page.getByText("连接研发助手平台")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "state", authenticated: true, osType: "MACOS", sessions: [], messages: [{ id: "1", role: "assistant", content: "欢迎使用 **研途助手**" }], tools: [{ callId: "1", name: "工具调用", status: "completed" }], recommendations: [{ skillKey: "springboot-tdd", name: "Spring Boot TDD", version: "1.0.0", status: "missing", reason: "适合当前项目" }], running: false, connection: "closed", currentRunKey: "run-1" } })));
  await expect(page.getByText("工具调用")).toHaveCount(0);
  await expect(page.getByText("Spring Boot TDD")).toBeVisible();
  await expect(page.getByText("未安装")).toBeVisible();
  await page.getByPlaceholder("向研途助手提问…").fill("推荐测试 Skill");
  await page.getByRole("button", { name: "发送" }).click();
  const sent = await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent);
  expect(sent).toContainEqual({ type: "send-message", content: "推荐测试 Skill" });
});

test("does not send Enter while an IME composition is active", async ({ page }) => {
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    Object.assign(window, { __sent: sent, acquireVsCodeApi: () => ({ postMessage: (message: unknown) => sent.push(message) }) });
  });
  await page.goto("/src/webview/index.html");
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "state", authenticated: true, osType: "MACOS", sessions: [], messages: [], recommendations: [], running: false, connection: "closed" } })));
  const input = page.getByPlaceholder("向研途助手提问…");
  await input.fill("skill");
  await input.evaluate(element => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(event, "isComposing", { value: true });
    element.dispatchEvent(event);
  });
  expect(await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent)).not.toContainEqual({ type: "send-message", content: "skill" });
  await expect(input).toHaveValue("skill");
  await input.press("Enter");
  expect(await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent)).toContainEqual({ type: "send-message", content: "skill" });
});
