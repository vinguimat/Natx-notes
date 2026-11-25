use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs,
    hash::{Hash, Hasher},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

// ---------------------------------------------------------------- estado

#[derive(Serialize, Deserialize, Clone)]
struct Geo {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[derive(Serialize, Deserialize, Clone)]
struct NoteState {
    geo: Option<Geo>,
    /// "top" (sempre no topo) | "desktop" (fixa no fundo) | "normal"
    mode: String,
    open: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct FabPos {
    x: i32,
    y: i32,
}

#[derive(Serialize, Deserialize, Default)]
struct Config {
    vault: Option<String>,
    notes: HashMap<String, NoteState>,
    /// posição do botão flutuante
    fab: Option<FabPos>,
    /// a pasta própria do app (Documentos\Natx) já foi criada e adotada
    #[serde(default)]
    natx: bool,
}

struct AppState {
    /// quando o launcher foi escondido por perder o foco (evita reabrir no mesmo clique)
    launcher_hid: Mutex<Option<Instant>>,
    config: Mutex<Config>,
    config_path: PathBuf,
    dirty: AtomicBool,
    quitting: AtomicBool,
    /// label da janela -> caminho relativo da nota
    labels: Mutex<HashMap<String, String>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl AppState {
    fn save_now(&self) {
        let cfg = self.config.lock().unwrap();
        if let Ok(json) = serde_json::to_string_pretty(&*cfg) {
            let _ = fs::write(&self.config_path, json);
        }
    }

    fn touch_note(&self, rel: &str, f: impl FnOnce(&mut NoteState)) {
        let mut cfg = self.config.lock().unwrap();
        let ns = cfg.notes.entry(rel.to_string()).or_insert(NoteState {
            geo: None,
            mode: "top".into(),
            open: false,
        });
        f(ns);
        self.dirty.store(true, Ordering::Relaxed);
    }
}

/// Estrutura inicial da pasta própria do app.
const NATX_FOLDERS: [&str; 4] = ["Inbox", "Projetos", "Diário", "Arquivo"];

const NATX_WELCOME: &str = "# Bem-vindo ao Natx

Suas notas ficam em arquivos `.md` nesta pasta, organizadas em pastas.

## Estrutura
- **Inbox**: captura rápida, sem pensar em onde guardar
- **Projetos**: uma pasta por projeto
- **Diário**: uma nota por dia
- **Arquivo**: o que já terminou

## Para começar
- [ ] Clique no texto para editar e **Esc** para sair
- [ ] `Ctrl+B` negrito, `Ctrl+L` tarefa, `Ctrl+K` link
- [ ] Ligue notas com [[Bem-vindo]] e use #tags

";

/// Cria (se faltar) a pasta Natx com as pastas iniciais e a nota de boas-vindas.
fn ensure_natx(root: &Path) -> std::io::Result<()> {
    for f in NATX_FOLDERS {
        fs::create_dir_all(root.join(f))?;
    }
    let welcome = root.join("Bem-vindo.md");
    if !welcome.exists() {
        fs::write(welcome, NATX_WELCOME)?;
    }
    Ok(())
}

fn vault_path(state: &AppState) -> Result<PathBuf, String> {
    state
        .config
        .lock()
        .unwrap()
        .vault
        .clone()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .ok_or_else(|| "Vault não configurado".to_string())
}

/// Geometria real da janela (usada quando só um dos eventos, Moved ou Resized, chegou antes).
fn fresh_geo(app: &AppHandle, label: &str) -> Geo {
    let w = app.get_webview_window(label);
    let pos = w.as_ref().and_then(|w| w.outer_position().ok());
    let size = w.as_ref().and_then(|w| w.inner_size().ok());
    Geo {
        x: pos.map_or(0, |p| p.x),
        y: pos.map_or(0, |p| p.y),
        w: size.map_or(300, |s| s.width),
        h: size.map_or(300, |s| s.height),
    }
}

/// Resolve um caminho relativo dentro do vault, recusando qualquer fuga (`..`, absolutos).
fn resolve(state: &AppState, rel: &str) -> Result<PathBuf, String> {
    let vault = vault_path(state)?;
    let rel_path = Path::new(rel);
    if rel_path.extension().and_then(|e| e.to_str()) != Some("md")
        || rel_path.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Caminho de nota inválido".into());
    }
    Ok(vault.join(rel_path))
}

fn label_for(rel: &str) -> String {
    let mut h = DefaultHasher::new();
    rel.hash(&mut h);
    format!("n{:x}", h.finish())
}

// ---------------------------------------------------------------- janelas

fn apply_mode(w: &WebviewWindow, mode: &str) {
    let _ = w.set_always_on_top(mode == "top");
    let _ = w.set_always_on_bottom(mode == "desktop");
}

fn open_sticky(app: &AppHandle, rel: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let label = label_for(rel);

    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    state.labels.lock().unwrap().insert(label.clone(), rel.to_string());
    state.touch_note(rel, |n| n.open = true);
    let ns = state.config.lock().unwrap().notes.get(rel).cloned().unwrap();

    let cascade = (state.labels.lock().unwrap().len() % 8) as f64 * 32.0;
    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(rel)
        .inner_size(300.0, 300.0)
        .min_inner_size(180.0, 120.0)
        .position(120.0 + cascade, 120.0 + cascade)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;

    if let Some(g) = ns.geo.as_ref().filter(|g| g.w > 0 && g.h > 0) {
        let _ = w.set_size(PhysicalSize::new(g.w, g.h));
        // (0, 0) vinha de versões antigas que gravavam a posição padrão: ignora
        if g.x != 0 || g.y != 0 {
            let _ = w.set_position(PhysicalPosition::new(g.x, g.y));
        }
    }
    apply_mode(&w, &ns.mode);

    let app2 = app.clone();
    let rel2 = rel.to_string();
    let label2 = label.clone();
    w.on_window_event(move |ev| {
        let st = app2.state::<AppState>();
        match ev {
            WindowEvent::Moved(p) if p.x > -10_000 => st.touch_note(&rel2, |n| {
                let g = n.geo.get_or_insert_with(|| fresh_geo(&app2, &label2));
                g.x = p.x;
                g.y = p.y;
            }),
            WindowEvent::Resized(s) if s.width > 0 => st.touch_note(&rel2, |n| {
                let g = n.geo.get_or_insert_with(|| fresh_geo(&app2, &label2));
                g.w = s.width;
                g.h = s.height;
            }),
            WindowEvent::Destroyed if !st.quitting.load(Ordering::Relaxed) => {
                // só atualiza se a nota ainda existe (renomear/excluir já removeu a chave)
                if let Some(n) = st.config.lock().unwrap().notes.get_mut(&rel2) {
                    n.open = false;
                    st.dirty.store(true, Ordering::Relaxed);
                }
            }
            _ => {}
        }
    });

    let _ = w.show();
    Ok(())
}

/// Posiciona o launcher ao lado do botão flutuante (ou no canto da tela, se ele não existir).
fn place_launcher(app: &AppHandle, win: &WebviewWindow) {
    let Ok(sz) = win.outer_size() else { return };
    let (lw, lh) = (sz.width as i32, sz.height as i32);

    if let Some(fab) = app.get_webview_window("fab") {
        if let (Ok(fp), Ok(fs), Ok(Some(m))) = (fab.outer_position(), fab.outer_size(), fab.current_monitor()) {
            let s = m.scale_factor();
            // o círculo (48px) fica centrado na largura da janela, a 8px do topo; o texto "Natx" vem abaixo
            let radius = (24.0 * s) as i32;
            let (mx, my) = (m.position().x, m.position().y);
            let (mw, mh) = (m.size().width as i32, m.size().height as i32);
            let orb_cx = fp.x + fs.width as i32 / 2;
            let orb_cy = fp.y + (32.0 * s) as i32;
            let x = if orb_cx > mx + mw / 2 { orb_cx - radius - lw } else { orb_cx + radius };
            let y = (orb_cy - lh / 2).min(my + mh - lh - 8).max(my + 8);
            let _ = win.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }
    if let Ok(Some(m)) = app.primary_monitor() {
        let s = m.scale_factor();
        let x = m.size().width as i32 - lw - (12.0 * s) as i32;
        let y = m.size().height as i32 - lh - (56.0 * s) as i32;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

fn toggle_launcher(app: &AppHandle) {
    let state = app.state::<AppState>();

    if let Some(w) = app.get_webview_window("launcher") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            return;
        }
        // o próprio clique que tirou o foco já escondeu o launcher: não reabre
        let just_hid = state
            .launcher_hid
            .lock()
            .unwrap()
            .is_some_and(|t| t.elapsed() < Duration::from_millis(300));
        if just_hid {
            return;
        }
        place_launcher(app, &w);
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to("launcher", "launcher-shown", ());
        return;
    }

    let Ok(win) = WebviewWindowBuilder::new(app, "launcher", WebviewUrl::App("index.html?view=launcher".into()))
        .title("Natx")
        .inner_size(400.0, 560.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
    else {
        return;
    };
    place_launcher(app, &win);

    let win2 = win.clone();
    let app2 = app.clone();
    win.on_window_event(move |ev| {
        if let WindowEvent::Focused(false) = ev {
            *app2.state::<AppState>().launcher_hid.lock().unwrap() = Some(Instant::now());
            let _ = win2.hide();
        }
    });
    let _ = win.show();
    let _ = win.set_focus();
}

/// Botão flutuante sempre visível; clicar abre o launcher, arrastar reposiciona.
fn create_fab(app: &AppHandle) {
    let state = app.state::<AppState>();
    let saved = state.config.lock().unwrap().fab.clone();

    let Ok(w) = WebviewWindowBuilder::new(app, "fab", WebviewUrl::App("index.html?view=fab".into()))
        .title("Natx")
        .inner_size(136.0, 92.0)
        .min_inner_size(136.0, 92.0)
        .max_inner_size(136.0, 92.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
    else {
        return;
    };

    if let Some(p) = saved {
        let _ = w.set_position(PhysicalPosition::new(p.x, p.y));
    } else if let Ok(Some(m)) = app.primary_monitor() {
        // padrão: borda direita, na metade da altura (o círculo fica a ~12px da borda)
        let s = m.scale_factor();
        let orb_cx = m.position().x + m.size().width as i32 - (36.0 * s) as i32;
        let x = orb_cx - (68.0 * s) as i32;
        let y = m.position().y + m.size().height as i32 / 2;
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }

    let app2 = app.clone();
    w.on_window_event(move |ev| {
        if let WindowEvent::Moved(p) = ev {
            if p.x > -10_000 {
                let st = app2.state::<AppState>();
                st.config.lock().unwrap().fab = Some(FabPos { x: p.x, y: p.y });
                st.dirty.store(true, Ordering::Relaxed);
            }
        }
    });
    let _ = w.show();
}

// ---------------------------------------------------------------- vault

fn start_watcher(app: &AppHandle, vault: &Path) {
    let state = app.state::<AppState>();
    let app2 = app.clone();
    let root = vault.to_path_buf();

    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if !matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)) {
            return;
        }
        for p in ev.paths {
            if p.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(r) = p.strip_prefix(&root) else { continue };
            if r.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')) {
                continue;
            }
            let rel = r.to_string_lossy().replace('\\', "/");
            let _ = app2.emit("note-changed", rel);
        }
    });

