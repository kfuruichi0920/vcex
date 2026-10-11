/* global acquireVsCodeApi, document, window */
const vscode = acquireVsCodeApi();
const find = (id) => document.getElementById(id);
let busy = false;
let preparing = false;
function updateActions() {
  find('send').disabled = preparing || !find('question').value.trim();
  find('send').textContent = busy ? '送信予約' : '送信';
  find('send-hint').textContent = busy
    ? '回答待ち中も次の質問を送信予約できます。'
    : '送信内容は質問と回答のファイルに記録します。';
}
find('question').addEventListener('input', () => {
  const length = find('question').value.length;
  find('question-count').textContent = `${length.toLocaleString()} 文字`;
  find('warning').textContent =
    length > 38000 ? '警告: 38,000文字超です。送信は可能です。' : '';
  updateActions();
});
find('files').addEventListener('click', () =>
  vscode.postMessage({ type: 'files' }),
);
find('send').addEventListener('click', () => {
  if (preparing || !find('question').value.trim()) return;
  preparing = true;
  updateActions();
  const file = find('context-file').checked;
  const selection = find('context-selection').checked;
  vscode.postMessage({
    type: 'send',
    question: find('question').value,
    mode:
      file && selection
        ? 'both'
        : file
          ? 'file'
          : selection
            ? 'selection'
            : 'none',
    promptName: find('system-prompt').value,
  });
});
find('system-prompt').addEventListener('change', () => {
  find('prompt-content').textContent = '読み込み中…';
  vscode.postMessage({
    type: 'prompt-select',
    promptName: find('system-prompt').value,
  });
});
for (const type of ['prompt-folder', 'prompt-refresh'])
  find(type).addEventListener('click', () => {
    vscode.postMessage({ type });
  });
find('cancel').addEventListener('click', () =>
  vscode.postMessage({ type: 'cancel' }),
);
find('settings').addEventListener('click', () =>
  vscode.postMessage({ type: 'settings' }),
);
let composing = false;
document.addEventListener('compositionstart', () => {
  composing = true;
});
document.addEventListener('compositionend', () => {
  composing = false;
});
// Webview 内でのみ有効。IME 確定やキー長押しでは実行しない。
document.addEventListener(
  'keydown',
  (event) => {
    if (composing || event.isComposing || !event.ctrlKey || event.metaKey)
      return;
    let action;
    if (event.key === 'Enter' && !event.altKey)
      action = event.shiftKey ? (busy ? 'cancel' : undefined) : 'send';
    else if (event.key.toLowerCase() === 'a' && event.altKey && !event.shiftKey)
      action = 'files';
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) find(action).click();
  },
  true,
);

document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => {
  event.preventDefault();
  find('status').textContent =
    'D&D では元ファイルのパスを取得できません。「ファイルを追加」で選択してください。';
});
window.addEventListener('message', ({ data }) => {
  if (data.type === 'prompts') {
    const selected = find('system-prompt').value;
    find('system-prompt').replaceChildren();
    for (const name of ['', ...data.names]) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name || 'なし';
      find('system-prompt').append(option);
    }
    if (data.names.includes(selected)) find('system-prompt').value = selected;
    find('prompt-directory').textContent = data.directory;
    find('prompt-directory').title = data.directory;
    vscode.postMessage({
      type: 'prompt-select',
      promptName: find('system-prompt').value,
    });
  } else if (data.type === 'prompt-content') {
    if (data.name === find('system-prompt').value)
      find('prompt-content').textContent = data.text || 'なし';
  } else if (data.type === 'context-target') {
    find('context-target').textContent = data.text;
    find('context-target').title = data.text;
  } else if (data.type === 'jobs') {
    find('queue-count').textContent = `${data.pending} 待機`;
    find('jobs-empty').hidden = data.jobs.length > 0;
    find('jobs').replaceChildren();
    for (const job of data.jobs) {
      const row = document.createElement('li');
      row.dataset.state = job.state;
      const label = document.createElement('span');
      label.textContent = job.question;
      label.title = job.question + (job.logPath ? `\n${job.logPath}` : '');
      const state = document.createElement('span');
      state.className = 'badge';
      state.textContent = job.state;
      row.append(label, state);
      if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.state)) {
        const cancel = document.createElement('button');
        cancel.className = 'secondary compact';
        cancel.textContent = '取消';
        cancel.setAttribute('aria-label', `${job.question} を取り消す`);
        cancel.addEventListener('click', () =>
          vscode.postMessage({ type: 'cancel', id: job.id }),
        );
        row.append(cancel);
      }
      find('jobs').append(row);
    }
  } else if (data.type === 'accepted') {
    if (find('question').value === data.question) {
      find('question').value = '';
      find('question-count').textContent = '0 文字';
      find('warning').textContent = '';
    }
    find('question').focus();
    updateActions();
  } else if (data.type === 'files') {
    find('attachment-count').textContent = data.files.length;
    find('attachment-empty').hidden = data.files.length > 0;
    find('attachments').replaceChildren();
    data.files.forEach((file, index) => {
      const name = file.name;
      const row = document.createElement('li');
      if (file.thumbnail) {
        const image = document.createElement('img');
        image.src = file.thumbnail;
        image.alt = `${name} のサムネイル`;
        image.addEventListener('error', () => {
          image.hidden = true;
        });
        row.append(image);
      }
      const filename = document.createElement('span');
      filename.textContent = name;
      filename.title = name;
      const info = document.createElement('small');
      info.textContent =
        file.note ||
        (file.size === undefined ? '' : `${(file.size / 1024).toFixed(1)} KB`);
      filename.append(info);
      row.append(filename);
      const remove = document.createElement('button');
      remove.textContent = '削除';
      remove.className = 'secondary compact';
      remove.setAttribute('aria-label', `${name} を削除`);
      remove.addEventListener('click', () => {
        vscode.postMessage({ type: 'remove', index });
      });
      row.append(remove);
      find('attachments').append(row);
    });
  } else if (data.type === 'status' || data.type === 'error') {
    find('status').textContent = data.text;
  } else if (data.type === 'preparing') {
    preparing = data.busy;
    updateActions();
  } else if (data.type === 'busy') {
    busy = data.busy;
    find('cancel').hidden = !data.busy;
    updateActions();
  }
});
vscode.postMessage({ type: 'ready' });
