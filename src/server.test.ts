import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import { isRecord, type JsonObject } from "./acp.js";

const fakeCopilot = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const startCountFile = path.join(process.cwd(), "copilot-start-count.txt");
const requestLogFile = path.join(process.cwd(), "copilot-requests.log");
let startCount = 1;
try {
  startCount = Number(fs.readFileSync(startCountFile, "utf8")) + 1;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
fs.writeFileSync(startCountFile, String(startCount));

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(requestLogFile, JSON.stringify({
    method: request.method,
    text: request.params?.prompt?.[0]?.text,
    ...(request.params?.prompt?.length > 1 ? { prompt: request.params.prompt } : {})
  }) + "\\n");
  const respond = (result) => process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n"
  );
  const update = (sessionId, value) => process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value }
  }) + "\\n");
  const commands = (sessionId) => {
    if (process.env.TEST_COMMAND_METADATA === "missing") return;
    const advertise = () => update(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: process.env.TEST_MCP_COMMAND === "false"
        ? []
        : [{ name: "mcp", description: "Manage MCP servers" }]
    });
    const delay = Number(process.env.TEST_COMMAND_DELAY_MS ?? 0);
    if (delay > 0) setTimeout(advertise, delay);
    else advertise();
  };
  switch (request.method) {
    case "initialize":
      respond({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { close: true, delete: false, list: true }
        }
      });
      break;
    case "session/new":
      commands("session-1");
      respond({ sessionId: "session-1", configOptions: [] });
      break;
    case "session/load":
      commands(request.params.sessionId);
      update(request.params.sessionId, {
        sessionUpdate: "user_message_chunk",
        messageId: "history-user",
        content: { type: "text", text: "Check GoCD pipelines" }
      });
      update(request.params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: "history-assistant",
        content: { type: "text", text: "GoCD tools are unavailable." }
      });
      setTimeout(
        () => {
          if (process.env.TEST_FAIL_RECOVERY_LOADS === "true" && startCount > 1) {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32603, message: "Session load failed" }
            }) + "\\n");
          } else {
            respond({ sessionId: request.params.sessionId, configOptions: [] });
          }
        },
        Number(process.env.TEST_LOAD_DELAY_MS ?? 0)
      );
      break;
    case "session/prompt": {
      if (request.params.prompt[0]?.text === "crash") {
        process.exit(17);
      }
      const toolFailure = {
        "mcp-failure": { title: "Search pipelines", detail: "MCP server connection closed" },
        "mcp-colon-failure": { title: "Search pipelines", detail: "MCP: connection closed" },
        "mcp-request-tool-failure": { title: "Search pipelines", detail: "MCP request failed" },
        "mcp-multiline-failure": { title: "Search pipelines", detail: "MCP server gocd\\nError: connection refused" },
        "tool-failure": { title: "Read mcp.json", detail: "ENOENT: no such file or directory, open mcp.json" },
        "shell-failure": { title: "Run npm test -- mcp.test.ts", detail: "Test assertion failed in mcp.test.ts" }
      }[request.params.prompt[0]?.text];
      if (toolFailure) {
        update(request.params.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: toolFailure.title,
          title: toolFailure.title,
          kind: "execute",
          status: "in_progress"
        });
        update(request.params.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: toolFailure.title,
          title: toolFailure.title,
          status: "failed",
          content: [{
            type: "content",
            content: { type: "text", text: toolFailure.detail }
          }]
        });
      }
      const requestError = {
        "file-request-failure": "ENOENT: no such file or directory, open mcp.json",
        "mcp-request-failure": "MCP transport error: connection refused",
        "mcp-colon-request-failure": "MCP: connection closed",
        "mcp-failed-request": "MCP request failed",
        "mcp-multiline-request-failure": "MCP server gocd\\nError: connection refused"
      }[request.params.prompt[0]?.text];
      if (requestError) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: requestError }
        }) + "\\n");
        break;
      }
      const reload = request.params.prompt[0]?.text === "/mcp reload";
      if (reload && process.env.TEST_MCP_RELOAD_ERROR === "true") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: "MCP reload failed" }
        }) + "\\n");
        break;
      }
      setTimeout(() => {
        update(request.params.sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: reload ? "MCP configuration reloaded and servers restarted." : "Done."
          }
        });
        respond({ stopReason: "end_turn" });
      }, reload ? 200 : 20);
      break;
    }
    case "session/cancel":
      break;
    case "session/list":
      respond({ sessions: [{
        sessionId: "session-1",
        cwd: process.cwd(),
        title: "Unavailable tools"
      }] });
      break;
    default:
      respond({});
  }
});
`;

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local test port");
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForHomePage(
  baseUrl: string,
  child: ReturnType<typeof spawn>,
  getOutput: () => string
): Promise<Response> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Copilot Web exited before starting:\n${getOutput()}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        return response;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Copilot Web did not start:\n${getOutput()}`);
}

