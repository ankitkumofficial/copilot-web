import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { isRecord, type JsonObject } from "./acp.js";

const persistedEventPageSize = 200;
const maximumPersistedHistoryPages = 10_000;
const attachmentMimeTypePattern = /^[a-z0-9!#$%&'+.^_`|~-]+\/[a-z0-9!#$%&'+.^_`|~-]+$/;
const nativeMessageEventTypes = new Set([
  "user.message",
  "assistant.message_start",
  "assistant.message_delta",
  "assistant.message"
]);

export interface PersistedEventsRequest {
  sessionId: string;
  cursor?: string;
  max: number;
  direction?: "backward";
}

export interface PersistedEventsPage {
  cursor: string;
  cursorStatus: "ok" | "expired";
  events: JsonObject[];
  hasMore: boolean;
}

export type PersistedEventsPageReader = (
  request: PersistedEventsRequest
) => Promise<unknown>;

export interface NativeAttachment {
  name: string;
  mimeType: string;
  data: string;
}

export interface NativeMessage {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  attachments: NativeAttachment[];
  completion: "streaming" | "completed";
  eventId: string;
  revision: number;
  reasoningText?: string;
  updatedAt?: string;
  timestamp?: string;
  clientPromptId?: string;
  toolCallIds?: string[];
}

export interface NativeMessageCollection {
  eventIds: Set<string>;
  messages: Map<string, NativeMessage>;
  order: string[];
}

interface CopilotSdkClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  rpc?: {
    sessions?: {
      readPersistedEvents?: PersistedEventsPageReader;
    };
  };
}

interface CopilotSdkModule {
  CopilotClient: new (options: {
    connection: unknown;
    workingDirectory: string;
    logLevel: "error";
  }) => CopilotSdkClient;
  RuntimeConnection: {
    forStdio(options: { path: string; args: string[] }): unknown;
  };
}

export interface CopilotHistoryReaderOptions {
  sdkPath?: string;
  command: string;
  cwd: string;
  allowAll: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): number | undefined {
  return isRecord(error) && typeof error.code === "number"
    ? error.code
    : undefined;
}

function isUnsupportedHistoryApi(error: unknown): boolean {
  if (errorCode(error) === -32601) {
    return true;
  }
  const message = errorMessage(error).toLowerCase();
  return message.includes("method not found") ||
    message.includes("unknown method") ||
    message.includes("unsupported method");
}

function isMissingHistoryJournal(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("persisted event journal is unavailable") ||
    message.includes("session not found") ||
    message.includes("no persisted event journal");
}

function parsePersistedEventsPage(value: unknown): PersistedEventsPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.events) ||
    typeof value.cursor !== "string" ||
    typeof value.hasMore !== "boolean" ||
    (value.cursorStatus !== "ok" && value.cursorStatus !== "expired")
  ) {
    throw new Error("Copilot returned an invalid persisted-history page");
  }
  if (!value.events.every(isRecord)) {
    throw new Error("Copilot returned an invalid persisted-history event");
  }
  return {
    cursor: value.cursor,
    cursorStatus: value.cursorStatus,
    events: value.events,
    hasMore: value.hasMore
  };
}

export const historyPageMaximumMessages = 20;
export const historyPageMaximumBytes = 128 * 1024;
const historyCursorLifetimeMs = 4 * 60_000;
const maximumHistoryCursors = 8;
const maximumHistoryCacheBytes = 8 * 1024 * 1024;

export class HistoryCursorExpiredError extends Error {
  public constructor() {
    super("Conversation history has changed or its page expired. Reload the latest messages to continue.");
  }
}

export interface HistoryPage {
  events: JsonObject[];
  cursor?: string;
  hasMore: boolean;
  oversized: boolean;
}

interface HistorySnapshot {
  sessionId: string;
  pending: JsonObject[];
  sourceCursor?: string;
  hasMore: boolean;
}

interface HistoryCursor {
  sessionId: string;
  touchedAt: number;
  snapshot: HistorySnapshot;
  result?: Promise<HistoryPage> | undefined;
  bytes: number;
}

function isHistoryEvent(event: JsonObject): boolean {
  return isRootAgentMessageEvent(event) && (
    isNativeMessageEvent(event) ||
    event.type === "tool.execution_start" ||
    event.type === "tool.execution_complete"
  );
}

function isDisplayableMessageEvent(event: JsonObject): boolean {
  if (!isNativeMessageEvent(event) || !isRecord(event.data)) {
    return false;
  }
  if (event.type === "user.message") {
    return (typeof event.data.content === "string" && event.data.content.length > 0) ||
      nativeAttachments(event.data.attachments).length > 0;
  }
  return event.type === "assistant.message" &&
    ((typeof event.data.content === "string" && event.data.content.trim().length > 0) ||
      nativeAttachments(event.data.attachments).length > 0);
}

