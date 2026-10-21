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
- Select an existing conversation and load its latest messages, fetching older
  history automatically when scrolling upward.
- Bound history pages by both message count and bytes while retaining loaded
  transcript pages and drafts as you switch conversations.
- Show each completed user message and Copilot reply's recorded date and time
  in the browser's local timezone, using **Today, 1:18 PM** for messages from
  today and the date for older messages; the tooltip gives the full date and
  time. Interrupted or otherwise untimestamped messages show no timestamp.
- Switch between conversations while another conversation is working; each
  conversation keeps its own transcript, prompt queue, draft, attachments,
  selected passages, cancellation state, streamed activities, and usage.
- Recover an in-progress prompt after a browser refresh and continue showing
  its streamed result.
- Reload a conversation after a CLI crash without duplicating its history or
  showing historical messages as new output.
- Send prompts and receive streamed Copilot responses.
- Compose rich-text prompts: preserve bold, italics, lists, and code when
  pasting from web pages or Markdown, and format Markdown as you type.
  **Enter** sends; **Shift+Enter** adds a line or list item, **Tab** /
  **Shift+Tab** nest or unnest list items, and **Ctrl/Cmd+Z** undoes edits.
  Prompts are sent as Markdown and retain their formatting in conversation
  history, including after a page reload. Literal Markdown characters in rich
  text are escaped on send so they do not become unintended formatting.
- Select text in a user or Copilot message and choose **Ask Copilot** to attach
  it as a numbered selection card; add multiple selections to one follow-up.
  Composer cards and sent-message selection chips return to their source and
  briefly highlight the selected text; sent-message formatting is restored
  after a browser refresh. This formatting is stored in browser storage, capped
  to recent entries, and pruned when a conversation no longer exists.
- Dictate into the message composer with the microphone button; interim speech
  appears as text while recording, and the cross button stops recording while
  keeping the draft. This requires browser speech-recognition support and
  microphone permission in a secure context (HTTPS or localhost).
- Send another prompt while Copilot is working to interrupt the active turn;
  the new prompt is submitted as soon as cancellation completes.
- Queue multiple prompts while an interruption is in progress; they are sent
  sequentially.
- Show cumulative conversation AI-credit usage when the Copilot CLI exposes it
  through ACP.
- Size the Model, Context, and Reasoning selectors to fit their longest option,
  so selected names are never truncated. Usage metrics stay beside them when
  space permits and wrap below them otherwise, without overlapping action
  buttons.
- Show Copilot reasoning text when the ACP stream or persisted history exposes it.
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
  The reload control remains disabled while any conversation has an
  active or queued prompt, including background conversations.
  Server activity is tracked separately from local prompt queues, and delayed
  session or status responses cannot overwrite newer activity notifications.
- Approve or reject Copilot tool permission requests from the browser.
- Cancel an in-progress prompt.
- Switch the active model when Copilot exposes model choices.
- Select the available reasoning effort levels.
- Choose between the standard and long context tiers.
- Attach files of any type to prompts by pasting, dragging and dropping, or
  using the attachment picker.
- Render common Markdown formatting in user and assistant messages, including
  emphasis, headings, lists, links, inline code, code blocks, and quotes.
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
preserving its history and compatible reasoning preference. Each conversation's
last-used context, model, and reasoning are stored in
`~/.copilot-web/session-preferences.json`, so reopening it, including after a
server restart, restores that profile instead of the current selector or
Copilot defaults. Profile changes and
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
- GitHub Copilot CLI 1.0.95 or newer for ACP context startup/resume; native
  message timestamps require the SDK/CLI `sessions.readPersistedEvents` API
  (verified with CLI 1.0.97)
- A completed `copilot login`
- A `~/projects` directory containing the repositories to work with

Recorded user-message and reply timestamps use Copilot's persisted native
message events. The server reads those events through the discovered Copilot
SDK and the normal `copilot` executable;
it does not create, resume, or activate a conversation to read history, rewrite
the transcript, or store timestamps in a separate file. The displayed local
date and time are in a separate `<time>` element, outside the Markdown body and
copied message content. ACP continues to provide tool, reasoning, and
configuration activity.

Persisted-history reading depends on an experimental SDK/CLI API, available in
the tested Copilot CLI 1.0.97 release. If the API is unsupported or a history
read fails, Copilot Web falls back to ACP replay; older ACP-only messages may
not have timestamps. A message without a
recorded event timestamp never receives an inferred or current time. Copilot
does not record command output such as `/mcp reload` (used by **Reconnect
tools**), so it is shown without a timestamp.

### Display history and AI context

History pagination changes only the web transcript, not the native conversation
or the AI request. The bridge still restores the original session through ACP
and sends only the new prompt and attachments to that same session ID. It never
constructs the model's context from the visible messages, truncates the native
journal, or creates a replacement session to evict a display cache. Model,
context-tier, reasoning, cancellation, and permission behavior are unchanged.
Copilot's own context-window limits and compaction still apply independently.

