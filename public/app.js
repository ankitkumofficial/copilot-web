const defaultBrandName = "Copilot Web";
const defaultBrandInitial = "C";
const contextStorageKey = "copilot-web-context";
const activeSessionStorageKey = "copilot-web-active-session";
const screenWakeLockStorageKey = "copilot-web-keep-awake";
const contextPreferences = ["default", "long_context"];
const maximumAttachmentCount = 10;
const maximumAttachmentBytes = 8 * 1024 * 1024;
const maximumAttachmentTotalBytes = 16 * 1024 * 1024;
const messagesBottomThreshold = 80;
const imageMimeTypesByExtension = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

function readContextPreference() {
  try {
    const stored = window.localStorage.getItem(contextStorageKey);
    return contextPreferences.includes(stored) ? stored : "default";
  } catch {
    return "default";
  }
}

function hasStoredContextPreference() {
  try {
    return contextPreferences.includes(window.localStorage.getItem(contextStorageKey));
  } catch {
    return false;
  }
}

function readActiveSessionId() {
  try {
    const sessionId = window.localStorage.getItem(activeSessionStorageKey);
    return sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

function saveActiveSessionId(sessionId) {
  try {
    window.localStorage.setItem(activeSessionStorageKey, sessionId);
  } catch {
    // Session restoration is a convenience; continue if storage is unavailable.
  }
}

function clearActiveSessionId() {
  try {
    window.localStorage.removeItem(activeSessionStorageKey);
  } catch {
    // Session restoration is a convenience; continue if storage is unavailable.
  }
}

function createConversationState(sessionId = null) {
  return {
    sessionId,
    loaded: sessionId === null,
    messages: [],
    messageKeys: new Map(),
    attachments: [],
    draft: "",
    promptQueue: [],
    syntheticMessageCounter: 0,
    lastStreamRole: null,
    currentTurnKey: null,
    currentAssistantMessageKey: null,
    currentAssistantTurnKey: null,
    currentToolGroupKey: null,
    toolGroupCounter: 0,
    configOptions: [],
    configOverrides: {},
    sessionContext: null,
    activeSessionIsNew: false,
    activeSessionTitleOverride: null,
    usage: {
      aicNano: null,
      aicLimit: null
    },
    contextUsage: {
      used: null,
      size: null
    },
    usageRevision: 0,
    status: "Ready",
    busy: false,
    activePromptKey: null,
    activePrompt: null,
    cancelRequested: false,
    recoveredPrompt: false,
    recoveredPromptId: null,
    recoveredPromptPollTimer: null,
    promptRunId: 0,
    promptRequestController: null,
    loading: false,
    configurationBusy: false,
    attachmentBusy: false,
    pendingPermission: null,
    drainPromise: null
  };
}

const state = {
  brandName: defaultBrandName,
  brandInitial: defaultBrandInitial,
  sessions: [],
  conversations: new Map(),
  composer: createConversationState(),
  activeSessionId: null,
  capabilities: {
    promptCapabilities: {
      image: false,
      audio: false,
      embeddedContext: false
    },
    sessionCapabilities: {
      delete: false
    }
  },
  projectsDirectory: "",
  newSessionDefaults: null,
  selectedContext: readContextPreference(),
  deletingSessionId: null,
  renamingSessionId: null,
  permissionDialogSessionId: null,
  connectionStatus: "connecting",
  connectionLabel: "Connecting..."
};

function conversationState(sessionId, create = true) {
  if (!sessionId) {
    return state.composer;
  }
  let conversation = state.conversations.get(sessionId);
  if (!conversation && create) {
    conversation = createConversationState(sessionId);
    state.conversations.set(sessionId, conversation);
  }
  return conversation ?? null;
}

function activeConversation() {
  return conversationState(state.activeSessionId, false);
}

function currentComposerConversation() {
  return activeConversation() ?? state.composer;
}

function isActiveConversation(conversation) {
  return conversation === activeConversation();
}
let defaultsRequestId = 0;
const eventReconnectInitialDelayMs = 1000;
const eventReconnectMaximumDelayMs = 5000;
let eventSource = null;
let eventReconnectTimer = null;
let eventReconnectDelayMs = eventReconnectInitialDelayMs;
let eventReconnectInProgress = false;
const pendingPromptCompletions = new Map();
const serverPromptStates = new Map();
let serverPromptRevision = 0;
let serverPromptRequestId = 0;
let lastSessionListRequestId = 0;

const elements = {
  statusFavicon: document.querySelector("#app-favicon"),
  brandMark: document.querySelector("#brand-mark"),
  brandName: document.querySelector("#brand-name"),
  newChat: document.querySelector("#new-chat"),
  search: document.querySelector("#session-search"),
  sessionList: document.querySelector("#session-list"),
  connectionStatus: document.querySelector("#connection-status"),
  connectionLabel: document.querySelector("#connection-label"),
  themeToggle: document.querySelector("#theme-toggle"),
  sidebarToggle: document.querySelector("#sidebar-toggle"),
  appShell: document.querySelector(".app-shell"),
  sidebarResizer: document.querySelector("#sidebar-resizer"),
  modelSelect: document.querySelector("#model-select"),
  contextSelect: document.querySelector("#context-select"),
  reasoningSelect: document.querySelector("#reasoning-select"),
  usageSummary: document.querySelector("#usage-summary"),
  usageAicMetric: document.querySelector("#usage-aic-metric"),
  usageAic: document.querySelector("#usage-aic"),
  usageContextMetric: document.querySelector("#usage-context-metric"),
  usageContext: document.querySelector("#usage-context"),
  messages: document.querySelector("#messages"),
  scrollToBottom: document.querySelector("#scroll-to-bottom"),
  emptyState: document.querySelector("#empty-state"),
  loadingState: document.querySelector("#loading-state"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#prompt-input"),
  attachmentList: document.querySelector("#attachment-list"),
  dropHint: document.querySelector("#drop-hint"),
  attachFiles: document.querySelector("#attach-files"),
  fileInput: document.querySelector("#file-input"),
  keepAwake: document.querySelector("#keep-awake"),
  keepAwakeStatus: document.querySelector("#keep-awake-status"),
  reconnectTools: document.querySelector("#reconnect-tools"),
  send: document.querySelector("#send-prompt"),
  cancel: document.querySelector("#cancel-prompt"),
  permissionDialog: document.querySelector("#permission-dialog"),
  permissionTitle: document.querySelector("#permission-title"),
  permissionDescription: document.querySelector("#permission-description"),
  permissionOptions: document.querySelector("#permission-options"),
  permissionCancel: document.querySelector("#permission-cancel"),
  deleteDialog: document.querySelector("#delete-dialog"),
  deleteForm: document.querySelector("#delete-form"),
  deleteConfirm: document.querySelector("#delete-confirm"),
  deleteTitle: document.querySelector("#delete-title"),
  deleteDescription: document.querySelector("#delete-description"),
  renameDialog: document.querySelector("#rename-dialog"),
  renameForm: document.querySelector("#rename-form"),
  renameTitle: document.querySelector("#rename-title"),
  renameInput: document.querySelector("#rename-input"),
  renameConfirm: document.querySelector("#rename-confirm"),
  imagePreviewDialog: document.querySelector("#image-preview-dialog"),
  imagePreviewImage: document.querySelector("#image-preview-image")
};

const screenWakeLock = {
  enabled: typeof navigator.wakeLock?.request === "function" && readScreenWakeLockPreference(),
  sentinel: null,
  busy: false,
  pageActive: true,
  error: null
};

function readScreenWakeLockPreference() {
  try {
    return window.localStorage.getItem(screenWakeLockStorageKey) === "true";
  } catch (error) {
    console.warn("Unable to restore the keep-awake preference", error);
    return false;
  }
}

function setScreenWakeLockEnabled(enabled) {
  screenWakeLock.enabled = enabled;
  try {
    window.localStorage.setItem(screenWakeLockStorageKey, String(enabled));
  } catch (error) {
    console.warn("Unable to save the keep-awake preference; it may reset after a refresh", error);
  }
}

function shouldKeepScreenAwake() {
  return screenWakeLock.enabled && screenWakeLock.pageActive &&
    document.visibilityState === "visible";
}

function renderScreenWakeLock() {
  const supported = typeof navigator.wakeLock?.request === "function";
  const active = screenWakeLock.sentinel !== null && !screenWakeLock.sentinel.released;
  const status = screenWakeLock.error ? "error"
    : active ? "on" : screenWakeLock.enabled ? "paused" : "off";
  const label = !supported ? "Keep awake: Unavailable in this browser"
    : screenWakeLock.error ? `Keep awake: ${screenWakeLock.error}`
    : screenWakeLock.busy ? "Keep awake: Updating..."
    : active ? "Keep awake: On"
    : screenWakeLock.enabled ? "Keep awake: On (paused)" : "Keep awake: Off";
  const message = !supported ? "Screen Wake Lock requires a supported browser and HTTPS or localhost."
    : screenWakeLock.error ?? (screenWakeLock.busy ? "Updating screen wake lock..."
      : active ? "Keep awake is on while this tab is visible."
      : screenWakeLock.enabled
        ? "Keep awake is paused. Return to this tab to resume, or toggle Off and On to retry."
        : "Keep awake is off.");
  elements.keepAwake.disabled = !supported || screenWakeLock.busy;
  elements.keepAwake.dataset.status = status;
  elements.keepAwake.setAttribute("aria-pressed", String(screenWakeLock.enabled));
  elements.keepAwake.setAttribute("aria-label", label);
  elements.keepAwake.title = label;
  elements.keepAwakeStatus.textContent = message;
  elements.keepAwakeStatus.dataset.error = String(screenWakeLock.error !== null);
  elements.keepAwakeStatus.classList.toggle(
    "visually-hidden",
    !screenWakeLock.error && (status !== "paused" || screenWakeLock.busy)
  );
}

async function updateScreenWakeLock() {
  if (screenWakeLock.busy) {
    return;
  }
  const shouldHold = shouldKeepScreenAwake();
  const active = screenWakeLock.sentinel !== null && !screenWakeLock.sentinel.released;
  if (shouldHold === active) {
    renderScreenWakeLock();
    return;
  }
  screenWakeLock.busy = true;
  screenWakeLock.error = null;
  renderScreenWakeLock();
  try {
    if (shouldHold) {
      const sentinel = await navigator.wakeLock.request("screen");
      screenWakeLock.sentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (screenWakeLock.sentinel === sentinel) {
          screenWakeLock.sentinel = null;
          renderScreenWakeLock();
        }
      });
    } else {
      await screenWakeLock.sentinel.release();
      screenWakeLock.sentinel = null;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    screenWakeLock.error = `Unable to ${shouldHold ? "enable" : "disable"} keep awake: ${detail}`;
  } finally {
    screenWakeLock.busy = false;
    renderScreenWakeLock();
    if (!screenWakeLock.error && shouldHold !== shouldKeepScreenAwake()) {
      void updateScreenWakeLock();
    }
  }
}

function initialFromBrandName(name) {
  const firstCharacter = Array.from(name)[0] ?? defaultBrandInitial;
  return Array.from(firstCharacter.toUpperCase())[0] ?? defaultBrandInitial;
}

function applyBranding(value, initial) {
  const name = typeof value === "string" ? value.trim() : "";
  state.brandName = name || defaultBrandName;
  const configuredInitial = typeof initial === "string" ? initial.trim() : "";
  state.brandInitial = configuredInitial
    ? initialFromBrandName(configuredInitial)
    : initialFromBrandName(state.brandName);
  elements.brandName.textContent = state.brandName;
  elements.brandMark.textContent = state.brandInitial;
  document.title = state.brandName;
}

const statusFaviconColors = {
  connected: "#51d68a",
  connecting: "#e5b75c",
  error: "#f2788b"
};

function renderStatusFavicon(status) {
  if (!elements.statusFavicon) {
    return;
  }
  const color = statusFaviconColors[status] ?? statusFaviconColors.connecting;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="9" fill="${color}"/>
      <circle cx="16" cy="16" r="14" fill="none" stroke="${color}" stroke-opacity=".2" stroke-width="3"/>
    </svg>
  `;
  elements.statusFavicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const themeStorageKey = "copilot-web-theme";
const sidebarCollapsedStorageKey = "copilot-web-sidebar-collapsed";
const sidebarWidthStorageKey = "copilot-web-sidebar-width";
const defaultSidebarWidth = 320;
const minimumSidebarWidth = 220;
const themePreferenceNames = ["system", "light", "dark"];
let themePreference = readThemePreference();
let sidebarCollapsed = readSidebarCollapsed();
let preferredSidebarWidth = readSidebarWidth();
let sidebarWidth = clampSidebarWidth(preferredSidebarWidth);
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

function readThemePreference() {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    return themePreferenceNames.includes(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function systemTheme() {
  return systemThemeQuery.matches ? "dark" : "light";
}

function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(sidebarCollapsedStorageKey) === "true";
  } catch {
    return false;
  }
}

function readSidebarWidth() {
  try {
    const storedWidth = window.localStorage.getItem(sidebarWidthStorageKey);
    const width = Number(storedWidth);
    return storedWidth && Number.isFinite(width) && width >= minimumSidebarWidth
      ? width
      : defaultSidebarWidth;
  } catch {
    return defaultSidebarWidth;
  }
}

function maximumSidebarWidth() {
  return Math.max(
    minimumSidebarWidth,
    Math.floor(document.documentElement.clientWidth / 2)
  );
}

function clampSidebarWidth(width) {
  return Math.min(
    maximumSidebarWidth(),
    Math.max(minimumSidebarWidth, Math.round(width))
  );
}

function applySidebarWidth(width) {
  sidebarWidth = clampSidebarWidth(width);
  elements.appShell.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  elements.sidebarResizer.setAttribute("aria-valuenow", String(sidebarWidth));
  elements.sidebarResizer.setAttribute("aria-valuemax", String(maximumSidebarWidth()));
  elements.sidebarResizer.setAttribute("aria-valuetext", `${sidebarWidth} pixels`);
}

function saveSidebarWidth() {
  preferredSidebarWidth = sidebarWidth;
  try {
    window.localStorage.setItem(sidebarWidthStorageKey, String(sidebarWidth));
  } catch {
    setStatus("Sidebar width could not be saved");
  }
}

let sidebarResizeStart = null;

function startSidebarResize(event) {
  if (sidebarCollapsed || event.button !== 0 || event.isPrimary === false) {
    return;
  }

  event.preventDefault();
  sidebarResizeStart = {
    pointerId: event.pointerId,
    x: event.clientX,
    width: sidebarWidth
  };
  elements.appShell.classList.add("sidebar-resizing");
  elements.sidebarResizer.setPointerCapture(event.pointerId);
}

function updateSidebarResize(event) {
  if (!sidebarResizeStart || event.pointerId !== sidebarResizeStart.pointerId) {
    return;
  }
  applySidebarWidth(
    sidebarResizeStart.width + event.clientX - sidebarResizeStart.x
  );
}

function finishSidebarResize(event) {
  if (
    !sidebarResizeStart ||
    (event?.pointerId !== undefined && event.pointerId !== sidebarResizeStart.pointerId)
  ) {
    return;
  }
  sidebarResizeStart = null;
  elements.appShell.classList.remove("sidebar-resizing");
  saveSidebarWidth();
}

function handleSidebarResizerKeydown(event) {
  let nextWidth;
  switch (event.key) {
    case "ArrowLeft":
      nextWidth = sidebarWidth - 16;
      break;
    case "ArrowRight":
      nextWidth = sidebarWidth + 16;
      break;
    case "Home":
      nextWidth = minimumSidebarWidth;
      break;
    case "End":
      nextWidth = maximumSidebarWidth();
      break;
    default:
      return;
  }

  event.preventDefault();
  applySidebarWidth(nextWidth);
  saveSidebarWidth();
}

function applySidebarState(collapsed) {
  sidebarCollapsed = collapsed;
  elements.appShell.classList.toggle("sidebar-collapsed", collapsed);
  elements.sidebarToggle.textContent = collapsed ? "›" : "‹";
  elements.sidebarToggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  elements.sidebarToggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  elements.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  document.documentElement.dataset.sidebarCollapsed = String(collapsed);
}

function saveSidebarState(collapsed) {
  try {
    if (collapsed) {
      window.localStorage.setItem(sidebarCollapsedStorageKey, "true");
    } else {
      window.localStorage.removeItem(sidebarCollapsedStorageKey);
    }
  } catch {
    setStatus("Sidebar preference could not be saved");
  }
}

function themeLabel(preference) {
  return preference.charAt(0).toUpperCase() + preference.slice(1);
}

function nextThemePreference(preference) {
  const currentIndex = themePreferenceNames.indexOf(preference);
  return themePreferenceNames[(currentIndex + 1) % themePreferenceNames.length];
}

function applyTheme(preference) {
  const resolvedTheme = preference === "system" ? systemTheme() : preference;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themePreference = preference;
  const nextPreference = nextThemePreference(preference);
  elements.themeToggle.textContent = preference === "system"
    ? "◐"
    : preference === "light"
      ? "☼"
      : "☾";
  elements.themeToggle.title = `Theme: ${themeLabel(preference)}. Switch to ${themeLabel(nextPreference)}.`;
  elements.themeToggle.setAttribute(
    "aria-label",
    `Theme: ${themeLabel(preference)}. Switch to ${themeLabel(nextPreference)}.`
  );
}

function saveThemePreference(preference) {
  try {
    if (preference === "system") {
      window.localStorage.removeItem(themeStorageKey);
    } else {
      window.localStorage.setItem(themeStorageKey, preference);
    }
  } catch {
    setStatus("Theme preference could not be saved");
  }
}

function saveContextPreference(preference) {
  try {
    window.localStorage.setItem(contextStorageKey, preference);
  } catch {
    setStatus("Context preference could not be saved");
  }
}

function findConfigOption(ids, category, conversation = activeConversation() ?? state.composer) {
  return conversation.configOptions.find((option) => ids.includes(option.id)) ??
    conversation.configOptions.find((option) => option.category === category) ??
    null;
}

function configOptionValues(option) {
  if (!option || !Array.isArray(option.options)) {
    return [];
  }

  return option.options.flatMap((item) => {
    if (item && typeof item === "object" && Array.isArray(item.options)) {
      return item.options;
    }
    return [item];
  }).filter((item) => (
    item &&
    typeof item === "object" &&
    typeof item.value === "string" &&
    typeof item.name === "string"
  ));
}

function renderConfigSelect(select, option, emptyLabel, conversation = activeConversation()) {
  select.replaceChildren();
  const values = configOptionValues(option);
  if (!option || values.length === 0) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = emptyLabel;
    select.append(empty);
    select.disabled = true;
    return;
  }

  for (const value of values) {
    const entry = document.createElement("option");
    entry.value = value.value;
    entry.textContent = value.name;
    if (typeof value.description === "string") {
      entry.title = value.description;
    }
    select.append(entry);
  }
  select.value = String(option.currentValue);
  select.disabled = !conversation ||
    conversation.busy ||
    conversation.loading ||
    conversation.configurationBusy;
}

function applyNewSessionDefaults(configOptions, defaults) {
  if (!defaults || !Array.isArray(configOptions)) {
    return configOptions;
  }
  return configOptions.map((option) => {
    if (
      option.id === "model" &&
      typeof defaults.model === "string" &&
      configOptionValues(option).some((value) => value.value === defaults.model)
    ) {
      return { ...option, currentValue: defaults.model };
    }
    if (
      option.id === "reasoning_effort" &&
      typeof defaults.reasoningEffort === "string" &&
      configOptionValues(option).some((value) => value.value === defaults.reasoningEffort)
    ) {
      return { ...option, currentValue: defaults.reasoningEffort };
    }
    return option;
  });
}

function applyNewSessionConfigOverrides(configOptions, overrides) {
  return configOptions.map((option) => {
    const value = overrides[option.id];
    if (
      value !== undefined &&
      configOptionValues(option).some((candidate) => candidate.value === value)
    ) {
      return { ...option, currentValue: value };
    }
    return option;
  });
}

function selectedNewSessionConfigOverrides(conversation) {
  return Object.fromEntries(
    [
      ["model", elements.modelSelect],
      ["reasoning_effort", elements.reasoningSelect]
    ].flatMap(([configId, select]) => {
      const value = select.value;
      const option = conversation.configOptions.find((candidate) => (
        candidate.id === configId
      ));
      return typeof value === "string" &&
        configOptionValues(option).some((candidate) => candidate.value === value)
        ? [[configId, value]]
        : [];
    })
  );
}

function beginServerPromptStateRequest() {
  return {
    revision: serverPromptRevision,
    requestId: ++serverPromptRequestId
  };
}

function applyServerPromptState(sessionId, result, request = null) {
  const previous = serverPromptStates.get(sessionId);
  // Preserve newer events and responses from later requests.
  if (
    request &&
    previous &&
    (
      previous.revision > request.revision ||
      previous.requestId > request.requestId
    )
  ) {
    return previous;
  }
  const promptState = {
    busy: result.busy === true,
    promptId: result.busy === true && typeof result.promptId === "string"
      ? result.promptId
      : null,
    revision: request ? previous?.revision ?? 0 : ++serverPromptRevision,
    requestId: request?.requestId ?? previous?.requestId ?? 0
  };
  serverPromptStates.set(sessionId, promptState);
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (session) {
    session.busy = promptState.busy;
    session.promptId = promptState.promptId;
  }
  return promptState;
}

function canReloadMcp(conversation) {
  return Boolean(conversation?.sessionId) &&
    !conversation.loading &&
    !conversation.configurationBusy &&
    !conversation.attachmentBusy &&
    !promptIsActive(conversation) &&
    conversation.promptQueue.length === 0 &&
    ![...serverPromptStates.values()].some((promptState) => promptState.busy) &&
    ![...state.conversations.values()].some((candidate) => (
      promptIsActive(candidate) || candidate.promptQueue.length > 0
    ));
}

function renderConfigurationControls() {
  const conversation = activeConversation() ?? state.composer;
  const configuration = conversation;
  const model = findConfigOption(["model"], "model", configuration);
  const reasoning = findConfigOption(["reasoning_effort"], "thought_level", configuration);
  renderConfigSelect(elements.modelSelect, model, "Unavailable", conversation);
  renderConfigSelect(elements.reasoningSelect, reasoning, "Unavailable", conversation);
  elements.contextSelect.value = conversation?.messages.length === 0
    ? state.selectedContext
    : conversation?.sessionContext ?? state.selectedContext;
  elements.contextSelect.disabled = Boolean(
    conversation &&
    (conversation.busy || conversation.loading || conversation.configurationBusy)
  );
  const reloadDisabled = !canReloadMcp(conversation);
  elements.reconnectTools.disabled = reloadDisabled;
  for (const retry of elements.messages.querySelectorAll(".message-retry")) {
    retry.disabled = reloadDisabled;
  }
}

function applySessionSetup(result, context, conversation = activeConversation() ?? state.composer) {
  conversation.configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
  conversation.sessionContext = typeof result.context === "string" ? result.context : context;
  renderConfigurationControls();
}

async function loadContextDefaults(context, resetToCopilotDefaults = false) {
  const requestId = ++defaultsRequestId;
  const composer = state.composer;
  const previousConfigOptions = composer.configOptions;
  const loadingComposerDefaults = !state.activeSessionId;
  const selectedModel = composer.configOverrides.model ?? state.newSessionDefaults?.model;
  const query = resetToCopilotDefaults
    ? ""
    : `?context=${encodeURIComponent(context)}${
        typeof selectedModel === "string" && selectedModel.length > 0
          ? `&model=${encodeURIComponent(selectedModel)}`
          : ""
      }`;
  composer.configOptions = [];
  if (loadingComposerDefaults) {
    composer.configurationBusy = true;
    elements.send.disabled = composer.loading ||
      composer.configurationBusy ||
      composer.attachmentBusy;
  }
  renderConfigurationControls();
  try {
    const result = await api(`/api/config${query}`);
    if (
      requestId !== defaultsRequestId ||
      state.activeSessionId ||
      (!resetToCopilotDefaults && state.selectedContext !== context)
    ) {
      return false;
    }
    state.newSessionDefaults = result.newSessionDefaults ?? state.newSessionDefaults;
    const effectiveContext = resetToCopilotDefaults ? result.context : context;
    if (!contextPreferences.includes(effectiveContext)) {
      throw new Error("Copilot returned an invalid context profile");
    }
    if (resetToCopilotDefaults) {
      state.selectedContext = effectiveContext;
      composer.sessionContext = effectiveContext;
      saveContextPreference(effectiveContext);
    }
    const configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
    for (const configId of ["model", "reasoning_effort"]) {
      const value = composer.configOverrides[configId];
      const option = configOptions.find((candidate) => candidate.id === configId);
      if (
        typeof value === "string" &&
        !configOptionValues(option).some((candidate) => candidate.value === value)
      ) {
        delete composer.configOverrides[configId];
      }
    }
    composer.configOptions = applyNewSessionConfigOverrides(
      applyNewSessionDefaults(
        configOptions,
        state.newSessionDefaults
      ),
      composer.configOverrides
    );
    renderConfigurationControls();
    return true;
  } catch (error) {
    if (requestId === defaultsRequestId && !state.activeSessionId) {
      composer.configOptions = previousConfigOptions;
      renderConfigurationControls();
      showError(error);
    }
    return false;
  } finally {
    if (
      loadingComposerDefaults &&
      requestId === defaultsRequestId &&
      state.composer === composer
    ) {
      composer.configurationBusy = false;
      elements.send.disabled = composer.loading ||
        composer.configurationBusy ||
        composer.attachmentBusy;
      renderConfigurationControls();
    }
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeLink(value) {
  const target = value.trim().replace(/^<|>$/g, "");
  if (!target) {
    return null;
  }

  try {
    const url = new URL(target, window.location.origin);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function renderInlineMarkdown(value) {
  let output = "";
  let index = 0;
  let plainTextStart = 0;

  const flushPlainText = (end) => {
    if (end > plainTextStart) {
      output += escapeHtml(value.slice(plainTextStart, end)).replaceAll("\n", "<br>");
    }
  };

  while (index < value.length) {
    if (value[index] === "\\" && index + 1 < value.length) {
      flushPlainText(index);
      output += escapeHtml(value[index + 1]);
      index += 2;
      plainTextStart = index;
      continue;
    }

    if (value[index] === "`") {
      const closing = value.indexOf("`", index + 1);
      if (closing > index + 1) {
        flushPlainText(index);
        output += `<code>${escapeHtml(value.slice(index + 1, closing))}</code>`;
        index = closing + 1;
        plainTextStart = index;
        continue;
      }
    }

    if (value[index] === "[" && value[index - 1] !== "!") {
      const labelEnd = value.indexOf("]", index + 1);
      if (labelEnd > index + 1 && value[labelEnd + 1] === "(") {
        const targetEnd = value.indexOf(")", labelEnd + 2);
        if (targetEnd > labelEnd + 2) {
          const href = safeLink(value.slice(labelEnd + 2, targetEnd));
          if (href) {
            flushPlainText(index);
            output += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${renderInlineMarkdown(value.slice(index + 1, labelEnd))}</a>`;
            index = targetEnd + 1;
            plainTextStart = index;
            continue;
          }
        }
      }
    }

    const strongMarker = value.startsWith("**", index)
      ? "**"
      : value.startsWith("__", index)
        ? "__"
        : null;
    if (strongMarker) {
      const closing = value.indexOf(strongMarker, index + strongMarker.length);
      if (closing > index + strongMarker.length) {
        flushPlainText(index);
        output += `<strong>${renderInlineMarkdown(value.slice(index + strongMarker.length, closing))}</strong>`;
        index = closing + strongMarker.length;
        plainTextStart = index;
        continue;
      }
    }

    if (value.startsWith("~~", index)) {
      const closing = value.indexOf("~~", index + 2);
      if (closing > index + 2) {
        flushPlainText(index);
        output += `<del>${renderInlineMarkdown(value.slice(index + 2, closing))}</del>`;
        index = closing + 2;
        plainTextStart = index;
        continue;
      }
    }

    const emphasisMarker = value[index] === "*" || value[index] === "_" ? value[index] : null;
    if (emphasisMarker && !value.startsWith(emphasisMarker.repeat(2), index)) {
      const closing = value.indexOf(emphasisMarker, index + 1);
      const preceding = value[index - 1];
      if (
        closing > index + 1 &&
        !(emphasisMarker === "_" && /[A-Za-z0-9]/.test(preceding ?? ""))
      ) {
        flushPlainText(index);
        output += `<em>${renderInlineMarkdown(value.slice(index + 1, closing))}</em>`;
        index = closing + 1;
        plainTextStart = index;
        continue;
      }
    }

    index += 1;
  }

  flushPlainText(value.length);
  return output;
}

function splitTableRow(value) {
  let row = String(value).trim();
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|") && !row.endsWith("\\|")) {
    row = row.slice(0, -1);
  }

  const cells = [];
  let cell = "";
  let codeSpan = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === "\\" && row[index + 1] === "|") {
      cell += "\\|";
      index += 1;
      continue;
    }
    if (character === "`") {
      codeSpan = !codeSpan;
    }
    if (character === "|" && !codeSpan) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function tableDelimiterAlignments(line) {
  const cells = splitTableRow(line);
  if (
    cells.length === 0 ||
    cells.some((cell) => !/^:?-{3,}:?$/.test(cell))
  ) {
    return null;
  }
  return cells.map((cell) => (
    cell.startsWith(":") && cell.endsWith(":")
      ? "center"
      : cell.startsWith(":")
        ? "left"
        : cell.endsWith(":")
          ? "right"
          : null
  ));
}

function renderTable(header, alignments, rows) {
  const columnCount = header.length;
  const renderCell = (cell, index, tagName) => {
    const alignment = alignments[index];
    const alignAttribute = alignment ? ` style="text-align:${alignment}"` : "";
    return `<${tagName}${alignAttribute}>${renderInlineMarkdown(cell ?? "")}</${tagName}>`;
  };
  const headerCells = header
    .slice(0, columnCount)
    .map((cell, index) => renderCell(cell, index, "th"))
    .join("");
  const bodyRows = rows.map((row) => {
    const cells = Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
    return `<tr>${cells.map((cell, index) => renderCell(cell, index, "td")).join("")}</tr>`;
  }).join("");

  return `
    <div class="markdown-table-wrap">
      <table>
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
}

function splitAttachedBoldTitle(line) {
  const match = line.match(/^(.+[.!?])(\*\*|__)([A-Z][^*\n]*?)\2[ \t]*$/);
  if (!match) {
    return null;
  }

  return {
    paragraph: match[1],
    title: `${match[2]}${match[3]}${match[2]}`
  };
}

function renderMarkdown(value) {
  const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${renderInlineMarkdown(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      flushParagraph();
      const fenceCharacter = fence[1][0];
      const fenceLength = fence[1].length;
      const codeLines = [];
      index += 1;
      while (index < lines.length) {
        const closingFence = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (
          closingFence &&
          closingFence[1][0] === fenceCharacter &&
          closingFence[1].length >= fenceLength
        ) {
          index += 1;
          break;
        }
        codeLines.push(lines[index]);
        index += 1;
      }
      const language = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : "";
      blocks.push(`<pre><code${language}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (index + 1 < lines.length && line.includes("|")) {
      const alignments = tableDelimiterAlignments(lines[index + 1]);
      if (alignments) {
        flushParagraph();
        const header = splitTableRow(line);
        const rows = [];
        index += 2;
        while (index < lines.length) {
          const tableLine = lines[index];
          if (!tableLine.trim() || !tableLine.includes("|")) {
            break;
          }
          rows.push(splitTableRow(tableLine));
          index += 1;
        }
        blocks.push(renderTable(header, alignments, rows));
        continue;
      }
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    const quote = line.match(/^ {0,3}>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      const quoteLines = [];
      while (index < lines.length) {
        const quoteLine = lines[index].match(/^ {0,3}>\s?(.*)$/);
        if (!quoteLine) {
          break;
        }
        quoteLines.push(quoteLine[1]);
        index += 1;
      }
      blocks.push(`<blockquote>${renderMarkdown(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    const unorderedItem = line.match(/^ {0,3}[-+*]\s+(.+)$/);
    if (unorderedItem) {
      flushParagraph();
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^ {0,3}[-+*]\s+(.+)$/);
        if (!item) {
          break;
        }
        items.push(`<li>${renderInlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const orderedItem = line.match(/^ {0,3}\d+[.)]\s+(.+)$/);
    if (orderedItem) {
      flushParagraph();
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^ {0,3}\d+[.)]\s+(.+)$/);
        if (!item) {
          break;
        }
        items.push(`<li>${renderInlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const attachedTitle = splitAttachedBoldTitle(line);
    if (attachedTitle) {
      paragraph.push(attachedTitle.paragraph);
      flushParagraph();
      blocks.push(`<p>${renderInlineMarkdown(attachedTitle.title)}</p>`);
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks.join("");
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
  }
  return body;
}

function selectedSession() {
  return state.sessions.find((session) => session.sessionId === state.activeSessionId) ?? null;
}

function relativeTime(value) {
  if (!value) {
    return "No activity time";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  if (seconds < 2_592_000) {
    return `${Math.floor(seconds / 86_400)}d ago`;
  }
  return date.toLocaleDateString();
}

function timestampValue(value) {
  if (typeof value !== "string") {
    return Number.NaN;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function latestTimestamp(...values) {
  const validValues = values
    .filter((value) => typeof value === "string")
    .map((value) => ({ value, timestamp: timestampValue(value) }))
    .filter((entry) => Number.isFinite(entry.timestamp));
  if (validValues.length === 0) {
    return undefined;
  }
  return validValues.reduce((latest, entry) => (
    entry.timestamp > latest.timestamp ? entry : latest
  )).value;
}

function sessionActivityAt(session) {
  return session.lastActivityAt ?? session.updatedAt;
}

function touchSessionActivity(sessionId, activityAt = new Date().toISOString()) {
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (!session) {
    return;
  }
  session.lastActivityAt = latestTimestamp(
    session.lastActivityAt,
    activityAt
  ) ?? activityAt;
}

function renderConnectionStatus() {
  const conversation = activeConversation();
  const loading = conversation?.loading === true && state.connectionStatus === "connected";
  const promptActive = conversation?.busy === true || conversation?.recoveredPrompt === true;
  const backgroundPromptCount = state.sessions
    .filter((session) => {
      if (session.sessionId === state.activeSessionId) {
        return false;
      }
      const backgroundConversation = state.conversations.get(session.sessionId);
      return session.busy === true ||
        backgroundConversation?.busy === true ||
        backgroundConversation?.recoveredPrompt === true;
    })
    .length;
  const anyPromptActive = promptActive || backgroundPromptCount > 0;
  const status = (promptActive || loading) && state.connectionStatus === "connected"
    ? "connecting"
    : state.connectionStatus;
  const faviconStatus = state.connectionStatus === "connected" && (anyPromptActive || loading)
    ? "connecting"
    : state.connectionStatus;
  const label = loading
    ? "Loading conversation..."
    : promptActive && state.connectionStatus === "connected"
      ? "Copilot is working..."
      : backgroundPromptCount > 0 && state.connectionStatus === "connected"
        ? `${backgroundPromptCount} other conversation${backgroundPromptCount === 1 ? "" : "s"} working`
      : state.connectionLabel;
  elements.connectionStatus.classList.remove("status-connected", "status-error", "status-connecting");
  elements.connectionStatus.classList.add(`status-${status}`);
  elements.connectionLabel.textContent = label;
  renderStatusFavicon(faviconStatus);
}

function setConnection(status, label) {
  state.connectionStatus = status;
  state.connectionLabel = label;
  renderConnectionStatus();
}

function promptIsActive(conversation = activeConversation()) {
  return Boolean(conversation && (conversation.busy || conversation.recoveredPrompt));
}

function updateSendPromptAction(conversation = activeConversation()) {
  const label = promptIsActive(conversation)
    ? "Interrupt current prompt and send"
    : "Send prompt";
  elements.send.title = label;
  elements.send.setAttribute("aria-label", label);
}

function setStatus(message, conversation = activeConversation() ?? state.composer) {
  if (conversation) {
    conversation.status = message;
  }
  if (conversation !== activeConversation() && conversation !== state.composer) {
    return;
  }
  const hint = elements.composer.querySelector("#composer-hint");
  const hidden = message === "Ready" || message.length === 0;
  hint.textContent = hidden ? "" : message;
  hint.hidden = hidden;
}

function resizePromptInput() {
  const styles = window.getComputedStyle(elements.input);
  const minHeight = Number.parseFloat(styles.minHeight) || 36;
  const maxHeight = Number.parseFloat(styles.maxHeight) || 130;
  elements.input.style.height = "auto";
  const nextHeight = Math.min(
    Math.max(elements.input.scrollHeight, minHeight),
    maxHeight
  );
  elements.input.style.height = `${nextHeight}px`;
  elements.input.style.overflowY = elements.input.scrollHeight > maxHeight
    ? "auto"
    : "hidden";
}

function formatAic(nanoAiu) {
  const credits = nanoAiu / 1_000_000_000;
  if (credits > 0 && credits < 0.01) {
    return "<0.01";
  }
  return credits.toFixed(2).replace(/\.?0+$/, "");
}

const contextTokenFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1
});

function formatContextTokens(tokens) {
  return contextTokenFormatter.format(tokens);
}

function renderUsage(conversation = activeConversation()) {
  if (conversation !== activeConversation()) {
    return;
  }
  const { aicNano, aicLimit } = conversation?.usage ?? {
    aicNano: null,
    aicLimit: null
  };
  const { used, size } = conversation?.contextUsage ?? {
    used: null,
    size: null
  };
  const hasAicUsage = Number.isFinite(aicNano);
  const hasContextUsage = Number.isFinite(used) &&
    used >= 0 &&
    Number.isFinite(size) &&
    size > 0;

  elements.usageAicMetric.hidden = !hasAicUsage;
  elements.usageContextMetric.hidden = !hasContextUsage;
  elements.usageSummary.hidden = !hasAicUsage && !hasContextUsage;
  elements.usageAicMetric.title =
    "Cumulative AI credit usage for this conversation; account-level quota is not included.";
  elements.usageContextMetric.title =
    "Latest ACP-reported context usage: tokens used / total context-window size.";
  if (hasAicUsage) {
    elements.usageAic.textContent = `${formatAic(aicNano)} used${
      Number.isFinite(aicLimit) ? ` / ${formatAic(aicLimit)}` : ""
    }`;
  }
  if (hasContextUsage) {
    elements.usageContext.textContent =
      `${formatContextTokens(used)} / ${formatContextTokens(size)} tokens`;
  }
}

function resetContextUsage(conversation) {
  conversation.contextUsage = {
    used: null,
    size: null
  };
}

function resetUsage(conversation = activeConversation() ?? state.composer) {
  conversation.usage = {
    aicNano: null,
    aicLimit: null
  };
  resetContextUsage(conversation);
  conversation.usageRevision += 1;
  if (conversation === activeConversation()) {
    renderUsage(conversation);
  }
}

function applySessionUsage(value, conversation, expectedRevision) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  if (
    expectedRevision !== undefined &&
    conversation.usageRevision !== expectedRevision
  ) {
    return;
  }
  conversation.usage = {
    aicNano: typeof value.aicNano === "number" && Number.isFinite(value.aicNano)
      ? value.aicNano
      : null,
    aicLimit: typeof value.aicLimit === "number" && Number.isFinite(value.aicLimit)
      ? value.aicLimit
      : null
  };
  if (conversation === activeConversation()) {
    renderUsage(conversation);
  }
}

function applyContextUsage(update, conversation) {
  const used = update.used;
  const size = update.size;
  if (
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    used < 0 ||
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    size <= 0
  ) {
    return;
  }

  conversation.contextUsage = { used, size };
  if (conversation === activeConversation()) {
    renderUsage(conversation);
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function attachmentId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fileMimeType(file) {
  const declared = String(file.type ?? "").toLowerCase().split(";", 1)[0].trim();
  if (declared.startsWith("image/") || declared === "application/pdf") {
    return declared;
  }

  const name = String(file.name ?? "").toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if (declared === "" || declared === "application/octet-stream") {
    return imageMimeTypesByExtension[extension] ??
      (extension === ".pdf" ? "application/pdf" : null);
  }
  return null;
}

function fileKey(file) {
  return [
    String(file.name ?? ""),
    String(file.size ?? 0),
    String(file.lastModified ?? 0),
    String(file.type ?? "")
  ].join(":");
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => {
      reject(new Error(`Unable to read ${file.name || "the attachment"}`));
    });
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`Unable to read ${file.name || "the attachment"}`));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0 || separator === reader.result.length - 1) {
        reject(new Error(`Attachment ${file.name || "file"} is empty`));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    });
    reader.readAsDataURL(file);
  });
}

function updateAttachmentControls() {
  const conversation = currentComposerConversation();
  const disabled = conversation.loading ||
    conversation.configurationBusy ||
    conversation.attachmentBusy;
  elements.attachFiles.disabled = disabled;
  elements.fileInput.disabled = disabled;
  renderConfigurationControls();
}

function attachmentDataUrl(attachment) {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

function renderAttachmentList() {
  elements.attachmentList.replaceChildren();
  const conversation = currentComposerConversation();
  for (const attachment of conversation.attachments) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";

    const preview = document.createElement("div");
    preview.className = "attachment-chip-preview";
    if (attachment.mimeType.startsWith("image/")) {
      const image = document.createElement("img");
      image.src = attachmentDataUrl(attachment);
      image.alt = "";
      preview.append(image);
    } else {
      preview.textContent = "PDF";
    }

    const copy = document.createElement("div");
    copy.className = "attachment-chip-copy";
    const name = document.createElement("span");
    name.className = "attachment-chip-name";
    name.textContent = attachment.name;
    const size = document.createElement("span");
    size.className = "attachment-chip-size";
    size.textContent = formatFileSize(attachment.size);
    copy.append(name, size);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.textContent = "×";
    remove.title = `Remove ${attachment.name}`;
    remove.setAttribute("aria-label", `Remove ${attachment.name}`);
    remove.addEventListener("click", () => removeAttachment(attachment.id));

    chip.append(preview, copy, remove);
    elements.attachmentList.append(chip);
  }
  updateAttachmentControls();
}

function removeAttachment(id) {
  const conversation = currentComposerConversation();
  conversation.attachments = conversation.attachments.filter((attachment) => attachment.id !== id);
  renderAttachmentList();
  setStatus(conversation.attachments.length > 0 ? "Attachments ready" : "Ready", conversation);
}

function filesFromTransfer(dataTransfer) {
  if (!dataTransfer) {
    return [];
  }
  const itemFiles = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      itemFiles.push(file);
    }
  }

  // Clipboard data can expose the same file through both collections. Use one
  // representation instead of merging them.
  return itemFiles.length > 0
    ? itemFiles
    : Array.from(dataTransfer.files ?? []);
}

function reportAttachmentErrors(errors, conversation = currentComposerConversation()) {
  for (const error of errors) {
    addMessage("system", error, null, [], conversation);
  }
}

async function addFiles(fileList) {
  const conversation = currentComposerConversation();
  if (
    conversation.loading ||
    conversation.configurationBusy ||
    conversation.attachmentBusy
  ) {
    return;
  }
  const files = Array.from(fileList ?? []);
  if (files.length === 0) {
    return;
  }

  conversation.attachmentBusy = true;
  updateAttachmentControls();
  renderRetryActions(conversation);
  const errors = [];
  let added = 0;
  try {
    for (const file of files) {
      const name = file.name || "attachment";
      const mimeType = fileMimeType(file);
      if (!mimeType) {
        errors.push(`${name} is not supported. Attach an image or PDF file.`);
        continue;
      }
      if (file.size > maximumAttachmentBytes) {
        errors.push(`${name} is too large. Files must be 8 MB or smaller.`);
        continue;
      }
      if (conversation.attachments.length >= maximumAttachmentCount) {
        errors.push(`A message can include at most ${maximumAttachmentCount} attachments.`);
        break;
      }
      if (
        conversation.attachments.reduce((total, attachment) => total + attachment.size, 0) +
          file.size >
        maximumAttachmentTotalBytes
      ) {
        errors.push("Attachments exceed the 16 MB total size limit.");
        break;
      }
      const key = fileKey(file);
      if (conversation.attachments.some((attachment) => attachment.key === key)) {
        errors.push(`${name} is already attached.`);
        continue;
      }

      setStatus(`Reading ${name}...`, conversation);
      try {
        const data = await readFileAsBase64(file);
        conversation.attachments.push({
          id: attachmentId(),
          key,
          name,
          mimeType,
          size: file.size,
          data
        });
        added += 1;
        if (isActiveConversation(conversation) || conversation === state.composer) {
          renderAttachmentList();
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Unable to read ${name}`);
      }
    }
  } finally {
    conversation.attachmentBusy = false;
    if (isActiveConversation(conversation) || conversation === state.composer) {
      updateAttachmentControls();
    }
    renderRetryActions(conversation);
  }

  if (errors.length > 0) {
    reportAttachmentErrors(errors, conversation);
  }
  if (added > 0) {
    setStatus(
      `${conversation.attachments.length} attachment${conversation.attachments.length === 1 ? "" : "s"} ready`,
      conversation
    );
  } else if (errors.length > 0) {
    setStatus("No attachments added", conversation);
  }
}

function insertTextAtCursor(text) {
  const input = elements.input;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(text, start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function handlePaste(event) {
  const files = filesFromTransfer(event.clipboardData);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text) {
    insertTextAtCursor(text);
  }
  void addFiles(files);
}

function hasFileTransfer(dataTransfer) {
  if (!dataTransfer) {
    return false;
  }
  return Array.from(dataTransfer.types ?? []).includes("Files") ||
    (dataTransfer.files?.length ?? 0) > 0;
}

let dragDepth = 0;

function clearDropTarget() {
  dragDepth = 0;
  elements.composer.classList.remove("drop-target");
  elements.dropHint.hidden = true;
}

function attachmentCapabilityError(attachments) {
  const promptCapabilities = state.capabilities.promptCapabilities ?? {};
  if (
    attachments.some((attachment) => attachment.mimeType.startsWith("image/")) &&
    promptCapabilities.image !== true
  ) {
    return "This Copilot agent does not support image attachments.";
  }
  if (
    attachments.some((attachment) => attachment.mimeType === "application/pdf") &&
    promptCapabilities.embeddedContext !== true
  ) {
    return "This Copilot agent does not support PDF attachments.";
  }
  return null;
}

applyTheme(themePreference);
applySidebarWidth(preferredSidebarWidth);
applySidebarState(sidebarCollapsed);

function renderSessionList() {
  const filter = elements.search.value.trim().toLowerCase();
  const sessions = state.sessions
    .filter((session) => {
      if (!filter) {
        return true;
      }
      return [
        session.title,
        session.cwd,
        session.sessionId
      ].filter(Boolean).join(" ").toLowerCase().includes(filter);
    })
    .sort((left, right) => {
      const rightActivity = timestampValue(sessionActivityAt(right));
      const leftActivity = timestampValue(sessionActivityAt(left));
      if (Number.isFinite(rightActivity) && Number.isFinite(leftActivity)) {
        return rightActivity - leftActivity;
      }
      return String(sessionActivityAt(right) ?? "")
        .localeCompare(String(sessionActivityAt(left) ?? ""));
    });

  elements.sessionList.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = filter ? "No matching conversations." : "No saved conversations found.";
    elements.sessionList.append(empty);
    return;
  }

  for (const session of sessions) {
    const row = document.createElement("div");
    const conversation = conversationState(session.sessionId, false);
    const title = session.title || "Untitled conversation";
    const working = session.busy === true ||
      conversation?.busy ||
      conversation?.recoveredPrompt;
    const queued = conversation?.promptQueue?.length ?? 0;
    const canDelete = state.capabilities.sessionCapabilities.delete;
    row.className = "session-item-row has-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-item${session.sessionId === state.activeSessionId ? " active" : ""}`;
    button.dataset.sessionId = session.sessionId;
    button.innerHTML = `
      <span class="session-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
      <span class="session-meta">${escapeHtml(relativeTime(sessionActivityAt(session)))}</span>
      ${working
        ? `<span class="session-status">Working${queued > 0 ? ` · ${queued} queued` : ""}</span>`
        : queued > 0
          ? `<span class="session-status">${queued} queued</span>`
          : ""}
    `;
    row.append(button);

    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "session-action session-rename";
    renameButton.title = `Rename ${session.title || "conversation"}`;
    renameButton.setAttribute(
      "aria-label",
      `Rename ${session.title || "conversation"}`
    );
    renameButton.disabled =
      state.deletingSessionId !== null ||
      state.renamingSessionId !== null;
    renameButton.innerHTML = renameSessionIconMarkup;
    renameButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void renameConversation(session.sessionId);
    });
    row.append(renameButton);

    if (canDelete) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "session-action session-delete";
      deleteButton.title = `Delete ${session.title || "conversation"}`;
      deleteButton.setAttribute(
        "aria-label",
        `Delete ${session.title || "conversation"}`
      );
      deleteButton.disabled = state.deletingSessionId !== null;
      deleteButton.innerHTML = deleteSessionIconMarkup;
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        void deleteConversation(session.sessionId);
      });
      row.append(deleteButton);
    }
    elements.sessionList.append(row);
  }
}

