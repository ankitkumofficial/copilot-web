import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import {
  AcpConnectionManager,
  AcpError,
  contextTiers,
  isRecord,
  type ContextTier,
  type AgentCapabilities,
  type JsonRpcId,
  type JsonObject,
  type ManagedPermissionRequestEvent,
  type ManagedSessionReplayEvent,
  type PromptContentBlock,
  type SessionSetup,
  type SessionInfo
} from "./acp.js";
import {
  applyNativeMessageEvent,
  CopilotHistoryReader,
  createNativeMessageCollection,
  HistoryCursorExpiredError,
  HistoryPager,
  historyPageMaximumBytes,
  historyPageMaximumMessages,
  historyReplayUpdates,
  isNativeMessageEvent,
  isRootAgentMessageEvent,
  mergePagedHistoryReplayUpdates,
  mergeNativeMessages,
  nativeMessagesFromEvents,
  type HistoryPage,
  type NativeMessage,
  type NativeMessageCollection
} from "./history.js";
import { SerialTaskQueue } from "./persistence.js";

const applicationVersion = "0.1.0";
const defaultBrandName = "Copilot Web";
const defaultBrandInitial = "C";
const maximumBodyBytes = 25 * 1024 * 1024;
const maximumPromptAttachments = 10;
const maximumPromptAttachmentBytes = 8 * 1024 * 1024;
const maximumPromptAttachmentTotalBytes = 16 * 1024 * 1024;
const maximumSessionTitleLength = 120;
const nativeSessionDeleteTimeoutMs = 60_000;
const githubQuotaCommandTimeoutMs = 10_000;
const githubQuotaOutputLimitBytes = 16 * 1024;
const githubQuotaUnavailableMessage =
  "GitHub CLI (gh) not available or not authenticated; quota could not be retrieved.";
const githubQuotaJq =
  "(.quota_snapshots.premium_models // .quota_snapshots.premium_interactions) as $q | {used: ($q.entitlement - $q.remaining), total: $q.entitlement}";
const sdkSessionDeleteScript = `
import { pathToFileURL } from "node:url";

const [sdkPath, command, cwd, sessionId, allowAll] = process.argv.slice(1);
process.chdir(cwd);
const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(sdkPath).href);
const client = new CopilotClient({
  connection: RuntimeConnection.forStdio({
    path: command,
    args: allowAll === "true" ? ["--allow-all"] : []
  }),
  logLevel: "error"
});

try {
  await client.start();
  await client.deleteSession(sessionId);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.stop().catch(() => {});
}
`;
const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const contextOptions = [
  {
    value: "default",
    name: "Default",
    description: "Use Copilot's default context tier."
  },
  {
    value: "long_context",
    name: "Long context",
    description: "Use Copilot's long_context profile."
  }
] as const;

interface NewSessionDefaults {
  model?: string;
  context: ContextTier;
  reasoningEffort?: string;
}

interface SseClient {
  response: ServerResponse;
  sessionId?: string;
}

interface BusyPrompt {
  promptId: string;
  clientPromptId?: string;
  userMessageId?: string;
  nativeUserMessageId?: string;
  lastVisibleNativeMessageId?: string;
  nativeAssistantHasContent?: boolean;
  acpAssistantUpdates?: JsonObject[];
  cancelController: AbortController;
  reloadingMcp: boolean;
}

interface NativeHistoryRead {
  promise: Promise<JsonObject[]>;
  bufferedEvents: JsonObject[];
  consumers: number;
}

interface NativeHistoryReadHandle {
  promise: Promise<JsonObject[]>;
  bufferedEvents: JsonObject[];
  release(): void;
}

interface PagedHistoryReplayBuffer {
  updates: JsonObject[];
  bytes: number;
  truncated: boolean;
}

interface SessionUsage {
  aicNano: number | null;
  aicLimit: number | null;
}

interface GitHubQuota {
  used: number;
  total: number;
}

type SessionTitleOverrides = Map<string, string>;
type SessionActivityCache = Map<string, string>;

class HttpError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;

  public constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function readBranding(): { brandName: string; brandInitial: string } {
  const configured = process.env.COPILOT_WEB_USER
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!configured) {
    return {
      brandName: defaultBrandName,
      brandInitial: defaultBrandInitial
    };
  }

  const firstCharacter = Array.from(configured)[0] ?? defaultBrandInitial;
  return {
    brandName: `${configured}'s Copilot Web`,
    brandInitial: Array.from(firstCharacter.toUpperCase())[0] ?? defaultBrandInitial
  };
}

function readPort(): number {
  const value = Number.parseInt(process.env.PORT ?? "8765", 10);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return value;
}

function readBooleanEnvironment(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value || value === "0" || value === "false" || value === "no") {
    return false;
  }
  if (value === "1" || value === "true" || value === "yes") {
    return true;
  }
  throw new Error(`${name} must be true or false`);
}

async function runChildProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        PWD: cwd
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out while deleting the Copilot session"));
    }, nativeSessionDeleteTimeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = (stderr || stdout).trim();
      reject(new Error(
        detail || `Copilot session deletion exited with ${signal ?? `code ${code ?? "unknown"}`}`
      ));
    });
  });
}

async function findCopilotSdkPath(): Promise<string | undefined> {
  const configured = process.env.COPILOT_SDK_PATH;
  if (configured) {
    const candidate = path.basename(configured) === "index.js"
      ? configured
      : path.join(configured, "index.js");
    const fileStats = await stat(candidate).catch(() => undefined);
    if (fileStats?.isFile()) {
      return candidate;
    }
  }

  const roots = [
    path.join(os.homedir(), "Library", "Caches", "copilot", "pkg"),
    path.join(os.homedir(), ".cache", "copilot", "pkg")
  ];
  for (const root of roots) {
    const platforms = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const platform of platforms.filter((entry) => entry.isDirectory())) {
      const platformPath = path.join(root, platform.name);
      const versions = await readdir(platformPath, { withFileTypes: true }).catch(() => []);
      const sortedVersions = versions
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => right.name.localeCompare(left.name));
      for (const version of sortedVersions) {
        const candidate = path.join(
          platformPath,
          version.name,
          "copilot-sdk",
          "index.js"
        );
        const fileStats = await stat(candidate).catch(() => undefined);
        if (fileStats?.isFile()) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

async function resolveExecutable(command: string): Promise<string> {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return command;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH entries.
    }
  }
  return command;
}

async function readGitHubQuota(command: string, cwd: string): Promise<GitHubQuota> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [
      "api",
      "-H",
      "X-GitHub-Api-Version: 2025-04-01",
      "/copilot_internal/user",
      "--jq",
      githubQuotaJq
    ], {
      cwd,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Timed out while retrieving GitHub quota")));
    }, githubQuotaCommandTimeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > githubQuotaOutputLimitBytes) {
        child.kill("SIGTERM");
        finish(() => reject(new Error("GitHub CLI returned too much quota data")));
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("close", (code, signal) => {
      if (code !== 0) {
        const detail = stderr.trim();
        finish(() => reject(new Error(
          detail || `GitHub CLI exited with ${signal ?? `code ${code ?? "unknown"}`}`
        )));
        return;
      }
      finish(() => resolve(stdout.trim()));
    });
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("GitHub CLI returned invalid quota JSON");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.used !== "number" ||
    !Number.isFinite(parsed.used) ||
    parsed.used < 0 ||
    typeof parsed.total !== "number" ||
    !Number.isFinite(parsed.total) ||
    parsed.total < 0
  ) {
    throw new Error("GitHub CLI returned invalid quota values");
  }
  return {
    used: parsed.used,
    total: parsed.total
  };
}

async function deleteSessionWithCopilotSdk(
  sdkPath: string,
  command: string,
  cwd: string,
  sessionId: string,
  allowAll: boolean
): Promise<void> {
  await runChildProcess(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      sdkSessionDeleteScript,
      sdkPath,
      command,
      cwd,
      sessionId,
      String(allowAll)
    ],
    cwd
  );
}

async function deleteSessionWithNativeCli(
  command: string,
  cwd: string,
  sessionId: string,
  allowAll: boolean
): Promise<void> {
  await runChildProcess(
    command,
    [
      "--silent",
      "--no-color",
      ...(allowAll ? ["--allow-all"] : []),
      "-i",
      `/session delete ${sessionId} --yes --local-only`
    ],
    cwd
  );
}

async function deleteSessionWithCopilotSdkOrNativeCli(
  sdkPath: string | undefined,
  copilotCommand: string,
  copilotExecutable: string,
  cwd: string,
  sessionId: string,
  allowAll: boolean
): Promise<void> {
  if (!sdkPath) {
    await deleteSessionWithNativeCli(copilotCommand, cwd, sessionId, allowAll);
    return;
  }

  try {
    await deleteSessionWithCopilotSdk(
      sdkPath,
      copilotExecutable,
      cwd,
      sessionId,
      allowAll
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!detail.includes("ERR_MODULE_NOT_FOUND") || !detail.includes(sdkPath)) {
      throw error;
    }
    await deleteSessionWithNativeCli(copilotCommand, cwd, sessionId, allowAll);
  }
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }

  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(encoded);
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function replayUpdateSignature(params: JsonObject): string {
  const update = isRecord(params.update) ? params.update : {};
  const isChatMessage = update.sessionUpdate === "user_message_chunk" ||
    update.sessionUpdate === "agent_message_chunk";
  return JSON.stringify([
    update.sessionUpdate,
    isChatMessage ? null : update.messageId,
    update.toolCallId,
    update.status,
    update.content,
    params.nativeCommand === true
  ]);
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maximumBodyBytes) {
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return parsed;
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function sessionIdFromPath(pathname: string): string | undefined {
  const match = /^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function subrouteFromPath(pathname: string): string | undefined {
  const match = /^\/api\/sessions\/([^/]+)\/([^/]+)$/.exec(pathname);
  return match?.[2];
}

function validSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionId) && sessionId.length <= 200;
}

function normalizeSessionTitle(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSessionTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "Conversation title must be a string");
  }
  const title = normalizeSessionTitle(value);
  if (title.length === 0) {
    throw new HttpError(400, "Conversation title cannot be empty");
  }
  if (title.length > maximumSessionTitleLength) {
    throw new HttpError(
      413,
      `Conversation title must be ${maximumSessionTitleLength} characters or fewer`
    );
  }
  return title;
}

