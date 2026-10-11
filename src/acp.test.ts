import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpConnection, AcpConnectionManager, isRecord } from "./acp.js";

const fakeCopilot = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const sessions = new Map();
const startupModel = process.argv[process.argv.indexOf("--model") + 1];
const model = process.argv.includes("--model") ? startupModel : "gpt-6-luna";
const configCallsFile = path.join(process.cwd(), "copilot-config-calls.jsonl");
fs.writeFileSync(
  path.join(process.cwd(), "copilot-args.json"),
  JSON.stringify(process.argv.slice(2))
);

function configOptions(session) {
  const codex = session.model === "gpt-5.3-codex";
  return [
    {
      id: "model",
      type: "select",
      currentValue: session.model,
      options: [
        { value: "gpt-6-luna", name: "GPT-6 Luna" },
        { value: "gpt-5.3-codex", name: "GPT-5.3-Codex" }
      ]
    },
    {
      id: "reasoning_effort",
      type: "select",
      category: "thought_level",
      currentValue: session.reasoningEffort ?? (codex ? "high" : "max"),
      options: codex
        ? [
            { value: "low", name: "low" },
            { value: "high", name: "high" }
          ]
        : [
            { value: "low", name: "low" },
            { value: "max", name: "max" }
          ]
    }
  ];
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  const respond = (result) => process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n"
  );
  switch (request.method) {
    case "initialize":
      respond({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { close: true, delete: false, list: false }
        }
      });
      break;
    case "session/new": {
      const session = {
        sessionId: require("node:crypto").randomUUID(),
        model
      };
      sessions.set(session.sessionId, session);
      respond({ sessionId: session.sessionId, configOptions: configOptions(session) });
      break;
    }
    case "session/load": {
      const session = {
        sessionId: request.params.sessionId,
        model
      };
      sessions.set(session.sessionId, session);
      respond({ sessionId: session.sessionId, configOptions: configOptions(session) });
      break;
    }
    case "session/set_config_option": {
      const session = sessions.get(request.params.sessionId);
      fs.appendFileSync(
        configCallsFile,
        JSON.stringify({
          configId: request.params.configId,
          value: request.params.value
        }) + "\\n"
      );
      if (request.params.configId === "model") {
        session.model = request.params.value;
        session.reasoningEffort = undefined;
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
    case "session/prompt":
      if (request.params.prompt[0]?.text === "crash") {
        process.exit(17);
      }
      respond({ stopReason: "end_turn" });
      break;
    default:
      respond({});
  }
});
`;

const tieredCopilot = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const context = args[args.indexOf("--context") + 1];
const startupModel = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined;
const sessions = new Map();
let pendingPermission;
const file = (id) => path.join(process.cwd(), id + ".json");
const notify = (session, update) => process.stdout.write(JSON.stringify({
  jsonrpc: "2.0", method: "session/update",
  params: { sessionId: session.sessionId, update }
}) + "\\n");
function configOptions(session) {
  return [
    {
      id: "model", type: "select", category: "model", currentValue: session.model,
      options: ["gpt-6-luna", "claude-opus-5.5", "gpt-5.3-codex"].map((value) => ({
        value, name: value
      }))
    },
    {
      id: "reasoning_effort", type: "select", category: "thought_level",
      currentValue: session.reasoningEffort,
      options: (session.model === "gpt-5.3-codex" ? ["low", "high"] : ["low", "max"])
        .map((value) => ({ value, name: value }))
    }
  ];
}
function completePrompt(request, session) {
  const text = request.params.prompt[0].text;
  session.messages.push(text);
  fs.writeFileSync(file(session.sessionId), JSON.stringify(session));
  const opus = session.model === "claude-opus-5.5";
  notify(session, {
    sessionUpdate: "usage_update", used: 100,
    size: session.context === "long_context" ? (opus ? 968000 : 872000) : (opus ? 200000 : 272000)
  });
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" }
  }) + "\\n");
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(path.join(process.cwd(), "tiered-requests.jsonl"), JSON.stringify({
    method: request.method, id: request.id, params: request.params,
    model: startupModel, context, result: request.result
  }) + "\\n");
  if (!request.method) {
    if (pendingPermission && request.id === 500) {
      completePrompt(pendingPermission.request, pendingPermission.session);
      pendingPermission = undefined;
    }
    return;
  }
  const respond = (result) => process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id: request.id, result
  }) + "\\n");
  const reject = (message) => process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id: request.id, error: { code: -32602, message }
  }) + "\\n");
  switch (request.method) {
    case "initialize":
      respond({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true, sessionCapabilities: { close: true, list: true }
        }
      });
      break;
    case "session/list":
      respond({ sessions: [] });
      break;
    case "session/new": {
      if (fs.existsSync(path.join(process.cwd(), "fail-new"))) {
        reject("Session creation failed");
        break;
      }
      const selectedModel = startupModel ?? "gpt-6-luna";
      const session = {
        sessionId: require("node:crypto").randomUUID(), model: selectedModel, context,
        reasoningEffort: selectedModel === "gpt-5.3-codex" ? "high" : "max", messages: []
      };
      sessions.set(session.sessionId, session);
      respond({ sessionId: session.sessionId, configOptions: configOptions(session) });
      break;
    }
    case "session/load": {
      if (fs.existsSync(path.join(process.cwd(), "fail-load"))) {
        reject("Session load failed");
        break;
      }
      if (!fs.existsSync(file(request.params.sessionId))) {
        reject("Session has no persisted messages");
        break;
      }
      const session = JSON.parse(fs.readFileSync(file(request.params.sessionId), "utf8"));
      session.model = startupModel ?? session.model;
      session.context = context;
      if (session.model === "gpt-5.3-codex" && session.reasoningEffort === "max") {
        session.reasoningEffort = "high";
      }
      sessions.set(session.sessionId, session);
      for (const text of session.messages) {
        notify(session, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
      }
      const delayFile = path.join(process.cwd(), "load-delay-ms");
      const delay = fs.existsSync(delayFile) ? Number(fs.readFileSync(delayFile, "utf8")) : 0;
      setTimeout(() => respond({
        sessionId: session.sessionId, configOptions: configOptions(session)
      }), delay);
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
      notify(session, { sessionUpdate: "config_option_update", configOptions: configOptions(session) });
      respond({ configOptions: configOptions(session) });
      break;
    }
    case "session/close":
      sessions.delete(request.params.sessionId);
      respond({});
      break;
    case "session/cancel":
      if (pendingPermission?.session.sessionId === request.params.sessionId) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: pendingPermission.request.id, result: { stopReason: "cancelled" }
        }) + "\\n");
        pendingPermission = undefined;
      }
      break;
    case "session/prompt": {
      if (request.params.prompt[0].text === "crash") {
        process.exit(17);
      }
      const session = sessions.get(request.params.sessionId);
      if (request.params.prompt[0].text === "permission") {
        pendingPermission = { request, session };
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: 500, method: "session/request_permission",
          params: { sessionId: session.sessionId, options: [{ optionId: "allow", kind: "allow_once" }] }
        }) + "\\n");
      } else {
        completePrompt(request, session);
      }
      break;
    }
    default:
      respond({});
  }
});
`;

