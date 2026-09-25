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
      onEnded: onEnded,
      executeAction: executeAction,
      companionRequest: companionRequest
    }
  };

  console.info('[LampaSleep] v' + VERSION + ' loaded; power=' + (config.powerEnabled ? 'enabled' : 'disabled'));
})();