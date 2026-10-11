import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { access, copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
    await frame.locator('#question').fill('あ'.repeat(38001));
    await frame.locator('#context').selectOption('none');
    await frame.locator('#preview').focus();
    await frame.locator('#preview').press('Enter');
    await frame
      .locator('#warning')
      .filter({ hasText: '38,000文字超' })
      .waitFor();
    if (!(await frame.locator('#send').isEnabled()))
      throw new Error('文字数警告で送信が禁止された');
    await frame
      .locator('#question')
      .fill('サイドバーから日本語の質問を送信します。');
    await frame.locator('#context').selectOption('none');
    await frame.locator('#preview').click();
    await frame.locator('#confirmation').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(directory, 'sidebar-preview.png') });
    await frame.locator('#send').focus();
    await frame.locator('#send').press('Enter');
    await frame
      .locator('#status')
      .filter({ hasText: 'COMPLETED' })
      .waitFor({ timeout: 20000 });
    await frame.locator('#cancel').waitFor({ state: 'hidden' });
    await frame.locator('#status').filter({ hasText: 'ログ:' }).waitFor();
    await page.screenshot({ path: join(directory, 'sidebar-completed.png') });
    await writeFile(
      join(directory, 'ui-complete'),
      'Sidebar question → preview → send → COMPLETED passed',
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
