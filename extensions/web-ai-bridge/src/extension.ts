import * as vscode from 'vscode';
import { join, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareQuestion } from './context';
import {
  BridgeError,
  errorText,
  validateUrl,
  type ContextMode,
  type PreparedQuestion,
  type RunOptions,
} from './domain';
import { JobRunner } from './runner';

function options(context: vscode.ExtensionContext): RunOptions {
  const config = vscode.workspace.getConfiguration('webAiBridge');
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const directory = config.get<string>('logDirectory', '');
  if (!directory && !workspace)
    throw new BridgeError(
      'LOG_DIRECTORY_REQUIRED',
      'ワークスペースを開くかログ保存先を設定してください。',
    );
  const profile =
    config.get<string>('profileDirectory', '') ||
    join(context.globalStorageUri.fsPath, 'edge-profile');
  if (!isAbsolute(profile))
    throw new BridgeError(
      'INVALID_PROFILE',
      '専用プロファイルには絶対パスを指定してください。',
    );
  const mode = config.get<'cdp' | 'dedicated'>('connectionMode', 'cdp');
  if (!['cdp', 'dedicated'].includes(mode))
    throw new BridgeError('INVALID_MODE', '接続方式を設定し直してください。');
  const timeoutSeconds = config.get<number>('timeoutSeconds', 120);
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds < 5 ||
    timeoutSeconds > 3600
  )
    throw new BridgeError(
      'INVALID_TIMEOUT',
      '待機時間は 5〜3600 秒で指定してください。',
    );
  return {
    url: validateUrl(config.get<string>('url', 'http://127.0.0.1:4173')),
    connection: {
      mode,
      endpoint: config.get<string>('cdpEndpoint', 'http://127.0.0.1:9222'),
      profile,
      headless: config.get<boolean>('headless', false),
    },
    logDirectory: directory
      ? resolve(workspace || context.globalStorageUri.fsPath, directory)
      : join(workspace!, 'web-ai-bridge-logs'),
    timeoutMs: timeoutSeconds * 1000,
    clipboardScript: join(context.extensionPath, 'dist/clipboard.ps1'),
  };
}
class Sidebar implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private files: vscode.Uri[] = [];
  private lastEditor = vscode.window.activeTextEditor;
  private prepared:
    { id: string; input: PreparedQuestion; options: RunOptions } | undefined;
  private controller: AbortController | undefined;
  private busy = false;
  private readonly runner = new JobRunner();
  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) this.lastEditor = editor;
      }),
    );
  }
  cancel(): void {
    this.controller?.abort();
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    const uri = (file: string) =>
      view.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'media', file),
      );
    view.webview.html = `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${view.webview.cspSource}; style-src ${view.webview.cspSource};"><link rel="stylesheet" href="${uri('sidebar.css')}"></head><body>
      <h2>Web AI Bridge</h2><p class="note">Phase 0 · 仮 React チャット</p>
      <label for="question">質問</label><textarea id="question" rows="8" placeholder="日本語・複数行で入力できます"></textarea>
      <label for="context">エディタのコンテキスト</label><select id="context"><option value="auto">自動（選択範囲／ファイル添付）</option><option value="selection">選択範囲</option><option value="file">ファイル全文を添付</option><option value="none">なし</option></select>
      <p class="note">最後に開いたテキストエディタを使用します。</p><button id="files">ファイルを追加</button><ul id="attachments"></ul>
      <p class="note">PNG / Office / PDF、複数ファイル対応。D&amp;D はファイル選択へ案内します。/コマンド・@補完は後続フェーズです。</p>
      <button id="preview">送信前に確認</button><section id="confirmation" hidden><h3>送信内容</h3><pre id="details"></pre><p id="warning"></p><button id="send">この内容で送信</button></section>
      <button id="cancel" hidden>取り消す</button><p id="status" role="status" aria-live="polite">READY</p><button id="settings">設定を開く</button>
      <p class="note">CDP は既存 Edge を非表示にできません。専用 Edge は別ログインが必要になる場合があります。添付時のクリップボード完全復元は保証されません。</p>
      <script src="${uri('sidebar.js')}"></script></body></html>`;
    view.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.receive(message).catch((error) =>
          this.post({ type: 'error', text: errorText(error) }),
        );
      },
      undefined,
      this.context.subscriptions,
    );
    view.onDidDispose(
      () => {
        this.view = undefined;
        this.prepared = undefined;
      },
      undefined,
      this.context.subscriptions,
    );
  }
  private post(message: object): void {
    void this.view?.webview.postMessage(message);
  }
  private async receive(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || !('type' in value)) return;
    const message = value as {
      type: string;
      question?: string;
      mode?: ContextMode;
      index?: number;
      id?: string;
    };
    if (message.type === 'cancel') {
      this.cancel();
      return;
    }
    if (message.type === 'settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'webAiBridge',
      );
      return;
    }
    if (this.busy)
      throw new BridgeError(
        'BUSY',
        '進行中の処理が終了するまでお待ちください。',
      );
    if (message.type === 'files') {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: true,
        title: '添付ファイルを選択',
      });
      if (files)
        this.files = [
          ...new Map(
            [...this.files, ...files]
              .filter((uri) => uri.scheme === 'file')
              .map((uri) => [uri.fsPath.toLowerCase(), uri]),
          ).values(),
        ];
      this.prepared = undefined;
      this.post({
        type: 'files',
        files: this.files.map((file) => vscode.workspace.asRelativePath(file)),
      });
    } else if (
      message.type === 'remove' &&
      Number.isInteger(message.index) &&
      message.index! >= 0
    ) {
      this.files.splice(message.index!, 1);
      this.prepared = undefined;
      this.post({
        type: 'files',
        files: this.files.map((file) => vscode.workspace.asRelativePath(file)),
      });
    } else if (message.type === 'invalidate') {
      this.prepared = undefined;
    } else if (message.type === 'preview') {
      if (
        typeof message.question !== 'string' ||
        !['auto', 'selection', 'file', 'none'].includes(message.mode || '')
      )
        return;
      this.prepared = undefined;
      this.busy = true;
      try {
        const input = await prepareQuestion(
          message.question,
          message.mode!,
          this.lastEditor,
          this.files,
        );
        const settings = options(this.context);
        this.prepared = { id: randomUUID(), input, options: settings };
        this.post({
          type: 'preview',
          id: this.prepared.id,
          text: `送信先: ${settings.url}\n方式: ${settings.connection.mode}${settings.connection.mode === 'dedicated' ? (settings.connection.headless ? '（非表示）' : '（表示）') : '（既存 Edge・非表示化不可）'}\nログ保存先: ${settings.logDirectory}\n\n${input.prompt}\n\n添付:\n${input.attachments.map((file) => `${file.name} (${file.size} bytes)`).join('\n') || 'なし'}`,
          warning:
            input.prompt.length > 38000
              ? `警告: 送信テキストが ${input.prompt.length} 文字（38,000文字超）です。送信は可能です。`
              : '',
        });
      } finally {
        this.busy = false;
      }
    } else if (message.type === 'send') {
      const prepared = this.prepared;
      if (!prepared || prepared.id !== message.id)
        throw new BridgeError(
          'PREVIEW_REQUIRED',
          '送信内容をもう一度確認してください。',
        );
      this.prepared = undefined;
      this.busy = true;
      this.controller = new AbortController();
      this.post({ type: 'busy', busy: true });
      try {
        const result = await this.runner.run(
          prepared.input,
          prepared.options,
          this.controller.signal,
          (state) => this.post({ type: 'status', text: state }),
        );
        this.post({
          type: 'status',
          text: `${result.state}${result.error ? `\n${result.error}` : ''}${result.logPath ? `\nログ: ${result.logPath}` : ''}${result.warnings.length ? `\n${result.warnings.join('\n')}` : ''}`,
        });
        if (
          result.logPath &&
          vscode.workspace.getConfiguration('webAiBridge').get('openLog', true)
        )
          await vscode.window.showTextDocument(
            vscode.Uri.file(result.logPath),
            { preview: false },
          );
      } finally {
        this.busy = false;
        this.controller = undefined;
        this.post({ type: 'busy', busy: false });
      }
    }
  }
}
export function activate(context: vscode.ExtensionContext): void {
  const sidebar = new Sidebar(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('web-ai-bridge.sidebar', sidebar),
    vscode.commands.registerCommand('web-ai-bridge.open', () =>
      vscode.commands.executeCommand('web-ai-bridge.sidebar.focus'),
    ),
    vscode.commands.registerCommand('web-ai-bridge.cancel', () =>
      sidebar.cancel(),
    ),
    { dispose: () => sidebar.cancel() },
  );
}
