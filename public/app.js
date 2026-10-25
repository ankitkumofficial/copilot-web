import { inlineMarkdownToHtml, parseMarkdownList } from "./prompt-editor.js";

const defaultBrandName = "Copilot Web";
const defaultBrandInitial = "C";
const contextStorageKey = "copilot-web-context";
const activeSessionStorageKey = "copilot-web-active-session";
const selectionMessageMetadataStorageKey = "copilot-web-selection-messages";
const screenWakeLockStorageKey = "copilot-web-keep-awake";
const messageSelectionHighlightName = "copilot-web-source-selection";
const maximumSelectionMessageMetadataEntries = 500;
const selectionNoticeDurationMs = 4000;
const contextPreferences = ["default", "long_context"];
const maximumAttachmentCount = 10;
const maximumAttachmentBytes = 8 * 1024 * 1024;
const maximumAttachmentTotalBytes = 16 * 1024 * 1024;
const quotaUnavailableMessage =
  "GitHub CLI (gh) not available or not authenticated; quota could not be retrieved.";
const messagesBottomThreshold = 80;
const maximumInitialHistoryPages = 32;
const messagePanelPositions = new WeakMap();
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
    nativeMessagesActive: false,
    nativeModeKnown: false,
    nativeEventIds: new Set(),
    pendingNativeMessages: [],
    attachments: [],
    selections: [],
    nextSelectionNumber: 1,
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
    cancelRequested: false,
    recoveredPrompt: false,
    recoveredPromptId: null,
    recoveredPromptPollTimer: null,
    promptRunId: 0,
    promptRequestController: null,
    loading: false,
    history: null,
    historyLoading: false,
    historyLoadPromise: null,
    historyError: "",
    historyWarning: "",
    historyGeneration: 0,
    newerHistoryHidden: false,
    lastScrollTop: 0,
    lastScrollAtBottom: true,
    configurationBusy: false,
    attachmentBusy: false,
    pendingPermission: null,
    drainPromise: null
  };
}

function copySelectionReference(selection) {
  return {
    ...selection,
    startPath: [...selection.startPath],
    endPath: [...selection.endPath]
  };
}

function isStoredSelectionReference(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    Number.isInteger(value.number) &&
    value.number > 0 &&
    typeof value.text === "string" &&
    (value.sessionId === null || typeof value.sessionId === "string") &&
    Number.isInteger(value.messageIndex) &&
    value.messageIndex >= 0 &&
    Array.isArray(value.startPath) &&
    value.startPath.every((index) => Number.isInteger(index) && index >= 0) &&
    Number.isInteger(value.startOffset) &&
    value.startOffset >= 0 &&
    Array.isArray(value.endPath) &&
    value.endPath.every((index) => Number.isInteger(index) && index >= 0) &&
    Number.isInteger(value.endOffset) &&
    value.endOffset >= 0 &&
    (value.sourceMessageId === undefined || typeof value.sourceMessageId === "string") &&
    (value.sourceKey === undefined || value.sourceKey === null || typeof value.sourceKey === "string") &&
    (
      value.sourceOrdinal === undefined ||
      (Number.isInteger(value.sourceOrdinal) && value.sourceOrdinal >= 0)
    )
  );
}

function compactSelectionText(text) {
  return text.replace(/\s+/g, "");
}

function readSelectionMessageMetadata() {
  try {
    const stored = window.localStorage.getItem(selectionMessageMetadataStorageKey);
    if (!stored) {
      return Object.create(null);
    }
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Object.create(null);
    }
    const metadata = Object.create(null);
    for (const [sessionId, entries] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !Array.isArray(entries)) {
        continue;
      }
      metadata[sessionId] = entries.filter((entry) => (
        entry &&
        typeof entry === "object" &&
        typeof entry.promptText === "string" &&
        typeof entry.displayText === "string" &&
        Array.isArray(entry.selections) &&
        entry.selections.length > 0 &&
        entry.selections.every(isStoredSelectionReference)
      )).map((entry) => ({
        promptText: entry.promptText,
        displayText: entry.displayText,
        selections: entry.selections.map(copySelectionReference),
        ...(typeof entry.messageId === "string" ? { messageId: entry.messageId } : {}),
        ...(typeof entry.clientPromptId === "string" ? { clientPromptId: entry.clientPromptId } : {}),
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0
      }));
      if (metadata[sessionId].length === 0) {
        delete metadata[sessionId];
      }
    }
    return metadata;
  } catch (error) {
    console.warn("Unable to restore selected-message formatting", error);
    return Object.create(null);
  }
}

let selectionMessageMetadata = readSelectionMessageMetadata();
const selectionMessageRestorationCounts = new Map();

function selectionMessageMetadataEntries() {
  return Object.entries(selectionMessageMetadata).flatMap(([sessionId, entries]) => (
    entries.map((entry) => ({ sessionId, entry }))
  ));
}

function removeOldestSelectionMessageMetadata(count, protectedEntry = null) {
  const oldest = selectionMessageMetadataEntries()
    .filter(({ entry }) => entry !== protectedEntry)
    .sort((left, right) => left.entry.createdAt - right.entry.createdAt)
    .slice(0, count);
  for (const { sessionId, entry } of oldest) {
    const entries = selectionMessageMetadata[sessionId];
    const index = entries?.indexOf(entry) ?? -1;
    if (index >= 0) {
      entries.splice(index, 1);
    }
    if (entries?.length === 0) {
      delete selectionMessageMetadata[sessionId];
    }
  }
  return oldest.length;
}

function writeSelectionMessageMetadata(protectedEntry = null) {
  const overflow = selectionMessageMetadataEntries().length - maximumSelectionMessageMetadataEntries;
  if (overflow > 0) {
    removeOldestSelectionMessageMetadata(overflow, protectedEntry);
  }
  while (true) {
    try {
      if (Object.keys(selectionMessageMetadata).length === 0) {
        window.localStorage.removeItem(selectionMessageMetadataStorageKey);
      } else {
        window.localStorage.setItem(
          selectionMessageMetadataStorageKey,
          JSON.stringify(selectionMessageMetadata)
        );
      }
      return true;
    } catch (error) {
      const evictable = selectionMessageMetadataEntries()
        .filter(({ entry }) => entry !== protectedEntry)
        .length;
      if (evictable === 0) {
        console.warn("Unable to persist selected-message formatting", error);
        return false;
      }
      removeOldestSelectionMessageMetadata(Math.max(1, Math.ceil(evictable / 4)), protectedEntry);
    }
  }
}

function persistSelectionMessageMetadata(sessionId, promptText, displayText, selections) {
  const entries = selectionMessageMetadata[sessionId] ?? [];
  selectionMessageMetadata[sessionId] = entries;
  const entry = {
    promptText,
    displayText,
    selections: selections.map(copySelectionReference),
    createdAt: Date.now()
  };
  entries.push(entry);
  if (writeSelectionMessageMetadata(entry)) {
    return true;
  }
  const index = entries.indexOf(entry);
  if (index >= 0) {
    entries.splice(index, 1);
  }
  if (entries.length === 0) {
    delete selectionMessageMetadata[sessionId];
  }
  return false;
}

function pruneSelectionMessageMetadata(listedSessionIds, requestStartedAt) {
  let changed = false;
  for (const [sessionId, entries] of Object.entries(selectionMessageMetadata)) {
    if (
      listedSessionIds.has(sessionId) ||
      state.conversations.has(sessionId) ||
      entries.some((entry) => entry.createdAt >= requestStartedAt)
    ) {
      continue;
    }
    delete selectionMessageMetadata[sessionId];
    selectionMessageRestorationCounts.delete(sessionId);
    changed = true;
  }
  if (changed) {
    writeSelectionMessageMetadata();
  }
}

function parseSelectionPrompt(text) {
  const marker = "\n\nSelected passages from the conversation:\n";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const selectionText = text.slice(markerIndex + marker.length);
  const headers = Array.from(
    selectionText.matchAll(/(?:^|\n\n)Selection (\d+):\n/g)
  );
  if (headers.length === 0 || headers[0].index !== 0) {
    return null;
  }

  const selections = [];
  for (const [index, header] of headers.entries()) {
    const nextHeader = headers[index + 1];
    const contentStart = header.index + header[0].length;
    const contentEnd = nextHeader?.index ?? selectionText.length;
    const lines = selectionText.slice(contentStart, contentEnd).split("\n");
    if (!lines.every((line) => line.startsWith("> "))) {
      return null;
    }
    const selectedText = lines.map((line) => line.slice(2)).join("\n").trim();
    const number = Number(header[1]);
    if (!selectedText || !Number.isInteger(number) || number < 1) {
      return null;
    }
    selections.push({ number, text: selectedText });
  }
  return {
    displayText: text.slice(0, markerIndex),
    selections
  };
}

function messageSelectionSearchText(message) {
  if (message.role !== "assistant" && message.role !== "user") {
    return message.text;
  }
  const rendered = document.createElement("div");
  rendered.innerHTML = renderMarkdown(message.text);
  return rendered.textContent ?? "";
}

function findSelectionSourceMessageIndex(conversation, beforeIndex, selectedText) {
  const compactSelection = compactSelectionText(selectedText);
  if (!compactSelection) {
    return -1;
  }
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    if (compactSelectionText(messageSelectionSearchText(message)).includes(compactSelection)) {
      return index;
    }
  }
  return -1;
}

function restoreSelectionMessageMetadata(message, conversation) {
  if (
    !conversation.loading ||
    !conversation.sessionId ||
    message.role !== "user" ||
    message.selectionMetadataRestored
  ) {
    return;
  }
  const promptText = message.rawSelectionPromptText ?? message.text;
  const storedEntries = selectionMessageMetadata[conversation.sessionId] ?? [];
  const recoveredPrompt = parseSelectionPrompt(promptText);
  const identified = storedEntries.find((entry) => (
    (message.nativeMessageId && entry.messageId === message.nativeMessageId) ||
    (message.clientPromptId && entry.clientPromptId === message.clientPromptId)
  ));
  const entries = identified ? [identified]
    : storedEntries.filter((entry) => (
      entry.promptText === promptText ||
      entry.displayText === promptText ||
      (recoveredPrompt && entry.displayText === recoveredPrompt.displayText)
    ));
  const sessionCounts = selectionMessageRestorationCounts.get(conversation.sessionId) ?? new Map();
  const matchingIndex = identified
    ? 0
    : Math.min(sessionCounts.get(promptText) ?? 0, entries.length - 1);
  const entry = entries[matchingIndex];
  if (entry) {
    if (!identified) {
      sessionCounts.set(promptText, matchingIndex + 1);
      selectionMessageRestorationCounts.set(conversation.sessionId, sessionCounts);
    }
    message.text = entry.displayText;
    message.selections = entry.selections.map(copySelectionReference);
    message.selectionMetadataRestored = true;
    return;
  }

  const recovered = recoveredPrompt;
  if (!recovered) {
    return;
  }
  const messageIndex = conversation.messages.indexOf(message);
  const selections = recovered.selections.map((selection) => {
    const sourceIndex = findSelectionSourceMessageIndex(
      conversation,
      messageIndex,
      selection.text
    );
    return {
      id: `selection-${selection.number}`,
      number: selection.number,
      text: selection.text,
      sessionId: conversation.sessionId,
      messageIndex: Math.max(0, sourceIndex),
      ...(sourceIndex >= 0 && conversation.messages[sourceIndex].nativeMessageId
        ? { sourceMessageId: conversation.messages[sourceIndex].nativeMessageId } : {}),
      startPath: [],
      startOffset: 0,
      endPath: [],
      endOffset: 0
    };
  });
  message.text = recovered.displayText;
  message.selections = selections;
  message.selectionMetadataRestored = true;
}

function moveSelectionMessageMetadata(previousSessionId, nextSessionId) {
  const entries = selectionMessageMetadata[previousSessionId];
  if (entries) {
    selectionMessageMetadata[nextSessionId] = [
      ...(selectionMessageMetadata[nextSessionId] ?? []),
      ...entries.map((entry) => ({
        ...entry,
        selections: entry.selections.map((selection) => ({
          ...copySelectionReference(selection),
          sessionId: selection.sessionId === previousSessionId
            ? nextSessionId
            : selection.sessionId
        }))
      }))
    ];
    delete selectionMessageMetadata[previousSessionId];
    writeSelectionMessageMetadata();
  }
  selectionMessageRestorationCounts.delete(previousSessionId);
  selectionMessageRestorationCounts.delete(nextSessionId);
}

function clearSelectionMessageMetadata(sessionId) {
  delete selectionMessageMetadata[sessionId];
  selectionMessageRestorationCounts.delete(sessionId);
  writeSelectionMessageMetadata();
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
  nativeMessageHistoryAvailable: false,
  quota: {
    status: "loading",
    used: null,
    total: null
  },
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
    conversation.nativeMessagesActive = state.nativeMessageHistoryAvailable;
    conversation.nativeModeKnown = !state.nativeMessageHistoryAvailable;
    state.conversations.set(sessionId, conversation);
  }
  return conversation ?? null;
}

function activeConversation() {
  return conversationState(state.activeSessionId, false);
}

function messageIdentity(message) {
  if (message.nativeMessageId) {
    return `native:${message.role}:${message.nativeMessageId}`;
  }
  if (message.role === "tool") {
    return message.toolActivities?.length > 0
      ? `tool:${message.toolActivities[0].id}`
      : message.toolGroupKey;
  }
  return message.displayKey ?? message.localMessageKey ?? null;
}

function reindexMessages(conversation) {
  conversation.messageKeys.clear();
  const indexes = new Map();
  conversation.messages.forEach((message, index) => {
    for (const key of [
      messageIdentity(message),
      message.displayKey,
      message.localMessageKey
    ]) {
      if (key) {
        conversation.messageKeys.set(key, index);
        indexes.set(key, index);
      }
    }
  });
  if (isActiveConversation(conversation)) {
    for (const article of elements.messages.querySelectorAll(".message")) {
      const index = indexes.get(article.dataset.messageKey);
      if (index !== undefined) {
        article.dataset.messageIndex = String(index);
      }
    }
  }
  conversation.nativeEventIds = new Set(conversation.messages
    .map((message) => message.nativeEventId)
    .filter(Boolean));
}

function currentComposerConversation() {
  return activeConversation() ?? state.composer;
}

