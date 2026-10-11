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
const profiles = process.env.TEST_PROFILE_SESSIONS === "true";
const args = process.argv.slice(2);
const startupModel = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined;
const context = args[args.indexOf("--context") + 1];
const sessions = new Map();
const sessionFile = (id) => path.join(process.cwd(), "profile-session-" + id + ".json");
const configOptions = (session) => profiles ? [
  {
    id: "model", type: "select", category: "model", currentValue: session.model,
    options: ["gpt-6-luna", "claude-opus-5.5"].map((value) => ({ value, name: value }))
  },
  {
    id: "reasoning_effort", type: "select", category: "thought_level",
    currentValue: session.reasoningEffort,
    options: ["low", "max"].map((value) => ({ value, name: value }))
  }
] : [];
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
    ...(profiles ? { sessionId: request.params?.sessionId, model: startupModel, context } : {}),
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
    case "session/new": {
      const sessionId = profiles ? require("node:crypto").randomUUID() : "session-1";
      const session = {
        sessionId, model: startupModel ?? "gpt-6-luna", context,
        reasoningEffort: "max", messages: []
      };
      sessions.set(sessionId, session);
      commands(sessionId);
      respond({ sessionId, configOptions: configOptions(session) });
      break;
    }
    case "session/load":
      if (profiles) {
        if (!fs.existsSync(sessionFile(request.params.sessionId))) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Session not found" }
          }) + "\\n");
          break;
        }
        const session = JSON.parse(fs.readFileSync(sessionFile(request.params.sessionId), "utf8"));
        session.model = startupModel ?? session.model;
        session.context = context;
        sessions.set(session.sessionId, session);
        for (const text of session.messages) {
          update(session.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
        }
        commands(session.sessionId);
        setTimeout(() => respond({
          sessionId: session.sessionId, configOptions: configOptions(session)
        }), Number(process.env.TEST_LOAD_DELAY_MS ?? 0));
        break;
      }
      commands(request.params.sessionId);
      update(request.params.sessionId, {
        sessionUpdate: "user_message_chunk",
        messageId: "history-user",
        content: { type: "text", text: "Check GoCD pipelines" }
      });
      update(request.params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: "history-assistant",
        content: { type: "text", text: process.env.TEST_HISTORY_TEXT ?? "GoCD tools are unavailable." }
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
      }, reload
        ? Number(process.env.TEST_MCP_RELOAD_DELAY_MS ?? 200)
        : Number(process.env.TEST_PROMPT_DELAY_MS ?? 20));
      if (profiles) {
        const session = sessions.get(request.params.sessionId);
        session.messages.push(request.params.prompt[0].text);
        fs.writeFileSync(sessionFile(session.sessionId), JSON.stringify(session));
        update(session.sessionId, {
          sessionUpdate: "usage_update", used: 100,
          size: session.context === "long_context"
            ? (session.model === "claude-opus-5.5" ? 968000 : 872000)
            : (session.model === "claude-opus-5.5" ? 200000 : 272000)
        });
      }
      break;
    }
    case "session/set_config_option": {
      const session = sessions.get(request.params.sessionId);
      if (request.params.configId === "model") {
        session.model = request.params.value;
        session.context = "default";
      } else {
        session.reasoningEffort = request.params.value;
      }
      respond({ configOptions: configOptions(session) });
      break;
    }
    case "session/close":
      sessions.delete(request.params.sessionId);
      respond({});
      break;
    case "session/cancel":
      break;
    case "session/list":
      if (profiles) {
        respond({ sessions: fs.readdirSync(process.cwd())
          .filter((name) => name.startsWith("profile-session-") && name.endsWith(".json"))
          .map((name) => {
            const session = JSON.parse(fs.readFileSync(path.join(process.cwd(), name), "utf8"));
            return { sessionId: session.sessionId, cwd: process.cwd(), title: "Profile conversation" };
          }) });
        break;
      }
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
  profileSessions?: boolean;
  promptDelayMs?: number;
  reloadDelayMs?: number;
  historyText?: string;
  context?: "default" | "long_context";
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
      TEST_PROFILE_SESSIONS: String(options.profileSessions ?? false),
      TEST_PROMPT_DELAY_MS: String(options.promptDelayMs ?? 20),
      TEST_MCP_RELOAD_DELAY_MS: String(options.reloadDelayMs ?? 200),
      ...(options.historyText ? { TEST_HISTORY_TEXT: options.historyText } : {}),
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
  const createSession = async (): Promise<string> => {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        context: options.context ?? "default",
        ...(options.profileSessions ? {
          configOverrides: { model: "gpt-6-luna", reasoning_effort: "low" }
        } : {})
      })
    });
    assert.equal(createResponse.status, 201);
    const created: unknown = await createResponse.json();
    assert.ok(isRecord(created) && isRecord(created.session));
    assert.equal(typeof created.session.sessionId, "string");
    const sessionId = String(created.session.sessionId);
    if (!options.profileSessions) {
      assert.equal(sessionId, "session-1");
    }
    return sessionId;
  };
  const sessionId = options.existingSession ? "session-1" : await createSession();

  return {
    baseUrl,
    headers,
    sessionId,
    createSession,
    session: (id: string) => readFile(path.join(projects, `profile-session-${id}.json`), "utf8")
      .then((content) => JSON.parse(content) as unknown),
    metadata: (name: string) => readFile(path.join(home, ".copilot-web", name), "utf8")
      .then((content) => JSON.parse(content) as unknown),
    async requests(): Promise<JsonObject[]> {
      const log = await readFile(path.join(projects, "copilot-requests.log"), "utf8");
      return log.trim().split("\n").map((line) => {
        const request: unknown = JSON.parse(line);
        assert.ok(isRecord(request));
        return request;
      });
    },
    async waitForPrompt(text: string): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (!(await this.requests()).some((request) => request.text === text)) {
        assert.ok(Date.now() < deadline, `Prompt did not start: ${text}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    starts: () => readFile(path.join(projects, "copilot-start-count.txt"), "utf8"),
    post: (subroute: string, body: JsonObject, id = sessionId) => fetch(
      `${baseUrl}/api/sessions/${id}/${subroute}`,
      { method: "POST", headers, body: JSON.stringify(body) }
    )
  };
}

test("updates empty-session IDs through the API and preserves metadata and selected context", async (t) => {
  const server = await startTestServer(t, { profileSessions: true, context: "long_context" });
  assert.equal((await server.post("title", { title: "Empty conversation title" })).status, 200);
  const configuredResponse = await server.post("config", { configId: "model", value: "claude-opus-5.5" });
  assert.equal(configuredResponse.status, 200);
  const configured: unknown = await configuredResponse.json();
  assert.ok(isRecord(configured) && isRecord(configured.session));
  assert.equal(typeof configured.session.sessionId, "string");
  const opusId = String(configured.session.sessionId);
  assert.notEqual(opusId, server.sessionId);
  assert.equal(configured.context, "long_context");
  assert.equal(configured.session.customTitle, "Empty conversation title");
  assert.equal((await server.post("load", { context: "long_context" })).status, 404);
  const titles = await server.metadata("session-titles.json");
  assert.ok(isRecord(titles));
  assert.equal(titles[opusId], "Empty conversation title");
  assert.equal(titles[server.sessionId], undefined);
  const listResponse = await fetch(`${server.baseUrl}/api/sessions`, { headers: server.headers });
  const list: unknown = await listResponse.json();
  assert.ok(isRecord(list) && Array.isArray(list.sessions));
  assert.deepEqual(list.sessions.filter(isRecord).map((session) => session.sessionId), [opusId]);

  const defaultResponse = await server.post("load", { context: "default" }, opusId);
  assert.equal(defaultResponse.status, 200);
  const loadedDefault: unknown = await defaultResponse.json();
  assert.ok(isRecord(loadedDefault) && isRecord(loadedDefault.session));
  const defaultId = String(loadedDefault.session.sessionId);
  assert.notEqual(defaultId, opusId);
  const longResponse = await server.post("load", { context: "long_context" }, defaultId);
  assert.equal(longResponse.status, 200);
  const loadedLong: unknown = await longResponse.json();
  assert.ok(isRecord(loadedLong) && isRecord(loadedLong.session));
  const longId = String(loadedLong.session.sessionId);
  assert.notEqual(longId, defaultId);
  assert.equal((await server.post("messages", { text: "first message" }, longId)).status, 200);
  const saved = await server.session(longId);
  assert.ok(isRecord(saved));
  assert.deepEqual(saved.messages, ["first message"]);
  assert.equal(saved.model, "claude-opus-5.5");
  assert.equal(saved.context, "long_context");
  assert.equal(saved.reasoningEffort, "low");
  const reloaded = await server.post("load", { context: "long_context" }, longId);
  assert.equal(reloaded.status, 200);
  const replay = replayUpdates(await reloaded.json());
  const usage = replay.map((params) => params.update).filter(isRecord)
    .find((update) => update.sessionUpdate === "usage_update");
  assert.equal(usage?.size, 968_000);
  assert.equal((await server.requests()).some((request) => request.method === "session/load"), false);
});

test("serializes concurrent API model switches and rejects prompts until configuration finishes", async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true, context: "long_context", loadDelayMs: 100
  });
  assert.equal((await server.post("messages", { text: "first" })).status, 200);
  const changes = Promise.all([
    server.post("config", { configId: "model", value: "claude-opus-5.5" }),
    server.post("config", { configId: "model", value: "gpt-6-luna" })
  ]);
  const deadline = Date.now() + 5_000;
  while (!(await server.requests()).some((request) => request.method === "session/load")) {
    assert.ok(Date.now() < deadline, "The profile switch did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await server.post("messages", { text: "blocked during configuration" })).status, 409);
  for (const response of await changes) {
    assert.equal(response.status, 200);
  }
  assert.equal((await server.post("messages", { text: "after concurrent changes" })).status, 200);
  assert.equal((await server.post("config", { configId: "model", value: "claude-opus-5.5" })).status, 200);
  assert.equal((await server.post("messages", { text: "after returning to opus" })).status, 200);
  const saved = await server.session(server.sessionId);
  assert.ok(isRecord(saved));
  assert.deepEqual(saved.messages, ["first", "after concurrent changes", "after returning to opus"]);
  assert.equal(saved.context, "long_context");
});

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

test("rejects cross-conversation MCP reloads without blocking ordinary parallel prompts", async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true, promptDelayMs: 1_000
  });
  const idleSessionId = await server.createSession();
  const working = server.post("messages", { text: "working" });
  await server.waitForPrompt("working");

  for (const body of [
    { text: "/mcp reload", reconnect: true },
    { text: "retry after reconnecting", reconnect: true },
    { text: "/mcp reload" }
  ]) {
    const response = await server.post("messages", body, idleSessionId);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Cannot reload MCP connections while another conversation is processing a prompt"
    });
  }
  assert.equal((await server.requests()).some((request) => request.text === "/mcp reload"), false);

  const parallel = server.post("messages", { text: "parallel prompt" }, idleSessionId);
  await server.waitForPrompt("parallel prompt");
  const statusResponse = await fetch(
    `${server.baseUrl}/api/sessions/${server.sessionId}/status`,
    { headers: server.headers }
  );
  const status: unknown = await statusResponse.json();
  assert.ok(isRecord(status) && status.busy === true);
  for (const response of await Promise.all([working, parallel])) {
    assert.equal(response.status, 200);
  }

  const reload = await server.post("messages", { text: "/mcp reload", reconnect: true }, idleSessionId);
  assert.equal(reload.status, 200);
  assert.deepEqual(
    (await server.requests()).filter((request) => request.method === "session/prompt")
      .map((request) => request.text),
    ["working", "parallel prompt", "/mcp reload"]
  );
});

test("blocks new prompts and reloads while another conversation reloads MCP", async (t) => {
  for (const reconnect of [true, false]) {
    await t.test(reconnect ? "Reconnect tools" : "native command", async (t) => {
      const server = await startTestServer(t, {
        profileSessions: true, reloadDelayMs: 1_000
      });
      const idleSessionId = await server.createSession();
      const reload = server.post("messages", { text: "/mcp reload", reconnect });
      await server.waitForPrompt("/mcp reload");

      for (const body of [
        { text: "blocked during reload" },
        { text: "/mcp reload", reconnect: true },
        { text: "blocked retry", reconnect: true },
        { text: "/mcp reload" }
      ]) {
        const response = await server.post("messages", body, idleSessionId);
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
          error: "MCP connections are currently reloading"
        });
      }
      assert.equal(
        (await server.requests()).filter((request) => request.method === "session/prompt").length,
        1
      );
      assert.equal((await reload).status, 200);
      assert.equal(
        (await server.post("messages", { text: "after reload" }, idleSessionId)).status,
        200
      );
    });
  }
});

test("allows parallel prompts after MCP reload finishes during a retry", async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true, promptDelayMs: 1_000, reloadDelayMs: 20
  });
  const idleSessionId = await server.createSession();
  const retry = server.post("messages", { text: "retry this prompt", reconnect: true });
  await server.waitForPrompt("retry this prompt");
  const parallel = server.post("messages", { text: "parallel with retry" }, idleSessionId);
  await server.waitForPrompt("parallel with retry");
  const statusResponse = await fetch(
    `${server.baseUrl}/api/sessions/${server.sessionId}/status`,
    { headers: server.headers }
  );
  const status: unknown = await statusResponse.json();
  assert.ok(isRecord(status) && status.busy === true);
  for (const response of await Promise.all([retry, parallel])) {
    assert.equal(response.status, 200);
  }
});

test("releases cross-conversation MCP reload guards after failure and cancellation", async (t) => {
  for (const failReload of [true, false]) {
    await t.test(failReload ? "failure" : "cancellation", async (t) => {
      const server = await startTestServer(t, {
        profileSessions: true, failReload, reloadDelayMs: 500
      });
      const idleSessionId = await server.createSession();
      const reload = server.post("messages", { text: "/mcp reload", reconnect: true });
      if (!failReload) {
        await server.waitForPrompt("/mcp reload");
        assert.equal((await server.post("cancel", {})).status, 202);
      }
      const response = await reload;
      assert.equal(response.status, failReload ? 500 : 200);
      assert.deepEqual(
        await response.json(),
        failReload ? { error: "MCP reload failed" } : { stopReason: "cancelled" }
      );
      assert.equal(
        (await server.post("messages", { text: "after recovery" }, idleSessionId)).status,
        200
      );
    });
  }
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

async function startTestBrowser(t: TestContext, baseUrl: string, preloadScript?: string) {
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
  const target = await command("Target.createTarget", { url: "about:blank" });
  assert.equal(typeof target.targetId, "string");
  const attached = await command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  assert.equal(typeof attached.sessionId, "string");
  const sessionId = String(attached.sessionId);
  if (preloadScript) {
    await command("Page.enable", {}, sessionId);
    await command("Page.addScriptToEvaluateOnNewDocument", { source: preloadScript }, sessionId);
  }
  await command("Page.navigate", { url: baseUrl }, sessionId);
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
  return { command, sessionId, evaluate, waitFor };
}

const trackPromptEvents = `
  const NativeEventSource = window.EventSource;
  window.promptEvents = [];
  window.EventSource = class extends NativeEventSource {
    constructor(url, options) {
      super(url, options);
      window.testEventSource = this;
      for (const type of ['session-prompt-started', 'session-prompt-complete']) {
        this.addEventListener(type, (event) => {
          window.promptEvents.push({ type, ...JSON.parse(event.data) });
        });
      }
    }
  };
`;

const holdSessionListResponse = `
  if (!window.nativeFetchForRaceTest) {
    window.nativeFetchForRaceTest = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      const url = typeof resource === 'string' ? resource : resource.url;
      if (
        !url.endsWith('/api/sessions') ||
        (init?.method ?? 'GET') !== 'GET' ||
        !window.holdNextSessionList
      ) {
        return window.nativeFetchForRaceTest(resource, init);
      }
      window.holdNextSessionList = false;
      const response = await window.nativeFetchForRaceTest(resource, init);
      const payload = await response.json();
      window.heldSessionList = payload;
      return new Promise((resolve) => {
        window.releaseSessionList = () => {
          if (typeof window.snapshotMarker === 'string') {
            payload.sessions.find((session) => (
              session.sessionId === window.markerSessionId
            )).title = window.snapshotMarker;
          }
          resolve(new Response(JSON.stringify(payload), {
            status: response.status,
            headers: response.headers
          }));
        };
      });
    };
  }
  window.heldSessionList = null;
  window.holdNextSessionList = true;
`;

const mockScreenWakeLock = `
  window.wakeLockTest = {
    requests: [], sentinels: [], visibility: 'visible',
    requestError: null, releaseError: null, delayRequest: false
  };
  Object.defineProperty(document, 'visibilityState', {
    get: () => window.wakeLockTest.visibility
  });
  Object.defineProperty(navigator, 'wakeLock', {
    value: {
      async request(type) {
        const state = window.wakeLockTest;
        state.requests.push(type);
        if (state.delayRequest) {
          state.delayRequest = false;
          await new Promise((resolve) => { state.resolveRequest = resolve; });
        }
        if (state.requestError) {
          throw new DOMException(state.requestError, 'NotAllowedError');
        }
        const sentinel = new EventTarget();
        sentinel.released = false;
        sentinel.releaseCalls = 0;
        sentinel.release = async () => {
          sentinel.releaseCalls += 1;
          if (state.releaseError) {
            throw new Error(state.releaseError);
          }
          sentinel.released = true;
          sentinel.dispatchEvent(new Event('release'));
        };
        state.sentinels.push(sentinel);
        return sentinel;
      }
    }
  });
`;

const mockSpeechRecognition = `
  window.speechRecognitionTest = { instances: [], startErrorName: null };
  window.SpeechRecognition = class {
    constructor() {
      this.stopCalls = 0;
      window.speechRecognitionTest.instances.push(this);
    }
    start() {
      const errorName = window.speechRecognitionTest.startErrorName;
      if (errorName) {
        throw new DOMException('Microphone permission denied', errorName);
      }
      this.onstart?.({ type: 'start' });
    }
    stop() {
      this.stopCalls += 1;
      this.onend?.({ type: 'end' });
    }
    abort() {
      this.onend?.({ type: 'end' });
    }
    emit(transcripts) {
      const results = transcripts.map(({ transcript, isFinal }) => {
        const result = [{ transcript }];
        result.isFinal = isFinal;
        return result;
      });
      this.onresult?.({ results, resultIndex: 0 });
    }
  };
`;

test("streams speech into the composer and stops from the microphone button", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, mockSpeechRecognition);
  const button = `document.querySelector('#voice-input')`;
  const input = `document.querySelector('#prompt-input')`;
  const status = `document.querySelector('#voice-input-status')`;
  await waitFor(`${button}?.dataset.state === 'idle' && !${button}.disabled`);
  await evaluate(`
    const input = ${input};
    input.value = 'Draft: ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.setSelectionRange(input.value.length, input.value.length);
  `);
  await waitFor(`${button}.dataset.state === 'idle' && !${button}.disabled`);
  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.state === 'recording'`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-label')`), "Stop voice input");
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "true");
  assert.equal(await evaluate(`${status}.textContent`), "Listening… Click the cross button to stop.");

  await evaluate(`window.speechRecognitionTest.instances[0].emit([
    { transcript: 'Copilot', isFinal: false }
  ])`);
  assert.equal(await evaluate(`${input}.value`), "Draft: Copilot");
  await evaluate(`window.speechRecognitionTest.instances[0].emit([
    { transcript: 'Copilot ', isFinal: true },
    { transcript: 'Web', isFinal: false }
  ])`);
  assert.equal(await evaluate(`${input}.value`), "Draft: Copilot Web");

  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.state === 'idle'`);
  assert.equal(await evaluate(`${button}.dataset.icon`), "microphone");
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "false");
  assert.equal(await evaluate(`window.speechRecognitionTest.instances[0].stopCalls`), 1);
  assert.equal(await evaluate(`${input}.value`), "Draft: Copilot Web");
  assert.equal(await evaluate(`${status}.hidden`), true);

  await evaluate(`
    window.speechRecognitionTest.startErrorName = 'NotAllowedError';
    ${button}.click();
  `);
  await waitFor(`${button}.dataset.state === 'error'`);
  assert.equal(await evaluate(`${status}.textContent`), "Microphone access was denied. Allow microphone access in your browser and try again.");
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "false");
});

test("toggles a native screen wake lock from the message bar", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const button = `document.querySelector('#keep-awake')`;
  await waitFor(`${button}?.dataset.status === 'off'`);
  assert.equal(await evaluate(`window.isSecureContext && typeof navigator.wakeLock.request === 'function'`), true);
  assert.equal(await evaluate(`${button}.disabled`), false);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "false");
  assert.equal(await evaluate(`${button}.nextElementSibling.id`), "reconnect-tools");
  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "true");
  assert.equal(await evaluate(`${button}.title`), "Keep awake: On");
  await evaluate(`window.beforeWakeLockReload = true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeWakeLockReload && ${button}?.dataset.status === 'on' && !${button}.disabled`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "true");
  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.status === 'off' && !${button}.disabled`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "false");
  assert.equal(await evaluate(`${button}.title`), "Keep awake: Off");
  await evaluate(`window.beforeWakeLockReload = true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeWakeLockReload && ${button}?.dataset.status === 'off'`);
  assert.equal(
    (await server.requests()).filter((request) => request.method === "session/prompt").length,
    0
  );
});

