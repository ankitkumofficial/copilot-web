import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyNativeMessageEvent,
  CopilotHistoryReader,
  createNativeMessageCollection,
  HistoryCursorExpiredError,
  HistoryPager,
  historyPageMaximumBytes,
  historyPageMaximumMessages,
  historyReplayUpdates,
  mergeNativeMessages,
  mergePagedHistoryReplayUpdates,
  nativeMessagesFromEvents,
  readAllPersistedEvents,
  type NativeMessage
} from "./history.js";
import { isRecord, type JsonObject } from "./acp.js";

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
      attachments: [
        {
          type: "file",
          displayName: "diagram.png",
          mimeType: "image/png",
          data: "aGVsbG8="
        },
        {
          type: "file",
          displayName: "notes.txt",
          mimeType: "text/plain",
          data: "dGV4dA=="
        }
      ]
    }
  });
  assert.deepEqual(user, {
    messageId: "user-1",
    role: "user",
    content: "Review this image",
    attachments: [
      {
        name: "diagram.png",
        mimeType: "image/png",
        data: "aGVsbG8="
      },
      {
        name: "notes.txt",
        mimeType: "text/plain",
        data: "dGV4dA=="
      }
    ],
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

function pagingFixture(count: number, content = "History") {
  const events: JsonObject[] = Array.from({ length: count }, (_, index) => ({
    id: `event-${index}`,
    type: index % 2 === 0 ? "user.message" : "assistant.message",
    timestamp: new Date(Date.UTC(2026, 9, 20, 0, index)).toISOString(),
    data: { messageId: `message-${index}`, content: `${content} ${index}` }
  }));
  const calls: Array<{ cursor?: string; direction?: string; max: number }> = [];
  const used = new Set<string>();
  const positions = new Map<string, number>();
  const pager = new HistoryPager(async (request) => {
    calls.push(request);
    assert.equal(request.direction, "backward");
    if (request.cursor) {
      assert.equal(used.has(request.cursor), false, "Native cursors must never be reused");
      used.add(request.cursor);
    }
    const end = request.cursor === undefined ? events.length : positions.get(request.cursor);
    assert.notEqual(end, undefined);
    const boundary = end ?? 0;
    const start = Math.max(0, boundary - request.max);
    const next = `${calls.length}:${start}`;
    positions.set(next, start);
    return {
      events: events.slice(start, boundary),
      cursor: next,
      hasMore: start > 0,
      cursorStatus: "ok"
    };
  });
  return { pager, events, calls };
}

test("pages newest-first with bounded counts and chronological, lossless messages", async () => {
  const { pager, events, calls } = pagingFixture(103);
  let page = await pager.read("session-1");
  assert.deepEqual(page.events, events.slice(-historyPageMaximumMessages));
  assert.equal(calls.length, 1, "The initial page must not scan the full journal");
  let collected = page.events;
  while (page.cursor) {
    page = await pager.read("session-1", page.cursor);
    assert.ok(page.events.length <= historyPageMaximumMessages);
    collected = [...page.events, ...collected];
  }
  assert.deepEqual(collected, events);
  assert.equal(page.hasMore, false);
});

test("uses byte limits before message limits and returns a single oversized event intact", async () => {
  const { pager, events } = pagingFixture(10, "Long reply ".repeat(4000));
  let page = await pager.read("session-1");
  assert.ok(page.events.length < 10);
  assert.ok(Buffer.byteLength(JSON.stringify(page.events)) <= historyPageMaximumBytes);
  const collected = [...page.events];
  while (page.cursor) {
    page = await pager.read("session-1", page.cursor);
    collected.unshift(...page.events);
  }
  assert.deepEqual(collected, events);
  const oversized = pagingFixture(2, "x".repeat(historyPageMaximumBytes * 2));
  const largePage = await oversized.pager.read("session-1");
  assert.equal(largePage.events.length, 1);
  assert.equal(largePage.oversized, true);
  assert.deepEqual(largePage.events, oversized.events.slice(-1));
});

test("counts attachment-only assistant replies toward the page message limit", async () => {
  const { pager, events } = pagingFixture(25);
  for (const event of events) {
    event.type = "assistant.message";
    assert.ok(isRecord(event.data));
    event.data.content = "";
    event.data.attachments = [{
      type: "file",
      displayName: "reply.pdf",
      mimeType: "application/pdf",
      data: "YQ=="
    }];
  }

  const page = await pager.read("session-1");

  assert.equal(page.events.length, historyPageMaximumMessages);
  assert.equal(page.hasMore, true);
  assert.ok(page.cursor);
});

test("shares cursor reads for concurrent requests and retries without consuming native cursors twice", async () => {
  const { pager, calls } = pagingFixture(60);
  const first = await pager.read("session-1");
  assert.ok(first.cursor);
  const pages = await Promise.all([
    pager.read("session-1", first.cursor),
    pager.read("session-1", first.cursor)
  ]);
  assert.deepEqual(pages[0], pages[1]);
  assert.deepEqual(await pager.read("session-1", first.cursor), pages[0]);
  assert.equal(calls.length, 2);
  await assert.rejects(pager.read("other-session", first.cursor), HistoryCursorExpiredError);
  pager.forget("session-1");
  await assert.rejects(pager.read("session-1", first.cursor), HistoryCursorExpiredError);
});

test("expires and bounds display cursors and rebases by stable message ID", async () => {
  const { pager, events } = pagingFixture(300);
  const first = await pager.read("session-1");
  assert.ok(first.cursor);
  let page = first;
  for (let index = 0; index < 10; index += 1) {
    assert.ok(page.cursor);
    page = await pager.read("session-1", page.cursor);
  }
  await assert.rejects(pager.read("session-1", first.cursor), HistoryCursorExpiredError);
  const older = await pager.seek("session-1", "message-270");
  assert.deepEqual(older.events, events.slice(260, 270));
  const source = await pager.seek("session-1", "message-5", true);
  assert.deepEqual(source.events, events.slice(0, 6));
  await assert.rejects(pager.seek("session-1", "missing-message"), HistoryCursorExpiredError);

  let now = 0;
  const expiring = new HistoryPager(async () => ({
    events: events.slice(-20), cursor: "next", cursorStatus: "ok", hasMore: true
  }), () => now);
  const snapshot = await expiring.read("session-1");
  assert.ok(snapshot.cursor);
  now += 5 * 60_000;
  await assert.rejects(expiring.read("session-1", snapshot.cursor), HistoryCursorExpiredError);
});

test("rejects native cursor expiry and malformed pages instead of returning partial success", async () => {
  for (const response of [
    { events: [], cursor: "", cursorStatus: "expired", hasMore: false },
    { events: [], cursor: "", cursorStatus: "ok", hasMore: true },
    { events: "not-events", cursor: "", cursorStatus: "ok", hasMore: false }
  ]) {
    const pager = new HistoryPager(async () => response);
    await assert.rejects(pager.read("session-1"));
  }
});

test("retries a failed history cursor without advancing or losing its pending events", async () => {
  let fail = true;
  const requests: Array<{ cursor?: string }> = [];
  const latestEvents = Array.from({ length: historyPageMaximumMessages }, (_, index) => ({
    id: `latest-${index}`,
    type: "user.message",
    data: { messageId: `latest-${index}`, content: `Latest ${index}` }
  }));
  const pager = new HistoryPager(async (request) => {
    requests.push(request);
    if (request.cursor === "native-cursor-1" && fail) {
      fail = false;
      throw new Error("Temporary persisted-history read failure");
    }
    if (request.cursor === undefined) {
      return {
        events: latestEvents,
        cursor: "native-cursor-1",
        cursorStatus: "ok",
        hasMore: true
      };
    }
    assert.equal(request.cursor, "native-cursor-1");
    return {
      events: [{ id: "older", type: "user.message", data: { messageId: "older", content: "Older" } }],
      cursor: "",
      cursorStatus: "ok",
      hasMore: false
    };
  });
  const first = await pager.read("session-1");
  assert.ok(first.cursor);
  await assert.rejects(pager.read("session-1", first.cursor), /Temporary persisted-history/);
  const retry = await pager.read("session-1", first.cursor);
  assert.equal(retry.events[0]?.id, "older");
  assert.equal(requests.filter((request) => request.cursor === "native-cursor-1").length, 2);
});

test("pages past empty tool-only assistant messages until it finds visible chat", async () => {
  const visible = pagingFixture(20).events;
  const toolRounds = Array.from({ length: 60 }, (_, index) => ({
    id: `tool-only-${index}`,
    type: "assistant.message",
    data: {
      messageId: `tool-only-message-${index}`,
      content: "",
      toolRequests: [{ toolCallId: `tool-only-call-${index}`, name: "read_file" }]
    }
  }));
  const events = [...visible, ...toolRounds];
  const calls: Array<{ cursor?: string }> = [];
  const positions = new Map<string, number>();
  const pager = new HistoryPager(async (request) => {
    calls.push(request);
    const end = request.cursor === undefined ? events.length : positions.get(request.cursor);
    assert.notEqual(end, undefined);
    const boundary = end ?? 0;
    const start = Math.max(0, boundary - request.max);
    const cursor = `page-${calls.length}-${start}`;
    positions.set(cursor, start);
    return {
      events: events.slice(start, boundary),
      cursor,
      cursorStatus: "ok",
      hasMore: start > 0
    };
  });
  const page = await pager.read("session-1");
  assert.equal(calls.length, 4);
  assert.equal(page.events.length, 80);
  assert.equal(page.events.filter((event) => (
    event.type === "user.message" ||
    (event.type === "assistant.message" && isRecord(event.data) &&
      typeof event.data.content === "string" && event.data.content.trim().length > 0)
  )).length, historyPageMaximumMessages);
  assert.deepEqual(page.events.slice(0, 20), visible);
  assert.equal(page.hasMore, false);
});

test("projects persisted tools and reasoning without duplicating chat text or subagent events", () => {
  const events = [
    { id: "user", type: "user.message", data: { messageId: "u", content: "Question" } },
    {
      id: "thought", type: "assistant.message",
      data: { messageId: "a", content: "", reasoningText: "Investigate", toolRequests: [
        { toolCallId: "tool-1", name: "Read files" }
      ] }
    },
    { id: "start", type: "tool.execution_start", data: { toolCallId: "tool-1", toolTitle: "Inspect source" } },
    {
      id: "finish", type: "tool.execution_complete",
      data: { toolCallId: "tool-1", success: true, result: { content: "Output" } }
    },
    { id: "child", type: "assistant.message", agentId: "child", data: { messageId: "child", content: "Hidden" } }
  ];
  const updates = historyReplayUpdates("session-1", events);
  assert.equal(updates.length, 5);
  assert.ok(updates.every((entry) => entry.sessionId === "session-1"));
  const final = updates.at(-1);
  assert.ok(final && isRecord(final.update));
  assert.equal(final.update.status, "completed");
  assert.deepEqual(final.update.content, { type: "text", text: "Output" });
  assert.equal(JSON.stringify(updates).includes("Question"), false);
  assert.equal(JSON.stringify(updates).includes("Hidden"), false);
});

test("keeps native chat separate while merging bounded tool details, commands, and live updates", () => {
  const events: JsonObject[] = [
    { id: "user-event", type: "user.message", data: { messageId: "user-1", content: "Question" } },
    {
      id: "tool-request", type: "assistant.message",
      data: { messageId: "assistant-tool", content: "", toolRequests: [
        { toolCallId: "tool-1", name: "read_file" }
      ] }
    },
    { id: "tool-start", type: "tool.execution_start", data: { toolCallId: "tool-1", toolTitle: "Read source" } },
    { id: "tool-end", type: "tool.execution_complete", data: {
      toolCallId: "tool-1", success: true, result: { detailedContent: "Stored output" }
    } },
    { id: "answer-event", type: "assistant.message", data: { messageId: "answer-1", content: "Persisted answer" } }
  ];
  const native = nativeMessagesFromEvents(events);
  const update = (sessionUpdate: string, messageId: string, text: string, extra: JsonObject = {}): JsonObject => ({
    sessionId: "session-1",
    update: {
      sessionUpdate,
      messageId,
      content: { type: "text", text },
      ...extra
    }
  });
  const cached: JsonObject[] = [
    update("user_message_chunk", "user-1", "Question"),
    update("agent_message_chunk", "assistant-tool", ""),
    {
      sessionId: "session-1",
      update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read source", status: "in_progress" }
    },
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "Read source",
        status: "completed", content: { type: "text", text: "Stored tool detail" }
      }
    },
    update("agent_message_chunk", "answer-1", "Recovered answer text"),
    {
      sessionId: "session-1",
      nativeCommand: true,
      clientPromptId: "command-prompt",
      update: { sessionUpdate: "agent_message_chunk", messageId: "command-answer", content: { type: "text", text: "MCP reload completed" } }
    },
    update("agent_message_chunk", "unrelated", "Do not include")
  ];
  const live: JsonObject[] = [{
    sessionId: "session-1",
    clientPromptId: "live-prompt",
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Live reasoning" } }
  }];
  const merged = mergePagedHistoryReplayUpdates("session-1", events, native, cached, live);
  const serialized = JSON.stringify(merged);
  assert.equal(serialized.includes("Question"), false);
  assert.equal(serialized.includes("Recovered answer text"), false);
  assert.ok(serialized.includes("Stored tool detail"));
  assert.ok(serialized.includes("MCP reload completed"));
  assert.ok(serialized.includes("Live reasoning"));
  assert.equal(serialized.includes("Do not include"), false);
  assert.equal(native.find((message) => message.messageId === "answer-1")?.content, "Persisted answer");
});

