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
- Reload a conversation after a CLI crash without duplicating its history or
  showing historical messages as new output.
- Send prompts and receive streamed Copilot responses.
- Send another prompt while Copilot is working to interrupt the active turn;
  the new prompt is submitted as soon as cancellation completes.
- Queue multiple prompts while an interruption is in progress; they are sent
  sequentially.
- Show cumulative conversation AI-credit usage when the Copilot CLI exposes it
  through ACP.
- Keep usage metrics beside the model settings when space permits; selectors
  shrink first, and narrow layouts wrap without overlapping action buttons.
- Show Copilot reasoning text when the ACP stream exposes thought chunks.
- Display tool activity while Copilot works.
- Toggle **Keep awake** using the coffee-cup button immediately before
  **Reconnect tools** in the message bar. It uses the browser's Screen Wake Lock
  API to prevent the display from sleeping and normal display-sleep-triggered
  locking while this tab is visible, without starting a native process or video.
  The button is highlighted while the wake lock is active. It pauses when the
  tab is hidden or the browser releases the lock, and automatically requests a
  new lock when you return to the tab. Request failures are shown below the
  message bar; toggle Off and On to retry a browser-released lock.
  Keep awake defaults to Off until enabled. Your On/Off choice is stored in the
  browser and restored after a page reload, requesting a new wake lock once the
  tab is visible. It remains independent of the selected conversation and
  releases the current lock on navigation or closing the tab.
  Browser request or release failures do not change your saved choice. If On,
  returning to the tab or refreshing retries a failed request.
  It requires a supported browser and HTTPS or localhost; unsupported browsers
  show a disabled button. Manual and company-enforced locks are unaffected.
- Reload MCP connections using **Reconnect tools**, even when Copilot says a
  tool is unavailable without attempting a call, or after refreshing the page.
  This uses the native `/mcp reload` ACP command without restarting the CLI,
  rerunning earlier actions, or clearing your draft.
  Reload and retry controls remain disabled while any conversation has an
  active or queued prompt, including background conversations.
  Server activity is tracked separately from local prompt queues, and delayed
  session or status responses cannot overwrite newer activity notifications.
- Use **Reconnect & retry** after an MCP-related prompt or tool failure to
  reload MCP connections before resubmitting the original text and attachments.
  The action requires an explicit MCP error or connection-failure message;
  tool titles and filenames alone do not qualify. Unidentified failures can
  still be handled with **Reconnect tools**. Retrying reruns the entire prompt
  and may repeat actions that already completed.
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
- Jump to the latest message using the floating down-arrow button that appears
  when you scroll up; new responses keep your reading position until you return
  to the bottom.
- Collapse or expand the conversation sidebar; its state is remembered in the
  browser.

New sessions use `~/projects` as their starting directory. Copilot can then
navigate to repositories below that directory when prompted. Resumed sessions
use the working directory recorded with the original session.

Every click on **New conversation** reloads the Copilot CLI defaults from
`$COPILOT_HOME/settings.json` (default: `~/.copilot/settings.json`): `model`,
`contextTier`, and `effortLevel`. Browser settings from the previous
conversation do not carry over. The backend applies these defaults to the ACP
session before the first prompt. After starting a conversation, changes to
model, context, or reasoning apply to its next prompt.
The model and reasoning controls use the options advertised by the installed
Copilot CLI. Changing the model refreshes the available reasoning options using
the selected context profile; an unsupported reasoning default falls back to
the value advertised for that model. Context is passed explicitly to the CLI
as `--context default` or `--context long_context`. Each model/context profile
uses a separate reusable ACP process, with the model also passed as `--model`.
Changing model or context reloads the conversation through the selected profile,
preserving its history and compatible reasoning preference. Profile changes and
prompts are serialized per conversation, while cancellation and permission
responses remain available. Before the first prompt, changing profiles recreates
the empty native session and updates its ID without losing the browser draft
or attachments. This avoids ACP's
model-setting RPC resetting the context tier, including when the model has not
changed. The context meter shows the actual size reported by ACP after a prompt,
not an inferred size from the selected tier. This can differ from the CLI's
full-window display: with CLI 1.0.95, Opus 5.5's 1M long-context window is reported
as 968K by ACP. See
https://github.com/github/copilot-cli/issues/4275 for the upstream ACP issue.

The theme control cycles through **System**, **Light**, and **Dark**. System
follows the browser's `prefers-color-scheme` setting; an explicit light or dark
choice is stored in the browser until System is selected again.

## Requirements

- Node.js 24 or newer
- GitHub Copilot CLI 1.0.95 or newer (required for ACP context startup/resume)
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

New browser conversations stay out of session history until the first message is
sent; the Copilot session then starts in `~/projects`. Existing ACP sessions are
listed across all workspaces visible to the current Copilot CLI account and are
loaded using their recorded working directory.

Custom conversation titles are stored in
`~/.copilot-web/session-titles.json`. Cumulative conversation AI-credit usage is
stored in `~/.copilot-web/session-usage.json`, and last-activity timestamps used
for sidebar ordering are stored in `~/.copilot-web/session-activity.json`.
These are web-interface metadata and do not modify the underlying Copilot
session transcript. Selecting or loading a conversation does not update its
last-activity timestamp. Writes to each metadata file are serialized and replace
the file atomically; graceful shutdown waits for pending writes. Deleting a
conversation also removes its metadata, and the API reports any metadata
cleanup failures to the browser. These guarantees apply within one server
process. Multiple server processes using the same home directory are not
coordinated, so run only one instance at a time.

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
- MCP reloads are exclusive across conversations because ACP connections may
  be shared. The server rejects reloads while any prompt is active and rejects
  new prompts during a reload, including manually submitted `/mcp reload`
  commands.
- Prompt attachments are limited to images and PDFs, with an 8 MB per-file and
  16 MB per-message total size limit.
- Long-running prompt turns remain active until Copilot completes, the user
  cancels them, or a new prompt requests an interruption; they are not cut off
  by the bridge's short request timeout.
- Tool recovery requires the CLI to advertise the native `/mcp` command through
  ACP. Recovery waits up to five seconds for delayed command metadata and
  reports an explicit timeout if it never arrives. Cancelling during that wait
  prevents the reload and prompt retry. It reloads configured MCP servers but
  does not guarantee that every server reconnects successfully or permanently
  fix upstream lifecycle bugs.
  Verify recovery with a fresh tool call; a cached status is not sufficient.

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
| `COPILOT_HOME` | `~/.copilot` | Copilot CLI configuration directory; used to read `settings.json` |
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
