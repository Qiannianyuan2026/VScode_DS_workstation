import * as vscode from 'vscode';
import { DEFAULT_MODEL, isLegacyModel } from './core/models';
import { ApiKeyStore } from './vscode/apiKey';
import { ChatService } from './vscode/chatService';
import { ContextGatherer } from './vscode/context';
import { checkSetup } from './vscode/diagnostics';
import { PREVIEW_SCHEME, PreviewManager } from './vscode/preview';
import { readSettings } from './vscode/settings';
import { StatusBar } from './vscode/statusBar';
import { WorkbenchViewProvider } from './vscode/workbenchView';

export function activate(context: vscode.ExtensionContext): void {
    // log: true 让日志同时落盘，便于排查激活/请求问题
    const output = vscode.window.createOutputChannel('DeepSeek 工作台', { log: true });
    const version = String(context.extension?.packageJSON?.version ?? '');
    output.appendLine(`DeepSeek 工作台已激活${version ? `（v${version}）` : ''}`);
    const settings = () => readSettings();
    const keys = new ApiKeyStore(context.secrets);
    const preview = new PreviewManager();
    const contextGatherer = new ContextGatherer(settings);
    const service = new ChatService({
        settings,
        keys,
        context: contextGatherer,
        preview,
        globalState: context.globalState,
        output,
    });
    const provider = new WorkbenchViewProvider(context.extensionUri, service);
    const status = new StatusBar();

    const updateStatus = (): void => status.update(service.getState());
    service.onDidChangeState(updateStatus);

    // 把设置里遗留的 V3 / R1 模型名迁移到新的默认模型
    const configuredModel = vscode.workspace.getConfiguration('deepseek').get<string>('model');
    if (configuredModel && isLegacyModel(configuredModel)) {
        void vscode.workspace
            .getConfiguration('deepseek')
            .update('model', DEFAULT_MODEL, vscode.ConfigurationTarget.Global);
    }

    const requireSelection = (): vscode.TextEditor | undefined => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            void vscode.window.showInformationMessage('请先在编辑器里选中一段代码。');
            return undefined;
        }
        return editor;
    };

    context.subscriptions.push(
        output,
        keys,
        preview,
        service,
        provider,
        status,
        vscode.window.registerWebviewViewProvider(WorkbenchViewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, preview),

        vscode.commands.registerCommand('deepseek.openWorkbench', async () => {
            await provider.focus();
        }),

        vscode.commands.registerCommand('deepseek.newChat', async () => {
            service.newChat();
            await provider.focus();
        }),

        vscode.commands.registerCommand('deepseek.askSelection', async () => {
            if (!requireSelection()) {
                return;
            }
            await provider.prefill('解释这段代码的作用、关键逻辑和潜在问题。', 'ask');
        }),

        vscode.commands.registerCommand('deepseek.editSelection', async () => {
            const editor = requireSelection();
            if (!editor) {
                return;
            }
            const lineCount = editor.selection.end.line - editor.selection.start.line + 1;
            const instruction = await vscode.window.showInputBox({
                title: 'DeepSeek 定点修改',
                prompt: `描述要如何修改选中的 ${lineCount} 行代码（Enter 生成，Esc 取消）`,
                placeHolder: '例如：改成 async/await，并补上错误处理',
                ignoreFocusOut: true,
            });
            if (!instruction || !instruction.trim()) {
                return;
            }
            await provider.focus();
            await service.send(instruction, 'edit', { includeSelection: true });
        }),

        vscode.commands.registerCommand('deepseek.explainSelection', async () => {
            if (!requireSelection()) {
                return;
            }
            await provider.focus();
            await service.send('请解释这段代码的作用、关键逻辑和潜在问题，并指出可疑之处。', 'ask', {
                includeSelection: true,
            });
        }),

        vscode.commands.registerCommand('deepseek.addComment', async () => {
            if (!requireSelection()) {
                return;
            }
            await provider.focus();
            await service.send('为这段代码补充文档注释，保持原有逻辑不变。', 'edit', { includeSelection: true });
        }),

        vscode.commands.registerCommand('deepseek.generateTests', async () => {
            if (!requireSelection()) {
                return;
            }
            await provider.focus();
            await service.send('为这段代码生成单元测试，覆盖主要分支和边界情况。', 'ask', { includeSelection: true });
        }),

        vscode.commands.registerCommand('deepseek.setApiKey', async () => {
            await keys.prompt();
        }),

        vscode.commands.registerCommand('deepseek.clearApiKey', async () => {
            await keys.clear();
        }),

        vscode.commands.registerCommand('deepseek.applyLastEdit', async () => {
            await service.applyLatestPendingEdit();
        }),

        vscode.commands.registerCommand('deepseek.revertLastEdit', async () => {
            await service.revertLastEdit();
        }),

        vscode.commands.registerCommand('deepseek.clearHistory', async () => {
            await service.clearHistory();
        }),

        vscode.commands.registerCommand('deepseek.openSettings', async () => {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'deepseek');
        }),

        vscode.commands.registerCommand('deepseek.checkSetup', async () => {
            await checkSetup(keys, settings(), output);
        }),

        vscode.commands.registerCommand('deepseek.refreshModels', async () => {
            await service.refreshModels();
            void vscode.window.setStatusBarMessage('DeepSeek：模型列表已刷新', 3000);
        }),

        vscode.commands.registerCommand('deepseek.openFile', async () => {
            await service.pickFile();
        })
    );

    let contextTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleContextRefresh = (): void => {
        if (contextTimer) {
            clearTimeout(contextTimer);
        }
        contextTimer = setTimeout(() => {
            contextTimer = undefined;
            service.refreshContext();
        }, 150);
    };

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(scheduleContextRefresh),
        vscode.window.onDidChangeActiveTextEditor(scheduleContextRefresh),
        {
            dispose: (): void => {
                if (contextTimer) {
                    clearTimeout(contextTimer);
                }
            },
        }
    );

    void service.init().then(updateStatus, (error: unknown) => {
        output.appendLine(`初始化失败：${String(error)}`);
        updateStatus();
    });
}

export function deactivate(): void {
    // 由 context.subscriptions 统一释放
}
