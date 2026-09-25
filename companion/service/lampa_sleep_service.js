'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var Service = require('webos-service');
var ssap = require('./ssap');

var SERVICE_ID = 'io.github.wathermg.lampasleep.service';
var APP_ID = 'io.github.wathermg.lampasleep';
var VERSION = '0.2.0-alpha';
var DATA_DIR = '/media/internal/.lampa-sleep';
var STATE_FILE = path.join(DATA_DIR, 'companion-state.json');
var SETUP_TTL_MS = 5 * 60 * 1000;

var service = new Service(SERVICE_ID);
var state = {
  authorizedSender: '',
  setupCodeHash: '',
  setupExpiresAt: 0,
  tvClientKey: ''
};
var loaded = false;
var loadWaiters = [];

function safeSender(message) {
  return message && typeof message.sender === 'string' ? message.sender : '';
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function publicState() {
  return {
    version: VERSION,
    authorized: !!state.authorizedSender,
    tvPaired: !!state.tvClientKey,
    setupActive: !!state.setupCodeHash && state.setupExpiresAt > Date.now()
  };
}

function ensureDataDir(callback) {
  fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 }, function (err) {
    callback(err || null);
  });
}

function persist(callback) {
  callback = typeof callback === 'function' ? callback : function () {};
  ensureDataDir(function (dirErr) {
    if (dirErr) return callback(dirErr);
    var temp = STATE_FILE + '.tmp';
    var payload = JSON.stringify({
      authorizedSender: state.authorizedSender,
      setupCodeHash: state.setupCodeHash,
      setupExpiresAt: state.setupExpiresAt,
      tvClientKey: state.tvClientKey
    });
    fs.writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 }, function (writeErr) {
      if (writeErr) return callback(writeErr);
      fs.rename(temp, STATE_FILE, function (renameErr) {
        callback(renameErr || null);
      });
    });
  });
}

function load(callback) {
  if (loaded) return callback();
  loadWaiters.push(callback);
  if (loadWaiters.length > 1) return;

  fs.readFile(STATE_FILE, 'utf8', function (err, text) {
    if (!err) {
      try {
        var parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          state.authorizedSender = typeof parsed.authorizedSender === 'string' ? parsed.authorizedSender : '';
          state.setupCodeHash = typeof parsed.setupCodeHash === 'string' ? parsed.setupCodeHash : '';
          state.setupExpiresAt = Number(parsed.setupExpiresAt) || 0;
          state.tvClientKey = typeof parsed.tvClientKey === 'string' ? parsed.tvClientKey : '';
        }
      } catch (e) {
        console.error('[LampaSleepService] invalid state file:', e.message);
      }
    } else if (err.code !== 'ENOENT') {
      console.error('[LampaSleepService] state read failed:', err.message);
    }
    loaded = true;
    var waiters = loadWaiters;
    loadWaiters = [];
    waiters.forEach(function (fn) { fn(); });
  });
}

function respondError(message, code, text) {
  message.respond({
    returnValue: false,
    errorCode: code,
    errorText: text
  });
}

function requireCompanionApp(message, callback) {
  var sender = safeSender(message);
  if (sender !== APP_ID) {
    respondError(message, 'FORBIDDEN', 'Method is available only to the Lampa Sleep companion app');
    return;
  }
  callback();
}

function requireAuthorized(message, callback) {
  load(function () {
    var sender = safeSender(message);
    if (!sender || sender !== state.authorizedSender) {
      respondError(message, 'NOT_AUTHORIZED', 'This app is not authorized for Lampa Sleep companion');
      return;
    }
    callback();
  });
}

function runTvCommand(message, uri) {
  requireAuthorized(message, function () {
    if (!state.tvClientKey) {
      respondError(message, 'TV_NOT_PAIRED', 'LG SSAP pairing has not been completed');
      return;
    }
    ssap.run({
      clientKey: state.tvClientKey,
      uri: uri
    }, function (err, result) {
      if (err) {
        respondError(message, 'SSAP_ERROR', err.message);
        return;
      }
      if (result.clientKey && result.clientKey !== state.tvClientKey) {
        state.tvClientKey = result.clientKey;
        persist(function () {});
      }
      message.respond({
        returnValue: true,
        payload: result.payload || {}
      });
    });
  });
}

