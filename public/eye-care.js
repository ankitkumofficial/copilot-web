const eyeCareStorageKey = "copilot-web-eye-care";
const reminderIntervalMinutes = 20;
const firstReminderMinute = 9 * 60 + 20;
const lastReminderMinute = 16 * 60 + 40;

export function initEyeCare() {
  const toggle = document.querySelector("#eye-care-toggle");
  const dialog = document.querySelector("#eye-care-dialog");
  const form = document.querySelector("#eye-care-form");
  const dismissButton = document.querySelector("#eye-care-dismiss");
  const stateLabel = document.querySelector("#eye-care-state");
  let enabled = readPreference();
  let lastReminderWindow = null;
  let timer = null;

  function showDueReminder() {
    const reminderWindow = reminderWindowAt(new Date());
    if (!enabled || reminderWindow === null || reminderWindow === lastReminderWindow) {
      return;
    }
    lastReminderWindow = reminderWindow;
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  function scheduleNextCheck() {
    clearTimeout(timer);
    timer = null;
    if (!enabled) {
      return;
    }
    const now = new Date();
    const millisecondsIntoInterval = (now.getMinutes() % reminderIntervalMinutes) * 60_000
      + now.getSeconds() * 1000 + now.getMilliseconds();
    timer = setTimeout(checkReminder, reminderIntervalMinutes * 60_000 - millisecondsIntoInterval);
  }

  function checkReminder() {
    showDueReminder();
    scheduleNextCheck();
  }

  function applyEnabled() {
    toggle.setAttribute("aria-pressed", String(enabled));
    stateLabel.textContent = enabled ? "On" : "Off";
    // The slot already under way counts as seen, so opening the page or turning Eye care on never pops up at once.
    lastReminderWindow = reminderWindowAt(new Date());
    scheduleNextCheck();
  }

  toggle.addEventListener("click", () => {
    enabled = !enabled;
    writePreference(enabled);
    applyEnabled();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) {
      return;
    }
    event.preventDefault();
    form.requestSubmit(dismissButton);
  });
  // Returning to the page checks at once, in case a timer was delayed while the page was hidden.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkReminder();
    }
  });
  applyEnabled();
}

// Each reminder owns the time from its slot until the next one; null means no reminder is due.
function reminderWindowAt(now) {
  if (now.getDay() === 0 || now.getDay() === 6) {
    return null;
  }
  const minute = now.getHours() * 60 + now.getMinutes();
  const windowStart = Math.floor(minute / reminderIntervalMinutes) * reminderIntervalMinutes;
  if (windowStart < firstReminderMinute || windowStart > lastReminderMinute) {
    return null;
  }
  return `${now.toDateString()} ${windowStart}`;
}

function readPreference() {
  try {
    return window.localStorage.getItem(eyeCareStorageKey) !== "false";
  } catch (error) {
    console.warn("Unable to restore the Eye care preference", error);
    return true;
  }
}

function writePreference(enabled) {
  try {
    window.localStorage.setItem(eyeCareStorageKey, String(enabled));
  } catch (error) {
    console.warn("Unable to save the Eye care preference; it may reset after a refresh", error);
  }
}
