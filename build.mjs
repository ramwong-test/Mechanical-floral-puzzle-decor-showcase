// Bundle main.js into app.bundle.js (esbuild).
// Usage: node build.mjs
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'main.js')],
  bundle: true,
  format: 'iife',
  charset: 'utf8',
  minify: false,
  outfile: join(here, 'app.bundle.js'),
  logLevel: 'info',
});
