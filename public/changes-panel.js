import { hunkText, parseUnifiedDiff, renderDiff } from "./diff-view.js";

const openStorageKey = "copilot-web-changes-open";
const widthStorageKey = "copilot-web-changes-width";
const wrapStorageKey = "copilot-web-changes-wrap";
const defaultWidth = 480;
const minimumWidth = 320;
const minimumListWidth = 220;
const minimumDiffWidth = 240;
const minimumGroupHeight = 48;
const splitterWidth = 9;
const initialRenderLines = 3_000;
const toolRefreshDelayMs = 750;
const focusRefreshAgeMs = 2_000;
const projectRepositoriesMaxAgeMs = 30_000;
const filterThreshold = 20;
const diffHighlightDurationMs = 2_000;
const diffSelectionHighlightName = "copilot-web-diff-selection";

const statusLabels = {
  added: ["A", "Added"],
  modified: ["M", "Modified"],
  deleted: ["D", "Deleted"],
  renamed: ["R", "Renamed"],
  copied: ["C", "Copied"],
  typechange: ["T", "Type changed"],
  untracked: ["?", "Untracked"],
  conflicted: ["!", "Conflicted"]
};

const errorMessages = {
  git_unavailable: "Git is not installed or not on the server's PATH.",
  repository_not_allowed: "This repository is outside the allowed roots.",
  git_timeout: "Git took too long to respond. Try refreshing, or narrow the list with the filter."
};