    if let Ok(mut w) = watcher {
        if w.watch(vault, RecursiveMode::Recursive).is_ok() {
            *state.watcher.lock().unwrap() = Some(w);
        }
    }
}

fn collect_notes(dir: &Path, root: &Path, notes: &mut Vec<(String, u64)>, folders: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(r) = path.strip_prefix(root) else { continue };
        let rel = r.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            folders.push(rel);
            collect_notes(&path, root, notes, folders);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            notes.push((rel, mtime));
        }
    }
}

fn sanitize(name: &str) -> Result<String, String> {
    let clean: String = name
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let clean = clean.trim().trim_matches('.').trim().to_string();
    if clean.is_empty() {
        Err("Nome inválido".into())
    } else {
        Ok(clean)
    }
}

fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/// Pasta relativa dentro do vault ("" = raiz); recusa `..`, caminhos absolutos e pastas ocultas.
fn resolve_dir(state: &AppState, rel: &str) -> Result<PathBuf, String> {
    let vault = vault_path(state)?;
    let p = Path::new(rel);
    let bad = p.components().any(|c| match c {
        Component::Normal(s) => s.to_string_lossy().starts_with('.'),
        _ => true,
    });
    if bad {
        return Err("Pasta inválida".into());
    }
    Ok(vault.join(p))
}

