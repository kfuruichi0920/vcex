import type { Page } from 'playwright-core';
import { BridgeError, checkCancelled, type Attachment } from './domain';

/** DOM・添付検証・完了判定は対象サイトの Adapter に閉じ込める。 */
export interface ChatAdapter {
  openNewChat(page: Page, url: string): Promise<void>;
  focusComposer(page: Page): Promise<void>;
  waitForAttachment(
    page: Page,
    files: readonly Attachment[],
    timeout: number,
  ): Promise<void>;
  submit(page: Page, prompt: string): Promise<void>;
  answer(page: Page, timeout: number, signal: AbortSignal): Promise<string>;
}
export class MockChatAdapter implements ChatAdapter {
  async openNewChat(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    try {
      await page
        .locator('[data-adapter="mock-v1"]')
        .waitFor({ timeout: 10000 });
    } catch {
      throw new BridgeError(
        'ADAPTER_MISMATCH',
        '仮チャット用の DOM がありません。実サイトには専用アダプターが必要です。',
      );
    }
    if (await page.getByTestId('login-required').count())
      throw new BridgeError(
        'AUTH_REQUIRED',
        '対象チャットにログインが必要です。',
      );
    await page.getByTestId('new-chat').click();
    await page
      .getByTestId('chat')
      .locator('[data-state="ready"]')
      .waitFor({ state: 'attached', timeout: 10000 });
  }
  async focusComposer(page: Page): Promise<void> {
    await page.getByTestId('composer').focus();
  }
  async waitForAttachment(
    page: Page,
    files: readonly Attachment[],
    timeout: number,
  ): Promise<void> {
    try {
      await page.waitForFunction(
        (expected) => {
          const cards = Array.from(
            document.querySelectorAll(
              '[data-testid="attachment"][data-state="ready"]',
            ),
          );
          if (
            cards.length !== expected.length ||
            document.querySelector('[data-testid="attachment-error"]')
          )
            return false;
          for (const file of expected) {
            const index = cards.findIndex((card) =>
              file.kind === 'png'
                ? card.getAttribute('data-type') === 'image/png'
                : card.getAttribute('data-name') === file.name &&
                  Number(card.getAttribute('data-size')) === file.size,
            );
            if (index < 0) return false;
            cards.splice(index, 1);
          }
          return true;
        },
        files.map(({ name, size, kind }) => ({ name, size, kind })),
        { timeout },
      );
    } catch {
      throw new BridgeError(
        'UPLOAD_FAILED',
        'Ctrl+V 後に全添付の受理を確認できませんでした。質問は送信していません。',
      );
    }
  }
  async submit(page: Page, prompt: string): Promise<void> {
    await page.getByTestId('composer').fill(prompt);
    try {
      // click の後は、成否不明でも再送しない。
      await page.getByTestId('send').click({ timeout: 10000 });
      await page.getByTestId('submitted').waitFor({ timeout: 10000 });
    } catch {
      throw new BridgeError(
        'SUBMISSION_UNKNOWN',
        '送信成否を確認できません。自動再送せず対象チャットを確認してください。',
      );
    }
  }
  async answer(
    page: Page,
    timeout: number,
    signal: AbortSignal,
  ): Promise<string> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      checkCancelled(signal);
      if (await page.getByTestId('response-error').count())
        throw new BridgeError(
          'RESPONSE_FAILED',
          '対象サイトが回答生成エラーを返しました。',
        );
      const answer = page.locator(
        '[data-testid="answer"][data-state="complete"]',
      );
      if (await answer.count()) {
        const text = await answer.textContent();
        if (!text?.trim())
          throw new BridgeError(
            'EXTRACTION_FAILED',
            '完了しましたが回答が空です。',
          );
        return text;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new BridgeError(
      'RESPONSE_TIMEOUT',
      '回答完了の明示シグナルを期限内に確認できませんでした。未完了回答は保存しません。',
    );
  }
}
