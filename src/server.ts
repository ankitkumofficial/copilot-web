import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  type PromptContentBlock,
  type SessionSetup,
  type SessionInfo
} from "./acp.js";

const applicationVersion = "0.1.0";
const defaultBrandName = "Copilot Web";
const defaultBrandInitial = "C";
const maximumBodyBytes = 25 * 1024 * 1024;
const maximumPromptAttachments = 10;
const maximumPromptAttachmentBytes = 8 * 1024 * 1024;
const maximumPromptAttachmentTotalBytes = 16 * 1024 * 1024;
const maximumSessionTitleLength = 120;
const nativeSessionDeleteTimeoutMs = 60_000;
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
    description: "Use Copilot's configured default context profile."
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
}

interface SessionUsage {
  aicNano: number | null;
  aicLimit: number | null;
}

type SessionTitleOverrides = Map<string, string>;
type SessionActivityCache = Map<string, string>;

class HttpError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
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

function inferredAttachmentMimeType(name: string): string | undefined {
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
      return undefined;
  }
}

function parseAttachmentMimeType(name: string, value: unknown): string {
  const declared = typeof value === "string"
    ? value.toLowerCase().split(";", 1)[0]?.trim() ?? ""
    : "";
  const mimeType = !declared || declared === "application/octet-stream"
    ? inferredAttachmentMimeType(name)
    : declared;
  if (!mimeType || (!mimeType.startsWith("image/") && mimeType !== "application/pdf")) {
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
      throw new HttpError(409, "This Copilot agent does not support PDF attachments");
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
  const settingsPath = path.join(os.homedir(), ".copilot", "settings.json");
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
  const sessionTitleOverrides = await loadSessionTitleOverrides(sessionTitlesPath);
  const sessionUsageCache = await loadSessionUsage(sessionUsagePath);
  const sessionActivityCache = await loadSessionActivity(sessionActivityPath);

  const acp = new AcpConnectionManager({
    command: copilotCommand,
    cwd: projectsDirectory,
    clientVersion: applicationVersion,
    clientTitle: branding.brandName,
    allowAll
  });
  await acp.start();

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
  let sessionUsageWrite: Promise<void> = Promise.resolve();
  let sessionActivityWrite: Promise<void> = Promise.resolve();
  const replayingSessions = new Set<string>();
  const busySessions = new Map<string, BusyPrompt>();
  const sseClients = new Set<SseClient>();
  const browserToken = randomBytes(32).toString("hex");

  const queueSessionUsageSave = (): Promise<void> => {
    const snapshot = new Map(
      [...sessionUsageCache].map(([sessionId, usage]) => [
        sessionId,
        { ...usage }
      ])
    );
    const write = sessionUsageWrite.then(() => saveSessionUsage(sessionUsagePath, snapshot));
    sessionUsageWrite = write.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[server] Unable to persist session usage: ${message}`);
    });
    return write;
  };

  const queueSessionActivitySave = (): Promise<void> => {
    const snapshot = new Map(sessionActivityCache);
    const write = sessionActivityWrite.then(() => (
      saveSessionActivity(sessionActivityPath, snapshot)
    ));
    sessionActivityWrite = write.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[server] Unable to persist session activity: ${message}`);
    });
    return write;
  };

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

  acp.events.on("sessionUpdate", (event: { context: ContextTier; params: JsonObject }) => {
    if (!isRecord(event.params)) {
      return;
    }
    const sessionId = typeof event.params.sessionId === "string" ? event.params.sessionId : undefined;
    if (sessionId) {
      const replay = sessionReplayCache.get(sessionId) ?? [];
      replay.push(event.params);
      sessionReplayCache.set(sessionId, replay);
    }
    if (
      sessionId &&
      !replayingSessions.has(sessionId) &&
      !busySessions.has(sessionId) &&
      isSessionUpdateActivity(event.params)
    ) {
      touchSessionActivity(sessionId);
    }
    publish(
      "session-update",
      replayingSessions.has(sessionId ?? "")
        ? { ...event.params, _replay: true }
        : event.params,
      sessionId
    );
  });
  acp.events.on("sessionEvent", (event: { context: ContextTier; params: JsonObject }) => {
    if (!isRecord(event.params)) {
      return;
    }
    const sessionId = typeof event.params.sessionId === "string" ? event.params.sessionId : undefined;
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
    publish("session-event", event.params, sessionId);
  });
  acp.events.on("permissionRequest", (event: ManagedPermissionRequestEvent) => {
    const sessionId = typeof event.params.sessionId === "string"
      ? event.params.sessionId
      : undefined;
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
      const newSessionDefaults = await readCopilotDefaults();
      jsonResponse(response, 200, {
        ok: true,
        brandName: branding.brandName,
        brandInitial: branding.brandInitial,
        projectsDirectory,
        capabilities: browserCapabilities(),
        contexts: contextOptions,
        newSessionDefaults
      });
      return true;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/config") {
      const context = parseContext(requestUrl.searchParams.get("context") ?? undefined);
      const setup = await acp.discoverConfig(context);
      const newSessionDefaults = await readCopilotDefaults();
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
        capabilities: browserCapabilities(),
        brandName: branding.brandName,
        brandInitial: branding.brandInitial,
        projectsDirectory,
        contexts: contextOptions,
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
      const newSessionDefaults = await readCopilotDefaults();
      cacheSessions(sessions);
      jsonResponse(response, 200, {
        sessions: sessions.map((session) => {
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
        newSessionDefaults
      });
      return true;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/sessions") {
      const body = await readJsonBody(request);
      const newSessionDefaults = await readCopilotDefaults();
      const context = parseContext(body.context ?? newSessionDefaults.context);
      const configOverrides: Record<string, string> = {};
      if (newSessionDefaults.model) {
        configOverrides.model = newSessionDefaults.model;
      }
      if (newSessionDefaults.reasoningEffort) {
        configOverrides.reasoning_effort = newSessionDefaults.reasoningEffort;
      }
      const createdAt = new Date().toISOString();
      const setup = await acp.newSession(
        projectsDirectory,
        context,
        Object.keys(configOverrides).length > 0 ? configOverrides : undefined
      );
      const session: SessionInfo = {
        sessionId: setup.sessionId,
        cwd: projectsDirectory,
        title: "New conversation",
        updatedAt: createdAt
      };
      sessionCache.set(setup.sessionId, session);
      sessionActivityCache.set(setup.sessionId, createdAt);
      void queueSessionActivitySave().catch(() => {});
      const sessionView = {
        ...session,
        context,
        lastActivityAt: createdAt
      };
      publish("session-created", sessionView, setup.sessionId);
      jsonResponse(response, 201, {
        session: sessionView,
        context,
        configOptions: setup.configOptions,
        models: setup.models,
        modes: setup.modes,
        newSessionDefaults
      });
      return true;
    }

    const sessionId = sessionIdFromPath(requestUrl.pathname);
    if (!sessionId || !validSessionId(sessionId)) {
      throw new HttpError(404, "API route not found");
    }
    const subroute = subrouteFromPath(requestUrl.pathname);
    const session = await findSession(sessionId, subroute === "config");

    if (request.method === "DELETE" && subroute === undefined) {
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
        if (copilotSdkPath) {
          await deleteSessionWithCopilotSdk(
            copilotSdkPath,
            copilotExecutable,
            projectsDirectory,
            sessionId,
            allowAll
          );
        } else {
          await deleteSessionWithNativeCli(
            copilotCommand,
            projectsDirectory,
            sessionId,
            allowAll
          );
        }
        acp.forgetSession(sessionId);
      }
      sessionCache.delete(sessionId);
      sessionReplayCache.delete(sessionId);
      if (sessionActivityCache.delete(sessionId)) {
        await queueSessionActivitySave();
      }
      if (sessionUsageCache.delete(sessionId)) {
        await queueSessionUsageSave();
      }
      if (sessionTitleOverrides.delete(sessionId)) {
        await saveSessionTitleOverrides(sessionTitlesPath, sessionTitleOverrides);
      }
      publish("session-deleted", { sessionId }, sessionId);
      jsonResponse(response, 200, { deleted: true });
      return true;
    }

    if (request.method === "POST" && subroute === "title") {
      const body = await readJsonBody(request);
      const title = parseSessionTitle(body.title);
      const previousTitle = sessionTitleOverrides.get(sessionId);
      sessionTitleOverrides.set(sessionId, title);
      try {
        await saveSessionTitleOverrides(sessionTitlesPath, sessionTitleOverrides);
      } catch (error) {
        if (previousTitle === undefined) {
          sessionTitleOverrides.delete(sessionId);
        } else {
          sessionTitleOverrides.set(sessionId, previousTitle);
        }
        throw error;
      }

      const renamedSession: SessionInfo = {
        ...session,
        title,
        customTitle: title
      };
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

    if (request.method === "POST" && subroute === "load") {
      const body = await readJsonBody(request);
      const previousContext = acp.getSessionContext(sessionId);
      const busyPrompt = busySessions.get(sessionId);
      const busy = busyPrompt !== undefined;
      const requestedContext = parseContext(body.context ?? previousContext);
      const context = busy
        ? previousContext ?? requestedContext
        : requestedContext;
      let setup: SessionSetup;
      if (busy) {
        setup = {
          sessionId,
          configOptions: acp.getConfigOptions(sessionId)
        };
      } else {
        if (previousContext && previousContext !== context) {
          sessionReplayCache.delete(sessionId);
        }
        replayingSessions.add(sessionId);
        try {
          setup = await acp.loadSession(session, context);
        } finally {
          replayingSessions.delete(sessionId);
        }
      }
      const sessionView = {
        ...session,
        context,
        lastActivityAt: sessionActivityCache.get(sessionId) ?? session.updatedAt
      };
      if (!busy) {
        publish("session-loaded", {
          session: sessionView,
          context,
          configOptions: setup.configOptions
        }, sessionId);
      }
      jsonResponse(response, 200, {
        session: sessionView,
        context,
        configOptions: setup.configOptions,
        models: setup.models,
        modes: setup.modes,
        busy,
        ...(busyPrompt ? { promptId: busyPrompt.promptId } : {}),
        usage: sessionUsageCache.get(sessionId) ?? null,
        replayUpdates: [...(sessionReplayCache.get(sessionId) ?? [])]
      });
      return true;
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
      if (busySessions.has(sessionId)) {
        throw new HttpError(409, "Conversation is already processing a prompt");
      }
      const body = await readJsonBody(request);
      const context = acp.getSessionContext(sessionId) ?? "default";
      const prompt = parsePrompt(body, acp.getCapabilities(context));
      const clientPromptId = parseOptionalPromptId(body.clientPromptId, "Client prompt id");
      const replay = sessionReplayCache.get(sessionId) ?? [];
      const userMessageId = `web-${randomBytes(12).toString("hex")}`;
      for (const content of prompt) {
        replay.push({
          sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            messageId: userMessageId,
            content
          }
        });
      }
      sessionReplayCache.set(sessionId, replay);

      const promptId = randomBytes(12).toString("hex");
      const busyPrompt: BusyPrompt = { promptId };
      if (clientPromptId !== undefined) {
        busyPrompt.clientPromptId = clientPromptId;
      }
      busySessions.set(sessionId, busyPrompt);
      touchSessionActivity(sessionId);
      let stopReason: string | undefined;
      let errorMessage: string | undefined;
      try {
        stopReason = await acp.prompt(session, prompt);
        jsonResponse(response, 200, { stopReason });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        if (busySessions.get(sessionId)?.promptId === promptId) {
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
      await acp.cancel(sessionId);
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

      const option = acp.getConfigOptions(sessionId)
        .find((candidate) => candidate.id === body.configId);
      if (!option || !isModelConfigOption(option)) {
        throw new HttpError(400, "That configuration option cannot be changed here");
      }

      const configOptions = await acp.setConfigOption(session, body.configId, body.value);
      jsonResponse(response, 200, {
        context: acp.getSessionContext(sessionId) ?? "default",
        configOptions
      });
      return true;
    }

    if (request.method === "POST" && subroute === "permissions") {
      const body = await readJsonBody(request);
      if (!isJsonRpcId(body.requestId)) {
        throw new HttpError(400, "Permission requestId is required");
      }

      const context = parseContext(body.context);
      if (body.cancelled === true) {
        await acp.respondToPermission(context, body.requestId, { outcome: "cancelled" });
      } else if (typeof body.optionId === "string" && body.optionId.length > 0) {
        await acp.respondToPermission(context, body.requestId, {
          outcome: "selected",
          optionId: body.optionId
        });
      } else {
        throw new HttpError(400, "Permission optionId or cancelled is required");
      }
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
          jsonResponse(response, status, { error: message });
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await acp.stop();
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
