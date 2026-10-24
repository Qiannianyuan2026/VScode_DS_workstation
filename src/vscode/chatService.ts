import * as vscode from 'vscode';
import { ApiError, DeepSeekClient } from '../core/client';
import { alignIndent, buildPreviewText, extractEditReply, type EditReply } from '../core/edit';
import { renderMarkdown } from '../core/markdown';
import { isValidModelId, isLegacyModel, mergeModels, modelLabel, supportsThinkingToggle } from '../core/models';
import { computeCost, formatCostTooltip, formatMoney } from '../core/pricing';
import { buildAskMessages, buildEditMessages } from '../core/prompt';
import type { ChatMode, WorkbenchState } from '../core/protocol';
import { toDisplayMessage } from '../core/protocol';
import {
    addMessage,
    createChat,
    createMessage,
    historyToApiMessages,
    parseState,
    summarize,
    updateMessage,
} from '../core/store';
import type {
    ApiMessage,
    Chat,
    ChatMessage,
    ContextSnapshot,
    EditTarget,
    StreamResult,
    Usage,
} from '../core/types';
import type { ApiKeyStore } from './apiKey';
import type { ContextGatherer } from './context';
import { applyEditTarget, revertEditTarget } from './editActions';
import { UserFacingError } from './errors';
import { showFilePicker } from './fileSwitcher';
import { openDiff, type PreviewManager } from './preview';
import type { WorkbenchSettings } from './settings';

const STATE_KEY = 'deepseek.workbench.state.v1';

export interface StreamingUpdate {
    messageId: string;
    html: string;
    reasoningHtml: string;
    content: string;
}

export interface ChatServiceDeps {
    settings: () => WorkbenchSettings;
    keys: ApiKeyStore;
    context: ContextGatherer;
    preview: PreviewManager;
    globalState: vscode.Memento;
    output: vscode.OutputChannel;
}

/**
 * 工作台的中枢：持有会话状态、驱动流式请求、执行定点修改。
 * UI 只订阅事件，不直接碰网络与文件。
 */
export class ChatService implements vscode.Disposable {
    private state = parseState(undefined);
    private mode: ChatMode = 'ask';
    private busy = false;
    private hasKey = false;
    private abort?: AbortController;
    private notice?: { level: 'info' | 'warn' | 'error'; text: string };
    private lastEdit?: EditTarget;
    private pendingEdits = new Map<string, EditTarget>();
    private readonly markdownCache = new Map<string, string>();
    /** /models 返回的可用模型；拉取失败时为空，界面回退到内置列表。 */
    private discoveredModels: string[] = [];
    private thinkingEnabled: boolean;
    private refreshingModels = false;

    private readonly stateEmitter = new vscode.EventEmitter<void>();
    private readonly streamEmitter = new vscode.EventEmitter<StreamingUpdate>();
    private readonly keyListener: vscode.Disposable;

    readonly onDidChangeState = this.stateEmitter.event;
    readonly onDidStream = this.streamEmitter.event;

    constructor(private readonly deps: ChatServiceDeps) {
        const parsed = parseState(deps.globalState.get(STATE_KEY), deps.settings().model);
        // 历史状态里如果还存着 V3 / R1，自动迁移到当前默认模型
        this.state = isLegacyModel(parsed.model) ? { ...parsed, model: deps.settings().model } : parsed;
        this.thinkingEnabled = deps.settings().thinking;
        this.keyListener = deps.keys.onDidChange(() => {
            void this.refreshKey();
        });
    }

    async init(): Promise<void> {
        await this.refreshKey();
    }

    private async refreshKey(): Promise<void> {
        this.hasKey = await this.deps.keys.has();
        if (!this.hasKey) {
            this.notice = { level: 'warn', text: '还没有配置 DeepSeek API Key。' };
        }
        this.pushState();
        if (this.hasKey) {
            await this.refreshModels();
        }
    }

