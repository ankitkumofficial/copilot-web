import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpConnectionManager, isRecord } from "./acp.js";

const fakeCopilot = `#!/usr/bin/env node
const readline = require("node:readline");
const sessions = new Map();
let nextSessionId = 0;

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
    case "session/set_config_option": {
      const session = sessions.get(request.params.sessionId);
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
    default:
      respond({});
  }
});
`;

test("previews model-specific reasoning options and falls back only for defaults", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-acp-test-"));
  const command = path.join(directory, "copilot-fake");
  await writeFile(command, fakeCopilot);
  await chmod(command, 0o700);

  const acp = new AcpConnectionManager({
    command,
    cwd: directory,
    clientVersion: "test"
  });
  try {
    const preview = await acp.discoverConfig("default", "gpt-5.3-codex");
    const reasoning = preview.configOptions.find((option) => option.id === "reasoning_effort");
    assert.equal(reasoning?.currentValue, "high");
    const reasoningOptions = Array.isArray(reasoning?.options) ? reasoning.options : [];
    assert.deepEqual(
      reasoningOptions
        .filter(isRecord)
        .map((option) => option.value),
      ["low", "high"]
    );

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
