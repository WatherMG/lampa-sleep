'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const plugin = fs.readFileSync(path.join(__dirname, '..', 'sleep.js'), 'utf8');

function harness(options = {}) {
  const events = {};
  const storage = Object.assign({}, options.storage || {});
  const localStorageData = Object.assign({}, options.localStorage || {});
  const settings = [];
  const components = [];
  const notices = [];
  const logs = [];
  const sockets = [];
  const played = [];
  const serviceRequests = [];
  const timers = new Map();
  let nextTimer = 0;
  let closeCount = 0;
  let pauseCount = 0;

  function addEvent(name, fn) {
    (events[name] ||= []).push(fn);
  }

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
      if (options.socketThrows) throw new Error('socket constructor failed');
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    }
    open() {
      this.readyState = FakeWebSocket.OPEN;
      if (this.onopen) this.onopen();
    }
    message(data) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
    }
    fail() {
      if (this.onerror) this.onerror(new Error('network'));
    }
  }

  const fakeWindow = {
    webOS: options.noWebOS ? undefined : {
      service: {
        request(uri, request) {
          serviceRequests.push({ uri, request });
          const response = options.networkStatus || {
            returnValue: true,
            wifi: { state: 'connected', ipAddress: '192.168.1.50' },
            wired: { state: 'disconnected' }
          };
          if (options.networkFailure) request.onFailure(options.networkFailure);
          else request.onSuccess(response);
          return { cancel() {} };
        }
      }
    },
    localStorage: {
      getItem(name) { return Object.hasOwn(localStorageData, name) ? String(localStorageData[name]) : null; },
      setItem(name, value) { localStorageData[name] = String(value); },
      removeItem(name) { delete localStorageData[name]; }
    },
    console: {
      log(...args) { logs.push(['log', ...args]); },
      warn(...args) { logs.push(['warn', ...args]); },
      info(...args) { logs.push(['info', ...args]); },
      error(...args) { logs.push(['error', ...args]); }
    },
    WebSocket: options.noWebSocket ? undefined : FakeWebSocket
  };

  const panel = {
    _sleepButton: null,
    find(selector) {
      if (selector === '.player-panel__lampa-sleep') return { length: this._sleepButton ? 1 : 0 };
      if (selector === '.player-panel__settings') {
        return {
          length: 1,
          after: (button) => { panel._sleepButton = button; }
        };
      }
      return { length: 0 };
    }
  };

  function $(html) {
    if (typeof html === 'string' && html.includes('player-panel__lampa-sleep')) {
      return {
        handlers: {},
        on(name, fn) { this.handlers[name] = fn; return this; }
      };
    }
    return { length: 0 };
  }
  fakeWindow.$ = $;

  const video = {
    pause() { pauseCount++; }
  };

  const Lampa = {
    Storage: {
      get(name, fallback) {
        return Object.hasOwn(storage, name) ? storage[name] : fallback;
      },
      set(name, value) {
        storage[name] = value;
      }
    },
    SettingsApi: {
      addComponent(value) { components.push(value); },
      addParam(value) { settings.push(value); }
    },
    Noty: {
      show(text) { notices.push(text); }
    },
    Player: {
      listener: { follow(name, fn) { addEvent('player:' + name, fn); } },
      close() { closeCount++; },
      play(data) {
        const event = {
          data,
          aborted: false,
          abort() { this.aborted = true; }
        };
        for (const fn of events['player:create'] || []) fn(event);
        if (!event.aborted) played.push(data);
        return !event.aborted;
      }
    },
    PlayerVideo: {
      listener: { follow(name, fn) { addEvent('video:' + name, fn); } },
      video() { return video; }
    },
    PlayerPanel: {
      render() { return panel; }
    },
    Select: {
      show() {}
    },
    Controller: {
      toggle() {}
    }
  };

  fakeWindow.Lampa = Lampa;

  const sandbox = {
    window: fakeWindow,
    Lampa,
    console: fakeWindow.console,
    $,
    Date,
    Math,
    JSON,
    Error,
    Number,
    String,
    Object,
    Array,
    RegExp,
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  };

  vm.runInNewContext(plugin, sandbox, { filename: 'sleep.js' });

  function emit(name, data) {
    for (const fn of events[name] || []) fn(data);
  }

  function fireTimer(delay) {
    const pair = [...timers.entries()].find(([, item]) => item.delay === delay);
    assert.ok(pair, 'timer exists: ' + delay);
    timers.delete(pair[0]);
    pair[1].fn();
  }

  return {
    api: fakeWindow.LampaSleep,
    Lampa,
    storage,
    localStorageData,
    settings,
    components,
    notices,
    logs,
    sockets,
    timers,
    played,
    serviceRequests,
    panel,
    emit,
    fireTimer,
    get closeCount() { return closeCount; },
    get pauseCount() { return pauseCount; }
  };
}

