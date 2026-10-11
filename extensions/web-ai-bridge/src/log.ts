import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Execution } from './domain';
import { BridgeError } from './domain';

export function logName(date: Date, question: string): string {
  const digits = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${date.getFullYear()}${digits(date.getMonth() + 1)}${digits(date.getDate())}-${digits(date.getHours())}${digits(date.getMinutes())}${digits(date.getSeconds())}`;
  // Windows ファイル名で禁止される制御文字も除去する。
  const title =
    question
      .trim()
      .split(/\r?\n/)[0]
      ?.replace(/[<>:"/\\|?*]/g, '')
      .split('')
      .filter((character) => character.charCodeAt(0) > 31)
      .join('')
      .trim()
      .replace(/[. ]+$/g, '')
      .slice(0, 60)
      .replace(/[. ]+$/g, '') || '質問';
  return `${timestamp}_${title}`;
}
function literal(value: string): string {
  const longest = Math.max(
    2,
    ...Array.from(value.matchAll(/`+/g), (m) => m[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${value}\n${fence}`;
}
export function renderLog(job: Execution): string {
  return (
    [
      '# Web AI Bridge',
      '## 実行情報',
      `- 実行日時: ${job.started.toString()}\n- 接続先: ${job.destination}\n- 実行状態: ${job.state}`,
      '## ユーザー質問',
      literal(job.input.question),
      '## 定型プロンプト',
      'Phase 0: /コマンド展開は未実装。',
      '## コンテキスト',
      literal(job.input.context || 'なし'),
      '## 送信テキスト',
      literal(job.input.prompt),
      '## 添付ファイル',
      job.input.attachments.length
        ? job.input.attachments
            .map((a) => literal(`${a.name} (${a.size} bytes): ${a.result}`))
            .join('\n\n')
        : 'なし',
      '## AI回答',
      job.answer || '（未取得）',
      '## エラー情報',
      literal(job.error || 'なし'),
      '## 注意事項',
      literal(job.warnings.join('\n') || 'なし'),
    ].join('\n\n') + '\n'
  );
}
export async function createLog(
  directory: string,
  job: Execution,
): Promise<string> {
  try {
    await mkdir(directory, { recursive: true });
    const base = logName(job.started, job.input.question);
    for (let index = 0; index < 10000; index++) {
      const path = join(directory, `${base}${index ? `_${index}` : ''}.md`);
      try {
        const file = await open(path, 'wx');
        try {
          await file.writeFile(renderLog(job), 'utf8');
        } finally {
          await file.close();
        }
        return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('Too many logs');
  } catch {
    throw new BridgeError(
      'SAVE_FAILED',
      'ログを作成できません。送信を中断しました。保存先と書込権限を確認してください。',
    );
  }
}
export async function updateLog(job: Execution): Promise<void> {
  try {
    await writeFile(job.logPath, renderLog(job), 'utf8');
  } catch {
    throw new BridgeError(
      'SAVE_FAILED',
      'ログの更新に失敗しました。再送せず保存先を確認してください。',
    );
  }
}