test("pauses and resumes the screen wake lock across visibility and page lifecycle changes", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, mockScreenWakeLock);
  const button = `document.querySelector('#keep-awake')`;
  const status = `document.querySelector('#keep-awake-status')`;
  await waitFor(`${button}?.dataset.status === 'off'`);
  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.status === 'on'`);
  assert.deepEqual(await evaluate(`window.wakeLockTest.requests`), ["screen"]);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="session-1"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="session-1"]').click()`);
  await waitFor(`document.querySelector('#messages').textContent.includes('GoCD tools are unavailable.')`);
  assert.equal(await evaluate(`${button}.dataset.status`), "on");
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 1);

  await evaluate(`
    window.wakeLockTest.visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  `);
  await waitFor(`${button}.dataset.status === 'paused' && !${button}.disabled`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "true");
  assert.equal(await evaluate(`window.wakeLockTest.sentinels[0].releaseCalls`), 1);
  assert.equal(await evaluate(`${status}.classList.contains('visually-hidden')`), false);
  await evaluate(`
    window.wakeLockTest.visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
  `);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 2);

  await evaluate(`window.wakeLockTest.sentinels[1].release()`);
  await waitFor(`${button}.dataset.status === 'paused'`);
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 2);
  assert.equal(await evaluate(`${status}.textContent.includes('toggle Off and On to retry')`), true);
  await evaluate(`${button}.click(); ${button}.click()`);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 3);

  await evaluate(`window.dispatchEvent(new Event('pagehide'))`);
  await waitFor(`${button}.dataset.status === 'paused' && !${button}.disabled`);
  assert.equal(await evaluate(`window.wakeLockTest.sentinels[2].releaseCalls`), 1);
  await evaluate(`window.dispatchEvent(new Event('pageshow'))`);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 4);

  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.status === 'off' && !${button}.disabled`);
  await evaluate(`
    window.wakeLockTest.visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    window.wakeLockTest.visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  `);
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 4);
  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  await evaluate(`window.beforeWakeLockReload = true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeWakeLockReload && ${button}?.dataset.status === 'on' && !${button}.disabled`);
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 1);
  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.status === 'off' && !${button}.disabled`);
  await evaluate(`window.beforeWakeLockReload = true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeWakeLockReload && ${button}?.dataset.status === 'off'`);
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 0);
});

