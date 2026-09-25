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

          if (uri === 'luna://io.github.wathermg.lampasleep.service') {
            const defaults = {
              status: { returnValue: true, version: '0.2.0-alpha', callerAuthorized: true, tvPaired: true },
              authorize: { returnValue: true },
              pairTv: { returnValue: true, tvPaired: true },
              forgetTvPairing: { returnValue: true },
              getPowerState: { returnValue: true, payload: { state: 'Active' } },
              screenOff: { returnValue: true, payload: { returnValue: true } },
              screenOn: { returnValue: true, payload: { returnValue: true } },
              powerOff: { returnValue: true, payload: { accepted: true } }
            };
            const configured = options.companionResponses && options.companionResponses[request.method];
            const response = configured === undefined ? defaults[request.method] : configured;
            if (response instanceof Error || (response && response.returnValue === false)) {
              request.onFailure(response instanceof Error ? { errorText: response.message } : response);
            } else {
              request.onSuccess(response || { returnValue: true });
            }
            return { cancel() {} };
          }

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

test('registers a separate settings component and safe companion code input', () => {
  const h = harness();
  assert.equal(h.api.version, '0.2.0-alpha');
  assert.equal(h.components[0].component, 'lampa_sleep');
  const input = h.settings.find(x => x.param.name === 'lampa_sleep_companion_code');
  assert.ok(input);
  assert.equal(input.param.type, 'input');
  assert.equal(input.param.values, 'string');
});


test('companion service is the configured power backend', () => {
  const h = harness();
  h.api.refreshCompanionStatus(() => {});
  assert.equal(h.api.status().companionAvailable, true);
});


test('power backend does not create browser sockets', () => {
  const h = harness();
  h.api.config.powerEnabled = true;
  h.api.getPowerState(() => {});
  assert.equal(h.sockets.length, 0);
});

test('power calls fail closed while power integration is disabled', () => {
  const h = harness();
  let error;
  h.api.screenOff(err => { error = err; });
  assert.match(error.message, /отключено/);
  assert.equal(h.sockets.length, 0);
});


test('companion authorization sends only the one-time code over Luna', () => {
  const h = harness({ storage: { lampa_sleep_companion_code: '123456' } });
  let error = 'pending';
  h.api.authorizeCompanion(err => { error = err; });
  assert.equal(error, null);
  const call = h.serviceRequests.find(x =>
    x.uri === 'luna://io.github.wathermg.lampasleep.service' &&
    x.request.method === 'authorize'
  );
  assert.ok(call);
  assert.equal(call.request.parameters.code, '123456');
  assert.equal(h.api.status().companionAuthorized, true);
  assert.equal(h.storage.lampa_sleep_companion_code, '');
});


test('screen off is delegated only to the local companion service', () => {
  const h = harness();
  h.api.config.powerEnabled = true;
  let result = 'pending';
  h.api.screenOff(err => { result = err; });
  assert.equal(result, null);
  const calls = h.serviceRequests.filter(x => x.uri === 'luna://io.github.wathermg.lampasleep.service');
  assert.equal(calls.at(-1).request.method, 'screenOff');
  assert.equal(h.sockets.length, 0);
});


test('TV off is delegated to companion and browser SSAP is not opened', () => {
  const h = harness();
  h.api.config.powerEnabled = true;
  let result = 'pending';
  h.api.powerOff(err => { result = err; });
  assert.equal(result, null);
  const calls = h.serviceRequests.filter(x => x.uri === 'luna://io.github.wathermg.lampasleep.service');
  assert.equal(calls.at(-1).request.method, 'powerOff');
  assert.equal(h.sockets.length, 0);
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
  assert.ok(buttons.includes('Забыть сопряжение TV'));
  assert.equal(buttons.some(name => /выключить телевизор/i.test(name)), false);
});


test('TV pairing is delegated to companion service', () => {
  const h = harness();
  h.api.config.powerEnabled = true;
  let error = 'pending';
  h.api.pair(err => { error = err; });
  assert.equal(error, null);
  const call = h.serviceRequests.find(x =>
    x.uri === 'luna://io.github.wathermg.lampasleep.service' &&
    x.request.method === 'pairTv'
  );
  assert.ok(call);
  assert.equal(h.api.status().paired, true);
  assert.equal(h.sockets.length, 0);
});


test('power-state diagnostic uses companion and stores returned state', () => {
  const h = harness();
  h.api.config.powerEnabled = true;
  let payload;
  h.api.getPowerState((err, result) => {
    assert.equal(err, null);
    payload = result;
  });
  assert.equal(payload.state, 'Active');
  assert.equal(h.api.status().lastPowerState, 'Active');
  assert.equal(h.sockets.length, 0);
});


test('screen diagnostic performs companion screenOff then screenOn and never powerOff', () => {
  const h = harness();
  h.api.config.powerEnabled = true;
  h.api.refreshCompanionStatus(() => {});
  const btn = h.settings.find(x => x.param.type === 'button' && x.field.name === 'Тест Screen Off → On');
  assert.ok(btn);
  btn.onChange();

  const calls1 = h.serviceRequests
    .filter(x => x.uri === 'luna://io.github.wathermg.lampasleep.service')
    .map(x => x.request.method);
  assert.ok(calls1.includes('screenOff'));

  h.fireTimer(3000);

  const methods = h.serviceRequests
    .filter(x => x.uri === 'luna://io.github.wathermg.lampasleep.service')
    .map(x => x.request.method);
  assert.ok(methods.includes('screenOn'));
  assert.equal(methods.includes('powerOff'), false);
  assert.equal(h.sockets.length, 0);
});


test('plugin status exposes readiness without credentials', () => {
  const h = harness();
  h.api.refreshCompanionStatus(() => {});
  const status = h.api.status();
  assert.equal(status.companionAvailable, true);
  assert.equal(status.companionAuthorized, true);
  assert.equal(status.paired, true);
  assert.equal(Object.hasOwn(status, 'clientKey'), false);
});


test('power setup no longer performs network address discovery', () => {
  const h = harness();
  h.api.refreshCompanionStatus(() => {});
  const networkCalls = h.serviceRequests.filter(x => x.uri === 'luna://com.palm.connectionmanager');
  assert.equal(networkCalls.length, 0);
});


test('companion authorization validates the setup code locally', () => {
  const h = harness({ storage: { lampa_sleep_companion_code: 'abc' } });
  let error;
  h.api.authorizeCompanion(err => { error = err; });
  assert.match(error.message, /6-значный/);
});

test('companion failures are surfaced without browser WebSocket fallback', () => {
  const h = harness({
    companionResponses: {
      pairTv: { returnValue: false, errorText: 'WSS loopback failed' }
    }
  });
  h.api.config.powerEnabled = true;
  let error;
  h.api.pair(err => { error = err; });
  assert.match(error.message, /WSS loopback failed/);
  assert.equal(h.sockets.length, 0);
});


test('companion status reports authorization and TV pairing', () => {
  const h = harness();
  let result;
  h.api.refreshCompanionStatus((err, status) => {
    assert.equal(err, null);
    result = status;
  });
  assert.equal(result.callerAuthorized, true);
  assert.equal(result.tvPaired, true);
  const status = h.api.status();
  assert.equal(status.companionAvailable, true);
  assert.equal(status.companionAuthorized, true);
  assert.equal(status.paired, true);
});

