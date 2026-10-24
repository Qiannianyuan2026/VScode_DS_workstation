import * as path from 'node:path';
import * as vscode from 'vscode';

const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,.vscode-test,.pnpm-store}/**';
const MAX_WORKSPACE_FILES = 400;
const CACHE_TTL_MS = 30_000;

let cache: { at: number; files: vscode.Uri[] } | undefined;

async function workspaceFiles(): Promise<vscode.Uri[]> {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) {
        return cache.files;
    }
    const files = (await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, MAX_WORKSPACE_FILES)).filter(
        (uri) => uri.scheme === 'file'
    );
    cache = { at: now, files };
    return files;
}

function relativePath(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false);
}

interface FilePickItem extends vscode.QuickPickItem {
    uri?: vscode.Uri;
}

/**
 * 在侧边栏里切换文件：先列已打开的编辑器，再列工作区文件。
 * 选中后按 keepFocus 决定焦点留在侧边栏还是交给编辑器。
 */
export async function showFilePicker(options: { keepFocus: boolean }): Promise<void> {
    const items: FilePickItem[] = [];
    const seen = new Set<string>();

    const add = (uri: vscode.Uri, groupLabel: string): void => {
        if (uri.scheme !== 'file' || seen.has(uri.toString())) {
            return;
        }
        seen.add(uri.toString());
        items.push({
            label: `$(file) ${path.basename(uri.fsPath)}`,
            description: `${groupLabel} · ${relativePath(uri)}`,
            uri,
        });
    };

    const openUris: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input instanceof vscode.TabInputText) {
                openUris.push(input.uri);
            }
        }
    }
    if (openUris.length > 0) {
        items.push({ label: '已打开的文件', kind: vscode.QuickPickItemKind.Separator });
        for (const uri of openUris) {
            add(uri, '已打开');
        }
    }

    const files = await workspaceFiles();
    if (files.length > 0) {
        items.push({ label: '工作区文件', kind: vscode.QuickPickItemKind.Separator });
        const sorted = [...files].sort((a, b) => relativePath(a).localeCompare(relativePath(b)));
        for (const uri of sorted) {
            add(uri, '工作区');
        }
    }

    const picked = await vscode.window.showQuickPick(items, {
        title: 'DeepSeek：切换文件',
        placeHolder: '输入文件名或路径，回车打开',
        matchOnDescription: true,
        ignoreFocusOut: true,
    });
    if (!picked?.uri) {
        return;
    }

    try {
        const document = await vscode.workspace.openTextDocument(picked.uri);
        await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: options.keepFocus,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showWarningMessage(`无法打开文件：${message}`);
    }
}