    /** 从 /models 拉取当前账号可用模型（V4 / Flash 等新模型会自动出现）。 */
    async refreshModels(): Promise<void> {
        if (this.refreshingModels || !this.hasKey) {
            return;
        }
        this.refreshingModels = true;
        try {
            const apiKey = await this.deps.keys.get();
            if (!apiKey) {
                return;
            }
            const settings = this.deps.settings();
            const client = new DeepSeekClient({
                apiKey,
                baseUrl: settings.baseUrl,
                timeoutMs: Math.min(settings.timeoutMs, 20000),
            });
            const models = (await client.listModels()).filter((id) => !isLegacyModel(id));
            if (models.length > 0) {
                this.discoveredModels = models;
                this.deps.output.appendLine(`[models] 发现可用模型：${models.join(', ')}`);
            }
        } catch (error) {
            this.deps.output.appendLine(`[models] 拉取模型列表失败：${this.describeError(error)}`);
        } finally {
            this.refreshingModels = false;
            this.pushState();
        }
    }

    setThinking(value: boolean): void {
        this.thinkingEnabled = value;
        this.pushState();
    }

    dispose(): void {
        this.abort?.abort();
        this.keyListener.dispose();
        this.stateEmitter.dispose();
        this.streamEmitter.dispose();
    }

    // ---------------------------------------------------------------- 状态

    getState(): WorkbenchState {
        const chat = this.activeChat();
        const settings = this.deps.settings();
        let chatUsd = 0;

        const messages = chat.messages.map((message) => {
            const display = toDisplayMessage(message, {
                render: (markdown) => this.renderMarkdownCached(markdown),
            });
            if (!message.usage) {
                return display;
            }
            const cost = computeCost(message.model ?? this.state.model, message.usage, new Date(message.createdAt));
            if (!cost) {
                return display;
            }
            chatUsd += cost.usd;
            display.cost = {
                label: formatMoney(cost.usd, settings.currency, settings.usdToCny),
                tooltip: formatCostTooltip(cost, settings.currency, settings.usdToCny),
            };
            return display;
        });

        return {
            chats: summarize(this.state.chats),
            activeChatId: chat.id,
            messages,
            model: this.state.model,
            models: mergeModels(this.discoveredModels, settings.extraModels).map((id) => ({
                id,
                label: modelLabel(id),
            })),
            hasKey: this.hasKey,
            busy: this.busy,
            context: this.deps.context.describe(),
            mode: this.mode,
            thinkingAvailable: supportsThinkingToggle(this.state.model),
            thinking: this.thinkingEnabled,
            chatCostLabel:
                chatUsd > 0
                    ? `本会话 ${formatMoney(chatUsd, settings.currency, settings.usdToCny)}`
                    : '',
            notice: this.notice,
        };
    }

    private renderMarkdownCached(markdown: string): string {
        const cached = this.markdownCache.get(markdown);
        if (cached !== undefined) {
            return cached;
        }
        const html = renderMarkdown(markdown);
        if (this.markdownCache.size > 200) {
            const oldest = this.markdownCache.keys().next();
            if (!oldest.done) {
                this.markdownCache.delete(oldest.value);
            }
        }
        this.markdownCache.set(markdown, html);
        return html;
    }

    private activeChat(): Chat {        const found = this.state.chats.find((chat) => chat.id === this.state.activeChatId);
        if (found) {
            return found;
        }
        const created = createChat();
        this.state = { ...this.state, chats: [created, ...this.state.chats], activeChatId: created.id };
        return created;
    }

    private mutateChat(chatId: string, mutate: (chat: Chat) => Chat): void {
        this.state = {
            ...this.state,
            chats: this.state.chats.map((chat) => (chat.id === chatId ? mutate(chat) : chat)),
        };
    }

    private setMessage(chatId: string, messageId: string, patch: Partial<ChatMessage>): void {
        this.mutateChat(chatId, (chat) => updateMessage(chat, messageId, patch));
    }

    private persist(): void {
        void this.deps.globalState.update(STATE_KEY, this.state);
    }

    private pushState(): void {
        this.stateEmitter.fire();
    }

    private toast(text: string): void {
        void vscode.window.setStatusBarMessage(`DeepSeek：${text}`, 4000);
    }

    // ---------------------------------------------------------------- 会话操作

    setMode(mode: ChatMode): void {
        this.mode = mode;
        this.pushState();
    }

