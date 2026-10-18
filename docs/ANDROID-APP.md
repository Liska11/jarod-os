# Jarod on Android

A companion app for the phone: talk to Jarod, prove who you are, approve what Jarod wants to do, and be told when something happens. It is a real Android app (`.apk`) built with Capacitor, and it talks **only to your own PC**: no cloud relay, no account, no message content ever goes through Google.

| Part | Where |
|---|---|
| The app (React + Capacitor 8, Android project) | `mobile/` |
| Native pieces (device key vault, biometrics, wake service) | `mobile/android/app/src/main/java/os/jarod/mobile/` |
| The PC side of the direct channel | `jarod-core/packages/plugins/gateways/src/mobile.ts` (`/m1/*` routes), `remote-host.ts` (direct clients) |
| The encrypted protocol (shared, byte for byte, by both ends) | `jarod-core/packages/plugins/gateways/src/remote-protocol.ts` |
| Pairing code and the list of phones on the PC | Réglages › Appareils (`DevicesSection.tsx`), canals `phone-*` (`bridge/src/main/handlers/phone.ts`) |
| Tests | `gateways/test/mobile-direct.test.ts` (core), `mobile/src/**/*.test.ts` (app) |
| X25519 for WebViews older than Chrome 133 (Android 9) | `mobile/src/lib/x25519-shim.ts` (@noble/curves) |
| A throwaway PC for development | `jarod-core/packages/plugins/gateways/scripts/dev-phone-pc.ts` |

## 1. Architecture

```
 Phone (Capacitor WebView)                                   PC (Jarod-OS)
 ┌──────────────────────────────┐                     ┌────────────────────────────────────┐
 │ React UI: chat, approvals,   │                     │ MobileBridge  (HTTP, port 10492)   │
 │ history, pairing             │  LAN Wi-Fi          │   /m1/open  /m1/up  /m1/down (SSE) │
 │ remote-protocol.ts (same     │ ───────────────────▶│   /m1/wake (content-free)          │
 │ file as the core)            │   or Tailscale      │   source filter: private nets only │
 │ DeviceVault (Keystore key,   │   (WireGuard)       │            │ frames                │
 │ BiometricPrompt)             │                     │            ▼                       │
 │ WakeService (foreground,     │                     │ RemoteHost: handshake, devices,    │
 │ long-poll, no content)       │                     │ RPC, approvals ──▶ agent runtime   │
 └──────────────────────────────┘                     └────────────────────────────────────┘
```

**Why this shape.**

- The core already had a complete, tested end-to-end protocol (`jarod-relay/1`): X25519 static keys for both sides, an ephemeral exchange for forward secrecy, AES-256-GCM frames with strictly increasing counters, pairing proven by an HMAC of a one-time code. It was built for a self-hosted relay. The phone app reuses it **without the relay**: the same frames travel directly to the PC. The relay path is untouched.
- Carrier: plain HTTP on the bridge's port — `POST /m1/open` gives a random channel id, `GET /m1/down` is a Server-Sent Events stream of frames from the PC, `POST /m1/up` sends one frame to the PC. No WebSocket server library is needed in the core, and it works through any network. HTTP itself carries no secret: everything after `open` is ciphertext, authenticated by the handshake.
- Why not TLS: there is no certificate authority for a LAN IP or a Tailscale address, and a self-signed certificate would need the WebView's certificate checks to be overridden in native code — exactly the kind of switch that ends up accepting anything. The pinned host key in the QR code gives the same guarantee (the phone talks to *this* PC) with code that both ends already test.
- The UI is React like the desktop renderer, and the app imports the protocol file from the core directly (`@jarod-protocol` alias in `mobile/vite.config.ts`), so a change to the protocol is a change to both ends. The desktop's own components depend on `window.heraldOS` and the Electron preload; the phone gets small components of its own, with the same tokens (colours, radius) as the desktop's dark theme.
- `mobile/` lives at the repository root, outside the npm workspaces (`apps/*`): it has its own lockfile and toolchain (Gradle, Android SDK), and installing the desktop must not pull Capacitor nor the reverse.

## 2. Network: local Wi-Fi and the tunnel