function renderConversationControls() {
  renderConfigurationControls();
}

const copyIconMarkup = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="8" y="8" width="11" height="12" rx="2"></rect>
    <path d="M16 8V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1"></path>
  </svg>
`;
const copiedIconMarkup = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m5 12 4 4L19 6"></path>
  </svg>
`;
const deleteSessionIconMarkup = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7l1-3h4l1 3"></path>
  </svg>
`;
const renameSessionIconMarkup = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m4 16.5-.8 3.3 3.3-.8L18.8 6.7a1.8 1.8 0 0 0 0-2.5l-1-1a1.8 1.8 0 0 0-2.5 0L4 16.5Z"></path>
    <path d="m13.8 4.2 6 6"></path>
  </svg>
`;

function messageClipboardText(message) {
  const text = typeof message.text === "string" ? message.text : "";
  const attachmentNames = Array.isArray(message.attachments)
    ? message.attachments
      .filter((attachment) => attachment && typeof attachment.name === "string")
      .map((attachment) => attachment.name)
    : [];
  if (attachmentNames.length === 0) {
    return text;
  }
  const attachmentText = `Attachments: ${attachmentNames.join(", ")}`;
  return text ? `${text}\n\n${attachmentText}` : attachmentText;
}

function messageClipboardContent(message, button) {
  const fallbackText = messageClipboardText(message);
  if (message.role !== "assistant") {
    return {
      text: fallbackText,
      html: `<div>${escapeHtml(fallbackText).replaceAll("\n", "<br>")}</div>`
    };
  }

  const body = button.closest(".message")?.querySelector(".message-body");
  const html = body?.innerHTML ?? renderMarkdown(fallbackText);
  const text = body?.innerText || body?.textContent || fallbackText;
  return { text, html };
}

