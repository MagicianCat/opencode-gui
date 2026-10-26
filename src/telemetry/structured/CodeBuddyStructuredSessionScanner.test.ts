import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { CodeBuddyStructuredSessionScanner } from "./CodeBuddyStructuredSessionScanner";
import { CodeBuddyLogSkillMonitor } from "../CodeBuddyLogSkillMonitor";
import { TelemetryQueue } from "../TelemetryQueue";
import { GenerationStateStore } from "../generation/GenerationStateStore";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-structured-")); roots.push(root);
  const home = path.join(root, "home");
  const local = path.join(root, "local");
  const native = path.join(local, "CodeBuddyExtension", "Data", "native-install", "CodeBuddyIDE", "native-install");
  const session = path.join(native, "history", "workspace-hash", "conversation-1");
  const tree = path.join(native, "file-tree", "workspace-hash", "conversation-1", "file-tree.json");
  await fs.mkdir(path.join(session, "messages"), { recursive: true });
  await fs.mkdir(path.dirname(tree), { recursive: true });
  return { root, home, local, native, session, tree };
}

describe("CodeBuddy structured session", () => {
  it("reuses a legacy event id during backfill instead of recording a second Skill call", async () => {
    const { home, local, session } = await fixture();
    const marker = path.join(home, ".codebuddy", "skills", "code-review");
    await fs.mkdir(marker, { recursive: true });
    await fs.writeFile(path.join(marker, ".yantu-platform-skill.json"), JSON.stringify({ source: "yantu-platform", skillKey: "code-review" }));
    await fs.writeFile(path.join(session, "index.json"), JSON.stringify({ requests: [{ id: "request-legacy",
      startedAt: 1792977000000, state: "complete", messages: ["msg-legacy"] }] }));
    await fs.writeFile(path.join(session, "messages", "msg-legacy.json"), JSON.stringify({ createdAt: 1792977001000,
      extra: { requestId: "request-legacy" },
      message: { toolName: "use_skill", toolCallId: "call-legacy", args: { command: "code-review" } } }));
    const telemetryRoot = path.join(home, ".codebuddy", "yantu-assistant", "telemetry");
    await fs.mkdir(path.join(telemetryRoot, "diagnostics"), { recursive: true });
    await fs.writeFile(path.join(telemetryRoot, "codebuddy-log-monitor-state.json"), JSON.stringify({ offsets: {}, seenCallIds: ["call-legacy"] }));
    const legacyEventId = "11111111-2222-4333-8444-555555555555";
    await fs.writeFile(path.join(telemetryRoot, "diagnostics", "codebuddy-log-monitor.jsonl"),
      JSON.stringify({ event: "captured", callId: "call-legacy", eventId: legacyEventId }) + "\n");
    const queue = new TelemetryQueue(home);
    const monitor = new CodeBuddyLogSkillMonitor(console, { homeDirectory: home, localAppDataDirectory: local,
      logRoots: [], queue, generationStore: new GenerationStateStore(home), structuredPollIntervalMs: 0,
      now: () => new Date("2026-10-26T12:00:00Z") });
    await monitor.poll();
    const files = await queue.pendingMetadata();
    expect(files).toHaveLength(1);
    expect((await queue.readMetadata(files[0]!)).eventId).toBe(legacyEventId);
  });

  it("recognizes a project-installed Skill from the active workspace when the log is unavailable", async () => {
    const { root, home, local, native, session } = await fixture();
    const project = path.join(root, "project");
    const workspaceHash = createHash("md5").update(project.replace(/\//g, "\\")).digest("hex");
    const projectSession = path.join(native, "history", workspaceHash, "conversation-1");
    await fs.rename(path.dirname(session), path.dirname(projectSession));
    const marker = path.join(project, ".codebuddy", "skills", "security-review");
    await fs.mkdir(marker, { recursive: true });
    await fs.writeFile(path.join(marker, ".yantu-platform-skill.json"), JSON.stringify({
      source: "yantu-platform", skillKey: "security-review", skillVersionId: 247,
    }));
    await fs.writeFile(path.join(projectSession, "index.json"), JSON.stringify({ requests: [{ id: "request-project",
      startedAt: new Date("2026-10-26T11:30:00Z").getTime(), state: "complete", messages: ["msg-project"] }] }));
    await fs.writeFile(path.join(projectSession, "messages", "msg-project.json"), JSON.stringify({
      createdAt: new Date("2026-10-26T11:30:05Z").getTime(), extra: { requestId: "request-project" },
      message: { toolName: "use_skill", toolCallId: "call-project", args: { command: "security-review" } },
    }));
    const queue = new TelemetryQueue(home);
    const monitor = new CodeBuddyLogSkillMonitor(console, { homeDirectory: home, localAppDataDirectory: local,
      logRoots: [], activeWorkspaceDirectory: project, queue, generationStore: new GenerationStateStore(home),
      structuredPollIntervalMs: 0, now: () => new Date("2026-10-26T12:00:00Z") });
    await monitor.poll();
    const files = await queue.pendingMetadata();
    expect(files).toHaveLength(1);
    expect(await queue.readMetadata(files[0]!)).toMatchObject({ skillKey: "security-review", localDirectory: project });
  });

  it("retries a partially written index and records a turn without a platform Skill", async () => {
    const { home, local, session, tree } = await fixture();
    const index = path.join(session, "index.json");
    await fs.writeFile(index, '{"requests":[');
    const scanner = new CodeBuddyStructuredSessionScanner({ homeDirectory: home, localAppDataDirectory: local,
      now: () => new Date("2026-10-26T12:00:00Z") });
    expect(await scanner.scan()).toHaveLength(0);
    await scanner.commit();
    await fs.writeFile(index, JSON.stringify({ requests: [{ id: "request-no-skill", startedAt: 1792977000000,
      state: "complete", messages: ["msg-late"], usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }] }));
    const queue = new TelemetryQueue(home);
    const monitor = new CodeBuddyLogSkillMonitor(console, { homeDirectory: home, localAppDataDirectory: local,
      logRoots: [], queue, generationStore: new GenerationStateStore(home), structuredPollIntervalMs: 0,
      now: () => new Date("2026-10-26T12:00:00Z") });
    await monitor.poll();
    const state = await new GenerationStateStore(home).load("log-request-no-skill");
    expect(state).toMatchObject({ status: "COMPLETED", captureQuality: "STRUCTURED", skillInvocations: [] });
    expect(state?.usage?.totalTokens).toBe(12);
    expect(await queue.pendingMetadata()).toHaveLength(0);
    await fs.writeFile(path.join(session, "messages", "msg-late.json"), JSON.stringify({
      createdAt: 1792977004000, role: "assistant", message: "Done",
      extra: { requestId: "request-no-skill", modelId: "glm-5.3" },
    }));
    await monitor.poll();
    expect(await new GenerationStateStore(home).load("log-request-no-skill")).toMatchObject({ modelId: "glm-5.3" });
    await fs.writeFile(tree, JSON.stringify([{ filePath: "D:/repo/A.java", versions: [{ versionId: "late-v1",
      metadata: { requestId: "request-no-skill", toolCallId: "call-late" },
      diff: { addedLines: 7, removedLines: 2 } }] }]));
    await monitor.poll();
    expect(await new GenerationStateStore(home).load("log-request-no-skill")).toMatchObject({
      codeSource: "FILE_TREE_REQUEST_DIFF", fileDiffs: [expect.objectContaining({ linesAdded: 7, linesDeleted: 2 })],
    });
  });

  it("attributes two turns' usage and all file versions by requestId", async () => {
    const { home, local, session, tree } = await fixture();
    await fs.writeFile(path.join(session, "index.json"), JSON.stringify({ requests: [
      { id: "request-1", startedAt: 1792977000000, state: "complete", messages: ["msg-1"], usage: {
        inputTokens: 208006, outputTokens: 5789, totalTokens: 213795, cacheTokens: 175104 } },
      { id: "request-2", startedAt: 1792977100000, state: "complete", messages: ["msg-2"], usage: {
        inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
    ] }));
    await fs.writeFile(path.join(session, "messages", "msg-1.json"), JSON.stringify({
      createdAt: 1792977004000, extra: { requestId: "request-1", modelId: "glm-5.3", modelName: "GLM-5.3" },
      message: [{ toolName: "use_skill", toolCallId: "call-a", args: { command: "code-review" } },
        { toolName: "use_skill", toolCallId: "call-b", args: { command: "code-review" } }],
    }));
    await fs.writeFile(path.join(session, "messages", "msg-2.json"), JSON.stringify({
      createdAt: 1792977104000, extra: { requestId: "request-2" }, message: "hello",
    }));
    await fs.writeFile(tree, JSON.stringify([{ filePath: "D:/repo/A.java", versions: [
      { versionId: "v1", metadata: { requestId: "request-1", toolCallId: "call-a" }, diff: { addedLines: 10, removedLines: 2 } },
      { versionId: "v2", metadata: { requestId: "request-2", toolCallId: "call-c" }, diff: { addedLines: 3, removedLines: 1 } },
      { versionId: "v2", metadata: { requestId: "request-2", toolCallId: "call-c" }, diff: { addedLines: 3, removedLines: 1 } },
    ] }]));
    const scanner = new CodeBuddyStructuredSessionScanner({ homeDirectory: home, localAppDataDirectory: local,
      now: () => new Date("2026-10-26T12:00:00Z") });
    const turns = await scanner.scan();
    expect(turns).toHaveLength(2);
    expect(turns[0]?.usage).toMatchObject({ inputTokens: 208006, outputTokens: 5789, totalTokens: 213795,
      cacheReadTokens: 175104, quality: "EXACT", source: "STRUCTURED_REQUEST_USAGE" });
    expect(turns[0]?.modelId).toBe("glm-5.3");
    expect(turns[0]?.skillCalls).toHaveLength(2);
    expect(turns[0]?.fileDiffs?.[0]).toMatchObject({ linesAdded: 10, linesDeleted: 2 });
    expect(turns[1]?.fileDiffs?.[0]).toMatchObject({ linesAdded: 3, linesDeleted: 1 });
    await scanner.commit();
    expect(await scanner.scan()).toHaveLength(0);
  });

  it("merges log and structured Skill calls into one event and one Generation", async () => {
    const { root, home, local, session } = await fixture();
    const project = path.join(root, "project");
    const marker = path.join(home, ".codebuddy", "skills", "code-review");
    await fs.mkdir(marker, { recursive: true });
    await fs.writeFile(path.join(marker, ".yantu-platform-skill.json"), JSON.stringify({ source: "yantu-platform", skillKey: "code-review", skillVersionId: 283 }));
    const logDir = path.join(root, "logs", "20261026T100000", "window1", "exthost", "tencent-cloud.coding-copilot");
    await fs.mkdir(logDir, { recursive: true });
    const log = path.join(logDir, "tkcoding.log");
    await fs.writeFile(log, "existing\n");
    const queue = new TelemetryQueue(home);
    const monitor = new CodeBuddyLogSkillMonitor(console, { homeDirectory: home, localAppDataDirectory: local,
      logRoots: [path.join(root, "logs")], queue, generationStore: new GenerationStateStore(home), structuredPollIntervalMs: 0,
      now: () => new Date("2026-10-26T12:00:00Z") });
    await monitor.poll();
    await fs.appendFile(log, [
      `2026-10-26 10:00:00 [CheckpointCoordinator] initialize START: conversationId=conversation-1, workspace=${project}`,
      "2026-10-26 10:00:01 [AgentReporter] onAgentStart: userInput=review agent=craft mode=craft conversationId=conversation-1 requestId=request-1",
      "2026-10-26 10:00:02 [StreamParser] tool-call-streaming-start 开始解析: call-a - use_skill",
      "2026-10-26 10:00:03 [StreamParser] 参数解析完成: call-a - 参数: command - 值: code-review",
      '2026-10-26 10:00:04 [AgentReporter] Agent execution successful with usage: {"inputTokens":90,"outputTokens":20,"totalTokens":110}',
      "",
    ].join("\n"));
    await monitor.poll();
    await fs.writeFile(path.join(session, "index.json"), JSON.stringify({ requests: [{ id: "request-1",
      startedAt: 1792980001000, state: "complete", messages: ["msg-user", "msg-1", "msg-after"], usage: {
        inputTokens: 100, outputTokens: 20, totalTokens: 120 } }] }));
    await fs.writeFile(path.join(session, "messages", "msg-user.json"), JSON.stringify({
      role: "user", createdAt: 1792980002000, extra: { requestId: "request-1" }, message: "Please review",
    }));
    await fs.writeFile(path.join(session, "messages", "msg-1.json"), JSON.stringify({
      createdAt: 1792980005000, extra: { requestId: "request-1", modelId: "glm-5.3" },
      role: "assistant",
      message: JSON.stringify({ toolName: "use_skill", toolCallId: "call-a", args: { command: "code-review" } }),
    }));
    await fs.writeFile(path.join(session, "messages", "msg-after.json"), JSON.stringify({
      role: "assistant", createdAt: 1792980010000, extra: { requestId: "request-1" },
      message: "A later answer",
    }));
    await monitor.poll();
    const metadata = await Promise.all((await queue.pendingMetadata()).map(file => queue.readMetadata(file)));
    expect(new Set(metadata.map(item => item.eventId)).size).toBe(1);
    expect(metadata.some(item => item.model === "glm-5.3")).toBe(true);
    const state = await new GenerationStateStore(home).load("log-request-1");
    expect(state).toMatchObject({ status: "COMPLETED", captureQuality: "STRUCTURED", modelId: "glm-5.3",
      tokenMismatch: true });
    expect(state?.skillInvocations).toHaveLength(1);
    expect(state?.usage?.totalTokens).toBe(120);
    const conversations = await queue.pendingConversations();
    expect(conversations).toHaveLength(2); // the initial log snapshot and its structured upgrade
    const body = JSON.parse(gunzipSync(await fs.readFile(conversations[1]!)).toString("utf8"));
    expect(body.messages).toEqual([expect.objectContaining({ role: "user", content: "Please review" })]);
    expect(JSON.stringify(body)).not.toContain("A later answer");
    expect(JSON.stringify(body)).not.toContain("command");
  });
});
