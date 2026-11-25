// Menu de notas: árvore de pastas em ordem alfabética, com criar / renomear / excluir.

const collator = new Intl.Collator('pt', { sensitivity: 'base', numeric: true });
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

const ICON = {
  chevron: svg('<path d="M9 6l6 6-6 6"/>'),
  note: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 12v5M9.5 14.5h5"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>'),
};

function loadExpanded() {
  try { return new Set(JSON.parse(localStorage.getItem('expanded') || '[]')); } catch { return new Set(); }
}
function saveExpanded(set) {
  try { localStorage.setItem('expanded', JSON.stringify([...set])); } catch { /* sem storage: só não lembra */ }
}

// notas + pastas (inclusive vazias) -> árvore
function buildTree(notes, folders) {
  const root = { dirs: new Map(), notes: [], count: 0 };
  const dirAt = (parts) => {
    let node = root, path = '';
    for (const p of parts) {
      path = path ? `${path}/${p}` : p;
      if (!node.dirs.has(p)) node.dirs.set(p, { name: p, path, dirs: new Map(), notes: [], count: 0 });
      node = node.dirs.get(p);
    }
    return node;
  };
  for (const f of folders) dirAt(f.split('/'));
  for (const n of notes) {
    const parts = n.rel.split('/');
    parts.pop();
    let node = root;
    root.count++;
    for (const p of parts) { node = node.dirs.get(p) || dirAt(parts); node.count++; }
    dirAt(parts).notes.push(n);
  }
  return root;
}

// pastas primeiro, depois notas; tudo em ordem alfabética
function flatten(node, depth, rows, expanded, searching) {
  [...node.dirs.values()].sort((a, b) => collator.compare(a.name, b.name)).forEach((d) => {
    const open = searching || expanded.has(d.path);
    rows.push({ type: 'dir', d, depth, open });
    if (open) flatten(d, depth + 1, rows, expanded, searching);
  });
  [...node.notes].sort((a, b) => collator.compare(a.title, b.title)).forEach((n) => rows.push({ type: 'note', n, depth }));
}

