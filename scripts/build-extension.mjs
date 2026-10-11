import { build, context } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const cwd = process.cwd();
const manifest = JSON.parse(
  await readFile(resolve(cwd, 'package.json'), 'utf8'),
);
if (!manifest.engines?.vscode) {
  throw new Error('拡張機能のフォルダで実行してください。');
}
const production = process.argv.includes('--production');
const options = {
  absWorkingDir: cwd,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  sourcesContent: !production,
  minify: production,
  logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