async function copyRichMarkupWithLegacyApi(html) {
  const helper = document.createElement("div");
  helper.innerHTML = html;
  helper.setAttribute("contenteditable", "true");
  helper.setAttribute("aria-hidden", "true");
  helper.style.position = "fixed";
  helper.style.top = "0";
  helper.style.left = "-9999px";
  document.body.append(helper);

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(helper);
  selection?.removeAllRanges();
  selection?.addRange(range);
  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard access is unavailable");
    }
  } finally {
    selection?.removeAllRanges();
    helper.remove();
  }
}

async function copyToClipboard({ text, html }) {
  if (
    navigator.clipboard &&
    typeof navigator.clipboard.write === "function" &&
    typeof ClipboardItem === "function"
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" })
        })
      ]);
      return;
    } catch {
      // Fall back to the legacy API when rich clipboard access is unavailable.
    }
  }

  try {
    await copyRichMarkupWithLegacyApi(html);
    return;
  } catch {
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error("Clipboard access is unavailable");
  }
}

async function copyMessage(message, button) {
  try {
    await copyToClipboard(messageClipboardContent(message, button));
    button.classList.add("copied");
    button.innerHTML = copiedIconMarkup;
    button.title = "Copied";
    button.setAttribute("aria-label", "Copied");
    window.setTimeout(() => {
      button.classList.remove("copied");
      button.innerHTML = copyIconMarkup;
      button.title = "Copy message";
      button.setAttribute("aria-label", "Copy message");
    }, 1400);
  } catch {
    setStatus("Could not copy message");
    button.title = "Could not copy message";
    button.setAttribute("aria-label", "Could not copy message");
  }
}

