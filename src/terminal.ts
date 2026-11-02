import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const terminalProtocol = "copilot-web-terminal.v1";
export const defaultTerminalMaximum = 8;
export const maximumTerminalMaximum = 32;
export const maximumTerminalInputBytes = 64 * 1024;

const defaultColumns = 120;
const defaultRows = 30;
const minimumColumns = 2;
const maximumColumns = 500;
const minimumRows = 1;
const maximumRows = 200;
const mirrorScrollbackLines = 5_000;
const outputBatchMs = 8;
const outputBatchCharacters = 64 * 1024;
const pauseAboveBytes = 1024 * 1024;
const resumeBelowBytes = 256 * 1024;
const slowClientBytes = 8 * 1024 * 1024;
const slowClientMs = 10_000;
const flowCheckMs = 50;
const hangupGraceMs = 3_000;
const shutdownGraceMs = 2_000;
const exitedRetentionMs = 10 * 60_000;
const maximumTitleLength = 80;
const removedEnvironmentPrefixes = ["COPILOT_WEB_", "npm_"];
const removedEnvironmentNames = new Set([
  "COPILOT_ALLOW_ALL",
  "COPILOT_NATIVE_SESSION_DELETE",
  "PORT",
  "INIT_CWD",
  "NODE_OPTIONS"
]);

export type TerminalState = "running" | "exited";

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  pid: number | null;
  state: TerminalState;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
  createdAt: string;
  attachedClients: number;
}

export type TerminalEvent =
  | { type: "created"; terminal: TerminalInfo }
  | { type: "updated"; terminal: TerminalInfo }
  | { type: "removed"; id: string };

// A browser WebSocket as seen by the terminal. Keeps the manager independent of the ws package.
export interface TerminalClient {
  readonly bufferedAmount: number;
  send(message: string): void;
  close(code: number, reason: string): void;
}

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export type PtySpawn = (file: string, args: string[], options: {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}) => PtyProcess;

// Headless xterm mirror: keeps the screen so a reloaded page can restore it exactly.
export interface TerminalMirror {
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  serialize(): string;
  onTitleChange(listener: (title: string) => void): void;
  dispose(): void;
}

export type MirrorFactory = (options: { cols: number; rows: number; scrollback: number }) => TerminalMirror;

export class TerminalError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, message: string, code: string) {
    super(message);
    this.name = "TerminalError";
    this.status = status;
    this.code = code;
  }
}

interface Attachment {
  client: TerminalClient;
  // Messages wait here until the snapshot has been sent, so the snapshot and live output never overlap or gap.
  ready: boolean;
  backlog: string[];
  clientPaused: boolean;
  slowSince: number | null;
}

interface TerminalHost {
  readonly spawn: PtySpawn;
  readonly environment: Record<string, string>;
  changed(terminal: Terminal): void;
  retire(terminal: Terminal): void;
  log(message: string): void;
}

interface TerminalInit {
  id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  mirror: TerminalMirror;
  createdAt: string;
}

