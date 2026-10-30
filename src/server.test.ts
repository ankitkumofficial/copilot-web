import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const nativeMessages = process.env.TEST_NATIVE_MESSAGES === "true";
let nativeSessionCounter = process.env.TEST_EXISTING_SESSION === "true" ? 1 : 0;
const nativeHistoryPath = path.join(process.cwd(), "native-history.json");
const nativeTimestamp = process.env.TEST_NATIVE_TIMESTAMP ?? "2026-10-14T10:00:00.000Z";
const pendingNativePrompts = new Map();
let streamThoughts = true;
const sessionFile = (id) => path.join(process.cwd(), "profile-session-" + id + ".json");
if (args.includes("-i")) {
  fs.appendFileSync(
    path.join(process.cwd(), "copilot-native-cli-requests.log"),
    JSON.stringify(args) + "\\n"
  );
  process.exit(0);
}
const configOptions = (session) => profiles ? [
  {
    id: "model", type: "select", category: "model", currentValue: session.model,
    options: [
      { value: "gpt-6-luna", name: "GPT-6 Luna" },
      { value: "claude-opus-5.5", name: "Claude Opus 5.5" },
      { value: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" }
    ]
  },
  {
    id: "reasoning_effort", type: "select", category: "thought_level",
    currentValue: session.reasoningEffort,
    options: ["low", "medium", "max"].map((value) => ({ value, name: value }))
  }
] : [];
function createNativeEvent(type, messageId, data, offset = 0) {
  return {
    id: require("node:crypto").randomUUID(),
    type,
    timestamp: new Date(Date.parse(nativeTimestamp) + offset).toISOString(),
    parentId: null,
    data: { messageId, ...data }
  };
}
function persistNativeEvent(sessionId, event) {
  let history = {};
  try {
    history = JSON.parse(fs.readFileSync(nativeHistoryPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  history[sessionId] ??= [];
  history[sessionId].push(event);
  fs.writeFileSync(nativeHistoryPath, JSON.stringify(history));
}
function readNativeHistory(sessionId) {
  try {
    const history = JSON.parse(fs.readFileSync(nativeHistoryPath, "utf8"));
    return Array.isArray(history[sessionId]) ? history[sessionId] : [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
}
function replayNativeHistoryThroughAcp(sessionId, update) {
  let firstUser = true;
  for (const event of readNativeHistory(sessionId)) {
    if (event.agentId || event.data?.testAcpHidden) continue;
    if (event.type === "user.message") {
      update(sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: event.data.content }
      });
      for (const attachment of event.data.attachments ?? []) {
        if (attachment.data && attachment.mimeType?.startsWith("image/")) {
          update(sessionId, {
            sessionUpdate: "user_message_chunk",
            content: { type: "image", data: attachment.data, mimeType: attachment.mimeType }
          });
        }
      }
      if (firstUser) {
        firstUser = false;
        update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "history-tool",
          title: "History lookup",
          kind: "read",
          status: "completed"
        });
      }
    } else if (event.type === "assistant.message") {
      if (event.data.content) {
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.data.content }
        });
      } else if (event.data.testAcpEmptyMessage) {
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          messageId: event.data.messageId,
          content: { type: "text", text: "" }
        });
      }
      for (const toolRequest of event.data.toolRequests ?? []) {
        update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: toolRequest.toolCallId,
          title: toolRequest.name,
          kind: "read",
          status: "completed"
        });
      }
    }
  }
}
function emitNativeEvent(sessionId, event, persist = false, duplicate = false) {
  if (persist) persistNativeEvent(sessionId, event);
  // Like the CLI, live ACP session events omit the persisted event id and parent id.
  const { id: _id, parentId: _parentId, ...liveEvent } = event;
  const encoded = JSON.stringify({
    jsonrpc: "2.0",
    method: "github.com/copilot/sessionEvent",
    params: { sessionId, ...liveEvent }
  }) + "\\n";
  process.stdout.write(encoded);
  if (duplicate) process.stdout.write(encoded);
}
function emitNativePrompt(request, sessionId, reply) {
  const prompt = request.params.prompt;
  const promptText = prompt.find((block) => block.type === "text")?.text ?? "";
  const reasoningText = promptText === "stream-progress"
    ? "Live reasoning: checking the request."
    : promptText === "evicted-thinking"
      ? "First preserved reasoning. Last reasoning fragment."
    : undefined;
  const userMessageId = require("node:crypto").randomUUID();
  const assistantMessageId = require("node:crypto").randomUUID();
  const attachments = prompt.flatMap((block) => {
    if (block.type === "image") {
      return [{
        type: "blob",
        displayName: "prompt-image.png",
        mimeType: block.mimeType,
        data: block.data
      }];
    }
    if (block.type === "resource") {
      // Like the CLI, persist embedded resources only as references to deleted temp files.
      return [{
        type: "file",
        path: "/tmp/acp-resource-test.bin",
        displayName: block.resource.uri.replace(/[^A-Za-z0-9.-]/g, "_")
      }];
    }
    return [];
  });
  emitNativeEvent(sessionId, createNativeEvent("user.message", userMessageId, {
    content: promptText,
    attachments
  }, 0), true);
  emitNativeEvent(sessionId, createNativeEvent(
    "assistant.message_start",
    assistantMessageId,
    {},
    100
  ));
  return {
    assistantMessageId,
    delta: createNativeEvent("assistant.message_delta", assistantMessageId, {
      deltaContent: reply
    }, 200),
    final: createNativeEvent("assistant.message", assistantMessageId, {
      content: reply,
      ...(reasoningText === undefined ? {} : { reasoningText })
    }, 300)
  };
}
let startCount = 1;
try {
  startCount = Number(fs.readFileSync(startCountFile, "utf8")) + 1;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
fs.writeFileSync(startCountFile, String(startCount));
if (nativeMessages && startCount > 1) {
  try {
    for (const id of Object.keys(JSON.parse(fs.readFileSync(nativeHistoryPath, "utf8")))) {
      const match = /^session-(\\d+)$/.exec(id);
      if (match) nativeSessionCounter = Math.max(nativeSessionCounter, Number(match[1]));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(requestLogFile, JSON.stringify({
    method: request.method,
    text: request.params?.prompt?.[0]?.text,
    ...(profiles || nativeMessages ? { sessionId: request.params?.sessionId } : {}),
    ...(profiles ? { model: startupModel, context } : {}),
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
    case "initialize": {
      const events = request.params?.clientCapabilities?._meta?.["github.com/copilot"]?.events ?? [];
      // Like the CLI, native message events suppress ACP thought chunks unless reasoning is requested.
      streamThoughts = !events.includes("assistant.message") ||
        events.includes("assistant.reasoning_delta");
      respond({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { close: true, delete: false, list: true }
        }
      });
      break;
    }
    case "session/new": {
      const sessionId = profiles ? require("node:crypto").randomUUID()
        : nativeMessages ? "session-" + (++nativeSessionCounter) : "session-1";
      const session = {
        sessionId, model: startupModel ?? "gpt-6-luna", context,
        reasoningEffort: "max", messages: []
      };
      sessions.set(sessionId, session);
      commands(sessionId);
      setTimeout(() => respond({ sessionId, configOptions: configOptions(session) }),
        Number(process.env.TEST_CREATION_DELAY_MS ?? 0));
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
      if (nativeMessages) {
        replayNativeHistoryThroughAcp(request.params.sessionId, update);
        if (process.env.TEST_NATIVE_REPLAY === "true") {
          for (const event of readNativeHistory(request.params.sessionId)) {
            emitNativeEvent(request.params.sessionId, event);
          }
        }
      } else {
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
      }
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
      const reply = reload
        ? "MCP configuration reloaded and servers restarted."
        : request.params.prompt[0]?.text === "acp-only-reply" ? "OKOK"
        : "Done.";
      // Like the CLI, commands such as /mcp reload record and emit no native messages.
      const nativeEvents = nativeMessages && !reload
        ? emitNativePrompt(request, request.params.sessionId, reply)
        : null;
      if (request.params.prompt[0]?.text === "evicted-thinking") {
        update(request.params.sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "First preserved reasoning. " }
        });
        update(request.params.sessionId, {
          sessionUpdate: "tool_call", toolCallId: "eviction-tool",
          title: "Large tool result", status: "completed",
          content: { type: "text", text: "x".repeat(600_000) }
        });
        update(request.params.sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Last reasoning fragment." }
        });
      } else if (request.params.prompt[0]?.text === "stream-progress") {
        const thought = (text) => {
          if (streamThoughts) {
            update(request.params.sessionId, {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text }
            });
          }
        };
        thought("Live reasoning: checking ");
        thought("the request.");
        update(request.params.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "live-history-inspection",
          title: "Inspect live history",
          kind: "read",
          status: "in_progress"
        });
        setTimeout(() => {
          update(request.params.sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "live-history-inspection",
            title: "Inspect live history",
            status: "completed",
            content: [{
              type: "content",
              content: { type: "text", text: "Inspection complete" }
            }]
          });
          // An empty reply between tool rounds must not split continuous reasoning.
          update(request.params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "" }
          });
          thought("Second round reasoning.");
        }, 500);
      } else if (request.params.prompt[0]?.text === "interleaved-rounds" ||
          request.params.prompt[0]?.text === "crossed-tool-update" ||
          request.params.prompt[0]?.text === "streaming-crossed-tool-update") {
        const crossedToolUpdate = request.params.prompt[0].text !== "interleaved-rounds";
        const streamingIntermediate = request.params.prompt[0].text === "streaming-crossed-tool-update";
        let secondRoundStarted = false;
        const thought = (text) => {
          if (streamThoughts) {
            update(request.params.sessionId, {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text }
            });
          }
        };
        const tool = (toolCallId, title, status) => update(request.params.sessionId, {
          sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update",
          toolCallId,
          title,
          kind: "read",
          status
        });
        thought("Round one: ");
        thought("inspect the code.");
        tool("round-one-tool", "Inspect code", "in_progress");
        const startSecondRound = () => {
          if (fs.existsSync(path.join(process.cwd(), "hold-tool-round"))) {
            setTimeout(startSecondRound, 20);
            return;
          }
          secondRoundStarted = true;
          if (!crossedToolUpdate) {
            tool("round-one-tool", "Inspect code", "completed");
          }
          if (nativeMessages) {
            if (streamingIntermediate) {
              emitNativeEvent(request.params.sessionId, createNativeEvent(
                "assistant.message_start", "intermediate-assistant", {}, 120
              ));
              for (const [index, character] of [..."Intermediate update."].entries()) {
                emitNativeEvent(request.params.sessionId, createNativeEvent(
                  "assistant.message_delta", "intermediate-assistant", { deltaContent: character }, 125 + index
                ));
              }
            }
            emitNativeEvent(request.params.sessionId, createNativeEvent(
              "assistant.message",
              "intermediate-assistant",
              {
                content: "Intermediate update.",
                reasoningText: "Round one: inspect the code.",
                toolRequests: [{ toolCallId: "round-two-tool", name: "Run tests" }]
              },
              150
            ), true);
          }
          update(request.params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Intermediate update." }
          });
          thought("Round two: run the tests.");
          if (crossedToolUpdate) {
            tool("round-one-tool", "Inspect code", "completed");
          }
          tool("round-two-tool", "Run tests", "in_progress");
        };
        setTimeout(startSecondRound, 300);
        const completeSecondTool = () => {
          if (!secondRoundStarted || fs.existsSync(path.join(process.cwd(), "hold-tool-round")) ||
              fs.existsSync(path.join(process.cwd(), "hold-tool-completion"))) {
            setTimeout(completeSecondTool, 20);
            return;
          }
          tool("round-two-tool", "Run tests", "completed");
        };
        setTimeout(completeSecondTool, 700);
      }
      const delay = reload
        ? Number(process.env.TEST_MCP_RELOAD_DELAY_MS ?? 200)
        : Number(process.env.TEST_PROMPT_DELAY_MS ?? 20);
      const finishPrompt = () => {
        if (fs.existsSync(path.join(process.cwd(), "hold-prompt-completion"))) {
          const deferred = setTimeout(finishPrompt, 20);
          const pending = pendingNativePrompts.get(request.params.sessionId);
          if (pending) pending.timer = deferred;
          return;
        }
        pendingNativePrompts.delete(request.params.sessionId);
        const emitAicUsage = (totalNanoAiu) => emitNativeEvent(request.params.sessionId, {
          id: require("node:crypto").randomUUID(),
          parentId: null,
          type: "assistant.usage",
          timestamp: new Date().toISOString(),
          data: { copilotUsage: { totalNanoAiu } }
        });
        for (let index = 0; index < Number(process.env.TEST_AIC_USAGE_EVENTS ?? 0); index++) {
          emitAicUsage(1_000_000_000);
        }
        if (process.env.TEST_AIC_NOOP_USAGE_EVENT === "true") {
          emitAicUsage(0);
        }
        if (nativeEvents && request.params.prompt[0]?.text !== "acp-only-reply") {
          emitNativeEvent(request.params.sessionId, nativeEvents.delta);
          // A repeated final event must stay idempotent.
          emitNativeEvent(request.params.sessionId, nativeEvents.final, true, true);
        }
        for (const text of request.params.prompt[0]?.text === "acp-only-reply" ? ["OK", "OK"] : [reply]) {
          update(request.params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          });
        }
        const respondWhenReady = () => {
          if (fs.existsSync(path.join(process.cwd(), "hold-prompt-response"))) {
            setTimeout(respondWhenReady, 20);
            return;
          }
          respond({ stopReason: "end_turn" });
        };
        respondWhenReady();
      };
      const timer = setTimeout(finishPrompt, delay);
      if (nativeEvents) {
        pendingNativePrompts.set(request.params.sessionId, {
          timer,
          requestId: request.id,
          assistantMessageId: nativeEvents.assistantMessageId
        });
      }
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
      if (nativeMessages) {
        const pendingPrompt = pendingNativePrompts.get(request.params.sessionId);
        if (pendingPrompt) {
          clearTimeout(pendingPrompt.timer);
          pendingNativePrompts.delete(request.params.sessionId);
          emitNativeEvent(
            request.params.sessionId,
            createNativeEvent(
              "assistant.message_delta",
              pendingPrompt.assistantMessageId,
              { deltaContent: "Partial response before cancellation." },
              200
            )
          );
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: pendingPrompt.requestId,
            result: { stopReason: "cancelled" }
          }) + "\\n");
        }
      }
      break;
    case "session/list":
      if (profiles) {
        respond({ sessions: fs.readdirSync(process.cwd())
          .filter((name) => name.startsWith("profile-session-") && name.endsWith(".json"))
          .map((name) => {
            const session = JSON.parse(fs.readFileSync(path.join(process.cwd(), name), "utf8"));
            return { sessionId: session.sessionId, cwd: process.cwd(), title: "Profile conversation" };
          })
          .filter((session) => !fs.existsSync(path.join(process.cwd(), "unlisted-" + session.sessionId))) });
        break;
      }
      if (nativeMessages) {
        let history = {};
        try {
          history = JSON.parse(fs.readFileSync(nativeHistoryPath, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const ids = new Set(Object.keys(history));
        respond({ sessions: [...ids].map((sessionId) => ({
          sessionId, cwd: process.cwd(), title: "Unavailable tools"
        })) });
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

const fakeGitHubCli = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(
  process.env.TEST_GH_LOG,
  JSON.stringify(process.argv.slice(2)) + "\\n"
);
if (process.env.TEST_GH_MODE === "success") {
  process.stdout.write(JSON.stringify({ used: 12.06, total: 300 }) + "\\n");
} else {
  process.stderr.write("gh auth login required\\n");
  process.exitCode = 1;
}
`;

const fakeCopilotSdk = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RuntimeConnection = {
  forStdio(options) {
    return options;
  }
};

export class CopilotClient {
  constructor(options) {
    this.options = options;
    writeFileSync(
      path.join(options.workingDirectory, "native-sdk-connection.json"),
      JSON.stringify({
        path: options.connection.path,
        args: options.connection.args,
        workingDirectory: options.workingDirectory
      })
    );
    this.rpc = {
      sessions: {
        readPersistedEvents: async ({ sessionId, cursor, max, direction }) => {
          const requestPath = path.join(options.workingDirectory, "native-history-requests.jsonl");
          appendFileSync(requestPath, JSON.stringify({ sessionId, cursor, ...(direction ? { direction, max } : {}) }) + "\\n");
          if (process.env.TEST_HISTORY_UNSUPPORTED === "true") {
            const error = new Error("Method not found: sessions.readPersistedEvents");
            error.code = -32601;
            throw error;
          }
          let historyReadFailed = process.env.TEST_HISTORY_READ_ERROR === "true";
          try {
            readFileSync(path.join(options.workingDirectory, "native-history-failure.flag"), "utf8");
            historyReadFailed = true;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          if (sessionId === "session-1" && historyReadFailed) {
            throw new Error("Persisted event journal is unavailable for session session-1");
          }
          const historyPath = path.join(options.workingDirectory, "native-history.json");
          let history = {};
          try {
            history = JSON.parse(readFileSync(historyPath, "utf8"));
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          const events = (history[sessionId] ?? []).filter((event) => !event.data?.testNativeHidden);
          const backwards = direction === "backward";
          const offset = cursor === undefined
            ? (backwards ? events.length : 0)
            : Number(cursor);
          if (cursor !== undefined && process.env.TEST_HISTORY_CURSOR_EXPIRED === "true") {
            return { events: [], cursor: "", cursorStatus: "expired", hasMore: false };
          }
          const pageSize = Math.min(max ?? 200, Number(process.env.TEST_HISTORY_PAGE_SIZE ?? 200));
          const pageEvents = backwards
            ? events.slice(Math.max(0, offset - pageSize), offset)
            : events.slice(offset, offset + pageSize);
          const nextOffset = backwards ? offset - pageEvents.length : offset + pageEvents.length;
          const hasMore = backwards ? nextOffset > 0 : nextOffset < events.length;
          if (sessionId === "session-1" && process.env.TEST_HISTORY_READ_DELAY_MS) {
            await new Promise((resolve) => setTimeout(
              resolve,
              Number(process.env.TEST_HISTORY_READ_DELAY_MS)
            ));
          }
          return {
            events: pageEvents,
            cursor: hasMore ? String(nextOffset) : "",
            cursorStatus: "ok",
            hasMore
          };
        }
      }
    };
  }

  async start() {}
  async stop() {}
}
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

const resourceCleanups = new WeakMap<TestContext, Array<() => Promise<void>>>();

function registerResourceCleanup(t: TestContext, cleanup: () => Promise<void>) {
  let cleanups = resourceCleanups.get(t);
  if (!cleanups) {
    const stack: Array<() => Promise<void>> = [];
    cleanups = stack;
    resourceCleanups.set(t, cleanups);
    t.after(async () => {
      const errors: unknown[] = [];
      // Release dependent resources (the browser) before their server.
      for (const dispose of [...stack].reverse()) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Test resource cleanup failed");
      }
    });
  }
  cleanups.push(cleanup);
}

async function startTestServer(t: TestContext, options: {
  advertiseMcp?: boolean;
  failReload?: boolean;
  existingSession?: boolean;
  commandDelayMs?: number;
  creationDelayMs?: number;
  missingCommandMetadata?: boolean;
  loadDelayMs?: number;
  failRecoveryLoads?: boolean;
  profileSessions?: boolean;
  promptDelayMs?: number;
  reloadDelayMs?: number;
  historyText?: string;
  context?: "default" | "long_context";
  nativeSessionDelete?: boolean;
  quotaCommand?: "success" | "failure" | "missing";
  aicUsageEvents?: number;
  aicNoopUsageEvent?: boolean;
  sessionActivity?: Record<string, string>;
  nativeMessages?: boolean;
  nativeReplay?: boolean;
  nativeHistory?: {
    events?: JsonObject[];
    pageSize?: number;
    readDelayMs?: number;
    readError?: boolean;
    cursorExpired?: boolean;
    unsupported?: boolean;
    timestamp?: string;
  };
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-server-reconnect-test-"));
  const home = path.join(directory, "home");
  const projects = path.join(directory, "projects");
  const copilotHome = path.join(home, ".copilot");
  const copilotSdk = path.join(directory, "copilot-sdk");
  const fakeCommand = path.join(directory, "copilot-fake");
  const fakeGitHubCommand = path.join(directory, "gh-fake");
  const githubCliLogPath = path.join(projects, "gh-requests.log");
  const port = await unusedPort();
  await mkdir(home);
  await mkdir(projects);
  await mkdir(copilotHome);
  if (options.sessionActivity) {
    await mkdir(path.join(home, ".copilot-web"));
    await writeFile(path.join(home, ".copilot-web", "session-activity.json"),
      JSON.stringify(options.sessionActivity));
  }
  await writeFile(fakeCommand, fakeCopilot);
  await chmod(fakeCommand, 0o700);
  await writeFile(fakeGitHubCommand, fakeGitHubCli);
  await chmod(fakeGitHubCommand, 0o700);
  if (options.nativeHistory) {
    await mkdir(copilotSdk);
    await writeFile(path.join(copilotSdk, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(path.join(copilotSdk, "index.js"), fakeCopilotSdk);
    await writeFile(
      path.join(projects, "native-history.json"),
      JSON.stringify({ "session-1": options.nativeHistory.events ?? [] })
    );
  }

  const serverEntry = fileURLToPath(new URL("./server.js", import.meta.url));
  const child = spawn(process.execPath, [serverEntry], {
    cwd: directory,
    env: {
      ...process.env,
      HOME: home,
      COPILOT_HOME: copilotHome,
      COPILOT_PROJECTS_DIR: projects,
      COPILOT_BIN: fakeCommand,
      GH_BIN: options.quotaCommand === "missing"
        ? path.join(directory, "gh-not-installed")
        : fakeGitHubCommand,
      COPILOT_ALLOW_ALL: "false",
      COPILOT_SDK_PATH: options.nativeHistory
        ? path.join(copilotSdk, "index.js")
        : "",
      COPILOT_NATIVE_SESSION_DELETE: String(options.nativeSessionDelete ?? false),
      TEST_MCP_COMMAND: String(options.advertiseMcp ?? true),
      TEST_MCP_RELOAD_ERROR: String(options.failReload ?? false),
      TEST_COMMAND_DELAY_MS: String(options.commandDelayMs ?? 0),
      TEST_CREATION_DELAY_MS: String(options.creationDelayMs ?? 0),
      TEST_COMMAND_METADATA: options.missingCommandMetadata ? "missing" : "available",
      TEST_LOAD_DELAY_MS: String(options.loadDelayMs ?? 0),
      TEST_FAIL_RECOVERY_LOADS: String(options.failRecoveryLoads ?? false),
      TEST_PROFILE_SESSIONS: String(options.profileSessions ?? false),
      TEST_NATIVE_MESSAGES: String(options.nativeMessages ?? false),
      TEST_EXISTING_SESSION: String(options.existingSession ?? false),
      TEST_NATIVE_REPLAY: String(options.nativeReplay ?? false),
      TEST_NATIVE_TIMESTAMP: options.nativeHistory?.timestamp ?? "2026-10-14T10:00:00.000Z",
      TEST_HISTORY_PAGE_SIZE: String(options.nativeHistory?.pageSize ?? 200),
      TEST_GH_LOG: githubCliLogPath,
      TEST_GH_MODE: options.quotaCommand === "success" ? "success" : "failure",
      TEST_AIC_USAGE_EVENTS: String(options.aicUsageEvents ?? 0),
      TEST_AIC_NOOP_USAGE_EVENT: String(options.aicNoopUsageEvent ?? false),
      TEST_HISTORY_READ_DELAY_MS: String(options.nativeHistory?.readDelayMs ?? 0),
      TEST_HISTORY_READ_ERROR: String(options.nativeHistory?.readError ?? false),
      TEST_HISTORY_CURSOR_EXPIRED: String(options.nativeHistory?.cursorExpired ?? false),
      TEST_HISTORY_UNSUPPORTED: String(options.nativeHistory?.unsupported ?? false),
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

  registerResourceCleanup(t, async () => {
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
    sessionListed: async (id: string, listed: boolean) => {
      const marker = path.join(projects, `unlisted-${id}`);
      if (listed) {
        await rm(marker, { force: true });
      } else {
        await writeFile(marker, "");
      }
    },
    pausePromptCompletion: async (paused: boolean) => {
      const marker = path.join(projects, "hold-prompt-completion");
      if (paused) {
        await writeFile(marker, "");
      } else {
        await rm(marker, { force: true });
      }
    },
    pauseToolRound: async (paused: boolean) => {
      const marker = path.join(projects, "hold-tool-round");
      if (paused) {
        await writeFile(marker, "");
      } else {
        await rm(marker, { force: true });
      }
    },
    pauseToolCompletion: async (paused: boolean) => {
      const marker = path.join(projects, "hold-tool-completion");
      if (paused) {
        await writeFile(marker, "");
      } else {
        await rm(marker, { force: true });
      }
    },
    pausePromptResponse: async (paused: boolean) => {
      const marker = path.join(projects, "hold-prompt-response");
      if (paused) {
        await writeFile(marker, "");
      } else {
        await rm(marker, { force: true });
      }
    },
    copilotSettings: (settings: JsonObject) => writeFile(
      path.join(copilotHome, "settings.json"),
      JSON.stringify(settings)
    ),
    attachmentsDirectory: path.join(home, ".copilot-web", "attachments"),
    metadata: (name: string) => readFile(path.join(home, ".copilot-web", name), "utf8")
      .then((content) => JSON.parse(content) as unknown),
    nativeHistory: () => readFile(path.join(projects, "native-history.json"), "utf8")
      .then((content) => JSON.parse(content) as unknown),
    historyReads: () => readFile(path.join(projects, "native-history-requests.jsonl"), "utf8")
      .then((content) => content.trim().split("\n").map((line) => JSON.parse(line) as unknown))
      .catch((error: unknown) => {
        if (isRecord(error) && error.code === "ENOENT") return [];
        throw error;
      }),
    historyReadFailure: async (enabled: boolean) => {
      const failurePath = path.join(projects, "native-history-failure.flag");
      if (enabled) {
        await writeFile(failurePath, "unavailable");
      } else {
        await rm(failurePath, { force: true });
      }
    },
    sdkConnection: () => readFile(path.join(projects, "native-sdk-connection.json"), "utf8")
      .then((content) => JSON.parse(content) as unknown),
    removeSdk: () => rm(path.join(copilotSdk, "index.js"), { force: true }),
    async nativeCliRequests(): Promise<string[][]> {
      try {
        const log = await readFile(
          path.join(projects, "copilot-native-cli-requests.log"),
          "utf8"
        );
        return log.trim().split("\n").filter(Boolean).map((line) => {
          const request: unknown = JSON.parse(line);
          assert.ok(Array.isArray(request));
          return request.map((argument: unknown) => {
            assert.equal(typeof argument, "string");
            return String(argument);
          });
        });
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return [];
        throw error;
      }
    },
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
    async githubCliRequests(): Promise<string[][]> {
      try {
        const log = await readFile(githubCliLogPath, "utf8");
        return log.trim().split("\n").filter(Boolean).map((line) => {
          const request: unknown = JSON.parse(line);
          assert.ok(Array.isArray(request));
          return request.map((argument: unknown) => {
            assert.equal(typeof argument, "string");
            return String(argument);
          });
        });
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return [];
        throw error;
      }
    },
    post: (subroute: string, body: JsonObject, id = sessionId) => fetch(
      `${baseUrl}/api/sessions/${id}/${subroute}`,
      { method: "POST", headers, body: JSON.stringify(body) }
    )
  };
}

test("retrieves account quota through the authenticated GitHub CLI", async (t) => {
  const server = await startTestServer(t, { quotaCommand: "success" });
  const response = await fetch(`${server.baseUrl}/api/quota`, { headers: server.headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { used: 12.06, total: 300 });
  assert.deepEqual(await server.githubCliRequests(), [[
    "api",
    "-H",
    "X-GitHub-Api-Version: 2025-04-01",
    "/copilot_internal/user",
    "--jq",
    "(.quota_snapshots.premium_models // .quota_snapshots.premium_interactions) as $q | {used: ($q.entitlement - $q.remaining), total: $q.entitlement}"
  ]]);
});

for (const quotaCommand of ["failure", "missing"] as const) {
  test(`reports an unavailable quota when gh is ${quotaCommand}`, async (t) => {
    const server = await startTestServer(t, { quotaCommand });
    const response = await fetch(`${server.baseUrl}/api/quota`, { headers: server.headers });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "GitHub CLI (gh) not available or not authenticated; quota could not be retrieved."
    });
    assert.equal(
      (await server.githubCliRequests()).length,
      quotaCommand === "missing" ? 0 : 1
    );
  });
}

test("uses native CLI deletion when the cached Copilot SDK disappears", async (t) => {
  const server = await startTestServer(t, {
    nativeHistory: {},
    nativeSessionDelete: true
  });
  await server.removeSdk();

  const response = await fetch(
    `${server.baseUrl}/api/sessions/${encodeURIComponent(server.sessionId)}`,
    { method: "DELETE", headers: server.headers }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  assert.deepEqual(await server.nativeCliRequests(), [[
    "--silent",
    "--no-color",
    "-i",
    `/session delete ${server.sessionId} --yes --local-only`
  ]]);
});

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

test("reloads a conversation with its own persisted context unless a context is requested", async (t) => {
  const server = await startTestServer(t, { profileSessions: true, context: "long_context" });
  assert.equal((await server.post("config", { configId: "reasoning_effort", value: "medium" })).status, 200);
  assert.equal((await server.post("messages", { text: "first message" })).status, 200);
  const waitForPreferences = async (expected: unknown): Promise<void> => {
    const deadline = Date.now() + 5_000;
    let actual: unknown;
    while (Date.now() < deadline) {
      actual = await server.metadata("session-preferences.json").catch(() => undefined);
      if (JSON.stringify(actual) === JSON.stringify(expected)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(actual, expected);
  };
  await waitForPreferences({
    [server.sessionId]: { context: "long_context", model: "gpt-6-luna", reasoning_effort: "medium" }
  });

  const reloaded = await server.post("load", { fallbackContext: "default" });
  assert.equal(reloaded.status, 200);
  const reloadedBody: unknown = await reloaded.json();
  assert.ok(isRecord(reloadedBody) && Array.isArray(reloadedBody.configOptions));
  assert.equal(reloadedBody.context, "long_context");
  assert.equal(reloadedBody.configOptions.filter(isRecord)
    .find((option) => option.id === "reasoning_effort")?.currentValue, "medium");

  const switched = await server.post("load", { context: "default", fallbackContext: "long_context" });
  assert.equal(switched.status, 200);
  const switchedBody: unknown = await switched.json();
  assert.ok(isRecord(switchedBody));
  assert.equal(switchedBody.context, "default");
  await waitForPreferences({
    [server.sessionId]: { context: "default", model: "gpt-6-luna", reasoning_effort: "medium" }
  });
});

test("starts new conversations from Copilot CLI defaults, not a previous conversation's preferences", async (t) => {
  const server = await startTestServer(t, { profileSessions: true, context: "long_context" });
  assert.equal((await server.post("config", { configId: "reasoning_effort", value: "low" })).status, 200);
  assert.equal((await server.post("messages", { text: "first message" })).status, 200);
  await server.copilotSettings({
    model: "claude-sonnet-5.5", contextTier: "default", effortLevel: "medium"
  });

  const configResponse = await fetch(`${server.baseUrl}/api/config`, { headers: server.headers });
  assert.equal(configResponse.status, 200);
  const config: unknown = await configResponse.json();
  assert.ok(isRecord(config) && Array.isArray(config.configOptions));
  assert.equal(config.context, "default");
  assert.deepEqual(config.newSessionDefaults, {
    context: "default", model: "claude-sonnet-5.5", reasoningEffort: "medium"
  });
  assert.equal(config.configOptions.filter(isRecord)
    .find((option) => option.id === "model")?.currentValue, "claude-sonnet-5.5");

  const createResponse = await fetch(`${server.baseUrl}/api/sessions`, {
    method: "POST", headers: server.headers, body: JSON.stringify({})
  });
  assert.equal(createResponse.status, 201);
  const created: unknown = await createResponse.json();
  assert.ok(isRecord(created) && Array.isArray(created.configOptions));
  assert.equal(created.context, "default");
  const options = created.configOptions.filter(isRecord);
  assert.equal(options.find((option) => option.id === "model")?.currentValue, "claude-sonnet-5.5");
  assert.equal(options.find((option) => option.id === "reasoning_effort")?.currentValue, "medium");
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

test("rejects reconnect requests that would replay an ordinary prompt", async (t) => {
  const server = await startTestServer(t);
  const before = await server.requests();
  const response = await server.post("messages", {
    text: "ordinary prompt",
    reconnect: true
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "reconnect can only be used with /mcp reload and no attachments"
  });
  assert.deepEqual(await server.requests(), before);
  assert.equal(await server.starts(), "1");
});

test("rejects invalid reconnect input before reloading tools", async (t) => {
  const server = await startTestServer(t);
  const before = await server.requests();
  for (const body of [
    { text: 42, reconnect: true },
    { text: "ordinary prompt", reconnect: "true" },
    { text: "/mcp reload", reconnect: true, attachments: false },
    { text: "", reconnect: true },
    {
      text: "/mcp reload",
      reconnect: true,
      attachments: [{ name: "image.png", mimeType: "image/png", data: "AA==" }]
    }
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

test("preserves prompt text and attachments", async (t) => {
  const server = await startTestServer(t);
  const text = "prompt with attachments";
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
  const pdfData = Buffer.from("%PDF-1.4\n%%EOF").toString("base64");
  const textData = Buffer.from("attachment text").toString("base64");
  const binaryData = Buffer.from([0, 1, 2]).toString("base64");
  const response = await server.post("messages", {
    text,
    attachments: [
      { name: "image.png", mimeType: "image/png", data: imageData },
      { name: "document.pdf", mimeType: "application/pdf", data: pdfData },
      { name: "notes.txt", mimeType: "text/plain", data: textData },
      { name: "archive.bin", data: binaryData }
    ]
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await server.requests()).filter((request) => request.method === "session/prompt"),
    [
      {
        method: "session/prompt",
        text,
        prompt: [
          { type: "text", text },
          { type: "image", data: imageData, mimeType: "image/png" },
          {
            type: "resource",
            resource: {
              uri: attachmentUriFor("document.pdf", "application/pdf", pdfData),
              blob: pdfData,
              mimeType: "application/pdf"
            }
          },
          {
            type: "resource",
            resource: {
              uri: attachmentUriFor("notes.txt", "text/plain", textData),
              blob: textData,
              mimeType: "text/plain"
            }
          },
          {
            type: "resource",
            resource: {
              uri: attachmentUriFor("archive.bin", "application/octet-stream", binaryData),
              blob: binaryData,
              mimeType: "application/octet-stream"
            }
          }
        ]
      }
    ]
  );
});

function attachmentUriFor(name: string, mimeType: string, data: string): string {
  const id = createHash("sha256").update(JSON.stringify([name, mimeType, data])).digest("hex");
  return `urn:copilot-web:attachment:${id}:${encodeURIComponent(name)}`;
}

function persistedAttachmentReference(uri: string): JsonObject {
  return {
    type: "file",
    path: "/tmp/acp-resource-deleted.bin",
    displayName: uri.replace(/[^A-Za-z0-9.-]/g, "_")
  };
}

test("stores non-image attachments for history and removes them with the conversation", async (t) => {
  const server = await startTestServer(t, {
    nativeMessages: true,
    nativeHistory: {},
    nativeSessionDelete: true
  });
  const text = "prompt with restorable attachments";
  const expected = [
    {
      name: "Bericht (final) \u00fc.txt",
      mimeType: "text/plain",
      data: Buffer.from("attachment text").toString("base64")
    },
    {
      name: "archive.bin",
      mimeType: "application/octet-stream",
      data: Buffer.from([0, 1, 2]).toString("base64")
    }
  ];
  const response = await server.post("messages", {
    text,
    attachments: [expected[0], { name: "archive.bin", data: expected[1]?.data }]
  });
  assert.equal(response.status, 200);

  const sessionDirectory = path.join(server.attachmentsDirectory, server.sessionId);
  const stored = await Promise.all((await readdir(sessionDirectory)).sort().map(async (file) => (
    JSON.parse(await readFile(path.join(sessionDirectory, file), "utf8")) as unknown
  )));
  assert.deepEqual(
    stored.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    [...expected].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  );

  const loadedResponse = await server.post("load", { historyPaging: true });
  assert.equal(loadedResponse.status, 200);
  const loaded: unknown = await loadedResponse.json();
  assert.ok(isRecord(loaded) && Array.isArray(loaded.nativeMessages));
  const user = loaded.nativeMessages.filter(isRecord)
    .find((message) => message.role === "user" && message.content === text);
  assert.deepEqual(user?.attachments, expected);

  await server.removeSdk();
  const deleted = await fetch(
    `${server.baseUrl}/api/sessions/${encodeURIComponent(server.sessionId)}`,
    { method: "DELETE", headers: server.headers }
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true });
  assert.equal(existsSync(sessionDirectory), false);
});

test("restores stored non-image attachment contents from persisted CLI references", async (t) => {
  const restored = {
    name: "notes.txt",
    mimeType: "text/plain",
    data: Buffer.from("restored notes").toString("base64")
  };
  const tampered = {
    name: "tampered.txt",
    mimeType: "text/plain",
    data: Buffer.from("original").toString("base64")
  };
  const restoredUri = attachmentUriFor(restored.name, restored.mimeType, restored.data);
  const tamperedUri = attachmentUriFor(tampered.name, tampered.mimeType, tampered.data);
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: {
      events: [{
        id: "persisted-user-event",
        type: "user.message",
        timestamp: "2026-10-13T12:00:00.000Z",
        parentId: null,
        data: {
          messageId: "native-user-1",
          content: "Historical prompt with files",
          attachments: [
            persistedAttachmentReference(restoredUri),
            persistedAttachmentReference(tamperedUri),
            persistedAttachmentReference("urn:copilot-web:attachment:0:legacy.txt")
          ]
        }
      }]
    }
  });
  const sessionDirectory = path.join(server.attachmentsDirectory, server.sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  const storedId = (uri: string) => uri.split(":")[3];
  await writeFile(path.join(sessionDirectory, `${storedId(restoredUri)}.json`), JSON.stringify(restored));
  await writeFile(
    path.join(sessionDirectory, `${storedId(tamperedUri)}.json`),
    JSON.stringify({ ...tampered, data: Buffer.from("changed!").toString("base64") })
  );

  for (const body of [{ context: "default" }, { historyPaging: true }]) {
    const response = await server.post("load", body);
    assert.equal(response.status, 200);
    const loaded: unknown = await response.json();
    assert.ok(isRecord(loaded) && Array.isArray(loaded.nativeMessages));
    const user = loaded.nativeMessages.filter(isRecord)
      .find((message) => message.messageId === "native-user-1");
    assert.deepEqual(user?.attachments, [restored], JSON.stringify(body));
  }
});

test("retries conversation creation and prompts without repeating accepted work", async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true, promptDelayMs: 200, failReload: true
  });
  const stream = openEventStream(server.baseUrl, server.headers);
  t.after(() => stream.close());
  const deadline = Date.now() + 5_000;
  while (!stream.events.some((event) => event.event === "ready")) {
    assert.ok(Date.now() < deadline, "Event stream did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const ready = stream.events.find((event) => event.event === "ready")?.data;
  assert.ok(isRecord(ready) && typeof ready.requestScope === "string");
  const post = (route: string, id: string, body: JsonObject, scope = ready.requestScope) => fetch(
    `${server.baseUrl}${route}`, {
      method: "POST",
      headers: {
        ...server.headers,
        "X-Copilot-Request-Id": id,
        "X-Copilot-Request-Scope": String(scope)
      },
      body: JSON.stringify(body)
    }
  );
  const creationsBefore = (await server.requests())
    .filter((request) => request.method === "session/new").length;
  const creations = await Promise.all([
    post("/api/sessions", "create-once", { context: "default" }),
    post("/api/sessions", "create-once", { context: "default" })
  ]);
  assert.deepEqual(creations.map((response) => response.status), [201, 201]);
  const created: unknown = await creations[0]?.json();
  assert.ok(isRecord(created) && isRecord(created.session));
  assert.deepEqual(await creations[1]?.json(), created);
  assert.equal((await server.requests()).filter((request) => request.method === "session/new").length,
    creationsBefore + 1);
  const route = `/api/sessions/${String(created.session.sessionId)}/messages`;
  const body = { text: "Send only once", clientPromptId: "prompt-once" };
  const first = post(route, "prompt-once", body);
  await server.waitForPrompt(body.text);
  const duplicate = post(route, "prompt-once", body);
  assert.equal((await post(route, "prompt-once", { ...body, text: "Different message" })).status, 409);
  const replies = await Promise.all([first, duplicate]);
  assert.deepEqual(replies.map((response) => response.status), [200, 200]);
  assert.deepEqual(await replies[0]?.json(), await replies[1]?.json());
  assert.equal((await post(route, "prompt-once", body)).status, 200);
  assert.equal((await server.requests()).filter((request) => request.text === body.text).length, 1);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await post(route, "failed-once", {
      text: "/mcp reload", reconnect: true
    })).status, 500);
  }
  assert.equal((await server.requests()).filter((request) => request.text === "/mcp reload").length, 1);
  const stale = await post("/api/sessions", "stale-request", {}, "previous-server");
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as JsonObject).code, "server-restarted");
  assert.equal((await post("/api/sessions", "invalid:identifier", {})).status, 400);
  const invalid = { text: "Rejected", reconnect: "invalid" };
  assert.equal((await post(route, "evicted-later", invalid)).status, 400);
  assert.equal((await post(route, "evicted-later", { ...invalid, text: "Changed" })).status, 409);
  for (let index = 0; index < 256; index += 1) {
    assert.equal((await post(route, `newer-${index}`, invalid)).status, 400);
  }
  // The oldest settled result was evicted, so its identifier is no longer bound to the first body.
  assert.equal((await post(route, "evicted-later", { ...invalid, text: "Changed" })).status, 400);
});

test("returns errors when the compose MCP reload fails", async (t) => {
  const server = await startTestServer(t, { failReload: true });
  const response = await server.post("messages", { text: "/mcp reload", reconnect: true });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "MCP reload failed" });
  assert.deepEqual(
    (await server.requests()).filter((request) => request.method === "session/prompt"),
    [{ method: "session/prompt", text: "/mcp reload" }]
  );
});

test("rejects MCP reload if the native command is not advertised", async (t) => {
  const server = await startTestServer(t, { advertiseMcp: false });
  const before = await server.requests();
  const response = await server.post("messages", { text: "/mcp reload", reconnect: true });
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
  const response = await server.post("messages", { text: "/mcp reload", reconnect: true });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Timed out waiting for Copilot's native command metadata"
  });
  assert.equal(
    (await server.requests()).filter((request) => request.method === "session/prompt").length,
    0
  );
});

test("cancels compose MCP reload while waiting for command metadata", async (t) => {
  const server = await startTestServer(t, { commandDelayMs: 1_000 });
  const reload = server.post("messages", { text: "/mcp reload", reconnect: true });
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
  const response = await reload;
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

const nativeImageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";

function nativeHistoryEvents(): JsonObject[] {
  return [
    {
      id: "persisted-user-event",
      type: "user.message",
      timestamp: "2026-10-13T12:00:00.000Z",
      parentId: null,
      data: {
        messageId: "native-user-1",
        content: "Native historical prompt",
        attachments: [{
          type: "blob",
          displayName: "diagram.png",
          mimeType: "image/png",
          data: nativeImageData
        }]
      }
    },
    {
      id: "persisted-assistant-event",
      type: "assistant.message",
      timestamp: "2026-10-13T12:00:05.123Z",
      parentId: "persisted-user-event",
      data: {
        messageId: "native-assistant-1",
        content: "Native historical reply"
      }
    },
    {
      id: "persisted-subagent-event",
      type: "assistant.message",
      agentId: "subagent-1",
      timestamp: "2026-10-13T12:00:06.000Z",
      parentId: "persisted-assistant-event",
      data: {
        messageId: "native-subagent-1",
        content: "This subagent message is not part of the root transcript"
      }
    }
  ];
}

test("loads root-agent native history sequentially with IDs, timestamps, and attachments", async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events: nativeHistoryEvents(), pageSize: 1 }
  });
  const response = await server.post("load", { context: "default" });
  assert.equal(response.status, 200);
  const loaded: unknown = await response.json();
  assert.ok(isRecord(loaded));
  assert.equal(loaded.nativeMessagesActive, true);
  assert.ok(Array.isArray(loaded.nativeMessages));
  assert.equal(loaded.nativeMessages.length, 2);

  const user = loaded.nativeMessages[0];
  const assistant = loaded.nativeMessages[1];
  assert.ok(isRecord(user) && isRecord(assistant));
  assert.equal(user.messageId, "native-user-1");
  assert.equal(user.content, "Native historical prompt");
  assert.ok(Array.isArray(user.attachments));
  assert.deepEqual(user.attachments[0], {
    name: "diagram.png",
    mimeType: "image/png",
    data: nativeImageData
  });
  assert.equal(assistant.messageId, "native-assistant-1");
  assert.equal(assistant.content, "Native historical reply");
  assert.equal(assistant.timestamp, "2026-10-13T12:00:05.123Z");
  assert.equal(assistant.completion, "completed");

  const reads = (await server.historyReads()).filter((request) => (
    isRecord(request) && request.sessionId === "session-1"
  ));
  assert.deepEqual(reads.map((request) => (
    isRecord(request) ? request.cursor ?? null : null
  )), [null, "1", "2"]);
  const connection: unknown = await server.sdkConnection();
  assert.ok(isRecord(connection));
  assert.equal(String(connection.path).endsWith("copilot-fake"), true);
  assert.deepEqual(connection.args, []);
});

test("does not read a persisted journal for an empty unprompted conversation", async (t) => {
  const server = await startTestServer(t, {
    nativeHistory: { events: [] }
  });
  const response = await server.post("load", { context: "default" });
  assert.equal(response.status, 200);
  const loaded: unknown = await response.json();
  assert.ok(isRecord(loaded) && Array.isArray(loaded.nativeMessages));
  assert.equal(loaded.nativeMessagesActive, true);
  assert.deepEqual(loaded.nativeMessages, []);
  assert.equal(
    (await server.historyReads()).filter((request) => (
      isRecord(request) && request.sessionId === server.sessionId
    )).length,
    0
  );
});

for (const oversized of [false, true]) {
  test(`refreshes a new active conversation ${
    oversized ? "without treating a bounded tail as complete" : "before its journal can be read"
  }`, async (t) => {
    const server = await startTestServer(t, {
      nativeMessages: true,
      nativeHistory: { readError: true },
      promptDelayMs: 1_000
    });
    const stream = openEventStream(server.baseUrl, server.headers);
    t.after(() => stream.close());
    const deadline = Date.now() + 5_000;
    while (!stream.events.some((event) => event.event === "ready")) {
      assert.ok(Date.now() < deadline, "Event stream was not ready");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const text = "New live conversation";
    const prompt = server.post("messages", {
      text,
      clientPromptId: "first-live-prompt",
      ...(oversized ? { attachments: [{
        name: "large.png", mimeType: "image/png", data: Buffer.alloc(160 * 1024, 1).toString("base64")
      }] } : {})
    });
    await server.waitForPrompt(text);
    while (!stream.events.some((event) => event.event === "native-message" &&
      isRecord(event.data) && event.data.role === "user")) {
      assert.ok(Date.now() < deadline, "Native user message was not received");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const response = await server.post("load", { historyPaging: true });
    assert.equal(response.status, oversized ? 503 : 200);
    const loaded: unknown = await response.json();
    assert.ok(isRecord(loaded));
    if (!oversized) {
      assert.equal(loaded.busy, true);
      assert.equal(loaded.nativeMessagesActive, true);
      assert.ok(isRecord(loaded.history));
      assert.equal(loaded.history.hasMore, false);
      assert.ok(Array.isArray(loaded.nativeMessages));
      assert.equal(loaded.nativeMessages.filter(isRecord)
        .find((message) => message.role === "user")?.content, text);
      assert.equal((await server.historyReads()).filter((request) =>
        isRecord(request) && request.sessionId === server.sessionId).length, 0);
    }
    assert.equal((await prompt).status, 200);
    assert.equal((await server.requests()).filter((request) => request.method === "session/prompt").length, 1);
    assert.equal((await server.requests()).filter((request) => request.method === "session/load").length, 0);
  });
}

function openEventStream(baseUrl: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const events: Array<{ event: string; data: unknown }> = [];
  void (async () => {
    try {
      const response = await fetch(`${baseUrl}/api/events`, { headers, signal: controller.signal });
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) {
            events.push({ event, data: JSON.parse(data) as unknown });
          }
          separator = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // The stream is aborted when the test finishes.
    }
  })();
  return { events, close: () => controller.abort() };
}

test("merges events buffered during a persisted-history read", async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    promptDelayMs: 250,
    nativeHistory: {
      events: nativeHistoryEvents().slice(0, 2),
      readDelayMs: 1_000
    }
  });
  const stream = openEventStream(server.baseUrl, server.headers);
  t.after(stream.close);
  const streamDeadline = Date.now() + 2_000;
  while (!stream.events.some((event) => event.event === "ready")) {
    assert.ok(Date.now() < streamDeadline, "Event stream did not connect");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  let loadFinished = false;
  const loading = server.post("load", { context: "default" }).finally(() => {
    loadFinished = true;
  });
  const deadline = Date.now() + 2_000;
  while (!(await server.historyReads()).some((request) => (
    isRecord(request) && request.sessionId === "session-1"
  ))) {
    assert.ok(Date.now() < deadline, "Persisted-history reading did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const prompt = server.post("messages", {
    text: "arrive while history is loading",
    clientPromptId: "live-prompt-1"
  });
  assert.equal((await prompt).status, 200);
  const liveDeadline = Date.now() + 2_000;
  let liveFinal: { event: string; data: unknown } | undefined;
  while (!liveFinal) {
    liveFinal = stream.events.find((event) => (
      event.event === "native-message" &&
      isRecord(event.data) &&
      event.data.role === "assistant" &&
      event.data.completion === "completed" &&
      event.data.content === "Done."
    ));
    assert.ok(Date.now() < liveDeadline, "The live reply was not published during the load");
    if (!liveFinal) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(loadFinished, false, "The live reply should arrive while history is still loading");
  assert.ok(isRecord(liveFinal.data));
  assert.equal(liveFinal.data.timestamp, "2026-10-14T10:00:00.300Z");

  const response = await loading;
  assert.equal(response.status, 200);
  const loaded: unknown = await response.json();
  assert.ok(isRecord(loaded) && Array.isArray(loaded.nativeMessages));
  const messages = loaded.nativeMessages.filter(isRecord);
  assert.equal(messages.length, 4);
  const liveUser = messages.find((message) => message.clientPromptId === "live-prompt-1");
  const liveAssistant = messages.find((message) => (
    message.role === "assistant" && message.content === "Done."
  ));
  assert.equal(liveUser?.content, "arrive while history is loading");
  assert.equal(liveAssistant?.timestamp, "2026-10-14T10:00:00.300Z");
});

test("falls back to ACP replay when native history is unavailable", async (t) => {
  for (const [name, nativeHistory] of [
    ["unsupported API", { events: nativeHistoryEvents(), unsupported: true }],
    ["read failure", { events: nativeHistoryEvents(), readError: true }],
    ["expired cursor", { events: nativeHistoryEvents(), pageSize: 1, cursorExpired: true }]
  ] as const) {
    await t.test(name, async (t) => {
      const server = await startTestServer(t, {
        existingSession: true,
        nativeMessages: true,
        nativeHistory
      });
      const response = await server.post("load", { context: "default" });
      assert.equal(response.status, 200);
      const loaded: unknown = await response.json();
      assert.ok(isRecord(loaded));
      assert.equal(loaded.nativeMessagesActive, false);
      const replay = replayUpdates(loaded);
      const idlessUser = replay.find((params) => (
        isRecord(params.update) &&
        params.update.sessionUpdate === "user_message_chunk"
      ));
      const idlessAssistant = replay.find((params) => (
        isRecord(params.update) &&
        params.update.sessionUpdate === "agent_message_chunk"
      ));
      assert.ok(idlessUser && isRecord(idlessUser.update));
      assert.ok(idlessAssistant && isRecord(idlessAssistant.update));
      assert.equal(idlessUser.update.messageId, undefined);
      assert.equal(idlessAssistant.update.messageId, undefined);
      assert.equal(idlessAssistant.timestamp, undefined);
    });
  }
});

test("keeps repeated final events idempotent and marks command-only replies as untimed", async (t) => {
  const server = await startTestServer(t, {
    nativeMessages: true,
    nativeHistory: { events: [], timestamp: "2026-10-14T10:00:00.000Z" },
    promptDelayMs: 20
  });
  const stream = openEventStream(server.baseUrl, server.headers);
  t.after(stream.close);
  const streamDeadline = Date.now() + 2_000;
  while (!stream.events.some((event) => event.event === "ready")) {
    assert.ok(Date.now() < streamDeadline, "Event stream did not connect");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const createdResponse = await fetch(`${server.baseUrl}/api/sessions`, {
    method: "POST",
    headers: server.headers,
    body: JSON.stringify({ context: "default" })
  });
  assert.equal(createdResponse.status, 201);
  const created: unknown = await createdResponse.json();
  assert.ok(isRecord(created) && isRecord(created.session));
  const sessionId = String(created.session.sessionId);

  const prompt = await server.post("messages", {
    text: "native live response",
    clientPromptId: "live-prompt-2"
  }, sessionId);
  assert.equal(prompt.status, 200);
  const loadedResponse = await server.post("load", { context: "default" }, sessionId);
  assert.equal(loadedResponse.status, 200);
  const loaded: unknown = await loadedResponse.json();
  assert.ok(isRecord(loaded) && Array.isArray(loaded.nativeMessages));
  const messages = loaded.nativeMessages.filter(isRecord);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.clientPromptId, "live-prompt-2");
  assert.equal(messages[1]?.content, "Done.");
  assert.equal(messages[1]?.timestamp, "2026-10-14T10:00:00.300Z");

  const reloadReply = "MCP configuration reloaded and servers restarted.";
  const reload = await server.post("messages", {
    text: "/mcp reload",
    reconnect: true,
    clientPromptId: "reload-prompt-1"
  }, sessionId);
  assert.equal(reload.status, 200);
  const liveDeadline = Date.now() + 2_000;
  const liveCommandReply = () => stream.events.find((event) => (
    event.event === "session-update" &&
    isRecord(event.data) &&
    event.data.nativeCommand === true &&
    isRecord(event.data.update) &&
    isRecord(event.data.update.content) &&
    event.data.update.content.text === reloadReply
  ));
  while (!liveCommandReply()) {
    assert.ok(Date.now() < liveDeadline, "The command reply was not published");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(stream.events.some((event) => (
    event.event === "session-update" && isRecord(event.data) && event.data.nativeFallback === true
  )), false);

  const afterReload = await server.post("load", { context: "default" }, sessionId);
  assert.equal(afterReload.status, 200);
  const reloaded: unknown = await afterReload.json();
  assert.ok(isRecord(reloaded) && Array.isArray(reloaded.nativeMessages));
  assert.equal(reloaded.nativeMessages.some((message) => (
    isRecord(message) && message.content === reloadReply
  )), false);
  const chatReplay = replayUpdates(reloaded).filter((params) => (
    isRecord(params.update) &&
    (params.update.sessionUpdate === "user_message_chunk" ||
      params.update.sessionUpdate === "agent_message_chunk")
  )).map((params) => ({
    command: params.nativeCommand === true,
    text: isRecord(params.update) && isRecord(params.update.content)
      ? params.update.content.text
      : undefined
  }));
  assert.deepEqual(chatReplay, [
    { command: false, text: "native live response" },
    { command: false, text: "Done." },
    { command: true, text: "/mcp reload" },
    { command: true, text: reloadReply }
  ]);
});

test("recovers native message identity and timestamps after the ACP process restarts", async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events: nativeHistoryEvents(), pageSize: 1 }
  });
  const beforeResponse = await server.post("load", { context: "default" });
  assert.equal(beforeResponse.status, 200);
  const before: unknown = await beforeResponse.json();
  assert.ok(isRecord(before) && Array.isArray(before.nativeMessages));
  const beforeMessages = before.nativeMessages.filter(isRecord);
  const assistantBefore = beforeMessages.find((message) => message.role === "assistant");
  assert.equal(assistantBefore?.messageId, "native-assistant-1");
  assert.equal(assistantBefore?.timestamp, "2026-10-13T12:00:05.123Z");

  assert.equal((await server.post("messages", { text: "crash" })).status, 500);
  const afterResponse = await server.post("load", { context: "default" });
  assert.equal(afterResponse.status, 200);
  const after: unknown = await afterResponse.json();
  assert.ok(isRecord(after) && Array.isArray(after.nativeMessages));
  const afterMessages = after.nativeMessages.filter(isRecord);
  const assistantAfter = afterMessages.find((message) => message.role === "assistant");
  assert.equal(afterMessages.length, beforeMessages.length);
  assert.equal(assistantAfter?.messageId, assistantBefore?.messageId);
  assert.equal(assistantAfter?.timestamp, assistantBefore?.timestamp);
  assert.equal(await server.starts(), "2");
});

test("rebuilds crash-recovery history once and preserves the current prompt", async (t) => {
  for (const body of [
    { text: "/mcp reload", reconnect: true },
    { text: "continue after a crash" },
    {
      text: "continue after a crash with an image",
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

test("cancels MCP reload without sending an additional prompt", async (t) => {
  const server = await startTestServer(t);
  const reload = server.post("messages", { text: "/mcp reload", reconnect: true });
  const deadline = Date.now() + 2_000;
  while (!(await server.requests()).some((request) => request.text === "/mcp reload")) {
    assert.ok(Date.now() < deadline, "MCP reload did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const conflicting = await server.post("messages", { text: "concurrent prompt" });
  assert.equal(conflicting.status, 409);
  const cancellation = await server.post("cancel", {});
  assert.equal(cancellation.status, 202);
  const response = await reload;
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
  registerResourceCleanup(t, async () => {
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
  await command("Page.enable", {}, sessionId);
  await command("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.testBrowserErrors = [];
      window.addEventListener("error", (event) => window.testBrowserErrors.push(event.message));
      window.addEventListener("unhandledrejection", (event) => window.testBrowserErrors.push(String(event.reason)));`
  }, sessionId);
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
      if (Date.now() >= deadline) {
        const details = await evaluate(`({
          transcript: document.querySelector("#messages")?.textContent.slice(0, 2000),
          cancelDisabled: document.querySelector("#cancel-prompt")?.disabled,
          pending: JSON.parse(sessionStorage.getItem("copilot-web-pending-sends") ?? "[]")
            .map(({ id, reviewRequired, nativeMessageId }) => ({ id, reviewRequired, nativeMessageId })),
          errors: window.testBrowserErrors
        })`);
        assert.fail(`Browser condition not met: ${expression}\n${JSON.stringify(details)}`);
      }
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

const holdConversationDeletions = `
  window.heldConversationDeletions = new Map();
  window.filteredDeletionLists = 0;
  const nativeFetchForDeletionTest = window.fetch.bind(window);
  window.fetch = async (resource, init) => {
    const url = typeof resource === "string" ? resource : resource.url;
    if (init?.method === "DELETE" && url.startsWith("/api/sessions/")) {
      const sessionId = decodeURIComponent(url.slice("/api/sessions/".length));
      return new Promise((resolve) => {
        window.heldConversationDeletions.set(sessionId, async (failure, warnings) => {
          let response;
          if (failure) {
            response = new Response(JSON.stringify({ error: failure }), { status: 500 });
          } else {
            const result = await nativeFetchForDeletionTest(resource, init);
            response = new Response(JSON.stringify({
              ...await result.json(),
              ...(warnings ? { persistenceWarnings: warnings } : {})
            }), { status: result.status });
          }
          window.heldConversationDeletions.delete(sessionId);
          resolve(response);
        });
      });
    }
    const response = await nativeFetchForDeletionTest(resource, init);
    if (url === "/api/sessions" && (init?.method ?? "GET") === "GET") {
      const payload = await response.json();
      payload.sessions = payload.sessions.filter((session) => (
        !window.heldConversationDeletions.has(session.sessionId)
      ));
      if (window.heldConversationDeletions.size > 0) window.filteredDeletionLists += 1;
      return new Response(JSON.stringify(payload), { status: response.status });
    }
    return response;
  };
`;

test("deletes conversations in the background while navigating and sending new prompts", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeSessionDelete: true,
    nativeHistory: {
      events: [nativeTranscriptEvent("user.message", "original", "Original conversation", 0)]
    }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    ${holdConversationDeletions}
    ${mockSpeechRecognition}
    window.SpeechRecognition.prototype.stop = function() { this.stopCalls += 1; };
  `);
  const original = `document.querySelector('.session-item[data-session-id="session-1"]')`;
  const originalRow = `${original}.closest(".session-item-row")`;
  await waitFor(`Boolean(${original})`);
  await evaluate(`${original}.click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Original conversation") &&
    !document.querySelector("#send-prompt").disabled`);
  await evaluate(`${originalRow}.querySelector(".session-delete").click()`);
  await waitFor(`document.querySelector("#delete-dialog").open`);
  await evaluate(`document.querySelector("#delete-dialog").close("cancel")`);
  await waitFor(`!document.querySelector("#delete-dialog").open`);
  assert.equal(await evaluate(`window.heldConversationDeletions.size`), 0);
  assert.equal(await evaluate(`${original}.classList.contains("active")`), true);

  await evaluate(`document.querySelector("#voice-input").click()`);
  await waitFor(`window.speechRecognitionTest.instances.length === 1`);
  await evaluate(`${originalRow}.querySelector(".session-delete").click()`);
  await waitFor(`document.querySelector("#delete-dialog").open`);
  await evaluate(`document.querySelector("#delete-confirm").click()`);
  await waitFor(`window.heldConversationDeletions.has("session-1")`);
  assert.equal(await evaluate(`document.querySelector(".session-item.active") === null`), true);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("Original conversation")`), false);
  assert.equal(await evaluate(`${originalRow}.querySelector(".session-status").textContent`), "Deleting");
  assert.equal(await evaluate(`${original}.disabled &&
    ${originalRow}.querySelector(".session-delete").disabled &&
    ${originalRow}.querySelector(".session-rename").disabled`), true);
  assert.equal(await evaluate(`window.speechRecognitionTest.instances[0].stopCalls`), 1);
  await evaluate(`window.speechRecognitionTest.instances[0].onend({ type: "end" })`);

  const newSessionIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    if (index > 0) {
      await evaluate(`document.querySelector("#new-chat").click()`);
      await waitFor(`document.querySelector(".session-item.active") === null`);
    }
    await waitFor(`!document.querySelector("#send-prompt").disabled`);
    await evaluate(`(() => {
      const input = document.querySelector("#prompt-input");
      input.value = ${JSON.stringify(`New prompt ${index + 1}`)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#composer").requestSubmit();
    })()`);
    await waitFor(`Boolean(document.querySelector(".session-item.active")) &&
      document.querySelector("#messages").textContent.includes("Done.") &&
      !document.querySelector("#send-prompt").disabled`);
    newSessionIds.push(String(await evaluate(`document.querySelector(".session-item.active").dataset.sessionId`)));
  }
  const [backgroundId, activeId] = newSessionIds;
  assert.ok(backgroundId && activeId && backgroundId !== activeId && activeId !== "session-1");
  assert.equal(await evaluate(`window.filteredDeletionLists > 0`), true);
  assert.equal(await evaluate(`${originalRow}.querySelector(".session-status").textContent`), "Deleting");

  await evaluate(`document.querySelector('.session-item[data-session-id="${backgroundId}"]').click()`);
  await waitFor(`document.querySelector(".session-item.active")?.dataset.sessionId === "${backgroundId}"`);
  await evaluate(`document.querySelector('.session-item[data-session-id="${activeId}"]').click()`);
  await waitFor(`document.querySelector(".session-item.active")?.dataset.sessionId === "${activeId}"`);
  await evaluate(`document.querySelector('.session-item[data-session-id="${backgroundId}"]')
    .closest(".session-item-row").querySelector(".session-delete").click()`);
  await waitFor(`document.querySelector("#delete-dialog").open`);
  await evaluate(`document.querySelector("#delete-confirm").click()`);
  await waitFor(`window.heldConversationDeletions.size === 2`);
  assert.equal(await evaluate(`document.querySelectorAll(".session-status-deleting").length`), 2);
  assert.equal(await evaluate(`document.querySelector(".session-item.active").dataset.sessionId`), activeId);

  await server.removeSdk();
  for (const id of [backgroundId, "session-1"]) {
    await evaluate(`window.heldConversationDeletions.get("${id}")()`);
    await waitFor(`!document.querySelector('.session-item[data-session-id="${id}"]')`);
    assert.equal(await evaluate(`document.querySelector(".session-item.active").dataset.sessionId`), activeId);
    assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("New prompt 2")`), true);
  }
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});

for (const outcome of ["failure", "warning"] as const) {
  test(`shows background conversation deletion ${outcome} without losing the new draft`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const server = await startTestServer(t, {
      existingSession: true,
      nativeMessages: true,
      nativeSessionDelete: true,
      nativeHistory: {
        events: [nativeTranscriptEvent("user.message", "original", "Original conversation", 0)]
      }
    });
    const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, holdConversationDeletions);
    const original = `document.querySelector('.session-item[data-session-id="session-1"]')`;
    await waitFor(`Boolean(${original})`);
    await evaluate(`${original}.click()`);
    await waitFor(`document.querySelector("#messages").textContent.includes("Original conversation") &&
      !document.querySelector("#send-prompt").disabled`);
    await evaluate(`${original}.closest(".session-item-row").querySelector(".session-delete").click()`);
    await waitFor(`document.querySelector("#delete-dialog").open`);
    await evaluate(`document.querySelector("#delete-confirm").click()`);
    await waitFor(`window.heldConversationDeletions.has("session-1")`);
    await evaluate(`
      const input = document.querySelector("#prompt-input");
      input.value = "Keep this new draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    const message = outcome === "failure" ? "Deletion failed" : "Title cleanup failed";
    await server.removeSdk();
    await evaluate(outcome === "failure"
      ? `window.heldConversationDeletions.get("session-1")("${message}")`
      : `window.heldConversationDeletions.get("session-1")(null, ["${message}"])`);
    await waitFor(`document.querySelector("#messages").textContent.includes("${message}")`);
    assert.equal(await evaluate(`document.querySelector(".session-item.active") === null`), true);
    assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "Keep this new draft");
    assert.equal(await evaluate(`document.querySelector(".session-status-deleting") === null`), true);
    if (outcome === "failure") {
      assert.equal(await evaluate(`!${original}.disabled &&
        !${original}.closest(".session-item-row").querySelector(".session-delete").disabled`), true);
      await evaluate(`${original}.click()`);
      await waitFor(`document.querySelector("#messages").textContent.includes("Original conversation")`);
      await evaluate(`${original}.closest(".session-item-row").querySelector(".session-delete").click()`);
      await waitFor(`document.querySelector("#delete-dialog").open`);
      await evaluate(`document.querySelector("#delete-confirm").click()`);
      await waitFor(`window.heldConversationDeletions.has("session-1")`);
      await evaluate(`window.heldConversationDeletions.get("session-1")()`);
      await waitFor(`!${original}`);
    } else {
      assert.equal(await evaluate(`${original} === null`), true);
    }
    assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
  });
}

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

