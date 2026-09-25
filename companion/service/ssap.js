'use strict';

var tls = require('tls');
var crypto = require('crypto');

var HOST = '127.0.0.1';
var PORT = 3001;
var MAX_FRAME = 1024 * 1024;
var WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function once(callback) {
  var called = false;
  return function () {
    if (called) return;
    called = true;
    callback.apply(null, arguments);
  };
}

function buildFrame(text, opcode) {
  var payload = Buffer.from(String(text), 'utf8');
  var op = opcode == null ? 1 : opcode;
  var mask = crypto.randomBytes(4);
  var headerLength = payload.length < 126 ? 2 : (payload.length <= 0xffff ? 4 : 10);
  var frame = Buffer.alloc(headerLength + 4 + payload.length);
  var offset = 0;

  frame[offset++] = 0x80 | (op & 0x0f);
  if (payload.length < 126) {
    frame[offset++] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    frame[offset++] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, offset);
    offset += 2;
  } else {
    frame[offset++] = 0x80 | 127;
    frame.writeUInt32BE(0, offset);
    frame.writeUInt32BE(payload.length, offset + 4);
    offset += 8;
  }

  mask.copy(frame, offset);
  offset += 4;
  for (var i = 0; i < payload.length; i++) {
    frame[offset + i] = payload[i] ^ mask[i % 4];
  }
  return frame;
}

function FrameParser(onFrame, onError) {
  this.buffer = Buffer.alloc(0);
  this.onFrame = onFrame;
  this.onError = onError;
}