function isActiveConversation(conversation) {
  return conversation === activeConversation();
}
let defaultsRequestId = 0;
let quotaRequestId = 0;
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
let pendingMessageSelection = null;
let pointerSelectionInProgress = false;
let keyboardSelectionInProgress = false;
let messageSelectionHighlightTimer = null;
let activeMessageSelectionHighlight = null;
let selectionNoticeTimer = null;
let renderedMessagesConversation = null;

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
  usageQuotaMetric: document.querySelector("#usage-quota-metric"),
  usageQuotaValue: document.querySelector("#usage-quota-value"),
  usageQuotaWarning: document.querySelector("#usage-quota-warning"),
  messages: document.querySelector("#messages"),
  scrollToBottom: document.querySelector("#scroll-to-bottom"),
  askSelection: document.querySelector("#ask-selection"),
  selectionList: document.querySelector("#selection-list"),
  selectionStatus: document.querySelector("#selection-status"),
  emptyState: document.querySelector("#empty-state"),
  loadingState: document.querySelector("#loading-state"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#prompt-input"),
  attachmentList: document.querySelector("#attachment-list"),
  dropHint: document.querySelector("#drop-hint"),
  attachFiles: document.querySelector("#attach-files"),
  fileInput: document.querySelector("#file-input"),
  voiceInput: document.querySelector("#voice-input"),
  voiceInputStatus: document.querySelector("#voice-input-status"),
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

const speechRecognitionConstructor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
const voiceInputState = {
  supported: Boolean(window.isSecureContext) && typeof speechRecognitionConstructor === "function",
  unavailableReason: window.isSecureContext
    ? "Speech recognition is not supported by this browser."
    : "Voice input requires HTTPS or localhost.",
  session: null,
  notice: null
};
let pendingVoiceSubmit = null;

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
  return inlineMarkdownToHtml(value, {
    resolveLink: safeLink,
    linkAttributes: ' target="_blank" rel="noopener noreferrer"',
    preserveDelimiters: false,
    strikeTag: "del"
  });
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
      blocks.push(
        `<div class="code-block">${codeCopyButtonMarkup}<pre><code${language}>${escapeHtml(codeLines.join("\n"))}</code></pre></div>`
      );
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

    if (/^ *([-+*]|\d{1,9}[.)]) +/.test(line)) {
      flushParagraph();
      const list = parseMarkdownList(lines, index, renderInlineMarkdown);
      blocks.push(list.html);
      index = list.next;
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
    const error = new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
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

function renderVoiceInputControl() {
  const session = voiceInputState.session;
  const active = Boolean(session);
  const conversation = currentComposerConversation();
  const iconName = active ? "stop" : "microphone";
  if (elements.voiceInput.dataset.icon !== iconName) {
    elements.voiceInput.innerHTML = iconName === "stop"
      ? '<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>'
      : '<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2m7 9v3m-4 0h8"></path></svg>';
    elements.voiceInput.dataset.icon = iconName;
  }

  const label = active
    ? session.status === "starting" ? "Cancel voice input" : "Stop voice input"
    : voiceInputState.supported ? "Start voice input" : "Voice input unavailable";
  elements.voiceInput.disabled = !voiceInputState.supported || (
    !active && conversation.loading
  );
  elements.voiceInput.title = active ? label : (
    voiceInputState.supported ? label : voiceInputState.unavailableReason
  );
  elements.voiceInput.setAttribute("aria-label", label);
  elements.voiceInput.setAttribute("aria-pressed", String(active));
  elements.voiceInput.dataset.state = session?.status ??
    (voiceInputState.notice?.type === "error" ? "error" : "idle");

  const notice = voiceInputState.notice;
  elements.voiceInputStatus.textContent = notice?.message ?? "";
  elements.voiceInputStatus.hidden = !notice;
  elements.voiceInputStatus.dataset.state = notice?.type ?? "";
}

function appendSpeechSegment(current, segment) {
  if (
    current &&
    segment &&
    !/\s$/.test(current) &&
    !/^[,.;:!?%)\]}]/.test(segment)
  ) {
    return `${current} ${segment}`;
  }
  return `${current}${segment}`;
}

function transcriptFromSpeechResults(results) {
  let finalTranscript = "";
  let interimTranscript = "";
  for (const result of Array.from(results ?? [])) {
    const transcript = result?.[0]?.transcript;
    if (typeof transcript !== "string" || transcript.length === 0) {
      continue;
    }
    if (result.isFinal) {
      finalTranscript = appendSpeechSegment(finalTranscript, transcript);
    } else {
      interimTranscript = appendSpeechSegment(interimTranscript, transcript);
    }
  }
  return appendSpeechSegment(finalTranscript, interimTranscript).trim();
}

function formatVoiceTranscript(transcript, prefix, suffix) {
  let formatted = transcript.trim();
  if (!formatted) {
    return "";
  }
  if (
    prefix &&
    !/\s$/.test(prefix) &&
    !/^[,.;:!?%)\]}]/.test(formatted)
  ) {
    formatted = ` ${formatted}`;
  }
  if (
    suffix &&
    !/^\s/.test(suffix) &&
    !/[ \t\n]$/.test(formatted) &&
    !/^[,.;:!?%)\]}]/.test(suffix)
  ) {
    formatted += " ";
  }
  return formatted;
}

function updateVoiceInputRangeAfterEdit(session, nextValue) {
  const previousValue = session.lastDraftValue;
  if (previousValue === nextValue) {
    return true;
  }

  let changedStart = 0;
  while (
    changedStart < previousValue.length &&
    changedStart < nextValue.length &&
    previousValue[changedStart] === nextValue[changedStart]
  ) {
    changedStart += 1;
  }
  let unchangedSuffix = 0;
  while (
    unchangedSuffix < previousValue.length - changedStart &&
    unchangedSuffix < nextValue.length - changedStart &&
    previousValue[previousValue.length - unchangedSuffix - 1] ===
      nextValue[nextValue.length - unchangedSuffix - 1]
  ) {
    unchangedSuffix += 1;
  }

  const changedEnd = previousValue.length - unchangedSuffix;
  const nextChangedEnd = nextValue.length - unchangedSuffix;
  if (changedEnd <= session.start) {
    const change = nextChangedEnd - changedEnd;
    session.start += change;
    session.end += change;
  } else if (changedStart < session.end) {
    return false;
  }
  session.lastDraftValue = nextValue;
  return true;
}

function voiceDraftFor(conversation) {
  return currentComposerConversation() === conversation
    ? elements.input.value
    : conversation.draft;
}

function updateVoiceDraft(conversation, value, selectionEnd) {
  conversation.draft = value;
  if (currentComposerConversation() !== conversation) {
    return;
  }
  elements.input.value = value;
  elements.input.setSelectionRange(selectionEnd, selectionEnd);
  resizePromptInput();
}

function updateVoiceTranscript(session, results) {
  if (voiceInputState.session !== session || !session.acceptResults) {
    return;
  }
  const currentValue = voiceDraftFor(session.conversation);
  if (currentValue.slice(session.start, session.end) !== session.renderedText) {
    void stopVoiceInput(session, {
      discardResults: true,
      notice: "Voice input stopped because the dictated text was edited."
    });
    return;
  }

  const transcript = transcriptFromSpeechResults(results);
  const replacement = transcript
    ? formatVoiceTranscript(
      transcript,
      currentValue.slice(0, session.start),
      currentValue.slice(session.end)
    )
    : session.originalText;
  const nextValue = currentValue.slice(0, session.start) +
    replacement +
    currentValue.slice(session.end);
  session.end = session.start + replacement.length;
  session.renderedText = replacement;
  session.lastDraftValue = nextValue;
  updateVoiceDraft(session.conversation, nextValue, session.end);
}

function voiceStartErrorMessage(error) {
  const name = error && typeof error === "object" && "name" in error
    ? String(error.name)
    : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was denied. Allow microphone access in your browser and try again.";
  }
  return "Unable to start voice input. Check your microphone and browser permissions, then try again.";
}

function voiceRecognitionErrorMessage(error) {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access or speech recognition was denied. Check your browser permissions and try again.";
    case "audio-capture":
      return "No microphone is available. Connect or enable a microphone and try again.";
    case "network":
      return "Speech recognition could not connect. Check your network and try again.";
    case "no-speech":
      return "No speech was detected. Click the microphone to try again.";
    case "language-not-supported":
      return "This browser does not support speech recognition for the selected language.";
    case "aborted":
      return "Voice input was interrupted.";
    default:
      return "Voice input failed. Check your microphone and browser permissions, then try again.";
  }
}

function finishVoiceInput(session) {
  if (session.finished) {
    return;
  }
  session.finished = true;
  if (voiceInputState.session === session) {
    voiceInputState.session = null;
    if (session.errorMessage) {
      voiceInputState.notice = { message: session.errorMessage, type: "error" };
    } else if (session.stopNotice) {
      voiceInputState.notice = { message: session.stopNotice, type: "status" };
    } else if (!session.stopRequested) {
      voiceInputState.notice = {
        message: "Voice input ended. Click the microphone to start again.",
        type: "status"
      };
    } else {
      voiceInputState.notice = null;
    }
    renderVoiceInputControl();
  }
  session.resolveEnded();
}

function stopVoiceInput(session = voiceInputState.session, {
  discardResults = false,
  notice = null
} = {}) {
  if (!session) {
    return Promise.resolve();
  }
  if (discardResults) {
    session.acceptResults = false;
  }
  if (notice) {
    session.stopNotice = notice;
  }
  if (session.stopRequested) {
    return session.endedPromise;
  }

  session.stopRequested = true;
  session.status = "stopping";
  voiceInputState.notice = notice
    ? { message: notice, type: "status" }
    : { message: "Stopping voice input…", type: "status" };
  renderVoiceInputControl();
  try {
    if (session.started) {
      session.recognition.stop();
    } else {
      session.recognition.abort();
    }
  } catch (error) {
    session.acceptResults = false;
    session.errorMessage = "Unable to stop voice input. The browser could not stop microphone access.";
    voiceInputState.notice = { message: session.errorMessage, type: "error" };
    renderVoiceInputControl();
    try {
      session.recognition.abort();
    } catch {
      finishVoiceInput(session);
    }
  }
  return session.endedPromise;
}

function startVoiceInput() {
  if (!voiceInputState.supported || voiceInputState.session) {
    return;
  }
  const conversation = currentComposerConversation();
  if (conversation.loading) {
    return;
  }

  let recognition;
  try {
    recognition = new speechRecognitionConstructor();
  } catch (error) {
    voiceInputState.notice = { message: voiceStartErrorMessage(error), type: "error" };
    renderVoiceInputControl();
    return;
  }

  const draft = elements.input.value;
  const start = elements.input.selectionStart ?? draft.length;
  const end = elements.input.selectionEnd ?? start;
  let resolveEnded;
  const endedPromise = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const session = {
    recognition,
    conversation,
    start,
    end,
    originalText: draft.slice(start, end),
    renderedText: draft.slice(start, end),
    lastDraftValue: draft,
    status: "starting",
    started: false,
    stopRequested: false,
    stopNotice: null,
    acceptResults: true,
    errorMessage: null,
    finished: false,
    endedPromise,
    resolveEnded
  };
  voiceInputState.session = session;
  voiceInputState.notice = { message: "Starting voice input…", type: "status" };

  recognition.lang = navigator.language || "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    if (session.finished) {
      return;
    }
    session.started = true;
    if (session.stopRequested) {
      try {
        recognition.stop();
      } catch (error) {
        session.errorMessage = "Unable to stop voice input. The browser could not stop microphone access.";
        voiceInputState.notice = { message: session.errorMessage, type: "error" };
        finishVoiceInput(session);
      }
      return;
    }
    session.status = "recording";
    voiceInputState.notice = {
      message: "Listening… Click the cross button to stop.",
      type: "listening"
    };
    renderVoiceInputControl();
  };
  recognition.onresult = (event) => {
    updateVoiceTranscript(session, event.results);
  };
  recognition.onerror = (event) => {
    if (voiceInputState.session !== session || (event.error === "aborted" && session.stopRequested)) {
      return;
    }
    session.errorMessage = voiceRecognitionErrorMessage(event.error);
    voiceInputState.notice = { message: session.errorMessage, type: "error" };
    renderVoiceInputControl();
  };
  recognition.onend = () => {
    finishVoiceInput(session);
  };
  renderVoiceInputControl();
  try {
    recognition.start();
  } catch (error) {
    session.acceptResults = false;
    session.errorMessage = voiceStartErrorMessage(error);
    finishVoiceInput(session);
  }
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

const quotaNumberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2
});

function formatContextTokens(tokens) {
  return contextTokenFormatter.format(tokens);
}

function renderQuota() {
  const quota = state.quota;
  elements.usageQuotaMetric.hidden = false;
  elements.usageQuotaWarning.hidden = quota.status !== "unavailable";
  elements.usageQuotaWarning.title = quotaUnavailableMessage;
  elements.usageQuotaWarning.setAttribute("aria-label", quotaUnavailableMessage);
  elements.usageQuotaValue.hidden = quota.status === "unavailable";
  elements.usageQuotaValue.title = quota.status === "available"
    ? "Account-level quota usage: used / total."
    : "";
  elements.usageQuotaValue.textContent = quota.status === "available"
    ? `${quotaNumberFormatter.format(quota.used)} / ${quotaNumberFormatter.format(quota.total)}`
    : quota.status === "loading"
      ? "Loading..."
      : "";
}

