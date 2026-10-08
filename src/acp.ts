import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export type JsonRpcId = number | string;
export type JsonObject = Record<string, unknown>;
export type ContextTier = "default" | "long_context";

export const contextTiers: readonly ContextTier[] = ["default", "long_context"];

export type PromptContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      data: string;
      mimeType: string;
    }
  | {
      type: "resource";
      resource: {
        uri: string;
        blob: string;
        mimeType: string;
      };
    };

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  customTitle?: string;
  updatedAt?: string;
}

export interface SessionSetup {
  sessionId: string;
  configOptions: JsonObject[];
  models?: JsonObject;
  modes?: JsonObject;
}

export interface AgentCapabilities {
  loadSession: boolean;
  promptCapabilities: {
    image: boolean;
    audio: boolean;
    embeddedContext: boolean;
  };
  sessionCapabilities: {
    close: boolean;
    delete: boolean;
    list: boolean;
  };
  agentInfo?: JsonObject;
}

export interface PermissionRequestEvent {
  requestId: JsonRpcId;
  params: JsonObject;
}

export interface ManagedPermissionRequestEvent extends PermissionRequestEvent {
  context: ContextTier;
}

interface ManagedSessionUpdateEvent {
  context: ContextTier;
  params: JsonObject;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

const defaultRequestTimeoutMs = 120_000;
const copilotSessionEventMethod = "github.com/copilot/sessionEvent";

export class AcpError extends Error {
  public readonly code: number | undefined;
  public readonly data: unknown;