async function startTestServer(t: TestContext, options: {
  advertiseMcp?: boolean;
  failReload?: boolean;
  existingSession?: boolean;
  commandDelayMs?: number;
  missingCommandMetadata?: boolean;
  loadDelayMs?: number;
  failRecoveryLoads?: boolean;
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-server-reconnect-test-"));
  const home = path.join(directory, "home");
  const projects = path.join(directory, "projects");
  const copilotHome = path.join(home, ".copilot");
  const fakeCommand = path.join(directory, "copilot-fake");
  const port = await unusedPort();
  await mkdir(home);
  await mkdir(projects);
  await mkdir(copilotHome);
  await writeFile(fakeCommand, fakeCopilot);
  await chmod(fakeCommand, 0o700);

  const serverEntry = fileURLToPath(new URL("./server.js", import.meta.url));
  const child = spawn(process.execPath, [serverEntry], {
    cwd: directory,
    env: {
      ...process.env,
      HOME: home,
      COPILOT_HOME: copilotHome,
      COPILOT_PROJECTS_DIR: projects,
      COPILOT_BIN: fakeCommand,
      COPILOT_NATIVE_SESSION_DELETE: "false",
      TEST_MCP_COMMAND: String(options.advertiseMcp ?? true),
      TEST_MCP_RELOAD_ERROR: String(options.failReload ?? false),
      TEST_COMMAND_DELAY_MS: String(options.commandDelayMs ?? 0),
      TEST_COMMAND_METADATA: options.missingCommandMetadata ? "missing" : "available",
      TEST_LOAD_DELAY_MS: String(options.loadDelayMs ?? 0),
      TEST_FAIL_RECOVERY_LOADS: String(options.failRecoveryLoads ?? false),
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const homeResponse = await waitForHomePage(baseUrl, child, () => output);
  const cookie = homeResponse.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const headers = { Cookie: cookie, "Content-Type": "application/json" };
  if (!options.existingSession) {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ context: "default" })
    });
    assert.equal(createResponse.status, 201);
    const created: unknown = await createResponse.json();
    assert.ok(isRecord(created) && isRecord(created.session));
    assert.equal(created.session.sessionId, "session-1");
  }

  return {
    baseUrl,
    headers,
    async requests(): Promise<JsonObject[]> {
      const log = await readFile(path.join(projects, "copilot-requests.log"), "utf8");
      return log.trim().split("\n").map((line) => {
        const request: unknown = JSON.parse(line);
        assert.ok(isRecord(request));
        return request;
      });
    },
    starts: () => readFile(path.join(projects, "copilot-start-count.txt"), "utf8"),
    post: (subroute: string, body: JsonObject) => fetch(
      `${baseUrl}/api/sessions/session-1/${subroute}`,
      { method: "POST", headers, body: JSON.stringify(body) }
    )
  };
}

test("reloads MCP natively before retrying without restarting the ACP process", async (t) => {
  const server = await startTestServer(t);
  const retryResponse = await server.post("messages", {
    text: "retry this request",
    reconnect: true
  });
  assert.equal(retryResponse.status, 200);
  assert.deepEqual(await retryResponse.json(), { stopReason: "end_turn" });
  assert.equal(await server.starts(), "1");
  assert.deepEqual(await server.requests(), [
    { method: "initialize" },
    { method: "session/new" },
    { method: "session/prompt", text: "/mcp reload" },
    { method: "session/prompt", text: "retry this request" }
  ]);
});