test("uses untimed ACP replay when native history is unavailable", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: {
      events: nativeHistoryEvents(),
      unsupported: true
    }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes(
    "Native historical reply"
  )`);
  assert.equal(
    await evaluate(`document.querySelectorAll(".message.assistant time.message-timestamp").length`),
    0
  );
  assert.equal(
    await evaluate(`document.querySelector(".message.assistant .message-body").textContent`),
    "Native historical reply"
  );
  assert.equal(
    await evaluate(`document.querySelector(".message.tool") !== null`),
    true
  );
});

test("renders native completion times outside message content through refresh", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const historicalUserDate = new Date(yesterday);
  historicalUserDate.setHours(11, 59, 55, 0);
  const historicalUserTimestamp = historicalUserDate.toISOString();
  const historicalAssistantDate = new Date(yesterday);
  historicalAssistantDate.setHours(12, 0, 5, 123);
  const historicalTimestamp = historicalAssistantDate.toISOString();
  const todayTimestamp = new Date(Date.now() - 60_000).toISOString();
  const historicalEvents = nativeHistoryEvents().map((event) => {
    if (event.id === "persisted-assistant-event") {
      return { ...event, timestamp: historicalTimestamp };
    }
    if (event.id === "persisted-user-event") {
      return { ...event, timestamp: historicalUserTimestamp };
    }
    return event;
  });
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: {
      events: [
        ...historicalEvents,
        {
          id: "untimed-assistant-event",
          type: "assistant.message",
          data: {
            messageId: "native-assistant-untimed",
            content: "Untimed native reply"
          }
        }
      ],
      pageSize: 1,
      timestamp: todayTimestamp
    },
    promptDelayMs: 20
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const assistantBodies = `[
    ...document.querySelectorAll(".message.assistant .message-body")
  ]`;
  const timestamps = `[
    ...document.querySelectorAll(".message.assistant time.message-timestamp")
  ]`;
  const userTimestamps = `[
    ...document.querySelectorAll(".message.user time.message-timestamp")
  ]`;

  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`${assistantBodies}.some((body) => body.textContent === "Native historical reply")`);
  await waitFor(`${timestamps}.length === 1`);
  await waitFor(`${userTimestamps}.length === 1`);
  assert.equal(
    await evaluate(`${userTimestamps}[0].dateTime`),
    historicalUserTimestamp
  );
  assert.equal(
    await evaluate(`${userTimestamps}[0].textContent`),
    await evaluate(`new Date(${JSON.stringify(historicalUserTimestamp)}).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    })`).then((time) => `Yesterday, ${String(time)}`)
  );
  assert.equal(
    await evaluate(`${timestamps}[0].dateTime`),
    historicalTimestamp
  );
  assert.equal(
    await evaluate(`${timestamps}[0].textContent`),
    await evaluate(`new Date(${JSON.stringify(historicalTimestamp)}).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    })`).then((time) => `Yesterday, ${String(time)}`)
  );
  assert.equal(await evaluate(`
    (() => {
      const time = ${timestamps}[0];
      const body = time.closest(".message").querySelector(".message-body");
      return !body.contains(time) &&
        body.textContent === "Native historical reply" &&
        time.title === new Date(${JSON.stringify(historicalTimestamp)}).toLocaleString(undefined, {
          dateStyle: "full",
          timeStyle: "long"
        });
    })()
  `), true);
  assert.equal(await evaluate(`
    (() => {
      const time = ${userTimestamps}[0];
      const body = time.closest(".message").querySelector(".message-body");
      return !body.contains(time) &&
        body.querySelector(".message-attachment-image")?.alt === "diagram.png" &&
        time.title === new Date(${JSON.stringify(historicalUserTimestamp)}).toLocaleString(undefined, {
          dateStyle: "full",
          timeStyle: "long"
        });
    })()
  `), true);
  assert.deepEqual(await evaluate(`
    (() => {
      const messages = [...document.querySelectorAll("#messages > .message")];
      return messages.map((message) => message.classList.contains("user")
        ? "user"
        : message.classList.contains("tool")
          ? "tool"
          : "assistant"
      );
    })()
  `), ["user", "tool", "assistant", "assistant"]);
  assert.equal(await evaluate(`
    (() => {
      const article = [...document.querySelectorAll(".message.assistant")]
        .find((candidate) => candidate.querySelector(".message-body")?.textContent ===
          "Untimed native reply");
      return Boolean(article) &&
        article.querySelector("time.message-timestamp") === null;
    })()
  `), true);
  assert.equal(await evaluate(
    `document.querySelector(".message.user .message-attachment-image")?.alt`
  ), "diagram.png");
  assert.equal(await evaluate(
    `document.querySelector("#messages").textContent.includes("subagent message is not")`
  ), false);

  await evaluate(`
    (() => {
      const input = document.querySelector("#prompt-input");
      input.value = "native live response";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#composer").requestSubmit();
    })();
  `);
  await waitFor(`${assistantBodies}.some((body) => body.textContent === "Done.")`);
  await waitFor(`${timestamps}.length === 2`);
  await waitFor(`${userTimestamps}.length === 2`);
  const todayCompletionTimestamp = new Date(Date.parse(todayTimestamp) + 300).toISOString();
  assert.equal(
    await evaluate(`${timestamps}[1].dateTime`),
    todayCompletionTimestamp
  );
  const todayLocalTime = await evaluate(`new Date(${JSON.stringify(todayCompletionTimestamp)})
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })`);
  assert.equal(
    await evaluate(`${timestamps}[1].textContent`),
    String(todayLocalTime)
  );
  const todayUserTime = await evaluate(`new Date(${JSON.stringify(todayTimestamp)})
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })`);
  assert.equal(await evaluate(`${userTimestamps}[1].dateTime`), todayTimestamp);
  assert.equal(
    await evaluate(`${userTimestamps}[1].textContent`),
    String(todayUserTime)
  );
  assert.equal(await evaluate(`
    [...document.querySelectorAll(".message.assistant .message-body")]
      .filter((body) => body.textContent === "Done.").length
  `), 1);
  assert.equal(
    await evaluate(`document.querySelectorAll(".message.user").length`),
    2
  );

  await evaluate("window.beforeNativeHistoryReload = true");
  await command("Page.reload", {}, sessionId);
  await waitFor(`
    window.beforeNativeHistoryReload !== true &&
    ${assistantBodies}.some((body) => body.textContent === "Done.") &&
    ${timestamps}.length === 2 &&
    ${userTimestamps}.length === 2
  `);
  assert.equal(
    await evaluate(`${timestamps}[1].dateTime`),
    todayCompletionTimestamp
  );
  assert.equal(
    await evaluate(`${userTimestamps}[1].dateTime`),
    todayTimestamp
  );
  assert.equal(
    await evaluate(`document.querySelectorAll(".message.assistant .message-body").length`),
    3
  );
});

test("shows command-only replies untimed", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events: nativeHistoryEvents() }
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const reloadReply = "MCP configuration reloaded and servers restarted.";
  const chatTranscript = `[...document.querySelectorAll(
    "#messages > .message.user, #messages > .message.assistant"
  )].map((message) => ({
    role: message.classList.contains("user") ? "user" : "assistant",
    text: message.querySelector(".message-body").textContent,
    timed: Boolean(message.querySelector("time.message-timestamp"))
  }))`;
  const expected = [
    { role: "user", text: "Native historical prompt", timed: true },
    { role: "assistant", text: "Native historical reply", timed: true },
    { role: "user", text: "/mcp reload", timed: false },
    { role: "assistant", text: reloadReply, timed: false }
  ];

  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`
    document.querySelector("#messages").textContent.includes("Native historical reply") &&
    !document.querySelector("#reconnect-tools").disabled
  `);
  await evaluate(`document.querySelector("#reconnect-tools").click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes(${JSON.stringify(reloadReply)})`);
  await waitFor(`!document.querySelector("#reconnect-tools").disabled`);
  assert.deepEqual(await evaluate(chatTranscript), expected);

  await evaluate("window.beforeCommandReload = true");
  await command("Page.reload", {}, sessionId);
  await waitFor(`
    window.beforeCommandReload !== true &&
    document.querySelector("#messages")?.textContent.includes(${JSON.stringify(reloadReply)})
  `);
  assert.deepEqual(await evaluate(chatTranscript), expected);
});

function nativeTranscriptEvent(
  type: "user.message" | "assistant.message",
  messageId: string,
  content: string,
  minute: number,
  data: JsonObject = {}
): JsonObject {
  return {
    id: `${messageId}-event`,
    type,
    timestamp: new Date(Date.UTC(2026, 9, 13, 9, minute)).toISOString(),
    parentId: null,
    data: { messageId, content, ...data }
  };
}

test("does not shift or duplicate messages when native and ACP histories differ", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 40_000
}, async (t) => {
  const chatTranscript = `[...document.querySelectorAll(
    "#messages > .message.user, #messages > .message.assistant"
  )].map((message) => ({
    role: message.classList.contains("user") ? "user" : "assistant",
    text: message.querySelector(".message-body").textContent,
    timed: Boolean(message.querySelector("time.message-timestamp"))
  }))`;
  const scenarios: Array<{
    name: string;
    events: JsonObject[];
    expected: Array<{ role: string; text: string; timed: boolean }>;
    expectedReasoning?: string;
    expectedActivities?: string[];
  }> = [
    {
      name: "tool calls separate replies within a turn",
      expectedReasoning: "Now run the command.",
      expectedActivities: ["History lookup", "view", "bash"],
      events: [
        nativeTranscriptEvent("user.message", "user-1", "Inspect and run", 0),
        nativeTranscriptEvent("assistant.message", "assistant-1", "I will look at the file.", 1, {
          toolRequests: [{ toolCallId: "call-view", name: "view" }]
        }),
        nativeTranscriptEvent("assistant.message", "assistant-2", "I looked at it.", 2, {
          reasoningText: "Now run the command.",
          toolRequests: [{ toolCallId: "call-bash", name: "bash" }]
        }),
        nativeTranscriptEvent("assistant.message", "assistant-3", "Second answer", 3)
      ],
      expected: [
        { role: "user", text: "Inspect and run", timed: true },
        { role: "assistant", text: "I will look at the file.", timed: true },
        { role: "assistant", text: "I looked at it.", timed: true },
        { role: "assistant", text: "Second answer", timed: true }
      ]
    },
    {
      name: "assistant messages differ within a turn",
      events: [
        nativeTranscriptEvent("user.message", "user-1", "First question", 0),
        nativeTranscriptEvent("assistant.message", "assistant-1", "First answer", 1, {
          toolRequests: [{ toolCallId: "lookup-1", name: "Lookup" }]
        }),
        nativeTranscriptEvent("assistant.message", "assistant-acp-only", "ACP-only reply", 2, {
          testNativeHidden: true
        }),
        nativeTranscriptEvent("user.message", "user-2", "Second question", 3),
        nativeTranscriptEvent("assistant.message", "assistant-2", "Second answer", 4)
      ],
      expected: [
        { role: "user", text: "First question", timed: true },
        { role: "assistant", text: "First answer", timed: true },
        { role: "assistant", text: "ACP-only reply", timed: false },
        { role: "user", text: "Second question", timed: true },
        { role: "assistant", text: "Second answer", timed: true }
      ]
    },
    {
      name: "a native-only turn is missing from ACP",
      events: [
        nativeTranscriptEvent("user.message", "user-1", "First question", 0),
        nativeTranscriptEvent("assistant.message", "assistant-1", "First answer", 1),
        nativeTranscriptEvent("user.message", "user-hidden", "Hidden native prompt", 2, {
          testAcpHidden: true
        }),
        nativeTranscriptEvent("assistant.message", "assistant-hidden", "Hidden native answer", 3, {
          testAcpHidden: true
        }),
        nativeTranscriptEvent("user.message", "user-2", "Second question", 4),
        nativeTranscriptEvent("assistant.message", "assistant-2", "Second answer", 5)
      ],
      expected: [
        { role: "user", text: "First question", timed: false },
        { role: "assistant", text: "First answer", timed: false },
        { role: "user", text: "Second question", timed: false },
        { role: "assistant", text: "Second answer", timed: false }
      ]
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const server = await startTestServer(t, {
        existingSession: true,
        nativeMessages: true,
        nativeHistory: { events: scenario.events }
      });
      const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
      await waitFor(`Boolean(document.querySelector(
        'button.session-item[data-session-id="${server.sessionId}"]'
      ))`);
      await evaluate(`document.querySelector(
        'button.session-item[data-session-id="${server.sessionId}"]'
      ).click()`);
      await waitFor(`document.querySelector("#messages").textContent.includes("Second answer")`);
      assert.deepEqual(await evaluate(chatTranscript), scenario.expected);
      if (scenario.expectedReasoning) {
        assert.equal(
          await evaluate(`Array.from(document.querySelectorAll(".thinking-content-text"))
            .map((element) => element.textContent).join("\\n")`),
          scenario.expectedReasoning
        );
      }
      if (scenario.expectedActivities) {
        assert.deepEqual(
          await evaluate(`Array.from(document.querySelectorAll(".tool-activity-title"))
            .map((element) => element.textContent)`),
          scenario.expectedActivities
        );
      }
      assert.equal(
        await evaluate(`document.querySelector("#messages").textContent.includes("Hidden native")`),
        false
      );
    });
  }
});

test("keeps historical and live responses, reasoning, and tool activity visible", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const history = [
    nativeTranscriptEvent("user.message", "stored-user", "Older question", 0),
    nativeTranscriptEvent("assistant.message", "stored-assistant", "Older response", 1, {
      reasoningText: "Historical reasoning.",
      toolRequests: [{ toolCallId: "stored-tool", name: "Read stored files" }]
    })
  ];
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events: history },
    promptDelayMs: 1_200
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);

  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`
    document.querySelector("#messages").textContent.includes("Older response") &&
    Array.from(document.querySelectorAll(".thinking-content-text"))
      .some((element) => element.textContent.includes("Historical reasoning."))
  `);
  assert.deepEqual(await evaluate(`
    Array.from(document.querySelectorAll(".message.assistant .message-body"))
      .map((body) => body.textContent)
  `), ["Older response"]);
  assert.deepEqual(await evaluate(`
    Array.from(document.querySelectorAll(".tool-activity-title"))
      .map((element) => element.textContent)
  `), ["History lookup", "Read stored files"]);

  await evaluate(`
    (() => {
      const input = document.querySelector("#prompt-input");
      input.value = "stream-progress";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#composer").requestSubmit();
    })();
  `);
  await server.waitForPrompt("stream-progress");
  await waitFor(`
    Array.from(document.querySelectorAll(".thinking-content-text"))
      .some((element) => element.textContent.includes(
        "Live reasoning: checking the request."
      )) &&
    Array.from(document.querySelectorAll(".tool-activity-item"))
      .some((item) =>
        item.querySelector(".tool-activity-title")?.textContent === "Inspect live history" &&
        item.querySelector(".tool-activity-status")?.textContent === "Running"
      )
  `);
  assert.equal(await evaluate(`
    Array.from(document.querySelectorAll(".message.assistant .message-body"))
      .some((body) => body.textContent === "Done.")
  `), false);

  await waitFor(`
    Array.from(document.querySelectorAll(".tool-activity-item"))
      .some((item) =>
        item.querySelector(".tool-activity-title")?.textContent === "Inspect live history" &&
        item.querySelector(".tool-activity-status")?.textContent === "Completed" &&
        item.querySelector(".tool-activity-detail")?.textContent === "Inspection complete"
      ) &&
    !Array.from(document.querySelectorAll(".message.assistant .message-body"))
      .some((body) => body.textContent === "Done.")
  `);
  await waitFor(`
    Array.from(document.querySelectorAll(".message.assistant .message-body"))
      .some((body) => body.textContent === "Done.")
  `);

  assert.deepEqual(await evaluate(`
    Array.from(document.querySelectorAll(".message.assistant .message-body"))
      .map((body) => body.textContent)
  `), ["Older response", "Done."]);
  assert.ok(await evaluate(`
    Array.from(document.querySelectorAll(".thinking-content-text"))
      .some((element) => element.textContent.includes("Historical reasoning."))
  `));
  assert.ok(await evaluate(`
    Array.from(document.querySelectorAll(".thinking-content-text"))
      .some((element) => element.textContent.includes(
        "Live reasoning: checking the request."
      ))
  `));
  assert.equal(await evaluate(`
    Array.from(document.querySelectorAll(".thinking-content-text"))
      .filter((element) => element.textContent.includes(
        "Live reasoning: checking the request."
      )).length
  `), 1);
  // Live reasoning belongs to the current turn, not to an earlier Thinking panel.
  assert.deepEqual(await evaluate(`
    Array.from(document.querySelectorAll("#messages > .message")).slice(-3).map((article) => [
      article.classList[1],
      article.querySelector(".message-text")?.textContent ??
        article.querySelector(".thinking-content-text")?.textContent ??
        article.querySelector(".message-body").textContent
    ])
  `), [
    ["user", "stream-progress"],
    ["tool", "Live reasoning: checking the request.Second round reasoning."],
    ["assistant", "Done."]
  ]);
  assert.equal(await evaluate(`
    Array.from(document.querySelectorAll(".message.tool")).filter((article) => (
      article.textContent.includes("Live reasoning") ||
      article.textContent.includes("Second round reasoning.")
    )).length
  `), 1);
  assert.ok(await evaluate(`
    Array.from(document.querySelectorAll(".thinking-content-text"))
      .some((element) => element.textContent.includes("Second round reasoning."))
  `));
  const activityTitles = await evaluate(`
    Array.from(document.querySelectorAll(".tool-activity-title"))
      .map((element) => element.textContent)
  `);
  assert.ok(Array.isArray(activityTitles));
  for (const title of ["History lookup", "Read stored files", "Inspect live history"]) {
    assert.ok(activityTitles.includes(title), `Missing activity: ${title}`);
  }
});

// Layout of the latest turn: user prompt, Thinking panels, and responses in display order.
const conversationLayout = `
  (() => {
    const articles = Array.from(document.querySelectorAll("#messages > .message"));
    const lastUser = articles.map((article) => article.classList.contains("user")).lastIndexOf(true);
    return articles.slice(Math.max(lastUser, 0));
  })().map((article) => {
    const role = article.classList[1];
    if (role !== "tool") {
      return [role, article.querySelector(".message-text")?.textContent ??
        article.querySelector(".message-body").textContent];
    }
    return [
      role,
      article.querySelector(".thinking-content-text")?.textContent ?? "",
      Array.from(article.querySelectorAll(".tool-activity-item")).map((item) => (
        item.querySelector(".tool-activity-title").textContent + ":" +
        item.querySelector(".tool-activity-status").textContent
      ))
    ];
  })
