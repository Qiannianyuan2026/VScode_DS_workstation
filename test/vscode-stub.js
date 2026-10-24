/**
 * 最小可用的 VS Code API 桩，用于在 Node 里跑扩展的端到端测试。
 * 只实现扩展真正用到的接口，行为尽量贴近真实 API。
 */

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
    isEqual(other) {
        return this.line === other.line && this.character === other.character;
    }
    isBefore(other) {
        return this.line < other.line || (this.line === other.line && this.character < other.character);
    }
    translate(lineDelta = 0, characterDelta = 0) {
        return new Position(this.line + lineDelta, this.character + characterDelta);
    }
}

class Range {
    constructor(a, b, c, d) {
        if (typeof a === 'number') {
            this.start = new Position(a, b);
            this.end = new Position(c, d);
        } else {
            this.start = a;
            this.end = b;
        }
    }
    get isEmpty() {
        return this.start.line === this.end.line && this.start.character === this.end.character;
    }
    isSingleLine() {
        return this.start.line === this.end.line;
    }
}

class Selection extends Range {
    constructor(anchor, active) {
        super(anchor, active);
        this.anchor = anchor;
        this.active = active;
    }
}

class Uri {
    constructor(scheme, path, query) {
        this.scheme = scheme;
        this.path = path;
        this.query = query || '';
        this.authority = '';
    }
    static file(filePath) {
        return new Uri('file', '/' + String(filePath).replace(/\\/g, '/'));
    }
    static parse(value) {
        const index = String(value).indexOf(':');
        if (index < 0) {
            return new Uri('file', '/', '');
        }
        const rest = String(value).slice(index + 1);
        const queryIndex = rest.indexOf('?');
        if (queryIndex >= 0) {
            return new Uri(String(value).slice(0, index), rest.slice(0, queryIndex), rest.slice(queryIndex + 1));
        }
        return new Uri(String(value).slice(0, index), rest, '');
    }
    static from(parts) {
        return new Uri(parts.scheme, parts.path, parts.query);
    }
    static joinPath(base, ...segments) {
        return new Uri(base.scheme, base.path + '/' + segments.join('/'), '');
    }
    toString() {
        return this.scheme + ':' + this.path + (this.query ? '?' + this.query : '');
    }
    get fsPath() {
        return this.path;
    }
}

class EventEmitter {
    constructor() {
        this.listeners = [];
        this.event = (listener) => {
            this.listeners.push(listener);
            return {
                dispose: () => {
                    this.listeners = this.listeners.filter((item) => item !== listener);
                },
            };
        };
    }
    fire(value) {
        for (const listener of [...this.listeners]) {
            listener(value);
        }
    }
    dispose() {
        this.listeners = [];
    }
}

const disposable = { dispose() {} };

