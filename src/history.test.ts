import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyNativeMessageEvent,
  CopilotHistoryReader,
  createNativeMessageCollection,
  mergeNativeMessages,
  nativeMessagesFromEvents,
  readAllPersistedEvents,
  type NativeMessage
} from "./history.js";

const reconnectingSdk = `
export const RuntimeConnection = { forStdio: (options) => options };

export class CopilotClient {
  constructor() {
    this.connected = false;
    this.epoch = 0;
    globalThis.historyReaderTestClient = this;
  }

  async start() {
    if (this.connected) return;
    this.connected = true;
    this.epoch += 1;
    const epoch = this.epoch;
    this.currentRpc = {
      sessions: {
        readPersistedEvents: async ({ sessionId }) => {
          if (!this.connected || this.epoch !== epoch) {
            throw new Error("Connection is disposed");
          }
          if (sessionId !== "session-1") {
            throw new Error("Persisted event journal is unavailable for session " + sessionId);
          }
          return {
            events: [{
              id: "event-" + epoch,
              type: "assistant.message",
              timestamp: "2026-10-14T10:00:00.000Z",
              data: { messageId: "message-" + epoch, content: "Reply " + epoch }
            }],
            cursor: "",
            cursorStatus: "ok",
            hasMore: false
          };
        }
      }
    };
  }

  get rpc() {
    if (!this.connected) throw new Error("Client is not connected");
    return this.currentRpc;
  }

  disconnect() {
    this.connected = false;
  }

  async stop() {
    this.connected = false;
  }
}
`;

test("resolves persisted-history RPC bindings again after the SDK reconnects", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-history-sdk-"));
  const sdkPath = path.join(directory, "index.mjs");
  await writeFile(sdkPath, reconnectingSdk);
  const reader = new CopilotHistoryReader({
    sdkPath,
    command: "copilot",
    cwd: directory,
    allowAll: false
  });
  try {
    await reader.initialize();
    assert.equal(reader.available, true);
    assert.equal((await reader.read("session-1"))[0]?.id, "event-1");

    const client = (globalThis as unknown as {
      historyReaderTestClient: { disconnect(): void };
    }).historyReaderTestClient;
    client.disconnect();

    assert.equal((await reader.read("session-1"))[0]?.id, "event-2");
  } finally {
    await reader.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads persisted-history pages sequentially using each returned cursor", async () => {
  const requests: Array<{ sessionId: string; cursor?: string; max: number }> = [];
  const events = [
    { id: "event-1", type: "user.message" },
    { id: "event-2", type: "assistant.message" },
    { id: "event-3", type: "assistant.message" }
  ];
  let inFlight = false;
  const result = await readAllPersistedEvents(async (request) => {
    assert.equal(inFlight, false);
    inFlight = true;
    requests.push(request);
    await Promise.resolve();
    inFlight = false;
    if (request.cursor === undefined) {
      return {
        events: events.slice(0, 1),
        cursor: "cursor-1",
        cursorStatus: "ok",
        hasMore: true
      };
    }
    if (request.cursor === "cursor-1") {
      return {
        events: events.slice(1, 2),
        cursor: "cursor-2",
        cursorStatus: "ok",
        hasMore: true
      };
    }
    assert.equal(request.cursor, "cursor-2");
    return {
      events: events.slice(2),
      cursor: "",
      cursorStatus: "ok",
      hasMore: false
    };
  }, "session-1");

  assert.deepEqual(result, events);
  assert.deepEqual(requests, [
    { sessionId: "session-1", max: 200 },
    { sessionId: "session-1", max: 200, cursor: "cursor-1" },
    { sessionId: "session-1", max: 200, cursor: "cursor-2" }
  ]);
});

test("rejects an expired persisted-history cursor instead of returning partial history", async () => {
  let requestCount = 0;
  await assert.rejects(
    readAllPersistedEvents(async () => {
      requestCount += 1;
      return requestCount === 1
        ? {
          events: [{ id: "partial-event" }],
          cursor: "cursor-1",
          cursorStatus: "ok",
          hasMore: true
        }
        : {
          events: [],
          cursor: "",
          cursorStatus: "expired",
          hasMore: false
        };
    }, "session-1"),
    /expired.*no partial history/
  );
  assert.equal(requestCount, 2);
});

