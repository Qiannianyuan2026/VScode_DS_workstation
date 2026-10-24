const Module = require('node:module');
const path = require('node:path');

// 把 'vscode' 解析到本地桩，扩展代码按真实模块加载
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') {
        return path.join(__dirname, 'vscode-stub.js');
    }
    return originalResolveFilename.call(this, request, ...rest);
};

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('vscode');
const helpers = vscode.__helpers;
const { activate } = require('../dist/extension.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (predicate()) {
            return;
        }
        await delay(10);
    }
    throw new Error(`等待超时：${label}`);
}

function makeMemento() {
    const map = new Map();
    return {
        get: (key, fallback) => (map.has(key) ? map.get(key) : fallback),
        update: async (key, value) => {
            map.set(key, value);
        },
        keys: () => [...map.keys()],
        setKeysForSync() {},
        _map: map,
    };
}

function makeSecrets(initial = {}) {
    const map = new Map(Object.entries(initial));
    const emitter = new vscode.EventEmitter();
    return {
        map,
        get: async (key) => map.get(key),
        store: async (key, value) => {
            map.set(key, value);
            emitter.fire({ key });
        },
        delete: async (key) => {
            map.delete(key);
            emitter.fire({ key });
        },
        onDidChange: emitter.event,
    };
}

function makeWebviewView() {
    const posted = [];
    const view = {
        posted,
        visible: true,
        webview: {
            options: {},
            html: '',
            cspSource: 'vscode-resource:',
            asWebviewUri: (uri) => uri,
            postMessage: async (message) => {
                posted.push(message);
                return true;
            },
            onDidReceiveMessage: (handler) => {
                view.receive = handler;
                return { dispose() {} };
            },
        },
        show() {},
        onDidChangeVisibility: () => ({ dispose() {} }),
    };
    return view;
}

function sseResponse(chunks) {
    const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
    const bytes = new TextEncoder().encode(payload);
    return {
        ok: true,
        status: 200,
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(bytes);
                controller.close();
            },
        }),
        text: async () => '',
    };
}

function textChunks(text, extra = []) {
    const chunks = [{ choices: [{ delta: { content: text } }] }];
    for (const item of extra) {
        chunks.push(item);
    }
    chunks.push({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });
    return chunks;
}

const SAMPLE = ['const a = 1;', 'function foo() {', '  return a;', '}'].join('\n');

async function setup(options = {}) {
    helpers.reset();
    const secrets = makeSecrets(options.apiKey ? { 'deepseek.apiKey': options.apiKey } : {});
    const globalState = makeMemento();
    const context = {
        subscriptions: [],
        secrets,
        globalState,
        extensionUri: vscode.Uri.file('D:/DS_work'),
        extensionPath: 'D:/DS_work',
    };

    // /models 的默认响应，避免测试打到真实网络
    globalThis.fetch = async (url) => {
        if (String(url).includes('/models')) {
            return {
                ok: true,
                status: 200,
                text: async () =>
                    JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }),
            };
        }
        return { ok: false, status: 500, text: async () => '{"error":{"message":"fetch mock not configured"}}' };
    };

    const document = helpers.openDocument(vscode.Uri.file('D:/DS_work/src/a.ts'), 'typescript', options.text ?? SAMPLE);
    const selection =
        options.selection === null
            ? new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0))
            : new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(3, 1));
    const editor = helpers.makeEditor(document, selection);
    helpers.setActiveEditor(editor);

    activate(context);
    await delay(30);

    const provider = helpers.solution.webviewProvider;
    const view = makeWebviewView();
    provider.resolveWebviewView(view);
    await waitFor(() => view.posted.some((message) => message.type === 'state'), '初始状态');
    if (options.apiKey) {
        await waitFor(
            () => {
                const current = lastState(view);
                return current && current.models.some((item) => item.id === 'deepseek-v4-pro');
            },
            '模型列表'
        );
    }

    return { context, secrets, globalState, document, editor, provider, view, selection };
}