`;

test("keeps the active composer disabled when startup defaults finish during history loading", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      const response = await nativeFetch(resource, init);
      if (resource.startsWith("/api/config") && !window.defaultsHeld) {
        window.defaultsHeld = true;
        await new Promise((resolve) => { window.releaseDefaults = resolve; });
      } else if (resource.endsWith("/load") && init?.method === "POST") {
        window.historyHeld = true;
        await new Promise((resolve) => { window.releaseHistory = resolve; });
      }
      return response;
    };
  `);
  await waitFor(`window.defaultsHeld === true &&
    Boolean(document.querySelector('[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`window.historyHeld === true`);
  await evaluate(`window.releaseDefaults();
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  assert.equal(await evaluate(`document.querySelector("#send-prompt").disabled`), true);
  assert.equal(await evaluate(`document.querySelector("#prompt-input").disabled`), true);
  await evaluate(`window.releaseHistory()`);
  await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
    document.querySelector("#send-prompt").disabled === false &&
    document.querySelector("#prompt-input").disabled === false`);
  assert.equal((await server.requests()).some((entry) => entry.method === "session/prompt"), false);
  assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
});

test("streams reasoning and activities in real time, grouped between visible messages", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 60_000
}, async (t) => {
  for (const nativeMessages of [true, false]) {
    await t.test(nativeMessages ? "native message history" : "ACP-only history", async (t) => {
      const server = await startTestServer(t, {
        nativeMessages,
        ...(nativeMessages ? { nativeHistory: { events: [] } } : {}),
        promptDelayMs: 20
      });
      await server.pauseToolRound(true);
      await server.pausePromptCompletion(true);
      registerResourceCleanup(t, async () => {
        await server.pauseToolRound(false);
        await server.pausePromptCompletion(false);
      });
      const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
      await waitFor(`Boolean(document.querySelector(
        'button.session-item[data-session-id="${server.sessionId}"]'
      ))`);
      await evaluate(`document.querySelector(
        'button.session-item[data-session-id="${server.sessionId}"]'
      ).click()`);
      await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
        document.querySelector("#prompt-input").disabled === false &&
        !document.querySelector("#send-prompt").disabled`);
      await evaluate(`
        (() => {
          const input = document.querySelector("#prompt-input");
          input.value = "interleaved-rounds";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          document.querySelector("#composer").requestSubmit();
        })();
      `);

      // The first round must appear while Copilot is still working.
      await waitFor(`JSON.stringify(${conversationLayout}) === JSON.stringify([
        ["user", "interleaved-rounds"],
        ["tool", "Round one: inspect the code.", ["Inspect code:Running"]]
      ])`);
      await server.pauseToolRound(false);

      // A visible response closes the first Thinking panel; later reasoning starts a new one.
      await waitFor(`JSON.stringify(${conversationLayout}) === JSON.stringify([
        ["user", "interleaved-rounds"],
        ["tool", "Round one: inspect the code.", ["Inspect code:Completed"]],
        ["assistant", "Intermediate update."],
        ["tool", "Round two: run the tests.", ["Run tests:Completed"]]
      ])`);
      await server.pausePromptCompletion(false);

      const expected = [
        ["user", "interleaved-rounds"],
        ["tool", "Round one: inspect the code.", ["Inspect code:Completed"]],
        ["assistant", "Intermediate update."],
        ["tool", "Round two: run the tests.", ["Run tests:Completed"]],
        ["assistant", "Done."]
      ];
      await waitFor(`JSON.stringify(${conversationLayout}) === ${JSON.stringify(JSON.stringify(expected))}`);

      await evaluate("window.beforeReasoningReload = true");
      await command("Page.reload", {}, sessionId);
      await waitFor(`
        window.beforeReasoningReload !== true &&
        document.querySelector("#messages")?.textContent.includes("Done.")
      `);
      assert.deepEqual(await evaluate(conversationLayout), expected);
    });
  }
});

for (const duringHydration of [false, true]) {
  test(`preserves active Thinking panels across refresh ${duringHydration ? "while activity arrives during hydration" : "in a paged existing conversation"
    }`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const server = await startTestServer(t, {
      existingSession: true,
      nativeMessages: true,
      nativeHistory: { events: longConversationEvents(60), readDelayMs: duringHydration ? 800 : 0 },
      promptDelayMs: 20
    });
    await server.pausePromptCompletion(true);
    const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
    await command("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false
    }, sessionId);
    await waitFor(`Boolean(document.querySelector('[data-session-id="session-1"]'))`);
    await evaluate(`document.querySelector('[data-session-id="session-1"]').click()`);
    await waitFor(`document.querySelector("#messages").textContent.includes("Stored message 59") &&
    document.querySelector("#send-prompt").disabled === false`);
    await evaluate(`
    document.querySelector("#prompt-input").value = "interleaved-rounds";
    document.querySelector("#composer").requestSubmit();
  `);
    const activeLayout = [
      ["user", "interleaved-rounds"],
      ["tool", "Round one: inspect the code.", ["Inspect code:Completed"]],
      ["assistant", "Intermediate update."],
      ["tool", "Round two: run the tests.", ["Run tests:Completed"]]
    ];
    const beforeRefresh = duringHydration ? [
      ["user", "interleaved-rounds"],
      ["tool", "Round one: inspect the code.", ["Inspect code:Running"]]
    ] : activeLayout;
    await waitFor(`JSON.stringify(${conversationLayout}) === ${JSON.stringify(JSON.stringify(beforeRefresh))}`);
    for (let reload = 0; reload < 2; reload += 1) {
      await evaluate(`window.beforeThinkingRefresh = true`);
      await command("Page.reload", {}, sessionId);
      await waitFor(`!window.beforeThinkingRefresh &&
      document.querySelector("#messages")?.getAttribute("aria-busy") === "false" &&
      document.querySelector("#messages").textContent.includes("Intermediate update.")`);
      assert.deepEqual(await evaluate(conversationLayout), activeLayout);
      assert.equal(await evaluate(`document.querySelector("#cancel-prompt").disabled`), false);
    }
    await server.pausePromptCompletion(false);
    await waitFor(`document.querySelector("#cancel-prompt").disabled === true &&
      sessionStorage.getItem("copilot-web-pending-sends") === null &&
      document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
      document.querySelector("#messages").textContent.includes("Done.")`);
    const completedLayout = [...activeLayout, ["assistant", "Done."]];
    assert.deepEqual(await evaluate(conversationLayout), completedLayout);
    await evaluate(`window.beforeCompletedRefresh = true`);
    await command("Page.reload", {}, sessionId);
    await waitFor(`!window.beforeCompletedRefresh &&
    document.querySelector("#messages")?.getAttribute("aria-busy") === "false" &&
    document.querySelector("#messages").textContent.includes("Done.")`);
    assert.deepEqual(await evaluate(conversationLayout), completedLayout);
    assert.equal((await server.requests()).filter((request) => request.method === "session/prompt").length, 1);
    assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
  });
}

test("restores complete persisted reasoning after its initial cached chunks are evicted", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true, nativeMessages: true,
    nativeHistory: { events: longConversationEvents(60) }, promptDelayMs: 200
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector('[data-session-id="session-1"]'))`);
  await evaluate(`document.querySelector('[data-session-id="session-1"]').click()`);
  await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
    document.querySelector("#messages").textContent.includes("Stored message 59")`);
  await evaluate(`
    document.querySelector("#prompt-input").value = "evicted-thinking";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`document.querySelector("#messages").textContent.includes("First preserved reasoning.") &&
    document.querySelector("#messages").textContent.includes("Done.") &&
    document.querySelector("#cancel-prompt").disabled === true`);
  const persisted = await server.nativeHistory();
  assert.ok(JSON.stringify(persisted).includes("First preserved reasoning. Last reasoning fragment."));
  for (let reload = 0; reload < 2; reload += 1) {
    await evaluate(`window.beforeCacheRefresh = true`);
    await command("Page.reload", {}, sessionId);
    await waitFor(`!window.beforeCacheRefresh &&
      document.querySelector("#messages")?.getAttribute("aria-busy") === "false" &&
      document.querySelector("#messages").textContent.includes("evicted-thinking")`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll(".thinking-content-text")]
      .map((node) => node.textContent).filter((text) => text.includes("reasoning"))`),
      ["First preserved reasoning. Last reasoning fragment."]);
    assert.equal(await evaluate(`document.querySelectorAll(".message.assistant").length`), 10);
  }
  assert.equal((await server.requests()).filter((entry) => entry.text === "evicted-thinking").length, 1);
  assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
});

for (const scenario of [
  {
    name: "cached suffix",
    cached: "Last reasoning fragment.",
    expected: "First preserved reasoning. Last reasoning fragment."
  },
  {
    name: "cached prefix",
    cached: "First preserved reasoning.",
    expected: "First preserved reasoning. Last reasoning fragment."
  },
  {
    name: "complete cached text and later thoughts",
    cached: "First preserved reasoning. Last reasoning fragment. Additional live thought.",
    expected: "First preserved reasoning. Last reasoning fragment. Additional live thought."
  },
  {
    name: "overlapping cached tail and later thoughts",
    cached: "Last reasoning fragment. Additional live thought.",
    expected: "First preserved reasoning. Last reasoning fragment. Additional live thought."
  },
  {
    name: "overlapping cached prefix and earlier thoughts",
    cached: "Earlier reasoning. First preserved reasoning.",
    expected: "Earlier reasoning. First preserved reasoning. Last reasoning fragment."
  },
  {
    name: "long repeated overlap",
    complete: `BEGIN ${"a".repeat(12_000)}`,
    cached: `${"a".repeat(6_000)} END`,
    expected: `BEGIN ${"a".repeat(12_000)} END`
  },
  {
    name: "a Unicode overlap",
    complete: "First \u03b1\u03b2\u03b3",
    cached: "\u03b1\u03b2\u03b3 next",
    expected: "First \u03b1\u03b2\u03b3 next"
  }
]) {
  test(`merges complete saved reasoning with ${scenario.name}`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const completeReasoning = scenario.complete ?? "First preserved reasoning. Last reasoning fragment.";
    const server = await startTestServer(t, {
      existingSession: true, nativeMessages: true,
      nativeHistory: { events: [
        ...longConversationEvents(40),
        nativeTranscriptEvent("user.message", "review-user", "Question", 42),
        nativeTranscriptEvent("assistant.message", "review-assistant", "Answer", 43, {
          reasoningText: completeReasoning
        })
      ] }
    });
    const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (resource, init) => {
        const response = await nativeFetch(resource, init);
        if (resource.endsWith("/load") && init?.method === "POST") {
          const payload = await response.json();
          const index = payload.replayUpdates.findIndex((entry) => entry.update?.messageId === "review-assistant");
          payload.replayUpdates.splice(index, 0, {
            sessionId: "session-1", afterMessageId: "review-user",
            update: { sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: ${JSON.stringify(scenario.cached)} } }
          });
          return new Response(JSON.stringify(payload), { status: 200, headers: response.headers });
        }
        return response;
      };
    `);
    await waitFor(`Boolean(document.querySelector('[data-session-id="session-1"]'))`);
    await evaluate(`document.querySelector('[data-session-id="session-1"]').click()`);
    await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
      document.querySelector("#messages").textContent.includes("Answer")`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll(".thinking-content-text")]
      .map((node) => node.textContent)`), [
      scenario.expected
    ]);
  });
}

for (const duringHydration of [false, true]) {
  test(`restores one activity when its completion follows another reply${
    duringHydration ? " during hydration" : ""
  }`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const server = await startTestServer(t, {
      existingSession: true, nativeMessages: true,
      nativeHistory: { events: longConversationEvents(60), readDelayMs: duringHydration ? 500 : 0 },
      promptDelayMs: 20
    });
    await server.pausePromptCompletion(true);
    const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
    await command("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false
    }, sessionId);
    await waitFor(`Boolean(document.querySelector('[data-session-id="session-1"]'))`);
    await evaluate(`document.querySelector('[data-session-id="session-1"]').click()`);
    await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
      document.querySelector("#messages").textContent.includes("Stored message 59")`);
    await evaluate(`
      document.querySelector("#prompt-input").value = "crossed-tool-update";
      document.querySelector("#composer").requestSubmit();
    `);
    const active = [
      ["user", "crossed-tool-update"],
      ["tool", "Round one: inspect the code.", ["Inspect code:Completed"]],
      ["assistant", "Intermediate update."],
      ["tool", "Round two: run the tests.", ["Run tests:Completed"]]
    ];
    await waitFor(duringHydration
      ? `document.querySelector(".tool-activity-status")?.textContent === "Running"`
      : `JSON.stringify(${conversationLayout}) === ${JSON.stringify(JSON.stringify(active))}`);
    await evaluate(`window.beforeToolRefresh = true`);
    await command("Page.reload", {}, sessionId);
    await waitFor(`!window.beforeToolRefresh &&
      document.querySelector("#messages")?.getAttribute("aria-busy") === "false" &&
      document.querySelector("#messages").textContent.includes("Intermediate update.")`);
    await waitFor(`JSON.stringify(${conversationLayout}) === ${JSON.stringify(JSON.stringify(active))}`);
    await server.pausePromptCompletion(false);
    await waitFor(`document.querySelector("#messages").textContent.includes("Done.") &&
      document.querySelector("#cancel-prompt").disabled === true &&
      sessionStorage.getItem("copilot-web-pending-sends") === null`);
    const completed = [...active, ["assistant", "Done."]];
    assert.deepEqual(await evaluate(conversationLayout), completed);
    await evaluate(`window.beforeCompletedToolRefresh = true`);
    await command("Page.reload", {}, sessionId);
    await waitFor(`!window.beforeCompletedToolRefresh &&
      document.querySelector("#messages")?.getAttribute("aria-busy") === "false" &&
      document.querySelector("#messages").textContent.includes("Done.")`);
    assert.deepEqual(await evaluate(conversationLayout), completed);
    assert.equal((await server.requests()).filter((entry) => entry.text === "crossed-tool-update").length, 1);
    assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
  });
}

