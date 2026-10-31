// Rich-text prompt composer. It renders Markdown as formatted text while
// typing or pasting, and exposes a textarea-compatible API (value, selection
// offsets, disabled, placeholder) whose value is the Markdown source.

const TEXT_BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "PRE"]);
const BLOCK_TAGS = new Set([
  ...TEXT_BLOCK_TAGS,
  "UL", "OL", "BLOCKQUOTE", "HR", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH",
  "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "FIGURE", "FIGCAPTION",
  "ADDRESS", "DL", "DT", "DD", "CENTER", "FORM", "FIELDSET", "DETAILS", "SUMMARY", "BODY"
]);
const SKIPPED_PASTE_TAGS = new Set([
  "SCRIPT", "STYLE", "META", "LINK", "TITLE", "HEAD", "NOSCRIPT", "TEMPLATE", "SVG", "IMG",
  "PICTURE", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "EMBED", "CANVAS", "BUTTON", "INPUT",
  "SELECT", "TEXTAREA", "OPTION"
]);
const ZERO_WIDTH_SPACE = "\u200b";
const PASTED_BULLET = /^(\s*)[•·◦▪‣●○■□➢►▸–]\s+/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +)(.*)$/;
const INLINE_RULES = [
  { pattern: /(?<!\*)\*\*(?![\s*])([^*]+?)(?<!\s)\*\*$/, tag: "strong" },
  { pattern: /(?<![\w_])__(?![\s_])([^_]+?)(?<!\s)__$/, tag: "strong", delimiter: "__" },
  { pattern: /(?<!\*)\*(?![\s*])([^*]+?)(?<!\s)\*$/, tag: "em" },
  { pattern: /(?<![\w_])_(?![\s_])([^_]+?)(?<!\s)_$/, tag: "em", delimiter: "_" },
  { pattern: /~~(?![\s~])([^~]+?)(?<!\s)~~$/, tag: "s" },
  { pattern: /(?<!`)`([^`]+)`$/, tag: "code" }
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeHref(value) {
  const href = String(value ?? "").trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : "";
}

// ---------------------------------------------------------------------------
// Markdown -> editor HTML
// ---------------------------------------------------------------------------

export function inlineMarkdownToHtml(text, {
  resolveLink = safeHref,
  linkAttributes = "",
  preserveDelimiters = true,
  strikeTag = "s"
} = {}) {
  const parse = (start, closing = "") => {
    let html = "";
    let index = start;
    while (index < text.length) {
      if (closing && index > start && text.startsWith(closing, index) && !/\s/.test(text[index - 1]) &&
        (closing[0] !== "_" || !/[a-z0-9]/i.test(text[index + closing.length] ?? ""))) {
        return { html, next: index + closing.length, closed: true };
      }
      const rest = text.slice(index);
      if (/^\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(rest)) {
        html += escapeHtml(text[index + 1]);
        index += 2;
        continue;
      }
      const code = rest.match(/^(`+)(?!`)([\s\S]*?[^`])\1(?!`)/);
      if (code) {
        let content = code[2];
        if (content.startsWith(" ") && content.endsWith(" ") && content.trim()) {
          content = content.slice(1, -1);
        }
        html += `<code>${escapeHtml(content)}</code>`;
        index += code[0].length;
        continue;
      }
      const link = rest.match(/^\[((?:\\.|[^\]\\\n])+)\]\(([^()\s]+)\)/);
      if (link) {
        const href = text[index - 1] !== "!" && resolveLink(link[2]);
        const attributes = href && typeof linkAttributes === "function"
          ? linkAttributes(href)
          : linkAttributes;
        html += href
          ? `<a href="${escapeHtml(href)}"${attributes}>${inlineMarkdownToHtml(link[1], {
            resolveLink, linkAttributes, preserveDelimiters, strikeTag
          })}</a>`
          : escapeHtml(link[0]);
        index += link[0].length;
        continue;
      }
      const run = rest.match(/^(\*+|_+|~+)/)?.[1];
      const supportedRun = run && (run[0] === "~" ? run.length === 2 : run.length <= 3);
      const marker = supportedRun && /\S/.test(rest[run.length] ?? "")
        ? run.slice(0, 2)
        : null;
      if (marker && (marker[0] !== "_" || !/[a-z0-9]/i.test(text[index - 1] ?? ""))) {
        const inner = parse(index + marker.length, marker);
        if (inner.closed) {
          const tag = marker === "~~" ? strikeTag : marker.length === 2 ? "strong" : "em";
          const attributes = preserveDelimiters && marker[0] === "_" ? ` data-md="${marker}"` : "";
          html += `<${tag}${attributes}>${inner.html}</${tag}>`;
          index = inner.next;
          continue;
        }
      }
      if (run) {
        html += escapeHtml(run);
        index += run.length;
        continue;
      }
      html += text[index] === "\n" ? "<br>" : escapeHtml(text[index]);
      index += 1;
    }
    return { html, next: index, closed: false };
  };
  return parse(0).html;
}

function textBlockHtml(tag, text, attributes = "") {
  return `<${tag}${attributes}>${inlineMarkdownToHtml(text) || "<br>"}</${tag}>`;
}

export function parseMarkdownList(lines, startIndex, renderInline = inlineMarkdownToHtml) {
  const first = lines[startIndex].match(LIST_ITEM);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const marker = ordered ? first[2].slice(-1) : first[2];
  const items = [];
  let index = startIndex;
  while (index < lines.length) {
    const match = lines[index].match(LIST_ITEM);
    if (!match || match[1].length !== indent) {
      break;
    }
    const itemOrdered = /\d/.test(match[2]);
    const itemMarker = itemOrdered ? match[2].slice(-1) : match[2];
    if (itemOrdered !== ordered || itemMarker !== marker) {
      break;
    }
    let html = renderInline(match[4]) || "<br>";
    const contentIndent = match[1].length + match[2].length + match[3].length;
    index += 1;
    while (index < lines.length) {
      const nested = lines[index].match(LIST_ITEM);
      if (nested && nested[1].length > indent) {
        const result = parseMarkdownList(lines, index, renderInline);
        html += result.html;
        index = result.next;
      } else if (!nested && lines[index].startsWith(" ".repeat(contentIndent))) {
        html += `<br>${renderInline(lines[index].slice(contentIndent))}`;
        index += 1;
      } else {
        break;
      }
    }
    items.push(`<li>${html}</li>`);
  }
  let attributes = "";
  if (ordered) {
    const start = Number.parseInt(first[2], 10);
    attributes += start !== 1 ? ` start="${start}"` : "";
    attributes += marker !== "." ? ` data-delimiter="${escapeHtml(marker)}"` : "";
  } else if (marker !== "-") {
    attributes += ` data-marker="${escapeHtml(marker)}"`;
  }
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}${attributes}>${items.join("")}</${tag}>`, next: index };
}

export function splitTableRow(value) {
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

export function tableDelimiterAlignments(line) {
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

const TABLE_ALIGNMENTS = new Set(["left", "center", "right"]);

// Cells hold inline HTML; the table always gets a header row because a
// Markdown table cannot exist without one.
function editorTableHtml(rows, alignments) {
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const rowHtml = (row, tag) => `<tr>${Array.from({ length: columns }, (_, index) => {
    const alignment = TABLE_ALIGNMENTS.has(alignments[index]) ? ` data-align="${alignments[index]}"` : "";
    return `<${tag}${alignment}>${row[index] || "<br>"}</${tag}>`;
  }).join("")}</tr>`;
  const body = rows.slice(1).map((row) => rowHtml(row, "td")).join("");
  return `<table><thead>${rowHtml(rows[0] ?? [], "th")}</thead>${body ? `<tbody>${body}</tbody>` : ""}</table>`;
}

function markdownLinesToHtml(lines) {
  const html = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^`]*)$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length) {
        const closing = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length) {
          index += 1;
          break;
        }
        code.push(lines[index]);
        index += 1;
      }
      const language = fence[2].trim();
      let attributes = language ? ` data-language="${escapeHtml(language)}"` : "";
      attributes += fence[1] !== "```" ? ` data-fence="${escapeHtml(fence[1])}"` : "";
      // A trailing newline in a <pre> is only rendered when another follows it.
      const text = code.join("\n") + (code.length > 1 && code.at(-1) === "" ? "\n" : "");
      html.push(`<pre${attributes}>${escapeHtml(text) || "<br>"}</pre>`);
      continue;
    }
    const header = line.includes("|") ? splitTableRow(line) : null;
    const alignments = header && index + 1 < lines.length ? tableDelimiterAlignments(lines[index + 1]) : null;
    if (alignments && alignments.length === header.length) {
      const rows = [header];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      html.push(editorTableHtml(rows.map((row) => row.map((cell) => inlineMarkdownToHtml(cell))), alignments));
      continue;
    }
    const heading = line.match(/^(#{1,6}) (.*)$/);
    if (heading) {
      html.push(textBlockHtml(`h${heading[1].length}`, heading[2]));
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const quoted = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        quoted.push(lines[index].replace(/^> ?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${markdownLinesToHtml(quoted)}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = parseMarkdownList(lines, index);
      html.push(list.html);
      index = list.next;
      continue;
    }
    html.push(textBlockHtml("p", line));
    index += 1;
  }
  return html.join("");
}

export function markdownToEditorHtml(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  return markdownLinesToHtml(lines) || "<p><br></p>";
}

// ---------------------------------------------------------------------------
// Editor DOM -> Markdown, with a mapping between Markdown offsets and DOM
// positions. Output is a list of lines; each line is a list of pieces. Pieces
// that come from text nodes (or empty-block anchors) remember their DOM node.
// ---------------------------------------------------------------------------

class LineBuilder {
  constructor() {
    this.lines = [[]];
  }

  push(text, node = null, offset = 0, literal = false) {
    this.lines.at(-1).push({ text, node, offset, literal });
  }

  newline() {
    this.lines.push([]);
  }

  append(lines) {
    lines.forEach((line, index) => {
      if (index > 0) {
        this.newline();
      }
      this.lines.at(-1).push(...line);
    });
  }
}

function isElement(node, tagName) {
  return node?.nodeType === Node.ELEMENT_NODE && (!tagName || node.tagName === tagName);
}

function isBlockNode(node) {
  return node?.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(node.tagName);
}

function isWhitespaceText(node) {
  return node?.nodeType === Node.TEXT_NODE && !/[^\t\n\r ]/.test(node.data);
}

function lineHasText(line) {
  return line.some((piece) => piece.text.length > 0);
}

function lineIsBlank(line) {
  return !line.some((piece) => piece.text.trim().length > 0);
}

function styleMarks(element) {
  const marks = [];
  const style = element.style;
  const weight = style?.fontWeight ?? "";
  if (weight === "bold" || weight === "bolder" || Number.parseInt(weight, 10) >= 600) {
    marks.push("strong");
  }
  if (style?.fontStyle === "italic") {
    marks.push("em");
  }
  if ((style?.textDecorationLine || style?.textDecoration || "").includes("line-through")) {
    marks.push("s");
  }
  return marks;
}

function elementMarks(element) {
  const style = element.style;
  switch (element.tagName) {
    case "B":
    case "STRONG": {
      const weight = style?.fontWeight ?? "";
      return weight === "normal" || Number.parseInt(weight, 10) < 600 ? [] : ["strong"];
    }
    case "I":
    case "EM":
      return style?.fontStyle === "normal" ? [] : ["em"];
    case "S":
    case "STRIKE":
    case "DEL":
      return ["s"];
    case "SPAN":
    case "FONT":
      return styleMarks(element);
    default:
      return [];
  }
}

function markDelimiter(mark, element) {
  if (mark === "strong") {
    return element.dataset?.md === "__" ? "__" : "**";
  }
  if (mark === "em") {
    return element.dataset?.md === "_" ? "_" : "*";
  }
  return "~~";
}

function splitPiece(piece, at) {
  return [
    { ...piece, text: piece.text.slice(0, at) },
    { ...piece, text: piece.text.slice(at), offset: piece.offset + at }
  ];
}

function wrapLine(line, open, close) {
  if (lineIsBlank(line)) {
    return line;
  }
  const pieces = [...line];
  const leading = [];
  while (pieces.length > 0) {
    const piece = pieces[0];
    const whitespace = piece.text.match(/^\s*/)[0].length;
    if (whitespace === piece.text.length) {
      leading.push(pieces.shift());
      continue;
    }
    if (whitespace > 0) {
      const [space, rest] = splitPiece(piece, whitespace);
      leading.push(space);
      pieces[0] = rest;
    }
    break;
  }
  const trailing = [];
  while (pieces.length > 0) {
    const piece = pieces.at(-1);
    const whitespace = piece.text.match(/\s*$/)[0].length;
    if (whitespace === piece.text.length) {
      trailing.unshift(pieces.pop());
      continue;
    }
    if (whitespace > 0) {
      const [rest, space] = splitPiece(piece, piece.text.length - whitespace);
      pieces[pieces.length - 1] = rest;
      trailing.unshift(space);
    }
    break;
  }
  // Nested element boundaries belong inside the surrounding delimiters.
  return [
    ...leading.filter((piece) => piece.text !== ""),
    { text: open, node: null, offset: 0 },
    ...leading.filter((piece) => piece.text === ""),
    ...pieces,
    ...trailing.filter((piece) => piece.text === ""),
    { text: close, node: null, offset: 0 },
    ...trailing.filter((piece) => piece.text !== "")
  ];
}

function hasFollowingContent(node, block) {
  let current = node;
  while (current && current !== block) {
    let sibling = current.nextSibling;
    while (sibling) {
      if (sibling.nodeType === Node.TEXT_NODE ? sibling.data.length > 0 : sibling.nodeType === Node.ELEMENT_NODE) {
        if (sibling.nodeType === Node.TEXT_NODE || sibling.textContent.length > 0 || sibling.querySelector?.("br") || isElement(sibling, "BR")) {
          return true;
        }
      }
      sibling = sibling.nextSibling;
    }
    current = current.parentNode;
  }
  return false;
}

function pushText(builder, node, literal = false) {
  // Zero-width spaces are caret helpers placed after inline formatting; they
  // are never part of the Markdown value.
  const data = node.data;
  let text = "";
  let runStart = 0;
  for (let index = 0; index < data.length; index += 1) {
    const character = data[index];
    if (character === "\n" || character === ZERO_WIDTH_SPACE) {
      if (character === "\n" || text) {
        builder.push(text, node, runStart, literal);
      }
      if (character === "\n") {
        builder.newline();
      }
      text = "";
      runStart = index + 1;
    } else {
      text += character === "\u00a0" ? " " : character;
    }
  }
  builder.push(text, node, runStart, literal);
}

function anchorInlineElement(lines, element) {
  const parent = element.parentNode;
  const index = Array.prototype.indexOf.call(parent.childNodes, element);
  lines[0].unshift({ text: "", node: parent, offset: index });
  lines.at(-1).push({ text: "", node: parent, offset: index + 1 });
  return lines;
}

function serializeInlineNodes(nodes, builder, block, activeMarks) {
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(builder, node, true);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    if (node.tagName === "BR") {
      if (hasFollowingContent(node, block)) {
        builder.newline();
      }
      continue;
    }
    if (node.tagName === "CODE" || node.tagName === "KBD" || node.tagName === "SAMP" || node.tagName === "TT") {
      const inner = new LineBuilder();
      serializePlainNodes(node.childNodes, inner);
      const longestRun = Math.max(0, ...(node.textContent.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(longestRun + 1);
      builder.append(anchorInlineElement(inner.lines.map((line) => {
        const text = line.map((piece) => piece.text).join("");
        const pad = /^`|`$/.test(text) || (text.startsWith(" ") && text.endsWith(" ") && text.trim()) ? " " : "";
        return [
          { text: fence + pad, node: null, offset: 0 },
          ...line,
          { text: pad + fence, node: null, offset: 0 }
        ];
      }), node));
      continue;
    }
    const inner = new LineBuilder();
    if (node.tagName === "A") {
      serializeInlineNodes(node.childNodes, inner, block, activeMarks);
      const href = safeHref(node.getAttribute("href"));
      const text = node.textContent;
      builder.append(anchorInlineElement(href && text !== href
        ? inner.lines.map((line) => wrapLine(line, "[", `](${href})`))
        : inner.lines, node));
      continue;
    }
    const marks = elementMarks(node).filter((mark) => !activeMarks.has(mark));
    serializeInlineNodes(node.childNodes, inner, block, new Set([...activeMarks, ...marks]));
    let lines = inner.lines;
    for (const mark of marks.reverse()) {
      const delimiter = markDelimiter(mark, node);
      lines = lines.map((line) => wrapLine(line, delimiter, delimiter));
    }
    builder.append(marks.length > 0 ? anchorInlineElement(lines, node) : lines);
  }
}

function serializePlainNodes(nodes, builder) {
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(builder, node);
    } else if (isElement(node, "BR")) {
      builder.newline();
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (isBlockNode(node) && lineHasText(builder.lines.at(-1))) {
        builder.newline();
      }
      serializePlainNodes(node.childNodes, builder);
    }
  }
}

function anchorLine(node, offset) {
  return [{ text: "", node, offset }];
}

function serializeInlineBlock(block, nodes = block.childNodes) {
  const builder = new LineBuilder();
  serializeInlineNodes(nodes, builder, block, new Set());
  const lines = builder.lines;
  if (lines.length === 1 && !lineHasText(lines[0]) && !lines[0].some((piece) => piece.node)) {
    const first = nodes[0];
    return [anchorLine(block, first ? Array.prototype.indexOf.call(block.childNodes, first) : 0)];
  }
  return lines;
}

function prefixLines(lines, firstPrefix, restPrefix = firstPrefix) {
  return lines.map((line, index) => [
    { text: index === 0 ? firstPrefix : restPrefix, node: null, offset: 0 },
    ...line
  ]);
}

function serializePre(pre) {
  const builder = new LineBuilder();
  serializePlainNodes(pre.childNodes, builder);
  const lines = builder.lines;
  if (lines.length > 1 && !lineHasText(lines.at(-1))) {
    lines.pop();
  }
  if (lines.length === 1 && !lines[0].some((piece) => piece.node)) {
    lines[0] = anchorLine(pre, 0);
  }
  const content = lines.map((line) => line.map((piece) => piece.text).join("")).join("\n");
  let fence = pre.dataset.fence || "```";
  const longestRun = Math.max(0, ...(content.match(new RegExp(`^ {0,3}${fence[0] === "~" ? "~" : "`"}{3,}`, "gm")) ?? [])
    .map((run) => run.trim().length));
  if (longestRun >= fence.length) {
    fence = fence[0].repeat(longestRun + 1);
  }
  return [
    [{ text: `${fence}${pre.dataset.language ?? ""}`, node: null, offset: 0 }],
    ...lines,
    [{ text: fence, node: null, offset: 0 }]
  ];
}

function serializeListItem(item) {
  const lines = serializeBlockChildren(item);
  const firstContent = Array.from(item.childNodes).find((node) => !isWhitespaceText(node));
  if (isElement(firstContent, "UL") || isElement(firstContent, "OL")) {
    lines.unshift(anchorLine(item, 0));
  }
  return lines.length > 0 ? lines : [anchorLine(item, 0)];
}

function serializeList(list) {
  const ordered = list.tagName === "OL";
  const startAttribute = Number.parseInt(list.getAttribute("start") ?? "", 10);
  let number = Number.isFinite(startAttribute) ? startAttribute : 1;
  const bullet = list.dataset.marker || "-";
  const delimiter = list.dataset.delimiter || ".";
  const lines = [];
  let indent = ordered ? 3 : 2;
  for (const child of list.childNodes) {
    if (isWhitespaceText(child)) {
      continue;
    }
    if (isElement(child, "UL") || isElement(child, "OL")) {
      lines.push(...prefixLines(serializeList(child), " ".repeat(indent)));
      continue;
    }
    const marker = ordered ? `${number}${delimiter} ` : `${bullet} `;
    number += 1;
    indent = marker.length;
    const itemLines = isElement(child, "LI")
      ? serializeListItem(child)
      : isBlockNode(child) ? serializeBlock(child) : serializeInlineBlock(list, [child]);
    lines.push(...prefixLines(itemLines, marker, " ".repeat(marker.length)));
  }
  return lines.length > 0 ? lines : [anchorLine(list, 0)];
}

function serializeTableCell(cell) {
  // A Markdown table cell is a single line, so line breaks become spaces.
  return serializeInlineBlock(cell)
    .flatMap((line, index) => index === 0 ? line : [{ text: " ", node: null, offset: 0 }, ...line])
    .map((piece) => ({ ...piece, cell: true }));
}

export function tableDelimiter(alignment) {
  return { left: ":---", center: ":---:", right: "---:" }[alignment] ?? "---";
}

function serializeTable(table) {
  const rows = Array.from(table.rows);
  if (rows.length === 0) {
    return [anchorLine(table, 0)];
  }
  const columns = Math.max(1, ...rows.map((row) => row.cells.length));
  const lines = [];
  rows.forEach((row, rowIndex) => {
    const line = [{ text: "|", node: null, offset: 0 }];
    for (let index = 0; index < columns; index += 1) {
      const cell = row.cells[index];
      line.push({ text: " ", node: null, offset: 0 }, ...(cell ? serializeTableCell(cell) : []), { text: " |", node: null, offset: 0 });
    }
    lines.push(line);
    if (rowIndex === 0) {
      const delimiters = Array.from({ length: columns }, (_, index) => tableDelimiter(row.cells[index]?.dataset.align));
      lines.push([{ text: `| ${delimiters.join(" | ")} |`, node: null, offset: 0 }]);
    }
  });
  return lines;
}

function serializeBlock(block) {
  const tagName = block.tagName;
  if (/^H[1-6]$/.test(tagName)) {
    const lines = serializeInlineBlock(block);
    return prefixLines(lines, `${"#".repeat(Number(tagName[1]))} `, "");
  }
  switch (tagName) {
    case "PRE":
      return serializePre(block);
    case "UL":
    case "OL":
      return serializeList(block);
    case "LI":
      return prefixLines(serializeListItem(block), "- ", "  ");
    case "BLOCKQUOTE": {
      const lines = serializeBlockChildren(block);
      return prefixLines(lines.length > 0 ? lines : [anchorLine(block, 0)], "> ");
    }
    case "HR":
      return [[{ text: "---", node: block, offset: 0 }]];
    case "TABLE":
      return serializeTable(block);
    default:
      return Array.from(block.childNodes).some(isBlockNode)
        ? serializeBlockChildren(block)
        : serializeInlineBlock(block);
  }
}

function serializeBlockChildren(parent) {
  const lines = [];
  let inlineNodes = [];
  const hasBlocks = Array.from(parent.childNodes).some(isBlockNode);
  const flush = () => {
    if (inlineNodes.length === 0) {
      return;
    }
    if (!(hasBlocks && inlineNodes.every(isWhitespaceText))) {
      lines.push(...serializeInlineBlock(parent, inlineNodes));
    }
    inlineNodes = [];
  };
  for (const child of parent.childNodes) {
    if (isBlockNode(child)) {
      flush();
      lines.push(...serializeBlock(child));
    } else {
      inlineNodes.push(child);
    }
  }
  flush();
  return lines;
}

function escapeLinePieces(line) {
  const source = line.map((piece) => piece.text).join("");
  const blockMarker = source.match(/^( {0,3})(?:#{1,6} |>|[-+] |-{3,}\s*$|(\d{1,9})[.)] +)/);
  const blockEscape = blockMarker ? blockMarker[1].length + (blockMarker[2]?.length ?? 0) : -1;
  let position = 0;
  return line.flatMap((piece) => {
    const start = position;
    position += piece.text.length;
    if (!piece.literal) {
      return [piece];
    }
    const pieces = [];
    const special = piece.cell ? /[\\*_~`[\]|]/ : /[\\*_~`[\]]/;
    let runStart = 0;
    for (let index = 0; index < piece.text.length; index += 1) {
      if (special.test(piece.text[index]) || start + index === blockEscape) {
        if (index > runStart) {
          pieces.push({ ...piece, text: piece.text.slice(runStart, index), offset: piece.offset + runStart });
        }
        // The escape occupies Markdown space, but no character in the DOM.
        pieces.push({ text: "\\", node: piece.node, offset: piece.offset + index, endOffset: piece.offset + index });
        runStart = index;
      }
    }
    pieces.push({ ...piece, text: piece.text.slice(runStart), offset: piece.offset + runStart });
    return pieces;
  });
}

export function serializeEditor(root) {
  const lines = serializeBlockChildren(root);
  if (lines.length === 0) {
    lines.push(anchorLine(root, 0));
  }
  const pieces = [];
  let text = "";
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      text += "\n";
    }
    for (const piece of escapeLinePieces(line)) {
      if (piece.node) {
        pieces.push({ ...piece, start: text.length, line: lineIndex });
      }
      text += piece.text;
    }
  });
  return { text, pieces, lineCount: lines.length };
}

// ---------------------------------------------------------------------------
// Pasted HTML -> editor HTML
// ---------------------------------------------------------------------------

function collapseWhitespace(value) {
  return value.replace(/\u00a0/g, " ").replace(/[\t\n\r\f ]+/g, " ");
}

function trimInlineHtml(html) {
  let result = html;
  let previous;
  do {
    previous = result;
    result = result
      .replace(/^((?:<(?!br>)[^/>][^>]*>)*)(?: |<br>)+/, "$1")
      .replace(/(?: |<br>)+((?:<\/[^>]+>)*)$/, "$1");
  } while (result !== previous);
  return /[^\s]/.test(result.replace(/<[^>]+>/g, "")) ? result : "";
}

function hasBlockDescendant(element) {
  return Array.from(element.querySelectorAll("*")).some((child) => BLOCK_TAGS.has(child.tagName));
}

function isHiddenElement(element) {
  return element.style?.display === "none" || element.hidden;
}

function pastedInlineHtml(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(collapseWhitespace(node.data));
  }
  if (node.nodeType !== Node.ELEMENT_NODE || SKIPPED_PASTE_TAGS.has(node.tagName) || isHiddenElement(node)) {
    return "";
  }
  if (node.tagName === "BR") {
    return "<br>";
  }
  if (["CODE", "KBD", "SAMP", "TT"].includes(node.tagName)) {
    const text = node.textContent.replace(/\r\n?|\n/g, " ").replace(/\u00a0/g, " ");
    return text.trim() ? `<code>${escapeHtml(text)}</code>` : escapeHtml(text);
  }
  let inner = Array.from(node.childNodes).map(pastedInlineHtml).join("");
  if (BLOCK_TAGS.has(node.tagName) && inner.trim()) {
    inner = ` ${inner} `;
  }
  if (node.tagName === "A") {
    const href = safeHref(node.getAttribute("href"));
    return href && inner.trim() ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
  }
  if (!/[^\s]/.test(inner.replace(/<[^>]+>/g, ""))) {
    return inner;
  }
  for (const mark of elementMarks(node).reverse()) {
    inner = `<${mark}>${inner}</${mark}>`;
  }
  return inner;
}

function pastedTableHtml(table) {
  const rows = Array.from(table.rows).filter((row) => !isHiddenElement(row) && row.cells.length > 0);
  const cells = rows.map((row) => Array.from(row.cells).map((cell) =>
    trimInlineHtml(Array.from(cell.childNodes).map(pastedInlineHtml).join("").replaceAll("<br>", " "))));
  if (!cells.flat().some(Boolean)) {
    return "";
  }
  const alignments = Array.from(rows[0].cells).map((cell) =>
    (cell.style?.textAlign || cell.getAttribute("align") || "").toLowerCase());
  return editorTableHtml(cells, alignments);
}

function pastedListItemHtml(item) {
  const parts = [];
  let nested = "";
  let inline = "";
  const flush = () => {
    const html = trimInlineHtml(inline);
    if (html) {
      parts.push(html);
    }
    inline = "";
  };
  for (const child of item.childNodes) {
    if (isElement(child, "UL") || isElement(child, "OL")) {
      flush();
      nested += pastedListHtml(child);
    } else if (child.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(child.tagName)) {
      flush();
      const inner = pastedListItemHtml(child);
      parts.push(...inner.parts);
      nested += inner.nested;
    } else {
      inline += pastedInlineHtml(child);
    }
  }
  flush();
  return { parts, nested };
}

function pastedListHtml(list) {
  const tag = list.tagName === "OL" ? "ol" : "ul";
  const start = Number.parseInt(list.getAttribute("start") ?? "", 10);
  const attributes = tag === "ol" && Number.isFinite(start) && start !== 1 ? ` start="${start}"` : "";
  const items = [];
  for (const child of list.children) {
    if (child.tagName === "UL" || child.tagName === "OL") {
      const nested = pastedListHtml(child);
      if (items.length > 0) {
        items[items.length - 1] = items.at(-1).replace(/<\/li>$/, `${nested}</li>`);
      } else {
        items.push(`<li><br>${nested}</li>`);
      }
    } else if (!SKIPPED_PASTE_TAGS.has(child.tagName)) {
      const { parts, nested } = pastedListItemHtml(child);
      items.push(`<li>${parts.join("<br>") || "<br>"}${nested}</li>`);
    }
  }
  return items.length > 0 ? `<${tag}${attributes}>${items.join("")}</${tag}>` : "";
}

function pastedPreText(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.data.replace(/\u00a0/g, " ");
  }
  if (isElement(node, "BR")) {
    return "\n";
  }
  if (node.nodeType !== Node.ELEMENT_NODE || SKIPPED_PASTE_TAGS.has(node.tagName)) {
    return "";
  }
  const text = Array.from(node.childNodes).map(pastedPreText).join("");
  return (node.tagName === "DIV" || node.tagName === "P") && text && !text.endsWith("\n") ? `${text}\n` : text;
}

function collectPastedBlocks(parent, blocks) {
  let inline = "";
  const flush = () => {
    if (!inline) {
      return;
    }
    const lines = inline.split(/<br>/);
    const content = trimInlineHtml(inline);
    if (content) {
      blocks.push({ type: "p", html: `<p>${content}</p>` });
    } else if (lines.length > 1) {
      blocks.push({ type: "blank" });
    }
    inline = "";
  };
  for (const child of parent.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      inline += pastedInlineHtml(child);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE || SKIPPED_PASTE_TAGS.has(child.tagName) || isHiddenElement(child)) {
      continue;
    }
    const tagName = child.tagName;
    if (/^H[1-6]$/.test(tagName)) {
      flush();
      const content = trimInlineHtml(Array.from(child.childNodes).map(pastedInlineHtml).join(""));
      if (content) {
        blocks.push({ type: "h", html: `<${tagName.toLowerCase()}>${content}</${tagName.toLowerCase()}>` });
      }
    } else if (tagName === "UL" || tagName === "OL") {
      flush();
      const html = pastedListHtml(child);
      if (html) {
        blocks.push({ type: "list", html });
      }
    } else if (tagName === "LI") {
      flush();
      const { parts, nested } = pastedListItemHtml(child);
      blocks.push({ type: "list", html: `<ul><li>${parts.join("<br>") || "<br>"}${nested}</li></ul>` });
    } else if (tagName === "PRE") {
      flush();
      const text = pastedPreText(child).replace(/\n$/, "");
      blocks.push({ type: "pre", html: `<pre>${escapeHtml(text) || "<br>"}</pre>` });
    } else if (tagName === "BLOCKQUOTE") {
      flush();
      const inner = [];
      collectPastedBlocks(child, inner);
      const html = joinPastedBlocks(inner);
      if (html) {
        blocks.push({ type: "quote", html: `<blockquote>${html}</blockquote>` });
      }
    } else if (tagName === "TABLE") {
      flush();
      const html = pastedTableHtml(child);
      if (html) {
        blocks.push({ type: "table", html });
      }
    } else if (tagName === "HR") {
      flush();
      blocks.push({ type: "p", html: "<p>---</p>" });
    } else if (BLOCK_TAGS.has(tagName) || hasBlockDescendant(child)) {
      flush();
      collectPastedBlocks(child, blocks);
    } else if (tagName === "BR") {
      inline += "<br>";
    } else {
      inline += pastedInlineHtml(child);
    }
  }
  flush();
}