test("restores the screen wake lock preference without acquiring it until the tab is visible", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    ${mockScreenWakeLock}
    window.localStorage.setItem('copilot-web-keep-awake', 'true');
    window.wakeLockTest.visibility = 'hidden';
  `);
  const button = `document.querySelector('#keep-awake')`;
  await waitFor(`${button}?.dataset.status === 'paused' && !${button}.disabled`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "true");
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 0);
  await evaluate(`
    window.wakeLockTest.visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  `);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 1);
  assert.equal(await evaluate(`window.wakeLockTest.sentinels[0].released`), false);
});

test("handles screen wake lock requests that finish after the page becomes hidden", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, mockScreenWakeLock);
  const button = `document.querySelector('#keep-awake')`;
  await waitFor(`${button}?.dataset.status === 'off'`);
  await evaluate(`window.wakeLockTest.delayRequest = true; ${button}.click()`);
  await waitFor(`Boolean(window.wakeLockTest.resolveRequest)`);
  assert.equal(await evaluate(`${button}.disabled`), true);
  await evaluate(`
    document.dispatchEvent(new Event('visibilitychange'));
    window.wakeLockTest.visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    window.wakeLockTest.resolveRequest();
  `);
  await waitFor(`${button}.dataset.status === 'paused' && !${button}.disabled`);
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 1);
  assert.equal(await evaluate(`window.wakeLockTest.sentinels[0].released`), true);
  assert.equal(await evaluate(`window.wakeLockTest.sentinels[0].releaseCalls`), 1);
  await evaluate(`
    window.wakeLockTest.visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  `);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  assert.equal(await evaluate(`window.wakeLockTest.requests.length`), 2);
});

test("reports screen wake lock failures and allows retrying without claiming it is active", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, mockScreenWakeLock);
  const button = `document.querySelector('#keep-awake')`;
  const status = `document.querySelector('#keep-awake-status')`;
  await waitFor(`${button}?.dataset.status === 'off'`);
  await evaluate(`window.wakeLockTest.requestError = 'Permission denied'; ${button}.click()`);
  await waitFor(`${button}.dataset.status === 'error' && !${button}.disabled`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "true");
  assert.equal(await evaluate(`${status}.textContent`), "Unable to enable keep awake: Permission denied");
  assert.equal(await evaluate(`${status}.classList.contains('visually-hidden')`), false);
  assert.equal(await evaluate(`window.wakeLockTest.sentinels.length`), 0);
  assert.equal(await evaluate(`window.localStorage.getItem('copilot-web-keep-awake')`), "true");

  await evaluate(`window.wakeLockTest.requestError = null; ${button}.click(); ${button}.click()`);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  await evaluate(`window.wakeLockTest.releaseError = 'Release failed'; ${button}.click()`);
  await waitFor(`${button}.dataset.status === 'error' && !${button}.disabled`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "false");
  assert.equal(await evaluate(`${status}.textContent`), "Unable to disable keep awake: Release failed");
  assert.equal(await evaluate(`window.wakeLockTest.sentinels[0].released`), false);
  assert.equal(await evaluate(`window.localStorage.getItem('copilot-web-keep-awake')`), "false");
  await evaluate(`window.wakeLockTest.releaseError = null; ${button}.click(); ${button}.click()`);
  await waitFor(`${button}.dataset.status === 'off' && !${button}.disabled`);
  assert.equal(await evaluate(`window.wakeLockTest.sentinels[0].released`), true);

  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  await evaluate(`
    window.wakeLockTest.visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  `);
  await waitFor(`${button}.dataset.status === 'paused' && !${button}.disabled`);
  await evaluate(`
    window.wakeLockTest.requestError = 'Low battery';
    window.wakeLockTest.visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  `);
  await waitFor(`${button}.dataset.status === 'error' && !${button}.disabled`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "true");
  assert.equal(await evaluate(`${status}.textContent`), "Unable to enable keep awake: Low battery");
  assert.equal(await evaluate(`window.localStorage.getItem('copilot-web-keep-awake')`), "true");
  await evaluate(`
    window.wakeLockTest.requestError = null;
    window.wakeLockTest.visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    window.wakeLockTest.visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  `);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  assert.equal(await evaluate(`${status}.classList.contains('visually-hidden')`), true);
});

test("preserves the saved screen wake lock choice through a rejected restore and a later successful reload", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    ${mockScreenWakeLock}
    if (window.localStorage.getItem('wake-lock-test-reject') === 'true') {
      window.wakeLockTest.requestError = 'Low battery';
    }
  `);
  const button = `document.querySelector('#keep-awake')`;
  await waitFor(`${button}?.dataset.status === 'off'`);
  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  await evaluate(`
    window.localStorage.setItem('wake-lock-test-reject', 'true');
    window.beforeWakeLockReload = true;
  `);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeWakeLockReload && ${button}?.dataset.status === 'error' && !${button}.disabled`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "true");
  assert.equal(await evaluate(`window.localStorage.getItem('copilot-web-keep-awake')`), "true");
  assert.equal(await evaluate(`window.wakeLockTest.sentinels.length`), 0);
  assert.equal(await evaluate(`document.querySelector('#keep-awake-status').textContent`),
    "Unable to enable keep awake: Low battery");
  await evaluate(`
    window.localStorage.removeItem('wake-lock-test-reject');
    window.beforeWakeLockReload = true;
  `);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeWakeLockReload && ${button}?.dataset.status === 'on' && !${button}.disabled`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "true");
  assert.equal(await evaluate(`window.localStorage.getItem('copilot-web-keep-awake')`), "true");
  assert.equal(await evaluate(`window.wakeLockTest.sentinels[0].released`), false);
});

