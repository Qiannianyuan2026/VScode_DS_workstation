/** 共享类型定义（核心层，不依赖 vscode）。 */

export type Role = 'system' | 'user' | 'assistant';

export interface Usage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** 命中上下文缓存的输入 token（单价更低）。 */
    cacheHitTokens?: number;
    /** 未命中缓存的输入 token。 */
    cacheMissTokens?: number;
}

export interface ChatMessage {
    id: string;
    role: Role;
    /** 原始 markdown 文本（不含 HTML，便于持久化和重新渲染）。 */
    content: string;
    /** 思考模式返回的推理内容。 */
    reasoning?: string;
    createdAt: number;
    model?: string;
    usage?: Usage;
    error?: string;
    /** 该条消息附带的选区/文件上下文标签，用于界面展示。 */
    contextLabel?: string;
    /** 生成该条修改时锁定的编辑目标，供“应用/撤销”使用。 */
    edit?: EditTarget;
    /** 该条修改是否已经写入文件。 */
    applied?: boolean;
    /** 用户消息对应的交互模式，重试时沿用。 */
    mode?: 'ask' | 'edit';
}

export interface Chat {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ChatMessage[];
}

export interface ChatSummary {
    id: string;
    title: string;
    updatedAt: number;
    messageCount: number;
}

/** 一次定点修改锁定的目标位置。 */
export interface EditTarget {
    uri: string;
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
    originalText: string;
    newText: string;
    documentVersion: number;
    eol: '\n' | '\r\n';
}

export interface SelectionInfo {
    startLine: number;
    endLine: number;
    startCharacter: number;
    endCharacter: number;
}

export interface ContextSnapshot {
    /** 发送给模型的上下文字符串。 */
    text: string;
    /** 界面展示用的简短标签。 */
    label: string;
    /** 若上下文来自选区，记录编辑器信息用于定点修改。 */
    editor?: {
        uri: string;
        fileName: string;
        languageId: string;
        documentVersion: number;
        selection?: SelectionInfo;
        fullText: string;
        eol: '\n' | '\r\n';
        startOffset: number;
        endOffset: number;
    };
}

export interface ApiMessage {
    role: Role;
    content: string;
}

export interface StreamHandlers {
    onDelta?: (text: string) => void;
    onReasoning?: (text: string) => void;
    onUsage?: (usage: Usage) => void;
}

export interface StreamResult {
    text: string;
    reasoning: string;
    usage?: Usage;
    finishReason?: string;
}