With the backward persisted-history API (verified with CLI 1.0.100), pages
target a 128 KiB persisted-event payload and contain at most 20 displayable
user or assistant messages. Empty assistant events that only request tools and
their tool activity do not consume the message count, so a tool-heavy turn can
span more event records. If the newest bounded page contains only tool activity,
the browser continues through bounded pages until recent chat is available or
it reaches a 32-page scan safety limit. Older turns load as the reader scrolls
upward. The byte budget can stop a page after only one or two
long messages; it is not a fixed 20-message allocation. One indivisible oversized
event is returned alone and intact rather than silently truncating its text or
attachments. Supplemental ACP text/activity and live updates have separate
bounded buffers. These are payload/cache budgets, not hard limits on browser or
CLI RSS.

The browser retains every page it has loaded and renders those messages in one
chronological transcript; it does not evict newer rows or replace them with
estimated-height spacers. Scrolling upward automatically fetches the next
bounded page, preserving the visible message's position. The down-arrow returns
to the latest loaded messages. Jumping to an unloaded selected passage opens
the containing page and offers **Return to latest messages**; sending from
there restores the latest page without changing the session or prompt.

The server retains bounded recent ACP replay and native-message caches rather
than whole replay streams for native-backed conversations. Historical ACP
replay is not broadcast through SSE. Display cursors are bounded and
short-lived; concurrent requests share a native continuation, failed reads can
be retried, and expired cursors can be rebased using the oldest visible native
message ID. Selection links use
stable native message IDs to fetch an unloaded source passage. History-only
requests never activate a session or submit a prompt.

The initial ACP restore still replays history internally because this CLI does
not advertise no-replay resume. Native AI-session state and its lifetime are
deliberately not evicted by the web cache policy. If the persisted-history API
is unavailable or fails, the bridge falls back to a complete ACP replay of the
same native session. If that session is already active, it closes and reloads
the same session before replaying; it does not create a new session or change
the model context. If a complete replay cannot be performed safely, the load
fails explicitly and keeps the previously displayed transcript instead of
showing a truncated cache as complete history.

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
Per-conversation context, model, and reasoning preferences are stored in
`~/.copilot-web/session-preferences.json`.
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
- Voice dictation uses the browser's Web Speech API, not a local speech model.
  Recognition availability and language support depend on the browser, and its
  speech-recognition service may process audio remotely. Dictation stops when
  switching conversations or hiding the tab.
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
- Prompt attachments accept any file type, with a 10-file limit, an 8 MB
  per-file limit, and a 16 MB per-message total size limit. Images require image
  support from the active agent; other file types require embedded-context
  support. Copilot CLI stores non-image attachments as temporary files with
  generated names, so the model does not see the original filename and file
  types without a known extension are saved as `.bin`. Copilot CLI history
  does not keep the contents of non-image attachments, so they are not shown
  again after a conversation is reloaded or the page is refreshed.
- Long-running prompt turns remain active until Copilot completes, the user
  cancels them, or a new prompt requests an interruption; they are not cut off
  by the bridge's short request timeout.
- Native persisted-message history is experimental and depends on the installed
  SDK and Copilot CLI supporting `sessions.readPersistedEvents`. If it is
  unavailable or unreadable, ACP replay remains available, but older messages
  may not have recorded timestamps.
- Paged history reconstructs messages, recorded reasoning, and tool activity
  from the native persisted journal. Small complete histories and compatibility
  fallback also preserve ACP-only output, such as native command replies,
  when it is retained in the recent replay cache.
- When matching complete native and ACP history, native messages are placed beside ACP tool and
  reasoning activity by conversation turn, using the tool-call IDs both sources
  share. If a turn's native and ACP messages cannot be matched exactly, that
  part of the transcript is shown from ACP rather than risking shifted or
  duplicated messages.
- Tool recovery requires the CLI to advertise the native `/mcp` command through
  ACP. Recovery waits up to five seconds for delayed command metadata and
  reports an explicit timeout if it never arrives. Cancelling during that wait
  prevents the reload. It reloads configured MCP servers but
  does not guarantee that every server reconnects successfully or permanently
  fix upstream lifecycle bugs.
  Verify recovery with a fresh tool call; a cached status is not sufficient.

## Architecture

The Node.js backend launches `copilot --acp` as a local child process and
translates ACP JSON-RPC messages into a small HTTP/SSE API. The static browser
client consumes that API; Copilot credentials, model calls, file access, shell
commands, MCP servers, and tool execution remain in the local CLI process.
Native user and assistant messages are sourced from the Copilot event stream
and read-only persisted-event snapshots; ACP remains authoritative for live tools
and configuration activity, with persisted assistant reasoning restored when
available.

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
| `COPILOT_SDK_PATH` | auto-discovered | Optional path to the installed Copilot SDK `index.js`, used for session deletion and persisted-message history |

Session deletion is confirmation-protected in the browser. ACP deletion is
preferred when advertised; otherwise the backend uses Copilot CLI's native
session manager APIs without hiding sessions locally.

## Development checks

```shell
npm run check
npm run build
npm test
```
