// Comportamentos de escrita de editor de notas sobre um <textarea>.
// As alterações passam por execCommand('insertText') para manter o desfazer (Ctrl+Z) nativo.

const FORMAT_BUTTONS = [
  ['h', 'H', 'Título (Ctrl+1/2/3)'],
  ['b', '<b>B</b>', 'Negrito (Ctrl+B)'],
  ['i', '<i>I</i>', 'Itálico (Ctrl+I)'],
  ['s', '<s>S</s>', 'Riscado (Ctrl+Shift+X)'],
  ['hl', '▮', 'Destaque (Ctrl+Shift+H)'],
  ['code', '&lt;/&gt;', 'Código (Ctrl+E)'],
  ['ul', '•', 'Lista'],
  ['task', '☐', 'Tarefa (Ctrl+L)'],
  ['quote', '❝', 'Citação'],
  ['link', '↗', 'Link (Ctrl+K)'],
  ['wiki', '[[ ]]', 'Link para nota'],
  ['table', '▦', 'Tabela'],
];

// botões extras, visíveis só quando o cursor está dentro de uma tabela
const TABLE_BUTTONS = [
  ['addrow', '+ linha', 'Adicionar linha abaixo'],
  ['addcol', '+ coluna', 'Adicionar coluna à direita'],
  ['delrow', '− linha', 'Remover esta linha'],
  ['delcol', '− coluna', 'Remover esta coluna'],
];

const LIST_MARK = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/;