async function loadSessionTitleOverrides(filePath: string): Promise<SessionTitleOverrides> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return new Map();
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read conversation titles at ${filePath}: ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Conversation titles at ${filePath} are not a JSON object`);
  }

  const titles: SessionTitleOverrides = new Map();
  for (const [sessionId, value] of Object.entries(parsed)) {
    if (!validSessionId(sessionId) || typeof value !== "string") {
      throw new Error(`Conversation titles at ${filePath} contain an invalid entry`);
    }
    const title = normalizeSessionTitle(value);
    if (title.length === 0 || title.length > maximumSessionTitleLength) {
      throw new Error(`Conversation titles at ${filePath} contain an invalid title`);
    }
    titles.set(sessionId, title);
  }
  return titles;
}

async function saveSessionTitleOverrides(
  filePath: string,
  titles: SessionTitleOverrides
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const serialized = JSON.stringify(Object.fromEntries(titles), null, 2) + "\n";
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporaryPath, serialized, "utf8");
  await rename(temporaryPath, filePath);
}

function parsePersistedUsage(value: unknown, filePath: string, sessionId: string): SessionUsage {
  if (!isRecord(value)) {
    throw new Error(`Session usage at ${filePath} contains an invalid entry for ${sessionId}`);
  }
  const aicNano = value.aicNano;
  const aicLimit = value.aicLimit;
  if (
    (aicNano !== null && (typeof aicNano !== "number" || !Number.isFinite(aicNano))) ||
    (aicLimit !== null && (typeof aicLimit !== "number" || !Number.isFinite(aicLimit)))
  ) {
    throw new Error(`Session usage at ${filePath} contains an invalid entry for ${sessionId}`);
  }
  return {
    aicNano,
    aicLimit
  };
}

async function loadSessionUsage(filePath: string): Promise<Map<string, SessionUsage>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return new Map();
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read session usage at ${filePath}: ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Session usage at ${filePath} is not a JSON object`);
  }

  const usage = new Map<string, SessionUsage>();
  for (const [sessionId, value] of Object.entries(parsed)) {
    if (!validSessionId(sessionId)) {
      throw new Error(`Session usage at ${filePath} contains an invalid session id`);
    }
    usage.set(sessionId, parsePersistedUsage(value, filePath, sessionId));
  }
  return usage;
}

async function saveSessionUsage(
  filePath: string,
  usage: Map<string, SessionUsage>
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const serialized = JSON.stringify(Object.fromEntries(usage), null, 2) + "\n";
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporaryPath, serialized, "utf8");
  await rename(temporaryPath, filePath);
}

function timestampValue(value: string | undefined): number {
  if (typeof value !== "string") {
    return Number.NaN;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function latestTimestamp(...values: Array<string | undefined>): string | undefined {
  const validValues = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => ({ value, timestamp: timestampValue(value) }))
    .filter((entry) => Number.isFinite(entry.timestamp));
  if (validValues.length === 0) {
    return undefined;
  }
  return validValues.reduce((latest, entry) => (
    entry.timestamp > latest.timestamp ? entry : latest
  )).value;
}

function parsePersistedSessionActivity(
  value: unknown,
  filePath: string,
  sessionId: string
): string {
  if (typeof value !== "string" || !Number.isFinite(timestampValue(value))) {
    throw new Error(`Session activity at ${filePath} contains an invalid entry for ${sessionId}`);
  }
  return value;
}

async function loadSessionActivity(filePath: string): Promise<SessionActivityCache> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return new Map();
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read session activity at ${filePath}: ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Session activity at ${filePath} is not a JSON object`);
  }

  const activity = new Map<string, string>();
  for (const [sessionId, value] of Object.entries(parsed)) {
    if (!validSessionId(sessionId)) {
      throw new Error(`Session activity at ${filePath} contains an invalid session id`);
    }
    activity.set(
      sessionId,
      parsePersistedSessionActivity(value, filePath, sessionId)
    );
  }
  return activity;
}

async function saveSessionActivity(
  filePath: string,
  activity: SessionActivityCache
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const serialized = JSON.stringify(Object.fromEntries(activity), null, 2) + "\n";
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporaryPath, serialized, "utf8");
  await rename(temporaryPath, filePath);
}

function parseOptionalPromptId(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]+$/.test(value) || value.length > 200) {
    throw new HttpError(400, `${fieldName} must be a valid prompt identifier`);
  }
  return value;
}

function updateSessionUsage(usage: SessionUsage, event: JsonObject): boolean {
  if (typeof event.type !== "string" || !isRecord(event.data)) {
    return false;
  }

  if (event.type === "assistant.usage") {
    const copilotUsage = isRecord(event.data.copilotUsage)
      ? event.data.copilotUsage
      : undefined;
    const totalNanoAiu = copilotUsage?.totalNanoAiu;
    if (typeof totalNanoAiu !== "number" || !Number.isFinite(totalNanoAiu)) {
      return false;
    }
    usage.aicNano = (usage.aicNano ?? 0) + totalNanoAiu;
    return true;
  }

  if (event.type === "session.usage_checkpoint") {
    const totalNanoAiu = event.data.totalNanoAiu;
    if (typeof totalNanoAiu !== "number" || !Number.isFinite(totalNanoAiu)) {
      return false;
    }
    usage.aicNano = totalNanoAiu;
    return true;
  }

  if (event.type === "session.session_limits_changed") {
    const sessionLimits = isRecord(event.data.sessionLimits)
      ? event.data.sessionLimits
      : undefined;
    const maxAiCredits = sessionLimits?.maxAiCredits;
    usage.aicLimit = typeof maxAiCredits === "number" && Number.isFinite(maxAiCredits)
      ? maxAiCredits * 1_000_000_000
      : null;
    return true;
  }

  return false;
}

function isSessionUpdateActivity(params: JsonObject): boolean {
  const update = isRecord(params.update) ? params.update : undefined;
  const sessionUpdate = update?.sessionUpdate;
  return sessionUpdate === "user_message_chunk" ||
    sessionUpdate === "agent_message_chunk" ||
    sessionUpdate === "agent_thought_chunk" ||
    sessionUpdate === "tool_call" ||
    sessionUpdate === "tool_call_update" ||
    sessionUpdate === "plan" ||
    sessionUpdate === "usage_update";
}

function isSessionEventActivity(params: JsonObject): boolean {
  return params.type === "assistant.usage" ||
    params.type === "session.usage_checkpoint";
}

function parseContext(value: unknown): ContextTier {
  if (value === undefined || value === "default") {
    return "default";
  }
  if (value === "long_context") {
    return "long_context";
  }
  throw new HttpError(400, "Context must be default or long_context");
}

function inferredAttachmentMimeType(name: string): string {
  const extension = path.extname(name).toLowerCase();
  switch (extension) {
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function parseAttachmentMimeType(name: string, value: unknown): string {
  const declared = typeof value === "string"
    ? value.toLowerCase().split(";", 1)[0]?.trim() ?? ""
    : "";
  const mimeType = !declared || declared === "application/octet-stream"
    ? inferredAttachmentMimeType(name)
    : declared;
  if (!/^[a-z0-9!#$%&'+.^_`|~-]+\/[a-z0-9!#$%&'+.^_`|~-]+$/.test(mimeType)) {
    throw new HttpError(400, `Unsupported attachment type for ${name}`);
  }
  return mimeType;
}

function decodeAttachmentData(name: string, value: unknown): { data: string; size: number } {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `Attachment ${name} does not contain data`);
  }
  if (
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new HttpError(400, `Attachment ${name} contains invalid base64 data`);
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) {
    throw new HttpError(400, `Attachment ${name} is empty`);
  }
  if (decoded.length > maximumPromptAttachmentBytes) {
    throw new HttpError(
      413,
      `Attachment ${name} is too large; files must be 8 MB or smaller`
    );
  }
  return { data: value, size: decoded.length };
}

function attachmentName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "Every attachment must have a file name");
  }
  const name = value
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim();
  if (name.length === 0 || name.length > 255) {
    throw new HttpError(400, "Attachment file names must be between 1 and 255 characters");
  }
  return name;
}

function parsePrompt(body: JsonObject, capabilities: AgentCapabilities): PromptContentBlock[] {
  if (body.text !== undefined && typeof body.text !== "string") {
    throw new HttpError(400, "Message text must be a string");
  }
  const text = typeof body.text === "string" ? body.text : "";
  if (text.length > 50_000) {
    throw new HttpError(413, "Message text is too long");
  }

  const rawAttachments = body.attachments;
  if (rawAttachments !== undefined && !Array.isArray(rawAttachments)) {
    throw new HttpError(400, "Attachments must be an array");
  }
  const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];
  if (attachments.length > maximumPromptAttachments) {
    throw new HttpError(413, `A message can include at most ${maximumPromptAttachments} attachments`);
  }

  const prompt: PromptContentBlock[] = [];
  if (text.trim().length > 0) {
    prompt.push({ type: "text", text });
  }

  let totalAttachmentBytes = 0;
  for (const [index, rawAttachment] of attachments.entries()) {
    if (!isRecord(rawAttachment)) {
      throw new HttpError(400, `Attachment ${index + 1} must be an object`);
    }
    const name = attachmentName(rawAttachment.name);
    const mimeType = parseAttachmentMimeType(name, rawAttachment.mimeType);
    const attachment = decodeAttachmentData(name, rawAttachment.data);
    totalAttachmentBytes += attachment.size;
    if (totalAttachmentBytes > maximumPromptAttachmentTotalBytes) {
      throw new HttpError(413, "Attachments exceed the 16 MB total size limit");
    }

    if (mimeType.startsWith("image/")) {
      if (!capabilities.promptCapabilities.image) {
        throw new HttpError(409, "This Copilot agent does not support image attachments");
      }
      prompt.push({
        type: "image",
        data: attachment.data,
        mimeType
      });
      continue;
    }

    if (!capabilities.promptCapabilities.embeddedContext) {
      throw new HttpError(409, "This Copilot agent does not support file attachments");
    }
    prompt.push({
      type: "resource",
      resource: {
        uri: `urn:copilot-web:attachment:${index}:${encodeURIComponent(name)}`,
        blob: attachment.data,
        mimeType
      }
    });
  }

  if (prompt.length === 0) {
    throw new HttpError(400, "Message text or at least one attachment is required");
  }
  return prompt;
}

function isModelConfigOption(option: JsonObject): boolean {
  return option.id === "model" ||
    option.id === "reasoning_effort" ||
    option.category === "model" ||
    option.category === "model_config" ||
    option.category === "thought_level";
}

async function readCopilotDefaults(): Promise<NewSessionDefaults> {
  const copilotHome = process.env.COPILOT_HOME
    ? expandHome(process.env.COPILOT_HOME)
    : path.join(os.homedir(), ".copilot");
  const settingsPath = path.join(path.resolve(copilotHome), "settings.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { context: "default" };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read Copilot settings at ${settingsPath}: ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Copilot settings at ${settingsPath} are not a JSON object`);
  }

  const defaults: NewSessionDefaults = {
    context: parsed.contextTier === "long_context" ? "long_context" : "default"
  };
  if (typeof parsed.model === "string" && parsed.model.trim().length > 0) {
    defaults.model = parsed.model.trim();
  }
  if (typeof parsed.effortLevel === "string" && parsed.effortLevel.trim().length > 0) {
    defaults.reasoningEffort = parsed.effortLevel.trim();
  }
  return defaults;
}

