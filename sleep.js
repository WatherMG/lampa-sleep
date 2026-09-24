/*
 * Lampa Sleep — safety-first sleep timer for Lampa.
 * No root, no private Luna power APIs, no remote backend.
 * Optional TV power control uses LG's local SSAP/WebSocket pairing protocol.
 */
(function () {
  'use strict';

  if (window.LampaSleep && window.LampaSleep.version) return;
  if (!window.Lampa || !Lampa.Player || !Lampa.Player.listener) {
    console.error('[LampaSleep] Lampa Player API is unavailable');
    return;
  }

  var VERSION = '0.1.0-alpha';
  var STORAGE_PREFIX = 'lampa_sleep_';
  var KEY_CLIENT = STORAGE_PREFIX + 'ssap_key';
  var KEY_HOST = STORAGE_PREFIX + 'ssap_host';
  var KEY_POWER = STORAGE_PREFIX + 'power_enabled';
  var KEY_ACTION = STORAGE_PREFIX + 'default_action';
  var KEY_SOFT = STORAGE_PREFIX + 'soft_timer';
  var KEY_DEBUG = STORAGE_PREFIX + 'debug';

  function storageGet(name, fallback) {
    try {
      return Lampa.Storage && Lampa.Storage.get ? Lampa.Storage.get(name, fallback) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function storageSet(name, value) {
    try {
      if (Lampa.Storage && Lampa.Storage.set) Lampa.Storage.set(name, value);
    } catch (e) {}
  }

  function asBool(value) {
    return value === true || value === 'true';
  }

  var config = {
    powerEnabled: asBool(storageGet(KEY_POWER, false)),
    host: storageGet(KEY_HOST, '127.0.0.1'),
    defaultAction: storageGet(KEY_ACTION, 'stop'),
    softTimer: asBool(storageGet(KEY_SOFT, true)),
    debug: asBool(storageGet(KEY_DEBUG, false))
  };

  if (!/^(stop|screen_off|tv_off)$/.test(config.defaultAction)) config.defaultAction = 'stop';

  var state = {
    active: false,
    mode: '',
    action: 'stop',
    deadline: 0,
    remainingEpisodes: 0,
    pendingEnd: false,
    blockNext: false,
    timer: null,
    lastError: '',
    lastPowerState: '',
    playerActive: false
  };

  function log() {
    if (config.debug && window.console) {
      console.log.apply(console, ['[LampaSleep]'].concat([].slice.call(arguments)));
    }
  }

  function notify(text) {
    if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(text);
    else if (window.console) console.warn('[LampaSleep]', text);
  }

  function isSafeHost(host) {
    if (typeof host !== 'string') return false;
    host = host.trim().toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return true;
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    var a = m.slice(1).map(Number);
    if (a.some(function (n) { return n < 0 || n > 255; })) return false;
    return a[0] === 10 ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && a[1] === 168) ||
      a[0] === 127;
  }

  function clearTimer() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function resetSchedule() {
    clearTimer();
    state.active = false;
    state.mode = '';
    state.deadline = 0;
    state.remainingEpisodes = 0;
    state.pendingEnd = false;
    state.blockNext = false;
  }

  function stopPlayback() {
    try {
      var video = Lampa.PlayerVideo && typeof Lampa.PlayerVideo.video === 'function' ?
        Lampa.PlayerVideo.video() : null;
      if (video && typeof video.pause === 'function') video.pause();
    } catch (e) {
      log('pause failed', String(e));
    }

    try {
      if (typeof Lampa.Player.close === 'function') Lampa.Player.close();
    } catch (e2) {
      log('player close failed', String(e2));
    }
  }

  function SSAPClient() {
    this.ws = null;
    this.connected = false;
    this.registered = false;
    this.pending = {};
    this.seq = 0;
    this.timer = null;
  }

  SSAPClient.prototype.clientKey = function () {
    // Keep the pairing credential outside Lampa.Storage to avoid application-level
    // sync/export mechanisms. It remains local to this web app origin.
    try {
      var key = window.localStorage ? window.localStorage.getItem(KEY_CLIENT) : '';
      return typeof key === 'string' ? key : '';
    } catch (e) {
      return '';
    }
  };

  SSAPClient.prototype.saveClientKey = function (key) {
    try {
      if (window.localStorage) window.localStorage.setItem(KEY_CLIENT, key);
    } catch (e) {}
  };

  SSAPClient.prototype.forget = function () {
    try {
      if (window.localStorage) window.localStorage.removeItem(KEY_CLIENT);
    } catch (e) {}
    this.close();
  };

  SSAPClient.prototype.manifest = function () {
    // Intentionally minimal and unsigned. We request only what this plugin needs.
    // No copied LG test signature, no pointer/keyboard/audio/app permissions.
    return {
      manifestVersion: 1,
      appVersion: VERSION,
      appId: 'io.github.wathermg.lampa.sleep',
      appName: 'Lampa Sleep',
      localizedAppNames: { '': 'Lampa Sleep' },
      permissions: ['CONTROL_POWER', 'CONTROL_TV_SCREEN', 'READ_POWER_STATE']
    };
  };

  SSAPClient.prototype.close = function () {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
    this.ws = null;
    this.connected = false;
    this.registered = false;
    this.pending = {};
  };

  SSAPClient.prototype.connect = function (callback) {
    var self = this;
    var host = String(config.host || '').trim();
    if (!isSafeHost(host)) {
      callback(new Error('Разрешены только localhost и приватные LAN IPv4-адреса'));
      return;
    }
    if (typeof window.WebSocket !== 'function') {
      callback(new Error('WebSocket API недоступен'));
      return;
    }

    self.close();
    var done = false;
    function finish(err) {
      if (done) return;
      done = true;
      if (self.timer) clearTimeout(self.timer);
      self.timer = null;
      callback(err || null);
    }

    var url = 'ws://' + host + ':3000';
    var ws;
    try {
      ws = new window.WebSocket(url);
    } catch (e) {
      finish(e);
      return;
    }
    self.ws = ws;
    self.timer = setTimeout(function () {
      finish(new Error('SSAP connection timeout'));
      self.close();
    }, 8000);

    ws.onopen = function () {
      self.connected = true;
      var payload = {
        forcePairing: false,
        pairingType: 'PROMPT',
        manifest: self.manifest()
      };
      var key = self.clientKey();
      if (key) payload['client-key'] = key;
      ws.send(JSON.stringify({ type: 'register', id: 'register_0', payload: payload }));
    };

    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'registered' && msg.id === 'register_0') {
        var newKey = msg.payload && msg.payload['client-key'];
        if (typeof newKey === 'string' && newKey.length >= 8) self.saveClientKey(newKey);
        self.registered = true;
        finish(null);
        return;
      }

      if (msg.type === 'error' && msg.id === 'register_0') {
        finish(new Error((msg.error || (msg.payload && msg.payload.errorText) || 'SSAP registration failed') + ''));
        return;
      }

      if ((msg.type === 'response' || msg.type === 'error') && msg.id && self.pending[msg.id]) {
        var cb = self.pending[msg.id];
        delete self.pending[msg.id];
        cb(msg.type === 'error' ? new Error(msg.error || 'SSAP request failed') : null, msg.payload || {});
      }
    };

    ws.onerror = function () {
      finish(new Error('SSAP WebSocket connection failed'));
    };

    ws.onclose = function () {
      self.connected = false;
      self.registered = false;
    };
  };

  SSAPClient.prototype.request = function (uri, payload, callback) {
    var self = this;
    function send() {
      if (!self.ws || !self.registered || self.ws.readyState !== 1) {
        callback(new Error('SSAP is not registered'));
        return;
      }
      var id = 'lampa_sleep_' + (++self.seq);
      self.pending[id] = callback;
      self.ws.send(JSON.stringify({
        type: 'request',
        id: id,
        uri: uri,
        payload: payload || {}
      }));
      setTimeout(function () {
        if (!self.pending[id]) return;
        delete self.pending[id];
        callback(new Error('SSAP request timeout'));
      }, 5000);
    }

    if (self.ws && self.registered && self.ws.readyState === 1) send();
    else self.connect(function (err) {
      if (err) callback(err);
      else send();
    });
  };

  var ssap = new SSAPClient();

  function recordPowerError(err) {
    state.lastError = err ? String(err.message || err) : '';
    if (state.lastError) log('power error', state.lastError);
  }

  function requirePower(callback) {
    if (!config.powerEnabled) {
      callback(new Error('Управление питанием отключено в настройках'));
      return;
    }
    if (!ssap.clientKey()) {
      callback(new Error('LG TV ещё не связан с Lampa Sleep'));
      return;
    }
    callback(null);
  }

  function getPowerState(callback) {
    callback = typeof callback === 'function' ? callback : function () {};
    requirePower(function (guardError) {
      if (guardError) return callback(guardError);
      ssap.request('ssap://com.webos.service.tvpower/power/getPowerState', {}, function (err, payload) {
        if (!err && payload && typeof payload.state === 'string') state.lastPowerState = payload.state;
        recordPowerError(err);
        callback(err, payload);
      });
    });
  }

  function screenOff(callback) {
    callback = typeof callback === 'function' ? callback : function () {};
    requirePower(function (guardError) {
      if (guardError) return callback(guardError);
      ssap.request('ssap://com.webos.service.tvpower/power/turnOffScreen', {}, function (err, payload) {
        recordPowerError(err);
        callback(err, payload);
      });
    });
  }

  function screenOn(callback) {
    callback = typeof callback === 'function' ? callback : function () {};
    requirePower(function (guardError) {
      if (guardError) return callback(guardError);
      ssap.request('ssap://com.webos.service.tvpower/power/turnOnScreen', {}, function (err, payload) {
        recordPowerError(err);
        callback(err, payload);
      });
    });
  }

  function powerOff(callback) {
    callback = typeof callback === 'function' ? callback : function () {};
    requirePower(function (guardError) {
      if (guardError) return callback(guardError);
      ssap.request('ssap://system/turnOff', {}, function (err, payload) {
        recordPowerError(err);
        callback(err, payload);
      });
    });
  }

  function executeAction(action) {
    var selected = /^(stop|screen_off|tv_off)$/.test(action) ? action : 'stop';
    var guardNext = state.blockNext;
    resetSchedule();
    if (guardNext) {
      state.blockNext = true;
      setTimeout(function () { state.blockNext = false; }, 3000);
    }
    stopPlayback();

    if (selected === 'stop') {
      notify('Lampa Sleep: воспроизведение остановлено.');
      return;
    }

    // Power operations are deliberately best-effort and fail closed:
    // playback is stopped first; an SSAP failure never triggers another mechanism.
    var fn = selected === 'screen_off' ? screenOff : powerOff;
    setTimeout(function () {
      fn(function (err) {
        ssap.close();
        if (err) {
          notify('Lampa Sleep: видео остановлено, но TV-команда не выполнена: ' + err.message);
          return;
        }
        if (selected === 'screen_off') notify('Lampa Sleep: экран выключен.');
      });
    }, 350);
  }

  function warnIfPowerUnavailable(action) {
    if (action === 'stop') return;
    if (!config.powerEnabled) {
      notify('Lampa Sleep: управление TV выключено; по таймеру будет гарантированно остановлено только видео.');
    } else if (!ssap.clientKey()) {
      notify('Lampa Sleep: TV не связан; выполните pairing, иначе по таймеру будет остановлено только видео.');
    }
  }

  function armMinutes(minutes, options) {
    minutes = Number(minutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
      throw new Error('minutes must be in range 1..1440');
    }
    options = options || {};
    resetSchedule();
    state.active = true;
    state.mode = 'minutes';
    state.action = options.action || config.defaultAction;
    warnIfPowerUnavailable(state.action);
    state.deadline = Date.now() + minutes * 60000;
    var soft = options.soft == null ? config.softTimer : !!options.soft;
    state.timer = setTimeout(function () {
      state.timer = null;
      if (!state.active) return;
      if (soft && state.playerActive) {
        state.pendingEnd = true;
        notify('Lampa Sleep: таймер истёк, остановка после окончания текущего видео.');
      } else {
        executeAction(state.action);
      }
    }, minutes * 60000);
    notify('Lampa Sleep: таймер ' + minutes + ' мин.');
    return snapshot();
  }

  function armEpisodes(count, options) {
    count = Number(count);
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new Error('episode count must be in range 1..20');
    }
    options = options || {};
    resetSchedule();
    state.active = true;
    state.mode = 'episodes';
    state.action = options.action || config.defaultAction;
    warnIfPowerUnavailable(state.action);
    state.remainingEpisodes = count;
    notify('Lampa Sleep: остановка после ' + count + ' видео/сер.');
    return snapshot();
  }

  function cancel() {
    var had = state.active;
    resetSchedule();
    if (had) notify('Lampa Sleep: таймер отменён.');
    return snapshot();
  }

  function snapshot() {
    return {
      active: state.active,
      mode: state.mode,
      action: state.action,
      deadline: state.deadline,
      remainingEpisodes: state.remainingEpisodes,
      pendingEnd: state.pendingEnd,
      playerActive: state.playerActive,
      powerEnabled: config.powerEnabled,
      paired: !!ssap.clientKey(),
      host: config.host,
      lastPowerState: state.lastPowerState,
      lastError: state.lastError
    };
  }

  function onEnded() {
    if (!state.active) return;

    if (state.pendingEnd) {
      state.blockNext = true;
      executeAction(state.action);
      return;
    }

    if (state.mode === 'episodes') {
      state.remainingEpisodes--;
      if (state.remainingEpisodes <= 0) {
        state.blockNext = true;
        executeAction(state.action);
      } else {
        log('episode ended; remaining', state.remainingEpisodes);
      }
    }
  }

  // Abort an automatic next-play race after the requested final episode.
  Lampa.Player.listener.follow('create', function (event) {
    if (!state.blockNext) return;
    if (event && typeof event.abort === 'function') event.abort();
    state.blockNext = false;
  });

  Lampa.Player.listener.follow('start', function () {
    state.playerActive = true;
    installPlayerButton();
  });

  Lampa.Player.listener.follow('destroy', function () {
    state.playerActive = false;
  });

  if (Lampa.PlayerVideo && Lampa.PlayerVideo.listener && typeof Lampa.PlayerVideo.listener.follow === 'function') {
    Lampa.PlayerVideo.listener.follow('ended', onEnded);
  }

  function showScheduleMenu() {
    if (!Lampa.Select || !Lampa.Select.show) return notify('Lampa.Select недоступен.');
    var items = [
      { title: '15 минут', kind: 'minutes', value: 15 },
      { title: '30 минут', kind: 'minutes', value: 30 },
      { title: '45 минут', kind: 'minutes', value: 45 },
      { title: '60 минут', kind: 'minutes', value: 60 },
      { title: 'После текущей серии/видео', kind: 'episodes', value: 1 },
      { title: 'После 2 серий', kind: 'episodes', value: 2 },
      { title: 'После 3 серий', kind: 'episodes', value: 3 }
    ];
    if (state.active) items.push({ title: 'Отменить таймер', kind: 'cancel' });

    Lampa.Select.show({
      title: 'Lampa Sleep · ' + actionLabel(config.defaultAction),
      items: items,
      onSelect: function (item) {
        if (item.kind === 'cancel') cancel();
        else if (item.kind === 'minutes') armMinutes(item.value);
        else if (item.kind === 'episodes') armEpisodes(item.value);
      },
      onBack: function () {
        if (Lampa.Controller && Lampa.Controller.toggle) Lampa.Controller.toggle('player');
      }
    });
  }

  function actionLabel(action) {
    if (action === 'screen_off') return 'выключить экран';
    if (action === 'tv_off') return 'выключить TV';
    return 'остановить';
  }

  function installPlayerButton() {
    if (!window.$ || !Lampa.PlayerPanel || typeof Lampa.PlayerPanel.render !== 'function') return;
    var panel = Lampa.PlayerPanel.render();
    if (!panel || !panel.find || panel.find('.player-panel__lampa-sleep').length) return;
    var button = $('<div class="player-panel__lampa-sleep button selector">' +
      '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12.7 2.1a9.9 9.9 0 1 0 9.2 12.7A8 8 0 0 1 12.7 2.1z"/></svg>' +
      '<div class="tooltip">Sleep</div></div>');
    button.on('hover:enter', showScheduleMenu);
    var settings = panel.find('.player-panel__settings');
    if (settings.length) settings.after(button);
  }

  function addSettings() {
    if (!Lampa.SettingsApi || typeof Lampa.SettingsApi.addParam !== 'function') return;
    var component = 'lampa_sleep';
    if (typeof Lampa.SettingsApi.addComponent === 'function') {
      Lampa.SettingsApi.addComponent({
        component: component,
        name: 'Lampa Sleep',
        after: 'player',
        icon: '<svg width="32" height="32" viewBox="0 0 24 24"><path fill="currentColor" d="M12.7 2.1a9.9 9.9 0 1 0 9.2 12.7A8 8 0 0 1 12.7 2.1z"/></svg>'
      });
    } else component = 'player';

    function param(name, type, def, values, label, descr, onChange) {
      var p = { name: name, type: type, default: def };
      if (values || type === 'input') p.values = type === 'input' ? 'string' : values;
      Lampa.SettingsApi.addParam({
        component: component,
        param: p,
        field: { name: label, description: descr || '' },
        onChange: onChange
      });
    }

    param(KEY_ACTION, 'select', 'stop', {
      stop: 'Остановить воспроизведение',
      screen_off: 'Остановить и выключить экран',
      tv_off: 'Остановить и выключить телевизор'
    }, 'Действие таймера', 'Power-команды выполняются только после явного включения и SSAP pairing.',
    function (value) {
      if (/^(stop|screen_off|tv_off)$/.test(value)) config.defaultAction = value;
    });

    param(KEY_SOFT, 'trigger', true, null,
      'Мягкий таймер по времени', 'После истечения времени дождаться конца текущего видео/серии.',
      function (value) { config.softTimer = asBool(value); });

    param(KEY_POWER, 'trigger', false, null,
      'Разрешить управление TV', 'По умолчанию выключено. Используется только локальный SSAP с подтверждением на экране TV.',
      function (value) { config.powerEnabled = asBool(value); });

    param(KEY_HOST, 'input', '127.0.0.1', null,
      'Адрес этого LG TV', 'Сначала попробуйте 127.0.0.1. Разрешены только loopback и приватные LAN IPv4.',
      function (value) {
        if (!isSafeHost(value)) {
          storageSet(KEY_HOST, config.host);
          return notify('Lampa Sleep: разрешён только localhost/приватный IPv4.');
        }
        config.host = String(value).trim();
      });

    param(KEY_DEBUG, 'trigger', false, null,
      'Диагностика', 'Логи без client-key и других секретов.',
      function (value) { config.debug = asBool(value); });
  }

  addSettings();

  window.LampaSleep = {
    version: VERSION,
    config: config,
    status: snapshot,
    armMinutes: armMinutes,
    armEpisodes: armEpisodes,
    cancel: cancel,
    pair: function (callback) {
      if (!config.powerEnabled) {
        var disabled = new Error('Сначала включите «Разрешить управление TV» в настройках.');
        if (callback) callback(disabled);
        else notify(disabled.message);
        return;
      }
      ssap.connect(function (err) {
        recordPowerError(err);
        if (err) notify('Lampa Sleep: pairing не выполнен: ' + err.message);
        else notify('Lampa Sleep: TV связан. Power-команды доступны.');
        if (callback) callback(err || null);
      });
    },
    forgetPairing: function () {
      ssap.forget();
      notify('Lampa Sleep: pairing удалён локально.');
    },
    getPowerState: getPowerState,
    screenOff: screenOff,
    screenOn: screenOn,
    powerOff: powerOff,
    _test: {
      isSafeHost: isSafeHost,
      manifest: function () { return ssap.manifest(); },
      onEnded: onEnded,
      executeAction: executeAction
    }
  };

  console.info('[LampaSleep] v' + VERSION + ' loaded; power=' + (config.powerEnabled ? 'enabled' : 'disabled'));
})();