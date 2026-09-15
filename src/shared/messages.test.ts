import { describe, expect, it } from "vitest";
import { parseHostMessage, parseWebviewMessage } from "./messages";
describe("webview protocol", () => {
  it("accepts bounded chat input", () => expect(parseWebviewMessage({ type: "send-message", content: " hello " })).toEqual({ type: "send-message", content: "hello" }));
  it("rejects empty and secret messages", () => { expect(parseWebviewMessage({ type: "send-message", content: " " })).toBeNull(); expect(parseWebviewMessage({ type: "token", accessToken: "secret" })).toBeNull(); });
  it("strips unknown host fields", () => { const state = parseHostMessage({ type: "state", authenticated: false, osType: "MACOS", sessions: [], messages: [], tools: [], recommendations: [], running: false, connection: "idle", accessToken: "secret" }); expect(state && "accessToken" in state).toBe(false); });
  it("accepts a visible pending device code", () => expect(parseHostMessage({ type: "state", authenticated: false, loginPending: true, userCode: "ABCD-1234", osType: "MACOS", sessions: [], messages: [], tools: [], recommendations: [], running: false, connection: "idle" })).toMatchObject({ userCode: "ABCD-1234" }));
});