async function refreshQuota() {
  const requestId = ++quotaRequestId;
  try {
    const result = await api("/api/quota");
    if (requestId !== quotaRequestId) {
      return;
    }
    if (
      typeof result.used !== "number" ||
      !Number.isFinite(result.used) ||
      result.used < 0 ||
      typeof result.total !== "number" ||
      !Number.isFinite(result.total) ||
      result.total < 0
    ) {
      throw new Error("Quota response contains invalid values");
    }
    state.quota = {
      status: "available",
      used: result.used,
      total: result.total
    };
  } catch {
    if (requestId !== quotaRequestId) {
      return;
    }
    state.quota = {
      status: "unavailable",
      used: null,
      total: null
    };
  }
  renderUsage();
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
  elements.usageSummary.hidden = false;
  elements.usageAicMetric.title =
    "Cumulative AI credits used in this session; when a session limit is shown, format is used / limit.";
  elements.usageContextMetric.title =
    "Latest ACP-reported context usage: tokens used / total context-window size.";
  renderQuota();
  if (hasAicUsage) {
    elements.usageAic.textContent = `${formatAic(aicNano)}${
      Number.isFinite(aicLimit) ? ` / ${formatAic(aicLimit)}` : ""
    } credits`;
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
  const previousUsage = conversation.usage;
  const usage = {
    aicNano: typeof value.aicNano === "number" && Number.isFinite(value.aicNano)
      ? value.aicNano
      : null,
    aicLimit: typeof value.aicLimit === "number" && Number.isFinite(value.aicLimit)
      ? value.aicLimit
      : null
  };
  conversation.usage = usage;
  if (usage.aicNano !== previousUsage.aicNano || usage.aicLimit !== previousUsage.aicLimit) {
    void refreshQuota();
  }
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
  if (declared && declared !== "application/octet-stream") {
    return declared;
  }

  const name = String(file.name ?? "").toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  return imageMimeTypesByExtension[extension] ??
    (extension === ".pdf" ? "application/pdf" : "application/octet-stream");
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
  renderVoiceInputControl();
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

    const isImage = attachment.mimeType.startsWith("image/");
    const preview = document.createElement(isImage ? "button" : "div");
    preview.className = "attachment-chip-preview";
    if (isImage) {
      preview.type = "button";
      preview.classList.add("attachment-chip-image-preview");
      preview.title = `Preview ${attachment.name}`;
      preview.setAttribute("aria-label", `Preview ${attachment.name}`);
      const source = attachmentDataUrl(attachment);
      preview.addEventListener("click", () => {
        openImagePreview(source, attachment.name);
      });
      const image = document.createElement("img");
      image.src = source;
      image.alt = "";
      preview.append(image);
    } else {
      preview.textContent = attachment.mimeType === "application/pdf" ? "PDF" : "FILE";
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

function renderSelectionList() {
  const conversation = currentComposerConversation();
  elements.selectionList.replaceChildren();
  for (const selection of conversation.selections) {
    const card = document.createElement("div");
    card.className = "selection-card";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "selection-card-open";
    open.title = `Jump to Selection ${selection.number}`;
    open.setAttribute("aria-label", `Jump to Selection ${selection.number} at its source`);
    open.addEventListener("click", () => {
      jumpToSelection(selection);
    });

    const text = document.createElement("span");
    text.className = "selection-card-text";
    text.textContent = selection.text;

    const label = document.createElement("span");
    label.className = "selection-card-label";
    label.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-5 4v-4a2 2 0 0 1-3-2V6a2 2 0 0 1 2-2Z"></path><path d="M9 8h6m-6 3h4"></path></svg>';
    const number = document.createElement("span");
    number.textContent = `Selection ${selection.number}`;
    label.append(number);
    open.append(text, label);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "selection-card-remove";
    remove.textContent = "×";
    remove.title = `Remove Selection ${selection.number}`;
    remove.setAttribute("aria-label", `Remove Selection ${selection.number}`);
    remove.addEventListener("click", () => {
      removeSelection(selection.id);
    });

    card.append(open, remove);
    elements.selectionList.append(card);
  }
  elements.input.placeholder = conversation.selections.length > 0
    ? "Ask Copilot about these selections..."
    : "Message Copilot...";
}

function removeSelection(id) {
  const conversation = currentComposerConversation();
  conversation.selections = conversation.selections.filter((selection) => selection.id !== id);
  renderSelectionList();
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
  const errors = [];
  let added = 0;
  try {
    for (const file of files) {
      const name = file.name || "attachment";
      const mimeType = fileMimeType(file);
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

function insertTextAtCursor(text, html = "") {
  const input = elements.input;
  if (typeof input.insertClipboard === "function") {
    input.insertClipboard({ text, html });
    return;
  }
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
  const html = event.clipboardData?.getData("text/html") ?? "";
  if (text || html) {
    insertTextAtCursor(text, html);
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
    attachments.some((attachment) => !attachment.mimeType.startsWith("image/")) &&
    promptCapabilities.embeddedContext !== true
  ) {
    return "This Copilot agent does not support file attachments.";
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
const codeCopyButtonMarkup =
  `<button type="button" class="code-copy" title="Copy code" aria-label="Copy code">${copyIconMarkup.trim()}</button>`;
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

function removeCodeCopyButtons(html) {
  const container = document.createElement("div");
  container.innerHTML = html;
  container.querySelectorAll(".code-copy").forEach((button) => button.remove());
  return container.innerHTML;
}

function messageClipboardContent(message, button) {
  const fallbackText = messageClipboardText(message);
  if (message.role !== "assistant") {
    const html = message.role === "user"
      ? renderMarkdown(fallbackText)
      : `<div>${escapeHtml(fallbackText).replaceAll("\n", "<br>")}</div>`;
    return {
      text: fallbackText,
      html: removeCodeCopyButtons(html)
    };
  }

  const body = button.closest(".message")?.querySelector(".message-body");
  const html = body?.innerHTML ?? renderMarkdown(fallbackText);
  const text = body?.innerText || body?.textContent || fallbackText;
  return { text, html: removeCodeCopyButtons(html) };
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

async function copyCodeBlock(button) {
  const code = button.closest(".code-block")?.querySelector("pre code");
  if (!code) {
    return;
  }

  const text = code.textContent ?? "";
  try {
    await copyToClipboard({
      text,
      html: `<pre><code>${escapeHtml(text)}</code></pre>`
    });
    button.classList.add("copied");
    button.innerHTML = copiedIconMarkup;
    button.title = "Code copied";
    button.setAttribute("aria-label", "Code copied");
    window.setTimeout(() => {
      button.classList.remove("copied");
      button.innerHTML = copyIconMarkup;
      button.title = "Copy code";
      button.setAttribute("aria-label", "Copy code");
    }, 1400);
  } catch {
    setStatus("Could not copy code");
    button.title = "Could not copy code";
    button.setAttribute("aria-label", "Could not copy code");
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

function startUserMessageTurn(key, conversation) {
  conversation.currentToolGroupKey = `tool-group:${key}`;
  conversation.currentTurnKey = key;
  conversation.currentAssistantMessageKey = null;
  conversation.currentAssistantTurnKey = null;
  conversation.lastStreamRole = "user";
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
      startUserMessageTurn(key, conversation);
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
    startUserMessageTurn(key, conversation);
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

function createToolGroup(toolGroupKey) {
  return {
    role: "tool",
    displayKey: toolGroupKey,
    text: "",
    toolGroupKey,
    toolActivities: [],
    toolActivitiesExpanded: false,
    thinkingText: "",
    thinkingExpanded: false
  };
}

function mergeToolGroupContents(older, newer, target) {
  const olderThinking = typeof older.thinkingText === "string" ? older.thinkingText : "";
  const newerThinking = typeof newer.thinkingText === "string" ? newer.thinkingText : "";
  if (!olderThinking) {
    target.thinkingText = newerThinking;
  } else if (!newerThinking || olderThinking.includes(newerThinking)) {
    target.thinkingText = olderThinking;
  } else if (newerThinking.includes(olderThinking)) {
    target.thinkingText = newerThinking;
  } else {
    target.thinkingText = `${olderThinking}\n\n${newerThinking}`;
  }

  const activities = [];
  const activitiesById = new Map();
  const mergeActivities = (source, isNewer) => {
    for (const activity of Array.isArray(source.toolActivities) ? source.toolActivities : []) {
      const existing = activitiesById.get(activity.id);
      if (!existing) {
        const copy = { ...activity };
        activities.push(copy);
        activitiesById.set(copy.id, copy);
        continue;
      }
      if (!isNewer) {
        continue;
      }
      if (
        typeof activity.title === "string" &&
        activity.title.length > 0 &&
        (activity.title !== "Copilot tool" || existing.title === "Copilot tool")
      ) {
        existing.title = activity.title;
      }
      if (typeof activity.status === "string" && activity.status.length > 0) {
        existing.status = activity.status;
      }
      if (typeof activity.detail === "string" && activity.detail.length > 0) {
        existing.detail = activity.detail;
      }
    }
  };
  mergeActivities(older, false);
  mergeActivities(newer, true);
  target.toolActivities = activities;
  target.thinkingExpanded = older.thinkingExpanded === true || newer.thinkingExpanded === true;
  target.toolActivitiesExpanded =
    older.toolActivitiesExpanded === true || newer.toolActivitiesExpanded === true;
  target.acpThinking = older.acpThinking === true || newer.acpThinking === true;
  target.lastPart = newer.lastPart ?? older.lastPart;
}

// Page boundaries can split one uninterrupted Thinking panel into adjacent tool groups.
function mergeAdjacentToolGroups(messages, conversation) {
  for (let index = 0; index < messages.length - 1;) {
    const older = messages[index];
    const newer = messages[index + 1];
    if (older?.role !== "tool" || newer?.role !== "tool") {
      index += 1;
      continue;
    }
    mergeToolGroupContents(older, newer, older);
    if (conversation.currentToolGroupKey === newer.toolGroupKey) {
      conversation.currentToolGroupKey = older.toolGroupKey;
    }
    messages.splice(index + 1, 1);
  }
}

function ensureToolGroup(conversation = activeConversation() ?? state.composer) {
  conversation.lastStreamRole = "tool";
  let group = conversation.currentToolGroupKey
    ? conversation.messages.find((message) => (
      message.role === "tool" &&
      message.toolGroupKey === conversation.currentToolGroupKey
    ))
    : null;
  if (group) {
    return group;
  }

  // Thinking and tool activity with no visible message in between stay in one panel.
  const previous = conversation.messages.at(-1);
  if (previous?.role === "tool") {
    conversation.currentToolGroupKey = previous.toolGroupKey;
    previous.lastPart = null;
    return previous;
  }

  if (!conversation.currentToolGroupKey) {
    conversation.toolGroupCounter += 1;
    conversation.currentToolGroupKey = `tool-group:orphan:${conversation.toolGroupCounter}`;
  }
  group = createToolGroup(conversation.currentToolGroupKey);
  conversation.messages.push(group);
  return group;
}

function updateContentText(update) {
  const content = contentText(update.content);
  if (content.length > 0) {
    return content;
  }
  return typeof update.text === "string" ? update.text : "";
}

function appendThinkingText(group, text) {
  const separator = group.thinkingText && group.lastPart !== "thinking" ? "\n\n" : "";
  group.thinkingText = `${group.thinkingText ?? ""}${separator}${text}`;
  group.lastPart = "thinking";
}

function upsertThinking(update, conversation = activeConversation() ?? state.composer) {
  const thought = updateContentText(update);
  if (thought.length === 0) {
    return;
  }
  const group = ensureToolGroup(conversation);
  appendThinkingText(group, thought);
  group.acpThinking = true;
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
  group.lastPart = "tool";
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
      if (message.role === "user") {
        text.innerHTML = renderMarkdown(message.text);
      } else {
        text.textContent = message.text;
      }
      body.append(text);
    }
    renderMessageAttachments(body, message.attachments);
  }
}

function renderMessageTimestamp(article, message) {
  let timestamp = article.querySelector("time.message-timestamp");
  const date = (message.role === "assistant" || message.role === "user") &&
    message.completed === true &&
    typeof message.timestamp === "string"
    ? new Date(message.timestamp)
    : null;
  if (!date || !Number.isFinite(date.getTime())) {
    timestamp?.remove();
    return;
  }
  if (!timestamp) {
    timestamp = document.createElement("time");
    timestamp.className = "message-timestamp";
  }
  timestamp.dateTime = date.toISOString();
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
  timestamp.textContent = isToday
    ? `Today, ${time}`
    : date.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  timestamp.title = date.toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "long"
  });
  article.querySelector(".message-body")?.after(timestamp);
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
      image.loading = "lazy";
      image.decoding = "async";
      preview.append(image);
      item.append(preview);
    } else {
      const link = document.createElement("a");
      link.className = "message-attachment-file";
      link.href = attachmentDataUrl(attachment);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.download = attachment.name;
      link.textContent = `${attachment.mimeType === "application/pdf" ? "PDF" : "File"}: ${attachment.name}`;
      item.append(link);
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
    messagePanelPositions.set(message, panelPositions);
  });
  return positions;
}

function restoreMessagePanelScroll(article, message, positions) {
  const savedPositions = positions.get(message) ?? messagePanelPositions.get(message);
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

function hideAskSelection() {
  pendingMessageSelection = null;
  elements.askSelection.hidden = true;
  elements.askSelection.style.removeProperty("left");
  elements.askSelection.style.removeProperty("top");
  elements.askSelection.style.removeProperty("visibility");
}

function selectionMatchesRange(selection, range) {
  if (!selection || selection.rangeCount !== 1) {
    return false;
  }
  const currentRange = selection.getRangeAt(0);
  return currentRange.startContainer === range.startContainer &&
    currentRange.startOffset === range.startOffset &&
    currentRange.endContainer === range.endContainer &&
    currentRange.endOffset === range.endOffset;
}

function clearMessageSelectionHighlight() {
  if (messageSelectionHighlightTimer !== null) {
    window.clearTimeout(messageSelectionHighlightTimer);
    messageSelectionHighlightTimer = null;
  }
  const highlight = activeMessageSelectionHighlight;
  activeMessageSelectionHighlight = null;
  if (!highlight) {
    return;
  }
  highlight.body.classList.remove("selection-flash");
  if (highlight.custom) {
    window.CSS?.highlights?.delete(messageSelectionHighlightName);
  }
  const selection = window.getSelection();
  if (selection && selectionMatchesRange(selection, highlight.range)) {
    selection.removeAllRanges();
  }
}

function messageBodyForSelectionNode(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return element?.closest(".message-body") ?? null;
}

function selectionNodePath(root, node) {
  const path = [];
  let current = node;
  while (current && current !== root) {
    const parent = current.parentNode;
    if (!parent) {
      return null;
    }
    const index = Array.prototype.indexOf.call(parent.childNodes, current);
    if (index < 0) {
      return null;
    }
    path.unshift(index);
    current = parent;
  }
  return current === root ? path : null;
}

function selectableMessageArticles() {
  return Array.from(elements.messages.querySelectorAll(".message.user, .message.assistant"));
}

function messageSelectionReference(selection) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const text = selection.toString().trim();
  const range = selection.getRangeAt(0);
  const body = messageBodyForSelectionNode(range.startContainer);
  const message = body?.closest(".message");
  if (
    !text ||
    !body ||
    body !== messageBodyForSelectionNode(range.endContainer) ||
    !elements.messages.contains(body) ||
    !message ||
    (!message.classList.contains("user") && !message.classList.contains("assistant"))
  ) {
    return null;
  }

  const conversation = currentComposerConversation();
  const messageIndex = Number(message.dataset.messageIndex);
  const startPath = selectionNodePath(body, range.startContainer);
  const endPath = selectionNodePath(body, range.endContainer);
  if (
    !Number.isInteger(messageIndex) ||
    !conversation.messages[messageIndex] ||
    startPath === null ||
    endPath === null
  ) {
    return null;
  }
  return {
    range,
    reference: {
      text,
      sessionId: conversation.sessionId,
      messageIndex,
      sourceMessageId: conversation.messages[messageIndex].nativeMessageId,
      sourceKey: messageIdentity(conversation.messages[messageIndex]),
      sourceOrdinal: selectableMessageArticles().indexOf(message),
      startPath,
      startOffset: range.startOffset,
      endPath,
      endOffset: range.endOffset
    }
  };
}

function updateAskSelection() {
  if (pointerSelectionInProgress || keyboardSelectionInProgress) {
    hideAskSelection();
    return;
  }
  const selection = window.getSelection();
  if (
    selection &&
    activeMessageSelectionHighlight &&
    !activeMessageSelectionHighlight.custom &&
    selectionMatchesRange(selection, activeMessageSelectionHighlight.range)
  ) {
    hideAskSelection();
    return;
  }
  const selected = messageSelectionReference(selection);
  if (!selected) {
    hideAskSelection();
    return;
  }

  const selectionBounds = selected.range.getBoundingClientRect();
  if (
    (selectionBounds.width === 0 && selectionBounds.height === 0) ||
    selectionBounds.bottom < 0 ||
    selectionBounds.top > window.innerHeight
  ) {
    hideAskSelection();
    return;
  }

  pendingMessageSelection = selected.reference;
  elements.askSelection.hidden = false;
  elements.askSelection.style.visibility = "hidden";
  const actionBounds = elements.askSelection.getBoundingClientRect();
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
  elements.askSelection.style.left = `${Math.round(left)}px`;
  elements.askSelection.style.top = `${Math.round(top)}px`;
  elements.askSelection.style.visibility = "";
}

function attachSelectedText() {
  if (!pendingMessageSelection) {
    return;
  }

  const conversation = currentComposerConversation();
  const number = conversation.nextSelectionNumber;
  conversation.nextSelectionNumber += 1;
  conversation.selections.push({
    ...pendingMessageSelection,
    id: `selection-${number}`,
    number,
    startPath: [...pendingMessageSelection.startPath],
    endPath: [...pendingMessageSelection.endPath]
  });
  hideAskSelection();
  window.getSelection()?.removeAllRanges();
  renderSelectionList();
  elements.input.focus();
}

function selectionNodeAtPath(root, path) {
  let node = root;
  for (const index of path) {
    node = node.childNodes[index];
    if (!node) {
      return null;
    }
  }
  return node;
}

function validSelectionOffset(node, offset) {
  const length = node.nodeType === Node.TEXT_NODE
    ? node.textContent.length
    : node.childNodes.length;
  return Number.isInteger(offset) && offset >= 0 && offset <= length;
}

function findSelectionTextRange(body, text) {
  const target = compactSelectionText(text);
  if (!target) {
    return null;
  }
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const positions = [];
  let content = "";
  let node;
  while ((node = walker.nextNode())) {
    const value = node.textContent ?? "";
    for (let offset = 0; offset < value.length; offset += 1) {
      const character = value[offset];
      if (!/\s/.test(character)) {
        content += character;
        positions.push({ node, offset });
      }
    }
  }

  const start = content.indexOf(target);
  if (start < 0) {
    return null;
  }
  const first = positions[start];
  const last = positions[start + target.length - 1];
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

function selectionRangeForReference(body, reference) {
  const startNode = selectionNodeAtPath(body, reference.startPath);
  const endNode = selectionNodeAtPath(body, reference.endPath);
  if (
    startNode &&
    endNode &&
    validSelectionOffset(startNode, reference.startOffset) &&
    validSelectionOffset(endNode, reference.endOffset)
  ) {
    const range = document.createRange();
    range.setStart(startNode, reference.startOffset);
    range.setEnd(endNode, reference.endOffset);
    if (
      !range.collapsed &&
      compactSelectionText(range.toString()) === compactSelectionText(reference.text)
    ) {
      return range;
    }
  }
  return findSelectionTextRange(body, reference.text);
}

function preferredSelectionMessageIndex(reference, articles) {
  const conversation = currentComposerConversation();
  if (reference.sourceMessageId || reference.sourceKey) {
    const index = conversation.messages.findIndex((message) => (
      (reference.sourceMessageId && message.nativeMessageId === reference.sourceMessageId) ||
      (reference.sourceKey && messageIdentity(message) === reference.sourceKey)
    ));
    if (index >= 0) {
      return index;
    }
  }
  if (Number.isInteger(reference.sourceOrdinal)) {
    const article = articles[reference.sourceOrdinal];
    const index = Number(article?.dataset.messageIndex);
    if (Number.isInteger(index)) {
      return index;
    }
  }
  return reference.messageIndex;
}

function locateSelectionReference(reference, { exactOnly = false } = {}) {
  const conversation = currentComposerConversation();
  if (reference.sessionId && reference.sessionId !== conversation.sessionId) {
    return null;
  }
  const articles = selectableMessageArticles();
  const preferredIndex = preferredSelectionMessageIndex(reference, articles);
  const candidates = articles
    .map((article) => ({ article, index: Number(article.dataset.messageIndex) }))
    .filter(({ index }) => Number.isInteger(index))
    .filter(({ index }) => !exactOnly || index === preferredIndex)
    .sort((left, right) => (
      Math.abs(left.index - preferredIndex) - Math.abs(right.index - preferredIndex) ||
      left.index - right.index
    ));
  for (const { article, index } of candidates) {
    const body = article.querySelector(".message-body");
    if (!body) {
      continue;
    }
    const range = index === preferredIndex
      ? selectionRangeForReference(body, reference)
      : findSelectionTextRange(body, reference.text);
    if (range) {
      return { article, body, range };
    }
  }
  return null;
}

function showSelectionNotice(message) {
  if (selectionNoticeTimer !== null) {
    window.clearTimeout(selectionNoticeTimer);
  }
  elements.selectionStatus.textContent = message;
  elements.selectionStatus.hidden = false;
  selectionNoticeTimer = window.setTimeout(() => {
    selectionNoticeTimer = null;
    elements.selectionStatus.hidden = true;
    elements.selectionStatus.textContent = "";
  }, selectionNoticeDurationMs);
}

function paintMessageSelectionHighlight(body, range) {
  if (typeof window.Highlight === "function" && window.CSS?.highlights) {
    window.CSS.highlights.set(messageSelectionHighlightName, new window.Highlight(range));
    return true;
  }
  const selection = window.getSelection();
  if (!selection) {
    return null;
  }
  selection.removeAllRanges();
  selection.addRange(range);
  body.classList.add("selection-flash");
  return false;
}

function messageSelectionHighlightIsCurrent(highlight) {
  return highlight.body.isConnected &&
    !highlight.range.collapsed &&
    compactSelectionText(highlight.range.toString()) ===
      compactSelectionText(highlight.reference.text) &&
    (
      highlight.custom ||
      selectionMatchesRange(window.getSelection(), highlight.range)
    );
}

function restoreMessageSelectionHighlight() {
  const highlight = activeMessageSelectionHighlight;
  if (!highlight || messageSelectionHighlightIsCurrent(highlight)) {
    return;
  }
  const located = locateSelectionReference(highlight.reference);
  highlight.body.classList.remove("selection-flash");
  if (!located) {
    clearMessageSelectionHighlight();
    return;
  }
  const custom = paintMessageSelectionHighlight(located.body, located.range);
  if (custom === null) {
    clearMessageSelectionHighlight();
    return;
  }
  highlight.body = located.body;
  highlight.range = located.range;
  highlight.custom = custom;
}

async function jumpToSelection(reference) {
  const conversation = currentComposerConversation();
  if (reference.sessionId && reference.sessionId !== conversation.sessionId) {
    if (!state.sessions.some((session) => session.sessionId === reference.sessionId)) {
      showSelectionNotice("The selected text's conversation is no longer available.");
      return;
    }
    const loaded = await loadConversation(reference.sessionId);
    if (loaded) {
      await jumpToSelection(reference);
    } else {
      showSelectionNotice("The selected text's conversation could not be opened.");
    }
    return;
  }

  let index = conversation.messages.findIndex((message) => (
    (reference.sourceMessageId && message.nativeMessageId === reference.sourceMessageId) ||
    (reference.sourceKey && messageIdentity(message) === reference.sourceKey)
  ));
  if (index < 0 && reference.sourceMessageId && conversation.history) {
    if (conversation.busy || conversation.recoveredPrompt) {
      showSelectionNotice("Wait for the current activity to finish before opening an unloaded passage.");
      return;
    }
    while (conversation.historyLoading) {
      const pendingHistoryLoad = conversation.historyLoadPromise;
      if (!pendingHistoryLoad) {
        showSelectionNotice("Wait for the current history load to finish before opening an unloaded passage.");
        return;
      }
      await pendingHistoryLoad;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (conversation.busy || conversation.recoveredPrompt) {
        showSelectionNotice("Wait for the current activity to finish before opening an unloaded passage.");
        return;
      }
    }
    const generation = ++conversation.historyGeneration;
    conversation.historyLoading = true;
    try {
      const page = await api(`/api/sessions/${encodeURIComponent(conversation.sessionId)}/history?${
        new URLSearchParams({ around: reference.sourceMessageId })
      }`);
      if (generation !== conversation.historyGeneration || !isActiveConversation(conversation)) {
        return;
      }
      if (conversation.busy || conversation.recoveredPrompt ||
          serverPromptStates.get(conversation.sessionId)?.busy) {
        showSelectionNotice("Open this passage after the current reply finishes.");
        return;
      }
      applyHistoryPage(page, conversation, true);
      index = conversation.messages.findIndex((message) => message.nativeMessageId === reference.sourceMessageId);
    } catch (error) {
      showSelectionNotice(error.message);
      return;
    } finally {
      if (generation === conversation.historyGeneration) {
        conversation.historyLoading = false;
        renderMessages(conversation);
      }
    }
  }
  if (index < 0) {
    const compact = compactSelectionText(reference.text);
    index = conversation.messages.findIndex((message) => (
      (message.role === "user" || message.role === "assistant") &&
      compactSelectionText(messageSelectionSearchText(message)).includes(compact)
    ));
    if (!reference.sourceMessageId && conversation.history && !conversation.historyLoading && !conversation.busy &&
        !conversation.recoveredPrompt) {
      for (let pages = 0; index < 0 && pages < 10_000 && conversation.history.hasMore; pages += 1) {
        await loadOlderHistory(conversation);
        if (!isActiveConversation(conversation) || conversation.historyError) {
          return;
        }
        index = conversation.messages.findIndex((message) => (
          (message.role === "user" || message.role === "assistant") &&
          compactSelectionText(messageSelectionSearchText(message)).includes(compact)
        ));
      }
    }
  }
  if (index >= 0) {
    mountMessageAtIndex(conversation, index);
  }
  const located = locateSelectionReference(reference);
  if (!located) {
    showSelectionNotice("The selected text is no longer available in this conversation.");
    return;
  }

  clearMessageSelectionHighlight();
  const { body, range } = located;
  const selectedBounds = range.getBoundingClientRect();
  const messagesBounds = elements.messages.getBoundingClientRect();
  const top = elements.messages.scrollTop +
    selectedBounds.top -
    messagesBounds.top -
    (elements.messages.clientHeight - selectedBounds.height) / 2;
  elements.messages.scrollTop = top;
  const custom = paintMessageSelectionHighlight(body, range);
  if (custom === null) {
    showSelectionNotice("Text highlighting is not supported by this browser.");
    return;
  }
  activeMessageSelectionHighlight = {
    body,
    range,
    custom,
    reference: copySelectionReference(reference)
  };
  messageSelectionHighlightTimer = window.setTimeout(clearMessageSelectionHighlight, 2000);
}

function preserveMessageTextSelection(conversation) {
  if (renderedMessagesConversation !== conversation || pointerSelectionInProgress) {
    return null;
  }
  const selection = window.getSelection();
  const highlight = activeMessageSelectionHighlight;
  if (selection && highlight && !highlight.custom && selectionMatchesRange(selection, highlight.range)) {
    return null;
  }
  const selected = messageSelectionReference(selection);
  if (!selected) {
    return null;
  }
  return {
    reference: selected.reference,
    askVisible: !elements.askSelection.hidden
  };
}

function restoreMessageTextSelection(preserved) {
  if (!preserved) {
    if (!elements.askSelection.hidden) {
      updateAskSelection();
    }
    return;
  }
  const selection = window.getSelection();
  const current = messageSelectionReference(selection);
  if (
    !current ||
    compactSelectionText(current.reference.text) !== compactSelectionText(preserved.reference.text)
  ) {
    const located = locateSelectionReference(preserved.reference, { exactOnly: true });
    if (!located || !selection) {
      hideAskSelection();
      return;
    }
    selection.removeAllRanges();
    selection.addRange(located.range);
  }
  if (preserved.askVisible) {
    updateAskSelection();
  }
}

function scheduleAskSelectionUpdate() {
  window.setTimeout(updateAskSelection, 0);
}

function handleMessageSelectionKeydown(event) {
  const selectionKeys = ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"];
  if (event.key === "Shift" || (event.shiftKey && selectionKeys.includes(event.key))) {
    keyboardSelectionInProgress = true;
    hideAskSelection();
    clearMessageSelectionHighlight();
  }
}

function handleMessageSelectionKeyup(event) {
  if (
    keyboardSelectionInProgress &&
    (event.key === "Shift" || !event.shiftKey)
  ) {
    keyboardSelectionInProgress = false;
    scheduleAskSelectionUpdate();
  }
}

function promptWithSelections(text, selections) {
  if (selections.length === 0) {
    return text;
  }
  const excerpts = selections.map((selection) => (
    `Selection ${selection.number}:\n${selection.text
      .split(/\r\n?|\n/)
      .map((line) => `> ${line}`)
      .join("\n")}`
  )).join("\n\n");
  const question = text.trim() ? text : "Please explain these selected passages.";
  return `${question}\n\nSelected passages from the conversation:\n${excerpts}`;
}

function messagesAreAtBottom() {
  return elements.messages.scrollHeight -
    elements.messages.scrollTop -
    elements.messages.clientHeight < messagesBottomThreshold;
}

function mountMessageAtIndex(conversation, index) {
  const article = elements.messages.querySelector(`[data-message-index="${index}"]`);
  article?.scrollIntoView({ block: "center" });
  conversation.lastScrollTop = elements.messages.scrollTop;
  conversation.lastScrollAtBottom = messagesAreAtBottom();
}

function createHistoryControl(conversation, newer = false) {
  if (newer ? !conversation.newerHistoryHidden
    : !conversation.historyLoading && !conversation.historyError) {
    return null;
  }
  const row = document.createElement("div");
  row.className = "history-control";
  if (!newer) {
    if (conversation.historyLoading) {
      row.id = "history-loading";
      row.setAttribute("role", "status");
      row.textContent = "Loading earlier messages...";
      return row;
    }
    row.id = "history-error";
    const error = document.createElement("span");
    error.setAttribute("role", "status");
    error.textContent = conversation.historyError;
    row.append(error);
    if (conversation.history?.hasMore) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary-button";
      retry.id = "retry-history";
      retry.setAttribute("aria-label", "Retry loading earlier messages");
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        void loadOlderHistory(conversation);
      });
      row.append(retry);
    }
    return row;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.id = "load-latest-messages";
  button.disabled = conversation.historyLoading || conversation.loading;
  button.textContent = "Return to latest messages";
  button.addEventListener("click", () => {
    void loadConversation(conversation.sessionId, undefined, true);
  });
  row.append(button);
  return row;
}

function renderHistoryControl(conversation, newer = false) {
  const row = createHistoryControl(conversation, newer);
  if (row) {
    elements.messages.append(row);
  }
}

function captureMessageScrollAnchor() {
  const viewportTop = elements.messages.getBoundingClientRect().top;
  const article = [...elements.messages.querySelectorAll(".message")]
    .find((message) => message.getBoundingClientRect().bottom > viewportTop + 1);
  return {
    scrollTop: elements.messages.scrollTop,
    scrollLeft: elements.messages.scrollLeft,
    article,
    offset: article?.getBoundingClientRect().top - viewportTop
  };
}

function restoreMessageScrollAnchor(conversation, anchor) {
  elements.messages.scrollLeft = anchor.scrollLeft;
  if (anchor.article && elements.messages.contains(anchor.article) &&
      Number.isFinite(anchor.offset)) {
    const viewportTop = elements.messages.getBoundingClientRect().top;
    elements.messages.scrollTop +=
      anchor.article.getBoundingClientRect().top - viewportTop - anchor.offset;
  } else {
    elements.messages.scrollTop = anchor.scrollTop;
  }
  conversation.lastScrollTop = elements.messages.scrollTop;
  conversation.lastScrollAtBottom = messagesAreAtBottom();
}

function syncMessageEmptyState(conversation) {
  if (conversation.messages.length > 0 || conversation.history?.hasMore) {
    elements.emptyState.hidden = true;
    if (elements.emptyState.parentElement === elements.messages) {
      elements.emptyState.remove();
    }
    return;
  }
  elements.emptyState.hidden = false;
  if (elements.emptyState.parentElement !== elements.messages) {
    elements.messages.append(elements.emptyState);
  }
}

function syncOlderHistoryControl(conversation) {
  elements.messages.querySelector("#history-loading, #history-error")?.remove();
  const row = createHistoryControl(conversation);
  if (row) {
    const firstMessage = elements.messages.querySelector(".message");
    const emptyState = elements.emptyState.parentElement === elements.messages
      ? elements.emptyState
      : null;
    const latestControl = elements.messages.querySelector("#load-latest-messages")
      ?.closest(".history-control");
    const before = firstMessage ?? emptyState ?? latestControl;
    if (before) {
      elements.messages.insertBefore(row, before);
    } else {
      elements.messages.append(row);
    }
  }
  const latestButton = elements.messages.querySelector("#load-latest-messages");
  if (latestButton) {
    latestButton.disabled = conversation.historyLoading || conversation.loading;
  }
  elements.messages.setAttribute("aria-busy", String(conversation.historyLoading === true));
  syncMessageEmptyState(conversation);
}

function renderHistoryStatusInPlace(conversation) {
  if (!isActiveConversation(conversation)) {
    return;
  }
  if (
    renderedMessagesConversation !== conversation ||
    conversation.renderedMessageCount !== conversation.messages.length ||
    elements.messages.querySelectorAll(".message").length !== conversation.messages.length
  ) {
    renderMessages(conversation);
    return;
  }
  const anchor = captureMessageScrollAnchor();
  syncOlderHistoryControl(conversation);
  restoreMessageScrollAnchor(conversation, anchor);
  updateScrollToBottomButton();
}

function updateScrollToBottomButton() {
  const conversation = activeConversation();
  const visible = conversation?.loading === false &&
    conversation.messages.length > 0 &&
    (!messagesAreAtBottom() || conversation.newerHistoryHidden);
  elements.scrollToBottom.hidden = !visible;
  elements.scrollToBottom.disabled = !visible;
}

function updateMessagesInPlace(conversation, messages) {
  if (conversation.renderedMessageCount !== conversation.messages.length) {
    return false;
  }
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
    if (!body || !article) {
      return null;
    }
    return { article, body, message };
  });
  if (updates.some((update) => !update)) {
    return false;
  }

  const wasAtBottom = messagesAreAtBottom() && !conversation.preserveHistoryAnchor;
  const previousScrollTop = elements.messages.scrollTop;
  const previousScrollLeft = elements.messages.scrollLeft;
  const preservedSelection = preserveMessageTextSelection(conversation);
  for (const update of updates) {
    renderMessageBody(update.body, update.message);
    renderMessageTimestamp(update.article, update.message);
  }
  if (wasAtBottom) {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  } else {
    elements.messages.scrollTop = previousScrollTop;
    elements.messages.scrollLeft = previousScrollLeft;
  }
  restoreMessageSelectionHighlight();
  restoreMessageTextSelection(preservedSelection);
  updateScrollToBottomButton();
  conversation.lastScrollTop = elements.messages.scrollTop;
  return true;
}

function renderMessageSelectionSummary(message, messageIndex) {
  const selections = Array.isArray(message.selections) ? message.selections : [];
  if (message.role !== "user" || selections.length === 0) {
    return null;
  }

  const row = document.createElement("div");
  row.className = "message-selection-row";

  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "message-selection-summary";
  summary.title = selections.length === 1
    ? "Jump to the selected text"
    : "Choose a selected passage";
  summary.setAttribute(
    "aria-label",
    selections.length === 1
      ? "Jump to selected text in this message"
      : `Show ${selections.length} selections attached to this message`
  );
  summary.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-5 4v-4a2 2 0 0 1-3-2V6a2 2 0 0 1 2-2Z"></path><path d="M9 8h6m-6 3h4"></path></svg>';
  const label = document.createElement("span");
  label.textContent = `${selections.length} selection${selections.length === 1 ? "" : "s"}`;
  summary.append(label);

  let menu = null;
  if (selections.length > 1) {
    menu = document.createElement("div");
    menu.className = "message-selection-menu";
    menu.id = `message-selection-menu-${messageIndex}`;
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", "Selections attached to this message");
    menu.hidden = true;
    summary.setAttribute("aria-controls", menu.id);
    summary.setAttribute("aria-expanded", "false");
    for (const selection of selections) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "message-selection-option";
      option.setAttribute(
        "aria-label",
        `Jump to Selection ${selection.number} at its source`
      );
      const optionLabel = document.createElement("span");
      optionLabel.className = "message-selection-option-label";
      optionLabel.textContent = `Selection ${selection.number}`;
      const optionText = document.createElement("span");
      optionText.className = "message-selection-option-text";
      optionText.textContent = selection.text;
      option.append(optionLabel, optionText);
      option.addEventListener("click", () => {
        menu.hidden = true;
        summary.setAttribute("aria-expanded", "false");
        jumpToSelection(selection);
      });
      menu.append(option);
    }
  }

  summary.addEventListener("click", () => {
    if (selections.length === 1) {
      jumpToSelection(selections[0]);
      return;
    }
    menu.hidden = !menu.hidden;
    summary.setAttribute("aria-expanded", String(!menu.hidden));
  });
  row.append(summary);
  if (menu) {
    row.append(menu);
  }
  return row;
}

function createMessageArticle(message, index) {
  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  article.dataset.messageIndex = String(index);
  article.dataset.messageKey = messageIdentity(message) ?? "";
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
  article.append(header);
  const selectionSummary = renderMessageSelectionSummary(message, index);
  if (selectionSummary) {
    article.append(selectionSummary);
  }
  article.append(body);
  renderMessageTimestamp(article, message);
  return article;
}

function updateMessageArticleIndex(article, index) {
  article.dataset.messageIndex = String(index);
  const menu = article.querySelector(".message-selection-menu");
  if (menu) {
    menu.id = `message-selection-menu-${index}`;
    article.querySelector(".message-selection-summary")
      ?.setAttribute("aria-controls", menu.id);
  }
}

function renderHistoryPageInPlace(
  conversation,
  addedMessages,
  modifiedMessages,
  panelScrollPositions,
  existingArticleIndexes
) {
  if (!isActiveConversation(conversation)) {
    return;
  }
  const existingArticles = [...elements.messages.querySelectorAll(".message")];
  const previousMessageCount = conversation.messages.length - addedMessages.length;
  if (
    renderedMessagesConversation !== conversation ||
    conversation.renderedMessageCount !== previousMessageCount ||
    existingArticles.length !== previousMessageCount
  ) {
    renderMessages(conversation);
    return;
  }

  const anchor = captureMessageScrollAnchor();
  const preservedSelection = preserveMessageTextSelection(conversation);
  for (const article of existingArticles) {
    const previousIndex = existingArticleIndexes.get(article);
    if (!Number.isInteger(previousIndex)) {
      renderMessages(conversation);
      return;
    }
    const index = previousIndex + addedMessages.length;
    const message = conversation.messages[index];
    if (!message) {
      renderMessages(conversation);
      return;
    }
    updateMessageArticleIndex(article, index);
    if (modifiedMessages.has(message)) {
      const body = article.querySelector(".message-body");
      if (body) {
        renderMessageBody(body, message);
        renderMessageTimestamp(article, message);
        restoreMessagePanelScroll(article, message, panelScrollPositions);
      }
    }
  }

  const fragment = document.createDocumentFragment();
  const newArticles = [];
  addedMessages.forEach((message, index) => {
    const article = createMessageArticle(message, index);
    fragment.append(article);
    newArticles.push({ article, message });
  });
  if (conversation.messages.length > 0) {
    elements.emptyState.hidden = true;
    if (elements.emptyState.parentElement === elements.messages) {
      elements.emptyState.remove();
    }
  }
  const latestControl = elements.messages.querySelector("#load-latest-messages")
    ?.closest(".history-control");
  elements.messages.insertBefore(fragment, existingArticles[0] ?? latestControl ?? null);
  for (const { article, message } of newArticles) {
    restoreMessagePanelScroll(article, message, panelScrollPositions);
  }
  syncMessageEmptyState(conversation);
  elements.messages.setAttribute("aria-busy", String(conversation.historyLoading === true));
  const latestButton = elements.messages.querySelector("#load-latest-messages");
  if (latestButton) {
    latestButton.disabled = conversation.historyLoading || conversation.loading;
  }
  conversation.renderedMessageCount = conversation.messages.length;
  restoreMessageScrollAnchor(conversation, anchor);
  restoreMessageSelectionHighlight();
  restoreMessageTextSelection(preservedSelection);
  updateScrollToBottomButton();
}

function renderMessages(conversation = activeConversation()) {
  if (conversation !== activeConversation()) {
    return;
  }
  const isRenderedConversation = renderedMessagesConversation === conversation;
  const preservedSelection = preserveMessageTextSelection(conversation);
  if (!isRenderedConversation) {
    clearMessageSelectionHighlight();
  }
  const wasAtBottom = conversation?.scrollToLatest ||
    (isRenderedConversation
      ? messagesAreAtBottom() && !conversation?.preserveHistoryAnchor
      : conversation?.lastScrollAtBottom === true);
  const previousScrollTop = isRenderedConversation
    ? elements.messages.scrollTop
    : conversation?.lastScrollTop ?? 0;
  const previousScrollLeft = isRenderedConversation ? elements.messages.scrollLeft : 0;
  const viewportTop = elements.messages.getBoundingClientRect().top;
  const anchorArticle = isRenderedConversation
    ? [...elements.messages.querySelectorAll(".message")]
      .find((article) => article.getBoundingClientRect().bottom > viewportTop + 1)
    : null;
  const anchorKey = anchorArticle?.dataset.messageKey;
  const anchorOffset = anchorArticle?.getBoundingClientRect().top - viewportTop;
  const panelScrollPositions = captureMessagePanelScroll(conversation);
  elements.messages.replaceChildren();
  renderedMessagesConversation = conversation;
  if (conversation) {
    conversation.renderedMessageCount = conversation.messages.length;
  }
  if (conversation?.loading === true) {
    clearMessageSelectionHighlight();
    hideAskSelection();
    elements.loadingState.hidden = false;
    elements.messages.append(elements.loadingState);
    elements.emptyState.hidden = true;
    elements.messages.setAttribute("aria-busy", "true");
    updateScrollToBottomButton();
    return;
  }

  elements.loadingState.hidden = true;
  elements.messages.setAttribute("aria-busy", String(conversation?.historyLoading === true));
  if (conversation?.historyWarning) {
    const warning = document.createElement("div");
    warning.className = "history-control";
    warning.setAttribute("role", "status");
    warning.textContent = conversation.historyWarning;
    elements.messages.append(warning);
  }
  if (!conversation || conversation.messages.length === 0) {
    clearMessageSelectionHighlight();
    hideAskSelection();
    if (conversation?.history?.hasMore) {
      renderHistoryControl(conversation);
      elements.emptyState.hidden = true;
      updateScrollToBottomButton();
      return;
    }
    elements.messages.append(elements.emptyState);
    elements.emptyState.hidden = false;
    updateScrollToBottomButton();
    return;
  }

  elements.emptyState.hidden = true;
  renderHistoryControl(conversation);
  for (let index = 0; index < conversation.messages.length; index += 1) {
    const message = conversation.messages[index];
    const article = createMessageArticle(message, index);
    elements.messages.append(article);
    restoreMessagePanelScroll(article, message, panelScrollPositions);
  }
  renderHistoryControl(conversation, true);
  if (wasAtBottom) {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  } else {
    elements.messages.scrollTop = previousScrollTop;
    elements.messages.scrollLeft = previousScrollLeft;
    const anchor = anchorKey ? [...elements.messages.querySelectorAll(".message")]
      .find((article) => article.dataset.messageKey === anchorKey) : null;
    if (anchor && Number.isFinite(anchorOffset)) {
      elements.messages.scrollTop += anchor.getBoundingClientRect().top - viewportTop - anchorOffset;
    }
  }
  restoreMessageSelectionHighlight();
  restoreMessageTextSelection(preservedSelection);
  updateScrollToBottomButton();
  conversation.lastScrollTop = elements.messages.scrollTop;
  conversation.lastScrollAtBottom = messagesAreAtBottom();
  conversation.scrollToLatest = false;
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
    scheduleMessagesRender(conversation);
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
}

function addMessage(
  role,
  text,
  key = null,
  attachments = [],
  conversation = activeConversation() ?? state.composer,
  selections = []
) {
  if (!text && attachments.length === 0 && selections.length === 0) {
    return;
  }
  if (key && conversation.messageKeys.has(key)) {
    const message = conversation.messages[conversation.messageKeys.get(key)];
    if (message) {
      if (role === "user" && conversation.loading) {
        message.rawSelectionPromptText = (message.rawSelectionPromptText ?? message.text) + text;
        if (!message.selectionMetadataRestored) {
          message.text = message.rawSelectionPromptText;
          restoreSelectionMessageMetadata(message, conversation);
        }
      } else {
        message.text += text;
      }
      if (attachments.length > 0) {
        message.attachments = [...(message.attachments ?? []), ...attachments];
      }
      if (selections.length > 0) {
        message.selections = [
          ...(message.selections ?? []),
          ...selections.map(copySelectionReference)
        ];
      }
      scheduleMessagesRender(conversation, message);
      return;
    }
  }

  const message = {
    role, text, attachments: [...attachments],
    displayKey: key ?? nextSyntheticMessageKey(role, conversation)
  };
  const restoreSelectionMetadata = selections.length === 0 &&
    role === "user" &&
    conversation.loading;
  if (selections.length > 0) {
    message.selections = selections.map(copySelectionReference);
    message.selectionMetadataRestored = true;
  } else if (restoreSelectionMetadata) {
    message.rawSelectionPromptText = text;
  }
  const index = conversation.messages.length;
  conversation.messages.push(message);
  if (key) {
    conversation.messageKeys.set(key, index);
  }
  if (restoreSelectionMetadata) {
    restoreSelectionMessageMetadata(message, conversation);
  }
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

function nativeMessageKey(message) {
  return `native:${message.role}:${message.messageId}`;
}

function nativeMessageIsNewer(incoming, current) {
  const incomingComplete = incoming.completion === "completed";
  if (incomingComplete !== (current.completed === true)) {
    return incomingComplete;
  }
  const incomingTimestamp = typeof incoming.updatedAt === "string"
    ? Date.parse(incoming.updatedAt)
    : Number.NaN;
  const currentTimestamp = typeof current.nativeUpdatedAt === "string"
    ? Date.parse(current.nativeUpdatedAt)
    : Number.NaN;
  if (Number.isFinite(incomingTimestamp) && Number.isFinite(currentTimestamp)) {
    if (incomingTimestamp !== currentTimestamp) {
      return incomingTimestamp > currentTimestamp;
    }
    if (incoming.updatedAt !== current.nativeUpdatedAt) {
      return incoming.updatedAt > current.nativeUpdatedAt;
    }
  } else if (Number.isFinite(incomingTimestamp) || Number.isFinite(currentTimestamp)) {
    return Number.isFinite(incomingTimestamp);
  }
  return Number(incoming.revision) > Number(current.nativeRevision ?? 0);
}

function updateNativeMessageTurn(message, conversation) {
  const key = nativeMessageKey(message);
  if (message.role === "user") {
    startUserMessageTurn(key, conversation);
    return;
  }
  if (message.role === "assistant") {
    conversation.currentAssistantMessageKey = key;
    conversation.currentAssistantTurnKey = conversation.currentTurnKey;
    conversation.lastStreamRole = "assistant";
    // A visible reply ends the current Thinking panel; later reasoning starts a new one.
    conversation.currentToolGroupKey = null;
  }
}

const nativeReasoningApplied = new WeakMap();

// Session loads replay no ACP thought chunks, so persisted reasoning fills in loaded history.
function upsertNativeReasoning(record, conversation, assistantMessage) {
  const reasoningText = typeof record.reasoningText === "string"
    ? record.reasoningText
    : "";
  if (!conversation.loading || reasoningText.length === 0) {
    return;
  }
  let applied = nativeReasoningApplied.get(conversation.messages);
  if (!applied) {
    applied = new Set();
    nativeReasoningApplied.set(conversation.messages, applied);
  }
  if (applied.has(record.messageId)) {
    return;
  }

  const insertionIndex = assistantMessage
    ? conversation.messages.indexOf(assistantMessage)
    : conversation.messages.length;
  if (insertionIndex < 0) {
    return;
  }
  let group = conversation.messages[insertionIndex - 1]?.role === "tool"
    ? conversation.messages[insertionIndex - 1]
    : null;
  // Live updates kept in the server's replay cache already carry this turn's reasoning.
  if (group?.acpThinking) {
    return;
  }
  applied.add(record.messageId);

  let inserted = false;
  if (!group) {
    group = createToolGroup(`tool-group:native:${record.messageId}`);
    conversation.messages.splice(insertionIndex, 0, group);
    for (const [key, index] of conversation.messageKeys) {
      if (index >= insertionIndex) {
        conversation.messageKeys.set(key, index + 1);
      }
    }
    inserted = true;
  }
  group.lastPart = null;
  appendThinkingText(group, reasoningText);
  // Inserting shifts message indexes, so in-place article updates would target the wrong rows.
  scheduleMessagesRender(conversation, inserted ? null : group);
}

function ingestNativeMessage(record, conversation) {
  if (
    !record ||
    typeof record !== "object" ||
    (record.role !== "user" && record.role !== "assistant") ||
    typeof record.messageId !== "string" ||
    !record.messageId ||
    typeof record.eventId !== "string" ||
    !record.eventId
  ) {
    return;
  }
  if (conversation.nativeEventIds.has(record.eventId)) {
    return;
  }
  conversation.nativeEventIds.add(record.eventId);

  const key = nativeMessageKey(record);
  let index = conversation.messageKeys.get(key);
  let message = Number.isInteger(index) ? conversation.messages[index] : null;
  if (!message && record.role === "user" && typeof record.clientPromptId === "string") {
    index = conversation.messages.findIndex((candidate) => (
      candidate.role === "user" &&
      candidate.clientPromptId === record.clientPromptId
    ));
    message = index >= 0 ? conversation.messages[index] : null;
  }
  if (
    !message &&
    record.role === "assistant" &&
    typeof record.clientPromptId === "string"
  ) {
    index = conversation.messages.findIndex((candidate) => (
      candidate.role === "assistant" &&
      candidate.clientPromptId === record.clientPromptId &&
      candidate.legacyFallback === true
    ));
    message = index >= 0 ? conversation.messages[index] : null;
  }
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.filter((attachment) => (
      attachment &&
      typeof attachment.name === "string" &&
      typeof attachment.mimeType === "string" &&
      typeof attachment.data === "string"
    )).map((attachment) => ({ ...attachment }))
    : [];
  const content = typeof record.content === "string" ? record.content : "";

  if (message) {
    const current = message.nativeMessageId
      ? message
      : { ...message, nativeRevision: 0 };
    if (!message.nativeMessageId || nativeMessageIsNewer(record, current)) {
      delete message.nativeHistoryFragment;
      const preserveOptimisticUser = record.role === "user" &&
        message.optimisticPrompt === true;
      if (!preserveOptimisticUser) {
        message.text = record.role === "assistant" &&
          record.completion === "completed" &&
          content.length === 0 &&
          typeof message.text === "string"
          ? message.text
          : content;
        if (attachments.length > 0 || !Array.isArray(message.attachments)) {
          message.attachments = attachments;
        }
      } else if (
        (!Array.isArray(message.attachments) || message.attachments.length === 0) &&
        attachments.length > 0
      ) {
        message.attachments = attachments;
      }
      message.completed = record.completion === "completed";
      if (typeof record.updatedAt === "string") {
        message.nativeUpdatedAt = record.updatedAt;
      }
      message.nativeRevision = Number(record.revision) || 0;
      if (
        message.completed &&
        typeof record.timestamp === "string" &&
        Number.isFinite(Date.parse(record.timestamp))
      ) {
        message.timestamp = record.timestamp;
      } else {
        delete message.timestamp;
      }
    }
    message.nativeMessageId = record.messageId;
    message.nativeEventId = record.eventId;
    message.legacyFallback = false;
    if (typeof record.clientPromptId === "string") {
      message.clientPromptId = record.clientPromptId;
      const metadata = (selectionMessageMetadata[conversation.sessionId] ?? [])
        .find((entry) => entry.clientPromptId === record.clientPromptId);
      if (record.role === "user" && metadata && metadata.messageId !== record.messageId) {
        metadata.messageId = record.messageId;
        writeSelectionMessageMetadata(metadata);
      }
    }
    if (Number.isInteger(index) && index >= 0) {
      conversation.messageKeys.set(key, index);
    }
    updateNativeMessageTurn(record, conversation);
    if (record.role === "assistant") {
      upsertNativeReasoning(record, conversation, message);
    }
    scheduleMessagesRender(conversation, message);
    return;
  }

  if (!content && attachments.length === 0) {
    if (record.role === "assistant") {
      upsertNativeReasoning(record, conversation, null);
    }
    return;
  }
  message = {
    role: record.role,
    text: content,
    attachments,
    nativeMessageId: record.messageId,
    nativeEventId: record.eventId,
    nativeRevision: Number(record.revision) || 0,
    completed: record.completion === "completed"
  };
  if (typeof record.updatedAt === "string") {
    message.nativeUpdatedAt = record.updatedAt;
  }
  if (
    message.completed &&
    typeof record.timestamp === "string" &&
    Number.isFinite(Date.parse(record.timestamp))
  ) {
    message.timestamp = record.timestamp;
  }
  if (typeof record.clientPromptId === "string") {
    message.clientPromptId = record.clientPromptId;
  }
  if (record.role === "user") {
    message.rawSelectionPromptText = content;
  }
  index = conversation.messages.length;
  conversation.messages.push(message);
  conversation.messageKeys.set(key, index);
  if (record.role === "user") {
    restoreSelectionMessageMetadata(message, conversation);
  }
  updateNativeMessageTurn(record, conversation);
  if (record.role === "assistant") {
    upsertNativeReasoning(record, conversation, message);
  }
  scheduleMessagesRender(conversation, message);
}

function handleNativeMessage(params) {
  if (!params || typeof params.sessionId !== "string") {
    return;
  }
  const conversation = conversationState(params.sessionId);
  if (conversation.newerHistoryHidden) {
    return;
  }
  conversation.nativeMessagesActive = true;
  conversation.nativeModeKnown = true;
  if (!conversation.history) {
    conversation.history = { hasMore: !conversation.loaded, cursor: null, oversized: false };
  }
  if (conversation.loading) {
    const previous = conversation.pendingNativeMessages.findIndex((message) => (
      message.role === params.role && message.messageId === params.messageId
    ));
    if (previous >= 0) {
      if (params.completion === "completed" ||
          conversation.pendingNativeMessages[previous].completion !== "completed") {
        conversation.pendingNativeMessages[previous] = params;
      }
    } else {
      conversation.pendingNativeMessages.push(params);
    }
    return;
  }
  ingestNativeMessage(params, conversation);
}

function replayChatRole(update) {
  if (update?.sessionUpdate === "user_message_chunk") {
    return "user";
  }
  if (update?.sessionUpdate === "agent_message_chunk") {
    return "assistant";
  }
  return null;
}

function hasNativeContent(message) {
  return Boolean(
    message &&
    (
      (typeof message.content === "string" && message.content.length > 0) ||
      (Array.isArray(message.attachments) && message.attachments.length > 0)
    )
  );
}

function splitReplayTurns(replayUpdates) {
  const turns = [{ entries: [], clientPromptId: null }];
  let previousMarker = null;
  for (const params of replayUpdates) {
    const update = params?.update;
    if (!update) {
      continue;
    }
    const role = replayChatRole(update);
    let startsGroup = false;
    if (role) {
      const messageId = typeof update.messageId === "string" ||
        typeof update.messageId === "number"
        ? String(update.messageId)
        : null;
      startsGroup = !previousMarker ||
        previousMarker.role !== role ||
        (
          messageId !== null &&
          previousMarker.messageId !== null &&
          messageId !== previousMarker.messageId
        );
      previousMarker = { role, messageId };
    } else {
      previousMarker = null;
    }
    if (role === "user" && startsGroup) {
      turns.push({
        entries: [],
        clientPromptId: typeof params.clientPromptId === "string" ? params.clientPromptId : null,
        command: params.nativeCommand === true
      });
    }
    turns[turns.length - 1].entries.push({ params, role, startsGroup });
  }
  return turns;
}

function splitNativeTurns(nativeMessages) {
  const turns = [{ user: null, assistants: [] }];
  for (const message of nativeMessages) {
    if (message?.role === "user") {
      turns.push({ user: message, assistants: [] });
    } else if (message?.role === "assistant") {
      turns[turns.length - 1].assistants.push(message);
    }
  }
  return turns;
}

// ACP text groups are separated by tool calls, whose IDs match native toolRequests.
function matchTurnAssistants(replayTurn, nativeTurn) {
  const matches = new Map();
  if (!nativeTurn) {
    return matches;
  }
  const replayToolIds = new Set(replayTurn.entries
    .filter((entry) => !entry.role && entry.params.update.sessionUpdate === "tool_call")
    .map((entry) => entry.params.update.toolCallId)
    .filter((toolCallId) => typeof toolCallId === "string"));

  const nativeSlots = [[]];
  const anchorByToolId = new Map();
  for (const message of nativeTurn.assistants) {
    if (hasNativeContent(message)) {
      nativeSlots[nativeSlots.length - 1].push(message);
    }
    const anchors = (Array.isArray(message.toolCallIds) ? message.toolCallIds : [])
      .filter((toolCallId) => replayToolIds.has(toolCallId));
    if (anchors.length > 0) {
      for (const toolCallId of anchors) {
        anchorByToolId.set(toolCallId, nativeSlots.length - 1);
      }
      nativeSlots.push([]);
    }
  }

  const replaySlots = [[]];
  let groupIndex = -1;
  for (const entry of replayTurn.entries) {
    if (entry.role === "assistant" && entry.startsGroup) {
      groupIndex += 1;
      replaySlots[replaySlots.length - 1].push(groupIndex);
      continue;
    }
    const toolCallId = entry.params.update.toolCallId;
    if (entry.role || entry.params.update.sessionUpdate !== "tool_call") {
      continue;
    }
    const nativeSlot = anchorByToolId.get(toolCallId);
    if (nativeSlot === undefined || nativeSlot < replaySlots.length - 1) {
      continue;
    }
    if (nativeSlot !== replaySlots.length - 1) {
      return new Map();
    }
    replaySlots.push([]);
  }
  if (replaySlots.length !== nativeSlots.length) {
    return new Map();
  }

  for (const [slotIndex, groups] of replaySlots.entries()) {
    const natives = nativeSlots[slotIndex];
    if (groups.length === 1 && natives.length > 0) {
      matches.set(groups[0], natives);
    } else if (groups.length === natives.length) {
      groups.forEach((group, index) => matches.set(group, [natives[index]]));
    }
  }
  return matches;
}

function alignReplayTurns(replayTurns, nativeTurns) {
  const pairs = new Map([[0, nativeTurns[0]]]);
  // Commands such as /mcp reload are never recorded natively, so they take no native turn.
  const candidates = replayTurns
    .map((turn, index) => index)
    .filter((index) => index > 0 && !replayTurns[index].command);
  const anchors = [];
  let lastNativeIndex = 0;
  for (const [position, replayIndex] of candidates.entries()) {
    const clientPromptId = replayTurns[replayIndex].clientPromptId;
    if (!clientPromptId) {
      continue;
    }
    const nativeIndex = nativeTurns.findIndex((turn, index) => (
      index > lastNativeIndex && turn.user?.clientPromptId === clientPromptId
    ));
    if (nativeIndex > 0) {
      anchors.push([position, nativeIndex]);
      lastNativeIndex = nativeIndex;
    }
  }
  anchors.push([candidates.length, nativeTurns.length]);

  let previousPosition = -1;
  let previousNativeIndex = 0;
  for (const [position, nativeIndex] of anchors) {
    const replayCount = position - previousPosition - 1;
    const nativeCount = nativeIndex - previousNativeIndex - 1;
    if (replayCount === nativeCount) {
      for (let offset = 1; offset <= replayCount; offset += 1) {
        pairs.set(candidates[previousPosition + offset], nativeTurns[previousNativeIndex + offset]);
      }
    }
    if (position < candidates.length) {
      pairs.set(candidates[position], nativeTurns[nativeIndex]);
    }
    previousPosition = position;
    previousNativeIndex = nativeIndex;
  }
  return pairs;
}

function replayNativeHistory(replayUpdates, nativeMessages, conversation) {
  if (!conversation.nativeMessagesActive) {
    for (const replayUpdate of replayUpdates) {
      handleSessionUpdate(replayUpdate, conversation.sessionId, conversation);
    }
    return;
  }
  if (!replayUpdates.some((params) => replayChatRole(params?.update))) {
    for (const replayUpdate of replayUpdates) {
      handleSessionUpdate(replayUpdate, conversation.sessionId, conversation);
    }
    for (const nativeMessage of nativeMessages) {
      ingestNativeMessage(nativeMessage, conversation);
    }
    return;
  }

  const replayTurns = splitReplayTurns(replayUpdates);
  const nativeTurns = splitNativeTurns(nativeMessages);
  const pairs = alignReplayTurns(replayTurns, nativeTurns);
  // Tool-round messages usually have no text, so their reasoning is placed with their tool calls.
  const reasoningByToolCall = new Map();
  for (const message of nativeMessages) {
    if (message?.role !== "assistant" || !Array.isArray(message.toolCallIds)) {
      continue;
    }
    for (const toolCallId of message.toolCallIds) {
      reasoningByToolCall.set(toolCallId, message);
    }
  }
  let fallbackMessageNumber = 0;

  for (const [turnIndex, replayTurn] of replayTurns.entries()) {
    const nativeTurn = pairs.get(turnIndex) ?? null;
    const userMatched = Boolean(nativeTurn?.user && hasNativeContent(nativeTurn.user));
    const assistantMatches = matchTurnAssistants(replayTurn, nativeTurn);
    let groupIndex = -1;
    let fallbackMessageId = null;

    for (const entry of replayTurn.entries) {
      const { params, role, startsGroup } = entry;
      if (role === "assistant" && startsGroup) {
        groupIndex += 1;
      }
      const matched = role === "user" ? userMatched : assistantMatches.has(groupIndex);
      if (!role || matched) {
        handleSessionUpdate(params, conversation.sessionId, conversation);
        const nativeToolMessage = !role && params.update.sessionUpdate === "tool_call"
          ? reasoningByToolCall.get(params.update.toolCallId)
          : undefined;
        if (nativeToolMessage) {
          upsertNativeReasoning(nativeToolMessage, conversation, null);
        }
        if (role === "user" && startsGroup) {
          ingestNativeMessage(nativeTurn.user, conversation);
        } else if (role === "assistant" && startsGroup) {
          for (const nativeMessage of assistantMatches.get(groupIndex)) {
            ingestNativeMessage(nativeMessage, conversation);
          }
        }
        continue;
      }
      // Unmatched chat stays as untimed ACP text instead of shifting or duplicating native messages.
      if (startsGroup) {
        fallbackMessageNumber += 1;
        fallbackMessageId = `history-fallback:${role}:${fallbackMessageNumber}`;
      }
      const update = params.update;
      handleSessionUpdate({
        ...params,
        ...(replayTurn.command ? { nativeCommand: true } : { nativeFallback: true }),
        update: {
          ...update,
          ...(typeof update.messageId === "string" || typeof update.messageId === "number"
            ? {}
            : { messageId: fallbackMessageId })
        }
      }, conversation.sessionId, conversation);
    }
  }
}

function replayPagedNativeHistory(replayUpdates, nativeMessages, conversation) {
  const messagesByKey = new Map(nativeMessages.map((message) => [
    `${message.role}:${message.messageId}`,
    message
  ]));
  const cachedReasoning = new Map();
  for (const params of replayUpdates) {
    const update = params?.update;
    if (
      update?.sessionUpdate !== "agent_thought_chunk" ||
      (typeof update.messageId !== "string" && typeof update.messageId !== "number")
    ) {
      continue;
    }
    const messageId = String(update.messageId);
    const text = contentText(update.content);
    if (text) {
      cachedReasoning.set(messageId, `${cachedReasoning.get(messageId) ?? ""}${text}`);
    }
  }
  for (const [messageId, text] of cachedReasoning) {
    const message = messagesByKey.get(`assistant:${messageId}`);
    if (message && !message.reasoningText) {
      message.reasoningText = text;
    }
  }
  const ingested = new Set();
  for (const params of replayUpdates) {
    const update = params?.update;
    if (!update) {
      continue;
    }
    const role = replayChatRole(update);
    const messageId = typeof update.messageId === "string" ||
      typeof update.messageId === "number"
      ? String(update.messageId)
      : undefined;
    if (role && messageId) {
      const key = `${role}:${messageId}`;
      const message = messagesByKey.get(key);
      if (message) {
        if (!ingested.has(key)) {
          ingestNativeMessage(message, conversation);
          ingested.add(key);
        }
      } else if (params.nativeCommand === true || params.nativeFallback === true) {
        handleSessionUpdate(params, conversation.sessionId, conversation);
      }
      continue;
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      continue;
    }
    if (params.nativeCommand === true || params.nativeFallback === true || !role) {
      handleSessionUpdate(params, conversation.sessionId, conversation);
    }
  }
  for (const [key, message] of messagesByKey) {
    if (!ingested.has(key)) {
      ingestNativeMessage(message, conversation);
    }
  }
  for (const record of nativeMessages) {
    if (record?.role !== "assistant" || record.completion !== "streaming") {
      continue;
    }
    const index = conversation.messageKeys.get(nativeMessageKey(record));
    const message = Number.isInteger(index) ? conversation.messages[index] : null;
    if (message?.completed === false) {
      message.nativeHistoryFragment = true;
    }
  }
}

function handleSessionUpdate(params, expectedSessionId = null, targetConversation = null) {
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
  const conversation = targetConversation ?? conversationState(sessionId);
  const update = params.update;
  if (conversation.newerHistoryHidden && [
    "user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call",
    "tool_call_update", "plan"
  ].includes(update.sessionUpdate)) {
    return;
  }
  const acpOnly = params.nativeFallback === true || params.nativeCommand === true;
  const chatRole = update.sessionUpdate === "user_message_chunk"
    ? "user"
    : update.sessionUpdate === "agent_message_chunk"
      ? "assistant"
      : null;
  if (acpOnly) {
    conversation.nativeModeKnown = true;
  } else if (
    chatRole &&
    !conversation.nativeModeKnown &&
    state.nativeMessageHistoryAvailable
  ) {
    streamMessageKey(chatRole, update, conversation);
    return;
  }
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const optimisticMessage = typeof params.clientPromptId === "string"
        ? conversation.messages.find((message) => (
          message.role === "user" &&
          message.clientPromptId === params.clientPromptId
        ))
        : null;
      if (optimisticMessage) {
        startUserMessageTurn(
          optimisticMessage.localMessageKey ??
            `local-user:${params.clientPromptId}`,
          conversation
        );
        break;
      }
      const key = streamMessageKey("user", update, conversation);
      if (!conversation.nativeMessagesActive || acpOnly) {
        addMessage(
          "user",
          contentText(update.content),
          key,
          contentAttachment(update.content),
          conversation
        );
        if (acpOnly) {
          const index = conversation.messageKeys.get(key);
          const fallbackMessage = Number.isInteger(index)
            ? conversation.messages[index]
            : null;
          if (fallbackMessage) {
            fallbackMessage.legacyFallback = true;
            if (typeof params.clientPromptId === "string") {
              fallbackMessage.clientPromptId = params.clientPromptId;
            }
          }
        }
      }
      break;
    }
    case "agent_message_chunk": {
      const key = streamMessageKey("assistant", update, conversation);
      if (!conversation.nativeMessagesActive || acpOnly) {
        addMessage("assistant", contentText(update.content), key, [], conversation);
        if (acpOnly) {
          const index = conversation.messageKeys.get(key);
          const fallbackMessage = Number.isInteger(index)
            ? conversation.messages[index]
            : null;
          if (fallbackMessage) {
            fallbackMessage.legacyFallback = true;
            if (typeof params.clientPromptId === "string") {
              fallbackMessage.clientPromptId = params.clientPromptId;
            }
          }
        }
      }
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
    void refreshQuota();
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
    clearSelectionMessageMetadata(sessionId);
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
  const requestStartedAt = Date.now();
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
  if (Array.isArray(result.sessions)) {
    pruneSelectionMessageMetadata(listedSessions, requestStartedAt);
  }
  for (const sessionId of serverPromptStates.keys()) {
    if (!listedSessions.has(sessionId)) {
      applyServerPromptState(sessionId, { busy: false }, request);
    }
  }
  state.capabilities = result.capabilities ?? state.capabilities;
  state.newSessionDefaults = result.newSessionDefaults ?? state.newSessionDefaults;
  state.nativeMessageHistoryAvailable =
    result.nativeMessageHistoryAvailable === true;
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

function saveActiveConversationScroll() {
  const conversation = currentComposerConversation();
  if (renderedMessagesConversation !== conversation) {
    return;
  }
  conversation.lastScrollTop = elements.messages.scrollTop;
  conversation.lastScrollAtBottom = messagesAreAtBottom();
}

function activateConversation(sessionId) {
  saveActiveConversationScroll();
  persistComposerDraft();
  void stopVoiceInput();
  const conversation = conversationState(sessionId);
  state.activeSessionId = sessionId;
  saveActiveSessionId(sessionId);
  elements.input.value = conversation.draft;
  resizePromptInput();
  renderSessionList();
  renderConversationControls();
  renderAttachmentList();
  renderSelectionList();
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
  saveActiveConversationScroll();
  state.activeSessionId = null;
  clearActiveSessionId();
  elements.input.value = conversation.draft;
  resizePromptInput();
  renderSessionList();
  renderConversationControls();
  renderAttachmentList();
  renderSelectionList();
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

async function startNewConversation({ discardDraft = false } = {}) {
  if (state.deletingSessionId && !discardDraft) {
    return;
  }
  const voiceSession = voiceInputState.session;
  if (voiceSession) {
    await stopVoiceInput(voiceSession);
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
  const pendingSelections = discardDraft
    ? []
    : state.composer.selections.map(copySelectionReference);
  const pendingSelectionNumber = discardDraft ? 1 : state.composer.nextSelectionNumber;
  state.composer = createConversationState();
  state.composer.draft = pendingDraft;
  state.composer.attachments = pendingAttachments;
  state.composer.selections = pendingSelections;
  state.composer.nextSelectionNumber = pendingSelectionNumber;
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
  const source = queuedPrompt.displayText.trim() ||
    queuedPrompt.text.trim() ||
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
  const pendingSelections = state.activeSessionId
    ? []
    : state.composer.selections.map(copySelectionReference);
  const pendingSelectionNumber = state.activeSessionId
    ? 1
    : state.composer.nextSelectionNumber;
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
    conversation.selections = pendingSelections;
    conversation.nextSelectionNumber = pendingSelectionNumber;
    conversation.activeSessionIsNew = true;
    conversation.activeSessionTitleOverride = null;
    conversation.messages = [];
    conversation.messageKeys.clear();
    conversation.nativeMessagesActive = result.nativeMessageHistoryAvailable === true;
    conversation.history = conversation.nativeMessagesActive
      ? { hasMore: false, cursor: null, oversized: false } : null;
    conversation.nativeModeKnown = true;
    conversation.nativeEventIds.clear();
    conversation.pendingNativeMessages = [];
    conversation.promptQueue = [];
    resetRecoveredPrompt(conversation);
    resetStreamTracking(conversation);
    resetUsage(conversation);
    state.newSessionDefaults = result.newSessionDefaults ?? state.newSessionDefaults;
    state.nativeMessageHistoryAvailable =
      result.nativeMessageHistoryAvailable === true;
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
    conversation.nativeEventIds.clear();
    conversation.pendingNativeMessages = [];
    if (typeof result.nativeMessageHistoryAvailable === "boolean") {
      conversation.nativeMessagesActive = result.nativeMessageHistoryAvailable;
      conversation.nativeModeKnown = true;
    }
    for (const selection of conversation.selections) {
      if (selection.sessionId === previousSessionId) {
        selection.sessionId = session.sessionId;
      }
    }
    for (const message of conversation.messages) {
      for (const selection of message.selections ?? []) {
        if (selection.sessionId === previousSessionId) {
          selection.sessionId = session.sessionId;
        }
      }
    }
    state.conversations.set(session.sessionId, conversation);
    for (const prompt of conversation.promptQueue) {
      prompt.sessionId = session.sessionId;
    }
    applySessionSetup(result, result.context, conversation);
  }
  moveSelectionMessageMetadata(previousSessionId, session.sessionId);
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

function mergeOlderAssistantHistoryFragment(current, older) {
  if (
    current?.role !== "assistant" ||
    older?.role !== "assistant" ||
    current.completed !== false ||
    older.completed !== false ||
    current.nativeHistoryFragment !== true ||
    older.nativeHistoryFragment !== true
  ) {
    return false;
  }

  const currentText = typeof current.text === "string" ? current.text : "";
  const olderText = typeof older.text === "string" ? older.text : "";
  if (!olderText) {
    return false;
  }

  current.text = `${olderText}${currentText}`;
  return true;
}

function applyHistoryPage(page, conversation, replace = false) {
  if (!page.history || !Array.isArray(page.nativeMessages) || !Array.isArray(page.replayUpdates)) {
    throw new Error("The server returned an invalid conversation history page");
  }
  const canUpdateInPlace = !replace && isActiveConversation(conversation);
  const panelScrollPositions = canUpdateInPlace
    ? captureMessagePanelScroll(conversation)
    : new Map();
  const existingArticleIndexes = new Map();
  if (canUpdateInPlace) {
    elements.messages.querySelectorAll(".message").forEach((article) => {
      existingArticleIndexes.set(article, Number(article.dataset.messageIndex));
    });
  }
  const temporary = createConversationState(conversation.sessionId);
  temporary.loading = true;
  temporary.nativeMessagesActive = true;
  temporary.nativeModeKnown = true;
  replayPagedNativeHistory(page.replayUpdates, page.nativeMessages, temporary);
  mergeAdjacentToolGroups(temporary.messages, temporary);
  let addedMessages = [];
  const modifiedMessages = new Set();
  if (replace) {
    conversation.messages = temporary.messages;
    conversation.newerHistoryHidden = true;
  } else {
    const existing = new Map(
      conversation.messages
        .map((message) => [messageIdentity(message), message])
        .filter(([identity]) => identity)
    );
    addedMessages = temporary.messages.filter((message) => {
      const identity = messageIdentity(message);
      if (message.role !== "tool" && identity && existing.has(identity)) {
        const current = existing.get(identity);
        if (current && mergeOlderAssistantHistoryFragment(current, message)) {
          modifiedMessages.add(current);
        }
        return false;
      }
      if (message.role === "tool") {
        let continuation = null;
        for (const current of conversation.messages) {
          if (current.role !== "tool") {
            continue;
          }
          message.toolActivities = message.toolActivities.filter((activity) => {
            const newer = current.toolActivities.find((item) => item.id === activity.id);
            if (!newer) {
              return true;
            }
            continuation = current;
            if (newer.title === "Copilot tool") {
              newer.title = activity.title;
              modifiedMessages.add(current);
            }
            if (activity.detail && !newer.detail) {
              newer.detail = activity.detail;
              modifiedMessages.add(current);
            }
            return false;
          });
        }
        if (continuation && message.thinkingText) {
          if (!continuation.thinkingText.includes(message.thinkingText)) {
            continuation.thinkingText = `${message.thinkingText}\n\n${continuation.thinkingText}`.trim();
            modifiedMessages.add(continuation);
          }
          message.thinkingText = "";
        }
        if (message.toolActivities.length === 0 && !message.thinkingText) {
          return false;
        }
      }
      return true;
    });
    const olderGroup = addedMessages.at(-1);
    const newerGroup = conversation.messages[0];
    if (olderGroup?.role === "tool" && newerGroup?.role === "tool") {
      mergeToolGroupContents(olderGroup, newerGroup, newerGroup);
      if (conversation.currentToolGroupKey === olderGroup.toolGroupKey) {
        conversation.currentToolGroupKey = newerGroup.toolGroupKey;
      }
      addedMessages.pop();
      modifiedMessages.add(newerGroup);
    }
    conversation.messages.unshift(...addedMessages);
  }
  conversation.history = page.history;
  conversation.historyError = "";
  reindexMessages(conversation);
  if (isActiveConversation(conversation)) {
    if (replace) {
      conversation.preserveHistoryAnchor = true;
      renderMessages(conversation);
      delete conversation.preserveHistoryAnchor;
    } else {
      renderHistoryPageInPlace(
        conversation,
        addedMessages,
        modifiedMessages,
        panelScrollPositions,
        existingArticleIndexes
      );
    }
  }
}

async function loadOlderHistory(conversation = activeConversation()) {
  if (!conversation?.history?.hasMore || conversation.loading) {
    return;
  }
  if (conversation.historyLoading) {
    await conversation.historyLoadPromise;
    return;
  }
  const generation = conversation.historyGeneration;
  const before = conversation.messages.find((message) => message.nativeMessageId)?.nativeMessageId;
  const cursor = conversation.history.cursor;
  if (typeof cursor !== "string" || cursor.length === 0) {
    conversation.historyError = "Reload the latest messages to continue browsing history.";
    renderHistoryStatusInPlace(conversation);
    return;
  }
  const query = { cursor };
  const messageCount = conversation.messages.length;
  let continuePastEmptyPage = false;
  conversation.historyLoading = true;
  conversation.historyError = "";
  renderHistoryStatusInPlace(conversation);
  const pendingHistoryLoad = (async () => {
    try {
      const messageCount = conversation.messages.length;
      let nextQuery = query;
      for (let pageCount = 0; pageCount < 4; pageCount += 1) {
        let page;
        try {
          page = await api(`/api/sessions/${encodeURIComponent(conversation.sessionId)}/history?${
            new URLSearchParams(nextQuery)
          }`);
        } catch (error) {
          if (error.status !== 410 || !before || nextQuery.before) {
            throw error;
          }
          page = await api(`/api/sessions/${encodeURIComponent(conversation.sessionId)}/history?${
            new URLSearchParams({ before })
          }`);
        }
        if (generation !== conversation.historyGeneration) {
          return;
        }
        applyHistoryPage(page, conversation);
        if (
          conversation.messages.length > messageCount ||
          !conversation.history?.hasMore ||
          !conversation.history.cursor
        ) {
          break;
        }
        nextQuery = { cursor: conversation.history.cursor };
      }
    } catch (error) {
      if (generation === conversation.historyGeneration) {
        conversation.historyError = error.message;
      }
    } finally {
      if (generation === conversation.historyGeneration) {
        conversation.historyLoading = false;
        renderHistoryStatusInPlace(conversation);
        continuePastEmptyPage = conversation.messages.length === messageCount &&
          conversation.history?.hasMore === true &&
          !conversation.historyError &&
          isActiveConversation(conversation) &&
          elements.messages.scrollTop < 160;
      }
    }
  })();
  conversation.historyLoadPromise = pendingHistoryLoad;
  try {
    await pendingHistoryLoad;
  } finally {
    if (conversation.historyLoadPromise === pendingHistoryLoad) {
      conversation.historyLoadPromise = null;
    }
  }
  if (continuePastEmptyPage && generation === conversation.historyGeneration) {
    window.setTimeout(() => {
      void loadOlderHistory(conversation);
    }, 0);
  }
}

function hasVisibleConversationMessages(conversation) {
  const viewport = elements.messages.getBoundingClientRect();
  const visibleMessage = (role) => [...elements.messages.querySelectorAll(`.message.${role}`)]
    .some((article) => {
      const bounds = article.getBoundingClientRect();
      if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) {
        return false;
      }
      const message = conversation.messages[Number(article.dataset.messageIndex)];
      return Boolean(message) &&
        ((typeof message.text === "string" && message.text.trim().length > 0) ||
          (Array.isArray(message.attachments) && message.attachments.length > 0));
    });
  const hasUserMessage = visibleMessage("user");
  const hasAssistantMessage = visibleMessage("assistant");
  return hasUserMessage || hasAssistantMessage;
}

// Without a requested context, the server reuses the conversation's last context.
async function loadConversation(sessionId, requestedContext = undefined, force = false) {
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
    (requestedContext === undefined || conversation.sessionContext === requestedContext)
  ) {
    activateConversation(sessionId);
    return true;
  }

  activateConversation(sessionId);
  const previousLoadState = {
    sessionId: conversation.sessionId,
    loaded: conversation.loaded,
    messages: conversation.messages,
    messageKeys: new Map(conversation.messageKeys),
    nativeMessagesActive: conversation.nativeMessagesActive,
    nativeModeKnown: conversation.nativeModeKnown,
    nativeEventIds: new Set(conversation.nativeEventIds),
    pendingNativeMessages: [...conversation.pendingNativeMessages],
    history: conversation.history,
    historyError: conversation.historyError,
    newerHistoryHidden: conversation.newerHistoryHidden,
    historyWarning: conversation.historyWarning,
    scrollToLatest: conversation.scrollToLatest,
    usage: conversation.usage,
    contextUsage: conversation.contextUsage,
    usageRevision: conversation.usageRevision,
    sessionContext: conversation.sessionContext,
    configOptions: conversation.configOptions
  };
  selectionMessageRestorationCounts.delete(sessionId);
  conversation.loaded = false;
  conversation.scrollToLatest = true;
  conversation.historyGeneration += 1;
  conversation.history = null;
  conversation.historyLoading = false;
  conversation.historyLoadPromise = null;
  conversation.historyError = "";
  conversation.newerHistoryHidden = false;
  conversation.historyWarning = "";
  conversation.activeSessionIsNew = false;
  conversation.messages = [];
  conversation.messageKeys.clear();
  conversation.nativeMessagesActive = state.nativeMessageHistoryAvailable;
  conversation.nativeModeKnown = false;
  conversation.nativeEventIds.clear();
  conversation.pendingNativeMessages = [];
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
      body: JSON.stringify(
        requestedContext === undefined
          ? { fallbackContext: state.selectedContext, historyPaging: true }
          : { context: requestedContext, historyPaging: true }
      )
    });
    applySessionReplacement(result, sessionId);
    const promptState = applyServerPromptState(conversation.sessionId, result, request);
    conversation.loaded = true;
    applySessionSetup(result, requestedContext ?? state.selectedContext, conversation);
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
    const liveReplayUpdates = Array.isArray(result.liveReplayUpdates)
      ? result.liveReplayUpdates
      : [];
    conversation.nativeMessagesActive = result.nativeMessagesActive === true;
    conversation.nativeModeKnown = true;
    if (conversation.nativeMessagesActive || replayUpdates.length > 0) {
      conversation.messages = [];
      conversation.messageKeys.clear();
      resetStreamTracking(conversation);
    }
    const nativeMessages = Array.isArray(result.nativeMessages)
      ? result.nativeMessages
      : [];
    if (result.history?.replayMode === "acp") {
      replayNativeHistory([...replayUpdates, ...liveReplayUpdates], nativeMessages, conversation);
      const renderedChat = conversation.messages.some((message) => (
        (message.role === "user" || message.role === "assistant") &&
        ((typeof message.text === "string" && message.text.trim().length > 0) ||
          (Array.isArray(message.attachments) && message.attachments.length > 0))
      ));
      if (!renderedChat && nativeMessages.some(hasNativeContent)) {
        conversation.messages = [];
        conversation.messageKeys.clear();
        conversation.nativeEventIds.clear();
        resetStreamTracking(conversation);
        pendingMessageUpdates.delete(conversation);
        replayPagedNativeHistory(replayUpdates, nativeMessages, conversation);
        for (const params of liveReplayUpdates) {
          handleSessionUpdate(params, conversation.sessionId, conversation);
        }
      }
    } else if (result.history) {
      replayPagedNativeHistory(replayUpdates, nativeMessages, conversation);
      for (const params of liveReplayUpdates) {
        handleSessionUpdate(params, conversation.sessionId, conversation);
      }
    } else {
      replayNativeHistory([...replayUpdates, ...liveReplayUpdates], nativeMessages, conversation);
    }
    conversation.history = result.history ?? null;
    conversation.historyWarning = result.historyWarning ?? "";
    const pendingNativeMessages = [
      ...(Array.isArray(result.liveNativeMessages) ? result.liveNativeMessages : []),
      ...conversation.pendingNativeMessages
    ];
    conversation.pendingNativeMessages = [];
    if (conversation.nativeMessagesActive) {
      for (const nativeMessage of pendingNativeMessages) {
        ingestNativeMessage(nativeMessage, conversation);
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
    if (
      previousLoadState.loaded &&
      conversation.sessionId === previousLoadState.sessionId
    ) {
      conversation.loaded = previousLoadState.loaded;
      conversation.messages = previousLoadState.messages;
      conversation.messageKeys = previousLoadState.messageKeys;
      conversation.nativeMessagesActive = previousLoadState.nativeMessagesActive;
      conversation.nativeModeKnown = previousLoadState.nativeModeKnown;
      conversation.nativeEventIds = previousLoadState.nativeEventIds;
      conversation.pendingNativeMessages = previousLoadState.pendingNativeMessages;
      conversation.history = previousLoadState.history;
      conversation.historyError = previousLoadState.historyError;
      conversation.newerHistoryHidden = previousLoadState.newerHistoryHidden;
      conversation.historyWarning = previousLoadState.historyWarning;
      conversation.scrollToLatest = previousLoadState.scrollToLatest;
      conversation.usage = previousLoadState.usage;
      conversation.contextUsage = previousLoadState.contextUsage;
      conversation.usageRevision = previousLoadState.usageRevision;
      conversation.sessionContext = previousLoadState.sessionContext;
      conversation.configOptions = previousLoadState.configOptions;
      conversation.historyLoading = false;
      conversation.historyLoadPromise = null;
      renderUsage(conversation);
      renderConversationControls();
    }
    showError(error, conversation);
    return false;
  } finally {
    setLoading(false, conversation);
    if (
      conversation.loaded &&
      conversation.history?.hasMore &&
      isActiveConversation(conversation)
    ) {
      const generation = conversation.historyGeneration;
      let page = 0;
      for (; page < maximumInitialHistoryPages; page += 1) {
        if (
          generation !== conversation.historyGeneration ||
          !isActiveConversation(conversation) ||
          !conversation.history?.hasMore ||
          conversation.historyError ||
          (hasVisibleConversationMessages(conversation) &&
            elements.messages.scrollHeight > elements.messages.clientHeight + 1)
        ) {
          break;
        }
        await loadOlderHistory(conversation);
      }
      if (
        page === maximumInitialHistoryPages &&
        conversation.messages.length === 0 &&
        conversation.history?.hasMore &&
        !conversation.historyError
      ) {
        conversation.historyError = "No chat messages found in the recent history pages. Retry to continue searching.";
        renderMessages(conversation);
      }
    }
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
        showError(error, conversation);
        conversation.cancelRequested = false;
      } finally {
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
  if (pendingVoiceSubmit) {
    await pendingVoiceSubmit;
    return;
  }
  const voiceSession = voiceInputState.session;
  if (voiceSession) {
    const conversation = currentComposerConversation();
    pendingVoiceSubmit = (async () => {
      await stopVoiceInput(voiceSession);
      if (currentComposerConversation() !== conversation) {
        return;
      }
      await submitPrompt();
    })();
    try {
      await pendingVoiceSubmit;
    } finally {
      pendingVoiceSubmit = null;
    }
    return;
  }
  await submitPrompt();
}

async function submitPrompt() {
  let conversation = currentComposerConversation();
  const text = elements.input.value;
  const selections = conversation.selections.map(copySelectionReference);
  if (
    (!text.trim() && conversation.attachments.length === 0 && selections.length === 0) ||
    conversation.loading ||
    conversation.configurationBusy ||
    conversation.attachmentBusy
  ) {
    return;
  }
  const promptText = promptWithSelections(text, selections);
  const displayText = text.trim()
    ? text
    : selections.length > 0
      ? "Please explain these selected passages."
      : text;
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
  if (conversation.newerHistoryHidden) {
    const loaded = await loadConversation(conversation.sessionId, undefined, true);
    if (!loaded || currentComposerConversation() !== conversation) {
      return;
    }
  }
  if (conversation.activeSessionIsNew && conversation.messages.length === 0 &&
      conversation.sessionContext !== state.selectedContext) {
    conversation = await createServerConversation() ?? activeConversation();
  }
  if (!conversation?.sessionId) {
    return;
  }

  if (selections.length > 0) {
    const persisted = persistSelectionMessageMetadata(
      conversation.sessionId,
      promptText,
      displayText,
      selections
    );
    if (!persisted) {
      showSelectionNotice(
        "Selections were sent, but browser storage is unavailable; their chips may expand after a refresh."
      );
    }
  }
  elements.input.value = "";
  conversation.draft = "";
  resizePromptInput();
  conversation.attachments = [];
  conversation.selections = [];
  conversation.nextSelectionNumber = 1;
  renderAttachmentList();
  renderSelectionList();
  enqueuePrompt(conversation, promptText, attachments, false, displayText, selections);
}

function enqueuePrompt(
  conversation,
  text,
  attachments,
  reconnect = false,
  displayText = text,
  selections = []
) {
  const messageKey = nextSyntheticMessageKey("local-user", conversation);
  const queuedPrompt = {
    sessionId: conversation.sessionId,
    text,
    displayText,
    attachments,
    messageKey,
    reconnect
  };
  addMessage("user", displayText, messageKey, attachments, conversation, selections);
  const messageIndex = conversation.messageKeys.get(messageKey);
  const optimisticMessage = Number.isInteger(messageIndex)
    ? conversation.messages[messageIndex]
    : null;
  if (optimisticMessage) {
    optimisticMessage.clientPromptId = messageKey;
    optimisticMessage.localMessageKey = messageKey;
    optimisticMessage.optimisticPrompt = true;
    if (selections.length > 0) {
      const metadata = [...(selectionMessageMetadata[conversation.sessionId] ?? [])]
        .reverse().find((entry) => entry.promptText === text && !entry.clientPromptId);
      if (metadata) {
        metadata.clientPromptId = messageKey;
        writeSelectionMessageMetadata(metadata);
      }
    }
  }
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

async function reconnectTools() {
  const conversation = activeConversation();
  if (!canReloadMcp(conversation)) {
    return;
  }
  if (conversation.newerHistoryHidden) {
    const loaded = await loadConversation(conversation.sessionId, undefined, true);
    if (!loaded || activeConversation() !== conversation || !canReloadMcp(conversation)) {
      return;
    }
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
    state.nativeMessageHistoryAvailable =
      data.nativeMessageHistoryAvailable === true;
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
  source.addEventListener("native-message", (event) => {
    handleNativeMessage(JSON.parse(event.data));
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
elements.messages.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const button = target.closest("button.code-copy");
  if (button) {
    void copyCodeBlock(button);
  }
});
elements.messages.addEventListener("scroll", updateScrollToBottomButton, { passive: true });
elements.messages.addEventListener("scroll", () => {
  const conversation = activeConversation();
  if (!conversation || conversation.loading) {
    return;
  }
  const top = elements.messages.scrollTop;
  const movedUp = top < conversation.lastScrollTop - 1;
  conversation.lastScrollTop = top;
  conversation.lastScrollAtBottom = messagesAreAtBottom();
  if (movedUp && top < 160 && !conversation.historyError) {
    void loadOlderHistory(conversation);
  }
}, { passive: true });
elements.messages.addEventListener("keydown", handleMessageSelectionKeydown);
elements.messages.addEventListener("scroll", updateAskSelection, { passive: true });
elements.messages.addEventListener("load", updateScrollToBottomButton, true);
elements.messages.addEventListener("toggle", updateScrollToBottomButton, true);
elements.askSelection.addEventListener("mousedown", (event) => {
  event.preventDefault();
});
elements.askSelection.addEventListener("click", attachSelectedText);
document.addEventListener("pointerdown", (event) => {
  keyboardSelectionInProgress = false;
  for (const row of elements.messages.querySelectorAll(".message-selection-row")) {
    const menu = row.querySelector(".message-selection-menu");
    if (menu && !row.contains(event.target)) {
      menu.hidden = true;
      row.querySelector(".message-selection-summary").setAttribute("aria-expanded", "false");
    }
  }
  if (elements.askSelection.contains(event.target)) {
    return;
  }
  if (elements.messages.contains(event.target)) {
    pointerSelectionInProgress = true;
    hideAskSelection();
    clearMessageSelectionHighlight();
  } else {
    pointerSelectionInProgress = false;
    hideAskSelection();
  }
});
document.addEventListener("pointerup", () => {
  if (!pointerSelectionInProgress) {
    return;
  }
  pointerSelectionInProgress = false;
  scheduleAskSelectionUpdate();
});
document.addEventListener("pointercancel", () => {
  pointerSelectionInProgress = false;
  hideAskSelection();
});
document.addEventListener("keyup", handleMessageSelectionKeyup);
window.addEventListener("resize", updateAskSelection);
elements.scrollToBottom.addEventListener("click", () => {
  const conversation = activeConversation();
  if (conversation?.newerHistoryHidden) {
    void loadConversation(conversation.sessionId, undefined, true);
    return;
  }
  elements.messages.scrollTo({
    top: elements.messages.scrollHeight,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
  });
  updateScrollToBottomButton();
});
const messagesResizeObserver = new ResizeObserver(() => {
  updateScrollToBottomButton();
  const conversation = activeConversation();
  if (conversation && conversation.renderWidth !== elements.messages.clientWidth) {
    conversation.renderWidth = elements.messages.clientWidth;
    scheduleMessagesRender(conversation);
  }
});
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
elements.voiceInput.addEventListener("click", () => {
  if (voiceInputState.session) {
    void stopVoiceInput();
  } else {
    startVoiceInput();
  }
});
elements.input.addEventListener("input", () => {
  const conversation = currentComposerConversation();
  conversation.draft = elements.input.value;
  const session = voiceInputState.session;
  if (session?.conversation === conversation && !updateVoiceInputRangeAfterEdit(session, elements.input.value)) {
    void stopVoiceInput(session, {
      discardResults: true,
      notice: "Voice input stopped because the dictated text was edited."
    });
  }
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
renderVoiceInputControl();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    void stopVoiceInput(voiceInputState.session, {
      notice: "Voice input stopped because this tab was hidden."
    });
  }
  void updateScreenWakeLock();
});
window.addEventListener("pagehide", () => {
  void stopVoiceInput();
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
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
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
renderSelectionList();
renderUsage();
void refreshQuota();
resizePromptInput();
renderMessages();
renderConnectionStatus();
void updateScreenWakeLock();
connectEvents();
