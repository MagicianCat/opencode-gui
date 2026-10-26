import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyGeneration } from "./GenerationState";
import { GenerationStateStore } from "./GenerationStateStore";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map(item => fs.rm(item, { recursive: true, force: true }))));

describe("GenerationStateStore", () => {
  it("keeps an uploaded revision and leaves later structured updates pending", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "generation-store-")); temporary.push(home);
    const store = new GenerationStateStore(home);
    const state = emptyGeneration("log-request-1", "session-1", "2026-10-26T01:00:00Z");
    state.status = "COMPLETED";
    state.captureQuality = "LOG_FINAL";
    await store.save(state);
    const firstRevision = state.revision!;
    await store.markUploaded(state.generationId, firstRevision);
    expect(await store.load(state.generationId)).toMatchObject({ uploadedRevision: firstRevision, captureQuality: "LOG_FINAL" });

    state.captureQuality = "STRUCTURED";
    state.usage = { inputTokens: 208006, outputTokens: 5789, totalTokens: 213795, quality: "EXACT" };
    await store.save(state);
    expect(await store.load(state.generationId)).toMatchObject({ revision: firstRevision + 1,
      uploadedRevision: firstRevision, captureQuality: "STRUCTURED" });
  });

  it("does not remove a state that was updated while an older snapshot was uploading", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "generation-store-")); temporary.push(home);
    const store = new GenerationStateStore(home);
    const state = emptyGeneration("generation-1", "session-1", "2026-10-09T01:00:00Z");
    state.status = "PARTIAL";
    await store.save(state);
    const uploading = await store.load(state.generationId);

    state.status = "COMPLETED";
    await new Promise(resolve => setTimeout(resolve, 2));
    await store.save(state);

    expect(await store.removeIfUnchanged(state.generationId, uploading!.updatedAtMs)).toBe(false);
    expect((await store.load(state.generationId))?.status).toBe("COMPLETED");
    expect(await store.removeIfUnchanged(state.generationId, state.updatedAtMs)).toBe(true);
    expect(await store.load(state.generationId)).toBeNull();
  });
});
