import type { ChatMessage, ChatSummary, Usage } from './types';

export type ChatMode = 'ask' | 'edit';

export interface ContextInfo {
    fileName: string;
    languageId: string;
    lineCount: number;
    selection?: { startLine: number; endLine: number; text: string };
}

export interface DisplayMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    html: string;
    content: string;
    reasoningHtml?: string;
    error?: string;
    usage?: Usage;
    model?: string;
    createdAt: number;
    contextLabel?: string;
    pending?: boolean;
    /** 该条助手消息已经产出了可应用的定点修改。 */
    canApply?: boolean;
    /** 该条修改已经写入文件。 */
    applied?: boolean;
    /** 本次请求的花费展示（金额 + hover 明细）。 */
    cost?: { label: string; tooltip: string };
}

export interface WorkbenchState {
    chats: ChatSummary[];
    activeChatId: string | null;
    messages: DisplayMessage[];
    model: string;
    models: Array<{ id: string; label: string }>;
    hasKey: boolean;
    busy: boolean;
    context: ContextInfo | null;
    mode: ChatMode;
   /** 当前模型是否支持开关思考模式（V4 / Flash）。 */
    thinkingAvailable: boolean;
    /** 当前思考模式是否开启。 */
    thinking: boolean;
    /** 当前会话累计花费，例如「本会话 ¥0.015」；为 0 时为空串。 */
    chatCostLabel: string;
    notice?: { level: 'info' | 'warn' | 'error'; text: string } | undefined;
}

export type HostToWebview =
    | { type: 'state'; state: WorkbenchState }
    | { type: 'delta'; messageId: string; html: string; reasoningHtml: string; plain: string }
    | { type: 'done'; messageId: string; message: DisplayMessage }
    | { type: 'busy'; value: boolean }
    | { type: 'toast'; text: string }
    | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
    | { type: 'focusInput' }
    | { type: 'draft'; text: string };

export type WebviewToHost =
    | { type: 'ready' }
    | { type: 'send'; text: string; mode: ChatMode; includeSelection: boolean; includeFile: boolean }
    | { type: 'stop' }
    | { type: 'newChat' }
    | { type: 'selectChat'; id: string }
    | { type: 'deleteChat'; id: string }
    | { type: 'setModel'; model: string }
    | { type: 'insertCode'; code: string }
    | { type: 'replaceSelection'; code: string }
    | { type: 'copy'; code: string }
    | { type: 'setKey' }
    | { type: 'openSettings' }
    | { type: 'retry'; messageId: string }
    | { type: 'applyLastEdit'; messageId: string }
    | { type: 'revertLastEdit' }
    | { type: 'setMode'; mode: ChatMode }
    | { type: 'setThinking'; value: boolean }
    | { type: 'refreshModels' }
    | { type: 'openFile' }
    | { type: 'askSelection' };

/** 把一条聊天记录转成界面展示对象（HTML 在这里渲染，Webview 只负责插入）。 */
export function toDisplayMessage(
    message: ChatMessage,
    options: { render: (markdown: string) => string; reasonPrefix?: string } = { render: (text) => text }
): DisplayMessage {
    const display: DisplayMessage = {
        id: message.id,
        role: message.role,
        html: options.render(message.content),
        content: message.content,
        createdAt: message.createdAt,
    };
    if (message.reasoning) {
        display.reasoningHtml = options.render(message.reasoning);
    }
    if (message.error) {
        display.error = message.error;
    }
    if (message.usage) {
        display.usage = message.usage;
    }
    if (message.model) {
        display.model = message.model;
    }
    if (message.contextLabel) {
        display.contextLabel = message.contextLabel;
    }
    if (message.edit) {
        display.canApply = !message.applied;
    }
    if (message.applied) {
        display.applied = true;
    }
    return display;
}
