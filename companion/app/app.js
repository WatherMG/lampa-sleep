'use strict';

(function () {
  var SERVICE = 'luna://io.github.wathermg.lampasleep.service';

  function call(method, parameters, callback) {
    callback = callback || function () {};
    if (!window.PalmServiceBridge) {
      callback(new Error('PalmServiceBridge недоступен'));
      return;
    }

    var bridge = new PalmServiceBridge();
    var done = false;
    bridge.onservicecallback = function (text) {
      if (done) return;
      done = true;
      var result;
      try { result = JSON.parse(text); }
      catch (e) { result = { returnValue: false, errorText: text }; }
      try { bridge.cancel(); } catch (e2) {}

      if (!result || result.returnValue === false) {
        callback(new Error(result && (result.errorText || result.errorCode) || 'Service request failed'), result);
      } else {
        callback(null, result);
      }
    };

    bridge.call(SERVICE + '/' + method, JSON.stringify(parameters || {}));
  }

  var codeNode = document.getElementById('code');
  var expiryNode = document.getElementById('expiry');
  var statusNode = document.getElementById('status');

  function setStatus(text) {
    statusNode.textContent = text;
  }

  function refresh() {
    call('status', {}, function (err, result) {
      if (err) {
        setStatus('Ошибка companion service: ' + err.message);
        return;
      }

      setStatus([
        'Companion: ' + result.version,
        'Lampa авторизована: ' + (result.authorized ? 'да' : 'нет'),
        'LG SSAP pairing: ' + (result.tvPaired ? 'есть' : 'нет'),
        'Активный setup-код: ' + (result.setupActive ? 'да' : 'нет')
      ].join('\n'));
    });
  }

  function createCode() {
    codeNode.textContent = '------';
    expiryNode.textContent = 'Создание кода...';

    call('createSetupCode', {}, function (err, result) {
      if (err) {
        expiryNode.textContent = 'Ошибка: ' + err.message;
        return;
      }

      codeNode.textContent = result.code;
      expiryNode.textContent = 'Код действует ' + result.expiresInSeconds + ' секунд.';
      refresh();
    });
  }

  document.getElementById('new-code').addEventListener('click', createCode);
  document.getElementById('refresh').addEventListener('click', refresh);
  document.getElementById('revoke').addEventListener('click', function () {
    call('revokeAuthorization', {}, function (err) {
      if (err) {
        setStatus('Ошибка: ' + err.message);
        return;
      }
      setStatus('Авторизация Lampa отозвана.');
      createCode();
    });
  });

  createCode();
})();
