import * as vscode from 'vscode';
import type { ChatMode, HostToWebview, WebviewToHost } from '../core/protocol';
import type { ChatService } from './chatService';
import { insertCodeAtCursor, replaceSelectionFromChat } from './editActions';
import { getWebviewHtml } from './html';

/** 侧边栏工作台视图：把 Webview 消息翻译成工作台动作。 */
export class WorkbenchViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    static readonly viewType = 'deepseek.workbench';

    private view?: vscode.WebviewView;
    private pendingDraft?: string;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly service: ChatService
    ) {
        this.disposables.push(service.onDidChangeState(() => this.pushState()));
        this.disposables.push(
            service.onDidStream((update) => {
                this.post({
                    type: 'delta',
                    messageId: update.messageId,
                    html: update.html,
                    reasoningHtml: update.reasoningHtml,
                    plain: update.content,
                });
            })
        );
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };
        view.webview.html = getWebviewHtml(view.webview, this.extensionUri);
        view.webview.onDidReceiveMessage((message: WebviewToHost) => {
            void this.handleMessage(message);
        });
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this.pushState();
            }
        });
        this.pushState();
    }

    /** 聚焦侧边栏；视图尚未创建时走命令触发创建。 */
    async focus(): Promise<void> {
        if (this.view) {
            this.view.show?.(true);
            return;
        }
        await vscode.commands.executeCommand(`${WorkbenchViewProvider.viewType}.focus`);
    }

    /** 打开工作台并把草稿放进输入框。 */
    async prefill(text: string, mode: ChatMode): Promise<void> {
        this.service.setMode(mode);
        this.pendingDraft = text;
        await this.focus();
        this.flushDraft();
    }

    private flushDraft(): void {
        if (!this.pendingDraft) {
            return;
        }
        this.post({ type: 'draft', text: this.pendingDraft });
        this.pendingDraft = undefined;
        this.post({ type: 'focusInput' });
    }

    private post(message: HostToWebview): void {
        void this.view?.webview.postMessage(message);
    }

    private pushState(): void {
        if (!this.view) {
            return;
        }
        this.post({ type: 'state', state: this.service.getState() });
    }

    private toast(text: string): void {
        void vscode.window.setStatusBarMessage(`DeepSeek：${text}`, 3000);
    }

    private async handleMessage(message: WebviewToHost): Promise<void> {
        try {
            switch (message.type) {
                case 'ready':
                    this.pushState();
                    this.flushDraft();
                    break;
                case 'send':
                    await this.service.send(message.text, message.mode, {
                        includeSelection: message.includeSelection,
                        includeFile: message.includeFile,
                    });
                    break;
                case 'stop':
                    this.service.stop();
                    break;
                case 'newChat':
                    this.service.newChat();
                    break;
                case 'selectChat':
                    this.service.selectChat(message.id);
                    break;
                case 'deleteChat':
                    this.service.deleteChat(message.id);
                    break;
                case 'setModel':
                    await this.service.setModel(message.model);
                    break;
                case 'setMode':
                    this.service.setMode(message.mode);
                    break;
                case 'setThinking':
                    this.service.setThinking(message.value);
                    break;
                case 'refreshModels':
                    await this.service.refreshModels();
                    break;
                case 'openFile':
                    await this.service.pickFile();
                    break;
                case 'insertCode':
                    await insertCodeAtCursor(message.code);
                    this.toast('已插入到光标处');
                    break;
                case 'replaceSelection': {
                    const result = await replaceSelectionFromChat(message.code);
                    this.toast(result === 'replaced' ? '已替换选区' : '没有选区，已插入到光标处');
                    break;
                }
                case 'copy':
                    await vscode.env.clipboard.writeText(message.code);
                    this.toast('代码已复制');
                    break;
                case 'setKey':
                    await vscode.commands.executeCommand('deepseek.setApiKey');
                    break;
                case 'openSettings':
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'deepseek');
                    break;
                case 'retry':
                    await this.service.retry(message.messageId);
                    break;
                case 'applyLastEdit':
                    await this.service.applyPendingEdit(message.messageId);
                    break;
                case 'revertLastEdit':
                    await this.service.revertLastEdit();
                    break;
                case 'askSelection':
                    await this.focus();
                    this.pendingDraft = '解释这段代码的作用、关键逻辑和潜在问题。';
                    this.flushDraft();
                    break;
                default:
                    break;
            }
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            void vscode.window.showWarningMessage(`DeepSeek：${text}`);
            this.post({ type: 'notice', level: 'error', text });
        }
    }
}
