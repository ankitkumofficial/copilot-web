import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTerminalRuntime } from "./terminal-runtime.js";
import {
  normalizeTerminalSize,
  readTerminalMaximum,
  resolveTerminalDirectory,
  TerminalError,
  TerminalManager,
  terminalEnvironment,
  type MirrorFactory,
  type PtyProcess,
  type TerminalEvent,
  type TerminalMirror
} from "./terminal.js";

class FakePty implements PtyProcess {
  public readonly written: string[] = [];
  public readonly signals: string[] = [];
  public readonly resizes: Array<[number, number]> = [];
  public paused = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number | undefined }) => void>();

  public constructor(public readonly pid: number) {}

  public onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => void this.dataListeners.delete(listener) };
  }

  public onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => void this.exitListeners.delete(listener) };
  }

  public write(data: string): void {
    this.written.push(data);
  }

  public resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  public kill(signal = "SIGHUP"): void {
    this.signals.push(signal);
  }

  public pause(): void {
    this.paused = true;
  }

  public resume(): void {
    this.paused = false;
  }

  public emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  public emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode });
    }
  }
}

// Like the headless terminal, writes are queued and applied in order on a later tick; the callback runs after
// everything queued before it has been applied.
function fakeMirror(): TerminalMirror {
  let applied = "";
  let scheduled = false;
  const queue: Array<{ data: string; callback: (() => void) | undefined }> = [];
  const drain = () => {
    scheduled = false;
    for (const item of queue.splice(0)) {
      applied += item.data;
      item.callback?.();
    }
  };
  return {
    write(data: string, callback?: () => void) {
      queue.push({ data, callback });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(drain);
      }
    },
    resize() {},
    serialize() {
      return applied;
    },
    onTitleChange() {},
    dispose() {}
  };
}

interface FakeClient {
  bufferedAmount: number;
  messages: Array<Record<string, unknown>>;
  closes: Array<{ code: number; reason: string }>;
  send(message: string): void;
  close(code: number, reason: string): void;
}

function fakeClient(): FakeClient {
  return {
    bufferedAmount: 0,
    messages: [],
    closes: [],
    send(message) {
      this.messages.push(JSON.parse(message) as Record<string, unknown>);
    },
    close(code, reason) {
      this.closes.push({ code, reason });
    }
  };
}