  public constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function supportsCapability(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

export class AcpConnection {
  public readonly events = new EventEmitter();

  private readonly command: string;
  private readonly spawnCwd: string;
  private readonly clientVersion: string;
  private readonly clientTitle: string;
  private readonly allowAll: boolean;
  public readonly context: ContextTier;
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private startPromise: Promise<void> | undefined;
  private initialized = false;
  private stopping = false;
  private agentCapabilities: AgentCapabilities | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly permissionRequests = new Set<string>();
  private readonly activeSessions = new Set<string>();
  private readonly busySessions = new Set<string>();
  private readonly sessionConfigOptions = new Map<string, JsonObject[]>();

  public constructor(options: {
    command: string;
    cwd: string;
    clientVersion: string;
    clientTitle?: string;
    allowAll?: boolean;
    context?: ContextTier;
  }) {
    this.command = options.command;
    this.spawnCwd = options.cwd;
    this.clientVersion = options.clientVersion;
    this.clientTitle = options.clientTitle ?? "Copilot Web";
    this.allowAll = options.allowAll === true;
    this.context = options.context ?? "default";
  }

  public async start(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = undefined;
      throw error;
    }
  }

  public getCapabilities(): AgentCapabilities {
    if (!this.agentCapabilities) {
      throw new Error("ACP connection has not been initialized");
    }
    return this.agentCapabilities;
  }

  public async listSessions(): Promise<SessionInfo[]> {
    await this.start();

    const sessions: SessionInfo[] = [];
    let cursor: string | undefined;
    let pageCount = 0;

    do {
      const params: JsonObject = {};
      if (cursor) {
        params.cursor = cursor;
      }

      const result = await this.sendRequest<unknown>("session/list", params);
      if (!isRecord(result) || !Array.isArray(result.sessions)) {
        throw new Error("Copilot returned an invalid session/list response");
      }

      for (const session of result.sessions) {
        const parsed = this.parseSessionInfo(session);
        if (parsed) {
          sessions.push(parsed);
        }
      }

      cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0
        ? result.nextCursor
        : undefined;
      pageCount += 1;
      if (pageCount > 100) {
        throw new Error("Copilot returned too many session/list pages");
      }
    } while (cursor);

    return sessions;
  }

  public async newSession(cwd: string): Promise<SessionSetup> {
    await this.start();
    const result = await this.sendRequest<unknown>("session/new", {
      cwd,
      mcpServers: []
    });

    const setup = this.parseSessionSetup(result, "session/new");
    this.activeSessions.add(setup.sessionId);
    this.sessionConfigOptions.set(setup.sessionId, setup.configOptions);
    return setup;
  }

  public async loadSession(session: SessionInfo): Promise<SessionSetup> {
    await this.start();
    if (!this.getCapabilities().loadSession) {
      throw new AcpError("This Copilot CLI does not support loading sessions");
    }
    if (this.activeSessions.has(session.sessionId)) {
      return {
        sessionId: session.sessionId,
        configOptions: this.sessionConfigOptions.get(session.sessionId) ?? []
      };
    }

    const result = await this.sendRequest<unknown>("session/load", {
      sessionId: session.sessionId,
      cwd: session.cwd,
      mcpServers: []
    });
    const setup = this.parseSessionSetup(result, "session/load", session.sessionId);
    this.activeSessions.add(setup.sessionId);
    this.sessionConfigOptions.set(setup.sessionId, setup.configOptions);
    return setup;
  }

  public async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<JsonObject[]> {
    await this.start();
    const result = await this.sendRequest<unknown>("session/set_config_option", {
      sessionId,
      configId,
      value
    });
    if (!isRecord(result) || !Array.isArray(result.configOptions)) {
      throw new Error("Copilot returned an invalid session/set_config_option response");
    }
    const configOptions = result.configOptions.filter(isRecord);
    this.sessionConfigOptions.set(sessionId, configOptions);
    return configOptions;
  }

  public getConfigOptions(sessionId: string): JsonObject[] {
    return this.sessionConfigOptions.get(sessionId) ?? [];
  }

  public async closeSession(sessionId: string): Promise<void> {
    await this.start();
    if (!this.activeSessions.has(sessionId)) {
      return;
    }
    if (!this.getCapabilities().sessionCapabilities.close) {
      throw new AcpError("This Copilot CLI does not support closing sessions");
    }

    await this.sendRequest("session/close", { sessionId });
    this.activeSessions.delete(sessionId);
    this.sessionConfigOptions.delete(sessionId);
  }

  public async prompt(
    session: SessionInfo,
    prompt: PromptContentBlock[]
  ): Promise<string | undefined> {
    await this.start();
    if (this.busySessions.has(session.sessionId)) {
      throw new AcpError("This conversation is already processing a prompt");
    }

    this.busySessions.add(session.sessionId);
    try {
      if (!this.activeSessions.has(session.sessionId)) {
        await this.loadSession(session);
      }

      const result = await this.sendRequest<unknown>(
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt
        },
        0
      );

      if (!isRecord(result)) {
        throw new Error("Copilot returned an invalid session/prompt response");
      }
      return typeof result.stopReason === "string" ? result.stopReason : undefined;
    } finally {
      this.busySessions.delete(session.sessionId);
    }
  }

  public async cancel(sessionId: string): Promise<void> {
    await this.start();
    this.sendNotification("session/cancel", { sessionId });
  }

  public async deleteSession(sessionId: string): Promise<void> {
    await this.start();
    if (!this.getCapabilities().sessionCapabilities.delete) {
      throw new AcpError("This Copilot CLI does not support session deletion");
    }

    await this.closeSession(sessionId);
    await this.sendRequest("session/delete", { sessionId });
  }

  public async respondToPermission(
    requestId: JsonRpcId,
    outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" }
  ): Promise<void> {
    const key = String(requestId);
    if (!this.permissionRequests.has(key)) {
      throw new AcpError("That permission request is no longer pending");
    }

    this.permissionRequests.delete(key);
    this.writeMessage({
      jsonrpc: "2.0",
      id: requestId,
      result: { outcome }
    });
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(new Error("ACP connection stopped"));
    }
    this.pending.clear();

    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) {
      return;
    }

