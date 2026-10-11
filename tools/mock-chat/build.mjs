import { build } from 'esbuild';
await build({
  absWorkingDir: import.meta.dirname,
  entryPoints: ['src/app.tsx'],
  outfile: 'dist/app.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