test("normalizes native messages, reconstructs inline attachments, and deduplicates event IDs", () => {
  const collection = createNativeMessageCollection();
  const user = applyNativeMessageEvent(collection, {
    id: "user-event",
    type: "user.message",
    timestamp: "2026-10-14T10:00:00.000Z",
    data: {
      messageId: "user-1",
      content: "Review this image",
      attachments: [{
        type: "file",
        displayName: "diagram.png",
        mimeType: "image/png",
        data: "aGVsbG8="
      }]
    }
  });
  assert.deepEqual(user, {
    messageId: "user-1",
    role: "user",
    content: "Review this image",
    attachments: [{
      name: "diagram.png",
      mimeType: "image/png",
      data: "aGVsbG8="
    }],
    completion: "completed",
    eventId: "user-event",
    revision: 1,
    timestamp: "2026-10-14T10:00:00.000Z",
    updatedAt: "2026-10-14T10:00:00.000Z"
  });

  applyNativeMessageEvent(collection, {
    id: "assistant-start",
    type: "assistant.message_start",
    timestamp: "2026-10-14T10:00:01.000Z",
    data: { messageId: "assistant-1" }
  });
  applyNativeMessageEvent(collection, {
    id: "assistant-delta",
    type: "assistant.message_delta",
    timestamp: "2026-10-14T10:00:02.000Z",
    data: { messageId: "assistant-1", deltaContent: "Hello" }
  });
  assert.equal(applyNativeMessageEvent(collection, {
    id: "assistant-delta",
    type: "assistant.message_delta",
    timestamp: "2026-10-14T10:00:02.000Z",
    data: { messageId: "assistant-1", deltaContent: "Hello" }
  }), undefined);
  const final = applyNativeMessageEvent(collection, {
    id: "assistant-final",
    type: "assistant.message",
    timestamp: "2026-10-14T10:00:03.000Z",
    data: { messageId: "assistant-1", content: "Hello, world." }
  });

  assert.equal(final?.content, "Hello, world.");
  assert.equal(final?.completion, "completed");
  assert.equal(final?.timestamp, "2026-10-14T10:00:03.000Z");
  assert.equal(final?.toolCallIds, undefined);
  const withActivity = applyNativeMessageEvent(collection, {
    id: "assistant-tools",
    type: "assistant.message",
    data: {
      messageId: "assistant-2",
      content: "Checking.",
      reasoningText: "Need to inspect the file.",
      toolRequests: [{ toolCallId: "tool-1", name: "view" }, { name: "missing-id" }]
    }
  });
  assert.deepEqual(withActivity?.toolCallIds, ["tool-1"]);
  assert.equal(withActivity?.reasoningText, "Need to inspect the file.");
  assert.equal(collection.eventIds.size, 5);
  assert.deepEqual(collection.order, [
    "user:user-1",
    "assistant:assistant-1",
    "assistant:assistant-2"
  ]);
});

test("accepts live events without event IDs without retaining them for deduplication", () => {
  const collection = createNativeMessageCollection();
  const delta = (deltaContent: string) => ({
    type: "assistant.message_delta",
    timestamp: "2026-10-14T10:00:01.000Z",
    data: { messageId: "assistant-1", deltaContent }
  });

  assert.equal(applyNativeMessageEvent(collection, delta("ignored")), undefined);
  const first = applyNativeMessageEvent(collection, delta("Hello"), { liveEventId: "live:1" });
  const second = applyNativeMessageEvent(collection, delta(", world."), { liveEventId: "live:2" });

  assert.equal(first?.eventId, "live:1");
  assert.equal(second?.eventId, "live:2");
  assert.equal(second?.content, "Hello, world.");
  assert.equal(collection.eventIds.size, 0);
});

test("filters subagent message events and leaves timestamp-less replies untimed", () => {
  const messages = nativeMessagesFromEvents([
    {
      id: "subagent-message",
      agentId: "agent-1",
      type: "assistant.message",
      timestamp: "2026-10-14T10:00:00.000Z",
      data: { messageId: "subagent-1", content: "Do not show" }
    },
    {
      id: "root-message",
      type: "assistant.message",
      data: { messageId: "root-1", content: "Recorded without a time" }
    }
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.messageId, "root-1");
  assert.equal(messages[0]?.completion, "completed");
  assert.equal(messages[0]?.timestamp, undefined);
});

test("merges persisted and buffered events without letting stale live text replace a final reply", () => {
  const persisted = [{
    id: "assistant-final",
    type: "assistant.message",
    timestamp: "2026-10-14T10:00:03.000Z",
    data: {
      messageId: "assistant-1",
      content: "Final answer",
      reasoningText: "Thought before the answer"
    }
  }];
  const buffered = [{
    id: "late-delta",
    type: "assistant.message_delta",
    timestamp: "2026-10-14T10:00:04.000Z",
    data: { messageId: "assistant-1", deltaContent: " stale chunk" }
  }];
  const staleLiveMessage: NativeMessage = {
    messageId: "assistant-1",
    role: "assistant",
    content: "Final answer stale chunk",
    attachments: [],
    completion: "streaming",
    eventId: "late-delta",
    revision: 9,
    updatedAt: "2026-10-14T10:00:04.000Z"
  };
  const messages = mergeNativeMessages(persisted, buffered, [staleLiveMessage]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.content, "Final answer");
  assert.equal(messages[0]?.completion, "completed");
  assert.equal(messages[0]?.timestamp, "2026-10-14T10:00:03.000Z");

  const newerLiveMessage: NativeMessage = {
    ...staleLiveMessage,
    content: "Updated final answer",
    completion: "completed",
    eventId: "live-final",
    revision: 10,
    updatedAt: "2026-10-14T10:00:04.500Z"
  };
  const mergedWithNewerLive = mergeNativeMessages(persisted, [], [newerLiveMessage]);
  assert.equal(mergedWithNewerLive[0]?.content, "Updated final answer");
  assert.equal(mergedWithNewerLive[0]?.reasoningText, "Thought before the answer");
});