function nextSyntheticMessageKey(role, conversation = activeConversation() ?? state.composer) {
  conversation.syntheticMessageCounter += 1;
  return `${role}:synthetic:${conversation.syntheticMessageCounter}`;
}

function resetStreamTracking(conversation = activeConversation() ?? state.composer) {
  conversation.syntheticMessageCounter = 0;
  conversation.lastStreamRole = null;
  conversation.currentTurnKey = null;
  conversation.currentAssistantMessageKey = null;
  conversation.currentAssistantTurnKey = null;
  conversation.currentToolGroupKey = null;
  conversation.toolGroupCounter = 0;
}

function streamMessageKey(
  role,
  update,
  conversation = activeConversation() ?? state.composer
) {
  const messageId = update && update.messageId;
  if (typeof messageId === "string" || typeof messageId === "number") {
    const key = `${role}:${messageId}`;
    if (role === "user") {
      conversation.currentToolGroupKey = `tool-group:${key}`;
      conversation.currentTurnKey = key;
      conversation.currentAssistantMessageKey = null;
      conversation.currentAssistantTurnKey = null;
    } else if (role === "assistant") {
      if (conversation.lastStreamRole !== "assistant") {
        conversation.currentToolGroupKey = null;
      }
      conversation.currentAssistantMessageKey = key;
      conversation.currentAssistantTurnKey = conversation.currentTurnKey;
    }
    conversation.lastStreamRole = role;
    return key;
  }

  if (role === "user") {
    const key = nextSyntheticMessageKey("user", conversation);
    conversation.currentToolGroupKey = `tool-group:${key}`;
    conversation.currentTurnKey = key;
    conversation.currentAssistantMessageKey = null;
    conversation.currentAssistantTurnKey = null;
    conversation.lastStreamRole = role;
    return key;
  }

  if (
    role === "assistant" &&
    conversation.lastStreamRole === "assistant" &&
    conversation.currentAssistantMessageKey &&
    conversation.currentAssistantTurnKey === conversation.currentTurnKey
  ) {
    conversation.lastStreamRole = role;
    return conversation.currentAssistantMessageKey;
  }

  if (role === "assistant") {
    conversation.currentToolGroupKey = null;
  }
  const key = nextSyntheticMessageKey(role, conversation);
  if (role === "assistant") {
    conversation.currentAssistantMessageKey = key;
    conversation.currentAssistantTurnKey = conversation.currentTurnKey;
  }
  conversation.lastStreamRole = role;
  return key;
}

function toolStatusLabel(status) {
  switch (status) {
    case "in_progress":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "pending":
      return "Queued";
    default:
      return status ? String(status) : "Updated";
  }
}

function toolStatusClass(status) {
  return String(status ?? "updated")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
}

function ensureToolGroup(conversation = activeConversation() ?? state.composer) {
  conversation.lastStreamRole = "tool";
  if (!conversation.currentToolGroupKey) {
    conversation.toolGroupCounter += 1;
    conversation.currentToolGroupKey = `tool-group:orphan:${conversation.toolGroupCounter}`;
  }

  let group = conversation.messages.find((message) => (
    message.role === "tool" &&
    message.toolGroupKey === conversation.currentToolGroupKey
  ));
  if (!group) {
    group = {
      role: "tool",
      text: "",
      toolGroupKey: conversation.currentToolGroupKey,
      toolActivities: [],
      toolActivitiesExpanded: false,
      thinkingText: "",
      thinkingExpanded: false
    };
    conversation.messages.push(group);
  }
  return group;
}

function updateContentText(update) {
  const content = contentText(update.content);
  if (content.length > 0) {
    return content;
  }
  return typeof update.text === "string" ? update.text : "";
}

function isMcpFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split(/\r?\n/);
  const mcpContext = /\bmcp(?:[ \t]*:|[ \t]+(?:server|connection|transport|protocol|client|session|reload|request|error|failure)\b)/i;
  const failure = /\b(?:failed|failure|error|closed|disconnected|refused|unavailable|timed out|timeout|not connected|not running)\b/i;
  return lines.some((line, index) => {
    if (!mcpContext.test(line)) {
      return false;
    }
    if (failure.test(line)) {
      return true;
    }
    const nextLine = lines[index + 1] ?? "";
    return /^\s*(?:error|failed|failure|connection|transport|protocol|timeout|timed out|disconnected)\b/i.test(nextLine) &&
      failure.test(nextLine);
  });
}

function upsertThinking(update, conversation = activeConversation() ?? state.composer) {
  const thought = updateContentText(update);
  if (thought.length === 0) {
    return;
  }
  const group = ensureToolGroup(conversation);
  group.thinkingText = `${group.thinkingText ?? ""}${thought}`;
  scheduleMessagesRender(conversation, group);
}

function upsertToolActivity(update, conversation = activeConversation() ?? state.composer) {
  const group = ensureToolGroup(conversation);

  const toolCallId = typeof update.toolCallId === "string" ||
    typeof update.toolCallId === "number"
    ? String(update.toolCallId)
    : `anonymous-${group.toolActivities.length + 1}`;
  let activity = group.toolActivities.find((item) => item.id === toolCallId);
  if (!activity) {
    activity = {
      id: toolCallId,
      title: "Copilot tool",
      status: "pending",
      detail: ""
    };
    group.toolActivities.push(activity);
  }

  if (typeof update.title === "string" && update.title.length > 0) {
    activity.title = update.title;
  } else if (typeof update.name === "string" && update.name.length > 0) {
    activity.title = update.name;
  }
  if (typeof update.status === "string" && update.status.length > 0) {
    activity.status = update.status;
  }
  const detail = updateContentText(update).trim();
  if (detail.length > 0) {
    activity.detail = detail;
  }
  if (
    activity.status.toLowerCase() === "failed" &&
    conversation.activePrompt &&
    isMcpFailure(activity.detail)
  ) {
    markPromptRetryable(conversation.activePrompt, conversation);
  }
  scheduleMessagesRender(conversation, group);
}

const renderedThinkingText = new WeakMap();

function updateScrollableContent(element, update) {
  const previousScrollTop = element.scrollTop;
  const previousScrollLeft = element.scrollLeft;
  const stickToBottom = element.clientHeight > 0 &&
    element.scrollHeight - previousScrollTop - element.clientHeight <= 8;
  update();
  element.scrollLeft = previousScrollLeft;
  element.scrollTop = stickToBottom ? element.scrollHeight : previousScrollTop;
}

function renderToolActivities(body, message) {
  const activities = Array.isArray(message.toolActivities) ? message.toolActivities : [];
  const thinkingText = typeof message.thinkingText === "string"
    ? message.thinkingText
    : "";
  if (
    !body.querySelector(".thinking-content, .tool-activity-panel") &&
    (thinkingText.length > 0 || activities.length > 0)
  ) {
    body.replaceChildren();
  }

  let thinking = body.querySelector(".thinking-content");
  if (thinkingText.length > 0) {
    if (!thinking) {
      thinking = document.createElement("details");
      thinking.className = "thinking-content";
      thinking.open = message.thinkingExpanded === true;
      const thinkingSummary = document.createElement("summary");
      thinkingSummary.textContent = "Reasoning";
      const thinkingBody = document.createElement("div");
      thinkingBody.className = "thinking-content-text";
      thinking.append(thinkingSummary, thinkingBody);
      thinking.addEventListener("toggle", () => {
        message.thinkingExpanded = thinking.open;
      });
      const activityPanel = body.querySelector(".tool-activity-panel");
      body.insertBefore(thinking, activityPanel);
    }
    const thinkingBody = thinking.querySelector(".thinking-content-text");
    if (
      thinkingBody &&
      renderedThinkingText.get(thinkingBody) !== thinkingText
    ) {
      updateScrollableContent(thinkingBody, () => {
        thinkingBody.innerHTML = renderMarkdown(thinkingText);
      });
      renderedThinkingText.set(thinkingBody, thinkingText);
    }
  } else {
    thinking?.remove();
  }

  let activityPanel = body.querySelector(".tool-activity-panel");
  if (activities.length > 0) {
    if (!activityPanel) {
      activityPanel = document.createElement("details");
      activityPanel.className = "tool-activity-panel";
      activityPanel.open = message.toolActivitiesExpanded === true;
      const summary = document.createElement("summary");
      const list = document.createElement("ul");
      list.className = "tool-activity-list";
      activityPanel.append(summary, list);
      activityPanel.addEventListener("toggle", () => {
        message.toolActivitiesExpanded = activityPanel.open;
      });
      body.append(activityPanel);
    }

    const activeCount = activities.filter((activity) => (
      activity.status === "pending" || activity.status === "in_progress"
    )).length;
    const summary = activityPanel.querySelector("summary");
    const summaryText = activeCount > 0
      ? `Activities (${activities.length}) · In progress`
      : `Activities (${activities.length})`;
    if (summary.textContent !== summaryText) {
      summary.textContent = summaryText;
    }

    const list = activityPanel.querySelector(".tool-activity-list");
    updateScrollableContent(list, () => {
      const existingItems = new Map(
        Array.from(list.children).map((item) => [item.dataset.activityId, item])
      );
      activities.forEach((activity, index) => {
        let item = existingItems.get(activity.id);
        if (!item) {
          item = document.createElement("li");
          item.dataset.activityId = activity.id;
          const status = document.createElement("span");
          status.className = "tool-activity-status";
          const title = document.createElement("span");
          title.className = "tool-activity-title";
          item.append(status, title);
        }
        const itemClass = `tool-activity-item tool-status-${toolStatusClass(activity.status)}`;
        if (item.className !== itemClass) {
          item.className = itemClass;
        }
        const status = item.querySelector(".tool-activity-status");
        const statusText = toolStatusLabel(activity.status);
        if (status.textContent !== statusText) {
          status.textContent = statusText;
        }
        const title = item.querySelector(".tool-activity-title");
        if (title.textContent !== activity.title) {
          title.textContent = activity.title;
        }

        let detail = item.querySelector(".tool-activity-detail");
        if (typeof activity.detail === "string" && activity.detail.length > 0) {
          if (!detail) {
            detail = document.createElement("span");
            detail.className = "tool-activity-detail";
            item.append(detail);
          }
          if (detail.textContent !== activity.detail) {
            updateScrollableContent(detail, () => {
              detail.textContent = activity.detail;
            });
          }
        } else {
          detail?.remove();
        }

        const currentItem = list.children[index];
        if (currentItem !== item) {
          list.insertBefore(item, currentItem ?? null);
        }
        existingItems.delete(activity.id);
      });
      for (const item of existingItems.values()) {
        item.remove();
      }
    });
  } else {
    activityPanel?.remove();
  }

  if (!body.querySelector(".thinking-content, .tool-activity-panel")) {
    body.textContent = "Copilot is working...";
  }
}

