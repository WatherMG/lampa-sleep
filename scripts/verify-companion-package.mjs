import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const file = join('dist', 'lampa-sleep-companion.ipk');
const stat = statSync(file);
assert.ok(stat.isFile(), 'Companion IPK is missing');
assert.ok(stat.size > 1024, 'Companion IPK is unexpectedly small');

const head = readFileSync(file).subarray(0, 8).toString('ascii');
assert.equal(head, '!<arch>\n', 'Companion file is not an ar/IPK package');

console.log('Companion IPK verified:', stat.size, 'bytes');