test("places cached reasoning and unpersisted tools after their native message anchors", () => {
  const events: JsonObject[] = [
    { type: "user.message", id: "user-event", data: { messageId: "user", content: "Question" } },
    { type: "assistant.message", id: "preamble-event", data: {
      messageId: "preamble", content: "I will investigate.",
      toolRequests: [{ toolCallId: "second-tool", name: "Run tests" }]
    } },
    { type: "tool.execution_complete", id: "tool-event", data: {
      toolCallId: "second-tool", success: true, result: { content: "Persisted completion" }
    } }
  ];
  const cached: JsonObject[] = [
    { afterMessageId: "user", update: {
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "First reasoning." }
    } },
    { afterMessageId: "user", update: {
      sessionUpdate: "tool_call", toolCallId: "first-tool", title: "Inspect code", status: "completed"
    } },
    { afterMessageId: "preamble", update: {
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Second reasoning." }
    } },
    { afterMessageId: "preamble", update: {
      sessionUpdate: "tool_call", toolCallId: "second-tool", title: "Run tests", status: "in_progress"
    } },
    { afterMessageId: "unrelated-user", update: {
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Do not include" }
    } }
  ];
  const replay = mergePagedHistoryReplayUpdates("session-1", events, nativeMessagesFromEvents(events), cached);
  assert.deepEqual(replay.map((params) => {
    assert.ok(isRecord(params.update));
    const update = params.update;
    return [update.sessionUpdate, update.messageId ?? update.toolCallId ??
      (isRecord(update.content) ? update.content.text : undefined), update.status];
  }), [
    ["user_message_chunk", "user", undefined],
    ["agent_thought_chunk", "First reasoning.", undefined],
    ["tool_call", "first-tool", "completed"],
    ["agent_message_chunk", "preamble", undefined],
    ["agent_thought_chunk", "Second reasoning.", undefined],
    ["tool_call", "second-tool", "in_progress"],
    ["tool_call_update", "second-tool", "completed"]
  ]);
  assert.equal(JSON.stringify(replay).includes("Do not include"), false);
  assert.equal(JSON.stringify(replay).includes("I will investigate."), false);
});

