/**
 * 「定点修改」的文本处理：从模型回复里提取替换代码、对齐缩进、合成预览内容。
 * 这里全是纯函数，方便单元测试。
 */

export type Eol = '\n' | '\r\n';

export function detectEol(text: string): Eol {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

/** 把任意换行统一成指定风格。 */
export function normalizeEol(text: string, eol: Eol): string {
    const normalized = text.replace(/\r\n/g, '\n');
    return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

export function indentOf(line: string): string {
    const match = /^[ \t]*/.exec(line);
    return match ? match[0] : '';
}

/** 一段文本里最小的行首缩进（忽略空行）。 */
export function minimalIndent(text: string): string {
    let result: string | undefined;
    for (const line of text.split(/\r?\n/)) {
        if (line.trim().length === 0) {
            continue;
        }
        const indent = indentOf(line);
        if (result === undefined || indent.length < result.length) {
            result = indent;
        }
    }
    return result ?? '';
}

export interface EditReply {
    code: string;
    explanation?: string;
    error?: string;
}

/**
 * 从模型回复中提取「替换代码」。
 * 兼容三种常见输出：纯代码、带 ``` 围栏的代码、围栏前后夹带说明文字。
 */
export function extractEditReply(raw: string): EditReply {
    const text = raw.replace(/\r\n/g, '\n').trim();
    if (!text) {
        return { code: '', error: '模型没有返回任何内容。' };
    }

    const errorMatch = /^(?:\/\/|#|--|<!--)\s*ERROR\s*[:：]\s*([\s\S]*?)(?:-->)?$/i.exec(text);
    if (errorMatch) {
        return { code: '', error: errorMatch[1].trim() || '模型拒绝完成这次修改。' };
    }

    const blocks: string[] = [];
    const fence = /```[^\n`]*\n([\s\S]*?)(?:```|$)/g;
    let match: RegExpExecArray | null;
    while ((match = fence.exec(text)) !== null) {
        blocks.push(match[1]);
        if (match[0].length === 0) {
            break;
        }
    }

    if (blocks.length > 0) {
        const code = blocks.reduce((best, current) => (current.length > best.length ? current : best), blocks[0]);
        const explanation = text
            .replace(fence, '')
            .replace(/```/g, '')
            .trim();
        const result: EditReply = { code: trimCodeEdges(code) };
        if (explanation) {
            result.explanation = explanation;
        }
        if (!result.code.trim()) {
            result.error = '模型返回的代码块为空。';
        }
        return result;
    }

    return { code: trimCodeEdges(text) };
}

function trimCodeEdges(code: string): string {
    return code.replace(/^\n+/, '').replace(/\s+$/, '');
}

/**
 * 把模型给出的替换代码对齐到原选区的缩进层级。
 * 模型经常把整块代码顶格返回，直接替换会破坏缩进，所以这里统一修正。
 */
export function alignIndent(selectionText: string, code: string, eol: Eol = '\n'): string {
    const normalizedCode = normalizeEol(code, '\n').replace(/\s+$/, '');
    if (!normalizedCode.trim()) {
        return '';
    }

    const baseIndent = indentOf(
        selectionText.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
    );
    const codeIndent = minimalIndent(normalizedCode);

    let lines = normalizedCode.split('\n');
    if (baseIndent === codeIndent) {
        return normalizeEol(normalizedCode, eol);
    }

    if (baseIndent.startsWith(codeIndent)) {
        const prefix = baseIndent.slice(codeIndent.length);
        lines = lines.map((line) => (line.trim().length === 0 ? '' : prefix + line));
    } else if (codeIndent.startsWith(baseIndent)) {
        const strip = codeIndent.slice(baseIndent.length);
        lines = lines.map((line) => (line.startsWith(strip) ? line.slice(strip.length) : line));
    } else {
        lines = lines.map((line) => (line.trim().length === 0 ? '' : baseIndent + line));
    }

    return normalizeEol(lines.join('\n'), eol);
}

/** 用替换文本合成「预览后的完整文档」，不修改任何文件。 */
export function buildPreviewText(fullText: string, startOffset: number, endOffset: number, replacement: string): string {
    const start = Math.max(0, Math.min(startOffset, fullText.length));
    const end = Math.max(start, Math.min(endOffset, fullText.length));
    return fullText.slice(0, start) + replacement + fullText.slice(end);
}

/** 该位置是否真的被本次修改替换掉了（用于安全撤销）。 */
export function matchesApplied(documentText: string, startOffset: number, newText: string): boolean {
    if (startOffset < 0 || startOffset + newText.length > documentText.length) {
        return false;
    }
    return documentText.slice(startOffset, startOffset + newText.length) === newText;
}