test("keeps persisted reasoning when a newer live message snapshot omits it", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events: [
      nativeTranscriptEvent("user.message", "reasoning-user", "A historical question", 0),
      nativeTranscriptEvent("assistant.message", "reasoning-assistant", "A historical answer", 1, {
        reasoningText: "Persisted reasoning must survive."
      })
    ] }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      const response = await nativeFetch(resource, init);
      if (resource.endsWith("/load") && init?.method === "POST") {
        const payload = await response.json();
        const assistant = payload.nativeMessages.find((message) => message.role === "assistant");
        payload.liveNativeMessages = [{
          ...assistant, revision: assistant.revision + 1, reasoningText: undefined
        }];
        return new Response(JSON.stringify(payload), { status: response.status, headers: response.headers });
      }
      return response;
    };
  `);
  await waitFor(`Boolean(document.querySelector('[data-session-id="session-1"]'))`);
  await evaluate(`document.querySelector('[data-session-id="session-1"]').click()`);
  await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
    document.querySelector("#messages").textContent.includes("A historical answer")`);
  assert.equal(await evaluate(`document.querySelector(".thinking-content-text")?.textContent`),
    "Persisted reasoning must survive.");
  assert.equal(await evaluate(`document.querySelectorAll(".message.assistant").length`), 1);
});

for (const timing of ["completion", "new round", "streaming native round", "failed snapshot"]) {
  test(`retains post-snapshot native messages and activity: ${timing}`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 25_000
  }, async (t) => {
    const server = await startTestServer(t, {
      existingSession: true, nativeMessages: true,
      nativeHistory: { events: longConversationEvents(60) }, promptDelayMs: 20
    });
    await server.pausePromptCompletion(true);
    await server.pauseToolCompletion(true);
    await server.pauseToolRound(timing !== "completion");
    const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (resource, init) => {
        const response = await nativeFetch(resource, init);
        if (resource.endsWith("/load") && init?.method === "POST" &&
            sessionStorage.getItem("hold-snapshot")) {
          sessionStorage.removeItem("hold-snapshot");
          const text = await response.text();
          window.snapshotSequence = JSON.parse(text).updateSequence;
          window.snapshotHeld = true;
          await new Promise((resolve) => { window.releaseSnapshot = resolve; });
          return new Response(${JSON.stringify(timing)} === "failed snapshot"
            ? JSON.stringify({ error: "Snapshot response unavailable" }) : text,
            { status: ${timing === "failed snapshot" ? 503 : 200},
              headers: response.headers });
        }
        return response;
      };
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener("session-update", (event) => {
            const value = JSON.parse(event.data);
            if (value.update?.toolCallId === "round-two-tool" && value.update.status === "completed") {
              window.completedToolSequence = value.updateSequence;
            }
          });
        }
      };
    `);
    try {
      await waitFor(`Boolean(document.querySelector('[data-session-id="session-1"]'))`);
      await evaluate(`document.querySelector('[data-session-id="session-1"]').click()`);
      await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
        document.querySelector("#messages").textContent.includes("Stored message 59")`);
      const text = timing === "streaming native round" ? "streaming-crossed-tool-update" : "crossed-tool-update";
      const prompt = server.post("messages", {
        text, clientPromptId: `snapshot-${timing.replaceAll(" ", "-")}`
      });
      await waitFor(`[...document.querySelectorAll(".tool-activity-item")].some((item) =>
        item.querySelector(".tool-activity-title")?.textContent === ${
          JSON.stringify(timing === "completion" ? "Run tests" : "Inspect code")
        } && item.querySelector(".tool-activity-status")?.textContent === "Running")`);
      await evaluate(`sessionStorage.setItem("hold-snapshot", "true")`);
      await command("Page.reload", {}, sessionId);
      await waitFor(`window.snapshotHeld === true`);
      await server.pauseToolRound(false);
      await server.pauseToolCompletion(false);
      await waitFor(`Number.isSafeInteger(window.completedToolSequence) &&
        window.completedToolSequence > window.snapshotSequence`);
      await evaluate(`window.releaseSnapshot()`);
      await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
        document.querySelector("#messages").textContent.includes("Intermediate update.")`);
      assert.equal(await evaluate(`[...document.querySelectorAll(".tool-activity-item")]
        .find((item) => item.querySelector(".tool-activity-title")?.textContent === "Run tests")
        ?.querySelector(".tool-activity-status")?.textContent`), "Completed");
      if (timing === "failed snapshot") {
        assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes(
          "Snapshot response unavailable")`), true);
        await evaluate(`window.beforeRetry = true`);
        await command("Page.reload", {}, sessionId);
        await waitFor(`!window.beforeRetry &&
          document.querySelector("#messages")?.getAttribute("aria-busy") === "false" &&
          document.querySelector("#messages").textContent.includes("Intermediate update.")`);
      }
      const activeLayout = [
        ["user", text],
        ["tool", "Round one: inspect the code.", ["Inspect code:Completed"]],
        ["assistant", "Intermediate update."],
        ["tool", "Round two: run the tests.", ["Run tests:Completed"]]
      ];
      assert.deepEqual(await evaluate(conversationLayout), activeLayout);
      await server.pausePromptCompletion(false);
      assert.equal((await prompt).status, 200);
      await waitFor(`document.querySelector("#messages").textContent.includes("Done.") &&
        document.querySelector("#cancel-prompt").disabled === true`);
      assert.deepEqual(await evaluate(conversationLayout), [...activeLayout, ["assistant", "Done."]]);
      assert.equal((await server.requests()).filter((entry) => entry.method === "session/prompt").length, 1);
      assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
    } finally {
      await server.pausePromptCompletion(false);
      await server.pauseToolRound(false);
      await server.pauseToolCompletion(false);
    }
  });
}

for (const input of ["/mcp reload", "acp-only-reply"]) {
  for (const paged of [false, true]) {
    test(`restores ${input === "/mcp reload" ? "an active command" : "an unpersisted assistant"} reply once across snapshot and completion fallback${paged ? " with paged history" : ""
      }`, {
      skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
      timeout: 20_000
    }, async (t) => {
      const server = await startTestServer(t, {
        existingSession: true, nativeMessages: true,
        nativeHistory: { events: paged ? longConversationEvents(60) : nativeHistoryEvents() }, reloadDelayMs: 20
      });
      await server.pausePromptResponse(true);
      const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        window.commandOutputEvents = [];
        this.addEventListener("session-update", (event) => {
          const value = JSON.parse(event.data);
          if (JSON.stringify(value.update).includes(${JSON.stringify(input === "/mcp reload" ? "MCP configuration reloaded" : "OK")})) {
            window.commandOutputReceived = true;
            window.commandOutputEvents.push(value);
          }
        });
      }
    };
  `);
      try {
        await waitFor(`Boolean(document.querySelector('[data-session-id="session-1"]'))`);
        await evaluate(`document.querySelector('[data-session-id="session-1"]').click()`);
        await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
      document.querySelector("#messages").textContent.includes(${JSON.stringify(paged ? "Stored message 59" : "Native historical reply")
          })`);
        if (input === "/mcp reload") {
          await evaluate(`document.querySelector("#reconnect-tools").click()`);
        } else {
          await evaluate(`
        document.querySelector("#prompt-input").value = ${JSON.stringify(input)};
        document.querySelector("#composer").requestSubmit();
      `);
        }
        await waitFor(`window.commandOutputReceived === true`);
        await evaluate(`window.beforeCommandRefresh = true`);
        await command("Page.reload", {}, sessionId);
        await waitFor(`!window.beforeCommandRefresh &&
      document.querySelector("#messages")?.getAttribute("aria-busy") === "false" &&
      document.querySelector("#cancel-prompt").disabled === false`);
        const reply = input === "/mcp reload" ? "MCP configuration reloaded and servers restarted." : "OKOK";
        if (!paged && input === "/mcp reload") {
          await waitFor(`document.querySelector("#messages").textContent.includes(${JSON.stringify(reply)})`);
        }
        await server.pausePromptResponse(false);
        await waitFor(`document.querySelector("#cancel-prompt").disabled === true &&
      document.querySelector("#messages").textContent.includes(${JSON.stringify(reply)})`);
        await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        assert.deepEqual(await evaluate(`[...document.querySelectorAll(".message.assistant .message-body")]
      .filter((node) => node.textContent.includes(${JSON.stringify(reply)}))
      .map((node) => node.textContent)`), [reply]);
        assert.deepEqual(await evaluate(`window.commandOutputEvents.map((value) => [
      Number.isSafeInteger(value.sourceUpdateSequence),
      value.updateSequence > value.sourceUpdateSequence,
      value.${input === "/mcp reload" ? "nativeCommand" : "nativeFallback"}
    ])`), Array.from({ length: input === "/mcp reload" ? 1 : 2 }, () => [true, true, true]));
        assert.equal(await evaluate(`[...document.querySelectorAll(".message.user .message-body")]
      .filter((node) => node.textContent === ${JSON.stringify(input)}).length`), 1);
        assert.equal((await server.requests()).filter((entry) => entry.text === input).length, 1);
        await evaluate(`window.beforeCompletedReplyRefresh = true`);
        await command("Page.reload", {}, sessionId);
        await waitFor(`!window.beforeCompletedReplyRefresh &&
      document.querySelector("#messages")?.getAttribute("aria-busy") === "false" &&
      document.querySelector("#messages").textContent.includes(${JSON.stringify(reply)})`);
        await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        assert.deepEqual(await evaluate(`[...document.querySelectorAll(".message.assistant .message-body")]
      .filter((node) => node.textContent.includes(${JSON.stringify(reply)}))
      .map((node) => node.textContent)`), [reply]);
        assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
      } finally {
        await server.pausePromptResponse(false);
      }
    });
  }
}

test("groups persisted reasoning from consecutive tool rounds into one Thinking panel", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: {
      events: [
        nativeTranscriptEvent("user.message", "rounds-user", "Investigate", 0),
        nativeTranscriptEvent("assistant.message", "round-1", "", 1, {
          reasoningText: "Plan the search.",
          toolRequests: [{ toolCallId: "round-1-tool", name: "Search files" }]
        }),
        nativeTranscriptEvent("assistant.message", "round-2", "", 2, {
          reasoningText: "Narrow the results.",
          toolRequests: [{ toolCallId: "round-2-tool", name: "Read file" }]
        }),
        nativeTranscriptEvent("assistant.message", "round-final", "Investigation done", 3, {
          reasoningText: "Summarize the findings."
        })
      ]
    }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Investigation done")`);

  assert.deepEqual(await evaluate(`
    Array.from(document.querySelectorAll("#messages > .message"))
      .map((article) => article.classList[1])
  `), ["user", "tool", "assistant"]);
  const reasoning = await evaluate(`
    document.querySelector(".thinking-content-text").textContent
  `);
  assert.equal(typeof reasoning, "string");
  const reasoningText = String(reasoning);
  const positions = ["Plan the search.", "Narrow the results.", "Summarize the findings."]
    .map((text) => reasoningText.indexOf(text));
  assert.ok(positions.every((position) => position >= 0), reasoningText);
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.deepEqual(await evaluate(`
    Array.from(document.querySelectorAll(".tool-activity-title"))
      .map((element) => element.textContent)
  `), ["History lookup", "Search files", "Read file"]);
});

test("keeps one Thinking panel when a refreshed turn spans history pages", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const rounds = Array.from({ length: 6 }, (_, index) => nativeTranscriptEvent(
    "assistant.message",
    `paged-round-${index + 1}`,
    "",
    index + 1,
    {
      reasoningText: `Round ${index + 1} reasoning. ${"detail ".repeat(6_000)}`,
      toolRequests: [{
        toolCallId: `paged-round-tool-${index + 1}`,
        name: `Inspect ${index + 1}`
      }]
    }
  ));
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: {
      events: [
        nativeTranscriptEvent("user.message", "paged-round-user", "Investigate", 0),
        ...rounds,
        nativeTranscriptEvent("assistant.message", "paged-round-answer", "Investigation done", 7)
      ]
    }
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const historyComplete = `
    document.querySelectorAll(".tool-activity-item").length === 6 &&
    document.querySelector(".message.user .message-body")?.textContent === "Investigate" &&
    !document.querySelector("#history-loading") &&
    !document.querySelector("#load-older-messages")
  `;
  const loadAllPages = async () => {
    for (let page = 0; page < 5; page += 1) {
      if (await evaluate(historyComplete)) {
        return;
      }
      if (!await scrollUpAndWaitForHistory(evaluate, waitFor)) {
        break;
      }
    }
    await waitFor(historyComplete);
  };

  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Investigation done")`);
  await loadAllPages();

  await evaluate("window.beforeThinkingReload = true");
  await command("Page.reload", {}, sessionId);
  await waitFor(`
    window.beforeThinkingReload !== true &&
    document.querySelector("#messages")?.textContent.includes("Investigation done")
  `);
  await loadAllPages();

  assert.equal(await evaluate(`document.querySelectorAll(".message.tool").length`), 1);
  assert.deepEqual(await evaluate(`
    Array.from(document.querySelectorAll(".tool-activity-title"))
      .map((element) => element.textContent)
  `), rounds.map((_, index) => `Inspect ${index + 1}`));
  const reasoning = String(await evaluate(`
    document.querySelector(".thinking-content-text")?.textContent ?? ""
  `));
  const reasoningPositions = rounds.map((_, index) => (
    reasoning.indexOf(`Round ${index + 1} reasoning.`)
  ));
  assert.ok(reasoningPositions.every((position) => position >= 0), reasoning);
  assert.deepEqual(
    reasoningPositions,
    [...reasoningPositions].sort((left, right) => left - right)
  );
});

test("maps queued prompts to native messages and leaves cancelled replies untimed", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const server = await startTestServer(t, {
    nativeMessages: true,
    nativeHistory: {
      events: [],
      timestamp: "2026-10-14T10:00:00.000Z"
    },
    promptDelayMs: 500
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const promptInput = `document.querySelector("#prompt-input")`;
  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`!document.querySelector("#send-prompt").disabled`);

  await evaluate(`
    (() => {
      const input = ${promptInput};
      input.value = "first native prompt";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#composer").requestSubmit();
    })();
  `);
  await server.waitForPrompt("first native prompt");
  await evaluate(`
    (() => {
      const input = ${promptInput};
      input.value = "second queued prompt";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#composer").requestSubmit();
    })();
  `);
  await server.waitForPrompt("second queued prompt");
  await waitFor(`
    [...document.querySelectorAll(".message.user .message-body")]
      .some((body) => body.textContent === "first native prompt") &&
    [...document.querySelectorAll(".message.user .message-body")]
      .some((body) => body.textContent === "second queued prompt") &&
    [...document.querySelectorAll(".message.assistant .message-body")]
      .some((body) => body.textContent === "Partial response before cancellation.") &&
    [...document.querySelectorAll(".message.assistant .message-body")]
      .some((body) => body.textContent === "Done.")
  `);
  await waitFor(`document.querySelectorAll(".message.assistant time.message-timestamp").length === 1`);

  assert.deepEqual(await evaluate(`
    [...document.querySelectorAll(".message.user .message-body")]
      .map((body) => body.textContent)
  `), ["first native prompt", "second queued prompt"]);
  assert.deepEqual(await evaluate(`
    [...document.querySelectorAll(".message.assistant .message-body")]
      .map((body) => body.textContent)
  `), ["Partial response before cancellation.", "Done."]);
  assert.equal(
    await evaluate(`document.querySelectorAll(".message.assistant time.message-timestamp").length`),
    1
  );
  assert.equal(
    await evaluate(`document.querySelector(".message.assistant time.message-timestamp").dateTime`),
    "2026-10-14T10:00:00.300Z"
  );
  assert.deepEqual(
    (await server.requests())
      .filter((request) => request.method === "session/prompt")
      .map((request) => request.text),
    ["first native prompt", "second queued prompt"]
  );
});

test("sizes composer selectors to their labels and wraps usage without overlap", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true,
    quotaCommand: "success"
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`
    !document.querySelector('#reconnect-tools').disabled &&
    !document.querySelector('#model-select').disabled &&
    [...document.querySelector('#model-select').options].some((option) => option.text === 'Claude Sonnet 5.5')
  `);
  await evaluate(`
    document.querySelector('#usage-summary').hidden = false;
    document.querySelector('#usage-aic-metric').hidden = false;
    document.querySelector('#usage-context-metric').hidden = false;
  `);
  const labelsFit = `[...document.querySelectorAll('.composer-setting select')].every((select) => {
    const width = select.getBoundingClientRect().width;
    return [...select.options].every((option) => {
      const probe = select.cloneNode(false);
      probe.removeAttribute('id');
      probe.append(new Option(option.text));
      probe.style.cssText = 'position:absolute;visibility:hidden;width:auto;min-width:0;max-width:none';
      select.parentElement.append(probe);
      const needed = probe.getBoundingClientRect().width;
      probe.remove();
      return width + 0.5 >= needed;
    });
  })`;
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
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1360, height: 900, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  for (const [aic, context] of [
    ["0.13 cr", "36.8K / 872K"],
    ["144.04 cr", "153.5K / 968K"]
  ]) {
    await evaluate(`
      document.querySelector('#usage-aic').textContent = ${JSON.stringify(aic)};
      document.querySelector('#usage-context').textContent = ${JSON.stringify(context)};
    `);
    assert.equal(await evaluate(`(() => {
      const usage = document.querySelector('#usage-summary').getBoundingClientRect();
      const settings = [...document.querySelectorAll('.composer-setting')]
        .map((element) => element.getBoundingClientRect());
      const settingsBottom = Math.max(...settings.map((box) => box.bottom));
      const staysInline = settings.every((box) => Math.abs(box.bottom - usage.bottom) < 1) &&
        usage.left >= settings[2].right;
      return staysInline || usage.top >= settingsBottom - 1;
    })()`), true, `Usage should stay inline or wrap below selectors with ${aic} and ${context}`);
    assert.equal(await evaluate(labelsFit), true, `Selector labels should fit with ${aic} and ${context}`);
    assert.equal(await evaluate(noOverlap), true);
  }
  assert.equal(await evaluate(`(() => {
    const labels = [...document.querySelectorAll(
      '#usage-summary .usage-metric:not([hidden]) .usage-label'
    )].map((label) => label.getBoundingClientRect().top);
    return labels.every((top) => Math.abs(top - labels[0]) < 1);
  })()`), true, "Usage metric labels should align vertically");
  assert.equal(await evaluate(`
    (() => {
      const message = document.createElement("div");
      message.className = "message";
      document.body.append(message);
      const messageWidth = getComputedStyle(message).maxWidth;
      message.remove();
      return getComputedStyle(document.querySelector(".composer")).maxWidth === messageWidth;
    })()
  `), true, "Composer and conversation history should share a maximum width");
  for (const width of [1200, 1000, 801, 768, 390, 320]) {
    await command("Emulation.setDeviceMetricsOverride", {
      width, height: 900, deviceScaleFactor: 1, mobile: false
    }, sessionId);
    assert.equal(await evaluate(labelsFit), true, `Selector labels should fit at ${width}px`);
    assert.equal(await evaluate(noOverlap), true, `Composer should not overflow or overlap at ${width}px`);
    assert.equal(await evaluate(`document.querySelector('#keep-awake').nextElementSibling.id`), "reconnect-tools");
  }
});

test("shows a focusable warning when the GitHub CLI cannot retrieve quota", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { quotaCommand: "missing" });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`!document.querySelector("#usage-quota-warning").hidden`);
  assert.equal(
    await evaluate(`document.querySelector("#usage-quota-warning").title`),
    "GitHub CLI (gh) not available or not authenticated; quota could not be retrieved."
  );
  assert.equal(
    await evaluate(`document.querySelector("#usage-quota-warning").getAttribute("tabindex")`),
    "0"
  );
  assert.equal(await evaluate(`document.querySelector("#usage-quota-value").hidden`), true);
});

test("refreshes quota after each AIC usage update", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true,
    nativeMessages: true,
    quotaCommand: "success",
    aicUsageEvents: 2,
    aicNoopUsageEvent: true
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const session = `document.querySelector('button.session-item[data-session-id="${server.sessionId}"]')`;
  await waitFor(`Boolean(${session})`);
  await evaluate(`${session}.click()`);
  await waitFor(`!document.querySelector("#prompt-input").disabled`);
  await waitFor(`document.querySelector("#usage-quota-value").textContent === "12.06 / 300"`);
  assert.equal((await server.githubCliRequests()).length, 1);

  await evaluate(`
    const input = document.querySelector("#prompt-input");
    input.value = "quota refresh test";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#composer").requestSubmit();
  `);
  await server.waitForPrompt("quota refresh test");
  await waitFor(`document.querySelector("#usage-aic").textContent === "2 cr"`);
  assert.equal(
    await evaluate(`document.querySelector("#usage-aic-metric .usage-label").textContent`),
    "SESSION"
  );
  assert.equal(
    await evaluate(`document.querySelector("#usage-aic-metric").title`),
    "Cumulative AI credits used in this session; when a session limit is shown, format is used / limit."
  );
  const deadline = Date.now() + 5_000;
  while ((await server.githubCliRequests()).length < 4) {
    assert.ok(Date.now() < deadline, "Quota was not refreshed for every AIC update");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await server.githubCliRequests()).length, 4);
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
  await waitFor(`document.querySelector('#messages').scrollTop === 0 &&
    !${button}.hidden && !${button}.disabled`);
});

test("keeps scroll positions independent when switching conversations", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const secondSessionId = await server.createSession();
  const historyText = Array.from(
    { length: 40 },
    (_, index) => `History paragraph ${index}.`
  ).join("\n\n");
  for (const sessionId of [server.sessionId, secondSessionId]) {
    assert.equal((await server.post("messages", { text: historyText }, sessionId)).status, 200);
  }
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const selectConversation = async (sessionId: string) => {
    const button = `document.querySelector('button.session-item[data-session-id="${sessionId}"]')`;
    await waitFor(`Boolean(${button})`);
    await evaluate(`${button}.click()`);
    await waitFor(`
      window.localStorage.getItem("copilot-web-active-session") === "${sessionId}" &&
      document.querySelector("#messages").textContent.includes("History paragraph 39.") &&
      !document.querySelector("#send-prompt").disabled
    `);
  };

  await selectConversation(server.sessionId);
  await selectConversation(secondSessionId);
  await selectConversation(server.sessionId);

  await evaluate(`(() => {
    const messages = document.querySelector("#messages");
    messages.scrollTop = 0;
    messages.dispatchEvent(new Event("scroll"));
  })()`);
  await waitFor(`document.querySelector("#messages").scrollTop === 0`);
  await selectConversation(secondSessionId);
  await waitFor(`
    document.querySelector("#messages").scrollHeight -
      document.querySelector("#messages").scrollTop -
      document.querySelector("#messages").clientHeight < 1
  `);

  await evaluate(`(() => {
    const messages = document.querySelector("#messages");
    messages.scrollTop = 150;
    messages.dispatchEvent(new Event("scroll"));
  })()`);
  await waitFor(`document.querySelector("#messages").scrollTop === 150`);
  await selectConversation(server.sessionId);
  assert.equal(await evaluate(`document.querySelector("#messages").scrollTop`), 0);
  await selectConversation(secondSessionId);
  assert.equal(await evaluate(`document.querySelector("#messages").scrollTop`), 150);
});

test("attaches multiple selections and briefly highlights their source messages", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    historyText: "Earlier answer with a distinctive detail. Final response has the exact selected phrase."
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1200, height: 900, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="session-1"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="session-1"]').click()`);
  await waitFor(`document.querySelector('#messages').textContent.includes('distinctive detail')`);

  const selectText = async (selector: string, text: string) => {
    assert.equal(await evaluate(`
      (() => {
        document.querySelector("#messages").dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true })
        );
        const root = document.querySelector(${JSON.stringify(selector)});
        const selectedText = ${JSON.stringify(text)};
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const selection = window.getSelection();
        if (!selection) return false;
        let node;
        while ((node = walker.nextNode())) {
          const start = node.textContent.indexOf(selectedText);
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + selectedText.length);
          selection.removeAllRanges();
          selection.addRange(range);
          return selection.toString() === selectedText;
        }
        return false;
      })()
    `), true, `Expected to select "${text}" in ${selector}`);
    assert.equal(await evaluate(`document.querySelector("#ask-selection").hidden`), true);
    await evaluate(`document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))`);
    await waitFor(`!document.querySelector('#ask-selection').hidden`);
  };
  const highlightedText = `(() => {
    const highlight = window.CSS.highlights?.get("copilot-web-source-selection");
    return highlight
      ? [...highlight].map((range) => range.toString()).join("")
      : window.getSelection().toString();
  })()`;

  await evaluate(`
    (() => {
      const input = document.querySelector("#prompt-input");
      input.value = "Keep this question";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })();
  `);
  await selectText(".message.user .message-body", "GoCD");
  await evaluate(`document.querySelector("#ask-selection").click()`);
  assert.equal(
    await evaluate(`document.querySelector("#prompt-input").value`),
    "Keep this question"
  );
  assert.equal(await evaluate(`document.querySelector("#selection-list").children.length`), 1);
  assert.equal(
    await evaluate(`document.querySelector(".selection-card-label").textContent`),
    "Selection 1"
  );

  await selectText(
    ".message.assistant .message-body",
    "Final response has the exact selected phrase."
  );
  await evaluate(`document.querySelector("#ask-selection").click()`);
  assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "Keep this question");
  assert.deepEqual(await evaluate(`
    [...document.querySelectorAll(".selection-card-label")].map((label) => label.textContent)
  `), ["Selection 1", "Selection 2"]);

  await evaluate(`document.querySelector('[aria-label="Jump to Selection 1 at its source"]').click()`);
  await waitFor(`
    ${highlightedText} === "GoCD" &&
    (Boolean(window.CSS.highlights?.get("copilot-web-source-selection")) ||
      document.querySelector(".message.user .message-body").classList.contains("selection-flash"))
  `);
  await waitFor(`
    (() => {
      const highlight = window.CSS.highlights?.get("copilot-web-source-selection");
      const selection = window.getSelection();
      const range = highlight
        ? [...highlight][0]
        : selection?.rangeCount
          ? selection.getRangeAt(0)
          : null;
      if (!range) return false;
      const rangeBounds = range.getBoundingClientRect();
      const viewport = document.querySelector("#messages").getBoundingClientRect();
      return rangeBounds.top >= viewport.top && rangeBounds.bottom <= viewport.bottom;
    })()
  `);
  assert.equal(
    await evaluate(`
      (() => {
        const custom = Boolean(window.CSS.highlights?.get("copilot-web-source-selection"));
        const element = document.querySelector(".message.user .message-text");
        const pseudo = custom
          ? "::highlight(copilot-web-source-selection)"
          : "::selection";
        return getComputedStyle(element, pseudo).backgroundColor;
      })()
    `),
    "rgb(245, 215, 126)"
  );
  await waitFor(`
    !window.CSS.highlights?.has("copilot-web-source-selection") &&
    window.getSelection().toString() === "" &&
    !document.querySelector(".message.user .message-body").classList.contains("selection-flash")
  `);

  await evaluate(`document.querySelector('[aria-label="Jump to Selection 2 at its source"]').click()`);
  await waitFor(`
    ${highlightedText} === "Final response has the exact selected phrase." &&
    (Boolean(window.CSS.highlights?.get("copilot-web-source-selection")) ||
      document.querySelector(".message.assistant .message-body").classList.contains("selection-flash"))
  `);
  await waitFor(`
    (() => {
      const highlight = window.CSS.highlights?.get("copilot-web-source-selection");
      const range = highlight
        ? [...highlight][0]
        : window.getSelection().getRangeAt(0);
      const rangeBounds = range.getBoundingClientRect();
      const viewport = document.querySelector("#messages").getBoundingClientRect();
      return rangeBounds.top >= viewport.top && rangeBounds.bottom <= viewport.bottom;
    })()
  `);
  await waitFor(`
    !window.CSS.highlights?.has("copilot-web-source-selection") &&
    window.getSelection().toString() === "" &&
    !document.querySelector(".message.assistant .message-body").classList.contains("selection-flash")
  `);

  await evaluate(`document.querySelector("#composer").requestSubmit()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Done.")`);
  const prompts = (await server.requests()).filter((request) => request.method === "session/prompt");
  assert.equal(
    prompts.at(-1)?.text,
    "Keep this question\n\nSelected passages from the conversation:\nSelection 1:\n> GoCD\n\nSelection 2:\n> Final response has the exact selected phrase."
  );
  assert.equal(await evaluate(`document.querySelector("#selection-list").children.length`), 0);
  assert.equal(
    await evaluate(`document.querySelector(".message.user .message-selection-summary").textContent`),
    "2 selections"
  );
  await evaluate(`document.querySelector(".message-selection-summary").click()`);
  assert.equal(await evaluate(`document.querySelector(".message-selection-menu").hidden`), false);
  await evaluate(`document.querySelector('[aria-label="Jump to Selection 2 at its source"]').click()`);
  await waitFor(`
    ${highlightedText} === "Final response has the exact selected phrase." &&
    (Boolean(window.CSS.highlights?.get("copilot-web-source-selection")) ||
      document.querySelector(".message.assistant .message-body").classList.contains("selection-flash"))
  `);
});

test("keeps multi-block selections, Ask Copilot, and highlights through re-renders", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    promptDelayMs: 700,
    historyText: "Intro paragraph text.\n\n- First list item\n- Second list item"
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="session-1"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="session-1"]').click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Second list item")`);

  const compact = (value: string) => value.replace(/\s+/g, "");
  const highlightedText = `(() => {
    const highlight = window.CSS.highlights?.get("copilot-web-source-selection");
    return highlight
      ? [...highlight].map((range) => range.toString()).join("")
      : window.getSelection().toString();
  })()`;
  const selectAcrossBlocks = `
    (() => {
      const body = document.querySelector(".message.assistant .message-body");
      const paragraph = [...body.querySelectorAll("p")]
        .find((element) => element.textContent.includes("paragraph text."));
      const item = [...body.querySelectorAll("li")]
        .find((element) => element.textContent.includes("Second list item"));
      const startNode = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode();
      const endNode = document.createTreeWalker(item, NodeFilter.SHOW_TEXT).nextNode();
      document.querySelector("#messages").dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true })
      );
      const range = document.createRange();
      range.setStart(startNode, startNode.textContent.indexOf("paragraph"));
      range.setEnd(endNode, endNode.textContent.indexOf("Second") + "Second".length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      return selection.toString();
    })()
  `;

  const selectedText = String(await evaluate(selectAcrossBlocks)).trim();
  assert.equal(compact(selectedText), "paragraphtext.FirstlistitemSecond");
  assert.match(selectedText, /\n/);
  await waitFor(`!document.querySelector("#ask-selection").hidden`);
  await evaluate(`document.querySelector("#ask-selection").click()`);
  await evaluate(`document.querySelector('[aria-label="Jump to Selection 1 at its source"]').click()`);
  await waitFor(`${highlightedText}.replace(/\\s+/g, "") === "paragraphtext.FirstlistitemSecond"`);
  assert.equal(await evaluate(`document.querySelector("#selection-status").hidden`), true);

  assert.equal((await server.post("messages", { text: "highlight survives rendering" })).status, 200);
  await waitFor(`document.querySelector("#messages").textContent.includes("Done.")`);
  assert.equal(
    compact(String(await evaluate(highlightedText))),
    "paragraphtext.FirstlistitemSecond"
  );
  await waitFor(`
    !window.CSS.highlights?.has("copilot-web-source-selection") &&
    !document.querySelector(".message-body.selection-flash")
  `);

  await evaluate(selectAcrossBlocks);
  await waitFor(`!document.querySelector("#ask-selection").hidden`);
  const responsePosted = server.post("messages", { text: "selection survives streaming" });
  await waitFor(`document.querySelector("#messages").textContent.match(/Done\\./g)?.length === 2`);
  assert.equal((await responsePosted).status, 200);
  assert.equal(await evaluate(`document.querySelector("#ask-selection").hidden`), false);
  assert.equal(
    compact(String(await evaluate(`window.getSelection().toString()`))),
    "paragraphtext.FirstlistitemSecond"
  );
  await evaluate(`document.querySelector("#ask-selection").click()`);
  assert.deepEqual(await evaluate(`
    [...document.querySelectorAll(".selection-card-label")].map((label) => label.textContent)
  `), ["Selection 1", "Selection 2"]);
});

