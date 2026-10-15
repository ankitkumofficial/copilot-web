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
const nativeMessages = process.env.TEST_NATIVE_MESSAGES === "true";
const nativeHistoryPath = path.join(process.cwd(), "native-history.json");
const nativeTimestamp = process.env.TEST_NATIVE_TIMESTAMP ?? "2026-10-14T10:00:00.000Z";
const pendingNativePrompts = new Map();
let streamThoughts = true;
const sessionFile = (id) => path.join(process.cwd(), "profile-session-" + id + ".json");
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
      return [{
        type: "blob",
        displayName: "prompt-document.pdf",
        mimeType: block.resource.mimeType,
        data: block.resource.blob
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
      if (nativeMessages) {
        replayNativeHistoryThroughAcp(request.params.sessionId, update);
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
        : "Done.";
      // Like the CLI, commands such as /mcp reload record and emit no native messages.
      const nativeEvents = nativeMessages && !reload
        ? emitNativePrompt(request, request.params.sessionId, reply)
        : null;
      if (request.params.prompt[0]?.text === "stream-progress") {
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
      } else if (request.params.prompt[0]?.text === "interleaved-rounds") {
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
        setTimeout(() => {
          tool("round-one-tool", "Inspect code", "completed");
          if (nativeMessages) {
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
          tool("round-two-tool", "Run tests", "in_progress");
        }, 300);
        setTimeout(() => tool("round-two-tool", "Run tests", "completed"), 700);
      }
      const delay = reload
        ? Number(process.env.TEST_MCP_RELOAD_DELAY_MS ?? 200)
        : Number(process.env.TEST_PROMPT_DELAY_MS ?? 20);
      const timer = setTimeout(() => {
        pendingNativePrompts.delete(request.params.sessionId);
        if (nativeEvents) {
          emitNativeEvent(request.params.sessionId, nativeEvents.delta);
          // A repeated final event must stay idempotent.
          emitNativeEvent(request.params.sessionId, nativeEvents.final, true, true);
        }
        update(request.params.sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reply }
        });
        respond({ stopReason: "end_turn" });
      }, delay);
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
        readPersistedEvents: async ({ sessionId, cursor }) => {
          const requestPath = path.join(options.workingDirectory, "native-history-requests.jsonl");
          appendFileSync(requestPath, JSON.stringify({ sessionId, cursor }) + "\\n");
          if (process.env.TEST_HISTORY_UNSUPPORTED === "true") {
            const error = new Error("Method not found: sessions.readPersistedEvents");
            error.code = -32601;
            throw error;
          }
          if (sessionId === "session-1" && process.env.TEST_HISTORY_READ_ERROR === "true") {
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
          const offset = cursor === undefined ? 0 : Number(cursor);
          if (cursor !== undefined && process.env.TEST_HISTORY_CURSOR_EXPIRED === "true") {
            return { events: [], cursor: "", cursorStatus: "expired", hasMore: false };
          }
          const pageSize = Number(process.env.TEST_HISTORY_PAGE_SIZE ?? 200);
          const pageEvents = events.slice(offset, offset + pageSize);
          const nextOffset = offset + pageEvents.length;
          const hasMore = nextOffset < events.length;
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
  nativeMessages?: boolean;
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
  const port = await unusedPort();
  await mkdir(home);
  await mkdir(projects);
  await mkdir(copilotHome);
  await writeFile(fakeCommand, fakeCopilot);
  await chmod(fakeCommand, 0o700);
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
      COPILOT_ALLOW_ALL: "false",
      COPILOT_SDK_PATH: options.nativeHistory
        ? path.join(copilotSdk, "index.js")
        : "",
      COPILOT_NATIVE_SESSION_DELETE: "false",
      TEST_MCP_COMMAND: String(options.advertiseMcp ?? true),
      TEST_MCP_RELOAD_ERROR: String(options.failReload ?? false),
      TEST_COMMAND_DELAY_MS: String(options.commandDelayMs ?? 0),
      TEST_COMMAND_METADATA: options.missingCommandMetadata ? "missing" : "available",
      TEST_LOAD_DELAY_MS: String(options.loadDelayMs ?? 0),
      TEST_FAIL_RECOVERY_LOADS: String(options.failRecoveryLoads ?? false),
      TEST_PROFILE_SESSIONS: String(options.profileSessions ?? false),
      TEST_NATIVE_MESSAGES: String(options.nativeMessages ?? false),
      TEST_NATIVE_TIMESTAMP: options.nativeHistory?.timestamp ?? "2026-10-14T10:00:00.000Z",
      TEST_HISTORY_PAGE_SIZE: String(options.nativeHistory?.pageSize ?? 200),
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
    copilotSettings: (settings: JsonObject) => writeFile(
      path.join(copilotHome, "settings.json"),
      JSON.stringify(settings)
    ),
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
    sdkConnection: () => readFile(path.join(projects, "native-sdk-connection.json"), "utf8")
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
  const response = await server.post("messages", {
    text,
    attachments: [
      { name: "image.png", mimeType: "image/png", data: imageData },
      { name: "document.pdf", mimeType: "application/pdf", data: pdfData }
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
    await evaluate(`new Date(${JSON.stringify(historicalUserTimestamp)}).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    })`)
  );
  assert.equal(
    await evaluate(`${timestamps}[0].dateTime`),
    historicalTimestamp
  );
  assert.equal(
    await evaluate(`${timestamps}[0].textContent`),
    await evaluate(`new Date(${JSON.stringify(historicalTimestamp)}).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    })`)
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
    `Today, ${String(todayLocalTime)}`
  );
  const todayUserTime = await evaluate(`new Date(${JSON.stringify(todayTimestamp)})
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })`);
  assert.equal(await evaluate(`${userTimestamps}[1].dateTime`), todayTimestamp);
  assert.equal(
    await evaluate(`${userTimestamps}[1].textContent`),
    `Today, ${String(todayUserTime)}`
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

test("streams reasoning and activities in real time, grouped between visible messages", {
  skip: existsSync(chromePath) ? false : "Chrome is not installed; set CHROME_BIN to run browser tests",
  timeout: 60_000
}, async (t) => {
  for (const nativeMessages of [true, false]) {
    await t.test(nativeMessages ? "native message history" : "ACP-only history", async (t) => {
      const server = await startTestServer(t, {
        nativeMessages,
        ...(nativeMessages ? { nativeHistory: { events: [] } } : {}),
        promptDelayMs: 1_500
      });
      const { command, sessionId, evaluate, waitFor } = await startTestBrowser(t, server.baseUrl);
      await waitFor(`Boolean(document.querySelector(
        'button.session-item[data-session-id="${server.sessionId}"]'
      ))`);
      await evaluate(`document.querySelector(
        'button.session-item[data-session-id="${server.sessionId}"]'
      ).click()`);
      await waitFor(`!document.querySelector("#send-prompt").disabled`);
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

      // A visible response closes the first Thinking panel; later reasoning starts a new one.
      await waitFor(`JSON.stringify(${conversationLayout}) === JSON.stringify([
        ["user", "interleaved-rounds"],
        ["tool", "Round one: inspect the code.", ["Inspect code:Completed"]],
        ["assistant", "Intermediate update."],
        ["tool", "Round two: run the tests.", ["Run tests:Completed"]]
      ])`);

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
  const server = await startTestServer(t, { profileSessions: true });
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
    ["0.13 used", "36.8K / 872K tokens"],
    ["144.04 used", "153.5K / 968K tokens"]
  ]) {
    await evaluate(`
      document.querySelector('#usage-aic').textContent = ${JSON.stringify(aic)};
      document.querySelector('#usage-context').textContent = ${JSON.stringify(context)};
    `);
    assert.equal(await evaluate(`(() => {
      const usage = document.querySelector('#usage-summary').getBoundingClientRect();
      const settings = [...document.querySelectorAll('.composer-setting')]
        .map((element) => element.getBoundingClientRect());
      return settings.every((box) => Math.abs(box.bottom - usage.bottom) < 1) &&
        usage.left >= settings[2].right;
    })()`), true, `Usage should stay inline with ${aic} and ${context}`);
    assert.equal(await evaluate(labelsFit), true, `Selector labels should fit with ${aic} and ${context}`);
    assert.equal(await evaluate(noOverlap), true);
  }
  for (const width of [1200, 1000, 801, 768, 390, 320]) {
    await command("Emulation.setDeviceMetricsOverride", {
      width, height: 900, deviceScaleFactor: 1, mobile: false
    }, sessionId);
    assert.equal(await evaluate(labelsFit), true, `Selector labels should fit at ${width}px`);
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

  await evaluate(`
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
    })();
  `);
  assert.equal(await evaluate(`document.querySelector("#ask-selection").hidden`), true);
  await evaluate(`document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))`);
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
        latest?.querySelector(".message-selection-summary")?.textContent === "2 selections";
    })()
  `);
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