test("rejects invalid retry input before reconnecting tools", async (t) => {
  const server = await startTestServer(t);
  const before = await server.requests();
  for (const body of [
    { text: 42, reconnect: true },
    { text: "retry", reconnect: "true" },
    { text: "retry", reconnect: true, attachments: false },
    { text: "", reconnect: true }
  ]) {
    const response = await server.post("messages", body);
    assert.equal(response.status, 400);
  }
  assert.equal(await server.starts(), "1");
  assert.deepEqual(await server.requests(), before);
});

test("reloads tools only once without replaying a previous prompt", async (t) => {
  const server = await startTestServer(t);
  const response = await server.post("messages", { text: "/mcp reload", reconnect: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stopReason: "end_turn" });
  assert.deepEqual(
    (await server.requests()).filter((request) => request.method === "session/prompt"),
    [{ method: "session/prompt", text: "/mcp reload" }]
  );
  assert.equal(await server.starts(), "1");
});

test("preserves prompt text and attachments when retrying after MCP reload", async (t) => {
  const server = await startTestServer(t);
  const text = "retry with attachments";
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
  const pdfData = Buffer.from("%PDF-1.4\n%%EOF").toString("base64");
  const response = await server.post("messages", {
    text,
    reconnect: true,
    attachments: [
      { name: "image.png", mimeType: "image/png", data: imageData },
      { name: "document.pdf", mimeType: "application/pdf", data: pdfData }
    ]
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await server.requests()).filter((request) => request.method === "session/prompt"),
    [
      { method: "session/prompt", text: "/mcp reload" },
      {
        method: "session/prompt",
        text,
        prompt: [
          { type: "text", text },
          { type: "image", data: imageData, mimeType: "image/png" },
          {
            type: "resource",
            resource: {
              uri: "urn:copilot-web:attachment:1:document.pdf",
              blob: pdfData,
              mimeType: "application/pdf"
            }
          }
        ]
      }
    ]
  );
});

test("does not retry the original prompt if MCP reload fails", async (t) => {
  const server = await startTestServer(t, { failReload: true });
  const response = await server.post("messages", { text: "must not run", reconnect: true });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "MCP reload failed" });
  assert.deepEqual(
    (await server.requests()).filter((request) => request.method === "session/prompt"),
    [{ method: "session/prompt", text: "/mcp reload" }]
  );
});

test("rejects automatic recovery if the native MCP command is not advertised", async (t) => {
  const server = await startTestServer(t, { advertiseMcp: false });
  const before = await server.requests();
  const response = await server.post("messages", { text: "must not run", reconnect: true });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "This Copilot CLI does not advertise the native /mcp command through ACP"
  });
  assert.deepEqual(await server.requests(), before);
});

test("waits for delayed native commands on both new and recovered sessions", async (t) => {
  const server = await startTestServer(t, { commandDelayMs: 250 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await server.post("messages", { text: "/mcp reload", reconnect: true });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { stopReason: "end_turn" });
    assert.equal(await server.starts(), String(attempt + 1));
    if (attempt === 0) {
      const crash = await server.post("messages", { text: "crash" });
      assert.equal(crash.status, 500);
    }
  }
  assert.equal(
    (await server.requests()).filter((request) => request.text === "/mcp reload").length,
    2
  );
});

test("times out explicitly if command metadata never arrives", { timeout: 10_000 }, async (t) => {
  const server = await startTestServer(t, { missingCommandMetadata: true });
  const response = await server.post("messages", { text: "must not run", reconnect: true });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Timed out waiting for Copilot's native command metadata"
  });
  assert.equal(
    (await server.requests()).filter((request) => request.method === "session/prompt").length,
    0
  );
});

