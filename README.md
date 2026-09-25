# Lampa Sleep

Safety-first sleep timer and binge-control plugin for **Lampa**, designed first for LG webOS.

Current version: **0.1.2-alpha**.

> Hardware status: timer/player integration is covered by automated tests. LG SSAP commands are based on the paired local-control protocol, but same-TV loopback/LAN operation still requires physical testing on an LG TV before this is called production-ready.

## Installation

After GitHub Pages deployment:

```text
https://wathermg.github.io/lampa-sleep/sleep.js
```

Lampa → Settings → Extensions → Add plugin → paste the URL.

The plugin adds a **Sleep** button to the stock Lampa player panel and a separate **Lampa Sleep** settings section.

The settings page also contains **Диагностика и сопряжение** with TV-side controls for pairing, read-only power-state checks, a reversible 3-second Screen Off/On test, emergency Screen On, and forgetting the local pairing. There is deliberately no one-tap TV Off diagnostic button.

## Sleep modes

From the stock player panel:

- 15 / 30 / 45 / 60 minutes;
- after the current episode/video;
- after 2 episodes;
- after 3 episodes;
- cancel active timer.

The default action can be:

1. **Stop playback** — always available and uses only Lampa's own Player APIs.
2. **Stop + Screen Off** — optional LG SSAP command.
3. **Stop + TV Off** — optional LG SSAP command.

A time-based timer can be **soft**: once the time expires, Lampa waits for the current video to end instead of cutting it in the middle.

## Safety model

Power integration is intentionally disabled by default.

The plugin:

- never uses root;
- never uses SSH;
- never uses private `luna://com.webos.service.tvpower` power calls;
- never copies LG test signatures or a third-party signed SSAP manifest;
- stores the SSAP client key only in this app origin's `window.localStorage`, not in `Lampa.Storage`;
- never prints the client key in diagnostic logs;
- accepts only `localhost`, loopback IPv4 and RFC1918 private IPv4 TV targets;
- requests only `CONTROL_POWER`, `CONTROL_TV_SCREEN`, and `READ_POWER_STATE`;
- stops Lampa playback **before** attempting a power action;
- has no alternative/fallback power mechanism if SSAP fails.

A failed power request therefore degrades to “video stopped; TV unchanged”.

See [SECURITY.md](SECURITY.md) and [docs/RESEARCH.md](docs/RESEARCH.md).

## LG TV pairing

### 1. Use automatic TV address detection

Settings → Lampa Sleep:

- **Разрешить управление TV** → On
- **Адрес LG TV** → `auto`

Then open Lampa DevTools and run:

```js
LampaSleep.pair()
```

`auto` asks the official webOS Connection Manager for the active Wi-Fi/wired private IP and then tries SSAP on that address. Use the **Определить адрес TV** diagnostic button first; no console is required.

### 2. If automatic detection fails

Enter the TV's own private LAN address shown by LG network settings, for example:

```text
192.168.1.42
```

This is still a direct Lampa → same TV connection. No VPS, Home Assistant, root, proxy or helper is involved.

Run `LampaSleep.pair()` again and accept the on-screen prompt.

### 3. Verify without powering off

First run:

```js
LampaSleep.getPowerState((err, state) => console.log(err, state))
```

Then test Screen Off:

```js
LampaSleep.screenOff((err, result) => console.log(err, result))
```

Restore the panel with:

```js
LampaSleep.screenOn((err, result) => console.log(err, result))
```

Only after these tests should `TV Off` be selected as the sleep action.

To invalidate the local pairing:

```js
LampaSleep.forgetPairing()
```

The TV may keep its paired-client record until removed from LG settings; this method only deletes Lampa Sleep's local key.

## Why SSAP instead of Luna power calls?

LG documents `webOS.service.request` and its public Luna APIs, and newer webOS versions add ACG permission enforcement. The public developer API list does not expose the private `com.webos.service.tvpower` power methods as a supported app API.

SSAP is the local paired remote-control protocol used by LG TV remote clients. The commands used here are:

```text
ssap://com.webos.service.tvpower/power/getPowerState
ssap://com.webos.service.tvpower/power/turnOffScreen
ssap://com.webos.service.tvpower/power/turnOnScreen
ssap://system/turnOff
```

The TV itself grants the client key after user confirmation.

Important: LG does not document “a web app running on a TV connects back to its own SSAP socket” as an official application architecture. Therefore compatibility of `127.0.0.1:3000` is treated as a capability to test, not an assumption. Using the TV's own private LAN IP is the fallback that still requires no third-party service.

## Public API

```js
LampaSleep.status()

LampaSleep.armMinutes(30)
LampaSleep.armMinutes(45, { soft: true, action: 'tv_off' })
LampaSleep.armEpisodes(1)
LampaSleep.armEpisodes(3, { action: 'screen_off' })
LampaSleep.cancel()

LampaSleep.pair(callback)
LampaSleep.forgetPairing()

LampaSleep.getPowerState(callback)
LampaSleep.screenOff(callback)
LampaSleep.screenOn(callback)
LampaSleep.powerOff(callback)
```

`status()` reports whether the plugin is paired but deliberately does not expose the SSAP client key.

## Development

Requires Node.js 22+:

```sh
npm run check
npm test
npm run build
```

GitHub Actions runs syntax checks, integration/safety tests and verifies the exact static Pages artifact.

## Physical LG acceptance test

Do this in order:

1. Install the plugin and verify `LampaSleep.version === '0.1.2-alpha'`.
2. Leave **Разрешить управление TV = Off**. Arm a 1-episode sleep action with **Stop playback** and verify the next episode does not start.
3. Test a 15-minute hard/soft timer with a temporary shorter value through DevTools if desired.
4. Enable TV control and try `127.0.0.1`.
5. Run `LampaSleep.pair()`; record whether LG shows a pairing prompt.
6. If loopback fails, set the TV's private LAN IP and retry. Port 3000 uses plain local WebSocket (`ws://`), so use this fallback only on a trusted home LAN; loopback is preferable.
7. Run `getPowerState`.
8. Run `screenOff`, wait several seconds, then restore with the remote or `screenOn`.
9. Only after Screen Off succeeds, test `powerOff`.
10. Restart Lampa and confirm the stored client key reconnects without a new prompt.
11. Verify ordinary movies, torrents, IPTV and next-episode behavior with no active sleep timer.

For a failure, enable diagnostics and capture console lines prefixed with `[LampaSleep]`. Do **not** share local-storage dumps or the SSAP client key.


## SSAP browser-origin limitation

The first hardware test showed that `127.0.0.1:3000` did not produce an LG pairing prompt. SSAP implementations are known to filter WebSocket `Origin` values for browser clients. Some historical projects worked around that by deliberately changing the Origin to `null`/using a `data:` context. **Lampa Sleep does not use that bypass.**

Version 0.1.2-alpha therefore:
- obtains the TV's active LAN IP using LG's documented `com.palm.connectionmanager/getStatus`;
- tries the normal browser WebSocket directly to that private address;
- distinguishes a 5-second socket-open failure from a 30-second pairing-approval timeout;
- reports the exact stage in the on-TV diagnostics UI.

If LG rejects the normal browser Origin even for the TV's own LAN IP, this power-control approach will be treated as unsupported rather than bypassing SSAP origin protections.
