import * as vscode from 'vscode';
import { basename, extname } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  BridgeError,
  type Attachment,
  type ContextMode,
  type PreparedQuestion,
} from './domain';

export async function describeFile(path: string): Promise<Attachment> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile())
    throw new BridgeError(
      'INVALID_FILE',
      '添付対象を読み取れません。ファイルを選び直してください。',
    );
  return {
    path,
    name: basename(path),
    size: info.size,
    mtime: info.mtimeMs,
    kind: extname(path).toLowerCase() === '.png' ? 'png' : 'file',
    result: '未送信',
  };
}
export async function prepareQuestion(
  question: string,
  mode: ContextMode,
  editor: vscode.TextEditor | undefined,
  files: readonly vscode.Uri[],
): Promise<PreparedQuestion> {
  if (!question.trim())
    throw new BridgeError('INVALID_QUESTION', '質問を入力してください。');
  let context = '';
  const paths = new Map(
    files.map((file) => [file.fsPath.toLowerCase(), file.fsPath]),
  );
  if (editor && mode !== 'none') {
    const selections = editor.selections
      .filter((selection) => !selection.isEmpty)
      .sort((a, b) => a.start.compareTo(b.start));
    if (mode === 'selection' || (mode === 'auto' && selections.length)) {
      context = selections
        .map(
          (range) =>
            `--- ${basename(editor.document.fileName)}:${range.start.line + 1}-${range.end.line + 1} ---\n${editor.document.getText(range)}`,
        )
        .join('\n\n');
    } else {
      if (editor.document.isUntitled || editor.document.uri.scheme !== 'file')
        throw new BridgeError(
          'UNSAVED_FILE',
          '無題・仮想ファイルは全文添付できません。保存するか「選択範囲」「なし」を選んでください。',
        );
      if (editor.document.isDirty) {
        const action = await vscode.window.showWarningMessage(
          '全文添付の前に、未保存の編集内容を保存しますか？',
          { modal: true },
          '保存する',
        );
        if (action !== '保存する' || !(await editor.document.save()))
          throw new BridgeError(
            'SAVE_CANCELLED',
            '保存を取り消しました。全文添付は実行していません。',
          );
      }
      paths.set(
        editor.document.uri.fsPath.toLowerCase(),
        editor.document.uri.fsPath,
      );
    }
  }
  const attachments = await Promise.all([...paths.values()].map(describeFile));
  return {
    question,
    context,
    prompt: context
      ? `${question}\n\n## エディタの選択範囲\n${context}`
      : question,
    attachments,
  };
}