    async setModel(model: string): Promise<void> {
        if (!isValidModelId(model)) {
            return;
        }
        this.state = { ...this.state, model };
        this.persist();
        this.pushState();
        await vscode.workspace.getConfiguration('deepseek').update('model', model, vscode.ConfigurationTarget.Global);
    }

    newChat(): void {
        this.stop();
        const chat = createChat();
        this.state = {
            ...this.state,
            chats: [chat, ...this.state.chats],
            activeChatId: chat.id,
        };
        this.notice = undefined;
        this.persist();
        this.pushState();
    }

    selectChat(id: string): void {
        if (!this.state.chats.some((chat) => chat.id === id)) {
            return;
        }
        this.state = { ...this.state, activeChatId: id };
        this.persist();
        this.pushState();
    }

    deleteChat(id: string): void {
        const chats = this.state.chats.filter((chat) => chat.id !== id);
        if (chats.length === 0) {
            chats.push(createChat());
        }
        const activeChatId = this.state.activeChatId === id ? chats[0].id : this.state.activeChatId;
        this.state = { ...this.state, chats, activeChatId };
        this.persist();
        this.pushState();
    }

    async clearHistory(): Promise<void> {
        const answer = await vscode.window.showWarningMessage('确定清空全部 DeepSeek 对话历史吗？此操作不可恢复。', {
            modal: true,
        }, '清空');
        if (answer !== '清空') {
            return;
        }
        this.stop();
        const chat = createChat();
        this.state = { ...this.state, chats: [chat], activeChatId: chat.id };
        this.lastEdit = undefined;
        this.pendingEdits.clear();
        this.persist();
        this.pushState();
    }

    refreshContext(): void {
        this.pushState();
    }

    /** 侧边栏里的「切换文件」入口：不离开工作台即可换当前文件。 */
    async pickFile(): Promise<void> {
        await showFilePicker({ keepFocus: this.deps.settings().keepFocusAfterFileSwitch });
        this.pushState();
    }

    stop(): void {
        this.abort?.abort();
    }

    // ---------------------------------------------------------------- 发送

    async send(
        text: string,
        mode: ChatMode,
        options: { includeSelection?: boolean; includeFile?: boolean } = {}
    ): Promise<void> {
        const instruction = text.trim();
        if (!instruction) {
            return;
        }
        if (this.busy) {
            this.toast('正在生成，先点「停止」再发送。');
            return;
        }
        if (!this.hasKey) {
            this.notice = { level: 'error', text: '还没有配置 DeepSeek API Key。' };
            this.pushState();
            void vscode.commands.executeCommand('deepseek.setApiKey');
            return;
        }

        const settings = this.deps.settings();
        this.mode = mode;
        if (this.state.model !== settings.model) {
            this.state = { ...this.state, model: settings.model };
        }

        let context: ContextSnapshot | undefined;
        try {
            context = await this.deps.context.capture({
                needSelection: mode === 'edit',
                includeSelection: options.includeSelection !== false,
                includeFile: options.includeFile === true,
            });
        } catch (error) {
            this.notice = { level: 'error', text: this.describeError(error) };
            this.reportError(error);
            this.pushState();
            return;
        }

        const chat = this.activeChat();
        const history = historyToApiMessages(chat, {
            maxTurns: settings.maxHistoryTurns,
            maxChars: 24000,
        });

        const userMessage = createMessage('user', instruction, {
            mode,
            ...(context?.label ? { contextLabel: context.label } : {}),
        });
        const assistantMessage = createMessage('assistant', '', { model: settings.model });

        this.mutateChat(chat.id, (current) => addMessage(addMessage(current, userMessage), assistantMessage));
        this.notice = undefined;
        this.busy = true;
        this.pushState();

        try {
            if (mode === 'edit') {
                await this.runEdit(instruction, context, chat.id, assistantMessage.id, settings, history);
            } else {
                await this.runAsk(instruction, context, chat.id, assistantMessage.id, settings, history);
            }
        } catch (error) {
            this.handleError(error, chat.id, assistantMessage.id, mode);
        } finally {
            this.busy = false;
            this.abort = undefined;
            this.persist();
            this.pushState();
        }
    }

