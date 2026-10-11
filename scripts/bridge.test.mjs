import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestModules } from './bridge-test-build.mjs';
const require = createRequire(import.meta.url);
const {
  logName,
  createLog,
  updateLog,
  validateUrl,
  publicDestination,
} = require(await buildTestModules());

test('ログはローカル日時・安全なファイル名・連番を使用し、添付内容を含まない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-log-'));
  try {
    const started = new Date(2026, 9, 11, 12, 34, 56);
    assert.equal(logName(started, 'CON: /質問?*'), '20261011-123456_CON 質問');
    assert.ok(logName(started, 'a'.repeat(1000)).length < 100);
    const job = {
      started,
      state: 'VALIDATING',
      destination: 'http://localhost/',
      input: {
        question: '質問',
        prompt: '質問\n選択',
        context: '選択',
        attachments: [
          {
            path: 'C:\\private\\a.pdf',
            name: 'a.pdf',
            size: 10,
            result: '未送信',
          },
        ],
      },
      answer: '',
      error: '',
      warnings: [],
      logPath: '',
    };
    job.logPath = await createLog(directory, job);
    const second = await createLog(directory, job);
    assert.notEqual(second, job.logPath);
    job.state = 'COMPLETED';
    job.answer = '# 回答\n\n| a | b |\n| --- | --- |\n| 1 | 2 |';
    await updateLog(job);
    const text = await readFile(job.logPath, 'utf8');
    assert.match(text, /COMPLETED/);
    assert.match(text, /選択/);
    assert.match(text, /# 回答/);
    assert.doesNotMatch(text, /private/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('接続先の資格情報を拒否し、クエリ・fragment をログへ含めない', () => {
  assert.throws(() => validateUrl('file:///secret'));
  assert.throws(() => validateUrl('https://user:pass@example.com'));
  assert.equal(
    publicDestination('https://example.com/chat?token=secret#secret'),
    'https://example.com/chat',
  );
});
