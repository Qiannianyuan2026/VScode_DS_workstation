import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

function nonce(): string {
    return createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16);
}

/** 侧边栏工作台的 HTML 骨架；脚本与样式都是本地媒体文件。 */
export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'workbench.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'workbench.js'));
    const scriptNonce = nonce();
    const csp = [
        "default-src 'none'",
        `img-src ${webview.cspSource} https: data:`,
        `style-src ${webview.cspSource}`,
        `font-src ${webview.cspSource}`,
        `script-src ${webview.cspSource} 'nonce-${scriptNonce}'`,
        `connect-src 'none'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>DeepSeek 工作台</title>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand"><span class="brand-dot"></span><span class="brand-name">DeepSeek</span><span class="brand-sub">工作台</span></div>
    <div class="top-actions">
      <select id="model" class="model-select" aria-label="选择模型"></select>
      <button id="open-file" class="icon-btn" title="切换文件（不离开侧边栏）" aria-label="切换文件">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M1.6 3.4h4.5l1.5 1.9h6.8v8.3H1.6z"/><path d="M1.6 5.3h12.8"/></svg>
      </button>
      <button id="history-btn" class="icon-btn" title="历史对话" aria-label="历史对话">☰</button>
      <button id="new-chat" class="icon-btn" title="新建对话" aria-label="新建对话">＋</button>
      <button id="settings-btn" class="icon-btn" title="设置" aria-label="设置">⚙</button>
    </div>
  </header>

  <section id="history-panel" class="history-panel hidden">
    <div class="history-head"><span>历史对话</span><button id="history-close" class="link-btn">收起</button></div>
    <ul id="history-list" class="history-list"></ul>
  </section>

  <div id="notice" class="notice hidden">
    <span id="notice-text"></span>
    <button id="notice-close" class="link-btn" title="关闭">×</button>
  </div>

  <main id="messages" class="messages"></main>

  <div id="context-bar" class="context-bar"></div>

  <footer class="composer">
    <div class="mode-row">
      <div class="segmented" role="tablist">
        <button class="mode-btn active" data-mode="ask" role="tab">提问</button>
        <button class="mode-btn" data-mode="edit" role="tab">定点修改</button>
      </div>
      <span id="busy-hint" class="busy-hint hidden">生成中…</span>
    </div>
    <textarea id="input" rows="3" placeholder="选中代码后提问；切到「定点修改」可原地改码…"></textarea>
    <div class="composer-actions">
      <label class="toggle" title="把当前选区一起发给模型"><input type="checkbox" id="attach-selection" checked> 选区</label>
      <label class="toggle" title="把整份文件一起发给模型（超长会截断）"><input type="checkbox" id="attach-file"> 整份文件</label>
      <label class="toggle hidden" id="thinking-wrap" title="V4 思考模式：先推理再回答，更准但更慢更贵"><input type="checkbox" id="thinking"> 深度思考</label>
      <span class="spacer"></span>
      <span id="key-warning" class="key-warning hidden" title="点击设置 API Key">未配置 Key</span>
      <button id="send" class="primary-btn" title="发送（Enter）">发送</button>
      <button id="stop" class="ghost-btn hidden" title="停止生成（Esc）">停止</button>
    </div>
  </footer>
</div>
<div id="toast" class="toast hidden"></div>
<script nonce="${scriptNonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