function deliver(attachment: Attachment, message: string): void {
  if (attachment.ready) {
    attachment.client.send(message);
  } else {
    attachment.backlog.push(message);
  }
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class Terminal {
  public readonly id: string;
  public readonly cwd: string;
  public readonly shell: string;
  public readonly createdAt: string;
  private title: string;
  private state: TerminalState = "running";
  private pid: number | null = null;
  private exitCode: number | null = null;
  private signal: number | null = null;
  private cols: number;
  private rows: number;
  private pty: PtyProcess | null = null;
  private ptyListeners: Array<{ dispose(): void }> = [];
  private readonly mirror: TerminalMirror;
  private readonly attachments = new Map<TerminalClient, Attachment>();
  private readonly exitWaiters: Array<() => void> = [];
  private batch = "";
  private batchTimer: NodeJS.Timeout | null = null;
  private flowTimer: NodeJS.Timeout | null = null;
  private flowPaused = false;
  private retentionTimer: NodeJS.Timeout | null = null;
  private hangupTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private disposed = false;

  public constructor(private readonly host: TerminalHost, init: TerminalInit) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.shell = init.shell;
    this.cols = init.cols;
    this.rows = init.rows;
    this.mirror = init.mirror;
    this.createdAt = init.createdAt;
    this.title = path.basename(init.cwd) || init.cwd;
    this.mirror.onTitleChange((title) => this.setTitle(title));
  }

  public info(): TerminalInfo {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      shell: this.shell,
      pid: this.pid,
      state: this.state,
      exitCode: this.exitCode,
      signal: this.signal,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      attachedClients: this.attachments.size
    };
  }

  public isExited(): boolean {
    return this.state === "exited";
  }

  public start(): void {
    const pty = this.host.spawn(this.shell, ["-l"], {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: this.host.environment
    });
    this.pty = pty;
    this.pid = pty.pid;
    this.state = "running";
    this.exitCode = null;
    this.signal = null;
    this.ptyListeners = [
      pty.onData((data) => this.handleOutput(data)),
      pty.onExit((event) => this.handleExit(pty, event))
    ];
    this.clearRetention();
    this.host.log(`[terminal] started ${this.id} (pid ${pty.pid})`);
  }

  public restart(): void {
    this.start();
    this.host.changed(this);
  }

  public attach(client: TerminalClient): void {
    // Output that arrived before this client attached belongs to the existing clients and to the snapshot.
    this.flushBatch();
    const attachment: Attachment = { client, ready: false, backlog: [], clientPaused: false, slowSince: null };
    this.attachments.set(client, attachment);
    this.clearRetention();
    this.mirror.write("", () => {
      if (this.attachments.get(client) !== attachment) {
        return;
      }
      client.send(JSON.stringify({
        t: "snapshot",
        data: this.mirror.serialize(),
        cols: this.cols,
        rows: this.rows,
        state: this.state,
        exitCode: this.exitCode,
        signal: this.signal,
        title: this.title
      }));
      attachment.ready = true;
      for (const message of attachment.backlog.splice(0)) {
        client.send(message);
      }
    });
  }

  public detach(client: TerminalClient): void {
    if (!this.attachments.delete(client)) {
      return;
    }
    this.enforceFlowControl();
    if (this.attachments.size === 0 && this.isExited()) {
      this.scheduleRetention();
    }
  }

  public input(data: string): void {
    if (this.pty && this.state === "running") {
      this.pty.write(data);
    }
  }

  public resize(cols: number, rows: number, from?: TerminalClient): void {
    if (cols === this.cols && rows === this.rows) {
      return;
    }
    this.cols = cols;
    this.rows = rows;
    if (this.pty && this.state === "running") {
      try {
        this.pty.resize(cols, rows);
      } catch {
        // The process exited between the check and the resize.
      }
    }
    this.mirror.resize(cols, rows);
    const message = JSON.stringify({ t: "resized", cols, rows });
    for (const [client, attachment] of this.attachments) {
      if (client !== from) {
        deliver(attachment, message);
      }
    }
    this.host.changed(this);
  }

  public setClientPaused(client: TerminalClient, paused: boolean): void {
    const attachment = this.attachments.get(client);
    if (attachment) {
      attachment.clientPaused = paused;
      this.enforceFlowControl();
    }
  }

  public waitForExit(): Promise<void> {
    if (this.isExited()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  // Ends the terminal: clients get the close code, the shell gets SIGHUP, and survivors are killed after a grace period.
  public stop(closeCode: number, closeReason: string): void {
    this.stopping = true;
    for (const [client] of this.attachments) {
      client.close(closeCode, closeReason);
    }
    this.attachments.clear();
    if (!this.pty) {
      this.dispose();
      return;
    }
    this.pty.kill("SIGHUP");
    this.hangupTimer = setTimeout(() => this.forceKill(), hangupGraceMs);
    this.hangupTimer.unref();
  }

  public forceKill(): void {
    if (!this.pty || this.pid === null) {
      return;
    }
    try {
      process.kill(-this.pid, "SIGKILL");
    } catch {
      // The process group is already gone.
    }
    try {
      this.pty.kill("SIGKILL");
    } catch {
      // The process is already gone.
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimers();
    for (const listener of this.ptyListeners.splice(0)) {
      listener.dispose();
    }
    this.attachments.clear();
    this.mirror.dispose();
  }

  private setTitle(title: string): void {
    const next = title.trim().slice(0, maximumTitleLength);
    if (!next || next === this.title || this.disposed) {
      return;
    }
    this.title = next;
    const message = JSON.stringify({ t: "title", title: next });
    for (const attachment of this.attachments.values()) {
      deliver(attachment, message);
    }
    this.host.changed(this);
  }

  private handleOutput(data: string): void {
    if (this.disposed) {
      return;
    }
    this.mirror.write(data);
    this.batch += data;
    if (this.batch.length >= outputBatchCharacters) {
      this.flushBatch();
    } else if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flushBatch(), outputBatchMs);
    }
  }

  private flushBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (!this.batch) {
      return;
    }
    const data = this.batch;
    this.batch = "";
    if (this.attachments.size === 0) {
      return;
    }
    const message = JSON.stringify({ t: "out", d: data });
    for (const attachment of this.attachments.values()) {
      deliver(attachment, message);
    }
    this.enforceFlowControl();
  }

  private handleExit(pty: PtyProcess, event: { exitCode: number; signal?: number | undefined }): void {
    if (pty !== this.pty) {
      return;
    }
    this.flushBatch();
    this.pty = null;
    this.pid = null;
    this.state = "exited";
    this.exitCode = event.exitCode;
    this.signal = event.signal ?? null;
    this.releaseFlowControl();
    if (this.hangupTimer) {
      clearTimeout(this.hangupTimer);
      this.hangupTimer = null;
    }
    for (const listener of this.ptyListeners.splice(0)) {
      listener.dispose();
    }
    this.host.log(`[terminal] exited ${this.id} with code ${event.exitCode}`);
    for (const waiter of this.exitWaiters.splice(0)) {
      waiter();
    }
    if (this.disposed) {
      return;
    }
    const message = JSON.stringify({ t: "exit", code: this.exitCode, signal: this.signal });
    for (const attachment of this.attachments.values()) {
      deliver(attachment, message);
    }
    if (this.stopping) {
      this.dispose();
      return;
    }
    this.host.changed(this);
    if (this.attachments.size === 0) {
      this.scheduleRetention();
    }
  }

  private enforceFlowControl(): void {
    const now = Date.now();
    for (const [client, attachment] of this.attachments) {
      if (client.bufferedAmount > slowClientBytes) {
        attachment.slowSince ??= now;
        if (now - attachment.slowSince >= slowClientMs) {
          this.attachments.delete(client);
          client.close(4008, "client too slow");
        }
      } else {
        attachment.slowSince = null;
      }
    }

    const attachments = [...this.attachments.values()];
    const overloaded = attachments.some((attachment) =>
      attachment.clientPaused || attachment.client.bufferedAmount > pauseAboveBytes
    );
    const drained = attachments.every((attachment) =>
      !attachment.clientPaused && attachment.client.bufferedAmount <= resumeBelowBytes
    );
    if (this.pty && this.state === "running") {
      if (!this.flowPaused && overloaded) {
        this.flowPaused = true;
        this.pty.pause();
        this.flowTimer ??= setInterval(() => this.enforceFlowControl(), flowCheckMs);
        this.flowTimer.unref();
      } else if (this.flowPaused && drained) {
        this.releaseFlowControl();
      }
    }
  }

  private releaseFlowControl(): void {
    if (this.flowTimer) {
      clearInterval(this.flowTimer);
      this.flowTimer = null;
    }
    if (this.flowPaused) {
      this.flowPaused = false;
      this.pty?.resume();
    }
  }

  private scheduleRetention(): void {
    this.clearRetention();
    this.retentionTimer = setTimeout(() => this.host.retire(this), exitedRetentionMs);
    this.retentionTimer.unref();
  }

  private clearRetention(): void {
    if (this.retentionTimer) {
      clearTimeout(this.retentionTimer);
      this.retentionTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearRetention();
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.hangupTimer) {
      clearTimeout(this.hangupTimer);
      this.hangupTimer = null;
    }
    this.releaseFlowControl();
    this.batch = "";
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();
  private readonly host: TerminalHost;

  public constructor(private readonly options: {
    spawn: PtySpawn;
    createMirror: MirrorFactory;
    environment: NodeJS.ProcessEnv;
    version: string;
    maximum: number;
    shell?: string | undefined;
    onEvent?: ((event: TerminalEvent) => void) | undefined;
    log?: ((message: string) => void) | undefined;
  }) {
    this.host = {
      spawn: options.spawn,
      environment: terminalEnvironment(options.environment, options.version),
      changed: (terminal) => this.options.onEvent?.({ type: "updated", terminal: terminal.info() }),
      retire: (terminal) => this.retire(terminal.id),
      log: (message) => this.options.log?.(message)
    };
  }

  public get maximumTerminals(): number {
    return this.options.maximum;
  }

  public list(): TerminalInfo[] {
    return [...this.terminals.values()].map((terminal) => terminal.info());
  }

  public find(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }

  public async create(input: { cwd: unknown; cols?: unknown; rows?: unknown }): Promise<TerminalInfo> {
    const cwd = await resolveTerminalDirectory(input.cwd);
    const shell = this.options.shell ?? await resolveShell(this.options.environment);
    const size = normalizeTerminalSize(input.cols, input.rows);
    if (this.terminals.size >= this.options.maximum) {
      throw new TerminalError(409, "Too many terminals are open. Close one before opening another.", "terminal_limit");
    }
    const terminal = new Terminal(this.host, {
      id: randomUUID(),
      cwd,
      shell,
      cols: size.cols,
      rows: size.rows,
      mirror: this.options.createMirror({ cols: size.cols, rows: size.rows, scrollback: mirrorScrollbackLines }),
      createdAt: new Date().toISOString()
    });
    this.terminals.set(terminal.id, terminal);
    try {
      terminal.start();
    } catch {
      this.terminals.delete(terminal.id);
      terminal.dispose();
      throw new TerminalError(500, "The shell could not be started.", "terminal_spawn_failed");
    }
    const info = terminal.info();
    this.options.onEvent?.({ type: "created", terminal: info });
    return info;
  }

  public restart(id: string): TerminalInfo {
    const terminal = this.require(id);
    if (!terminal.isExited()) {
      throw new TerminalError(409, "The terminal is still running.", "terminal_running");
    }
    try {
      terminal.restart();
    } catch {
      throw new TerminalError(500, "The shell could not be started.", "terminal_spawn_failed");
    }
    return terminal.info();
  }

  public remove(id: string): void {
    const terminal = this.require(id);
    this.terminals.delete(id);
    terminal.stop(1000, "Terminal closed");
    this.options.onEvent?.({ type: "removed", id });
  }

  // Server shutdown: SIGHUP every shell, then SIGKILL whatever is still running after a short grace period.
  public async disposeAll(): Promise<void> {
    const all = [...this.terminals.values()];
    this.terminals.clear();
    for (const terminal of all) {
      terminal.stop(1001, "Terminal ended because the server stopped");
    }
    await Promise.race([
      Promise.all(all.map((terminal) => terminal.waitForExit())),
      waitFor(shutdownGraceMs)
    ]);
    for (const terminal of all) {
      terminal.forceKill();
      terminal.dispose();
    }
  }

  private retire(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal || !terminal.isExited()) {
      return;
    }
    this.terminals.delete(id);
    terminal.dispose();
    this.options.onEvent?.({ type: "removed", id });
  }

  private require(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      throw new TerminalError(404, "Terminal not found", "terminal_not_found");
    }
    return terminal;
  }
}