// These snapshots are display-only. No cursor or page is used to resume or prompt an AI session.
export class HistoryPager {
  private readonly cursors = new Map<string, HistoryCursor>();

  public constructor(
    private readonly readPage: PersistedEventsPageReader,
    private readonly now: () => number = Date.now
  ) {}

  public async read(sessionId: string, cursor?: string): Promise<HistoryPage> {
    this.prune();
    if (cursor !== undefined) {
      const continuation = this.cursors.get(cursor);
      if (!continuation || continuation.sessionId !== sessionId) {
        throw new HistoryCursorExpiredError();
      }
      continuation.touchedAt = this.now();
      // Native cursors are single-use: retries share a successful read, but a failed read is retryable.
      if (!continuation.result) {
        const snapshot = {
          ...continuation.snapshot,
          pending: [...continuation.snapshot.pending]
        };
        continuation.result = this.next(snapshot).then((page) => {
          continuation.bytes += Buffer.byteLength(JSON.stringify(page));
          this.prune();
          return page;
        }).catch((error: unknown) => {
          continuation.result = undefined;
          throw error;
        });
      }
      return continuation.result;
    }
    return this.next({ sessionId, pending: [], hasMore: true });
  }

  public forget(sessionId: string): void {
    for (const [cursor, continuation] of this.cursors) {
      if (continuation.sessionId === sessionId) {
        this.cursors.delete(cursor);
      }
    }
  }

  public async seek(sessionId: string, messageId: string, includeMessage = false): Promise<HistoryPage> {
    let page = await this.read(sessionId);
    for (let count = 0; count < maximumPersistedHistoryPages; count += 1) {
      let index = -1;
      for (let candidate = page.events.length - 1; candidate >= 0; candidate -= 1) {
        const event = page.events[candidate];
        if (event && isNativeMessageEvent(event) && isRecord(event.data) &&
            event.data.messageId === messageId) {
          index = candidate;
          break;
        }
      }
      if (index >= 0) {
        const events = page.events.slice(0, index + (includeMessage ? 1 : 0));
        if (events.length === 0 && page.cursor) {
          return this.read(sessionId, page.cursor);
        }
        return { ...page, events };
      }
      if (!page.cursor) {
        throw new HistoryCursorExpiredError();
      }
      page = await this.read(sessionId, page.cursor);
    }
    throw new Error("Conversation history is too large to locate this message");
  }

  private prune(): void {
    let bytes = 0;
    const oldest = [...this.cursors].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [cursor, continuation] of oldest) {
      if (this.now() - continuation.touchedAt >= historyCursorLifetimeMs) {
        this.cursors.delete(cursor);
      } else {
        bytes += continuation.bytes;
      }
    }
    for (const [cursor, continuation] of oldest) {
      if (this.cursors.size <= maximumHistoryCursors && bytes <= maximumHistoryCacheBytes) {
        break;
      }
      if (this.cursors.delete(cursor)) {
        bytes -= continuation.bytes;
      }
    }
  }

  private async next(snapshot: HistorySnapshot): Promise<HistoryPage> {
    const events: JsonObject[] = [];
    let bytes = 2;
    let displayableMessages = 0;
    let reads = 0;
    while (true) {
      if (displayableMessages >= historyPageMaximumMessages) {
        break;
      }
      if (snapshot.pending.length === 0) {
        if (!snapshot.hasMore || reads >= 8) {
          break;
        }
        const previousCursor = snapshot.sourceCursor;
        const page = parsePersistedEventsPage(await this.readPage({
          sessionId: snapshot.sessionId,
          max: historyPageMaximumMessages,
          direction: "backward",
          ...(previousCursor === undefined ? {} : { cursor: previousCursor })
        }));
        if (page.cursorStatus === "expired") {
          throw new HistoryCursorExpiredError();
        }
        if (page.hasMore && (!page.cursor || page.cursor === previousCursor)) {
          throw new Error("Copilot returned an invalid backward-history cursor");
        }
        snapshot.pending = page.events.filter(isHistoryEvent);
        snapshot.sourceCursor = page.cursor;
        snapshot.hasMore = page.hasMore;
        reads += 1;
        if (snapshot.pending.length === 0) {
          continue;
        }
      }
      const event = snapshot.pending.at(-1);
      if (!event) {
        break;
      }
      const eventBytes = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (events.length > 0 && (
        bytes + eventBytes > historyPageMaximumBytes - 16 * 1024 ||
        displayableMessages >= historyPageMaximumMessages
      )) {
        break;
      }
      snapshot.pending.pop();
      events.unshift(event);
      bytes += eventBytes;
      if (isDisplayableMessageEvent(event)) {
        displayableMessages += 1;
      }
    }
    const hasMore = snapshot.pending.length > 0 || snapshot.hasMore;
    const result: HistoryPage = {
      events,
      hasMore,
      oversized: bytes > historyPageMaximumBytes
    };
    if (hasMore) {
      const cursor = randomUUID();
      result.cursor = cursor;
      this.cursors.set(cursor, {
        sessionId: snapshot.sessionId,
        snapshot,
        touchedAt: this.now(),
        bytes: Buffer.byteLength(JSON.stringify(snapshot.pending))
      });
      this.prune();
    }
    return result;
  }
}