async function initLauncher() {
  $('#app').innerHTML = `
    <div class="panel">
      <div class="search">
        <input type="text" placeholder="Buscar ou criar nota…" autofocus spellcheck="false">
        <button class="hbtn" data-h="note" title="Nova nota">${ICON.note}</button>
        <button class="hbtn" data-h="folder" title="Nova pasta">${ICON.folder}</button>
      </div>
      <ul class="list"></ul>
      <div class="toast" hidden></div>
      <footer>
        <span class="vault"></span>
        <button class="pick">Trocar pasta</button>
      </footer>
    </div>`;

  const input = $('.search input'), list = $('.list');
  const expanded = loadExpanded();
  let notes = [], folders = [], rows = [], sel = 0;
  let pending = null;     // { kind: 'note'|'folder', parent } | { kind: 'rename', key, rel, isDir }
  let confirmKey = null;  // linha esperando confirmação de exclusão

  const rowKey = (r) => (r.type === 'dir' ? `d:${r.d.path}` : r.type === 'note' ? `n:${r.n.rel}` : '');
  const flash = (msg) => {
    const t = $('.toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => { t.hidden = true; }, 2800);
  };

  const refresh = async () => {
    try {
      const r = await invoke('list_notes');
      notes = r.notes;
      folders = r.folders;
    } catch { notes = []; folders = []; }
    const vault = await invoke('get_vault');
    $('.vault').textContent = vault ? vault.split(/[\\/]/).pop() : 'Nenhuma pasta';
    $('.vault').title = vault || '';
    draw();
  };

  const actBtn = (a, title, icon) => `<button class="ab" data-a="${a}" title="${title}">${icon}</button>`;
  const actionsHtml = (r, key) => {
    if (confirmKey === key) {
      return '<span class="acts show"><span class="ask">Excluir?</span><button class="ab yes" data-a="del-yes">Sim</button><button class="ab" data-a="del-no">Não</button></span>';
    }
    const create = r.type === 'dir' ? actBtn('new-note', 'Nova nota aqui', ICON.note) + actBtn('new-folder', 'Nova subpasta', ICON.folder) : '';
    return `<span class="acts">${create}${actBtn('rename', 'Renomear (F2)', ICON.edit)}${actBtn('del', 'Mover para a lixeira', ICON.trash)}</span>`;
  };

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const matching = q ? notes.filter((n) => n.rel.toLowerCase().includes(q)) : notes;
    rows = [];
    flatten(buildTree(matching, q ? [] : folders), 0, rows, expanded, Boolean(q));
    if (q && !notes.some((n) => n.title.toLowerCase() === q)) rows.push({ type: 'create', depth: 0 });

    if (pending && pending.kind !== 'rename') {
      const idx = pending.parent ? rows.findIndex((r) => r.type === 'dir' && r.d.path === pending.parent) : -1;
      const depth = idx >= 0 ? rows[idx].depth + 1 : 0;
      rows.splice(idx + 1, 0, { type: 'input', kind: pending.kind, depth });
    }
    sel = Math.min(sel, Math.max(rows.length - 1, 0));

    list.innerHTML = rows.map((r, i) => {
      const cls = i === sel ? ' sel' : '';
      const pad = `style="--depth:${r.depth}"`;
      if (r.type === 'input') {
        const ph = r.kind === 'folder' ? 'Nome da pasta' : 'Nome da nota';
        return `<li class="inline" ${pad}><span class="ic">${r.kind === 'folder' ? ICON.folder : ICON.note}</span><input class="inl" placeholder="${ph}" spellcheck="false"></li>`;
      }
      if (r.type === 'create') {
        return `<li data-i="${i}" class="create${cls}" ${pad}><span class="plus">+</span><span class="name">Criar “${esc(input.value.trim())}”</span></li>`;
      }
      const key = rowKey(r);
      const name = r.type === 'dir' ? r.d.name : r.n.title;
      const renaming = pending?.kind === 'rename' && pending.key === key;
      const label = renaming
        ? `<input class="inl" value="${escAttr(name)}" spellcheck="false">`
        : `<span class="name">${esc(name)}</span>`;
      const acts = renaming ? '' : actionsHtml(r, key);
      if (r.type === 'dir') {
        return `<li data-i="${i}" class="dir-row${cls}${r.open ? ' open' : ''}" ${pad}><span class="chev">${ICON.chevron}</span>${label}${acts}<span class="count">${r.d.count}</span></li>`;
      }
      return `<li data-i="${i}" class="note-row${cls}" ${pad}><span class="dot${r.n.open ? ' on' : ''}"></span>${label}${acts}</li>`;
    }).join('') || '<li class="none">Nenhuma nota encontrada</li>';

    const inl = list.querySelector('.inl');
    if (inl) {
      inl.focus();
      inl.select();
      inl.addEventListener('keydown', onInline);
      inl.addEventListener('blur', () => setTimeout(() => {
        if (pending && document.activeElement !== inl) { pending = null; draw(); }
      }, 150));
    } else {
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    }
  };

  const hide = () => appWin.hide();

  const startPending = (p) => {
    pending = p;
    confirmKey = null;
    if (p.parent) { expanded.add(p.parent); saveExpanded(expanded); }
    draw();
  };
  const startRename = (r) => startPending({
    kind: 'rename', key: rowKey(r), isDir: r.type === 'dir', rel: r.type === 'dir' ? r.d.path : r.n.rel,
  });

  async function onInline(e) {
    if (e.key === 'Escape') { e.stopPropagation(); pending = null; draw(); input.focus(); return; }
    if (e.key !== 'Enter') return;
    const name = e.target.value.trim();
    const p = pending;
    if (!name) { pending = null; draw(); input.focus(); return; }
    try {
      if (p.kind === 'note') {
        await invoke('create_note', { title: name, folder: p.parent });
        pending = null;
        input.value = '';
        hide();
        return;
      }
      if (p.kind === 'folder') {
        await invoke('create_folder', { parent: p.parent, name });
      } else {
        const newRel = await invoke('rename_entry', { rel: p.rel, newName: name, isDir: p.isDir });
        if (p.isDir && expanded.delete(p.rel)) { expanded.add(newRel); saveExpanded(expanded); }
      }
    } catch (err) {
      flash(String(err));   // mantém o campo aberto para corrigir o nome
      return;
    }
    pending = null;
    await refresh();
    input.focus();
  }

  const activate = async (r) => {
    if (!r || r.type === 'input') return;
    if (r.type === 'dir') {
      if (expanded.has(r.d.path)) expanded.delete(r.d.path); else expanded.add(r.d.path);
      saveExpanded(expanded);
      draw();
      return;
    }
    if (r.type === 'note') await invoke('open_note', { rel: r.n.rel });
    else await invoke('create_note', { title: input.value.trim(), folder: '' });
    input.value = '';
    hide();
  };

  input.addEventListener('input', () => { sel = 0; confirmKey = null; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, rows.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && rows[sel]?.type === 'dir' && !rows[sel].open) { activate(rows[sel]); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && rows[sel]?.type === 'dir' && rows[sel].open) { activate(rows[sel]); e.preventDefault(); }
    else if (e.key === 'F2' && ['dir', 'note'].includes(rows[sel]?.type)) { startRename(rows[sel]); e.preventDefault(); }
    else if (e.key === 'Enter') activate(rows[sel]);
    else if (e.key === 'Escape') hide();
  });

  list.addEventListener('click', async (e) => {
    if (e.target.closest('.inl')) return;
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    sel = Number(li.dataset.i);
    const r = rows[sel];
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) { confirmKey = null; activate(r); return; }

    e.stopPropagation();
    const isDir = r.type === 'dir';
    const rel = isDir ? r.d.path : r.n?.rel;
    if (a === 'new-note') startPending({ kind: 'note', parent: r.d.path });
    else if (a === 'new-folder') startPending({ kind: 'folder', parent: r.d.path });
    else if (a === 'rename') startRename(r);
    else if (a === 'del') { confirmKey = rowKey(r); draw(); }
    else if (a === 'del-no') { confirmKey = null; draw(); }
    else if (a === 'del-yes') {
      try {
        await invoke('delete_entry', { rel, isDir });
        flash('Movido para .trash no vault');
      } catch (err) { flash(String(err)); }
      confirmKey = null;
      await refresh();
    }
  });

  for (const b of document.querySelectorAll('.hbtn')) {
    b.addEventListener('click', () => startPending({ kind: b.dataset.h, parent: '' }));
  }
  $('.pick').addEventListener('click', async () => { await invoke('pick_vault'); refresh(); });

  listen('launcher-shown', () => { input.value = ''; sel = 0; pending = null; confirmKey = null; refresh(); input.focus(); });
  listen('note-changed', () => { if (!pending) refresh(); });
  window.addEventListener('focus', () => { if (!pending) input.focus(); });
  await refresh();
  input.focus();
}
