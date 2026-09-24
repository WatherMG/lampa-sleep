import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

for (const name of ['index.html', '.nojekyll', 'sleep.js']) {
  assert.ok(statSync(join('dist', name)).isFile(), 'Missing site file: ' + name);
}
const plugin = readFileSync(join('dist', 'sleep.js'), 'utf8');
assert.match(plugin, /0\.1\.1-alpha/);
assert.match(plugin, /ssap:\/\/system\/turnOff/);
assert.match(plugin, /turnOffScreen/);
assert.doesNotMatch(plugin, /luna:\/\/com\.webos\.service\.tvpower/);
assert.ok(!existsSync(join('dist', 'test')), 'Tests must not be published');
console.log('Pages artifact verified.');
