import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformClient } from "./PlatformClient";

class MemorySecrets {
  values = new Map<string, string>();
  get(key: string) { return Promise.resolve(this.values.get(key)); }
  store(key: string, value: string) { this.values.set(key, value); return Promise.resolve(); }
  delete(key: string) { this.values.delete(key); return Promise.resolve(); }
}

describe("PlatformClient", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("stores only refresh token and sends authoritative environment", async () => {
    const secrets = new MemorySecrets(); secrets.values.set("yantuAssistant.refreshToken", "refresh-1");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ accessToken: "access-1", refreshToken: "refresh-2" }))
      .mockResolvedValueOnce(response({ runKey: "run-1", status: "QUEUED" }, 202));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PlatformClient({ apiBaseUrl: () => "http://localhost/api/v1/", secrets });
    const run = await client.sendMessage("session-1", "hello", "LINUX");
    expect(run.runKey).toBe("run-1");
    expect(secrets.values.get("yantuAssistant.refreshToken")).toBe("refresh-2");
    const request = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(request[0]).toBe("http://localhost/api/v1/agent/sessions/session-1/messages");
    expect(JSON.parse(String(request[1].body))).toEqual({ content: "hello", context: { platform: "CODEBUDDY", osType: "LINUX" } });
  });
  it("refreshes exactly once after 401", async () => {
    const secrets = new MemorySecrets(); secrets.values.set("yantuAssistant.refreshToken", "refresh");
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ accessToken: "expired" })).mockResolvedValueOnce(response({}, 401)).mockResolvedValueOnce(response({ accessToken: "fresh" })).mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", fetchMock); const client = new PlatformClient({ apiBaseUrl: () => "http://localhost/api/v1", secrets });
    await expect(client.sessions()).resolves.toEqual([]); expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it("normalizes nested create response and restores run history", async () => {
    const secrets = new MemorySecrets(); secrets.values.set("yantuAssistant.refreshToken", "refresh");
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ accessToken: "access" })).mockResolvedValueOnce(response({ session: { sessionKey: "session-1", title: "New" }, messages: [], latestRun: null, latestRecommendation: null })).mockResolvedValueOnce(response({ session: { sessionKey: "session-1" }, messages: [{ sequenceNo: 1, role: "USER", content: "hello", runKey: "run-1" }], latestRun: { runKey: "run-1", status: "RUNNING" }, latestRecommendation: { items: [{ skillKey: "tdd" }] } })).mockResolvedValueOnce(response(undefined, 204));
    vi.stubGlobal("fetch", fetchMock); const client = new PlatformClient({ apiBaseUrl: () => "http://localhost/api/v1", secrets });
    await expect(client.createSession("MACOS")).resolves.toMatchObject({ sessionKey: "session-1" });
    await expect(client.session("session-1")).resolves.toMatchObject({ messages: [{ id: "1", runKey: "run-1" }], latestRun: { runKey: "run-1", status: "RUNNING" }, recommendations: [{ skillKey: "tdd" }] });
    await client.cancelRun("run-1"); expect(fetchMock.mock.calls[3]?.[0]).toBe("http://localhost/api/v1/agent/runs/run-1:cancel");
  });
  it("builds verification URL only from server user_code and supports cancellation", async () => {
    const secrets = new MemorySecrets(); const fetchMock = vi.fn().mockResolvedValueOnce(response({ deviceCode: "device", userCode: "ABCD-1234", verificationUri: "https://platform.example/ide/authorize?untrusted=drop", expiresIn: 60, pollInterval: 1 })); vi.stubGlobal("fetch", fetchMock);
    const client = new PlatformClient({ apiBaseUrl: () => "https://platform.example/api/v1", secrets }); const login = await client.beginDeviceLogin();
    expect(login.userCode).toBe("ABCD-1234"); expect(login.verificationUriComplete).toBe("https://platform.example/ide/authorize?user_code=ABCD-1234"); login.cancel(); await expect(login.poll()).rejects.toMatchObject({ name: "AbortError" }); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("validates origin before touching secrets or network", async () => {
    const secrets = new MemorySecrets(); const get = vi.spyOn(secrets, "get"); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); const client = new PlatformClient({ apiBaseUrl: () => "http://evil.example/api", secrets });
    await expect(client.restore()).rejects.toThrow(/HTTPS/); expect(get).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("checks platform skill updates in one request and creates an update bundle", async () => {
    const secrets = new MemorySecrets(); secrets.values.set("yantuAssistant.refreshToken", "refresh");
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ accessToken: "access" })).mockResolvedValueOnce(response({ items: [{ skillKey: "brainstorming", displayName: "头脑风暴", latestVersionId: 42, latestVersion: "2.0.0" }] })).mockResolvedValueOnce(response({ id: 9, status: "AVAILABLE", items: [] }));
    vi.stubGlobal("fetch", fetchMock); const client = new PlatformClient({ apiBaseUrl: () => "http://localhost/api/v1", secrets });
    await expect(client.checkSkillUpdates("MACOS", ["brainstorming"])).resolves.toEqual([{ skillKey: "brainstorming", displayName: "头脑风暴", latestVersionId: 42, latestVersion: "2.0.0" }]);
    await client.createSkillUpdateBundle("MACOS", [42]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost/api/v1/skill-updates:check");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ platform: "CODEBUDDY", osType: "MACOS", skillKeys: ["brainstorming"] });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ platform: "CODEBUDDY", osType: "MACOS", rootVersionIds: [42], includeDependencies: true });
  });
});
function response(body: unknown, status = 200): Response { return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
