// Unified diff parsing and rendering. Content is only ever inserted as text nodes.

function stripPathPrefix(value) {
  const trimmed = value.replace(/\t$/, "");
  if (trimmed === "/dev/null") {
    return null;
  }
  return trimmed.replace(/^[ab]\//, "");
}

function createFile() {
  return {
    oldPath: null,
    newPath: null,
    oldMode: null,
    newMode: null,
    isNew: false,
    isDeleted: false,
    isRename: false,
    isCopy: false,
    isBinary: false,
    similarity: null,
    headers: [],
    hunks: [],
    additions: 0,
    deletions: 0
  };
}

export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  const lines = String(text ?? "").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      file = createFile();
      files.push(file);
      hunk = null;
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (match) {
        file.oldPath = match[1];
        file.newPath = match[2];
      }
      file.headers.push(line);
      continue;
    }
    if (!file) {
      file = createFile();
      files.push(file);
    }
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (hunkMatch) {
      hunk = {
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        section: hunkMatch[5] ?? "",
        lines: []
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      const marker = line[0];
      const content = line.slice(1);
      if (marker === "+") {
        hunk.lines.push({ type: "add", text: content, oldLine: null, newLine: newLine++ });
        file.additions += 1;
        continue;
      }
      if (marker === "-") {
        hunk.lines.push({ type: "del", text: content, oldLine: oldLine++, newLine: null });
        file.deletions += 1;
        continue;
      }
      if (marker === " " || line === "") {
        hunk.lines.push({ type: "context", text: content, oldLine: oldLine++, newLine: newLine++ });
        continue;
      }
      if (marker === "\\") {
        hunk.lines.push({ type: "meta", text: line.slice(2), oldLine: null, newLine: null });
        continue;
      }
    }
    file.headers.push(line);
    if (line.startsWith("--- ")) {
      file.oldPath = stripPathPrefix(line.slice(4));
      file.isNew ||= file.oldPath === null;
    } else if (line.startsWith("+++ ")) {
      file.newPath = stripPathPrefix(line.slice(4));
      file.isDeleted ||= file.newPath === null;
    } else if (line.startsWith("new file mode ")) {
      file.isNew = true;
      file.newMode = line.slice(14);
    } else if (line.startsWith("deleted file mode ")) {
      file.isDeleted = true;
      file.oldMode = line.slice(18);
    } else if (line.startsWith("old mode ")) {
      file.oldMode = line.slice(9);
    } else if (line.startsWith("new mode ")) {
      file.newMode = line.slice(9);
    } else if (line.startsWith("rename from ")) {
      file.isRename = true;
      file.oldPath = line.slice(12);
    } else if (line.startsWith("rename to ")) {
      file.isRename = true;
      file.newPath = line.slice(10);
    } else if (line.startsWith("copy from ")) {
      file.isCopy = true;
      file.oldPath = line.slice(10);
    } else if (line.startsWith("copy to ")) {
      file.isCopy = true;
      file.newPath = line.slice(8);
    } else if (line.startsWith("similarity index ")) {
      file.similarity = Number.parseInt(line.slice(17), 10);
    } else if (/^Binary files .* differ$/.test(line) || line === "GIT binary patch") {
      file.isBinary = true;
    }
  }
  return { files };
}

export function hunkText(file, hunk) {
  const headers = file.headers.filter((line) => (
    line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")
  ));
  const body = hunk.lines.map((line) => {
    if (line.type === "meta") {
      return `\\ ${line.text}`;
    }
    return `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}`;
  });
  return `${[...headers, hunk.header, ...body].join("\n")}\n`;
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

const lineLabels = { add: "Added", del: "Removed", context: "Unchanged", meta: "Note" };
const lineMarkers = { add: "+", del: "−", context: "", meta: "" };

function lineRow(line) {
  const row = element("tr", `diff-line diff-${line.type}`);
  row.append(
    element("td", "diff-num diff-num-old", line.oldLine === null ? "" : String(line.oldLine)),
    element("td", "diff-num diff-num-new", line.newLine === null ? "" : String(line.newLine))
  );
  const markerCell = element("td", "diff-marker");
  const marker = element("span", "", lineMarkers[line.type]);
  marker.setAttribute("aria-hidden", "true");
  markerCell.append(marker, element("span", "visually-hidden", lineLabels[line.type]));
  row.append(markerCell, element("td", "diff-code", line.type === "meta" ? line.text : line.text || "\u200b"));
  return row;
}

// Renders parsed files into container. Options: caption, maxLines, onRenderMore(), hunkActions(file, hunk, index).
export function renderDiff(container, parsed, options = {}) {
  container.replaceChildren();
  const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY;
  let rendered = 0;
  let remaining = 0;
  let hunkIndex = 0;
  for (const file of parsed.files) {
    if (file.hunks.length === 0) {
      continue;
    }
    const table = element("table", "diff-table");
    if (options.caption) {
      table.append(element("caption", "visually-hidden", options.caption));
    }
    const head = element("thead", "visually-hidden");
    const headRow = element("tr");
    for (const label of ["Old line", "New line", "Change", "Content"]) {
      const cell = element("th", "", label);
      cell.scope = "col";
      headRow.append(cell);
    }
    head.append(headRow);
    table.append(head);
    for (const hunk of file.hunks) {
      const body = element("tbody", "diff-hunk-group");
      body.dataset.hunkIndex = String(hunkIndex);
      if (rendered >= maxLines) {
        remaining += hunk.lines.length + 1;
        hunkIndex += 1;
        continue;
      }
      const headerRow = element("tr", "diff-hunk");
      const headerCell = element("td", "diff-hunk-cell");
      headerCell.colSpan = 4;
      const headerText = element("span", "diff-hunk-header", `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      headerCell.append(headerText);
      if (hunk.section) {
        headerCell.append(element("span", "diff-hunk-section", hunk.section));
      }
      const actions = options.hunkActions?.(file, hunk, hunkIndex);
      if (actions) {
        const actionGroup = element("span", "diff-hunk-actions");
        actionGroup.append(...actions);
        headerCell.append(actionGroup);
      }
      headerRow.append(headerCell);
      body.append(headerRow);
      rendered += 1;
      for (const line of hunk.lines) {
        if (rendered >= maxLines) {
          remaining += 1;
          continue;
        }
        body.append(lineRow(line));
        rendered += 1;
      }
      table.append(body);
      hunkIndex += 1;
    }
    container.append(table);
  }
  if (remaining > 0 && options.onRenderMore) {
    const more = element("button", "diff-render-more", `Render remaining ${remaining.toLocaleString()} lines`);
    more.type = "button";
    more.addEventListener("click", () => options.onRenderMore());
    container.append(more);
  }
  return { rendered, remaining };
}
