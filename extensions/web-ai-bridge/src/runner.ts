import { readFile, stat } from 'node:fs/promises';
import {
  BridgeError,
  checkCancelled,
  errorText,
  publicDestination,
  validateUrl,
  type Execution,
  type PreparedQuestion,
  type RunOptions,
  type State,
} from './domain';
import { createLog, updateLog } from './log';
import { connectEdge, type EdgeSession } from './edge';
import { openClipboard, type ClipboardSession } from './clipboard';
import { MockChatAdapter, type ChatAdapter } from './adapter';

export class JobRunner {
  private active = false;
  constructor(private readonly adapter: ChatAdapter = new MockChatAdapter()) {}
  async run(
    input: PreparedQuestion,
    options: RunOptions,
    signal: AbortSignal,
    onState: (state: State) => void = () => {},
  ): Promise<Execution> {
    if (this.active)
      throw new BridgeError(
        'BUSY',
        '進行中の処理が終了するまでお待ちください。',
      );
    this.active = true;
    let session: EdgeSession | undefined;
    let clipboard: ClipboardSession | undefined;
    const job: Execution = {
      started: new Date(),
      state: 'VALIDATING',
      destination: '',
      connectionMode: options.connection.mode,
      input: structuredClone(input),
      answer: '',
      error: '',
      warnings: [],
      logPath: '',
    };
    const state = async (next: State) => {
      job.state = next;
      onState(next);
      if (job.logPath) await updateLog(job);
    };
    const abort = () => {
      void session?.page.close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      onState('VALIDATING');
      const url = validateUrl(options.url);
      job.destination = publicDestination(url);
      checkCancelled(signal);
      if (!input.question.trim())
        throw new BridgeError('INVALID_QUESTION', '質問を入力してください。');
      for (const file of input.attachments) {
        const current = await stat(file.path).catch(() => undefined);
        if (
          !current?.isFile() ||
          current.size !== file.size ||
          current.mtimeMs !== file.mtime
        )
          throw new BridgeError(
            'FILE_CHANGED',
            '送信予約後に添付ファイルが変更・削除されました。添付を確認してもう一度送信してください。',
          );
      }
      job.logPath = await createLog(options.logDirectory, job);
      await state('CONNECTING');
      session = await connectEdge(options.connection);
      checkCancelled(signal);
      await this.adapter.openNewChat(session.page, url);
      await state('UPLOADING');
      if (input.attachments.length) {
        clipboard = await openClipboard(options.clipboardScript);
        job.warnings.push('クリップボードの全形式の完全復元は保証されません。');
        if (clipboard.partial)
          job.warnings.push(
            '元のクリップボードの一部形式を退避できませんでした。',
          );
        const files = job.input.attachments.filter(
          (file) => file.kind === 'file',
        );
        const accepted = [...files];
        if (files.length) {
          checkCancelled(signal);
          await clipboard.files(files.map((file) => file.path));
          await this.adapter.focusComposer(session.page);
          await session.page.keyboard.press('Control+V');
          await this.adapter.waitForAttachment(session.page, accepted, 10000);
          files.forEach((file) => {
            file.result = '添付完了';
          });
        }
        for (const image of job.input.attachments.filter(
          (file) => file.kind === 'png',
        )) {
          checkCancelled(signal);
          await clipboard.image(await readFile(image.path));
          await this.adapter.focusComposer(session.page);
          await session.page.keyboard.press('Control+V');
          accepted.push(image);
          await this.adapter.waitForAttachment(session.page, accepted, 10000);
          image.result = '添付完了（画像メモリ貼り付け）';
        }
        await clipboard.restore();
        clipboard = undefined;
      }
      checkCancelled(signal);
      await this.adapter.submit(session.page, input.prompt);
      await state('SUBMITTED');
      await state('GENERATING');
      const answer = await this.adapter.answer(
        session.page,
        options.timeoutMs,
        signal,
      );
      checkCancelled(signal);
      await state('EXTRACTING');
      job.answer = answer;
      await state('SAVING');
      await state('COMPLETED');
    } catch (error) {
      job.state = signal.aborted ? 'CANCELLED' : 'FAILED';
      job.error = signal.aborted
        ? 'CANCELLED: 利用者が取り消しました。送信済みの質問は撤回されません。'
        : errorText(error);
      for (const attachment of job.input.attachments) {
        if (attachment.result === '未送信') attachment.result = '未完了／中断';
      }
      onState(job.state);
    } finally {
      signal.removeEventListener('abort', abort);
      try {
        await clipboard?.restore();
      } catch {
        job.warnings.push('クリップボードの復元に失敗しました。');
      }
      await session?.close().catch(() => {
        job.warnings.push('Edge の後処理を完了できませんでした。');
      });
      if (job.logPath) {
        try {
          await updateLog(job);
        } catch (error) {
          job.state = 'FAILED';
          job.error = errorText(error);
          onState('FAILED');
        }
      }
      this.active = false;
    }
    return job;
  }
}
