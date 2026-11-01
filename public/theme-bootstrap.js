// Runs in <head> before the stylesheet so the first paint already has the chosen theme and sidebar state.
(() => {
  let preference = "system";
  try {
    const stored = localStorage.getItem("copilot-web-theme");
    if (stored === "light" || stored === "dark") {
      preference = stored;
    }
  } catch {
    preference = "system";
  }
  try {
    if (localStorage.getItem("copilot-web-sidebar-collapsed") === "true") {
      document.documentElement.dataset.sidebarCollapsed = "true";
    }
  } catch {
    document.documentElement.dataset.sidebarCollapsed = "false";
  }
  const theme = preference === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
})();
