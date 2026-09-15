import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "./SerialTaskQueue";

describe("SerialTaskQueue", () => {
  it("preserves async event ordering and continues after errors", async () => {
    const order: number[] = []; const errors: string[] = []; const queue = new SerialTaskQueue(error => errors.push((error as Error).message));
    queue.enqueue(async () => { await new Promise(resolve => setTimeout(resolve, 10)); order.push(1); });
    queue.enqueue(async () => { order.push(2); throw new Error("event failed"); });
    queue.enqueue(async () => { order.push(3); });
    await queue.idle(); expect(order).toEqual([1, 2, 3]); expect(errors).toEqual(["event failed"]);
  });
});
