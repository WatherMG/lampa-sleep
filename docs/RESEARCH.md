# Research notes: safe LG power control

Research date: 2026-09-25.

## 1. Lampa playback control

Current Lampa source exposes `Lampa.Player.listener`, `Lampa.Player.close()`, `Lampa.PlayerVideo.listener`, and `Lampa.PlayerPanel.render()`. The player emits `create`, `start`, `ready`, and `destroy`; PlayerVideo emits `ended`.

This is sufficient for a sleep timer without touching LG system APIs:

- pause/close current playback;
- count completed videos/episodes;
- briefly abort a race where the playlist tries to auto-start the next item.

Source:
- https://github.com/yumata/lampa-source

## 2. Public webOS Luna API boundary

LG documents Luna calls via `webOS.service.request`:
- https://webostv.developer.lge.com/develop/references/luna-service-introduction
- https://webostv.developer.lge.com/develop/references/webostvjs-webos

LG's public webOS TV API list does not document `com.webos.service.tvpower` as a supported application Luna service.

webOS TV 26 Re:New introduces ACG enforcement capability; webOS TV 27 makes ACG declarations mandatory:
- https://webostv.developer.lge.com/develop/guides/acg-guide

Therefore this project deliberately does not call private tvpower Luna methods.

## 3. SSAP

LG TVs expose the paired remote-control protocol over WebSocket, conventionally port 3000 (and secure variants on some generations).

Established open-source clients use:
- `ssap://system/turnOff`
- `ssap://com.webos.service.tvpower/power/getPowerState`
- `ssap://com.webos.service.tvpower/power/turnOffScreen`
- `ssap://com.webos.service.tvpower/power/turnOnScreen`

References:
- https://github.com/hobbyquaker/lgtv2
- https://github.com/merdok/lgtv2
- https://github.com/MysterWolf/lg-remote

The protocol performs a registration handshake using `pairingType: PROMPT`; the TV returns a `client-key` after the user approves the client.

## 4. Manifest decision

Many old clients reproduce LG's historical signed test manifest. Lampa Sleep does **not** copy that signature.

Instead, it sends a minimal unsigned manifest requesting only:
- `CONTROL_POWER`
- `CONTROL_TV_SCREEN`
- `READ_POWER_STATE`

If a firmware refuses this manifest, the plugin reports the incompatibility. It does not escalate to a broader copied manifest automatically.

## 5. Same-TV connection uncertainty

Browser/phone SSAP control is well established, but same-device SSAP (`Lampa → 127.0.0.1:3000 → same TV`) is not documented by LG as a supported web-app architecture.

The implementation therefore:
1. tries loopback only when the user explicitly enables TV control and pairs;
2. allows the user to enter the TV's own RFC1918 LAN IP as a direct fallback;
3. provides no cloud/helper fallback.

The physical LG test determines which direct path is supported on the target firmware.
