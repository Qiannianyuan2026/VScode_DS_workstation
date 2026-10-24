const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { JSDOM } = require('jsdom');

// html.ts 依赖 vscode.Uri.joinPath，因此同样接上本地桩
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') {
        return path.join(__dirname, 'vscode-stub.js');
    }
    return originalResolveFilename.call(this, request, ...rest);
};

const vscode = require('vscode');
const { getWebviewHtml } = require('../dist/vscode/html.js');

const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'workbench.js'), 'utf8');

function buildDom() {
    const posted = [];
    const webview = {
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri) => uri,
    };
    const html = getWebviewHtml(webview, vscode.Uri.file('D:/DS_work'));
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://webview.test/' });
    dom.window.acquireVsCodeApi = () => ({
        postMessage: (message) => {
            posted.push(message);
        },
        getState: () => undefined,
        setState: () => undefined,
    });
    dom.window.eval(script);
    return { dom, posted, window: dom.window, document: dom.window.document };
}

function post(window, data) {
    window.dispatchEvent(new window.MessageEvent('message', { data }));
}

function state(overrides = {}) {
    return {
        chats: [{ id: 'c1', title: '会话一', updatedAt: Date.now(), messageCount: 2 }],
        activeChatId: 'c1',
        messages: [
            {
                id: 'm1',
                role: 'user',
                content: '帮我看看这段',
                html: '<p>帮我看看这段</p>',
                createdAt: Date.now(),
                contextLabel: 'a.ts:2-4',
            },
            {
                id: 'm2',
                role: 'assistant',
                content: '```ts\nconst a = 1;\n```',
                html: '<div class="code"><div class="code-bar"><span class="lang">ts</span><span class="code-actions"><button type="button" data-act="copy" data-code>复制</button><button type="button" data-act="insert" data-code>插入</button><button type="button" data-act="replace" data-code>替换选区</button></span></div><pre><code class="language-ts">const a = 1;</code></pre></div>',
                createdAt: Date.now(),
                model: 'deepseek-flash',
                usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
                cost: { label: '¥0.003', tooltip: '输入 3 tokens（缓存命中 0，未命中 3）· 输出 2 tokens · 谷时价' },
            },
        ],
        model: 'deepseek-flash',
        models: [
            { id: 'deepseek-flash', label: 'V4.1 Flash' },
            { id: 'deepseek-v4-pro', label: 'V4 Pro' },
        ],
        hasKey: true,
        busy: false,
        mode: 'ask',
        thinkingAvailable: true,
        thinking: true,
        chatCostLabel: '本会话 ¥0.003',
        context: { fileName: 'a.ts', languageId: 'typescript', lineCount: 4, selection: { startLine: 2, endLine: 4, text: '' } },
        ...overrides,
    };
}

test('Webview 启动即发送 ready，并按状态渲染消息、模型与上下文', () => {
    const { posted, window, document } = buildDom();
    assert.equal(posted[0].type, 'ready');

    post(window, { type: 'state', state: state() });

    assert.equal(document.querySelectorAll('article.msg').length, 2);
    assert.match(document.querySelector('.msg-user .msg-body').innerHTML, /帮我看看这段/);
    assert.match(document.querySelector('.msg-assistant .code').textContent, /const a = 1/);
    assert.match(document.querySelector('.msg-foot').textContent, /5 tokens/);
    assert.match(document.querySelector('.msg-foot .cost').textContent, /¥0\.003/);
    assert.match(document.querySelector('.msg-foot .cost').getAttribute('title'), /缓存命中/);
    assert.match(document.getElementById('context-bar').textContent, /本会话 ¥0\.003/);
    assert.equal(document.getElementById('model').value, 'deepseek-flash');
    assert.match(document.getElementById('model').textContent, /V4\.1 Flash/);
    assert.match(document.getElementById('context-bar').textContent, /a\.ts/);
    assert.match(document.getElementById('context-bar').textContent, /选区 2-4/);
    assert.equal(document.getElementById('key-warning').classList.contains('hidden'), true);
});