function createEditing(ta) {
  const sel = () => [ta.selectionStart, ta.selectionEnd];

  const insert = (text) => {
    ta.focus();
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  };
  const replaceRange = (start, end, text, selStart, selEnd) => {
    ta.setSelectionRange(start, end);
    insert(text);
    ta.setSelectionRange(selStart, selEnd);
  };

  // início e fim do bloco de linhas tocado pela seleção
  const lineBounds = () => {
    const v = ta.value, [s, e] = sel();
    const start = v.lastIndexOf('\n', s - 1) + 1;
    const from = e > s && v[e - 1] === '\n' ? e - 1 : e;
    let end = v.indexOf('\n', from);
    if (end < 0) end = v.length;
    return { start, end };
  };

  const mapLines = (fn) => {
    const { start, end } = lineBounds();
    const [s, e] = sel();
    const block = ta.value.slice(start, end);
    const out = block.split('\n').map(fn).join('\n');
    if (out === block) return;
    const delta = out.length - block.length;
    if (s === e) replaceRange(start, end, out, Math.max(start, s + delta), Math.max(start, s + delta));
    else replaceRange(start, end, out, start, start + out.length);
  };

  const wrap = (before, after = before) => {
    const v = ta.value, [s, e] = sel();
    const chosen = v.slice(s, e);
    // já envolvido por fora: desfaz
    if (s >= before.length && v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
      replaceRange(s - before.length, e + after.length, chosen, s - before.length, s - before.length + chosen.length);
      return;
    }
    // seleção inclui os marcadores: desfaz
    if (chosen.length >= before.length + after.length && chosen.startsWith(before) && chosen.endsWith(after)) {
      const inner = chosen.slice(before.length, chosen.length - after.length);
      replaceRange(s, e, inner, s, s + inner.length);
      return;
    }
    replaceRange(s, e, before + chosen + after, s + before.length, s + before.length + chosen.length);
  };

  const strip = (l) => l.replace(LIST_MARK, '$1');

  const setHeading = (n) => mapLines((l) => {
    const cur = (l.match(/^(#{1,6}) /) || [''])[0].length - 1;
    const base = l.replace(/^#{1,6} /, '');
    return cur === n ? base : `${'#'.repeat(n)} ${base}`;
  });
  const cycleHeading = () => mapLines((l) => {
    const n = (l.match(/^(#{1,6}) /) || [''])[0].length - 1;
    const base = l.replace(/^#{1,6} /, '');
    return n >= 3 ? base : `${'#'.repeat(n + 1)} ${base}`;
  });

  const toggleBullet = () => mapLines((l) => {
    if (/^\s*[-*+]\s+(?!\[[ xX]\])/.test(l)) return strip(l);
    const lead = (l.match(/^\s*/) || [''])[0];
    return `${lead}- ${strip(l).slice(lead.length)}`;
  });
  const toggleTask = () => mapLines((l) => {
    if (/^\s*[-*+]\s+\[[ xX]\]\s/.test(l)) return strip(l);
    if (/^\s*[-*+]\s+/.test(l)) return l.replace(/^(\s*[-*+]\s+)/, '$1[ ] ');
    const indent = (l.match(/^\s*/) || [''])[0];
    return `${indent}- [ ] ${l.slice(indent.length)}`;
  });
  const toggleQuote = () => mapLines((l) => (/^>\s?/.test(l) ? l.replace(/^>\s?/, '') : `> ${l}`));

  const link = () => {
    const [s, e] = sel();
    const chosen = ta.value.slice(s, e) || 'texto';
    const text = `[${chosen}](url)`;
    const urlStart = s + chosen.length + 3;
    replaceRange(s, e, text, urlStart, urlStart + 3);
  };

  // Enter dentro de lista/citação continua o marcador; em item vazio, encerra a lista.
  const continueList = () => {
    const [s, e] = sel();
    if (s !== e) return false;
    const v = ta.value;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    const before = v.slice(ls, s);
    const m = before.match(/^(\s*)(?:([-*+])|(\d+)([.)])|(>))\s+(\[[ xX]\]\s+)?(.*)$/);
    if (!m) return false;
    const [, indent, bullet, num, sep, quote, task, content] = m;
    const lineEnd = v.indexOf('\n', s);
    const rest = v.slice(s, lineEnd < 0 ? v.length : lineEnd);
    if (!content.trim() && !rest.trim()) {
      replaceRange(ls, s, '', ls, ls);
      return true;
    }
    let marker = quote ? `${indent}> ` : num ? `${indent}${Number(num) + 1}${sep} ` : `${indent}${bullet} `;
    if (task) marker += '[ ] ';
    insert(`\n${marker}`);
    return true;
  };

  const indent = (outdent) => {
    const { start, end } = lineBounds();
    const [s, e] = sel();
    const multi = ta.value.slice(start, end).includes('\n') || s !== e;
    const onList = LIST_MARK.test(ta.value.slice(start, end));
    if (!outdent && !multi && !onList) { insert('  '); return; }
    mapLines((l) => (outdent ? l.replace(/^( {1,2}|\t)/, '') : `  ${l}`));
  };

  // ---- tabelas: Tab/Enter entre células, formatação automática, linhas e colunas -------------

  const emptyRow = (n) => `| ${Array(n).fill('').join(' | ')} |`;

  const rowFromPos = (lines, pos) => {
    let acc = 0;
    for (let r = 0; r < lines.length; r++) {
      if (pos <= acc + lines[r].length) return { row: r, off: pos - acc };
      acc += lines[r].length + 1;
    }
    return { row: lines.length - 1, off: 0 };
  };

  // bloco de tabela (cabeçalho + separador + corpo) que contém a linha `row`, ou null
  const blockAt = (lines, row, off = 0) => {
    if (!TABLE_ROW.test(lines[row] || '')) return null;
    let a = row, b = row;
    while (a > 0 && TABLE_ROW.test(lines[a - 1])) a--;
    while (b < lines.length - 1 && TABLE_ROW.test(lines[b + 1])) b++;
    if (!startsTable(lines, a)) return null;
    const start = lines.slice(0, a).reduce((n, l) => n + l.length + 1, 0);
    const rows = lines.slice(a, b + 1);
    const pipes = (lines[row].slice(0, off).match(/(?<!\\)\|/g) || []).length;
    const ncols = splitRow(rows[0]).length;
    return { start, end: start + rows.join('\n').length, rows, rowIdx: row - a, col: Math.min(Math.max(pipes - 1, 0), ncols - 1) };
  };
  const caretBlock = () => {
    const lines = ta.value.split('\n');
    const p = rowFromPos(lines, sel()[0]);
    return blockAt(lines, p.row, p.off);
  };

  // realinha as colunas e preserva o alinhamento (:---, :---:, ---:) do separador
  const formatTable = (rows) => {
    const n = splitRow(rows[0]).length;
    const cells = rows.map((r) => {
      const c = splitRow(r);
      return Array.from({ length: n }, (_, k) => c[k] ?? '');
    });
    const align = cells[1].map((c) => (c.length > 1 && c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : c.startsWith(':') ? 'l' : ''));
    const w = Array.from({ length: n }, (_, k) => Math.max(3, ...cells.map((r, i) => (i === 1 ? 0 : r[k].length))));
    const dashes = (x) => '-'.repeat(Math.max(x, 1));
    const sep = (k) => (align[k] === 'c' ? `:${dashes(w[k] - 2)}:` : align[k] === 'r' ? `${dashes(w[k] - 1)}:` : align[k] === 'l' ? `:${dashes(w[k] - 1)}` : dashes(w[k]));
    const lines = cells.map((r, i) => `| ${r.map((c, k) => (i === 1 ? sep(k) : c.padEnd(w[k]))).join(' | ')} |`);
    return { lines, cells, w };
  };

  // reescreve a tabela formatada e seleciona o conteúdo da célula (r, c), como numa planilha
  const writeTable = (b, f, r, c) => {
    const rowStart = b.start + f.lines.slice(0, r).reduce((n, l) => n + l.length + 1, 0);
    const colOff = 2 + f.w.slice(0, c).reduce((n, x) => n + x + 3, 0);
    const from = rowStart + colOff;
    replaceRange(b.start, b.end, f.lines.join('\n'), from, from + f.cells[r][c].length);
  };

  const inTable = () => Boolean(caretBlock());

  const tableNav = (dir) => {
    const b = caretBlock();
    if (!b) return false;
    const rows = b.rows.slice();
    const n = splitRow(rows[0]).length;
    let r = b.rowIdx, c = b.col;
    if (r === 1) { r = dir > 0 ? 2 : 0; c = dir > 0 ? 0 : n - 1; }
    else if (dir > 0) { c++; if (c >= n) { c = 0; r = r === 0 ? 2 : r + 1; } }
    else { c--; if (c < 0) { c = n - 1; r = r === 2 ? 0 : r - 1; } }
    if (r < 0) { r = 0; c = 0; }
    if (r >= rows.length) rows.push(emptyRow(n));   // Tab na última célula cria uma linha nova
    writeTable(b, formatTable(rows), r, c);
    return true;
  };

  // Enter numa tabela abre uma linha nova; em linha final vazia, sai da tabela.
  const tableEnter = () => {
    const [s, e] = sel();
    if (s !== e) return false;
    const b = caretBlock();
    if (!b) return false;
    const rows = b.rows.slice();
    const n = splitRow(rows[0]).length;
    const isEmpty = (l) => splitRow(l).every((x) => x === '');
    if (b.rowIdx >= 2 && b.rowIdx === rows.length - 1 && isEmpty(rows[b.rowIdx])) {
      rows.pop();
      const text = `${formatTable(rows).lines.join('\n')}\n`;
      replaceRange(b.start, b.end, text, b.start + text.length, b.start + text.length);
      return true;
    }
    const at = Math.max(b.rowIdx, 1) + 1;
    rows.splice(at, 0, emptyRow(n));
    writeTable(b, formatTable(rows), at, 0);
    return true;
  };

  const addRow = () => {
    const b = caretBlock();
    if (!b) return;
    const rows = b.rows.slice();
    const at = Math.max(b.rowIdx, 1) + 1;
    rows.splice(at, 0, emptyRow(splitRow(rows[0]).length));
    writeTable(b, formatTable(rows), at, b.col);
  };
  const delRow = () => {
    const b = caretBlock();
    if (!b || b.rowIdx < 2) return;
    const rows = b.rows.slice();
    rows.splice(b.rowIdx, 1);
    const r = Math.min(b.rowIdx, rows.length - 1);
    writeTable(b, formatTable(rows), r === 1 ? 0 : r, b.col);
  };
  const addCol = () => {
    const b = caretBlock();
    if (!b) return;
    const rows = b.rows.map((l, i) => {
      const c = splitRow(l);
      c.splice(b.col + 1, 0, i === 0 ? 'Coluna' : i === 1 ? '---' : '');
      return `| ${c.join(' | ')} |`;
    });
    writeTable(b, formatTable(rows), b.rowIdx, b.col + 1);
  };
  const delCol = () => {
    const b = caretBlock();
    const n = b ? splitRow(b.rows[0]).length : 0;
    if (!b || n < 2) return;
    const rows = b.rows.map((l) => {
      const c = splitRow(l);
      c.splice(b.col, 1);
      return `| ${c.join(' | ')} |`;
    });
    writeTable(b, formatTable(rows), b.rowIdx, Math.min(b.col, n - 2));
  };

  // clique numa célula da tabela renderizada: abre a edição já com a célula selecionada
  const selectTableCell = (lineIdx, r, c) => {
    const b = blockAt(ta.value.split('\n'), lineIdx, 0);
    if (!b) return;
    const f = formatTable(b.rows);
    writeTable(b, f, r, Math.min(c, f.cells[0].length - 1));
  };

  const insertTable = (rowsN, colsN) => {
    const v = ta.value, [s, e] = sel();
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    const prevLine = ls > 0 ? v.slice(v.lastIndexOf('\n', ls - 2) + 1, ls - 1) : '';
    const prefix = v.slice(ls, s).trim() ? '\n\n' : prevLine.trim() ? '\n' : '';
    const head = Array.from({ length: colsN }, (_, k) => `Coluna ${k + 1}`);
    const rows = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
    for (let i = 0; i < Math.max(rowsN - 1, 1); i++) rows.push(emptyRow(colsN));
    const f = formatTable(rows);
    const start = s + prefix.length;
    replaceRange(s, e, `${prefix}${f.lines.join('\n')}\n`, start + 2, start + 2 + f.cells[0][0].length);
  };

  return {
    wrap, setHeading, cycleHeading, toggleBullet, toggleTask, toggleQuote, link, continueList, indent,
    inTable, tableNav, tableEnter, addRow, delRow, addCol, delCol, selectTableCell, insertTable,
  };
}