test("restores sent selection chips and source links after a page refresh", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`
    Boolean(document.querySelector("#send-prompt")) &&
    !document.querySelector("#send-prompt").disabled
  `);
  await waitFor(`
    document.querySelector("#model-select")?.disabled === false &&
    !document.querySelector("#send-prompt").disabled
  `);

  await evaluate(`
    (() => {
      const input = document.querySelector("#prompt-input");
      input.value = "The original source marker is here.";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#composer").requestSubmit();
    })();
  `);
  await waitFor(`document.querySelector("#messages").textContent.includes("Done.")`);
  assert.equal(
    await evaluate(`typeof window.localStorage.getItem("copilot-web-active-session")`),
    "string"
  );

  const askSelectionWasHidden = await evaluate(`
    (() => {
      const messages = document.querySelector("#messages");
      messages.scrollTop = 0;
      messages.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const root = document.querySelector(".message.user .message-body");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const selection = window.getSelection();
      let node;
      while ((node = walker.nextNode())) {
        const start = node.textContent.indexOf("source marker");
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + "source marker".length);
        selection.removeAllRanges();
        selection.addRange(range);
        break;
      }
      const askSelectionWasHidden = document.querySelector("#ask-selection").hidden;
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      return askSelectionWasHidden;
    })();
  `);
  assert.equal(askSelectionWasHidden, true);
  await waitFor(`!document.querySelector("#ask-selection").hidden`);
  await evaluate(`document.querySelector("#ask-selection").click()`);
  assert.equal(await evaluate(`document.querySelector("#selection-list").children.length`), 1);

  await evaluate(`
    (() => {
      const input = document.querySelector("#prompt-input");
      input.value = "Explain this selected passage.";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#composer").requestSubmit();
    })();
  `);
  await waitFor(`document.querySelector("#messages").textContent.match(/Done\\./g)?.length === 2`);
  assert.equal(
    await evaluate(`Boolean(window.localStorage.getItem("copilot-web-selection-messages"))`),
    true
  );
  const activeSessionId = await evaluate(
    `window.localStorage.getItem("copilot-web-active-session")`
  );
  assert.equal(typeof activeSessionId, "string");
  const savedSession = await server.session(String(activeSessionId));
  assert.ok(isRecord(savedSession) && Array.isArray(savedSession.messages));
  assert.equal(savedSession.messages.length, 2);

  await evaluate(`window.beforeSelectionReload = true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`
    !window.beforeSelectionReload &&
    (() => {
      const messages = document.querySelector("#messages");
      if (!messages || messages.getAttribute("aria-busy") !== "false") return false;
      const users = messages.querySelectorAll(".message.user");
      const latest = users[users.length - 1];
      return latest?.querySelector(".message-selection-summary")?.textContent === "1 selection" &&
        latest.querySelector(".message-body")?.textContent === "Explain this selected passage.";
    })()
  `);

  await evaluate(`document.querySelector(".message-selection-summary").click()`);
  await waitFor(`
    (window.CSS.highlights?.get("copilot-web-source-selection")
      ? [...window.CSS.highlights.get("copilot-web-source-selection")].map((range) => range.toString()).join("")
      : window.getSelection().toString()) === "source marker"
  `);

  await evaluate(`
    (() => {
      window.beforeStaleSelectionReload = true;
      const key = "copilot-web-selection-messages";
      const stored = JSON.parse(window.localStorage.getItem(key));
      const [activeSessionId] = Object.keys(stored);
      const entry = stored[activeSessionId][0];
      const original = entry.selections[0];
      entry.selections = [
        { ...original, messageIndex: original.messageIndex + 3, sourceOrdinal: undefined },
        {
          ...original,
          id: "selection-2",
          number: 2,
          text: "text that no longer exists",
          startPath: [],
          endPath: [],
          startOffset: 0,
          endOffset: 0
        }
      ];
      stored["ghost-session"] = [{ ...entry, createdAt: 0 }];
      window.localStorage.setItem(key, JSON.stringify(stored));
    })();
  `);
  await command("Page.reload", {}, sessionId);
  await waitFor(`
    !window.beforeStaleSelectionReload &&
    (() => {
      const messages = document.querySelector("#messages");
      const users = messages?.querySelectorAll(".message.user");
      const latest = users?.[users.length - 1];
      return messages?.getAttribute("aria-busy") === "false" &&
        users?.length === 2 &&
        latest?.querySelector(".message-body")?.textContent ===
          "Explain this selected passage.";
    })()
  `);
  const restoredSelectionState = await evaluate(`(() => {
    const stored = JSON.parse(localStorage.getItem("copilot-web-selection-messages") ?? "{}");
    const sessionId = localStorage.getItem("copilot-web-active-session");
    const users = document.querySelectorAll("#messages .message.user");
    const latest = users[users.length - 1];
    return {
      summary: latest?.querySelector(".message-selection-summary")?.textContent,
      text: latest?.querySelector(".message-body")?.textContent,
      users: [...users].map((message) => ({
        key: message.dataset.messageKey,
        summary: message.querySelector(".message-selection-summary")?.textContent,
        text: message.querySelector(".message-body")?.textContent
      })),
      entries: stored[sessionId]
    };
  })()`);
  assert.ok(isRecord(restoredSelectionState));
  assert.equal(restoredSelectionState.summary, "2 selections", JSON.stringify(restoredSelectionState));
  await waitFor(`
    !Object.hasOwn(
      JSON.parse(window.localStorage.getItem("copilot-web-selection-messages")),
      "ghost-session"
    )
  `);
  await evaluate(`document.querySelector(".message-selection-summary").click()`);
  await evaluate(`document.querySelector('[aria-label="Jump to Selection 1 at its source"]').click()`);
  await waitFor(`
    (window.CSS.highlights?.get("copilot-web-source-selection")
      ? [...window.CSS.highlights.get("copilot-web-source-selection")].map((range) => range.toString()).join("")
      : window.getSelection().toString()) === "source marker"
  `);
  assert.equal(await evaluate(`document.querySelector("#selection-status").hidden`), true);
  await evaluate(`document.querySelector(".message-selection-summary").click()`);
  await evaluate(`document.querySelector('[aria-label="Jump to Selection 2 at its source"]').click()`);
  await waitFor(`
    !document.querySelector("#selection-status").hidden &&
    document.querySelector("#selection-status").textContent ===
      "The selected text is no longer available in this conversation." &&
    document.querySelector("#selection-status").getBoundingClientRect().height > 0
  `);

  await evaluate(`
    window.beforeLegacySelectionReload = true;
    window.localStorage.removeItem("copilot-web-selection-messages");
  `);
  await command("Page.reload", {}, sessionId);
  await waitFor(`
    !window.beforeLegacySelectionReload &&
    (() => {
      const messages = document.querySelector("#messages");
      const users = messages?.querySelectorAll(".message.user");
      const latest = users?.[users.length - 1];
      return messages?.getAttribute("aria-busy") === "false" &&
        latest?.querySelector(".message-selection-summary")?.textContent === "1 selection" &&
        latest.querySelector(".message-body")?.textContent === "Explain this selected passage.";
    })()
  `);
  await evaluate(`document.querySelector(".message-selection-summary").click()`);
  await waitFor(`
    (window.CSS.highlights?.get("copilot-web-source-selection")
      ? [...window.CSS.highlights.get("copilot-web-source-selection")].map((range) => range.toString()).join("")
      : window.getSelection().toString()) === "source marker"
  `);
});

test("previews pending image attachments before sending", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { existingSession: true });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`window.localStorage.getItem("copilot-web-active-session") === "${server.sessionId}" &&
    document.querySelector("#attach-files").disabled === false`);

  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
  await evaluate(`
    const files = new DataTransfer();
    const image = Uint8Array.from(atob("${imageData}"), (character) => character.charCodeAt(0));
    files.items.add(new File([image], "preview.png", { type: "image/png" }));
    const fileInput = document.querySelector("#file-input");
    fileInput.files = files.files;
    fileInput.dispatchEvent(new Event("change"));
  `);
  await waitFor(`document.querySelector("#attachment-list").textContent.includes("preview.png")`);
  assert.equal(await evaluate(`
    (() => {
      const button = document.querySelector("#attachment-list .attachment-chip-image-preview");
      return button?.type === "button" &&
        button.getAttribute("aria-label") === "Preview preview.png";
    })()
  `), true);

  await evaluate(`document.querySelector("#attachment-list .attachment-chip-image-preview").click()`);
  await waitFor(`document.querySelector("#image-preview-dialog").open`);
  assert.equal(await evaluate(`document.querySelector("#image-preview-image").alt`), "preview.png");
  assert.equal(
    await evaluate(`document.querySelector("#image-preview-image").getAttribute("src")`),
    `data:image/png;base64,${imageData}`
  );

  await evaluate(`document.querySelector("#image-preview-dialog").close()`);
  await waitFor(`!document.querySelector("#image-preview-dialog").open &&
    !document.querySelector("#image-preview-image").hasAttribute("src")`);
  await evaluate(`document.querySelector("#attachment-list .attachment-remove").click()`);
  await waitFor(`document.querySelector("#attachment-list").children.length === 0`);
});

test("accepts arbitrary files from the picker and drag-and-drop", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { existingSession: true });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`window.localStorage.getItem("copilot-web-active-session") === "${server.sessionId}" &&
    document.querySelector("#attach-files").disabled === false`);
  assert.equal(
    await evaluate(`document.querySelector("#file-input").hasAttribute("accept")`),
    false
  );

  await evaluate(`
    const files = new DataTransfer();
    files.items.add(new File(["picker content"], "notes.txt", { type: "text/plain" }));
    const fileInput = document.querySelector("#file-input");
    fileInput.files = files.files;
    fileInput.dispatchEvent(new Event("change"));
  `);
  await waitFor(`document.querySelector("#attachment-list").textContent.includes("notes.txt")`);
  assert.equal(
    await evaluate(`document.querySelector("#attachment-list .attachment-chip-preview").textContent`),
    "FILE"
  );
  await evaluate(`document.querySelector("#attachment-list .attachment-remove").click()`);
  await waitFor(`document.querySelector("#attachment-list").children.length === 0`);

  await evaluate(`
    (() => {
      const files = new DataTransfer();
      files.items.add(new File(["drop content"], "document.odt", {
        type: "application/vnd.oasis.opendocument.text"
      }));
      const composer = document.querySelector("#composer");
      composer.dispatchEvent(new DragEvent("dragenter", {
        bubbles: true, cancelable: true, dataTransfer: files
      }));
      composer.dispatchEvent(new DragEvent("dragover", {
        bubbles: true, cancelable: true, dataTransfer: files
      }));
      composer.dispatchEvent(new DragEvent("drop", {
        bubbles: true, cancelable: true, dataTransfer: files
      }));
    })();
  `);
  await waitFor(`document.querySelector("#attachment-list").textContent.includes("document.odt")`);
  assert.equal(await evaluate(`document.querySelector("#drop-hint").hidden`), true);
  await evaluate(`
    const input = document.querySelector("#prompt-input");
    input.value = "Review this file";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#send-prompt").click();
  `);
  await server.waitForPrompt("Review this file");
  await waitFor(`document.querySelector("#messages").textContent.includes("Done.")`);
  assert.equal(
    await evaluate(`document.querySelector("#messages .message-attachment-file")?.textContent`),
    "File: document.odt"
  );

  const prompt = (await server.requests()).find((request) => request.method === "session/prompt");
  assert.ok(prompt && Array.isArray(prompt.prompt));
  const fileBlock = prompt.prompt[1];
  assert.ok(isRecord(fileBlock) && isRecord(fileBlock.resource));
  assert.equal(fileBlock.type, "resource");
  assert.equal(fileBlock.resource.mimeType, "application/vnd.oasis.opendocument.text");
  assert.equal(
    Buffer.from(String(fileBlock.resource.blob), "base64").toString(),
    "drop content"
  );
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
  await waitFor(`document.querySelector('#reconnect-tools').disabled`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  assert.equal(await evaluate(
    `document.querySelectorAll('#messages button:not(.message-copy)').length`
  ), 0);

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
    document.querySelector('#reconnect-tools').disabled
  `);
  await evaluate(`
    (() => {
      const button = document.querySelector('#reconnect-tools');
      button.disabled = false;
      button.click();
      button.disabled = true;
    })()
  `);
  assert.equal(await evaluate(
    `document.querySelectorAll('#messages button:not(.message-copy)').length`
  ), 0);
  assert.equal(await evaluate(`document.querySelector('#messages').textContent.includes('/mcp reload')`), false);
  assert.equal((await server.requests()).some((request) => request.text === "/mcp reload"), false);
  await waitFor(`
    !document.querySelector('#reconnect-tools').disabled
  `);

  const externalPrompt = server.post("messages", { text: "prompt from another tab" });
  await waitFor(`
    document.querySelector('#reconnect-tools').disabled
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
  await waitFor(`document.querySelector('#reconnect-tools').disabled`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  assert.equal(await evaluate(
    `document.querySelectorAll('#messages button:not(.message-copy)').length`
  ), 0);
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
  assert.equal(await evaluate(`document.querySelector('#reconnect-tools').disabled`), true);
  assert.equal(await evaluate(
    `document.querySelectorAll('#messages button:not(.message-copy)').length`
  ), 0);
  assert.equal((await remotePrompt).status, 200);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
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
  await waitFor(`document.querySelector('#reconnect-tools').disabled`);
  await waitFor(`!document.querySelector('#reconnect-tools').disabled`);
  assert.equal(await evaluate(
    `document.querySelectorAll('#messages button:not(.message-copy)').length`
  ), 0);
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
  assert.equal(await evaluate(
    `document.querySelectorAll('#messages button:not(.message-copy)').length`
  ), 0);
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
      window.originalFetchForPromptTest = nativeFetch;
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
  assert.equal(await evaluate(
    `document.querySelectorAll('#messages button:not(.message-copy)').length`
  ), 0);

  await evaluate(`window.fetch = window.originalFetchForPromptTest`);
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
    assert.equal(await evaluate(
      `document.querySelectorAll('#messages button:not(.message-copy)').length`
    ), 0);
  }

  const reloadCountBeforeFailures = (await server.requests())
    .filter((request) => request.text === "/mcp reload").length;
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
    await waitFor(`
      document.querySelector('#messages')?.textContent.includes(${JSON.stringify(prompt)}) &&
      document.querySelector('#cancel-prompt')?.disabled &&
      !document.querySelector('#reconnect-tools').disabled
    `);
    assert.equal(await evaluate(
      `document.querySelectorAll('#messages button:not(.message-copy)').length`
    ), 0);
  }
  assert.equal(
    (await server.requests()).filter((request) => request.text === "/mcp reload").length,
    reloadCountBeforeFailures
  );
});

function composerHelpers(command: Awaited<ReturnType<typeof startTestBrowser>>["command"], sessionId: string) {
  const type = async (text: string) => {
    for (const character of text) {
      await command("Input.insertText", { text: character }, sessionId);
    }
  };
  const press = async (key: string, modifiers = 0, code = key) => {
    const keyCodes: Record<string, number> = { Enter: 13, Tab: 9, Backspace: 8, z: 90 };
    const base = { key, code, modifiers, windowsVirtualKeyCode: keyCodes[key] ?? 0 };
    await command("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, sessionId);
    await command("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
  };
  return { type, press, shift: 8, meta: process.platform === "darwin" ? 4 : 2 };
}

test("keeps conversation times and ordering unchanged when selecting and restoring history", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const originalActivity = "2026-10-01T10:00:00.000Z";
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events: nativeHistoryEvents() },
    sessionActivity: { "session-1": originalActivity }
  });
  const createdResponse = await fetch(`${server.baseUrl}/api/sessions`, {
    method: "POST", headers: server.headers, body: "{}"
  });
  assert.equal(createdResponse.status, 201);
  const created: unknown = await createdResponse.json();
  assert.ok(isRecord(created) && isRecord(created.session));
  const newerId = String(created.session.sessionId);
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`document.querySelectorAll(".session-item").length === 2`);
  const order = `[...document.querySelectorAll(".session-item")].map((item) => item.dataset.sessionId)`;
  const oldTime = `document.querySelector('[data-session-id="session-1"] .session-meta')?.textContent`;
  assert.deepEqual(await evaluate(order), [newerId, "session-1"]);
  const originalLabel = await evaluate(oldTime);
  assert.notEqual(originalLabel, "just now");
  await evaluate(`document.querySelector('[data-session-id="session-1"]').click()`);
  await waitFor(`document.querySelector("#messages")?.textContent.includes("Native historical reply") &&
    document.querySelector("#messages").getAttribute("aria-busy") === "false"`);
  assert.deepEqual(await evaluate(order), [newerId, "session-1"]);
  assert.equal(await evaluate(oldTime), originalLabel);
  const persistedActivity = await server.metadata("session-activity.json");
  assert.ok(isRecord(persistedActivity));
  assert.equal(persistedActivity["session-1"], originalActivity);
  await evaluate(`window.beforeRefresh = true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeRefresh &&
    document.querySelector("#messages")?.textContent.includes("Native historical reply") &&
    document.querySelector("#messages").getAttribute("aria-busy") === "false"`);
  assert.deepEqual(await evaluate(order), [newerId, "session-1"]);
  assert.equal(await evaluate(oldTime), originalLabel);
  await evaluate(`
    document.querySelector("#prompt-input").value = "A genuine new activity";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`document.querySelector(".session-item")?.dataset.sessionId === "session-1" &&
    document.querySelector('[data-session-id="session-1"] .session-meta')?.textContent === "just now" &&
    document.querySelector("#messages")?.textContent.includes("Done.")`);
  await server.waitForPrompt("A genuine new activity");
});

test("keeps historical usage replay read-only while accepting genuine new usage", async (t) => {
  const originalActivity = "2026-10-01T10:00:00.000Z";
  const history: JsonObject[] = [
    ...nativeHistoryEvents(),
    { type: "assistant.usage", id: "old-usage", timestamp: originalActivity,
      data: { copilotUsage: { totalNanoAiu: 2_000_000_000 } } },
    { type: "session.usage_checkpoint", id: "old-checkpoint", timestamp: originalActivity,
      data: { totalNanoAiu: 9_000_000_000 } },
    { type: "session.session_limits_changed", id: "old-limit", timestamp: originalActivity,
      data: { sessionLimits: { maxAiCredits: 100 } } }
  ];
  const server = await startTestServer(t, {
    existingSession: true, nativeMessages: true, nativeReplay: true,
    sessionActivity: { "session-1": originalActivity },
    nativeHistory: { events: history }, aicUsageEvents: 1
  });
  const stream = openEventStream(server.baseUrl, server.headers);
  t.after(() => stream.close());
  const deadline = Date.now() + 5_000;
  while (!stream.events.some((event) => event.event === "ready")) {
    assert.ok(Date.now() < deadline, "Event stream was not ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const response = await server.post("load", { historyPaging: true });
  assert.equal(response.status, 200);
  const loaded: unknown = await response.json();
  assert.ok(isRecord(loaded) && isRecord(loaded.session));
  assert.equal(loaded.session.lastActivityAt, originalActivity);
  assert.equal(loaded.usage, null);
  assert.equal(stream.events.some((event) => event.event === "session-activity"), false);
  assert.equal(stream.events.some((event) => {
    const data = event.data;
    return event.event === "session-event" && isRecord(data) &&
      history.some((old) => old.type === data.type);
  }), false);
  const listingResponse = await fetch(`${server.baseUrl}/api/sessions`, { headers: server.headers });
  const listing: unknown = await listingResponse.json();
  assert.ok(isRecord(listing) && Array.isArray(listing.sessions));
  assert.equal(listing.sessions.find((session) => isRecord(session) &&
    session.sessionId === server.sessionId)?.lastActivityAt, originalActivity);
  assert.equal((await server.post("messages", { text: "Genuine new activity" })).status, 200);
  const liveResponse = await server.post("load", { historyPaging: true });
  assert.equal(liveResponse.status, 200);
  const liveSnapshot: unknown = await liveResponse.json();
  assert.ok(isRecord(liveSnapshot) && isRecord(liveSnapshot.usage) && isRecord(liveSnapshot.session));
  assert.equal(liveSnapshot.usage.aicNano, 1_000_000_000);
  assert.notEqual(liveSnapshot.session.lastActivityAt, originalActivity);
  const switched = await server.post("load", { historyPaging: true, context: "long_context" });
  assert.equal(switched.status, 200);
  const afterReplay: unknown = await switched.json();
  assert.ok(isRecord(afterReplay) && isRecord(afterReplay.session));
  assert.equal(afterReplay.session.lastActivityAt, liveSnapshot.session.lastActivityAt);
  assert.deepEqual(afterReplay.usage, { aicNano: 1_000_000_000, aicLimit: null });
  assert.equal((await server.requests()).filter((request) => request.method === "session/prompt").length, 1);
});

test("preserves newer activity when a delayed history response arrives", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events: nativeHistoryEvents() },
    sessionActivity: { "session-1": "2026-10-01T10:00:00.000Z" },
    promptDelayMs: 1_500
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      const response = await nativeFetch(resource, init);
      if (resource.endsWith("/load") && init?.method === "POST") {
        const body = await response.text();
        window.historyResponseHeld = true;
        await new Promise((resolve) => { window.releaseHistory = resolve; });
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return response;
    };
  `);
  await waitFor(`Boolean(document.querySelector('[data-session-id="session-1"]'))`);
  await evaluate(`document.querySelector('[data-session-id="session-1"]').click()`);
  await waitFor(`window.historyResponseHeld === true`);
  const remote = server.post("messages", { text: "New activity after the history snapshot" });
  await server.waitForPrompt("New activity after the history snapshot");
  await waitFor(`document.querySelector('[data-session-id="session-1"] .session-meta').textContent === "just now"`);
  await evaluate(`window.releaseHistory()`);
  await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false"`);
  const label = await evaluate(`document.querySelector('[data-session-id="session-1"] .session-meta').textContent`);
  assert.equal((await remote).status, 200);
  assert.equal(label, "just now");
});

test("respects opening a new conversation while pending-send recovery waits for the session list", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true,
    nativeMessages: true,
    nativeHistory: {},
    promptDelayMs: 2_500
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      if (resource.endsWith("/messages") && init?.method === "POST" &&
          sessionStorage.getItem("hold-recovery-list")) {
        window.recoveryPosted = true;
      }
      const response = await nativeFetch(resource, init);
      if (resource === "/api/sessions" && (init?.method ?? "GET") === "GET" &&
          window.recoveryPosted && sessionStorage.getItem("hold-recovery-list")) {
        sessionStorage.removeItem("hold-recovery-list");
        const body = await response.text();
        window.recoveryListHeld = true;
        await new Promise((resolve) => { window.releaseRecoveryList = resolve; });
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return response;
    };
  `);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Recover in the background";
    document.querySelector("#composer").requestSubmit();
  `);
  await server.waitForPrompt("Recover in the background");
  await evaluate(`sessionStorage.setItem("hold-recovery-list", "true")`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`window.recoveryListHeld === true`);
  await evaluate(`
    document.querySelector("#new-chat").click();
    document.querySelector("#prompt-input").value = "My new unsent draft";
    document.querySelector("#prompt-input").dispatchEvent(new Event("input", { bubbles: true }));
    window.releaseRecoveryList();
  `);
  await waitFor(`sessionStorage.getItem("copilot-web-pending-sends") === null`);
  assert.equal(await evaluate(`localStorage.getItem("copilot-web-active-session")`), null);
  assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "My new unsent draft");
});

for (const edit of ["later text", "same text retyped", "programmatic edit", "queued follow-up"]) {
  test(`keeps the original send and later composer edits distinct: ${edit}`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const server = await startTestServer(t, {
      profileSessions: true, nativeMessages: true, nativeHistory: {}
    });
    const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (resource, init) => {
        const response = await nativeFetch(resource, init);
        if (resource === "/api/sessions" && init?.method === "POST") {
          window.creationHeldForTyping = true;
          await new Promise((resolve) => { window.releaseCreationForTyping = resolve; });
        }
        return response;
      };
    `);
    await waitFor(`document.querySelector("#model-select")?.disabled === false`);
    await evaluate(`
      document.querySelector("#prompt-input").value = "Original prompt";
      document.querySelector("#prompt-input").dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#composer").requestSubmit();
    `);
    await waitFor(`window.creationHeldForTyping === true`);
    if (edit === "queued follow-up") {
      await evaluate(`
        document.querySelector("#prompt-input").value = "Queued prompt";
        document.querySelector("#prompt-input").dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#composer").requestSubmit();
      `);
    }
    if (edit === "same text retyped") {
      await evaluate(`
        document.querySelector("#prompt-input").value = "Temporary edit";
        document.querySelector("#prompt-input").dispatchEvent(new Event("input", { bubbles: true }));
      `);
    }
    const expectedDraft = edit === "same text retyped" ? "Original prompt" : "My next unsent prompt";
    await evaluate(`
      document.querySelector("#prompt-input").value = ${JSON.stringify(expectedDraft)};
      ${edit === "programmatic edit" ? "" :
        'document.querySelector("#prompt-input").dispatchEvent(new Event("input", { bubbles: true }));'}
      window.releaseCreationForTyping();
    `);
    await waitFor(`sessionStorage.getItem("copilot-web-pending-sends") === null &&
      document.querySelector("#messages").textContent.includes("Done.") &&
      document.querySelector("#cancel-prompt").disabled === true`);
    assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), expectedDraft);
    const prompts = (await server.requests()).filter((entry) => entry.method === "session/prompt");
    assert.deepEqual(prompts.map((entry) => entry.text), edit === "queued follow-up"
      ? ["Original prompt", "Queued prompt"] : ["Original prompt"]);
    const id = await evaluate(`localStorage.getItem("copilot-web-active-session")`);
    await evaluate(`document.querySelector("#new-chat").click()`);
    await evaluate(`document.querySelector('[data-session-id="${String(id)}"]').click()`);
    await waitFor(`localStorage.getItem("copilot-web-active-session") === ${JSON.stringify(id)}`);
    assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), expectedDraft);
    assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
  });
}

for (const failure of ["transport", "server rejection"]) {
  test(`does not reroute a background send after ${failure}`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const server = await startTestServer(t, {
      profileSessions: true, nativeMessages: true, nativeHistory: {}
    });
    const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (resource, init) => {
        if (resource === "/api/sessions" && init?.method === "POST") {
          if (${JSON.stringify(failure)} === "server rejection") {
            const body = JSON.parse(init.body);
            body.configOverrides = { unsupported: "value" };
            init = { ...init, body: JSON.stringify(body) };
          }
          const response = await nativeFetch(resource, init);
          window.creationWillFail = true;
          await new Promise((resolve) => { window.failCreation = resolve; });
          window.creationFailureDelivered = true;
          if (${JSON.stringify(failure)} === "transport") {
            throw new TypeError("Creation response lost");
          }
          return response;
        }
        return nativeFetch(resource, init);
      };
    `);
    await waitFor(`document.querySelector("#model-select")?.disabled === false &&
      Boolean(document.querySelector('[data-session-id="${server.sessionId}"]'))`);
    await evaluate(`
      document.querySelector("#prompt-input").value = "For the original conversation only";
      document.querySelector("#composer").requestSubmit();
    `);
    await waitFor(`window.creationWillFail === true`);
    await evaluate(`document.querySelector('[data-session-id="${server.sessionId}"]').click()`);
    await waitFor(`localStorage.getItem("copilot-web-active-session") === "${server.sessionId}" &&
      document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
      document.querySelector("#send-prompt").disabled === false`);
    await evaluate(`
      document.querySelector("#prompt-input").value = "Keep this other conversation draft";
      document.querySelector("#prompt-input").dispatchEvent(new Event("input", { bubbles: true }));
      window.failCreation();
    `);
    await waitFor(`window.creationFailureDelivered === true`);
    await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    assert.deepEqual((await server.requests()).filter((entry) => entry.method === "session/prompt"), []);
    assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "Keep this other conversation draft");
    assert.equal(await evaluate(`localStorage.getItem("copilot-web-active-session")`), server.sessionId);
    assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
  });
}

for (const delayedRead of [false, true]) {
  test(`retains follow-up attachments added during conversation creation${delayedRead ? " with a delayed read" : ""}`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const server = await startTestServer(t, { profileSessions: true });
    const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (resource, init) => {
        const response = await nativeFetch(resource, init);
        if (resource === "/api/sessions" && init?.method === "POST") {
          window.creationHeldForFiles = true;
          await new Promise((resolve) => { window.releaseFileCreation = resolve; });
        }
        return response;
      };
      const nativeRead = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function(file) {
        if (file.name === "future.txt" && ${delayedRead}) {
          window.futureReadHeld = true;
          window.releaseFutureRead = () => nativeRead.call(this, file);
        } else {
          nativeRead.call(this, file);
        }
      };
    `);
    await waitFor(`document.querySelector("#model-select")?.disabled === false`);
    const attach = (name: string) => evaluate(`
      (() => {
        const files = new DataTransfer();
        files.items.add(new File([${JSON.stringify(name)}], ${JSON.stringify(name)}, { type: "text/plain" }));
        document.querySelector("#file-input").files = files.files;
        document.querySelector("#file-input").dispatchEvent(new Event("change"));
      })()
    `);
    await attach("sent.txt");
    await waitFor(`document.querySelector("#attachment-list").textContent.includes("sent.txt") &&
      document.querySelector("#send-prompt").disabled === false`);
    await evaluate(`
      document.querySelector("#prompt-input").value = "Send the first file";
      document.querySelector("#composer").requestSubmit();
    `);
    await waitFor(`window.creationHeldForFiles === true`);
    await attach("future.txt");
    await waitFor(delayedRead ? `window.futureReadHeld === true` :
      `document.querySelector("#attachment-list").textContent.includes("future.txt")`);
    await evaluate(`window.releaseFileCreation()`);
    await server.waitForPrompt("Send the first file");
    if (delayedRead) {
      await evaluate(`window.releaseFutureRead()`);
    }
    await waitFor(`document.querySelector("#attachment-list").textContent.includes("future.txt") &&
      document.querySelector("#send-prompt").disabled === false`);
    assert.equal(await evaluate(`document.querySelector("#attachment-list").textContent.includes("sent.txt")`), false);
    const prompt = (await server.requests()).find((entry) => entry.method === "session/prompt");
    assert.ok(prompt && Array.isArray(prompt.prompt));
    assert.equal(prompt.prompt.length, 2);
    assert.ok(JSON.stringify(prompt.prompt).includes(Buffer.from("sent.txt").toString("base64")));
    assert.equal(JSON.stringify(prompt.prompt).includes(Buffer.from("future.txt").toString("base64")), false);
    assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "");
    assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
  });
}

for (const target of ["new", "existing"]) {
  test(`preserves the ${target} conversation draft while another creation finishes`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const server = await startTestServer(t, {
      profileSessions: true, nativeMessages: true, nativeHistory: {}
    });
    const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (resource, init) => {
        const response = await nativeFetch(resource, init);
        if (resource === "/api/sessions" && init?.method === "POST") {
          window.creationHeld = true;
          await new Promise((resolve) => { window.releaseCreation = resolve; });
        }
        return response;
      };
    `);
    await waitFor(`document.querySelector("#model-select")?.disabled === false &&
      Boolean(document.querySelector('[data-session-id="${server.sessionId}"]'))`);
    await evaluate(`
      document.querySelector("#prompt-input").value = "Send in the original conversation";
      document.querySelector("#composer").requestSubmit();
    `);
    await waitFor(`window.creationHeld === true`);
    await evaluate(target === "new"
      ? `document.querySelector("#new-chat").click()`
      : `document.querySelector('[data-session-id="${server.sessionId}"]').click()`);
    await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
      document.querySelector("#model-select").disabled === false &&
      document.querySelector("#send-prompt").disabled === false`);
    await evaluate(`
      document.querySelector("#prompt-input").value = "Do not erase this unsent draft";
      document.querySelector("#prompt-input").dispatchEvent(new Event("input", { bubbles: true }));
      window.releaseCreation();
    `);
    await server.waitForPrompt("Send in the original conversation");
    await waitFor(`sessionStorage.getItem("copilot-web-pending-sends") === null`);
    assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "Do not erase this unsent draft");
    assert.equal(await evaluate(`localStorage.getItem("copilot-web-active-session")`),
      target === "new" ? null : server.sessionId);
    assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
  });
}

test("recovers independent conversations concurrently but keeps each conversation queue ordered", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true, nativeMessages: true, nativeHistory: {}
  });
  await server.pausePromptCompletion(true);
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      const response = await nativeFetch(resource, init);
      if (resource === "/api/sessions" && init?.method === "POST" && window.holdCreationResponse) {
        window.holdCreationResponse = false;
        window.independentCreationHeld = true;
        return new Promise(() => {});
      }
      return response;
    };
  `);
  try {
    await waitFor(`document.querySelector("#model-select")?.disabled === false`);
    await evaluate(`
      document.querySelector("#prompt-input").value = "Long-running first conversation";
      document.querySelector("#composer").requestSubmit();
    `);
    await server.waitForPrompt("Long-running first conversation");
    await evaluate(`document.querySelector("#new-chat").click()`);
    await waitFor(`document.querySelector("#model-select").disabled === false &&
      document.querySelector("#send-prompt").disabled === false`);
    await evaluate(`
      window.holdCreationResponse = true;
      document.querySelector("#prompt-input").value = "Independent second conversation";
      document.querySelector("#composer").requestSubmit();
    `);
    await waitFor(`window.independentCreationHeld === true`);
    await evaluate(`
      document.querySelector("#prompt-input").value = "Follow-up in second conversation";
      document.querySelector("#composer").requestSubmit();
    `);
    await waitFor(`JSON.parse(sessionStorage.getItem("copilot-web-pending-sends")).length === 3`);
    await command("Page.reload", {}, sessionId);
    await server.waitForPrompt("Independent second conversation");
    const activeRequests = await server.requests();
    assert.equal(activeRequests.filter((entry) => entry.text === "Long-running first conversation").length, 1);
    assert.equal(activeRequests.filter((entry) => entry.text === "Independent second conversation").length, 1);
    assert.equal(activeRequests.some((entry) => entry.text === "Follow-up in second conversation"), false);
    await server.pausePromptCompletion(false);
    await server.waitForPrompt("Follow-up in second conversation");
    await waitFor(`sessionStorage.getItem("copilot-web-pending-sends") === null`);
    const requests = (await server.requests()).filter((entry) => entry.method === "session/prompt");
    assert.equal(requests.length, 3);
    const second = requests.find((entry) => entry.text === "Independent second conversation");
    const followup = requests.find((entry) => entry.text === "Follow-up in second conversation");
    assert.ok(second && followup);
    assert.equal(second.sessionId, followup.sessionId);
    assert.ok(requests.indexOf(second) < requests.indexOf(followup));
    assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
  } finally {
    await server.pausePromptCompletion(false);
  }
});