// Mirrors the statuses the server's reset accepts; conflicts, renames, and folders are never reset from the list.
const resettableStatuses = new Set(["untracked", "added", "modified", "deleted", "typechange"]);

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Preferences are optional.
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function iconElement(paths, className = "button-icon") {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const folderIconPaths = ["M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z"];
const chevronIconPaths = ["M9 6l6 6-6 6"];
const resetIconPaths = ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"];

function basename(value) {
  const trimmed = String(value).replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

function dirname(value) {
  const index = String(value).lastIndexOf("/");
  return index < 0 ? "" : String(value).slice(0, index + 1);
}

function joinPath(root, relativePath) {
  return `${String(root).replace(/\/+$/, "")}/${relativePath}`;
}

function describeError(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  return {
    code,
    message: (code && errorMessages[code]) || (error instanceof Error ? error.message : String(error))
  };
}

function isEditableTarget(target) {
  return target instanceof Element && Boolean(target.closest(
    "input, textarea, select, [contenteditable=''], [contenteditable='true'], prompt-editor, .terminal-tabpanel"
  ));
}

function fileSignature(file) {
  return file ? [file.section, file.status, file.additions, file.deletions, file.oldPath].join(":") : "";
}

function badgeText(count, truncated) {
  if (count > 999) {
    return "999+";
  }
  return `${count}${truncated ? "+" : ""}`;
}

function editorUrl(template, absolutePath, line) {
  const encodedPath = absolutePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return template
    .replaceAll("{path}", encodedPath)
    .replaceAll("{line}", encodeURIComponent(String(line ?? 1)));
}

export function initChangesPanel({
  api,
  insertIntoComposer,
  addSelection = () => {},
  attachFiles,
  changeWorkingDirectory,
  terminal = null,
  filesPanel = null,
  notify = () => {},
  onDecisionChange = () => {}
}) {
  const query = (selector) => document.querySelector(selector);
  const el = {
    workspace: query("#workspace"),
    workspaceBody: query("#workspace-body"),
    toggle: query("#changes-toggle"),
    decision: query("#changes-decision"),
    badge: query("#changes-badge"),
    panel: query("#changes-panel"),
    resizer: query("#changes-resizer"),
    back: query("#changes-back"),
    refresh: query("#changes-refresh"),
    expand: query("#changes-expand"),
    close: query("#changes-close"),
    repository: query("#changes-repository"),
    repositoryLabel: query("#changes-repository-label"),
    repositoryMenu: query("#changes-repository-menu"),
    branch: query("#changes-branch"),
    tabFiles: query("#repository-tab-files"),
    tabChanges: query("#repository-tab-changes"),
    tabCurrentChanges: query("#repository-tab-current-changes"),
    tabTerminal: query("#repository-tab-terminal"),
    tabsRow: query(".repository-tabs"),
    changesTabpanel: query("#changes-tabpanel"),
    filesTabpanel: query("#files-tabpanel"),
    terminalTabpanel: query("#terminal-tabpanel"),
    // Created from a template only while the terminal is enabled, so a disabled server leaves no menu entry.
    terminalAction: null,
    stage: query("#changes-stage"),
    reset: query("#changes-reset"),
    summary: query("#changes-summary-text"),
    filter: query("#changes-filter"),
    warnings: query("#changes-warnings"),
    list: query("#changes-list"),
    splitResizer: query("#changes-split-resizer"),
    diff: query("#changes-diff"),
    diffBack: query("#changes-diff-back"),
    diffClose: query("#changes-diff-close"),
    diffTitle: query("#changes-diff-title"),
    diffMeta: query("#changes-diff-meta"),
    diffBody: query("#changes-diff-body"),
    selectionActions: query("#changes-selection-actions"),
    askSelection: query("#changes-ask-selection"),
    ask: query("#changes-ask"),
    attach: query("#changes-attach"),
    copy: query("#changes-copy"),
    wrap: query("#changes-wrap"),
    full: query("#changes-full"),
    more: query("#changes-more"),
    moreMenu: query("#changes-more-menu"),
    openEditor: query("#changes-open-editor"),
    live: query("#changes-live"),
    resetDialog: query("#changes-reset-dialog"),
    resetTitle: query("#changes-reset-title"),
    resetDescription: query("#changes-reset-description"),
    resetConfirm: query("#changes-reset-confirm"),
    suggestion: query("#changes-suggestion"),
    suggestionText: query("#changes-suggestion-text"),
    suggestionUse: query("#changes-suggestion-use"),
    suggestionDismiss: query("#changes-suggestion-dismiss")
  };

  const storedWidth = Number(readStorage(widthStorageKey));
  const s = {
    open: readStorage(openStorageKey) === "true",
    width: Number.isFinite(storedWidth) && storedWidth >= minimumWidth ? storedWidth : defaultWidth,
    expanded: false,
    wrap: readStorage(wrapStorageKey) === "true",
    // The terminal tab exists only when the server enables it; the tab resets to Current changes when it does not.
    terminalEnabled: false,
    tab: "current",
    // The changes view shown last, which decides whether an open diff survives a switch through Files or the terminal.
    changesTab: "current",
    editorUrlTemplate: null,
    session: null,
    sessionRoot: null,
    editedRoot: null,
    sessionName: null,
    projectRepositories: null,
    projectRepositoriesAt: 0,
    projectRepositoriesPromise: null,
    repository: null,
    repositoryFromStorage: false,
    repositoryChosen: false,
    // The picker is locked while a reply runs or while the working directory is changing.
    replyBusy: false,
    switching: false,
    // The automatic choice last seen for this conversation, and the repository offered as the working directory.
    automaticRoot: undefined,
    suggestedRoot: null,
    // A repository edited in without a user pick, which becomes the working directory once no reply is running.
    followRoot: null,
    repositoryMenuOpen: false,
    repositoryMenuActive: null,
    repositoryFoldersOpen: new Set(),
    status: null,
    statusAt: 0,
    loading: false,
    error: null,
    filter: "",
    activeKey: null,
    openFile: null,
    diff: null,
    parsedDiff: null,
    diffLoading: false,
    diffError: null,
    diffNotChanged: false,
    // The selected lines of the diff being shown, painted until the highlight timer clears them.
    diffHighlight: null,
    full: false,
    renderLimit: initialRenderLines,
    currentHunk: -1,
    listHeight: null,
    sessionToken: 0,
    repoToken: 0,
    diffToken: 0,
    toolRefreshTimer: null,
    staging: new Set(),
    mutations: 0,
    statusInFlight: new Map(),
    statusQueued: new Set(),
    // The view and repository that the loaded status belongs to, so a response for another view is never shown.
    statusKey: null,
    navigableItems: [],
    updatedAt: 0
  };
  // A repository chosen before its conversation existed, handed to the session created from it.
  let repositoryCarry = null;
  // Each conversation's repository record (explicit pick and pending decision), mirrored from the server so it follows the user to any browser.
  const repositoryRecords = new Map();
  // Conversations whose record has been read from the server, and changes made before that read, merged in once it arrives.
  const loadedRecords = new Set();
  const unsavedRecordChanges = new Map();
  // Expanded view lists both sections, even when empty, with a draggable divider between Unstaged and Staged.
  let listExpanded = false;
  // The diff text selection offered for Ask Copilot, whether the pointer is selecting in the diff, and the timer that clears a revealed passage.
  let pendingDiffSelection = null;
  let diffSelectionPointer = false;
  let diffHighlightTimer = null;
  const groupDivider = element("div", "changes-group-divider");
  groupDivider.setAttribute("aria-hidden", "true");
  groupDivider.title = "Drag to resize the Unstaged and Staged sections";

  function readRepositoryChoice(sessionId) {
    const root = repositoryRecords.get(sessionId)?.choice;
    return root ? { root, explicit: true } : null;
  }

  function storeRecord(sessionId, record) {
    if (!record.choice && !record.suggestedRoot && !record.followRoot) {
      repositoryRecords.delete(sessionId);
    } else {
      repositoryRecords.set(sessionId, record);
    }
  }

  function saveRecord(sessionId) {
    api(`/api/sessions/${encodeURIComponent(sessionId)}/repository-record`, {
      method: "PUT",
      body: JSON.stringify(repositoryRecords.get(sessionId) ?? {})
    }).catch((error) => notify(`Repository choice not saved: ${describeError(error).message}`));
  }

  function updateRecord(sessionId, changes) {
    storeRecord(sessionId, { ...(repositoryRecords.get(sessionId) ?? {}), ...changes });
    if (!loadedRecords.has(sessionId)) {
      unsavedRecordChanges.set(sessionId, { ...(unsavedRecordChanges.get(sessionId) ?? {}), ...changes });
      return;
    }
    saveRecord(sessionId);
  }

  // Takes the server's record for a conversation; changes made before it arrived take precedence and are saved.
  function loadRecord(sessionId, serverRecord) {
    loadedRecords.add(sessionId);
    const changes = unsavedRecordChanges.get(sessionId);
    unsavedRecordChanges.delete(sessionId);
    storeRecord(sessionId, { ...(serverRecord ?? {}), ...(changes ?? {}) });
    if (changes) {
      saveRecord(sessionId);
    }
    return repositoryRecords.get(sessionId) ?? {};
  }

  // Puts a conversation's pending decision into the panel's state.
  function applyDecision(record) {
    s.automaticRoot = record.automaticRoot;
    s.suggestedRoot = record.suggestedRoot ?? null;
    s.followRoot = record.followRoot ?? null;
    setDecisionPending(suggestionVisible());
  }

  // ---- layout ----------------------------------------------------------

  const maximumWidth = () => Math.max(minimumWidth, Math.min(Math.floor(window.innerWidth * 0.6), 900));
  const clampWidth = (width) => Math.min(maximumWidth(), Math.max(minimumWidth, Math.round(width)));

  function applyWidth(width) {
    s.width = clampWidth(width);
    el.workspace.style.setProperty("--changes-width", `${s.width}px`);
    el.resizer.setAttribute("aria-valuenow", String(s.width));
    el.resizer.setAttribute("aria-valuemax", String(maximumWidth()));
    el.resizer.setAttribute("aria-valuetext", `${s.width} pixels`);
  }

  function saveWidth() {
    writeStorage(widthStorageKey, String(s.width));
  }

  function applyOpen() {
    el.workspace.classList.toggle("changes-open", s.open);
    el.workspace.classList.toggle("changes-expanded", s.open && s.expanded);
    el.workspace.closest(".app-shell")?.classList.toggle("repository-expanded", s.open && s.expanded);
    const expanded = s.open && s.expanded;
    if (expanded !== listExpanded) {
      listExpanded = expanded;
      renderList();
    }
    syncSplitResizer();
    el.panel.hidden = !s.open;
    el.resizer.hidden = !s.open;
    el.toggle.setAttribute("aria-pressed", String(s.open));
    el.expand.setAttribute("aria-pressed", String(s.expanded));
    el.expand.setAttribute("aria-label", s.expanded ? "Restore repository panel width" : "Expand repository panel");
    el.expand.title = s.expanded ? "Restore width" : "Expand";
    applyTabs();
    syncTerminal();
  }

  // ---- tabs ------------------------------------------------------------

  function isChangesTab(tab) {
    return tab === "current" || tab === "all";
  }

  function applyTabs() {
    syncTerminalAction();
    const buttons = { files: el.tabFiles, current: el.tabCurrentChanges, all: el.tabChanges, terminal: el.tabTerminal };
    el.tabTerminal.hidden = !s.terminalEnabled;
    for (const [tab, button] of Object.entries(buttons)) {
      const selected = tab === s.tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    const onChanges = isChangesTab(s.tab);
    if (onChanges) {
      el.changesTabpanel.setAttribute("aria-labelledby", buttons[s.tab].id);
    }
    el.changesTabpanel.hidden = !onChanges;
    el.filesTabpanel.hidden = s.tab !== "files";
    el.terminalTabpanel.hidden = s.tab !== "terminal";
    el.refresh.hidden = s.tab === "terminal";
    el.panel.dataset.tab = onChanges ? "changes" : s.tab;
    filesPanel?.setActive(s.open && s.tab === "files");
  }

  function syncTerminalAction() {
    if (s.terminalEnabled && !el.terminalAction) {
      const template = query("#terminal-action-template");
      const action = template?.content.firstElementChild?.cloneNode(true);
      if (!action) {
        return;
      }
      action.addEventListener("click", () => openTerminal());
      const attach = query("#attach-files");
      if (attach) {
        attach.after(action);
      } else {
        query("#composer-more-menu")?.append(action);
      }
      el.terminalAction = action;
    } else if (!s.terminalEnabled && el.terminalAction) {
      el.terminalAction.remove();
      el.terminalAction = null;
    }
  }

  function setTab(tab) {
    if (tab === "terminal" && !s.terminalEnabled) {
      return;
    }
    if (s.tab !== tab) {
      s.tab = tab;
      if (isChangesTab(tab)) {
        // Each changes view lists different files, so an open diff and its highlight belong to the view they were opened in.
        if (tab !== s.changesTab) {
          resetDiff();
          s.activeKey = null;
        }
        s.changesTab = tab;
      }
      render();
      if (isChangesTab(tab) && s.open && !statusIsCurrent()) {
        refreshStatusAndRender();
      }
    }
    applyTabs();
    syncTerminal();
  }

  // The shell is connected only while its tab is visible, so closing the panel detaches the socket.
  function syncTerminal() {
    terminal?.setActive(s.terminalEnabled && s.open && s.tab === "terminal");
  }

  function syncTerminalRepository() {
    if (s.terminalEnabled) {
      terminal?.setRepository(s.repository);
    }
  }

  function setTerminalEnabled(enabled) {
    s.terminalEnabled = enabled === true;
    if (!s.terminalEnabled && s.tab === "terminal") {
      setTab("current");
    }
    render();
  }

  // The Repository action shows the changes view it last showed. From the terminal view it switches there rather than closing.
  function openRepositoryView() {
    if (s.open && s.tab !== "terminal") {
      toggle(false);
      return;
    }
    setTab(s.tab === "terminal" ? "current" : s.tab);
    if (!s.open) {
      toggle(true);
    }
  }

  function openTerminal() {
    if (!s.terminalEnabled || !terminal) {
      return;
    }
    if (!s.open) {
      toggle(true);
    }
    setTab("terminal");
    void terminal.openRepository(s.repository);
  }

  el.tabFiles.addEventListener("click", () => setTab("files"));
  el.tabChanges.addEventListener("click", () => setTab("all"));
  el.tabCurrentChanges.addEventListener("click", () => setTab("current"));
  el.tabTerminal.addEventListener("click", () => setTab("terminal"));
  el.tabsRow.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    const tabs = s.terminalEnabled ? ["files", "current", "all", "terminal"] : ["files", "current", "all"];
    const buttons = { files: el.tabFiles, all: el.tabChanges, current: el.tabCurrentChanges, terminal: el.tabTerminal };
    const step = event.key === "ArrowRight" ? 1 : -1;
    const tab = tabs[(Math.max(tabs.indexOf(s.tab), 0) + step + tabs.length) % tabs.length];
    setTab(tab);
    buttons[tab].focus();
  });

  function toggle(force) {
    const next = typeof force === "boolean" ? force : !s.open;
    if (next === s.open) {
      return;
    }
    s.open = next;
    writeStorage(openStorageKey, String(next));
    if (!next) {
      s.expanded = false;
      setRepositoryMenuOpen(false);
      closeMoreMenu();
    }
    applyOpen();
    if (next) {
      void refreshAll();
      if (!s.projectRepositories || Date.now() - s.projectRepositoriesAt > projectRepositoriesMaxAgeMs) {
        void loadProjectRepositories();
      }
    }
    render();
  }

  let resizeStart = null;
  el.resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) {
      return;
    }
    event.preventDefault();
    resizeStart = { pointerId: event.pointerId, x: event.clientX, width: s.width };
    el.workspace.classList.add("changes-resizing");
    el.resizer.setPointerCapture(event.pointerId);
  });
  el.resizer.addEventListener("pointermove", (event) => {
    if (resizeStart && event.pointerId === resizeStart.pointerId) {
      s.expanded = false;
      applyWidth(resizeStart.width - (event.clientX - resizeStart.x));
      applyOpen();
    }
  });
  const finishResize = (event) => {
    if (!resizeStart || (event?.pointerId !== undefined && event.pointerId !== resizeStart.pointerId)) {
      return;
    }
    resizeStart = null;
    el.workspace.classList.remove("changes-resizing");
    saveWidth();
  };
  el.resizer.addEventListener("pointerup", finishResize);
  el.resizer.addEventListener("pointercancel", finishResize);
  el.resizer.addEventListener("lostpointercapture", finishResize);
  el.resizer.addEventListener("keydown", (event) => {
    const steps = { ArrowLeft: s.width + 16, ArrowRight: s.width - 16, Home: maximumWidth(), End: minimumWidth };
    if (!(event.key in steps)) {
      return;
    }
    event.preventDefault();
    s.expanded = false;
    applyWidth(steps[event.key]);
    applyOpen();
    saveWidth();
  });
  window.addEventListener("resize", () => applyWidth(s.width));

  let splitStart = null;
  el.splitResizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) {
      return;
    }
    event.preventDefault();
    const rect = el.list.getBoundingClientRect();
    splitStart = listExpanded
      ? { pointerId: event.pointerId, position: event.clientX, size: rect.width }
      : { pointerId: event.pointerId, position: event.clientY, size: rect.height };
    el.splitResizer.setPointerCapture(event.pointerId);
  });
  el.splitResizer.addEventListener("pointermove", (event) => {
    if (splitStart && event.pointerId === splitStart.pointerId) {
      if (listExpanded) {
        setListWidth(splitStart.size + event.clientX - splitStart.position);
      } else {
        setListHeight(splitStart.size + event.clientY - splitStart.position);
      }
    }
  });
  const finishSplit = () => {
    splitStart = null;
  };
  el.splitResizer.addEventListener("pointerup", finishSplit);
  el.splitResizer.addEventListener("pointercancel", finishSplit);
  el.splitResizer.addEventListener("keydown", (event) => {
    if (listExpanded) {
      const width = el.list.getBoundingClientRect().width;
      const step = event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0;
      if (step) {
        event.preventDefault();
        setListWidth(width + step);
      }
      return;
    }
    const current = el.list.getBoundingClientRect().height;
    const step = event.key === "ArrowUp" ? -24 : event.key === "ArrowDown" ? 24 : 0;
    if (step) {
      event.preventDefault();
      setListHeight(current + step);
    }
  });

  function setListHeight(height) {
    const maximum = Math.max(80, el.panel.getBoundingClientRect().height * 0.7);
    s.listHeight = Math.round(Math.min(maximum, Math.max(60, height)));
    el.panel.style.setProperty("--changes-list-height", `${s.listHeight}px`);
    el.splitResizer.setAttribute("aria-valuenow", String(s.listHeight));
  }

  // Expanded view: the list takes a share of the width and the diff takes the rest.
  function setListWidth(width) {
    const total = el.changesTabpanel.getBoundingClientRect().width;
    const maximum = Math.max(minimumListWidth, total - splitterWidth - minimumDiffWidth);
    const clamped = Math.round(Math.min(maximum, Math.max(minimumListWidth, width)));
    el.panel.style.setProperty("--changes-list-width", `${clamped}px`);
    el.splitResizer.setAttribute("aria-valuenow", String(clamped));
    el.splitResizer.setAttribute("aria-valuetext", `${clamped} pixels`);
  }

  // The splitter stays visible in the expanded view even with no file open, since the list is still beside the empty diff area.
  function syncSplitResizer() {
    el.splitResizer.hidden = !s.openFile && !listExpanded;
    el.splitResizer.setAttribute("aria-orientation", listExpanded ? "vertical" : "horizontal");
    el.splitResizer.setAttribute("aria-label", listExpanded ? "Resize file list and diff" : "Resize file list");
  }

  // Expanded view: dragging the divider between Unstaged and Staged sets the Unstaged section's height.
  let groupSplitStart = null;
  groupDivider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) {
      return;
    }
    event.preventDefault();
    const unstaged = el.list.querySelector(".changes-group-unstaged");
    groupSplitStart = {
      pointerId: event.pointerId,
      y: event.clientY,
      height: unstaged?.getBoundingClientRect().height ?? 0
    };
    groupDivider.setPointerCapture(event.pointerId);
  });
  groupDivider.addEventListener("pointermove", (event) => {
    if (groupSplitStart && event.pointerId === groupSplitStart.pointerId) {
      setUnstagedHeight(groupSplitStart.height + event.clientY - groupSplitStart.y);
    }
  });
  const finishGroupSplit = () => {
    groupSplitStart = null;
  };
  groupDivider.addEventListener("pointerup", finishGroupSplit);
  groupDivider.addEventListener("pointercancel", finishGroupSplit);

  function setUnstagedHeight(height) {
    const total = el.list.getBoundingClientRect().height;
    const maximum = Math.max(minimumGroupHeight, total - splitterWidth - minimumGroupHeight);
    const clamped = Math.round(Math.min(maximum, Math.max(minimumGroupHeight, height)));
    el.list.style.setProperty("--changes-unstaged-height", `${clamped}px`);
  }

  // ---- data ------------------------------------------------------------

  function loadProjectRepositories() {
    s.projectRepositoriesPromise ??= (async () => {
      try {
        const result = await api("/api/git/repositories");
        s.projectRepositories = Array.isArray(result.repositories) ? result.repositories : [];
        s.projectRepositoriesAt = Date.now();
      } catch (error) {
        s.projectRepositories ??= [];
        if (!s.error) {
          s.error = describeError(error);
        }
      } finally {
        s.projectRepositoriesPromise = null;
        render();
      }
    })();
    return s.projectRepositoriesPromise;
  }

  // Repository suggestions still waiting for an answer are stored per conversation, so they survive switching and reloads.
  function persistDecision() {
    if (!s.session) {
      return;
    }
    updateRecord(s.session.sessionId, { automaticRoot: s.automaticRoot, suggestedRoot: s.suggestedRoot, followRoot: s.followRoot });
  }

  // A repository picked in the panel stays in the picker and, when edits land elsewhere, a move to another repository is offered. Without a pick, the picker and the working directory follow the first edited repository; after that move the repository counts as chosen.
  function chooseRepository() {
    const automatic = s.editedRoot ?? s.sessionRoot ?? null;
    if (automatic !== s.automaticRoot) {
      // The first choice seen for a conversation is its starting point, not a change caused by edits.
      const firstChoice = s.automaticRoot === undefined;
      s.automaticRoot = automatic;
      const explicit = s.repositoryChosen || s.repositoryFromStorage || Boolean(s.session && readRepositoryChoice(s.session.sessionId)?.explicit);
      const moved = !firstChoice && Boolean(automatic) && automatic !== s.sessionRoot;
      if (moved && explicit) {
        s.suggestedRoot = automatic;
        s.followRoot = null;
        notify(`Copilot edited files in ${repositoryName(automatic)}. Use it as the working directory from the Repository panel.`);
      } else {
        s.suggestedRoot = null;
        s.followRoot = moved ? automatic : null;
      }
      persistDecision();
    }
    if (s.repository && (s.repositoryFromStorage || s.repositoryChosen)) {
      setDecisionPending(suggestionVisible());
      return;
    }
    setDecisionPending(suggestionVisible());
    const stored = s.session ? readRepositoryChoice(s.session.sessionId) : null;
    if (stored?.explicit) {
      setRepository(stored.root);
      s.repositoryFromStorage = true;
      return;
    }
    setRepository(automatic);
    s.repositoryFromStorage = false;
  }

  function setRepository(root) {
    if (root !== s.repository) {
      s.repository = root;
      s.repoToken += 1;
      s.status = null;
    }
  }

  async function refreshAll({ announce = false } = {}) {
    const token = s.sessionToken;
    const session = s.session;
    if (!session && !s.open) {
      return;
    }
    s.loading = true;
    renderHeader();
    try {
      if (session) {
        const repository = await api(`/api/sessions/${encodeURIComponent(session.sessionId)}/repository`);
        if (token !== s.sessionToken) {
          return;
        }
        s.sessionRoot = repository.root ?? null;
        if (repository.editedRoot !== undefined) {
          s.editedRoot = repository.editedRoot;
        }
        s.sessionName = repository.name ?? null;
        if (!loadedRecords.has(session.sessionId)) {
          applyDecision(loadRecord(session.sessionId, repository.record));
        }
      }
      chooseRepository();
      void followPendingRepository();
      if (!s.repository && s.open && !s.projectRepositories) {
        await loadProjectRepositories();
      }
      if (token !== s.sessionToken) {
        return;
      }
      if (s.repository) {
        await refreshStatus();
      } else {
        s.status = null;
        s.error = null;
      }
      s.updatedAt = Date.now();
      if (announce) {
        announceSummary();
      }
    } catch (error) {
      if (token === s.sessionToken) {
        s.error = describeError(error);
      }
    } finally {
      if (token === s.sessionToken) {
        s.loading = false;
        render();
      }
    }
  }

  // Refresh reloads the changes and the file tree; the tree also reloads whenever its tab is shown.
  function refreshViews(options) {
    filesPanel?.refresh();
    return refreshAll(options);
  }

  // "all" lists the repository's changes; "current" lists the files the open conversation edited.
  function changesScopeKey() {
    if (s.tab !== "current") {
      return "all";
    }
    return s.session ? `current:${s.session.sessionId}` : "none";
  }

  function changesSessionId() {
    return s.tab === "current" ? s.session?.sessionId ?? null : null;
  }

  function currentStatusKey() {
    return s.repository ? `${s.repository}\n${changesScopeKey()}` : null;
  }

  function statusIsCurrent() {
    return Boolean(s.status) && s.statusKey === currentStatusKey();
  }

  function refreshStatus() {
    const repository = s.repository;
    if (!repository || changesScopeKey() === "none") {
      return Promise.resolve();
    }
    const key = currentStatusKey();
    const existing = s.statusInFlight.get(key);
    if (existing) {
      s.statusQueued.add(key);
      return existing;
    }
    const repoToken = s.repoToken;
    const mutations = s.mutations;
    const sessionId = changesSessionId();
    const pending = (async () => {
      try {
        const scope = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : "";
        const status = await api(`/api/git/status?repo=${encodeURIComponent(repository)}${scope}`);
        // A read that overlapped a stage or unstage may show the index from before the change; a read for another view is not shown.
        if (repoToken !== s.repoToken || mutations !== s.mutations || key !== currentStatusKey()) {
          return;
        }
        applyStatus(status, key);
      } catch (error) {
        if (repoToken !== s.repoToken || key !== currentStatusKey()) {
          return;
        }
        if (error?.code === "repository_not_allowed" && s.repositoryFromStorage && s.session) {
          updateRecord(s.session.sessionId, { choice: null });
          s.repositoryFromStorage = false;
          s.repository = null;
          s.repoToken += 1;
          chooseRepository();
          if (s.repository && s.repository !== repository) {
            s.statusInFlight.delete(key);
            await refreshStatus();
            return;
          }
        }
        throw error;
      } finally {
        if (s.statusInFlight.get(key) === pending) {
          s.statusInFlight.delete(key);
        }
        if (s.statusQueued.delete(key) && key === currentStatusKey()) {
          void refreshStatus().then(render, (error) => {
            s.error = describeError(error);
            render();
          });
        }
      }
    })();
    s.statusInFlight.set(key, pending);
    return pending;
  }

  function refreshStatusAndRender() {
    void refreshStatus().then(() => {
      s.updatedAt = Date.now();
      render();
    }, (error) => {
      s.error = describeError(error);
      render();
    });
  }

  function applyStatus(status, key = currentStatusKey()) {
    const previousOpen = openFileEntry();
    s.status = status;
    s.statusKey = key;
    s.statusAt = Date.now();
    s.error = null;
    followOpenFile();
    if (s.open && s.openFile && !s.diffNotChanged && fileSignature(previousOpen) !== fileSignature(openFileEntry())) {
      void loadDiff();
    }
  }

  // A file that moves between sections (for example, after staging) keeps its diff open.
  function followOpenFile() {
    const open = s.openFile;
    const files = s.status?.files ?? [];
    if (!open || files.some((file) => file.path === open.path && file.section === open.section)) {
      return;
    }
    const moved = files.find((file) => file.path === open.path);
    if (!moved) {
      return;
    }
    const wasActive = s.activeKey === open.key;
    s.openFile = {
      key: `${moved.section}:${moved.path}`,
      path: moved.path,
      oldPath: moved.oldPath ?? null,
      status: moved.status,
      section: moved.section
    };
    s.diffNotChanged = false;
    if (wasActive) {
      s.activeKey = s.openFile.key;
    }
  }

  function openFileEntry() {
    if (!s.openFile) {
      return null;
    }
    return s.status?.files?.find((file) => file.path === s.openFile.path && file.section === s.openFile.section) ?? null;
  }

  // The open file as a list item, so the diff's Reset button and ⌘J still work when the list filter hides its row.
  function openFileItem() {
    const file = statusIsCurrent() ? openFileEntry() : null;
    return file ? fileItem(file) : null;
  }

  async function loadDiff() {
    const file = s.openFile;
    const repository = s.repository;
    if (!file || !repository) {
      return;
    }
    const token = ++s.diffToken;
    s.diffLoading = true;
    s.diffError = null;
    s.diffNotChanged = false;
    renderDiffArea();
    try {
      const params = new URLSearchParams({
        repo: repository,
        path: file.path,
        section: file.section,
        context: s.full ? "full" : "3"
      });
      if (file.oldPath) {
        params.set("oldPath", file.oldPath);
      }
      const diff = await api(`/api/git/diff?${params}`);
      if (token !== s.diffToken) {
        return;
      }
      s.diff = diff;
      s.parsedDiff = parseUnifiedDiff(diff.diff);
      s.currentHunk = -1;
    } catch (error) {
      if (token !== s.diffToken) {
        return;
      }
      s.diff = null;
      s.parsedDiff = null;
      if (error?.code === "file_not_changed") {
        s.diffNotChanged = true;
      } else {
        s.diffError = describeError(error);
      }
    } finally {
      if (token === s.diffToken) {
        s.diffLoading = false;
        renderDiffArea();
      }
    }
  }

  function resetDiff() {
    s.diffToken += 1;
    clearDiffSelectionHighlight();
    hideDiffSelectionActions();
    s.openFile = null;
    s.diff = null;
    s.parsedDiff = null;
    s.diffLoading = false;
    s.diffError = null;
    s.diffNotChanged = false;
    s.full = false;
    s.renderLimit = initialRenderLines;
    s.currentHunk = -1;
  }

  function openItem(item, { full = false } = {}) {
    if (!item?.selectable) {
      return;
    }
    s.activeKey = item.key;
    resetDiff();
    s.full = full;
    s.openFile = {
      key: item.key,
      path: item.path,
      oldPath: item.oldPath ?? null,
      status: item.status ?? null,
      section: item.section
    };
    el.panel.dataset.view = "diff";
    render();
    return loadDiff();
  }

  function closeDiff() {
    resetDiff();
    el.panel.dataset.view = "list";
    render();
    el.list.focus();
  }

  // Moves the working directory to a repository edited in without a user pick, once no reply is running. Nothing is announced in the transcript; the move makes the repository the conversation's chosen one.
  async function followPendingRepository() {
    const root = s.followRoot;
    if (!root || !s.session || s.replyBusy || s.switching) {
      return;
    }
    s.followRoot = null;
    persistDecision();
    if (root === s.sessionRoot || s.repositoryChosen || s.repositoryFromStorage) {
      return;
    }
    const sessionId = s.session.sessionId;
    // Once Copilot has moved the conversation, its repository counts as chosen, so later edits elsewhere are offered rather than moved to silently.
    s.repositoryChosen = true;
    updateRecord(sessionId, { choice: root });
    s.switching = true;
    renderRepositoryRow();
    try {
      await changeWorkingDirectory(sessionId, root, { announce: false });
      if (sessionId === (s.session?.sessionId ?? null)) {
        s.sessionRoot = root;
        // The name belongs to the previous root; the new root's basename is shown until the next refresh.
        s.sessionName = null;
      }
    } catch (error) {
      updateRecord(sessionId, { choice: null });
      if (sessionId === (s.session?.sessionId ?? null)) {
        s.repositoryChosen = false;
      }
      notify(`Working directory not changed: ${describeError(error).message}`);
    } finally {
      s.switching = false;
      renderRepositoryRow();
      // A move requested while this one ran is applied now.
      void followPendingRepository();
    }
  }

  async function selectRepository(root) {
    const switches = Boolean(s.session) && root !== s.sessionRoot;
    const explicit = s.repositoryChosen || s.repositoryFromStorage;
    if (!root || (root === s.repository && explicit && !switches)) {
      return;
    }
    if (switches && (s.replyBusy || s.switching)) {
      notify("Wait for the reply to finish before changing the working directory");
      return;
    }
    const sessionId = s.session?.sessionId ?? null;
    const previousRoot = s.repository;
    applyRepositoryChoice(root);
    if (!switches) {
      return;
    }
    s.switching = true;
    renderRepositoryRow();
    try {
      await changeWorkingDirectory(sessionId, root);
      if (sessionId === (s.session?.sessionId ?? null)) {
        s.sessionRoot = root;
        s.sessionName = null;
      }
    } catch (error) {
      if (sessionId === (s.session?.sessionId ?? null)) {
        restoreRepositoryChoice(previousRoot, explicit);
      }
      notify(`Working directory not changed: ${describeError(error)}`);
    } finally {
      s.switching = false;
      renderRepositoryRow();
    }
  }

  // Applies a repository choice made in the picker; a conversation remembers it.
  function applyRepositoryChoice(root) {
    s.repository = root;
    s.repositoryChosen = true;
    s.repositoryFromStorage = false;
    s.suggestedRoot = null;
    s.followRoot = null;
    persistDecision();
    setDecisionPending(false);
    s.repoToken += 1;
    s.status = null;
    s.activeKey = null;
    resetDiff();
    el.panel.dataset.view = "list";
    if (s.session) {
      updateRecord(s.session.sessionId, { choice: root });
    }
    render();
    s.loading = true;
    renderHeader();
    void refreshStatus().then(() => {
      s.updatedAt = Date.now();
    }, (error) => {
      s.error = describeError(error);
    }).finally(() => {
      s.loading = false;
      render();
    });
  }

  // Puts back the choice that was in effect before a failed working-directory change.
  function restoreRepositoryChoice(previousRoot, wasExplicit) {
    if (wasExplicit && previousRoot) {
      applyRepositoryChoice(previousRoot);
      return;
    }
    if (s.session) {
      updateRecord(s.session.sessionId, { choice: null });
    }
    s.repositoryChosen = false;
    s.repositoryFromStorage = false;
    void refreshAll();
  }

  // ---- rendering -------------------------------------------------------

  function announce(message) {
    el.live.textContent = "";
    window.setTimeout(() => {
      el.live.textContent = message;
    }, 30);
  }

  function announceSummary() {
    if (!statusIsCurrent()) {
      return;
    }
    const count = s.status.totals?.files ?? 0;
    const files = `file${count === 1 ? "" : "s"}`;
    if (changesSessionId()) {
      announce(count === 0
        ? `No files changed in this conversation in ${s.status.name}`
        : `${count} ${files} changed in this conversation in ${s.status.name}`);
      return;
    }
    announce(count === 0
      ? `No uncommitted changes in ${s.status.name}`
      : `${count} uncommitted ${files} in ${s.status.name}`);
  }

  // Repositories below the projects folder show their path, so nested ones stay identifiable.
  function repositoryName(root) {
    const project = s.projectRepositories?.find((repository) => repository.root === root);
    if (project) {
      return project.relativePath;
    }
    return root === s.sessionRoot && s.sessionName ? s.sessionName : basename(root ?? "");
  }

  function branchText(status) {
    if (!status) {
      return "";
    }
    if (!status.hasCommits) {
      return `${status.branch ?? "unborn"} · no commits yet`;
    }
    const head = status.detached ? `detached at ${status.headShort}` : status.branch ?? "";
    const tracking = [
      status.ahead > 0 ? `↑${status.ahead}` : "",
      status.behind > 0 ? `↓${status.behind}` : ""
    ].filter(Boolean).join(" ");
    return [head, tracking].filter(Boolean).join(" ");
  }

  function renderToolbar() {
    const status = s.status && s.status.root === s.repository ? s.status : null;
    // The badge counts the whole repository, so it does not change with the Current changes view.
    const totals = status?.repositoryTotals ?? { files: 0, truncated: false };
    const count = totals.files;
    el.badge.hidden = !status || count === 0;
    el.badge.textContent = status ? badgeText(count, totals.truncated) : "";
    const label = (status && count > 0
      ? `Repository, ${badgeText(count, totals.truncated)} uncommitted file${count === 1 ? "" : "s"}`
      : "Repository") + (suggestionVisible() ? ", repository decision pending" : "");
    const location = s.session && s.repository
      ? [repositoryName(s.repository), branchText(status)].filter(Boolean).join(" · ")
      : "";
    el.toggle.setAttribute("aria-label", location ? `${label} in ${location}` : label);
    el.toggle.title = `${location ? `${location}\n` : ""}${s.open ? "Hide" : "Show"} repository and changes (Ctrl+Shift+G)`;
  }

  function renderHeader() {
    el.refresh.classList.toggle("is-loading", s.loading);
    el.refresh.setAttribute("aria-busy", String(s.loading));
    el.refresh.title = s.updatedAt
      ? `Refresh (R) · Updated ${Date.now() - s.updatedAt < 10_000 ? "just now" : new Date(s.updatedAt).toLocaleTimeString()}`
      : "Refresh (R)";
  }

  function renderRepositoryRow() {
    const projects = s.projectRepositories ?? [];
    const label = s.repository ? repositoryName(s.repository) : "Choose a repository";
    el.repository.dataset.root = s.repository ?? "";
    el.repository.disabled = (outsideRepositoryRoots().length === 0 && projects.length === 0) ||
      s.replyBusy || s.switching;
    el.repository.title = s.replyBusy
      ? "Wait for the reply to finish before changing the working directory"
      : "Repository";
    el.repository.classList.toggle("is-placeholder", !s.repository);
    el.repository.setAttribute("aria-label", `Repository: ${label}`);
    el.repositoryLabel.textContent = label;
    renderRepositoryMenu();
    if (el.repository.disabled && s.repositoryMenuOpen) {
      setRepositoryMenuOpen(false);
    }
    const status = s.status && s.status.root === s.repository ? s.status : null;
    el.branch.textContent = branchText(status);
    el.branch.title = status?.upstream ? `Tracking ${status.upstream}` : "";
  }

  // Whether a move to another repository is waiting for the user's answer.
  function suggestionVisible() {
    return Boolean(s.suggestedRoot) && s.suggestedRoot !== s.sessionRoot;
  }

  // Marks a pending repository decision on the Repository item and on the more-actions button.
  function setDecisionPending(pending) {
    el.decision.hidden = !pending;
    onDecisionChange(pending);
  }

  // For a repository the user picked, the suggestion is offered once per automatic change and stays until the user uses it, dismisses it, or the repository matches the working directory.
  function renderSuggestion() {
    const root = s.suggestedRoot;
    const visible = suggestionVisible();
    el.suggestion.hidden = !visible;
    setDecisionPending(visible);
    if (!visible) {
      return;
    }
    const workingDirectory = s.sessionRoot ? repositoryName(s.sessionRoot) : "the projects folder";
    el.suggestionText.textContent =
      `Copilot edited files in ${repositoryName(root)}. The working directory is still ${workingDirectory}.`;
    el.suggestionUse.disabled = s.replyBusy || s.switching;
  }

  // Repositories outside the projects folder, such as the conversation's own, are listed above the tree.
  function outsideRepositoryRoots() {
    const projects = s.projectRepositories ?? [];
    return [...new Set([s.sessionRoot, s.repository])].filter((root) => (
      root && !projects.some((repository) => repository.root === root)
    ));
  }

  function renderRepositoryMenu() {
    const menu = document.createDocumentFragment();
    for (const root of outsideRepositoryRoots()) {
      menu.append(repositoryOption(root, repositoryName(root), 1));
    }
    appendRepositoryNodes(menu, repositoryTree(s.projectRepositories ?? []), 1);
    const scrollTop = el.repositoryMenu.scrollTop;
    el.repositoryMenu.replaceChildren(menu);
    el.repositoryMenu.scrollTop = scrollTop;
    repositoryItems().forEach((item, index) => {
      item.id = `changes-repository-option-${index}`;
    });
    setRepositoryActive(s.repositoryMenuActive);
  }

  // Folders exist only above repositories, so every folder in the picker leads to at least one repository.
  function repositoryTree(repositories) {
    const tree = { name: "", path: "", children: new Map(), repository: null };
    for (const repository of repositories) {
      let node = tree;
      let folder = "";
      for (const segment of repository.relativePath.split("/")) {
        folder = folder ? `${folder}/${segment}` : segment;
        if (!node.children.has(segment)) {
          node.children.set(segment, { name: segment, path: folder, children: new Map(), repository: null });
        }
        node = node.children.get(segment);
      }
      node.repository = repository;
    }
    return tree;
  }

  // Folders start collapsed. Only expanded folders render their children, so the rendered items are exactly the
  // visible ones, in order, which keeps keyboard navigation simple.
  function appendRepositoryNodes(container, node, level) {
    const children = [...node.children.values()].sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (child.repository) {
        container.append(repositoryOption(child.repository.root, child.name, level));
        continue;
      }
      const expanded = s.repositoryFoldersOpen.has(child.path);
      const folder = element("div", "changes-repository-folder");
      folder.setAttribute("role", "treeitem");
      folder.setAttribute("aria-level", String(level));
      folder.setAttribute("aria-expanded", String(expanded));
      folder.setAttribute("aria-label", child.name);
      folder.title = child.path;
      folder.dataset.folder = child.path;
      folder.dataset.key = repositoryFolderKey(child.path);
      const row = element("div", "changes-repository-folder-row");
      row.append(
        iconElement(chevronIconPaths, "changes-repository-chevron"),
        iconElement(folderIconPaths),
        element("span", "changes-repository-folder-name", child.name)
      );
      folder.append(row);
      if (expanded) {
        const items = element("div", "changes-repository-folder-items");
        items.setAttribute("role", "group");
        appendRepositoryNodes(items, child, level + 1);
        folder.append(items);
      }
      container.append(folder);
    }
  }

  function repositoryFolderKey(path) {
    return `folder:${path}`;
  }

  function toggleRepositoryFolder(path) {
    if (s.repositoryFoldersOpen.has(path)) {
      s.repositoryFoldersOpen.delete(path);
    } else {
      s.repositoryFoldersOpen.add(path);
    }
    // The folder takes the highlight, so collapsing a folder never leaves the highlight on a hidden item.
    s.repositoryMenuActive = repositoryFolderKey(path);
    renderRepositoryMenu();
  }

  function repositoryOption(root, label, level) {
    const option = element("div", "changes-repository-item");
    option.setAttribute("role", "treeitem");
    option.setAttribute("aria-level", String(level));
    option.dataset.key = root;
    option.dataset.root = root;
    option.title = root;
    const selected = root === s.repository;
    option.setAttribute("aria-selected", String(selected));
    option.append(element("span", "changes-repository-name", label));
    if (selected) {
      const check = element("span", "changes-repository-check", "✓");
      check.setAttribute("aria-hidden", "true");
      option.append(check);
    }
    return option;
  }

  function repositoryItems() {
    return Array.from(el.repositoryMenu.querySelectorAll('[role="treeitem"]'));
  }

  function setRepositoryActive(key, { reveal = false } = {}) {
    s.repositoryMenuActive = key;
    let active = null;
    for (const item of repositoryItems()) {
      const current = item.dataset.key === key;
      item.classList.toggle("is-active", current);
      if (current) {
        active = item;
      }
    }
    if (active) {
      el.repositoryMenu.setAttribute("aria-activedescendant", active.id);
      if (reveal) {
        active.scrollIntoView({ block: "nearest" });
      }
    } else {
      el.repositoryMenu.removeAttribute("aria-activedescendant");
    }
  }

  function setRepositoryMenuOpen(open, { returnFocus = false } = {}) {
    const items = repositoryItems();
    if (open && (el.repository.disabled || items.length === 0)) {
      return;
    }
    s.repositoryMenuOpen = open;
    el.repositoryMenu.hidden = !open;
    el.repository.setAttribute("aria-expanded", String(open));
    if (open) {
      // Start on the current repository when it is visible; repositories in collapsed folders are not.
      const current = items.find((item) => item.dataset.root === s.repository) ?? items[0];
      setRepositoryActive(current.dataset.key, { reveal: true });
      el.repositoryMenu.focus();
    } else if (returnFocus) {
      el.repository.focus();
    }
  }

  function chooseRepositoryOption(root) {
    setRepositoryMenuOpen(false, { returnFocus: true });
    selectRepository(root);
  }

  function statusBadge(status) {
    const [letter, label] = statusLabels[status] ?? ["•", "Changed"];
    const badge = element("span", `changes-status changes-status-${status ?? "unknown"}`);
    badge.title = label;
    const letterNode = element("span", "", letter);
    letterNode.setAttribute("aria-hidden", "true");
    badge.append(letterNode, element("span", "visually-hidden", label));
    return badge;
  }

  function pathLabel(filePath) {
    const label = element("span", "changes-file-name");
    const directory = dirname(filePath);
    if (directory) {
      label.append(element("span", "changes-file-dir", directory));
    }
    label.append(element("span", "changes-file-base", basename(filePath)));
    return label;
  }

  function counts(file) {
    const container = element("span", "changes-file-counts");
    if (file.binary) {
      container.append(element("span", "changes-count-note", "binary"));
    } else if (file.tooLarge) {
      container.append(element("span", "changes-count-note", "large"));
    } else if (file.directory) {
      container.append(element("span", "changes-count-note", "directory"));
    } else {
      if (file.additions) {
        container.append(element("span", "changes-count-add", `+${file.additions}`));
      }
      if (file.deletions) {
        container.append(element("span", "changes-count-del", `−${file.deletions}`));
      }
    }
    return container;
  }

  function matchesFilter(filePath) {
    return !s.filter || filePath.toLowerCase().includes(s.filter.toLowerCase());
  }

  function fileItem(file) {
    return {
      kind: "file",
      key: `${file.section}:${file.path}`,
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      section: file.section,
      file,
      selectable: true
    };
  }

  function buildListModel() {
    const files = statusIsCurrent() && Array.isArray(s.status.files) ? s.status.files : [];
    const groups = [
      {
        id: "unstaged",
        title: "Unstaged changes",
        items: files.filter((file) => file.section === "unstaged" && matchesFilter(file.path)).map(fileItem)
      },
      {
        id: "staged",
        title: "Staged changes",
        items: files.filter((file) => file.section === "staged" && matchesFilter(file.path)).map(fileItem)
      }
    ];
    return { groups, files, total: new Set(files.map((file) => file.path)).size };
  }

  function sectionTotals(items) {
    const additions = items.reduce((total, item) => total + (item.file.additions ?? 0), 0);
    const deletions = items.reduce((total, item) => total + (item.file.deletions ?? 0), 0);
    return `${items.length} · +${additions} −${deletions}`;
  }

  // Only unstaged rows that the server can reset get the reset button; it sits just before the stage button.
  function rowActions(item) {
    return canReset(item) ? [resetButton(item), stageButton(item)] : [stageButton(item)];
  }

  function canReset(item) {
    return item.section === "unstaged" && !item.file.directory && resettableStatuses.has(item.status);
  }

  function isNewFile(item) {
    return item.status === "untracked" || item.status === "added";
  }

  function resetButtonTitle(item) {
    return isNewFile(item) ? "Reset (deletes new file) (⌘J)" : "Reset changes (⌘J)";
  }

  function resetButton(item) {
    const deletesFile = isNewFile(item);
    const button = element("button", "changes-file-action changes-file-action-reset");
    button.type = "button";
    button.tabIndex = -1;
    button.disabled = s.staging.has(item.key);
    button.title = resetButtonTitle(item);
    button.setAttribute("aria-label", deletesFile ? `Delete new file ${item.path}` : `Reset changes to ${item.path}`);
    button.append(iconElement(resetIconPaths));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void resetItem(item);
    });
    return button;
  }

  function stageButton(item) {
    const stagesFile = item.section === "unstaged";
    const label = stagesFile ? "Stage" : "Unstage";
    const button = element("button", "changes-file-action");
    button.type = "button";
    // Keyboard users act on the highlighted row with S, so the button stays out of the tab order.
    button.tabIndex = -1;
    button.disabled = s.staging.has(item.key);
    button.title = `${label} (S)`;
    button.setAttribute("aria-label", `${label} ${item.path}`);
    button.append(iconElement(stagesFile ? ["M12 5v14", "M5 12h14"] : ["M5 12h14"]));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void setStaged(item);
    });
    return button;
  }

  function rowFor(item, index) {
    const row = element("div", "changes-file");
    row.id = `changes-option-${index}`;
    row.setAttribute("role", "option");
    row.dataset.key = item.key;
    row.title = item.path;
    row.setAttribute("aria-selected", String(item.key === s.activeKey));
    row.classList.toggle("is-open", item.key === s.openFile?.key);
    row.append(statusBadge(item.status));
    const name = pathLabel(item.path);
    if (item.oldPath) {
      name.append(element("span", "changes-file-rename", ` ← ${basename(item.oldPath)}`));
      name.title = `${item.oldPath} → ${item.path}`;
    }
    row.append(name, counts(item.file), ...rowActions(item));
    row.addEventListener("click", () => {
      openItem(item);
      el.list.focus();
    });
    return row;
  }

  function emptyState(message, actionLabel, action) {
    const container = element("div", "changes-empty");
    container.append(element("p", "", message));
    if (actionLabel) {
      const button = element("button", "changes-action", actionLabel);
      button.type = "button";
      button.addEventListener("click", action);
      container.append(button);
    }
    return container;
  }

  function renderList() {
    el.list.replaceChildren();
    s.navigableItems = [];
    if (s.error && !s.status) {
      el.list.append(emptyState(s.error.message, "Retry", () => void refreshAll({ announce: true })));
      el.summary.textContent = "";
      el.filter.hidden = true;
      return;
    }
    if (changesScopeKey() === "none") {
      el.list.append(emptyState("Files this conversation edits appear here."));
      el.summary.textContent = "";
      el.filter.hidden = true;
      return;
    }
    if (!s.repository) {
      el.list.append(emptyState(
        s.loading ? "Loading…" : "Choose a repository to see its uncommitted changes."
      ));
      el.summary.textContent = "";
      el.filter.hidden = true;
      return;
    }
    if (!statusIsCurrent()) {
      el.list.append(emptyState("Loading…"));
      el.summary.textContent = "";
      el.filter.hidden = true;
      return;
    }
    const model = buildListModel();
    const status = s.status;
    el.summary.textContent = model.total > 0 ? `${model.total} file${model.total === 1 ? "" : "s"}` : "";
    el.filter.hidden = model.files.length <= filterThreshold && !s.filter;

    if (status.truncated) {
      el.list.append(element(
        "p",
        "changes-notice",
        "Only the first 2,000 changed files are listed. Use the filter, or commit or ignore generated files."
      ));
    }
    if (model.files.length === 0) {
      const empty = changesSessionId()
        ? `No files changed in this conversation in ${status.name}.`
        : `No uncommitted changes in ${status.name}.`;
      el.list.append(emptyState(empty));
    } else if (model.groups.every((group) => group.items.length === 0)) {
      el.list.append(emptyState("No files match the filter."));
    }
    let index = 0;
    for (const group of model.groups) {
      if (group.items.length === 0 && !listExpanded) {
        continue;
      }
      const section = element("div", `changes-group changes-group-${group.id}`);
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", group.title);
      const header = element("div", "changes-group-title");
      header.append(element("span", "", group.title), element("span", "changes-group-count", sectionTotals(group.items)));
      section.append(header);
      if (group.items.length === 0) {
        section.append(element("p", "changes-group-empty", s.filter ? "No matching files" : `No ${group.id} changes`));
      }
      el.list.append(section);
      for (const item of group.items) {
        s.navigableItems.push(item);
        section.append(rowFor(item, index));
        index += 1;
      }
      if (listExpanded && group.id === "unstaged") {
        el.list.append(groupDivider);
      }
    }
    const active = s.navigableItems.find((item) => item.key === s.activeKey);
    if (active) {
      const row = el.list.querySelector(`[data-key="${CSS.escape(active.key)}"]`);
      el.list.setAttribute("aria-activedescendant", row?.id ?? "");
    } else {
      el.list.removeAttribute("aria-activedescendant");
    }
  }

  function renderWarnings() {
    const warnings = s.error && s.status ? [s.error.message] : [];
    el.warnings.replaceChildren(...warnings.map((warning) => element("p", "", warning)));
    el.warnings.hidden = warnings.length === 0;
  }

  function hunkActions(file, hunk) {
    const ask = element("button", "diff-hunk-action", "Ask");
    ask.type = "button";
    ask.title = "Ask Copilot about this hunk";
    ask.setAttribute("aria-label", `Ask Copilot about hunk at line ${hunk.newStart}`);
    ask.addEventListener("click", () => askCopilot(hunk));
    const attach = element("button", "diff-hunk-action", "Attach");
    attach.type = "button";
    attach.title = "Attach this hunk as a diff file";
    attach.setAttribute("aria-label", `Attach hunk at line ${hunk.newStart}`);
    attach.addEventListener("click", () => void attachDiff(hunkText(file, hunk), hunk));
    return [ask, attach];
  }

  function diffNotices(diff, parsed) {
    const notices = [];
    const file = parsed?.files[0];
    if (diff.truncated) {
      notices.push("This diff is larger than 1 MB and was truncated at a hunk boundary. Copy and attach use the shown part.");
    }
    if (file?.oldMode && file?.newMode && file.oldMode !== file.newMode) {
      notices.push(`File mode changed from ${file.oldMode} to ${file.newMode}.`);
    }
    if (diff.status === "deleted") {
      notices.push("This file was deleted.");
    }
    return notices;
  }

  function renderDiffArea() {
    hideDiffSelectionActions();
    const file = s.openFile;
    el.diff.hidden = !file;
    syncSplitResizer();
    el.panel.classList.toggle("has-diff", Boolean(file));
    if (!file) {
      el.panel.dataset.view = "list";
      return;
    }
    el.diffTitle.textContent = file.path;
    el.diffTitle.title = s.repository ? joinPath(s.repository, file.path) : file.path;
    const entry = openFileEntry();
    const meta = [file.section === "staged" ? "Staged" : "Unstaged"];
    if (entry) {
      meta.push(statusLabels[entry.status]?.[1] ?? entry.status);
    }
    if (entry?.oldPath) {
      meta.push(`from ${entry.oldPath}`);
    }
    el.diffMeta.textContent = meta.join(" · ");
    const unstage = file.section === "staged";
    el.stage.textContent = unstage ? "Unstage" : "Stage";
    el.stage.title = unstage
      ? "Unstage file (S)"
      : entry?.status === "conflicted" ? "Mark conflicts as resolved by staging (S)" : "Stage file (S)";
    el.stage.disabled = !entry || s.staging.has(file.key);
    const resetTarget = openFileItem();
    el.reset.hidden = !resetTarget || !canReset(resetTarget);
    el.reset.disabled = s.staging.has(file.key);
    if (resetTarget) {
      el.reset.title = resetButtonTitle(resetTarget);
    }
    el.wrap.setAttribute("aria-pressed", String(s.wrap));
    el.full.setAttribute("aria-pressed", String(s.full));
    el.diffBody.classList.toggle("diff-wrap", s.wrap);
    const hasDiffText = Boolean(s.diff?.diff);
    el.copy.disabled = !hasDiffText;
    el.attach.disabled = !hasDiffText;
    el.ask.disabled = !s.repository;
    el.full.disabled = !hasDiffText && !s.full;
    renderEditorLink();

    el.diffBody.replaceChildren();
    if (s.diffLoading) {
      el.diffBody.append(element("p", "changes-diff-state", "Loading diff…"));
      return;
    }
    if (s.diffNotChanged) {
      el.diffBody.append(element("p", "changes-diff-state", "No uncommitted changes in this file."));
      return;
    }
    if (s.diffError) {
      el.diffBody.append(emptyState(s.diffError.message, "Retry", () => void loadDiff()));
      return;
    }
    if (entry?.status === "conflicted") {
      el.diffBody.append(element(
        "p",
        "changes-diff-state",
        "This file has merge conflicts. Resolve them in your editor, then stage it to mark it resolved."
      ));
      return;
    }
    const diff = s.diff;
    if (!diff) {
      return;
    }
    if (diff.directory) {
      el.diffBody.append(element("p", "changes-diff-state", "This is a directory or nested repository; no diff is available."));
      return;
    }
    if (diff.tooLarge) {
      el.diffBody.append(element("p", "changes-diff-state", "This file is larger than 2 MB, so its diff isn't shown."));
      return;
    }
    if (diff.binary) {
      el.diffBody.append(element("p", "changes-diff-state", "Binary file changed."));
      return;
    }
    const parsed = s.parsedDiff ?? parseUnifiedDiff(diff.diff);
    for (const notice of diffNotices(diff, parsed)) {
      el.diffBody.append(element("p", "changes-notice", notice));
    }
    const hasHunks = parsed.files.some((entry) => entry.hunks.length > 0);
    if (!hasHunks) {
      const parsedFile = parsed.files[0];
      let message = "No content changes.";
      if (parsedFile?.isRename) {
        message = `Renamed without content changes${parsedFile.similarity ? ` (${parsedFile.similarity}% similar)` : ""}.`;
      } else if (parsedFile?.isNew || diff.status === "untracked" || diff.status === "added") {
        message = "New empty file.";
      } else if (parsedFile?.isDeleted) {
        message = "Deleted empty file.";
      } else if (parsedFile?.oldMode && parsedFile?.newMode) {
        message = "Only the file mode changed.";
      }
      el.diffBody.append(element("p", "changes-diff-state", message));
      return;
    }
    const container = element("div", "changes-diff-content");
    el.diffBody.append(container);
    renderDiff(container, parsed, {
      caption: `Changes to ${file.path}`,
      maxLines: s.renderLimit,
      hunkActions,
      onRenderMore: () => {
        s.renderLimit = Number.POSITIVE_INFINITY;
        renderDiffArea();
      }
    });
    paintDiffSelectionHighlight();
  }

  function renderEditorLink() {
    const template = s.editorUrlTemplate;
    const file = s.openFile;
    if (!template || !file || !s.repository || s.diff?.status === "deleted") {
      el.openEditor.hidden = true;
      el.openEditor.removeAttribute("href");
      return;
    }
    const firstHunk = s.parsedDiff?.files[0]?.hunks[0];
    const firstChange = firstHunk?.lines.find((line) => line.type === "add")?.newLine ?? firstHunk?.newStart ?? 1;
    el.openEditor.href = editorUrl(template, joinPath(s.repository, file.path), firstChange);
    el.openEditor.hidden = false;
  }

  // ---- diff text selection ---------------------------------------------

  // Characters of a code cell before a boundary point. Points before the cell count as 0 and points after it count as its full length.
  function diffCodeOffset(code, container, offset) {
    const cell = document.createRange();
    cell.selectNodeContents(code);
    const position = cell.comparePoint(container, offset);
    if (position < 0) {
      return 0;
    }
    if (position > 0) {
      return code.textContent.length;
    }
    const before = document.createRange();
    before.setStart(code, 0);
    before.setEnd(container, offset);
    return before.toString().length;
  }

  // One segment per selected line with the code it covers. Meta lines such as "No newline at end of file" are not file text.
  function diffSegmentsFromRange(range) {
    const hunks = s.parsedDiff.files.flatMap((file) => file.hunks);
    const segments = [];
    for (const row of el.diffBody.querySelectorAll("tr.diff-line")) {
      if (!range.intersectsNode(row)) {
        continue;
      }
      const hunkIndex = Number(row.parentElement.dataset.hunkIndex);
      const lineIndex = Number(row.dataset.lineIndex);
      const line = hunks[hunkIndex]?.lines[lineIndex];
      if (!line || line.type === "meta") {
        continue;
      }
      // An empty line renders a zero-width space, so offsets stay within the line's own text.
      const code = row.querySelector(".diff-code");
      const start = Math.min(diffCodeOffset(code, range.startContainer, range.startOffset), line.text.length);
      const end = Math.max(start, Math.min(diffCodeOffset(code, range.endContainer, range.endOffset), line.text.length));
      segments.push({ hunkIndex, lineIndex, start, end, text: line.text.slice(start, end) });
    }
    // A selection that only touches the edge of a line covers none of its text.
    while (segments[0]?.text === "") {
      segments.shift();
    }
    while (segments.at(-1)?.text === "") {
      segments.pop();
    }
    const text = segments.map((segment) => segment.text).join("\n");
    return text.trim() ? { text, segments } : null;
  }

  // Finds a selection's lines in the diff as it is now. The recorded position wins when its text still matches; otherwise the first identical passage is used.
  function locateDiffSegments(parsed, segments) {
    if (segments.length === 0) {
      return null;
    }
    const lines = parsed.files
      .flatMap((file) => file.hunks)
      .flatMap((hunk, hunkIndex) => hunk.lines.map((line, lineIndex) => ({ hunkIndex, lineIndex, line })))
      .filter(({ line }) => line.type !== "meta");
    const matchesAt = (index) => segments.every((segment, offset) => (
      lines[index + offset]?.line.text.slice(segment.start, segment.end) === segment.text
    ));
    const [first] = segments;
    let match = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (!matchesAt(index)) {
        continue;
      }
      if (lines[index].hunkIndex === first.hunkIndex && lines[index].lineIndex === first.lineIndex) {
        match = index;
        break;
      }
      match = match < 0 ? index : match;
    }
    if (match < 0) {
      return null;
    }
    return segments.map((segment, offset) => ({
      hunkIndex: lines[match + offset].hunkIndex,
      lineIndex: lines[match + offset].lineIndex,
      start: segment.start,
      end: segment.end,
      text: segment.text
    }));
  }

  function diffRowFor(segment) {
    return el.diffBody.querySelector(
      `tbody[data-hunk-index="${segment.hunkIndex}"] > tr.diff-line[data-line-index="${segment.lineIndex}"]`
    );
  }

  // Paints the highlighted passage. Returns false while one of its lines is not rendered, which the render limit can cause.
  function paintDiffSelectionHighlight() {
    const highlight = s.diffHighlight;
    if (!highlight) {
      return true;
    }
    if (highlight.diff !== s.diff) {
      // A reloaded diff can move its lines, so the recorded positions no longer mark the passage.
      clearDiffSelectionHighlight();
      return true;
    }
    const rows = new Map(Array.from(el.diffBody.querySelectorAll("tr.diff-line"), (row) => [
      `${row.parentElement.dataset.hunkIndex}:${row.dataset.lineIndex}`,
      row
    ]));
    const ranges = [];
    for (const segment of highlight.segments) {
      const text = rows.get(`${segment.hunkIndex}:${segment.lineIndex}`)?.querySelector(".diff-code")?.firstChild;
      if (!text) {
        return false;
      }
      if (segment.end > segment.start) {
        const range = document.createRange();
        range.setStart(text, segment.start);
        range.setEnd(text, segment.end);
        ranges.push(range);
      }
    }
    if (typeof window.Highlight === "function" && window.CSS?.highlights) {
      window.CSS.highlights.set(diffSelectionHighlightName, new window.Highlight(...ranges));
      return true;
    }
    // Without the CSS Highlight API, the browser's own selection marks the passage, as it does in the conversation.
    const selection = window.getSelection();
    if (selection && ranges.length > 0) {
      const span = document.createRange();
      span.setStart(ranges[0].startContainer, ranges[0].startOffset);
      span.setEnd(ranges.at(-1).endContainer, ranges.at(-1).endOffset);
      selection.removeAllRanges();
      selection.addRange(span);
      highlight.range = span;
      el.diffBody.classList.add("selection-flash");
    }
    return true;
  }

  function clearDiffSelectionHighlight() {
    window.clearTimeout(diffHighlightTimer);
    diffHighlightTimer = null;
    const highlight = s.diffHighlight;
    s.diffHighlight = null;
    window.CSS?.highlights?.delete(diffSelectionHighlightName);
    el.diffBody.classList.remove("selection-flash");
    if (highlight?.range) {
      window.getSelection()?.removeAllRanges();
    }
  }

  function showDiffSelectionHighlight(segments) {
    clearDiffSelectionHighlight();
    s.diffHighlight = { segments, diff: s.diff };
    if (!paintDiffSelectionHighlight()) {
      s.renderLimit = Number.POSITIVE_INFINITY;
      renderDiffArea();
    }
    const row = diffRowFor(segments[0]);
    if (row) {
      const body = el.diffBody.getBoundingClientRect();
      const target = row.getBoundingClientRect();
      el.diffBody.scrollTop += target.top - body.top - (el.diffBody.clientHeight - target.height) / 2;
    }
    diffHighlightTimer = window.setTimeout(clearDiffSelectionHighlight, diffHighlightDurationMs);
  }

  // Opens the diff a selection came from and highlights its lines. Returns a notice when they cannot be shown.
  async function revealDiffSelection(reference) {
    const otherRepository = "This selected text is from a repository that is not open in Changes.";
    if (reference.repository !== s.repository) {
      return otherRepository;
    }
    if (!s.open) {
      toggle(true);
    }
    setTab(reference.tab);
    try {
      await refreshStatus();
    } catch (error) {
      return describeError(error).message;
    }
    if (reference.repository !== s.repository) {
      return otherRepository;
    }
    const file = statusIsCurrent()
      ? s.status.files.find((entry) => entry.path === reference.path && entry.section === reference.section)
      : null;
    if (!file) {
      return "The selected text's file has no uncommitted changes now.";
    }
    const key = `${file.section}:${file.path}`;
    await openItem({
      key,
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      section: file.section,
      selectable: true
    }, { full: reference.full });
    if (s.openFile?.key !== key) {
      return null;
    }
    const segments = s.parsedDiff ? locateDiffSegments(s.parsedDiff, reference.segments) : null;
    if (!segments) {
      return s.diffError?.message ?? "The selected text is no longer in this diff.";
    }
    showDiffSelectionHighlight(segments);
    return null;
  }

  // The diff code under the page selection, with its range, or null when the selection is not diff code.
  function diffSelectionOnPage() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !s.openFile || !s.repository || !s.parsedDiff) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!el.diffBody.contains(range.commonAncestorContainer)) {
      return null;
    }
    const picked = diffSegmentsFromRange(range);
    if (!picked) {
      return null;
    }
    return {
      range,
      reference: {
        kind: "diff",
        text: picked.text,
        repository: s.repository,
        tab: s.tab,
        path: s.openFile.path,
        section: s.openFile.section,
        full: s.full,
        segments: picked.segments
      }
    };
  }

  function placeDiffSelectionActions(selectionBounds) {
    const actions = el.selectionActions;
    actions.hidden = false;
    actions.style.visibility = "hidden";
    const actionBounds = actions.getBoundingClientRect();
    const edge = 8;
    const gap = 9;
    const maxLeft = Math.max(edge, window.innerWidth - actionBounds.width - edge);
    const left = Math.min(
      Math.max(selectionBounds.left + selectionBounds.width / 2 - actionBounds.width / 2, edge),
      maxLeft
    );
    let top = selectionBounds.top - actionBounds.height - gap;
    if (top < edge) {
      top = selectionBounds.bottom + gap;
    }
    const maxTop = Math.max(edge, window.innerHeight - actionBounds.height - edge);
    top = Math.min(Math.max(top, edge), maxTop);
    actions.style.left = `${Math.round(left)}px`;
    actions.style.top = `${Math.round(top)}px`;
    actions.style.visibility = "";
  }

  function hideDiffSelectionActions() {
    pendingDiffSelection = null;
    el.selectionActions.hidden = true;
    el.selectionActions.style.removeProperty("left");
    el.selectionActions.style.removeProperty("top");
    el.selectionActions.style.removeProperty("visibility");
  }

  function updateDiffSelectionActions() {
    const selected = (s.diffHighlight || diffSelectionPointer) ? null : diffSelectionOnPage();
    if (!selected) {
      hideDiffSelectionActions();
      return;
    }
    const bounds = selected.range.getBoundingClientRect();
    const body = el.diffBody.getBoundingClientRect();
    if (
      (bounds.width === 0 && bounds.height === 0) ||
      bounds.bottom < body.top ||
      bounds.top > body.bottom
    ) {
      hideDiffSelectionActions();
      return;
    }
    pendingDiffSelection = selected.reference;
    placeDiffSelectionActions(bounds);
  }

  function scheduleDiffSelectionUpdate() {
    window.setTimeout(updateDiffSelectionActions, 0);
  }

  function render() {
    // The terminal's repository is set before applyOpen can activate the terminal, since a later root change resets a terminal being shown.
    syncTerminalRepository();
    applyOpen();
    renderToolbar();
    filesPanel?.setRepository(s.repository);
    if (!s.open) {
      return;
    }
    renderHeader();
    renderRepositoryRow();
    renderSuggestion();
    renderWarnings();
    renderList();
    renderDiffArea();
  }

  // ---- actions ---------------------------------------------------------

  function diffCommand(file) {
    const quoted = /[\s'"$`\\]/.test(file.path) ? `'${file.path.replaceAll("'", "'\\''")}'` : file.path;
    if (s.diff?.status === "untracked") {
      return `git diff --no-index -- /dev/null ${quoted}`;
    }
    return file.section === "staged" ? `git diff --cached -- ${quoted}` : `git diff -- ${quoted}`;
  }

  // Ask and Attach put text in the conversation composer, which is hidden while the panel is expanded.
  function restoreWidth() {
    if (s.expanded) {
      s.expanded = false;
      applyOpen();
    }
  }

  function askCopilot(hunk = null) {
    const file = s.openFile;
    if (!file || !s.repository) {
      return;
    }
    restoreWidth();
    const subject = hunk
      ? `the hunk at lines ${hunk.newStart}–${hunk.newStart + Math.max(hunk.newLines - 1, 0)} of my ${file.section} changes to`
      : `my ${file.section} changes to`;
    insertIntoComposer(
      `Review ${subject} \`${file.path}\` in \`${s.repository}\` (\`${diffCommand(file)}\`).`
    );
  }

  async function attachDiff(text, hunk = null) {
    const file = s.openFile;
    if (!file || !text) {
      return;
    }
    restoreWidth();
    const name = `${basename(file.path)}${hunk ? `-L${hunk.newStart}` : ""}.diff`;
    const attached = await attachFiles([new File([text], name, { type: "text/x-diff" })]);
    if (!attached) {
      return;
    }
    insertIntoComposer(
      `The attached ${name} is the uncommitted diff${hunk ? " hunk" : ""} of \`${file.path}\` in \`${s.repository}\`.`
    );
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${label} copied`);
      announce(`${label} copied`);
    } catch {
      notify(`${label} could not be copied`);
    }
  }

  function closeMoreMenu() {
    el.moreMenu.hidden = true;
    el.more.setAttribute("aria-expanded", "false");
  }

  function openFileTarget() {
    const file = s.openFile;
    return file ? { key: file.key, path: file.path, section: file.section } : null;
  }

  // After staging the visible file, move its preview to the first unstaged file, or close when none is left.
  function openFirstUnstaged(files) {
    const next = files.find((file) => file.section === "unstaged");
    if (!next) {
      closeDiff();
      return;
    }
    openItem({
      key: `unstaged:${next.path}`,
      path: next.path,
      oldPath: next.oldPath,
      status: next.status,
      section: next.section,
      selectable: true
    });
  }

  // Staging changes only the Git index; the worktree is never touched.
  async function setStaged(item) {
    if (!s.repository || !item || s.staging.has(item.key)) {
      return;
    }
    const action = item.section === "unstaged" ? "stage" : "unstage";
    const advanceDiff = action === "stage" && s.openFile?.path === item.path;
    const repository = s.repository;
    const repoToken = s.repoToken;
    const statusKey = currentStatusKey();
    const focus = el.stage === document.activeElement ? "stage" : el.list.contains(document.activeElement) ? "list" : null;
    s.staging.add(item.key);
    if (s.openFile?.key === item.key) {
      el.stage.disabled = true;
      el.reset.disabled = true;
    }
    renderList();
    try {
      const status = await api("/api/git/stage", {
        method: "POST",
        body: JSON.stringify({ repo: repository, path: item.path, action, sessionId: changesSessionId() })
      });
      if (repoToken === s.repoToken) {
        s.mutations += 1;
        if (statusKey !== currentStatusKey()) {
          refreshStatusAndRender();
        } else if (action === "stage") {
          if (advanceDiff) {
            // Clear the preview first so the staged file is not followed into the staged section.
            resetDiff();
          }
          applyStatus(status);
          if (advanceDiff) {
            openFirstUnstaged(status.files);
          }
        } else {
          const movedKey = `unstaged:${item.path}`;
          const wasActive = s.activeKey === item.key;
          applyStatus(status);
          if (wasActive) {
            s.activeKey = status.files.some((file) => `${file.section}:${file.path}` === movedKey) ? movedKey : null;
          }
        }
        announce(`${item.path} ${action === "stage" ? "staged" : "unstaged"}`);
      }
    } catch (error) {
      if (repoToken === s.repoToken) {
        s.mutations += 1;
        const message = describeError(error).message;
        notify(message);
        announce(message);
        refreshStatusAndRender();
      }
    } finally {
      s.staging.delete(item.key);
      render();
      if (focus === "stage" && s.openFile && !el.stage.disabled) {
        el.stage.focus();
      } else if (focus === "list") {
        el.list.focus();
      }
    }
  }

  function resetCopy(item) {
    const name = basename(item.path);
    if (isNewFile(item)) {
      return {
        title: `Delete ${name}?`,
        description: `Git has no saved content for ${item.path}, so deleting it permanently removes its only copy. This cannot be undone.`,
        action: "Delete"
      };
    }
    const hasStagedPart = Boolean(s.status?.files?.some((file) => file.section === "staged" && file.path === item.path));
    return {
      title: `Reset ${name}?`,
      description: hasStagedPart
        ? `Unstaged changes to ${item.path} will be discarded and the file restored to its staged version. Staged changes are kept. This cannot be undone.`
        : `Changes to ${item.path} since the last commit will be discarded and the file restored to its committed version. This cannot be undone.`,
      action: "Reset"
    };
  }

  // Answers come from the dialog's submit and cancel events, which fire as the user acts. Close events can arrive
  // late, after a newer confirmation has started, so they only answer a question that nothing else answered.
  let pendingResetAnswer = null;
  function settleResetAnswer(confirmed) {
    const answer = pendingResetAnswer;
    pendingResetAnswer = null;
    answer?.(confirmed);
  }
  el.resetDialog.addEventListener("submit", (event) => settleResetAnswer(event.submitter?.value === "confirm"));
  el.resetDialog.addEventListener("cancel", () => settleResetAnswer(false));
  el.resetDialog.addEventListener("close", () => {
    if (!el.resetDialog.open) {
      settleResetAnswer(false);
    }
  });

  function confirmReset(item) {
    const copy = resetCopy(item);
    if (typeof el.resetDialog.showModal !== "function") {
      return Promise.resolve(window.confirm(`${copy.title}\n\n${copy.description}`));
    }
    el.resetTitle.textContent = copy.title;
    el.resetDescription.textContent = copy.description;
    el.resetConfirm.textContent = copy.action;
    return new Promise((resolve) => {
      pendingResetAnswer = resolve;
      el.resetDialog.showModal();
    });
  }

  // Nothing is discarded or deleted until the confirmation dialog is confirmed.
  async function resetItem(item) {
    if (!s.repository || !item || !canReset(item) || s.staging.has(item.key) || el.resetDialog.open) {
      return;
    }
    const repository = s.repository;
    const repoToken = s.repoToken;
    const focusInList = el.list.contains(document.activeElement);
    const focusOnReset = el.reset === document.activeElement;
    if (!(await confirmReset(item)) || repoToken !== s.repoToken) {
      return;
    }
    const statusKey = currentStatusKey();
    s.staging.add(item.key);
    render();
    try {
      const status = await api("/api/git/reset", {
        method: "POST",
        body: JSON.stringify({ repo: repository, path: item.path, sessionId: changesSessionId() })
      });
      if (repoToken === s.repoToken) {
        s.mutations += 1;
        if (statusKey !== currentStatusKey()) {
          refreshStatusAndRender();
        } else {
          const wasActive = s.activeKey === item.key;
          applyStatus(status);
          if (wasActive) {
            // After a reset, only the staged part of the file, if any, is left to highlight.
            const stagedKey = `staged:${item.path}`;
            s.activeKey = status.files.some((file) => `${file.section}:${file.path}` === stagedKey) ? stagedKey : null;
          }
          announce(isNewFile(item) ? `${item.path} deleted` : `${item.path} reset`);
        }
      }
    } catch (error) {
      if (repoToken === s.repoToken) {
        s.mutations += 1;
        const message = describeError(error).message;
        notify(message);
        announce(message);
        refreshStatusAndRender();
      }
    } finally {
      s.staging.delete(item.key);
      render();
      if (focusInList) {
        el.list.focus();
      } else if (focusOnReset) {
        // Focus stays on the diff's Reset button while it is offered; otherwise it moves to the list, or to Back where the narrow layout hides the list.
        if (!el.reset.hidden) {
          el.reset.focus();
        } else {
          (el.list.offsetParent ? el.list : el.diffBack).focus();
        }
      }
    }
  }

  function stageActive(inList) {
    const target = inList ? s.navigableItems.find((item) => item.key === s.activeKey) : openFileTarget();
    if (target) {
      void setStaged(target);
    }
  }

  // Same confirmed reset as the row's Reset button, for the highlighted row or the file open in the diff.
  function resetActive(inList) {
    const target = inList ? s.navigableItems.find((item) => item.key === s.activeKey) : openFileItem();
    if (target) {
      void resetItem(target);
    }
  }

  function moveActive(delta) {
    const items = s.navigableItems;
    if (items.length === 0) {
      return;
    }
    const current = items.findIndex((item) => item.key === s.activeKey);
    const next = current < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, current + delta));
    s.activeKey = items[next].key;
    renderList();
    el.list.querySelector(`[data-key="${CSS.escape(s.activeKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function moveHunk(delta) {
    const groups = Array.from(el.diffBody.querySelectorAll("tbody[data-hunk-index]"));
    if (groups.length === 0) {
      return;
    }
    s.currentHunk = Math.min(groups.length - 1, Math.max(0, s.currentHunk + delta));
    groups.forEach((group, index) => group.classList.toggle("is-current", index === s.currentHunk));
    groups[s.currentHunk].scrollIntoView({ block: "start" });
  }

  function toggleWrap() {
    s.wrap = !s.wrap;
    writeStorage(wrapStorageKey, String(s.wrap));
    renderDiffArea();
  }

  // The toggle may live in a collapsed menu; return focus to the nearest visible control.
  function focusToggle() {
    const target = el.toggle.checkVisibility?.() === false
      ? el.toggle.closest(".composer-more")?.querySelector("[aria-haspopup]")
      : el.toggle;
    target?.focus();
  }

  el.toggle.addEventListener("click", () => openRepositoryView());
  el.close.addEventListener("click", () => {
    toggle(false);
    focusToggle();
  });
  el.back.addEventListener("click", () => {
    toggle(false);
    focusToggle();
  });
  el.refresh.addEventListener("click", () => void refreshViews({ announce: true }));
  el.expand.addEventListener("click", () => {
    s.expanded = !s.expanded;
    applyOpen();
  });
  el.suggestionUse.addEventListener("click", () => {
    if (s.suggestedRoot) {
      selectRepository(s.suggestedRoot);
    }
  });
  el.suggestionDismiss.addEventListener("click", () => {
    s.suggestedRoot = null;
    persistDecision();
    renderSuggestion();
  });
  el.repository.addEventListener("click", () => setRepositoryMenuOpen(!s.repositoryMenuOpen, { returnFocus: true }));
  el.repository.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !s.repositoryMenuOpen) {
      event.preventDefault();
      setRepositoryMenuOpen(true);
    }
  });
  el.repositoryMenu.addEventListener("click", (event) => {
    const row = event.target.closest?.(".changes-repository-folder-row");
    if (row) {
      toggleRepositoryFolder(row.parentElement.dataset.folder);
      return;
    }
    const option = event.target.closest?.('[role="treeitem"][data-root]');
    if (option) {
      chooseRepositoryOption(option.dataset.root);
    }
  });
  el.repositoryMenu.addEventListener("keydown", (event) => {
    const items = repositoryItems();
    const index = items.findIndex((item) => item.dataset.key === s.repositoryMenuActive);
    const current = items[index];
    const isFolder = (item) => item?.classList.contains("changes-repository-folder") ?? false;
    const isOpen = (item) => item?.getAttribute("aria-expanded") === "true";
    const move = (item) => setRepositoryActive(item?.dataset.key ?? s.repositoryMenuActive, { reveal: true });
    switch (event.key) {
      case "ArrowDown":
        move(items[Math.min(items.length - 1, index + 1)]);
        break;
      case "ArrowUp":
        move(items[Math.max(0, index - 1)]);
        break;
      case "Home":
        move(items[0]);
        break;
      case "End":
        move(items.at(-1));
        break;
      case "ArrowRight":
        // An open folder's first child is the next rendered item.
        if (isFolder(current) && !isOpen(current)) {
          toggleRepositoryFolder(current.dataset.folder);
        } else if (isOpen(current)) {
          move(items[index + 1]);
        }
        break;
      case "ArrowLeft": {
        if (isFolder(current) && isOpen(current)) {
          toggleRepositoryFolder(current.dataset.folder);
        } else {
          const parent = current?.parentElement?.closest('[role="treeitem"]');
          if (parent) {
            move(parent);
          }
        }
        break;
      }
      case "Enter":
      case " ":
        if (isFolder(current)) {
          toggleRepositoryFolder(current.dataset.folder);
        } else {
          chooseRepositoryOption(s.repositoryMenuActive);
        }
        break;
      case "Escape":
        setRepositoryMenuOpen(false, { returnFocus: true });
        break;
      case "Tab":
        setRepositoryMenuOpen(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
  document.addEventListener("pointerdown", (event) => {
    if (s.repositoryMenuOpen && !event.target.closest?.(".changes-repository-picker")) {
      setRepositoryMenuOpen(false);
    }
  });
  el.stage.addEventListener("click", () => {
    const target = openFileTarget();
    if (target) {
      void setStaged(target);
    }
  });
  el.reset.addEventListener("click", () => resetActive(false));
  el.filter.addEventListener("input", () => {
    s.filter = el.filter.value.trim();
    renderList();
  });
  el.diffBack.addEventListener("click", closeDiff);
  el.diffClose.addEventListener("click", closeDiff);
  el.selectionActions.addEventListener("mousedown", (event) => {
    // Keeps the diff selection while the Ask button is pressed.
    event.preventDefault();
  });
  el.askSelection.addEventListener("click", () => {
    const reference = pendingDiffSelection;
    if (!reference) {
      return;
    }
    hideDiffSelectionActions();
    window.getSelection()?.removeAllRanges();
    restoreWidth();
    addSelection(reference);
  });
  el.diffBody.addEventListener("scroll", updateDiffSelectionActions, { passive: true });
  window.addEventListener("resize", updateDiffSelectionActions);
  document.addEventListener("pointerdown", (event) => {
    if (el.selectionActions.contains(event.target)) {
      return;
    }
    diffSelectionPointer = el.diffBody.contains(event.target);
    hideDiffSelectionActions();
    if (diffSelectionPointer) {
      clearDiffSelectionHighlight();
    }
  });
  document.addEventListener("pointerup", () => {
    if (diffSelectionPointer) {
      diffSelectionPointer = false;
      scheduleDiffSelectionUpdate();
    }
  });
  document.addEventListener("pointercancel", () => {
    diffSelectionPointer = false;
    hideDiffSelectionActions();
  });
  document.addEventListener("keyup", scheduleDiffSelectionUpdate);
  el.ask.addEventListener("click", () => askCopilot());
  el.attach.addEventListener("click", () => void attachDiff(s.diff?.diff ?? ""));
  el.copy.addEventListener("click", () => void copyText(s.diff?.diff ?? "", "Diff"));
  el.wrap.addEventListener("click", toggleWrap);
  el.full.addEventListener("click", () => {
    s.full = !s.full;
    s.renderLimit = initialRenderLines;
    void loadDiff();
  });
  el.more.addEventListener("click", () => {
    const opening = el.moreMenu.hidden;
    el.moreMenu.hidden = !opening;
    el.more.setAttribute("aria-expanded", String(opening));
    if (opening) {
      el.moreMenu.querySelector("[role=menuitem]:not([hidden])")?.focus();
    }
  });
  el.moreMenu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-action]");
    if (!item || !s.openFile) {
      return;
    }
    if (item.dataset.action === "copy-path") {
      void copyText(s.openFile.path, "Path");
    } else if (item.dataset.action === "copy-absolute-path" && s.repository) {
      void copyText(joinPath(s.repository, s.openFile.path), "Absolute path");
    }
    closeMoreMenu();
  });
  el.moreMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMoreMenu();
      el.more.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!el.moreMenu.hidden && !event.target.closest?.(".changes-more")) {
      closeMoreMenu();
    }
  });

  el.panel.addEventListener("keydown", (event) => {
    const resetShortcut = event.metaKey && event.key.toLowerCase() === "j";
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || (event.metaKey && !resetShortcut)) {
      return;
    }
    // Keys typed into the shell belong to the shell, including Escape.
    if (event.target instanceof Element && event.target.closest(".terminal-tabpanel")) {
      return;
    }
    if (s.tab === "terminal") {
      if (event.key === "Escape") {
        event.preventDefault();
        toggle(false);
        focusToggle();
      }
      return;
    }
    // The file tree handles its own arrows, Enter, and Space; the changes shortcuts below do not apply to it.
    if (s.tab === "files") {
      if (event.key === "Escape") {
        event.preventDefault();
        toggle(false);
        focusToggle();
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        void refreshViews({ announce: true });
      }
      return;
    }
    if (event.key === "Escape") {
      if (event.target === el.filter && el.filter.value) {
        return;
      }
      event.preventDefault();
      if (s.openFile) {
        closeDiff();
      } else {
        toggle(false);
        focusToggle();
      }
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }
    // Nested buttons and group summaries in the list keep their native keyboard behavior.
    const inList = event.target === el.list;
    if (resetShortcut) {
      event.preventDefault();
      resetActive(inList);
      return;
    }
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (inList) {
          event.preventDefault();
          moveActive(event.key === "ArrowDown" ? 1 : -1);
        }
        return;
      case "Enter":
        if (inList) {
          event.preventDefault();
          openItem(s.navigableItems.find((item) => item.key === s.activeKey));
          el.list.focus();
        }
        return;
      case "n":
      case "N":
        event.preventDefault();
        moveHunk(1);
        return;
      case "p":
      case "P":
        event.preventDefault();
        moveHunk(-1);
        return;
      case "s":
      case "S":
        event.preventDefault();
        stageActive(inList);
        return;
      case "w":
      case "W":
        event.preventDefault();
        toggleWrap();
        return;
      case "r":
      case "R":
        event.preventDefault();
        void refreshAll({ announce: true });
        return;
      default:
    }
  });

  document.addEventListener("keydown", (event) => {
    if (
      event.isComposing || event.keyCode === 229 ||
      !event.ctrlKey || !event.shiftKey || event.metaKey || event.altKey ||
      (event.code !== "KeyG" && event.key.toLowerCase() !== "g")
    ) {
      return;
    }
    event.preventDefault();
    toggle();
    if (s.open) {
      if (s.tab === "terminal") {
        terminal?.focus();
      } else if (s.tab === "files") {
        filesPanel?.focus();
      } else {
        el.list.focus();
      }
    }
  });

  const refreshOnFocus = () => {
    if (s.open && s.repository && document.visibilityState === "visible" &&
        Date.now() - s.statusAt > focusRefreshAgeMs) {
      refreshStatusAndRender();
      filesPanel?.refresh();
    }
  };
  window.addEventListener("focus", refreshOnFocus);
  document.addEventListener("visibilitychange", refreshOnFocus);

  applyWidth(s.width);
  render();

  return {
    revealSelection: revealDiffSelection,
    get open() {
      return s.open;
    },
    toggle,
    setEditorUrlTemplate(template) {
      s.editorUrlTemplate = typeof template === "string" && template ? template : null;
      if (s.open) {
        renderDiffArea();
      }
    },
    setTerminalEnabled,
    openTerminal,
    setReplyBusy(busy) {
      s.replyBusy = busy === true;
      renderRepositoryRow();
      renderSuggestion();
      void followPendingRepository();
    },
    setSession(session) {
      const sessionId = session?.sessionId ?? null;
      if (sessionId === (s.session?.sessionId ?? null)) {
        if (s.session && session?.cwd && s.session.cwd !== session.cwd) {
          s.session.cwd = session.cwd;
          renderToolbar();
        }
        return;
      }
      const carried = repositoryCarry;
      repositoryCarry = null;
      window.clearTimeout(s.toolRefreshTimer);
      setRepositoryMenuOpen(false);
      const record = sessionId ? repositoryRecords.get(sessionId) : undefined;
      s.session = session ? { sessionId, cwd: session.cwd ?? "" } : null;
      s.sessionToken += 1;
      s.repoToken += 1;
      s.sessionRoot = null;
      s.editedRoot = null;
      s.sessionName = null;
      s.status = null;
      s.statusAt = 0;
      s.error = null;
      s.loading = false;
      s.repository = null;
      s.repositoryChosen = false;
      s.repositoryFromStorage = false;
      s.automaticRoot = record?.automaticRoot;
      s.suggestedRoot = record?.suggestedRoot ?? null;
      s.followRoot = record?.followRoot ?? null;
      setDecisionPending(suggestionVisible());
      s.activeKey = null;
      s.filter = "";
      el.filter.value = "";
      resetDiff();
      el.panel.dataset.view = "list";
      if (carried?.sessionId === sessionId) {
        setRepository(carried.root);
        s.repositoryChosen = true;
        updateRecord(sessionId, { choice: carried.root });
      }
      render();
      void refreshAll();
    },
    notifyToolCompletion(sessionId) {
      if (sessionId !== s.session?.sessionId) {
        return;
      }
      window.clearTimeout(s.toolRefreshTimer);
      s.toolRefreshTimer = window.setTimeout(() => void refreshViews(), toolRefreshDelayMs);
    },
    notifyPromptComplete(sessionId) {
      if (sessionId !== s.session?.sessionId) {
        return;
      }
      window.clearTimeout(s.toolRefreshTimer);
      void refreshViews();
    },
    forgetSession(sessionId) {
      repositoryRecords.delete(sessionId);
      loadedRecords.delete(sessionId);
      unsavedRecordChanges.delete(sessionId);
    },
    // Before a conversation exists, an explicit choice becomes its working directory; automatic choices never do.
    repositoryForPrompt(sessionId) {
      const explicit = s.repositoryChosen || s.repositoryFromStorage;
      return explicit && s.repository && (s.session?.sessionId ?? null) === (sessionId ?? null) ? s.repository : null;
    },
    carryRepositoryChoice(fromSessionId, toSessionId) {
      const explicit = s.repositoryChosen || s.repositoryFromStorage;
      repositoryCarry = explicit && s.repository && toSessionId && (s.session?.sessionId ?? null) === (fromSessionId ?? null)
        ? { sessionId: toSessionId, root: s.repository }
        : null;
    }
  };
}