const recoveringCopilot = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const runFile = path.join(process.cwd(), "copilot-start-count.txt");
let run = 1;
try {
  run = Number(fs.readFileSync(runFile, "utf8")) + 1;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
fs.writeFileSync(runFile, String(run));

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  const respond = (result) => process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n"
  );
  const commands = (sessionId) => {
    if (fs.existsSync(path.join(process.cwd(), "omit-command-metadata"))) return;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "mcp", description: "Manage MCP servers" }]
        }
      }
    }) + "\\n");
  };
  switch (request.method) {
    case "initialize":
      respond({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
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
      respond({ sessionId: request.params.sessionId, configOptions: [] });
      break;
    case "session/prompt":
      if (request.params.prompt[0]?.text === "crash") {
        process.exit(17);
      }
      fs.writeFileSync(
        path.join(process.cwd(), "prompt-started.txt"),
        request.params.prompt[0]?.text
      );
      setTimeout(() => respond({ stopReason: "end_turn" }), 100);
      break;
    case "session/list":
      if (run === 1) {
        process.exit(17);
      }
      respond({ sessions: [] });
      break;
    default:
      respond({});
  }
});
`;

test("recovers a dead ACP process and reloads MCP without restarting a healthy process", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-acp-restart-test-"));
  const command = path.join(directory, "copilot-fake");
  const startCountFile = path.join(directory, "copilot-start-count.txt");
  await writeFile(command, recoveringCopilot);
  await chmod(command, 0o700);

  const acp = new AcpConnectionManager({
    command,
    cwd: directory,
    clientVersion: "test"
  });
  try {
    await assert.rejects(
      acp.listSessions(),
      /Copilot ACP process exited with exit code 17/
    );
    assert.deepEqual(await acp.listSessions(), []);
    assert.equal(await readFile(startCountFile, "utf8"), "2");

    const setup = await acp.newSession(directory, "default");
    const session = { sessionId: setup.sessionId, cwd: directory };
    assert.equal(await acp.reloadMcpServers(session), "end_turn");
    assert.equal(await readFile(startCountFile, "utf8"), "2");

    const activePrompt = acp.prompt(session, [{ type: "text", text: "in progress" }]);
    const promptStartedFile = path.join(directory, "prompt-started.txt");
    const promptDeadline = Date.now() + 1_000;
    while (true) {
      try {
        if (await readFile(promptStartedFile, "utf8") === "in progress") {
          break;
        }
      } catch {
        // The fixture writes this marker when it receives the prompt.
      }
      if (Date.now() >= promptDeadline) {
        throw new Error("Fake Copilot did not start the prompt");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await assert.rejects(
      acp.reloadMcpServers(session),
      /This conversation is already processing a prompt/
    );
    assert.equal(await activePrompt, "end_turn");

    await assert.rejects(
      acp.prompt(session, [{ type: "text", text: "crash" }]),
      /Copilot ACP process exited with exit code 17/
    );
    assert.equal(await acp.reloadMcpServers(session), "end_turn");
    assert.equal(await readFile(startCountFile, "utf8"), "3");
    assert.equal(await acp.prompt(session, [{ type: "text", text: "retry" }]), "end_turn");
  } finally {
    await acp.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleans up command metadata waits on cancellation, closure, shutdown, and crashes", async (t) => {
  for (const action of ["cancel", "close", "stop", "crash"]) {
    await t.test(action, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-command-wait-test-"));
      const command = path.join(directory, "copilot-fake");
      await writeFile(command, recoveringCopilot);
      await writeFile(path.join(directory, "omit-command-metadata"), "");
      await chmod(command, 0o700);
      const acp = new AcpConnection({ command, cwd: directory, clientVersion: "test" });
      try {
        const setup = await acp.newSession(directory);
        const session = { sessionId: setup.sessionId, cwd: directory };
        const controller = new AbortController();
        const waiting = acp.waitForCommand(session.sessionId, "mcp", controller.signal);
        const rejection = assert.rejects(waiting, (
          action === "cancel"
            ? /operation was aborted/i
            : action === "close"
              ? /Conversation closed before native command metadata/
              : /ACP disconnected before native command metadata/
        ));
        assert.equal(acp.events.listenerCount("commandsAvailable"), 1);
        assert.equal(acp.events.listenerCount("disconnected"), 1);
        assert.equal(acp.events.listenerCount("sessionClosed"), 1);
        if (action === "cancel") {
          controller.abort();
        } else if (action === "close") {
          await acp.closeSession(session.sessionId);
        } else if (action === "stop") {
          await acp.stop();
        } else {
          await assert.rejects(
            acp.prompt(session, [{ type: "text", text: "crash" }]),
            /Copilot ACP process exited with exit code 17/
          );
        }
        await rejection;
        assert.equal(acp.events.listenerCount("commandsAvailable"), 0);
        assert.equal(acp.events.listenerCount("disconnected"), 0);
        assert.equal(acp.events.listenerCount("sessionClosed"), 0);
      } finally {
        await acp.stop();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("restores model and reasoning preferences after an ACP crash", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-acp-config-recovery-test-"));
  const command = path.join(directory, "copilot-fake");
  await writeFile(command, fakeCopilot);
  await chmod(command, 0o700);
  const acp = new AcpConnectionManager({
    command,
    cwd: directory,
    clientVersion: "test"
  });
  try {
    const setup = await acp.newSession(directory, "default", {
      model: "gpt-5.3-codex",
      reasoning_effort: "low"
    });
    const session = { sessionId: setup.sessionId, cwd: directory };
    await assert.rejects(
      acp.prompt(session, [{ type: "text", text: "crash" }]),
      /Copilot ACP process exited with exit code 17/
    );
    assert.equal(await acp.prompt(session, [{ type: "text", text: "retry" }]), "end_turn");
    const options = acp.getConfigOptions(session.sessionId);
    assert.equal(options.find((option) => option.id === "model")?.currentValue, "gpt-5.3-codex");
    assert.equal(options.find((option) => option.id === "reasoning_effort")?.currentValue, "low");
  } finally {
    await acp.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("passes context tiers to the CLI and previews model-specific reasoning options", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-acp-test-"));
  const command = path.join(directory, "copilot-fake");
  const argsFile = path.join(directory, "copilot-args.json");
  const configCallsFile = path.join(directory, "copilot-config-calls.jsonl");
  await writeFile(command, fakeCopilot);
  await chmod(command, 0o700);

  const acp = new AcpConnectionManager({
    command,
    cwd: directory,
    clientVersion: "test"
  });
  try {
    const preview = await acp.discoverConfig("default", "gpt-5.3-codex");
    assert.deepEqual(
      JSON.parse(await readFile(argsFile, "utf8")),
      ["--context", "default", "--acp", "--no-color", "--model", "gpt-5.3-codex"]
    );
    const reasoning = preview.configOptions.find((option) => option.id === "reasoning_effort");
    assert.equal(reasoning?.currentValue, "high");
    const reasoningOptions = Array.isArray(reasoning?.options) ? reasoning.options : [];
    assert.deepEqual(
      reasoningOptions
        .filter(isRecord)
        .map((option) => option.value),
      ["low", "high"]
    );

    await acp.discoverConfig("long_context", "gpt-6-luna");
    assert.deepEqual(
      JSON.parse(await readFile(argsFile, "utf8")),
      ["--context", "long_context", "--acp", "--no-color", "--model", "gpt-6-luna"]
    );

    await writeFile(configCallsFile, "");
    await acp.newSession(directory, "default", {
      model: "gpt-6-luna",
      reasoning_effort: "max"
    });
    assert.equal(await readFile(configCallsFile, "utf8"), "");

    const configured = await acp.newSession(
      directory,
      "default",
      {
        model: "gpt-5.3-codex",
        reasoning_effort: "max"
      },
      new Set(["reasoning_effort"])
    );
    assert.equal(
      configured.configOptions.find((option) => option.id === "reasoning_effort")?.currentValue,
      "high"
    );

    await assert.rejects(
      acp.newSession(directory, "default", {
        model: "gpt-5.3-codex",
        reasoning_effort: "max"
      }),
      /Copilot does not support reasoning_effort=max/
    );
  } finally {
    await acp.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves effective context limits through creation, model changes, context changes, and recovery", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-context-test-"));
  const command = path.join(directory, "copilot-fake");
  await writeFile(command, tieredCopilot);
  await chmod(command, 0o700);
  const acp = new AcpConnectionManager({ command, cwd: directory, clientVersion: "test" });
  const sizes = new Map<string, number>();
  const history: string[] = [];
  acp.events.on("sessionUpdate", (event: { params: Record<string, unknown> }) => {
    const { sessionId, update } = event.params;
    if (typeof sessionId !== "string" || !isRecord(update)) {
      return;
    }
    if (update.sessionUpdate === "usage_update" && typeof update.size === "number") {
      sizes.set(sessionId, update.size);
    }
    if (update.sessionUpdate === "user_message_chunk" && isRecord(update.content)) {
      history.push(String(update.content.text));
    }
  });
  try {
    const setup = await acp.newSession(directory, "long_context", {
      model: "gpt-6-luna", reasoning_effort: "low"
    });
    const session = { sessionId: setup.sessionId, cwd: directory };
    await acp.prompt(session, [{ type: "text", text: "first message" }]);
    assert.equal(sizes.get(session.sessionId), 872_000);

    await acp.loadSession(session, "long_context");
    await acp.setConfigOption(session, "model", "gpt-6-luna");
    await acp.prompt(session, [{ type: "text", text: "same model" }]);
    assert.equal(sizes.get(session.sessionId), 872_000);

    const switched = await acp.setConfigOption(session, "model", "claude-opus-5.5");
    assert.equal(switched.configOptions.find((option) => option.id === "model")?.currentValue, "claude-opus-5.5");
    assert.equal(switched.configOptions.find((option) => option.id === "reasoning_effort")?.currentValue, "low");
    assert.deepEqual(history, ["first message", "same model"]);
    await acp.prompt(session, [{ type: "text", text: "opus long" }]);
    assert.equal(sizes.get(session.sessionId), 968_000);

    await acp.loadSession(session, "default");
    await acp.prompt(session, [{ type: "text", text: "opus default" }]);
    assert.equal(sizes.get(session.sessionId), 200_000);
    await acp.loadSession(session, "long_context");
    await acp.prompt(session, [{ type: "text", text: "opus long again" }]);
    assert.equal(sizes.get(session.sessionId), 968_000);

    await assert.rejects(
      acp.prompt(session, [{ type: "text", text: "crash" }]),
      /Copilot ACP process exited with exit code 17/
    );
    await acp.prompt(session, [{ type: "text", text: "after crash" }]);
    assert.equal(sizes.get(session.sessionId), 968_000);
    assert.equal(acp.getConfigOptions(session.sessionId)
      .find((option) => option.id === "reasoning_effort")?.currentValue, "low");

    await acp.setConfigOption(session, "model", "gpt-6-luna");
    await acp.prompt(session, [{ type: "text", text: "back to luna" }]);
    assert.equal(sizes.get(session.sessionId), 872_000);
    const requests = (await readFile(path.join(directory, "tiered-requests.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.some((request) => (
      request.method === "session/set_model" ||
      (request.method === "session/set_config_option" && request.params.configId === "model")
    )), false);
  } finally {
    await acp.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses the selected model at startup and falls back only for incompatible reasoning", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-startup-context-test-"));
  const command = path.join(directory, "copilot-fake");
  await writeFile(command, tieredCopilot);
  await chmod(command, 0o700);
  const acp = new AcpConnectionManager({ command, cwd: directory, clientVersion: "test" });
  let size: unknown;
  acp.events.on("sessionUpdate", (event: { params: Record<string, unknown> }) => {
    if (isRecord(event.params.update) && event.params.update.sessionUpdate === "usage_update") {
      size = event.params.update.size;
    }
  });
  try {
    const setup = await acp.newSession(directory, "long_context", {
      model: "claude-opus-5.5", reasoning_effort: "max"
    });
    const session = { sessionId: setup.sessionId, cwd: directory };
    await acp.prompt(session, [{ type: "text", text: "first opus message" }]);
    assert.equal(size, 968_000);
    const options = await acp.setConfigOption(session, "model", "gpt-5.3-codex");
    assert.equal(options.configOptions.find((option) => option.id === "reasoning_effort")?.currentValue, "high");
    await assert.rejects(acp.setConfigOption(session, "model", "unknown"), /does not support model/);
    assert.equal(acp.getConfigOptions(session.sessionId)
      .find((option) => option.id === "model")?.currentValue, "gpt-5.3-codex");
  } finally {
    await acp.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the original session usable when switching profiles cannot load its history", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-profile-failure-test-"));
  const command = path.join(directory, "copilot-fake");
  await writeFile(command, tieredCopilot);
  await chmod(command, 0o700);
  const acp = new AcpConnectionManager({ command, cwd: directory, clientVersion: "test" });
  let size: unknown;
  acp.events.on("sessionUpdate", (event: { params: Record<string, unknown> }) => {
    if (isRecord(event.params.update) && event.params.update.sessionUpdate === "usage_update") {
      size = event.params.update.size;
    }
  });
  try {
    const setup = await acp.newSession(directory, "long_context", { model: "gpt-6-luna" });
    const session = { sessionId: setup.sessionId, cwd: directory };
    await acp.prompt(session, [{ type: "text", text: "persist history" }]);
    assert.equal(size, 872_000);

    await writeFile(path.join(directory, "fail-load"), "");
    await assert.rejects(
      acp.setConfigOption(session, "model", "claude-opus-5.5"),
      /Session load failed/
    );
    await acp.prompt(session, [{ type: "text", text: "continue on original profile" }]);
    assert.equal(size, 872_000);
    assert.equal(acp.getConfigOptions(session.sessionId)
      .find((option) => option.id === "model")?.currentValue, "gpt-6-luna");
  } finally {
    await acp.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes overlapping model, context, reasoning, and prompt changes without losing history", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-overlapping-profiles-test-"));
  const command = path.join(directory, "copilot-fake");
  await writeFile(command, tieredCopilot);
  await writeFile(path.join(directory, "load-delay-ms"), "30");
  await chmod(command, 0o700);
  const acp = new AcpConnectionManager({ command, cwd: directory, clientVersion: "test" });
  try {
    const setup = await acp.newSession(directory, "long_context", { model: "gpt-6-luna" });
    const session = { sessionId: setup.sessionId, cwd: directory };
    await acp.prompt(session, [{ type: "text", text: "first" }]);
    await Promise.all([
      acp.setConfigOption(session, "model", "claude-opus-5.5"),
      acp.setConfigOption(session, "model", "gpt-5.3-codex"),
      acp.prompt(session, [{ type: "text", text: "after concurrent switches" }])
    ]);
    await acp.setConfigOption(session, "model", "claude-opus-5.5");
    await acp.prompt(session, [{ type: "text", text: "after returning to opus" }]);
    await Promise.all([
      acp.setConfigOption(session, "reasoning_effort", "low"),
      acp.loadSession(session, "default"),
      acp.setConfigOption(session, "model", "gpt-6-luna"),
      acp.loadSession(session, "long_context"),
      acp.prompt(session, [{ type: "text", text: "after mixed changes" }])
    ]);
    const saved = JSON.parse(await readFile(path.join(directory, session.sessionId + ".json"), "utf8"));
    assert.deepEqual(saved.messages, [
      "first", "after concurrent switches", "after returning to opus", "after mixed changes"
    ]);
    assert.equal(saved.model, "gpt-6-luna");
    assert.equal(saved.context, "long_context");
    assert.equal(saved.reasoningEffort, "low");
  } finally {
    await acp.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recreates unprompted sessions on model and context changes without loading nonexistent history", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-empty-profiles-test-"));
  const command = path.join(directory, "copilot-fake");
  await writeFile(command, tieredCopilot);
  await chmod(command, 0o700);
  const acp = new AcpConnectionManager({ command, cwd: directory, clientVersion: "test" });
  let size: unknown;
  acp.events.on("sessionUpdate", (event: { params: Record<string, unknown> }) => {
    if (isRecord(event.params.update) && event.params.update.sessionUpdate === "usage_update") {
      size = event.params.update.size;
    }
  });
  try {
    const setup = await acp.newSession(directory, "long_context", {
      model: "gpt-6-luna", reasoning_effort: "low"
    });
    const original = { sessionId: setup.sessionId, cwd: directory };
    assert.equal((await acp.setConfigOption(original, "model", "gpt-6-luna")).sessionId, setup.sessionId);
    const opus = await acp.setConfigOption(original, "model", "claude-opus-5.5");
    assert.notEqual(opus.sessionId, setup.sessionId);
    assert.equal(opus.configOptions.find((option) => option.id === "reasoning_effort")?.currentValue, "low");
    const defaultContext = await acp.loadSession({ ...original, sessionId: opus.sessionId }, "default");
    assert.notEqual(defaultContext.sessionId, opus.sessionId);
    const longContext = await acp.loadSession({ ...original, sessionId: defaultContext.sessionId }, "long_context");
    assert.notEqual(longContext.sessionId, defaultContext.sessionId);
    const session = { ...original, sessionId: longContext.sessionId };
    await acp.prompt(session, [{ type: "text", text: "first message" }]);
    assert.equal(size, 968_000);
    const saved = JSON.parse(await readFile(path.join(directory, session.sessionId + ".json"), "utf8"));
    assert.deepEqual(saved.messages, ["first message"]);
    assert.equal(saved.model, "claude-opus-5.5");
    assert.equal(saved.reasoningEffort, "low");
    const requests = (await readFile(path.join(directory, "tiered-requests.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.some((request) => request.method === "session/load"), false);
    assert.deepEqual(requests.filter((request) => request.method === "session/close")
      .map((request) => request.params.sessionId), [
      setup.sessionId, opus.sessionId, defaultContext.sessionId
    ]);
    assert.equal(acp.getSessionContext(original.sessionId), undefined);
    await assert.rejects(acp.prompt(original, [{ type: "text", text: "stale session" }]), /was replaced/);
  } finally {
    await acp.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps an empty session usable if its replacement cannot be created", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-empty-profile-failure-test-"));
  const command = path.join(directory, "copilot-fake");
  await writeFile(command, tieredCopilot);
  await chmod(command, 0o700);
  const acp = new AcpConnectionManager({ command, cwd: directory, clientVersion: "test" });
  try {
    const setup = await acp.newSession(directory, "long_context", { model: "gpt-6-luna" });
    const session = { sessionId: setup.sessionId, cwd: directory };
    await writeFile(path.join(directory, "fail-new"), "");
    await assert.rejects(
      acp.setConfigOption(session, "model", "claude-opus-5.5"), /Session creation failed/
    );
    await acp.prompt(session, [{ type: "text", text: "continue on original" }]);
    const saved = JSON.parse(await readFile(path.join(directory, session.sessionId + ".json"), "utf8"));
    assert.deepEqual(saved.messages, ["continue on original"]);
    assert.equal(saved.model, "gpt-6-luna");
  } finally {
    await acp.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("allows cancellation and permission responses while a profile change waits for a prompt", async () => {
  for (const action of ["permission", "cancel"]) {
    const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-profile-prompt-wait-test-"));
    const command = path.join(directory, "copilot-fake");
    await writeFile(command, tieredCopilot);
    await chmod(command, 0o700);
    const acp = new AcpConnectionManager({ command, cwd: directory, clientVersion: "test" });
    try {
      const setup = await acp.newSession(directory, "long_context", { model: "gpt-6-luna" });
      const session = { sessionId: setup.sessionId, cwd: directory };
      await acp.prompt(session, [{ type: "text", text: "persist history" }]);
      const ready = new Promise<void>((resolve) => acp.events.once("permissionRequest", () => resolve()));
      const prompt = acp.prompt(session, [{ type: "text", text: "permission" }]);
      await ready;
      const change = acp.setConfigOption(session, "model", "claude-opus-5.5");
      if (action === "cancel") {
        await acp.cancel(session.sessionId);
      } else {
        await acp.respondToPermission("long_context", 500, { outcome: "selected", optionId: "allow" }, session.sessionId);
      }
      assert.equal(await prompt, action === "cancel" ? "cancelled" : "end_turn");
      await change;
      const controller = new AbortController();
      const contextChange = acp.loadSession(session, "default");
      const cancelledPrompt = acp.prompt(session, [{ type: "text", text: "never sent" }], controller.signal);
      controller.abort();
      await contextChange;
      assert.equal(await cancelledPrompt, "cancelled");
      await acp.prompt(session, [{ type: "text", text: "after change" }]);
      const saved = JSON.parse(await readFile(path.join(directory, session.sessionId + ".json"), "utf8"));
      assert.deepEqual(saved.messages, action === "cancel"
        ? ["persist history", "after change"]
        : ["persist history", "permission", "after change"]);
    } finally {
      await acp.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("rejects queued profile changes on shutdown without restarting the CLI", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-profile-shutdown-test-"));
  const command = path.join(directory, "copilot-fake");
  await writeFile(command, tieredCopilot);
  await chmod(command, 0o700);
  const acp = new AcpConnectionManager({ command, cwd: directory, clientVersion: "test" });
  try {
    const setup = await acp.newSession(directory, "long_context", { model: "gpt-6-luna" });
    const session = { sessionId: setup.sessionId, cwd: directory };
    await acp.prompt(session, [{ type: "text", text: "persist history" }]);
    const ready = new Promise<void>((resolve) => acp.events.once("permissionRequest", () => resolve()));
    const prompt = acp.prompt(session, [{ type: "text", text: "permission" }]);
    await ready;
    const change = acp.setConfigOption(session, "model", "claude-opus-5.5");
    const promptRejected = assert.rejects(prompt, /ACP connection stopped/);
    const changeRejected = assert.rejects(change, /ACP connection manager stopped/);
    await acp.stop();
    await Promise.all([promptRejected, changeRejected]);
    const requests = (await readFile(path.join(directory, "tiered-requests.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.filter((request) => request.method === "initialize").length, 1);
  } finally {
    await acp.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes permission responses to the session's model profile despite colliding request ids", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-profile-permissions-test-"));
  const command = path.join(directory, "copilot-fake");
  await writeFile(command, tieredCopilot);
  await chmod(command, 0o700);
  const acp = new AcpConnectionManager({ command, cwd: directory, clientVersion: "test" });
  try {
    const luna = await acp.newSession(directory, "long_context", { model: "gpt-6-luna" });
    const opus = await acp.newSession(directory, "long_context", { model: "claude-opus-5.5" });
    const permissions: string[] = [];
    let received: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { received = resolve; });
    acp.events.on("permissionRequest", (event: { requestId: unknown; params: Record<string, unknown> }) => {
      assert.equal(event.requestId, 500);
      permissions.push(String(event.params.sessionId));
      if (permissions.length === 2) {
        received?.();
      }
    });

    const lunaPrompt = acp.prompt(
      { sessionId: luna.sessionId, cwd: directory }, [{ type: "text", text: "permission" }]
    );
    const opusPrompt = acp.prompt(
      { sessionId: opus.sessionId, cwd: directory }, [{ type: "text", text: "permission" }]
    );
    await ready;
    await acp.respondToPermission("long_context", 500, { outcome: "cancelled" }, opus.sessionId);
    assert.equal(await opusPrompt, "end_turn");
    await acp.respondToPermission(
      "long_context", 500, { outcome: "selected", optionId: "allow" }, luna.sessionId
    );
    assert.equal(await lunaPrompt, "end_turn");
    await assert.rejects(
      acp.respondToPermission("default", 500, { outcome: "cancelled" }, luna.sessionId),
      /no longer pending/
    );
  } finally {
    await acp.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
