(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const el = {
    model: document.getElementById('model'),
    openFile: document.getElementById('open-file'),
    historyBtn: document.getElementById('history-btn'),
    historyPanel: document.getElementById('history-panel'),
    historyList: document.getElementById('history-list'),
    historyClose: document.getElementById('history-close'),
    notice: document.getElementById('notice'),
    noticeText: document.getElementById('notice-text'),
    noticeClose: document.getElementById('notice-close'),
    messages: document.getElementById('messages'),
    contextBar: document.getElementById('context-bar'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    stop: document.getElementById('stop'),
    busyHint: document.getElementById('busy-hint'),
    attachSelection: document.getElementById('attach-selection'),
    attachFile: document.getElementById('attach-file'),
    thinking: document.getElementById('thinking'),
    thinkingWrap: document.getElementById('thinking-wrap'),
    keyWarning: document.getElementById('key-warning'),
    newChat: document.getElementById('new-chat'),
    settings: document.getElementById('settings-btn'),
    toast: document.getElementById('toast'),
    modeButtons: Array.prototype.slice.call(document.querySelectorAll('.mode-btn')),
  };

  let state = null;
  let pinned = true;
  let dismissedNotice = '';
  let toastTimer = 0;

  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function fmtTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } catch (error) {
      return '';
    }
  }

  function findArticle(id) {
    const nodes = el.messages.querySelectorAll('article.msg');
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].dataset.id === id) {
        return nodes[i];
      }
    }
    return null;
  }

  function atBottom() {
    return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 28;
  }

  function scrollBottom(force) {
    if (force || pinned) {
      el.messages.scrollTop = el.messages.scrollHeight;
    }
  }

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 220) + 'px';
  }

  // ------------------------------------------------------------ 渲染

  function messageEl(message) {
    const article = document.createElement('article');
    article.className = 'msg msg-' + message.role;
    article.dataset.id = message.id;

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML =
      '<span class="who">' +
      (message.role === 'user' ? '你' : 'DeepSeek') +
      '</span>' +
      (message.contextLabel ? '<span class="chip">' + esc(message.contextLabel) + '</span>' : '') +
      '<span class="time">' + esc(fmtTime(message.createdAt)) + '</span>';
    article.appendChild(meta);

    if (message.reasoningHtml) {
      const details = document.createElement('details');
      details.className = 'reasoning';
      details.innerHTML = '<summary>思考过程</summary><div class="reasoning-body">' + message.reasoningHtml + '</div>';
      article.appendChild(details);
    }

    const body = document.createElement('div');
    body.className = 'msg-body';
    if (message.html) {
      body.innerHTML = message.html;
    } else if (message.role === 'assistant' && !message.error) {
      body.innerHTML = '<span class="typing">正在生成</span>';
    }
    article.appendChild(body);

    if (message.error) {
      const error = document.createElement('div');
      error.className = 'msg-error';
      error.textContent = message.error;
      article.appendChild(error);
    }

    const foot = document.createElement('div');
    foot.className = 'msg-foot';
    const bits = [];
    if (message.model) {
      bits.push('<span class="model-tag">' + esc(message.model) + '</span>');
    }
    if (message.usage) {
      bits.push('<span>' + message.usage.totalTokens + ' tokens</span>');
    }
    if (message.cost) {
      bits.push('<span class="cost" title="' + esc(message.cost.tooltip) + '">' + esc(message.cost.label) + '</span>');
    }
    if (message.applied) {
      bits.push('<span class="badge ok">已应用</span>');
    }
    foot.innerHTML = bits.join('');

    if (message.canApply && !message.applied) {
      const applyBtn = document.createElement('button');
      applyBtn.className = 'link-btn';
      applyBtn.dataset.act = 'apply';
      applyBtn.dataset.message = message.id;
      applyBtn.textContent = '应用修改';
      foot.appendChild(applyBtn);
    }
    if (message.applied) {
      const revertBtn = document.createElement('button');
      revertBtn.className = 'link-btn';
      revertBtn.dataset.act = 'revert';
      revertBtn.textContent = '撤销';
      foot.appendChild(revertBtn);
    }
    if (message.error) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'link-btn';
      retryBtn.dataset.act = 'retry';
      retryBtn.dataset.message = message.id;
      retryBtn.textContent = '重试';
      foot.appendChild(retryBtn);
    }

    if (foot.childNodes.length > 0) {
      article.appendChild(foot);
    }
    return article;
  }

  function emptyState() {
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    wrap.innerHTML =
      '<div class="empty-title">和 DeepSeek 一起改代码</div>' +
      '<p class="empty-sub">选中一段代码，用「定点修改」原地改；或者直接提问。</p>' +
      '<div class="suggestions">' +
      '<button data-act="suggest" data-mode="ask" data-text="解释这段代码的作用、关键逻辑和潜在问题。">解释选中代码</button>' +
      '<button data-act="suggest" data-mode="ask" data-text="找出这段代码里的 bug、边界问题和异常路径。">找 bug</button>' +
      '<button data-act="suggest" data-mode="edit" data-text="重构这段代码，让它更易读，行为保持不变。">重构一下</button>' +
      '<button data-act="suggest" data-mode="ask" data-text="为这段代码补充单元测试，覆盖主要分支。">写测试</button>' +
      '</div>';
    return wrap;
  }

  function renderMessages(forceScroll) {
    if (!state) {
      return;
    }
    const previousTop = el.messages.scrollTop;
    el.messages.innerHTML = '';
    if (state.messages.length === 0) {
      el.messages.appendChild(emptyState());
      return;
    }
    for (let i = 0; i < state.messages.length; i++) {
      el.messages.appendChild(messageEl(state.messages[i]));
    }
    if (forceScroll || pinned) {
      scrollBottom(true);
    } else {
      el.messages.scrollTop = previousTop;
    }
  }

  function signatureOf(messages) {
    return messages
      .map(function (message) {
        return [
          message.id,
          message.role,
          (message.content || '').length,
          message.applied ? 1 : 0,
          message.error ? 1 : 0,
          message.canApply ? 1 : 0,
          message.contextLabel || '',
        ].join(':');
      })
      .join('|');
  }

  function renderContext(context, mode, costLabel) {
    const bits = [];
    if (!context) {
      bits.push('<span class="muted">未打开编辑器</span>');
      el.contextBar.classList.add('muted');
    } else {
      el.contextBar.classList.remove('muted');
      bits.push('<span class="ctx-file">' + esc(context.fileName) + '</span>', '<span>' + context.lineCount + ' 行</span>');
      if (context.selection) {
        bits.push(
          '<span class="chip">选区 ' +
            context.selection.startLine +
            '-' +
            context.selection.endLine +
            '</span>'
        );
      } else if (mode === 'edit') {
        bits.push('<span class="warn">先选中要改的代码</span>');
      }
    }
    if (costLabel) {
      bits.push('<span class="ctx-cost" title="按官方峰谷价与缓存命中情况估算">' + esc(costLabel) + '</span>');
    }
    el.contextBar.innerHTML = bits.join('<span class="dot">·</span>');
  }

  function renderHistory(chats) {
    const parts = chats.map(function (chat) {
      const active = chat.id === state.activeChatId ? ' active' : '';
      return (
        '<li class="history-item' +
        active +
        '" data-id="' +
        esc(chat.id) +
        '"><span class="history-title">' +
        esc(chat.title) +
        '</span><span class="history-count">' +
        chat.messageCount +
        '</span><button class="link-btn history-del" data-del="' +
        esc(chat.id) +
        '" title="删除对话">×</button></li>'
      );
    });
    el.historyList.innerHTML = parts.join('');
  }

  function renderNotice(notice) {
    if (!notice || notice.text === dismissedNotice) {
      el.notice.classList.add('hidden');
      return;
    }
    el.noticeText.textContent = notice.text;
    el.notice.className = 'notice ' + (notice.level === 'error' ? 'error' : notice.level === 'warn' ? 'warn' : '');
    el.notice.classList.remove('hidden');
  }

  function setMode(mode, notifyHost) {
    if (state) {
      state.mode = mode;
    }
    for (let i = 0; i < el.modeButtons.length; i++) {
      el.modeButtons[i].classList.toggle('active', el.modeButtons[i].dataset.mode === mode);
    }
    el.input.placeholder =
      mode === 'edit'
        ? '描述要如何修改选中的代码，Enter 生成实时预览…'
        : '选中代码后提问，切到「定点修改」可原地改码…';
    if (notifyHost) {
      vscode.postMessage({ type: 'setMode', mode: mode });
    }
    if (state) {
      renderContext(state.context, mode, state.chatCostLabel);
    }
  }

  function setBusy(value) {
    el.busyHint.classList.toggle('hidden', !value);
    el.stop.classList.toggle('hidden', !value);
    el.send.classList.toggle('hidden', value);
    el.send.disabled = value;
  }

  function applyState(next) {
    const previous = state;
    const previousSignature = previous ? signatureOf(previous.messages) : '';
    const chatChanged = !previous || previous.activeChatId !== next.activeChatId;
    state = next;

    if (next.models && next.models.length > 0) {
      const current = Array.prototype.map.call(el.model.options, function (option) {
        return option.value;
      });
      const ids = next.models.map(function (item) {
        return typeof item === 'string' ? item : item.id;
      });
      if (current.join(',') !== ids.join(',')) {
        el.model.innerHTML = next.models
          .map(function (item) {
            const id = typeof item === 'string' ? item : item.id;
            const label = typeof item === 'string' ? item : item.label || item.id;
            return '<option value="' + esc(id) + '">' + esc(label) + '</option>';
          })
          .join('');
      }
      el.model.value = next.model;
    }

    el.keyWarning.classList.toggle('hidden', next.hasKey);
    if (el.thinkingWrap) {
      el.thinkingWrap.classList.toggle('hidden', !next.thinkingAvailable);
      el.thinking.checked = Boolean(next.thinking);
    }
    setMode(next.mode, false);
    setBusy(next.busy);
    renderNotice(next.notice);
    renderContext(next.context, next.mode, next.chatCostLabel);
    renderHistory(next.chats);

    // 只有消息内容真正变化时才重建列表，避免移动光标就抖动
    if (chatChanged || signatureOf(next.messages) !== previousSignature) {
      renderMessages(chatChanged);
    }

    if (next.busy && previous && !previous.busy) {
      pinned = true;
      scrollBottom(true);
    }
  }

  function showToast(text) {
    el.toast.textContent = text;
    el.toast.classList.remove('hidden');
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(function () {
      el.toast.classList.add('hidden');
      toastTimer = 0;
    }, 2600);
  }

  // ------------------------------------------------------------ 事件

  el.messages.addEventListener('scroll', function () {
    pinned = atBottom();
  });

  el.messages.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-act]');
    if (!button) {
      return;
    }
    const act = button.dataset.act;

    if (act === 'suggest') {
      el.input.value = button.dataset.text || '';
      autosize();
      setMode(button.dataset.mode || 'ask', true);
      el.input.focus();
      return;
    }

    if (act === 'apply') {
      vscode.postMessage({ type: 'applyLastEdit', messageId: button.dataset.message });
      return;
    }
    if (act === 'revert') {
      vscode.postMessage({ type: 'revertLastEdit' });
      return;
    }
    if (act === 'retry') {
      vscode.postMessage({ type: 'retry', messageId: button.dataset.message });
      return;
    }

    const codeElement = button.closest('.code') && button.closest('.code').querySelector('code');
    const code = codeElement ? codeElement.textContent : '';
    if (!code) {
      return;
    }
    if (act === 'copy') {
      vscode.postMessage({ type: 'copy', code: code });
    } else if (act === 'insert') {
      vscode.postMessage({ type: 'insertCode', code: code });
    } else if (act === 'replace') {
      vscode.postMessage({ type: 'replaceSelection', code: code });
    }
  });

  el.send.addEventListener('click', send);

  el.stop.addEventListener('click', function () {
    vscode.postMessage({ type: 'stop' });
  });

  el.input.addEventListener('input', autosize);

  el.input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape' && state && state.busy) {
      event.preventDefault();
      vscode.postMessage({ type: 'stop' });
    }
  });

  for (let i = 0; i < el.modeButtons.length; i++) {
    el.modeButtons[i].addEventListener('click', function () {
      setMode(el.modeButtons[i].dataset.mode, true);
      el.input.focus();
    });
  }

  el.model.addEventListener('change', function () {
    vscode.postMessage({ type: 'setModel', model: el.model.value });
  });

  el.thinking.addEventListener('change', function () {
    vscode.postMessage({ type: 'setThinking', value: el.thinking.checked });
  });

  el.newChat.addEventListener('click', function () {
    vscode.postMessage({ type: 'newChat' });
  });

  el.openFile.addEventListener('click', function () {
    vscode.postMessage({ type: 'openFile' });
  });

  el.settings.addEventListener('click', function () {
    vscode.postMessage({ type: 'openSettings' });
  });

  el.keyWarning.addEventListener('click', function () {
    vscode.postMessage({ type: 'setKey' });
  });

  el.historyBtn.addEventListener('click', function () {
    el.historyPanel.classList.toggle('hidden');
  });

  el.historyClose.addEventListener('click', function () {
    el.historyPanel.classList.add('hidden');
  });

  el.historyList.addEventListener('click', function (event) {
    const del = event.target.closest('button[data-del]');
    if (del) {
      event.stopPropagation();
      vscode.postMessage({ type: 'deleteChat', id: del.dataset.del });
      return;
    }
    const item = event.target.closest('li[data-id]');
    if (item) {
      vscode.postMessage({ type: 'selectChat', id: item.dataset.id });
      el.historyPanel.classList.add('hidden');
    }
  });

  el.noticeClose.addEventListener('click', function () {
    dismissedNotice = el.noticeText.textContent || '';
    el.notice.classList.add('hidden');
  });

  function send() {
    if (!state) {
      return;
    }
    const text = el.input.value.trim();
    if (!text || state.busy) {
      el.input.focus();
      return;
    }
    vscode.postMessage({
      type: 'send',
      text: text,
      mode: state.mode || 'ask',
      includeSelection: el.attachSelection.checked,
      includeFile: el.attachFile.checked,
    });
    el.input.value = '';
    autosize();
  }

  // ------------------------------------------------------------ 主机消息

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || !message.type) {
      return;
    }

    switch (message.type) {
      case 'state':
        applyState(message.state);
        break;

      case 'delta': {
        const article = findArticle(message.messageId);
        if (!article) {
          break;
        }
        const body = article.querySelector('.msg-body');
        if (body) {
          body.innerHTML = message.html || '';
        }
        if (message.reasoningHtml) {
          let details = article.querySelector('details.reasoning');
          if (!details) {
            details = document.createElement('details');
            details.className = 'reasoning';
            details.innerHTML = '<summary>思考过程</summary><div class="reasoning-body"></div>';
            article.insertBefore(details, body);
          }
          const reasoningBody = details.querySelector('.reasoning-body');
          if (reasoningBody) {
            reasoningBody.innerHTML = message.reasoningHtml;
          }
        }
        if (pinned) {
          scrollBottom(true);
        }
        break;
      }

      case 'done': {
        if (!state) {
          break;
        }
        for (let i = 0; i < state.messages.length; i++) {
          if (state.messages[i].id === message.message.id) {
            state.messages[i] = message.message;
            break;
          }
        }
        const old = findArticle(message.message.id);
        if (old) {
          old.replaceWith(messageEl(message.message));
        }
        if (pinned) {
          scrollBottom(true);
        }
        break;
      }

      case 'busy':
        setBusy(message.value);
        break;

      case 'toast':
        showToast(message.text);
        break;

      case 'notice': {
        if (message.level && message.text) {
          dismissedNotice = '';
          renderNotice({ level: message.level, text: message.text });
        }
        break;
      }

      case 'focusInput':
        el.input.focus();
        break;

      case 'draft':
        el.input.value = message.text;
        autosize();
        el.input.focus();
        el.input.setSelectionRange(el.input.value.length, el.input.value.length);
        break;

      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
