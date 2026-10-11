/* global document, KeyboardEvent -- Playwright のブラウザ内コールバックで使用 */
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  writeFile,
  readdir,
  readFile,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMock } from '../tools/mock-chat/server.mjs';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const executable = process.argv[2] || process.env.VSCODE_EXECUTABLE_PATH;
if (!executable)
  throw new Error(
    'VS Code Portable の Code.exe を引数で指定してください。自動ダウンロードは行いません。',
  );
await access(executable);
const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, '.test-artifacts'), { recursive: true });
const directory = await mkdtemp(join(root, '.test-artifacts/portable-'));
await mkdir(join(directory, 'portable-data'), { recursive: true });
const socket = createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const debugPort = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const zip = join(directory, 'extension.zip');
await copyFile(
  join(root, 'extensions/web-ai-bridge/web-ai-bridge-0.0.1.vsix'),
  zip,
);
const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe',
);
await promisify(execFile)(
  powershell,
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Expand-Archive -LiteralPath $env:BRIDGE_TEST_ZIP -DestinationPath $env:BRIDGE_TEST_EXTRACT',
  ],
  {
    windowsHide: true,
    env: {
      ...process.env,
      BRIDGE_TEST_ZIP: zip,
      BRIDGE_TEST_EXTRACT: join(directory, 'unpacked'),
    },
  },
);
const extension = join(directory, 'unpacked/extension');
await build({
  entryPoints: [join(root, 'extensions/web-ai-bridge/test/portable.ts')],
  outfile: join(extension, 'dist/portable-tests.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode', 'playwright-core'],
});
const server = await startMock(0);
async function testSidebar() {
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      await access(join(directory, 'ui-ready'));
      break;
    } catch {
      if (Date.now() > deadline)
        throw new Error('Portable UI did not become ready');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${debugPort}`,
  );
  try {
    const page = browser
      .contexts()[0]
      .pages()
      .find((page) => page.url().includes('workbench'));
    if (!page) throw new Error('Workbench page not found');
    let frame;
    while (!frame) {
      for (const candidate of page.frames()) {
        if (await candidate.locator('#question').count()) {
          frame = candidate;
          break;
        }
      }
      if (Date.now() > deadline) throw new Error('Sidebar frame not found');
      if (!frame) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!(await frame.locator('#send').isVisible()))
      throw new Error('初期状態で送信ボタンが表示されていない');
    if (await frame.locator('#send').isEnabled())
      throw new Error('空の質問を送信できる');
    if (
      await frame
        .locator('#confirmation, #details, #preview, select#context')
        .count()
    )
      throw new Error(
        '不要なプレビューまたはコンテキストドロップダウンが残っている',
      );
    if (await frame.locator('#prompt-directory').isVisible())
      throw new Error('プロンプトの詳細が初期表示されている');
    await frame
      .locator('#system-prompt option[value="01-general.md"]')
      .waitFor({ state: 'attached' });
    await frame.locator('#system-prompt').selectOption('01-general.md');
    await frame
      .locator('#prompt-content')
      .filter({ hasText: '基本アシスタント' })
      .waitFor({ state: 'attached' });
    await frame.locator('#attachments img').waitFor();
    if (
      !(await frame
        .locator('#attachments img')
        .evaluate((image) => image.complete && image.naturalWidth > 0))
    )
      throw new Error('画像サムネイルを読み込めない');
    await frame.locator('#help summary').click();
    await frame.locator('#help ol').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(directory, 'sidebar-help.png') });
    await frame.locator('#help summary').click();
    await frame.locator('#question').fill('改行の確認');
    await frame.locator('#question').press('Enter');
    if (!(await frame.locator('#question').inputValue()).includes('\n'))
      throw new Error('Enter で改行できない');
    await frame.locator('#question').evaluate((input) => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    if (!(await frame.locator('#send').isEnabled()))
      throw new Error('IME 変換中・キー長押しで送信された');
    await frame.locator('#question').dispatchEvent('compositionstart');
    await frame.locator('#question').press('Control+Enter');
    if (!(await frame.locator('#send').isEnabled()))
      throw new Error('変換確定中に送信された');
    await frame.locator('#question').dispatchEvent('compositionend');
    await frame.evaluate(() => {
      document.getElementById('files').addEventListener(
        'click',
        (event) => {
          event.stopImmediatePropagation();
          document.getElementById('files').dataset.shortcutTest = 'passed';
        },
        { once: true, capture: true },
      );
    });
    await frame.locator('#question').press('Control+Alt+a');
    if (
      (await frame.locator('#files').getAttribute('data-shortcut-test')) !==
      'passed'
    )
      throw new Error('添付ショートカットでファイル追加ボタンを実行できない');
    await frame.locator('#question').fill('あ'.repeat(38001));
    await frame
      .locator('#warning')
      .filter({ hasText: '38,000文字超' })
      .waitFor();
    if (!(await frame.locator('#send').isEnabled()))
      throw new Error('文字数警告で送信が禁止された');
    await frame
      .locator('#question')
      .fill('サイドバーから日本語の質問を送信します。');
    await frame.locator('#context-file').check();
    await frame.locator('#context-selection').check();
    await frame
      .locator('#context-target')
      .filter({ hasText: 'active.txt' })
      .waitFor();
    await page.screenshot({ path: join(directory, 'sidebar-compose.png') });
    await (
      await frame.frameElement()
    ).screenshot({ path: join(directory, 'sidebar-compose-panel.png') });
    await frame.locator('#question').press('Control+Enter');
    await frame
      .locator('#jobs [data-state="GENERATING"]')
      .waitFor({ timeout: 20000 });
    await frame
      .locator('#question')
      .fill('回答を待たずに次の質問を送信予約します。');
    await frame.locator('#context-file').uncheck();
    if (!(await frame.locator('#attachments img').isVisible()))
      throw new Error('送信後に添付が失われた');
    await frame.locator('#question').press('Control+Enter');
    await frame.locator('#jobs [data-state="QUEUED"]').waitFor();
    await frame.locator('#question').fill('この予約は取り消します。');
    await frame.locator('#send').click();
    const cancelled = frame
      .locator('#jobs li')
      .filter({ hasText: 'この予約は取り消します。' });
    await cancelled.locator('button').click();
    await cancelled
      .locator('.badge')
      .filter({ hasText: 'CANCELLED' })
      .waitFor();
    await frame
      .locator('#question')
      .fill('回答の生成中も、次の質問をここに入力できます。');
    await page.screenshot({ path: join(directory, 'sidebar-queue.png') });
    await (
      await frame.frameElement()
    ).screenshot({ path: join(directory, 'sidebar-queue-panel.png') });
    await writeFile(join(directory, 'use-custom-prompts'), 'ready');
    await frame
      .locator('#system-prompt option[value="custom.md"]')
      .waitFor({ state: 'attached' });
    if (
      await frame.locator('#system-prompt option[value="ignored.txt"]').count()
    )
      throw new Error('Markdown 以外がプロンプト一覧に含まれた');
    await frame.locator('#system-prompt').selectOption('custom.md');
    await frame
      .locator('#prompt-content')
      .filter({ hasText: '指定フォルダのサンプル' })
      .waitFor({ state: 'attached' });
    await frame.locator('.prompt-content summary').click();
    await frame.locator('#prompt-directory').waitFor();
    await page.screenshot({
      path: join(directory, 'sidebar-custom-prompts.png'),
    });
    await frame
      .locator('#jobs [data-state="COMPLETED"]')
      .nth(1)
      .waitFor({ timeout: 40000 });
    if (
      (await frame.locator('#question').inputValue()) !==
      '回答の生成中も、次の質問をここに入力できます。'
    )
      throw new Error('回答完了により次の質問の下書きが消えた');
    await frame
      .locator('#status')
      .filter({ hasText: 'COMPLETED' })
      .waitFor({ timeout: 20000 });
    await frame.locator('#cancel').waitFor({ state: 'hidden' });
    if (
      !(await frame.locator('#context-target').innerText()).includes(
        'active.txt',
      )
    )
      throw new Error('ログの自動表示で次の質問のコンテキストが切り替わった');
    const logNames = await readdir(join(directory, 'ui-logs'));
    if (logNames.length !== 2)
      throw new Error('取消した予約が実行されたか、質問が失われた');
    for (const name of logNames) {
      const text = await readFile(join(directory, 'ui-logs', name), 'utf8');
      if (
        !text.includes('01-general.md') ||
        text.includes('指定フォルダのサンプル')
      )
        throw new Error('予約後の設定変更でプロンプトが書き換わった');
    }
    if (!(await frame.locator('#send').isVisible()))
      throw new Error('完了後に送信ボタンが消えた');
    if (!(await frame.locator('#attachments img').isVisible()))
      throw new Error('回答完了後に添付が失われた');
    await frame.locator('#attachments button').click();
    await frame.locator('#attachment-empty').waitFor();
    if (await frame.locator('#attachments img').count())
      throw new Error('添付の明示的な削除が反映されない');
    const firstLog = await readFile(
      join(
        directory,
        'ui-logs',
        logNames.find((name) => name.includes('サイドバー')),
      ),
      'utf8',
    );
    const secondLog = await readFile(
      join(
        directory,
        'ui-logs',
        logNames.find((name) => name.includes('回答を待たず')),
      ),
      'utf8',
    );
    if (
      !firstLog.includes('指定: both') ||
      !firstLog.includes('active.txt') ||
      !secondLog.includes('指定: selection') ||
      !secondLog.includes('vscode-example.png')
    )
      throw new Error('コンテキスト指定または維持した添付がログに記録されない');
    await frame.locator('.prompt-content summary').click();
    await (
      await frame.frameElement()
    ).screenshot({ path: join(directory, 'sidebar-final-panel.png') });
    await frame.locator('#status').filter({ hasText: 'ログ:' }).waitFor();
    await page.screenshot({ path: join(directory, 'sidebar-completed.png') });
    await frame.locator('#question').fill('ショートカットによる実行取消の確認');
    await frame.locator('#context-selection').uncheck();
    await frame.locator('#question').press('Control+Enter');
    const shortcutJob = frame
      .locator('#jobs li')
      .filter({ hasText: 'ショートカットによる実行取消の確認' });
    try {
      await shortcutJob
        .locator('.badge')
        .filter({ hasText: 'GENERATING' })
        .waitFor({ timeout: 20000 });
    } catch (error) {
      await writeFile(
        join(directory, 'shortcut-error.txt'),
        await frame.locator('body').innerText(),
      );
      throw error;
    }
    await frame.locator('#question').fill('取消後も下書きは保持します。');
    await frame.locator('#question').press('Control+Shift+Enter');
    await shortcutJob
      .locator('.badge')
      .filter({ hasText: 'CANCELLED' })
      .waitFor();
    await frame.locator('#cancel').waitFor({ state: 'hidden' });
    if (
      (await frame.locator('#question').inputValue()) !==
      '取消後も下書きは保持します。'
    )
      throw new Error('取消ショートカットで下書きが失われた');
    await writeFile(
      join(directory, 'ui-complete'),
      'Sidebar checkboxes → send → persistent attachment → queued → COMPLETED passed',
    );
  } finally {
    await browser.close();
  }
}
try {
  await Promise.all([
    runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: extension,
      extensionTestsPath: join(extension, 'dist/portable-tests.cjs'),
      launchArgs: [
        directory,
        '--user-data-dir',
        join(directory, 'user-data'),
        '--extensions-dir',
        join(directory, 'extensions'),
        '--disable-updates',
        '--disable-telemetry',
        `--remote-debugging-port=${debugPort}`,
        '--disable-extension=github.copilot-chat',
      ],
      extensionTestsEnv: {
        VSCODE_PORTABLE: join(directory, 'portable-data'),
        BRIDGE_TEST_DIRECTORY: directory,
        BRIDGE_TEST_URL: server.url,
        PATH: join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
      },
    }),
    testSidebar(),
  ]);
} finally {
  await server.close();
  console.log(`Portable evidence: ${directory}`);
}
