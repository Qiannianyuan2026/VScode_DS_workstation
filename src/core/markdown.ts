/**
 * 极简 Markdown → 安全 HTML 渲染器。
 *
 * 只支持聊天里真正会出现的语法：围栏代码块、标题、列表、引用、行内代码、
 * 粗体/斜体/删除线、链接。所有文本先做 HTML 转义，再拼标签，
 * 因此模型输出里即使有 <script> 也只会显示成文本。
 */

const FENCE = /^\s*```(\S*)\s*$/;

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(text: string): string {
    return escapeHtml(text).replace(/`/g, '&#96;');
}

/** 流式输出时围栏可能还没闭合，补一个结尾让渲染不抖动。 */
export function balanceFences(source: string): string {
    const count = (source.match(/^\s*```/gm) ?? []).length;
    return count % 2 === 1 ? `${source}\n\`\`\`` : source;
}

const SAFE_URL = /^(https?:|mailto:)/i;

function renderInline(text: string): string {
    const codeSpans: string[] = [];
    let work = text.replace(/`([^`\n]+)`/g, (_all, code: string) => {
        codeSpans.push(`<code>${escapeHtml(code)}</code>`);
        return `\u0000${codeSpans.length - 1}\u0000`;
    });

    work = escapeHtml(work);

    // 链接：仅允许 http(s) / mailto，避免 javascript: 注入
    work = work.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_all, label: string, rawHref: string) => {
        const href = rawHref.replace(/&amp;/g, '&');
        if (!SAFE_URL.test(href)) {
            return label;
        }
        return `<a href="${escapeAttribute(href)}" rel="noopener noreferrer">${label}</a>`;
    });

    work = work
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[\s(（【])[*_]([^*_\n]+)[*_](?=$|[\s)）】，。,.!?！？:：;；])/g, '$1<em>$2</em>')
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    work = work.replace(/\u0000(\d+)\u0000/g, (_all, index: string) => codeSpans[Number(index)] ?? '');
    return work;
}

function renderCodeBlock(language: string, code: string): string {
    const lang = language.replace(/[^\w+#.-]/g, '').slice(0, 24);
    const langLabel = lang || 'text';
    return (
        '<div class="code">' +
        `<div class="code-bar"><span class="lang">${escapeHtml(langLabel)}</span>` +
        '<span class="code-actions">' +
        '<button type="button" data-act="copy" data-code>复制</button>' +
        '<button type="button" data-act="insert" data-code>插入</button>' +
        '<button type="button" data-act="replace" data-code>替换选区</button>' +
        '</span></div>' +
        `<pre><code class="language-${escapeAttribute(langLabel)}">${escapeHtml(code)}</code></pre>` +
        '</div>'
    );
}

interface BlockState {
    kind: 'paragraph' | 'list' | 'quote' | null;
    lines: string[];
    listOrdered: boolean;
}

export function renderMarkdown(source: string): string {
    const text = balanceFences(source.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    const lines = text.split('\n');
    const out: string[] = [];
    const state: BlockState = { kind: null, lines: [], listOrdered: false };

    const flush = (): void => {
        if (state.kind === 'paragraph' && state.lines.length > 0) {
            out.push(`<p>${state.lines.map(renderInline).join('<br>')}</p>`);
        } else if (state.kind === 'list' && state.lines.length > 0) {
            const tag = state.listOrdered ? 'ol' : 'ul';
            out.push(`<${tag}>${state.lines.map((line) => `<li>${renderInline(line)}</li>`).join('')}</${tag}>`);
        } else if (state.kind === 'quote' && state.lines.length > 0) {
            out.push(`<blockquote>${state.lines.map(renderInline).join('<br>')}</blockquote>`);
        }
        state.kind = null;
        state.lines = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const fence = FENCE.exec(line);
        if (fence) {
            flush();
            const language = fence[1] ?? '';
            const body: string[] = [];
            i++;
            while (i < lines.length && !FENCE.test(lines[i])) {
                body.push(lines[i]);
                i++;
            }
            out.push(renderCodeBlock(language, body.join('\n')));
            continue;
        }

        if (line.trim() === '') {
            flush();
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            flush();
            const level = heading[1].length;
            out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
            continue;
        }

        if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
            flush();
            out.push('<hr>');
            continue;
        }

        const quoteLine = /^\s*>\s?(.*)$/.exec(line);
        if (quoteLine) {
            if (state.kind !== 'quote') {
                flush();
                state.kind = 'quote';
            }
            state.lines.push(quoteLine[1]);
            continue;
        }

        const listItem = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
        if (listItem) {
            const ordered = Boolean(listItem[2]);
            if (state.kind !== 'list' || state.listOrdered !== ordered) {
                flush();
                state.kind = 'list';
                state.listOrdered = ordered;
            }
            state.lines.push(listItem[3]);
            continue;
        }

        if (state.kind !== 'paragraph') {
            flush();
            state.kind = 'paragraph';
        }
        state.lines.push(line.trim());
    }

    flush();
    return out.join('\n');
}

/** 聊天里展示用：把纯文本压成一行标题。 */
export function plainText(markdown: string): string {
    return markdown
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[#>*_`~-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
