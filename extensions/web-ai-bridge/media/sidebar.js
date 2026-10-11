/* global acquireVsCodeApi, document, window */
const vscode = acquireVsCodeApi();
const find = (id) => document.getElementById(id);
let previewId;
function invalidate() {
  previewId = undefined;
  find('confirmation').hidden = true;
  vscode.postMessage({ type: 'invalidate' });
}
find('question').addEventListener('input', invalidate);
find('context').addEventListener('change', invalidate);
find('files').addEventListener('click', () => {
  invalidate();
  vscode.postMessage({ type: 'files' });
});
find('preview').addEventListener('click', () => {
  invalidate();
  vscode.postMessage({
    type: 'preview',
    question: find('question').value,
    mode: find('context').value,
  });
});
find('send').addEventListener('click', () => {
  vscode.postMessage({ type: 'send', id: previewId });
  find('confirmation').hidden = true;
});
find('cancel').addEventListener('click', () =>
  vscode.postMessage({ type: 'cancel' }),
);
find('settings').addEventListener('click', () =>
  vscode.postMessage({ type: 'settings' }),
);
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => {
  event.preventDefault();
  find('status').textContent =
    'D&D では元ファイルのパスを取得できません。「ファイルを追加」で選択してください。';
});
window.addEventListener('message', ({ data }) => {
  if (data.type === 'preview') {
    previewId = data.id;
    find('details').textContent = data.text;
    find('warning').textContent = data.warning;
    find('confirmation').hidden = false;
  } else if (data.type === 'files') {
    find('attachments').replaceChildren();
    data.files.forEach((name, index) => {
      const row = document.createElement('li');
      row.append(document.createTextNode(name + ' '));
      const remove = document.createElement('button');
      remove.textContent = '削除';
      remove.addEventListener('click', () => {
        invalidate();
        vscode.postMessage({ type: 'remove', index });
      });
      row.append(remove);
      find('attachments').append(row);
    });
  } else if (data.type === 'status' || data.type === 'error') {
    find('status').textContent = data.text;
  } else if (data.type === 'busy') {
    for (const id of ['question', 'context', 'files', 'preview', 'send'])
      find(id).disabled = data.busy;
    find('cancel').hidden = !data.busy;
  }
});