test('registers a separate settings component and safe text host input', () => {
  const h = harness();
  assert.equal(h.api.version, '0.1.2-alpha');
  assert.equal(h.components[0].component, 'lampa_sleep');
  const input = h.settings.find(x => x.param.name === 'lampa_sleep_ssap_host');
  assert.ok(input);
  assert.equal(input.param.type, 'input');
  assert.equal(input.param.values, 'string');
});

test('accepts only loopback and private IPv4 SSAP targets', () => {
  const h = harness();
  const valid = ['auto', '127.0.0.1', 'localhost', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.20'];
  const invalid = ['8.8.8.8', '1.1.1.1', 'example.com', '172.32.0.1', '192.169.1.1', '', '256.1.1.1'];
  valid.forEach(host => assert.equal(h.api._test.isSafeHost(host), true, host));
  invalid.forEach(host => assert.equal(h.api._test.isSafeHost(host), false, host));
});

test('SSAP manifest is unsigned and requests only three power capabilities', () => {
  const h = harness();
  const manifest = h.api._test.manifest();
  assert.equal(manifest.appId, 'io.github.wathermg.lampa.sleep');
  assert.equal(Object.hasOwn(manifest, 'signed'), false);
  assert.equal(Object.hasOwn(manifest, 'signatures'), false);
  assert.deepEqual(Array.from(manifest.permissions), [
    'CONTROL_POWER',
    'CONTROL_TV_SCREEN',
    'READ_POWER_STATE'
  ]);
});

test('power calls fail closed while power integration is disabled', () => {
  const h = harness();
  let error;
  h.api.screenOff(err => { error = err; });
  assert.match(error.message, /отключено/);
  assert.equal(h.sockets.length, 0);
});

test('pairing uses PROMPT, stores the client key locally and never logs it', () => {
  const h = harness();
  h.api.config.powerEnabled = true;
  let pairError = 'pending';
  h.api.pair(err => { pairError = err; });
  assert.equal(h.sockets.length, 1);
  const ws = h.sockets[0];
  assert.equal(ws.url, 'ws://192.168.1.50:3000');
  ws.open();
  assert.equal(ws.sent[0].type, 'register');
  assert.equal(ws.sent[0].payload.pairingType, 'PROMPT');
  assert.equal(ws.sent[0].payload['client-key'], undefined);

  const secret = 'secret-client-key-123';
  ws.message({ type: 'registered', id: 'register_0', payload: { 'client-key': secret } });
  assert.equal(pairError, null);
  assert.equal(h.localStorageData.lampa_sleep_ssap_key, secret);
  assert.equal(Object.hasOwn(h.storage, 'lampa_sleep_ssap_key'), false);
  assert.equal(JSON.stringify(h.logs).includes(secret), false);
});

test('screen off sends only the documented SSAP power request after pairing', () => {
  const h = harness({ localStorage: { lampa_sleep_ssap_key: 'paired-key-123' } });
  h.api.config.powerEnabled = true;
  let result = 'pending';
  h.api.screenOff(err => { result = err; });
  const ws = h.sockets[0];
  ws.open();
  assert.equal(ws.sent[0].payload['client-key'], 'paired-key-123');
  ws.message({ type: 'registered', id: 'register_0', payload: { 'client-key': 'paired-key-123' } });
  assert.equal(ws.sent[1].uri, 'ssap://com.webos.service.tvpower/power/turnOffScreen');
  assert.deepEqual(ws.sent[1].payload, {});
  ws.message({ type: 'response', id: ws.sent[1].id, payload: { returnValue: true } });
  assert.equal(result, null);
});

test('TV off uses ssap system/turnOff and no Luna fallback', () => {
  const h = harness({ localStorage: { lampa_sleep_ssap_key: 'paired-key-123' } });
  h.api.config.powerEnabled = true;
  h.api.powerOff(() => {});
  const ws = h.sockets[0];
  ws.open();
  ws.message({ type: 'registered', id: 'register_0', payload: { 'client-key': 'paired-key-123' } });
  assert.equal(ws.sent[1].uri, 'ssap://system/turnOff');
  assert.equal(plugin.includes('luna://com.webos.service.tvpower'), false);
});

test('hard minute timer pauses and closes the Lampa player without power access', () => {
  const h = harness();
  h.api.armMinutes(15, { action: 'stop', soft: false });
  h.fireTimer(15 * 60000);
  assert.equal(h.pauseCount, 1);
  assert.equal(h.closeCount, 1);
  assert.equal(h.api.status().active, false);
  assert.equal(h.sockets.length, 0);
});

test('soft minute timer waits for current video end', () => {
  const h = harness();
  h.emit('player:start', { title: 'Episode' });
  h.api.armMinutes(15, { action: 'stop', soft: true });
  h.fireTimer(15 * 60000);
  assert.equal(h.closeCount, 0);
  assert.equal(h.api.status().pendingEnd, true);
  h.emit('video:ended', {});
  assert.equal(h.closeCount, 1);
});

test('episode counter stops after requested episode and blocks immediate autoplay next', () => {
  const h = harness();
  h.emit('player:start', { title: 'Episode 1' });
  h.api.armEpisodes(1, { action: 'stop' });
  h.emit('video:ended', {});
  assert.equal(h.closeCount, 1);

  const started = h.Lampa.Player.play({ title: 'Episode 2', url: 'https://example/video2' });
  assert.equal(started, false);
  assert.equal(h.played.length, 0);
});

test('player start installs one sleep button in the stock panel', () => {
  const h = harness();
  h.emit('player:start', {});
  h.emit('player:start', {});
  assert.ok(h.panel._sleepButton);
});

test('diagnostic settings expose pairing and safe screen checks without TV off button', () => {
  const h = harness();
  const buttons = h.settings.filter(x => x.param.type === 'button').map(x => x.field.name);
  assert.ok(buttons.includes('Сопрячь TV'));
  assert.ok(buttons.includes('Проверить состояние TV'));
  assert.ok(buttons.includes('Тест Screen Off → On'));
  assert.ok(buttons.includes('Включить экран'));
  assert.ok(buttons.includes('Забыть сопряжение'));
  assert.equal(buttons.some(name => /выключить телевизор/i.test(name)), false);
});

test('pairing timeout allows 30 seconds for on-TV approval', () => {
  const h = harness();
  h.api.config.powerEnabled = true;
  h.api.pair(() => {});
  const timeout = [...h.timers.values()].find(x => x.delay === 30000);
  assert.ok(timeout);
});

test('successful diagnostic request closes SSAP connection immediately', () => {
  const h = harness({ localStorage: { lampa_sleep_ssap_key: 'paired-key-123' } });
  h.api.config.powerEnabled = true;
  let done = false;
  h.api.getPowerState((err) => {
    assert.equal(err, null);
    done = true;
  });
  const ws = h.sockets[0];
  ws.open();
  ws.message({ type: 'registered', id: 'register_0', payload: { 'client-key': 'paired-key-123' } });
  const request = ws.sent[1];
  ws.message({ type: 'response', id: request.id, payload: { state: 'Active' } });
  assert.equal(done, true);
  assert.equal(ws.readyState, 3);
});

test('screen diagnostic performs screen off then screen on, never TV off', () => {
  const h = harness({ localStorage: { lampa_sleep_ssap_key: 'paired-key-123' } });
  h.api.config.powerEnabled = true;
  const btn = h.settings.find(x => x.param.type === 'button' && x.field.name === 'Тест Screen Off → On');
  assert.ok(btn);
  btn.onChange();

  const first = h.sockets[0];
  first.open();
  first.message({ type: 'registered', id: 'register_0', payload: { 'client-key': 'paired-key-123' } });
  assert.equal(first.sent[1].uri, 'ssap://com.webos.service.tvpower/power/turnOffScreen');
  first.message({ type: 'response', id: first.sent[1].id, payload: { returnValue: true } });

  h.fireTimer(3000);
  const second = h.sockets[1];
  second.open();
  second.message({ type: 'registered', id: 'register_0', payload: { 'client-key': 'paired-key-123' } });
  assert.equal(second.sent[1].uri, 'ssap://com.webos.service.tvpower/power/turnOnScreen');
  assert.equal([first, second].some(ws => ws.sent.some(msg => msg.uri === 'ssap://system/turnOff')), false);
});

test('diagnostic status never exposes the SSAP client key', () => {
  const secret = 'secret-client-key-123';
  const h = harness({ localStorage: { lampa_sleep_ssap_key: secret } });
  const status = h.api.status();
  assert.equal(Object.values(status).some(value => value === secret), false);
  assert.equal(JSON.stringify(h.settings).includes(secret), false);
});

test('auto host uses official webOS Connection Manager and selects active private IP', () => {
  const h = harness({
    networkStatus: {
      returnValue: true,
      wifi: { state: 'connected', ipAddress: '192.168.50.77' },
      wired: { state: 'disconnected' }
    }
  });
  let result;
  h.api.detectOwnTvIp((err, ip) => { result = { err, ip }; });
  assert.equal(result.err, null);
  assert.equal(result.ip, '192.168.50.77');
  assert.equal(h.serviceRequests.length, 1);
  assert.equal(h.serviceRequests[0].uri, 'luna://com.palm.connectionmanager');
  assert.equal(h.serviceRequests[0].request.method, 'getStatus');
  assert.equal(h.api.status().detectedHost, '192.168.50.77');
});

test('auto detection rejects a public interface address', () => {
  const h = harness({
    networkStatus: {
      returnValue: true,
      wifi: { state: 'connected', ipAddress: '8.8.8.8' },
      wired: { state: 'disconnected' }
    }
  });
  let error;
  h.api.detectOwnTvIp(err => { error = err; });
  assert.match(error.message, /приватный IP/);
});

test('pairing separates socket-open timeout from TV approval timeout', () => {
  const h = harness();
  h.api.config.powerEnabled = true;
  let error;
  h.api.pair(err => { error = err; });
  assert.equal(h.sockets[0].url, 'ws://192.168.1.50:3000');
  assert.ok([...h.timers.values()].some(x => x.delay === 5000));
  h.fireTimer(5000);
  assert.match(error.message, /WebSocket/);

  const h2 = harness();
  h2.api.config.powerEnabled = true;
  let error2;
  h2.api.pair(err => { error2 = err; });
  h2.sockets[0].open();
  assert.ok([...h2.timers.values()].some(x => x.delay === 30000));
  h2.fireTimer(30000);
  assert.match(error2.message, /pairing/);
});

test('manual private host bypasses network detection', () => {
  const h = harness({ storage: { lampa_sleep_ssap_host: '192.168.10.9' } });
  h.api.config.powerEnabled = true;
  h.api.pair(() => {});
  assert.equal(h.serviceRequests.length, 0);
  assert.equal(h.sockets[0].url, 'ws://192.168.10.9:3000');
});