function bulletParagraphsToLists(blocks) {
  const result = [];
  for (const block of blocks) {
    const match = block.type === "p" && block.html.match(/^<p>\s*[•·◦▪‣●○■□➢►▸]\s*(.*)<\/p>$/s);
    if (!match) {
      result.push(block);
      continue;
    }
    const item = `<li>${trimInlineHtml(match[1]) || "<br>"}</li>`;
    const previous = result.at(-1);
    if (previous?.type === "bullets") {
      previous.items.push(item);
    } else {
      result.push({ type: "bullets", items: [item] });
    }
  }
  return result.map((block) => block.type === "bullets"
    ? { type: "list", html: `<ul>${block.items.join("")}</ul>` }
    : block);
}

function joinPastedBlocks(blocks) {
  const html = [];
  let previous = null;
  for (const block of bulletParagraphsToLists(blocks)) {
    if (block.type === "blank") {
      if (previous && previous.type !== "blank") {
        previous = block;
      }
      continue;
    }
    // Pasted blocks are visually separated in their source; keep that as a
    // blank line so the serialized Markdown keeps separate paragraphs.
    if (previous) {
      html.push("<p><br></p>");
    }
    html.push(block.html);
    previous = block;
  }
  return html.join("");
}

function isCodeEditorHtml(body) {
  const styled = body.querySelector("[style*='white-space: pre'], [style*='white-space:pre']");
  return Boolean(styled) &&
    !body.querySelector("p, ul, ol, li, h1, h2, h3, h4, h5, h6, table, blockquote") &&
    /monospace|menlo|monaco|consolas|courier/i.test(body.innerHTML);
}