test("keeps a send when reloading aborts the actual in-flight creation request", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true, nativeMessages: true, nativeHistory: {}, creationDelayMs: 400
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  const creationsBeforeSend = (await server.requests())
    .filter((request) => request.method === "session/new").length;
  await evaluate(`
    document.querySelector("#prompt-input").value = "Preserve the send when its request is aborted";
    document.querySelector("#composer").requestSubmit();
  `);
  const deadline = Date.now() + 5_000;
  while ((await server.requests()).filter((request) => request.method === "session/new").length ===
    creationsBeforeSend) {
    assert.ok(Date.now() < deadline, "Conversation creation did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await command("Page.reload", {}, sessionId);
  await waitFor(`document.querySelector("#messages")?.textContent.includes(
    "Preserve the send when its request is aborted") &&
    document.querySelector(".message.assistant")?.textContent.includes("Done.")`);
  assert.equal((await server.requests()).filter((request) => request.method === "session/new").length,
    creationsBeforeSend + 1);
  assert.equal((await server.requests()).filter((request) =>
    request.text === "Preserve the send when its request is aborted").length, 1);
  assert.equal(await evaluate(`document.querySelectorAll(".message.user").length`), 1);
  await waitFor(`sessionStorage.getItem("copilot-web-pending-sends") === null`);
  assert.equal(await evaluate(`document.querySelectorAll(".message.system").length`), 0);
});

for (const working of [false, true]) {
  test(`restores a new ${working ? "working" : "completed"} conversation before the CLI lists it`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const server = await startTestServer(t, {
      profileSessions: true,
      nativeMessages: true,
      nativeHistory: {},
      promptDelayMs: working ? 2_500 : 20
    });
    const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
    await waitFor(`document.querySelector("#model-select")?.disabled === false`);
    const text = `New ${working ? "working" : "completed"} conversation with delayed listing`;
    await evaluate(`
      document.querySelector("#prompt-input").value = ${JSON.stringify(text)};
      document.querySelector("#composer").requestSubmit();
    `);
    await server.waitForPrompt(text);
    const id = String(await evaluate(`localStorage.getItem("copilot-web-active-session")`));
    if (!working) {
      await waitFor(`sessionStorage.getItem("copilot-web-pending-sends") === null`);
    }
    await server.sessionListed(id, false);
    await evaluate(`window.beforeRefresh = true`);
    await command("Page.reload", {}, sessionId);
    await waitFor(`!window.beforeRefresh &&
      document.querySelector(".session-item.active")?.dataset.sessionId === ${JSON.stringify(id)} &&
      document.querySelector("#messages")?.textContent.includes(${JSON.stringify(text)})`);
    assert.equal(await evaluate(`localStorage.getItem("copilot-web-active-session")`), id);
    assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("Conversation not found")`),
      false);
    await server.sessionListed(id, true);
    await evaluate(`window.beforeSecondRefresh = true`);
    await command("Page.reload", {}, sessionId);
    await waitFor(`!window.beforeSecondRefresh &&
      document.querySelector(".session-item.active")?.dataset.sessionId === ${JSON.stringify(id)} &&
      document.querySelector("#messages")?.textContent.includes(${JSON.stringify(text)})`);
    await waitFor(`sessionStorage.getItem("copilot-web-pending-sends") === null`);
    assert.equal((await server.requests()).filter((request) => request.text === text).length, 1);
    assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
  });
}

test("restores the selected conversation from its ID when the first list snapshot is stale", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true, nativeMessages: true, nativeHistory: {}
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
  const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      const response = await nativeFetch(resource, init);
      if (resource === "/api/sessions" && (init?.method ?? "GET") === "GET") {
        const hidden = sessionStorage.getItem("hide-from-list");
        if (hidden) {
          const payload = await response.json();
          payload.sessions = payload.sessions.filter((session) => session.sessionId !== hidden);
          return new Response(JSON.stringify(payload), { status: 200 });
        }
      }
      return response;
    };
  `);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Restore directly by session ID";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`sessionStorage.getItem("copilot-web-pending-sends") === null &&
    document.querySelector("#messages").textContent.includes("Done.")`);
  const id = String(await evaluate(`localStorage.getItem("copilot-web-active-session")`));
  const creationsBeforeRefresh = (await server.requests())
    .filter((request) => request.method === "session/new").length;
  await evaluate(`
    sessionStorage.setItem("hide-from-list", ${JSON.stringify(id)});
    window.beforeRefresh = true;
  `);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeRefresh &&
    document.querySelector(".session-item.active")?.dataset.sessionId === ${JSON.stringify(id)} &&
    document.querySelector("#messages")?.textContent.includes("Restore directly by session ID")`);
  const requests = await server.requests();
  assert.equal(requests.filter((request) => request.text === "Restore directly by session ID").length, 1);
  assert.equal(requests.filter((request) => request.method === "session/new").length, creationsBeforeRefresh);
  assert.equal(await evaluate(`document.querySelectorAll(".message.user").length`), 1);
  assert.equal(await evaluate(`document.querySelectorAll(".message.system").length`), 0);
});

test("keeps the saved selection when restoring its transcript temporarily fails", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true, nativeMessages: true, nativeHistory: {}
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (resource, init) => {
      if (resource.endsWith("/load") && init?.method === "POST" &&
          sessionStorage.getItem("fail-next-load")) {
        sessionStorage.removeItem("fail-next-load");
        return Promise.resolve(new Response(JSON.stringify({ error: "History temporarily unavailable" }),
          { status: 503 }));
      }
      return nativeFetch(resource, init);
    };
  `);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Keep the selected session after a load error";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`sessionStorage.getItem("copilot-web-pending-sends") === null &&
    document.querySelector("#messages").textContent.includes("Done.")`);
  const id = String(await evaluate(`localStorage.getItem("copilot-web-active-session")`));
  await evaluate(`
    sessionStorage.setItem("fail-next-load", "true");
    window.beforeRefresh = true;
  `);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeRefresh &&
    document.querySelector("#messages")?.textContent.includes("History temporarily unavailable")`);
  assert.equal(await evaluate(`localStorage.getItem("copilot-web-active-session")`), id);
  await evaluate(`window.beforeRetry = true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeRetry &&
    document.querySelector(".session-item.active")?.dataset.sessionId === ${JSON.stringify(id)} &&
    document.querySelector("#messages")?.textContent.includes("Keep the selected session after a load error")`);
});

test("forgets a saved selection whose conversation no longer exists", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`
    localStorage.setItem("copilot-web-active-session", "missing-conversation");
    window.beforeRefresh = true;
  `);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeRefresh &&
    document.querySelector("#messages")?.textContent.includes("Conversation not found")`);
  assert.equal(await evaluate(`localStorage.getItem("copilot-web-active-session")`), null);
});

test("discards unreadable pending sends and keeps saving new ones", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (resource, init) => {
      if (resource.endsWith("/messages") && init?.method === "POST") {
        window.messageRequestHeld = true;
        return new Promise(() => {});
      }
      return nativeFetch(resource, init);
    };
  `);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`
    sessionStorage.setItem("copilot-web-pending-sends", JSON.stringify([{ id: 1 }]));
    window.beforeRefresh = true;
  `);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeRefresh &&
    document.querySelector("#messages")?.textContent.includes("could not be read and were discarded") &&
    document.querySelector("#model-select")?.disabled === false`);
  assert.equal(await evaluate(`sessionStorage.getItem("copilot-web-pending-sends")`), null);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Save after discarding unreadable records";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`window.messageRequestHeld === true`);
  assert.deepEqual(await evaluate(`JSON.parse(sessionStorage.getItem("copilot-web-pending-sends"))
    .map((entry) => entry.displayText)`), ["Save after discarding unreadable records"]);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes(
    "Unable to preserve this message")`), false);
});

test("keeps a queued send for review when the server restarted before delivery", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (resource, init) => {
      if (resource.endsWith("/messages") && init?.method === "POST") {
        const headers = new Headers(init.headers);
        headers.set("X-Copilot-Request-Scope", "previous-server");
        return nativeFetch(resource, { ...init, headers });
      }
      return nativeFetch(resource, init);
    };
  `);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Keep this for review after a restart";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`document.querySelector("#messages")?.textContent.includes("The server restarted") &&
    document.querySelector("#pending-send-reviews button")?.textContent === "Restore draft"`);
  assert.deepEqual(await evaluate(`JSON.parse(sessionStorage.getItem("copilot-web-pending-sends"))
    .map((entry) => [entry.displayText, entry.reviewRequired])`),
  [["Keep this for review after a restart", true]]);
  assert.equal((await server.requests()).filter((request) => request.method === "session/prompt").length, 0);
});

test("creates the conversation in a context selected while the first creation is pending", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      if (resource === "/api/sessions" && init?.method === "POST" && !window.creationHeld) {
        window.creationHeld = true;
        await new Promise((resolve) => { window.releaseCreation = resolve; });
      }
      return nativeFetch(resource, init);
    };
  `);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  const prompt = "Use the context selected during creation";
  await evaluate(`
    document.querySelector("#prompt-input").value = ${JSON.stringify(prompt)};
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`typeof window.releaseCreation === "function"`);
  await evaluate(`
    const context = document.querySelector("#context-select");
    context.value = "long_context";
    context.dispatchEvent(new Event("change"));
  `);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`window.releaseCreation()`);
  await waitFor(`document.querySelector("#messages")?.textContent.includes("Done.")`);
  const sent = (await server.requests())
    .find((request) => request.method === "session/prompt" && request.text === prompt);
  assert.ok(sent && typeof sent.sessionId === "string");
  const saved = await server.session(sent.sessionId);
  assert.ok(isRecord(saved));
  assert.equal(saved.context, "long_context");
});

for (const phase of ["before creation", "after creation", "during reply", "after reply"]) {
  test(`keeps the first message when refreshed ${phase}`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const server = await startTestServer(t, {
      profileSessions: true,
      promptDelayMs: phase === "during reply" ? 1_500 : 20,
      ...(phase === "during reply" ? { nativeMessages: true, nativeHistory: {} } : {})
    });
    const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      const phase = ${JSON.stringify(phase)};
      const match = init?.method === "POST" && (phase.includes("creation")
        ? resource === "/api/sessions"
        : resource.endsWith("/messages"));
      if (match && !sessionStorage.getItem("send-race-held")) {
        sessionStorage.setItem("send-race-held", "true");
        if (phase === "after creation" || phase === "after reply") {
          await nativeFetch(resource, init);
        } else if (phase === "during reply") {
          nativeFetch(resource, init).catch((error) => { window.promptFetchError = String(error); });
        }
        window.sendRaceHeld = true;
        return new Promise(() => {});
      }
      return nativeFetch(resource, init);
    };
  `);
    await waitFor(`document.querySelector("#model-select")?.disabled === false`);
    const prompt = "Keep my first message through an immediate refresh.";
    await evaluate(`
    const input = document.querySelector("#prompt-input");
    input.value = ${JSON.stringify(prompt)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#composer").requestSubmit();
  `);
    await waitFor(`window.sendRaceHeld === true`);
    assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem("copilot-web-pending-sends")).length`), 1);
    if (phase.includes("reply")) {
      await server.waitForPrompt(prompt);
    }
    const creationsBeforeRefresh = (await server.requests())
      .filter((request) => request.method === "session/new").length;
    assert.equal((await server.requests()).some((request) => request.text === prompt),
      phase.includes("reply"));
    await command("Page.reload", {}, sessionId);
    if (phase === "during reply") {
      await waitFor(`!window.sendRaceHeld &&
      document.querySelector("#messages")?.textContent.includes(${JSON.stringify(prompt)}) &&
      document.querySelector("#cancel-prompt")?.disabled === false`);
      await command("Page.reload", {}, sessionId);
    }
    await waitFor(`!window.sendRaceHeld &&
    document.querySelector("#messages")?.textContent.includes(${JSON.stringify(prompt)}) &&
    document.querySelector("#cancel-prompt")?.disabled === true &&
    sessionStorage.getItem("copilot-web-pending-sends") === null`);
    const requests = await server.requests();
    assert.equal(requests.filter((request) => request.method === "session/new").length,
      creationsBeforeRefresh + (phase === "before creation" ? 1 : 0));
    assert.deepEqual(requests.filter((request) => request.method === "session/prompt")
      .map((request) => request.text), [prompt]);
    assert.equal(await evaluate(`document.querySelectorAll(".message.user").length`), 1);
    await waitFor(`sessionStorage.getItem("copilot-web-pending-sends") === null`);
    assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
  });
}

test("recovers a pending message and attachment in an existing conversation", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (resource, init) => {
      if (resource.endsWith("/messages") && init?.method === "POST" &&
          !sessionStorage.getItem("message-request-held")) {
        sessionStorage.setItem("message-request-held", "true");
        window.messageRequestHeld = true;
        return new Promise(() => {});
      }
      return nativeFetch(resource, init);
    };
  `);
  await waitFor(`Boolean(document.querySelector('[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`document.querySelector("#attach-files").disabled === false`);
  await evaluate(`
    const transfer = new DataTransfer();
    transfer.items.add(new File(["Keep this attachment"], "notes.txt", { type: "text/plain" }));
    document.querySelector("#file-input").files = transfer.files;
    document.querySelector("#file-input").dispatchEvent(new Event("change"));
  `);
  await waitFor(`document.querySelector("#attachment-list").textContent.includes("notes.txt") &&
    document.querySelector("#send-prompt").disabled === false`);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Keep this existing conversation";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`window.messageRequestHeld === true`);
  const creationsBeforeRefresh = (await server.requests())
    .filter((request) => request.method === "session/new").length;
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.messageRequestHeld &&
    document.querySelector("#messages")?.textContent.includes("Keep this existing conversation") &&
    sessionStorage.getItem("copilot-web-pending-sends") === null`);
  const requests = await server.requests();
  assert.equal(requests.filter((request) => request.method === "session/new").length,
    creationsBeforeRefresh);
  const prompts = requests.filter((request) => request.method === "session/prompt");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.sessionId, server.sessionId);
  assert.deepEqual(prompts[0]?.prompt, [
    { type: "text", text: "Keep this existing conversation" },
    { type: "resource", resource: {
      uri: attachmentUriFor(
        "notes.txt",
        "text/plain",
        Buffer.from("Keep this attachment").toString("base64")
      ),
      blob: Buffer.from("Keep this attachment").toString("base64"),
      mimeType: "text/plain"
    } }
  ]);
});

test("warns when pending sends cannot be stored without blocking message delivery", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "copilot-web-pending-sends") {
        throw new DOMException("Storage is full", "QuotaExceededError");
      }
      return nativeSetItem.call(this, key, value);
    };
  `);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Send even when storage is full";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`document.querySelector("#messages")?.textContent.includes("Done.")`);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes(
    "Unable to preserve this message across a refresh. Keep this page open until sending finishes"
  )`), true);
  assert.equal((await server.requests()).filter((request) =>
    request.text === "Send even when storage is full").length, 1);
  assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
});

test("keeps the selected conversation while recovering a background send", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const selectedId = await server.createSession();
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (resource, init) => {
      if (resource.endsWith("/messages") && init?.method === "POST" &&
          !sessionStorage.getItem("background-send-held")) {
        sessionStorage.setItem("background-send-held", "true");
        window.backgroundSendHeld = true;
        return new Promise(() => {});
      }
      return nativeFetch(resource, init);
    };
  `);
  const select = async (id: string) => {
    await waitFor(`Boolean(document.querySelector('[data-session-id="${id}"]'))`);
    await evaluate(`document.querySelector('[data-session-id="${id}"]').click()`);
    await waitFor(`localStorage.getItem("copilot-web-active-session") === "${id}" &&
      document.querySelector("#messages").getAttribute("aria-busy") === "false" &&
      document.querySelector("#model-select").disabled === false &&
      document.querySelector("#send-prompt").disabled === false`);
  };
  await select(server.sessionId);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Recover this in the background";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`window.backgroundSendHeld === true`);
  await select(selectedId);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.backgroundSendHeld &&
    document.querySelector(".session-item.active")?.dataset.sessionId === "${selectedId}" &&
    sessionStorage.getItem("copilot-web-pending-sends") === null`);
  assert.equal((await server.requests()).filter((request) =>
    request.text === "Recover this in the background").length, 1);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes(
    "Recover this in the background")`), false);
});

test("requires explicit restoration of an uncertain send from an earlier server", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (resource, init) => {
      if (resource === "/api/sessions" && init?.method === "POST" &&
          !sessionStorage.getItem("old-server-send-held")) {
        sessionStorage.setItem("old-server-send-held", "true");
        window.oldServerSendHeld = true;
        return new Promise(() => {});
      }
      return nativeFetch(resource, init);
    };
  `);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Review before resending";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`window.oldServerSendHeld === true`);
  await evaluate(`
    const entries = JSON.parse(sessionStorage.getItem("copilot-web-pending-sends"));
    entries[0].scope = "previous-server";
    sessionStorage.setItem("copilot-web-pending-sends", JSON.stringify(entries));
  `);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.oldServerSendHeld &&
    document.querySelector("#messages")?.textContent.includes("The server restarted") &&
    document.querySelector("#pending-send-reviews button")?.textContent === "Restore draft"`);
  assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "");
  assert.equal((await server.requests()).filter((request) => request.method === "session/prompt").length, 0);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Keep my current draft";
    document.querySelector("#pending-send-reviews button").click();
  `);
  assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "Keep my current draft");
  await evaluate(`
    document.querySelector("#prompt-input").value = "";
    document.querySelector("#pending-send-reviews button").click();
  `);
  await waitFor(`document.querySelector("#prompt-input").value === "Review before resending" &&
    document.querySelector("#send-prompt").disabled === false`);
  await evaluate(`document.querySelector("#composer").requestSubmit()`);
  await waitFor(`document.querySelector("#messages")?.textContent.includes("Done.") &&
    sessionStorage.getItem("copilot-web-pending-sends") === null`);
  assert.equal((await server.requests()).filter((request) => request.method === "session/prompt").length, 1);
});

test("recovers a new send despite an older restart entry and shows its warning only once", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true, nativeMessages: true, nativeHistory: {}
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (resource, init) => {
      if (resource.endsWith("/messages") && init?.method === "POST" &&
          sessionStorage.getItem("hold-next-send")) {
        sessionStorage.removeItem("hold-next-send");
        window.newSendHeld = true;
        return new Promise(() => {});
      }
      return nativeFetch(resource, init);
    };
  `);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Original conversation";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`sessionStorage.getItem("copilot-web-pending-sends") === null &&
    document.querySelector("#messages")?.textContent.includes("Done.")`);
  await evaluate(`
    sessionStorage.setItem("copilot-web-pending-sends", JSON.stringify([{
      id: "uncertain-old-send", scope: "previous-server",
      creation: { id: "old-creation", body: { context: "default" } },
      text: "Keep this uncertain draft", displayText: "Keep this uncertain draft",
      attachments: [], selections: []
    }]));
    sessionStorage.setItem("hold-next-send", "true");
    document.querySelector("#prompt-input").value = "hi";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`window.newSendHeld === true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.newSendHeld &&
    [...document.querySelectorAll(".message.user .message-body")].some((body) => body.textContent === "hi") &&
    JSON.parse(sessionStorage.getItem("copilot-web-pending-sends") ?? "[]").length === 1`);
  assert.equal((await server.requests()).filter((request) => request.text === "hi").length, 1);
  assert.equal((await server.requests()).filter((request) => request.text === "Keep this uncertain draft").length, 0);
  await evaluate(`window.beforeRefresh = true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeRefresh &&
    [...document.querySelectorAll(".message.user .message-body")].some((body) => body.textContent === "hi") &&
    document.querySelector("#messages").getAttribute("aria-busy") === "false"`);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("The server restarted")`), false);
  assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "");
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem("copilot-web-pending-sends"))[0].displayText`),
    "Keep this uncertain draft");
  await evaluate(`document.querySelectorAll("#pending-send-reviews button")[1].click()`);
  assert.equal(await evaluate(`sessionStorage.getItem("copilot-web-pending-sends")`), null);
  await evaluate(`window.beforeDismissRefresh = true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeDismissRefresh &&
    document.querySelector("#messages")?.textContent.includes("Original conversation") &&
    document.querySelector("#messages").getAttribute("aria-busy") === "false"`);
  assert.equal(await evaluate(`document.querySelector("#pending-send-reviews").hidden`), true);
  assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "");
  assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
});

test("does not warn or resend a natively accepted prompt after the server changes", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true, nativeMessages: true, nativeHistory: {}
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      const response = await nativeFetch(resource, init);
      if (resource.endsWith("/messages") && init?.method === "POST" &&
          !sessionStorage.getItem("accepted-response-held")) {
        sessionStorage.setItem("accepted-response-held", "true");
        window.acceptedResponseHeld = true;
        return new Promise(() => {});
      }
      return response;
    };
  `);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`
    document.querySelector("#prompt-input").value = "Already accepted before restart";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`window.acceptedResponseHeld === true &&
    document.querySelector(".message.user time") !== null`);
  await evaluate(`
    const entries = JSON.parse(sessionStorage.getItem("copilot-web-pending-sends"));
    entries[0].scope = "previous-server";
    sessionStorage.setItem("copilot-web-pending-sends", JSON.stringify(entries));
  `);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.acceptedResponseHeld &&
    document.querySelector("#messages")?.textContent.includes("Already accepted before restart") &&
    sessionStorage.getItem("copilot-web-pending-sends") === null`);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("The server restarted")`), false);
  assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "");
  assert.equal((await server.requests()).filter((request) => request.text === "Already accepted before restart").length, 1);
});

test("refreshes during Thinking without repeating a reviewed restart warning or the active prompt", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true, nativeMessages: true, nativeHistory: {}, promptDelayMs: 2_500
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`document.querySelector("#model-select")?.disabled === false`);
  await evaluate(`
    sessionStorage.setItem("copilot-web-pending-sends", JSON.stringify([{
      id: "reviewed-old-send", scope: "previous-server", reviewRequired: true,
      creation: { id: "old-creation", body: { context: "default" } },
      text: "Draft retained for review", displayText: "Draft retained for review",
      attachments: [], selections: []
    }]));
    document.querySelector("#prompt-input").value = "stream-progress";
    document.querySelector("#composer").requestSubmit();
  `);
  await waitFor(`document.querySelector(".thinking-content-text")?.textContent.includes(
    "Live reasoning: checking the request.") &&
    document.querySelector("#cancel-prompt").disabled === false`);
  for (let reload = 0; reload < 2; reload += 1) {
    await evaluate(`window.beforeThinkingRefresh = true`);
    await command("Page.reload", {}, sessionId);
    await waitFor(`!window.beforeThinkingRefresh &&
      document.querySelector(".thinking-content-text")?.textContent.includes(
        "Live reasoning: checking the request.") &&
      document.querySelector("#cancel-prompt").disabled === false &&
      document.querySelector("#messages").getAttribute("aria-busy") === "false"`);
    assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("The server restarted")`),
      false);
    assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "");
  }
  await waitFor(`document.querySelector(".message.assistant")?.textContent.includes("Done.") &&
    document.querySelector("#cancel-prompt").disabled === true`);
  assert.equal((await server.requests()).filter((request) => request.text === "stream-progress").length, 1);
  assert.equal(await evaluate(`document.querySelectorAll(".message.user").length`), 1);
  assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
});

for (const failure of ["lost response", "failed request", "server rejection"]) {
  test(`retries conversation creation safely after ${failure}`, {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const server = await startTestServer(t, { profileSessions: true });
    const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
      const nativeFetch = window.fetch.bind(window);
      window.creationRequestIds = [];
      window.fetch = async (resource, init) => {
        if (resource === "/api/sessions" && init?.method === "POST") {
          window.creationRequestIds.push(new Headers(init.headers).get("X-Copilot-Request-Id"));
          if (window.creationRequestIds.length === 1) {
            if (${JSON.stringify(failure)} === "server rejection") {
              return new Response(JSON.stringify({ error: "Creation rejected" }), { status: 400 });
            }
            if (${JSON.stringify(failure)} === "lost response") {
              await nativeFetch(resource, init);
            }
            throw new TypeError("Failed to fetch");
          }
        }
        return nativeFetch(resource, init);
      };
    `);
    await waitFor(`document.querySelector("#model-select")?.disabled === false`);
    const before = (await server.requests()).filter((entry) => entry.method === "session/new").length;
    await evaluate(`
      document.querySelector("#prompt-input").value = "Retry after creation failed";
      document.querySelector("#composer").requestSubmit();
    `);
    await waitFor(`document.querySelector("#messages").textContent.includes(
      ${JSON.stringify(failure === "server rejection" ? "Creation rejected" : "Failed to fetch")})`);
    await evaluate(`document.querySelector("#composer").requestSubmit()`);
    await waitFor(`document.querySelector("#messages").textContent.includes("Done.") &&
      sessionStorage.getItem("copilot-web-pending-sends") === null`);
    const ids = await evaluate(`window.creationRequestIds`);
    assert.ok(Array.isArray(ids));
    assert.equal(ids.length, 2);
    assert.equal(ids[0] === ids[1], failure !== "server rejection");
    const requests = await server.requests();
    assert.equal(requests.filter((entry) => entry.method === "session/new").length - before, 1);
    assert.equal(requests.filter((entry) => entry.method === "session/prompt").length, 1);
    assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
  });
}

test("deduplicates repeated submits, shares session creation, and normalizes generated titles", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { profileSessions: true });
  const delaySessionCreation = `
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        window.testEventSource = this;
      }
    };
    window.sessionCreationRequests = 0;
    window.sessionCreationResponses = 0;
    window.promptRequests = 0;
    window.promptResponses = 0;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      const url = typeof resource === "string" ? resource : resource.url;
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        window.sessionCreationRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        const response = await nativeFetch(resource, init);
        window.sessionCreationResponses += 1;
        return response;
      }
      if (
        url.includes("/api/sessions/") &&
        url.endsWith("/messages") &&
        init?.method === "POST"
      ) {
        window.promptRequests += 1;
        const response = await nativeFetch(resource, init);
        window.promptResponses += 1;
        return response;
      }
      return nativeFetch(resource, init);
    };
  `;
  const { evaluate, waitFor } = await startTestBrowser(
    t,
    server.baseUrl,
    delaySessionCreation
  );
  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector("#new-chat").click()`);
  await waitFor(`document.querySelector("#model-select").disabled === false`);
  const firstPrompt =
    "```\nTrinityVirusScanServiceInterface\ninitial request\n```";
  const secondPrompt =
    "```\nTrinityVirusScanServiceInterface\nfollow-up request\n```";
  await evaluate(`
    (() => {
      const input = document.querySelector("#prompt-input");
      input.value = ${JSON.stringify(firstPrompt)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const form = document.querySelector("#composer");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      input.value = ${JSON.stringify(secondPrompt)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    })()
  `);
  await waitFor(`
    window.sessionCreationRequests > 0 &&
    window.sessionCreationResponses === window.sessionCreationRequests &&
    window.promptRequests === 2 &&
    window.promptResponses === window.promptRequests &&
    document.querySelector("#messages")?.textContent.includes("Done.")
  `);

  assert.equal(await evaluate(`window.sessionCreationRequests`), 1);
  assert.equal(await evaluate(`window.promptRequests`), 2);
  const requests = await server.requests();
  const promptRequests = requests.filter((request) => request.method === "session/prompt");
  assert.equal(promptRequests.length, 2);
  assert.deepEqual(
    promptRequests.map((request) => request.text).sort(),
    [firstPrompt, secondPrompt].sort()
  );
  assert.equal(promptRequests[0]?.sessionId, promptRequests[1]?.sessionId);
  const title = await evaluate(
    `document.querySelector(".session-item.active .session-title")?.textContent`
  );
  assert.equal(typeof title, "string");
  assert.ok(String(title).startsWith("TrinityVirusScanServiceInterface"));
  assert.equal(String(title).includes("```"), false);

  await waitFor(`Boolean(window.testEventSource)`);
  const generatedTitleEvent = {
    sessionId: server.sessionId,
    update: {
      sessionUpdate: "session_info_update",
      title: "```\nGenerated title from Copilot\n```"
    }
  };
  await evaluate(`
    window.testEventSource.dispatchEvent(new MessageEvent("session-update", {
      data: ${JSON.stringify(JSON.stringify(generatedTitleEvent))}
    }));
  `);
  await waitFor(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"] .session-title'
  )?.textContent === "Generated title from Copilot"`);

  const customTitle = "``` custom title";
  await evaluate(`
    window.testEventSource.dispatchEvent(new MessageEvent("session-renamed", {
      data: ${JSON.stringify(JSON.stringify({
        sessionId: server.sessionId,
        title: customTitle
      }))}
    }));
  `);
  await waitFor(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"] .session-title'
  )?.textContent === ${JSON.stringify(customTitle)}`);
});

test("formats Markdown while typing in the composer and sends it as Markdown", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const { type, press, shift, meta } = composerHelpers(command, sessionId);
  const input = `document.querySelector("#prompt-input")`;
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await waitFor(`!${input}.disabled`);
  await evaluate(`${input}.focus()`);

  await type("**Follow these rules:**");
  assert.equal(await evaluate(`${input}.querySelector("strong")?.textContent`), "Follow these rules:");
  assert.equal(await evaluate(`${input}.textContent.includes("**")`), false);
  await press("z", meta, "KeyZ");
  assert.equal(await evaluate(`${input}.querySelector("strong")`), null);
  assert.equal(await evaluate(`${input}.textContent`), "**Follow these rules:**");
  assert.equal(await evaluate(`${input}.value`), String.raw`\*\*Follow these rules:\*\*`);
  await press("z", meta | shift, "KeyZ");
  assert.equal(await evaluate(`${input}.querySelector("strong")?.textContent`), "Follow these rules:");

  await press("Enter", shift);
  await press("Enter", shift);
  await type("1. *One* sentence with `code`");
  await press("Enter", shift);
  await type("Daily life");
  await press("Tab");
  await type(" ~~old~~ done");
  await press("Enter", shift);
  await press("Enter", shift);
  await press("Enter", shift);
  await type("# Heading");
  await press("Enter", shift);
  await type("- point");

  const expected = [
    "**Follow these rules:**",
    "",
    "1. *One* sentence with `code`",
    "   1. Daily life ~~old~~ done",
    "# Heading",
    "- point"
  ].join("\n");
  assert.equal(await evaluate(`${input}.value`), expected);
  assert.deepEqual(await evaluate(`
    [...${input}.querySelectorAll("strong, em, code, s, ol, ol ol, h1, ul")]
      .map((element) => element.tagName)
  `), ["STRONG", "OL", "EM", "CODE", "OL", "S", "H1", "UL"]);
  assert.equal(await evaluate(`${input}.textContent.includes("\\u200b")`), false);

  await evaluate(`${input}.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", isComposing: true, bubbles: true, cancelable: true
  }))`);
  assert.equal((await server.requests()).some((request) => request.text === expected), false);
  assert.equal(await evaluate(`${input}.value`), expected);

  await press("Enter");
  await server.waitForPrompt(expected);
  await waitFor(`${input}.value === "" && ${input}.classList.contains("is-empty")`);

  await type("```js");
  await press("Enter", shift);
  assert.equal(await evaluate(`${input}.querySelector("pre")?.dataset.language`), "js");
  await type("const value = 1;");
  await press("Enter", shift);
  await type("value++;");
  await press("Enter", shift);
  await press("Enter", shift);
  await type("> quote");
  await press("Enter", shift);
  await press("Enter", shift);
  await type("- first");
  await press("Enter", shift);
  await type("second");
  await press("Tab");
  await press("Tab", shift);
  assert.equal(await evaluate(`${input}.querySelector("ul ul")`), null);
  assert.equal(await evaluate(`${input}.value`), "```js\nconst value = 1;\nvalue++;\n```\n> quote\n- first\n- second");
});

