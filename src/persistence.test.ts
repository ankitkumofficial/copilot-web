import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

import { SerialTaskQueue } from "./persistence.js";

test("serializes concurrent snapshots without dropping other sessions", async () => {
  const writes = new SerialTaskQueue();
  const usage = new Map([
    ["session-a", { aicNano: 10, aicLimit: 100 }]
  ]);
  const persistedSnapshots: Array<Map<string, { aicNano: number; aicLimit: number }>> = [];
  const snapshotUsage = () => new Map(
    [...usage].map(([sessionId, value]) => [sessionId, { ...value }])
  );

  const firstSnapshot = snapshotUsage();
  const firstWrite = writes.enqueue(async () => {
    await setTimeout(10);
    persistedSnapshots.push(firstSnapshot);
  });

  usage.get("session-a")!.aicNano = 15;
  usage.set("session-b", { aicNano: 20, aicLimit: 200 });
  const secondSnapshot = snapshotUsage();
  const secondWrite = writes.enqueue(async () => {
    persistedSnapshots.push(secondSnapshot);
  });

  await Promise.all([firstWrite, secondWrite]);
  assert.deepEqual([...persistedSnapshots[0]!], [
    ["session-a", { aicNano: 10, aicLimit: 100 }]
  ]);
  assert.deepEqual([...persistedSnapshots[1]!], [
    ["session-a", { aicNano: 15, aicLimit: 100 }],
    ["session-b", { aicNano: 20, aicLimit: 200 }]
  ]);
});

test("continues after a failed write and flush waits for queued writes", async () => {
  const writes = new SerialTaskQueue();
  const saved: string[] = [];
  const failedWrite = writes.enqueue(async () => {
    throw new Error("disk full");
  });
  const followingWrite = writes.enqueue(async () => {
    await setTimeout(5);
    saved.push("latest snapshot");
  });

  await assert.rejects(failedWrite, /disk full/);
  await followingWrite;
  await writes.flush();
  assert.deepEqual(saved, ["latest snapshot"]);
});
