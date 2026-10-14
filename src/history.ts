import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { isRecord, type JsonObject } from "./acp.js";

const persistedEventPageSize = 200;
const maximumPersistedHistoryPages = 10_000;
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

function attachmentMimeType(attachment: JsonObject): string | undefined {
  const mimeType = typeof attachment.mimeType === "string"
    ? attachment.mimeType.toLowerCase().split(";", 1)[0]?.trim()
    : undefined;
  if (mimeType?.startsWith("image/") || mimeType === "application/pdf") {
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
  return undefined;
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