| Where the phone is | Path | Encryption |
|---|---|---|
| Same Wi-Fi as the PC | `http://192.168.x.y:10492` | Jarod's own end-to-end channel (the Wi-Fi sees only ciphertext) |
| Elsewhere | `http://100.x.y.z:10492` through **Tailscale** | WireGuard (Tailscale) **and** Jarod's channel |

**Tunnel choice: Tailscale** (or its self-hosted server Headscale for no third party at all).

- No port is opened on the router: Tailscale traverses NAT itself; when it cannot, its DERP relays carry WireGuard packets they cannot read.
- Plain WireGuard was rejected for now: one side needs a reachable endpoint, i.e. a port forwarded on the router (forbidden here) or a rented server.
- Jarod-OS already reads Tailscale's state for remote machines (`docs/REMOTE-SSH.md`) and installs nothing; the same rule holds here. The phone uses the official Tailscale app; Jarod's app does not embed a VPN.
- The QR code lists every address the PC can be reached on (LAN and Tailscale `100.64.0.0/10`); the phone tries them in order and keeps the one that answers.

**The bridge refuses any source address that is not private** — loopback, `10/8`, `172.16/12`, `192.168/16`, link-local, Tailscale's `100.64/10`, IPv6 ULA (`fc00::/7`, Tailscale uses `fd7a:115c:a1e0::/48`). A port forwarded on a router by mistake still opens nothing to the Internet. This holds for the old browser page as well.

**The Internet switch.** The bridge never connects out: no relay, no push service. Runs started from the phone go through the same tool gate as the desktop (`executeGuardedTool`), so with the Internet switched off a phone cannot make Jarod reach the Internet, and a remote machine still needs its own switch (`remoteMachines`, `remoteHosts`). Voice messages are transcribed with the speech provider configured on the PC: a cloud provider is refused while the switch is off, a local one keeps working.

## 3. Pairing and authentication

### Pairing (once per phone)

1. On the PC, Réglages › Appareils › Pont téléphone › **Associer** shows a QR code. It now carries an app link:
   `jarod://pair#v=2&h=<hostId>&k=<host X25519 public key>&p=<one-time code, 32 random bytes>&u=<address 1>,<address 2>&n=<PC name>`.
   Everything after `#` is a fragment: never sent anywhere by a browser. The code is valid 10 minutes and works once; the same code also works for the browser page (one door shown, either way in).
2. The phone scans it (camera, decoded in the app with `jsQR`; no Google ML Kit) or the link is pasted.
3. The phone creates its **device key**: an X25519 pair made in the WebView's WebCrypto. The private key is immediately wrapped (AES-256-GCM) by a key that lives in the **Android Keystore**, hardware-backed when the phone has it, usable only after a **fingerprint, face or device PIN** (`BIOMETRIC_STRONG | DEVICE_CREDENTIAL`), and invalidated if a new fingerprint is enrolled. Only the wrapped blob is stored by the app.
4. The phone opens a channel and sends the protocol's `init` with its static key, a fresh ephemeral key, its name, and `HMAC(code, C‖Ec)`. The PC checks the HMAC against the pending codes, spends the one that matches, records the device `{ id = SHA-256(public key)[0..12], name, publicKey, pairedAt }` and answers `accept` with its proof (`HMAC(kConfirm, "host")`). The phone checks it against the host key from the QR code: a machine in the middle cannot answer.
5. The PC shows a notification «Appareil associé».

### Every session afterwards

1. The app opens locked. **Unlock = BiometricPrompt** with the Keystore cipher: the private key is unwrapped in memory, imported as a *non-extractable* WebCrypto key.
2. Handshake without the code: the PC finds the device by the id of its static key. `DH(host, device)` authenticates both sides; nothing else is accepted.
3. Every request afterwards is an AES-GCM frame on that channel: a frame from someone else, a replayed or reordered frame, or a frame for another channel is rejected and the channel is closed.
4. After 5 minutes in the background, or on «Verrouiller», the key is dropped from memory and the channel closed.

### Revoking