    private async runAsk(
        instruction: string,
        context: ContextSnapshot | undefined,
        chatId: string,
        messageId: string,
        settings: WorkbenchSettings,
        history: ApiMessage[]
    ): Promise<void> {
        const messages = buildAskMessages({
            question: instruction,
            contextText: context?.text,
            history,
            extraSystemPrompt: settings.extraSystemPrompt,
        });

        const result = await this.streamCompletion(messages, chatId, messageId, settings, (content) => content);
        this.setMessage(chatId, messageId, {
            content: result.text.trim() || '（模型没有返回内容）',
            reasoning: result.reasoning || undefined,
            usage: result.usage,
            model: settings.model,
        });
        this.persist();
    }

    private async runEdit(
        instruction: string,
        context: ContextSnapshot | undefined,
        chatId: string,
        messageId: string,
        settings: WorkbenchSettings,
        history: ApiMessage[]
    ): Promise<void> {
        const editorContext = context?.editor;
        if (!editorContext || !editorContext.selection) {
            throw new UserFacingError('定点修改需要先在编辑器里选中一段代码。');
        }

        const target: EditTarget = {
            uri: editorContext.uri,
            startLine: editorContext.selection.startLine,
            endLine: editorContext.selection.endLine,
            startOffset: editorContext.startOffset,
            endOffset: editorContext.endOffset,
            originalText: editorContext.fullText.slice(editorContext.startOffset, editorContext.endOffset),
            newText: '',
            documentVersion: editorContext.documentVersion,
            eol: editorContext.eol,
        };

        const previewUri = this.deps.preview.create(editorContext.fileName, editorContext.fullText);
        const previewTitle = `${editorContext.fileName} ↔ DeepSeek 实时预览`;
        try {
            await openDiff(vscode.Uri.parse(editorContext.uri), previewUri, previewTitle);
        } catch (error) {
            this.deps.output.appendLine(`[preview] 无法打开 diff 预览：${String(error)}`);
        }

        const messages = buildEditMessages({
            instruction,
            contextText: context.text,
            history,
            extraSystemPrompt: settings.extraSystemPrompt,
        });

        let lastPreviewAt = 0;
        const renderPreview = (raw: string, force = false): void => {
            const now = Date.now();
            if (!force && now - lastPreviewAt < 70) {
                return;
            }
            lastPreviewAt = now;
            const partial = extractEditReply(raw);
            const code = partial.code ? alignIndent(target.originalText, partial.code, target.eol) : target.originalText;
            this.deps.preview.update(
                previewUri,
                buildPreviewText(editorContext.fullText, target.startOffset, target.endOffset, code)
            );
        };

        let attempt = 0;
        try {
            for (;;) {
                attempt += 1;
                const result = await this.streamCompletion(messages, chatId, messageId, settings, (raw) =>
                    this.composeEditMarkdown(raw, editorContext.languageId)
                );

                const reply = extractEditReply(result.text);
                if (reply.error) {
                    throw new UserFacingError(reply.error);
                }

                target.newText = alignIndent(target.originalText, reply.code, target.eol);
                renderPreview(result.text, true);

                this.setMessage(chatId, messageId, {
                    content: this.composeFinalEdit(reply, editorContext.languageId),
                    reasoning: result.reasoning || undefined,
                    usage: result.usage,
                    model: settings.model,
                    edit: { ...target },
                });
                this.pendingEdits.set(messageId, { ...target });
                this.pushState();

                const decision = await this.askEditDecision();
                if (decision === 'apply') {
                    const applied = await applyEditTarget(target);
                    this.recordApplied(chatId, messageId, applied);
                    break;
                }
                if (decision === 'retry' && attempt < 3) {
                    continue;
                }
                this.pendingEdits.delete(messageId);
                this.setMessage(chatId, messageId, { edit: undefined });
                break;
            }
        } finally {
            this.persist();
            this.pushState();
            await this.deps.preview.closeTab(previewUri);
            this.deps.preview.release(previewUri);
        }
    }