export function historyReplayUpdates(sessionId: string, events: readonly JsonObject[]): JsonObject[] {
  const updates: JsonObject[] = [];
  for (const event of events) {
    if (!isHistoryEvent(event) || !isRecord(event.data)) {
      continue;
    }
    const data = event.data;
    if (isNativeMessageEvent(event)) {
      if (event.type === "assistant.message_start" || event.type === "assistant.message_delta") {
        continue;
      }
      updates.push({
        sessionId,
        update: {
          sessionUpdate: event.type === "user.message" ? "user_message_chunk" : "agent_message_chunk",
          messageId: data.messageId,
          content: { type: "text", text: "" }
        }
      });
      if (Array.isArray(data.toolRequests)) {
        for (const tool of data.toolRequests) {
          if (isRecord(tool) && typeof tool.toolCallId === "string") {
            updates.push({
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: tool.toolCallId,
                title: typeof tool.name === "string" ? tool.name : "Copilot tool",
                status: "pending"
              }
            });
          }
        }
      }
    } else if (typeof data.toolCallId === "string") {
      const result = isRecord(data.result) ? data.result : undefined;
      const error = isRecord(data.error) ? data.error : undefined;
      const detail = typeof result?.detailedContent === "string" ? result.detailedContent
        : typeof result?.content === "string" ? result.content
          : typeof error?.message === "string" ? error.message
            : "";
      updates.push({
        sessionId,
        update: {
          sessionUpdate: event.type === "tool.execution_start" ? "tool_call" : "tool_call_update",
          toolCallId: data.toolCallId,
          ...(typeof data.toolTitle === "string" ? { title: data.toolTitle }
            : typeof data.toolName === "string" ? { title: data.toolName } : {}),
          status: event.type === "tool.execution_start" ? "in_progress"
            : data.success === false ? "failed" : "completed",
          ...(detail ? { content: { type: "text", text: detail } } : {})
        }
      });
    }
  }
  return updates;
}

export function thoughtChunkText(params: JsonObject | undefined): string | undefined {
  const update = isRecord(params?.update) ? params.update : undefined;
  const content = isRecord(update?.content) ? update.content : undefined;
  return update?.sessionUpdate === "agent_thought_chunk" && content?.type === "text" &&
    typeof content.text === "string" ? content.text : undefined;
}