test("pastes rich HTML and Markdown text into the composer as formatted content", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const input = `document.querySelector("#prompt-input")`;
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await waitFor(`!${input}.disabled`);
  const paste = (data: Record<string, string>, setup = `${input}.value = ""; ${input}.focus();`) => evaluate(`
    (() => {
      ${setup}
      const transfer = new DataTransfer();
      for (const [type, value] of Object.entries(${JSON.stringify(data)})) {
        transfer.setData(type, value);
      }
      ${input}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      return ${input}.value;
    })()
  `);

  assert.equal(await paste({
    "text/plain": "Act as my tutor.\n**Follow these rules:**\n\n1. **One sentence at a time:** Give me one.\n2. **Daily-life situations:** Use practical sentences."
  }), "Act as my tutor.\n**Follow these rules:**\n\n1. **One sentence at a time:** Give me one.\n2. **Daily-life situations:** Use practical sentences.");
  assert.deepEqual(await evaluate(`[...${input}.querySelectorAll("ol > li > strong")].map((node) => node.textContent)`), [
    "One sentence at a time:",
    "Daily-life situations:"
  ]);
  assert.equal(await evaluate(`${input}.textContent.includes("**")`), false);
  assert.equal(await evaluate(`document.querySelector("#composer").contains(${input})`), true);

  assert.equal(await paste({
    "text/html": "<meta charset='utf-8'><h2>Shopping</h2><p>Buy <script>alert(1)</script>these:</p><ul><li>Milk</li><li>Eggs <b>fresh</b><ul><li>brown</li></ul></li></ul><p><a href='javascript:alert(1)'>bad</a> <a href='https://example.com'>good</a></p>",
    "text/plain": "ignored"
  }), "## Shopping\n\nBuy these:\n\n- Milk\n- Eggs **fresh**\n  - brown\n\nbad [good](https://example.com)");
  assert.equal(await evaluate(`${input}.querySelector("script, [href^='javascript']")`), null);

  assert.equal(await paste({
    "text/html": "<b style='font-weight:normal' id='docs-internal-guid-1'><p><span style='font-weight:700'>Bold</span><span> text</span></p><ul><li><p><span style='font-style:italic'>item</span></p></li></ul></b>",
    "text/plain": "ignored"
  }), "**Bold** text\n\n- *item*");

  assert.equal(await paste({ "text/plain": "• apples\n• pears" }), "- apples\n- pears");
  assert.equal(await paste({ "text/plain": "MID" }, `${input}.value = "abcd"; ${input}.focus(); ${input}.setSelectionRange(2, 2);`), "abMIDcd");
  assert.equal(await paste({ "text/plain": "X\n- y\nZ" }, `${input}.value = "abcd"; ${input}.focus(); ${input}.setSelectionRange(2, 2);`), "abX\n- y\nZcd");
  assert.equal(await paste({ "text/html": "<div>HTML-only text</div>" }), "HTML-only text");
  assert.equal(await paste({
    "text/html": "<div style='font-family:monospace;white-space:pre'><span>const x = 1;</span><br><span>  x++;</span></div>",
    "text/plain": "const x = 1;\n  x++;",
    "vscode-editor-data": "{}"
  }), "```\nconst x = 1;\n  x++;\n```");
  assert.equal(await evaluate(`${input}.querySelector("pre")?.textContent`), "const x = 1;\n  x++;");
  assert.equal(await paste({
    "text/plain": "___both___ and __bold _italic___"
  }), "___both___ and __bold _italic___");
  assert.equal(await evaluate(`${input}.querySelectorAll("strong em").length`), 2);
  assert.equal(await paste({ "text/plain": "**** and **unfinished" }), String.raw`\*\*\*\* and \*\*unfinished`);
  assert.equal(await evaluate(`${input}.textContent`), "**** and **unfinished");

  const richCases = [
    {
      html: "<p><strong><em>Bold italic</em></strong> and <em>italic <strong>bold</strong></em></p>",
      markdown: "***Bold italic*** and *italic **bold***",
      selectors: ["strong em", "em strong"]
    },
    {
      html: "<ol start='3'><li>First<br>continued<ul><li>Nested</li></ul></li><li>Second</li></ol>",
      markdown: "3. First\n   continued\n   - Nested\n4. Second",
      selectors: ["ol[start='3'] > li", "ol > li > ul > li"]
    },
    {
      html: "<p>Use <code>**literal** and `ticks`</code></p>",
      markdown: "Use `` **literal** and `ticks` ``",
      selectors: ["code"]
    },
    {
      html: "<p>Keep <code>  spaces  </code> and <code>`</code></p>",
      markdown: "Keep `   spaces   ` and `` ` ``",
      selectors: ["code"]
    },
    {
      html: "<p><strong>*not italic*</strong> and <em>**not bold**</em></p>",
      markdown: String.raw`**\*not italic\*** and *\*\*not bold\*\**`,
      selectors: ["strong", "em"]
    }
  ];
  for (const { html, markdown, selectors } of richCases) {
    assert.equal(await paste({ "text/html": html }), markdown, html);
    const before = await evaluate(`${input}.textContent`);
    await evaluate(`${input}.value = ${input}.value`);
    assert.equal(await evaluate(`${input}.value`), markdown, `Restoring Markdown: ${html}`);
    assert.equal(await evaluate(`${input}.textContent`), before, `Restoring visible text: ${html}`);
    for (const selector of selectors) {
      assert.equal(await evaluate(`Boolean(${input}.querySelector(${JSON.stringify(selector)}))`), true, selector);
    }
  }
  await evaluate(`
    ${input}.innerHTML = '<p><span style="font-weight:bold;font-style:italic">Both</span></p>';
    ${input}.dispatchEvent(new InputEvent("input", { inputType: "formatBold", bubbles: true }));
  `);
  assert.equal(await evaluate(`${input}.value`), "***Both***");
  assert.equal(await evaluate(`${input}.querySelector("strong em")?.textContent`), "Both");

  const tableMarkdown = "| Group | Decision |\n| --- | :---: |\n| **9 modules** | Uses a \\| pipe |";
  const tableHtml = "<table><thead><tr><th>Group</th><th style=\"text-align:center\">Decision</th></tr></thead>" +
    "<tbody><tr><td><strong>9 modules</strong></td><td style=\"text-align:center\">Uses a | pipe</td></tr></tbody></table>";
  const tableCells = `[...${input}.querySelectorAll("table tr")].map((row) => [...row.cells].map((cell) => cell.textContent))`;
  for (const data of [{ "text/html": tableHtml, "text/plain": tableMarkdown }, { "text/plain": tableMarkdown }]) {
    assert.equal(await paste(data), `${tableMarkdown}\n`, JSON.stringify(data));
    assert.deepEqual(await evaluate(tableCells), [["Group", "Decision"], ["9 modules", "Uses a | pipe"]]);
    assert.equal(await evaluate(`${input}.querySelector("td strong")?.textContent`), "9 modules");
    assert.equal(await evaluate(`${input}.querySelector("th[data-align='center']")?.textContent`), "Decision");
  }
  await evaluate(`${input}.insertClipboard({ text: "After" })`);
  assert.equal(await evaluate(`${input}.value`), `${tableMarkdown}\nAfter`);
  await evaluate(`
    (() => {
      const cell = ${input}.querySelectorAll("td")[1];
      window.getSelection().collapse(cell.firstChild, 4);
      ${input}.insertClipboard({ html: "<p>One</p><p>Two</p>" });
      ${input}.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
      ${input}.insertClipboard({ text: "Below" });
    })()
  `);
  assert.equal(await evaluate(`${input}.querySelectorAll("td")[1].textContent`), "UsesOne Two a | pipe");
  assert.equal(await evaluate(`${input}.value`),
    "| Group | Decision |\n| --- | :---: |\n| **9 modules** | UsesOne Two a \\| pipe |\nBelow\nAfter");
});

test("indents list subtrees without flattening their descendants", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const { press, shift } = composerHelpers(command, sessionId);
  const input = `document.querySelector("#prompt-input")`;
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await waitFor(`!${input}.disabled`);
  const cases = [
    {
      original: "- A\n- B\n  - C\n    1. Grandchild\n- D",
      indented: "- A\n  - B\n    - C\n      1. Grandchild\n- D"
    },
    {
      original: "- A\n  - Existing\n- B\n  3. C\n     - Grandchild\n- D",
      indented: "- A\n  - Existing\n  - B\n    3. C\n       - Grandchild\n- D"
    },
    {
      original: "3. A\n4. B\n   7. C\n      - Grandchild\n5. D",
      indented: "3. A\n   1. B\n      7. C\n         - Grandchild\n4. D"
    }
  ];
  for (const { original, indented } of cases) {
    await evaluate(`
      ${input}.value = ${JSON.stringify(original)};
      ${input}.focus();
      ${input}.setSelectionRange(${input}.value.indexOf("B"), ${input}.value.indexOf("B"));
    `);
    const children = await evaluate(`${input}.querySelectorAll(":scope > ul > li, :scope > ol > li")[1].innerHTML`);
    await press("Tab");
    assert.equal(await evaluate(`${input}.value`), indented);
    assert.equal(await evaluate(`[...${input}.querySelectorAll("li")].find((item) => item.firstChild.textContent === "B").innerHTML`), children);
    await evaluate(`${input}.undo()`);
    assert.equal(await evaluate(`${input}.value`), original);
    await evaluate(`${input}.redo()`);
    assert.equal(await evaluate(`${input}.value`), indented);
    await press("Tab", shift);
    assert.equal(await evaluate(`${input}.value`), original);
  }
});

test("preserves literal Markdown and its selection offsets through draft and history round trips", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true, nativeMessages: true, nativeHistory: { events: [] }
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const input = `document.querySelector("#prompt-input")`;
  const session = `document.querySelector('button.session-item[data-session-id="${server.sessionId}"]')`;
  await waitFor(`Boolean(${session})`);
  await evaluate(`${session}.click()`);
  await waitFor(`document.querySelector("#messages").getAttribute("aria-busy") === "false" && !${input}.disabled`);
  const html = [
    "<p><strong>Example:</strong> literally **not bold** and _underscores_ and ~~not struck~~.</p>",
    "<p># Not a heading<br>- Not a list<br>1. Not numbered<br>&gt; Not a quote<br>---<br>[not a link](https://example.com)<br>literal \\ * `</p>",
    "<p><code>**code** _raw_ \\</code></p>"
  ].join("");
  const markdown = [
    String.raw`**Example:** literally \*\*not bold\*\* and \_underscores\_ and \~\~not struck\~\~.`,
    "",
    String.raw`\# Not a heading`,
    String.raw`\- Not a list`,
    String.raw`1\. Not numbered`,
    String.raw`\> Not a quote`,
    String.raw`\---`,
    String.raw`\[not a link\](https://example.com)`,
    "literal \\\\ \\* \\`",
    "",
    "`**code** _raw_ \\`"
  ].join("\n");
  await evaluate(`
    ${input}.focus();
    ${input}.insertClipboard({ html: ${JSON.stringify(html)} });
    ${input}.dispatchEvent(new Event("input", { bubbles: true }));
  `);
  assert.equal(await evaluate(`${input}.value`), markdown);
  const visible = await evaluate(`${input}.textContent`);
  await evaluate(`${input}.value = ${input}.value`);
  assert.equal(await evaluate(`${input}.textContent`), visible);
  assert.equal(await evaluate(`${input}.querySelectorAll("strong").length`), 1);
  assert.equal(await evaluate(`${input}.querySelector("h1, ul, ol, blockquote, hr, a, em, del, s")`), null);
  assert.equal(await evaluate(`${input}.value`), markdown);
  await evaluate(`document.querySelector("#new-chat").click()`);
  await waitFor(`${input}.value === ""`);
  await evaluate(`${session}.click()`);
  await waitFor(`${input}.value === ${JSON.stringify(markdown)} && !${input}.disabled`);
  assert.equal(await evaluate(`${input}.textContent`), visible);
  await evaluate(`document.querySelector("#composer").requestSubmit()`);
  await server.waitForPrompt(markdown);
  const message = `document.querySelector(".message.user .message-text")`;
  await waitFor(`document.querySelector("#messages").textContent.includes("Done.")`);
  assert.equal(await evaluate(`${message}.textContent`), visible);
  assert.equal(await evaluate(`${message}.querySelectorAll("strong").length`), 1);
  assert.equal(await evaluate(`${message}.querySelector("h1, ul, ol, blockquote, hr, a, em, del, s")`), null);
  const historyHtml = await evaluate(`${message}.innerHTML`);
  await evaluate(`window.beforeLiteralReload = true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeLiteralReload && Boolean(${message}) &&
    document.querySelector("#messages").getAttribute("aria-busy") === "false"`);
  assert.equal(await evaluate(`${message}.innerHTML`), historyHtml);

  const suffix = " a*b_c\\d";
  await evaluate(`
    ${input}.value = "";
    ${input}.focus();
    ${input}.insertClipboard({ html: ${JSON.stringify(`<p><strong>Title</strong>${suffix}</p>`)} });
  `);
  for (let offset = 0; offset <= suffix.length; offset += 1) {
    const expectedOffset = "**Title**".length + suffix.slice(0, offset).replace(/[\\*_]/g, "\\$&").length;
    await evaluate(`window.getSelection().collapse(${input}.querySelector("p").lastChild, ${offset})`);
    assert.equal(await evaluate(`${input}.selectionStart`), expectedOffset, `DOM offset ${offset}`);
    await evaluate(`${input}.setSelectionRange(${expectedOffset}, ${expectedOffset})`);
    assert.equal(await evaluate(`${input}.selectionStart`), expectedOffset, `Markdown offset ${expectedOffset}`);
  }
  await evaluate(`
    const node = ${input}.querySelector("p").lastChild;
    window.getSelection().setBaseAndExtent(node, 2, node, 3);
    ${input}.setRangeText("X", ${input}.selectionStart, ${input}.selectionEnd, "end");
  `);
  assert.equal(await evaluate(`${input}.textContent`), "Title aXb_c\\d");
  assert.equal(await evaluate(`${input}.value`), String.raw`**Title** aXb\_c\\d`);
});

test("keeps dictation outside completed inline formatting at DOM and Markdown boundaries", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, mockSpeechRecognition);
  const input = `document.querySelector("#prompt-input")`;
  const button = `document.querySelector("#voice-input")`;
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await waitFor(`!${input}.disabled && ${button}.dataset.state === "idle"`);
  const cases = [
    { html: "<strong>Bold</strong>", markdown: "**Bold**" },
    { html: "<em>Italic</em>", markdown: "*Italic*" },
    { html: "<s>Old</s>", markdown: "~~Old~~" },
    { html: "<code>code</code>", markdown: "`code`" },
    { html: '<a href="https://example.com">Link</a>', markdown: "[Link](https://example.com)" },
    { html: "<strong><em>Both</em></strong>", markdown: "***Both***" }
  ];
  for (const { html, markdown } of cases) {
    await evaluate(`
      ${input}.value = "";
      ${input}.focus();
      ${input}.insertClipboard({ html: ${JSON.stringify(`<p>${html}</p>`)} });
    `);
    assert.equal(await evaluate(`${input}.selectionStart`), markdown.length, `After pasting ${html}`);
    assert.equal(await evaluate(`${input}.selectionEnd`), markdown.length);
    await evaluate(`${input}.value = ${input}.value; ${input}.setSelectionRange(${markdown.length}, ${markdown.length})`);
    assert.equal(await evaluate(`${input}.selectionStart`), markdown.length, `After restoring ${html}`);
    await evaluate(`${button}.click()`);
    await waitFor(`${button}.dataset.state === "recording"`);
    await evaluate(`window.speechRecognitionTest.instances.at(-1).emit([{ transcript: "more", isFinal: false }])`);
    assert.equal(await evaluate(`${input}.value`), `${markdown} more`);
    await evaluate(`window.speechRecognitionTest.instances.at(-1).emit([{ transcript: "more words", isFinal: true }])`);
    assert.equal(await evaluate(`${input}.value`), `${markdown} more words`);
    assert.equal(await evaluate(`${input}.querySelector("p").lastChild.data`), " more words");
    await evaluate(`${button}.click()`);
    await waitFor(`${button}.dataset.state === "idle"`);
  }
  await evaluate(`
    ${input}.value = "***Both***";
    ${input}.focus();
    window.getSelection().collapse(${input}.querySelector("em").firstChild, 4);
  `);
  assert.equal(await evaluate(`${input}.selectionStart`), 7);
  await evaluate(`window.getSelection().collapse(${input}.querySelector("strong"), 1)`);
  assert.equal(await evaluate(`${input}.selectionStart`), 8);
  await evaluate(`window.getSelection().collapse(${input}.querySelector("p"), 1)`);
  assert.equal(await evaluate(`${input}.selectionStart`), 10);
  await evaluate(`${input}.setSelectionRange(0, 0)`);
  assert.equal(await evaluate(`${input}.selectionStart`), 0);
});

test("preserves rich composer drafts through switching, dictation, replacement, and file paste", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t, { existingSession: true });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, mockSpeechRecognition);
  const input = `document.querySelector("#prompt-input")`;
  const session = `document.querySelector('button.session-item[data-session-id="${server.sessionId}"]')`;
  await waitFor(`Boolean(${session})`);
  await evaluate(`${session}.click()`);
  await waitFor(`!${input}.disabled && document.querySelector("#messages").textContent.includes("GoCD")`);
  const draft = "**Intro**\n\n3. First\n   continued\n   - Nested\n4. Second";
  await evaluate(`
    ${input}.value = ${JSON.stringify(draft)};
    ${input}.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#new-chat").click();
  `);
  await waitFor(`${input}.value === ""`);
  await evaluate(`${session}.click()`);
  await waitFor(`${input}.value === ${JSON.stringify(draft)} && !${input}.disabled`);
  assert.equal(await evaluate(`${input}.querySelector("strong")?.textContent`), "Intro");
  assert.equal(await evaluate(`${input}.querySelector("ol > li > ul > li")?.textContent`), "Nested");

  await evaluate(`
    ${input}.setSelectionRange(${input}.value.length, ${input}.value.length);
    document.querySelector("#voice-input").click();
  `);
  await waitFor(`document.querySelector("#voice-input").dataset.state === "recording"`);
  await evaluate(`window.speechRecognitionTest.instances[0].emit([
    { transcript: "more detail", isFinal: true }
  ])`);
  assert.equal(await evaluate(`${input}.value`), `${draft} more detail`);
  assert.equal(await evaluate(`${input}.querySelector("strong")?.textContent`), "Intro");
  await evaluate(`document.querySelector("#voice-input").click()`);
  await waitFor(`document.querySelector("#voice-input").dataset.state === "idle"`);

  await evaluate(`
    (() => {
      const input = ${input};
      input.focus();
      input.setSelectionRange(0, input.value.length);
      const transfer = new DataTransfer();
      transfer.setData("text/html", "<p><b>Attached</b> note</p>");
      transfer.setData("text/plain", "Attached note");
      transfer.items.add(new File(["file content"], "pasted.txt", { type: "text/plain" }));
      input.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: transfer, bubbles: true, cancelable: true
      }));
    })()
  `);
  await waitFor(`document.querySelector("#attachment-list").textContent.includes("pasted.txt")`);
  assert.equal(await evaluate(`${input}.value`), "**Attached** note");
  await evaluate(`${input}.undo()`);
  assert.equal(await evaluate(`${input}.value`), `${draft} more detail`);
  await evaluate(`${input}.redo()`);
  assert.equal(await evaluate(`${input}.value`), "**Attached** note");
  await evaluate(`document.querySelector("#composer").requestSubmit()`);
  await server.waitForPrompt("**Attached** note");
  await waitFor(`document.querySelector("#messages").textContent.includes("Done.")`);
});

test("renders user Markdown in live and restored history, rich copies, and selection sources", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const nestedEmphasisMarkdown = "**bold *italic*** and *italic **bold*** and __bold _italic___ and _italic __bold___";
  const historicalPrompt = [
    "# Instructions",
    "",
    "**Rules:**",
    "",
    "3. **English:** Translate `word`.",
    "   - **Informal:** *du / ihr*",
    "   - **Formal:** *Sie*",
    "4. Continue",
    "   on a second line.",
    "",
    "> Keep it simple.",
    "",
    "```js",
    "const value = '<script>literal</script>';",
    "```",
    "",
    "***Bold italic*** and `` `ticks` ``.",
    nestedEmphasisMarkdown,
    "",
    "[Reference](https://example.com)",
    "<script>window.userMarkupExecuted = true</script>",
    "[Unsafe](javascript:alert(1))"
  ].join("\n");
  const assistantCode = [
    "gh api \\",
    "  -H 'X-GitHub-Api-Version: 2026-03-10' \\",
    '  "/users/$(gh api user --jq .login)/settings/billing/ai_credit/usage" \\',
    "  -f year=2026 -f month=10 \\",
    "  --jq '[.usageItems[].grossQuantity] | add // 0'"
  ].join("\n");
  const assistantTable = "| Group | Decision |\n| --- | ---: |\n| **9 modules** | Enabled `a|b` and \\| pipes |";
  const events = nativeHistoryEvents().map((event) => {
    if (event.id === "persisted-assistant-event") {
      assert.ok(isRecord(event.data));
      return {
        ...event,
        data: {
          ...event.data,
          content: `Native historical reply\n\n${nestedEmphasisMarkdown}\n\n\`\`\`sh\n${assistantCode}\n\`\`\`\n\n${assistantTable}`
        }
      };
    }
    if (event.type !== "user.message") return event;
    assert.ok(isRecord(event.data));
    return { ...event, data: { ...event.data, content: historicalPrompt } };
  });
  const server = await startTestServer(t, {
    existingSession: true, nativeMessages: true, nativeHistory: { events }
  });
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    window.clipboardWrites = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        async write(items) {
          const item = items[0];
          window.clipboardWrites.push({
            text: await (await item.getType("text/plain")).text(),
            html: await (await item.getType("text/html")).text()
          });
        }
      }
    });
  `);
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1200, height: 900, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  const users = `[...document.querySelectorAll(".message.user .message-text")]`;
  const input = `document.querySelector("#prompt-input")`;
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Native historical reply")`);
  await evaluate(`${input}.value = ${JSON.stringify(nestedEmphasisMarkdown)}`);
  const nestedText = ["italic", "bold", "italic", "bold"];
  assert.deepEqual(await evaluate(`[...${input}.querySelectorAll("strong em, em strong")].map((node) => node.textContent)`), nestedText);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll(".message.assistant .message-body strong em, .message.assistant .message-body em strong")].map((node) => node.textContent)`), nestedText);
  await evaluate(`${input}.value = ""`);
  assert.deepEqual(await evaluate(`
    (() => {
      const text = ${users}[0];
      return {
        heading: text.querySelector("h1")?.textContent,
        title: text.querySelector("p > strong")?.textContent,
        start: text.querySelector("ol")?.getAttribute("start"),
        nested: [...text.querySelectorAll("ol > li > ul > li")]
          .map((item) => item.textContent),
        continuation: text.querySelector("ol > li:last-child")?.innerHTML,
        code: [...text.querySelectorAll("code")].map((code) => code.textContent),
        combined: text.querySelector("strong em")?.textContent,
        nestedEmphasis: [...text.querySelectorAll("strong em, em strong")].map((node) => node.textContent),
        quote: text.querySelector("blockquote")?.textContent,
        link: text.querySelector("a")?.getAttribute("href"),
        unsafe: Boolean(text.querySelector("script, [href^='javascript:']")) ||
          Boolean(window.userMarkupExecuted),
        whitespace: getComputedStyle(text).whiteSpace,
        lastMargin: getComputedStyle(text.lastElementChild).marginBottom
      };
    })()
  `), {
    heading: "Instructions", title: "Rules:", start: "3",
    nested: ["Informal: du / ihr", "Formal: Sie"],
    continuation: "Continue<br>on a second line.",
    code: ["word", "const value = '<script>literal</script>';", "`ticks`"],
    combined: "Bold italic", nestedEmphasis: ["Bold italic", "italic", "bold", "italic", "bold"],
    quote: "Keep it simple.", link: "https://example.com/",
    unsafe: false, whitespace: "normal", lastMargin: "0px"
  });
  assert.equal(await evaluate(`document.querySelector(".message.user .message-attachment-image")?.alt`), "diagram.png");
  const historicalHtml = await evaluate(`${users}[0].innerHTML`);
  await evaluate(`document.querySelector(".message.user .message-copy").click()`);
  await waitFor(`window.clipboardWrites.length === 1`);
  assert.equal(await evaluate(`window.clipboardWrites[0].text`), `${historicalPrompt}\n\nAttachments: diagram.png`);
  assert.equal(await evaluate(`window.clipboardWrites[0].html.includes("<strong>Rules:</strong>")`), true);
  assert.equal(await evaluate(`window.clipboardWrites[0].html.includes("code-copy")`), false);
  await evaluate(`document.querySelector(".message.assistant .code-copy").click()`);
  await waitFor(`window.clipboardWrites.length === 2`);
  assert.equal(await evaluate(`window.clipboardWrites[1].text`), assistantCode);
  assert.equal(await evaluate(`window.clipboardWrites[1].html.includes("<pre><code>")`), true);
  assert.equal(await evaluate(`window.clipboardWrites[1].html.includes("code-copy")`), false);
  assert.equal(await evaluate(`document.querySelector(".message.assistant .code-copy").getAttribute("aria-label")`), "Code copied");
  await evaluate(`document.querySelector(".message.assistant .message-copy").click()`);
  await waitFor(`window.clipboardWrites.length === 3`);
  assert.equal(await evaluate(`window.clipboardWrites[2].text.includes(${JSON.stringify(assistantCode)})`), true);
  assert.equal(await evaluate(`window.clipboardWrites[2].html.includes("code-copy")`), false);
  assert.equal(await evaluate(`window.clipboardWrites[2].html.includes("table-copy")`), false);
  assert.equal(await evaluate(`
    (() => {
      const block = document.querySelector(".message.assistant .code-block");
      return block.querySelector(".code-copy").getBoundingClientRect().bottom <=
        block.querySelector("pre").getBoundingClientRect().top;
    })()
  `), true);
  await evaluate(`document.querySelector(".message.assistant .table-copy").click()`);
  await waitFor(`window.clipboardWrites.length === 4`);
  assert.equal(await evaluate(`window.clipboardWrites[3].text`),
    "| Group | Decision |\n| --- | ---: |\n| 9 modules | Enabled a\\|b and \\| pipes |");
  assert.equal(await evaluate(`window.clipboardWrites[3].html.startsWith("<table>")`), true);
  assert.equal(await evaluate(`document.querySelector(".message.assistant .table-copy").getAttribute("aria-label")`), "Table copied");
  assert.equal(await evaluate(`
    (() => {
      ${input}.value = "";
      ${input}.focus();
      ${input}.insertClipboard(window.clipboardWrites[3]);
      return ${input}.value;
    })()
  `), `${assistantTable}\n`);
  assert.equal(await evaluate(`${input}.querySelectorAll("table th, table td").length`), 4);
  await evaluate(`${input}.value = ""`);

  await evaluate(`
    (() => {
      const input = ${input};
      input.focus();
      const transfer = new DataTransfer();
      transfer.setData("text/html",
        "<h2>Live prompt</h2><p><b>Keep</b> this formatting</p><ol><li>First<ul><li>Nested</li></ul></li><li>Second</li></ol>");
      input.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: transfer, bubbles: true, cancelable: true
      }));
      window.sentRichPrompt = input.value;
      document.querySelector("#composer").requestSubmit();
    })()
  `);
  const sentPrompt = await evaluate(`window.sentRichPrompt`);
  assert.equal(typeof sentPrompt, "string");
  await server.waitForPrompt(String(sentPrompt));
  await waitFor(`${users}.length === 2 && document.querySelector("#messages").textContent.includes("Done.")`);
  assert.equal(await evaluate(`${users}[1].querySelector("h2")?.textContent`), "Live prompt");
  assert.equal(await evaluate(`${users}[1].querySelector("p > strong")?.textContent`), "Keep");
  assert.equal(await evaluate(`${users}[1].querySelector("ol > li > ul > li")?.textContent`), "Nested");
  const liveHtml = await evaluate(`${users}[1].innerHTML`);

  await evaluate(`window.beforeRichHistoryReload = true`);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeRichHistoryReload && ${users}.length === 2 &&
    document.querySelector("#messages").getAttribute("aria-busy") === "false"`);
  assert.equal(await evaluate(`${users}[0].innerHTML`), historicalHtml);
  assert.equal(await evaluate(`${users}[1].innerHTML`), liveHtml);
  assert.equal(await evaluate(`document.querySelector(".message.user .message-attachment-image")?.alt`), "diagram.png");

  await evaluate(`
    (() => {
      const paragraph = ${users}[1].querySelector("p");
      paragraph.scrollIntoView({ block: "center" });
      document.querySelector("#messages").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    })()
  `);
  await waitFor(`!document.querySelector("#ask-selection").hidden`);
  await evaluate(`
    document.querySelector("#ask-selection").click();
    ${input}.value = "Explain this.";
    ${input}.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#composer").requestSubmit();
  `);
  await server.waitForPrompt("Explain this.\n\nSelected passages from the conversation:\nSelection 1:\n> Keep this formatting");
  await waitFor(`document.querySelectorAll(".message.assistant").length === 3 &&
    document.querySelector("#messages").getAttribute("aria-busy") === "false"`);
  await evaluate(`
    localStorage.removeItem("copilot-web-selection-messages");
    window.beforeSelectionSourceReload = true;
  `);
  await command("Page.reload", {}, sessionId);
  await waitFor(`!window.beforeSelectionSourceReload &&
    document.querySelector(".message-selection-summary")?.textContent === "1 selection"`);
  await evaluate(`document.querySelector(".message-selection-summary").click()`);
  await waitFor(`(window.CSS.highlights?.get("copilot-web-source-selection")
    ? [...window.CSS.highlights.get("copilot-web-source-selection")].map((range) => range.toString()).join("")
    : window.getSelection().toString()) === "Keep this formatting"`);
});

test("keeps the rich composer readable and bounded in light and dark themes", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const server = await startTestServer(t);
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  const input = `document.querySelector("#prompt-input")`;
  const ready = `Boolean(customElements.get("prompt-editor")) &&
    Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]')) &&
    !${input}.disabled`;
  await waitFor(ready);
  const text = "**Follow these rules**\n\n1. *One* sentence with `code`\n   - Nested point\n2. Next point\n\n> A useful quote\n\n```js\nconst value = 1;\n```";
  for (const theme of ["light", "dark"]) {
    await evaluate(`
      localStorage.setItem("copilot-web-theme", ${JSON.stringify(theme)});
      window.beforeComposerThemeReload = true;
    `);
    await command("Page.reload", {}, sessionId);
    await waitFor(`!window.beforeComposerThemeReload && (${ready})`);
    assert.equal(await evaluate(`document.documentElement.dataset.theme`), theme);
    for (const width of [1280, 390]) {
      await command("Emulation.setDeviceMetricsOverride", {
        width, height: 900, deviceScaleFactor: 1, mobile: false
      }, sessionId);
      await evaluate(`
        ${input}.value = ${JSON.stringify(text)};
        ${input}.dispatchEvent(new Event("input", { bubbles: true }));
        ${input}.scrollTop = 0;
      `);
      assert.deepEqual(await evaluate(`
        (() => {
          const input = ${input};
          const bounds = input.getBoundingClientRect();
          const composer = document.querySelector("#composer").getBoundingClientRect();
          const styles = getComputedStyle(input);
          return {
            boundedHeight: bounds.height <= 130 && bounds.height >= 36,
            contained: bounds.left >= composer.left && bounds.right <= composer.right,
            fitsViewport: composer.left >= 0 && composer.right <= innerWidth,
            scrollable: styles.overflowY === "auto" && input.scrollHeight > input.clientHeight,
            bold: getComputedStyle(input.querySelector("strong")).fontWeight >= 600,
            italic: getComputedStyle(input.querySelector("em")).fontStyle === "italic",
            listMarkers: getComputedStyle(input.querySelector("ul")).listStyleType !== "none",
            color: styles.color
          };
        })()
      `), {
        boundedHeight: true, contained: true, fitsViewport: true, scrollable: true,
        bold: true, italic: true, listMarkers: true,
        color: theme === "light" ? "rgb(29, 34, 48)" : "rgb(241, 243, 245)"
      }, `${theme}, ${width}px`);
      await evaluate(`
        ${input}.value = "";
        ${input}.dispatchEvent(new Event("input", { bubbles: true }));
      `);
      assert.equal(await evaluate(`${input}.classList.contains("is-empty") &&
        getComputedStyle(${input}, "::before").content.includes("Message Copilot") &&
        ${input}.getBoundingClientRect().height === 36`), true);
    }
  }
});

function longConversationEvents(count: number, content = "Stored message"): JsonObject[] {
  return Array.from({ length: count }, (_, index) => nativeTranscriptEvent(
    index % 2 === 0 ? "user.message" : "assistant.message",
    `paged-${index}`,
    `${content} ${index}`,
    index
  ));
}

async function scrollUpAndWaitForHistory(
  evaluate: (expression: string) => Promise<unknown>,
  waitFor: (expression: string) => Promise<void>
): Promise<boolean> {
  await evaluate(`(() => {
    window.historyLoadObserved = false;
    window.historyLoadComplete = false;
    const messages = document.querySelector("#messages");
    const observer = new MutationObserver(() => {
      if (messages.querySelector("#history-loading")) {
        window.historyLoadObserved = true;
      } else if (window.historyLoadObserved) {
        observer.disconnect();
        window.clearTimeout(window.historyLoadTimeout);
        window.historyLoadComplete = true;
      }
    });
    window.historyLoadTimeout = window.setTimeout(() => {
      observer.disconnect();
      window.historyLoadComplete = true;
    }, 500);
    if (messages.querySelector("#history-loading")) {
      window.historyLoadObserved = true;
    }
    observer.observe(messages, { childList: true, subtree: true });
    messages.scrollTop = messages.scrollHeight;
    messages.dispatchEvent(new Event("scroll"));
    messages.scrollTop = Math.min(120, Math.floor(messages.scrollTop / 2));
    messages.dispatchEvent(new Event("scroll"));
  })()`);
  await waitFor("window.historyLoadComplete");
  return await evaluate("window.historyLoadObserved === true") === true;
}

