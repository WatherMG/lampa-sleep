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

  var VERSION = '0.2.0-alpha';
  var STORAGE_PREFIX = 'lampa_sleep_';
  var KEY_CLIENT = STORAGE_PREFIX + 'ssap_key';
  var KEY_HOST = STORAGE_PREFIX + 'ssap_host';
  var KEY_POWER = STORAGE_PREFIX + 'power_enabled';
  var KEY_ACTION = STORAGE_PREFIX + 'default_action';
  var KEY_SOFT = STORAGE_PREFIX + 'soft_timer';
  var KEY_DEBUG = STORAGE_PREFIX + 'debug';
  var KEY_COMPANION_CODE = STORAGE_PREFIX + 'companion_code';
  var COMPANION_SERVICE = 'luna://io.github.wathermg.lampasleep.service';

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
    host: storageGet(KEY_HOST, 'auto'),
    defaultAction: storageGet(KEY_ACTION, 'stop'),
    softTimer: asBool(storageGet(KEY_SOFT, true)),
    debug: asBool(storageGet(KEY_DEBUG, false)),
    companionCode: storageGet(KEY_COMPANION_CODE, '')
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
    lastOperation: '',
    lastResult: 'Не проверялось',
    connectionStage: 'idle',
    detectedHost: '',
    companionAvailable: false,
    companionAuthorized: false,
    tvPaired: false,
    playerActive: false
  };

  var diagnosticStatusItem = null;

  function diagnosticText() {
    var parts = [
      'Companion: ' + (state.companionAvailable ? 'доступен' : 'не проверен'),
      'Lampa: ' + (state.companionAuthorized ? 'authorized' : 'not authorized'),
      'TV pairing: ' + (state.tvPaired ? 'есть' : 'нет'),
      'Stage: ' + state.connectionStage,
      'Последнее: ' + state.lastResult
    ];
    if (state.lastPowerState) parts.push('Power: ' + state.lastPowerState);
    return parts.join(' · ');
  }

  function refreshDiagnosticStatus() {
    if (!diagnosticStatusItem || !diagnosticStatusItem.find) return;
    try {
      diagnosticStatusItem.find('.settings-param__name').text('Статус: ' + diagnosticText());
    } catch (e) {}
  }

  function setDiagnostic(stage, operation, result) {
    if (stage) state.connectionStage = stage;
    if (operation) state.lastOperation = operation;
    if (result) state.lastResult = result;
    refreshDiagnosticStatus();
    log('diagnostic', stage, operation, result);
  }

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
    if (host === 'auto' || host === 'localhost' || host === '127.0.0.1') return true;
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    var a = m.slice(1).map(Number);
    if (a.some(function (n) { return n < 0 || n > 255; })) return false;
    return a[0] === 10 ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && a[1] === 168) ||
      a[0] === 127;
  }


  function extractConnectedIp(status) {
    if (!status || typeof status !== 'object') return '';
    var candidates = [status.wifi, status.wired];
    for (var i = 0; i < candidates.length; i++) {
      var item = candidates[i];
      if (!item || item.state !== 'connected' || !item.ipAddress) continue;
      var ip = String(item.ipAddress).trim();
      if (isSafeHost(ip) && ip !== '127.0.0.1') return ip;
    }
    return '';
  }

  function detectOwnTvIp(callback) {
    callback = typeof callback === 'function' ? callback : function () {};
    if (!window.webOS || !window.webOS.service || typeof window.webOS.service.request !== 'function') {
      callback(new Error('Публичный webOS Connection Manager недоступен'));
      return;
    }

    setDiagnostic('detecting_ip', 'Network', 'Определение адреса TV…');
    try {
      window.webOS.service.request('luna://com.palm.connectionmanager', {
        method: 'getStatus',
        parameters: { subscribe: false },
        onSuccess: function (response) {
          var ip = extractConnectedIp(response);
          if (!ip) {
            setDiagnostic('error', 'Network', 'Не найден приватный IP активного интерфейса');
            callback(new Error('Не удалось определить приватный IP телевизора'));
            return;
          }
          state.detectedHost = ip;
          setDiagnostic('idle', 'Network', 'Адрес TV: ' + ip);
          callback(null, ip);
        },
        onFailure: function (error) {
          var message = error && (error.errorText || error.message) || 'Connection Manager error';
          setDiagnostic('error', 'Network', message);
          callback(new Error(message));
        }
      });
    } catch (e) {
      setDiagnostic('error', 'Network', String(e.message || e));
      callback(e);
    }
  }

  function resolveSsAPHost(callback) {
    var configured = String(config.host || 'auto').trim().toLowerCase();
    if (configured !== 'auto' && configured !== 'localhost' && configured !== '127.0.0.1') {
      if (!isSafeHost(configured)) return callback(new Error('Некорректный адрес TV'));
      state.detectedHost = configured;
      callback(null, configured);
      return;
    }

    detectOwnTvIp(function (err, ip) {
      if (!err && ip) return callback(null, ip);
      if (configured === 'localhost' || configured === '127.0.0.1') {
        state.detectedHost = configured;
        setDiagnostic('idle', 'Network', 'Используется loopback ' + configured);
        callback(null, configured);
        return;
      }
      callback(err || new Error('Адрес TV не определён'));
    });
  }


  function companionRequest(method, parameters, callback) {
    callback = typeof callback === 'function' ? callback : function () {};
    parameters = parameters || {};

    if (window.webOS && window.webOS.service && typeof window.webOS.service.request === 'function') {
      try {
        window.webOS.service.request(COMPANION_SERVICE, {
          method: method,
          parameters: parameters,
          onSuccess: function (result) {
            state.companionAvailable = true;
            callback(null, result || {});
          },
          onFailure: function (error) {
            var text = error && (error.errorText || error.message || error.errorCode) || 'Companion service request failed';
            callback(new Error(String(text)));
          }
        });
      } catch (e) {
        callback(e);
      }
      return;
    }

    if (window.PalmServiceBridge) {
      try {
        var bridge = new window.PalmServiceBridge();
        var done = false;
        bridge.onservicecallback = function (text) {
          if (done) return;
          done = true;
          var result;
          try { result = JSON.parse(text); }
          catch (e) { result = { returnValue: false, errorText: text }; }
          try { bridge.cancel(); } catch (e2) {}
          if (!result || result.returnValue === false) {
            callback(new Error(result && (result.errorText || result.errorCode) || 'Companion service request failed'));
          } else {
            state.companionAvailable = true;
            callback(null, result);
          }
        };
        bridge.call(COMPANION_SERVICE + '/' + method, JSON.stringify(parameters));
      } catch (e3) {
        callback(e3);
      }
      return;
    }

    callback(new Error('webOS Luna bridge недоступен'));
  }

  function refreshCompanionStatus(callback) {
    companionRequest('status', {}, function (err, result) {
      if (err) {
        state.companionAvailable = false;
        state.companionAuthorized = false;
        state.tvPaired = false;
        state.lastError = err.message;
        setDiagnostic('error', 'Companion', 'Companion не установлен или недоступен: ' + err.message);
        if (callback) callback(err);
        return;
      }

      state.companionAvailable = true;
      state.companionAuthorized = !!result.callerAuthorized;
      state.tvPaired = !!result.tvPaired;
      state.lastError = '';
      setDiagnostic('idle', 'Companion',
        'Service ' + (result.version || '?') +
        ' · Lampa: ' + (state.companionAuthorized ? 'authorized' : 'not authorized') +
        ' · TV: ' + (state.tvPaired ? 'paired' : 'not paired'));
      if (callback) callback(null, result);
    });
  }

  function authorizeCompanion(callback) {
    var code = String(config.companionCode || '').trim();
    if (!/^\d{6}$/.test(code)) {
      var invalid = new Error('Введите 6-значный код из приложения Lampa Sleep Companion');
      if (callback) callback(invalid);
      else notify('Lampa Sleep: ' + invalid.message);
      return;
    }

    setDiagnostic('authorizing', 'Companion', 'Авторизация Lampa…');
    companionRequest('authorize', { code: code }, function (err) {
      if (err) {
        setDiagnostic('error', 'Companion', err.message);
        if (callback) callback(err);
        else notify('Lampa Sleep: авторизация companion не выполнена: ' + err.message);
        return;
      }
      state.companionAuthorized = true;
      config.companionCode = '';
      storageSet(KEY_COMPANION_CODE, '');
      setDiagnostic('idle', 'Companion', 'Lampa авторизована');
      notify('Lampa Sleep: companion авторизован.');
      if (callback) callback(null);
    });
  }

  function pairTvViaCompanion(callback) {
    callback = typeof callback === 'function' ? callback : function () {};
    if (!config.powerEnabled) return callback(new Error('Сначала включите «Разрешить управление TV»'));

    setDiagnostic('pairing_tv', 'LG SSAP', 'Запуск pairing через локальный companion…');
    companionRequest('pairTv', {}, function (err, result) {
      if (err) {
        state.tvPaired = false;
        setDiagnostic('error', 'LG SSAP', err.message);
        callback(err);
        return;
      }
      state.tvPaired = !!result.tvPaired;
      setDiagnostic('idle', 'LG SSAP', state.tvPaired ? 'TV связан' : 'Pairing завершён без подтверждения');
      callback(null, result);
    });
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
    callback = typeof callback === 'function' ? callback : function () {};

    resolveSsAPHost(function (resolveError, host) {
      if (resolveError) {
        callback(resolveError);
        return;
      }
      if (!isSafeHost(host) || host === 'auto') {
        callback(new Error('Разрешены только localhost и приватные LAN IPv4-адреса'));
        return;
      }
      if (typeof window.WebSocket !== 'function') {
        callback(new Error('WebSocket API недоступен'));
        return;
      }

      self.close();
      setDiagnostic('connecting', 'SSAP', 'Подключение к ' + host + ':3000');
      var done = false;
      var socketOpened = false;

      function armTimeout(ms, message) {
        if (self.timer) clearTimeout(self.timer);
        self.timer = setTimeout(function () {
          finish(new Error(message));
          self.close();
        }, ms);
      }

      function finish(err) {
        if (done) return;
        done = true;
        if (self.timer) clearTimeout(self.timer);
        self.timer = null;
        if (err) setDiagnostic('error', 'SSAP', String(err.message || err));
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
      armTimeout(5000, 'Не удалось открыть SSAP WebSocket к ' + host + ':3000');

      ws.onopen = function () {
        socketOpened = true;
        self.connected = true;
        setDiagnostic('socket_open', 'SSAP', 'WebSocket открыт: ' + host + ':3000');
        armTimeout(30000, 'WebSocket открыт, но TV не завершил SSAP pairing за 30 секунд');

        var payload = {
          forcePairing: false,
          pairingType: 'PROMPT',
          manifest: self.manifest()
        };
        var key = self.clientKey();
        if (key) payload['client-key'] = key;
        setDiagnostic('registering', 'Pairing', key ? 'Проверка сохранённого pairing' : 'Регистрация отправлена; ожидается запрос LG');
        ws.send(JSON.stringify({ type: 'register', id: 'register_0', payload: payload }));
      };

      ws.onmessage = function (event) {
        var msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'registered' && (!msg.id || msg.id === 'register_0')) {
          var newKey = msg.payload && msg.payload['client-key'];
          if (typeof newKey === 'string' && newKey.length >= 8) self.saveClientKey(newKey);
          self.registered = true;
          setDiagnostic('paired', 'Pairing', 'TV связан через ' + host);
          finish(null);
          return;
        }

        if ((msg.type === 'pairing' || msg.type === 'response') &&
            (!msg.id || msg.id === 'register_0') &&
            msg.payload && msg.payload.pairingType === 'PROMPT') {
          setDiagnostic('waiting_approval', 'Pairing', 'Подтвердите системный запрос LG на экране TV');
          return;
        }

        if (msg.type === 'error' && (!msg.id || msg.id === 'register_0')) {
          finish(new Error((msg.error || (msg.payload && msg.payload.errorText) || 'SSAP registration failed') + ''));
          return;
        }

        if ((msg.type === 'response' || msg.type === 'error') && msg.id && self.pending[msg.id]) {
          var cb = self.pending[msg.id];
          delete self.pending[msg.id];
          var requestError = msg.type === 'error' ? new Error(msg.error || 'SSAP request failed') : null;
          self.close();
          cb(requestError, msg.payload || {});
        }
      };

      ws.onerror = function () {
        finish(new Error(socketOpened ?
          'SSAP WebSocket error после открытия соединения' :
          'SSAP WebSocket не открылся. Возможна блокировка Origin/mixed-content или порт 3000 недоступен'));
      };

      ws.onclose = function () {
        self.connected = false;
        self.registered = false;
        if (!done) {
          finish(new Error(socketOpened ?
            'SSAP WebSocket закрыт до завершения регистрации' :
            'SSAP WebSocket отклонён до открытия соединения'));
        }
      };
    });
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
        self.close();
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

  function ensurePowerEnabled(callback) {
    if (!config.powerEnabled) {
      callback(new Error('Управление питанием отключено в настройках'));
      return;
    }
    callback(null);
  }

  function companionPower(method, callback) {
    callback = typeof callback === 'function' ? callback : function () {};
    ensurePowerEnabled(function (guardError) {
      if (guardError) return callback(guardError);

      companionRequest(method, {}, function (err, result) {
        recordPowerError(err);
        if (err) {
          state.companionAvailable = false;
          callback(err);
          return;
        }
        state.companionAvailable = true;
        state.companionAuthorized = true;
        state.tvPaired = true;
        callback(null, result && (result.payload || result));
      });
    });
  }

  function getPowerState(callback) {
    companionPower('getPowerState', function (err, payload) {
      if (!err && payload && typeof payload.state === 'string') state.lastPowerState = payload.state;
      callback = typeof callback === 'function' ? callback : function () {};
      callback(err, payload);
    });
  }

  function screenOff(callback) {
    companionPower('screenOff', callback);
  }

  function screenOn(callback) {
    companionPower('screenOn', callback);
  }

  function powerOff(callback) {
    companionPower('powerOff', callback);
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
    } else if (!state.companionAuthorized || !state.tvPaired) {
      notify('Lampa Sleep: companion/TV ещё не готовы; по таймеру будет гарантированно остановлено только видео.');
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
      paired: state.tvPaired,
      companionAvailable: state.companionAvailable,
      companionAuthorized: state.companionAuthorized,
      host: config.host,
      detectedHost: state.detectedHost,
      lastPowerState: state.lastPowerState,
      lastOperation: state.lastOperation,
      lastResult: state.lastResult,
      connectionStage: state.connectionStage,
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

    param(KEY_DEBUG, 'trigger', false, null,
      'Диагностика', 'Логи без client-key и других секретов.',
      function (value) { config.debug = asBool(value); });

    Lampa.SettingsApi.addParam({
      component: component,
      param: { type: 'title' },
      field: { name: 'Диагностика и сопряжение' }
    });

    param(KEY_COMPANION_CODE, 'input', '', null,
      'Код Companion', 'Откройте Lampa Sleep Companion на TV и введите показанный 6-значный код.',
      function (value) { config.companionCode = String(value || '').trim(); });

    diagnosticButton('Авторизовать companion', 'Одноразово привязывает установленную Lampa к локальному companion service.', function () {
      authorizeCompanion(function (err) {
        if (err) notify('Lampa Sleep: ' + err.message);
        refreshDiagnosticStatus();
      });
    });

    diagnosticButton('Проверить companion', 'Проверяет локальный service, авторизацию Lampa и наличие TV pairing.', function () {
      refreshCompanionStatus(function (err) {
        if (err) notify('Lampa Sleep: companion недоступен: ' + err.message);
        else notify('Lampa Sleep: companion доступен.');
      });
    });

    Lampa.SettingsApi.addParam({
      component: component,
      param: { type: 'static' },
      field: { name: 'Статус: ' + diagnosticText(), description: 'Client-key никогда не отображается.' },
      onRender: function (item) {
        diagnosticStatusItem = item;
        refreshDiagnosticStatus();
      }
    });

    function diagnosticButton(name, description, action) {
      Lampa.SettingsApi.addParam({
        component: component,
        param: { type: 'button' },
        field: { name: name, description: description || '' },
        onChange: action
      });
    }

    diagnosticButton('Сопрячь TV', 'Companion подключится к WSS loopback:3001. LG должен показать системный запрос подтверждения.', function () {
      pairTvViaCompanion(function (err) {
        if (err) notify('Lampa Sleep: сопряжение TV не выполнено: ' + err.message);
        else notify('Lampa Sleep: TV успешно связан через companion.');
        refreshDiagnosticStatus();
      });
    });

    diagnosticButton('Проверить состояние TV', 'Безопасный read-only запрос текущего состояния питания.', function () {
      setDiagnostic('checking', 'Power state', 'Запрос состояния…');
      getPowerState(function (err, payload) {
        if (err) {
          setDiagnostic('error', 'Power state', err.message);
          notify('Lampa Sleep: ' + err.message);
        } else {
          var value = payload && (payload.state || payload.processing) || 'ответ получен';
          setDiagnostic('idle', 'Power state', String(value));
          notify('Lampa Sleep: состояние TV — ' + value);
        }
      });
    });

    diagnosticButton('Тест Screen Off → On', 'Выключает только экран на 3 секунды и автоматически включает его обратно. Видео не запускается.', function () {
      if (!config.powerEnabled || !state.companionAuthorized || !state.tvPaired) {
        return notify('Сначала авторизуйте companion и выполните сопряжение TV.');
      }
      setDiagnostic('testing_screen', 'Screen Off/On', 'Выключение экрана…');
      screenOff(function (offErr) {
        if (offErr) {
          setDiagnostic('error', 'Screen Off/On', offErr.message);
          return notify('Lampa Sleep: Screen Off не выполнен: ' + offErr.message);
        }
        notify('Lampa Sleep: экран выключен на 3 секунды.');
        setTimeout(function () {
          setDiagnostic('testing_screen', 'Screen Off/On', 'Включение экрана…');
          screenOn(function (onErr) {
            if (onErr) {
              setDiagnostic('error', 'Screen Off/On', 'Screen On: ' + onErr.message);
              notify('Lampa Sleep: Screen On не выполнен. Используйте обычный пульт LG. ' + onErr.message);
            } else {
              setDiagnostic('idle', 'Screen Off/On', 'Успешно');
              notify('Lampa Sleep: Screen Off/On успешно.');
            }
          });
        }, 3000);
      });
    });

    diagnosticButton('Включить экран', 'Аварийная отдельная команда Screen On после успешного pairing.', function () {
      setDiagnostic('testing_screen', 'Screen On', 'Отправка команды…');
      screenOn(function (err) {
        if (err) {
          setDiagnostic('error', 'Screen On', err.message);
          notify('Lampa Sleep: Screen On не выполнен: ' + err.message);
        } else {
          setDiagnostic('idle', 'Screen On', 'Успешно');
          notify('Lampa Sleep: команда Screen On отправлена.');
        }
      });
    });

    diagnosticButton('Забыть сопряжение TV', 'Удаляет SSAP client-key только из companion service.', function () {
      companionRequest('forgetTvPairing', {}, function (err) {
        if (err) return notify('Lampa Sleep: ' + err.message);
        state.tvPaired = false;
        state.lastError = '';
        setDiagnostic('idle', 'LG SSAP', 'TV pairing удалён');
        notify('Lampa Sleep: TV pairing удалён.');
      });
    });
  }

  addSettings();

  window.LampaSleep = {
    version: VERSION,
    config: config,
    status: snapshot,
    detectOwnTvIp: detectOwnTvIp,
    armMinutes: armMinutes,
    armEpisodes: armEpisodes,
    cancel: cancel,
    authorizeCompanion: authorizeCompanion,
    refreshCompanionStatus: refreshCompanionStatus,
    pair: pairTvViaCompanion,
    forgetPairing: function (callback) {
      companionRequest('forgetTvPairing', {}, function (err, result) {
        if (!err) state.tvPaired = false;
        if (callback) callback(err, result);
      });
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