export function mergePagedHistoryReplayUpdates(
  sessionId: string,
  events: readonly JsonObject[],
  nativeMessages: readonly NativeMessage[],
  cachedReplay: readonly JsonObject[],
  liveReplay: readonly JsonObject[] = [],
  onActivityTruncated?: () => void
): JsonObject[] {
  const nativeById = new Map(nativeMessages.map((message) => [message.messageId, message]));
  const toolCallIds = new Set<string>();
  for (const message of nativeMessages) {
    for (const toolCallId of message.toolCallIds ?? []) {
      toolCallIds.add(toolCallId);
    }
  }
  for (const event of events) {
    if (!isHistoryEvent(event) || !isRecord(event.data)) {
      continue;
    }
    const data = event.data;
    if (typeof data.toolCallId === "string") {
      toolCallIds.add(data.toolCallId);
    }
    if (Array.isArray(data.toolRequests)) {
      for (const request of data.toolRequests) {
        if (isRecord(request) && typeof request.toolCallId === "string") {
          toolCallIds.add(request.toolCallId);
        }
      }
    }
  }

  const cachedTools = new Map<string, JsonObject[]>();
  const cachedCommands = new Map<string, JsonObject[]>();
  // Native message IDs keep unpersisted activity beside the visible message it followed.
  const cachedActivity = new Map<string, JsonObject[]>();
  const activityToolAnchors = new Map<string, string>();
  for (const params of cachedReplay) {
    if (!isRecord(params.update)) {
      continue;
    }
    const update = params.update;
    if (
      typeof params.afterMessageId === "string" &&
      nativeById.has(params.afterMessageId) &&
      (update.sessionUpdate === "agent_thought_chunk" ||
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update" ||
        update.sessionUpdate === "plan" ||
        (params.nativeFallback === true && update.sessionUpdate === "agent_message_chunk"))
    ) {
      let anchor = params.afterMessageId;
      let activity = params;
      if (typeof update.toolCallId === "string") {
        anchor = activityToolAnchors.get(update.toolCallId) ?? anchor;
        activityToolAnchors.set(update.toolCallId, anchor);
        // The browser never renders raw tool payloads, which can be several times larger than content.
        if ("rawInput" in update || "rawOutput" in update) {
          const { rawInput: _rawInput, rawOutput: _rawOutput, ...displayUpdate } = update;
          activity = { ...params, update: displayUpdate };
        }
      }
      const group = cachedActivity.get(anchor) ?? [];
      const previous = group.at(-1);
      const previousThought = previous ? thoughtChunkText(previous) : undefined;
      const thought = thoughtChunkText(activity);
      if (previous && isRecord(previous.update) && previousThought !== undefined && thought !== undefined &&
          previous.update.messageId === update.messageId) {
        // Thoughts stream almost per token; one envelope per fragment would exhaust the activity budget.
        group[group.length - 1] = {
          ...activity,
          update: { ...update, content: { type: "text", text: previousThought + thought } }
        };
      } else {
        group.push(anchor === params.afterMessageId ? activity : { ...activity, afterMessageId: anchor });
      }
      cachedActivity.set(anchor, group);
      continue;
    }
    if (params.nativeCommand === true) {
      const promptId = typeof params.clientPromptId === "string"
        ? params.clientPromptId
        : "legacy-command";
      const group = cachedCommands.get(promptId) ?? [];
      group.push(params);
      cachedCommands.set(promptId, group);
      continue;
    }
    const toolCallId = typeof update.toolCallId === "string"
      ? update.toolCallId
      : undefined;
    if (!toolCallId || !toolCallIds.has(toolCallId)) {
      continue;
    }
    const group = cachedTools.get(toolCallId) ?? [];
    group.push(params);
    cachedTools.set(toolCallId, group);
  }

  const maximumCachedBytes = Math.floor(historyPageMaximumBytes / 2);
  let cachedBytes = 0;
  const keepRecentGroups = (
    groups: Map<string, JsonObject[]>,
    maximumGroups = groups.size,
    preserveActivity = false
  ): Map<string, JsonObject[]> => {
    const entries = [...groups].slice(-maximumGroups);
    const kept: Array<[string, JsonObject[]]> = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      let updates = entry[1];
      let size = Buffer.byteLength(JSON.stringify(updates));
      if (preserveActivity && cachedBytes + size > maximumCachedBytes) {
        // Large tool output must not evict the entire Thinking panel.
        updates = updates.map((params) => {
          if (!isRecord(params.update) || typeof params.update.toolCallId !== "string") {
            return params;
          }
          const { content: _content, ...metadata } = params.update;
          return { ...params, update: metadata };
        });
        size = Buffer.byteLength(JSON.stringify(updates));
        if (cachedBytes + size > maximumCachedBytes) {
          updates = updates.filter((params) => (
            !isRecord(params.update) || params.update.sessionUpdate !== "agent_thought_chunk"
          ));
          size = Buffer.byteLength(JSON.stringify(updates));
        }
        onActivityTruncated?.();
      }
      if (cachedBytes + size <= maximumCachedBytes) {
        cachedBytes += size;
        kept.unshift([entry[0], updates]);
      }
    }
    return new Map(kept);
  };
  const recentActivity = keepRecentGroups(cachedActivity, cachedActivity.size, true);
  const activityToolIds = new Set([...recentActivity.values()].flatMap((updates) => (
    updates.flatMap((params) => isRecord(params.update) && typeof params.update.toolCallId === "string"
      ? [params.update.toolCallId] : [])
  )));
  const recentTools = keepRecentGroups(cachedTools);
  const recentCommands = keepRecentGroups(cachedCommands, 4);
  const result: JsonObject[] = [];
  const emittedTools = new Set<string>();
  const baseUpdates = historyReplayUpdates(sessionId, events);
  const persistedToolMetadata = new Map<string, JsonObject>();
  const persistedToolCompletions = new Map<string, JsonObject>();
  const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
  for (const params of baseUpdates) {
    if (isRecord(params.update) && typeof params.update.toolCallId === "string") {
      const { sessionUpdate: _sessionUpdate, status: _status, content: _content, ...metadata } = params.update;
      persistedToolMetadata.set(params.update.toolCallId, {
        ...persistedToolMetadata.get(params.update.toolCallId), ...metadata
      });
      if (terminalStatuses.has(String(params.update.status))) {
        persistedToolCompletions.set(params.update.toolCallId, params);
      }
    }
  }
  const emittedActivity = new Set<string>();
  const appendActivity = (messageId: string | undefined): void => {
    if (messageId === undefined || emittedActivity.has(messageId)) {
      return;
    }
    const updates = recentActivity.get(messageId);
    if (!updates) {
      return;
    }
    emittedActivity.add(messageId);
    result.push(...updates.map((params) => {
      if (!isRecord(params.update) || typeof params.update.toolCallId !== "string") {
        return params;
      }
      const metadata = persistedToolMetadata.get(params.update.toolCallId);
      const completion = persistedToolCompletions.get(params.update.toolCallId);
      const persistedContent = isRecord(completion?.update) ? completion.update.content : undefined;
      const restoreTitle = (!params.update.title || params.update.title === "Copilot tool") &&
        typeof metadata?.title === "string";
      const restoreContent = terminalStatuses.has(String(params.update.status)) &&
        !params.update.content && persistedContent !== undefined;
      return {
        ...params,
        update: {
          ...metadata,
          ...params.update,
          ...(restoreTitle ? { title: metadata.title } : {}),
          ...(restoreContent ? { content: persistedContent } : {})
        }
      };
    }));
    const lastToolStatuses = new Map<string, unknown>();
    for (const params of updates) {
      if (isRecord(params.update) && typeof params.update.toolCallId === "string") {
        lastToolStatuses.set(params.update.toolCallId, params.update.status);
      }
    }
    for (const [toolCallId, status] of lastToolStatuses) {
      const completion = persistedToolCompletions.get(toolCallId);
      if (completion && !terminalStatuses.has(String(status))) {
        result.push(completion);
      }
    }
  };
  const appendDetachedActivity = (messageId: string): void => {
    const message = nativeById.get(messageId);
    if (!message || emittedActivity.has(messageId)) {
      return;
    }
    result.push({
      sessionId,
      update: {
        sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
        messageId,
        content: { type: "text", text: "" }
      }
    });
    appendActivity(messageId);
  };
  const pageMessageIds = new Set(baseUpdates.flatMap((params) => (
    isRecord(params.update) && typeof params.update.messageId === "string" &&
    (params.update.sessionUpdate === "user_message_chunk" ||
      params.update.sessionUpdate === "agent_message_chunk")
      ? [params.update.messageId] : []
  )));
  const activityAnchors = [...recentActivity.keys()];
  const firstPagedAnchor = activityAnchors.findIndex((messageId) => pageMessageIds.has(messageId));
  const pageStartedAt = Date.parse(String(events.find((event) => typeof event.timestamp === "string")?.timestamp));
  // A busy turn can start before this page; its earlier activity must stay above the page content.
  activityAnchors.forEach((messageId, index) => {
    if (pageMessageIds.has(messageId)) {
      return;
    }
    const message = nativeById.get(messageId);
    const messageAt = Date.parse(message?.timestamp ?? message?.updatedAt ?? "");
    if (firstPagedAnchor >= 0 ? index < firstPagedAnchor : messageAt < pageStartedAt) {
      appendDetachedActivity(messageId);
    }
  });
  let anchor: string | undefined;
  for (const params of baseUpdates) {
    const update = isRecord(params.update) ? params.update : undefined;
    if ((update?.sessionUpdate === "user_message_chunk" ||
         update?.sessionUpdate === "agent_message_chunk") &&
        typeof update.messageId === "string") {
      appendActivity(anchor);
      anchor = update.messageId;
    }
    const toolCallId = typeof update?.toolCallId === "string"
      ? update.toolCallId
      : undefined;
    if (toolCallId) {
      if (activityToolIds.has(toolCallId)) {
        continue;
      }
      const cached = recentTools.get(toolCallId);
      if (cached && !emittedTools.has(toolCallId)) {
        result.push(...cached);
        emittedTools.add(toolCallId);
      }
    }
    result.push(params);
  }
  appendActivity(anchor);
  for (const messageId of activityAnchors) {
    appendDetachedActivity(messageId);
  }
  for (const updates of recentCommands.values()) {
    result.push(...updates);
  }
  result.push(...liveReplay);
  return result;
}