function lastState(view) {
    const states = view.posted.filter((message) => message.type === 'state');
    return states.length > 0 ? states[states.length - 1].state : undefined;
}

test('激活后注册侧边栏、命令与状态栏，并渲染工作台 HTML', async () => {
    const { view } = await setup({ apiKey: 'sk-test' });

    assert.ok(view.webview.html.includes('DeepSeek'));
    assert.ok(view.webview.html.includes('contenteditable') === false);
    assert.match(view.webview.html, /Content-Security-Policy/);
    assert.match(view.webview.html, /workbench\.js/);

    const commandIds = [...helpers.commands.keys()];
    for (const id of ['deepseek.openWorkbench', 'deepseek.editSelection', 'deepseek.askSelection', 'deepseek.revertLastEdit', 'deepseek.openFile']) {
        assert.ok(commandIds.includes(id), `缺少命令 ${id}`);
    }
    assert.equal(helpers.statusBarItems.length, 1);
    assert.match(helpers.statusBarItems[0].text, /DeepSeek/);
});

test('提问：流式增量写入界面，完成后落库并带用量', async () => {
    const { view } = await setup({ apiKey: 'sk-test' });

    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        return sseResponse([
            { choices: [{ delta: { content: '这段代码' } }] },
            { choices: [{ delta: { content: '定义了一个函数。' } }] },
            { choices: [], usage: { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29 } },
        ]);
    };

    await view.receive({ type: 'send', text: '这段代码是干什么的？', mode: 'ask', includeSelection: true, includeFile: false });
    await waitFor(() => {
        const state = lastState(view);
        return state && state.busy === false && state.messages.length >= 2 && state.messages[1].content.length > 0;
    }, '回答完成');

    const state = lastState(view);
    assert.equal(state.messages[0].role, 'user');
    assert.equal(state.messages[0].contextLabel, 'a.ts:2-4');
    assert.equal(state.messages[1].role, 'assistant');
    assert.match(state.messages[1].content, /定义了一个函数/);
    assert.equal(state.messages[1].usage.totalTokens, 29);

    const statePosts = view.posted.filter((message) => message.type === 'state');
    assert.ok(statePosts.length >= 2, '发送后应推送状态');
    assert.ok(view.posted.some((message) => message.type === 'delta'));

    const request = requests[0];
    assert.match(request.url, /\/chat\/completions$/);
    assert.equal(request.body.model, 'deepseek-flash');
    assert.equal(request.body.stream, true);
    const system = request.body.messages[0];
    assert.equal(system.role, 'system');
    const user = request.body.messages.at(-1);
    assert.match(user.content, /选中的代码/);
    assert.match(user.content, /这段代码是干什么的/);
});