    child.stdin.end();
    child.kill("SIGTERM");
  }

  private async startInternal(): Promise<void> {
    this.stopping = false;
    const args = ["--context", this.context, "--acp", "--no-color"];
    if (this.allowAll) {
      args.push("--allow-all");
    }
    const child = spawn(this.command, args, {
      cwd: this.spawnCwd,
      env: {
        ...process.env,
        PWD: this.spawnCwd
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.events.emit("stderr", chunk);
    });
    child.on("error", (error) => {
      this.events.emit("processError", error);
      this.rejectPending(error);
    });
    child.on("exit", (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      const error = new Error(`Copilot ACP process exited with ${suffix}`);
      this.events.emit("processExit", { code, signal });
      if (!this.stopping) {
        this.rejectPending(error);
        this.events.emit("processError", error);
      }
    });

    const result = await this.sendRequest<unknown>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        _meta: {
          "github.com/copilot": {
            events: [
              "assistant.usage",
              "session.usage_checkpoint",
              "session.session_limits_changed"
            ]
          }
        },
        fs: {
          readTextFile: false,
          writeTextFile: false
        },
        terminal: false,
        auth: {
          terminal: false
        }
      },
      clientInfo: {
        name: "copilot-web",
        title: this.clientTitle,
        version: this.clientVersion
      }
    });

    if (!isRecord(result) || result.protocolVersion !== 1) {
      throw new Error("Copilot did not negotiate ACP protocol version 1");
    }

    const capabilities = isRecord(result.agentCapabilities)
      ? result.agentCapabilities
      : {};
    const sessionCapabilities = isRecord(capabilities.sessionCapabilities)
      ? capabilities.sessionCapabilities
      : {};

    this.agentCapabilities = {
      loadSession: capabilities.loadSession === true,
      promptCapabilities: {
        image: isRecord(capabilities.promptCapabilities) &&
          capabilities.promptCapabilities.image === true,
        audio: isRecord(capabilities.promptCapabilities) &&
          capabilities.promptCapabilities.audio === true,
        embeddedContext: isRecord(capabilities.promptCapabilities) &&
          capabilities.promptCapabilities.embeddedContext === true
      },
      sessionCapabilities: {
        close: supportsCapability(sessionCapabilities.close),
        delete: supportsCapability(sessionCapabilities.delete),
        list: supportsCapability(sessionCapabilities.list)
      }
    };
    if (isRecord(result.agentInfo)) {
      this.agentCapabilities.agentInfo = result.agentInfo;
    }
    this.initialized = true;
    this.events.emit("initialized", this.agentCapabilities);
  }

  private parseSessionSetup(
    value: unknown,
    operation: string,
    fallbackSessionId?: string
  ): SessionSetup {
    if (!isRecord(value)) {
      throw new Error(`Copilot returned an invalid ${operation} response`);
    }
    const sessionId = typeof value.sessionId === "string" ? value.sessionId : fallbackSessionId;
    if (!sessionId) {
      throw new Error("Copilot returned an invalid session/new response");
    }

    const setup: SessionSetup = {
      sessionId,
      configOptions: Array.isArray(value.configOptions)
        ? value.configOptions.filter(isRecord)
        : []
    };
    if (isRecord(value.models)) {
      setup.models = value.models;
    }
    if (isRecord(value.modes)) {
      setup.modes = value.modes;
    }
    return setup;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch (error) {
      const parseError = error instanceof Error ? error : new Error(String(error));
      this.events.emit("protocolError", new Error(`Invalid ACP JSON: ${parseError.message}`));
      return;
    }

    if (!isRecord(message)) {
      this.events.emit("protocolError", new Error("ACP message was not a JSON object"));
      return;
    }

    if (typeof message.method === "string") {
      this.handleMethodMessage(message);
      return;
    }

    if (isJsonRpcId(message.id) && (hasOwn(message, "result") || hasOwn(message, "error"))) {
      this.handleResponse(message.id, message);
      return;
    }

    this.events.emit("protocolError", new Error("Unrecognized ACP message"));
  }

  private handleMethodMessage(message: JsonObject): void {
    const method = message.method;
    if (method === copilotSessionEventMethod) {
      if (isRecord(message.params)) {
        this.events.emit("sessionEvent", message.params);
      } else {
        this.events.emit("protocolError", new Error("Copilot session event omitted params"));
      }
      return;
    }

    if (method === "session/update") {
      if (isRecord(message.params)) {
        this.events.emit("sessionUpdate", message.params);
      } else {
        this.events.emit("protocolError", new Error("ACP session/update omitted params"));
      }
      return;
    }

    if (method === "session/request_permission") {
      if (!isJsonRpcId(message.id) || !isRecord(message.params)) {
        this.events.emit("protocolError", new Error("Invalid ACP permission request"));
        return;
      }

      this.permissionRequests.add(String(message.id));
      const event: PermissionRequestEvent = {
        requestId: message.id,
        params: message.params
      };
      this.events.emit("permissionRequest", event);
      return;
    }

    if (isJsonRpcId(message.id)) {
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported ACP client method: ${method}`
        }
      });
      return;
    }

    this.events.emit("protocolError", new Error(`Unsupported ACP notification: ${method}`));
  }

  private handleResponse(id: JsonRpcId, message: JsonObject): void {
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending) {
      this.events.emit("protocolError", new Error(`ACP response ${key} has no pending request`));
      return;
    }

    this.pending.delete(key);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    if (isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : undefined;
      const errorMessage = typeof message.error.message === "string"
        ? message.error.message
        : "Copilot returned an ACP error";
      pending.reject(new AcpError(errorMessage, code, message.error.data));
      return;
    }

    pending.resolve(message.result);
  }

  private async sendRequest<T>(
    method: string,
    params: JsonObject,
    timeoutMs = defaultRequestTimeoutMs
  ): Promise<T> {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error("Copilot ACP process is not running");
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(String(id));
          reject(new Error(`ACP request timed out: ${method}`));
        }, timeoutMs);
        timer.unref();
      }
      const pendingRequest: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject
      };
      if (timer) {
        pendingRequest.timer = timer;
      }
      this.pending.set(String(id), pendingRequest);

      try {
        this.writeMessage({
          jsonrpc: "2.0",
          id,
          method,
          params
        });
      } catch (error) {
        if (timer) {
          clearTimeout(timer);
        }
        this.pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(method: string, params: JsonObject): void {
    this.writeMessage({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  private writeMessage(message: JsonObject): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error("Copilot ACP process is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }

  private parseSessionInfo(value: unknown): SessionInfo | undefined {
    if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.cwd !== "string") {
      return undefined;
    }

    const session: SessionInfo = {
      sessionId: value.sessionId,
      cwd: value.cwd
    };
    if (typeof value.title === "string") {
      session.title = value.title;
    }
    if (typeof value.updatedAt === "string") {
      session.updatedAt = value.updatedAt;
    }
    return session;
  }
}

export class AcpConnectionManager {
  public readonly events = new EventEmitter();

  private readonly command: string;
  private readonly cwd: string;
  private readonly clientVersion: string;
  private readonly clientTitle: string;
  private readonly allowAll: boolean;
  private readonly connections = new Map<ContextTier, AcpConnection>();
  private readonly sessionContexts = new Map<string, ContextTier>();
  private readonly sessionConfigPreferences = new Map<string, Map<string, string | boolean>>();
  private readonly profileDefaults = new Map<ContextTier, SessionSetup>();

  public constructor(options: {
    command: string;
    cwd: string;
    clientVersion: string;
    clientTitle?: string;
    allowAll?: boolean;
  }) {
    this.command = options.command;
    this.cwd = options.cwd;
    this.clientVersion = options.clientVersion;
    this.clientTitle = options.clientTitle ?? "Copilot Web";
    this.allowAll = options.allowAll === true;
  }

  public async start(context: ContextTier = "default"): Promise<void> {
    await this.getConnection(context);
  }

  public getCapabilities(context: ContextTier = "default"): AgentCapabilities {
    const connection = this.connections.get(context);
    if (!connection) {
      throw new Error(`ACP ${context} connection has not been initialized`);
    }
    return connection.getCapabilities();
  }

  public getSessionContext(sessionId: string): ContextTier | undefined {
    return this.sessionContexts.get(sessionId);
  }

  public async listSessions(): Promise<SessionInfo[]> {
    const connection = await this.getConnection("default");
    return connection.listSessions();
  }

  public async discoverConfig(context: ContextTier, model?: string): Promise<SessionSetup> {
    const cached = this.profileDefaults.get(context);
    if (cached && model === undefined) {
      return cached;
    }

    const connection = await this.getConnection(context);
    const canCloseSession = connection.getCapabilities().sessionCapabilities.close;
    const reuseCachedSession = !canCloseSession && cached !== undefined;
    const setup = reuseCachedSession
      ? cached
      : await connection.newSession(this.cwd);
    if (!cached) {
      this.profileDefaults.set(context, setup);
    }
    const initialModel = setup.configOptions.find((option) => option.id === "model");
    let configOptions = setup.configOptions;
    let modelChanged = false;
    try {
      if (model !== undefined) {
        if (!initialModel) {
          throw new AcpError("Copilot does not expose the model session option");
        }
        if (!configOptionAcceptsValue(initialModel, model)) {
          throw new AcpError(`Copilot does not support model=${model}`);
        }
        if (initialModel.currentValue !== model) {
          if (!canCloseSession && typeof initialModel.currentValue !== "string") {
            throw new AcpError("Copilot cannot safely preview a model without its current value");
          }
          modelChanged = true;
          configOptions = await connection.setConfigOption(setup.sessionId, "model", model);
        }
      }
      return {
        ...setup,
        configOptions
      };
    } finally {
      if (canCloseSession && !reuseCachedSession) {
        await connection.closeSession(setup.sessionId);
      } else if (
        modelChanged &&
        typeof initialModel?.currentValue === "string"
      ) {
        await connection.setConfigOption(
          setup.sessionId,
          "model",
          initialModel.currentValue
        );
      }
    }
  }

  public async newSession(
    cwd: string,
    context: ContextTier,
    configOverrides?: Readonly<Record<string, string | boolean>>,
    fallbackConfigIds: ReadonlySet<string> = new Set()
  ): Promise<SessionSetup> {
    const connection = await this.getConnection(context);
    const setup = await connection.newSession(cwd);
    try {
      const configuredSetup = await this.applySessionConfig(
        connection,
        setup,
        configOverrides,
        fallbackConfigIds
      );
      this.rememberSessionConfig(configuredSetup.sessionId, configuredSetup.configOptions);
      this.sessionContexts.set(configuredSetup.sessionId, context);
      return configuredSetup;
    } catch (error) {
      if (connection.getCapabilities().sessionCapabilities.close) {
        await connection.closeSession(setup.sessionId);
      }
      throw error;
    }
  }

  public async loadSession(session: SessionInfo, context: ContextTier): Promise<SessionSetup> {
    const previousContext = this.sessionContexts.get(session.sessionId);
    if (previousContext && previousContext !== context) {
      const previousConnection = await this.getConnection(previousContext);
      await previousConnection.closeSession(session.sessionId);
    }

    const connection = await this.getConnection(context);
    const setup = await connection.loadSession(session);
    const configuredSetup = await this.applySessionConfig(connection, setup);
    const restoredSetup = await this.restoreConfigOptions(connection, configuredSetup);
    this.sessionContexts.set(restoredSetup.sessionId, context);
    return restoredSetup;
  }

  public async setConfigOption(
    session: SessionInfo,
    configId: string,
    value: string | boolean
  ): Promise<JsonObject[]> {
    const context = this.sessionContexts.get(session.sessionId) ?? "default";
    const connection = await this.getConnection(context);
    if (!this.sessionContexts.has(session.sessionId)) {
      await this.loadSession(session, context);
    }
    const configOptions = await connection.setConfigOption(session.sessionId, configId, value);
    const preferences = this.sessionConfigPreferences.get(session.sessionId) ?? new Map();
    preferences.set(configId, value);
    this.sessionConfigPreferences.set(session.sessionId, preferences);
    return configOptions;
  }

  public getConfigOptions(sessionId: string): JsonObject[] {
    const context = this.sessionContexts.get(sessionId);
    const connection = context ? this.connections.get(context) : undefined;
    return connection?.getConfigOptions(sessionId) ?? [];
  }

  public async prompt(
    session: SessionInfo,
    prompt: PromptContentBlock[]
  ): Promise<string | undefined> {
    const context = this.sessionContexts.get(session.sessionId) ?? "default";
    const connection = await this.getConnection(context);
    const result = await connection.prompt(session, prompt);
    this.sessionContexts.set(session.sessionId, context);
    return result;
  }

  public async cancel(sessionId: string): Promise<void> {
    const context = this.sessionContexts.get(sessionId) ?? "default";
    const connection = await this.getConnection(context);
    await connection.cancel(sessionId);
  }

  public async closeSession(sessionId: string): Promise<void> {
    const context = this.sessionContexts.get(sessionId) ?? "default";
    const connection = await this.getConnection(context);
    await connection.closeSession(sessionId);
  }

  public forgetSession(sessionId: string): void {
    this.sessionContexts.delete(sessionId);
    this.sessionConfigPreferences.delete(sessionId);
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const context = this.sessionContexts.get(sessionId) ?? "default";
    const connection = await this.getConnection(context);
    await connection.deleteSession(sessionId);
    this.sessionContexts.delete(sessionId);
    this.sessionConfigPreferences.delete(sessionId);
  }

  public async respondToPermission(
    context: ContextTier,
    requestId: JsonRpcId,
    outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" }
  ): Promise<void> {
    const connection = await this.getConnection(context);
    await connection.respondToPermission(requestId, outcome);
  }

  public async stop(): Promise<void> {
    await Promise.all([...this.connections.values()].map((connection) => connection.stop()));
    this.connections.clear();
    this.sessionContexts.clear();
    this.sessionConfigPreferences.clear();
    this.profileDefaults.clear();
  }

  private async getConnection(context: ContextTier): Promise<AcpConnection> {
    const existing = this.connections.get(context);
    if (existing) {
      await existing.start();
      return existing;
    }

    const connection = new AcpConnection({
      command: this.command,
      cwd: this.cwd,
      clientVersion: this.clientVersion,
      clientTitle: this.clientTitle,
      allowAll: this.allowAll,
      context
    });
    this.forwardEvents(context, connection);
    this.connections.set(context, connection);
    try {
      await connection.start();
      return connection;
    } catch (error) {
      this.connections.delete(context);
      throw error;
    }
  }

  private forwardEvents(context: ContextTier, connection: AcpConnection): void {
    connection.events.on("sessionUpdate", (params: unknown) => {
      if (isRecord(params)) {
        const event: ManagedSessionUpdateEvent = { context, params };
        this.events.emit("sessionUpdate", event);
      }
    });
    connection.events.on("permissionRequest", (event: PermissionRequestEvent) => {
      const managedEvent: ManagedPermissionRequestEvent = { ...event, context };
      this.events.emit("permissionRequest", managedEvent);
    });
    connection.events.on("processError", (error: Error) => {
      this.events.emit("processError", error);
    });
    connection.events.on("protocolError", (error: Error) => {
      this.events.emit("protocolError", error);
    });
    connection.events.on("stderr", (chunk: string) => {
      this.events.emit("stderr", chunk);
    });
    connection.events.on("sessionEvent", (params: unknown) => {
      if (isRecord(params)) {
        const event: ManagedSessionUpdateEvent = { context, params };
        this.events.emit("sessionEvent", event);
      }
    });
  }

  private async applySessionConfig(
    connection: AcpConnection,
    setup: SessionSetup,
    configOverrides?: Readonly<Record<string, string | boolean>>,
    fallbackConfigIds: ReadonlySet<string> = new Set()
  ): Promise<SessionSetup> {
    let configOptions = setup.configOptions;
    const requestedValues = configOverrides
      ? Object.entries(configOverrides)
      : ["model", "reasoning_effort"]
        .map((configId) => {
          const option = configOptions.find((candidate) => candidate.id === configId);
          return option &&
            (typeof option.currentValue === "string" || typeof option.currentValue === "boolean")
            ? [configId, option.currentValue] as const
            : undefined;
        })
        .filter((entry): entry is readonly [string, string | boolean] => entry !== undefined);

    requestedValues.sort(([leftId], [rightId]) => (
      leftId === "model" ? -1 : rightId === "model" ? 1 : 0
    ));
    for (const [configId, value] of requestedValues) {
      const option = configOptions.find((candidate) => candidate.id === configId);
      if (!option) {
        if (fallbackConfigIds.has(configId)) {
          continue;
        }
        if (configOverrides) {
          throw new AcpError(`Copilot does not expose the ${configId} session option`);
        }
        continue;
      }
      if (!configOptionAcceptsValue(option, value)) {
        if (fallbackConfigIds.has(configId)) {
          continue;
        }
        throw new AcpError(`Copilot does not support ${configId}=${String(value)}`);
      }
      if (option.currentValue === value) {
        continue;
      }
      configOptions = await connection.setConfigOption(
        setup.sessionId,
        configId,
        value
      );
    }
    return {
      ...setup,
      configOptions
    };
  }

  private rememberSessionConfig(sessionId: string, configOptions: JsonObject[]): void {
    const preferences = new Map<string, string | boolean>();
    for (const configId of ["model", "reasoning_effort"]) {
      const option = configOptions.find((candidate) => candidate.id === configId);
      if (
        option &&
        (typeof option.currentValue === "string" || typeof option.currentValue === "boolean")
      ) {
        preferences.set(configId, option.currentValue);
      }
    }
    if (preferences.size > 0) {
      this.sessionConfigPreferences.set(sessionId, preferences);
    }
  }

  private async restoreConfigOptions(
    connection: AcpConnection,
    setup: SessionSetup
  ): Promise<SessionSetup> {
    const preferences = this.sessionConfigPreferences.get(setup.sessionId);
    if (!preferences || preferences.size === 0) {
      return setup;
    }

    let configOptions = setup.configOptions;
    const entries = [...preferences.entries()].sort(([leftId], [rightId]) => (
      leftId === "model" ? -1 : rightId === "model" ? 1 : 0
    ));
    for (const [configId, value] of entries) {
      const option = configOptions.find((candidate) => candidate.id === configId);
      if (!option || !configOptionAcceptsValue(option, value)) {
        continue;
      }
      configOptions = await connection.setConfigOption(setup.sessionId, configId, value);
    }
    return {
      ...setup,
      configOptions
    };
  }
}

function configOptionAcceptsValue(option: JsonObject, value: string | boolean): boolean {
  if (option.type === "boolean") {
    return typeof value === "boolean";
  }
  if (!Array.isArray(option.options)) {
    return false;
  }
  return option.options.some((candidate) => {
    if (!isRecord(candidate)) {
      return false;
    }
    if (candidate.value === value) {
      return true;
    }
    return Array.isArray(candidate.options) &&
      candidate.options.some((nested) => isRecord(nested) && nested.value === value);
  });
}