class TextDocument {
    constructor(uri, languageId, text) {
        this.uri = uri;
        this.fileName = uri.path.replace(/^\//, '').replace(/\//g, '\\');
        this.languageId = languageId;
        this.text = text;
        this.version = 1;
        this.isDirty = false;
    }
    get lineCount() {
        return this.text.split('\n').length;
    }
    getText(range) {
        if (!range) {
            return this.text;
        }
        return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
    }
    lineAt(line) {
        const lines = this.text.split('\n');
        const text = lines[line] ?? '';
        let start = 0;
        for (let index = 0; index < line; index++) {
            start += lines[index].length + 1;
        }
        return {
            text,
            lineNumber: line,
            range: new Range(line, 0, line, text.length),
            rangeIncludingLineBreak: new Range(line, 0, line + 1, 0),
            firstNonWhitespaceCharacterIndex: text.length - text.trimStart().length,
            isEmptyOrWhitespace: text.trim().length === 0,
            _start: start,
        };
    }
    offsetAt(position) {
        const lines = this.text.split('\n');
        let offset = 0;
        for (let index = 0; index < position.line; index++) {
            offset += (lines[index] ?? '').length + 1;
        }
        return offset + Math.min(position.character, (lines[position.line] ?? '').length);
    }
    positionAt(offset) {
        const clamped = Math.max(0, Math.min(offset, this.text.length));
        const before = this.text.slice(0, clamped);
        const lines = before.split('\n');
        return new Position(lines.length - 1, lines[lines.length - 1].length);
    }
    setText(text) {
        this.text = text;
        this.version += 1;
        workspace.__fireDocumentChange(this);
    }
}

class WorkspaceEdit {
    constructor() {
        this.edits = [];
    }
    replace(uri, range, newText) {
        this.edits.push({ uri, range, newText });
    }
    insert(uri, position, newText) {
        this.edits.push({ uri, range: new Range(position, position), newText });
    }
}

class TabInputText {
    constructor(uri) {
        this.uri = uri;
    }
}

class TabInputTextDiff {
    constructor(original, modified) {
        this.original = original;
        this.modified = modified;
    }
}

const configStore = new Map();
const commands = new Map();
const documents = new Map();
const contentProviders = new Map();
const diffCalls = [];
const statusMessages = [];
const clipboard = { text: '' };
const changeDocumentEmitter = new EventEmitter();
const changeSelectionEmitter = new EventEmitter();
const changeActiveEditorEmitter = new EventEmitter();

const hooks = {
    inputBox: null,
    inputBoxes: [],
    quickPick: null,
    warning: null,
    info: null,
    error: null,
    shownDocument: null,
    fetch: null,
};

const statusBarItems = [];
const solution = {
    registerWebviewViewProvider: null,
    webviewProvider: null,
};

let activeTextEditor = undefined;

function makeStatusBarItem(alignment, priority) {
    const item = {
        alignment,
        priority,
        text: '',
        tooltip: '',
        command: undefined,
        backgroundColor: undefined,
        visible: false,
        show() {
            this.visible = true;
        },
        hide() {
            this.visible = false;
        },
        dispose() {},
    };
    statusBarItems.push(item);
    return item;
}

const window = {
    get activeTextEditor() {
        return activeTextEditor;
    },
    set activeTextEditor(value) {
        activeTextEditor = value;
        changeActiveEditorEmitter.fire(value);
    },
    showInputBox: async (options = {}) => {
        hooks.lastInputBox = options;
        if (hooks.inputBoxes.length > 0) {
            return hooks.inputBoxes.shift();
        }
        return hooks.inputBox;
    },
    showQuickPick: async (items) => {
        if (typeof hooks.quickPick === 'function') {
            return hooks.quickPick(items);
        }
        return hooks.quickPick;
    },
    showInformationMessage: async (message, ...rest) => {
        hooks.info = message;
        const actions = rest.filter((item) => typeof item === 'string');
        return actions.length > 0 ? actions[0] : undefined;
    },
    showWarningMessage: async (message, ...rest) => {
        hooks.warning = message;
        const actions = rest.filter((item) => typeof item === 'string');
        return actions.length > 0 ? actions[0] : undefined;
    },
    showErrorMessage: async (message, ...rest) => {
        hooks.error = message;
        const actions = rest.filter((item) => typeof item === 'string');
        return actions.length > 0 ? actions[0] : undefined;
    },
    showTextDocument: async (document, options) => {
        hooks.shownDocument = { uri: document.uri.toString(), options };
        activeTextEditor = { document, selection: new Selection(new Position(0, 0), new Position(0, 0)) };
        changeActiveEditorEmitter.fire(activeTextEditor);
        return activeTextEditor;
    },
    setStatusBarMessage: (text) => {
        statusMessages.push(text);
        return disposable;
    },
    createStatusBarItem: (alignment, priority) => makeStatusBarItem(alignment, priority),
    createOutputChannel: (name) => ({
        name,
        lines: [],
        appendLine(line) {
            this.lines.push(line);
        },
        append(line) {
            this.lines.push(line);
        },
        show() {},
        dispose() {},
    }),
    registerWebviewViewProvider: (id, provider, options) => {
        solution.registerWebviewViewProvider = { id, provider, options };
        solution.webviewProvider = provider;
        return disposable;
    },
    onDidChangeTextEditorSelection: changeSelectionEmitter.event,
    onDidChangeActiveTextEditor: changeActiveEditorEmitter.event,
    tabGroups: { all: [], close: async () => true },
    createTerminal: () => ({ show() {}, sendText() {}, dispose() {} }),
};

const workspace = {
    getConfiguration: (section) => ({
        get(key, fallback) {
            return configStore.has(`${section}.${key}`) ? configStore.get(`${section}.${key}`) : fallback;
        },
        async update(key, value) {
            configStore.set(`${section}.${key}`, value);
        },
        inspect: () => undefined,
    }),
    getWorkspaceFolder: () => ({ uri: Uri.file('D:/DS_work'), name: 'DS_work', index: 0 }),
    asRelativePath: (uri) => {
        const text = uri.toString().replace(/^file:\/\/?\/?/, '');
        const marker = 'DS_work/';
        const index = text.lastIndexOf(marker);
        return index >= 0 ? text.slice(index + marker.length) : text;
    },
    openTextDocument: async (uri) => {
        const key = uri.toString();
        if (!documents.has(key)) {
            throw new Error(`document not found: ${key}`);
        }
        return documents.get(key);
    },
    findFiles: async () => [...documents.keys()].map((key) => Uri.parse(key)),
    applyEdit: async (edit) => {
        for (const item of edit.edits) {
            const document = documents.get(item.uri.toString());
            if (!document) {
                return false;
            }
            const start = document.offsetAt(item.range.start);
            const end = document.offsetAt(item.range.end);
            document.text = document.text.slice(0, start) + item.newText + document.text.slice(end);
            document.version += 1;
            workspace.__fireDocumentChange(document);
        }
        return true;
    },
    registerTextDocumentContentProvider: (scheme, provider) => {
        contentProviders.set(scheme, provider);
        return disposable;
    },
    onDidChangeTextDocument: changeDocumentEmitter.event,
    __fireDocumentChange(document) {
        changeDocumentEmitter.fire({ document });
    },
};

const commandsApi = {
    registerCommand: (id, handler) => {
        commands.set(id, handler);
        return disposable;
    },
    executeCommand: async (id, ...args) => {
        if (id === 'vscode.diff') {
            diffCalls.push(args);
            return undefined;
        }
        if (id === 'workbench.action.openSettings') {
            hooks.openedSettings = args[0];
            return undefined;
        }
        const handler = commands.get(id);
        if (!handler) {
            return undefined;
        }
        return handler(...args);
    },
    getCommands: async () => [...commands.keys()],
};

const env = {
    clipboard: {
        writeText: async (text) => {
            clipboard.text = text;
        },
        readText: async () => clipboard.text,
    },
    openExternal: async () => true,
};

const vscode = {
    Position,
    Range,
    Selection,
    Uri,
    EventEmitter,
    WorkspaceEdit,
    TextDocument,
    TabInputText,
    TabInputTextDiff,
    QuickPickItemKind: { Separator: -1, Default: 0 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    window,
    workspace,
    commands: commandsApi,
    env,
};

// 测试辅助
const helpers = {
    hooks,
    commands,
    documents,
    contentProviders,
    diffCalls,
    statusMessages,
    statusBarItems,
    solution,
    clipboard,
    configStore,
    openDocument(uri, languageId, text) {
        const document = new TextDocument(uri, languageId, text);
        documents.set(uri.toString(), document);
        return document;
    },
    setActiveEditor(editor) {
        activeTextEditor = editor;
        changeActiveEditorEmitter.fire(editor);
    },
    makeEditor(document, selection) {
        return {
            document,
            selection,
            selections: [selection],
            edit: async (callback) => {
                const builder = {
                    edits: [],
                    insert(position, text) {
                        this.edits.push({ kind: 'insert', position, text });
                        return this;
                    },
                    replace(range, text) {
                        this.edits.push({ kind: 'replace', range, text });
                        return this;
                    },
                    delete(range) {
                        this.edits.push({ kind: 'delete', range });
                        return this;
                    },
                };
                const result = callback(builder);
                for (const item of builder.edits) {
                    const range = item.kind === 'insert' ? new Range(item.position, item.position) : item.range;
                    const start = document.offsetAt(range.start);
                    const end = document.offsetAt(range.end);
                    const text = item.kind === 'delete' ? '' : item.text;
                    document.text = document.text.slice(0, start) + text + document.text.slice(end);
                    document.version += 1;
                }
                return result !== false;
            },
            revealRange() {},
            setDecorations() {},
        };
    },
    reset() {
        hooks.inputBox = null;
        hooks.inputBoxes = [];
        hooks.quickPick = null;
        hooks.warning = null;
        hooks.info = null;
        hooks.error = null;
        hooks.shownDocument = null;
        hooks.lastInputBox = null;
        diffCalls.length = 0;
        statusMessages.length = 0;
        changeDocumentEmitter.listeners = [];
        changeSelectionEmitter.listeners = [];
        changeActiveEditorEmitter.listeners = [];
        activeTextEditor = undefined;
        configStore.clear();
        commands.clear();
        documents.clear();
        contentProviders.clear();
        statusBarItems.length = 0;
    },
};

vscode.__helpers = helpers;

module.exports = vscode;
