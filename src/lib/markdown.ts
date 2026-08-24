import { isRtl } from "./summary";

const TABLE_SEPARATOR = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

interface ListItem {
  kind: "ul" | "ol";
  html: string;
  task: boolean;
  checked: boolean;
  children: ListItem[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(text: string): string {
  let rendered = escapeHtml(text);
  const protectedHtml: string[] = [];
  const protect = (html: string) => {
    const token = `\uE000${protectedHtml.length}\uE001`;
    protectedHtml.push(html);
    return token;
  };

  rendered = rendered.replace(/`([^`\n]+)`/g, (_match, code: string) =>
    protect(`<code>${code}</code>`),
  );
  rendered = rendered.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (match: string, label: string, href: string) => {
      if (!/^https?:\/\//i.test(href)) return match;
      return protect(
        `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`,
      );
    },
  );
  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  rendered = rendered.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  rendered = rendered.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  rendered = rendered.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<em>$1</em>");

  return rendered.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => {
    return protectedHtml[Number(index)] ?? "";
  });
}

function splitTableRow(line: string): string[] {
  let content = line.trim();
  if (content.startsWith("|")) content = content.slice(1);
  if (content.endsWith("|")) content = content.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === "\\" && content[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseListLine(line: string): {
  level: 0 | 1;
  item: ListItem;
} | null {
  const match = line.match(/^([ \t]*)(?:(-|\*|•)\s+|(\d+)\.\s+)(.*)$/);
  if (!match) return null;

  const indentation = match[1];
  const level = indentation.includes("\t") || indentation.length >= 2 ? 1 : 0;
  const marker = match[2];
  let body = match[4];
  let task = false;
  let checked = false;
  if (marker === "-") {
    const taskMatch = body.match(/^\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      task = true;
      checked = taskMatch[1].toLowerCase() === "x";
      body = taskMatch[2];
    }
  }

  return {
    level,
    item: {
      kind: match[3] ? "ol" : "ul",
      html: renderInline(body.trim()),
      task,
      checked,
      children: [],
    },
  };
}

function renderListItems(items: ListItem[]): string {
  let html = "";
  let openKind: "ul" | "ol" | null = null;
  for (const item of items) {
    if (item.kind !== openKind) {
      if (openKind) html += `</${openKind}>`;
      openKind = item.kind;
      html += `<${openKind}>`;
    }
    const className = item.task ? ' class="md-task"' : "";
    const checkbox = item.task
      ? `<input type="checkbox" disabled${item.checked ? " checked" : ""}> `
      : "";
    html += `<li${className}>${checkbox}${item.html}`;
    if (item.children.length > 0) html += renderListItems(item.children);
    html += "</li>";
  }
  if (openKind) html += `</${openKind}>`;
  return html;
}

function isTableStart(lines: string[], index: number): boolean {
  return (
    lines[index]?.trimStart().startsWith("|") === true &&
    TABLE_SEPARATOR.test(lines[index + 1]?.trim() ?? "")
  );
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const trimmed = line.trim();
  return (
    line.trimStart().startsWith("```") ||
    /^#{1,}\s+/.test(trimmed) ||
    /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed) ||
    /^>\s?/.test(line) ||
    isTableStart(lines, index) ||
    parseListLine(line) !== null
  );
}

/** Render the artifact Markdown subset without allowing source HTML through. */
export function markdownToHtml(markdown: string): string {
  const lines = (markdown ?? "").split(/\r?\n/);
  const parts: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      parts.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      parts.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      parts.push("<hr>");
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      const paragraphs: string[] = [];
      let paragraph: string[] = [];
      const flushParagraph = () => {
        if (paragraph.length > 0) {
          paragraphs.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
          paragraph = [];
        }
      };
      for (const quoteLine of quoteLines) {
        if (quoteLine.trim()) paragraph.push(quoteLine.trim());
        else flushParagraph();
      }
      flushParagraph();
      parts.push(`<blockquote>${paragraphs.join("")}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trimStart().startsWith("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      const headerHtml = headers
        .map((cell) => `<th>${renderInline(cell)}</th>`)
        .join("");
      const bodyHtml = rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell) => `<td>${renderInline(cell)}</td>`)
              .join("")}</tr>`,
        )
        .join("");
      parts.push(
        `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`,
      );
      continue;
    }

    const firstListLine = parseListLine(line);
    if (firstListLine) {
      const roots: ListItem[] = [];
      let lastRoot: ListItem | null = null;
      while (index < lines.length) {
        const parsed = parseListLine(lines[index]);
        if (!parsed) break;
        if (parsed.level === 1 && lastRoot) {
          lastRoot.children.push(parsed.item);
        } else {
          roots.push(parsed.item);
          lastRoot = parsed.item;
        }
        index += 1;
      }
      parts.push(renderListItems(roots));
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      (paragraphLines.length === 0 || !isBlockStart(lines, index))
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    parts.push(`<p>${renderInline(paragraphLines.join(" "))}</p>`);
  }

  const dir = isRtl(markdown) ? ' dir="rtl"' : "";
  return `<div class="md"${dir}>${parts.join("")}</div>`;
}
