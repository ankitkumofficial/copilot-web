# Copilot Web

`copilot-web` is a small localhost browser interface for the locally installed
GitHub Copilot CLI. It starts Copilot in Agent Client Protocol (ACP) mode and
keeps the model, tools, authentication, and workspace local.

## Supported features

- Start a new conversation from the browser.
- Start new conversations in `~/projects` by default.
- List all conversations exposed by Copilot ACP, including sessions from other
  workspaces.
- Show each conversation's title, last activity, and working or queued status.
- Rename conversations from the browser; custom titles are stored locally and
  survive browser and server restarts.
- Select an existing conversation and resume it with its full history replayed
  into the browser.
- Switch between conversations while another conversation is working; each
  conversation keeps its own transcript, prompt queue, draft, attachments,
  cancellation state, streamed activities, and usage.
- Recover an in-progress prompt after a browser refresh and continue showing
  its streamed result.
- Send prompts and receive streamed Copilot responses.
- Send another prompt while Copilot is working to interrupt the active turn;
  the new prompt is submitted as soon as cancellation completes.
- Queue multiple prompts while an interruption is in progress; they are sent
  sequentially.
- Show cumulative conversation AI-credit usage when the Copilot CLI exposes it
  through ACP.
- Show Copilot reasoning text when the ACP stream exposes thought chunks.
- Display tool activity while Copilot works.
- Approve or reject Copilot tool permission requests from the browser.
- Cancel an in-progress prompt.
- Switch the active model when Copilot exposes model choices.
- Select the available reasoning effort levels.
- Choose between the standard and long context tiers.
- Attach images or PDF files to prompts by pasting, dragging and dropping, or
  using the attachment picker.
- Render common Markdown formatting in assistant messages, including emphasis,
  headings, lists, links, inline code, code blocks, and quotes.
- Use a light or dark theme, defaulting to the browser/system theme.
- Scroll conversation history independently from the chat area.
- Collapse or expand the conversation sidebar; its state is remembered in the
  browser.

New sessions use `~/projects` as their starting directory. Copilot can then
navigate to repositories below that directory when prompted. Resumed sessions
use the working directory recorded with the original session.

New browser conversations inherit the Copilot CLI defaults from
`~/.copilot/settings.json`: `model`, `contextTier`, and `effortLevel`. The
backend applies those values to the ACP session before the first prompt, so
Copilot does not silently route the first turn to another model. The model and
reasoning controls use the options advertised by the installed Copilot CLI.
Context size is implemented with Copilot's `default` and `long_context` process
profiles. Switching context for an existing conversation reloads it through
the selected local profile.

The theme control cycles through **System**, **Light**, and **Dark**. System
follows the browser's `prefers-color-scheme` setting; an explicit light or dark
choice is stored in the browser until System is selected again.

## Requirements

- Node.js 24 or newer
- GitHub Copilot CLI 1.0.87 or newer
- A completed `copilot login`
- A `~/projects` directory containing the repositories to work with

## Running

```shell
npm install
npm run build
npm start
```

Open the URL printed by the server, normally:

```text
http://127.0.0.1:8765
```

New browser conversations start in `~/projects`. Existing ACP sessions are
listed across all workspaces visible to the current Copilot CLI account and are
loaded using their recorded working directory.

Custom conversation titles are stored in
`~/.copilot-web/session-titles.json`. Cumulative conversation AI-credit usage is
stored in `~/.copilot-web/session-usage.json`. These are web-interface
metadata and do not modify the underlying Copilot session transcript.

The server binds to loopback only and does not enable `--allow-all`,
`--allow-all-paths`, or `--allow-all-urls`. Tool permission requests are
forwarded to the browser and must be answered there.

To launch the local Copilot process with the equivalent of
`copilot --allow-all`, opt in when starting the web server:

```shell
COPILOT_ALLOW_ALL=true npm start
```

This disables tool, path, and URL permission prompts for the Copilot child
process. Keep the server bound to loopback and do not use this mode for a
shared or untrusted environment.

Set `COPILOT_WEB_USER` when starting the server to include your name in the
browser title and application branding:

```shell
COPILOT_WEB_USER=YourName npm start
```

This displays `YourName's Copilot Web` and uses `Y` as the brand mark. If
`COPILOT_WEB_USER` is unset or empty, the interface uses `Copilot Web` and the
brand mark uses `C`.

## Current limitations

- This is a single-user local interface. It is not intended to be exposed to
  a network or used as a multi-user service.
- The workspace is Copilot's default context and working directory, not an
  absolute security boundary. Copilot may access other paths when explicitly
  permitted by the CLI.
- Session deletion requires either ACP `session/delete` support or the native
  Copilot CLI deletion fallback. The fallback uses the installed Copilot SDK
  deletion RPC and falls back to `/session delete <id> --yes --local-only`.
- A browser session is authenticated with a local, HttpOnly cookie issued by
  the server. Start the server locally and do not share that cookie or expose
  the port beyond loopback.
- Only the selected conversation's composer and settings are shown in the main
  panel. Background conversations continue processing and show a working or
  queued indicator in the sidebar.
- Prompt attachments are limited to images and PDFs, with an 8 MB per-file and
  16 MB per-message total size limit.
- Long-running prompt turns remain active until Copilot completes, the user
  cancels them, or a new prompt requests an interruption; they are not cut off
  by the bridge's short request timeout.

## Architecture

The Node.js backend launches `copilot --acp` as a local child process and
translates ACP JSON-RPC messages into a small HTTP/SSE API. The static browser
client consumes that API; Copilot credentials, model calls, file access, shell
commands, MCP servers, and tool execution remain in the local CLI process.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `COPILOT_WEB_USER` | unset | User name used to derive the browser title, sidebar brand, brand mark, and ACP client title |
| `PORT` | `8765` | Local HTTP port |
| `COPILOT_PROJECTS_DIR` | `~/projects` | Starting directory for new conversations |
| `COPILOT_BIN` | `copilot` | Copilot CLI executable |
| `COPILOT_ALLOW_ALL` | `false` | Pass `--allow-all` to the Copilot ACP process |
| `COPILOT_NATIVE_SESSION_DELETE` | `true` | Enable the SDK/native CLI fallback for deleting sessions |
| `COPILOT_SDK_PATH` | auto-discovered | Optional path to the installed Copilot SDK `index.js` |

Session deletion is confirmation-protected in the browser. ACP deletion is
preferred when advertised; otherwise the backend uses Copilot CLI's native
session manager APIs without hiding sessions locally.

## Development checks

```shell
npm run check
npm run build
npm test
```
