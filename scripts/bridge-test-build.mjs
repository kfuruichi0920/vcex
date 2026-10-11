import { build } from 'esbuild';
import { resolve } from 'node:path';
export async function buildTestModules() {
  const root = resolve(import.meta.dirname, '..');
  const outfile = resolve(root, '.test-artifacts/bridge.cjs');
  await build({
    stdin: {
      contents:
        "export * from './extensions/web-ai-bridge/src/runner'; export * from './extensions/web-ai-bridge/src/log'; export * from './extensions/web-ai-bridge/src/domain'; export * from './extensions/web-ai-bridge/src/adapter'; export * from './extensions/web-ai-bridge/src/clipboard'; export * from './extensions/web-ai-bridge/src/assets';",
      resolveDir: root,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['playwright-core'],
  });
  return outfile;
}