export async function readAllPersistedEvents(
  readPage: PersistedEventsPageReader,
  sessionId: string,
  includeEvent: (event: JsonObject) => boolean = () => true
): Promise<JsonObject[]> {
  const events: JsonObject[] = [];
  const usedCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;

  while (true) {
    pageCount += 1;
    if (pageCount > maximumPersistedHistoryPages) {
      throw new Error(
        `Copilot persisted history exceeded ${maximumPersistedHistoryPages} pages for conversation ${sessionId}`
      );
    }
    const page = parsePersistedEventsPage(await readPage({
      sessionId,
      max: persistedEventPageSize,
      ...(cursor === undefined ? {} : { cursor })
    }));
    if (page.cursorStatus === "expired") {
      throw new Error(
        `Copilot persisted history expired while reading conversation ${sessionId}; no partial history was loaded`
      );
    }
    events.push(...page.events.filter(includeEvent));
    if (!page.hasMore) {
      return events;
    }
    if (!page.cursor || usedCursors.has(page.cursor)) {
      throw new Error(
        `Copilot returned an invalid persisted-history cursor for conversation ${sessionId}`
      );
    }
    usedCursors.add(page.cursor);
    cursor = page.cursor;
  }
}

export class CopilotHistoryReader {
  private client: CopilotSdkClient | undefined;
  private ready = false;
  private failure: string | undefined;