test('定点修改：生成时打开 diff，确认后写入文件并可撤销', async () => {
    const { document, view } = await setup({ apiKey: 'sk-test' });

    globalThis.fetch = async () =>
        sseResponse(
            textChunks('async function foo() {\n  return await a;\n}', [
                { choices: [{ delta: { content: '' }, finish_reason: 'stop' }] },
            ])
        );

    helpers.hooks.inputBoxes = ['把 foo 改成 async 函数'];
    let previewAtDecision = '';
    helpers.hooks.quickPick = () => {
        const previewUri = helpers.diffCalls[0][1];
        previewAtDecision = helpers.contentProviders
            .get('deepseek-preview')
            .provideTextDocumentContent(previewUri);
        return { label: '$(check) 应用修改', value: 'apply' };
    };

    await vscode.commands.executeCommand('deepseek.editSelection');

    assert.equal(helpers.diffCalls.length, 1, '应打开 diff 预览');
    const [, previewUri, title] = helpers.diffCalls[0];
    assert.match(title, /实时预览/);
    assert.match(previewAtDecision, /async function foo/, '确认时应看到实时预览内容');

    assert.match(document.text, /async function foo\(\) \{/);
    assert.match(document.text, /return await a;/);
    assert.match(document.text, /^const a = 1;/);

    const state = lastState(view);
    const assistant = state.messages.at(-1);
    assert.equal(assistant.applied, true);
    assert.equal(assistant.canApply, false);
    assert.match(assistant.content, /async function foo/);

    await vscode.commands.executeCommand('deepseek.revertLastEdit');
    assert.equal(document.text, SAMPLE, '撤销后应恢复原文');
});

test('定点修改：文件在预览期间变化时拒绝覆盖并提示过期', async () => {
    const { document, view } = await setup({ apiKey: 'sk-test' });

    globalThis.fetch = async () => sseResponse(textChunks('async function foo() {\n  return await a;\n}'));
    helpers.hooks.inputBoxes = ['改成 async'];
    helpers.hooks.quickPick = (items) => {
        document.setText(`${document.text}\n// 用户自己的改动`);
        return items.find((item) => item.value === 'apply');
    };

    await vscode.commands.executeCommand('deepseek.editSelection');

    assert.match(document.text, /用户自己的改动/);
    assert.ok(!document.text.includes('async function foo'), '过期预览不应该写入');
    const assistant = lastState(view).messages.at(-1);
    assert.match(assistant.error, /过期/);
});

test('API 错误：401 时给出可读提示并标记消息失败', async () => {
    const { view } = await setup({ apiKey: 'sk-test' });

    globalThis.fetch = async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"invalid api key"}}',
    });

    await view.receive({ type: 'send', text: '你好', mode: 'ask', includeSelection: false, includeFile: false });
    await waitFor(() => {
        const state = lastState(view);
        return state && state.busy === false && state.messages.length >= 2 && Boolean(state.messages[1].error);
    }, '错误落库');

    const state = lastState(view);
    assert.match(state.messages[1].error, /API Key 无效/);
    assert.equal(state.notice.level, 'error');
});

test('未配置 Key 时提示设置，而不是发起请求', async () => {
    const { view } = await setup({});
    let called = false;
    globalThis.fetch = async () => {
        called = true;
        return sseResponse(textChunks('不应该被调用'));
    };

    await view.receive({ type: 'send', text: '你好', mode: 'ask', includeSelection: false, includeFile: false });
    await delay(60);

    assert.equal(called, false);
    assert.match(helpers.hooks.lastInputBox.title, /API Key/);
    const state = lastState(view);
    assert.match(state.notice.text, /API Key/);
    assert.equal(state.messages.length, 0);
});

test('定点修改：没有选区时明确提示', async () => {
    const { view } = await setup({ apiKey: 'sk-test', selection: null });
    await view.receive({ type: 'send', text: '改成 async', mode: 'edit', includeSelection: true, includeFile: false });
    await waitFor(() => {
        const state = lastState(view);
        return state && state.busy === false && state.messages.length === 0 && Boolean(state.notice);
    }, '提示选区');
    assert.match(lastState(view).notice.text, /选中/);
});

test('聊天代码块：替换选区与复制', async () => {
    const { document, view } = await setup({ apiKey: 'sk-test' });

    await view.receive({ type: 'replaceSelection', code: 'function foo() {\n  return 42;\n}' });
    assert.match(document.text, /return 42;/);

    await view.receive({ type: 'copy', code: 'const x = 1;' });
    assert.equal(helpers.clipboard.text, 'const x = 1;');
});

test('会话操作：新建、切换、删除与模型切换', async () => {
    const { view } = await setup({ apiKey: 'sk-test' });
    const before = lastState(view).chats.length;

    await view.receive({ type: 'newChat' });
    await waitFor(() => lastState(view).chats.length === before + 1, '新建对话');
    const created = lastState(view).activeChatId;

    await view.receive({ type: 'setModel', model: 'deepseek-v4-pro' });
    await waitFor(() => lastState(view).model === 'deepseek-v4-pro', '切换模型');

    await view.receive({ type: 'deleteChat', id: created });
    await waitFor(() => lastState(view).chats.length === before, '删除对话');
    assert.notEqual(lastState(view).activeChatId, created);
});

