import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, 'sleep.js'), join(dist, 'sleep.js'));
writeFileSync(join(dist, '.nojekyll'), '');
writeFileSync(join(dist, 'index.html'), [
  '<!doctype html>',
  '<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>Lampa Sleep</title>',
  '<style>body{max-width:48rem;margin:2rem auto;padding:0 1rem;background:#16191c;color:#fafafa;font:1.05rem/1.6 system-ui}a{color:#9ad0ff}code{overflow-wrap:anywhere}</style>',
  '</head><body><h1>Lampa Sleep</h1>',
  '<p>Safety-first sleep timer for Lampa. Power integration is disabled by default and requires explicit LG TV pairing.</p>',
  '<p>Plugin: <a href="sleep.js"><code>sleep.js</code></a></p>',
  '</body></html>'
].join('\n') + '\n');
