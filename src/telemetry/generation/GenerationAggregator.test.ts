import { describe, expect, it } from "vitest";
import { aggregateFileTypes } from "./GenerationAggregator";
import { toPayload } from "./GenerationTelemetry";
import type { FileDiffMetric, GenerationState } from "./GenerationState";

const diff = (over: Partial<FileDiffMetric>): FileDiffMetric => ({
  filePath: "/p/F.java", extension: "java", category: "JAVA",
  linesAdded: 0, linesDeleted: 0, created: false, modified: false, ...over,
});

describe("aggregateFileTypes", () => {
  it("merges multiple files of the same category", () => {
    const result = aggregateFileTypes([
      diff({ filePath: "/p/A.java", linesAdded: 10, linesDeleted: 2, created: true }),
      diff({ filePath: "/p/B.java", linesAdded: 5, linesDeleted: 1, modified: true }),
      diff({ filePath: "/p/s.sql", extension: "sql", category: "SQL", linesAdded: 3, created: true }),
    ]);
    const java = result.find(r => r.type === "JAVA");
    const sql = result.find(r => r.type === "SQL");
    expect(java).toMatchObject({ linesAdded: 15, linesDeleted: 3, filesCreated: 1, filesModified: 1 });
    expect(sql).toMatchObject({ linesAdded: 3, filesCreated: 1, filesModified: 0 });
  });
});

describe("toPayload", () => {
  it("reduces fileDiffs to code totals and dedups skillKeys", () => {
    const state: GenerationState = {
      generationId: "g1", sessionId: "s1", startedAt: "2026-09-19T01:00:00Z", status: "COMPLETED",
      endedAt: "2026-09-19T01:09:31Z", durationMs: 571000,
      projectKey: "k", projectName: "sms", projectSource: "GIT_REMOTE",
      skillInvocations: [
        { skillKey: "java-backend", invokedAt: "t" },
        { skillKey: "unit-testing", invokedAt: "t" },
        { skillKey: "java-backend", invokedAt: "t" },
      ],
      fileDiffs: [
        diff({ filePath: "/p/A.java", linesAdded: 326, linesDeleted: 63, created: true }),
        diff({ filePath: "/p/B.java", linesAdded: 0, linesDeleted: 0, modified: true }),
        diff({ filePath: "/p/pom.xml", extension: "xml", category: "XML", linesAdded: 46, linesDeleted: 9, created: true }),
      ],
      toolCallCount: 42, toolFailureCount: 2,
      usage: { inputTokens: 585930, outputTokens: 10155, totalTokens: 596085, source: "CODEBUDDY_UPSTREAM_USAGE", quality: "EXACT" },
      updatedAtMs: Date.now(),
    };
    const payload = toPayload(state) as any;
    expect(payload.generationId).toBe("g1");
    expect(payload.skillKeys).toEqual(["java-backend", "unit-testing"]);
    expect(payload.code).toEqual({ linesAdded: 372, linesDeleted: 72, filesCreated: 2, filesModified: 1 });
    expect(payload.fileTypes).toHaveLength(2);
    expect(payload.usage.totalTokens).toBe(596085);
    expect(payload.status).toBe("COMPLETED");
    expect(payload.toolCallCount).toBe(42);
    expect(payload.toolFailureCount).toBe(2);
  });
});
