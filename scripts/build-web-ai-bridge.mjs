import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const extension = resolve(root, 'extensions/web-ai-bridge');
const require = createRequire(import.meta.url);
if (process.argv.includes('--production')) {
  await rm(resolve(extension, 'dist/extension.js.map'), { force: true });
}
await build({
  absWorkingDir: extension,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'playwright-core'],
  sourcemap: !process.argv.includes('--production'),
  logLevel: 'info',
});
await mkdir(resolve(extension, 'dist/node_modules'), { recursive: true });
// Playwright の動的 require と内部資産の相対パスを保持する。
await cp(
  dirname(require.resolve('playwright-core/package.json')),
  resolve(extension, 'dist/node_modules/playwright-core'),
  { recursive: true },
);
await cp(
  resolve(extension, 'resources/clipboard.ps1'),
  resolve(extension, 'dist/clipboard.ps1'),
);