  public constructor(private readonly options: CopilotHistoryReaderOptions) {}

  public get available(): boolean {
    return this.ready;
  }

  public async initialize(): Promise<void> {
    if (!this.options.sdkPath) {
      this.failure = "The installed Copilot SDK could not be found";
      return;
    }

    try {
      const loaded: unknown = await import(pathToFileURL(this.options.sdkPath).href);
      if (!isRecord(loaded)) {
        throw new Error("The installed Copilot SDK did not export a module object");
      }
      const sdk = loaded as unknown as CopilotSdkModule;
      if (
        typeof sdk.CopilotClient !== "function" ||
        !isRecord(sdk.RuntimeConnection) ||
        typeof sdk.RuntimeConnection.forStdio !== "function"
      ) {
        throw new Error("The installed Copilot SDK does not expose its stdio client");
      }

      this.client = new sdk.CopilotClient({
        connection: sdk.RuntimeConnection.forStdio({
          path: this.options.command,
          args: this.options.allowAll ? ["--allow-all"] : []
        }),
        workingDirectory: this.options.cwd,
        logLevel: "error"
      });
      await this.client.start();
      const readPage = this.currentPageReader();

      try {
        parsePersistedEventsPage(await readPage({
          sessionId: randomUUID(),
          max: 1
        }));
        this.ready = true;
      } catch (error) {
        if (isUnsupportedHistoryApi(error)) {
          throw new Error(
            "The installed Copilot CLI does not support sessions.readPersistedEvents"
          );
        }
        if (!isMissingHistoryJournal(error)) {
          throw error;
        }
        this.ready = true;
      }
    } catch (error) {
      this.failure = errorMessage(error);
      if (this.client) {
        await this.client.stop().catch(() => {});
        this.client = undefined;
      }
    }
  }

  public async read(sessionId: string): Promise<JsonObject[]> {
    if (!this.ready || !this.client) {
      throw new Error(
        this.failure ?? "Copilot persisted message history is unavailable"
      );
    }

    await this.client.start();
    // The SDK recreates RPC bindings after reconnecting, so resolve them for every read.
    return readAllPersistedEvents(
      this.currentPageReader(),
      sessionId,
      (event) => isNativeMessageEvent(event) && isRootAgentMessageEvent(event)
    );
  }

  public async readPage(request: PersistedEventsRequest): Promise<unknown> {
    if (!this.ready || !this.client) {
      throw new Error(this.failure ?? "Copilot persisted message history is unavailable");
    }
    await this.client.start();
    return this.currentPageReader()(request);
  }

  private currentPageReader(): PersistedEventsPageReader {
    const sessions = this.client?.rpc?.sessions;
    const readPersistedEvents = sessions?.readPersistedEvents;
    if (!sessions || typeof readPersistedEvents !== "function") {
      throw new Error(
        "The installed Copilot SDK does not expose sessions.readPersistedEvents"
      );
    }
    return (request) => readPersistedEvents.call(sessions, request);
  }

  public async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      await client.stop();
    }
  }
}

export function createNativeMessageCollection(): NativeMessageCollection {
  return {
    eventIds: new Set(),
    messages: new Map(),
    order: []
  };
}

export function isNativeMessageEvent(event: JsonObject): boolean {
  return typeof event.type === "string" && nativeMessageEventTypes.has(event.type);
}

