import * as vscode from "vscode";

const VIEW_TYPE = "battledragon.replayViewer";

function nonce(): string {
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
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
        panel.webview.html = this.html(panel.webview, media);

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

    private html(webview: vscode.Webview, media: vscode.Uri): string {
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
<body><div id="app"></div><script nonce="${id}" src="${script}"></script></body>
</html>`;
    }
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, new ReplayEditorProvider(context), {
            supportsMultipleEditorsPerDocument: false,
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );
}

export function deactivate(): void {}
