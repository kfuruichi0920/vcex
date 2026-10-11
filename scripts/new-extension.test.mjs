import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtension } from './new-extension.mjs';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

test('雛形を展開し、名前を置換し、既存ファイルを保護する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vcex-generator-'));
  try {
    await cp(
      new URL('../tsconfig.base.json', import.meta.url),
      join(root, 'tsconfig.base.json'),
    );
    await cp(
      new URL('../.prettierrc.json', import.meta.url),
      join(root, '.prettierrc.json'),
    );
    await cp(
      new URL('../templates', import.meta.url),
      join(root, 'templates'),
      { recursive: true },
    );
    const target = await createExtension('test-tool', root);
    const manifest = JSON.parse(
      await readFile(join(target, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'test-tool');
    assert.equal(manifest.contributes.commands[0].command, 'test-tool.hello');
    assert.equal(manifest.dependencies['@vcex/shared'], '0.0.0');
    assert.match(
      await readFile(join(target, 'src', 'extension.ts'), 'utf8'),
      /test-tool\.hello/,
    );
    await readFile(join(target, '.vscode', 'launch.json'), 'utf8');
    await readFile(join(target, '.vscodeignore'), 'utf8');
    const bundle = await build({
      entryPoints: [join(target, 'src', 'extension.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
      alias: {
        '@vcex/shared': fileURLToPath(
          new URL('../packages/shared/src/index.ts', import.meta.url),
        ),
      },
      write: false,
    });
    const commands = new Map();
    const messages = [];
    const disposable = { dispose() {} };
    const api = {
      commands: {
        registerCommand(id, callback) {
          commands.set(id, callback);
          return disposable;
        },
      },
      window: {
        showInformationMessage(message) {
          messages.push(message);
        },
      },
    };
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, {
      module,
      exports: module.exports,
      require(id) {
        assert.equal(id, 'vscode');
        return api;
      },
    });
    const context = { subscriptions: [] };
    module.exports.activate(context);
    commands.get('test-tool.hello')();
    assert.deepEqual(messages, ['test-tool の開発環境が動作しています。']);
    assert.equal(context.subscriptions[0], disposable);
    await writeFile(join(target, 'README.md'), 'keep');
    await assert.rejects(createExtension('test-tool', root), {
      code: 'EEXIST',
    });
    assert.equal(await readFile(join(target, 'README.md'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('パスの脱出、無効な名前、Windows 予約名を拒否する', async () => {
  for (const name of [
    undefined,
    '',
    '../outside',
    'a/b',
    'a\\b',
    'Upper',
    'a--b',
    'nul',
    'com1',
    'x'.repeat(65),
  ]) {
    await assert.rejects(createExtension(name));
  }
});
