const eyeCareStorageKey = "copilot-web-eye-care";
const eyeCareSoundStorageKey = "copilot-web-eye-care-sound";
const reminderIntervalMinutes = 20;
const firstReminderMinute = 9 * 60 + 20;
const lastReminderMinute = 16 * 60 + 40;
const countdownSeconds = 20;
let audioContext = null;

export function initEyeCare() {
  const toggle = document.querySelector("#eye-care-toggle");
  const dialog = document.querySelector("#eye-care-dialog");
  const form = document.querySelector("#eye-care-form");
  const dismissButton = document.querySelector("#eye-care-dismiss");
  const stateLabel = document.querySelector("#eye-care-state");
  const soundToggle = document.querySelector("#eye-care-sound");
  const startButton = document.querySelector("#eye-care-start");
  const countLabel = document.querySelector("#eye-care-count");
  let enabled = readPreference(eyeCareStorageKey);
  let soundEnabled = readPreference(eyeCareSoundStorageKey);
  let lastReminderWindow = null;
  let timer = null;
  let countdownTimer = null;

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

  function applySoundToggle() {
    const label = soundEnabled ? "Sound enabled" : "Sound disabled";
    soundToggle.dataset.sound = soundEnabled ? "on" : "off";
    soundToggle.setAttribute("aria-label", label);
    soundToggle.title = label;
  }

  function showCount(value) {
    countLabel.hidden = false;
    countLabel.textContent = String(value);
    if (!soundEnabled) {
      return;
    }
    if (value === 0) {
      playFinishedChime();
    } else {
      playTick();
    }
  }

  function startCountdown() {
    stopCountdown();
    if (soundEnabled) {
      prepareAudio();
    }
    let remaining = countdownSeconds;
    showCount(remaining);
    countdownTimer = setInterval(() => {
      remaining -= 1;
      showCount(remaining);
      if (remaining === 0) {
        stopCountdown();
      }
    }, 1000);
  }

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function resetCountdown() {
    stopCountdown();
    countLabel.hidden = true;
    countLabel.textContent = "";
  }

  toggle.addEventListener("click", () => {
    enabled = !enabled;
    writePreference(eyeCareStorageKey, enabled);
    applyEnabled();
  });
  soundToggle.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    writePreference(eyeCareSoundStorageKey, soundEnabled);
    applySoundToggle();
    if (soundEnabled) {
      prepareAudio();
    }
  });
  startButton.addEventListener("click", startCountdown);
  dialog.addEventListener("close", resetCountdown);
  dialog.addEventListener("keydown", (event) => {
    // Enter on a focused button activates that button, such as the counter controls, instead of dismissing.
    if (event.key !== "Enter" || event.isComposing || event.target.closest("button")) {
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
  applySoundToggle();
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

function readPreference(storageKey) {
  try {
    return window.localStorage.getItem(storageKey) !== "false";
  } catch (error) {
    console.warn("Unable to restore the Eye care preference", error);
    return true;
  }
}

function writePreference(storageKey, enabled) {
  try {
    window.localStorage.setItem(storageKey, String(enabled));
  } catch (error) {
    console.warn("Unable to save the Eye care preference; it may reset after a refresh", error);
  }
}

// Browsers only allow sound after a user gesture, so this runs from a click handler.
function prepareAudio() {
  if (!audioContext) {
    if (!window.AudioContext) {
      return;
    }
    audioContext = new window.AudioContext();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume().catch((error) => console.warn("Unable to play Eye care sounds", error));
  }
}

function playTick() {
  playTone(880, { type: "sine", duration: 0.09, peak: 0.25 });
}

// Rising triangle-wave notes, unlike the sine tick, so the finish sounds different.
function playFinishedChime() {
  [523.25, 659.25, 783.99].forEach((frequency, index) => {
    playTone(frequency, { type: "triangle", duration: 0.7, peak: 0.3, delay: index * 0.2 });
  });
}

function playTone(frequency, { type, duration, peak, delay = 0 }) {
  if (!audioContext) {
    return;
  }
  const start = audioContext.currentTime + delay;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration);
}