function renderMessageBody(body, message) {
  if (message.role === "tool") {
    renderToolActivities(body, message);
    return;
  }

  body.replaceChildren();
  if (message.role === "assistant") {
    body.innerHTML = renderMarkdown(message.text);
  } else {
    if (message.text) {
      const text = document.createElement("div");
      text.className = "message-text";
      text.textContent = message.text;
      body.append(text);
    }
    renderMessageAttachments(body, message.attachments);
  }
}

let messagesRenderScheduled = false;
const pendingMessageUpdates = new Map();

function scheduleMessagesRender(conversation = activeConversation(), message = null) {
  if (!isActiveConversation(conversation)) {
    return;
  }
  let pending = pendingMessageUpdates.get(conversation);
  if (!pending) {
    pending = { fullRender: false, messages: new Set() };
    pendingMessageUpdates.set(conversation, pending);
  }
  if (message) {
    pending.messages.add(message);
  } else {
    pending.fullRender = true;
  }
  if (!messagesRenderScheduled) {
    messagesRenderScheduled = true;
    const render = () => {
      messagesRenderScheduled = false;
      const updates = Array.from(pendingMessageUpdates.entries());
      pendingMessageUpdates.clear();
      for (const [targetConversation, update] of updates) {
        if (!isActiveConversation(targetConversation)) {
          continue;
        }
        if (
          update.fullRender ||
          !updateMessagesInPlace(targetConversation, update.messages)
        ) {
          renderMessages(targetConversation);
        }
      }
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(render);
    } else {
      window.setTimeout(render, 0);
    }
  }
}

function openImagePreview(source, alt) {
  elements.imagePreviewImage.src = source;
  elements.imagePreviewImage.alt = alt;
  if (typeof elements.imagePreviewDialog.showModal === "function") {
    elements.imagePreviewDialog.showModal();
  } else {
    elements.imagePreviewDialog.setAttribute("open", "");
  }
}

function closeImagePreview() {
  if (elements.imagePreviewDialog.open && typeof elements.imagePreviewDialog.close === "function") {
    elements.imagePreviewDialog.close();
  } else {
    elements.imagePreviewDialog.removeAttribute("open");
  }
}

function renderMessageAttachments(body, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return;
  }
  const list = document.createElement("div");
  list.className = "message-attachments";
  for (const attachment of attachments) {
    if (
      !attachment ||
      typeof attachment.name !== "string" ||
      typeof attachment.mimeType !== "string" ||
      typeof attachment.data !== "string"
    ) {
      continue;
    }
    const item = document.createElement("div");
    item.className = "message-attachment";
    if (attachment.mimeType.startsWith("image/")) {
      const source = attachmentDataUrl(attachment);
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "message-attachment-image-button";
      preview.title = `Open ${attachment.name}`;
      preview.setAttribute("aria-label", `View ${attachment.name}`);
      preview.addEventListener("click", () => {
        openImagePreview(source, attachment.name);
      });
      const image = document.createElement("img");
      image.className = "message-attachment-image";
      image.src = source;
      image.alt = attachment.name;
      preview.append(image);
      item.append(preview);
    } else if (attachment.mimeType === "application/pdf") {
      const link = document.createElement("a");
      link.className = "message-attachment-file";
      link.href = attachmentDataUrl(attachment);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.download = attachment.name;
      link.textContent = `PDF: ${attachment.name}`;
      item.append(link);
    } else {
      continue;
    }
    list.append(item);
  }
  if (list.childElementCount > 0) {
    body.append(list);
  }
}

function messagePanelScrollKey(panel) {
  if (panel.classList.contains("thinking-content-text")) {
    return "thinking";
  }
  if (panel.classList.contains("tool-activity-list")) {
    return "activities";
  }
  if (panel.classList.contains("tool-activity-detail")) {
    const activityId = panel.closest(".tool-activity-item")?.dataset.activityId;
    return typeof activityId === "string" ? `activity-detail:${activityId}` : null;
  }
  return null;
}

function captureMessagePanelScroll(conversation) {
  const positions = new Map();
  const messageElements = elements.messages.querySelectorAll(".message");
  messageElements.forEach((article) => {
    const index = Number(article.dataset.messageIndex);
    const message = conversation.messages[index];
    if (!message) {
      return;
    }
    const panels = article.querySelectorAll(
      ".thinking-content-text, .tool-activity-list, .tool-activity-detail"
    );
    if (panels.length === 0) {
      return;
    }
    const panelPositions = new Map();
    panels.forEach((panel) => {
      const key = messagePanelScrollKey(panel);
      if (key) {
        panelPositions.set(key, {
          scrollLeft: panel.scrollLeft,
          scrollTop: panel.scrollTop,
          stickToBottom: panel.clientHeight > 0 &&
            panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 8
        });
      }
    });
    positions.set(message, panelPositions);
  });
  return positions;
}

function restoreMessagePanelScroll(article, message, positions) {
  const savedPositions = positions.get(message);
  if (!savedPositions) {
    return;
  }
  const panels = article.querySelectorAll(
    ".thinking-content-text, .tool-activity-list, .tool-activity-detail"
  );
  panels.forEach((panel) => {
    const key = messagePanelScrollKey(panel);
    const saved = key ? savedPositions.get(key) : null;
    if (!saved) {
      return;
    }
    panel.scrollLeft = saved.scrollLeft;
    panel.scrollTop = saved.stickToBottom
      ? panel.scrollHeight
      : saved.scrollTop;
  });
}

function messagesAreAtBottom() {
  return elements.messages.scrollHeight -
    elements.messages.scrollTop -
    elements.messages.clientHeight < messagesBottomThreshold;
}

function updateScrollToBottomButton() {
  const conversation = activeConversation();
  const visible = conversation?.loading === false &&
    conversation.messages.length > 0 &&
    !messagesAreAtBottom();
  elements.scrollToBottom.hidden = !visible;
  elements.scrollToBottom.disabled = !visible;
}

function updateMessagesInPlace(conversation, messages) {
  const articlesByIndex = new Map();
  elements.messages.querySelectorAll(".message").forEach((article) => {
    const index = Number(article.dataset.messageIndex);
    if (Number.isInteger(index)) {
      articlesByIndex.set(index, article);
    }
  });
  const updates = Array.from(messages, (message) => {
    const index = conversation.messages.indexOf(message);
    const article = articlesByIndex.get(index);
    const body = article?.querySelector(".message-body");
    return body ? { body, message } : null;
  });
  if (updates.some((update) => !update)) {
    return false;
  }

  const wasAtBottom = messagesAreAtBottom();
  const previousScrollTop = elements.messages.scrollTop;
  const previousScrollLeft = elements.messages.scrollLeft;
  for (const update of updates) {
    renderMessageBody(update.body, update.message);
  }
  if (wasAtBottom) {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  } else {
    elements.messages.scrollTop = previousScrollTop;
    elements.messages.scrollLeft = previousScrollLeft;
  }
  updateScrollToBottomButton();
  return true;
}

function renderMessages(conversation = activeConversation()) {
  if (conversation !== activeConversation()) {
    return;
  }
  const wasAtBottom = messagesAreAtBottom();
  const previousScrollTop = elements.messages.scrollTop;
  const previousScrollLeft = elements.messages.scrollLeft;
  const panelScrollPositions = captureMessagePanelScroll(conversation);
  elements.messages.replaceChildren();
  if (conversation?.loading === true) {
    elements.loadingState.hidden = false;
    elements.messages.append(elements.loadingState);
    elements.emptyState.hidden = true;
    elements.messages.setAttribute("aria-busy", "true");
    updateScrollToBottomButton();
    return;
  }

  elements.loadingState.hidden = true;
  elements.messages.setAttribute("aria-busy", "false");
  if (!conversation || conversation.messages.length === 0) {
    elements.messages.append(elements.emptyState);
    elements.emptyState.hidden = false;
    updateScrollToBottomButton();
    return;
  }

  elements.emptyState.hidden = true;
  for (const [index, message] of conversation.messages.entries()) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    article.dataset.messageIndex = String(index);
    const header = document.createElement("div");
    header.className = "message-header";
    const label = document.createElement("div");
    label.className = "message-label";
    label.textContent = message.role === "user"
      ? "You"
      : message.role === "tool"
        ? "Thinking"
        : message.role === "system"
        ? state.brandName
          : "Copilot";
    header.append(label);
    if (message.role === "user" || message.role === "assistant") {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "message-copy";
      copy.innerHTML = copyIconMarkup;
      copy.title = "Copy message";
      copy.setAttribute(
          "aria-label",
          message.role === "user" ? "Copy your message" : "Copy Copilot response"
      );
      copy.addEventListener("click", () => {
          void copyMessage(message, copy);
      });
      header.append(copy);
    }
    const body = document.createElement("div");
    body.className = "message-body";
    renderMessageBody(body, message);
    article.append(header, body);
    if (message.role === "user" && message.retryPrompt) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "message-retry";
      retry.textContent = "Reconnect & retry";
      retry.title = "Reload MCP connections and retry the whole prompt";
      retry.disabled = !canReloadMcp(conversation);
      retry.addEventListener("click", () => retryFailedPrompt(message, conversation));
      article.append(retry);
    }
    elements.messages.append(article);
    restoreMessagePanelScroll(article, message, panelScrollPositions);
  }
  if (wasAtBottom) {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  } else {
    elements.messages.scrollTop = previousScrollTop;
    elements.messages.scrollLeft = previousScrollLeft;
  }
  updateScrollToBottomButton();
}

function renderRetryActions(conversation) {
  if (conversation.messages.some((message) => message.retryPrompt)) {
    renderMessages(conversation);
  }
}

function setBusy(value, conversation = activeConversation()) {
  if (!conversation) {
    return;
  }
  touchSessionActivity(conversation.sessionId);
  conversation.busy = value;
  if (!value) {
    conversation.activePromptKey = null;
    conversation.cancelRequested = false;
    stopRecoveredPromptPolling(conversation);
  } else {
    scheduleRecoveredPromptPolling(conversation);
  }
  renderSessionList();
  if (isActiveConversation(conversation)) {
    renderConnectionStatus();
    elements.input.disabled = conversation.loading;
    elements.send.disabled = conversation.loading ||
      conversation.configurationBusy ||
      conversation.attachmentBusy;
    updateSendPromptAction(conversation);
    elements.cancel.disabled = !promptIsActive(conversation);
    updateAttachmentControls();
    renderConversationControls();
  } else {
    renderConnectionStatus();
    renderConversationControls();
  }
  renderRetryActions(conversation);
}

function stopRecoveredPromptPolling(conversation = activeConversation()) {
  if (conversation?.recoveredPromptPollTimer !== null) {
    window.clearTimeout(conversation.recoveredPromptPollTimer);
    conversation.recoveredPromptPollTimer = null;
  }
}

function resetRecoveredPrompt(conversation = activeConversation()) {
  if (!conversation) {
    return;
  }
  stopRecoveredPromptPolling(conversation);
  conversation.recoveredPrompt = false;
  conversation.recoveredPromptId = null;
}

function clearStalePrompt(conversation, status = "Ready") {
  if (!conversation) {
    return;
  }

  const drainPromise = conversation.drainPromise;
  conversation.promptRunId += 1;
  if (conversation.promptRequestController) {
    conversation.promptRequestController.abort();
    conversation.promptRequestController = null;
  }
  resetRecoveredPrompt(conversation);
  setBusy(false, conversation);
  setStatus(status, conversation);

  if (conversation.promptQueue.length === 0) {
    return;
  }
  const restart = () => {
    if (!conversation.busy && conversation.promptQueue.length > 0) {
      void drainPromptQueue(conversation);
    }
  };
  if (drainPromise) {
    void drainPromise.then(restart, restart);
  } else {
    restart();
  }
}

function finishRecoveredPrompt(
  completion,
  conversation = conversationState(completion?.sessionId, false)
) {
  if (
    !conversation ||
    !conversation.recoveredPrompt ||
    completion.sessionId !== conversation.sessionId ||
    (
      conversation.recoveredPromptId &&
      completion.promptId !== conversation.recoveredPromptId
    )
  ) {
    return false;
  }

  resetRecoveredPrompt(conversation);
  setBusy(false, conversation);
  if (typeof completion.error === "string" && completion.error.length > 0) {
    showError(new Error(completion.error), conversation);
  } else {
    setStatus(
      completion.stopReason === "cancelled" ? "Cancelled" : "Ready",
      conversation
    );
  }
  void refreshSessions().catch((error) => showError(error, conversation));
  if (conversation.promptQueue.length > 0) {
    void drainPromptQueue(conversation);
  }
  return true;
}

