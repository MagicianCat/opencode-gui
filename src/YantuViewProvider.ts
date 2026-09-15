import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PlatformClient, type DeviceLogin } from "./platform/PlatformClient";
import { validateServiceBaseUrl } from "./platform/ServiceUrl";
import { SseClient, type SseEvent } from "./transport/SseClient";
import { parseWebviewMessage, type ChatMessage, type HostMessage, type OsType, type Recommendation, type Session, type SkillUpdate, type WebviewMessage } from "./shared/messages";
import { addInstallStatus, compareVersions, scanPlatformSkills, scanSkills, type PlatformSkill } from "./skills/SkillScanner";
import { parseBundleDescriptor, SkillInstaller } from "./skills/SkillInstaller";
import { getLogger, machineSetting } from "./extension";
import { SerialTaskQueue } from "./utils/SerialTaskQueue";

interface ViewState { authenticated: boolean; loginPending?: boolean; userCode?: string; osType: OsType; sessions: Session[]; currentSessionKey?: string; currentRunKey?: string; messages: ChatMessage[]; recommendations: Recommendation[]; skillUpdates: SkillUpdate[]; updatesChecking: boolean; updatesInstalling: boolean; updateError?: string; running: boolean; connection: "idle" | "connecting" | "connected" | "reconnecting" | "closed"; error?: string; }
interface UpdateCandidate extends SkillUpdate { versionIds: number[]; targets: Array<{ directory: string; scope: "project" | "global" }>; }