test("disables the screen wake lock toggle when the browser API is unavailable", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    window.localStorage.setItem('copilot-web-keep-awake', 'true');
    Object.defineProperty(navigator, 'wakeLock', { value: undefined });
  `);
  const button = `document.querySelector('#keep-awake')`;
  await waitFor(`${button}?.dataset.status === 'off'`);
  assert.equal(await evaluate(`${button}.disabled`), true);
  assert.equal(await evaluate(`${button}.title`), "Keep awake: Unavailable in this browser");
  await evaluate(`${button}.click()`);
  assert.equal(await evaluate(`${button}.getAttribute('aria-pressed')`), "false");
  assert.equal(await evaluate(`window.localStorage.getItem('copilot-web-keep-awake')`), "true");
});

test("keeps the screen wake lock toggle usable and reports unavailable preference storage", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    ${mockScreenWakeLock}
    window.wakeLockStorageWarnings = [];
    const nativeWarn = console.warn.bind(console);
    console.warn = (...args) => {
      window.wakeLockStorageWarnings.push(args[0]);
      nativeWarn(...args);
    };
    for (const method of ['getItem', 'setItem']) {
      const native = Storage.prototype[method];
      Storage.prototype[method] = function (key, ...args) {
        if (key === 'copilot-web-keep-awake') {
          throw new DOMException('Storage disabled', 'SecurityError');
        }
        return native.call(this, key, ...args);
      };
    }
  `);
  const button = `document.querySelector('#keep-awake')`;
  await waitFor(`${button}?.dataset.status === 'off' && !${button}.disabled`);
  assert.deepEqual(await evaluate(`window.wakeLockStorageWarnings`), [
    "Unable to restore the keep-awake preference"
  ]);
  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.status === 'on' && !${button}.disabled`);
  assert.equal(await evaluate(`window.wakeLockStorageWarnings[1]`),
    "Unable to save the keep-awake preference; it may reset after a refresh");
  await evaluate(`${button}.click()`);
  await waitFor(`${button}.dataset.status === 'off' && !${button}.disabled`);
  assert.equal(await evaluate(`window.wakeLockTest.sentinels[0].released`), true);
});

test("keeps composer usage beside the selectors and wraps narrow layouts without overlap", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="session-1"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="session-1"]').click()`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  await evaluate(`
    document.querySelector('#usage-summary').hidden = false;
    document.querySelector('#usage-aic-metric').hidden = false;
    document.querySelector('#usage-context-metric').hidden = false;
  `);
  const noOverlap = `(() => {
    const footer = document.querySelector('.composer-footer').getBoundingClientRect();
    const boxes = [
      ...document.querySelectorAll('.composer-setting'),
      document.querySelector('#usage-summary'),
      document.querySelector('.composer-actions')
    ].map((element) => element.getBoundingClientRect());
    return Math.abs(boxes.at(-1).right - footer.right) < 1 && boxes.every((box) => (
      box.left >= footer.left - 1 && box.right <= footer.right + 1 &&
      box.top >= footer.top - 1 && box.bottom <= footer.bottom + 1
    )) && boxes.every((box, index) => boxes.slice(index + 1).every((other) => !(
      box.left < other.right - 1 && box.right > other.left + 1 &&
      box.top < other.bottom - 1 && box.bottom > other.top + 1
    )));
  })()`;
  for (const width of [1360, 1200]) {
    await command("Emulation.setDeviceMetricsOverride", {
      width, height: 900, deviceScaleFactor: 1, mobile: false
    }, sessionId);
    for (const [aic, context] of [
      ["0.13 used", "36.8K / 872K tokens"],
      ["58.67 used", "107.3K / 922K tokens"]
    ]) {
      await evaluate(`
        document.querySelector('#usage-aic').textContent = ${JSON.stringify(aic)};
        document.querySelector('#usage-context').textContent = ${JSON.stringify(context)};
      `);
      assert.equal(await evaluate(`(() => {
        const usage = document.querySelector('#usage-summary').getBoundingClientRect();
        const settings = [...document.querySelectorAll('.composer-setting')]
          .map((element) => element.getBoundingClientRect());
        return settings.every((box) => (
          Math.abs(box.bottom - usage.bottom) < 1 && box.width >= 100 && box.width <= 145
        )) && usage.left >= settings[2].right;
      })()`), true, `Usage should stay inline at ${width}px with ${aic} and ${context}`);
      assert.equal(await evaluate(noOverlap), true);
    }
  }
  for (const width of [1000, 801, 768, 390, 320]) {
    await command("Emulation.setDeviceMetricsOverride", {
      width, height: 900, deviceScaleFactor: 1, mobile: false
    }, sessionId);
    assert.equal(await evaluate(noOverlap), true, `Composer should not overflow or overlap at ${width}px`);
    assert.equal(await evaluate(`document.querySelector('#keep-awake').nextElementSibling.id`), "reconnect-tools");
  }
});