function scheduleRecoveredPromptPolling(conversation = activeConversation()) {
  if (
    !conversation ||
    conversation.recoveredPromptPollTimer !== null ||
    (!conversation.busy && !conversation.recoveredPrompt) ||
    !conversation.sessionId
  ) {
    return;
  }

  const sessionId = conversation.sessionId;
  const promptId = conversation.recoveredPromptId;
  conversation.recoveredPromptPollTimer = window.setTimeout(async () => {
    conversation.recoveredPromptPollTimer = null;
    if (
      (!conversation.busy && !conversation.recoveredPrompt) ||
      conversation.sessionId !== sessionId
    ) {
      return;
    }
    try {
      const request = beginServerPromptStateRequest();
      const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/status`);
      if (
        (!conversation.busy && !conversation.recoveredPrompt) ||
        conversation.sessionId !== sessionId
      ) {
        return;
      }
      const promptState = applyServerPromptState(sessionId, result, request);
      if (
        !promptState.busy ||
        (promptId && promptState.promptId !== promptId)
      ) {
        if (conversation.recoveredPrompt) {
          finishRecoveredPrompt({ sessionId, promptId }, conversation);
        } else {
          clearStalePrompt(conversation);
        }
        return;
      }
    } catch {
      // The SSE connection remains the primary completion signal; retry status
      // checks while it is temporarily unavailable.
    }
    scheduleRecoveredPromptPolling(conversation);
  }, 1000);
}

function setLoading(value, conversation = activeConversation()) {
  if (!conversation) {
    return;
  }
  conversation.loading = value;
  if (isActiveConversation(conversation)) {
    renderConnectionStatus();
    elements.input.disabled = value;
    elements.send.disabled = value ||
      conversation.configurationBusy ||
      conversation.attachmentBusy;
    elements.cancel.disabled = !promptIsActive(conversation);
    updateAttachmentControls();
    renderConversationControls();
    renderMessages(conversation);
  }
}

function setConfigurationBusy(value, conversation = activeConversation()) {
  if (!conversation) {
    return;
  }
  conversation.configurationBusy = value;
  if (isActiveConversation(conversation)) {
    elements.send.disabled = value ||
      conversation.loading ||
      conversation.attachmentBusy;
    updateAttachmentControls();
    renderConversationControls();
  }
  renderRetryActions(conversation);
}

function addMessage(
  role,
  text,
  key = null,
  attachments = [],
  conversation = activeConversation() ?? state.composer
) {
  if (!text && attachments.length === 0) {
    return;
  }
  if (key && conversation.messageKeys.has(key)) {
    const message = conversation.messages[conversation.messageKeys.get(key)];
    if (message) {
      message.text += text;
      if (attachments.length > 0) {
        message.attachments = [...(message.attachments ?? []), ...attachments];
      }
      scheduleMessagesRender(conversation, message);
      return;
    }
  }

  const message = { role, text, attachments: [...attachments] };
  const index = conversation.messages.length;
  conversation.messages.push(message);
  if (key) {
    conversation.messageKeys.set(key, index);
  }
  scheduleMessagesRender(conversation, message);
}

function markPromptRetryable(queuedPrompt, conversation) {
  const messageIndex = conversation.messageKeys.get(queuedPrompt.messageKey);
  if (messageIndex === undefined) {
    return;
  }
  const message = conversation.messages[messageIndex];
  if (!message || message.role !== "user") {
    return;
  }
  message.retryPrompt = {
    text: queuedPrompt.text,
    attachments: queuedPrompt.attachments.map((attachment) => ({ ...attachment }))
  };
  scheduleMessagesRender(conversation, message);
}

function contentText(content) {
  if (Array.isArray(content)) {
    return content.map((item) => contentText(item)).filter(Boolean).join("\n");
  }
  if (!content || typeof content !== "object") {
    return "";
  }
  if (typeof content.text === "string") {
    return content.text;
  }
  if (content.content && typeof content.content === "object") {
    return contentText(content.content);
  }
  return "";
}

function contentAttachment(content) {
  if (!content || typeof content !== "object") {
    return [];
  }
  const block = content.content && typeof content.content === "object"
    ? content.content
    : content;
  if (
    block.type === "image" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
  ) {
    return [{
      name: typeof block.name === "string" ? block.name : "Image",
      mimeType: block.mimeType,
      data: block.data
    }];
  }
  if (
    block.type === "resource" &&
    block.resource &&
    typeof block.resource === "object" &&
    typeof block.resource.blob === "string" &&
    typeof block.resource.mimeType === "string"
  ) {
    return [{
      name: typeof block.resource.name === "string"
        ? block.resource.name
        : "PDF attachment",
      mimeType: block.resource.mimeType,
      data: block.resource.blob
    }];
  }
  return [];
}

function handleSessionUpdate(params, expectedSessionId = null) {
  if (
    !params ||
    params._replay === true ||
    !params.update
  ) {
    return;
  }
  const sessionId = typeof params.sessionId === "string"
    ? params.sessionId
    : expectedSessionId;
  if (!sessionId || (expectedSessionId && sessionId !== expectedSessionId)) {
    return;
  }
  const conversation = conversationState(sessionId);
  const update = params.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const key = streamMessageKey("user", update, conversation);
      addMessage(
        "user",
        contentText(update.content),
        key,
        contentAttachment(update.content),
        conversation
      );
      break;
    }
    case "agent_message_chunk": {
      const key = streamMessageKey("assistant", update, conversation);
      addMessage("assistant", contentText(update.content), key, [], conversation);
      break;
    }
    case "agent_thought_chunk":
      upsertThinking(update, conversation);
      break;
    case "tool_call":
    case "tool_call_update":
      upsertToolActivity(update, conversation);
      break;
    case "plan":
      conversation.lastStreamRole = "system";
      addMessage("system", "Copilot is preparing a plan.", "plan", [], conversation);
      break;
    case "usage_update":
      applyContextUsage(update, conversation);
      setStatus("Copilot is working...", conversation);
      break;
    case "config_option_update":
      conversation.configOptions = Array.isArray(update.configOptions)
        ? update.configOptions
        : [];
      if (isActiveConversation(conversation)) {
        renderConfigurationControls();
      }
      break;
    case "session_info_update": {
      const session = state.sessions.find((item) => item.sessionId === sessionId);
      if (session) {
        const customTitle = conversation.activeSessionTitleOverride ||
          (typeof session.customTitle === "string" ? session.customTitle : "");
        if (typeof update.title === "string") {
          if (customTitle) {
            session.title = customTitle;
          } else if (update.title !== "New conversation") {
            session.title = update.title;
            conversation.activeSessionTitleOverride = update.title;
            conversation.activeSessionIsNew = false;
          } else if (!conversation.activeSessionTitleOverride) {
            session.title = update.title;
          }
        }
        if (typeof update.updatedAt === "string") {
          session.updatedAt = update.updatedAt;
        }
        if (isActiveConversation(conversation)) {
          renderConversationControls();
        }
        renderSessionList();
      }
      break;
    }
    default:
      break;
  }
}

function handleRawSessionEvent(params) {
  if (
    !params ||
    typeof params.sessionId !== "string" ||
    typeof params.type !== "string" ||
    !params.data ||
    typeof params.data !== "object"
  ) {
    return;
  }
  const conversation = conversationState(params.sessionId);
  let usageChanged = false;

  if (params.type === "assistant.usage") {
    const totalNanoAiu = params.data.copilotUsage &&
      typeof params.data.copilotUsage === "object"
      ? params.data.copilotUsage.totalNanoAiu
      : undefined;
    if (typeof totalNanoAiu === "number" && Number.isFinite(totalNanoAiu)) {
      conversation.usage.aicNano = (conversation.usage.aicNano ?? 0) + totalNanoAiu;
      usageChanged = true;
    }
  } else if (params.type === "session.usage_checkpoint") {
    if (
      typeof params.data.totalNanoAiu === "number" &&
      Number.isFinite(params.data.totalNanoAiu)
    ) {
      conversation.usage.aicNano = params.data.totalNanoAiu;
      usageChanged = true;
    }
  } else if (params.type === "session.session_limits_changed") {
    const maxAiCredits = params.data.sessionLimits &&
      typeof params.data.sessionLimits === "object"
      ? params.data.sessionLimits.maxAiCredits
      : undefined;
    conversation.usage.aicLimit = typeof maxAiCredits === "number" &&
      Number.isFinite(maxAiCredits)
      ? maxAiCredits * 1_000_000_000
      : null;
    usageChanged = true;
  }
  if (usageChanged) {
    conversation.usageRevision += 1;
  }
  renderUsage(conversation);
}

function permissionOptionLabel(option) {
  if (!option || typeof option !== "object") {
    return "Choose";
  }
  return typeof option.name === "string" ? option.name : String(option.optionId ?? "Choose");
}

function showPermissionRequest(event) {
  const params = event.params ?? {};
  const toolCall = params.toolCall && typeof params.toolCall === "object" ? params.toolCall : {};
  const options = Array.isArray(params.options) ? params.options : [];
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  if (!sessionId) {
    return;
  }
  const conversation = conversationState(sessionId);
  conversation.pendingPermission = {
    requestId: event.requestId,
    sessionId,
    context: event.context,
    options
  };
  state.permissionDialogSessionId = sessionId;

  elements.permissionTitle.textContent = "Permission requested";
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  const toolDescription = typeof toolCall.title === "string"
    ? toolCall.title
    : "Copilot wants permission to use a tool.";
  elements.permissionDescription.textContent = session && sessionId !== state.activeSessionId
    ? `${session.title || "Another conversation"}: ${toolDescription}`
    : toolDescription;
  elements.permissionOptions.replaceChildren();
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "permission-option";
    button.textContent = permissionOptionLabel(option);
    button.addEventListener("click", () => choosePermission(option.optionId));
    elements.permissionOptions.append(button);
  }
  if (typeof elements.permissionDialog.showModal === "function") {
    elements.permissionDialog.showModal();
  } else {
    elements.permissionDialog.setAttribute("open", "");
  }
}

async function choosePermission(optionId) {
  const sessionId = state.permissionDialogSessionId;
  const conversation = conversationState(sessionId, false);
  if (!conversation?.pendingPermission || typeof optionId !== "string") {
    return;
  }
  const pending = conversation.pendingPermission;
  conversation.pendingPermission = null;
  state.permissionDialogSessionId = null;
  elements.permissionDialog.close();
  try {
    await api(`/api/sessions/${encodeURIComponent(pending.sessionId)}/permissions`, {
      method: "POST",
      body: JSON.stringify({
        requestId: pending.requestId,
        optionId,
        context: pending.context
      })
    });
  } catch (error) {
    showError(error);
  }
}

async function cancelPermission() {
  const conversation = conversationState(state.permissionDialogSessionId, false);
  if (!conversation?.pendingPermission) {
    return;
  }
  const pending = conversation.pendingPermission;
  conversation.pendingPermission = null;
  state.permissionDialogSessionId = null;
  try {
    await api(`/api/sessions/${encodeURIComponent(pending.sessionId)}/permissions`, {
      method: "POST",
      body: JSON.stringify({
        requestId: pending.requestId,
        cancelled: true,
        context: pending.context
      })
    });
  } catch (error) {
    showError(error);
  }
}

function showError(error, conversation = activeConversation() ?? state.composer) {
  const message = error instanceof Error ? error.message : String(error);
  addMessage("system", message, null, [], conversation);
  setStatus("Something went wrong", conversation);
}

function confirmRenameConversation(session) {
  const currentTitle = session.title || "";
  if (typeof elements.renameDialog.showModal !== "function") {
    const title = window.prompt("Rename conversation", currentTitle);
    return Promise.resolve(title === null ? null : title);
  }

  elements.renameTitle.textContent = `Rename "${currentTitle || "conversation"}"`;
  elements.renameInput.value = currentTitle;
  elements.renameDialog.showModal();
  window.requestAnimationFrame(() => {
    elements.renameInput.focus();
    elements.renameInput.select();
  });
  return new Promise((resolve) => {
    elements.renameDialog.addEventListener("close", () => {
      resolve(
        elements.renameDialog.returnValue === "confirm"
          ? elements.renameInput.value
          : null
      );
    }, { once: true });
  });
}

async function renameConversation(sessionId) {
  if (
    state.renamingSessionId ||
    state.deletingSessionId
  ) {
    return;
  }
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (!session || elements.renameDialog.open) {
    return;
  }

  const requestedTitle = await confirmRenameConversation(session);
  if (requestedTitle === null) {
    return;
  }
  const title = requestedTitle.replace(/\s+/g, " ").trim();
  if (title.length === 0) {
    showError(
      new Error("Conversation title cannot be empty"),
      conversationState(sessionId, false) ?? state.composer
    );
    return;
  }

  state.renamingSessionId = sessionId;
  renderSessionList();
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
      method: "POST",
      body: JSON.stringify({ title })
    });
    const renamedTitle = typeof result.title === "string" ? result.title : title;
    const renamedSession = state.sessions.find((item) => item.sessionId === sessionId);
    if (renamedSession) {
      renamedSession.title = renamedTitle;
    }
    const conversation = conversationState(sessionId);
    conversation.activeSessionTitleOverride = renamedTitle;
    conversation.activeSessionIsNew = false;
    if (sessionId === state.activeSessionId) {
      setStatus("Ready", conversation);
    }
    await refreshSessions();
  } catch (error) {
    showError(error, conversationState(sessionId, false) ?? state.composer);
  } finally {
    state.renamingSessionId = null;
    renderSessionList();
  }
}

function confirmDeleteConversation(session) {
  const title = session.title || "this conversation";
  if (typeof elements.deleteDialog.showModal !== "function") {
    return Promise.resolve(window.confirm(
      `Delete "${title}"? This removes its saved session data.`
    ));
  }

  elements.deleteTitle.textContent = `Delete "${title}"?`;
  elements.deleteDescription.textContent =
    "This permanently removes the saved conversation data and cannot be undone.";
  elements.deleteDialog.showModal();
  return new Promise((resolve) => {
    elements.deleteDialog.addEventListener("close", () => {
      resolve(elements.deleteDialog.returnValue === "confirm");
    }, { once: true });
  });
}

async function deleteConversation(sessionId) {
  const conversation = conversationState(sessionId, false);
  if (
    state.deletingSessionId ||
    state.renamingSessionId ||
    conversation?.busy ||
    conversation?.loading ||
    conversation?.configurationBusy
  ) {
    return;
  }
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (!session || elements.deleteDialog.open || !(await confirmDeleteConversation(session))) {
    return;
  }

  state.deletingSessionId = sessionId;
  renderSessionList();
  let activeConversationDeleted = false;
  let deleteError;
  let persistenceWarnings = [];
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE"
    });
    persistenceWarnings = Array.isArray(result.persistenceWarnings)
      ? result.persistenceWarnings.filter((warning) => typeof warning === "string")
      : [];
    state.conversations.delete(sessionId);
    if (sessionId === state.activeSessionId) {
      activeConversationDeleted = true;
      startNewConversation({ discardDraft: true });
    }
    await refreshSessions();
    if (!activeConversationDeleted && persistenceWarnings.length === 0) {
      setStatus("Ready", activeConversation() ?? state.composer);
    }
  } catch (error) {
    deleteError = error;
  } finally {
    state.deletingSessionId = null;
    renderSessionList();
  }

  const errorConversation = activeConversation() ?? state.composer;
  if (deleteError) {
    showError(
      deleteError,
      activeConversationDeleted ? errorConversation : conversation ?? state.composer
    );
  }
  if (persistenceWarnings.length > 0) {
    showError(new Error(
      `Conversation deleted, but metadata cleanup was incomplete: ${
        persistenceWarnings.join("; ")
      }`
    ), errorConversation);
  }
}

async function refreshSessions() {
  const request = beginServerPromptStateRequest();
  const result = await api("/api/sessions");
  if (request.requestId < lastSessionListRequestId) {
    return;
  }
  lastSessionListRequestId = request.requestId;
  const sessions = Array.isArray(result.sessions) ? result.sessions : [];
  state.sessions = sessions.map((session) => {
    const previousSession = state.sessions.find((item) => item.sessionId === session.sessionId);
    const conversation = conversationState(session.sessionId, false);
    const promptState = applyServerPromptState(session.sessionId, session, request);
    if (typeof session.customTitle === "string" && session.customTitle.length > 0) {
      if (conversation) {
        conversation.activeSessionTitleOverride = session.customTitle;
        conversation.activeSessionIsNew = false;
      }
    }
    return {
      ...session,
      busy: promptState.busy,
      promptId: promptState.promptId,
      lastActivityAt: latestTimestamp(
        previousSession?.lastActivityAt,
        session.lastActivityAt ?? session.updatedAt,
        promptState.busy ? new Date().toISOString() : undefined
      ),
      ...(conversation?.activeSessionTitleOverride
        ? { title: conversation.activeSessionTitleOverride }
        : conversation?.activeSessionIsNew
          ? { title: "New conversation" }
          : {})
    };
  });
  const listedSessions = new Set(sessions.map((session) => session.sessionId));
  for (const sessionId of serverPromptStates.keys()) {
    if (!listedSessions.has(sessionId)) {
      applyServerPromptState(sessionId, { busy: false }, request);
    }
  }
  state.capabilities = result.capabilities ?? state.capabilities;
  state.newSessionDefaults = result.newSessionDefaults ?? state.newSessionDefaults;
  renderSessionList();
  renderConversationControls();
  renderConnectionStatus();
}

async function restoreActiveConversation() {
  const sessionId = readActiveSessionId();
  if (!sessionId) {
    return;
  }
  if (!state.sessions.some((session) => session.sessionId === sessionId)) {
    clearActiveSessionId();
    return;
  }
  const conversation = conversationState(sessionId, false);
  if (conversation?.loaded) {
    await reconcileConversationStatus(conversation);
  }
  const loaded = await loadConversation(sessionId);
  if (!loaded) {
    clearActiveSessionId();
  }
}

async function reconcileConversationStatus(conversation) {
  if (
    !conversation?.sessionId ||
    (!conversation.busy && !conversation.recoveredPrompt)
  ) {
    return;
  }
  const sessionId = conversation.sessionId;
  try {
    const request = beginServerPromptStateRequest();
    const result = await api(
      `/api/sessions/${encodeURIComponent(sessionId)}/status`
    );
    if (conversation.sessionId !== sessionId) {
      return;
    }
    const promptState = applyServerPromptState(sessionId, result, request);
    if (promptState.busy) {
      if (conversation.recoveredPrompt) {
        conversation.recoveredPromptId = promptState.promptId !== null
          ? promptState.promptId
          : conversation.recoveredPromptId;
        scheduleRecoveredPromptPolling(conversation);
      }
      return;
    }
    if (conversation.recoveredPrompt) {
      finishRecoveredPrompt({
        sessionId: conversation.sessionId,
        promptId: conversation.recoveredPromptId
      }, conversation);
      return;
    }
    clearStalePrompt(conversation);
  } catch {
    // The normal prompt request and SSE completion remain the primary signals.
  }
}

async function reconcileKnownConversationStatuses(excludeSessionId = null) {
  const conversations = [...state.conversations.values()].filter((conversation) => (
    conversation.sessionId !== excludeSessionId &&
    (conversation.busy || conversation.recoveredPrompt)
  ));
  await Promise.all(conversations.map((conversation) => (
    reconcileConversationStatus(conversation)
  )));
}

function persistComposerDraft() {
  const conversation = currentComposerConversation();
  conversation.draft = elements.input.value;
}

function activateConversation(sessionId) {
  persistComposerDraft();
  const conversation = conversationState(sessionId);
  state.activeSessionId = sessionId;
  saveActiveSessionId(sessionId);
  elements.input.value = conversation.draft;
  resizePromptInput();
  renderSessionList();
  renderConversationControls();
  renderAttachmentList();
  renderUsage(conversation);
  renderMessages(conversation);
  setStatus(conversation.status ?? "Ready", conversation);
  elements.input.disabled = conversation.loading;
  elements.send.disabled = conversation.loading ||
    conversation.configurationBusy ||
    conversation.attachmentBusy;
  updateAttachmentControls();
  updateSendPromptAction(conversation);
  elements.cancel.disabled = !promptIsActive(conversation);
  if (promptIsActive(conversation)) {
    scheduleRecoveredPromptPolling(conversation);
  }
  renderConnectionStatus();
}

function activateComposerConversation(conversation = state.composer) {
  state.activeSessionId = null;
  clearActiveSessionId();
  elements.input.value = conversation.draft;
  resizePromptInput();
  renderSessionList();
  renderConversationControls();
  renderAttachmentList();
  renderUsage(conversation);
  renderMessages(conversation);
  setStatus(conversation.status ?? "Ready", conversation);
  elements.input.disabled = conversation.loading;
  elements.send.disabled = conversation.loading ||
    conversation.configurationBusy ||
    conversation.attachmentBusy;
  updateAttachmentControls();
  updateSendPromptAction(conversation);
  elements.cancel.disabled = !promptIsActive(conversation);
  renderConnectionStatus();
}

function startNewConversation({ discardDraft = false } = {}) {
  if (state.deletingSessionId && !discardDraft) {
    return;
  }
  if (!discardDraft) {
    persistComposerDraft();
  }

  const pendingDraft = discardDraft
    ? ""
    : state.activeSessionId
      ? state.composer.draft
      : elements.input.value;
  const pendingAttachments = discardDraft
    ? []
    : state.composer.attachments.map((attachment) => ({ ...attachment }));
  state.composer = createConversationState();
  state.composer.draft = pendingDraft;
  state.composer.attachments = pendingAttachments;
  state.composer.loaded = true;
  state.composer.sessionContext = state.selectedContext;
  state.composer.activeSessionIsNew = true;
  activateComposerConversation();
  void loadContextDefaults(state.selectedContext, true);
  elements.input.focus();
}

function applyFallbackConversationTitle(queuedPrompt, conversation) {
  if (
    !conversation.activeSessionIsNew ||
    conversation.activeSessionTitleOverride ||
    (queuedPrompt.reconnect && queuedPrompt.text.trim() === "/mcp reload")
  ) {
    return;
  }
  const attachmentNames = queuedPrompt.attachments
    .filter((attachment) => typeof attachment.name === "string")
    .map((attachment) => attachment.name);
  const source = queuedPrompt.text.trim() ||
    (attachmentNames.length > 0 ? attachmentNames.join(", ") : "");
  const compact = source.replace(/\s+/g, " ").trim();
  if (!compact) {
    return;
  }
  const title = compact.length > 64
    ? `${compact.slice(0, 63).trimEnd()}…`
    : compact;
  conversation.activeSessionTitleOverride = title;
  conversation.activeSessionIsNew = false;
  const session = state.sessions.find((item) => item.sessionId === conversation.sessionId);
  if (session) {
    session.title = title;
  }
  renderSessionList();
}

async function createServerConversation() {
  if (state.deletingSessionId) {
    return null;
  }
  const previousConversation = activeConversation();
  const pendingDraft = state.activeSessionId ? "" : elements.input.value;
  const pendingAttachments = state.activeSessionId
    ? []
    : state.composer.attachments.map((attachment) => ({ ...attachment }));
  const configOverrides = state.activeSessionId
    ? {}
    : selectedNewSessionConfigOverrides(state.composer);
  try {
    const result = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        context: state.selectedContext,
        configOverrides
      })
    });
    const session = result.session;
    upsertSession(session);
    const conversation = conversationState(session.sessionId);
    conversation.loaded = true;
    conversation.draft = pendingDraft;
    conversation.attachments = pendingAttachments;
    conversation.activeSessionIsNew = true;
    conversation.activeSessionTitleOverride = null;
    conversation.messages = [];
    conversation.messageKeys.clear();
    conversation.promptQueue = [];
    resetRecoveredPrompt(conversation);
    resetStreamTracking(conversation);
    resetUsage(conversation);
    state.newSessionDefaults = result.newSessionDefaults ?? state.newSessionDefaults;
    applySessionSetup(result, state.selectedContext, conversation);
    state.composer = createConversationState();
    state.activeSessionId = session.sessionId;
    activateConversation(session.sessionId);
    setStatus("Ready", conversation);
    elements.input.focus();
    return conversation;
  } catch (error) {
    showError(error, previousConversation ?? state.composer);
    return null;
  }
}

function upsertSession(session) {
  if (
    !session ||
    typeof session !== "object" ||
    typeof session.sessionId !== "string"
  ) {
    return false;
  }
  const conversation = conversationState(session.sessionId, false);
  const promptState = serverPromptStates.get(session.sessionId);
  state.sessions = [
    {
      ...session,
      ...(promptState ? {
        busy: promptState.busy,
        promptId: promptState.promptId
      } : {}),
      ...(conversation?.activeSessionTitleOverride
        ? { title: conversation.activeSessionTitleOverride }
        : {})
    },
    ...state.sessions.filter((item) => item.sessionId !== session.sessionId)
  ];
  renderSessionList();
  return true;
}

function applySessionReplacement(result, previousSessionId) {
  const session = result.session;
  if (!session || typeof session.sessionId !== "string" || session.sessionId === previousSessionId) {
    return;
  }
  applyServerPromptState(previousSessionId, { busy: false });
  const conversation = conversationState(previousSessionId, false);
  const wasActive = state.activeSessionId === previousSessionId;
  if (wasActive) {
    persistComposerDraft();
  }
  if (conversation) {
    state.conversations.delete(previousSessionId);
    conversation.sessionId = session.sessionId;
    state.conversations.set(session.sessionId, conversation);
    for (const prompt of conversation.promptQueue) {
      prompt.sessionId = session.sessionId;
    }
    applySessionSetup(result, result.context, conversation);
  }
  state.sessions = state.sessions.filter((item) => item.sessionId !== previousSessionId);
  pendingPromptCompletions.delete(previousSessionId);
  if (wasActive) {
    state.activeSessionId = session.sessionId;
    saveActiveSessionId(session.sessionId);
  }
  upsertSession(session);
  renderConversationControls();
  if (Array.isArray(result.persistenceWarnings) && result.persistenceWarnings.length > 0) {
    showError(new Error(
      `Conversation settings changed, but metadata persistence was incomplete: ${
        result.persistenceWarnings.join("; ")
      }`
    ), conversation ?? activeConversation() ?? state.composer);
  }
}

async function loadConversation(sessionId, requestedContext = state.selectedContext, force = false) {
  if (state.deletingSessionId) {
    return false;
  }
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (!session) {
    return false;
  }
  const conversation = conversationState(sessionId);
  if (typeof session.customTitle === "string" && session.customTitle.length > 0) {
    conversation.activeSessionTitleOverride = session.customTitle;
    conversation.activeSessionIsNew = false;
  }
  if (conversation.loading) {
    activateConversation(sessionId);
    return true;
  }
  if (conversation.busy || conversation.recoveredPrompt) {
    if (force) {
      return false;
    }
    activateConversation(sessionId);
    return true;
  }
  if (
    !force &&
    conversation.loaded &&
    conversation.sessionContext === requestedContext
  ) {
    activateConversation(sessionId);
    return true;
  }

  activateConversation(sessionId);
  conversation.loaded = false;
  conversation.activeSessionIsNew = false;
  conversation.messages = [];
  conversation.messageKeys.clear();
  conversation.promptQueue = [];
  resetStreamTracking(conversation);
  resetUsage(conversation);
  const usageRevision = conversation.usageRevision;
  conversation.configOptions = [];
  setLoading(true, conversation);
  setStatus("Loading conversation...", conversation);

  try {
    const request = beginServerPromptStateRequest();
    const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/load`, {
      method: "POST",
      body: JSON.stringify({ context: requestedContext })
    });
    applySessionReplacement(result, sessionId);
    const promptState = applyServerPromptState(conversation.sessionId, result, request);
    conversation.loaded = true;
    applySessionSetup(result, requestedContext, conversation);
    if (
      typeof result.session?.customTitle === "string" &&
      result.session.customTitle.length > 0
    ) {
      conversation.activeSessionTitleOverride = result.session.customTitle;
      conversation.activeSessionIsNew = false;
      session.title = result.session.customTitle;
    }
    applySessionUsage(result.usage, conversation, usageRevision);
    const replayUpdates = Array.isArray(result.replayUpdates)
      ? result.replayUpdates
      : [];
    if (replayUpdates.length > 0) {
      conversation.messages = [];
      conversation.messageKeys.clear();
      resetStreamTracking(conversation);
      for (const replayUpdate of result.replayUpdates) {
        handleSessionUpdate(replayUpdate, conversation.sessionId);
      }
    }
    const pendingCompletion = pendingPromptCompletions.get(conversation.sessionId);
    pendingPromptCompletions.delete(conversation.sessionId);
    let completionHandled = false;
    if (promptState.busy) {
      conversation.recoveredPrompt = true;
      conversation.recoveredPromptId = promptState.promptId;
      setBusy(true, conversation);
      setStatus("Copilot is working...", conversation);
      completionHandled = pendingCompletion
        ? finishRecoveredPrompt(pendingCompletion, conversation)
        : false;
      if (!completionHandled) {
        scheduleRecoveredPromptPolling(conversation);
      }
    } else {
      resetRecoveredPrompt(conversation);
    }
    if (
      !conversation.recoveredPrompt &&
      !(completionHandled && typeof pendingCompletion?.error === "string")
    ) {
      setStatus("Ready", conversation);
    }
    return true;
  } catch (error) {
    showError(error, conversation);
    return false;
  } finally {
    setLoading(false, conversation);
  }
}

async function changeContext(value) {
  if (!contextPreferences.includes(value)) {
    return;
  }
  const previousContext = state.selectedContext;
  state.selectedContext = value;
  saveContextPreference(value);
  const conversation = activeConversation();
  if (!conversation.sessionId) {
    state.composer.sessionContext = value;
    setStatus("The selected context will apply to your first message", conversation);
    const updated = await loadContextDefaults(value);
    if (!updated && state.composer === conversation && !state.activeSessionId) {
      state.selectedContext = previousContext;
      saveContextPreference(previousContext);
      conversation.sessionContext = previousContext;
      renderConfigurationControls();
    }
    return;
  }
  if (conversation.sessionContext === value) {
    renderConfigurationControls();
    return;
  }
  const loaded = await loadConversation(conversation.sessionId, value, true);
  if (!loaded) {
    state.selectedContext = previousContext;
    saveContextPreference(previousContext);
    renderConfigurationControls();
  }
}

async function changeConfigOption(configId, value) {
  const conversation = activeConversation() ?? state.composer;
  if (
    !conversation ||
    conversation.busy ||
    conversation.loading ||
    conversation.configurationBusy ||
    typeof value !== "string" ||
    value.length === 0
  ) {
    return;
  }

  if (!conversation.sessionId) {
    const previousConfigOptions = conversation.configOptions;
    const previousConfigOverrides = { ...conversation.configOverrides };
    const option = conversation.configOptions.find((candidate) => candidate.id === configId);
    if (
      !option ||
      !configOptionValues(option).some((candidate) => candidate.value === value)
    ) {
      return;
    }
    conversation.configOverrides[configId] = value;
    conversation.configOptions = conversation.configOptions.map((candidate) => (
      candidate.id === configId
        ? { ...candidate, currentValue: value }
        : candidate
    ));
    renderConfigurationControls();
    if (configId === "model") {
      setStatus("Updating settings for the selected model...", conversation);
      const updated = await loadContextDefaults(state.selectedContext);
      if (updated && state.composer === conversation && !state.activeSessionId) {
        setStatus("This setting will apply to your first message", conversation);
      } else if (state.composer === conversation && !state.activeSessionId) {
        conversation.configOptions = previousConfigOptions;
        conversation.configOverrides = previousConfigOverrides;
        renderConfigurationControls();
      }
    } else {
      setStatus("This setting will apply to your first message", conversation);
    }
    return;
  }

  setConfigurationBusy(true, conversation);
  setStatus("Updating conversation settings...", conversation);
  const previousSessionId = conversation.sessionId;
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(previousSessionId)}/config`, {
      method: "POST",
      body: JSON.stringify({ configId, value })
    });
    applySessionReplacement(result, previousSessionId);
    conversation.configOptions = Array.isArray(result.configOptions)
      ? result.configOptions
      : [];
    if (configId === "model") {
      resetContextUsage(conversation);
      renderUsage(conversation);
    }
    setStatus("Ready", conversation);
  } catch (error) {
    showError(error, conversation);
  } finally {
    setConfigurationBusy(false, conversation);
  }
}

async function drainPromptQueue(conversation = activeConversation()) {
  if (!conversation || !conversation.sessionId) {
    return;
  }
  if (conversation.drainPromise) {
    return conversation.drainPromise;
  }

  conversation.drainPromise = (async () => {
    if (conversation.busy || conversation.promptQueue.length === 0) {
      return;
    }

    const runId = conversation.promptRunId + 1;
    conversation.promptRunId = runId;
    setBusy(true, conversation);
    let finalStatus = "Ready";
    while (conversation.promptQueue.length > 0) {
      if (conversation.promptRunId !== runId) {
        return;
      }
      const queuedPrompt = conversation.promptQueue.shift();
      renderSessionList();
      if (!queuedPrompt) {
        continue;
      }

      conversation.currentTurnKey = queuedPrompt.messageKey;
      conversation.activePromptKey = queuedPrompt.messageKey;
      conversation.currentToolGroupKey = `tool-group:${queuedPrompt.messageKey}`;
      conversation.lastStreamRole = "user";
      conversation.currentAssistantMessageKey = null;
      conversation.activePrompt = queuedPrompt;
      setStatus(
        queuedPrompt.reconnect
          ? "Reloading MCP connections..."
          : conversation.promptQueue.length > 0
            ? `Copilot is working... ${conversation.promptQueue.length} queued`
            : "Copilot is working...",
        conversation
      );
      const controller = new AbortController();
      conversation.promptRequestController = controller;
      let promptCompleted = false;
      try {
        const result = await api(`/api/sessions/${encodeURIComponent(queuedPrompt.sessionId)}/messages`, {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            text: queuedPrompt.text,
            clientPromptId: queuedPrompt.messageKey,
            reconnect: queuedPrompt.reconnect === true,
            attachments: queuedPrompt.attachments.map(({ name, mimeType, size, data }) => ({
              name,
              mimeType,
              size,
              data
            }))
          })
        });
        promptCompleted = true;
        if (conversation.promptRunId !== runId) {
          return;
        }
        finalStatus = result.stopReason === "cancelled" ? "Cancelled" : "Ready";
        if (result.stopReason !== "cancelled") {
          applyFallbackConversationTitle(queuedPrompt, conversation);
        }
        await refreshSessions();
        if (conversation.promptRunId !== runId) {
          return;
        }
        conversation.cancelRequested = false;
      } catch (error) {
        if (conversation.promptRunId !== runId) {
          return;
        }
        finalStatus = "Something went wrong";
        if (!promptCompleted && isMcpFailure(error)) {
          markPromptRetryable(queuedPrompt, conversation);
        }
        showError(error, conversation);
        conversation.cancelRequested = false;
      } finally {
        if (conversation.activePrompt === queuedPrompt) {
          conversation.activePrompt = null;
        }
        if (conversation.promptRequestController === controller) {
          conversation.promptRequestController = null;
        }
      }
    }
    if (conversation.promptRunId !== runId) {
      return;
    }
    setBusy(false, conversation);
    pendingPromptCompletions.delete(conversation.sessionId);
    setStatus(finalStatus, conversation);
  })();

  try {
    await conversation.drainPromise;
  } finally {
    conversation.drainPromise = null;
  }
}

async function sendPrompt(event) {
  event.preventDefault();
  let conversation = currentComposerConversation();
  const text = elements.input.value;
  if (
    (!text.trim() && conversation.attachments.length === 0) ||
    conversation.loading ||
    conversation.configurationBusy ||
    conversation.attachmentBusy
  ) {
    return;
  }
  const attachments = conversation.attachments.map((attachment) => ({ ...attachment }));
  const capabilityError = attachmentCapabilityError(attachments);
  if (capabilityError) {
    addMessage("system", capabilityError, null, [], conversation);
    setStatus("Attachments are not supported", conversation);
    return;
  }

  if (!state.activeSessionId) {
    conversation = await createServerConversation() ?? activeConversation();
  }
  if (!conversation?.sessionId) {
    return;
  }
  if (conversation.messages.length === 0 && conversation.sessionContext !== state.selectedContext) {
    conversation = await createServerConversation() ?? activeConversation();
  }
  if (!conversation?.sessionId) {
    return;
  }

  elements.input.value = "";
  conversation.draft = "";
  resizePromptInput();
  conversation.attachments = [];
  renderAttachmentList();
  enqueuePrompt(conversation, text, attachments);
}

function enqueuePrompt(conversation, text, attachments, reconnect = false) {
  const messageKey = nextSyntheticMessageKey("local-user", conversation);
  const queuedPrompt = {
    sessionId: conversation.sessionId,
    text,
    attachments,
    messageKey,
    reconnect
  };
  addMessage("user", text, messageKey, attachments, conversation);
  conversation.promptQueue.push(queuedPrompt);
  renderSessionList();
  if (promptIsActive(conversation)) {
    if (conversation.cancelRequested) {
      setStatus(
        `${conversation.promptQueue.length} prompt${
          conversation.promptQueue.length === 1 ? "" : "s"
        } waiting for the current prompt to stop`,
        conversation
      );
    } else {
      void cancelPrompt("Stopping current prompt...", conversation);
    }
    return;
  }
  void drainPromptQueue(conversation);
}

function retryFailedPrompt(message, conversation) {
  const retryPrompt = message.retryPrompt;
  if (!retryPrompt || !canReloadMcp(conversation)) {
    return;
  }
  if (!window.confirm(
    "MCP connections will reload before rerunning the entire prompt. " +
    "Actions that already completed may be repeated. Continue?"
  )) {
    return;
  }

  message.retryPrompt = null;
  scheduleMessagesRender(conversation, message);
  enqueuePrompt(
    conversation,
    retryPrompt.text,
    retryPrompt.attachments.map((attachment) => ({ ...attachment })),
    true
  );
}

function reconnectTools() {
  const conversation = activeConversation();
  if (!canReloadMcp(conversation)) {
    return;
  }
  enqueuePrompt(conversation, "/mcp reload", [], true);
}

async function cancelPrompt(statusMessage = "Cancelling...", conversation = activeConversation()) {
  if (!conversation?.sessionId || !promptIsActive(conversation)) {
    return;
  }
  if (conversation.cancelRequested) {
    return;
  }
  const promptId = conversation.recoveredPrompt
    ? conversation.recoveredPromptId
    : conversation.activePromptKey;
  conversation.cancelRequested = true;
  setStatus(statusMessage, conversation);
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(conversation.sessionId)}/cancel`, {
      method: "POST",
      body: JSON.stringify(promptId ? { promptId } : {})
    });
    if (result.cancelled !== true) {
      if (
        promptId === (conversation.recoveredPrompt
          ? conversation.recoveredPromptId
          : conversation.activePromptKey)
      ) {
        conversation.cancelRequested = false;
        setStatus("The current prompt has already finished", conversation);
      }
    }
  } catch (error) {
    conversation.cancelRequested = false;
    showError(error, conversation);
  }
}