test('空会话展示建议卡片，点击后填入输入框并切换模式', () => {
    const { posted, window, document } = buildDom();
    post(window, { type: 'state', state: state({ messages: [], chats: [] }) });

    const suggestions = document.querySelectorAll('.suggestions button');
    assert.ok(suggestions.length >= 3);
    suggestions[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    assert.equal(document.getElementById('input').value, suggestions[2].dataset.text);
    assert.ok(posted.some((message) => message.type === 'setMode' && message.mode === 'edit'));
});

test('发送消息：带上模式、选区与整份文件开关', () => {
    const { posted, window, document } = buildDom();
    post(window, { type: 'state', state: state() });

    document.getElementById('input').value = '  这段代码有什么问题？ ';
    document.getElementById('attach-file').checked = true;
    document.getElementById('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const sent = posted.find((message) => message.type === 'send');
    assert.ok(sent);
    assert.equal(sent.text, '这段代码有什么问题？');
    assert.equal(sent.mode, 'ask');
    assert.equal(sent.includeSelection, true);
    assert.equal(sent.includeFile, true);
    assert.equal(document.getElementById('input').value, '');

    post(window, { type: 'state', state: state({ busy: true }) });
    assert.equal(document.getElementById('stop').classList.contains('hidden'), false);
    assert.equal(document.getElementById('send').classList.contains('hidden'), true);
});

test('Enter 发送、Shift+Enter 换行、Esc 停止', () => {
    const { posted, window, document } = buildDom();
    post(window, { type: 'state', state: state() });

    const input = document.getElementById('input');
    input.value = '继续';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.ok(posted.some((message) => message.type === 'send'));

    post(window, { type: 'state', state: state({ busy: true }) });
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(posted.some((message) => message.type === 'stop'));
});

test('流式增量更新正文，思考过程追加折叠块', () => {
    const { window, document } = buildDom();
    post(window, { type: 'state', state: state({ messages: [state().messages[0]], busy: true }) });

    post(window, {
        type: 'state',
        state: state({ messages: [state().messages[0], { ...state().messages[1], html: '<p>部分</p>', content: '' }], busy: true }),
    });
    post(window, { type: 'delta', messageId: 'm2', html: '<p>正在输出…</p>', reasoningHtml: '<p>先想一想</p>' });

    const assistant = document.querySelectorAll('article.msg')[1];
    assert.match(assistant.querySelector('.msg-body').innerHTML, /正在输出/);
    assert.match(assistant.querySelector('details.reasoning').textContent, /先想一想/);
});

test('代码块按钮把代码回传给扩展；应用与撤销按钮带消息 id', () => {
    const { posted, window, document } = buildDom();
    post(window, {
        type: 'state',
        state: state({
            messages: [
                { ...state().messages[1], canApply: true },
            ],
        }),
    });

    const copy = document.querySelector('button[data-act="copy"]');
    copy.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(posted.find((message) => message.type === 'copy').code, 'const a = 1;');

    const apply = document.querySelector('button[data-act="apply"]');
    apply.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(posted.find((message) => message.type === 'applyLastEdit').messageId, 'm2');

    post(window, { type: 'state', state: state({ messages: [{ ...state().messages[1], applied: true }] }) });
    const revert = document.querySelector('button[data-act="revert"]');
    revert.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.ok(posted.some((message) => message.type === 'revertLastEdit'));
});

test('历史面板：切换与删除会话', () => {
    const { posted, window, document } = buildDom();
    post(window, { type: 'state', state: state() });

    document.getElementById('history-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(document.getElementById('history-panel').classList.contains('hidden'), false);

    document.querySelector('.history-item').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(posted.find((message) => message.type === 'selectChat').id, 'c1');
    assert.equal(document.getElementById('history-panel').classList.contains('hidden'), true);

    document.getElementById('history-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    document.querySelector('.history-del').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(posted.find((message) => message.type === 'deleteChat').id, 'c1');
});

test('未配置 Key 时展示警告并可点击设置；错误消息显示重试', () => {
    const { posted, window, document } = buildDom();
    post(window, { type: 'state', state: state({ hasKey: false, notice: { level: 'warn', text: '还没有配置 API Key' } }) });

    const warning = document.getElementById('key-warning');
    assert.equal(warning.classList.contains('hidden'), false);
    warning.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.ok(posted.some((message) => message.type === 'setKey'));

    post(window, {
        type: 'state',
        state: state({ messages: [{ ...state().messages[1], error: '请求失败', canApply: false }] }),
    });
    assert.match(document.querySelector('.msg-error').textContent, /请求失败/);
    document.querySelector('button[data-act="retry"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(posted.find((message) => message.type === 'retry').messageId, 'm2');
});

test('深度思考开关：V4 可见可切换，旧模型隐藏', () => {
    const { posted, window, document } = buildDom();
    post(window, { type: 'state', state: state() });

    const wrap = document.getElementById('thinking-wrap');
    const box = document.getElementById('thinking');
    assert.equal(wrap.classList.contains('hidden'), false);
    assert.equal(box.checked, true);

    box.checked = false;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    const message = posted.find((item) => item.type === 'setThinking');
    assert.equal(message.value, false);

    post(window, { type: 'state', state: state({ model: 'my-gateway-model', thinkingAvailable: false }) });
    assert.equal(wrap.classList.contains('hidden'), true);
});

test('顶栏「切换文件」按钮把请求交给扩展', () => {
    const { posted, window, document } = buildDom();
    post(window, { type: 'state', state: state() });

    const button = document.getElementById('open-file');
    assert.ok(button);
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.ok(posted.some((message) => message.type === 'openFile'));
});

test('草稿消息填入输入框并聚焦；选区变化不会重建消息列表', () => {
    const { window, document } = buildDom();
    post(window, { type: 'state', state: state() });
    const firstArticle = document.querySelector('article.msg');

    post(window, { type: 'state', state: state({ context: { fileName: 'b.ts', languageId: 'typescript', lineCount: 10 } }) });
    assert.equal(document.querySelector('article.msg'), firstArticle, '仅上下文变化时不应重建 DOM');

    post(window, { type: 'draft', text: '解释一下这个函数' });
    assert.equal(document.getElementById('input').value, '解释一下这个函数');
});
