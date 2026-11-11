const folderIconPaths = ["M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z"];
const fileIconPaths = ["M6 3h8l4 4v12.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5Z", "M14 3v4.5h4.5"];
const chevronIconPaths = ["M9 6l6 6-6 6"];

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

function describeError(error) {
  return error instanceof Error ? error.message : "The files could not be listed.";
}

function nameOf(relativePath) {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

// Names starting with "." are hidden, so a folder with such a segment is listed only while hidden files are shown.
function hasHiddenSegment(relativePath) {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}

// Preview requests split plain paths at ?, # and %, so the path travels as a file: reference with each segment encoded.
function fileReference(absolutePath) {
  return `file://${absolutePath.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

// Owns the Files tab in the Repository panel: a tree of the selected repository's files and folders, hidden names left out.
// Folders load when they are first opened, and selecting a file opens it in the file preview.
export function initFilesPanel({ api, openFile }) {
  const el = {
    status: document.querySelector("#files-status"),
    tree: document.querySelector("#files-tree"),
    hiddenToggle: document.querySelector("#files-hidden-toggle")
  };
  const s = {
    repository: null,
    active: false,
    // Hidden names are off by default; the server sends them only while this is on.
    showHidden: false,
    // Listings by folder path, where "" is the repository root. A stale listing keeps its entries until it reloads.
    listings: new Map(),
    expanded: new Set(),
    highlight: null,
    opened: null,
    requests: 0
  };

  function setRepository(root) {
    const repository = root || null;
    if (repository === s.repository) {
      return;
    }
    s.repository = repository;
    s.listings.clear();
    s.expanded.clear();
    s.highlight = null;
    s.opened = null;
    loadMissingListings();
    render();
  }

  function setActive(active) {
    const visible = active === true;
    if (visible === s.active) {
      return;
    }
    s.active = visible;
    if (visible) {
      // Showing the tab reads its listings again, so files created since it was last shown appear.
      markStale();
      loadMissingListings();
    }
    render();
  }

  function refresh() {
    markStale();
    loadMissingListings();
    render();
  }

  // Hidden names come from the server only while they are shown. Changing the setting drops every listing and reads them
  // again, so once hidden files are turned off the browser holds none of them.
  function setShowHidden(showHidden) {
    if (showHidden === s.showHidden) {
      return;
    }
    s.showHidden = showHidden;
    el.hiddenToggle.setAttribute("aria-pressed", String(showHidden));
    s.listings.clear();
    s.expanded = new Set([...s.expanded].filter((folder) => showHidden || !hasHiddenSegment(folder)));
    if (!showHidden && s.opened && hasHiddenSegment(s.opened)) {
      s.opened = null;
    }
    s.highlight = null;
    loadMissingListings();
    render();
  }

  function markStale() {
    for (const listing of s.listings.values()) {
      listing.stale = true;
    }
  }

  // Loads the root and the open folders that have no current listing. Only a visible tab loads anything.
  function loadMissingListings() {
    if (!s.active || !s.repository) {
      return;
    }
    for (const folder of ["", ...s.expanded]) {
      const listing = s.listings.get(folder);
      if (!listing || listing.stale || listing.error) {
        loadListing(folder);
      }
    }
  }

  function loadListing(folder) {
    const repository = s.repository;
    const listing = s.listings.get(folder) ?? { entries: null, truncated: false, error: null, stale: false, request: 0 };
    const request = ++s.requests;
    Object.assign(listing, { request, stale: false, error: null });
    s.listings.set(folder, listing);
    const query = new URLSearchParams({ repo: repository, path: folder });
    if (s.showHidden) {
      query.set("hidden", "1");
    }
    // A response is applied only if its listing is still the current one for the same repository.
    const isCurrent = () => listing.request === request && s.listings.get(folder) === listing;
    api(`/api/git/files?${query}`).then((result) => {
      if (isCurrent()) {
        Object.assign(listing, {
          entries: Array.isArray(result.entries) ? result.entries : [],
          truncated: result.truncated === true
        });
        render();
      }
    }, (error) => {
      if (isCurrent()) {
        Object.assign(listing, { entries: null, error: describeError(error) });
        render();
      }
    });
  }

  function treeItems() {
    return Array.from(el.tree.querySelectorAll('[role="treeitem"]'));
  }

  function showStatus(message, retry = false) {
    const children = [element("p", "", message)];
    if (retry) {
      const button = element("button", "changes-action", "Retry");
      button.type = "button";
      button.addEventListener("click", () => refresh());
      children.push(button);
    }
    el.status.replaceChildren(...children);
    el.status.hidden = false;
  }

  function note(message, level) {
    const node = element("div", "changes-notice files-note", message);
    node.style.setProperty("--level", String(level));
    node.setAttribute("role", "presentation");
    return node;
  }

  function render() {
    const root = s.repository ? s.listings.get("") : undefined;
    el.tree.replaceChildren();
    if (!s.repository) {
      showStatus("Choose a repository to see its files.");
    } else if (!root || root.entries === null) {
      if (root?.error) {
        showStatus(root.error, true);
      } else {
        showStatus("Loading…");
      }
    } else if (root.entries.length === 0) {
      showStatus(s.showHidden ? "This repository has no files." : "This repository has no visible files.");
    } else {
      el.status.replaceChildren();
      el.status.hidden = true;
      appendChildren(el.tree, "", 1);
    }
    const items = treeItems();
    items.forEach((item, index) => {
      item.id = `files-item-${index}`;
    });
    const highlighted = items.find((item) => item.dataset.key === s.highlight) ?? null;
    s.highlight = highlighted ? s.highlight : null;
    for (const item of items) {
      item.classList.toggle("is-active", item === highlighted);
    }
    if (highlighted) {
      el.tree.setAttribute("aria-activedescendant", highlighted.id);
    } else {
      el.tree.removeAttribute("aria-activedescendant");
    }
  }

  // Appends a folder's entries, or the state of loading them, so that expanded folders render their children in place.
  function appendChildren(container, folder, level) {
    const listing = s.listings.get(folder);
    if (!listing || listing.entries === null) {
      container.append(note(listing?.error ?? "Loading…", level));
      return;
    }
    if (listing.entries.length === 0) {
      container.append(note(s.showHidden ? "This folder is empty." : "This folder has no visible items.", level));
    }
    for (const entry of listing.entries) {
      container.append(entry.type === "directory" ? folderNode(entry, level) : fileNode(entry, level));
    }
    if (listing.truncated) {
      container.append(note("Only the first 2,000 items are listed.", level));
    }
  }

  function itemNode(entry, level, key) {
    const item = element("div", "files-item");
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(level));
    item.setAttribute("aria-label", entry.name);
    item.title = entry.path;
    item.dataset.key = key;
    item.dataset.type = entry.type;
    item.dataset.path = entry.path;
    const row = element("div", "files-row");
    row.style.setProperty("--level", String(level));
    item.append(row);
    return item;
  }

  function folderNode(entry, level) {
    const expanded = s.expanded.has(entry.path);
    const item = itemNode(entry, level, `folder:${entry.path}`);
    item.classList.add("files-folder");
    item.setAttribute("aria-expanded", String(expanded));
    item.querySelector(".files-row").append(
      iconElement(chevronIconPaths, "files-chevron"),
      iconElement(folderIconPaths),
      element("span", "files-name", entry.name)
    );
    if (expanded) {
      const children = element("div", "files-children");
      children.setAttribute("role", "group");
      appendChildren(children, entry.path, level + 1);
      item.append(children);
    }
    return item;
  }

  function fileNode(entry, level) {
    const item = itemNode(entry, level, `file:${entry.path}`);
    item.classList.add("files-file");
    item.setAttribute("aria-selected", String(entry.path === s.opened));
    item.querySelector(".files-row").append(
      element("span", "files-spacer"),
      iconElement(fileIconPaths),
      element("span", "files-name", entry.name)
    );
    return item;
  }

  function toggleFolder(folder) {
    if (s.expanded.has(folder)) {
      s.expanded.delete(folder);
    } else {
      s.expanded.add(folder);
    }
    loadMissingListings();
    render();
  }

  function openEntry(filePath) {
    s.opened = filePath;
    render();
    openFile(fileReference(`${s.repository.replace(/\/+$/, "")}/${filePath}`), nameOf(filePath));
  }

  // Clicking or pressing Enter acts on an item: folders open and close, and files open in the preview.
  function activate(item) {
    s.highlight = item.dataset.key;
    if (item.dataset.type === "directory") {
      toggleFolder(item.dataset.path);
    } else {
      openEntry(item.dataset.path);
    }
  }

  el.hiddenToggle.addEventListener("click", () => setShowHidden(!s.showHidden));
  el.tree.addEventListener("click", (event) => {
    const row = event.target instanceof Element ? event.target.closest(".files-row") : null;
    const item = row?.parentElement;
    if (!item || item.getAttribute("role") !== "treeitem") {
      return;
    }
    el.tree.focus();
    activate(item);
  });

  // The tree follows the WAI tree pattern: arrows move through the visible items, and Left and Right open and close folders.
  el.tree.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) {
      return;
    }
    const items = treeItems();
    const index = items.findIndex((item) => item.dataset.key === s.highlight);
    const current = index < 0 ? null : items[index];
    let next = null;
    switch (event.key) {
      case "ArrowDown":
        next = items[current ? Math.min(items.length - 1, index + 1) : 0] ?? null;
        break;
      case "ArrowUp":
        next = items[current ? Math.max(0, index - 1) : 0] ?? null;
        break;
      case "Home":
        next = items[0] ?? null;
        break;
      case "End":
        next = items.at(-1) ?? null;
        break;
      case "ArrowRight":
        if (current?.dataset.type === "directory") {
          if (current.getAttribute("aria-expanded") === "false") {
            toggleFolder(current.dataset.path);
          } else {
            next = current.querySelector('[role="treeitem"]');
          }
        }
        break;
      case "ArrowLeft":
        if (current?.dataset.type === "directory" && current.getAttribute("aria-expanded") === "true") {
          toggleFolder(current.dataset.path);
        } else {
          next = current?.parentElement.closest('[role="treeitem"]') ?? null;
        }
        break;
      case "Enter":
      case " ":
        if (!current) {
          return;
        }
        activate(current);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (next) {
      s.highlight = next.dataset.key;
      render();
      el.tree.querySelector(`[data-key="${CSS.escape(s.highlight)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  });

  render();

  return {
    setRepository,
    setActive,
    refresh,
    focus() {
      el.tree.focus();
    }
  };
}