function hasRichPasteContent(body) {
  if (body.querySelector("b, strong, i, em, s, strike, del, ul, ol, li, h1, h2, h3, h4, h5, h6, blockquote, pre, code, a[href], table, hr")) {
    return true;
  }
  return Array.from(body.querySelectorAll("span, font")).some((element) => styleMarks(element).length > 0);
}

function plainTextToMarkdown(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(PASTED_BULLET, "$1- "))
    .join("\n");
}

function codeBlockHtml(text) {
  const code = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return `<pre>${escapeHtml(code) || "<br>"}</pre>`;
}

export function clipboardToEditorHtml({ html = "", text = "", vscode = false } = {}) {
  if (html) {
    const body = new DOMParser().parseFromString(html, "text/html").body;
    if (vscode || isCodeEditorHtml(body)) {
      return text.includes("\n") ? codeBlockHtml(text) : escapeHtml(text);
    }
    if (hasRichPasteContent(body)) {
      const blocks = [];
      collectPastedBlocks(body, blocks);
      const converted = joinPastedBlocks(blocks);
      if (converted) {
        return converted;
      }
    }
    if (!text) {
      const blocks = [];
      collectPastedBlocks(body, blocks);
      return joinPastedBlocks(blocks);
    }
  } else if (vscode && text.includes("\n")) {
    return codeBlockHtml(text);
  }
  return text ? markdownToEditorHtml(plainTextToMarkdown(text)) : "";
}