test("keeps a tool's cached completion with its original reply anchor", () => {
  const events: JsonObject[] = [
    { type: "user.message", id: "u", data: { messageId: "user", content: "Investigate" } },
    { type: "assistant.message", id: "a1", data: {
      messageId: "first", content: "I will investigate.",
      toolRequests: [{ toolCallId: "tool-1", name: "Read file" }]
    } },
    { type: "tool.execution_start", id: "ts", data: { toolCallId: "tool-1" } },
    { type: "tool.execution_complete", id: "te", data: {
      toolCallId: "tool-1", success: true, result: { content: "Read completed" }
    } },
    { type: "assistant.message", id: "a2", data: { messageId: "second", content: "File read." } }
  ];
  const cached: JsonObject[] = [
    { afterMessageId: "first", update: {
      sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read file", status: "in_progress"
    } },
    { afterMessageId: "second", update: {
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Now checking results." }
    } },
    { afterMessageId: "second", update: {
      sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed"
    } }
  ];
  const replay = mergePagedHistoryReplayUpdates("s", events, nativeMessagesFromEvents(events), cached);
  const toolUpdates = replay.filter((entry) => isRecord(entry.update) && entry.update.toolCallId === "tool-1");
  assert.equal(toolUpdates.length, 2);
  assert.deepEqual(toolUpdates.map((entry) => {
    assert.ok(isRecord(entry.update));
    return [entry.afterMessageId, entry.update.status];
  }), [["first", "in_progress"], ["first", "completed"]]);
  const completedEntry = toolUpdates[1];
  assert.ok(completedEntry);
  const completion = completedEntry.update;
  assert.ok(isRecord(completion) && isRecord(completion.content));
  assert.equal(completion.content.text, "Read completed");
  assert.ok(replay.indexOf(completedEntry) < replay.findIndex((entry) =>
    isRecord(entry.update) && entry.update.messageId === "second"));
  assert.equal(cached[2]?.afterMessageId, "second", "Merging must not mutate the source replay");
});