export class YantuViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "yantu-assistant.chatView";
  private view?: vscode.WebviewView; private sse?: SseClient; private loginAttempt?: DeviceLogin; private disposed = false; private readonly installer = new SkillInstaller(); private readonly eventQueue = new SerialTaskQueue(error => this.fail(error));
  private state: ViewState = { authenticated: false, osType: detectOs(), sessions: [], messages: [], recommendations: [], skillUpdates: [], updatesChecking: false, updatesInstalling: false, running: false, connection: "idle" };
  private updateCandidates: UpdateCandidate[] = [];
  constructor(private readonly extensionUri: vscode.Uri, private readonly client: PlatformClient) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view; view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out")] }; view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async data => { const message = parseWebviewMessage(data); if (!message) return; try { await this.handle(message); } catch (error) { this.fail(error); } });
  }
  dispose(): void { this.disposed = true; this.loginAttempt?.cancel(); this.sse?.close(); }

  private async handle(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready": case "refresh": await this.bootstrap(); break;
      case "login": await this.login(); break;
      case "logout": this.loginAttempt?.cancel(); this.sse?.close(); await this.client.logout(); this.updateCandidates = []; this.state = { ...this.state, authenticated: false, loginPending: false, userCode: undefined, sessions: [], messages: [], recommendations: [], skillUpdates: [], updatesChecking: false, updatesInstalling: false, running: false, currentRunKey: undefined, currentSessionKey: undefined }; this.sendState(); break;
      case "new-session": await this.newSession(); break;
      case "select-session": await this.selectSession(message.sessionKey); break;
      case "delete-session": await this.client.deleteSession(message.sessionKey); await this.bootstrap(); break;
      case "send-message": await this.sendMessage(message.content); break;
      case "cancel-run": if (this.state.currentRunKey) await this.client.cancelRun(this.state.currentRunKey); break;
      case "install-skill": await this.install(message.runKey, [message.skillKey]); break;
      case "install-all": await this.install(message.runKey, [...new Set(this.state.recommendations.filter(item => item.status === "missing" || item.status === "update").map(item => item.skillKey))]); break;
      case "open-detail": await this.openDetail(message.detailPath); break;
      case "install-updates": await this.installUpdates(message.skillKeys); break;
      case "dismiss-updates": this.updateCandidates = []; this.state.skillUpdates = []; this.state.updateError = undefined; this.sendState(); break;
      case "retry-updates": await this.checkSkillUpdates(); break;
    }
  }
  private async bootstrap(): Promise<void> {
    this.state.authenticated = await this.client.restore(); this.state.error = undefined;
    if (this.state.authenticated) { this.state.sessions = await this.client.sessions(); if (this.state.currentSessionKey && this.state.sessions.some(item => item.sessionKey === this.state.currentSessionKey)) await this.selectSession(this.state.currentSessionKey); }
    this.sendState();
    if (this.state.authenticated && (!this.state.currentSessionKey || this.state.messages.length === 0)) void this.checkSkillUpdates();
  }
  private async login(): Promise<void> {
    this.loginAttempt?.cancel(); const login = await this.client.beginDeviceLogin(); this.loginAttempt = login; this.state.loginPending = true; this.state.userCode = login.userCode; this.state.error = undefined; this.sendState(); await vscode.env.openExternal(vscode.Uri.parse(login.verificationUriComplete)); this.notice("info", "已在浏览器打开登录页面，请核对设备码");
    try { await login.poll(); if (!this.disposed) await this.bootstrap(); } catch (error) { if (!(error instanceof Error && error.name === "AbortError") && !this.disposed) throw error; } finally { if (this.loginAttempt === login) { this.loginAttempt = undefined; this.state.loginPending = false; this.state.userCode = undefined; if (!this.disposed) this.sendState(); } }
  }
  private async newSession(): Promise<void> { const session = await this.client.createSession(this.state.osType); this.sse?.close(); this.updateCandidates = []; this.state.sessions = [session, ...this.state.sessions]; this.state.currentSessionKey = session.sessionKey; this.state.messages = []; this.state.recommendations = []; this.state.skillUpdates = []; this.state.updateError = undefined; this.state.updatesChecking = false; this.sendState(); void this.checkSkillUpdates(); }
  private async selectSession(key: string): Promise<void> { this.sse?.close(); this.updateCandidates = []; this.state.skillUpdates = []; this.state.updateError = undefined; const detail = await this.client.session(key); this.state.currentSessionKey = key; this.state.messages = detail.messages; this.state.currentRunKey = detail.latestRun?.runKey ?? [...detail.messages].reverse().find(message => message.runKey)?.runKey; this.state.recommendations = addInstallStatus(detail.recommendations.map(normalizeRecommendation).filter((item): item is Recommendation => item !== null), await scanSkills(this.projectRoot())); this.state.running = detail.latestRun ? ["PENDING", "RUNNING"].includes(detail.latestRun.status) : false; this.state.connection = this.state.running ? "connecting" : "idle"; this.sendState(); if (this.state.running && this.state.currentRunKey) await this.connectRun(this.state.currentRunKey); if (!detail.messages.length) void this.checkSkillUpdates(); }
  private async sendMessage(content: string): Promise<void> {
    if (!this.state.currentSessionKey) await this.newSession(); const sessionKey = this.state.currentSessionKey; if (!sessionKey) return;
    this.state.messages.push({ id: `local-${Date.now()}`, role: "user", content }); this.state.running = true; this.state.error = undefined; this.sendState();
    const run = await this.client.sendMessage(sessionKey, content, this.state.osType); this.state.currentRunKey = run.runKey; await this.connectRun(run.runKey);
  }
  private async connectRun(runKey: string): Promise<void> {
    this.sse?.close(); const headers = await this.client.authorizationHeader();
    this.sse = new SseClient(this.client.runEventsUrl(runKey), { headers, onUnauthorized: () => this.client.refreshAuthorizationHeader(), onEvent: event => this.eventQueue.enqueue(() => this.onEvent(event)), onStateChange: state => { this.state.connection = state.status; this.sendState(); }, onError: error => this.fail(error), logger: getLogger() }); this.sse.connect();
  }
  private async onEvent(event: SseEvent): Promise<void> {
    let payload: Record<string, unknown>; try { const parsed: unknown = JSON.parse(event.data); payload = record(parsed); } catch { return; }
    const type = event.event ?? string(payload.type) ?? string(payload.eventType); const data = record(payload.data ?? payload.payload ?? payload);
    if (type === "message.delta") { const delta = string(data.delta) ?? string(data.content) ?? string(data.text) ?? ""; let assistant = this.state.messages.at(-1); if (!assistant || assistant.role !== "assistant") { assistant = { id: string(data.messageKey) ?? `assistant-${Date.now()}`, role: "assistant", content: "" }; this.state.messages.push(assistant); } assistant.content += delta; }
    else if (type === "tool.started" || type === "tool.completed" || type === "tool.failed") { return; }
    else if (type === "recommendation.completed") { const raw = Array.isArray(data.items) ? data.items : Array.isArray(payload.items) ? payload.items : []; const recommendations = raw.map(normalizeRecommendation).filter((item): item is Recommendation => item !== null); const local = await scanSkills(this.projectRoot()); this.state.recommendations = [...this.state.recommendations, ...addInstallStatus(recommendations, local)]; }
    if (["run.completed", "run.failed", "run.cancelled", "done"].includes(type ?? "")) { this.state.running = false; this.state.connection = "closed"; this.sse?.close(); }
    this.sendState();
  }
  private async install(runKey: string, skillKeys: string[]): Promise<void> {
    if (!skillKeys.length) { this.notice("info", "没有需要安装的 Skill"); return; }
    const scope = await vscode.window.showQuickPick(this.projectRoot() ? [{ label: "项目", description: "安装到当前项目 .codebuddy/skills", value: "project" }, { label: "全局", description: "安装到用户目录 ~/.codebuddy/skills", value: "global" }] : [{ label: "全局", description: "当前未打开项目", value: "global" }], { placeHolder: "选择 Skill 安装位置" }); if (!scope) return;
    const root = scope.value === "project" ? await this.chooseProjectRoot() : os.homedir(); if (!root) return; const directory = path.join(root, ".codebuddy", "skills");
    const existing = skillKeys.filter(key => existsSync(path.join(directory, key))); if (existing.length) { const answer = await vscode.window.showWarningMessage(`以下 Skill 已存在，将被覆盖：${existing.join("、")}`, { modal: true }, "确认覆盖"); if (answer !== "确认覆盖") return; }
    const confirmed = await vscode.window.showInformationMessage(`安装 ${skillKeys.join("、")} 到 ${directory}？依赖项也会一并安装。`, { modal: true }, "安装"); if (confirmed !== "安装") return;
    const metadata = await this.client.createBundle(runKey, this.state.osType, skillKeys); const status = string(metadata.resultStatus) ?? string(metadata.status); const failures = Array.isArray(metadata.failures) ? metadata.failures.map(failureMessage).filter(Boolean) : []; if (status === "FAILED" || status === "BUILDING") throw new Error(status === "BUILDING" ? "Bundle 尚未生成完成" : `Bundle 生成失败${failures.length ? `：${failures.join("；")}` : ""}`); if (status && !["AVAILABLE", "COMPLETE", "PARTIAL"].includes(status)) throw new Error(`不支持的 Bundle 状态：${status}`); if (failures.length) this.notice("error", `部分 Skill 无法打包：${failures.join("；")}`); const descriptor = parseBundleDescriptor(metadata); if (!descriptor.items.length) throw new Error("Bundle 没有可安装项"); const id = metadata.id ?? metadata.bundleId; if (typeof id !== "number" && typeof id !== "string") throw new Error("Bundle 缺少下载 ID"); const bundle = await this.client.downloadBundle(id); const installed = await this.installer.install(bundle, descriptor, directory); this.notice("info", `已安装：${installed.join("、")}`); this.state.recommendations = addInstallStatus(this.state.recommendations, await scanSkills(this.projectRoot())); this.sendState();
  }
  private async checkSkillUpdates(): Promise<void> {
    if (!this.state.authenticated || this.state.updatesInstalling) return;
    this.state.updatesChecking = true; this.state.updateError = undefined; this.sendState();
    try {
      const local = await scanPlatformSkills(this.projectRoot());
      if (!local.length) { this.updateCandidates = []; this.state.skillUpdates = []; return; }
      const latest = await this.client.checkSkillUpdates(this.state.osType, [...new Set(local.map(item => item.skillKey))]);
      const byKey = new Map(latest.map(item => [item.skillKey, item]));
      const grouped = new Map<string, UpdateCandidate>();
      const localByKey = new Map<string, PlatformSkill[]>();
      for (const item of local) localByKey.set(item.skillKey, [...(localByKey.get(item.skillKey) ?? []), item]);
      for (const [skillKey, installed] of localByKey) {
        const remote = byKey.get(skillKey); if (!remote || !installed.some(item => !isCurrent(item, remote.latestVersion, remote.latestVersionId))) continue;
        // Once a Skill is stale, keep all of its platform-marked locations bound to one card.
        grouped.set(skillKey, { skillKey, name: remote.displayName, localVersion: installed.map(item => item.version).sort(compareVersions)[0] ?? "", latestVersion: remote.latestVersion, latestVersionId: remote.latestVersionId, scopes: [...new Set(installed.map(item => item.scope))], versionIds: [remote.latestVersionId], targets: installed.map(item => ({ directory: item.directory, scope: item.scope })) });
      }
      this.updateCandidates = [...grouped.values()]; this.state.skillUpdates = this.updateCandidates.map(toPublicUpdate); this.state.updatesChecking = false; this.sendState();
    } catch (error) { this.state.updatesChecking = false; this.state.updateError = error instanceof Error ? error.message : String(error); this.sendState(); }
    finally { this.state.updatesChecking = false; this.sendState(); }
  }
  private async installUpdates(skillKeys: string[]): Promise<void> {
    const selected = this.updateCandidates.filter(item => skillKeys.includes(item.skillKey)); if (!selected.length) return;
    this.state.updatesInstalling = true; this.state.updateError = undefined; this.sendState();
    try {
      const targets = new Map<string, { directory: string; candidates: UpdateCandidate[] }>();
      for (const candidate of selected) for (const target of candidate.targets) { const directory = path.dirname(target.directory); const current = targets.get(directory) ?? { directory, candidates: [] }; if (!current.candidates.includes(candidate)) current.candidates.push(candidate); targets.set(directory, current); }
      const bundleCache = new Map<string, { bytes: Buffer; descriptor: ReturnType<typeof parseBundleDescriptor> }>();
      for (const target of targets.values()) {
        const ids = target.candidates.map(item => item.latestVersionId);
        for (let offset = 0; offset < ids.length; offset += 50) {
          const chunk = ids.slice(offset, offset + 50); const cacheKey = chunk.join(","); let bundle = bundleCache.get(cacheKey);
          if (!bundle) { const metadata = await this.client.createSkillUpdateBundle(this.state.osType, chunk); const descriptor = parseBundleDescriptor(metadata); if (!descriptor.items.length) throw new Error("更新 Bundle 没有可安装项"); const status = string(metadata.resultStatus) ?? string(metadata.status); if (status === "FAILED" || status === "BUILDING") throw new Error(status === "BUILDING" ? "更新 Bundle 尚未生成完成" : "更新 Bundle 生成失败"); const id = metadata.id ?? metadata.bundleId; if (typeof id !== "number" && typeof id !== "string") throw new Error("更新 Bundle 缺少下载 ID"); bundle = { bytes: await this.client.downloadBundle(id), descriptor }; bundleCache.set(cacheKey, bundle); }
          const { bytes, descriptor } = bundle;
          const collisions = await this.unmarkedCollisions(descriptor.items.map(item => item.skillKey), target.directory); if (collisions.length) { const answer = await vscode.window.showWarningMessage(`目标目录存在非平台安装的 Skill，将被覆盖：${collisions.join("、")}`, { modal: true }, "确认覆盖"); if (answer !== "确认覆盖") continue; }
          await this.installer.install(bytes, descriptor, target.directory); 
        }
      }
      this.notice("info", `已更新 ${selected.map(item => item.skillKey).join("、")}`); this.state.updatesInstalling = false; await this.checkSkillUpdates();
    } catch (error) { this.state.updateError = error instanceof Error ? error.message : String(error); this.sendState(); this.notice("error", this.state.updateError); }
    finally { this.state.updatesInstalling = false; this.sendState(); }
  }
  private async unmarkedCollisions(skillKeys: string[], directory: string): Promise<string[]> { const collisions: string[] = []; for (const key of skillKeys) { const target = path.join(directory, key); if (!existsSync(target)) continue; try { const marker = JSON.parse(readFileSync(path.join(target, ".yantu-platform-skill.json"), "utf8")) as Record<string, unknown>; if (marker.source === "yantu-platform") continue; } catch { /* no marker */ } collisions.push(key); } return collisions; }
  private projectRoot(): string | undefined { const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri); return active?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }
  private async chooseProjectRoot(): Promise<string | undefined> { const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri); if (active) return active.uri.fsPath; const folders = vscode.workspace.workspaceFolders ?? []; if (folders.length <= 1) return folders[0]?.uri.fsPath; const picked = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, value: folder.uri.fsPath })), { placeHolder: "选择要安装 Skill 的工作区" }); return picked?.value; }
  private webBaseUrl(): string { return validateServiceBaseUrl(machineSetting("webBaseUrl", "http://127.0.0.1:5173")).toString(); }
  private async openDetail(detailPath: string): Promise<void> { const base = new URL(this.webBaseUrl()); const target = new URL(detailPath, base); if (target.origin !== base.origin) throw new Error("Skill 详情链接不属于已配置的平台地址"); await vscode.env.openExternal(vscode.Uri.parse(target.toString())); }
  private fail(error: unknown): void { const message = error instanceof Error ? error.message : String(error); getLogger().error(message); this.state.error = message; this.state.running = false; this.sendState(); this.notice("error", message); }
  private notice(level: "info" | "error", message: string): void { void this.post({ type: "notice", level, message }); }
  private sendState(): void { void this.post({ type: "state", ...this.state }); }
  private post(message: HostMessage): Thenable<boolean> | undefined { return this.view?.webview.postMessage(message); }
  private html(webview: vscode.Webview): string { const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "main.js")); const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "main.css")); const nonce = randomBytes(16).toString("base64"); return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link href="${style}" rel="stylesheet"><title>研途助手</title></head><body><div id="root"></div><script type="module" nonce="${nonce}" src="${script}"></script></body></html>`; }
}
function detectOs(): OsType { return process.platform === "win32" ? "WINDOWS" : process.platform === "darwin" ? "MACOS" : "LINUX"; }
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function normalizeRecommendation(value: unknown): Recommendation | null { const item = record(value); const skillKey = string(item.skillKey) ?? string(item.key); if (!skillKey) return null; return { skillKey, name: string(item.name), description: string(item.description), version: string(item.version), versionId: typeof item.versionId === "number" ? item.versionId : undefined, reason: string(item.reason), detailPath: string(item.detailPath), status: "missing" }; }
function failureMessage(value: unknown): string { const failure = record(value); const key = string(failure.skillKey); const message = string(failure.message) ?? string(failure.reason) ?? string(failure.errorMessage); return [key, message].filter(Boolean).join(": "); }
function isCurrent(local: PlatformSkill, latestVersion: string, latestVersionId: number): boolean { if (local.skillVersionId !== undefined && local.skillVersionId === latestVersionId) return true; return compareVersions(local.version, latestVersion) >= 0; }
function toPublicUpdate(candidate: UpdateCandidate): SkillUpdate { return { skillKey: candidate.skillKey, name: candidate.name, localVersion: candidate.localVersion, latestVersion: candidate.latestVersion, latestVersionId: candidate.latestVersionId, scopes: candidate.scopes, installing: false }; }
