// Renderizador de markdown mínimo. Cada linha do fonte vira um bloco com data-i,
// o que permite marcar/desmarcar checkboxes editando só aquela linha do arquivo.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(raw) {
  let s = esc(raw);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => `<span class="wl" data-t="${t.replace(/"/g, '&quot;')}">${a || t}</span>`);
  s = s.replace(/(^|\s)#([\p{L}\d_/-]*[\p{L}_/-][\p{L}\d_/-]*)/gu, '$1<span class="tag">#$2</span>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-ext>$1</a>');
  return s;
}

const depth = (ws) => Math.floor(ws.replace(/\t/g, '  ').length / 2);

// ---- tabelas (| a | b |) --------------------------------------------------

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const CELL_SPLIT = /(?<!\\)\|/;

// "| a | b |" -> ['a', 'b']  (barras escapadas com \| ficam dentro da célula)
function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return t.split(CELL_SPLIT).map((c) => c.trim());
}
const isSeparatorRow = (line) => TABLE_ROW.test(line) && splitRow(line).every((c) => /^:?-+:?$/.test(c));
const startsTable = (lines, i) =>
  TABLE_ROW.test(lines[i]) && i + 1 < lines.length && isSeparatorRow(lines[i + 1]) &&
  splitRow(lines[i]).length === splitRow(lines[i + 1]).length;

function renderTable(rows) {
  const head = splitRow(rows[0]);
  const align = splitRow(rows[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c.replace(/\\\|/g, '|'))}</${tag}>`;
  const body = rows.slice(2).map((r) => {
    const cells = splitRow(r);
    return `<tr>${head.map((_, k) => cell('td', cells[k] || '', k)).join('')}</tr>`;
  }).join('');
  return `<table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderMarkdown(body) {
  const out = [];
  const lines = body.split('\n').map((l) => l.replace(/\r$/, ''));
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m;
    if (/^\s*```/.test(ln)) { fence = !fence; out.push(`<div class="l fm" data-i="${i}"></div>`); continue; }
    if (fence) { out.push(`<div class="l code" data-i="${i}">${esc(ln) || '&nbsp;'}</div>`); continue; }
    if (startsTable(lines, i)) {
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j])) j++;
      out.push(`<div class="l tw" data-i="${i}">${renderTable(lines.slice(i, j))}</div>`);
      i = j - 1;
      continue;
    }
    if (!ln.trim()) { out.push(`<div class="l sp" data-i="${i}"></div>`); continue; }
    if ((m = ln.match(/^(#{1,6})\s+(.*)$/))) {
      out.push(`<div class="l h h${m[1].length}" data-i="${i}">${inline(m[2])}</div>`); continue;
    }
    if ((m = ln.match(/^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/))) {
      const done = m[2] !== ' ';
      out.push(`<div class="l task${done ? ' done' : ''}" style="--d:${depth(m[1])}" data-i="${i}"><span class="cb" role="checkbox" aria-checked="${done}"></span><span>${inline(m[3])}</span></div>`);
      continue;
    }
    if ((m = ln.match(/^(\s*)[-*+]\s+(.*)$/))) {
      out.push(`<div class="l li" style="--d:${depth(m[1])}" data-i="${i}"><span class="bl">•</span><span>${inline(m[2])}</span></div>`); continue;
    }
    if ((m = ln.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) {
      out.push(`<div class="l li" style="--d:${depth(m[1])}" data-i="${i}"><span class="bl">${m[2]}.</span><span>${inline(m[3])}</span></div>`); continue;
    }
    if ((m = ln.match(/^>\s?(.*)$/))) { out.push(`<div class="l quote" data-i="${i}">${inline(m[1])}</div>`); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) { out.push(`<div class="l hr" data-i="${i}"></div>`); continue; }
    out.push(`<div class="l" data-i="${i}">${inline(ln)}</div>`);
  }
  return out.join('');
}

// Separa o frontmatter YAML do corpo, preservando o texto original do frontmatter.
function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? { fm: m[0], body: text.slice(m[0].length) } : { fm: '', body: text };
}

function frontmatterGet(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

function frontmatterSet(fm, key, value) {
  if (!fm) return `---\n${key}: ${value}\n---\n`;
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(fm)) return fm.replace(re, `${key}: ${value}`);
  return fm.replace(/\r?\n---[ \t]*(\r?\n|$)/, (end) => `\n${key}: ${value}${end}`);
}