/// Move o estado (e as janelas abertas) de uma nota/pasta renomeada ou excluída.
/// `new = None` descarta; `Some` reabre as janelas que estavam abertas no novo caminho.
fn relocate(app: &AppHandle, old: &str, new: Option<&str>, is_dir: bool) {
    let st = app.state::<AppState>();
    let prefix = format!("{old}/");
    let affected: Vec<(String, NoteState)> = st
        .config
        .lock()
        .unwrap()
        .notes
        .iter()
        .filter(|(r, _)| if is_dir { r.starts_with(&prefix) } else { r.as_str() == old })
        .map(|(r, n)| (r.clone(), n.clone()))
        .collect();

    let mut reopen = Vec::new();
    for (rel, ns) in affected {
        let label = label_for(&rel);
        st.config.lock().unwrap().notes.remove(&rel);
        st.labels.lock().unwrap().remove(&label);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        }
        if let Some(new) = new {
            let nrel = if is_dir { format!("{new}/{}", &rel[prefix.len()..]) } else { new.to_string() };
            st.config.lock().unwrap().notes.insert(nrel.clone(), ns.clone());
            if ns.open {
                reopen.push(nrel);
            }
        }
    }
    st.dirty.store(true, Ordering::Relaxed);
    for rel in reopen {
        let _ = open_sticky(app, &rel);
    }
}

