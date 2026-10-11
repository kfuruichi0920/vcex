import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { BridgeError } from './domain';

export interface ClipboardSession {
  partial: boolean;
  image(bytes: Buffer): Promise<void>;
  files(paths: string[]): Promise<void>;
  restore(): Promise<void>;
}
export async function openClipboard(script: string): Promise<ClipboardSession> {
  if (process.platform !== 'win32')
    throw new BridgeError('CLIPBOARD_FAILED', 'Windows のみ対応します。');
  // Windows 標準 PowerShell を利用。追加ランタイムや PNG 一時ファイルは不要。
  const executable = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const child = spawn(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', script],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lines = createInterface({ input: child.stdout });
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  type Response = { ok: boolean; partial?: boolean };
  let pending:
    | { resolve: (value: Response) => void; reject: (error: Error) => void }
    | undefined;
  let terminated = false;
  const failure = () =>
    new BridgeError(
      'CLIPBOARD_FAILED',
      'クリップボードの準備・復元に失敗しました。別操作との競合や Windows の制限を確認してください。',
    );
  const queue: Response[] = [];
  lines.on('line', (line) => {
    try {
      const response = JSON.parse(line) as Response;
      if (pending) {
        const waiter = pending;
        pending = undefined;
        waiter.resolve(response);
      } else queue.push(response);
    } catch {
      pending?.reject(failure());
      pending = undefined;
    }
  });
  const onFailure = () => {
    terminated = true;
    pending?.reject(failure());
    pending = undefined;
  };
  child.on('error', onFailure);
  child.on('exit', onFailure);
  child.stdin.on('error', onFailure);
  // エラー出力はパス・データをログへ流さないが、パイプは drain する。
  child.stderr.resume();
  async function response(): Promise<Response> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = queue.length
        ? queue.shift()!
        : await new Promise<Response>((resolve, reject) => {
            if (terminated) {
              reject(failure());
              return;
            }
            pending = { resolve, reject };
            timer = setTimeout(() => {
              pending = undefined;
              reject(failure());
            }, 10000);
          });
      if (!value.ok) throw failure();
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  async function request(payload: object): Promise<void> {
    if (terminated || child.stdin.writableEnded || child.stdin.destroyed)
      throw failure();
    await new Promise<void>((resolve, reject) =>
      child.stdin.write(JSON.stringify(payload) + '\n', (error) =>
        error ? reject(failure()) : resolve(),
      ),
    );
    await response();
  }
  let initial: Response;
  try {
    initial = await response();
  } catch (error) {
    child.stdin.end();
    child.kill();
    throw error;
  }
  let restorePromise: Promise<void> | undefined;
  return {
    partial: Boolean(initial.partial),
    image: (bytes) =>
      request({ action: 'image', base64: bytes.toString('base64') }),
    files: (paths) => request({ action: 'files', paths }),
    restore() {
      return (restorePromise ??= (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await request({ action: 'restore' });
        } finally {
          child.stdin.end();
          try {
            await Promise.race([
              exited,
              new Promise<void>((_, reject) => {
                timer = setTimeout(() => {
                  child.kill();
                  reject(failure());
                }, 5000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
            lines.close();
          }
        }
      })());
    },
  };
}