function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error("Condition was not met in time"));
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createFakeManager(overrides: { maximum?: number; events?: TerminalEvent[] } = {}) {
  const spawned: FakePty[] = [];
  const events = overrides.events ?? [];
  const createMirror: MirrorFactory = () => fakeMirror();
  const manager = new TerminalManager({
    spawn: (_file, _args, _options) => {
      const pty = new FakePty(10_000 + spawned.length);
      spawned.push(pty);
      return pty;
    },
    createMirror,
    environment: { PATH: "/usr/bin:/bin", HOME: os.homedir(), SHELL: "/bin/sh", LC_ALL: "C.UTF-8" },
    version: "0.1.0-test",
    maximum: overrides.maximum ?? 8,
    shell: "/bin/sh",
    onEvent: (event) => events.push(event)
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "copilot-web-terminal-test-"));
  const cwd = await realpath(directory);
  return {
    manager,
    spawned,
    events,
    cwd,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

test("terminal environment drops server settings and sets terminal variables", () => {
  const environment = terminalEnvironment({
    PATH: "/usr/bin",
    HOME: "/Users/me",
    COPILOT_WEB_TERMINAL: "true",
    COPILOT_WEB_TERMINAL_MAX: "4",
    COPILOT_ALLOW_ALL: "true",
    PORT: "8765",
    npm_config_cache: "/tmp/npm",
    INIT_CWD: "/tmp",
    NODE_OPTIONS: "--inspect"
  }, "0.1.0");

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.HOME, "/Users/me");
  assert.equal(environment.TERM, "xterm-256color");
  assert.equal(environment.COLORTERM, "truecolor");
  assert.equal(environment.TERM_PROGRAM, "copilot-web");
  assert.equal(environment.TERM_PROGRAM_VERSION, "0.1.0");
  assert.equal(environment.LANG, "en_US.UTF-8");
  for (const name of ["COPILOT_WEB_TERMINAL", "COPILOT_WEB_TERMINAL_MAX", "COPILOT_ALLOW_ALL", "PORT", "npm_config_cache", "INIT_CWD", "NODE_OPTIONS"]) {
    assert.equal(name in environment, false, `${name} must not reach the shell`);
  }
});

test("terminal environment keeps an existing locale", () => {
  assert.equal(terminalEnvironment({ LC_ALL: "de_DE.UTF-8" }, "0.1.0").LANG, undefined);
});

test("terminal sizes are clamped and must be whole numbers", () => {
  assert.deepEqual(normalizeTerminalSize(undefined, undefined), { cols: 120, rows: 30 });
  assert.deepEqual(normalizeTerminalSize(1, 900), { cols: 2, rows: 200 });
  assert.throws(() => normalizeTerminalSize(80.5, 24), (error: unknown) =>
    error instanceof TerminalError && error.code === "invalid_size");
});

test("terminal maximum reads the optional override and rejects out-of-range values", () => {
  assert.equal(readTerminalMaximum({}), 8);
  assert.equal(readTerminalMaximum({ COPILOT_WEB_TERMINAL_MAX: "3" }), 3);
  assert.throws(() => readTerminalMaximum({ COPILOT_WEB_TERMINAL_MAX: "33" }), /between 1 and 32/);
});

test("terminal directory must be an existing absolute directory", async () => {
  const { cwd, cleanup } = await createFakeManager();
  try {
    assert.equal(await resolveTerminalDirectory(cwd), cwd);
    await assert.rejects(resolveTerminalDirectory("relative/path"), { code: "invalid_cwd" });
    await assert.rejects(resolveTerminalDirectory(path.join(cwd, "missing")), { code: "invalid_cwd" });
    await assert.rejects(resolveTerminalDirectory(path.join(cwd, "..", "\0bad")), { code: "invalid_cwd" });
  } finally {
    await cleanup();
  }
});

test("terminal limit returns a conflict once the maximum is open", async () => {
  const { manager, cwd, cleanup } = await createFakeManager({ maximum: 1 });
  try {
    await manager.create({ cwd });
    await assert.rejects(manager.create({ cwd }), { status: 409, code: "terminal_limit" });
  } finally {
    await cleanup();
  }
});

test("terminal snapshot is sent before live output and output before attach is not repeated", async () => {
  const { manager, spawned, cwd, cleanup } = await createFakeManager();
  try {
    const info = await manager.create({ cwd });
    const terminal = manager.find(info.id);
    assert.ok(terminal);
    const pty = spawned[0];
    assert.ok(pty);
    pty.emitData("before\r\n");

    const client = fakeClient();
    terminal.attach(client);
    pty.emitData("after\r\n");

    await waitUntil(() => client.messages.some((message) => message.t === "out"));
    assert.equal(client.messages[0]?.t, "snapshot");
    assert.equal(client.messages[0]?.data, "before\r\n");
    const live = client.messages.filter((message) => message.t === "out").map((message) => message.d).join("");
    assert.equal(live, "after\r\n");
    manager.remove(info.id);
  } finally {
    await cleanup();
  }
});

test("terminal exit is delivered, and restart spawns a new shell with the same id", async () => {
  const { manager, spawned, events, cwd, cleanup } = await createFakeManager();
  try {
    const info = await manager.create({ cwd });
    const terminal = manager.find(info.id);
    assert.ok(terminal);
    const client = fakeClient();
    terminal.attach(client);
    await waitUntil(() => client.messages.some((message) => message.t === "snapshot"));

    spawned[0]?.emitExit(3);
    await waitUntil(() => client.messages.some((message) => message.t === "exit"));
    assert.equal(client.messages.find((message) => message.t === "exit")?.code, 3);
    assert.equal(manager.list()[0]?.state, "exited");
    assert.equal(manager.list()[0]?.exitCode, 3);

    const restarted = manager.restart(info.id);
    assert.equal(restarted.id, info.id);
    assert.equal(restarted.state, "running");
    assert.equal(spawned.length, 2);
    assert.ok(events.some((event) => event.type === "updated" && event.terminal.state === "exited"));
    manager.remove(info.id);
  } finally {
    await cleanup();
  }
});

test("restart is refused while the shell is running", async () => {
  const { manager, cwd, cleanup } = await createFakeManager();
  try {
    const info = await manager.create({ cwd });
    assert.throws(() => manager.restart(info.id), { code: "terminal_running" });
    manager.remove(info.id);
  } finally {
    await cleanup();
  }
});

test("removing a terminal hangs up the shell and closes its clients", async () => {
  const { manager, spawned, events, cwd, cleanup } = await createFakeManager();
  try {
    const info = await manager.create({ cwd });
    const client = fakeClient();
    manager.find(info.id)?.attach(client);
    manager.remove(info.id);

    assert.deepEqual(spawned[0]?.signals, ["SIGHUP"]);
    assert.deepEqual(client.closes, [{ code: 1000, reason: "Terminal closed" }]);
    assert.equal(manager.list().length, 0);
    assert.ok(events.some((event) => event.type === "removed" && event.id === info.id));
  } finally {
    await cleanup();
  }
});

test("output pauses the shell while a client is far behind and resumes when it catches up", async () => {
  const { manager, spawned, cwd, cleanup } = await createFakeManager();
  try {
    const info = await manager.create({ cwd });
    const client = fakeClient();
    manager.find(info.id)?.attach(client);
    await waitUntil(() => client.messages.some((message) => message.t === "snapshot"));
    const pty = spawned[0];
    assert.ok(pty);

    client.bufferedAmount = 2 * 1024 * 1024;
    pty.emitData("flood\r\n");
    await delay(10);
    assert.equal(pty.paused, true);

    client.bufferedAmount = 0;
    await waitUntil(() => pty.paused === false);
    manager.remove(info.id);
  } finally {
    await cleanup();
  }
});

test("a client pause message holds the shell until the client resumes", async () => {
  const { manager, spawned, cwd, cleanup } = await createFakeManager();
  try {
    const info = await manager.create({ cwd });
    const terminal = manager.find(info.id);
    const client = fakeClient();
    terminal?.attach(client);
    await waitUntil(() => client.messages.some((message) => message.t === "snapshot"));
    terminal?.setClientPaused(client, true);
    assert.equal(spawned[0]?.paused, true);
    terminal?.setClientPaused(client, false);
    assert.equal(spawned[0]?.paused, false);
    manager.remove(info.id);
  } finally {
    await cleanup();
  }
});

test("resize is forwarded to the shell and announced to other clients only", async () => {
  const { manager, spawned, cwd, cleanup } = await createFakeManager();
  try {
    const info = await manager.create({ cwd });
    const terminal = manager.find(info.id);
    const sender = fakeClient();
    const observer = fakeClient();
    terminal?.attach(sender);
    terminal?.attach(observer);
    await waitUntil(() => observer.messages.some((message) => message.t === "snapshot"));

    terminal?.resize(100, 40, sender);
    assert.deepEqual(spawned[0]?.resizes, [[100, 40]]);
    assert.equal(sender.messages.some((message) => message.t === "resized"), false);
    assert.deepEqual(observer.messages.at(-1), { t: "resized", cols: 100, rows: 40 });
    manager.remove(info.id);
  } finally {
    await cleanup();
  }
});

test("disposeAll sends SIGHUP to every shell and escalates to SIGKILL for survivors", async () => {
  const { manager, spawned, cwd, cleanup } = await createFakeManager();
  try {
    const info = await manager.create({ cwd });
    const client = fakeClient();
    manager.find(info.id)?.attach(client);
    await manager.disposeAll();

    assert.equal(manager.list().length, 0);
    assert.deepEqual(client.closes, [{ code: 1001, reason: "Terminal ended because the server stopped" }]);
    assert.equal(spawned[0]?.signals[0], "SIGHUP");
    assert.equal(spawned[0]?.signals.includes("SIGKILL"), true);
  } finally {
    await cleanup();
  }
});

test("node-pty runs a real shell, returns output, and reports the exit code", async (t) => {
  let runtime: Awaited<ReturnType<typeof loadTerminalRuntime>>;
  try {
    runtime = await loadTerminalRuntime(() => undefined);
  } catch (error) {
    t.skip(`node-pty is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "copilot-web-pty-test-"));
  const manager = new TerminalManager({
    spawn: runtime.spawn,
    createMirror: runtime.createMirror,
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir() },
    version: "0.1.0-test",
    maximum: 2,
    shell: "/bin/sh"
  });
  try {
    const info = await manager.create({ cwd: directory });
    const terminal = manager.find(info.id);
    assert.ok(terminal);
    const client = fakeClient();
    terminal.attach(client);
    await waitUntil(() => client.messages.some((message) => message.t === "snapshot"));
    terminal.input("printf 'A%sB\\n' 42; exit 7\r");
    await waitUntil(() => client.messages.some((message) => message.t === "exit"), 5_000);

    const output = client.messages
      .filter((message) => message.t === "out")
      .map((message) => String(message.d))
      .join("");
    assert.match(output, /A42B/);
    assert.equal(client.messages.find((message) => message.t === "exit")?.code, 7);
    manager.remove(info.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal mirror serialization restores the screen in a fresh terminal", async (t) => {
  let runtime: Awaited<ReturnType<typeof loadTerminalRuntime>>;
  try {
    runtime = await loadTerminalRuntime(() => undefined);
  } catch (error) {
    t.skip(`node-pty is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const options = { cols: 20, rows: 5, scrollback: 100 };
  const source = runtime.createMirror(options);
  await new Promise<void>((resolve) => source.write("hello \x1b[31mred\x1b[0m\r\nline2", resolve));
  const restored = runtime.createMirror(options);
  await new Promise<void>((resolve) => restored.write(source.serialize(), resolve));
  assert.equal(restored.serialize(), source.serialize());
  source.dispose();
  restored.dispose();
});