function scheduleEventReconnect() {
  if (eventReconnectTimer !== null) {
    return;
  }
  eventReconnectTimer = window.setTimeout(() => {
    eventReconnectTimer = null;
    void reconnectEvents();
  }, eventReconnectDelayMs);
  eventReconnectDelayMs = Math.min(
    eventReconnectDelayMs * 2,
    eventReconnectMaximumDelayMs
  );
}

async function refreshBrowserSession() {
  const response = await fetch("/", {
    cache: "no-store",
    credentials: "same-origin"
  });
  if (!response.ok) {
    throw new Error(`Browser session refresh failed (${response.status})`);
  }
  await response.text();
}

async function reconnectEvents() {
  if (eventReconnectInProgress) {
    return;
  }
  eventReconnectInProgress = true;
  try {
    await refreshBrowserSession();
  } catch {
    eventReconnectInProgress = false;
    scheduleEventReconnect();
    return;
  }
  eventReconnectInProgress = false;
  connectEvents();
}

function connectEvents() {
  const source = new EventSource("/api/events");
  eventSource = source;
  source.addEventListener("ready", (event) => {
    if (eventSource !== source) {
      return;
    }
    eventReconnectDelayMs = eventReconnectInitialDelayMs;
    const data = JSON.parse(event.data);
    applyBranding(data.brandName, data.brandInitial);
    state.capabilities = data.capabilities ?? state.capabilities;
    state.projectsDirectory = data.projectsDirectory ?? "";
    state.newSessionDefaults = data.newSessionDefaults ?? state.newSessionDefaults;
    if (!hasStoredContextPreference() && state.newSessionDefaults?.context) {
      state.selectedContext = state.newSessionDefaults.context;
    }
    setConnection("connected", "Connected");
    void loadContextDefaults(state.selectedContext);
    void (async () => {
      try {
        await refreshSessions();
        await reconcileKnownConversationStatuses(state.activeSessionId);
        await restoreActiveConversation();
      } catch (error) {
        showError(error);
      }
    })();
    renderConversationControls();
  });
  source.addEventListener("session-update", (event) => {
    handleSessionUpdate(JSON.parse(event.data));
  });
  source.addEventListener("session-event", (event) => {
    handleRawSessionEvent(JSON.parse(event.data));
  });
  source.addEventListener("permission-request", (event) => {
    showPermissionRequest(JSON.parse(event.data));
  });
  source.addEventListener("server-error", (event) => {
    const data = JSON.parse(event.data);
    showError(new Error(data.message ?? "The local Copilot bridge reported an error"));
  });
  source.addEventListener("session-activity", (event) => {
    const data = JSON.parse(event.data);
    if (
      !data ||
      typeof data.sessionId !== "string" ||
      typeof data.lastActivityAt !== "string"
    ) {
      return;
    }
    const session = state.sessions.find((item) => item.sessionId === data.sessionId);
    if (!session) {
      void refreshSessions().catch(showError);
      return;
    }
    session.lastActivityAt = latestTimestamp(
      session.lastActivityAt,
      data.lastActivityAt
    ) ?? data.lastActivityAt;
    renderSessionList();
  });
  source.addEventListener("session-created", (event) => {
    if (!upsertSession(JSON.parse(event.data))) {
      void refreshSessions().catch(showError);
    }
  });
  source.addEventListener("session-replaced", (event) => {
    const data = JSON.parse(event.data);
    if (typeof data.previousSessionId === "string") {
      applySessionReplacement(data, data.previousSessionId);
    }
  });
  source.addEventListener("session-deleted", (event) => {
    const data = JSON.parse(event.data);
    if (typeof data?.sessionId === "string") {
      applyServerPromptState(data.sessionId, { busy: false });
      renderConversationControls();
    }
    void refreshSessions().catch(showError);
  });
  source.addEventListener("session-renamed", (event) => {
    const data = JSON.parse(event.data);
    if (
      !data ||
      typeof data.sessionId !== "string" ||
      typeof data.title !== "string"
    ) {
      return;
    }
    const session = state.sessions.find((item) => item.sessionId === data.sessionId);
    if (session) {
      session.title = data.title;
    }
    const conversation = conversationState(data.sessionId);
    conversation.activeSessionTitleOverride = data.title;
    conversation.activeSessionIsNew = false;
    renderSessionList();
  });
  source.addEventListener("session-prompt-started", (event) => {
    const data = JSON.parse(event.data);
    if (
      !data ||
      typeof data.sessionId !== "string" ||
      typeof data.promptId !== "string"
    ) {
      return;
    }
    applyServerPromptState(data.sessionId, { busy: true, promptId: data.promptId });
    const session = state.sessions.find((item) => item.sessionId === data.sessionId);
    if (!session) {
      renderConversationControls();
      void refreshSessions().catch(showError);
      return;
    }
    renderSessionList();
    renderConversationControls();
    renderConnectionStatus();
  });
  source.addEventListener("session-prompt-complete", (event) => {
    const data = JSON.parse(event.data);
    if (
      !data ||
      typeof data.sessionId !== "string" ||
      typeof data.promptId !== "string"
    ) {
      return;
    }
    const promptState = serverPromptStates.get(data.sessionId);
    if (!promptState?.promptId || promptState.promptId === data.promptId) {
      applyServerPromptState(data.sessionId, { busy: false });
    }
    renderSessionList();
    renderConversationControls();
    renderConnectionStatus();
    const conversation = conversationState(data.sessionId);
    if (finishRecoveredPrompt(data, conversation)) {
      return;
    }
    if (conversation.busy) {
      return;
    }
    if (conversation.loaded) {
      return;
    }
    pendingPromptCompletions.set(data.sessionId, data);
  });
  source.onerror = () => {
    if (eventSource !== source) {
      return;
    }
    source.close();
    setConnection("error", "Disconnected; retrying...");
    scheduleEventReconnect();
  };
}

