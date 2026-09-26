# nodeterm for Android

The Android companion to nodeterm: pair your phone with nodeterm on your computer, then watch your
agents, answer their questions and open any terminal on the canvas — on your network over SSH, or
from anywhere through the end-to-end encrypted relay. It is the Android counterpart of the iOS app
and speaks the same protocol to the same desktop; nothing on the computer needs to know which phone
it is talking to.

> **Status (2026-09-26): not ready for users.** CI builds the debug APK, and the release blockers
> and medium bugs an audit found are fixed on this branch and tested where the code allows — but the
> app has **not yet been run on a phone**. The plan, the device checklist and what is still open are
> in [`docs/android-handover.md`](../docs/android-handover.md); the findings are in
> [`docs/android-audit-2026-09.md`](../docs/android-audit-2026-09.md). The table below describes what
> the code is written to do, not what has been verified on a device.

## What it does

| | Android | Notes |
|---|---|---|
| Pair by QR (or pasted code, or a `nodeterm://pair` link) | ✓ | E2EE-sealed `/pair`, Ed25519 key made on the phone |
| Direct connection on your network (SSH + tmux) | ✓ | TOFU-pinned host key; the desktop's own tmux socket |
| From anywhere (relay, E2EE, SAS approval) | ✓ | A current desktop approves the phone at the scan (its relay key rides the sealed `/pair` body); an older one shows a code on the first relay connect |
| Late relay adoption (paired while remote access was off) | ✓ | Reads `~/.nodeterm/relay.json` over SSH, mints its own device token |
| Sessions, grouped like the desktop sidebar | ✓ | Needs you / Running / Sleeping, activity + context % |
| Terminal (co-attach to the live tmux session) | ✓ | xterm.js renderer, native input bar, special keys, swipe = tmux scroll, OSC 52 copy |
| Sleeping (Eco) session opened | ✓ | Through the relay the computer wakes it on open. Over SSH the phone offers the desktop's wake line (`--resume <id>` + permission mode), typed only on a tap |
| Cold-start resume offer (the computer rebooted) | relay | Offers the agent's own `--resume <id>`; never types it unasked. Over SSH a session that is not running is never created (it would lack its hook environment): the phone offers to open it through the relay |
| Sessions of the computer's SSH projects | relay | They run on another host; the computer attaches them over its SSH connection. Over direct SSH the phone offers the relay instead |
| New session (agent / shell) → registered on the canvas | relay | `projects.registerNode`, launched before registration so the desktop never double-launches |
| Wake / refresh / rename / end session | relay (end: both) | `node.*` verbs; over SSH "end" stops the tmux session only |
| Kanban board, move cards, labels | relay (read-only on SSH) | `projects.ensureBoard/setCardColumn/editCardLabels` |
| Inbox: approvals, questions, finished turns | ✓ | Held hook approvals are answered deterministically (never with keystrokes); a multi-select question lists its options but is answered in the session; each card shows its node's context % when known |
| Read-ack (reading a finished session clears it on the computer) | ✓ | `inbox.ack` over the relay, `~/.nodeterm/acks` over SSH |
| Usage (rate limits per account) | ✓ | From the agent-status mirror, with a pace line ("5h usage pace faster") when the reset time is known |
| Notifications | local | See "Notifications" below |

## Build

```bash
cd android
./gradlew :app:assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
./gradlew -p protocol test            # the wire layer; see below
```

Needs JDK 17+ and the Android SDK (Android Studio's, or `ANDROID_HOME`). `minSdk` 26, `targetSdk` 35.
CI builds the debug APK on every change under `android/` (`.github/workflows/android.yml`) and
attaches it to the run.

**Debug builds are signed with a public key that is committed on purpose**
(`app/debug.keystore`, password `android`). That is what lets you install a newer CI or local
debug APK over an older one without uninstalling — uninstalling wipes every pairing. The other side
of "public": anyone can sign an APK that installs as an update over a debug build and inherits its
data, including the keys your computers trust. **Install debug APKs only from this repository's CI
or your own build.** Release builds will need their own private key; none exists yet.

## Layout

- **`protocol/`** — everything that goes on the wire, as a plain Kotlin/JVM library with no Android
  dependency, so it is tested on a JVM: NaCl box (a TweetNaCl port), the relay client, the host
  RPC vocabulary, pairing, the direct-SSH transport, and the parsers for what the computer serves.
  Its tests run the **desktop's own code** on the other end of the wire — `connectHostSession` and
  `createPairingService` through a local relay broker (`src/test/interop/host-fixture.ts`, bundled
  with the repo's esbuild), and the SSH transport against a real SSH server and a sandboxed tmux.
  Run `npm ci --ignore-scripts` at the repo root first; without node the interop tests skip.
- **`app/`** — the Compose UI on top: pairing, the computers list, a computer's Sessions / Board /
  Inbox / Usage tabs, the terminal screen, settings, background notifications.

## Notifications

The background check never makes a first relay connection (that would put the approval dialog on
an unattended computer): it uses the relay only for a computer that has already approved this
phone. After Deny, or an approval nobody answered, the app stops re-dialing the relay until you tap
Try again or open that computer.


The iOS app is woken by APNs pushes the nodeterm backend sends. That backend has no Android (FCM)
leg, so this app polls instead: checked about every 15 minutes in the background (WorkManager's
floor), and live for the computer whose screen is open, which the app re-lists every 8 seconds.
Other paired computers are not polled while you look at one, so their notifications still come from
the background check only. Real-time push on Android needs an FCM leg in the backend.

The live check leaves out what you are looking at: nothing of a computer is announced while its
Inbox tab is on screen, and nothing of a session open in a terminal. Those events count as seen, so
no later check announces them either.

Each Inbox event raises at most one notification: only events younger than 6 hours are announced,
and the phone remembers the ones it has announced, you have read or you had on screen for a day
after it last saw them (longer when the computer's clock runs ahead), so nothing still eligible is
forgotten.

A notification names the session, the computer and the kind of event ("Needs you — build-bot",
"Needs approval"), but not the event's own text: the command, file or question, or the agent's last
message. Android shows a notification's full content on a secure lock screen unless you hide
sensitive content there. **Settings → Show details in notifications** (off by default) adds that
text. A lock screen set to hide sensitive content shows only "Needs you — <session>" and the
computer's name either way. The iOS app does receive the detail, in the push the desktop sends.

## Security

- The phone's relay identity (a Curve25519 box key) and SSH identity (an Ed25519 seed) are
  generated on the device and stored encrypted under an Android Keystore AES-GCM key. Only their
  public halves ever leave the phone.
- Relay traffic is end-to-end encrypted (NaCl box under a per-session HKDF key) and checked exactly
  as the desktop checks it: role byte (no reflections), strictly increasing sequence numbers (no
  replays), no re-key once ready, and the host key pinned from pairing.
- The SSH host key is pinned on the first connect that authenticates (a server that refuses the
  phone's key is never pinned). A changed key is never used over SSH; in Auto the phone goes on to
  the relay, which verifies the computer separately, and shows a warning.
- No cleartext HTTP anywhere; the LAN `/pair` POST runs over a raw socket and is sealed to the host
  key from the QR. Its answer is read as untrusted: at most 64 KiB, within 45 seconds.

Design notes, the protocol mapping and known gaps: [`docs/android.md`](../docs/android.md).