test("shows a jump-to-bottom button without interrupting conversation scrolling", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    loadDelayMs: 150,
    historyText: Array.from({ length: 30 }, (_, index) => `History paragraph ${index}.`).join("\n\n")
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1200, height: 900, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  const button = `document.querySelector('#scroll-to-bottom')`;
  const bottomDistance = `(() => {
    const messages = document.querySelector('#messages');
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  })()`;
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="session-1"]'))`);
  assert.equal(await evaluate(`${button}.hidden && ${button}.disabled`), true);
  await evaluate(`document.querySelector('button.session-item[data-session-id="session-1"]').click()`);
  await waitFor(`document.querySelector('#messages').getAttribute('aria-busy') === 'true'`);
  assert.equal(await evaluate(`${button}.hidden && ${button}.disabled`), true);
  await waitFor(`document.querySelector('#messages').textContent.includes('History paragraph 29.')`);
  await waitFor(`${bottomDistance} < 1 && ${button}.hidden`);

  await evaluate(`document.querySelector('#messages').scrollTop = 0`);
  await waitFor(`!${button}.hidden && !${button}.disabled`);
  assert.equal(await evaluate(`
    (() => {
      const arrow = ${button}.getBoundingClientRect();
      const messages = document.querySelector('#messages').getBoundingClientRect();
      const composer = document.querySelector('#composer').getBoundingClientRect();
      return arrow.width === 36 && arrow.height === 36 &&
        arrow.bottom <= messages.bottom && arrow.bottom < composer.top &&
        Math.abs((arrow.left + arrow.right - messages.left - messages.right) / 2) < 1;
    })()
  `), true);
  assert.equal((await server.post("messages", { text: "continue while reading history" })).status, 200);
  await waitFor(`document.querySelector('#messages').textContent.includes('Done.')`);
  assert.equal(await evaluate(`document.querySelector('#messages').scrollTop`), 0);
  assert.equal(await evaluate(`${button}.hidden || ${button}.disabled`), false);

  await evaluate(`${button}.click()`);
  await waitFor(`${bottomDistance} < 1 && ${button}.hidden && ${button}.disabled`);
  await evaluate(`
    (() => {
      const messages = document.querySelector('#messages');
      messages.scrollTop = messages.scrollHeight - messages.clientHeight - 79;
    })()
  `);
  await waitFor(`${button}.hidden`);
  await evaluate(`
    (() => {
      const messages = document.querySelector('#messages');
      messages.scrollTop = messages.scrollHeight - messages.clientHeight - 80;
    })()
  `);
  await waitFor(`!${button}.hidden && !${button}.disabled`);
  await command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  }, sessionId);
  assert.equal(await evaluate(`${button}.click(); ${bottomDistance} < 1 && ${button}.hidden`), true);

  assert.equal((await server.post("messages", { text: "continue at the bottom" })).status, 200);
  await waitFor(`document.querySelector('#messages').textContent.match(/Done\\./g)?.length === 2`);
  await waitFor(`${bottomDistance} < 1 && ${button}.hidden`);
  await command("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 700, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  await waitFor(`!${button}.hidden && !${button}.disabled`);
  assert.equal(await evaluate(`
    ${button}.getBoundingClientRect().bottom < document.querySelector('#composer').getBoundingClientRect().top
  `), true);
  await evaluate(`${button}.click()`);
  await waitFor(`${bottomDistance} < 1 && ${button}.hidden`);
  await evaluate(`document.querySelector('#messages').scrollTop = 0`);
  await waitFor(`!${button}.hidden`);
  await evaluate(`document.querySelector('#new-chat').click()`);
  await waitFor(`document.querySelector('#messages').contains(document.querySelector('#empty-state'))`);
  assert.equal(await evaluate(`${button}.hidden && ${button}.disabled`), true);
  await evaluate(`document.querySelector('button.session-item[data-session-id="session-1"]').click()`);
  await waitFor(`document.querySelector('#messages').textContent.includes('History paragraph 29.')`);
  await waitFor(`${bottomDistance} < 1 && ${button}.hidden`);
});

