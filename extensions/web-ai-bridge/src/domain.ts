export type State =
  | 'READY'
  | 'VALIDATING'
  | 'CONNECTING'
  | 'UPLOADING'
  | 'SUBMITTED'
  | 'GENERATING'
  | 'EXTRACTING'
  | 'SAVING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';
export type ContextMode = 'auto' | 'selection' | 'file' | 'none';
export interface Attachment {
  path: string;
  name: string;
  size: number;
  mtime: number;
  kind: 'png' | 'file';
  result: string;
}
export interface PreparedQuestion {
  question: string;
  prompt: string;
  context: string;
  attachments: Attachment[];
}
export interface ConnectionOptions {
  mode: 'cdp' | 'dedicated';
  endpoint: string;
  profile: string;
  headless: boolean;
}
export interface RunOptions {
  url: string;
  connection: ConnectionOptions;
  logDirectory: string;
  timeoutMs: number;
  clipboardScript: string;
}
export interface Execution {
  started: Date;
  state: State;
  destination: string;
  input: PreparedQuestion;
  answer: string;
  error: string;
  warnings: string[];
  logPath: string;
}
export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}
export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted)
    throw new BridgeError(
      'CANCELLED',
      '利用者が取り消しました。送信済みの質問は撤回されません。',
    );
}
export function errorText(error: unknown): string {
  return error instanceof BridgeError
    ? `${error.code}: ${error.message}`
    : 'UNEXPECTED: 処理に失敗しました。接続設定・対象サイトを確認してください。';
}
export function validateUrl(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new BridgeError(
      'INVALID_URL',
      '認証情報を含まない HTTP(S) URL を指定してください。',
    );
  return url.href;
}
/** URL クエリ・fragment に含まれうる認証情報をログへ出さない。 */
export function publicDestination(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}