- On the PC, Réglages › Appareils lists **every** paired phone (app and browser), with when it was paired and last seen. **Retirer** deletes the device: its open channel is cut at once, its next handshake gets «Appareil inconnu ou révoqué», and the app then wipes its pairing.
- On the phone, «Oublier ce PC» sends `device.leave` and wipes the wrapped key.
- A stolen phone: the key cannot be used without the phone's biometrics or PIN; revoke it from the PC anyway.

## 4. Approvals

- A run started from the phone sends its approval requests to the phone (`approval` event: tool, arguments, description, deadline). The app shows exactly what will run, on which machine.
- **Accepting asks for the biometrics again**, for that decision only. Refusing does not.
- The answer is `approval.resolve { id, ok }`: one decision for one request. The protocol has no «always», «this conversation» or «auto»: anything other than a boolean is ignored. Tools that the core only offers «once / deny» for (`remote_exec`) stay that way.
- No answer within 10 minutes = refused. A channel that drops refuses everything it had pending.
- Not yet: requests from runs started **on the PC** or by scheduled tasks are not mirrored to the phone (see §8).

## 5. Notifications

**No message content goes to Google, ever.** Firebase Cloud Messaging is not used in this version.

| App state | How the phone learns | What it shows |
|---|---|---|
| Open or recently in background (channel open) | `notification`, `approval` and `done` events on the encrypted channel | A local notification with the title (content stays on the phone) |
| Closed | **WakeService**, an Android foreground service, long-polls `GET /m1/wake` with the device's *wake token* | «Jarod a du nouveau» — no content; tapping opens the app, which unlocks and fetches the real items over the channel |

- The wake token is 32 random bytes made by the PC and given to the phone **over the encrypted channel** (`wake.register`); the PC keeps only its SHA-256. It proves nothing but «this phone may ask whether there is news»: the answer is a counter. Revoking the device kills it. It is rotated at each unlock.
- The service stays alive with a permanent notification («Jarod veille»), as Android requires; it can be turned off in the app. It reaches the PC over Wi-Fi or Tailscale like the rest.
- **If FCM is ever added** (for battery): only a content-free *data* message («wake up»), sent by the PC, opt-in, and only when the Internet switch is on — and it needs a Firebase project, which is a third party. A self-hosted UnifiedPush distributor (ntfy on the PC, reached through Tailscale) is the alternative that keeps everything inside.

## 6. Chat

- History: `sessions.list`, `messages.list` (user and assistant turns; tool rows shortened).
- Text: `chat.send`; replies are **streamed** — `stream-start`, `delta`, `message`, `done` events arrive as the model writes.
- Voice: the app records with `MediaRecorder` (Opus, max 2 minutes), sends `chat.voice { audio (base64), mime }`; the PC transcribes it with its configured speech-to-text and posts the text as the user's message. The app shows what was heard.
- Stop: `chat.stop`.

## 7. Threat model

| Threat | What stops it |
|---|---|
| Someone on the same Wi-Fi reads the traffic | End-to-end AES-GCM; HTTP carries only ciphertext and a random channel id |
| A fake «PC» on the network (ARP/DNS spoofing) | The phone pins the host key from the QR code; the host proves `DH(H, C)` |
| A fake phone | Unknown static key → denied; pairing needs the one-time code, spent on first use, 10-minute life |
| Guessing the pairing code | 256 random bits; the browser path also limits failures per address |
| Replaying captured frames | Per-direction keys, counters strictly increasing, fresh ephemeral keys each session |
| Injecting garbage into someone's channel (the channel id is visible on the LAN) | The frame fails authentication: the channel is closed. Denial of service only, and only from the LAN |
| The PC reached from the Internet (port forwarded by mistake, UPnP) | Source filter: non-private addresses get nothing |
| Stolen / lost phone | Device key wrapped by a Keystore key that needs biometrics or PIN; revocation from the PC is immediate |
| Malware on the phone with the app unlocked | Out of scope of the app; mitigated by approval-time biometrics and «once» only approvals |
| A paired phone approving something it did not see | Every request shows tool, arguments and machine; one decision per request; no blanket approval exists |
| Wake channel sniffed on the LAN | It reveals «there is news» timing only; the token is per device, hashed on the PC, rotated, revocable |
| Google learns content | No FCM; no Google service in the app (QR decoded locally) |
| The bridge as a way around the Internet switch | It never connects out; phone runs go through the same tool gate |
| Old browser page (bearer token over plain HTTP on the LAN) | Kept for compatibility, still refuses dangerous tools; the app is the encrypted way. Turning it off is listed in §8 |

