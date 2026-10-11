import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { chromium } from 'playwright-core';
import { startMock } from '../tools/mock-chat/server.mjs';
import { buildTestModules } from './bridge-test-build.mjs';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { JobRunner, MockChatAdapter } = require(await buildTestModules());
await mkdir(resolve(root, '.test-artifacts'), { recursive: true });
const directory = await mkdtemp(resolve(root, '.test-artifacts/edge-'));
const server = await startMock(0);
const evidence = [];
const baseOptions = {
  url: server.url,
  connection: { mode: 'cdp', endpoint: '', profile: '', headless: false },
  logDirectory: join(directory, 'logs'),
  timeoutMs: 5000,
  clipboardScript: resolve(
    root,
    'extensions/web-ai-bridge/resources/clipboard.ps1',
  ),
};
const input = (attachments = []) => ({
  question: '日本語で方式を確認してください。',
  prompt: '日本語で方式を確認してください。\n選択範囲の本文',
  context: '選択範囲の本文',
  attachments,
});
const context = await chromium.launchPersistentContext(
  join(directory, 'profile'),
  { channel: 'msedge', headless: false, args: ['--remote-debugging-port=0'] },
);
try {
  const port = (
    await readFile(join(directory, 'profile/DevToolsActivePort'), 'utf8')
  ).split('\n')[0];
  baseOptions.connection.endpoint = `http://127.0.0.1:${port}`;
  const untouched = await context.newPage();
  await untouched.goto(server.url);
  await untouched.evaluate(() => {
    localStorage.setItem('test-login', 'present');
  });
  class ObservingAdapter extends MockChatAdapter {
    submissions = 0;
    async openNewChat(page, url) {
      await super.openNewChat(page, url);
      assert.equal(
        await page.evaluate(() => localStorage.getItem('test-login')),
        'present',
      );
    }
    async submit(page, prompt) {
      this.submissions++;
      await super.submit(page, prompt);
    }
  }
  async function run(
    name,
    question = input(),
    options = baseOptions,
    signal = new AbortController().signal,
    expected = 'COMPLETED',
  ) {
    const adapter = new ObservingAdapter();
    const states = [];
    const result = await new JobRunner(adapter).run(
      question,
      options,
      signal,
      (state) => states.push(state),
    );
    assert.equal(result.state, expected, `${name}: ${result.error}`);
    assert.equal(untouched.isClosed(), false, '既存タブが閉じられていない');
    const log = await readFile(result.logPath, 'utf8');
    assert.match(log, new RegExp(expected));
    if (expected === 'COMPLETED') {
      assert.match(result.answer, /```typescript/);
      assert.match(result.answer, /\| 項目 \|/);
    } else assert.equal(result.answer, '');
    evidence.push({
      name,
      state: result.state,
      error: result.error,
      states,
      submissions: adapter.submissions,
      attachments: result.input.attachments.map((a) => ({
        name: a.name,
        result: a.result,
      })),
    });
    console.log(
      `${name}: ${result.state}${result.error ? ` (${result.error})` : ''}`,
    );
    return { result, adapter, log };
  }
  await run('CDP・新規質問・状態保持・Markdown');
  const files = [];
  for (const extension of ['pdf', 'docx', 'xlsx', 'pptx']) {
    const path = join(directory, `transport-fixture.${extension}`);
    // 転送検証専用。Office/PDF の内容解析は仮サイトでも実装していない。
    await writeFile(path, 'CLIPBOARD_TRANSPORT_FIXTURE_DO_NOT_LOG');
    const info = await stat(path);
    files.push({
      path,
      name: basename(path),
      size: info.size,
      mtime: info.mtimeMs,
      kind: 'file',
      result: '未送信',
    });
  }
  const png = join(directory, 'pixel.png');
  await writeFile(
    png,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const info = await stat(png);
  const image = {
    path: png,
    name: 'pixel.png',
    size: info.size,
    mtime: info.mtimeMs,
    kind: 'png',
    result: '未送信',
  };
  const uploaded = await run(
    'Headed・実Ctrl+V・複数ファイル＋PNG',
    input([...files, image]),
  );
  assert.match(uploaded.result.answer, /添付数: 5/);
  assert.doesNotMatch(uploaded.log, /CLIPBOARD_TRANSPORT_FIXTURE_DO_NOT_LOG/);
  const rejected = await run(
    '添付拒否で送信を中断',
    input([files[0]]),
    { ...baseOptions, url: server.url + '?upload=reject' },
    undefined,
    'FAILED',
  );
  assert.equal(rejected.adapter.submissions, 0);
  assert.match(rejected.result.error, /UPLOAD_FAILED/);
  const auth = await run(
    '認証要求',
    input(),
    { ...baseOptions, url: server.url + '?auth=required' },
    undefined,
    'FAILED',
  );
  assert.match(auth.result.error, /AUTH_REQUIRED/);
  const timeout = await run(
    '安定した未完了回答を保存しない',
    input(),
    { ...baseOptions, url: server.url + '?response=never', timeoutMs: 400 },
    undefined,
    'FAILED',
  );
  assert.match(timeout.result.error, /RESPONSE_TIMEOUT/);
  const cancel = new AbortController();
  const timer = setTimeout(() => cancel.abort(), 1500);
  try {
    await run(
      '実行取消',
      input(),
      { ...baseOptions, url: server.url + '?delay=10000' },
      cancel.signal,
      'CANCELLED',
    );
  } finally {
    clearTimeout(timer);
  }
  const unknown = await run(
    '送信成否不明で再送しない',
    input(),
    { ...baseOptions, url: server.url + '?submission=unknown' },
    undefined,
    'FAILED',
  );
  assert.equal(unknown.adapter.submissions, 1);
  assert.match(unknown.result.error, /SUBMISSION_UNKNOWN/);
  // 専用 Edge の表示モードも確認。他の起動中 Edge は操作しない。
  const headed = await new JobRunner().run(
    input([image]),
    {
      ...baseOptions,
      connection: {
        mode: 'dedicated',
        endpoint: '',
        profile: join(directory, 'headed-profile'),
        headless: false,
      },
    },
    new AbortController().signal,
  );
  assert.equal(headed.state, 'COMPLETED', headed.error);
  evidence.push({ name: '専用Edge Headed・画像Ctrl+V', state: headed.state });
  const headless = await new JobRunner().run(
    input([files[0]]),
    {
      ...baseOptions,
      connection: {
        mode: 'dedicated',
        endpoint: '',
        profile: join(directory, 'headless-profile'),
        headless: true,
      },
    },
    new AbortController().signal,
  );
  assert.equal(headless.state, 'FAILED');
  assert.match(headless.error, /UPLOAD_FAILED/);
  evidence.push({
    name: 'Headless・ファイルCtrl+Vは受理されず安全に中断',
    state: headless.state,
    error: headless.error,
  });
} finally {
  await context.close();
  await server.close();
  await writeFile(
    join(directory, 'results.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log(`Evidence: ${directory}`);
}
