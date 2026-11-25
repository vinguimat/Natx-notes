# Natx

Notas em markdown, organizadas em pastas, que viram adesivos na área de trabalho.
Leve (Tauri + WebView2, ~3 MB), minimalista e independente de outros apps.

As notas ficam em `Documentos\Natx` (criada na primeira execução) como arquivos `.md` comuns.

## Estrutura do projeto

```
Natx/
├── package.json            scripts (npm run build) e o CLI do Tauri
├── app-icon.png            ícone-fonte; `npm run icon` gera o conjunto em src-tauri/icons
├── src/                    interface (HTML/CSS/JS puro, sem bundler)
│   ├── index.html          página única; a janela escolhe a tela por ?view=
│   ├── main.js             adesivo (nota) e botão flutuante
│   ├── launcher.js         menu de notas: pastas, criar, renomear, excluir
│   ├── editing.js          edição: atalhos, listas, tabelas
│   ├── md.js               renderizador de markdown + frontmatter
│   ├── util.js             helpers pequenos
│   └── style.css           tema (azul-petróleo + turquesa) e gradientes
└── src-tauri/              núcleo em Rust
    ├── src/lib.rs          bandeja, janelas, vault, watcher, comandos
    ├── tauri.conf.json     nome, identificador e ícones do app
    ├── capabilities/       permissões das janelas
    └── Cargo.toml          dependências Rust
```

## Compilar

Requer Node, Rust (`rustup`) e o VS Build Tools com a carga C++.

```
npm install
npx tauri build --no-bundle      # gera src-tauri/target/release/natx.exe
```

## Uso rápido

- **Botão flutuante "Natx"**: clique abre o menu de notas; arraste para mover.
- **Menu**: busca, pastas em ordem alfabética, nova nota / nova pasta, renomear, excluir (vai para `.trash`).
- **Adesivo**: clique no texto para editar, `Esc` para sair. Botões: fixar no topo / desktop, cor (gradiente), fechar.
- **Atalhos**: `Ctrl+B` negrito, `Ctrl+I` itálico, `Ctrl+E` código, `Ctrl+K` link, `Ctrl+L` tarefa, `Ctrl+1/2/3` títulos.
- **Tabelas**: botão ▦ escolhe o tamanho; `Tab` / `Shift+Tab` navegam entre células (e criam linha no fim); `Enter` abre linha nova.