elements.newChat.addEventListener("click", () => {
  startNewConversation();
});
elements.messages.addEventListener("scroll", updateScrollToBottomButton, { passive: true });
elements.messages.addEventListener("load", updateScrollToBottomButton, true);
elements.messages.addEventListener("toggle", updateScrollToBottomButton, true);
elements.scrollToBottom.addEventListener("click", () => {
  elements.messages.scrollTo({
    top: elements.messages.scrollHeight,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
  });
  updateScrollToBottomButton();
});
const messagesResizeObserver = new ResizeObserver(updateScrollToBottomButton);
messagesResizeObserver.observe(elements.messages);
elements.renameInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  if (!event.isComposing) {
    elements.renameForm.requestSubmit(elements.renameConfirm);
  }
});
elements.deleteDialog.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) {
    return;
  }
  event.preventDefault();
  elements.deleteForm.requestSubmit(elements.deleteConfirm);
});
elements.sessionList.addEventListener("click", (event) => {
  const button = event.target.closest("button.session-item");
  if (!button || !elements.sessionList.contains(button)) {
    return;
  }
  const sessionId = button.dataset.sessionId;
  if (sessionId) {
    void loadConversation(sessionId);
  }
});
elements.themeToggle.addEventListener("click", () => {
  themePreference = nextThemePreference(themePreference);
  saveThemePreference(themePreference);
  applyTheme(themePreference);
});
elements.sidebarToggle.addEventListener("click", () => {
  applySidebarState(!sidebarCollapsed);
  saveSidebarState(sidebarCollapsed);
});
elements.sidebarResizer.addEventListener("pointerdown", startSidebarResize);
elements.sidebarResizer.addEventListener("pointermove", updateSidebarResize);
elements.sidebarResizer.addEventListener("pointerup", finishSidebarResize);
elements.sidebarResizer.addEventListener("pointercancel", finishSidebarResize);
elements.sidebarResizer.addEventListener("lostpointercapture", finishSidebarResize);
elements.sidebarResizer.addEventListener("keydown", handleSidebarResizerKeydown);
window.addEventListener("resize", () => {
  applySidebarWidth(preferredSidebarWidth);
});
elements.modelSelect.addEventListener("change", () => {
  void changeConfigOption("model", elements.modelSelect.value);
});
elements.contextSelect.addEventListener("change", () => {
  void changeContext(elements.contextSelect.value);
});
elements.reasoningSelect.addEventListener("change", () => {
  void changeConfigOption("reasoning_effort", elements.reasoningSelect.value);
});
elements.search.addEventListener("input", renderSessionList);
elements.imagePreviewDialog.addEventListener("click", (event) => {
  if (event.target === elements.imagePreviewDialog) {
    closeImagePreview();
  }
});
elements.imagePreviewDialog.addEventListener("close", () => {
  elements.imagePreviewImage.removeAttribute("src");
  elements.imagePreviewImage.alt = "";
});
elements.attachFiles.addEventListener("click", () => {
  if (!elements.attachFiles.disabled) {
    elements.fileInput.click();
  }
});
elements.fileInput.addEventListener("change", () => {
  void addFiles(elements.fileInput.files);
  elements.fileInput.value = "";
});
elements.input.addEventListener("input", () => {
  currentComposerConversation().draft = elements.input.value;
  resizePromptInput();
});
elements.input.addEventListener("paste", handlePaste);
elements.composer.addEventListener("dragenter", (event) => {
  const conversation = currentComposerConversation();
  if (
    !hasFileTransfer(event.dataTransfer) ||
    conversation.loading ||
    conversation.configurationBusy ||
    conversation.attachmentBusy
  ) {
    return;
  }
  event.preventDefault();
  dragDepth += 1;
  elements.composer.classList.add("drop-target");
  elements.dropHint.hidden = false;
});
elements.composer.addEventListener("dragover", (event) => {
  const conversation = currentComposerConversation();
  if (
    !hasFileTransfer(event.dataTransfer) ||
    conversation.loading ||
    conversation.configurationBusy ||
    conversation.attachmentBusy
  ) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
elements.composer.addEventListener("dragleave", (event) => {
  if (!elements.composer.classList.contains("drop-target")) {
    return;
  }
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    clearDropTarget();
  }
});
elements.composer.addEventListener("drop", (event) => {
  const conversation = currentComposerConversation();
  const files = filesFromTransfer(event.dataTransfer);
  clearDropTarget();
  if (
    files.length === 0 ||
    conversation.loading ||
    conversation.configurationBusy ||
    conversation.attachmentBusy
  ) {
    return;
  }
  event.preventDefault();
  void addFiles(files);
});
elements.composer.addEventListener("submit", (event) => {
  void sendPrompt(event);
});
elements.cancel.addEventListener("click", () => {
  void cancelPrompt();
});
elements.reconnectTools.addEventListener("click", reconnectTools);
elements.keepAwake.addEventListener("click", () => {
  setScreenWakeLockEnabled(!screenWakeLock.enabled);
  screenWakeLock.error = null;
  void updateScreenWakeLock();
});
document.addEventListener("visibilitychange", () => {
  void updateScreenWakeLock();
});
window.addEventListener("pagehide", () => {
  screenWakeLock.pageActive = false;
  void updateScreenWakeLock();
});
window.addEventListener("pageshow", () => {
  screenWakeLock.pageActive = true;
  void updateScreenWakeLock();
});
elements.permissionCancel.addEventListener("click", (event) => {
  event.preventDefault();
  elements.permissionDialog.close();
  void cancelPermission();
});
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

const handleSystemThemeChange = () => {
  if (themePreference === "system") {
    applyTheme("system");
  }
};
if (typeof systemThemeQuery.addEventListener === "function") {
  systemThemeQuery.addEventListener("change", handleSystemThemeChange);
} else {
  systemThemeQuery.addListener(handleSystemThemeChange);
}

renderSessionList();
renderConversationControls();
renderAttachmentList();
renderUsage();
resizePromptInput();
renderMessages();
renderConnectionStatus();
void updateScreenWakeLock();
connectEvents();