// ---------------------------------------------------------------------------
// Custom element
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 200;
const HISTORY_GROUP_MS = 1000;

function comparePoints(nodeA, offsetA, nodeB, offsetB) {
  if (nodeA === nodeB) {
    return Math.sign(offsetA - offsetB);
  }
  const range = document.createRange();
  range.setStart(nodeA, offsetA);
  range.collapse(true);
  return -range.comparePoint(nodeB, offsetB);
}

function pieceEndOffset(piece) {
  return piece.endOffset ?? (piece.node.nodeType === Node.TEXT_NODE ? piece.offset + piece.text.length : piece.offset);
}

function visibleText(node) {
  return (node?.textContent ?? "").replaceAll(ZERO_WIDTH_SPACE, "");
}

function hasInlineContent(block) {
  return Array.from(block.childNodes).some((node) =>
    node.nodeType === Node.TEXT_NODE ? node.data.length > 0 : !isElement(node, "UL") && !isElement(node, "OL"));
}

function fillEmptyBlock(block) {
  if (!hasInlineContent(block)) {
    block.prepend(document.createElement("br"));
  }
}

function isListElement(node) {
  return isElement(node, "UL") || isElement(node, "OL");
}

function firstTextPosition(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode();
  return text ? [text, 0] : [element, 0];
}

function lastTextPosition(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest("ul, ol") && node.parentElement.closest("ul, ol") !== element.closest("ul, ol")
      && element.contains(node.parentElement.closest("ul, ol"))
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT
  });
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    last = node;
  }
  if (last) {
    return [last, last.data.length];
  }
  const nested = Array.from(element.childNodes).findIndex(isListElement);
  const brs = Array.from(element.childNodes).filter((node) => isElement(node, "BR"));
  if (brs.length > 0) {
    return [element, Array.prototype.indexOf.call(element.childNodes, brs[0])];
  }
  return [element, nested >= 0 ? nested : element.childNodes.length];
}

function flattenedText(root) {
  const copy = root.cloneNode(true);
  for (const element of copy.querySelectorAll("*")) {
    if (isBlockNode(element) || isElement(element, "BR")) {
      element.after(" ");
    }
  }
  return collapseWhitespace(copy.textContent).trim();
}

