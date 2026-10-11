import * as vscode from 'vscode';
import { join, isAbsolute, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareQuestion } from './context';
import {
  BridgeError,
  errorText,
  validateUrl,
  type ContextMode,
  type PreparedQuestion,
  type RunOptions,
  type State,
} from './domain';
import { JobRunner } from './runner';
import { attachmentView, listPrompts, loadPrompt } from './assets';

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
interface QueuedQuestion {
  id: string;
  input: PreparedQuestion;
  options: RunOptions;
  state: State | 'QUEUED';
  logPath?: string;
}
class Sidebar implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private files: vscode.Uri[] = [];
  private lastEditor = vscode.window.activeTextEditor;
  private controller: AbortController | undefined;
  private busy = false;
  private running = false;
  private queue: QueuedQuestion[] = [];
  private jobs: QueuedQuestion[] = [];
  private activeId: string | undefined;
  private readonly logFiles = new Set<string>();
  private readonly runner = new JobRunner();
  constructor(private readonly context: vscode.ExtensionContext) {
    this.files = context.workspaceState
      .get<string[]>('attachments', [])
      .filter((path) => typeof path === 'string' && isAbsolute(path))
      .map((path) => vscode.Uri.file(path));
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (
          editor &&
          !this.logFiles.has(editor.document.uri.fsPath.toLowerCase())
        ) {
          this.lastEditor = editor;
          this.publishContext();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === this.lastEditor) this.publishContext();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('webAiBridge')) {
          void this.publishPrompts().catch((error) =>
            this.post({ type: 'error', text: errorText(error) }),
          );
        }
      }),
    );
  }
  cancel(): void {
    this.controller?.abort();
  }
  dispose(): void {
    this.queue = [];
    this.cancel();
  }
  async attachFiles(files: readonly vscode.Uri[]): Promise<void> {
    this.files = [
      ...new Map(
        [...this.files, ...files]
          .filter((uri) => uri.scheme === 'file')
          .map((uri) => [uri.fsPath.toLowerCase(), uri]),
      ).values(),
    ];
    await this.context.workspaceState.update(
      'attachments',
      this.files.map((file) => file.fsPath),
    );
    await this.publishFiles();
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
    view.webview.html = `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src ${view.webview.cspSource}; style-src ${view.webview.cspSource};"><link rel="stylesheet" href="${uri('sidebar.css')}"></head><body>
      <header class="toolbar"><strong>WEB AI BRIDGE</strong><span class="badge">Phase 0</span><button id="settings" class="secondary compact" title="Web AI Bridge の設定を開く">設定</button></header>
      <main>
        <p class="quick-start">質問とコンテキストを選んで送信</p>
        <section class="panel"><div class="section-heading"><label for="system-prompt">システムプロンプト</label></div><select id="system-prompt"><option value="">なし</option></select><details class="prompt-content"><summary>詳細</summary><div class="prompt-tools"><button id="prompt-folder" class="secondary compact">フォルダ</button><button id="prompt-refresh" class="secondary compact">更新</button></div><p id="prompt-directory" class="note hint"></p><pre id="prompt-content">なし</pre><p class="note hint">Markdown 本文を質問の先頭へ付加します。</p></details></section>
        <section class="panel"><div class="section-heading"><label for="question">質問</label><span id="question-count" class="note">0 文字</span></div><textarea id="question" rows="5" placeholder="質問を入力…（複数行対応）"></textarea></section>
        <section class="panel"><div class="section-heading"><h3>コンテキスト</h3></div><div class="context-options"><label><input id="context-file" type="checkbox">今開いているファイル <span class="note">全文</span></label><label><input id="context-selection" type="checkbox">選択箇所</label></div><p id="context-target" class="note hint">未チェックなら質問と添付のみ送信</p></section>
        <section class="panel"><div class="section-heading"><h3>添付 <span id="attachment-count" class="badge">0</span></h3><button id="files" class="secondary compact" title="ファイルを追加（Ctrl+Alt+A）" aria-keyshortcuts="Control+Alt+A">＋ ファイルを追加</button></div><ul id="attachments"></ul><p id="attachment-empty" class="note hint">添付なし · PNG / Office / PDF · 複数選択可</p></section>
        <section class="panel"><div class="section-heading"><h3>送信ジョブ <span id="queue-count" class="badge">0</span></h3><span class="note">順次実行</span></div><ul id="jobs"></ul><p id="jobs-empty" class="note hint">回答待ち中も次の質問を送信予約できます。</p></section>
        <details id="help" class="panel help"><summary>使い方・接続の準備</summary><ol><li>検証用チャットを開発ターミナルで <code>npm run mock:chat</code> により起動します。現状は仮 React チャット専用です。</li><li>「設定」で接続方式を <code>dedicated</code> にすると専用 Edge を起動できます。既存 Edge を使う <code>cdp</code> はリモートデバッグ接続の準備が必要です。</li><li>質問を入力し、必要なコンテキストにチェックします。「ファイルを追加」で選んだ添付は削除するまで維持されます。</li><li>「送信」で実行します。回答待ち中は次の質問を「送信予約」できます。送信内容は質問と回答の Markdown ファイルに記録します。</li><li>完了すると回答の Markdown ログが開きます。実行中は「取り消す」で中断できます。送信済みの質問は取り消せません。</li></ol><p class="note">キー操作（パネル内）: Ctrl+Enter で送信・予約、Ctrl+Alt+A でファイル追加、Ctrl+Shift+Enter で実行取消。Enter は改行、Tab で移動、Space でチェック切替。日本語変換中は送信しません。</p><p class="note">添付は表示ありの Edge を使用してください。貼り付け中は他アプリでコピー操作を避けてください。クリップボードの完全復元は保証されません。画像の直接貼り付け・D&amp;D・/ コマンド・@ 補完は後続対応です。</p></details>
      </main>
      <footer class="action-bar"><div class="actions"><button id="send" disabled title="送信・送信予約（Ctrl+Enter）" aria-keyshortcuts="Control+Enter">送信</button><button id="cancel" class="secondary" hidden title="実行中の質問を取り消す（Ctrl+Shift+Enter）" aria-keyshortcuts="Control+Shift+Enter">取り消す</button></div><p class="note hint">Ctrl+Enter で送信 · Enter で改行</p><p id="send-hint" class="note hint">質問を入力して送信してください。</p><p id="warning" role="status"></p><p id="status" role="status" aria-live="polite">READY</p></footer>
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
      },
      undefined,
      this.context.subscriptions,
    );
  }
  private post(message: object): void {
    void this.view?.webview.postMessage(message);
  }
  private publishContext(): void {
    const editor = this.lastEditor;
    this.post({
      type: 'context-target',
      text: editor
        ? `${basename(editor.document.fileName)} · 選択 ${editor.selections.filter((selection) => !selection.isEmpty).length} 箇所`
        : '対象のテキストエディタなし',
    });
  }
  private promptDirectory(): string {
    const directory = vscode.workspace
      .getConfiguration('webAiBridge')
      .get<string>('promptDirectory', '');
    if (!directory) return join(this.context.extensionPath, 'media/prompts');
    if (!isAbsolute(directory) && !vscode.workspace.workspaceFolders?.length)
      throw new BridgeError(
        'PROMPT_DIRECTORY',
        'フォルダは絶対パスで指定するかワークスペースを開いてください。',
      );
    return resolve(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
      directory,
    );
  }
  private async publishPrompts(): Promise<void> {
    const directory = this.promptDirectory();
    this.post({
      type: 'prompts',
      directory,
      names: await listPrompts(directory),
    });
  }
  private async publishFiles(): Promise<void> {
    this.post({
      type: 'files',
      files: await Promise.all(
        this.files.map((file) =>
          attachmentView(file.fsPath, vscode.workspace.asRelativePath(file)),
        ),
      ),
    });
  }
  private publishJobs(): void {
    this.post({
      type: 'jobs',
      pending: this.queue.length,
      jobs: this.jobs.map((job) => ({
        id: job.id,
        question: job.input.question,
        state: job.state,
        logPath: job.logPath,
      })),
    });
    this.post({ type: 'busy', busy: this.running });
  }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        this.activeId = job.id;
        this.controller = new AbortController();
        this.publishJobs();
        try {
          const result = await this.runner.run(
            job.input,
            job.options,
            this.controller.signal,
            (state) => {
              job.state = state;
              this.publishJobs();
              this.post({ type: 'status', text: state });
            },
          );
          job.state = result.state;
          job.logPath = result.logPath;
          this.post({
            type: 'status',
            text: `${result.state}${result.error ? `\n${result.error}` : ''}${result.logPath ? `\nログ: ${result.logPath}` : ''}${result.warnings.length ? `\n${result.warnings.join('\n')}` : ''}`,
          });
          if (result.logPath) this.logFiles.add(result.logPath.toLowerCase());
          if (
            result.logPath &&
            vscode.workspace
              .getConfiguration('webAiBridge')
              .get('openLog', true)
          )
            await vscode.window.showTextDocument(
              vscode.Uri.file(result.logPath),
              { preview: false, preserveFocus: true },
            );
        } catch (error) {
          job.state = 'FAILED';
          this.post({ type: 'error', text: errorText(error) });
        } finally {
          this.controller = undefined;
          this.activeId = undefined;
          this.publishJobs();
        }
      }
    } finally {
      this.running = false;
      this.publishJobs();
    }
  }
  private async receive(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || !('type' in value)) return;
    const message = value as {
      type: string;
      question?: string;
      mode?: ContextMode;
      index?: number;
      id?: string;
      promptName?: string;
    };
    if (message.type === 'ready') {
      await this.publishPrompts();
      await this.publishFiles();
      this.publishJobs();
      this.publishContext();
      return;
    }
    if (message.type === 'prompt-folder') {
      const selected = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title: 'システムプロンプトの Markdown フォルダ',
      });
      if (selected?.[0])
        await vscode.workspace
          .getConfiguration('webAiBridge')
          .update(
            'promptDirectory',
            selected[0].fsPath,
            vscode.workspace.workspaceFolders?.length
              ? vscode.ConfigurationTarget.Workspace
              : vscode.ConfigurationTarget.Global,
          );
      return;
    }
    if (message.type === 'prompt-refresh') {
      await this.publishPrompts();
      return;
    }
    if (message.type === 'prompt-select') {
      const name =
        typeof message.promptName === 'string' ? message.promptName : '';
      this.post({
        type: 'prompt-content',
        name,
        text: await loadPrompt(this.promptDirectory(), name),
      });
      return;
    }
    if (message.type === 'cancel') {
      if (message.id && message.id !== this.activeId) {
        const index = this.queue.findIndex((job) => job.id === message.id);
        const job = index >= 0 ? this.queue.splice(index, 1)[0] : undefined;
        if (job) job.state = 'CANCELLED';
        this.publishJobs();
        return;
      }
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
      if (files) await this.attachFiles(files);
    } else if (
      message.type === 'remove' &&
      Number.isInteger(message.index) &&
      message.index! >= 0
    ) {
      this.files.splice(message.index!, 1);
      await this.context.workspaceState.update(
        'attachments',
        this.files.map((file) => file.fsPath),
      );
      await this.publishFiles();
    } else if (message.type === 'send') {
      if (
        typeof message.question !== 'string' ||
        !['selection', 'file', 'both', 'none'].includes(message.mode || '')
      )
        return;
      this.busy = true;
      this.post({ type: 'preparing', busy: true });
      try {
        const settings = options(this.context);
        const input = await prepareQuestion(
          message.question,
          message.mode!,
          this.lastEditor,
          [...this.files],
        );
        input.systemPromptName =
          typeof message.promptName === 'string' ? message.promptName : '';
        input.systemPrompt = await loadPrompt(
          this.promptDirectory(),
          input.systemPromptName,
        );
        if (input.systemPrompt)
          input.prompt = `## システムプロンプト\n${input.systemPrompt}\n\n## ユーザー質問\n${input.prompt}`;
        const job: QueuedQuestion = {
          id: randomUUID(),
          input,
          options: settings,
          state: 'QUEUED',
        };
        this.jobs = this.jobs
          .filter(
            (entry) => entry.state === 'QUEUED' || entry.id === this.activeId,
          )
          .concat(
            this.jobs
              .filter(
                (entry) =>
                  entry.state !== 'QUEUED' && entry.id !== this.activeId,
              )
              .slice(-19),
            job,
          );
        this.queue.push(job);
        this.publishJobs();
        this.post({ type: 'accepted', question: message.question });
        void this.drain();
      } finally {
        this.busy = false;
        this.post({ type: 'preparing', busy: false });
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
    vscode.commands.registerCommand(
      'web-ai-bridge.attachFiles',
      async (
        uri: vscode.Uri | undefined,
        selected: vscode.Uri[] | undefined,
      ) => {
        await sidebar.attachFiles(selected || (uri ? [uri] : []));
        await vscode.commands.executeCommand('web-ai-bridge.open');
      },
    ),
    { dispose: () => sidebar.dispose() },
  );
}