    private composeEditMarkdown(raw: string, languageId: string): string {
        if (!raw.trim()) {
            return '';
        }
        if (raw.includes('```')) {
            return raw;
        }
        return '```' + languageId + '\n' + raw.replace(/\s+$/, '') + '\n```';
    }

    private composeFinalEdit(reply: EditReply, languageId: string): string {
        const block = '```' + languageId + '\n' + reply.code + '\n```';
        return reply.explanation ? `${block}\n\n${reply.explanation}` : block;
    }

    private async askEditDecision(): Promise<'apply' | 'retry' | 'discard'> {
        if (!this.deps.settings().confirmBeforeApply) {
            return 'apply';
        }
        interface DecisionItem extends vscode.QuickPickItem {
            value: 'apply' | 'retry' | 'discard';
        }
        const items: DecisionItem[] = [
            { label: '$(check) 应用修改', description: '写入文件，可随时撤销', value: 'apply' },
            { label: '$(refresh) 重新生成', description: '再让模型改一次', value: 'retry' },
            { label: '$(close) 放弃', description: '不写入文件', value: 'discard' },
        ];
        const picked = await vscode.window.showQuickPick(items, {
            title: 'DeepSeek 定点修改',
            placeHolder: '右侧是实时预览，选择如何处理这次修改',
            ignoreFocusOut: true,
        });
        return picked?.value ?? 'discard';
    }

    private recordApplied(chatId: string, messageId: string, target: EditTarget): void {
        this.setMessage(chatId, messageId, { applied: true, edit: target });
        this.lastEdit = target;
        this.pendingEdits.delete(messageId);
        this.persist();
        this.pushState();
        this.toast('已应用修改，Ctrl+Alt+Z 可撤销');
    }

    async applyLatestPendingEdit(): Promise<void> {
        const chat = this.activeChat();
        for (let index = chat.messages.length - 1; index >= 0; index--) {
            const message = chat.messages[index];
            if (message.edit && !message.applied) {
                await this.applyPendingEdit(message.id);
                return;
            }
        }
        const pending = Array.from(this.pendingEdits.keys()).pop();
        if (pending) {
            await this.applyPendingEdit(pending);
            return;
        }
        this.toast('没有可应用的 DeepSeek 修改。');
    }

    async applyPendingEdit(messageId: string): Promise<void> {
        const chat = this.activeChat();
        const message = chat.messages.find((item) => item.id === messageId);
        const target = message?.edit ?? this.pendingEdits.get(messageId);
        if (!target) {
            this.toast('这条消息没有可应用的修改。');
            return;
        }
        if (message?.applied) {
            this.toast('这条修改已经应用过了。');
            return;
        }
        try {
            const applied = await applyEditTarget(target);
            this.recordApplied(chat.id, messageId, applied);
        } catch (error) {
            this.reportError(error);
            this.setMessage(chat.id, messageId, { error: this.describeError(error) });
            this.pushState();
        }
    }

    async revertLastEdit(): Promise<void> {
        if (!this.lastEdit) {
            this.toast('没有可撤销的 DeepSeek 修改。');
            return;
        }
        try {
            await revertEditTarget(this.lastEdit);
            const uri = this.lastEdit.uri;
            this.lastEdit = undefined;
            for (const chat of this.state.chats) {
                for (const message of chat.messages) {
                    if (message.applied && message.edit?.uri === uri) {
                        this.setMessage(chat.id, message.id, { applied: false, edit: undefined });
                    }
                }
            }
            this.persist();
            this.pushState();
            this.toast('已撤销上一次修改');
        } catch (error) {
            this.reportError(error);
        }
    }

    async retry(messageId: string): Promise<void> {
        if (this.busy) {
            this.toast('正在生成，先点「停止」再重试。');
            return;
        }
        const chat = this.activeChat();
        const index = chat.messages.findIndex((message) => message.id === messageId);
        if (index < 0) {
            return;
        }
        const assistant = chat.messages[index];
        let userIndex = index - 1;
        while (userIndex >= 0 && chat.messages[userIndex].role !== 'user') {
            userIndex -= 1;
        }
        if (userIndex < 0) {
            return;
        }
        const userMessage = chat.messages[userIndex];
        const wasEdit = userMessage.mode === 'edit' || Boolean(assistant.edit);
        const truncated: Chat = { ...chat, messages: chat.messages.slice(0, userIndex) };
        this.state = { ...this.state, chats: this.state.chats.map((item) => (item.id === chat.id ? truncated : item)) };
        this.pushState();
        await this.send(userMessage.content, wasEdit ? 'edit' : 'ask', { includeSelection: true });
    }

