import * as vscode from 'vscode';

export const PREVIEW_SCHEME = 'deepseek-preview';

/**
 * 虚拟文档：右侧 diff 显示「改完之后长什么样」。
 * 生成过程中不断 update，用户看到的就是实时预览。
 */
export class PreviewManager implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly contents = new Map<string, string>();
    private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
    private counter = 0;

    readonly onDidChange = this.emitter.event;

    create(fileName: string, initial: string): vscode.Uri {
        this.counter += 1;
        const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_');
        const uri = vscode.Uri.from({
            scheme: PREVIEW_SCHEME,
            path: `/${safeName}`,
            query: `v=${this.counter}`,
        });
        this.contents.set(uri.toString(), initial);
        return uri;
    }

    update(uri: vscode.Uri, text: string): void {
        const key = uri.toString();
        if (this.contents.get(key) === text) {
            return;
        }
        this.contents.set(key, text);
        this.emitter.fire(uri);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) ?? '';
    }

    /** 关掉对应的 diff 标签页。 */
    async closeTab(uri: vscode.Uri): Promise<void> {
        const tabs: vscode.Tab[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === uri.toString()) {
                    tabs.push(tab);
                }
            }
        }
        if (tabs.length > 0) {
            await vscode.window.tabGroups.close(tabs, true);
        }
    }

    release(uri: vscode.Uri): void {
        this.contents.delete(uri.toString());
    }

    dispose(): void {
        this.emitter.dispose();
        this.contents.clear();
    }
}

/** 打开左右对比：左边是真实文件，右边是实时预览。 */
export async function openDiff(left: vscode.Uri, right: vscode.Uri, title: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', left, right, title, {
        preserveFocus: true,
        preview: false,
    });
}