async function main(): Promise<void> {
  const port = readPort();
  const branding = readBranding();
  const projectsDirectory = path.resolve(
    expandHome(process.env.COPILOT_PROJECTS_DIR ?? path.join(os.homedir(), "projects"))
  );
  const copilotCommand = process.env.COPILOT_BIN ?? "copilot";
  const githubCommand = process.env.GH_BIN?.trim() || "gh";
  const copilotExecutable = await resolveExecutable(copilotCommand);
  const allowAll = readBooleanEnvironment("COPILOT_ALLOW_ALL");
  const nativeSessionDelete = process.env.COPILOT_NATIVE_SESSION_DELETE === undefined
    ? true
    : readBooleanEnvironment("COPILOT_NATIVE_SESSION_DELETE");
  const copilotSdkPath = await findCopilotSdkPath();
  await readCopilotDefaults();

  const projectsStats = await stat(projectsDirectory).catch(() => undefined);
  if (!projectsStats?.isDirectory()) {
    throw new Error(`COPILOT_PROJECTS_DIR is not a directory: ${projectsDirectory}`);
  }
  const sessionTitlesPath = path.join(
    os.homedir(),
    ".copilot-web",
    "session-titles.json"
  );
  const sessionUsagePath = path.join(
    os.homedir(),
    ".copilot-web",
    "session-usage.json"
  );
  const sessionActivityPath = path.join(
    os.homedir(),
    ".copilot-web",
    "session-activity.json"
  );
  const sessionPreferencesPath = path.join(
    os.homedir(),
    ".copilot-web",
    "session-preferences.json"
  );
  const sessionTitleOverrides = await loadSessionTitleOverrides(sessionTitlesPath);
  const sessionUsageCache = await loadSessionUsage(sessionUsagePath);
  const sessionActivityCache = await loadSessionActivity(sessionActivityPath);

  const acp = new AcpConnectionManager({
    command: copilotCommand,
    cwd: projectsDirectory,
    clientVersion: applicationVersion,
    clientTitle: branding.brandName,
    allowAll,
    preferencesPath: sessionPreferencesPath
  });
  await acp.start();
  const copilotHistory = new CopilotHistoryReader({
    ...(copilotSdkPath === undefined ? {} : { sdkPath: copilotSdkPath }),
    command: copilotExecutable,
    cwd: projectsDirectory,
    allowAll
  });
  await copilotHistory.initialize();
  const historyPager = new HistoryPager((request) => copilotHistory.readPage(request));

  const browserCapabilities = () => {
    const capabilities = acp.getCapabilities();
    return {
      ...capabilities,
      sessionCapabilities: {
        ...capabilities.sessionCapabilities,
        delete: capabilities.sessionCapabilities.delete || nativeSessionDelete
      }
    };
  };

  const sessionCache = new Map<string, SessionInfo>();
  const sessionReplayCache = new Map<string, JsonObject[]>();
  const sessionTitleWrites = new SerialTaskQueue();
  const sessionUsageWrites = new SerialTaskQueue();
  const sessionActivityWrites = new SerialTaskQueue();
  const replayingSessions = new Map<string, JsonObject[]>();
  const fallbackReplayTails = new Map<string, JsonObject[]>();
  const busySessions = new Map<string, BusyPrompt>();
  const nativeMessageStates = new Map<string, NativeMessageCollection>();
  const nativePipelineModes = new Map<string, boolean>();
  const nativeHistoryReads = new Map<string, NativeHistoryRead>();
  const pagedHistoryBuffers = new Map<string, Set<Map<string, NativeMessage>>>();
  const pagedHistoryReplayBuffers = new Map<string, Set<PagedHistoryReplayBuffer>>();
  const deletingSessions = new Set<string>();
  const deletedSessions = new Set<string>();
  const activeSessionOperations = new Map<string, number>();
  const configuringSessions = new Map<string, number>();
  const sessionOperationWaiters = new Map<string, Set<() => void>>();
  const sseClients = new Set<SseClient>();
  const browserToken = randomBytes(32).toString("hex");
  const requestScope = randomBytes(12).toString("hex");
  let updateSequence = 0;
  // Settled results stay long enough for refresh retries without growing for the server's lifetime.
  const maximumSettledSubmissions = 256;
  const submittedRequests = new Map<string, {
    fingerprint: string;
    result: Promise<JsonObject>;
  }>();
  const settledSubmissions = new Set<string>();
  const runRequestOnce = (
    request: IncomingMessage,
    body: JsonObject,
    operation: () => Promise<JsonObject>
  ): Promise<JsonObject> => {
    const requestId = request.headers["x-copilot-request-id"];
    if (requestId === undefined) {
      return operation();
    }
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(requestId)) {
      throw new HttpError(400, "Invalid submission identifier");
    }
    if (request.headers["x-copilot-request-scope"] !== requestScope) {
      throw new HttpError(
        409,
        "The server restarted; the pending message was not resent automatically",
        "server-restarted"
      );
    }
    const key = `${request.url}:${requestId}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const previous = submittedRequests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new HttpError(409, "Submission identifier was already used for a different request");
      }
      return previous.result;
    }
    const result = Promise.resolve().then(operation);
    submittedRequests.set(key, { fingerprint, result });
    const settle = (): void => {
      settledSubmissions.add(key);
      for (const oldest of settledSubmissions) {
        if (settledSubmissions.size <= maximumSettledSubmissions) {
          break;
        }
        settledSubmissions.delete(oldest);
        submittedRequests.delete(oldest);
      }
    };
    void result.then(settle, settle);
    return result;
  };
  const truncatedReplays = new Set<string>();
  const completeLiveHistories = new Set<string>();
  const legacyReplaySessions = new Set<string>();
  const maximumReplayBytes = 512 * 1024;
  const maximumReplaySessions = 8;
  const replaySizes = new WeakMap<JsonObject[], { sizes: number[]; bytes: number }>();

  const retainReplay = (sessionId: string, replay: JsonObject[], cache = true): void => {
    // Legacy ACP-only history cannot be read back independently, so retain its compatibility path.
    if (copilotHistory.available && !legacyReplaySessions.has(sessionId)) {
      let measured = replaySizes.get(replay);
      if (!measured) {
        measured = { sizes: [], bytes: 0 };
        replaySizes.set(replay, measured);
      }
      for (let index = measured.sizes.length; index < replay.length; index += 1) {
        const entry = replay[index];
        if (!entry) {
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(entry));
        measured.sizes.push(size);
        measured.bytes += size;
      }
      let start = 0;
      while (start < measured.sizes.length && (
        measured.bytes > maximumReplayBytes || measured.sizes.length - start > 1000
      )) {
        measured.bytes -= measured.sizes[start] ?? 0;
        start += 1;
      }
      if (start > 0) {
        replay.splice(0, start);
        measured.sizes.splice(0, start);
        truncatedReplays.add(sessionId);
        completeLiveHistories.delete(sessionId);
      }
      if (!cache) {
        return;
      }
      sessionReplayCache.delete(sessionId);
      while (sessionReplayCache.size >= maximumReplaySessions) {
        const oldest = [...sessionReplayCache.keys()].find((id) => (
          !busySessions.has(id) && !legacyReplaySessions.has(id)
        ));
        if (oldest === undefined) {
          break;
        }
        sessionReplayCache.delete(oldest);
        truncatedReplays.add(oldest);
        completeLiveHistories.delete(oldest);
      }
    }
    if (cache) {
      sessionReplayCache.set(sessionId, replay);
    }
  };

  const trimNativeState = (sessionId: string): void => {
    const state = nativeMessageStates.get(sessionId);
    if (!state) {
      return;
    }
    let bytes = 0;
    for (let index = state.order.length - 1; index >= 0; index -= 1) {
      const key = state.order[index];
      const message = key ? state.messages.get(key) : undefined;
      if (!message) {
        continue;
      }
      bytes += Buffer.byteLength(JSON.stringify(message));
      if (index < state.order.length - 1 && (
        bytes > maximumReplayBytes || state.order.length - index > 64
      )) {
        for (const oldKey of state.order.splice(0, index + 1)) {
          state.messages.delete(oldKey);
        }
        completeLiveHistories.delete(sessionId);
        break;
      }
    }
    while (state.eventIds.size > 1000) {
      const first = state.eventIds.values().next().value;
      if (first === undefined) {
        break;
      }
      state.eventIds.delete(first);
    }
    nativeMessageStates.delete(sessionId);
    nativeMessageStates.set(sessionId, state);
    for (const id of nativeMessageStates.keys()) {
      if (nativeMessageStates.size <= maximumReplaySessions) {
        break;
      }
      if (id !== sessionId && !busySessions.has(id)) {
        nativeMessageStates.delete(id);
        completeLiveHistories.delete(id);
      }
    }
  };

  const displayHistory = (
    sessionId: string,
    page: HistoryPage,
    includeReplay = false,
    liveReplay: readonly JsonObject[] = [],
    liveNativeMessages?: NativeMessage[],
    activityNativeMessages: NativeMessage[] = []
  ) => {
    const nativeMessages = liveNativeMessages ?? nativeMessagesFromEvents(page.events);
    const replayMessages = activityNativeMessages.length > 0
      ? mergeNativeMessages([], [], [...nativeMessages, ...activityNativeMessages])
      : nativeMessages;
    const cachedReplay = sessionReplayCache.get(sessionId) ?? [];
    const useCompleteReplay = includeReplay && cachedReplay.length > 0 &&
      !page.hasMore && !truncatedReplays.has(sessionId) &&
      Buffer.byteLength(JSON.stringify({ cachedReplay, nativeMessages: replayMessages })) <= historyPageMaximumBytes;
    let activityTruncated = false;
    const replayUpdates = useCompleteReplay
      ? [...cachedReplay]
      : mergePagedHistoryReplayUpdates(
        sessionId,
        page.events,
        replayMessages,
        cachedReplay,
        [],
        () => { activityTruncated = true; }
      );
    const included = new Set(replayUpdates);
    const includedTools = new Set(replayUpdates.flatMap((params) => (
      typeof params.afterMessageId === "string" && isRecord(params.update) &&
      typeof params.update.toolCallId === "string"
        ? [params.update.toolCallId] : []
    )));
    const liveReplayUpdates = liveReplay.filter((params) => !included.has(params) && !(
      typeof params.afterMessageId === "string" && isRecord(params.update) &&
      includedTools.has(String(params.update.toolCallId))
    ));
    return {
      nativeMessages,
      replayUpdates,
      ...(liveReplayUpdates.length > 0 ? { liveReplayUpdates } : {}),
      ...(activityTruncated ? {
        historyWarning: "Some cached reasoning or tool output exceeded the activity display budget and could not be restored."
      } : {}),
      history: {
        hasMore: page.hasMore,
        cursor: page.cursor ?? null,
        oversized: page.oversized,
        maxMessages: historyPageMaximumMessages,
        maxBytes: historyPageMaximumBytes,
        replayMode: useCompleteReplay ? "acp" : "native"
      }
    };
  };

  const nativeMessageState = (sessionId: string): NativeMessageCollection => {
    let state = nativeMessageStates.get(sessionId);
    if (!state) {
      state = createNativeMessageCollection();
      nativeMessageStates.set(sessionId, state);
    }
    return state;
  };

  const startNativeHistoryRead = (sessionId: string): NativeHistoryReadHandle | undefined => {
    if (!copilotHistory.available || acp.isSessionUnprompted(sessionId)) {
      return undefined;
    }
    let read = nativeHistoryReads.get(sessionId);
    if (!read) {
      read = {
        promise: copilotHistory.read(sessionId),
        bufferedEvents: [],
        consumers: 0
      };
      nativeHistoryReads.set(sessionId, read);
    }
    read.consumers += 1;
    let released = false;
    return {
      promise: read.promise,
      bufferedEvents: read.bufferedEvents,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        read.consumers -= 1;
        if (read.consumers === 0 && nativeHistoryReads.get(sessionId) === read) {
          nativeHistoryReads.delete(sessionId);
        }
      }
    };
  };

  const nativeMessagesForState = (state: NativeMessageCollection): NativeMessage[] => (
    state.order.flatMap((key) => {
      const message = state.messages.get(key);
      return message
        ? [{ ...message, attachments: message.attachments.map((attachment) => ({ ...attachment })) }]
        : [];
    })
  );

  const ensureSessionAvailable = (sessionId: string): void => {
    if (deletedSessions.has(sessionId)) {
      throw new HttpError(404, "Conversation not found");
    }
    if (deletingSessions.has(sessionId)) {
      throw new HttpError(409, "Conversation is being deleted");
    }
  };

  const withSessionOperation = async <T>(
    sessionId: string,
    operation: () => Promise<T>,
    configuring = false
  ): Promise<T> => {
    ensureSessionAvailable(sessionId);
    activeSessionOperations.set(
      sessionId,
      (activeSessionOperations.get(sessionId) ?? 0) + 1
    );
    if (configuring) {
      configuringSessions.set(sessionId, (configuringSessions.get(sessionId) ?? 0) + 1);
    }
    try {
      return await operation();
    } finally {
      if (configuring) {
        const configuringCount = (configuringSessions.get(sessionId) ?? 1) - 1;
        if (configuringCount === 0) {
          configuringSessions.delete(sessionId);
        } else {
          configuringSessions.set(sessionId, configuringCount);
        }
      }
      const activeCount = (activeSessionOperations.get(sessionId) ?? 1) - 1;
      if (activeCount > 0) {
        activeSessionOperations.set(sessionId, activeCount);
      } else {
        activeSessionOperations.delete(sessionId);
        const waiters = sessionOperationWaiters.get(sessionId);
        if (waiters) {
          sessionOperationWaiters.delete(sessionId);
          for (const resolve of waiters) {
            resolve();
          }
        }
      }
    }
  };

  const waitForSessionOperations = (sessionId: string): Promise<void> => {
    if (!activeSessionOperations.has(sessionId)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters = sessionOperationWaiters.get(sessionId) ?? new Set();
      waiters.add(resolve);
      sessionOperationWaiters.set(sessionId, waiters);
    });
  };

  const queueSessionUsageSave = (): Promise<void> => {
    const snapshot = new Map(
      [...sessionUsageCache].map(([sessionId, usage]) => [
        sessionId,
        { ...usage }
      ])
    );
    return sessionUsageWrites.enqueue(() => saveSessionUsage(sessionUsagePath, snapshot))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[server] Unable to persist session usage: ${message}`);
        throw error;
      });
  };

  const queueSessionActivitySave = (): Promise<void> => {
    const snapshot = new Map(sessionActivityCache);
    return sessionActivityWrites.enqueue(() => (
      saveSessionActivity(sessionActivityPath, snapshot)
    )).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[server] Unable to persist session activity: ${message}`);
      throw error;
    });
  };

  const persistSessionTitleOverride = (
    sessionId: string,
    title: string | undefined,
    rollbackOnFailure = true,
    forceSave = false
  ): Promise<void> => sessionTitleWrites.enqueue(async () => {
    const snapshot = new Map(sessionTitleOverrides);
    const previousTitle = snapshot.get(sessionId);
    const hadPreviousTitle = snapshot.has(sessionId);
    if (title === undefined) {
      snapshot.delete(sessionId);
    } else {
      snapshot.set(sessionId, title);
    }
    if (!forceSave && hadPreviousTitle === (title !== undefined) && previousTitle === title) {
      return;
    }

    try {
      await saveSessionTitleOverrides(sessionTitlesPath, snapshot);
    } catch (error) {
      if (!rollbackOnFailure) {
        sessionTitleOverrides.delete(sessionId);
      }
      throw error;
    }
    sessionTitleOverrides.clear();
    for (const [id, value] of snapshot) {
      sessionTitleOverrides.set(id, value);
    }
  });

  const publish = (event: string, data: unknown, sessionId?: string): void => {
    const encoded = sseEvent(event, data);
    for (const client of sseClients) {
      if (client.sessionId && client.sessionId !== sessionId) {
        continue;
      }
      client.response.write(encoded);
    }
  };

  const touchSessionActivity = (
    sessionId: string,
    activityAt = new Date().toISOString()
  ): void => {
    if (deletedSessions.has(sessionId)) {
      return;
    }
    const latest = latestTimestamp(sessionActivityCache.get(sessionId), activityAt);
    if (!latest || latest === sessionActivityCache.get(sessionId)) {
      return;
    }
    sessionActivityCache.set(sessionId, latest);
    void queueSessionActivitySave().catch(() => {});
    publish("session-activity", {
      sessionId,
      lastActivityAt: latest
    }, sessionId);
  };

  const cacheSessions = (sessions: SessionInfo[]): void => {
    let activityChanged = false;
    for (const session of sessions) {
      if (deletedSessions.has(session.sessionId)) {
        continue;
      }
      if (!sessionActivityCache.has(session.sessionId) && session.updatedAt) {
        sessionActivityCache.set(session.sessionId, session.updatedAt);
        activityChanged = true;
      }
      const customTitle = sessionTitleOverrides.get(session.sessionId);
      sessionCache.set(
        session.sessionId,
        customTitle === undefined
          ? session
          : { ...session, title: customTitle, customTitle }
      );
    }
    if (activityChanged) {
      void queueSessionActivitySave().catch(() => {});
    }
  };

  const findSession = async (
    sessionId: string,
    allowKnownContextFallback = false
  ): Promise<SessionInfo> => {
    const cached = sessionCache.get(sessionId);
    if (cached) {
      return cached;
    }

    if (allowKnownContextFallback && acp.getSessionContext(sessionId)) {
      const customTitle = sessionTitleOverrides.get(sessionId);
      const knownSession: SessionInfo = {
        sessionId,
        cwd: projectsDirectory,
        title: customTitle ?? "New conversation",
        ...(customTitle ? { customTitle } : {})
      };
      sessionCache.set(sessionId, knownSession);
      return knownSession;
    }

    const sessions = await acp.listSessions();
    cacheSessions(sessions);
    const session = sessionCache.get(sessionId);
    if (!session) {
      throw new HttpError(404, "Conversation not found");
    }
    return session;
  };

  const replaceEmptySession = async (
    session: SessionInfo,
    setup: SessionSetup
  ): Promise<{ session: SessionInfo; persistenceWarnings: string[] }> => {
    if (session.sessionId === setup.sessionId) {
      return { session, persistenceWarnings: [] };
    }
    const previousSessionId = session.sessionId;
    const replacement = { ...session, sessionId: setup.sessionId };
    sessionCache.set(setup.sessionId, replacement);
    sessionCache.delete(previousSessionId);
    sessionReplayCache.delete(previousSessionId);
    fallbackReplayTails.delete(previousSessionId);
    historyPager.forget(previousSessionId);
    truncatedReplays.delete(previousSessionId);
    legacyReplaySessions.delete(previousSessionId);
    nativeMessageStates.delete(previousSessionId);
    nativePipelineModes.delete(previousSessionId);
    nativePipelineModes.set(setup.sessionId, copilotHistory.available);
    completeLiveHistories.delete(previousSessionId);
    completeLiveHistories.add(setup.sessionId);
    sessionUsageCache.delete(previousSessionId);
    const activity = sessionActivityCache.get(previousSessionId) ?? session.updatedAt;
    sessionActivityCache.delete(previousSessionId);
    if (activity) {
      sessionActivityCache.set(setup.sessionId, activity);
    }
    deletedSessions.add(previousSessionId);

    const titleSave = sessionTitleWrites.enqueue(async () => {
      const snapshot = new Map(sessionTitleOverrides);
      const title = snapshot.get(previousSessionId);
      snapshot.delete(previousSessionId);
      if (title !== undefined) {
        snapshot.set(setup.sessionId, title);
        replacement.title = title;
        replacement.customTitle = title;
      }
      await saveSessionTitleOverrides(sessionTitlesPath, snapshot);
      sessionTitleOverrides.delete(previousSessionId);
      if (title !== undefined) {
        sessionTitleOverrides.set(setup.sessionId, title);
      }
    });
    const labels = ["session titles", "session usage", "session activity"];
    const saved = await Promise.allSettled([
      titleSave, queueSessionUsageSave(), queueSessionActivitySave()
    ]);
    const persistenceWarnings: string[] = [];
    saved.forEach((result, index) => {
      if (result.status === "rejected") {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        persistenceWarnings.push(`${labels[index]}: ${message}`);
        console.error(`[server] Unable to persist replaced conversation metadata: ${message}`);
      }
    });
    publish("session-replaced", {
      previousSessionId,
      session: replacement,
      context: acp.getSessionContext(setup.sessionId),
      configOptions: setup.configOptions,
      nativeMessageHistoryAvailable: copilotHistory.available,
      ...(persistenceWarnings.length > 0 ? { persistenceWarnings } : {})
    }, previousSessionId);
    for (const client of sseClients) {
      if (client.sessionId === previousSessionId) {
        client.sessionId = setup.sessionId;
      }
    }
    return { session: replacement, persistenceWarnings };
  };

  acp.events.on("sessionReplay", (event: ManagedSessionReplayEvent) => {
    const { sessionId } = event;
    if (deletedSessions.has(sessionId)) {
      return;
    }
    if (event.phase === "start") {
      replayingSessions.set(sessionId, []);
      return;
    }
    const replay = replayingSessions.get(sessionId);
    replayingSessions.delete(sessionId);
    if (event.succeeded && replay) {
      const pendingMessageId = busySessions.get(sessionId)?.userMessageId;
      const pendingUpdates = pendingMessageId
        ? (sessionReplayCache.get(sessionId) ?? []).filter((params) => (
          isRecord(params.update) && params.update.messageId === pendingMessageId
        ))
        : [];
      const completeReplay = [...replay, ...pendingUpdates];
      const fallbackTail = fallbackReplayTails.get(sessionId);
      if (fallbackTail) {
        const signatures = new Map<string, number>();
        for (const update of completeReplay) {
          const signature = replayUpdateSignature(update);
          signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
        }
        for (const update of fallbackTail) {
          const signature = replayUpdateSignature(update);
          const count = signatures.get(signature) ?? 0;
          if (count > 0) {
            signatures.set(signature, count - 1);
          } else {
            completeReplay.push(update);
            signatures.set(signature, 1);
          }
        }
        fallbackReplayTails.delete(sessionId);
      }
      if (legacyReplaySessions.has(sessionId)) {
        truncatedReplays.delete(sessionId);
      }
      retainReplay(sessionId, completeReplay);
    }
  });
  acp.events.on("sessionUpdate", (event: { context: ContextTier; params: JsonObject }) => {
    if (!isRecord(event.params)) {
      return;
    }
    const sessionId = typeof event.params.sessionId === "string" ? event.params.sessionId : undefined;
    if (sessionId && deletedSessions.has(sessionId)) {
      return;
    }
    const replaying = replayingSessions.has(sessionId ?? "");
    const activePrompt = !replaying && sessionId
      ? busySessions.get(sessionId)
      : undefined;
    const updateParams = replaying ? event.params : {
      ...event.params,
      updateScope: requestScope,
      updateSequence: ++updateSequence,
      ...(activePrompt?.clientPromptId ? { clientPromptId: activePrompt.clientPromptId } : {}),
      ...(activePrompt?.lastVisibleNativeMessageId
        ? { afterMessageId: activePrompt.lastVisibleNativeMessageId }
        : {})
    };
    if (sessionId) {
      const replay = replayingSessions.get(sessionId) ?? sessionReplayCache.get(sessionId) ?? [];
      replay.push(updateParams);
      retainReplay(sessionId, replay, !replaying);
    }
    if (
      sessionId &&
      !replayingSessions.has(sessionId) &&
      !busySessions.has(sessionId) &&
      isSessionUpdateActivity(event.params)
    ) {
      touchSessionActivity(sessionId);
    }
    if (replaying) {
      return;
    }
    const update = isRecord(event.params.update) ? event.params.update : undefined;
    if (
      sessionId &&
      activePrompt &&
      !activePrompt.nativeAssistantHasContent &&
      nativePipelineModes.get(sessionId) === true &&
      update?.sessionUpdate === "agent_message_chunk"
    ) {
      activePrompt.acpAssistantUpdates ??= [];
      activePrompt.acpAssistantUpdates.push(updateParams);
    }
    const updateBytes = Buffer.byteLength(JSON.stringify(updateParams));
    for (const buffer of pagedHistoryReplayBuffers.get(sessionId ?? "") ?? []) {
      if (buffer.bytes + updateBytes <= Math.floor(historyPageMaximumBytes / 2) &&
          buffer.updates.length < 1000) {
        buffer.updates.push(updateParams);
        buffer.bytes += updateBytes;
      } else {
        buffer.truncated = true;
      }
    }
    publish(
      "session-update",
      updateParams,
      sessionId
    );
  });
  acp.events.on("sessionEvent", (event: { context: ContextTier; params: JsonObject }) => {
    if (!isRecord(event.params)) {
      return;
    }
    const sessionId = typeof event.params.sessionId === "string" ? event.params.sessionId : undefined;
    if (sessionId && deletedSessions.has(sessionId)) {
      return;
    }
    if (sessionId && replayingSessions.has(sessionId)) {
      return;
    }
    if (sessionId) {
      const usage = sessionUsageCache.get(sessionId) ?? {
        aicNano: null,
        aicLimit: null
      };
      if (updateSessionUsage(usage, event.params)) {
        sessionUsageCache.set(sessionId, usage);
        void queueSessionUsageSave().catch(() => {});
      }
      if (
        !busySessions.has(sessionId) &&
        isSessionEventActivity(event.params)
      ) {
        touchSessionActivity(sessionId);
      }
    }
    if (isNativeMessageEvent(event.params)) {
      if (
        !sessionId ||
        !copilotHistory.available ||
        nativePipelineModes.get(sessionId) === false ||
        !isRootAgentMessageEvent(event.params)
      ) {
        return;
      }
      const busyPrompt = busySessions.get(sessionId);
      const eventData = isRecord(event.params.data) ? event.params.data : undefined;
      if (typeof eventData?.messageId !== "string" || !eventData.messageId) {
        console.warn(
          `[history] Ignoring ${String(event.params.type)} event for ${sessionId}: native message id is missing`
        );
        return;
      }
      // Live ACP session events omit the event id; persisted history keeps it.
      const liveEventId = typeof event.params.id === "string" && event.params.id
        ? undefined
        : `live:${randomBytes(12).toString("hex")}`;
      const nativeMessage = applyNativeMessageEvent(
        nativeMessageState(sessionId),
        event.params,
        {
          ...(busyPrompt?.clientPromptId ? { clientPromptId: busyPrompt.clientPromptId } : {}),
          ...(liveEventId ? { liveEventId } : {})
        }
      );
      if (!nativeMessage) {
        return;
      }
      trimNativeState(sessionId);
      for (const buffer of pagedHistoryBuffers.get(sessionId) ?? []) {
        buffer.set(`${nativeMessage.role}:${nativeMessage.messageId}`, nativeMessage);
      }
      if (nativeMessage.role === "user" && busyPrompt) {
        busyPrompt.nativeUserMessageId = nativeMessage.messageId;
        busyPrompt.lastVisibleNativeMessageId = nativeMessage.messageId;
      }
      if (
        nativeMessage.role === "assistant" &&
        nativeMessage.content.trim().length > 0 &&
        busyPrompt
      ) {
        busyPrompt.nativeAssistantHasContent = true;
        busyPrompt.lastVisibleNativeMessageId = nativeMessage.messageId;
        busyPrompt.acpAssistantUpdates = [];
      }
      // Loads merge buffered events with their snapshot; other clients still need the live update.
      nativeHistoryReads.get(sessionId)?.bufferedEvents.push(
        liveEventId ? { ...event.params, id: liveEventId } : event.params
      );
      nativePipelineModes.set(sessionId, true);
      publish("native-message", { ...nativeMessage, sessionId, updateSequence: ++updateSequence }, sessionId);
      if (!busyPrompt) {
        touchSessionActivity(sessionId);
      }
      return;
    }
    // ACP thought chunks drive the Reasoning panel; the raw native reasoning events are redundant.
    if (event.params.type === "assistant.reasoning_delta" || event.params.type === "assistant.reasoning") {
      return;
    }
    publish("session-event", event.params, sessionId);
  });
  acp.events.on("permissionRequest", (event: ManagedPermissionRequestEvent) => {
    const sessionId = typeof event.params.sessionId === "string"
      ? event.params.sessionId
      : undefined;
    if (sessionId && deletedSessions.has(sessionId)) {
      return;
    }
    if (sessionId && !busySessions.has(sessionId)) {
      touchSessionActivity(sessionId);
    }
    publish("permission-request", {
      requestId: event.requestId,
      context: event.context,
      params: event.params
    }, sessionId);
  });
  acp.events.on("processError", (error: Error) => {
    console.error(`[copilot] ${error.message}`);
    publish("server-error", { message: error.message });
  });
  acp.events.on("protocolError", (error: Error) => {
    console.error(`[acp] ${error.message}`);
    publish("server-error", { message: error.message });
  });
  acp.events.on("stderr", (chunk: string) => {
    const text = chunk.trim();
    if (text) {
      console.error(`[copilot] ${text}`);
    }
  });

  const authorized = (request: IncomingMessage): boolean => {
    const origin = request.headers.origin;
    const allowedOrigins = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`
    ]);
    if (origin && !allowedOrigins.has(origin)) {
      return false;
    }

    const authorization = request.headers.authorization;
    if (authorization === `Bearer ${browserToken}`) {
      return true;
    }
    return parseCookies(request.headers.cookie).get("copilot_web_token") === browserToken;
  };

  const requireAuthorization = (request: IncomingMessage): void => {
    if (!authorized(request)) {
      throw new HttpError(401, "This local API requires the browser session cookie");
    }
  };

  const serveStatic = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const requestedPath = decodeURIComponent(requestUrl.pathname);
    const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
    const filePath = path.resolve(publicDirectory, relativePath);
    if (filePath !== publicDirectory && !filePath.startsWith(`${publicDirectory}${path.sep}`)) {
      throw new HttpError(403, "Invalid static file path");
    }

    try {
      const content = await readFile(filePath);
      response.statusCode = 200;
      response.setHeader("Content-Type", contentType(filePath));
      response.setHeader("Cache-Control", "no-store");
      if (requestedPath === "/") {
        response.setHeader(
          "Set-Cookie",
          `copilot_web_token=${browserToken}; Path=/; HttpOnly; SameSite=Strict`
        );
      }
      response.end(content);
    } catch (error) {
      const code = isRecord(error) && error.code === "ENOENT" ? 404 : 500;
      throw new HttpError(code, code === 404 ? "Static file not found" : "Unable to read static file");
    }
  };

  const handleApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<boolean> => {
    if (!requestUrl.pathname.startsWith("/api/")) {
      return false;
    }
    requireAuthorization(request);

    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      await acp.start();
      const newSessionDefaults = await readCopilotDefaults();
      jsonResponse(response, 200, {
        ok: true,
        brandName: branding.brandName,
        brandInitial: branding.brandInitial,
        projectsDirectory,
        capabilities: browserCapabilities(),
        contexts: contextOptions,
        nativeMessageHistoryAvailable: copilotHistory.available,
        newSessionDefaults
      });
      return true;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/quota") {
      let quota: GitHubQuota;
      try {
        quota = await readGitHubQuota(githubCommand, projectsDirectory);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[quota] Unable to retrieve quota with gh: ${detail}`);
        throw new HttpError(503, githubQuotaUnavailableMessage);
      }
      jsonResponse(response, 200, quota);
      return true;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/config") {
      const newSessionDefaults = await readCopilotDefaults();
      const context = parseContext(
        requestUrl.searchParams.get("context") ?? newSessionDefaults.context
      );
      const requestedModel = requestUrl.searchParams.get("model");
      if (requestedModel !== null && requestedModel.trim().length === 0) {
        throw new HttpError(400, "Model must be a non-empty string");
      }
      const model = requestedModel?.trim() ?? newSessionDefaults.model;
      const setup = await acp.discoverConfig(context, model);
      jsonResponse(response, 200, {
        brandName: branding.brandName,
        brandInitial: branding.brandInitial,
        context,
        configOptions: setup.configOptions,
        models: setup.models,
        modes: setup.modes,
        newSessionDefaults
      });
      return true;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/events") {
      await acp.start();
      const requestedSessionId = requestUrl.searchParams.get("sessionId") ?? undefined;
      const client: SseClient = requestedSessionId
        ? { response, sessionId: requestedSessionId }
        : { response };
      const newSessionDefaults = await readCopilotDefaults();
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-store");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders();
      response.write(sseEvent("ready", {
        requestScope,
        capabilities: browserCapabilities(),
        brandName: branding.brandName,
        brandInitial: branding.brandInitial,
        projectsDirectory,
        contexts: contextOptions,
        nativeMessageHistoryAvailable: copilotHistory.available,
        newSessionDefaults
      }));
      sseClients.add(client);
      request.on("close", () => {
        sseClients.delete(client);
      });
      return true;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/sessions") {
      const sessions = await acp.listSessions();
      const listed = new Set(sessions.map((session) => session.sessionId));
      for (const session of sessionCache.values()) {
        // The listing connection may not see a new session's persisted index yet.
        if (acp.getSessionContext(session.sessionId) && !listed.has(session.sessionId)) {
          sessions.push(session);
        }
      }
      const newSessionDefaults = await readCopilotDefaults();
      cacheSessions(sessions);
      jsonResponse(response, 200, {
        sessions: sessions
          .filter((session) => (
            !deletingSessions.has(session.sessionId) &&
            !deletedSessions.has(session.sessionId)
          ))
          .map((session) => {
            const cachedSession = sessionCache.get(session.sessionId) ?? session;
            const context = acp.getSessionContext(session.sessionId);
            const busyPrompt = busySessions.get(session.sessionId);
            const lastActivityAt = sessionActivityCache.get(session.sessionId) ??
              cachedSession.updatedAt;
            return {
              ...cachedSession,
              ...(lastActivityAt ? { lastActivityAt } : {}),
              ...(context ? { context } : {}),
              busy: busyPrompt !== undefined,
              ...(busyPrompt ? { promptId: busyPrompt.promptId } : {})
            };
          }),
        capabilities: browserCapabilities(),
        contexts: contextOptions,
        nativeMessageHistoryAvailable: copilotHistory.available,
        newSessionDefaults
      });
      return true;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/sessions") {
      const body = await readJsonBody(request);
      const result = await runRequestOnce(request, body, async () => {
        const newSessionDefaults = await readCopilotDefaults();
        const context = parseContext(body.context ?? newSessionDefaults.context);
        const configOverrides: Record<string, string | boolean> = {};
        const fallbackConfigIds = new Set<string>();
        if (newSessionDefaults.model) {
          configOverrides.model = newSessionDefaults.model;
        }
        if (newSessionDefaults.reasoningEffort) {
          configOverrides.reasoning_effort = newSessionDefaults.reasoningEffort;
          fallbackConfigIds.add("reasoning_effort");
        }
        if (body.configOverrides !== undefined) {
          if (!isRecord(body.configOverrides)) {
            throw new HttpError(400, "Configuration overrides must be an object");
          }
          for (const [configId, value] of Object.entries(body.configOverrides)) {
            if (configId !== "model" && configId !== "reasoning_effort") {
              throw new HttpError(400, `Unsupported new conversation setting: ${configId}`);
            }
            if (typeof value !== "string" && typeof value !== "boolean") {
              throw new HttpError(400, `Invalid value for new conversation setting: ${configId}`);
            }
            configOverrides[configId] = value;
            fallbackConfigIds.delete(configId);
          }
        }
        const createdAt = new Date().toISOString();
        const setup = await acp.newSession(
          projectsDirectory,
          context,
          Object.keys(configOverrides).length > 0 ? configOverrides : undefined,
          fallbackConfigIds
        );
        const session: SessionInfo = {
          sessionId: setup.sessionId,
          cwd: projectsDirectory,
          title: "New conversation",
          updatedAt: createdAt
        };
        deletedSessions.delete(setup.sessionId);
        sessionCache.set(setup.sessionId, session);
        sessionActivityCache.set(setup.sessionId, createdAt);
        nativePipelineModes.set(setup.sessionId, copilotHistory.available);
        completeLiveHistories.add(setup.sessionId);
        void queueSessionActivitySave().catch(() => {});
        const sessionView = {
          ...session,
          context,
          lastActivityAt: createdAt
        };
        publish("session-created", {
          ...sessionView,
          nativeMessageHistoryAvailable: copilotHistory.available
        }, setup.sessionId);
        return {
          session: sessionView,
          context,
          configOptions: setup.configOptions,
          models: setup.models,
          modes: setup.modes,
          nativeMessageHistoryAvailable: copilotHistory.available,
          newSessionDefaults
        };
      });
      jsonResponse(response, 201, result);
      return true;
    }

    const sessionId = sessionIdFromPath(requestUrl.pathname);
    if (!sessionId || !validSessionId(sessionId)) {
      throw new HttpError(404, "API route not found");
    }
    const subroute = subrouteFromPath(requestUrl.pathname);
    const deleteRequest = request.method === "DELETE" && subroute === undefined;
    if (deletedSessions.has(sessionId)) {
      throw new HttpError(404, "Conversation not found");
    }
    if (deletingSessions.has(sessionId)) {
      throw new HttpError(409, "Conversation is being deleted");
    }
    if (deleteRequest && busySessions.has(sessionId)) {
      throw new HttpError(409, "Cannot delete a conversation while it is processing a prompt");
    }
    if (deleteRequest) {
      deletingSessions.add(sessionId);
    }

    let session: SessionInfo;
    try {
      session = await findSession(sessionId, subroute === "config");
    } catch (error) {
      if (deleteRequest) {
        deletingSessions.delete(sessionId);
      }
      throw error;
    }
    if (!deleteRequest) {
      ensureSessionAvailable(sessionId);
    }

    if (deleteRequest) {
      try {
        await waitForSessionOperations(sessionId);
        await acp.start(acp.getSessionContext(sessionId) ?? "default");
        const acpSupportsDelete = acp.getCapabilities().sessionCapabilities.delete;
        if (!acpSupportsDelete && !nativeSessionDelete) {
          throw new HttpError(409, "This Copilot CLI does not support session deletion");
        }
        if (acpSupportsDelete) {
          await acp.deleteSession(sessionId);
        } else {
          if (acp.getSessionContext(sessionId)) {
            await acp.closeSession(sessionId);
          }
          await deleteSessionWithCopilotSdkOrNativeCli(
            await findCopilotSdkPath(),
            copilotCommand,
            copilotExecutable,
            projectsDirectory,
            sessionId,
            allowAll
          );
          acp.forgetSession(sessionId);
        }
        deletedSessions.add(sessionId);
        sessionCache.delete(sessionId);
        sessionReplayCache.delete(sessionId);
        nativeMessageStates.delete(sessionId);
        historyPager.forget(sessionId);
        truncatedReplays.delete(sessionId);
        legacyReplaySessions.delete(sessionId);
        fallbackReplayTails.delete(sessionId);
        nativePipelineModes.delete(sessionId);
        completeLiveHistories.delete(sessionId);
        busySessions.delete(sessionId);
        replayingSessions.delete(sessionId);
        sessionActivityCache.delete(sessionId);
        sessionUsageCache.delete(sessionId);

        const cleanupLabels = ["session usage", "session activity", "custom titles"];
        const cleanupResults = await Promise.allSettled([
          queueSessionUsageSave(),
          queueSessionActivitySave(),
          persistSessionTitleOverride(sessionId, undefined, false, true)
        ]);
        const persistenceWarnings: string[] = [];
        cleanupResults.forEach((result, index) => {
          if (result.status === "rejected") {
            const message = result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
            persistenceWarnings.push(`${cleanupLabels[index]}: ${message}`);
            if (index === 2) {
              console.error(`[server] Unable to clean deleted conversation title: ${message}`);
            }
          }
        });
        sessionCache.delete(sessionId);
        sessionReplayCache.delete(sessionId);
        publish("session-deleted", { sessionId }, sessionId);
        jsonResponse(response, 200, {
          deleted: true,
          ...(persistenceWarnings.length > 0 ? { persistenceWarnings } : {})
        });
        return true;
      } finally {
        deletingSessions.delete(sessionId);
      }
    }

    if (request.method === "POST" && subroute === "title") {
      const body = await readJsonBody(request);
      const title = parseSessionTitle(body.title);
      await withSessionOperation(sessionId, () => (
        persistSessionTitleOverride(sessionId, title)
      ));

      const renamedSession: SessionInfo = {
        ...session,
        title,
        customTitle: title
      };
      ensureSessionAvailable(sessionId);
      sessionCache.set(sessionId, renamedSession);
      publish("session-renamed", {
        sessionId,
        title
      }, sessionId);
      jsonResponse(response, 200, {
        session: renamedSession,
        title
      });
      return true;
    }

    if (!subroute) {
      throw new HttpError(404, "API route not found");
    }

    if (request.method === "GET" && subroute === "history") {
      if (!copilotHistory.available) {
        throw new HttpError(409, "Paged history requires the Copilot persisted-history API");
      }
      const cursor = requestUrl.searchParams.get("cursor");
      const before = requestUrl.searchParams.get("before");
      const around = requestUrl.searchParams.get("around");
      const position = cursor ?? before ?? around;
      if (!position || position.length > 200 || [cursor, before, around].filter(Boolean).length !== 1) {
        throw new HttpError(400, "One valid conversation history position is required");
      }
      try {
        const page = cursor !== null
          ? await historyPager.read(sessionId, cursor)
          : await historyPager.seek(sessionId, position, around !== null);
        ensureSessionAvailable(sessionId);
        jsonResponse(response, 200, displayHistory(sessionId, page));
      } catch (error) {
        if (error instanceof HistoryCursorExpiredError) {
          throw new HttpError(410, error.message);
        }
        throw error;
      }
      return true;
    }

    if (request.method === "POST" && subroute === "load") {
      const body = await readJsonBody(request);
      if (body.historyPaging !== undefined && typeof body.historyPaging !== "boolean") {
        throw new HttpError(400, "historyPaging must be a boolean");
      }
      const sessionWasUnprompted = acp.isSessionUnprompted(sessionId);
      const liveState = nativeMessageStates.get(sessionId);
      // A new conversation's journal may not exist yet. Its complete live snapshot
      // is authoritative while the first reply is being saved.
      const useLiveHistory = body.historyPaging === true && copilotHistory.available &&
        busySessions.has(sessionId) && completeLiveHistories.has(sessionId) &&
        (liveState?.messages.size ?? 0) <= historyPageMaximumMessages &&
        Buffer.byteLength(JSON.stringify({
          replay: sessionReplayCache.get(sessionId) ?? [],
          messages: liveState ? nativeMessagesForState(liveState) : []
        })) <= historyPageMaximumBytes;
      const liveHistoryMessages = new Map<string, NativeMessage>();
      const historyPagingRequested = body.historyPaging === true;
      const liveHistoryReplay: PagedHistoryReplayBuffer = {
        updates: [],
        bytes: 0,
        truncated: false
      };
      if (historyPagingRequested) {
        const buffers = pagedHistoryBuffers.get(sessionId) ?? new Set();
        buffers.add(liveHistoryMessages);
        pagedHistoryBuffers.set(sessionId, buffers);
        const replayBuffers = pagedHistoryReplayBuffers.get(sessionId) ?? new Set();
        replayBuffers.add(liveHistoryReplay);
        pagedHistoryReplayBuffers.set(sessionId, replayBuffers);
      }
      let historyPage: HistoryPage | undefined;
      let historyWarning: string | undefined;
      if (historyPagingRequested && (sessionWasUnprompted || useLiveHistory)) {
        historyPage = { events: [], hasMore: false, oversized: false };
      } else if (historyPagingRequested && !copilotHistory.available) {
        historyWarning = "This Copilot CLI cannot page stored history; using compatible ACP replay.";
      }
      if (
        historyPagingRequested &&
        !sessionWasUnprompted && !useLiveHistory &&
        copilotHistory.available
      ) {
        try {
          // Pin the persisted generation before ACP activation can compact or rewrite it.
          historyPage = await historyPager.read(sessionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[history] Paged history unavailable for ${sessionId}: ${message}`);
          historyWarning = `Paged history unavailable; using ACP history: ${message}`;
        }
      }
      const nativeHistoryRead = historyPage ? undefined : startNativeHistoryRead(sessionId);
      let persistedNativeEvents: JsonObject[] = [];
      let nativeHistoryReadSucceeded = historyPage !== undefined ||
        (sessionWasUnprompted && copilotHistory.available);
      if (historyPage) {
        persistedNativeEvents = historyPage.events;
      }
      try {
        if (nativeHistoryRead) {
          persistedNativeEvents = await nativeHistoryRead.promise;
          nativeHistoryReadSucceeded = true;
        } else if (!historyPage && !sessionWasUnprompted && copilotHistory.available) {
          console.warn(
            `[history] Unable to start persisted-message read for ${sessionId}`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[history] Unable to read persisted messages for ${sessionId}: ${message}`
        );
      }
      if (historyPagingRequested && !historyPage && nativeHistoryReadSucceeded) {
        historyPage = {
          events: persistedNativeEvents,
          hasMore: false,
          oversized: persistedNativeEvents.some((event) => (
            Buffer.byteLength(JSON.stringify(event)) > historyPageMaximumBytes
          ))
        };
        historyWarning = "Paged history was unavailable; the complete native transcript was loaded.";
      }
      if (nativeHistoryReadSucceeded) {
        legacyReplaySessions.delete(sessionId);
      } else {
        legacyReplaySessions.add(sessionId);
      }

      try {
        ensureSessionAvailable(sessionId);
        const previousContext = acp.getSessionContext(sessionId);
        const busyPrompt = busySessions.get(sessionId);
        const busy = busyPrompt !== undefined;
        // An explicit context switches profiles; otherwise reuse the conversation's last context.
        const requestedContext = parseContext(
          body.context ??
          acp.getPreferredSessionContext(sessionId) ??
          body.fallbackContext
        );
        const context = busy
          ? previousContext ?? requestedContext
          : requestedContext;
        const acpFallbackReplay = historyPagingRequested &&
          !historyPage &&
          !nativeHistoryReadSucceeded;
        const replayCompleteAcpHistory = acpFallbackReplay &&
          previousContext !== undefined;
        if (acpFallbackReplay && busy) {
          throw new HttpError(
            503,
            "History could not be read safely while this conversation is active. Wait for the current reply to finish and retry."
          );
        }
        if (
          replayCompleteAcpHistory &&
          !acp.getCapabilities(previousContext ?? context).sessionCapabilities.close
        ) {
          throw new HttpError(
            503,
            "History could not be read safely, and this Copilot CLI cannot replay the active session. The existing transcript was left unchanged."
          );
        }
        let setup: SessionSetup;
        let persistenceWarnings: string[] = [];
        if (acpFallbackReplay) {
          fallbackReplayTails.set(
            sessionId,
            [...(sessionReplayCache.get(sessionId) ?? [])]
          );
          sessionReplayCache.delete(sessionId);
          truncatedReplays.delete(sessionId);
        }
        if (busy) {
          setup = {
            sessionId,
            configOptions: acp.getConfigOptions(sessionId)
          };
        } else {
          setup = await withSessionOperation(sessionId, async () => {
            if (replayCompleteAcpHistory) {
              await acp.closeSession(sessionId);
            }
            const loaded = await acp.loadSession(session, context);
            const replacement = await replaceEmptySession(session, loaded);
            session = replacement.session;
            persistenceWarnings = replacement.persistenceWarnings;
            return loaded;
          }, true);
          ensureSessionAvailable(setup.sessionId);
        }
        const sessionView = {
          ...session,
          context,
          lastActivityAt: sessionActivityCache.get(setup.sessionId) ?? session.updatedAt
        };
        if (!busy) {
          publish("session-loaded", {
            session: sessionView,
            context,
            configOptions: setup.configOptions
          }, setup.sessionId);
        }
        const state = nativeMessageState(setup.sessionId);
        const nativeMessagesActive = !acpFallbackReplay &&
          copilotHistory.available && (
            nativeHistoryReadSucceeded ||
            state.messages.size > 0
          );
        nativePipelineModes.set(setup.sessionId, copilotHistory.available);
        let nativeMessages: NativeMessage[] = [];
        if (nativeMessagesActive) {
          if (nativeHistoryReadSucceeded) {
            for (const event of persistedNativeEvents) {
              if (
                isNativeMessageEvent(event) &&
                isRootAgentMessageEvent(event) &&
                typeof event.id === "string"
              ) {
                state.eventIds.add(event.id);
              }
            }
            nativeMessages = mergeNativeMessages(
              persistedNativeEvents,
              nativeHistoryRead?.bufferedEvents ?? [],
              nativeMessagesForState(state)
            );
          } else {
            nativeMessages = nativeMessagesForState(state);
          }
          if (
            busyPrompt?.nativeUserMessageId &&
            busyPrompt.clientPromptId
          ) {
            for (const message of nativeMessages) {
              if (
                message.role === "user" &&
                message.messageId === busyPrompt.nativeUserMessageId
              ) {
                message.clientPromptId = busyPrompt.clientPromptId;
              }
            }
          }
        }
        trimNativeState(setup.sessionId);
        retainReplay(setup.sessionId, sessionReplayCache.get(setup.sessionId) ?? []);
        const pagedDisplay = historyPage
          ? displayHistory(
            setup.sessionId,
            historyPage,
            true,
            liveHistoryReplay.updates,
            useLiveHistory ? nativeMessages : undefined,
            [
              ...liveHistoryMessages.values(),
              ...nativeMessagesForState(state).filter((message) => (
                busyPrompt?.clientPromptId !== undefined &&
                message.clientPromptId === busyPrompt.clientPromptId
              ))
            ]
          )
          : undefined;
        if (historyPage && busyPrompt) {
          for (const message of nativeMessagesForState(state)) {
            if (message.clientPromptId === busyPrompt.clientPromptId) {
              liveHistoryMessages.set(`${message.role}:${message.messageId}`, message);
            }
          }
        }
        const loadWarnings = [
          historyWarning,
          pagedDisplay?.historyWarning,
          liveHistoryReplay.truncated
            ? "Some live activity arrived during history loading and could not fit in the page buffer."
            : undefined
        ].filter((warning): warning is string => warning !== undefined);
        jsonResponse(response, 200, {
          session: sessionView,
          updateSequence,
          context,
          configOptions: setup.configOptions,
          models: setup.models,
          modes: setup.modes,
          busy,
          ...(busyPrompt ? { promptId: busyPrompt.promptId } : {}),
          usage: sessionUsageCache.get(setup.sessionId) ?? null,
          replayUpdates: pagedDisplay?.replayUpdates ??
            [...(sessionReplayCache.get(setup.sessionId) ?? [])],
          nativeMessagesActive,
          ...(nativeMessagesActive ? {
            nativeMessages: pagedDisplay?.nativeMessages ?? nativeMessages
          } : {}),
          ...(pagedDisplay ? {
            history: pagedDisplay.history,
            liveNativeMessages: [...liveHistoryMessages.values()],
            ...(pagedDisplay.liveReplayUpdates
              ? { liveReplayUpdates: pagedDisplay.liveReplayUpdates }
              : {})
          } : {}),
          ...(loadWarnings.length > 0 ? { historyWarning: loadWarnings.join(" ") } : {}),
          ...(persistenceWarnings.length > 0 ? { persistenceWarnings } : {})
        });
        if (acpFallbackReplay) {
          legacyReplaySessions.delete(sessionId);
          truncatedReplays.delete(sessionId);
          retainReplay(sessionId, sessionReplayCache.get(sessionId) ?? []);
        }
        return true;
      } finally {
        nativeHistoryRead?.release();
        const buffers = pagedHistoryBuffers.get(sessionId);
        buffers?.delete(liveHistoryMessages);
        if (buffers?.size === 0) {
          pagedHistoryBuffers.delete(sessionId);
        }
        const replayBuffers = pagedHistoryReplayBuffers.get(sessionId);
        replayBuffers?.delete(liveHistoryReplay);
        if (replayBuffers?.size === 0) {
          pagedHistoryReplayBuffers.delete(sessionId);
        }
      }
    }

    if (request.method === "GET" && subroute === "status") {
      const busyPrompt = busySessions.get(sessionId);
      jsonResponse(response, 200, {
        sessionId,
        busy: busyPrompt !== undefined,
        ...(busyPrompt ? { promptId: busyPrompt.promptId } : {})
      });
      return true;
    }

    if (request.method === "POST" && subroute === "messages") {
      const body = await readJsonBody(request);
      const result = await runRequestOnce(request, body, async () => {
        if (configuringSessions.has(sessionId)) {
          throw new HttpError(409, "Conversation is currently updating its settings");
        }
        if (busySessions.has(sessionId)) {
          throw new HttpError(409, "Conversation is already processing a prompt");
        }
        ensureSessionAvailable(sessionId);
        if (configuringSessions.has(sessionId)) {
          throw new HttpError(409, "Conversation is currently updating its settings");
        }
        if (body.reconnect !== undefined && typeof body.reconnect !== "boolean") {
          throw new HttpError(400, "reconnect must be a boolean");
        }
        if (busySessions.has(sessionId)) {
          throw new HttpError(409, "Conversation is already processing a prompt");
        }
        const nativeMcpReload = typeof body.text === "string" &&
          body.text.trim() === "/mcp reload";
        if (
          body.reconnect === true &&
          (!nativeMcpReload || (Array.isArray(body.attachments) && body.attachments.length > 0))
        ) {
          throw new HttpError(
            400,
            "reconnect can only be used with /mcp reload and no attachments"
          );
        }
        const reloadMcp = body.reconnect === true || nativeMcpReload;
        if ([...busySessions.values()].some((prompt) => prompt.reloadingMcp)) {
          throw new HttpError(409, "MCP connections are currently reloading");
        }
        if (reloadMcp && busySessions.size > 0) {
          throw new HttpError(
            409,
            "Cannot reload MCP connections while another conversation is processing a prompt"
          );
        }
        const clientPromptId = parseOptionalPromptId(body.clientPromptId, "Client prompt id");
        const promptId = randomBytes(12).toString("hex");
        const busyPrompt: BusyPrompt = {
          promptId,
          cancelController: new AbortController(),
          reloadingMcp: reloadMcp
        };
        if (clientPromptId !== undefined) {
          busyPrompt.clientPromptId = clientPromptId;
        }
        busySessions.set(sessionId, busyPrompt);
        const userReplayEntries: JsonObject[] = [];
        let stopReason: string | undefined;
        let errorMessage: string | undefined;
        try {
          publish("session-prompt-started", { sessionId, promptId }, sessionId);
          const context = acp.getSessionContext(sessionId) ?? "default";
          await acp.start(context);
          const prompt = parsePrompt(body, acp.getCapabilities(context));
          const replay = sessionReplayCache.get(sessionId) ?? [];
          const userMessageId = `web-${randomBytes(12).toString("hex")}`;
          busyPrompt.userMessageId = userMessageId;
          for (const content of prompt) {
            const entry: JsonObject = {
              sessionId,
              ...(reloadMcp ? { nativeCommand: true } : {}),
              ...(busyPrompt.clientPromptId
                ? { clientPromptId: busyPrompt.clientPromptId }
                : {}),
              update: {
                sessionUpdate: "user_message_chunk",
                messageId: userMessageId,
                content
              }
            };
            userReplayEntries.push(entry);
            replay.push(entry);
          }
          retainReplay(sessionId, replay);
          touchSessionActivity(sessionId);
          if (body.reconnect === true && !busyPrompt.cancelController.signal.aborted) {
            stopReason = await withSessionOperation(sessionId, () => (
              acp.reloadMcpServers(session, busyPrompt.cancelController.signal)
            ));
            ensureSessionAvailable(sessionId);
          }
          if (busyPrompt.cancelController.signal.aborted) {
            stopReason = "cancelled";
          } else if (body.reconnect !== true) {
            stopReason = await acp.prompt(session, prompt, busyPrompt.cancelController.signal);
          }
          return stopReason === undefined ? {} : { stopReason };
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          if (busySessions.get(sessionId)?.promptId === promptId) {
            if (nativePipelineModes.get(sessionId) === true) {
              // Commands such as /mcp reload record no native messages, so their output has no
              // recorded time and is not a history mismatch.
              const commandPrompt = busyPrompt.nativeUserMessageId === undefined;
              if (commandPrompt) {
                for (const entry of userReplayEntries) {
                  entry.nativeCommand = true;
                }
              }
              if (!busyPrompt.nativeAssistantHasContent) {
                for (const update of busyPrompt.acpAssistantUpdates ?? []) {
                  if (commandPrompt) {
                    update.nativeCommand = true;
                  } else {
                    update.nativeFallback = true;
                  }
                  if (busyPrompt.clientPromptId) {
                    update.clientPromptId = busyPrompt.clientPromptId;
                  }
                  // Delivery advances, but history and fallback still represent the same text chunk.
                  update.sourceUpdateSequence ??= update.updateSequence;
                  update.updateSequence = ++updateSequence;
                  publish("session-update", {
                    ...update,
                    ...(busyPrompt.clientPromptId
                      ? { clientPromptId: busyPrompt.clientPromptId }
                      : {}),
                    ...(commandPrompt ? { nativeCommand: true } : { nativeFallback: true })
                  }, sessionId);
                }
              }
              if (commandPrompt && busyPrompt.clientPromptId) {
                for (const buffer of pagedHistoryReplayBuffers.get(sessionId) ?? []) {
                  for (const params of buffer.updates) {
                    if (params.clientPromptId === busyPrompt.clientPromptId) {
                      params.nativeCommand = true;
                    }
                  }
                }
              }
            }
            busySessions.delete(sessionId);
          }
          touchSessionActivity(sessionId);
          const completion: JsonObject = {
            sessionId,
            promptId
          };
          if (stopReason !== undefined) {
            completion.stopReason = stopReason;
          }
          if (errorMessage !== undefined) {
            completion.error = errorMessage;
          }
          publish("session-prompt-complete", completion, sessionId);
        }
      });
      jsonResponse(response, 200, result);
      return true;
    }

    if (request.method === "POST" && subroute === "cancel") {
      const body = await readJsonBody(request);
      const requestedPromptId = parseOptionalPromptId(body.promptId, "Prompt id");
      const busyPrompt = busySessions.get(sessionId);
      const promptMatches = busyPrompt !== undefined && (
        requestedPromptId === undefined ||
        requestedPromptId === busyPrompt.promptId ||
        requestedPromptId === busyPrompt.clientPromptId
      );
      if (!promptMatches) {
        jsonResponse(response, 202, { cancelled: false });
        return true;
      }
      busyPrompt.cancelController.abort();
      await withSessionOperation(sessionId, () => acp.cancel(sessionId));
      ensureSessionAvailable(sessionId);
      jsonResponse(response, 202, {
        cancelled: true,
        promptId: busyPrompt.promptId
      });
      return true;
    }

    if (request.method === "POST" && subroute === "config") {
      if (busySessions.has(sessionId)) {
        throw new HttpError(409, "Conversation is currently processing a prompt");
      }
      const body = await readJsonBody(request);
      if (typeof body.configId !== "string" || body.configId.length === 0) {
        throw new HttpError(400, "Configuration id is required");
      }
      if (typeof body.value !== "string" && typeof body.value !== "boolean") {
        throw new HttpError(400, "Configuration value must be a string or boolean");
      }
      const configId = body.configId;
      const configValue = body.value;

      const option = acp.getConfigOptions(sessionId)
        .find((candidate) => candidate.id === configId);
      if (!option || !isModelConfigOption(option)) {
        throw new HttpError(400, "That configuration option cannot be changed here");
      }

      let persistenceWarnings: string[] = [];
      const setup = await withSessionOperation(sessionId, async () => {
        const configured = await acp.setConfigOption(session, configId, configValue);
        const replacement = await replaceEmptySession(session, configured);
        session = replacement.session;
        persistenceWarnings = replacement.persistenceWarnings;
        return configured;
      }, true);
      ensureSessionAvailable(setup.sessionId);
      jsonResponse(response, 200, {
        session,
        context: acp.getSessionContext(setup.sessionId) ?? "default",
        configOptions: setup.configOptions,
        nativeMessageHistoryAvailable: copilotHistory.available,
        ...(persistenceWarnings.length > 0 ? { persistenceWarnings } : {})
      });
      return true;
    }

    if (request.method === "POST" && subroute === "permissions") {
      const body = await readJsonBody(request);
      const requestId = body.requestId;
      if (!isJsonRpcId(requestId)) {
        throw new HttpError(400, "Permission requestId is required");
      }

      const context = parseContext(body.context);
      const optionId = body.optionId;
      if (body.cancelled === true) {
        await withSessionOperation(sessionId, () => acp.respondToPermission(
          context,
          requestId,
          { outcome: "cancelled" },
          sessionId
        ));
      } else if (typeof optionId === "string" && optionId.length > 0) {
        await withSessionOperation(sessionId, () => acp.respondToPermission(
          context,
          requestId,
          {
            outcome: "selected",
            optionId
          },
          sessionId
        ));
      } else {
        throw new HttpError(400, "Permission optionId or cancelled is required");
      }
      ensureSessionAvailable(sessionId);
      jsonResponse(response, 200, { accepted: true });
      return true;
    }

    throw new HttpError(404, "API route not found");
  };

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        if (requestUrl.pathname.startsWith("/api/")) {
          await handleApi(request, response, requestUrl);
        } else if (request.method === "GET" || request.method === "HEAD") {
          await serveStatic(request, response);
        } else {
          throw new HttpError(405, "Method not allowed");
        }
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Unexpected server error";
        if (status >= 500) {
          console.error(`[server] ${message}`);
        }
        if (!response.headersSent) {
          jsonResponse(response, status, {
            error: message,
            ...(error instanceof HttpError && error.code ? { code: error.code } : {})
          });
        } else {
          response.end();
        }
      }
    })();
  });

  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      client.response.write(": heartbeat\n\n");
    }
  }, 15_000);
  heartbeat.unref();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}; stopping ${branding.brandName}`);
    clearInterval(heartbeat);
    for (const client of sseClients) {
      client.response.end();
    }
    sseClients.clear();
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await acp.stop();
    } finally {
      try {
        await copilotHistory.stop();
      } finally {
        await serverClosed;
        await Promise.all([
          sessionTitleWrites.flush(),
          sessionUsageWrites.flush(),
          sessionActivityWrites.flush()
        ]);
      }
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").finally(() => process.exit(0));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  console.log(`${branding.brandName} is running at http://127.0.0.1:${port}`);
  console.log(`New conversations start in ${projectsDirectory}`);
  console.log(`Available context tiers: ${contextTiers.join(", ")}`);
  console.log(`Copilot allow-all permissions: ${allowAll ? "enabled" : "disabled"}`);
  console.log(`Session deletion supported: ${browserCapabilities().sessionCapabilities.delete}`);
  console.log(
    `Session deletion fallback: ${
      !nativeSessionDelete
        ? "disabled"
        : copilotSdkPath
          ? "Copilot SDK"
          : "native CLI command"
    }`
  );
};

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
