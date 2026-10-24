import type { ApiMessage } from './types';

export const ASK_SYSTEM_PROMPT = [
    '你是嵌入在 VS Code 中的 DeepSeek 编程助手，工作在「工作台」侧边栏里，帮助用户在真实项目中读懂代码、定位缺陷、给出可直接落地的方案。',
    '',
    '回答要求：',
    '- 用中文回答，先给结论再展开；不要重复粘贴用户已提供的代码。',
    '- 提到具体位置时写成「相对路径:行号」，并说明为什么这样改。',
    '- 代码块必须标注语言，改动尽量小而完整。',
    '- 用户信息不足时直接问一个最关键的问题，不要猜测后长篇大论。',
    '- 涉及你不确定的 API 时明确说「不确定」，禁止编造。',
].join('\n');

export const EDIT_SYSTEM_PROMPT = [
    '你是 DeepSeek 工作台的「定点修改」引擎。用户选中了一段代码并给出修改要求，你只需要输出用来替换这段选区的代码。',
    '',
    '输出规则（非常重要）：',
    '1. 只输出替换代码本身：不要解释、不要前后说明、不要 Markdown 围栏。',
    '2. 首行不要额外缩进，宿主会自动对齐选区缩进；不要改动选区之外的代码。',
    '3. 保持原文件的代码风格：命名习惯、引号、分号、空行都与周边一致。',
    '4. 做最小必要改动，不需要改的行原样保留，让 diff 保持干净。',
    '5. 如果还必须改动选区之外的其它文件，在代码第一行用注释说明，例如：// 注意：还需要同步修改 xxx.ts 中的 yyy。',
    '6. 无法完成时只输出一行：// ERROR: 具体原因',
].join('\n');

export function applyExtraSystemPrompt(base: string, extra: string | undefined): string {
    const trimmed = (extra ?? '').trim();
    return trimmed ? `${base}\n\n# 用户自定义要求\n${trimmed}` : base;
}

/** 给代码加行号，让模型能精确定位。 */
export function numberLines(text: string, startLineNumber: number): string {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const width = String(startLineNumber + lines.length - 1).length;
    return lines
        .map((line, index) => `${String(startLineNumber + index).padStart(width, ' ')} | ${line}`)
        .join('\n');
}

/** 超长文本从中间截断，同时保留头尾结构。 */
export function truncateMiddle(text: string, maxChars: number): string {
    if (maxChars <= 0 || text.length <= maxChars) {
        return text;
    }
    const headChars = Math.floor(maxChars * 0.65);
    const tailChars = maxChars - headChars;
    const head = text.slice(0, headChars);
    const tail = text.slice(text.length - tailChars);
    return `${head}\n...（中间省略 ${text.length - maxChars} 个字符）...\n${tail}`;
}

export interface EditorContextParts {
    fileName: string;
    relativePath?: string;
    languageId: string;
    startLine: number;
    endLine: number;
    selectedText: string;
    beforeContext?: string;
    afterContext?: string;
    fullFileText?: string;
    cursorLine?: number;
}

/** 把编辑器上下文渲染成模型可读的文本块。 */
export function renderEditorContext(parts: EditorContextParts): string {
    const path = parts.relativePath && parts.relativePath !== parts.fileName
        ? `${parts.fileName}（工作区相对路径：${parts.relativePath}）`
        : parts.fileName;
    const sections: string[] = ['## 当前编辑器上下文', `文件：${path}`, `语言：${parts.languageId}`];

    if (typeof parts.cursorLine === 'number') {
        sections.push(`光标行：${parts.cursorLine}`);
    }

    sections.push(`选区：第 ${parts.startLine}-${parts.endLine} 行（共 ${parts.selectedText.split('\n').length} 行）`);
    sections.push('', '### 选中的代码', '```' + parts.languageId, numberLines(parts.selectedText, parts.startLine), '```');

    if (parts.beforeContext && parts.beforeContext.trim()) {
        sections.push('', '### 选区上文', '```' + parts.languageId, parts.beforeContext.replace(/\s+$/, ''), '```');
    }
    if (parts.afterContext && parts.afterContext.trim()) {
        sections.push('', '### 选区下文', '```' + parts.languageId, parts.afterContext.replace(/^\s+/, ''), '```');
    }
    if (parts.fullFileText && parts.fullFileText.trim()) {
        sections.push('', '### 完整文件（供参考，不要整体重写）', '```' + parts.languageId, parts.fullFileText, '```');
    }

    return sections.join('\n');
}

export interface AskPromptInput {
    question: string;
    contextText?: string;
    history?: ApiMessage[];
    extraSystemPrompt?: string;
}

export function buildAskMessages(input: AskPromptInput): ApiMessage[] {
    const messages: ApiMessage[] = [
        { role: 'system', content: applyExtraSystemPrompt(ASK_SYSTEM_PROMPT, input.extraSystemPrompt) },
    ];
    if (input.history) {
        messages.push(...input.history);
    }
    const body = input.contextText
        ? `${input.contextText}\n\n## 我的问题\n${input.question.trim()}`
        : input.question.trim();
    messages.push({ role: 'user', content: body });
    return messages;
}

export interface EditPromptInput {
    instruction: string;
    contextText: string;
    history?: ApiMessage[];
    extraSystemPrompt?: string;
}

export function buildEditMessages(input: EditPromptInput): ApiMessage[] {
    const messages: ApiMessage[] = [
        { role: 'system', content: applyExtraSystemPrompt(EDIT_SYSTEM_PROMPT, input.extraSystemPrompt) },
    ];
    if (input.history) {
        messages.push(...input.history);
    }
    messages.push({
        role: 'user',
        content: [
            input.contextText,
            '',
            '## 修改要求',
            input.instruction.trim(),
            '',
            '请直接输出替换「选中的代码」的完整代码。',
        ].join('\n'),
    });
    return messages;
}

/** 粗略估算 token 数，仅用于界面提示（中文约 1.5 字/token）。 */
export function estimateTokens(text: string): number {
    let tokens = 0;
    for (const char of text) {
        tokens += /[\u4e00-\u9fff\u3000-\u303f]/.test(char) ? 0.7 : 0.25;
    }
    return Math.ceil(tokens);
}
