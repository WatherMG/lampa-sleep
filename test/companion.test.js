'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ssap = require('../companion/service/ssap');
const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'companion', 'service', 'lampa_sleep_service.js'), 'utf8');

test('companion transport targets loopback WSS', () => {
  assert.equal(ssap.HOST, '127.0.0.1');
  assert.equal(ssap.PORT, 3001);
});

test('registration manifest is minimal and unsigned', () => {
  const payload = ssap.registrationPayload('');
  assert.equal(payload.pairingType, 'PROMPT');
  assert.equal(payload.manifest.permissions.length, 3);
  assert.equal(Object.hasOwn(payload.manifest, 'signed'), false);
  assert.equal(Object.hasOwn(payload.manifest, 'signatures'), false);
});

test('WebSocket frame encoder and parser round-trip JSON', () => {
  const message = JSON.stringify({ type: 'request', id: 'test', payload: { ok: true } });
  const frame = ssap.buildFrame(message, 1);
  let parsed;
  const parser = new ssap.FrameParser((opcode, payload) => {
    parsed = { opcode, text: payload.toString('utf8') };
  }, err => { throw err; });
  parser.push(frame);
  assert.deepEqual(parsed, { opcode: 1, text: message });
});

test('service keeps persistent data under media internal', () => {
  assert.match(serviceSource, /\/media\/internal\/\.lampa-sleep/);
});

test('service uses Luna sender for client authorization', () => {
  assert.match(serviceSource, /message\.sender/);
  assert.match(serviceSource, /authorizedSender\s*=\s*sender/);
});

test('public status does not include the TV client credential', () => {
  const body = serviceSource.match(/function publicState\(\) \{([\s\S]*?)\n\}/);
  assert.ok(body);
  assert.doesNotMatch(body[1], /tvClientKey/);
});