export function isRootAgentMessageEvent(event: JsonObject): boolean {
  if (typeof event.agentId === "string" && event.agentId.length > 0) {
    return false;
  }
  const data = isRecord(event.data) ? event.data : undefined;
  if (
    (typeof data?.agentId === "string" && data.agentId.length > 0) ||
    (typeof data?.parentToolCallId === "string" && data.parentToolCallId.length > 0) ||
    (typeof data?.source === "string" && data.source.startsWith("agent-"))
  ) {
    return false;
  }
  return true;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function attachmentName(attachment: JsonObject): string {
  const displayName = typeof attachment.displayName === "string"
    ? attachment.displayName.trim()
    : "";
  if (displayName) {
    return displayName;
  }
  const name = typeof attachment.name === "string" ? attachment.name.trim() : "";
  if (name) {
    return name;
  }
  const filePath = typeof attachment.path === "string" ? attachment.path : "";
  const basename = filePath.split(/[\\/]/).at(-1)?.trim();
  return basename || "Attachment";
}

function attachmentMimeType(attachment: JsonObject): string {
  const mimeType = typeof attachment.mimeType === "string"
    ? attachment.mimeType.toLowerCase().split(";", 1)[0]?.trim()
    : undefined;
  if (
    mimeType &&
    mimeType !== "application/octet-stream" &&
    attachmentMimeTypePattern.test(mimeType)
  ) {
    return mimeType;
  }
  const name = attachmentName(attachment).toLowerCase();
  if (name.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (name.endsWith(".png")) {
    return "image/png";
  }
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (name.endsWith(".gif")) {
    return "image/gif";
  }
  if (name.endsWith(".webp")) {
    return "image/webp";
  }
  if (name.endsWith(".avif")) {
    return "image/avif";
  }
  if (name.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

function nativeAttachments(value: unknown): NativeAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const attachments: NativeAttachment[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const mimeType = attachmentMimeType(item);
    const data = typeof item.data === "string" ? item.data : undefined;
    if (
      !mimeType ||
      !data ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    ) {
      continue;
    }
    attachments.push({
      name: attachmentName(item),
      mimeType,
      data
    });
  }
  return attachments;
}

function nativeMessageKey(role: NativeMessage["role"], messageId: string): string {
  return `${role}:${messageId}`;
}

function copyNativeMessage(message: NativeMessage): NativeMessage {
  return {
    ...message,
    attachments: message.attachments.map((attachment) => ({ ...attachment })),
    ...(message.toolCallIds ? { toolCallIds: [...message.toolCallIds] } : {})
  };
}

function toolCallIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .map((request) => isRecord(request) ? request.toolCallId : undefined)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
}

export function applyNativeMessageEvent(
  collection: NativeMessageCollection,
  event: JsonObject,
  options: { clientPromptId?: string; liveEventId?: string } = {}
): NativeMessage | undefined {
  const persistedEventId = typeof event.id === "string" && event.id ? event.id : undefined;
  const eventId = persistedEventId ?? options.liveEventId;
  if (
    !isNativeMessageEvent(event) ||
    !isRootAgentMessageEvent(event) ||
    !eventId ||
    !isRecord(event.data) ||
    typeof event.data.messageId !== "string" ||
    !event.data.messageId
  ) {
    return undefined;
  }
  // Live ACP events have no event id and cannot be redelivered, so only persisted ids are retained.
  if (persistedEventId) {
    if (collection.eventIds.has(persistedEventId)) {
      return undefined;
    }
    collection.eventIds.add(persistedEventId);
  }

  const role = event.type === "user.message" ? "user" : "assistant";
  const messageId = event.data.messageId;
  const key = nativeMessageKey(role, messageId);
  const previous = collection.messages.get(key);
  const revision = (previous?.revision ?? 0) + 1;
  const reasoningText = typeof event.data.reasoningText === "string"
    ? event.data.reasoningText
    : previous?.reasoningText;
  const reasoning = reasoningText === undefined ? {} : { reasoningText };
  let message: NativeMessage;

  if (event.type === "user.message") {
    message = {
      messageId,
      role,
      content: typeof event.data.content === "string" ? event.data.content : "",
      attachments: nativeAttachments(event.data.attachments),
      completion: "completed",
      eventId,
      revision,
      ...(validTimestamp(event.timestamp) ? {
        timestamp: event.timestamp,
        updatedAt: event.timestamp
      } : {}),
      ...(options.clientPromptId ? { clientPromptId: options.clientPromptId } : {})
    };
  } else if (event.type === "assistant.message_start") {
    if (previous?.completion === "completed") {
      return undefined;
    }
    message = {
      messageId,
      role,
      content: previous?.content ?? "",
      attachments: previous?.attachments ?? [],
      completion: "streaming",
      eventId,
      revision,
      ...reasoning,
      ...(validTimestamp(event.timestamp) ? { updatedAt: event.timestamp } : {})
    };
  } else if (event.type === "assistant.message_delta") {
    if (previous?.completion === "completed") {
      return undefined;
    }
    message = {
      messageId,
      role,
      content: `${previous?.content ?? ""}${
        typeof event.data.deltaContent === "string" ? event.data.deltaContent : ""
      }`,
      attachments: previous?.attachments ?? [],
      completion: "streaming",
      eventId,
      revision,
      ...reasoning,
      ...(validTimestamp(event.timestamp) ? { updatedAt: event.timestamp } : {})
    };
  } else {
    message = {
      messageId,
      role,
      content: typeof event.data.content === "string" ? event.data.content : "",
      attachments: [],
      completion: "completed",
      eventId,
      revision,
      ...reasoning,
      ...(validTimestamp(event.timestamp) ? {
        timestamp: event.timestamp,
        updatedAt: event.timestamp
      } : {}),
      ...(options.clientPromptId ? { clientPromptId: options.clientPromptId } : {}),
      ...(toolCallIds(event.data.toolRequests).length > 0
        ? { toolCallIds: toolCallIds(event.data.toolRequests) }
        : {})
    };
  }

  if (options.clientPromptId) {
    message.clientPromptId = options.clientPromptId;
  } else if (previous?.clientPromptId) {
    message.clientPromptId = previous.clientPromptId;
  }
  if (!previous) {
    collection.order.push(key);
  }
  collection.messages.set(key, message);
  return copyNativeMessage(message);
}

export function nativeMessagesFromEvents(
  events: readonly JsonObject[]
): NativeMessage[] {
  const collection = createNativeMessageCollection();
  for (const event of events) {
    applyNativeMessageEvent(collection, event);
  }
  return collection.order
    .map((key) => collection.messages.get(key))
    .filter((message): message is NativeMessage => message !== undefined)
    .map(copyNativeMessage);
}

export function mergeNativeMessages(
  persistedEvents: readonly JsonObject[],
  bufferedEvents: readonly JsonObject[],
  liveMessages: readonly NativeMessage[]
): NativeMessage[] {
  const mergedEvents: JsonObject[] = [];
  const eventIndexes = new Map<string, number>();
  for (const event of persistedEvents) {
    if (!isNativeMessageEvent(event) || !isRootAgentMessageEvent(event)) {
      continue;
    }
    const index = mergedEvents.length;
    mergedEvents.push(event);
    if (typeof event.id === "string" && event.id.length > 0) {
      eventIndexes.set(event.id, index);
    }
  }
  for (const event of bufferedEvents) {
    if (!isNativeMessageEvent(event) || !isRootAgentMessageEvent(event)) {
      continue;
    }
    const existingIndex = typeof event.id === "string"
      ? eventIndexes.get(event.id)
      : undefined;
    if (existingIndex !== undefined) {
      mergedEvents[existingIndex] = event;
    } else {
      const index = mergedEvents.length;
      mergedEvents.push(event);
      if (typeof event.id === "string" && event.id.length > 0) {
        eventIndexes.set(event.id, index);
      }
    }
  }

  const collection = createNativeMessageCollection();
  for (const event of mergedEvents) {
    applyNativeMessageEvent(collection, event);
  }
  const messages = collection.order
    .map((key) => collection.messages.get(key))
    .filter((message): message is NativeMessage => message !== undefined);
  const messageIndexes = new Map(
    messages.map((message, index) => [
      nativeMessageKey(message.role, message.messageId),
      index
    ])
  );
  for (const liveMessage of liveMessages) {
    const key = nativeMessageKey(liveMessage.role, liveMessage.messageId);
    const index = messageIndexes.get(key);
    if (index === undefined) {
      messageIndexes.set(key, messages.length);
      messages.push(copyNativeMessage(liveMessage));
      continue;
    }
    const persistedMessage = messages[index];
    if (!persistedMessage || !nativeMessageIsNewer(liveMessage, persistedMessage)) {
      if (persistedMessage && liveMessage.clientPromptId && !persistedMessage.clientPromptId) {
        persistedMessage.clientPromptId = liveMessage.clientPromptId;
      }
      continue;
    }
    const newerMessage = copyNativeMessage(liveMessage);
    if (
      newerMessage.reasoningText === undefined &&
      persistedMessage.reasoningText !== undefined
    ) {
      newerMessage.reasoningText = persistedMessage.reasoningText;
    }
    messages[index] = newerMessage;
  }
  return messages;
}

export function nativeMessageIsNewer(
  incoming: NativeMessage,
  current: NativeMessage
): boolean {
  if (incoming.completion !== current.completion) {
    return incoming.completion === "completed";
  }
  if (incoming.updatedAt && current.updatedAt) {
    const incomingTime = Date.parse(incoming.updatedAt);
    const currentTime = Date.parse(current.updatedAt);
    if (incomingTime !== currentTime) {
      return incomingTime > currentTime;
    }
    if (incoming.updatedAt !== current.updatedAt) {
      return incoming.updatedAt > current.updatedAt;
    }
  } else if (incoming.updatedAt || current.updatedAt) {
    return Boolean(incoming.updatedAt);
  }
  return incoming.revision > current.revision;
}
