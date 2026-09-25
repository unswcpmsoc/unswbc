# Battledragon Replay Viewer

Opens `.replay` files in VS Code as an interactive board, read-only. Same
visualiser the web app uses — `packages/visualiser` is aliased by path, not
copied, so the two hosts share one renderer.

```bash
cd vscode-extension
npm install
npm run build
```

| script    | does                                                               |
| --------- | ------------------------------------------------------------------ |
| `build`   | `vite build` for the webview bundle, then esbuild for the host      |
| `watch`   | rebuilds the webview on change; reload the webview to pick it up    |
| `check`   | `svelte-check` over the extension and the whole visualiser package  |
| `package` | builds a `.vsix`                                                   |

## Trying it

A development host needs no install, and leaves your own VS Code alone:

```bash
code --extensionDevelopmentPath="$PWD" ~/projects/battlecode
```

Press F5 from this folder for the same thing. Open any `.replay` in the new
window — replays are gitignored, so open the main checkout rather than a
worktree, which has none. `npm run watch` plus "Developer: Reload Webviews"
is the edit loop.

To install it for real:

```bash
npm run package
code --install-extension battledragon-replay-viewer-0.3.11.vsix
code --uninstall-extension unswbc.battledragon-replay-viewer
```

## Replay opens with a binary / unsupported encoding message

Replays are binary files. This message comes from VS Code's text editor,
before the replay viewer opens; changing the text encoding will not help.

1. Run `unswbc vscode` to install the viewer bundled with your toolkit. Check
   the printed editor path: this must be the editor you are using.
2. Run **Developer: Reload Window** from the Command Palette.
3. Right-click the replay tab, choose **Reopen Editor With…**, then
   **Battledragon Replay**. Use **Configure default editor for '*.replay'…**
   in that picker to make the choice permanent.

If Battledragon Replay is missing from the picker, check that
`unswbc.battledragon-replay-viewer` is installed and enabled in the current
VS Code window/profile. Version 0.3.11 and later support Restricted Mode:
the viewer only reads replay data and does not run code from the workspace.

## How it is wired

The host (`src/extension.ts`) registers a `CustomReadonlyEditorProvider`. It
never reads the file when the scheme is `file`: it hands the webview an
`asWebviewUri` and the webview `fetch`es it. A 15 MB replay through
`postMessage` is a noticeable structured clone, and the repo has two of those.
Other schemes — remote or virtual filesystems — fall back to
`workspace.fs.readFile` and a posted byte array.

The webview (`webview/App.svelte`) is the frontend's `/visualiser` page shell:
the Info / Game Log / Options tabs and the resizable sidebar. Everything
inside it is a package export — `ReplayViewer`, `GameLog`, `MatchCharts`,
`TeamStats`, `SkinOptions`.

`webview/theme.css` defines the `--color-*` names from `--vscode-*`, which is
all it takes to theme the chrome: the package's `theme.css` reads every token
as `var(--color-X, fallback)` precisely so a host can substitute. The board
itself stays on its skin palette in every theme — it is painted into a canvas,
so no CSS reaches it.

The four sprite sheets total 67 KB and inline as data URIs
(`assetsInlineLimit`), so the webview needs no resource roots beyond `dist/`.

## Known limits

- `retainContextWhenHidden` is on. A hidden tab keeps its parsed match in
  memory; for a 15 MB replay that is not free. The alternative is re-parsing on
  every reveal, which is slower than it sounds.
- Panning and zooming the board uses the same keys as the web app. VS Code
  never sees them, because the webview has focus.
