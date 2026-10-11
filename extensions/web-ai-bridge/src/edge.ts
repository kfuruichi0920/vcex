import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright-core';
import { BridgeError, type ConnectionOptions } from './domain';

export interface EdgeSession {
  page: Page;
  close(): Promise<void>;
}
export async function connectEdge(
  options: ConnectionOptions,
): Promise<EdgeSession> {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    if (options.mode === 'cdp') {
      const url = new URL(options.endpoint);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.protocol !== 'http:' ||
        url.username ||
        url.password
      )
        throw new BridgeError(
          'CONNECTION_FAILED',
          'Phase 0 の CDP 接続先はローカル HTTP のみ対応します。',
        );
      browser = await chromium.connectOverCDP(options.endpoint, {
        timeout: 15000,
      });
      const existing = browser.contexts()[0];
      if (!existing)
        throw new BridgeError(
          'CONNECTION_FAILED',
          '接続先に既存コンテキストがありません。',
        );
      context = existing;
    } else {
      if (!options.profile)
        throw new BridgeError(
          'CONNECTION_FAILED',
          '専用プロファイル保存先が必要です。',
        );
      context = await chromium.launchPersistentContext(options.profile, {
        channel: 'msedge',
        headless: options.headless,
        timeout: 20000,
      });
    }
    const page = await context.newPage();
    return {
      page,
      async close() {
        if (options.mode === 'cdp') {
          await page.close().catch(() => {});
          // CDP 接続時は接続を切断し、既存 Edge を終了しない。
          await browser?.close();
        } else {
          await context?.close();
        }
      },
    };
  } catch (error) {
    if (options.mode === 'dedicated') await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(
      'CONNECTION_FAILED',
      'Edge に接続できません。CDP 設定、ポート、専用プロファイルの競合を確認してください。',
    );
  }
}