function renameElement(element, tagName) {
  const replacement = document.createElement(tagName);
  replacement.append(...element.childNodes);
  element.replaceWith(replacement);
  return replacement;
}

class PromptEditor extends HTMLElement {
  #initialized = false;
  #observer = null;
  #cachedValue = null;
  #savedOffsets = null;
  #savedRange = null;
  #applyingRule = false;
  #history = { undo: [], redo: [], lastType: null, lastTime: 0 };

  connectedCallback() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    this.setAttribute("role", "textbox");
    this.setAttribute("aria-multiline", "true");
    this.#applyEditable();
    if (!this.firstElementChild) {
      this.innerHTML = "<p><br></p>";
    }
    this.#observer = new MutationObserver(() => {
      this.#cachedValue = null;
    });
    this.#observer.observe(this, { childList: true, subtree: true, characterData: true, attributes: true });
    this.addEventListener("keydown", (event) => this.#handleKeydown(event));
    this.addEventListener("beforeinput", (event) => this.#handleBeforeInput(event));
    this.addEventListener("input", (event) => this.#handleInput(event));
    this.addEventListener("paste", (event) => this.#handlePaste(event));
    document.addEventListener("selectionchange", () => {
      const range = this.#currentRange();
      if (range) {
        this.#savedRange = range.cloneRange();
        this.#savedOffsets = null;
      }
    });
    this.#updateEmptyState();
  }

  get value() {
    if (this.#observer?.takeRecords().length) {
      this.#cachedValue = null;
    }
    if (this.#cachedValue === null) {
      this.#cachedValue = serializeEditor(this).text;
    }
    return this.#cachedValue;
  }

  set value(next) {
    const focused = Boolean(this.#currentRange());
    this.innerHTML = markdownToEditorHtml(next);
    this.#history = { undo: [], redo: [], lastType: null, lastTime: 0 };
    const length = this.value.length;
    this.#savedRange = null;
    this.#savedOffsets = [length, length];
    if (focused) {
      this.#applyOffsets(length, length);
    }
    this.#updateEmptyState();
  }

  get placeholder() {
    return this.getAttribute("placeholder") ?? "";
  }

  set placeholder(value) {
    this.setAttribute("placeholder", value);
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  set disabled(value) {
    this.toggleAttribute("disabled", Boolean(value));
    this.#applyEditable();
  }

  get selectionStart() {
    return this.#selectionOffsets()[0];
  }

  get selectionEnd() {
    return this.#selectionOffsets()[1];
  }

  setSelectionRange(start, end = start) {
    const length = this.value.length;
    const from = Math.max(0, Math.min(Number(start) || 0, length));
    const to = Math.max(from, Math.min(Number(end) || 0, length));
    if (document.activeElement !== this && !this.#currentRange()) {
      this.#savedOffsets = [from, to];
      this.#savedRange = null;
      return;
    }
    this.#applyOffsets(from, to);
  }

  setRangeText(text, start = this.selectionStart, end = this.selectionEnd, mode = "preserve") {
    const value = this.value;
    const insertedText = String(text);
    const from = Math.max(0, Math.min(start, value.length));
    const to = Math.max(from, Math.min(end, value.length));
    const [selectionStart, selectionEnd] = this.#selectionOffsets();
    const history = this.#history;
    this.#checkpoint();
    const undoStack = history.undo;
    this.value = value.slice(0, from) + insertedText + value.slice(to);
    this.#history = { ...history, undo: undoStack, redo: [] };
    const inserted = from + insertedText.length;
    if (mode === "end") {
      this.setSelectionRange(inserted, inserted);
    } else if (mode === "start") {
      this.setSelectionRange(from, from);
    } else if (mode === "select") {
      this.setSelectionRange(from, inserted);
    } else {
      const delta = insertedText.length - (to - from);
      const adjust = (offset) => offset <= from ? offset : offset >= to ? offset + delta : from;
      this.setSelectionRange(adjust(selectionStart), adjust(selectionEnd));
    }
  }

  focus(options) {
    if (this.disabled) {
      return;
    }
    const hadSelection = Boolean(this.#currentRange());
    super.focus(options);
    if (!hadSelection) {
      this.#restoreSavedSelection();
    }
  }

  insertMarkdown(text) {
    this.insertClipboard({ text: String(text) });
  }

  insertClipboard({ text = "", html = "", vscode = false }) {
    if (!this.#currentRange()) {
      this.focus();
    }
    if (this.#isInCode()) {
      this.#insertPlainText(text);
      return;
    }
    const converted = clipboardToEditorHtml({ html, text, vscode });
    if (converted) {
      this.#insertHtml(converted);
    }
  }

  undo() {
    this.#stepHistory("undo", "redo");
  }

  redo() {
    this.#stepHistory("redo", "undo");
  }

  // -- state ----------------------------------------------------------------

  #applyEditable() {
    const disabled = this.disabled;
    this.setAttribute("contenteditable", disabled ? "false" : "true");
    this.setAttribute("aria-disabled", String(disabled));
    this.tabIndex = disabled ? -1 : 0;
  }

  #updateEmptyState() {
    this.classList.toggle("is-empty", this.value === "");
  }

  #emitInput(inputType) {
    this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
  }

  #snapshot() {
    return { html: this.innerHTML, selection: this.#selectionOffsets() };
  }

  #checkpoint(type = "other") {
    const history = this.#history;
    const now = Date.now();
    const grouped = (type === "typing" || type === "delete") &&
      history.lastType === type &&
      now - history.lastTime < HISTORY_GROUP_MS;
    history.lastType = type;
    history.lastTime = now;
    if (grouped) {
      return;
    }
    history.undo.push(this.#snapshot());
    if (history.undo.length > HISTORY_LIMIT) {
      history.undo.shift();
    }
    history.redo = [];
  }

  #stepHistory(from, to) {
    const history = this.#history;
    const state = history[from].pop();
    if (!state) {
      return;
    }
    history[to].push(this.#snapshot());
    history.lastType = null;
    this.innerHTML = state.html;
    if (document.activeElement === this || this.#currentRange()) {
      this.#applyOffsets(...state.selection);
    } else {
      this.#savedOffsets = state.selection;
      this.#savedRange = null;
    }
    this.#updateEmptyState();
    this.#emitInput(from === "undo" ? "historyUndo" : "historyRedo");
  }

  // -- selection ------------------------------------------------------------

  #currentRange() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) {
      return null;
    }
    const range = selection.getRangeAt(0);
    return this.contains(range.startContainer) && this.contains(range.endContainer) ? range : null;
  }

  #selectionOffsets() {
    const range = this.#currentRange() ??
      (this.#savedRange && this.contains(this.#savedRange.startContainer) ? this.#savedRange : null);
    const length = this.value.length;
    if (range) {
      const { pieces } = serializeEditor(this);
      return [
        this.#offsetFromPoint(range.startContainer, range.startOffset, pieces),
        this.#offsetFromPoint(range.endContainer, range.endOffset, pieces)
      ];
    }
    if (this.#savedOffsets) {
      return this.#savedOffsets.map((offset) => Math.min(offset, length));
    }
    return [length, length];
  }

  #restoreSavedSelection() {
    const selection = window.getSelection();
    if (this.#savedRange && this.contains(this.#savedRange.startContainer)) {
      selection?.removeAllRanges();
      selection?.addRange(this.#savedRange);
      return;
    }
    const length = this.value.length;
    const [start, end] = this.#savedOffsets ?? [length, length];
    this.#applyOffsets(start, end);
  }

  #closestBlock(node) {
    let element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (element && element !== this) {
      if (TEXT_BLOCK_TAGS.has(element.tagName) || ["BLOCKQUOTE", "TD", "TH"].includes(element.tagName)) {
        return element;
      }
      element = element.parentElement;
    }
    return this;
  }

  #closestCell(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const cell = element?.closest("td, th");
    return cell && this.contains(cell) ? cell : null;
  }

  #offsetFromPoint(container, offset, pieces) {
    for (const piece of pieces) {
      if (piece.node === container && offset >= piece.offset && offset <= pieceEndOffset(piece)) {
        return piece.start + offset - piece.offset;
      }
    }
    let before = null;
    let after = null;
    for (const piece of pieces) {
      if (comparePoints(piece.node, pieceEndOffset(piece), container, offset) <= 0) {
        before = piece;
      } else if (!after && comparePoints(piece.node, piece.offset, container, offset) >= 0) {
        after = piece;
      }
    }
    const block = this.#closestBlock(container);
    if (before && (this.#closestBlock(before.node) === block || !after)) {
      return before.start + before.text.length;
    }
    return after ? after.start : 0;
  }

  #pointFromOffset(offset, pieces, value) {
    const line = value.slice(0, offset).split("\n").length - 1;
    let best = null;
    let bestDistance = Infinity;
    for (const piece of pieces) {
      const end = piece.start + piece.text.length;
      if (offset >= piece.start && offset <= end) {
        return piece.node.nodeType === Node.TEXT_NODE
          ? [piece.node, Math.min(piece.offset + offset - piece.start, pieceEndOffset(piece))]
          : [piece.node, piece.offset];
      }
      const distance = (piece.line === line ? 0 : 1e9) +
        (offset < piece.start ? piece.start - offset : offset - end);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = [piece.node, offset < piece.start ? piece.offset : pieceEndOffset(piece)];
      }
    }
    return best ?? [this, 0];
  }

  #applyOffsets(start, end) {
    const { text, pieces } = serializeEditor(this);
    const [startNode, startOffset] = this.#pointFromOffset(Math.min(start, text.length), pieces, text);
    const [endNode, endOffset] = this.#pointFromOffset(Math.min(end, text.length), pieces, text);
    window.getSelection()?.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
    this.#savedOffsets = null;
  }

  #setCaret(node, offset) {
    window.getSelection()?.collapse(node, offset);
  }

  #withPreservedSelection(callback, fallback) {
    const selection = window.getSelection();
    const saved = this.#currentRange()
      ? [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]
      : null;
    callback();
    if (!saved) {
      return;
    }
    if (this.contains(saved[0]) && this.contains(saved[2])) {
      try {
        const clamp = (node, offset) => Math.min(offset, node.nodeType === Node.TEXT_NODE ? node.data.length : node.childNodes.length);
        selection.setBaseAndExtent(saved[0], clamp(saved[0], saved[1]), saved[2], clamp(saved[2], saved[3]));
        return;
      } catch {
        // Fall through to the fallback position.
      }
    }
    const target = typeof fallback === "function" ? fallback() : fallback;
    if (target?.isConnected) {
      this.#setCaret(...firstTextPosition(target));
    }
  }

  #caretContext() {
    const range = this.#currentRange();
    if (!range || !range.collapsed) {
      return null;
    }
    const block = this.#closestBlock(range.startContainer);
    if (block === this || block.tagName === "BLOCKQUOTE") {
      return null;
    }
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.setStart(range.startContainer, range.startOffset);
    after.setEnd(block, block.childNodes.length);
    const nested = Array.from(block.childNodes).find(isListElement);
    if (nested && after.comparePoint(nested, 0) >= 0) {
      after.setEndBefore(nested);
    }
    return {
      range,
      block,
      textBefore: before.toString().replaceAll(ZERO_WIDTH_SPACE, ""),
      textAfter: after.toString().replaceAll(ZERO_WIDTH_SPACE, ""),
      beforeRange: before
    };
  }

  #isInCode() {
    const range = this.#currentRange();
    if (!range) {
      return false;
    }
    const element = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
    return Boolean(element?.closest("pre, code") && this.contains(element.closest("pre, code")));
  }

  // -- normalization --------------------------------------------------------

  #normalize() {
    const strayNodes = Array.from(this.childNodes).some((node) => !isBlockNode(node));
    const artifacts = this.querySelector("span, font, [style], p > ul, p > ol, p > p, p > pre, p > blockquote");
    const zeroWidth = this.textContent.includes(ZERO_WIDTH_SPACE);
    const emptyBlocks = Array.from(this.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, pre, td, th"))
      .filter((block) => !block.firstChild);
    if (!strayNodes && !artifacts && !zeroWidth && emptyBlocks.length === 0 && this.firstElementChild) {
      return;
    }
    const selection = window.getSelection();
    this.#withPreservedSelection(() => {
      // Browsers add presentational spans and inline styles while editing;
      // the editor's formatting lives in semantic elements only.
      for (const element of this.querySelectorAll("span, font")) {
        const marks = styleMarks(element);
        if (marks.length > 0 && element.textContent) {
          const wrapper = document.createElement(marks[0]);
          let inner = wrapper;
          for (const mark of marks.slice(1)) {
            const child = document.createElement(mark);
            inner.append(child);
            inner = child;
          }
          inner.append(...element.childNodes);
          element.replaceWith(wrapper);
        } else {
          element.replaceWith(...element.childNodes);
        }
      }
      for (const element of this.querySelectorAll("[style]")) {
        element.removeAttribute("style");
      }
      for (const paragraph of this.querySelectorAll("p")) {
        if (Array.from(paragraph.children).some(isBlockNode)) {
          paragraph.replaceWith(...paragraph.childNodes);
        }
      }
      let paragraph = null;
      for (const node of Array.from(this.childNodes)) {
        if (isBlockNode(node)) {
          paragraph = null;
          continue;
        }
        if (isWhitespaceText(node) && (node.data === "" || node.data.includes("\n"))) {
          node.remove();
          continue;
        }
        if (!paragraph) {
          paragraph = document.createElement("p");
          node.before(paragraph);
        }
        paragraph.append(node);
      }
      for (const block of emptyBlocks) {
        block.append(document.createElement("br"));
      }
      if (!this.firstElementChild) {
        this.innerHTML = "<p><br></p>";
      }
    });
    const range = this.#currentRange();
    if (range?.collapsed && range.startContainer === this) {
      const block = this.childNodes[range.startOffset] ?? this.lastElementChild;
      if (block) {
        this.#setCaret(...firstTextPosition(block));
      }
    }
    if (zeroWidth) {
      this.#removeZeroWidthSpaces(selection);
    }
    if (!this.#currentRange() && document.activeElement === this) {
      this.#setCaret(...lastTextPosition(this.lastElementChild));
    }
  }

  #removeZeroWidthSpaces(selection) {
    const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
    const anchor = selection.anchorNode;
    const anchorOffset = selection.anchorOffset;
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data.includes(ZERO_WIDTH_SPACE)) {
        nodes.push(node);
      }
    }
    for (const node of nodes) {
      // Keep the helper only while the caret still sits right after it.
      if (node === anchor && node.data[anchorOffset - 1] === ZERO_WIDTH_SPACE) {
        continue;
      }
      const removedBeforeCaret = node === anchor
        ? node.data.slice(0, anchorOffset).split(ZERO_WIDTH_SPACE).length - 1
        : 0;
      node.data = node.data.replaceAll(ZERO_WIDTH_SPACE, "");
      if (node === anchor) {
        this.#setCaret(node, Math.max(0, Math.min(anchorOffset - removedBeforeCaret, node.data.length)));
      } else if (node.data === "") {
        const parent = node.parentNode;
        node.remove();
        if (parent && parent !== this && TEXT_BLOCK_TAGS.has(parent.tagName)) {
          fillEmptyBlock(parent);
        }
      }
    }
  }

  // -- events ---------------------------------------------------------------

  #handleBeforeInput(event) {
    if (this.disabled) {
      return;
    }
    switch (event.inputType) {
      case "historyUndo":
        event.preventDefault();
        this.undo();
        return;
      case "historyRedo":
        event.preventDefault();
        this.redo();
        return;
      case "insertParagraph":
      case "insertLineBreak":
        event.preventDefault();
        this.#insertNewline();
        return;
      case "insertText":
      case "insertCompositionText":
        this.#checkpoint("typing");
        return;
      case "deleteContentBackward":
      case "deleteContentForward":
        this.#checkpoint("delete");
        return;
      default:
        this.#checkpoint();
    }
  }

  #handleInput(event) {
    if (this.#applyingRule || event.isComposing) {
      return;
    }
    this.#normalize();
    if (event.inputType === "insertText" && event.data) {
      this.#applyingRule = true;
      try {
        if (event.data === " " || event.data === "\u00a0") {
          this.#applyBlockRule();
        }
        this.#applyInlineRule(event.data);
      } finally {
        this.#applyingRule = false;
      }
    }
    this.#updateEmptyState();
  }

  #handleKeydown(event) {
    if (this.disabled || event.isComposing) {
      return;
    }
    const modifier = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (modifier && !event.altKey && key === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
      return;
    }
    if (modifier && !event.altKey && key === "y") {
      event.preventDefault();
      this.redo();
      return;
    }
    if (modifier && !event.altKey && !event.shiftKey && (key === "b" || key === "i")) {
      event.preventDefault();
      if (!this.#isInCode()) {
        this.#checkpoint();
        document.execCommand(key === "b" ? "bold" : "italic");
      }
      return;
    }
    if (modifier && !event.altKey && key === "u") {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && event.shiftKey && !modifier) {
      event.preventDefault();
      this.#insertNewline();
      return;
    }
    if (event.key === "Tab" && !modifier && !event.altKey) {
      const block = this.#selectionBlock();
      if (block?.tagName === "LI") {
        event.preventDefault();
        this.#mutate(() => event.shiftKey ? this.#outdentItem(block) : this.#indentItem(block));
      }
      return;
    }
    if (event.key === "Backspace" && !modifier && !event.altKey) {
      const context = this.#caretContext();
      if (context && context.textBefore === "" && this.#canLift(context.block)) {
        event.preventDefault();
        this.#mutate(() => this.#liftBlock(context.block));
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      this.#ensureTrailingParagraph();
    }
  }

  #mutate(callback, inputType = "formatBlock") {
    this.#checkpoint();
    callback();
    this.#updateEmptyState();
    this.#emitInput(inputType);
  }

  #selectionBlock() {
    const range = this.#currentRange();
    return range ? this.#closestBlock(range.startContainer) : null;
  }

  // -- block structure ------------------------------------------------------

  #splitBlock(block, container, offset) {
    const range = document.createRange();
    range.setStart(container, offset);
    range.setEnd(block, block.childNodes.length);
    const fragment = range.extractContents();
    const rest = document.createElement(block.tagName.toLowerCase());
    rest.append(fragment);
    for (const node of Array.from(rest.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && node.data === "") {
        node.remove();
      }
    }
    for (const node of Array.from(block.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && node.data === "") {
        node.remove();
      }
    }
    fillEmptyBlock(block);
    fillEmptyBlock(rest);
    block.after(rest);
    return rest;
  }

  #insertNewline() {
    const range = this.#currentRange();
    if (!range) {
      return;
    }
    const cell = this.#closestCell(range.startContainer);
    if (cell) {
      this.#checkpoint();
      this.#exitTable(cell.closest("table"));
      this.#emitInput("insertParagraph");
      return;
    }
    if (range.collapsed && this.#applyBlockRule(true)) {
      return;
    }
    this.#checkpoint();
    if (!range.collapsed) {
      range.deleteContents();
    }
    const block = this.#selectionBlock();
    if (!block || block === this || block.tagName === "BLOCKQUOTE") {
      const paragraph = document.createElement("p");
      paragraph.append(document.createElement("br"));
      (block === this ? this : block).append(paragraph);
      this.#setCaret(paragraph, 0);
      this.#emitInput("insertParagraph");
      return;
    }
    if (block.tagName === "PRE") {
      this.#insertCodeNewline(block);
      this.#emitInput("insertLineBreak");
      return;
    }
    const empty = visibleText(block).trim() === "" && !Array.from(block.childNodes).some(isListElement);
    if (empty && (block.tagName === "LI" || block.parentElement?.tagName === "BLOCKQUOTE")) {
      this.#liftBlock(block);
      this.#updateEmptyState();
      this.#emitInput("insertParagraph");
      return;
    }
    const current = this.#currentRange();
    let rest = this.#splitBlock(block, current.startContainer, current.startOffset);
    if (/^H[1-6]$/.test(block.tagName) && visibleText(rest) === "") {
      rest = renameElement(rest, "p");
    }
    this.#setCaret(...firstTextPosition(rest));
    this.#updateEmptyState();
    this.#emitInput("insertParagraph");
  }

  #insertCodeNewline(pre) {
    const context = this.#caretContext();
    const text = visibleText(pre);
    // Pressing Shift+Enter on a trailing empty line leaves the code block.
    if (context && context.textAfter.replace(/\n$/, "") === "" && /\n\n$|\n$/.test(context.textBefore) &&
      text.replace(/\n$/, "").endsWith("\n")) {
      this.#exitCodeBlock(pre);
      return;
    }
    const range = this.#currentRange();
    const node = document.createTextNode(context && context.textAfter === "" && !text.endsWith("\n") ? "\n\n" : "\n");
    range.insertNode(node);
    for (const br of pre.querySelectorAll("br")) {
      br.remove();
    }
    this.#setCaret(node, 1);
    pre.normalize();
  }

  #exitCodeBlock(pre) {
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      last = node;
    }
    if (last) {
      last.data = last.data.replace(/\n+$/, "");
    }
    for (const br of pre.querySelectorAll("br")) {
      br.remove();
    }
    fillEmptyBlock(pre);
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    pre.after(paragraph);
    this.#setCaret(paragraph, 0);
  }

  #exitTable(table) {
    let paragraph = table.nextElementSibling;
    if (!isElement(paragraph, "P") || visibleText(paragraph) !== "") {
      paragraph = document.createElement("p");
      paragraph.append(document.createElement("br"));
      table.after(paragraph);
    }
    this.#setCaret(paragraph, 0);
  }

  #canLift(block) {
    return /^H[1-6]$/.test(block.tagName) ||
      block.tagName === "PRE" ||
      block.tagName === "LI" ||
      block.parentElement?.tagName === "BLOCKQUOTE";
  }

  #liftBlock(block) {
    if (/^H[1-6]$/.test(block.tagName) || block.tagName === "PRE") {
      const fallback = renameElement(block, "p");
      this.#setCaret(...firstTextPosition(fallback));
      return;
    }
    if (block.tagName === "LI") {
      this.#outdentItem(block);
      return;
    }
    const quote = block.parentElement;
    if (quote?.tagName !== "BLOCKQUOTE") {
      return;
    }
    this.#withPreservedSelection(() => {
      const following = [];
      for (let node = block.nextSibling; node; node = node.nextSibling) {
        following.push(node);
      }
      if (following.length > 0) {
        const tail = quote.cloneNode(false);
        tail.append(...following);
        quote.after(tail);
      }
      quote.after(block);
      if (!quote.firstChild) {
        quote.remove();
      }
    }, block);
  }

  #indentItem(item) {
    const previous = item.previousElementSibling;
    if (previous?.tagName !== "LI") {
      return;
    }
    this.#withPreservedSelection(() => {
      let nested = previous.lastElementChild;
      if (!isListElement(nested)) {
        nested = document.createElement(item.parentElement.tagName.toLowerCase());
        if (item.parentElement.dataset.marker) {
          nested.dataset.marker = item.parentElement.dataset.marker;
        }
        previous.append(nested);
      }
      nested.append(item);
    }, item);
  }

  #outdentItem(item) {
    const list = item.parentElement;
    if (!isListElement(list)) {
      return;
    }
    const following = [];
    for (let node = item.nextSibling; node; node = node.nextSibling) {
      following.push(node);
    }
    const parentItem = list.parentElement?.tagName === "LI" ? list.parentElement : null;
    let fallback = item;
    this.#withPreservedSelection(() => {
      if (parentItem) {
        if (following.length > 0) {
          const sublist = list.cloneNode(false);
          sublist.append(...following);
          item.append(sublist);
        }
        parentItem.after(item);
        if (!list.firstElementChild) {
          list.remove();
        }
        return;
      }
      if (following.length > 0) {
        const tail = list.cloneNode(false);
        if (list.tagName === "OL") {
          const start = Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1;
          const index = Array.from(list.children).indexOf(item);
          tail.setAttribute("start", String(start + index + 1));
        }
        tail.append(...following);
        list.after(tail);
      }
      const paragraph = document.createElement("p");
      const nestedLists = [];
      for (const node of Array.from(item.childNodes)) {
        if (isListElement(node)) {
          nestedLists.push(node);
        } else {
          paragraph.append(node);
        }
      }
      fillEmptyBlock(paragraph);
      list.after(paragraph, ...nestedLists);
      item.remove();
      if (!list.firstElementChild) {
        list.remove();
      }
      fallback = paragraph;
    }, () => fallback);
  }

  #ensureTrailingParagraph() {
    const last = this.lastElementChild;
    if (!last || !["PRE", "BLOCKQUOTE", "UL", "OL", "TABLE"].includes(last.tagName)) {
      return;
    }
    const range = this.#currentRange();
    if (!range || !last.contains(range.endContainer)) {
      return;
    }
    const after = document.createRange();
    after.setStart(range.endContainer, range.endOffset);
    after.setEnd(last, last.childNodes.length);
    if (after.toString().replaceAll(ZERO_WIDTH_SPACE, "").replace(/\n$/, "") !== "") {
      return;
    }
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    last.after(paragraph);
  }

  // -- input rules ------------------------------------------------------------

  #applyBlockRule(fenceOnNewline = false) {
    const context = this.#caretContext();
    if (!context || !["P", "DIV"].includes(context.block.tagName)) {
      return;
    }
    const parent = context.block.parentElement;
    if (parent !== this && parent?.tagName !== "BLOCKQUOTE") {
      return;
    }
    let marker = context.textBefore.replace(/\u00a0/g, " ");
    if (fenceOnNewline) {
      if (!/^(```|~~~)[\w+-]*$/.test(marker) || context.textAfter !== "") {
        return false;
      }
      marker += " ";
    }
    let convert = null;
    let match;
    if (/^[-*+] $/.test(marker)) {
      const bullet = marker[0];
      convert = (block) => this.#wrapInList(block, "ul", bullet === "-" ? null : bullet);
    } else if ((match = marker.match(/^(\d{1,9})([.)]) $/))) {
      const start = Number(match[1]);
      const delimiter = match[2];
      convert = (block) => this.#wrapInList(block, "ol", null, start, delimiter);
    } else if ((match = marker.match(/^(#{1,6}) $/))) {
      const level = match[1].length;
      convert = (block) => renameElement(block, `h${level}`);
    } else if (marker === "> ") {
      convert = (block) => {
        const quote = document.createElement("blockquote");
        block.replaceWith(quote);
        quote.append(block);
        return block;
      };
    } else if ((match = marker.match(/^(```|~~~)([\w+-]*) $/))) {
      const language = match[2];
      const fence = match[1];
      convert = (block) => {
        const pre = renameElement(block, "pre");
        if (language) {
          pre.dataset.language = language;
        }
        if (fence !== "```") {
          pre.dataset.fence = fence;
        }
        return pre;
      };
    }
    if (!convert) {
      return;
    }
    this.#checkpoint("rule");
    context.beforeRange.deleteContents();
    let block = context.block;
    for (const node of Array.from(block.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && node.data === "") {
        node.remove();
      }
    }
    fillEmptyBlock(block);
    block = convert(block);
    this.#setCaret(...firstTextPosition(block));
    this.#emitInput("formatBlock");
    return true;
  }

  #wrapInList(block, tagName, bullet, start = 1, delimiter = ".") {
    const item = renameElement(block, "li");
    const previous = item.previousElementSibling;
    const sameList = previous?.tagName === tagName.toUpperCase() &&
      (previous.dataset.marker ?? null) === bullet &&
      (tagName === "ul" || start === serializeList(previous).length + (Number.parseInt(previous.getAttribute("start") ?? "1", 10) || 1));
    if (sameList) {
      previous.append(item);
      return item;
    }
    const list = document.createElement(tagName);
    if (bullet) {
      list.dataset.marker = bullet;
    }
    if (tagName === "ol" && start !== 1) {
      list.setAttribute("start", String(start));
    }
    if (tagName === "ol" && delimiter !== ".") {
      list.dataset.delimiter = delimiter;
    }
    item.replaceWith(list);
    list.append(item);
    return item;
  }

  #applyInlineRule(data) {
    const context = this.#caretContext();
    if (!context || context.block.tagName === "PRE") {
      return;
    }
    const { range } = context;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || node.parentElement?.closest("code")) {
      return;
    }
    const before = node.data.slice(0, range.startOffset);
    if (!before.endsWith(data.at(-1))) {
      return;
    }
    for (const rule of INLINE_RULES) {
      const match = before.match(rule.pattern);
      if (!match) {
        continue;
      }
      this.#checkpoint("rule");
      const start = range.startOffset - match[0].length;
      const rest = node.splitText(range.startOffset);
      node.data = node.data.slice(0, start);
      const element = document.createElement(rule.tag);
      element.textContent = match[1];
      if (rule.delimiter) {
        element.dataset.md = rule.delimiter;
      }
      rest.before(element);
      // Keep typing outside the new formatting by placing the caret after a
      // zero-width helper that is removed as soon as text is typed.
      rest.data = ZERO_WIDTH_SPACE + rest.data;
      if (node.data === "") {
        node.remove();
      }
      this.#setCaret(rest, 1);
      this.#emitInput("formatBold");
      return;
    }
  }

  // -- paste ------------------------------------------------------------------

  #handlePaste(event) {
    const data = event.clipboardData;
    if (!data || this.disabled) {
      return;
    }
    const types = Array.from(data.types ?? []);
    if (types.includes("Files") || (data.files?.length ?? 0) > 0) {
      return;
    }
    const text = data.getData("text/plain");
    const html = data.getData("text/html");
    if (!text && !html) {
      return;
    }
    event.preventDefault();
    this.insertClipboard({ html, text, vscode: types.includes("vscode-editor-data") });
  }

  #deleteSelection(range) {
    if (range.collapsed) {
      return;
    }
    const before = document.createRange();
    before.selectNodeContents(this);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.selectNodeContents(this);
    after.setStart(range.endContainer, range.endOffset);
    if (before.toString() === "" && after.toString() === "") {
      this.innerHTML = "<p><br></p>";
      this.#setCaret(this.firstElementChild, 0);
      return;
    }
    const startBlock = this.#closestBlock(range.startContainer);
    const endBlock = this.#closestBlock(range.endContainer);
    range.deleteContents();
    if (startBlock !== endBlock && startBlock !== this && endBlock !== this && endBlock.isConnected &&
      TEXT_BLOCK_TAGS.has(startBlock.tagName) && TEXT_BLOCK_TAGS.has(endBlock.tagName)) {
      for (const br of startBlock.querySelectorAll(":scope > br")) {
        if (!hasFollowingContent(br, startBlock)) {
          br.remove();
        }
      }
      const caret = lastTextPosition(startBlock);
      startBlock.append(...endBlock.childNodes);
      let parent = endBlock.parentElement;
      endBlock.remove();
      while (parent && parent !== this && !parent.firstElementChild && visibleText(parent) === "") {
        const next = parent.parentElement;
        parent.remove();
        parent = next;
      }
      this.#setCaret(...caret);
    }
    const block = this.#closestBlock(range.startContainer);
    if (block !== this) {
      fillEmptyBlock(block);
    }
  }

  #insertPlainText(text) {
    const range = this.#currentRange();
    if (!range) {
      return;
    }
    this.#checkpoint();
    this.#deleteSelection(range);
    const caret = this.#currentRange();
    const node = document.createTextNode(text.replace(/\r\n?/g, "\n"));
    caret.insertNode(node);
    const pre = node.parentElement?.closest("pre");
    if (pre && node.data.endsWith("\n") && !node.nextSibling) {
      node.data += "\n";
      this.#setCaret(node, node.data.length - 1);
    } else {
      this.#setCaret(node, node.data.length);
    }
    for (const br of Array.from(node.parentElement?.querySelectorAll(":scope > br") ?? [])) {
      if (!hasFollowingContent(br, node.parentElement) && br.previousSibling) {
        br.remove();
      }
    }
    this.#updateEmptyState();
    this.#emitInput("insertFromPaste");
  }

  #insertHtml(html) {
    let range = this.#currentRange();
    if (!range) {
      this.focus();
      range = this.#currentRange();
      if (!range) {
        return;
      }
    }
    this.#checkpoint();
    this.#deleteSelection(range);
    range = this.#currentRange();
    const template = document.createElement("template");
    template.innerHTML = html;
    let nodes = Array.from(template.content.childNodes);
    if (this.#closestCell(range.startContainer) && nodes.some(isBlockNode)) {
      nodes = [document.createTextNode(flattenedText(template.content))];
    }
    const single = nodes.length === 1 && isElement(nodes[0], "P");
    if (single || !nodes.some(isBlockNode)) {
      const fragment = document.createDocumentFragment();
      fragment.append(...(single ? nodes[0].childNodes : nodes));
      const last = fragment.lastChild;
      if (isElement(last, "BR") && single) {
        last.remove();
      }
      const inserted = fragment.lastChild;
      range.insertNode(fragment);
      this.#removeTrailingPlaceholder(range.startContainer);
      if (inserted) {
        const [node, offset] = inserted.nodeType === Node.TEXT_NODE
          ? [inserted, inserted.data.length]
          : [inserted.parentNode, Array.prototype.indexOf.call(inserted.parentNode.childNodes, inserted) + 1];
        this.#setCaret(node, offset);
      }
    } else {
      this.#insertBlocks(nodes);
    }
    this.#normalize();
    this.#updateEmptyState();
    this.#emitInput("insertFromPaste");
  }

  #removeTrailingPlaceholder(node) {
    const block = this.#closestBlock(node);
    if (block === this) {
      return;
    }
    for (const br of block.querySelectorAll(":scope > br")) {
      if (!hasFollowingContent(br, block) && visibleText(block) !== "") {
        br.remove();
      }
    }
  }

  #insertBlocks(nodes) {
    let range = this.#currentRange();
    let block = this.#closestBlock(range.startContainer);
    if (block === this || block.tagName === "BLOCKQUOTE") {
      const paragraph = document.createElement("p");
      range.insertNode(paragraph);
      block = paragraph;
      range = document.createRange();
      range.setStart(paragraph, 0);
    }
    const tail = this.#splitBlock(block, range.startContainer, range.startOffset);
    const blockEmpty = visibleText(block) === "" && !Array.from(block.childNodes).some(isListElement);
    const tailEmpty = visibleText(tail) === "" && !Array.from(tail.childNodes).some(isListElement);
    const inList = block.tagName === "LI";
    const pasted = inList ? this.#blocksToListItems(nodes) : nodes;
    let current = block;
    let first = true;
    let merged = false;
    let lastInserted = block;
    for (const node of pasted) {
      const mergeable = TEXT_BLOCK_TAGS.has(node.tagName) && !["PRE"].includes(node.tagName) &&
        (inList ? node.tagName === "LI" : node.tagName === "P");
      if (first && mergeable && !(inList && Array.from(node.childNodes).some(isListElement))) {
        this.#appendInline(block, node);
        lastInserted = block;
        first = false;
        merged = true;
        continue;
      }
      first = false;
      current.after(node);
      current = node;
      lastInserted = node;
    }
    if (blockEmpty && !merged && block.isConnected) {
      block.remove();
    }
    // Typing continues below a pasted table rather than in its last cell.
    const endsWithTable = isElement(lastInserted, "TABLE");
    const caret = endsWithTable ? firstTextPosition(tail) : lastTextPosition(lastInserted);
    const tailMergeable = !tailEmpty && TEXT_BLOCK_TAGS.has(lastInserted.tagName) && lastInserted.tagName !== "PRE" &&
      !Array.from(lastInserted.childNodes).some(isListElement) &&
      (inList || !/^H[1-6]$/.test(lastInserted.tagName));
    if (tailMergeable) {
      this.#appendInline(lastInserted, tail);
      tail.remove();
    } else if (tailEmpty && !endsWithTable) {
      tail.remove();
    } else if (lastInserted !== block) {
      lastInserted.after(tail);
    }
    if (caret[0].isConnected) {
      this.#setCaret(...caret);
    }
  }

  #appendInline(target, source) {
    for (const br of Array.from(target.querySelectorAll(":scope > br"))) {
      if (!hasFollowingContent(br, target)) {
        br.remove();
      }
    }
    const nested = Array.from(target.childNodes).find(isListElement);
    const nodes = Array.from(source.childNodes).filter((node) =>
      !(isElement(node, "BR") && !hasFollowingContent(node, source) && visibleText(source) !== ""));
    if (nested) {
      nested.before(...nodes);
    } else {
      target.append(...nodes);
    }
    fillEmptyBlock(target);
  }

  #blocksToListItems(nodes) {
    const items = [];
    for (const node of nodes) {
      if (isListElement(node)) {
        items.push(...Array.from(node.children).filter((child) => child.tagName === "LI"));
        continue;
      }
      if (!isElement(node)) {
        continue;
      }
      if (node.tagName === "P" && visibleText(node).trim() === "") {
        continue;
      }
      const item = document.createElement("li");
      if (node.tagName === "TABLE") {
        item.textContent = flattenedText(node);
      } else if (node.tagName === "PRE" || node.tagName === "BLOCKQUOTE") {
        item.textContent = node.textContent;
      } else {
        item.append(...node.childNodes);
      }
      fillEmptyBlock(item);
      items.push(item);
    }
    return items;
  }
}

if (!customElements.get("prompt-editor")) {
  customElements.define("prompt-editor", PromptEditor);
}