## 8. Building and trying it

```bash
cd mobile
npm install
npm test                 # protocol client, pairing link, conversation model (18 tests)
npm run apk:debug        # web build, cap sync, Gradle → android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run apk:debug` needs JDK 21 and the Android SDK (platform 36, build-tools 36). `scripts/gradle.mjs` finds the SDK in `ANDROID_HOME`, `ANDROID_SDK_ROOT` or `%LOCALAPPDATA%\Android\Sdk` and writes the git-ignored `android/local.properties`; nothing global is changed. Install with `adb install -r app-debug.apk`.

**Without a phone**, against a throwaway Jarod (temporary profile, scripted model that streams and asks for one approval when told «approuve»):

```bash
pnpm --dir jarod-core --filter @jarod/plugin-gateways exec tsx scripts/dev-phone-pc.ts
```

then, in another terminal, `JAROD_BRIDGE=http://127.0.0.1:10493 npm --prefix mobile run dev` and paste the printed link at http://localhost:5190. In a desktop browser the device key is not wrapped (no Keystore): the lock screen says so.

**Tailscale**: on the PC and on the phone, sign in to the same tailnet; the PC's `100.x` address then appears in the QR code. The bridge must be on (Réglages › Appareils › Pont téléphone).

## 9. Status

**Done in this version**

- Core: direct channel (`/m1/open|up|down`), private-source filter, app pairing link (virtual adapters and link-local addresses left out), devices listed and revoked from the PC (app and browser), `chat.voice`, `device.leave`, `notifications.list`, `wake.register` + `/m1/wake`, live `notification` events. Unit tests: `gateways/test/mobile-direct.test.ts` (19), `bridge/test/phone.test.ts`.
- Desktop: Réglages › Appareils shows the app's QR code (tab «Appli Jarod», the browser's stays available) and says for each phone whether it is the app or the browser page.
- App: pairing by QR (decoded in the app) or link, `jarod://pair` links opened by the camera, device key wrapped by the Android Keystore with biometric unlock, auto-lock after 5 minutes away, chat with streamed replies, history, voice messages, approvals of phone-started runs (biometric to accept), local notifications while connected, WakeService for the closed app, no cloud backup, `FLAG_SECURE` (no screenshots).
- Verified end to end in a browser against a real local kernel (`dev-phone-pc.ts`): pairing, unlock, streamed reply, approval shown with its arguments and refused.
- Debug APK built with `npm run apk:debug` (minSdk 30, targetSdk 36, ~9.5 MB, no Firebase / Play-services code inside). The extra permissions it lists (`RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, `SCHEDULE_EXACT_ALARM`, `USE_FINGERPRINT`) come from `@capacitor/local-notifications` and `androidx.biometric`.

**Left to do**

0. Real phones: verified on a Galaxy Note 8 (Android 9, WebView 101, X25519 from `x25519-shim.ts`) through `adb reverse` — pairing with the fingerprint, unlock, streamed reply, an approval accepted with the fingerprint, WakeService waking the closed app with a content-free notification. Still to try there: camera scan, voice message, an Android 11+ phone (PIN as well as biometrics), and the LAN / Tailscale path instead of USB.
1. Approvals from runs started on the PC and from scheduled tasks mirrored to the phone (first answer wins, PC or phone), behind an explicit setting — today `backgroundHooks.approve` refuses, and the desktop's approvals stay on the desktop.
2. WakeService hardening: restart after reboot (`BOOT_COMPLETED`), back-off when the PC is unreachable, battery measurements, and the Android 14+ foreground-service type review for Play.
3. A notification setting per kind (finished tasks, reminders, alerts) and a «what's new» list on the phone.
4. Turning the old browser page off by default once the app is installed.
5. Release build: signing key kept outside the repository, `minifyEnabled`, Play-integrity review if ever published.
6. Android 9-10: the device key opens with biometrics only (a per-use Keystore key accepts the PIN from Android 11). WebViews older than Chrome 100 are refused with an explanation (`public/check.js`).
