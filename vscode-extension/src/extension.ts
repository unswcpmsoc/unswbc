import * as vscode from "vscode";

const VIEW_TYPE = "battledragon.replayViewer";
const MAP_VIEW_TYPE = "battledragon.mapEditor";

function nonce(): string {
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

function webviewHtml(webview: vscode.Webview, media: vscode.Uri, view: string): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.css"));
    const id = nonce();
    const csp = [
        "default-src 'none'",
        `img-src ${webview.cspSource} data: blob:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
        `connect-src ${webview.cspSource}`,
        `script-src 'nonce-${id}'`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${style}" />
</head>
<body><div id="app" data-view="${view}"></div><script nonce="${id}" src="${script}"></script></body>
</html>`;
}

class ReplayEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
        const media = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
        const roots = [media];
        if (document.uri.scheme === "file") roots.push(vscode.Uri.joinPath(document.uri, ".."));

        panel.webview.options = { enableScripts: true, localResourceRoots: roots };
        panel.webview.html = webviewHtml(panel.webview, media, "replay");

        panel.webview.onDidReceiveMessage(async (message) => {
            if (message?.type !== "ready") return;
            const name = document.uri.path.split("/").pop() ?? "replay";
            if (document.uri.scheme === "file") {
                const url = panel.webview.asWebviewUri(document.uri).toString();
                panel.webview.postMessage({ type: "open", name, url });
                return;
            }
            try {
                const bytes = await vscode.workspace.fs.readFile(document.uri);
                panel.webview.postMessage({ type: "open", name, bytes });
            } catch (error) {
                panel.webview.postMessage({ type: "error", message: String(error) });
            }
        });
    }
}

// `.map` also names source maps and linker maps. A board's first line that
// isn't blank or a comment is its MAP line; an empty file is a new board.
function isBoard(text: string): boolean {
    const first = text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#"));
    return first === undefined || /^MAP\s/.test(first);
}

// VS Code keeps a file's own line endings, so a CRLF file never reads back
// exactly as the LF text the board sent.
const lf = (text: string) => text.replace(/\r\n/g, "\n");

class MapEditorProvider implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        if (!isBoard(document.getText())) {
            void vscode.commands.executeCommand("vscode.openWith", document.uri, "default", panel.viewColumn);
            panel.dispose();
            return;
        }
        const media = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
        panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
        panel.webview.html = webviewHtml(panel.webview, media, "map");

        let written = lf(document.getText());
        const sendText = () => panel.webview.postMessage({ type: "map", text: document.getText() });
        const changes = vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document !== document || lf(document.getText()) === written) return;
            written = lf(document.getText());
            sendText();
        });
        panel.onDidDispose(() => changes.dispose());

        panel.webview.onDidReceiveMessage(async (message) => {
            if (message?.type === "ready") sendText();
            if (message?.type !== "edit") return;
            written = lf(message.text);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), message.text);
            await vscode.workspace.applyEdit(edit);
        });
    }
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, new ReplayEditorProvider(context), {
            supportsMultipleEditorsPerDocument: false,
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerCustomEditorProvider(MAP_VIEW_TYPE, new MapEditorProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );
}

export function deactivate(): void {}
