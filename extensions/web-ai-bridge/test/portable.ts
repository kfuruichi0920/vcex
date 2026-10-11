import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { prepareQuestion } from '../src/context';
import { JobRunner } from '../src/runner';

export async function run(): Promise<void> {
  const directory = process.env.BRIDGE_TEST_DIRECTORY!;
  const extension = vscode.extensions.getExtension('local-dev.web-ai-bridge');
  assert.ok(extension);
  await extension.activate();
  assert.ok(
    (await vscode.commands.getCommands()).includes('web-ai-bridge.open'),
  );
  const document = await vscode.workspace.openTextDocument({
    content: 'first\nsecond\nthird\nfourth',
    language: 'plaintext',
  });
  const editor = await vscode.window.showTextDocument(document);
  editor.selections = [
    new vscode.Selection(2, 0, 2, 5),
    new vscode.Selection(0, 0, 0, 5),
  ];
  const prepared = await prepareQuestion('日本語の質問', 'auto', editor, []);
  assert.ok(
    prepared.context.indexOf('first') < prepared.context.indexOf('third'),
  );
  assert.equal(prepared.attachments.length, 0);
  await assert.rejects(prepareQuestion('質問', 'file', editor, []), /無題/);
  assert.equal((await prepareQuestion('質問', 'none', editor, [])).context, '');
  assert.equal(
    (await prepareQuestion('質問', 'auto', undefined, [])).prompt,
    '質問',
  );
  const attachment = join(directory, 'active.txt');
  await writeFile(attachment, 'FILE_CONTENT_SHOULD_NOT_APPEAR_IN_LOG');
  const fileEditor = await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(attachment),
  );
  const whole = await prepareQuestion('全文添付', 'auto', fileEditor, []);
  assert.equal(whole.attachments.length, 1);
  assert.equal(whole.context, '');
  await vscode.commands.executeCommand('web-ai-bridge.open');
  const job = await new JobRunner().run(
    whole,
    {
      url: process.env.BRIDGE_TEST_URL!,
      connection: {
        mode: 'dedicated',
        endpoint: '',
        profile: join(directory, 'edge-profile'),
        headless: false,
      },
      clipboardScript: join(extension.extensionPath, 'dist/clipboard.ps1'),
      logDirectory: join(directory, 'logs'),
      timeoutMs: 10000,
    },
    new AbortController().signal,
  );
  assert.equal(job.state, 'COMPLETED', job.error);
  assert.match(job.answer, /添付数: 1/);
  const log = await readFile(job.logPath, 'utf8');
  assert.doesNotMatch(log, /FILE_CONTENT_SHOULD_NOT_APPEAR_IN_LOG/);
  await vscode.window.showTextDocument(vscode.Uri.file(job.logPath));
  assert.equal(
    vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase(),
    job.logPath.toLowerCase(),
  );
  const config = vscode.workspace.getConfiguration('webAiBridge');
  for (const [key, value] of Object.entries({
    url: process.env.BRIDGE_TEST_URL!,
    connectionMode: 'dedicated',
    profileDirectory: join(directory, 'ui-profile'),
    logDirectory: join(directory, 'ui-logs'),
    openLog: true,
  })) {
    await config.update(key, value, vscode.ConfigurationTarget.Workspace);
  }
  await vscode.commands.executeCommand('web-ai-bridge.open');
  await writeFile(join(directory, 'ui-ready'), 'ready');
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      await readFile(join(directory, 'ui-complete'), 'utf8');
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('Sidebar UI test timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(
    join(directory, 'portable-results.json'),
    JSON.stringify(
      {
        vscode: vscode.version,
        node: process.versions.node,
        extensionPath: extension.extensionPath,
        path: process.env.PATH,
        state: job.state,
        contextCases: [
          'multiple selection',
          'none',
          'no editor',
          'untitled rejected',
          'whole file',
        ],
        logPath: job.logPath,
      },
      null,
      2,
    ),
  );
  console.log(
    'Portable tests passed: VSIX runtime, sidebar activation, context, native Ctrl+V, Markdown log.',
  );
}
