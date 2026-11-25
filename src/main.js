const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWin = window.__TAURI__.window.getCurrentWindow();

// Gradientes predefinidos [início, fim]. O padrão é o azul-petróleo escuro do Natx.
const PRESETS = {
  natx: ['#1b2a33', '#0f1a21'],
  aurora: ['#7c3aed', '#06b6d4'],
  sunset: ['#f97316', '#ec4899'],
  ocean: ['#0ea5e9', '#6366f1'],
  forest: ['#10b981', '#065f46'],
  ember: ['#ef4444', '#7f1d1d'],
  candy: ['#f9a8d4', '#c4b5fd'],
  lemon: ['#fde68a', '#fbbf24'],
  mint: ['#a7f3d0', '#67e8f9'],
  mist: ['#e2e8f0', '#94a3b8'],
};
// nomes antigos de cor continuam funcionando
const ALIAS = { yellow: 'lemon', pink: 'candy', blue: 'ocean', green: 'forest', purple: 'aurora', graphite: 'natx', obsidian: 'natx' };

// `color: natx` (predefinido) ou `color: "#7c3aed,#ec4899"` (gradiente personalizado)
function parseColor(value) {
  const v = (value || '').trim();
  if (v.startsWith('#')) {
    const [a, b] = v.split(',').map((s) => s.trim());
    if (/^#[0-9a-f]{6}$/i.test(a) && /^#[0-9a-f]{6}$/i.test(b || a)) return [a, b || a];
  }
  return PRESETS[ALIAS[v] || v] || PRESETS.natx;
}
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};
const RESIZE_DIRS = { n: 'North', s: 'South', e: 'East', w: 'West', ne: 'NorthEast', nw: 'NorthWest', se: 'SouthEast', sw: 'SouthWest' };
const MODES = {
  top: { next: 'desktop', label: 'Sempre no topo', icon: '<path d="M12 17v5M9 3h6l-1 7 3 3v2H7v-2l3-3-1-7z"/>' },
  desktop: { next: 'normal', label: 'Fixada no desktop', icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>' },
  normal: { next: 'top', label: 'Janela normal', icon: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16"/>' },
};

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-ext]');
  if (a) { e.preventDefault(); e.stopPropagation(); invoke('open_external', { url: a.getAttribute('href') }); }
});

const view = new URLSearchParams(location.search).get('view');
document.body.dataset.view = view || 'sticky';
({ launcher: initLauncher, fab: initFab }[view] || initSticky)();

// ------------------------------------------------------------------ sticky