for (const cachedTitle of [undefined, "", "Copilot tool", "Latest descriptive title"]) {
  for (const status of ["in_progress", "completed"]) {
    test(`restores persisted tool metadata with ${cachedTitle ?? "missing title"} and ${status}`, () => {
      const events: JsonObject[] = [
        { type: "user.message", id: "u", data: { messageId: "user", content: "Inspect code" } },
        { type: "assistant.message", id: "r", data: { messageId: "request", content: "",
          toolRequests: [{ toolCallId: "tool-1", name: "read_file" }] } },
        { type: "tool.execution_start", id: "ts", data: {
          toolCallId: "tool-1", toolTitle: "Read important source"
        } },
        { type: "tool.execution_complete", id: "te", data: {
          toolCallId: "tool-1", success: true, result: { content: "Stored result" }
        } },
        { type: "assistant.message", id: "a", data: { messageId: "answer", content: "Inspected" } }
      ];
      const cached: JsonObject[] = [{
        afterMessageId: "user",
        update: {
          sessionUpdate: "tool_call_update", toolCallId: "tool-1", status,
          ...(cachedTitle !== undefined ? { title: cachedTitle } : {})
        }
      }];
      const replay = mergePagedHistoryReplayUpdates("s", events, nativeMessagesFromEvents(events), cached);
      const toolUpdates = replay.filter((entry) => isRecord(entry.update) && entry.update.toolCallId === "tool-1");
      const firstUpdate = toolUpdates[0]?.update;
      assert.ok(isRecord(firstUpdate));
      assert.equal(firstUpdate.title, cachedTitle === "Latest descriptive title"
        ? cachedTitle : "Read important source");
      assert.equal(firstUpdate.status, status);
      assert.equal(toolUpdates.length, status === "completed" ? 1 : 2);
      const lastUpdate = toolUpdates.at(-1)?.update;
      assert.ok(isRecord(lastUpdate) && isRecord(lastUpdate.content));
      assert.equal(lastUpdate.status, "completed");
      assert.equal(lastUpdate.content.text, "Stored result");
      assert.ok(isRecord(cached[0]?.update));
      assert.equal(cached[0].update.title, cachedTitle, "Persisted metadata must not mutate cached input");
    });
  }
}