    // ---------------------------------------------------------------- 流式请求

    private async streamCompletion(
        messages: ApiMessage[],
        chatId: string,
        messageId: string,
        settings: WorkbenchSettings,
        compose: (content: string) => string
    ): Promise<StreamResult> {
        const apiKey = await this.deps.keys.get();
        if (!apiKey) {
            throw new UserFacingError('还没有配置 DeepSeek API Key。');
        }

        const client = new DeepSeekClient({
            apiKey,
            baseUrl: settings.baseUrl,
            timeoutMs: settings.timeoutMs,
        });
        const controller = new AbortController();
        this.abort = controller;

        let content = '';
        let reasoning = '';
        let lastEmit = 0;
        let usage: Usage | undefined;

        const emit = (final = false): void => {
            const now = Date.now();
            if (!final && now - lastEmit < 50) {
                return;
            }
            lastEmit = now;
            const composed = compose(content);
            this.setMessage(chatId, messageId, { content: composed, reasoning: reasoning || undefined });
            this.streamEmitter.fire({
                messageId,
                html: renderMarkdown(composed),
                reasoningHtml: reasoning ? renderMarkdown(reasoning) : '',
                content: composed,
            });
        };

        const thinking = supportsThinkingToggle(settings.model);
        const result = await client.streamChat(
            {
                model: settings.model,
                messages,
                temperature: settings.temperature,
                maxTokens: settings.maxTokens,
                ...(thinking
                    ? { thinking: { type: (this.thinkingEnabled ? 'enabled' : 'disabled') as 'enabled' | 'disabled' } }
                    : {}),
                ...(thinking && this.thinkingEnabled ? { reasoningEffort: settings.reasoningEffort } : {}),
            },
            {
                onDelta: (piece) => {
                    content += piece;
                    emit();
                },
                onReasoning: (piece) => {
                    reasoning += piece;
                    emit();
                },
                onUsage: (value) => {
                    usage = value;
                },
            },
            controller.signal
        );

        content = result.text || content;
        reasoning = result.reasoning || reasoning;
        emit(true);

        const merged: StreamResult = {
            text: content,
            reasoning,
            usage: result.usage ?? usage,
        };
        if (result.finishReason) {
            merged.finishReason = result.finishReason;
        }
        return merged;
    }

    // ---------------------------------------------------------------- 错误

    private handleError(error: unknown, chatId: string, messageId: string, mode: ChatMode): void {
        if (error instanceof ApiError && error.kind === 'aborted') {
            this.setMessage(chatId, messageId, { error: '已停止生成。' });
            return;
        }
        const message = this.describeError(error);
        this.setMessage(chatId, messageId, { error: message });
        if (error instanceof ApiError) {
            if (error.kind === 'auth') {
                this.notice = { level: 'error', text: 'API Key 无效或已失效，请重新设置。' };
            } else if (error.kind === 'balance') {
                this.notice = { level: 'error', text: '账户余额不足，请充值后再试。' };
            } else if (error.kind === 'rate-limit') {
                this.notice = { level: 'warn', text: '请求过于频繁，请稍后重试。' };
            } else {
                this.notice = { level: 'error', text: message };
            }
        }
        this.deps.output.appendLine(`[${mode}] ${message}`);
    }

    private reportError(error: unknown): void {
        const message = this.describeError(error);
        this.deps.output.appendLine(`[error] ${message}`);
        void vscode.window.showWarningMessage(`DeepSeek：${message}`);
    }

    private describeError(error: unknown): string {
        if (error instanceof ApiError || error instanceof UserFacingError) {
            return error.message;
        }
        if (error instanceof Error) {
            this.deps.output.appendLine(error.stack ?? error.message);
            return error.message || '未知错误。';
        }
        return String(error);
    }
}
