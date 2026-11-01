const terminalProtocol = "copilot-web-terminal.v1";
const xtermModuleUrl = "/vendor/xterm/xterm.mjs";
const xtermStylesheetUrl = "/vendor/xterm/xterm.css";
const fitModuleUrl = "/vendor/xterm/addon-fit.mjs";
const linksModuleUrl = "/vendor/xterm/addon-web-links.mjs";
const maximumInputChunkCharacters = 16 * 1024;
const flowPauseAboveCharacters = 512 * 1024;
const flowResumeBelowCharacters = 128 * 1024;
const reconnectMinimumMs = 500;
const reconnectMaximumMs = 5_000;
const fitDelayMs = 50;
const socketOpen = 1;
const socketClosing = 2;
const terminalFontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

const ansiPalettes = {
  dark: {
    black: "#1b1e26", red: "#ff7b72", green: "#7ee787", yellow: "#e3b341",
    blue: "#79c0ff", magenta: "#d2a8ff", cyan: "#56d4dd", white: "#d7dae0",
    brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#a5f3ab", brightYellow: "#f8e3a1",
    brightBlue: "#a5d6ff", brightMagenta: "#e2c5ff", brightCyan: "#89ebf0", brightWhite: "#f0f3f6"
  },
  light: {
    black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
    blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
    brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f"
  }
};

function currentThemeName() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

// Background, foreground, and cursor follow the app's theme tokens; the ANSI colours are per theme.
function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  const dark = currentThemeName() === "dark";
  return {
    background: token("--surface", dark ? "#17191f" : "#ffffff"),
    foreground: token("--text", dark ? "#f1f3f5" : "#1d2230"),
    cursor: token("--accent", dark ? "#8b7cff" : "#6555d8"),
    cursorAccent: token("--surface", dark ? "#17191f" : "#ffffff"),
    selectionBackground: dark ? "rgba(139, 124, 255, 0.35)" : "rgba(101, 85, 216, 0.25)",
    ...ansiPalettes[currentThemeName()]
  };
}

function repositoryName(root) {
  return String(root).split("/").filter(Boolean).at(-1) ?? String(root);
}