service.register('status', function (message) {
  load(function () {
    var result = publicState();
    result.returnValue = true;
    result.callerAuthorized = safeSender(message) === state.authorizedSender;
    message.respond(result);
  });
});

service.register('createSetupCode', function (message) {
  requireCompanionApp(message, function () {
    load(function () {
      var code = String(crypto.randomInt ? crypto.randomInt(100000, 1000000) :
        (100000 + Math.floor(Math.random() * 900000)));
      state.setupCodeHash = hashCode(code);
      state.setupExpiresAt = Date.now() + SETUP_TTL_MS;
      persist(function (err) {
        if (err) return respondError(message, 'STATE_WRITE_FAILED', err.message);
        message.respond({
          returnValue: true,
          code: code,
          expiresInSeconds: Math.floor(SETUP_TTL_MS / 1000)
        });
      });
    });
  });
});

service.register('authorize', function (message) {
  load(function () {
    var code = message.payload && String(message.payload.code || '').trim();
    var sender = safeSender(message);
    if (!sender) return respondError(message, 'NO_SENDER', 'Caller sender ID is unavailable');
    if (!/^\d{6}$/.test(code)) return respondError(message, 'BAD_CODE', 'Setup code must contain 6 digits');
    if (!state.setupCodeHash || state.setupExpiresAt <= Date.now()) {
      return respondError(message, 'SETUP_EXPIRED', 'Setup code is missing or expired');
    }

    var actual = Buffer.from(hashCode(code), 'hex');
    var expected = Buffer.from(state.setupCodeHash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return respondError(message, 'BAD_CODE', 'Incorrect setup code');
    }

    state.authorizedSender = sender;
    state.setupCodeHash = '';
    state.setupExpiresAt = 0;
    persist(function (err) {
      if (err) return respondError(message, 'STATE_WRITE_FAILED', err.message);
      message.respond({ returnValue: true, authorizedSender: sender });
    });
  });
});

service.register('revokeAuthorization', function (message) {
  requireCompanionApp(message, function () {
    load(function () {
      state.authorizedSender = '';
      state.setupCodeHash = '';
      state.setupExpiresAt = 0;
      persist(function (err) {
        if (err) return respondError(message, 'STATE_WRITE_FAILED', err.message);
        message.respond({ returnValue: true });
      });
    });
  });
});

service.register('probe', function (message) {
  requireAuthorized(message, function () {
    ssap.probe(function (err, payload) {
      if (err) return respondError(message, 'SSAP_PROBE_FAILED', err.message);
      message.respond({
        returnValue: true,
        transport: 'wss-loopback-3001',
        payload: payload || {}
      });
    });
  });
});

service.register('pairTv', function (message) {
  requireAuthorized(message, function () {
    ssap.run({
      pairOnly: true,
      clientKey: state.tvClientKey,
      pairTimeout: 30000
    }, function (err, result) {
      if (err) return respondError(message, 'SSAP_PAIR_FAILED', err.message);
      state.tvClientKey = result.clientKey || state.tvClientKey;
      if (!state.tvClientKey) return respondError(message, 'NO_CLIENT_KEY', 'TV did not return a client key');
      persist(function (persistErr) {
        if (persistErr) return respondError(message, 'STATE_WRITE_FAILED', persistErr.message);
        message.respond({ returnValue: true, tvPaired: true });
      });
    });
  });
});

service.register('forgetTvPairing', function (message) {
  requireAuthorized(message, function () {
    state.tvClientKey = '';
    persist(function (err) {
      if (err) return respondError(message, 'STATE_WRITE_FAILED', err.message);
      message.respond({ returnValue: true });
    });
  });
});

service.register('getPowerState', function (message) {
  runTvCommand(message, 'ssap://com.webos.service.tvpower/power/getPowerState');
});

service.register('screenOff', function (message) {
  runTvCommand(message, 'ssap://com.webos.service.tvpower/power/turnOffScreen');
});

service.register('screenOn', function (message) {
  runTvCommand(message, 'ssap://com.webos.service.tvpower/power/turnOnScreen');
});

service.register('powerOff', function (message) {
  runTvCommand(message, 'ssap://system/turnOff');
});

console.log('[LampaSleepService] ' + VERSION + ' ready');