test("does not start MCP reload if cancelled while waiting for command metadata", async (t) => {
  const server = await startTestServer(t, { commandDelayMs: 1_000 });
  const retry = server.post("messages", { text: "must not run", reconnect: true });
  const deadline = Date.now() + 2_000;
  while (true) {
    const response = await fetch(`${server.baseUrl}/api/sessions/session-1/status`, {
      headers: server.headers
    });
    const status: unknown = await response.json();
    assert.ok(isRecord(status));
    if (status.busy === true) break;
    assert.ok(Date.now() < deadline, "Recovery did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await server.post("cancel", {})).status, 202);
  const response = await retry;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stopReason: "cancelled" });
  assert.equal(
    (await server.requests()).filter((request) => request.method === "session/prompt").length,
    0
  );
});

function replayUpdates(value: unknown): JsonObject[] {
  assert.ok(isRecord(value) && Array.isArray(value.replayUpdates));
  assert.ok(value.replayUpdates.every(isRecord));
  return value.replayUpdates;
}

test("rebuilds crash-recovery history once and preserves the current prompt", async (t) => {
  for (const body of [
    { text: "/mcp reload", reconnect: true },
    { text: "retry after reloading", reconnect: true },
    { text: "continue after a crash" },
    {
      text: "retry with an image after a crash",
      reconnect: true,
      attachments: [{
        name: "image.png",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII="
      }]
    }
  ]) {
    await t.test(body.text, async (t) => {
      const server = await startTestServer(t, { existingSession: true });
      const initial = await server.post("load", { context: "default" });
      assert.equal(initial.status, 200);
      assert.equal(
        replayUpdates(await initial.json()).filter((params) => (
          isRecord(params.update) && params.update.messageId === "history-assistant"
        )).length,
        1
      );
      assert.equal((await server.post("messages", { text: "crash" })).status, 500);
      const recovery = await server.post("messages", body);
      assert.equal(recovery.status, 200);
      const loaded = await server.post("load", { context: "default" });
      assert.equal(loaded.status, 200);
      const replay = replayUpdates(await loaded.json());
      assert.equal(
        replay.filter((params) => isRecord(params.update) && params.update.messageId === "history-assistant").length,
        1
      );
      const messages = replay.filter((params) => (
        isRecord(params.update) && params.update.sessionUpdate === "user_message_chunk"
      ));
      assert.equal(messages.length, 2 + (body.attachments?.length ?? 0));
      const current = messages[1]?.update;
      assert.ok(isRecord(current) && isRecord(current.content));
      assert.equal(current.content.text, body.text);
      if (body.attachments) {
        const image = messages[2]?.update;
        assert.ok(isRecord(image));
        assert.deepEqual(image.content, {
          type: "image",
          data: body.attachments[0]?.data,
          mimeType: "image/png"
        });
      }
      assert.equal(await server.starts(), "2");
    });
  }
});

test("shares concurrent session loads instead of replaying history twice", async (t) => {
  const server = await startTestServer(t, { existingSession: true, loadDelayMs: 100 });
  const responses = await Promise.all([
    server.post("load", { context: "default" }),
    server.post("load", { context: "default" })
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(
      replayUpdates(await response.json()).filter((params) => (
        isRecord(params.update) && params.update.messageId === "history-assistant"
      )).length,
      1
    );
  }
  assert.equal(
    (await server.requests()).filter((request) => request.method === "session/load").length,
    1
  );
});

test("keeps cached history intact when a recovery load fails after partial replay", async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    loadDelayMs: 200,
    failRecoveryLoads: true
  });
  assert.equal((await server.post("load", { context: "default" })).status, 200);
  assert.equal((await server.post("messages", { text: "crash" })).status, 500);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const recovering = server.post("messages", { text: "/mcp reload", reconnect: true });
    const deadline = Date.now() + 2_000;
    while (
      (await server.requests()).filter((request) => request.method === "session/load").length <
      attempt + 2
    ) {
      assert.ok(Date.now() < deadline, "Recovery load did not start");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const snapshot = await server.post("load", { context: "default" });
    assert.equal(snapshot.status, 200);
    const loaded: unknown = await snapshot.json();
    assert.ok(isRecord(loaded) && loaded.busy === true);
    assert.equal(
      replayUpdates(loaded).filter((params) => (
        isRecord(params.update) && params.update.messageId === "history-assistant"
      )).length,
      1
    );
    const response = await recovering;
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Session load failed" });
  }
});