async function initSticky() {
  const { rel, mode: initialMode } = await invoke('sticky_init');
  const title = rel.split('/').pop().replace(/\.md$/, '');
  let mode = initialMode;
  let fm = '', body = '', lastSaved = '', editing = false, saveTimer = null;

  $('#app').innerHTML = `
    ${Object.keys(RESIZE_DIRS).map((d) => `<div class="rz ${d}" data-dir="${RESIZE_DIRS[d]}"></div>`).join('')}
    <div class="note">
      <header data-tauri-drag-region>
        <span class="title" data-tauri-drag-region></span>
        <div class="tools">
          <button class="mode" title=""></button>
          <button class="color" title="Cor"><i></i></button>
          <button class="close" title="Fechar">${svg('<path d="M6 6l12 12M18 6L6 18"/>')}</button>
        </div>
        <div class="palette" hidden>
          <div class="sw">${Object.entries(PRESETS).map(([n, [a, b]]) => `<button data-c="${n}" style="--a:${a};--b:${b}" title="${n}"></button>`).join('')}</div>
          <div class="custom">
            <span>Personalizado</span>
            <input type="color" class="c1" title="Cor inicial">
            <input type="color" class="c2" title="Cor final">
          </div>
        </div>
      </header>
      <main>
        <div class="view"></div>
        <textarea class="editor" spellcheck="false" hidden></textarea>
      </main>
      <div class="grid" hidden>
        <div class="gcells">${Array.from({ length: 36 }, (_, n) => `<i data-r="${Math.floor(n / 6) + 1}" data-c="${(n % 6) + 1}"></i>`).join('')}</div>
        <div class="glabel">Tabela</div>
      </div>
      <div class="fmt" hidden>
        ${FORMAT_BUTTONS.map(([f, label, tip]) => `<button data-f="${f}" title="${tip}">${label}</button>`).join('')}
        <span class="tctx" hidden>${TABLE_BUTTONS.map(([f, label, tip]) => `<button data-f="${f}" title="${tip}">${label}</button>`).join('')}</span>
      </div>
    </div>`;

  const note = $('.note'), viewEl = $('.view'), editor = $('.editor');
  $('.title').textContent = title;

  const paint = () => {
    const [g1, g2] = parseColor(frontmatterGet(fm, 'color'));
    const dark = (lum(g1) + lum(g2)) / 2 < 0.55;
    const s = note.style;
    s.setProperty('--g1', g1);
    s.setProperty('--g2', g2);
    s.setProperty('--ink', dark ? '#d6e4e8' : '#1d2a30');
    s.setProperty('--accent', dark ? '#5eead4' : '#0f766e');
    $('.c1').value = g1;
    $('.c2').value = g2;
    viewEl.innerHTML = body.trim() ? renderMarkdown(body) : '<div class="empty">Clique para escrever…</div>';
  };
  const paintMode = () => {
    const b = $('.mode');
    b.innerHTML = svg(MODES[mode].icon);
    b.title = `${MODES[mode].label} (clique para alternar)`;
    b.classList.toggle('active', mode !== 'normal');
  };
  const persist = async () => {
    clearTimeout(saveTimer);
    const content = fm + body;
    if (content === lastSaved) return;
    lastSaved = content;
    try { await invoke('write_note', { rel, content }); } catch (err) { console.error(err); }
  };
  const load = async () => {
    const text = await invoke('read_note', { rel });
    if (text === lastSaved && fm + body === text) return;
    lastSaved = text;
    ({ fm, body } = splitFrontmatter(text));
    paint();
  };

  const fmt = $('.fmt'), grid = $('.grid'), tctx = $('.tctx');
  const startEdit = (atEnd = true) => {
    editing = true;
    editor.value = body;
    viewEl.hidden = true;
    editor.hidden = false;
    fmt.hidden = false;
    editor.focus();
    if (atEnd) editor.setSelectionRange(body.length, body.length);
  };
  const stopEdit = async () => {
    if (!editing) return;
    editing = false;
    body = editor.value;
    editor.hidden = true;
    fmt.hidden = true;
    grid.hidden = true;
    viewEl.hidden = false;
    paint();
    await persist();
  };

  editor.addEventListener('input', () => {
    body = editor.value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  });
  editor.addEventListener('blur', stopEdit);

  // ---- edição: atalhos, listas que continuam sozinhas, indentação
  const ed = createEditing(editor);
  const FORMATS = {
    h: ed.cycleHeading,
    b: () => ed.wrap('**'),
    i: () => ed.wrap('*'),
    s: () => ed.wrap('~~'),
    hl: () => ed.wrap('=='),
    code: () => ed.wrap('`'),
    ul: ed.toggleBullet,
    task: ed.toggleTask,
    quote: ed.toggleQuote,
    link: ed.link,
    wiki: () => ed.wrap('[[', ']]'),
    table: () => { grid.hidden = !grid.hidden; },
    addrow: ed.addRow,
    addcol: ed.addCol,
    delrow: ed.delRow,
    delcol: ed.delCol,
  };
  // os botões de linha/coluna só aparecem com o cursor dentro de uma tabela
  const updateTableUI = () => { tctx.hidden = !ed.inTable(); };
  for (const ev of ['keyup', 'mouseup', 'focus']) editor.addEventListener(ev, updateTableUI);
  editor.addEventListener('input', updateTableUI);

  // mousedown não pode tirar o foco do textarea (o blur encerraria a edição)
  for (const el of [fmt, grid]) el.addEventListener('mousedown', (e) => e.preventDefault());
  fmt.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (!f) return;
    if (f !== 'table') grid.hidden = true;
    FORMATS[f]();
    updateTableUI();
  });

  // seletor de tamanho da tabela (linhas × colunas), como num editor de texto
  grid.addEventListener('mouseover', (e) => {
    const c = e.target.closest('i');
    if (!c) return;
    const [hr, hc] = [Number(c.dataset.r), Number(c.dataset.c)];
    for (const i of grid.querySelectorAll('i')) i.classList.toggle('on', Number(i.dataset.r) <= hr && Number(i.dataset.c) <= hc);
    $('.glabel').textContent = `${hr} × ${hc}`;
  });
  grid.addEventListener('click', (e) => {
    const c = e.target.closest('i');
    if (!c) return;
    grid.hidden = true;
    ed.insertTable(Number(c.dataset.r), Number(c.dataset.c));
    updateTableUI();
  });

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { stopEdit(); return; }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let handled = true;
    if (mod && !e.shiftKey && !e.altKey && k === 'b') FORMATS.b();
    else if (mod && !e.shiftKey && k === 'i') FORMATS.i();
    else if (mod && !e.shiftKey && k === 'e') FORMATS.code();
    else if (mod && !e.shiftKey && k === 'k') FORMATS.link();
    else if (mod && !e.shiftKey && k === 'l') FORMATS.task();
    else if (mod && e.shiftKey && k === 'x') FORMATS.s();
    else if (mod && e.shiftKey && k === 'h') FORMATS.hl();
    else if (mod && ['1', '2', '3'].includes(e.key)) ed.setHeading(Number(e.key));
    else if (e.key === 'Enter' && !mod && !e.shiftKey) handled = ed.tableEnter() || ed.continueList();
    else if (e.key === 'Tab' && !mod) { if (!ed.tableNav(e.shiftKey ? -1 : 1)) ed.indent(e.shiftKey); }
    else handled = false;
    if (handled) e.preventDefault();
    updateTableUI();
  });

  viewEl.addEventListener('click', (e) => {
    const wl = e.target.closest('.wl');
    if (wl) { invoke('open_link', { name: wl.dataset.t }).catch(() => {}); return; }
    const cb = e.target.closest('.cb');
    if (cb) {
      const i = Number(cb.closest('.l').dataset.i);
      const lines = body.split('\n');
      lines[i] = lines[i].replace(/\[( |x|X)\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]'));
      body = lines.join('\n');
      paint();
      persist();
      return;
    }
    if (e.target.closest('a')) return;

    // o cursor entra onde se clicou: na célula (tabelas) ou no fim da linha
    const block = e.target.closest('.l');
    if (!block) { startEdit(); return; }
    const lineIdx = Number(block.dataset.i);
    startEdit(false);
    const cell = e.target.closest('td, th');
    if (block.classList.contains('tw') && cell) {
      const r = cell.tagName === 'TH' ? 0 : cell.parentElement.sectionRowIndex + 2;
      ed.selectTableCell(lineIdx, r, cell.cellIndex);
    } else {
      const lines = body.split('\n');
      const pos = lines.slice(0, lineIdx).reduce((n, l) => n + l.length + 1, 0) + (lines[lineIdx] || '').length;
      editor.setSelectionRange(pos, pos);
    }
    updateTableUI();
  });

  const palette = $('.palette');
  $('.color').addEventListener('click', () => { palette.hidden = !palette.hidden; });
  const applyColor = (value) => {
    if (editing) body = editor.value;
    fm = frontmatterSet(fm, 'color', value);
    paint();
    persist();
  };
  palette.addEventListener('click', (e) => {
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (!c) return;
    applyColor(c);
    palette.hidden = true;
  });
  // gradiente personalizado: aplica ao vivo; grava no arquivo quando o seletor fecha
  const custom = () => `"${$('.c1').value},${$('.c2').value}"`;
  for (const sel of ['.c1', '.c2']) {
    $(sel).addEventListener('input', () => {
      note.style.setProperty('--g1', $('.c1').value);
      note.style.setProperty('--g2', $('.c2').value);
    });
    $(sel).addEventListener('change', () => applyColor(custom()));
  }

  for (const rz of document.querySelectorAll('.rz')) {
    rz.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      appWin.startResizeDragging(rz.dataset.dir);
    });
  }

  $('.mode').addEventListener('click', async () => {
    mode = MODES[mode].next;
    paintMode();
    await invoke('set_mode', { mode });
  });
  $('.close').addEventListener('click', async () => { await stopEdit(); appWin.close(); });

  listen('note-changed', async (e) => {
    if (e.payload === rel && !editing) await load();
  });

  paintMode();
  await load();
}

// --------------------------------------------------------------------- fab

// Botão flutuante: clique abre o launcher; arrastar (>4px) move o botão.
function initFab() {
  $('#app').innerHTML = `<button class="fab" title="Abrir o Natx"><span class="orb">${svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>')}</span><span class="lbl">Natx</span></button>`;
  let down = null;
  $('.fab').addEventListener('mousedown', (e) => {
    if (e.button === 0) down = { x: e.screenX, y: e.screenY, dragged: false };
  });
  window.addEventListener('mousemove', (e) => {
    if (down && !down.dragged && Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) {
      down.dragged = true;
      appWin.startDragging();
    }
  });
  window.addEventListener('mouseup', () => {
    if (down && !down.dragged) invoke('toggle_launcher_cmd');
    down = null;
  });
}