test('V4 Pro 请求带 temperature，并展示思考内容', async () => {
    const { view } = await setup({ apiKey: 'sk-test' });
    helpers.hooks.quickPick = undefined;

    await vscode.workspace.getConfiguration('deepseek').update('model', 'deepseek-v4-pro');

    let body;
    globalThis.fetch = async (url, init) => {
        body = JSON.parse(init.body);
        return sseResponse([
            { choices: [{ delta: { reasoning_content: '先分析一下' } }] },
            { choices: [{ delta: { content: '结论' } }] },
            { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
        ]);
    };

    await view.receive({ type: 'send', text: '说说看', mode: 'ask', includeSelection: true, includeFile: false });
    await waitFor(() => lastState(view).messages.at(-1).content === '结论', 'V4 Pro 回复');

    assert.equal(body.model, 'deepseek-v4-pro');
    assert.equal(body.temperature, 0.2);
    assert.match(lastState(view).messages.at(-1).reasoningHtml, /先分析一下/);
});

test('配置检查：API 地址被填成 Key 时给出可操作提示', async () => {
    await setup({ apiKey: 'sk-test' });
    await vscode.workspace.getConfiguration('deepseek').update('apiBaseUrl', 'sk-abcdefgh12345678');

    await vscode.commands.executeCommand('deepseek.checkSetup');

    assert.match(helpers.hooks.error, /API 地址/);
    assert.match(helpers.hooks.error, /API Key/);
    assert.ok(!helpers.hooks.error.includes('sk-abcdefgh'), '错误提示不应带出完整密钥');
});

test('配置检查：连接成功时提示可用模型', async () => {
    await setup({ apiKey: 'sk-test' });
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }),
    });

    await vscode.commands.executeCommand('deepseek.checkSetup');
    assert.match(helpers.hooks.info, /连接正常/);
    assert.match(helpers.hooks.info, /deepseek-flash/);
});

test('模型来自 /models：默认 V4.1 Flash，可切到 V4 Pro', async () => {
    const { view } = await setup({ apiKey: 'sk-test' });

    const initial = lastState(view);
    assert.deepEqual(
        initial.models.slice(0, 2).map((item) => item.id),
        ['deepseek-flash', 'deepseek-v4-pro']
    );
    assert.equal(initial.models[0].label, 'V4.1 Flash');
    assert.equal(initial.model, 'deepseek-flash');
    assert.equal(initial.thinkingAvailable, true);

    let body;
    globalThis.fetch = async (url, init) => {
        body = JSON.parse(init.body);
        return sseResponse(textChunks('好的'));
    };

    await view.receive({ type: 'send', text: '你好', mode: 'ask', includeSelection: false, includeFile: false });
    await waitFor(() => !lastState(view).busy && lastState(view).messages.length === 2, '第一次回答');
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'high');

    await view.receive({ type: 'setModel', model: 'deepseek-v4-pro' });
    await waitFor(() => lastState(view).model === 'deepseek-v4-pro', '切换到 V4 Pro');
    await view.receive({ type: 'send', text: '再问一句', mode: 'ask', includeSelection: false, includeFile: false });
    await waitFor(() => !lastState(view).busy && lastState(view).messages.length === 4, '第二次回答');
    assert.equal(body.model, 'deepseek-v4-pro');
});

