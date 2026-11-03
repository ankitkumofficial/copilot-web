import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";

import { isRecord, type JsonObject } from "./acp.js";
import {
  maximumTerminalInputBytes,
  normalizeTerminalSize,
  Terminal,
  TerminalError,
  TerminalManager,
  terminalProtocol,
  type TerminalClient
} from "./terminal.js";
import { vendorFileContentType, type TerminalRuntime } from "./terminal-runtime.js";

const cookieName = "copilot_web_token";
const idPattern = "[0-9a-f-]{36}";
const socketPath = new RegExp(`^/api/terminals/(${idPattern})/socket$`);
const terminalPath = new RegExp(`^/api/terminals/(${idPattern})(/restart)?$`);
const pingIntervalMs = 20_000;
const maximumMissedPongs = 2;
const maximumSocketPayloadBytes = 1024 * 1024;
const openState = 1;

export interface TerminalHttpOptions {
  runtime: TerminalRuntime;
  manager: TerminalManager;
  port: number;
  projectsDirectory: string;
  browserToken: string;
  readJsonBody: (request: IncomingMessage) => Promise<JsonObject>;
}

export interface TerminalHttp {
  handleApi(request: IncomingMessage, response: ServerResponse, requestUrl: URL): Promise<boolean>;
  serveVendorFile(request: IncomingMessage, response: ServerResponse, requestUrl: URL): Promise<boolean>;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

export function sameToken(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function parseMessage(text: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && typeof parsed.t === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rawToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

export function createTerminalHttp(options: TerminalHttpOptions): TerminalHttp {
  const { manager, port } = options;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const webSocketServer = new options.runtime.WebSocketServer({
    noServer: true,
    maxPayload: maximumSocketPayloadBytes,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(terminalProtocol) ? terminalProtocol : false)
  });

  // Browsers do not apply CORS to WebSockets, so the Origin check is what stops cross-site socket hijacking.
  function checkRequest(request: IncomingMessage, requireOrigin: boolean): void {
    if (!allowedHosts.has(request.headers.host ?? "")) {
      throw new TerminalError(403, "Requests must use the local Copilot Web address", "forbidden_host");
    }
    const origin = request.headers.origin;
    if (origin === undefined ? requireOrigin : !allowedOrigins.has(origin)) {
      throw new TerminalError(403, "Requests must come from Copilot Web", "forbidden_origin");
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite !== undefined && fetchSite !== "same-origin") {
      throw new TerminalError(403, "Requests must come from Copilot Web", "forbidden_origin");
    }
    const cookie = (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (cookie === undefined || !sameToken(cookie, options.browserToken)) {
      throw new TerminalError(401, "This local API requires the browser session cookie", "unauthorized");
    }
  }

  function attachSocket(socket: WebSocket, terminal: Terminal): void {
    let missedPongs = 0;
    const client: TerminalClient = {
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      send(message) {
        if (socket.readyState === openState) {
          socket.send(message);
        }
      },
      close(code, reason) {
        socket.close(code, reason);
      }
    };
    const protocolError = (message: string): void => {
      client.send(JSON.stringify({ t: "error", code: "protocol_error", message }));
      client.close(4400, message);
    };
    const handleMessage = (text: string): void => {
      const message = parseMessage(text);
      if (!message) {
        protocolError("Messages must be JSON objects with a type");
        return;
      }
      switch (message.t) {
        case "in":
          if (typeof message.d !== "string" || Buffer.byteLength(message.d) > maximumTerminalInputBytes) {
            protocolError("Input is invalid or too large");
            return;
          }
          terminal.input(message.d);
          return;
        case "resize":
          try {
            const size = normalizeTerminalSize(message.cols, message.rows);
            terminal.resize(size.cols, size.rows, client);
          } catch {
            protocolError("Terminal size is invalid");
          }
          return;
        case "pause":
          terminal.setClientPaused(client, true);
          return;
        case "resume":
          terminal.setClientPaused(client, false);
          return;
        case "ping":
          client.send(JSON.stringify({ t: "pong" }));
          return;
        default:
          protocolError("Unknown message type");
      }
    };

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => handleMessage(rawToString(data)));
    socket.on("pong", () => {
      missedPongs = 0;
    });
    // The close event that follows reports the failure; the listener only prevents an unhandled error.
    socket.on("error", () => undefined);
    const heartbeat = setInterval(() => {
      if (missedPongs >= maximumMissedPongs) {
        socket.terminate();
        return;
      }
      missedPongs += 1;
      socket.ping();
    }, pingIntervalMs);
    socket.on("close", () => {
      clearInterval(heartbeat);
      terminal.detach(client);
    });
    terminal.attach(client);
  }

  return {
    async handleApi(request, response, requestUrl) {
      const pathname = requestUrl.pathname;
      try {
        checkRequest(request, false);
        if (request.method === "GET" && pathname === "/api/terminals") {
          jsonResponse(response, 200, {
            terminals: manager.list(),
            limits: { max: manager.maximumTerminals }
          });
          return true;
        }
        if (request.method === "POST" && pathname === "/api/terminals") {
          const body = await options.readJsonBody(request);
          const info = await manager.create({
            cwd: body.cwd === undefined ? options.projectsDirectory : body.cwd,
            cols: body.cols,
            rows: body.rows
          });
          jsonResponse(response, 201, info);
          return true;
        }
        const match = terminalPath.exec(pathname);
        const id = match?.[1];
        if (id && request.method === "DELETE" && !match?.[2]) {
          manager.remove(id);
          response.statusCode = 204;
          response.end();
          return true;
        }
        if (id && request.method === "POST" && match?.[2]) {
          jsonResponse(response, 200, manager.restart(id));
          return true;
        }
        throw new TerminalError(404, "Terminal route not found", "terminal_route_not_found");
      } catch (error) {
        if (error instanceof TerminalError) {
          jsonResponse(response, error.status, { error: error.message, code: error.code });
          return true;
        }
        throw error;
      }
    },

    async serveVendorFile(request, response, requestUrl) {
      const file = options.runtime.vendorFiles.get(requestUrl.pathname);
      if (!file || (request.method !== "GET" && request.method !== "HEAD")) {
        return false;
      }
      const content = await readFile(file);
      response.statusCode = 200;
      response.setHeader("Content-Type", vendorFileContentType(file));
      response.setHeader("Cache-Control", "no-store");
      if (request.method === "HEAD") {
        response.end();
      } else {
        response.end(content);
      }
      return true;
    },

    handleUpgrade(request, socket, head) {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const id = socketPath.exec(requestUrl.pathname)?.[1];
      if (!id) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      try {
        checkRequest(request, true);
      } catch (error) {
        const status = error instanceof TerminalError ? error.status : 403;
        rejectUpgrade(socket, status, status === 401 ? "Unauthorized" : "Forbidden");
        return;
      }
      const terminal = manager.find(id);
      if (!terminal) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      const requested = String(request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((protocol) => protocol.trim());
      if (!requested.includes(terminalProtocol)) {
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (client) => attachSocket(client, terminal));
    },

    close() {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      webSocketServer.close();
    }
  };
}