test("does not rerun the original prompt when cancelled during MCP reload", async (t) => {
  const server = await startTestServer(t);
  const retry = server.post("messages", { text: "do not rerun this", reconnect: true });
  const deadline = Date.now() + 2_000;
  while (!(await server.requests()).some((request) => request.text === "/mcp reload")) {
    assert.ok(Date.now() < deadline, "MCP reload did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const conflicting = await server.post("messages", { text: "concurrent prompt" });
  assert.equal(conflicting.status, 409);
  const cancellation = await server.post("cancel", {});
  assert.equal(cancellation.status, 202);
  const response = await retry;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stopReason: "cancelled" });
  assert.equal(
    (await server.requests()).filter((request) => request.method === "session/prompt").length,
    1
  );
});

const chromePath = process.env.CHROME_BIN ?? (
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome"
);

test("keeps tools recovery available for successful refusals and after page refresh", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const profile = await mkdtemp(path.join(tmpdir(), "copilot-web-browser-test-"));
  const browser = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let socket: WebSocket | undefined;
  const pending = new Map<number, {
    resolve: (value: JsonObject) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  t.after(async () => {
    socket?.close();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Browser closed"));
    }
    if (browser.exitCode === null && browser.signalCode === null) {
      const closed = new Promise<void>((resolve) => browser.once("close", () => resolve()));
      browser.kill("SIGTERM");
      await closed;
    }
    await rm(profile, { recursive: true, force: true });
  });

  const debuggerUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome did not start")), 5_000);
    let output = "";
    browser.stderr.setEncoding("utf8");
    browser.stderr.on("data", (chunk: string) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    browser.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    browser.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited:\n${output}`));
    });
  });
  socket = new WebSocket(debuggerUrl);
  socket.addEventListener("message", (event) => {
    const message: unknown = JSON.parse(String(event.data));
    if (!isRecord(message) || typeof message.id !== "number") {
      return;
    }
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (isRecord(message.error)) {
      request.reject(new Error(String(message.error.message)));
    } else {
      request.resolve(isRecord(message.result) ? message.result : {});
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket?.addEventListener("open", () => resolve(), { once: true });
    socket?.addEventListener("error", () => reject(new Error("Chrome connection failed")), { once: true });
  });
  let nextId = 0;
  const command = (method: string, params: JsonObject = {}, sessionId?: string) => (
    new Promise<JsonObject>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chrome request timed out: ${method}`));
      }, 5_000);
      pending.set(id, { resolve, reject, timer });
      socket?.send(JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {})
      }));
    })
  );
  const target = await command("Target.createTarget", { url: server.baseUrl });
  assert.equal(typeof target.targetId, "string");
  const attached = await command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  assert.equal(typeof attached.sessionId, "string");
  const sessionId = String(attached.sessionId);
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = await command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, sessionId);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return isRecord(result.result) ? result.result.value : undefined;
  };
  const waitFor = async (expression: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (await evaluate(expression) !== true) {
      assert.ok(Date.now() < deadline, `Browser condition not met: ${expression}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="session-1"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="session-1"]').click()`);
  await waitFor(`document.querySelector('#messages').textContent.includes('GoCD tools are unavailable.')`);
  assert.equal(await evaluate(`document.querySelectorAll('.message-retry').length`), 0);
  assert.equal(await evaluate(`document.querySelector('#reconnect-tools')?.disabled`), false);
  await evaluate(`
    const input = document.querySelector('#prompt-input');
    input.value = 'keep my draft';
    input.dispatchEvent(new Event('input'));
    document.querySelector('#reconnect-tools').click();
  `);
  await waitFor(`document.querySelector('#reconnect-tools').disabled`);
  await waitFor(`document.querySelector('#messages').textContent.includes('MCP configuration reloaded')`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  assert.equal(await evaluate(`document.querySelector('#prompt-input').value`), "keep my draft");
  assert.equal(await server.starts(), "1");
  assert.equal(
    (await server.requests()).filter((request) => request.text === "/mcp reload").length,
    1
  );

  await evaluate("window.beforeRefresh = true");
  await command("Page.reload", {}, sessionId);
  await waitFor(`
    window.beforeRefresh !== true &&
    document.querySelector('#messages')?.textContent.includes('GoCD tools are unavailable.') &&
    document.querySelector('#reconnect-tools')?.disabled === false
  `);
  await evaluate(`document.querySelector('#reconnect-tools').click()`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  assert.equal(
    (await server.requests()).filter((request) => request.text === "/mcp reload").length,
    2
  );
  assert.equal(await server.starts(), "1");

  assert.equal((await server.post("messages", { text: "crash" })).status, 500);
  await evaluate(`document.querySelector('#reconnect-tools').click()`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  assert.equal(
    await evaluate(`document.querySelector('#messages').textContent.match(/GoCD tools are unavailable\\./g)?.length`),
    1
  );
  assert.equal(await server.starts(), "2");
  await evaluate("window.beforeCrashRefresh = true");
  await command("Page.reload", {}, sessionId);
  await waitFor(`
    window.beforeCrashRefresh !== true &&
    document.querySelector('#messages')?.textContent.includes('GoCD tools are unavailable.') &&
    document.querySelector('#reconnect-tools')?.disabled === false
  `);
  assert.equal(
    await evaluate(`document.querySelector('#messages').textContent.match(/GoCD tools are unavailable\\./g)?.length`),
    1
  );

  await evaluate(`
    (() => {
      const nativeFetch = window.fetch.bind(window);
      window.nativeFetchForRetryTest = nativeFetch;
      window.fetch = (resource, init) => {
        const url = typeof resource === "string" ? resource : resource.url;
        if (url.includes("/api/sessions/session-1/messages")) {
          return Promise.resolve(new Response(
            JSON.stringify({ error: "Conversation is already processing a prompt" }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          ));
        }
        return nativeFetch(resource, init);
      };
      const input = document.querySelector("#prompt-input");
      input.value = "ordinary prompt";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#composer").dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    })();
  `);
  await waitFor(
    `document.querySelector('#messages')?.textContent.includes('Conversation is already processing a prompt')`
  );
  assert.equal(await evaluate(`document.querySelectorAll('.message-retry').length`), 0);

  await evaluate(`window.fetch = window.nativeFetchForRetryTest`);
  for (const [prompt, expectedDetail] of [
    ["tool-failure", "ENOENT: no such file or directory, open mcp.json"],
    ["shell-failure", "Test assertion failed in mcp.test.ts"],
    ["file-request-failure", "ENOENT: no such file or directory, open mcp.json"]
  ]) {
    await evaluate(`
      (() => {
        const input = document.querySelector("#prompt-input");
        input.value = ${JSON.stringify(prompt)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#composer").dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
      })();
    `);
    await waitFor(`
      document.querySelector('#messages')?.textContent.includes(${JSON.stringify(prompt)}) &&
      document.querySelector('#messages')?.textContent.includes(${JSON.stringify(expectedDetail)}) &&
      document.querySelector('#cancel-prompt')?.disabled
    `);
    assert.equal(await evaluate(`document.querySelectorAll('.message-retry').length`), 0);
  }

  let retryCount = 0;
  for (const prompt of [
    "mcp-failure",
    "mcp-colon-failure",
    "mcp-request-tool-failure",
    "mcp-multiline-failure",
    "mcp-request-failure",
    "mcp-colon-request-failure",
    "mcp-failed-request",
    "mcp-multiline-request-failure"
  ]) {
    await evaluate(`
      (() => {
        const input = document.querySelector("#prompt-input");
        input.value = ${JSON.stringify(prompt)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#composer").dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
      })();
    `);
    retryCount += 1;
    await waitFor(`
      document.querySelectorAll('.message-retry').length === ${retryCount} &&
      document.querySelector('#cancel-prompt')?.disabled
    `);
    assert.equal(await evaluate(`
      Array.from(document.querySelectorAll('.message.user')).some((message) => (
        message.querySelector('.message-text')?.textContent === ${JSON.stringify(prompt)} &&
        message.querySelector('.message-retry')?.disabled === false
      ))
    `), true, `Missing retry action for ${prompt}`);
  }
});
