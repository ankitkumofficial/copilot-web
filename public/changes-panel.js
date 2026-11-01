import { hunkText, parseUnifiedDiff, renderDiff } from "./diff-view.js";

const openStorageKey = "copilot-web-changes-open";
const widthStorageKey = "copilot-web-changes-width";
const wrapStorageKey = "copilot-web-changes-wrap";
const repositoryStoragePrefix = "copilot-web-changes-repo:";
const maximumRepositoryChoices = 200;
const defaultWidth = 480;
const minimumWidth = 320;
const initialRenderLines = 3_000;
const toolRefreshDelayMs = 750;
const focusRefreshAgeMs = 2_000;
const projectRepositoriesMaxAgeMs = 30_000;
const filterThreshold = 20;

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

function readRepositoryChoice(sessionId) {
  const stored = readStorage(`${repositoryStoragePrefix}${sessionId}`);
  if (!stored) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored);
    return typeof parsed?.root === "string" ? { root: parsed.root, explicit: parsed.explicit !== false } : null;
  } catch {
    return null;
  }
}

// Only choices made in the picker are remembered; otherwise the conversation's directory decides.
function saveRepositoryChoice(sessionId, root) {
  writeStorage(`${repositoryStoragePrefix}${sessionId}`, JSON.stringify({ root, savedAt: Date.now() }));
  try {
    const entries = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(repositoryStoragePrefix)) {
        let savedAt = 0;
        try {
          savedAt = Number(JSON.parse(window.localStorage.getItem(key))?.savedAt) || 0;
        } catch {
          savedAt = 0;
        }
        entries.push({ key, savedAt });
      }
    }
    entries.sort((left, right) => left.savedAt - right.savedAt);
    for (const entry of entries.slice(0, Math.max(0, entries.length - maximumRepositoryChoices))) {
      window.localStorage.removeItem(entry.key);
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
  attachFiles,
  terminal = null,
  notify = () => {}
}) {
  const query = (selector) => document.querySelector(selector);
  const el = {
    workspace: query("#workspace"),
    workspaceBody: query("#workspace-body"),
    toggle: query("#changes-toggle"),
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
    tabChanges: query("#repository-tab-changes"),
    tabTerminal: query("#repository-tab-terminal"),
    tabsRow: query(".repository-tabs"),
    changesTabpanel: query("#changes-tabpanel"),
    terminalTabpanel: query("#terminal-tabpanel"),
    // Created from a template only while the terminal is enabled, so a disabled server leaves no menu entry.
    terminalAction: null,
    stage: query("#changes-stage"),
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
    resetConfirm: query("#changes-reset-confirm")
  };

  const storedWidth = Number(readStorage(widthStorageKey));
  const s = {
    open: readStorage(openStorageKey) === "true",
    width: Number.isFinite(storedWidth) && storedWidth >= minimumWidth ? storedWidth : defaultWidth,
    expanded: false,
    wrap: readStorage(wrapStorageKey) === "true",
    // The terminal tab exists only when the server enables it; the tab resets to Changes when it does not.
    terminalEnabled: false,
    tab: "changes",
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
    navigableItems: [],
    updatedAt: 0
  };
  // A repository chosen before its conversation existed, handed to the session created from it.
  let repositoryCarry = null;

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

  function applyTabs() {
    syncTerminalAction();
    const onChanges = s.tab !== "terminal" || !s.terminalEnabled;
    el.tabTerminal.hidden = !s.terminalEnabled;
    el.tabChanges.setAttribute("aria-selected", String(onChanges));
    el.tabChanges.tabIndex = onChanges ? 0 : -1;
    el.tabTerminal.setAttribute("aria-selected", String(!onChanges));
    el.tabTerminal.tabIndex = onChanges ? -1 : 0;
    el.changesTabpanel.hidden = !onChanges;
    el.terminalTabpanel.hidden = onChanges;
    el.refresh.hidden = !onChanges;
    el.panel.dataset.tab = onChanges ? "changes" : "terminal";
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
      render();
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
      s.tab = "changes";
    }
    render();
  }

  // The Repository action shows the Changes view. From the terminal view it switches there rather than closing.
  function openRepositoryView() {
    if (s.open && s.tab === "changes") {
      toggle(false);
      return;
    }
    setTab("changes");
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

  el.tabChanges.addEventListener("click", () => setTab("changes"));
  el.tabTerminal.addEventListener("click", () => setTab("terminal"));
  el.tabsRow.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    const tab = s.tab === "terminal" ? "changes" : "terminal";
    setTab(tab);
    (tab === "terminal" ? el.tabTerminal : el.tabChanges).focus();
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
    splitStart = { pointerId: event.pointerId, y: event.clientY, height: el.list.getBoundingClientRect().height };
    el.splitResizer.setPointerCapture(event.pointerId);
  });
  el.splitResizer.addEventListener("pointermove", (event) => {
    if (splitStart && event.pointerId === splitStart.pointerId) {
      setListHeight(splitStart.height + event.clientY - splitStart.y);
    }
  });
  const finishSplit = () => {
    splitStart = null;
  };
  el.splitResizer.addEventListener("pointerup", finishSplit);
  el.splitResizer.addEventListener("pointercancel", finishSplit);
  el.splitResizer.addEventListener("keydown", (event) => {
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

  // A repository picked in the panel stays; otherwise the latest edited repository, then the working directory, decides.
  function chooseRepository() {
    if (s.repository && (s.repositoryFromStorage || s.repositoryChosen)) {
      return;
    }
    const stored = s.session ? readRepositoryChoice(s.session.sessionId) : null;
    if (stored?.explicit) {
      setRepository(stored.root);
      s.repositoryFromStorage = true;
      return;
    }
    setRepository(s.editedRoot ?? s.sessionRoot);
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
      }
      chooseRepository();
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

  function refreshStatus() {
    const repository = s.repository;
    if (!repository) {
      return Promise.resolve();
    }
    const existing = s.statusInFlight.get(repository);
    if (existing) {
      s.statusQueued.add(repository);
      return existing;
    }
    const repoToken = s.repoToken;
    const mutations = s.mutations;
    const pending = (async () => {
      try {
        const status = await api(`/api/git/status?repo=${encodeURIComponent(repository)}`);
        // A read that overlapped a stage or unstage may show the index from before the change.
        if (repoToken !== s.repoToken || mutations !== s.mutations) {
          return;
        }
        applyStatus(status);
      } catch (error) {
        if (repoToken !== s.repoToken) {
          return;
        }
        if (error?.code === "repository_not_allowed" && s.repositoryFromStorage && s.session) {
          writeStorage(`${repositoryStoragePrefix}${s.session.sessionId}`, null);
          s.repositoryFromStorage = false;
          s.repository = null;
          s.repoToken += 1;
          chooseRepository();
          if (s.repository && s.repository !== repository) {
            s.statusInFlight.delete(repository);
            await refreshStatus();
            return;
          }
        }
        throw error;
      } finally {
        if (s.statusInFlight.get(repository) === pending) {
          s.statusInFlight.delete(repository);
        }
        if (s.statusQueued.delete(repository) && repository === s.repository) {
          void refreshStatus().then(render, (error) => {
            s.error = describeError(error);
            render();
          });
        }
      }
    })();
    s.statusInFlight.set(repository, pending);
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

  function applyStatus(status) {
    const previousOpen = openFileEntry();
    s.status = status;
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

  function openItem(item) {
    if (!item?.selectable) {
      return;
    }
    s.activeKey = item.key;
    resetDiff();
    s.openFile = {
      key: item.key,
      path: item.path,
      oldPath: item.oldPath ?? null,
      status: item.status ?? null,
      section: item.section
    };
    el.panel.dataset.view = "diff";
    render();
    void loadDiff();
  }

  function closeDiff() {
    resetDiff();
    el.panel.dataset.view = "list";
    render();
    el.list.focus();
  }

  function selectRepository(root) {
    if (!root || root === s.repository) {
      return;
    }
    s.repository = root;
    s.repositoryChosen = true;
    s.repositoryFromStorage = false;
    s.repoToken += 1;
    s.status = null;
    s.activeKey = null;
    resetDiff();
    el.panel.dataset.view = "list";
    if (s.session) {
      saveRepositoryChoice(s.session.sessionId, root);
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

  // ---- rendering -------------------------------------------------------

  function announce(message) {
    el.live.textContent = "";
    window.setTimeout(() => {
      el.live.textContent = message;
    }, 30);
  }

  function announceSummary() {
    if (!s.status) {
      return;
    }
    const count = s.status.totals?.files ?? 0;
    announce(count === 0
      ? `No uncommitted changes in ${s.status.name}`
      : `${count} uncommitted file${count === 1 ? "" : "s"} in ${s.status.name}`);
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
    const count = status?.totals?.files ?? 0;
    el.badge.hidden = !status || count === 0;
    el.badge.textContent = status ? badgeText(count, status.truncated) : "";
    const label = status && count > 0
      ? `Repository, ${badgeText(count, status.truncated)} uncommitted file${count === 1 ? "" : "s"}`
      : "Repository";
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
    el.repository.disabled = outsideRepositoryRoots().length === 0 && projects.length === 0;
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

  function buildListModel() {
    const files = s.status && s.status.root === s.repository && Array.isArray(s.status.files) ? s.status.files : [];
    const fileItem = (file) => ({
      kind: "file",
      key: `${file.section}:${file.path}`,
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      section: file.section,
      file,
      selectable: true
    });
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

  function resetButton(item) {
    const deletesFile = isNewFile(item);
    const button = element("button", "changes-file-action changes-file-action-reset");
    button.type = "button";
    button.tabIndex = -1;
    button.disabled = s.staging.has(item.key);
    button.title = deletesFile ? "Reset (deletes new file)" : "Reset changes";
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
    if (!s.repository) {
      el.list.append(emptyState(
        s.loading ? "Loading…" : "Choose a repository to see its uncommitted changes."
      ));
      el.summary.textContent = "";
      el.filter.hidden = true;
      return;
    }
    if (!s.status || s.status.root !== s.repository) {
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
      el.list.append(emptyState(`No uncommitted changes in ${status.name}.`));
    } else if (model.groups.every((group) => group.items.length === 0)) {
      el.list.append(emptyState("No files match the filter."));
    }
    let index = 0;
    for (const group of model.groups) {
      if (group.items.length === 0) {
        continue;
      }
      const section = element("div", `changes-group changes-group-${group.id}`);
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", group.title);
      const header = element("div", "changes-group-title");
      header.append(element("span", "", group.title), element("span", "changes-group-count", sectionTotals(group.items)));
      section.append(header);
      el.list.append(section);
      for (const item of group.items) {
        s.navigableItems.push(item);
        section.append(rowFor(item, index));
        index += 1;
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
    const file = s.openFile;
    el.diff.hidden = !file;
    el.splitResizer.hidden = !file;
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

  function render() {
    applyOpen();
    renderToolbar();
    syncTerminalRepository();
    if (!s.open) {
      return;
    }
    renderHeader();
    renderRepositoryRow();
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

  function askCopilot(hunk = null) {
    const file = s.openFile;
    if (!file || !s.repository) {
      return;
    }
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

  // Staging changes only the Git index; the worktree is never touched.
  async function setStaged(item) {
    if (!s.repository || !item || s.staging.has(item.key)) {
      return;
    }
    const action = item.section === "unstaged" ? "stage" : "unstage";
    const repository = s.repository;
    const repoToken = s.repoToken;
    const focus = el.stage === document.activeElement ? "stage" : el.list.contains(document.activeElement) ? "list" : null;
    s.staging.add(item.key);
    if (s.openFile?.key === item.key) {
      el.stage.disabled = true;
    }
    renderList();
    try {
      const status = await api("/api/git/stage", {
        method: "POST",
        body: JSON.stringify({ repo: repository, path: item.path, action })
      });
      if (repoToken === s.repoToken) {
        s.mutations += 1;
        const movedKey = `${action === "stage" ? "staged" : "unstaged"}:${item.path}`;
        const wasActive = s.activeKey === item.key;
        applyStatus(status);
        if (wasActive) {
          s.activeKey = status.files.some((file) => `${file.section}:${file.path}` === movedKey) ? movedKey : null;
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
      if (focus === "stage" && !el.stage.disabled) {
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
    if (!(await confirmReset(item)) || repoToken !== s.repoToken) {
      return;
    }
    s.staging.add(item.key);
    render();
    try {
      const status = await api("/api/git/reset", {
        method: "POST",
        body: JSON.stringify({ repo: repository, path: item.path })
      });
      if (repoToken === s.repoToken) {
        s.mutations += 1;
        const wasActive = s.activeKey === item.key;
        applyStatus(status);
        if (wasActive) {
          // After a reset, only the staged part of the file, if any, is left to highlight.
          const stagedKey = `staged:${item.path}`;
          s.activeKey = status.files.some((file) => `${file.section}:${file.path}` === stagedKey) ? stagedKey : null;
        }
        announce(isNewFile(item) ? `${item.path} deleted` : `${item.path} reset`);
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
      }
    }
  }

  function stageActive(inList) {
    const target = inList ? s.navigableItems.find((item) => item.key === s.activeKey) : openFileTarget();
    if (target) {
      void setStaged(target);
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
  el.refresh.addEventListener("click", () => void refreshAll({ announce: true }));
  el.expand.addEventListener("click", () => {
    s.expanded = !s.expanded;
    applyOpen();
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
  el.filter.addEventListener("input", () => {
    s.filter = el.filter.value.trim();
    renderList();
  });
  el.diffBack.addEventListener("click", closeDiff);
  el.diffClose.addEventListener("click", closeDiff);
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
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
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
      } else {
        el.list.focus();
      }
    }
  });

  const refreshOnFocus = () => {
    if (s.open && s.repository && document.visibilityState === "visible" &&
        Date.now() - s.statusAt > focusRefreshAgeMs) {
      refreshStatusAndRender();
    }
  };
  window.addEventListener("focus", refreshOnFocus);
  document.addEventListener("visibilitychange", refreshOnFocus);

  applyWidth(s.width);
  render();

  return {
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
      s.activeKey = null;
      s.filter = "";
      el.filter.value = "";
      resetDiff();
      el.panel.dataset.view = "list";
      if (carried?.sessionId === sessionId) {
        setRepository(carried.root);
        s.repositoryChosen = true;
        saveRepositoryChoice(sessionId, carried.root);
      }
      render();
      void refreshAll();
    },
    notifyToolCompletion(sessionId) {
      if (sessionId !== s.session?.sessionId) {
        return;
      }
      window.clearTimeout(s.toolRefreshTimer);
      s.toolRefreshTimer = window.setTimeout(() => void refreshAll(), toolRefreshDelayMs);
    },
    notifyPromptComplete(sessionId) {
      if (sessionId !== s.session?.sessionId) {
        return;
      }
      window.clearTimeout(s.toolRefreshTimer);
      void refreshAll();
    },
    forgetSession(sessionId) {
      writeStorage(`${repositoryStoragePrefix}${sessionId}`, null);
    },
    // The explicit repository choice is what Copilot is told with each message; automatic choices are not.
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