FrameParser.prototype.push = function (data) {
  this.buffer = Buffer.concat([this.buffer, data]);

  while (this.buffer.length >= 2) {
    var first = this.buffer[0];
    var second = this.buffer[1];
    var fin = !!(first & 0x80);
    var opcode = first & 0x0f;
    var masked = !!(second & 0x80);
    var length = second & 0x7f;
    var offset = 2;

    if (!fin) {
      this.onError(new Error('Fragmented WebSocket frames are not supported'));
      return;
    }

    if (length === 126) {
      if (this.buffer.length < offset + 2) return;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return;
      var high = this.buffer.readUInt32BE(offset);
      var low = this.buffer.readUInt32BE(offset + 4);
      if (high !== 0) {
        this.onError(new Error('WebSocket frame is too large'));
        return;
      }
      length = low;
      offset += 8;
    }

    if (length > MAX_FRAME) {
      this.onError(new Error('WebSocket frame exceeds safety limit'));
      return;
    }

    var mask;
    if (masked) {
      if (this.buffer.length < offset + 4) return;
      mask = this.buffer.slice(offset, offset + 4);
      offset += 4;
    }

    if (this.buffer.length < offset + length) return;

    var payload = Buffer.from(this.buffer.slice(offset, offset + length));
    this.buffer = this.buffer.slice(offset + length);

    if (masked) {
      for (var i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    this.onFrame(opcode, payload);
  }
};

function SocketClient(options) {
  this.options = options || {};
  this.socket = null;
  this.parser = null;
  this.handshakeBuffer = Buffer.alloc(0);
  this.opened = false;
  this.closed = false;
  this.timer = null;
  this.onJson = null;
  this.onClose = null;
}

SocketClient.prototype.close = function () {
  if (this.closed) return;
  this.closed = true;
  if (this.timer) clearTimeout(this.timer);
  this.timer = null;
  if (this.socket) {
    try {
      if (this.opened) this.socket.write(buildFrame('', 8));
    } catch (e) {}
    try { this.socket.end(); } catch (e2) {}
    try { this.socket.destroy(); } catch (e3) {}
  }
};

SocketClient.prototype.sendJson = function (value) {
  if (!this.opened || !this.socket) throw new Error('SSAP socket is not open');
  this.socket.write(buildFrame(JSON.stringify(value), 1));
};

SocketClient.prototype.connect = function (callback) {
  var self = this;
  var finish = once(callback);
  var key = crypto.randomBytes(16).toString('base64');
  var expectedAccept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

  self.timer = setTimeout(function () {
    self.close();
    finish(new Error('WSS loopback connection timeout'));
  }, 5000);

  try {
    self.socket = tls.connect({
      host: HOST,
      port: PORT,
      rejectUnauthorized: false
    });
  } catch (e) {
    self.close();
    finish(e);
    return;
  }

  self.socket.once('secureConnect', function () {
    var request = [
      'GET / HTTP/1.1',
      'Host: ' + HOST + ':' + PORT,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key,
      'Sec-WebSocket-Version: 13',
      '',
      ''
    ].join('\r\n');
    self.socket.write(request);
  });

  self.socket.on('error', function (err) {
    if (!self.opened) finish(new Error('WSS loopback failed: ' + err.message));
    if (self.onClose) self.onClose(err);
  });

  self.socket.on('close', function () {
    if (!self.closed && self.onClose) self.onClose(new Error('WSS loopback closed'));
    self.closed = true;
  });

  self.socket.on('data', function (data) {
    if (!self.opened) {
      self.handshakeBuffer = Buffer.concat([self.handshakeBuffer, data]);
      var marker = self.handshakeBuffer.indexOf('\r\n\r\n');
      if (marker < 0) {
        if (self.handshakeBuffer.length > 16384) {
          self.close();
          finish(new Error('WSS handshake header too large'));
        }
        return;
      }

      var header = self.handshakeBuffer.slice(0, marker + 4).toString('utf8');
      var rest = self.handshakeBuffer.slice(marker + 4);
      self.handshakeBuffer = Buffer.alloc(0);

      if (!/^HTTP\/1\.[01] 101\b/m.test(header)) {
        self.close();
        finish(new Error('WSS upgrade rejected'));
        return;
      }

      var acceptMatch = /\r\nSec-WebSocket-Accept:\s*([^\r\n]+)/i.exec(header);
      if (!acceptMatch || acceptMatch[1].trim() !== expectedAccept) {
        self.close();
        finish(new Error('Invalid WSS server handshake'));
        return;
      }

      if (self.timer) clearTimeout(self.timer);
      self.timer = null;
      self.opened = true;
      self.parser = new FrameParser(function (opcode, payload) {
        if (opcode === 1) {
          var value;
          try { value = JSON.parse(payload.toString('utf8')); }
          catch (e) { return; }
          if (self.onJson) self.onJson(value);
        } else if (opcode === 8) {
          self.close();
          if (self.onClose) self.onClose(new Error('SSAP closed connection'));
        } else if (opcode === 9) {
          try { self.socket.write(buildFrame(payload.toString('utf8'), 10)); } catch (e2) {}
        }
      }, function (err) {
        self.close();
        if (self.onClose) self.onClose(err);
      });

      finish(null);
      if (rest.length) self.parser.push(rest);
      return;
    }

    if (self.parser) self.parser.push(data);
  });
};

function registrationPayload(clientKey) {
  var payload = {
    forcePairing: false,
    pairingType: 'PROMPT',
    manifest: {
      manifestVersion: 1,
      appVersion: '0.2.0',
      appId: 'io.github.wathermg.lampasleep',
      appName: 'Lampa Sleep',
      localizedAppNames: { '': 'Lampa Sleep' },
      permissions: ['CONTROL_POWER', 'CONTROL_TV_SCREEN', 'READ_POWER_STATE']
    }
  };
  if (clientKey) payload['client-key'] = clientKey;
  return payload;
}

function run(options, callback) {
  options = options || {};
  callback = once(callback || function () {});
  var client = new SocketClient();
  var phase = 'connect';
  var registeredKey = options.clientKey || '';
  var timer;

  function fail(err) {
    if (timer) clearTimeout(timer);
    client.close();
    callback(err);
  }

  function arm(ms, message) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { fail(new Error(message)); }, ms);
  }

  client.onClose = function (err) {
    if (phase !== 'done') fail(err);
  };

  client.onJson = function (msg) {
    if (!msg || typeof msg !== 'object') return;

    if (phase === 'hello') {
      if (msg.type !== 'hello') return;
      phase = 'system';
      arm(5000, 'SSAP pre-registration system info timeout');
      client.sendJson({
        id: 'get_sys_info',
        type: 'request',
        uri: 'ssap://system/getSystemInfo',
        payload: {}
      });
      return;
    }

    if (phase === 'system') {
      if (msg.id !== 'get_sys_info') return;
      phase = 'register';
      arm(options.pairTimeout || 30000, 'SSAP pairing timeout');
      client.sendJson({
        type: 'register',
        id: 'register_0',
        payload: registrationPayload(options.clientKey)
      });
      return;
    }

    if (phase === 'register') {
      if (msg.type === 'response' && msg.payload && msg.payload.pairingType === 'PROMPT') {
        if (options.onStage) options.onStage('waiting_approval');
        return;
      }
      if (msg.type === 'error') {
        fail(new Error(msg.error || 'SSAP registration rejected'));
        return;
      }
      if (msg.type !== 'registered') return;

      registeredKey = msg.payload && msg.payload['client-key'] || registeredKey;
      if (!registeredKey) {
        fail(new Error('TV did not return an SSAP client key'));
        return;
      }

      if (options.pairOnly) {
        phase = 'done';
        if (timer) clearTimeout(timer);
        client.close();
        callback(null, { clientKey: registeredKey });
        return;
      }

      if (!options.uri) {
        fail(new Error('Missing SSAP request URI'));
        return;
      }

      phase = 'request';
      arm(options.requestTimeout || 8000, 'SSAP request timeout');
      client.sendJson({
        id: 'command_1',
        type: 'request',
        uri: options.uri,
        payload: options.payload || {}
      });
      return;
    }

    if (phase === 'request' && msg.id === 'command_1') {
      if (msg.type === 'error') {
        fail(new Error(msg.error || 'SSAP request failed'));
        return;
      }
      phase = 'done';
      if (timer) clearTimeout(timer);
      client.close();
      callback(null, {
        clientKey: registeredKey,
        payload: msg.payload || {}
      });
    }
  };

  client.connect(function (err) {
    if (err) {
      fail(err);
      return;
    }
    phase = 'hello';
    arm(5000, 'SSAP hello timeout');
    if (options.onStage) options.onStage('wss_open');
    client.sendJson({ id: 'hello', type: 'hello', payload: {} });
  });
}

function probe(callback) {
  var client = new SocketClient();
  var timer = setTimeout(function () {
    client.close();
    callback(new Error('SSAP hello timeout'));
  }, 5000);

  client.onJson = function (msg) {
    if (msg && msg.type === 'hello') {
      clearTimeout(timer);
      client.close();
      callback(null, msg.payload || {});
    }
  };

  client.connect(function (err) {
    if (err) {
      clearTimeout(timer);
      callback(err);
      return;
    }
    client.sendJson({ id: 'hello', type: 'hello', payload: {} });
  });
}

module.exports = {
  HOST: HOST,
  PORT: PORT,
  buildFrame: buildFrame,
  FrameParser: FrameParser,
  registrationPayload: registrationPayload,
  run: run,
  probe: probe
};