test("preserves the draft and attachments when an empty conversation changes model and context", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true, context: "long_context" });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const activeId = `window.localStorage.getItem("copilot-web-active-session")`;
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await waitFor(`document.querySelector('#model-select').disabled === false`);
  await evaluate(`
    (() => {
      const context = document.querySelector('#context-select');
      context.value = "long_context";
      context.dispatchEvent(new Event("change"));
    })();
  `);
  await waitFor(`document.querySelector('#model-select').disabled === false`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`${activeId} === "${server.sessionId}" && document.querySelector('#model-select').disabled === false`);
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
  await evaluate(`
    const input = document.querySelector("#prompt-input");
    input.value = "keep this draft";
    input.dispatchEvent(new Event("input"));
    const files = new DataTransfer();
    const image = Uint8Array.from(atob("${imageData}"), (character) => character.charCodeAt(0));
    files.items.add(new File([image], "draft.png", { type: "image/png" }));
    const fileInput = document.querySelector("#file-input");
    fileInput.files = files.files;
    fileInput.dispatchEvent(new Event("change"));
  `);
  await waitFor(`document.querySelector('#attachment-list').textContent.includes('draft.png')`);
  await evaluate(`
    const model = document.querySelector("#model-select");
    model.value = "claude-opus-5.5";
    model.dispatchEvent(new Event("change"));
  `);
  await waitFor(`${activeId} !== "${server.sessionId}" && document.querySelector('#model-select').disabled === false`);
  const opusId = await evaluate(activeId);
  assert.equal(typeof opusId, "string");
  assert.equal(await evaluate(`document.querySelector('#prompt-input').value`), "keep this draft");
  assert.equal(await evaluate(`document.querySelector('#attachment-list').textContent.includes('draft.png')`), true);
  assert.equal(await evaluate(`document.querySelector('#model-select').value`), "claude-opus-5.5");
  assert.equal(await evaluate(`document.querySelector('#reasoning-select').value`), "low");
  await evaluate(`
    (() => {
      const context = document.querySelector('#context-select');
      context.value = "default";
      context.dispatchEvent(new Event("change"));
    })();
  `);
  await waitFor(`${activeId} !== "${opusId}" && document.querySelector('#model-select').disabled === false`);
  const defaultId = await evaluate(activeId);
  await evaluate(`
    (() => {
      const context = document.querySelector('#context-select');
      context.value = "long_context";
      context.dispatchEvent(new Event("change"));
    })();
  `);
  await waitFor(`${activeId} !== "${defaultId}" && document.querySelector('#model-select').disabled === false`);
  const longId = await evaluate(activeId);
  assert.equal(typeof longId, "string");
  assert.equal(await evaluate(`document.querySelectorAll('button.session-item').length`), 1);
  assert.equal(await evaluate(`document.querySelector('#prompt-input').value`), "keep this draft");
  assert.equal(await evaluate(`document.querySelector('#attachment-list').textContent.includes('draft.png')`), true);
  await evaluate(`document.querySelector('#send-prompt').click()`);
  await waitFor(`document.querySelector('#messages').textContent.includes('Done.') &&
    document.querySelector('#model-select').disabled === false`);
  const saved = await server.session(String(longId));
  assert.ok(isRecord(saved));
  assert.deepEqual(saved.messages, ["keep this draft"]);
  assert.equal(saved.model, "claude-opus-5.5");
  assert.equal(saved.context, "long_context");
  assert.equal(saved.reasoningEffort, "low");
  const prompt = (await server.requests()).find((request) => request.method === "session/prompt");
  assert.ok(prompt && Array.isArray(prompt.prompt) && isRecord(prompt.prompt[1]));
  assert.equal(prompt.prompt[1].type, "image");
  assert.equal(prompt.prompt[1].data, imageData);
  assert.match(String(await evaluate(`document.querySelector('#usage-context').textContent`)), /968K/);
});

