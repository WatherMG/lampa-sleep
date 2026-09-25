# Lampa Sleep

Safety-first sleep timer and binge-control plugin for **Lampa** on LG webOS.

Current version: **0.2.0-alpha**.

> Hardware status: Lampa timer/player behavior and the companion package are covered by automated tests. The companion WSS loopback path still requires validation on the physical LG G6 before power control is considered proven.

## Components

Lampa Sleep now consists of two parts:

1. **Lampa plugin** — timer UI, episode counting and playback stop logic.
2. **Lampa Sleep Companion** — an ordinary sideloaded webOS app + official JavaScript Service used only for local LG power control.

Published files:

```text
https://wathermg.github.io/lampa-sleep/sleep.js
https://wathermg.github.io/lampa-sleep/lampa-sleep-companion.ipk
```

The companion is required only for Screen Off / Screen On / TV Off. Plain playback stop and episode/time timers continue to work without it.

## Why the companion exists

Hardware testing on the LG G6 showed that browser SSAP from Lampa could not open `ws://TV:3000`. Modern LG firmware commonly exposes secure SSAP on port 3001, while a web app cannot safely override certificate handling or WebSocket Origin policy.

Lampa Sleep therefore does **not** use browser SSAP and does **not** apply historical Origin-null/data-URL bypasses.

Instead:

```text
Lampa plugin
    |
    | local Luna IPC
    v
Lampa Sleep webOS JavaScript Service
    |
    | WSS loopback to the same TV only
    v
127.0.0.1:3001 (LG SSAP)
```

The JavaScript Service is an officially supported webOS application component for low-level networking/background work. It is installed in the same IPK as the small setup app.

## Installation

### 1. Lampa plugin

Lampa → Settings → Extensions → Add plugin:

```text
https://wathermg.github.io/lampa-sleep/sleep.js
```

### 2. Companion IPK

Install the companion with the normal LG Developer Mode / webOS CLI workflow. For example from a PC where your TV is already configured for `ares-*`:

```sh
ares-install ./lampa-sleep-companion.ipk -d <your-device-name>
```

No root is required.

### 3. Authorize Lampa

1. Launch **Lampa Sleep Companion** on the TV.
2. It displays a short-lived 6-digit setup code.
3. Open Lampa → Settings → Lampa Sleep.
4. Enter the code in **Код Companion**.
5. Press **Авторизовать companion**.
6. Press **Проверить companion**.

The service stores the actual Luna caller ID (`message.sender`) and accepts subsequent power operations only from that authorized caller.

### 4. Pair companion with LG SSAP

1. Enable **Разрешить управление TV**.
2. Press **Сопрячь TV**.
3. Accept the normal LG pairing prompt if it appears.
4. Press **Проверить состояние TV**.
5. Only after that succeeds, run **Тест Screen Off → On**.

There is deliberately no one-tap TV Off diagnostic button.

## Sleep modes

The stock Lampa player gets a **Sleep** button with:

- 15 / 30 / 45 / 60 minutes;
- after the current episode/video;
- after 2 episodes;
- after 3 episodes;
- cancel active timer.

Actions:

1. **Stop playback** — Lampa APIs only.
2. **Stop + Screen Off** — companion required.
3. **Stop + TV Off** — companion required.

A time timer can be **soft**: after the deadline it waits for the current video/episode to finish.

## Security model

Power control is disabled by default.

The project:

- does not require root, SSH, Homebrew services, a VPS, Home Assistant or another LAN helper;
- does not call private `luna://com.webos.service.tvpower` methods from Lampa;
- does not use browser WebSocket SSAP;
- does not use an Origin-null/data-URL bypass;
- packages an official webOS JavaScript Service in the companion IPK;
- pins its SSAP transport to `127.0.0.1:3001`;
- requests a minimal unsigned SSAP manifest with only power/screen-state capabilities;
- never opens the LG pointer socket and requests no Magic Remote/input permissions;
- keeps the LG SSAP client key inside companion service storage; it is never returned to Lampa;
- authorizes the Lampa caller using a short-lived setup code and the actual Luna `message.sender`;
- stops Lampa playback before a sleep-triggered power command;
- has no cloud or remote-network fallback.

The service disables normal CA validation only for the WSS connection to **127.0.0.1:3001 on the same TV**. It cannot be configured by Lampa to connect to an arbitrary host.

See [SECURITY.md](SECURITY.md) and [docs/RESEARCH.md](docs/RESEARCH.md).

## Public plugin API

```js
LampaSleep.status()

LampaSleep.armMinutes(30)
LampaSleep.armMinutes(45, { soft: true, action: 'tv_off' })
LampaSleep.armEpisodes(1)
LampaSleep.armEpisodes(3, { action: 'screen_off' })
LampaSleep.cancel()

LampaSleep.authorizeCompanion(callback)
LampaSleep.refreshCompanionStatus(callback)
LampaSleep.pair(callback)
LampaSleep.forgetPairing(callback)

LampaSleep.getPowerState(callback)
LampaSleep.screenOff(callback)
LampaSleep.screenOn(callback)
LampaSleep.powerOff(callback)
```

No API returns the LG SSAP client key.

## Development

Node.js 24 is used in CI.

```sh
npm run check
npm test
npm run build

npm install -g @webos-tools/cli@3.2.6
npm run package:companion
npm run verify:companion
```

GitHub Actions verifies JavaScript, integration/safety tests, the static Pages plugin, and the actual generated IPK.

## Physical LG G6 acceptance test

Run in this exact order:

1. Install `sleep.js` and the companion IPK.
2. Confirm the plugin reports version `0.2.0-alpha`.
3. Leave TV control disabled and verify **after current episode → Stop playback** works.
4. Launch **Lampa Sleep Companion**.
5. Enter its 6-digit code in Lampa and press **Авторизовать companion**.
6. Press **Проверить companion**. Record the status shown.
7. Enable TV control.
8. Press **Сопрячь TV** and accept the LG system prompt if shown.
9. Press **Проверить состояние TV**.
10. Run **Тест Screen Off → On**. Keep the physical LG remote nearby; if Screen On fails, use the normal remote.
11. Only after steps 8–10 succeed, select TV Off as a sleep action.
12. Verify ordinary movie/torrent/IPTV playback with no active timer.

If a step fails, report the exact on-screen Lampa Sleep status/error. Do not share the companion state file or any SSAP client key.
