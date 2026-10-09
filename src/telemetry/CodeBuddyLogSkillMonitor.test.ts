import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { CodeBuddyLogSkillMonitor } from "./CodeBuddyLogSkillMonitor";
import { TelemetryQueue } from "./TelemetryQueue";

const gunzipAsync = promisify(gunzip);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

describe("CodeBuddyLogSkillMonitor", () => {
  it("captures only marked platform Skills and keeps window contexts isolated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-log-monitor-")); temporary.push(root);
    const home = path.join(root, "home");
    const logs = path.join(root, "logs");
    const project = path.join(root, "project");
    const window1 = await createLog(logs, "window1");
    const window2 = await createLog(logs, "window2");
    await writeMarker(path.join(home, ".codebuddy", "skills", "code-review"), "code-review", 283);
    await writeMarker(path.join(project, ".codebuddy", "skills", "security-review"), "security-review", 247);
    const queue = new TelemetryQueue(home);
    const monitor = new CodeBuddyLogSkillMonitor(console, { homeDirectory: home, logRoots: [logs], queue });

    await monitor.poll(); // initialize at EOF
    await fs.appendFile(window1, invocation("session-global", project, "global prompt", "call-global", "code-review"));
    await fs.appendFile(window2, invocation("session-project", project, "project prompt", "call-project", "security-review"));
    await monitor.poll();

    const metadataFiles = await queue.pendingMetadata();
    expect(metadataFiles).toHaveLength(2);
    const metadata = await Promise.all(metadataFiles.map(file => queue.readMetadata(file)));
    expect(metadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillKey: "code-review", skillVersionId: 283, localDirectory: project, clientSessionId: "session-global" }),
      expect.objectContaining({ skillKey: "security-review", skillVersionId: 247, localDirectory: project, clientSessionId: "session-project" }),
    ]));
    const conversations = await queue.pendingConversations();
    expect(conversations).toHaveLength(2);
    const body = JSON.parse((await gunzipAsync(await fs.readFile(conversations[0]!))).toString("utf8"));
    expect(body.partial).toBe(true);
    expect(body.messages[0].role).toBe("user");
  });

  it("ignores an unmarked Skill and deduplicates repeated CodeBuddy log lines", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-log-monitor-")); temporary.push(root);
    const home = path.join(root, "home");
    const logs = path.join(root, "logs");
    const log = await createLog(logs, "window1");
    const queue = new TelemetryQueue(home);
    const monitor = new CodeBuddyLogSkillMonitor(console, { homeDirectory: home, logRoots: [logs], queue });
    await monitor.poll();
    const duplicated = invocation("session", root, "hello", "call-1", "test-hello");
    await fs.appendFile(log, duplicated + duplicated);
    await monitor.poll();
    expect(await queue.pendingMetadata()).toHaveLength(0);
  });

  it("persists call-id deduplication across extension restarts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-log-monitor-")); temporary.push(root);
    const home = path.join(root, "home");
    const logs = path.join(root, "logs");
    const log = await createLog(logs, "window1");
    await writeMarker(path.join(home, ".codebuddy", "skills", "code-review"), "code-review", 283);
    const queue = new TelemetryQueue(home);
    const first = new CodeBuddyLogSkillMonitor(console, { homeDirectory: home, logRoots: [logs], queue });
    await first.poll();
    const entry = invocation("session", root, "review", "stable-call-id", "code-review");
    await fs.appendFile(log, entry);
    await first.poll();
    expect(await queue.pendingMetadata()).toHaveLength(1);

    const restarted = new CodeBuddyLogSkillMonitor(console, { homeDirectory: home, logRoots: [logs], queue });
    await restarted.poll();
    await fs.appendFile(log, entry);
    await restarted.poll();
    expect(await queue.pendingMetadata()).toHaveLength(1);
  });

  it("creates one stable partial Generation for multiple platform Skills in the same turn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-log-monitor-")); temporary.push(root);
    const home = path.join(root, "home");
    const logs = path.join(root, "logs");
    const project = path.join(root, "project");
    const log = await createLog(logs, "window1");
    await writeMarker(path.join(home, ".codebuddy", "skills", "code-review"), "code-review", 283);
    await writeMarker(path.join(project, ".codebuddy", "skills", "security-review"), "security-review", 247);
    const queue = new TelemetryQueue(home);
    const monitor = new CodeBuddyLogSkillMonitor(console, { homeDirectory: home, logRoots: [logs], queue });
    await monitor.poll();
    await fs.appendFile(log, [
      `2026-10-08 17:16:19 [CheckpointCoordinator] initialize START: conversationId=session-1, workspace=${project}`,
      "2026-10-08 17:16:20 [AgentReporter] onAgentStart: userInput=review everything agent=x mode=x conversationId=session-1",
      "2026-10-08 17:16:21 [StreamParser] tool-call-streaming-start 开始解析: call-1 - use_skill",
      "2026-10-08 17:16:22 [StreamParser] 参数解析完成: call-1 - 参数: command - 值: code-review",
      "2026-10-08 17:16:23 [StreamParser] tool-call-streaming-start 开始解析: call-2 - use_skill",
      "2026-10-08 17:16:24 [StreamParser] 参数解析完成: call-2 - 参数: command - 值: security-review",
      "",
    ].join("\n"));
    await monitor.poll();

    const metadata = await Promise.all((await queue.pendingMetadata()).map(file => queue.readMetadata(file)));
    expect(metadata).toHaveLength(2);
    expect(new Set(metadata.map(item => item.generationId)).size).toBe(1);
    expect(metadata[0]!.generationId).not.toBe("call-1");

    const generationDirectory = path.join(home, ".codebuddy", "yantu-assistant", "telemetry", "generations");
    const generationFiles = await fs.readdir(generationDirectory);
    expect(generationFiles).toHaveLength(1);
    const generation = JSON.parse(await fs.readFile(path.join(generationDirectory, generationFiles[0]!), "utf8"));
    expect(generation).toMatchObject({ sessionId: "session-1", status: "PARTIAL", projectName: "project" });
    expect(generation.skillInvocations.map((item: { skillKey: string }) => item.skillKey)).toEqual(["code-review", "security-review"]);
  });

  it("completes the previous sampled Generation when the next turn starts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-log-monitor-")); temporary.push(root);
    const home = path.join(root, "home");
    const logs = path.join(root, "logs");
    const log = await createLog(logs, "window1");
    await writeMarker(path.join(home, ".codebuddy", "skills", "code-review"), "code-review", 283);
    const monitor = new CodeBuddyLogSkillMonitor(console, { homeDirectory: home, logRoots: [logs], queue: new TelemetryQueue(home) });
    await monitor.poll();
    await fs.appendFile(log, invocation("session-1", root, "first", "call-1", "code-review"));
    await monitor.poll();
    await fs.appendFile(log, "2026-10-08 17:17:20 [AgentReporter] onAgentStart: userInput=second agent=x mode=x conversationId=session-1\n");
    await monitor.poll();

    const directory = path.join(home, ".codebuddy", "yantu-assistant", "telemetry", "generations");
    const files = await fs.readdir(directory);
    const generation = JSON.parse(await fs.readFile(path.join(directory, files[0]!), "utf8"));
    expect(generation.status).toBe("COMPLETED");
    expect(generation.durationMs).toBe(60_000);
  });
});

async function createLog(root: string, windowName: string): Promise<string> {
  const directory = path.join(root, "20261008T161900", windowName, "exthost", "tencent-cloud.coding-copilot");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "tkcoding.log");
  await fs.writeFile(file, "existing log line\n");
  return file;
}

async function writeMarker(directory: string, skillKey: string, skillVersionId: number): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, ".yantu-platform-skill.json"), JSON.stringify({
    source: "yantu-platform", skillKey, skillVersionId, installationId: `install-${skillKey}`,
  }));
}

function invocation(session: string, workspace: string, input: string, callId: string, skill: string): string {
  return [
    `2026-10-08 17:16:19 [CheckpointCoordinator] initialize START: conversationId=${session}, workspace=${workspace}`,
    `2026-10-08 17:16:20 [AgentReporter] onAgentStart: userInput=${input} agent=x mode=x conversationId=${session}`,
    `2026-10-08 17:16:21 [StreamParser] tool-call-streaming-start 开始解析: ${callId} - use_skill`,
    `2026-10-08 17:16:22 [StreamParser] 参数解析完成: ${callId} - 参数: command - 值: ${skill}`,
    "",
  ].join("\n");
}
