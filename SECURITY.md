# Security

## Current architecture

Power integration is disabled by default. Playback-only timers use Lampa APIs and do not require TV-control access.

Optional TV power control uses a separately installed **Lampa Sleep Companion** package:

- Lampa plugin -> local Luna IPC;
- companion webOS JavaScript Service -> secure SSAP loopback on port 3001;
- no root, SSH, cloud backend or external helper.

## Boundaries

- The Lampa plugin no longer opens SSAP WebSockets itself.
- The companion SSAP target is fixed to the same TV loopback address.
- The service does not implement pointer, keyboard or ordinary remote-control input.
- The LG pairing credential remains in companion service state and is not returned to the Lampa plugin.
- Companion authorization is tied to the actual Luna caller identifier after the user enters the short-lived setup code.
- Power operations are accepted only after explicit authorization.
- Lampa playback is stopped before a timer-triggered power request.
- There is no private TV-power Luna fallback and no browser Origin workaround.
- TV Off is deliberately absent from the diagnostics buttons; reversible checks come first.

## TLS

LG secure SSAP uses a certificate that is not generally trusted by a normal Node CA store. The companion disables normal CA verification only for its fixed connection to the same TV at loopback port 3001. The plugin cannot supply another host.

## Hardware validation still required

Automated tests cannot prove firmware-specific behavior. Validate on the physical TV in this order:

1. install companion;
2. authorize Lampa;
3. pair with LG;
4. read power state;
5. Screen Off -> Screen On;
6. TV Off only after the reversible test succeeds.

## Sensitive data

Do not publish companion service state, LG pairing credentials, Wi-Fi credentials, or unrelated device identifiers. For normal debugging, share the on-screen Lampa Sleep error/status only.
