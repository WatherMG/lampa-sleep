# Security

## Threat model

Lampa Sleep controls playback and, when explicitly enabled, can request Screen Off or TV Off on an LG TV. A bug must not silently broaden that capability to arbitrary devices or private webOS services.

## Controls

- Power integration defaults to **off**.
- Network target validation allows only loopback/RFC1918 IPv4.
- SSAP requires TV-side pairing and a client key.
- The client key is stored locally through `Lampa.Storage` and is never returned by `status()`.
- Debug logging never prints the key.
- The registration manifest is unsigned and asks only for power/screen-state permissions.
- No root, SSH, Homebrew service, private Luna power call, alert/Luna trick, external HTTP proxy or cloud service is used.
- Power failure has no fallback transport.
- Playback is stopped before a power request.
- Automatic-next blocking expires after 3 seconds to avoid blocking a later manual playback.

## What is not yet proven

- Whether LG webOS allows SSAP WebSocket loopback from Lampa to `127.0.0.1:3000`.
- Whether every firmware accepts the intentionally minimal unsigned SSAP manifest.
- Whether an installed Lampa build permits clear-text local `ws://` WebSockets to its own TV/LAN address.
- Exact behavior of Screen Off on every LG panel/firmware.

These are compatibility questions and must be established with a physical-TV acceptance test.

## Reporting

Do not publish:

- SSAP client keys;
- local-storage dumps;
- Wi-Fi credentials;
- public IP addresses;
- unrelated device identifiers.

A private LAN address alone is normally not secret, but redact it if logs will be posted publicly.