// ---------------------------------------------------------------- comandos

#[derive(Serialize)]
struct NoteInfo {
    rel: String,
    title: String,
    open: bool,
    mtime: u64,
}

#[derive(Serialize)]
struct VaultList {
    notes: Vec<NoteInfo>,
    folders: Vec<String>,
}

#[derive(Serialize)]
struct StickyInit {
    rel: String,
    mode: String,
}

#[tauri::command]
fn get_vault(state: State<AppState>) -> Option<String> {
    vault_path(&state).ok().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_vault(app: AppHandle) -> Option<String> {
    let picked = app.dialog().file().blocking_pick_folder()?;
    let path = picked.into_path().ok()?;
    let state = app.state::<AppState>();
    state.config.lock().unwrap().vault = Some(path.to_string_lossy().to_string());
    state.dirty.store(true, Ordering::Relaxed);
    start_watcher(&app, &path);
    if let Some(w) = app.get_webview_window("launcher") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    Some(path.to_string_lossy().to_string())
}

#[tauri::command]
fn list_notes(state: State<AppState>) -> Result<VaultList, String> {
    let vault = vault_path(&state)?;
    let mut found = Vec::new();
    let mut folders = Vec::new();
    collect_notes(&vault, &vault, &mut found, &mut folders);
    let cfg = state.config.lock().unwrap();
    let mut notes: Vec<NoteInfo> = found
        .into_iter()
        .map(|(rel, mtime)| {
            let title = Path::new(&rel)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let open = cfg.notes.get(&rel).is_some_and(|n| n.open);
            NoteInfo { rel, title, open, mtime }
        })
        .collect();
    notes.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(VaultList { notes, folders })
}

#[tauri::command]
fn read_note(state: State<AppState>, rel: String) -> Result<String, String> {
    fs::read_to_string(resolve(&state, &rel)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_note(state: State<AppState>, rel: String, content: String) -> Result<(), String> {
    fs::write(resolve(&state, &rel)?, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_note(app: AppHandle, rel: String) -> Result<(), String> {
    resolve(&app.state::<AppState>(), &rel)?;
    open_sticky(&app, &rel)
}

#[tauri::command]
async fn create_note(app: AppHandle, title: String, folder: Option<String>) -> Result<String, String> {
    let state = app.state::<AppState>();
    let parent = folder.unwrap_or_default();
    let dir = resolve_dir(&state, &parent)?;
    if !dir.is_dir() {
        return Err("Pasta não encontrada".into());
    }
    let clean = sanitize(&title)?;
    let clean = clean.strip_suffix(".md").unwrap_or(&clean).to_string();
    let rel = join_rel(&parent, &format!("{clean}.md"));
    let path = dir.join(format!("{clean}.md"));
    if !path.exists() {
        fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    open_sticky(&app, &rel)?;
    Ok(rel)
}

#[tauri::command]
fn create_folder(state: State<AppState>, parent: String, name: String) -> Result<(), String> {
    let dir = resolve_dir(&state, &parent)?;
    let path = dir.join(sanitize(&name)?);
    if path.exists() {
        return Err("Já existe uma pasta com esse nome".into());
    }
    fs::create_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_entry(app: AppHandle, rel: String, new_name: String, is_dir: bool) -> Result<String, String> {
    let state = app.state::<AppState>();
    let vault = vault_path(&state)?;
    if is_dir && rel.is_empty() {
        return Err("Não dá para renomear a raiz".into());
    }
    let old_path = if is_dir { resolve_dir(&state, &rel)? } else { resolve(&state, &rel)? };
    let parent = rel.rsplit_once('/').map_or("", |(p, _)| p);
    let clean = sanitize(&new_name)?;
    let new_rel = if is_dir {
        join_rel(parent, &clean)
    } else {
        join_rel(parent, &format!("{}.md", clean.strip_suffix(".md").unwrap_or(&clean)))
    };
    let new_path = vault.join(&new_rel);
    // mudar só maiúsculas/minúsculas é o mesmo arquivo no Windows
    if new_path.exists() && new_rel.to_lowercase() != rel.to_lowercase() {
        return Err("Já existe um item com esse nome".into());
    }
    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;
    relocate(&app, &rel, Some(&new_rel), is_dir);
    Ok(new_rel)
}

/// Move para `.trash` dentro do vault (a mesma ideia de lixeira de outros apps de notas): nada é apagado de vez.
#[tauri::command]
async fn delete_entry(app: AppHandle, rel: String, is_dir: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let vault = vault_path(&state)?;
    if is_dir && rel.is_empty() {
        return Err("Não dá para excluir a raiz".into());
    }
    let path = if is_dir { resolve_dir(&state, &rel)? } else { resolve(&state, &rel)? };
    let trash = vault.join(".trash");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or("Caminho inválido")?;
    let mut dest = trash.join(&file_name);
    if dest.exists() {
        let secs = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let (stem, ext) = match file_name.rsplit_once('.') {
            Some((s, e)) if !is_dir => (s.to_string(), format!(".{e}")),
            _ => (file_name.clone(), String::new()),
        };
        dest = trash.join(format!("{stem}-{secs}{ext}"));
    }
    fs::rename(&path, &dest).map_err(|e| e.to_string())?;
    relocate(&app, &rel, None, is_dir);
    Ok(())
}

/// Segue um [[wikilink]]: abre a nota pelo nome (com ou sem pasta) ou cria na raiz se não existir.
#[tauri::command]
async fn open_link(app: AppHandle, name: String) -> Result<String, String> {
    let state = app.state::<AppState>();
    let vault = vault_path(&state)?;
    let raw = name.split('#').next().unwrap_or("").trim().trim_end_matches(".md").to_string();
    if raw.is_empty() {
        return Err("Link vazio".into());
    }
    let target = raw.to_lowercase();

    let (mut found, mut folders) = (Vec::new(), Vec::new());
    collect_notes(&vault, &vault, &mut found, &mut folders);
    let hit = found.iter().find(|(rel, _)| {
        let r = rel.trim_end_matches(".md").to_lowercase();
        r == target || r.rsplit('/').next() == Some(target.as_str())
    });

    let rel = match hit {
        Some((r, _)) => r.clone(),
        None => {
            if raw.contains('/') {
                return Err("Nota não encontrada".into());
            }
            let file = format!("{}.md", sanitize(&raw)?);
            fs::write(vault.join(&file), "").map_err(|e| e.to_string())?;
            file
        }
    };
    open_sticky(&app, &rel)?;
    Ok(rel)
}

#[tauri::command]
fn sticky_init(window: WebviewWindow, state: State<AppState>) -> Result<StickyInit, String> {
    let rel = state
        .labels
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or("Janela sem nota associada")?;
    let mode = state
        .config
        .lock()
        .unwrap()
        .notes
        .get(&rel)
        .map_or("top".to_string(), |n| n.mode.clone());
    Ok(StickyInit { rel, mode })
}

#[tauri::command]
fn set_mode(window: WebviewWindow, state: State<AppState>, mode: String) -> Result<(), String> {
    if !matches!(mode.as_str(), "top" | "desktop" | "normal") {
        return Err("Modo inválido".into());
    }
    let rel = state
        .labels
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or("Janela sem nota associada")?;
    apply_mode(&window, &mode);
    state.touch_note(&rel, |n| n.mode = mode);
    Ok(())
}

#[tauri::command]
async fn toggle_launcher_cmd(app: AppHandle) {
    toggle_launcher(&app);
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Só links http(s)".into());
    }
    // rundll32 recebe a URL como argumento direto, sem passar por um shell.
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- app

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            toggle_launcher(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            fs::create_dir_all(&dir)?;
            let config_path = dir.join("config.json");
            let mut config: Config = fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();

            // A pasta padrão é a própria do app (Documentos\Natx). Na primeira execução desta versão
            // ela substitui o vault anterior; depois disso a escolha do usuário é respeitada.
            let vault_missing = config.vault.as_deref().map_or(true, |v| !Path::new(v).is_dir());
            if !config.natx || vault_missing {
                if let Ok(docs) = app.path().document_dir() {
                    let root = docs.join("Natx");
                    if ensure_natx(&root).is_ok() {
                        config.vault = Some(root.to_string_lossy().to_string());
                        config.natx = true;
                    }
                }
            }

            app.manage(AppState {
                launcher_hid: Mutex::new(None),
                config: Mutex::new(config),
                config_path,
                dirty: AtomicBool::new(true),
                quitting: AtomicBool::new(false),
                labels: Mutex::new(HashMap::new()),
                watcher: Mutex::new(None),
            });

            // grava a config em segundo plano (posição/tamanho mudam várias vezes por segundo)
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(1));
                let st = handle.state::<AppState>();
                if st.dirty.swap(false, Ordering::Relaxed) {
                    st.save_now();
                }
            });

            // bandeja do sistema
            let list_i = MenuItem::with_id(app, "list", "Abrir notas…", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&list_i, &quit_i])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Natx")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "list" => toggle_launcher(app),
                    "quit" => {
                        let st = app.state::<AppState>();
                        st.quitting.store(true, Ordering::Relaxed);
                        st.save_now();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = ev
                    {
                        toggle_launcher(tray.app_handle());
                    }
                })
                .build(app)?;

            create_fab(app.handle());

            // vault + restaura as notas que estavam abertas
            let state = app.state::<AppState>();
            match vault_path(&state) {
                Ok(vault) => {
                    start_watcher(app.handle(), &vault);
                    let to_open: Vec<String> = state
                        .config
                        .lock()
                        .unwrap()
                        .notes
                        .iter()
                        .filter(|(rel, n)| n.open && vault.join(rel).is_file())
                        .map(|(rel, _)| rel.clone())
                        .collect();
                    for rel in to_open {
                        let _ = open_sticky(app.handle(), &rel);
                    }
                }
                Err(_) => toggle_launcher(app.handle()),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_vault,
            pick_vault,
            list_notes,
            read_note,
            write_note,
            open_note,
            create_note,
            create_folder,
            rename_entry,
            delete_entry,
            open_link,
            sticky_init,
            set_mode,
            open_external,
            toggle_launcher_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Natx")
        .run(|_app, ev| {
            // o app vive na bandeja: fechar todas as janelas não encerra o processo
            if let RunEvent::ExitRequested { api, code, .. } = ev {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