export function terminalEnvironment(source: NodeJS.ProcessEnv, version: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || removedEnvironmentNames.has(name)) {
      continue;
    }
    if (removedEnvironmentPrefixes.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    environment[name] = value;
  }
  environment.TERM = "xterm-256color";
  environment.COLORTERM = "truecolor";
  environment.TERM_PROGRAM = "copilot-web";
  environment.TERM_PROGRAM_VERSION = version;
  if (!environment.LANG && !environment.LC_ALL) {
    environment.LANG = "en_US.UTF-8";
  }
  return environment;
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function resolveShell(environment: NodeJS.ProcessEnv): Promise<string> {
  for (const candidate of [environment.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (candidate && path.isAbsolute(candidate) && await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  throw new TerminalError(500, "No usable login shell was found.", "terminal_shell_missing");
}

// The shell can change directory anywhere, so this only checks that the start directory exists.
export async function resolveTerminalDirectory(value: unknown, homeDirectory = os.homedir()): Promise<string> {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0")) {
    throw new TerminalError(400, "An absolute directory is required", "invalid_cwd");
  }
  const expanded = value === "~" || value.startsWith("~/") ? path.join(homeDirectory, value.slice(1)) : value;
  if (!path.isAbsolute(expanded)) {
    throw new TerminalError(400, "An absolute directory is required", "invalid_cwd");
  }
  const resolved = await realpath(expanded).catch(() => undefined);
  const directory = resolved ? await stat(resolved).catch(() => undefined) : undefined;
  if (!resolved || !directory?.isDirectory()) {
    throw new TerminalError(400, "The terminal directory does not exist", "invalid_cwd");
  }
  return resolved;
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TerminalError(400, "Terminal size must be whole numbers", "invalid_size");
  }
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeTerminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  return {
    cols: clampInteger(cols, minimumColumns, maximumColumns, defaultColumns),
    rows: clampInteger(rows, minimumRows, maximumRows, defaultRows)
  };
}

export function readTerminalMaximum(environment: NodeJS.ProcessEnv): number {
  const raw = environment.COPILOT_WEB_TERMINAL_MAX?.trim();
  if (!raw) {
    return defaultTerminalMaximum;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximumTerminalMaximum) {
    throw new Error(`COPILOT_WEB_TERMINAL_MAX must be an integer between 1 and ${maximumTerminalMaximum}`);
  }
  return value;
}
