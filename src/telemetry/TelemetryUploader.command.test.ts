import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HttpError, type PlatformClient } from "../platform/PlatformClient";
import { TelemetryQueue } from "./TelemetryQueue";
import { TelemetryUploader } from "./TelemetryUploader";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe("Command telemetry upload diagnostics", () => {
  it("records a bounded failure and success with the same event id", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yantu-command-upload-")); roots.push(home);
    const queue = new TelemetryQueue(home);
    const eventId = "11111111-2222-4333-8444-555555555555";
    await queue.enqueueCommand({ eventId, commandName: "code-review", triggerType: "MENU",
      evidenceType: "STRUCTURED_COMMAND", clientSessionId: "session", generationId: "log-request",
      client: "CodeBuddyIDE", invokedAt: "2026-11-02T02:33:17Z" });
    const record = vi.fn().mockRejectedValueOnce(new HttpError(503, "unavailable")).mockResolvedValue(undefined);
    const client = { recordCommandUsage: record } as unknown as PlatformClient;
    const logger = { info: vi.fn(), error: vi.fn() };
    const uploader = new TelemetryUploader(client, logger, queue);
    await uploader["flush"]();
    expect(await queue.pendingCommands()).toHaveLength(1);
    await uploader["flush"]();
    expect(await queue.pendingCommands()).toHaveLength(0);
    const rows = (await fs.readFile(queue.commandDiagnosticFile, "utf8")).trim().split("\n").map(JSON.parse);
    expect(rows).toEqual([expect.objectContaining({ event: "upload_failed", eventId, reason: "HTTP_503" }),
      expect.objectContaining({ event: "uploaded", eventId })]);
  });
});
