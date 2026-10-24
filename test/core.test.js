const { test } = require('node:test');
const assert = require('node:assert/strict');

const { escapeHtml, renderMarkdown, balanceFences } = require('../dist/core/markdown.js');
const { alignIndent, extractEditReply, buildPreviewText, matchesApplied, detectEol, normalizeEol } = require('../dist/core/edit.js');
const { buildAskMessages, buildEditMessages, numberLines, truncateMiddle, renderEditorContext } = require('../dist/core/prompt.js');
const { createChat, addMessage, createMessage, historyToApiMessages, parseState, pruneChats, titleFromText } = require('../dist/core/store.js');

test('escapeHtml 拦住脚本注入', () => {
    assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

test('renderMarkdown 渲染代码块、粗体和列表', () => {
    const html = renderMarkdown('**重点**\n\n- 甲\n- 乙\n\n```ts\nconst a = 1 < 2;\n```');
    assert.match(html, /<strong>重点<\/strong>/);
    assert.match(html, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
    assert.match(html, /<div class="code">/);
    assert.match(html, /const a = 1 &lt; 2;/);
    assert.match(html, /data-act="replace"/);
});

test('renderMarkdown 不执行原始 HTML，且过滤 javascript: 链接', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [点我](javascript:alert(1)) [官网](https://example.com)');
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('javascript:'));
    assert.match(html, /href="https:\/\/example\.com"/);
});

test('渲染进行中的未闭合围栏不报错', () => {
    const partial = '看这里：\n```ts\nconst x = 1;';
    assert.equal(balanceFences(partial).split('```').length % 2, 1);
    const html = renderMarkdown(partial);
    assert.match(html, /const x = 1;/);
});

test('extractEditReply 支持纯代码、围栏代码和说明文字', () => {
    assert.deepEqual(extractEditReply('const a = 1;').code, 'const a = 1;');

    const fenced = extractEditReply('这是改法：\n```js\nfunction f() {\n  return 1;\n}\n```\n说明完毕');
    assert.equal(fenced.code, 'function f() {\n  return 1;\n}');
    assert.match(fenced.explanation, /这是改法/);
    assert.match(fenced.explanation, /说明完毕/);

    const multi = extractEditReply('```ts\na\n```\n```ts\nbb\n```');
    assert.equal(multi.code, 'bb');
});

test('extractEditReply 识别 ERROR 与空回复', () => {
    assert.match(extractEditReply('// ERROR: 需要补充依赖').error, /需要补充依赖/);
    assert.match(extractEditReply('# ERROR: 缺少上下文').error, /缺少上下文/);
    assert.match(extractEditReply('   ').error, /没有返回任何内容/);
    assert.match(extractEditReply('```ts\n```').error, /代码块为空/);
});

test('alignIndent 把顶格代码对齐到选区缩进', () => {
    const selection = '        if (a) {\n            b();\n        }';
    const code = 'if (a) {\n    b();\n    c();\n}';
    const aligned = alignIndent(selection, code, '\n');
    assert.equal(aligned, '        if (a) {\n            b();\n            c();\n        }');
});

test('alignIndent 去掉模型多给的缩进', () => {
    const selection = '    const a = 1;';
    const code = '        const a = 2;';
    assert.equal(alignIndent(selection, code, '\n'), '    const a = 2;');
});

test('alignIndent 保留 CRLF 文件换行风格', () => {
    const result = alignIndent('    a();', 'a();\nb();', '\r\n');
    assert.equal(result, '    a();\r\n    b();');
});

test('buildPreviewText / matchesApplied 合成预览并可校验落盘', () => {
    const doc = 'line1\nline2\nline3\n';
    const start = doc.indexOf('line2');
    const end = start + 'line2'.length;
    const preview = buildPreviewText(doc, start, end, 'LINE-TWO');
    assert.equal(preview, 'line1\nLINE-TWO\nline3\n');
    assert.equal(matchesApplied(preview, start, 'LINE-TWO'), true);
    assert.equal(matchesApplied(preview, start, 'other'), false);
});

test('detectEol / normalizeEol', () => {
    assert.equal(detectEol('a\r\nb'), '\r\n');
    assert.equal(detectEol('a\nb'), '\n');
    assert.equal(normalizeEol('a\r\nb', '\n'), 'a\nb');
    assert.equal(normalizeEol('a\nb', '\r\n'), 'a\r\nb');
});

test('numberLines 生成带行号的上下文', () => {
    assert.equal(numberLines('a\nb', 9), ' 9 | a\n10 | b');
});

test('truncateMiddle 保留头尾', () => {
    const text = 'A'.repeat(100) + 'B'.repeat(100);
    const result = truncateMiddle(text, 40);
    assert.ok(result.length < 160);
    assert.match(result, /中间省略/);
    assert.ok(result.startsWith('A'));
    assert.ok(result.endsWith('B'));
});

test('buildEditMessages 要求只输出替换代码', () => {
    const messages = buildEditMessages({
        instruction: '改成 async',
        contextText: '### 选中的代码\n```ts\nfoo();\n```',
    });
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /只输出替换代码/);
    assert.match(messages.at(-1).content, /改成 async/);
    assert.match(messages.at(-1).content, /选中的代码/);
});

test('buildAskMessages 拼上自定义系统提示', () => {
    const messages = buildAskMessages({ question: '这是干什么的？', extraSystemPrompt: '回答不超过 3 行' });
    assert.match(messages[0].content, /回答不超过 3 行/);
    assert.equal(messages.at(-1).content, '这是干什么的？');
});

test('renderEditorContext 标注行号与相对路径', () => {
    const text = renderEditorContext({
        fileName: 'a.ts',
        relativePath: 'src/a.ts',
        languageId: 'typescript',
        startLine: 3,
        endLine: 4,
        selectedText: 'x();\ny();',
        beforeContext: 'before',
        afterContext: 'after',
    });
    assert.match(text, /src\/a\.ts/);
    assert.match(text, /第 3-4 行/);
    assert.match(text, /3 \| x\(\);/);
    assert.match(text, /### 选区下文/);
});

test('会话存储：标题、消息与历史裁剪', () => {
    let chat = createChat();
    chat = addMessage(chat, createMessage('user', '请帮我优化一下这个函数，它太慢了而且不好读'));
    assert.match(chat.title, /请帮我优化/);

    chat = addMessage(chat, createMessage('assistant', '好的'));
    chat = addMessage(chat, createMessage('user', '继续'));
    assert.equal(chat.messages.length, 3);
    assert.equal(titleFromText('   '), '新对话');

    const history = historyToApiMessages(chat, { maxTurns: 1, maxChars: 10_000 });
    assert.deepEqual(history.map((item) => item.role), ['assistant', 'user']);
});

test('会话存储：丢弃出错消息且按预算截断', () => {
    let chat = createChat();
    chat = addMessage(chat, createMessage('user', 'a'.repeat(100)));
    chat = addMessage(chat, createMessage('assistant', 'b'.repeat(100)));
    chat = addMessage(chat, createMessage('user', 'c'.repeat(100)));
    const history = historyToApiMessages(chat, { maxTurns: 5, maxChars: 250 });
    assert.equal(history.length, 2);
    assert.equal(history.at(-1).content, 'c'.repeat(100));
});

test('parseState 容忍损坏数据', () => {
    const fallback = parseState(null);
    assert.equal(fallback.chats.length, 1);
    assert.equal(fallback.activeChatId, fallback.chats[0].id);

    // 会话数据损坏时重建，但保留用户选择的模型
    const broken = parseState({ version: 1, chats: [{ id: 'x', messages: 'nope' }], model: 'deepseek-v4-pro' });
    assert.equal(broken.chats.length, 1);
    assert.equal(broken.model, 'deepseek-v4-pro');

    const good = parseState({
        version: 1,
        model: 'deepseek-v4-pro',
        chats: [{ id: 'c1', title: 't', createdAt: 1, updatedAt: 2, messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }] }],
        activeChatId: 'c1',
    });
    assert.equal(good.model, 'deepseek-v4-pro');
    assert.equal(good.chats[0].messages.length, 1);
});

test('pruneChats 按更新时间保留最近的会话', () => {
    const chats = Array.from({ length: 5 }, (_, index) => ({
        id: `c${index}`,
        title: `t${index}`,
        createdAt: index,
        updatedAt: index,
        messages: [],
    }));
    assert.deepEqual(pruneChats(chats, 2).map((chat) => chat.id), ['c4', 'c3']);
});