test("pages display history without changing the native transcript, session ID, or prompt", async (t) => {
  const events = longConversationEvents(240);
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeReplay: true,
    nativeHistory: { events }
  });
  const before = await server.nativeHistory();
  const stream = openEventStream(server.baseUrl, server.headers);
  t.after(stream.close);
  const streamDeadline = Date.now() + 2000;
  while (!stream.events.some((event) => event.event === "ready")) {
    assert.ok(Date.now() < streamDeadline, "The event stream did not connect");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const loadedResponse = await server.post("load", { historyPaging: true, context: "default" });
  assert.equal(loadedResponse.status, 200);
  const loaded: unknown = await loadedResponse.json();
  assert.ok(isRecord(loaded) && isRecord(loaded.history) && Array.isArray(loaded.nativeMessages));
  assert.equal(loaded.nativeMessages.length, 20);
  assert.equal(loaded.nativeMessages[0]?.messageId, "paged-220");
  assert.equal(loaded.history.hasMore, true);
  assert.equal(loaded.history.replayMode, "native");
  const nativeReads = (await server.historyReads()).filter((request) => (
    isRecord(request) && request.sessionId === server.sessionId
  ));
  assert.equal(nativeReads.length, 1, "Initial hydration must only read one native page");
  assert.equal(isRecord(nativeReads[0]) && nativeReads[0].direction, "backward");
  assert.equal(stream.events.some((event) => event.event === "session-update" &&
    isRecord(event.data) && event.data._replay === true), false);
  assert.equal(stream.events.some((event) => event.event === "native-message"), false);
  assert.deepEqual(loaded.liveNativeMessages, []);

  let cursor = String(loaded.history.cursor);
  const ids = loaded.nativeMessages.filter(isRecord).map((message) => message.messageId);
  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(`${server.baseUrl}/api/sessions/${server.sessionId}/history?${
      new URLSearchParams({ cursor })
    }`, { headers: server.headers });
    assert.equal(response.status, 200);
    const page: unknown = await response.json();
    assert.ok(isRecord(page) && isRecord(page.history) && Array.isArray(page.nativeMessages));
    ids.unshift(...page.nativeMessages.filter(isRecord).map((message) => message.messageId));
    cursor = String(page.history.cursor);
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(await server.nativeHistory(), before);
  const callsBeforePrompt = await server.requests();
  assert.equal(callsBeforePrompt.filter((request) => request.method === "session/load").length, 1);
  assert.equal(callsBeforePrompt.some((request) => request.method === "session/new"), false);
  assert.equal(callsBeforePrompt.some((request) => request.method === "session/close"), false);
  const text = "Use the original conversation, including its oldest decisions.";
  assert.equal((await server.post("messages", { text })).status, 200);
  const prompts = (await server.requests()).filter((request) => request.method === "session/prompt");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.sessionId, server.sessionId);
  assert.equal(prompts[0]?.text, text);
  assert.equal(prompts[0]?.prompt, undefined, "No browser transcript may be appended to the prompt");
});

test("falls back to persisted chat when a complete ACP replay has no alignable messages", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const events = [
    nativeTranscriptEvent("user.message", "native-user", "Persisted user message", 0, {
      testAcpHidden: true
    }),
    nativeTranscriptEvent("assistant.message", "native-assistant", "Persisted Copilot answer", 1, {
      testAcpHidden: true
    }),
    nativeTranscriptEvent("assistant.message", "acp-empty-assistant", "", 2, {
      testNativeHidden: true,
      testAcpEmptyMessage: true,
      toolRequests: [{ toolCallId: "acp-empty-tool", name: "read_file" }]
    })
  ];
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Persisted user message") &&
    document.querySelector("#messages").textContent.includes("Persisted Copilot answer")`);
  assert.equal(await evaluate(`document.querySelectorAll(".message.user").length`), 1);
  assert.equal(await evaluate(`document.querySelectorAll(".message.assistant").length`), 1);
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});

test("replays the complete same session when both paged and full native history reads fail", async (t) => {
  const events = longConversationEvents(600, "Complete ACP fallback ".repeat(25));
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events }
  });
  assert.equal((await server.post("load", { historyPaging: true })).status, 200);
  await server.historyReadFailure(true);
  const response = await server.post("load", { historyPaging: true });
  assert.equal(response.status, 200);
  const loaded: unknown = await response.json();
  assert.ok(isRecord(loaded) && Array.isArray(loaded.replayUpdates));
  assert.equal(loaded.history, undefined);
  assert.equal(loaded.nativeMessagesActive, false);
  const oldestMessage = isRecord(events[0]?.data) ? events[0].data.content : undefined;
  assert.equal(typeof oldestMessage, "string");
  assert.ok(
    JSON.stringify(loaded.replayUpdates).includes(String(oldestMessage)),
    JSON.stringify({
      historyWarning: loaded.historyWarning,
      replayCount: loaded.replayUpdates.length,
      hasOldest: JSON.stringify(loaded.replayUpdates).includes("Complete ACP fallback"),
      loads: (await server.requests()).filter((request) => request.method === "session/load").length,
      closes: (await server.requests()).filter((request) => request.method === "session/close").length
    })
  );
  assert.ok(loaded.replayUpdates.length >= events.length);
  const requests = await server.requests();
  assert.equal(requests.filter((request) => request.method === "session/close").length, 1);
  assert.equal(requests.filter((request) => request.method === "session/load").length, 2);
  assert.equal(requests.some((request) => request.method === "session/new"), false);
  assert.equal(requests.some((request) => request.method === "session/prompt"), false);
  assert.deepEqual(await server.nativeHistory(), { "session-1": events });
});

test("keeps ACP-only command replies when requesting an older native-history page", async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events: longConversationEvents(240) }
  });
  const initial = await (await server.post("load", { historyPaging: true })).json();
  assert.ok(isRecord(initial) && isRecord(initial.history) &&
    typeof initial.history.cursor === "string");
  assert.equal((await server.post("messages", {
    text: "/mcp reload",
    clientPromptId: "paged-command",
    reconnect: true
  })).status, 200);
  const olderResponse = await fetch(
    `${server.baseUrl}/api/sessions/${server.sessionId}/history?${new URLSearchParams({
      cursor: initial.history.cursor
    })}`,
    { headers: server.headers }
  );
  assert.equal(olderResponse.status, 200);
  const older: unknown = await olderResponse.json();
  assert.ok(isRecord(older) && Array.isArray(older.replayUpdates));
  const updates = older.replayUpdates.filter(isRecord);
  assert.ok(updates.some((entry) => entry.nativeCommand === true &&
    isRecord(entry.update) &&
    JSON.stringify(entry.update).includes("/mcp reload")));
  assert.ok(updates.some((entry) => entry.nativeCommand === true &&
    isRecord(entry.update) &&
    JSON.stringify(entry.update).includes("MCP configuration reloaded and servers restarted.")));
  const prompts = (await server.requests()).filter((request) => request.method === "session/prompt");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.sessionId, server.sessionId);
  assert.equal(prompts[0]?.text, "/mcp reload");
});

test("bounds long-message history by bytes and explicitly expires cursors", async (t) => {
  const events = longConversationEvents(40, "Long message ".repeat(3000));
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events }
  });
  const loadedResponse = await server.post("load", { historyPaging: true });
  const loaded: unknown = await loadedResponse.json();
  assert.ok(isRecord(loaded) && isRecord(loaded.history) && Array.isArray(loaded.nativeMessages));
  assert.ok(loaded.nativeMessages.length < 10);
  assert.ok(Buffer.byteLength(JSON.stringify(loaded)) < 128 * 1024);
  assert.equal(loaded.history.oversized, false);
  const response = await fetch(`${server.baseUrl}/api/sessions/${server.sessionId}/history?cursor=expired`, {
    headers: server.headers
  });
  assert.equal(response.status, 410);
  const rebased = await fetch(`${server.baseUrl}/api/sessions/${server.sessionId}/history?before=paged-38`, {
    headers: server.headers
  });
  assert.equal(rebased.status, 200);
  const older: unknown = await rebased.json();
  assert.ok(isRecord(older) && Array.isArray(older.nativeMessages));
  assert.ok(older.nativeMessages.filter(isRecord).every((message) => (
    Number(String(message.messageId).slice("paged-".length)) < 38
  )));
  assert.deepEqual(await server.nativeHistory(), { "session-1": events });
});

test("merges interrupted assistant replies split across history pages", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const repeatedText = "same ".repeat(12_288);
  const olderText = repeatedText;
  const newerText = `${repeatedText}continued`;
  const timestamp = "2026-10-14T10:00:00.000Z";
  const events: JsonObject[] = [
    {
      id: "split-assistant-start",
      type: "assistant.message_start",
      timestamp,
      parentId: null,
      data: { messageId: "split-assistant" }
    },
    {
      id: "split-assistant-older-delta",
      type: "assistant.message_delta",
      timestamp: "2026-10-14T10:00:01.000Z",
      parentId: null,
      data: { messageId: "split-assistant", deltaContent: olderText }
    },
    {
      id: "split-assistant-newer-delta",
      type: "assistant.message_delta",
      timestamp: "2026-10-14T10:00:02.000Z",
      parentId: null,
      data: { messageId: "split-assistant", deltaContent: newerText }
    }
  ];
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`document.querySelector(".message.assistant .message-body")?.textContent.length === ${
    newerText.length
  }`);

  assert.deepEqual(await evaluate(`(() => {
    const text = document.querySelector(".message.assistant .message-body").textContent;
    return {
      length: text.length,
      matchesNewerPage: text === "same ".repeat(${repeatedText.length / "same ".length}) + "continued"
    };
  })()`), {
    length: newerText.length,
    matchesNewerPage: true
  });
  assert.equal(await scrollUpAndWaitForHistory(evaluate, waitFor), true);
  await waitFor(`document.querySelector(".message.assistant .message-body")?.textContent.length === ${
    olderText.length + newerText.length
  }`);
  assert.deepEqual(await evaluate(`(() => {
    const text = document.querySelector(".message.assistant .message-body").textContent;
    return {
      length: text.length,
      startsWithOlder: text.startsWith("same ".repeat(${repeatedText.length / "same ".length})),
      endsWithNewer: text.endsWith("continued")
    };
  })()`), {
    length: olderText.length + newerText.length,
    startsWithOlder: true,
    endsWithNewer: true
  });
  assert.equal(await evaluate(`document.querySelectorAll("#messages > .message.assistant").length`), 1);
  assert.equal(await evaluate("window.testBrowserErrors.length"), 0);
});

test("loads older messages on upward scroll and preserves the full transcript and viewport anchor", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const events = longConversationEvents(240, "A paragraph of **formatted conversation history**. ".repeat(8));
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events, readDelayMs: 30 }
  });
  const originalHistory = await server.nativeHistory();
  const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("239") &&
    !document.querySelector("#send-prompt").disabled`);
  const requestsBeforePaging = await server.requests();
  assert.equal(await evaluate(`document.querySelector("#load-older-messages") === null`), true);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("One large history entry")`), false);
  assert.equal(await evaluate(`document.querySelectorAll("#messages > .message").length`), 20);
  assert.equal(await evaluate(`Array.from({ length: 20 }, (_, index) =>
    Boolean(document.querySelector(
      '[data-message-key="native:' +
        (index % 2 === 0 ? "user" : "assistant") +
        ':paged-' + (220 + index) + '"]'
    ))
  ).every(Boolean)`), true);
  assert.equal(await evaluate(`document.querySelector("#messages").scrollTop > 160`), true,
    "An opened conversation must start at its latest messages");
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("history**. 0")`), false);
  await evaluate(`(() => {
    const messages = document.querySelector("#messages");
    messages.scrollTop = 20;
    window.oldestVisibleArticle = [...messages.querySelectorAll(".message")]
      .find((article) => article.getBoundingClientRect().bottom > messages.getBoundingClientRect().top);
    window.oldestVisibleKey = window.oldestVisibleArticle?.dataset.messageKey;
    window.oldestVisibleTop = window.oldestVisibleArticle?.getBoundingClientRect().top;
  })()`);
  await waitFor(`document.querySelectorAll("#messages > .message").length > 20`);
  const preservedAnchor = await evaluate(`(() => {
    const article = [...document.querySelectorAll("#messages > .message")]
      .find((item) => item.dataset.messageKey === window.oldestVisibleKey);
    return {
      sameArticle: article === window.oldestVisibleArticle,
      delta: article ? article.getBoundingClientRect().top - window.oldestVisibleTop : null,
      scrollTop: document.querySelector("#messages").scrollTop,
      loading: Boolean(document.querySelector("#history-loading"))
    };
  })()`);
  assert.ok(isRecord(preservedAnchor));
  assert.equal(preservedAnchor.sameArticle, true, JSON.stringify(preservedAnchor));
  assert.ok(typeof preservedAnchor.delta === "number" && Math.abs(preservedAnchor.delta) < 3,
    `Prepending must retain the visible message's pixel position: ${JSON.stringify(preservedAnchor)}`);
  for (let index = 0; index < 8; index += 1) {
    await scrollUpAndWaitForHistory(evaluate, waitFor);
    assert.equal(await evaluate(`document.querySelector("#messages .transcript-spacer") === null`), true);
  }
  assert.equal(await evaluate(`document.querySelectorAll("#messages > .message").length`), 200);
  await command("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 900, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  await waitFor(`document.querySelectorAll("#messages > .message").length === 200`);
  await evaluate(`(() => {
    const messages = document.querySelector("#messages");
    messages.scrollTop = messages.scrollHeight;
    messages.dispatchEvent(new Event("scroll"));
  })()`);
  await waitFor(`document.querySelector("#messages").scrollHeight -
      document.querySelector("#messages").scrollTop -
      document.querySelector("#messages").clientHeight < 80`);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("239")`), true);
  assert.deepEqual(await server.nativeHistory(), originalHistory,
    "Paging must not modify the transcript Copilot uses as its session history");
  const prompt = "Continue from the original conversation.";
  await evaluate(`(() => {
    const input = document.querySelector("#prompt-input");
    input.value = ${JSON.stringify(prompt)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#composer").requestSubmit();
  })()`);
  await server.waitForPrompt(prompt);
  await waitFor(`document.querySelector("#messages").textContent.includes("Done.")`);
  const promptRequests = (await server.requests()).filter((request) => (
    request.method === "session/prompt"
  ));
  assert.equal(promptRequests.length, 1);
  assert.equal(promptRequests[0]?.sessionId, server.sessionId);
  assert.equal(promptRequests[0]?.text, prompt);
  assert.equal(promptRequests[0]?.prompt, undefined);
  const requestsAfterPrompt = await server.requests();
  assert.equal(requestsAfterPrompt.filter((request) => request.method === "session/load").length, 1);
  assert.equal(
    requestsAfterPrompt.filter((request) => request.method === "session/new").length,
    requestsBeforePaging.filter((request) => request.method === "session/new").length
  );
  assert.equal(requestsAfterPrompt.some((request) => (
    request.method === "session/close" && request.sessionId === server.sessionId
  )), false);
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});

test("renders oversized history entries without leaving a blank spacer", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const events = [
    nativeTranscriptEvent(
      "assistant.message", "oversized-before-viewport", "Large old response ".repeat(12_000), 0
    ),
    ...longConversationEvents(20)
  ];
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events, readDelayMs: 30 }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Stored message 19") &&
    !document.querySelector("#send-prompt").disabled`);
  await scrollUpAndWaitForHistory(evaluate, waitFor);
  await evaluate(`(() => {
    const messages = document.querySelector("#messages");
    messages.scrollTop = messages.scrollHeight;
    messages.dispatchEvent(new Event("scroll"));
  })()`);
  await waitFor(`Boolean(document.querySelector('[data-message-key="native:assistant:oversized-before-viewport"]'))`);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("One large history entry")`), false);
  assert.equal(await evaluate(`document.querySelector("#messages .transcript-spacer") === null`), true);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("Stored message 1")`), true);
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});

test("keeps inactive transcripts and drafts without replacing native sessions", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const server = await startTestServer(t, {
    profileSessions: true,
    nativeMessages: true,
    nativeHistory: { events: [] }
  });
  const ids = [server.sessionId];
  for (let index = 0; index < 5; index += 1) {
    ids.push(await server.createSession());
  }
  for (const [index, id] of ids.entries()) {
    const response = await fetch(`${server.baseUrl}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: server.headers,
      body: JSON.stringify({ text: `Conversation ${index}` })
    });
    assert.equal(response.status, 200);
  }
  const before = await server.nativeHistory();
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  for (const [index, id] of ids.entries()) {
    await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${id}"]'))`);
    await evaluate(`document.querySelector('button.session-item[data-session-id="${id}"]').click()`);
    await waitFor(`!document.querySelector("#send-prompt").disabled &&
      document.querySelector("#messages").textContent.includes("Conversation ${index}")`);
    if (index === 0) {
      await evaluate(`document.querySelector("#prompt-input").value = "Keep this unsent draft";`);
    }
  }
  const readsBefore = (await server.historyReads()).filter((read) => (
    isRecord(read) && read.sessionId === ids[0]
  )).length;
  await evaluate(`document.querySelector('button.session-item[data-session-id="${ids[0]}"]').click()`);
  await waitFor(`!document.querySelector("#send-prompt").disabled &&
    document.querySelector("#messages").textContent.includes("Conversation 0")`);
  const readsAfter = (await server.historyReads()).filter((read) => (
    isRecord(read) && read.sessionId === ids[0]
  )).length;
  assert.equal(readsAfter, readsBefore, "Switching back should reuse the loaded transcript");
  assert.equal(await evaluate(`document.querySelector("#prompt-input").value`), "Keep this unsent draft");
  assert.deepEqual(await server.nativeHistory(), before);
  const requests = await server.requests();
  assert.equal(requests.filter((request) => request.method === "session/prompt").length, ids.length);
  assert.equal(requests.some((request) => request.method === "session/close" && ids.includes(String(request.sessionId))), false);
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});

test("fetches an unloaded selected passage by stable ID and leaves AI context untouched", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const events = longConversationEvents(240);
  const source = "Stored message 4";
  const prompt = `Explain this\n\nSelected passages from the conversation:\nSelection 1:\n> ${source}`;
  events[238] = nativeTranscriptEvent("user.message", "paged-238", prompt, 238);
  const server = await startTestServer(t, {
    existingSession: true, nativeMessages: true, nativeHistory: { events }
  });
  const stored = {
    [server.sessionId]: [{
      promptText: prompt,
      displayText: "Explain this",
      messageId: "paged-238",
      selections: [{
        id: "selection-1", number: 1, text: source, sessionId: server.sessionId,
        sourceMessageId: "paged-4", messageIndex: 4,
        startPath: [], endPath: [], startOffset: 0, endOffset: 0
      }],
      createdAt: Date.now()
    }]
  };
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    localStorage.setItem("copilot-web-selection-messages", ${JSON.stringify(JSON.stringify(stored))});
  `);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`Boolean(document.querySelector(".message-selection-summary"))`);
  await evaluate(`document.querySelector(".message-selection-summary").click()`);
  await waitFor(`(window.CSS.highlights?.get("copilot-web-source-selection")
    ? [...window.CSS.highlights.get("copilot-web-source-selection")].map((range) => range.toString()).join("")
    : window.getSelection().toString()) === ${JSON.stringify(source)}`);
  assert.equal(await evaluate(`Boolean(document.querySelector("#load-latest-messages"))`), true);
  assert.deepEqual(await server.nativeHistory(), { "session-1": events });
  const requests = await server.requests();
  assert.equal(requests.filter((request) => request.method === "session/load").length, 1);
  assert.equal(requests.some((request) => request.method === "session/prompt"), false);
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});

for (const abortLoad of [false, true]) {
  test(abortLoad
    ? "recovers a source-page send when refresh aborts its history preparation"
    : "does not replay a failed source-page send after its explicit retry succeeds", {
    skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
    timeout: 20_000
  }, async (t) => {
    const events = longConversationEvents(60);
    const source = "Stored message 4";
    const prompt = `Explain this\n\nSelected passages from the conversation:\nSelection 1:\n> ${source}`;
    events[58] = nativeTranscriptEvent("user.message", "paged-58", prompt, 58);
    const server = await startTestServer(t, {
      existingSession: true, nativeMessages: true,
      nativeHistory: { events, readDelayMs: abortLoad ? 400 : 0 }
    });
    const stored = {
      [server.sessionId]: [{
        promptText: prompt, displayText: "Explain this", messageId: "paged-58",
        selections: [{
          id: "selection-1", number: 1, text: source, sessionId: server.sessionId,
          sourceMessageId: "paged-4", messageIndex: 4,
          startPath: [], endPath: [], startOffset: 0, endOffset: 0
        }],
        createdAt: Date.now()
      }]
    };
    const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    localStorage.setItem("copilot-web-selection-messages", ${JSON.stringify(JSON.stringify(stored))});
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (resource, init) => {
      if (resource.endsWith("/load") && init?.method === "POST" && window.failNextLoad) {
        window.failNextLoad = false;
        return Promise.resolve(new Response(JSON.stringify({ error: "History temporarily unavailable" }),
          { status: 503 }));
      }
      if (resource.endsWith("/load") && init?.method === "POST" && window.trackNextLoad) {
        window.latestLoadStarted = true;
      }
      return nativeFetch(resource, init);
    };
  `);
    await waitFor(`Boolean(document.querySelector('[data-session-id="session-1"]'))`);
    await evaluate(`document.querySelector('[data-session-id="session-1"]').click()`);
    await waitFor(`Boolean(document.querySelector(".message-selection-summary"))`);
    await evaluate(`document.querySelector(".message-selection-summary").click()`);
    await waitFor(`Boolean(document.querySelector("#load-latest-messages"))`);
    await evaluate(`
    window.failNextLoad = ${!abortLoad};
    window.trackNextLoad = ${abortLoad};
    document.querySelector("#prompt-input").value = "Run this action once";
    document.querySelector("#composer").requestSubmit();
  `);
    if (abortLoad) {
      await waitFor(`window.latestLoadStarted === true`);
      await command("Page.reload", {}, sessionId);
    } else {
      await waitFor(`document.querySelector("#messages").textContent.includes("History temporarily unavailable") &&
      document.querySelector("#send-prompt").disabled === false`);
      assert.equal(await evaluate(`sessionStorage.getItem("copilot-web-pending-sends")`), null);
      await evaluate(`document.querySelector("#composer").requestSubmit()`);
    }
    await waitFor(`document.querySelector("#messages")?.textContent.includes("Done.") &&
    sessionStorage.getItem("copilot-web-pending-sends") === null`);
    await evaluate(`window.beforeRetryRefresh = true`);
    await command("Page.reload", {}, sessionId);
    await waitFor(`!window.beforeRetryRefresh &&
    document.querySelector("#messages")?.textContent.includes("Run this action once") &&
    document.querySelector("#messages").getAttribute("aria-busy") === "false"`);
    assert.equal((await server.requests()).filter((request) => request.text === "Run this action once").length, 1);
    assert.deepEqual(await evaluate(`window.testBrowserErrors`), []);
  });
}

test("retains every loaded history page beyond the former transcript byte limit", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: {
      events: longConversationEvents(20, "word ".repeat(24_000)),
      readDelayMs: 30
    }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("word word") &&
    !document.querySelector("#send-prompt").disabled`);
  assert.equal(await evaluate(`document.querySelectorAll("#messages > .message").length >= 1`), true);
  assert.equal(await evaluate(`document.querySelector("#load-older-messages") === null`), true);
  assert.equal(await evaluate(`document.querySelectorAll("#messages > .message").length`), 1);
  let loadedMessages = 1;
  while (loadedMessages < 20) {
    await scrollUpAndWaitForHistory(evaluate, waitFor);
    loadedMessages = Number(await evaluate(`document.querySelectorAll("#messages > .message").length`));
    assert.ok(loadedMessages <= 20);
  }
  assert.equal(await evaluate(`Boolean(document.querySelector(
    '[data-message-key="native:user:paged-0"]'
  ))`), true);
  assert.equal(await evaluate(`Boolean(document.querySelector(
    '[data-message-key="native:assistant:paged-19"]'
  ))`), true);
  assert.equal(await evaluate(`document.querySelector("#messages .transcript-spacer") === null`), true);
  assert.equal((await server.requests()).some((request) => request.method === "session/prompt"), false);
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});

test("merges live output received while a paged history snapshot is loading", async (t) => {
  const events = longConversationEvents(80);
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    promptDelayMs: 600,
    nativeHistory: { events, readDelayMs: 700 }
  });
  const loading = server.post("load", { historyPaging: true });
  const deadline = Date.now() + 5_000;
  while (!(await server.historyReads()).some((read) => (
    isRecord(read) && read.sessionId === server.sessionId
  ))) {
    assert.ok(Date.now() < deadline, "The paged snapshot did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const text = "stream-progress";
  assert.equal((await server.post("messages", { text, clientPromptId: "during-page" })).status, 200);
  const response = await loading;
  assert.equal(response.status, 200);
  const loaded: unknown = await response.json();
  assert.ok(isRecord(loaded) && Array.isArray(loaded.nativeMessages) &&
    Array.isArray(loaded.liveNativeMessages) && Array.isArray(loaded.replayUpdates) &&
    Array.isArray(loaded.liveReplayUpdates), JSON.stringify({
      keys: isRecord(loaded) ? Object.keys(loaded) : [],
      liveNative: isRecord(loaded) && Array.isArray(loaded.liveNativeMessages)
        ? loaded.liveNativeMessages.length : null,
      replay: isRecord(loaded) && Array.isArray(loaded.replayUpdates)
        ? loaded.replayUpdates.length : null,
      reads: (await server.historyReads()).length,
      prompts: (await server.requests()).filter((request) => request.method === "session/prompt").length
    }));
  assert.equal(loaded.nativeMessages.length, 20);
  assert.equal(loaded.nativeMessages.filter(isRecord).at(-1)?.messageId, "paged-79");
  assert.deepEqual(loaded.liveNativeMessages.filter(isRecord).map((message) => [
    message.role, message.content, message.completion, message.clientPromptId
  ]), [
    ["user", text, "completed", "during-page"],
    ["assistant", "Done.", "completed", "during-page"]
  ]);
  const replayUpdates = [...loaded.replayUpdates, ...loaded.liveReplayUpdates];
  assert.ok(replayUpdates.some((entry) =>
    isRecord(entry) && isRecord(entry.update) &&
    entry.update.sessionUpdate === "agent_thought_chunk"));
  assert.ok(replayUpdates.some((entry) =>
    isRecord(entry) && isRecord(entry.update) &&
    entry.update.toolCallId === "live-history-inspection" &&
    entry.update.status === "completed"));
  assert.equal((await server.requests()).filter((request) => request.method === "session/load").length, 1);
});

test("shows the latest text after restart when recent history contains only tool rounds", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const events: JsonObject[] = [
    nativeTranscriptEvent("user.message", "visible-user", "The latest question is visible", 0),
    nativeTranscriptEvent("assistant.message", "visible-assistant", "The latest answer is visible", 1),
    ...Array.from({ length: 400 }, (_, index) => ({
      id: `recent-tool-${index}`,
      type: "tool.execution_complete",
      timestamp: new Date(Date.UTC(2026, 9, 20, 1, index)).toISOString(),
      data: {
        toolCallId: `recent-tool-call-${index}`,
        toolTitle: `Recent activity ${index}`,
        success: true,
        result: { detailedContent: `Recent persisted tool result ${index}` }
      }
    }))
  ];
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events, pageSize: 20 }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`
    document.querySelector("#messages").textContent.includes("The latest question is visible") &&
    document.querySelector("#messages").textContent.includes("The latest answer is visible") &&
    !document.querySelector("#send-prompt").disabled
  `);
  assert.equal(await evaluate(`document.querySelectorAll(".message.user").length`), 1);
  assert.equal(await evaluate(`document.querySelectorAll(".message.assistant").length`), 1);
  assert.ok((await server.historyReads()).filter((request) => (
    isRecord(request) && request.sessionId === server.sessionId
  )).length > 8, "The restart hydration must continue behind tool-only pages");
  assert.equal((await server.requests()).filter((request) => request.method === "session/load").length, 1);
  assert.equal((await server.requests()).some((request) => request.method === "session/prompt"), false);
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});

test("preserves live reasoning and tools while the restarted transcript is hydrating", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    promptDelayMs: 1_500,
    nativeHistory: { events: longConversationEvents(80), readDelayMs: 700 }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl, `
    localStorage.setItem("copilot-web-active-session", "session-1");
  `);
  const deadline = Date.now() + 5_000;
  while (!(await server.historyReads()).some((request) => (
    isRecord(request) && request.sessionId === server.sessionId
  ))) {
    assert.ok(Date.now() < deadline, "History restoration did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const prompt = server.post("messages", {
    text: "stream-progress",
    clientPromptId: "restart-live-prompt"
  });
  await waitFor(`
    [...document.querySelectorAll(".thinking-content-text")]
      .some((element) => element.textContent.includes("Live reasoning: checking the request.")) &&
    [...document.querySelectorAll(".tool-activity-item")]
      .some((item) => item.querySelector(".tool-activity-title")?.textContent === "Inspect live history")
  `);
  assert.ok(await evaluate(`document.querySelector("#messages").textContent.includes("stream-progress")`));
  assert.equal((await prompt).status, 200);
  await waitFor(`document.querySelector("#messages").textContent.includes("Done.")`);
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});

test("merges historical reasoning and tool completions across byte-limited page boundaries", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 30_000
}, async (t) => {
  const events: JsonObject[] = [
    nativeTranscriptEvent("user.message", "tool-question", "Inspect the source", 0),
    nativeTranscriptEvent("assistant.message", "tool-reasoning", "", 1, {
      reasoningText: "Recorded reasoning. ".repeat(500),
      toolRequests: [{ toolCallId: "paged-tool", name: "read_file" }]
    }),
    {
      id: "tool-start", type: "tool.execution_start",
      data: { toolCallId: "paged-tool", toolTitle: "Inspect source", arguments: { padding: "x".repeat(40_000) } }
    },
    {
      id: "tool-complete", type: "tool.execution_complete",
      data: { toolCallId: "paged-tool", success: true, result: {
        content: "Short model-facing result",
        detailedContent: "Full tool output. ".repeat(4000)
      } }
    },
    nativeTranscriptEvent("assistant.message", "tool-answer", "Final answer. ".repeat(4000), 2)
  ];
  const server = await startTestServer(t, {
    existingSession: true, nativeMessages: true, nativeHistory: { events, readDelayMs: 30 }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Final answer") &&
    !document.querySelector("#send-prompt").disabled`);
  for (let page = 0; page < 4; page += 1) {
    if (await evaluate(`Boolean(document.querySelector(".tool-activity-detail"))`)) {
      break;
    }
    if (!await scrollUpAndWaitForHistory(evaluate, waitFor)) {
      break;
    }
  }
  await evaluate(`(() => {
    const messages = document.querySelector("#messages");
    messages.scrollTop = 0;
    messages.dispatchEvent(new Event("scroll"));
  })()`);
  await waitFor(`Boolean(document.querySelector(".thinking-content-text")) &&
    document.querySelector(".tool-activity-detail")?.textContent.includes("Full tool output.")`);
  assert.equal(await evaluate(`document.querySelectorAll(".tool-activity-item").length`), 1);
  assert.equal(await evaluate(`document.querySelector(".tool-activity-title").textContent`), "Inspect source");
  assert.equal(await evaluate(`document.querySelector(".tool-activity-status").textContent`), "Completed");
  assert.equal(await evaluate(`document.querySelector(".tool-activity-detail").textContent`),
    "Full tool output. ".repeat(4000).trim());
  assert.equal(await evaluate(`document.querySelector(".thinking-content-text").textContent.split("Recorded reasoning.").length - 1`), 500);
  await evaluate(`(() => {
    const messages = document.querySelector("#messages");
    messages.scrollTop = messages.scrollHeight;
    messages.dispatchEvent(new Event("scroll"));
  })()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Final answer")`);
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});

test("automatically pages past filtered events to show the latest visible messages", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const events = [
    ...longConversationEvents(2),
    ...longConversationEvents(850).map((event, index) => ({
      ...event, id: `child-${index}`, agentId: "subagent"
    }))
  ];
  const server = await startTestServer(t, {
    existingSession: true, nativeMessages: true, nativeHistory: { events }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector('button.session-item[data-session-id="${server.sessionId}"]'))`);
  await evaluate(`document.querySelector('button.session-item[data-session-id="${server.sessionId}"]').click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Stored message 1") &&
    !document.querySelector("#send-prompt").disabled`);
  assert.equal(await evaluate(`document.querySelectorAll("#messages > .message").length`), 2);
  assert.equal(await evaluate(`document.querySelector("#load-older-messages") === null`), true);
  assert.ok((await server.historyReads()).filter((request) => (
    isRecord(request) && request.sessionId === server.sessionId
  )).length > 8, "The initial page must continue behind filtered events");
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});

test("skips empty filtered pages while scrolling without blanking the transcript", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 20_000
}, async (t) => {
  const messages = (prefix: string, count: number): JsonObject[] => (
    Array.from({ length: count }, (_, index) => nativeTranscriptEvent(
      index % 2 === 0 ? "user.message" : "assistant.message",
      `${prefix}-${index}`,
      `${prefix} ${index}`,
      index
    ))
  );
  const filtered: JsonObject[] = Array.from({ length: 850 }, (_, index) => ({
    id: `filtered-${index}`,
    agentId: "subagent",
    type: "assistant.message",
    data: { messageId: `filtered-message-${index}`, content: `Hidden ${index}` }
  }));
  const events = [...messages("Older page", 20), ...filtered, ...messages("Latest page", 20)];
  const server = await startTestServer(t, {
    existingSession: true,
    nativeMessages: true,
    nativeHistory: { events }
  });
  const { evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
  await waitFor(`Boolean(document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ))`);
  await evaluate(`document.querySelector(
    'button.session-item[data-session-id="${server.sessionId}"]'
  ).click()`);
  await waitFor(`document.querySelector("#messages").textContent.includes("Latest page 19") &&
    !document.querySelector("#send-prompt").disabled`);
  await scrollUpAndWaitForHistory(evaluate, waitFor);
  await waitFor(`document.querySelector("#messages").textContent.includes("Older page 19")`);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("Latest page 19")`), true);
  assert.equal(await evaluate(`document.querySelector("#messages").textContent.includes("Hidden 0")`), false);
  assert.equal(await evaluate(`document.querySelectorAll("#messages > .message").length >= 30`), true);
  assert.equal(await evaluate(`document.querySelector("#messages .transcript-spacer") === null`), true);
  assert.equal(await evaluate(`window.testBrowserErrors.length`), 0);
});