test("keeps reasoning and tool progress when cached tool output exceeds the activity budget", () => {
  const events: JsonObject[] = [{
    type: "user.message", id: "user-event", data: { messageId: "user", content: "Question" }
  }];
  const cached: JsonObject[] = [
    { afterMessageId: "user", update: {
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Preserved reasoning." }
    } },
    { afterMessageId: "user", update: {
      sessionUpdate: "tool_call_update", toolCallId: "large-tool", title: "Read a large file",
      status: "completed", content: { type: "text", text: "x".repeat(historyPageMaximumBytes) }
    } }
  ];
  let truncated = false;
  const replay = mergePagedHistoryReplayUpdates("session-1", events, nativeMessagesFromEvents(events),
    cached, [], () => { truncated = true; });
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(replay)) < historyPageMaximumBytes / 2);
  assert.ok(JSON.stringify(replay).includes("Preserved reasoning."));
  assert.ok(replay.some((params) => isRecord(params.update) &&
    params.update.toolCallId === "large-tool" && params.update.status === "completed"));
  assert.equal(isRecord(cached[1]?.update) && isRecord(cached[1].update.content) &&
    String(cached[1].update.content.text).length, historyPageMaximumBytes);
});

test("anchors cached activity after a native reply that is still streaming", () => {
  const events: JsonObject[] = [
    { type: "user.message", id: "user-event", data: { messageId: "user", content: "Question" } },
    { type: "assistant.message_start", id: "start-event", data: { messageId: "streaming" } },
    { type: "assistant.message_delta", id: "delta-event", data: {
      messageId: "streaming", deltaContent: "An update."
    } }
  ];
  const cached: JsonObject[] = [{
    afterMessageId: "streaming",
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Keep thinking." } }
  }];
  const replay = mergePagedHistoryReplayUpdates("session-1", events, nativeMessagesFromEvents(events), cached);
  assert.deepEqual(replay.map((params) => {
    assert.ok(isRecord(params.update));
    return [params.update.sessionUpdate, params.update.messageId ?? params.afterMessageId];
  }), [
    ["user_message_chunk", "user"],
    ["agent_message_chunk", "streaming"],
    ["agent_thought_chunk", "streaming"]
  ]);
});

test("budgets UTF-8 text and attachment data instead of only counting messages", async () => {
  const unicode = pagingFixture(4, "\u{1f600}".repeat(20_000));
  const textPage = await unicode.pager.read("session-1");
  assert.equal(textPage.events.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(textPage.events)) < historyPageMaximumBytes);
  const attachments = pagingFixture(4);
  const data = Buffer.alloc(48 * 1024).toString("base64");
  for (const event of attachments.events) {
    assert.ok(isRecord(event.data));
    event.data.attachments = [{ displayName: "image.png", mimeType: "image/png", data }];
  }
  const attachmentPage = await attachments.pager.read("session-1");
  assert.equal(attachmentPage.events.length, 1);
  assert.deepEqual(attachmentPage.events, attachments.events.slice(-1));
});
