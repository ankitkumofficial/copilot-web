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
let nextSessionId = 0;
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
        sessionId: "session-" + (++nextSessionId),
        model: "gpt-6-luna"
      };
      sessions.set(session.sessionId, session);
      respond({ sessionId: session.sessionId, configOptions: configOptions(session) });
      break;
    }
    case "session/load": {
      const session = {
        sessionId: request.params.sessionId,
        model: "gpt-6-luna"
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
      ["--context", "default", "--acp", "--no-color"]
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
      ["--context", "long_context", "--acp", "--no-color"]
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