test('关掉深度思考后 thinking 为 disabled，不支持思考的模型不发送 thinking', async () => {
    const { view } = await setup({ apiKey: 'sk-test' });
    await view.receive({ type: 'setThinking', value: false });
    await waitFor(() => lastState(view).thinking === false, '关闭思考');

    let body;
    globalThis.fetch = async (url, init) => {
        body = JSON.parse(init.body);
        return sseResponse(textChunks('ok'));
    };

    await view.receive({ type: 'send', text: 'hi', mode: 'ask', includeSelection: false, includeFile: false });
    await waitFor(() => !lastState(view).busy && lastState(view).messages.length === 2, '回答完成');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.reasoning_effort, undefined);

    await view.receive({ type: 'setModel', model: 'my-gateway-model' });
    await waitFor(() => lastState(view).model === 'my-gateway-model', '切换到网关模型');
    assert.equal(lastState(view).thinkingAvailable, false);

    await view.receive({ type: 'send', text: 'hi2', mode: 'ask', includeSelection: false, includeFile: false });
    await waitFor(() => !lastState(view).busy && lastState(view).messages.length === 4, '第二次完成');
    assert.equal(body.thinking, undefined);
});

test('侧边栏切换文件：Quick Pick 打开文件并保留焦点', async () => {
    const { view } = await setup({ apiKey: 'sk-test' });

    helpers.hooks.quickPick = (items) => items.find((item) => item.uri !== undefined);
    await view.receive({ type: 'openFile' });
    await waitFor(() => Boolean(helpers.hooks.shownDocument), '打开文件');

    assert.match(helpers.hooks.shownDocument.uri, /a\.ts$/);
    assert.equal(helpers.hooks.shownDocument.options.preserveFocus, true);
    assert.equal(helpers.hooks.shownDocument.options.preview, false);
});

test('切换文件后是否保留焦点由设置控制', async () => {
    const { view } = await setup({ apiKey: 'sk-test' });
    await vscode.workspace.getConfiguration('deepseek').update('keepFocusAfterFileSwitch', false);

    helpers.hooks.quickPick = (items) => items.find((item) => item.uri !== undefined);
    await view.receive({ type: 'openFile' });
    await waitFor(() => Boolean(helpers.hooks.shownDocument), '打开文件');

    assert.equal(helpers.hooks.shownDocument.options.preserveFocus, false);
});

test('每条回答显示花费，会话累计随之增长', async () => {
    const { view } = await setup({ apiKey: 'sk-test' });
    globalThis.fetch = async () =>
        sseResponse([
            { choices: [{ delta: { content: '答案' } }] },
            { choices: [], usage: { prompt_tokens: 12000, completion_tokens: 7000, total_tokens: 19000 } },
        ]);

    await view.receive({ type: 'send', text: '第一问', mode: 'ask', includeSelection: false, includeFile: false });
    await waitFor(() => !lastState(view).busy && lastState(view).messages.length === 2, '第一次回答');

    const first = lastState(view);
    assert.ok(first.messages[1].cost, '回答应带花费');
    assert.match(first.messages[1].cost.label, /¥/);
    assert.match(first.messages[1].cost.tooltip, /输入 12,000 tokens/);
    assert.match(first.chatCostLabel, /本会话/);
    assert.match(first.chatCostLabel, /¥/);

    await view.receive({ type: 'send', text: '第二问', mode: 'ask', includeSelection: false, includeFile: false });
    await waitFor(() => !lastState(view).busy && lastState(view).messages.length === 4, '第二次回答');
    assert.notEqual(lastState(view).chatCostLabel, first.chatCostLabel, '累计花费应增长');
});

test('未闭合围栏的流式输出不会破坏渲染', async () => {
    const { view } = await setup({ apiKey: 'sk-test' });
    globalThis.fetch = async () =>
        sseResponse([
            { choices: [{ delta: { content: '示例：\n```ts\nconst a = 1;' } }] },
            { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ]);

    await view.receive({ type: 'send', text: '写个例子', mode: 'ask', includeSelection: false, includeFile: false });
    await waitFor(() => lastState(view).busy === false && lastState(view).messages.length === 2, '流式完成');
    assert.match(lastState(view).messages[1].html, /<div class="code">/);
    assert.match(lastState(view).messages[1].html, /const a = 1;/);
});