function socketUrl(id) {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/api/terminals/${encodeURIComponent(id)}/socket`;
}

function exitDescription(terminal) {
  if (terminal.signal) {
    return `Process ended by signal ${terminal.signal}`;
  }
  return `Process exited with code ${terminal.exitCode ?? 0}`;
}

function describeError(error) {
  if (error?.code === "terminal_limit") {
    return "Close a terminal before opening another one.";
  }
  return error instanceof Error ? error.message : "The terminal request failed.";
}

// Owns the terminal tab in the Repository panel: one xterm for the selected repository and the server-side terminals in it.
export function initTerminalPanel({ api }) {
  const query = (selector) => document.querySelector(selector);
  const el = {
    tabs: query("#terminal-tabs"),
    newButton: query("#terminal-new"),
    notice: query("#terminal-notice"),
    screen: query("#terminal-screen"),
    empty: query("#terminal-empty"),
    emptyText: query("#terminal-empty-text"),
    emptyAction: query("#terminal-empty-action"),
    footer: query("#terminal-footer"),
    footerStatus: query("#terminal-footer-status"),
    restart: query("#terminal-restart"),
    close: query("#terminal-close"),
    closeDialog: query("#terminal-close-dialog"),
    closeTitle: query("#terminal-close-title"),
    closeForm: query("#terminal-close-form"),
    closeConfirm: query("#terminal-close-confirm")
  };
  const s = {
    root: null,
    repository: null,
    defaultDirectory: null,
    // Set only by navigating to the terminal view or the Terminal action, so selecting a repository never attaches one.
    wantsTerminal: false,
    active: false,
    terminals: [],
    activeId: null,
    rememberedByRoot: new Map(),
    creating: false,
    term: null,
    fit: null,
    xtermPromise: null,
    resizeObserver: null,
    themeObserver: null,
    fitTimer: null,
    socket: null,
    socketId: null,
    attachToken: 0,
    applyingRemote: false,
    pending: 0,
    flowPaused: false,
    reconnectTimer: null,
    reconnectAttempt: 0
  };

  function terminalById(id) {
    return s.terminals.find((terminal) => terminal.id === id) ?? null;
  }

  function rootTerminals() {
    return s.root ? s.terminals.filter((terminal) => terminal.cwd === s.root) : [];
  }

  function pickTerminal() {
    const candidates = rootTerminals();
    const remembered = s.rememberedByRoot.get(s.root);
    if (remembered && candidates.some((terminal) => terminal.id === remembered)) {
      return remembered;
    }
    return candidates.at(-1)?.id ?? null;
  }

  function showNotice(text) {
    el.notice.textContent = text ?? "";
    el.notice.hidden = !text;
  }

  function ensureStylesheet() {
    if (!document.querySelector("link[data-terminal-stylesheet]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = xtermStylesheetUrl;
      link.dataset.terminalStylesheet = "";
      document.head.append(link);
    }
  }

  function ensureTerminal() {
    s.xtermPromise ??= (async () => {
      const [xterm, fit, links] = await Promise.all([
        import(xtermModuleUrl),
        import(fitModuleUrl),
        import(linksModuleUrl)
      ]);
      ensureStylesheet();
      const term = new xterm.Terminal({
        fontFamily: terminalFontFamily,
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        scrollback: 10_000,
        macOptionIsMeta: false,
        macOptionClickForcesSelection: true,
        rightClickSelectsWord: true,
        theme: terminalTheme()
      });
      const fitAddon = new fit.FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new links.WebLinksAddon((event, uri) => {
        if (/^https?:\/\//i.test(uri)) {
          window.open(uri, "_blank", "noopener,noreferrer");
        }
      }));
      term.open(el.screen);
      term.onData((data) => sendInput(data));
      term.onResize(({ cols, rows }) => {
        if (!s.applyingRemote) {
          send({ t: "resize", cols, rows });
        }
      });
      s.term = term;
      s.fit = fitAddon;
      s.resizeObserver = new ResizeObserver(() => scheduleFit());
      s.resizeObserver.observe(el.screen);
      s.themeObserver = new MutationObserver(() => {
        term.options.theme = terminalTheme();
      });
      s.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return term;
    })().catch((error) => {
      s.xtermPromise = null;
      throw error;
    });
    return s.xtermPromise;
  }

  function send(message) {
    if (s.socket?.readyState === socketOpen) {
      s.socket.send(JSON.stringify(message));
    }
  }

  function sendInput(data) {
    for (let index = 0; index < data.length; index += maximumInputChunkCharacters) {
      send({ t: "in", d: data.slice(index, index + maximumInputChunkCharacters) });
    }
  }

  function scheduleFit() {
    window.clearTimeout(s.fitTimer);
    s.fitTimer = window.setTimeout(() => {
      if (!s.active || !s.fit || el.screen.clientWidth === 0 || el.screen.clientHeight === 0) {
        return;
      }
      s.fit.fit();
    }, fitDelayMs);
  }

  function closeSocket() {
    const socket = s.socket;
    s.socket = null;
    s.socketId = null;
    s.attachToken += 1;
    window.clearTimeout(s.reconnectTimer);
    if (socket && socket.readyState < socketClosing) {
      socket.close(1000, "View closed");
    }
  }

  function applySnapshot(message, token) {
    const term = s.term;
    s.pending = 0;
    s.flowPaused = false;
    s.reconnectAttempt = 0;
    showNotice("");
    s.applyingRemote = true;
    try {
      term.reset();
      term.resize(message.cols, message.rows);
    } finally {
      s.applyingRemote = false;
    }
    term.write(String(message.data ?? ""), () => {
      if (token === s.attachToken) {
        scheduleFit();
      }
    });
    updateTerminal(s.socketId, {
      state: message.state,
      exitCode: message.exitCode ?? null,
      signal: message.signal ?? null,
      title: message.title
    });
  }

  function writeOutput(data, token) {
    const size = data.length;
    s.pending += size;
    if (!s.flowPaused && s.pending > flowPauseAboveCharacters) {
      s.flowPaused = true;
      send({ t: "pause" });
    }
    s.term.write(data, () => {
      if (token !== s.attachToken) {
        return;
      }
      s.pending -= size;
      if (s.flowPaused && s.pending < flowResumeBelowCharacters) {
        s.flowPaused = false;
        send({ t: "resume" });
      }
    });
  }

  function handleSocketMessage(message, id, token) {
    switch (message.t) {
      case "snapshot":
        applySnapshot(message, token);
        break;
      case "out":
        writeOutput(String(message.d ?? ""), token);
        break;
      case "exit":
        updateTerminal(id, { state: "exited", exitCode: message.code ?? null, signal: message.signal ?? null });
        break;
      case "title":
        updateTerminal(id, { title: message.title });
        break;
      case "resized":
        s.applyingRemote = true;
        try {
          s.term.resize(message.cols, message.rows);
        } finally {
          s.applyingRemote = false;
        }
        break;
      case "error":
        showNotice(String(message.message ?? "The terminal reported an error."));
        break;
      default:
    }
  }

  function handleSocketClosed(id, token, event) {
    if (token !== s.attachToken) {
      return;
    }
    s.socket = null;
    s.socketId = null;
    if (!s.active || id !== s.activeId) {
      return;
    }
    switch (event.code) {
      case 1000:
        return;
      case 4400:
        showNotice("The terminal connection was rejected.");
        return;
      default:
        scheduleReconnect();
    }
  }

  // A terminal that is gone after a reconnect was lost with the server, such as after `cpw restart`.
  function scheduleReconnect() {
    window.clearTimeout(s.reconnectTimer);
    const id = s.activeId;
    const delay = Math.min(reconnectMaximumMs, reconnectMinimumMs * 2 ** s.reconnectAttempt) *
      (0.75 + Math.random() * 0.5);
    s.reconnectAttempt += 1;
    showNotice("Reconnecting…");
    s.reconnectTimer = window.setTimeout(() => {
      refreshList().then(() => {
        if (id && !terminalById(id)) {
          showNotice("This terminal ended because the server restarted. Open a new one to continue.");
        }
      }, () => scheduleReconnect());
    }, delay);
  }

  function attach(id) {
    if (s.socketId === id && s.socket && s.socket.readyState < socketClosing) {
      return;
    }
    closeSocket();
    const token = ++s.attachToken;
    s.socketId = id;
    ensureTerminal().then(() => {
      if (token !== s.attachToken || !s.active) {
        return;
      }
      const socket = new WebSocket(socketUrl(id), terminalProtocol);
      s.socket = socket;
      socket.addEventListener("message", (event) => {
        if (token !== s.attachToken) {
          return;
        }
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        handleSocketMessage(message, id, token);
      });
      socket.addEventListener("close", (event) => handleSocketClosed(id, token, event));
      // The close event that follows reports the failure, so the error listener only prevents an unhandled error.
      socket.addEventListener("error", () => undefined);
    }, (error) => {
      showNotice(describeError(error));
    });
  }

  // Keeps the shown terminal consistent with the list and the selected repository, and connects it when visible.
  function reconcile() {
    const current = s.activeId && rootTerminals().some((terminal) => terminal.id === s.activeId)
      ? s.activeId
      : s.wantsTerminal ? pickTerminal() : null;
    s.activeId = current;
    if (!current) {
      closeSocket();
      showNotice("");
    } else if (s.active) {
      attach(current);
    } else {
      closeSocket();
    }
    render();
  }

  function updateTerminal(id, changes) {
    if (!id) {
      return;
    }
    const existing = terminalById(id);
    if (!existing) {
      return;
    }
    Object.assign(existing, changes);
    render();
  }

  function upsert(info) {
    const index = s.terminals.findIndex((terminal) => terminal.id === info.id);
    if (index >= 0) {
      s.terminals[index] = info;
    } else {
      s.terminals.push(info);
    }
    reconcile();
  }

  function removeTerminal(id) {
    s.terminals = s.terminals.filter((terminal) => terminal.id !== id);
    for (const [root, remembered] of s.rememberedByRoot) {
      if (remembered === id) {
        s.rememberedByRoot.delete(root);
      }
    }
    if (s.activeId === id) {
      s.activeId = null;
      closeSocket();
    }
    reconcile();
  }

  function selectTerminal(id) {
    s.activeId = id;
    if (s.root) {
      s.rememberedByRoot.set(s.root, id);
    }
    reconcile();
  }

  function tabFor(terminal) {
    const item = document.createElement("div");
    item.className = "terminal-tab";
    item.setAttribute("role", "presentation");

    const select = document.createElement("button");
    select.type = "button";
    select.className = "terminal-tab-select";
    select.setAttribute("role", "tab");
    select.id = `terminal-tab-${terminal.id}`;
    select.setAttribute("aria-selected", String(terminal.id === s.activeId));
    select.dataset.id = terminal.id;
    const status = terminal.state === "exited" ? exitDescription(terminal) : "Running";
    select.title = `${terminal.title} · ${status}`;
    const dot = document.createElement("span");
    dot.className = `terminal-tab-status ${terminal.state === "exited" ? "is-exited" : "is-running"}`;
    dot.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "terminal-tab-title";
    title.textContent = terminal.title;
    select.append(dot, title);
    select.addEventListener("click", () => selectTerminal(terminal.id));

    const close = document.createElement("button");
    close.type = "button";
    close.className = "terminal-tab-close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close terminal ${terminal.title}`);
    close.title = "Close terminal";
    close.addEventListener("click", () => {
      void closeTerminal(terminal.id);
    });

    item.append(select, close);
    return item;
  }

  function render() {
    const root = s.root;
    const terminals = rootTerminals();
    const active = terminals.find((terminal) => terminal.id === s.activeId) ?? null;
    el.newButton.disabled = !root || s.creating;
    el.tabs.replaceChildren(...terminals.map(tabFor));
    el.screen.hidden = !active;
    el.empty.hidden = Boolean(active);
    el.footer.hidden = !(active && active.state === "exited");
    if (active && active.state === "exited") {
      el.footerStatus.textContent = exitDescription(active);
    }
    if (!active) {
      if (!root) {
        el.emptyText.textContent = "The terminal opens once the projects folder is known.";
      } else if (terminals.length === 0) {
        el.emptyText.textContent = `No terminal is open in ${repositoryName(root)}.`;
      } else {
        el.emptyText.textContent = `No terminal is shown for ${repositoryName(root)}. Pick one above, or open one.`;
      }
      el.emptyAction.hidden = !root;
      el.emptyAction.disabled = s.creating;
    }
  }

  async function refreshList() {
    const result = await api("/api/terminals");
    s.terminals = Array.isArray(result.terminals) ? result.terminals : [];
    reconcile();
  }

  async function createTerminal() {
    if (!s.root || s.creating) {
      return null;
    }
    s.creating = true;
    s.wantsTerminal = true;
    render();
    try {
      const size = s.term ? { cols: s.term.cols, rows: s.term.rows } : {};
      const info = await api("/api/terminals", {
        method: "POST",
        body: JSON.stringify({ cwd: s.root, ...size })
      });
      s.rememberedByRoot.set(s.root, info.id);
      upsert(info);
      s.activeId = info.id;
      reconcile();
      s.term?.focus();
      return info;
    } catch (error) {
      showNotice(describeError(error));
      return null;
    } finally {
      s.creating = false;
      render();
    }
  }

  // Same pop-up as deleting a conversation. Escape or Cancel keeps the terminal running.
  function confirmCloseTerminal(terminal) {
    if (typeof el.closeDialog.showModal !== "function") {
      return Promise.resolve(window.confirm(`Close "${terminal.title}"? Processes running in it will stop.`));
    }
    el.closeTitle.textContent = `Close "${terminal.title}"?`;
    el.closeDialog.showModal();
    return new Promise((resolve) => {
      el.closeDialog.addEventListener("close", () => {
        resolve(el.closeDialog.returnValue === "confirm");
      }, { once: true });
    });
  }

  async function closeTerminal(id) {
    if (el.closeDialog.open) {
      return;
    }
    const terminal = terminalById(id);
    if (terminal?.state === "running" && !(await confirmCloseTerminal(terminal))) {
      return;
    }
    try {
      await api(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (error) {
      if (error?.status !== 404) {
        showNotice(describeError(error));
        return;
      }
    }
    removeTerminal(id);
  }

  async function restartTerminal(id) {
    try {
      const info = await api(`/api/terminals/${encodeURIComponent(id)}/restart`, { method: "POST" });
      upsert(info);
    } catch (error) {
      showNotice(describeError(error));
    }
  }

  el.tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    const tabs = [...el.tabs.querySelectorAll("[role=tab]")];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) {
      return;
    }
    event.preventDefault();
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next?.focus();
  });
  el.newButton.addEventListener("click", () => {
    void createTerminal();
  });
  el.emptyAction.addEventListener("click", () => {
    void openRepository(s.repository);
  });
  el.restart.addEventListener("click", () => {
    if (s.activeId) {
      void restartTerminal(s.activeId);
    }
  });
  el.close.addEventListener("click", () => {
    if (s.activeId) {
      void closeTerminal(s.activeId);
    }
  });

  // Selecting a repository or folder never starts or attaches a terminal; the Terminal action and the terminal view do.
  function applyRoot() {
    const next = s.repository ?? s.defaultDirectory;
    if (next !== s.root) {
      s.root = next;
      s.activeId = null;
      s.wantsTerminal = false;
      closeSocket();
    }
    render();
  }

  function setRepository(root) {
    s.repository = root || null;
    applyRoot();
  }

  function setDefaultDirectory(directory) {
    s.defaultDirectory = directory || null;
    applyRoot();
  }

  function setActive(active) {
    if (s.active === active) {
      return;
    }
    s.active = active;
    if (!active) {
      closeSocket();
      window.clearTimeout(s.fitTimer);
      return;
    }
    s.wantsTerminal = true;
    ensureTerminal().then(() => {
      if (s.active) {
        refreshList().catch((error) => showNotice(describeError(error)));
      }
    }, (error) => showNotice(describeError(error)));
  }

  // The Terminal action: show the repository's live terminal, or start one if there is none.
  async function openRepository(root) {
    setRepository(root);
    s.wantsTerminal = true;
    if (!s.root) {
      showNotice("The projects folder is not known yet. Try again in a moment.");
      return;
    }
    try {
      await ensureTerminal();
      await refreshList();
      if (!s.activeId) {
        await createTerminal();
      }
      s.term?.focus();
    } catch (error) {
      showNotice(describeError(error));
    }
  }

  render();

  return {
    setRepository,
    setDefaultDirectory,
    setActive,
    openRepository,
    focus() {
      s.term?.focus();
    },
    handleServerEvent(type, data) {
      if (type === "terminal-removed") {
        removeTerminal(data.id);
      } else if (data?.terminal) {
        upsert(data.terminal);
      }
    }
  };
}
