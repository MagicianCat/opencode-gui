import { createHash, randomBytes } from "node:crypto";
import type * as vscode from "vscode";
import { z } from "zod/v4";
import type { OsType, Session } from "../shared/messages";
import { validateServiceBaseUrl } from "./ServiceUrl";
import type { SkillUsageMetadata } from "../telemetry/TelemetryQueue";

const TOKEN_KEY = "yantuAssistant.refreshToken";
const TokenSchema = z.object({ accessToken: z.string(), refreshToken: z.string().optional() }).passthrough();
const DeviceSchema = z.object({ deviceCode: z.string(), userCode: z.string(), verificationUri: z.string().url(), expiresIn: z.number().positive(), pollInterval: z.number().positive().optional().default(3) }).passthrough();
const RunSchema = z.object({ runKey: z.string(), status: z.string().optional(), platform: z.string().optional(), osType: z.string().optional() }).passthrough();

export interface PlatformClientOptions {
  apiBaseUrl: () => string;
  secrets: Pick<vscode.SecretStorage, "get" | "store" | "delete">;
}
export interface SessionDetail {
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; runKey?: string; createdAt?: string }>;
  latestRun?: { runKey: string; status: string };
  recommendations: unknown[];
}
export interface DeviceLogin { userCode: string; verificationUriComplete: string; poll: () => Promise<void>; cancel: () => void; }
export interface SkillUpdateResult { skillKey: string; displayName?: string; latestVersionId: number; latestVersion: string; }

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export class PlatformClient {
  private accessToken?: string;
  constructor(private readonly options: PlatformClientOptions) {}

  async restore(): Promise<boolean> {
    this.baseUrl();
    if (this.accessToken) return true;
    const refreshToken = await this.options.secrets.get(TOKEN_KEY);
    if (!refreshToken) return false;
    try { await this.refresh(refreshToken); return true; } catch { await this.logout(); return false; }
  }

  async beginDeviceLogin(): Promise<DeviceLogin> {
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const device = DeviceSchema.parse(await this.requestRaw("/auth/ide/authorizations", { method: "POST", body: JSON.stringify({ clientName: "CodeBuddy IDE / 研途助手", codeChallenge: challenge, codeChallengeMethod: "S256" }) }));
    const controller = new AbortController(); const verification = new URL(device.verificationUri); verification.search = ""; verification.searchParams.set("user_code", device.userCode);
    return {
      userCode: device.userCode,
      verificationUriComplete: verification.toString(),
      cancel: () => controller.abort(),
      poll: async () => {
        const deadline = Date.now() + device.expiresIn * 1000;
        while (Date.now() < deadline) {
          if (controller.signal.aborted) throw abortError();
          const response = await fetch(this.url("/auth/ide/token"), { ...this.jsonInit("POST", { deviceCode: device.deviceCode, codeVerifier: verifier }), signal: controller.signal });
          if (response.status === 202 || response.status === 428) { await delay(device.pollInterval * 1000, controller.signal); continue; }
          if (!response.ok) throw await toHttpError(response);
          await this.acceptTokens(TokenSchema.parse(await response.json()));
          return;
        }
        throw new Error("登录授权已过期，请重试");
      },
    };
  }

  async logout(): Promise<void> {
    this.baseUrl();
    const refreshToken = await this.options.secrets.get(TOKEN_KEY);
    if (refreshToken) {
      try { await this.requestRaw("/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken }) }); } catch { /* local logout still succeeds */ }
    }
    this.accessToken = undefined;
    await this.options.secrets.delete(TOKEN_KEY);
  }

  async sessions(): Promise<Session[]> {
    const value = await this.request("/agent/sessions");
    const records = Array.isArray(value) ? value : readArray(value, "content", "items", "records");
    return records.map(normalizeSession).filter((item): item is Session => item !== null);
  }

  async session(sessionKey: string): Promise<SessionDetail> {
    const value = asRecord(await this.request(`/agent/sessions/${encodeURIComponent(sessionKey)}`));
    const messages = readArray(value, "messages").map(normalizeMessage).filter((item): item is NonNullable<ReturnType<typeof normalizeMessage>> => item !== null);
    const latest = asRecord(value.latestRun); const latestRun = typeof latest.runKey === "string" && typeof latest.status === "string" ? { runKey: latest.runKey, status: latest.status } : undefined;
    const latestRecommendation = asRecord(value.latestRecommendation); const fromLatest = readArray(latestRecommendation, "items").map(item => ({ ...asRecord(item), runKey: latestRun?.runKey }));
    const fromMessages = readArray(value, "messages").flatMap(message => { const row = asRecord(message); const runKey = typeof row.runKey === "string" ? row.runKey : undefined; return readArray(row.recommendation, "items").map(item => ({ ...asRecord(item), runKey })); });
    return { messages, latestRun, recommendations: fromMessages.length ? fromMessages : fromLatest };
  }

  async createSession(osType: OsType): Promise<Session> {
    const value = await this.request("/agent/sessions", { method: "POST", body: JSON.stringify({ profileKey: "skill-advisor", context: { platform: "CODEBUDDY", osType } }) });
    const session = normalizeSession(asRecord(value).session ?? value);
    if (!session) throw new Error("平台返回了无效的会话");
    return session;
  }

  async deleteSession(sessionKey: string): Promise<void> { await this.request(`/agent/sessions/${encodeURIComponent(sessionKey)}`, { method: "DELETE" }); }

  async sendMessage(sessionKey: string, content: string, osType: OsType): Promise<z.infer<typeof RunSchema>> {
    return RunSchema.parse(await this.request(`/agent/sessions/${encodeURIComponent(sessionKey)}/messages`, { method: "POST", body: JSON.stringify({ content, context: { platform: "CODEBUDDY", osType } }) }));
  }

  async cancelRun(runKey: string): Promise<void> { await this.request(`/agent/runs/${encodeURIComponent(runKey)}:cancel`, { method: "POST" }); }
  async recordSkillUsage(metadata: SkillUsageMetadata): Promise<void> {
    const { conversationFile: _conversationFile, transcriptPath: _transcriptPath, messageIds: _messageIds, ...body } = metadata;
    await this.request("/telemetry/skill-usage-events", { method: "POST", headers: { "Idempotency-Key": metadata.eventId }, body: JSON.stringify(body) });
  }
  async recordGeneration(payload: Record<string, unknown>): Promise<void> {
    await this.request("/telemetry/generations", { method: "POST", body: JSON.stringify(payload) });
  }
  async uploadSkillUsageConversation(eventId: string, compressed: Buffer): Promise<void> {
    await this.authorizedFetch(`/telemetry/skill-usage-events/${encodeURIComponent(eventId)}/conversation`, { method: "PUT", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: compressed as unknown as BodyInit });
  }
  async createBundle(runKey: string, osType: OsType, skillKeys: string[]): Promise<Record<string, unknown>> {
    return asRecord(await this.request(`/agent/runs/${encodeURIComponent(runKey)}/bundle`, { method: "POST", body: JSON.stringify({ platform: "CODEBUDDY", osType, skillKeys }) }));
  }
  async checkSkillUpdates(osType: OsType, skillKeys: string[]): Promise<SkillUpdateResult[]> {
    const value = asRecord(await this.request("/skill-updates:check", { method: "POST", body: JSON.stringify({ platform: "CODEBUDDY", osType, skillKeys }) }));
    return readArray(value, "items").map(item => { const row = asRecord(item); return { skillKey: String(row.skillKey ?? ""), displayName: typeof row.displayName === "string" ? row.displayName : undefined, latestVersionId: Number(row.latestVersionId), latestVersion: String(row.latestVersion ?? "") }; }).filter(item => item.skillKey && Number.isFinite(item.latestVersionId) && item.latestVersion);
  }
  async createSkillUpdateBundle(osType: OsType, rootVersionIds: number[]): Promise<Record<string, unknown>> {
    return asRecord(await this.request("/bundles", { method: "POST", body: JSON.stringify({ platform: "CODEBUDDY", osType, rootVersionIds, includeDependencies: true }) }));
  }
  async downloadBundle(id: string | number): Promise<Buffer> {
    const response = await this.authorizedFetch(`/bundles/${encodeURIComponent(String(id))}/download`, {}, true);
    return Buffer.from(await response.arrayBuffer());
  }
  async authorizationHeader(): Promise<Record<string, string>> {
    this.baseUrl();
    if (!this.accessToken && !(await this.restore())) throw new HttpError(401, "未登录");
    return { Authorization: `Bearer ${this.accessToken}` };
  }
  async refreshAuthorizationHeader(): Promise<Record<string, string>> {
    this.baseUrl();
    const refreshToken = await this.options.secrets.get(TOKEN_KEY);
    if (!refreshToken) throw new HttpError(401, "登录已失效");
    await this.refresh(refreshToken);
    return this.authorizationHeader();
  }
  runEventsUrl(runKey: string): string { return this.url(`/agent/runs/${encodeURIComponent(runKey)}/events`); }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.authorizedFetch(path, init);
    if (response.status === 204) return undefined;
    return response.json();
  }
  private async authorizedFetch(path: string, init: RequestInit, binary = false): Promise<Response> {
    if (!this.accessToken && !(await this.restore())) throw new HttpError(401, "未登录");
    let response = await fetch(this.url(path), this.withAuth(init));
    if (response.status === 401) {
      const token = await this.options.secrets.get(TOKEN_KEY);
      if (!token) throw await toHttpError(response);
      await this.refresh(token);
      response = await fetch(this.url(path), this.withAuth(init));
    }
    if (!response.ok) throw await toHttpError(response);
    if (binary) return response;
    return response;
  }
  private async refresh(refreshToken: string): Promise<void> {
    const tokens = TokenSchema.parse(await this.requestRaw("/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) }));
    await this.acceptTokens(tokens, refreshToken);
  }
  private async acceptTokens(tokens: z.infer<typeof TokenSchema>, fallback?: string): Promise<void> {
    this.accessToken = tokens.accessToken;
    const refreshToken = tokens.refreshToken ?? fallback;
    if (refreshToken) await this.options.secrets.store(TOKEN_KEY, refreshToken);
  }
  private async requestRaw(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(this.url(path), { ...this.jsonInit(init.method ?? "GET"), ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
    if (!response.ok) throw await toHttpError(response);
    return response.status === 204 ? undefined : response.json();
  }
  private withAuth(init: RequestInit): RequestInit { return { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}), Authorization: `Bearer ${this.accessToken}` } }; }
  private jsonInit(method: string, body?: unknown): RequestInit { return { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }; }
  private baseUrl(): URL { return validateServiceBaseUrl(this.options.apiBaseUrl()); }
  private url(path: string): string { return `${this.baseUrl().toString().replace(/\/$/, "")}${path}`; }
}

function asRecord(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function readArray(value: unknown, ...keys: string[]): unknown[] { const record = asRecord(value); for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[]; return []; }
function normalizeSession(value: unknown): Session | null { const r = asRecord(value); const key = r.sessionKey ?? r.key ?? r.id; if (typeof key !== "string") return null; return { ...r, sessionKey: key, title: typeof r.title === "string" ? r.title : "新对话", createdAt: typeof r.createdAt === "string" ? r.createdAt : undefined, updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : undefined } as Session; }
function normalizeMessage(value: unknown): { id: string; role: "user" | "assistant"; content: string; runKey?: string; createdAt?: string } | null { const r = asRecord(value); const id = r.messageKey ?? r.id ?? r.sequenceNo ?? r.sequence; const rawRole = r.role ?? r.senderType; const role = rawRole === "USER" || rawRole === "user" ? "user" : rawRole === "ASSISTANT" || rawRole === "assistant" ? "assistant" : null; const content = r.content ?? r.text; if ((typeof id !== "string" && postsafe(id) === undefined) || !role || typeof content !== "string") return null; return { id: typeof id === "string" ? id : String(id), role, content, runKey: typeof r.runKey === "string" ? r.runKey : undefined, createdAt: typeof r.createdAt === "string" ? r.createdAt : undefined }; }
function postsafe(value: unknown): string | undefined { return typeof value === "number" ? String(value) : undefined; }
async function toHttpError(response: Response): Promise<HttpError> { let message = `${response.status} ${response.statusText}`; try { const body = asRecord(await response.json()); message = String(body.message ?? body.error ?? message); } catch { /* use status */ } return new HttpError(response.status, message); }
function delay(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(abortError()); }, { once: true }); }); }
function abortError(): Error { const error = new Error("登录已取消"); error.name = "AbortError"; return error; }
