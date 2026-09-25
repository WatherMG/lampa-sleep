import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const out = join(root, 'companion', 'out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = spawnSync('ares-package', [
  join(root, 'companion', 'app'),
  join(root, 'companion', 'service'),
  '-o', out
], { stdio: 'inherit', shell: process.platform === 'win32' });

if (result.error) throw result.error;
if (result.status !== 0) throw new Error('ares-package failed with exit code ' + result.status);

const ipks = readdirSync(out).filter(name => name.endsWith('.ipk'));
if (ipks.length !== 1) throw new Error('Expected exactly one companion IPK, got ' + ipks.length);
mkdirSync(join(root, 'dist'), { recursive: true });
copyFileSync(join(out, ipks[0]), join(root, 'dist', 'lampa-sleep-companion.ipk'));
console.log('Companion package:', ipks[0]);