test("disables MCP recovery across conversations and restores it when background work finishes", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true, promptDelayMs: 3_000 });
  const idleSessionId = await server.createSession();
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${idleSessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${idleSessionId}"]'
  ).click()`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  await evaluate(`
    (() => {
      const input = document.querySelector('#prompt-input');
      input.value = 'mcp-failure';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#composer').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    })()
  `);
  await waitFor(`document.querySelector('.message-retry')?.disabled === false`);

  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  await evaluate(`
    (() => {
      const input = document.querySelector('#prompt-input');
      input.value = 'working in another conversation';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#composer').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    })()
  `);
  await server.waitForPrompt("working in another conversation");
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${idleSessionId}"]'
  ).click()`);
  await waitFor(`
    document.querySelector('button.session-item.active')?.dataset.sessionId === "${idleSessionId}" &&
    document.querySelector('#reconnect-tools').disabled &&
    document.querySelector('.message-retry')?.disabled === true
  `);
  await evaluate(`
    (() => {
      window.retryConfirmations = 0;
      window.confirm = () => {
        window.retryConfirmations += 1;
        return true;
      };
      for (const button of document.querySelectorAll('#reconnect-tools, .message-retry')) {
        button.disabled = false;
        button.click();
        button.disabled = true;
      }
    })()
  `);
  assert.equal(await evaluate("window.retryConfirmations"), 0);
  assert.equal(await evaluate(`document.querySelector('#messages').textContent.includes('/mcp reload')`), false);
  assert.equal((await server.requests()).some((request) => request.text === "/mcp reload"), false);
  await waitFor(`
    !document.querySelector('#reconnect-tools').disabled &&
    document.querySelector('.message-retry')?.disabled === false
  `);

  const externalPrompt = server.post("messages", { text: "prompt from another tab" });
  await waitFor(`
    document.querySelector('#reconnect-tools').disabled &&
    document.querySelector('.message-retry')?.disabled === true
  `);
  await evaluate("window.beforeBusyRefresh = true");
  await command("Page.reload", {}, sessionId);
  await waitFor(`
    window.beforeBusyRefresh !== true &&
    document.querySelector('button.session-item.active')?.dataset.sessionId === "${idleSessionId}" &&
    document.querySelector(
      'button.session-item[data-session-id="${server.sessionId}"] .session-status'
    )?.textContent.includes('Working') &&
    document.querySelector('#reconnect-tools')?.disabled === true
  `);
  assert.equal((await externalPrompt).status, 200);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
});

test("keeps MCP recovery disabled when local cleanup overlaps a newer remote prompt", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true, promptDelayMs: 1_500 });
  const idleSessionId = await server.createSession();
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, trackPromptEvents);
  await waitFor(`Boolean(window.testEventSource)`);
  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${idleSessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${idleSessionId}"]'
  ).click()`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  await evaluate(`
    (() => {
      const input = document.querySelector('#prompt-input');
      input.value = 'mcp-failure';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#composer').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    })()
  `);
  await waitFor(`document.querySelector('.message-retry')?.disabled === false`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  await evaluate(holdSessionListResponse);
  await evaluate(`
    (() => {
      const input = document.querySelector('#prompt-input');
      input.value = 'local prompt awaiting cleanup';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#composer').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    })()
  `);
  await waitFor(`Boolean(window.heldSessionList)`);
  assert.equal(await evaluate(`window.heldSessionList.sessions.find((session) => (
    session.sessionId === "${server.sessionId}"
  )).busy`), false);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${idleSessionId}"]'
  ).click()`);

  const remotePrompt = server.post("messages", { text: "newer remote prompt" });
  await waitFor(`window.promptEvents.filter((event) => (
    event.type === 'session-prompt-started' && event.sessionId === "${server.sessionId}"
  )).length === 2`);
  await evaluate(`window.releaseSessionList()`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`document.querySelector('#cancel-prompt').disabled`);
  assert.equal(await evaluate(`document.querySelector('#reconnect-tools').disabled`), true);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${idleSessionId}"]'
  ).click()`);
  assert.equal(await evaluate(`document.querySelector('.message-retry').disabled`), true);
  assert.equal((await remotePrompt).status, 200);
  await waitFor(`
    !document.querySelector('#reconnect-tools').disabled &&
    document.querySelector('.message-retry')?.disabled === false
  `);
});

test("merges delayed session snapshots without overriding newer prompt events", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true, promptDelayMs: 1_500 });
  const idleSessionId = await server.createSession();
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, trackPromptEvents);
  await waitFor(`Boolean(window.testEventSource)`);
  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${idleSessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${idleSessionId}"]'
  ).click()`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  await evaluate(`
    (() => {
      const input = document.querySelector('#prompt-input');
      input.value = 'mcp-failure';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#composer').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    })()
  `);
  await waitFor(`document.querySelector('.message-retry')?.disabled === false`);
  await evaluate(`window.markerSessionId = "${server.sessionId}"`);

  for (const busySnapshot of [true, false]) {
    const marker = busySnapshot ? "Completed snapshot applied" : "Started snapshot applied";
    let remotePrompt: Promise<Response> | undefined;
    if (busySnapshot) {
      remotePrompt = server.post("messages", { text: "complete before snapshot arrives" });
      await waitFor(`document.querySelector('#reconnect-tools').disabled`);
    }
    await evaluate(holdSessionListResponse);
    await evaluate(`
      window.snapshotMarker = ${JSON.stringify(marker)};
      window.testEventSource.dispatchEvent(new MessageEvent('session-activity', {
        data: JSON.stringify({
          sessionId: 'session-refresh-probe',
          lastActivityAt: new Date().toISOString()
        })
      }));
    `);
    await waitFor(`Boolean(window.heldSessionList)`);
    assert.equal(await evaluate(`window.heldSessionList.sessions.find((session) => (
      session.sessionId === "${server.sessionId}"
    )).busy`), busySnapshot);

    if (busySnapshot) {
      assert.equal((await remotePrompt)?.status, 200);
      await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
    } else {
      remotePrompt = server.post("messages", { text: "start after snapshot was captured" });
      await waitFor(`document.querySelector('#reconnect-tools').disabled`);
    }
    await evaluate(`window.releaseSessionList()`);
    await waitFor(`document.querySelector(
      'button.session-item[data-session-id="${server.sessionId}"] .session-title'
    )?.textContent === ${JSON.stringify(marker)}`);
    assert.equal(await evaluate(`document.querySelector('#reconnect-tools').disabled`), !busySnapshot);
    assert.equal(await evaluate(`document.querySelector('.message-retry').disabled`), !busySnapshot);
    if (!busySnapshot) {
      assert.equal((await remotePrompt)?.status, 200);
      await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
    }
  }
});

test("keeps tools recovery available for successful refusals and after page refresh", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);

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
