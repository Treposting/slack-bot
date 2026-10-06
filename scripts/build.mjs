// Bundles src/*.ts into the plain scripts Chrome loads from extension/.
// `node scripts/build.mjs --watch` rebuilds on change.
import * as esbuild from 'esbuild';

const options = {
  entryPoints: { content: 'src/content.ts', background: 'src/background.ts' },
  outdir: 'extension',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
