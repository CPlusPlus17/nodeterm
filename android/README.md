# nodeterm for Android

The Android companion to nodeterm: pair your phone with nodeterm on your computer, then watch your
agents, answer their questions and open any terminal on the canvas — on your network over SSH, or
from anywhere through the end-to-end encrypted relay. It is the Android counterpart of the iOS app
and speaks the same protocol to the same desktop; nothing on the computer needs to know which phone
it is talking to.

> **Status (2026-10-02): private beta preparation; device verification pending.** CI builds the debug APK, and the release blockers
> and medium bugs an audit found are fixed on this branch and tested where the code allows — but the
> app has **not yet been run on a phone**. The plan and what is still open are in
> [`docs/android-handover.md`](../docs/android-handover.md); the findings are in
> [`docs/android-audit-2026-09.md`](../docs/android-audit-2026-09.md).

## What it does

The APK is built by CI, but **no row below has been checked on a device yet**: ✓ means the code is
written for it and tested where the layer allows, and the numbered
[device checklist](../docs/android.md#device-checklist) is what will check it.

| | Android | Notes |
|---|---|---|
| Pair by QR (or pasted code, or a `nodeterm://pair` link) | ✓ | E2EE-sealed `/pair`, Ed25519 key made on the phone |
| Add a computer by its SSH address ("Add SSH server") | ✓ | For a computer with no pairing code: a headless Server Edition, or a macOS / Linux host you reach only over SSH. Shows the phone's key line (copy, share, or a one-line command) to add to `~/.ssh/authorized_keys`; Connect pins the SSH host key once the computer accepts that key, and shows the fingerprint to compare. **SSH only**: no relay (so no new session, board writes, node actions or source control from the phone, and nothing "from anywhere" beyond what reaches its SSH, a VPN say) and no push. No password login, no Windows |
| Direct connection on your network (SSH + tmux) | ✓ | Host key checked against the keys the computer names at pairing, then pinned (trust on first use with a desktop that names none); the tmux socket of the nodeterm on the computer, and the one a desktop that drives the computer over SSH uses (its sessions, project files and status slices are read there too). Finds a Server Edition's data dir |
| From anywhere (relay, E2EE, SAS approval) | ✓ | A current desktop approves the phone at the scan (its relay key rides the sealed `/pair` body), also when remote access is turned on only after pairing; an older one shows a code on the first relay connect |
| Late relay adoption (paired while remote access was off) | ✓ | Reads `~/.nodeterm/relay.json` over SSH, mints its own device token |
| Sessions, grouped like the desktop sidebar | ✓ | Needs you / Running / Sleeping, activity + context % |
| Terminal (co-attach to the live tmux session) | ✓ | xterm.js renderer, native input bar, special keys, swipe = tmux scroll. Tap a link (also one wrapped over several rows, or an OSC 8 link): the phone names its host and opens it only when you confirm, and only an http(s) one. The Copy chip opens a sheet of the screen's lines and links to select and copy or share. A copy the pane sends itself (OSC 52, e.g. vim's `"+y`) reaches the clipboard too, but tmux's copy-mode is out of easy reach on a touch screen |
| Dictation into the input bar | ✓ | A mic beside Send: Android's speech recognizer, in the phone's language, writes into the draft and never sends it. The microphone permission is asked on the first tap; no mic shows on a phone without a recognizer. Not the on-device Whisper of iOS and the desktop (see [Known gaps](../docs/android.md#known-gaps)); the keyboard's own voice typing works too |
| Sleeping (Eco) session opened | ✓ | Through the relay the computer wakes it on open. Over SSH the phone offers the desktop's wake line (`--resume <id>`, + permission mode for Claude only), while a shell owns the pane, typed only on a tap |
| Cold-start resume offer (the computer rebooted) | relay | Offers the agent's own `--resume <id>`; never types it unasked. Over SSH a session that is not running is never created (it would lack its hook environment): the phone offers to open it through the relay when it is the computer's own; a session another computer's nodeterm runs there, or one no listing names, is not offered the relay |
| Sessions of the computer's SSH projects | relay | They run on another host; the computer attaches them over its SSH connection. Over direct SSH the phone offers the relay instead |
| New session (agent / shell) → registered on the canvas | relay | `projects.registerNode`, launched before registration so the desktop never double-launches. On your network the phone opens the relay leg next to SSH for it; with no relay leg (remote access off) the button is disabled and says why |
| Wake / refresh / rename / end session | relay (end: both) | `node.*` verbs, through the relay leg next to SSH when on your network; over SSH "end" stops the tmux session only |
| Kanban board, move cards, labels | relay (reads: both) | `projects.ensureBoard/setCardColumn/editCardLabels`; on your network the writes go through the relay leg next to SSH, and are disabled with the reason when there is none |
| Source control: status, diffs, stage/unstage, commit, push/pull, recent commits | relay | The desktop's typed `git.*` bridge on the project's folder (no free-form git). On your network it goes through the relay leg next to SSH; not for the computer's SSH projects or a project with no folder, which say why. Merge conflicts are listed and their diff shown; resolve them on the computer or in a terminal |
| Inbox: approvals, questions, finished turns | ✓ | Held hook approvals are answered deterministically (never with keystrokes); a multi-select question lists its options but is answered in the session; each card shows its node's context % when known |
| Read-ack (reading a finished session clears it on the computer) | ✓ | `inbox.ack` over the relay, `~/.nodeterm/acks` over SSH |
| Usage (rate limits per account) | ✓ | From the agent-status mirror, with a pace line ("5h usage pace faster") when the reset time is known |
| All computers: every paired computer's Inbox and Usage on one screen | ✓ | With two or more computers paired: cards newest first across computers, each naming its computer and answered on it; one Usage section per computer that reports usage. Each computer's row shows how many of its approvals and questions are open, from its last listing (the list dials nothing) |
| Notifications | local | See "Notifications" below |

## Before using it away from your computer

The device pass is still outstanding. The latest local fixes (`A78`–`A82`) have not
been pushed or built by CI; a previous CI APK does not include them.

1. Prepare and install the [private beta](#private-beta) below from a successful run of the current
   branch. The desktop must also include the host-side fixes you want to test. Future private beta
   updates use the same private signer and a higher version code, preserving pairings.
2. At the computer, turn on remote access in Settings → Phone, pair, and open the computer in the
   app. If either screen asks for a first relay approval, compare and approve its code there.
3. Turn the phone's Wi-Fi off. Open a terminal over mobile data, send a harmless command, answer a
   question and a held approval, then reconnect after briefly enabling airplane mode. Confirm the
   answers on the computer. This also checks the live relay join contract, still unverified here.
4. Keep the computer awake, nodeterm running, remote access on, and the intended project/session
   mounted and awake. Offscreen Sleeping sessions remain a known relay gap. Background
   notifications use Android's periodic worker and may take longer than 15 minutes; there is no FCM.
5. Record these results, then finish the [64-item device checklist](../docs/android.md#device-checklist).
   A successful build alone does not verify pairing, input or connectivity on the phone.

## Build

```bash
cd android
./gradlew :app:assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
./gradlew -p protocol test            # the wire layer; see below
```

Needs JDK 17–24 and the Android SDK (Android Studio's, or `ANDROID_HOME`). `minSdk` 26, `targetSdk` 35.
Android Studio's bundled JDK works, and CI uses 17. JDK 25 does not: the wrapper's Gradle 8.14.3 cannot
run on it (its embedded Kotlin compiler rejects the version while compiling the build scripts, so
`./gradlew` stops before configuring anything); that needs Gradle 9.1 or newer. Point `JAVA_HOME` at a
17–24 JDK if your default is 25.
CI builds the debug APK on every change under `android/` or to the desktop code the protocol tests
run (`.github/workflows/android.yml`; its path filter says which) and attaches it to the run. The
debug APK is not minified. Only the release build type runs R8 (`app/proguard-rules.pro`), and CI
builds it too, attaching unsigned build inputs
(`./gradlew :app:assembleRelease`, then `tools/check-r8-output.sh`). A missing `-dontwarn` therefore
fails CI rather than a first release (R8 reports the missing class), and so does one of the keeps the
script checks when it stops matching (the WebView bridge, the worker, BouncyCastle's provider tables,
one exception name). A keep that NEW reflection needs is not detected, because R8 renames or drops
such code without a word; add the keep and a line in `tools/check-r8-output.sh`. None of this proves
a minified APK works on a phone; none has been run on one.

## Private beta

This path prepares an APK for your own phone. The private signing key and signed APK stay on your
machine. The tool and CI changes described here are local and unpushed; no nodeterm release APK has
been signed or installed in this session. Actions artifacts on a public repository are downloadable
by other signed-in users, so they contain only unsigned build inputs and checks.

1. After the required checks, push `claude/android-ios-parity-75kfem`: pushes to this exact branch
   prepare unsigned beta inputs with version code `2`, name `0.1.0-beta.1`. Increase the workflow's
   `NODETERM_BETA_VERSION_CODE/NAME` for later branch betas. Once the workflow exists on the default
   branch, manual **prepare_beta** runs can select a branch and override those versions; GitHub
   [requires that default-branch workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
   for manual dispatch. Each later update needs a higher code. Wait for **Protocol**,
   **App release (R8, unsigned)** and **Private beta checks** to succeed.
2. Download `nodeterm-android-release-unsigned`, `r8-release-outputs`, and
   `nodeterm-android-beta-build-inputs` from that same run. Extract them into separate directories.
   Check out the exact `sourceRevision` in `beta-build-inputs.json`, and match its version fields.
   The unsigned APK cannot be installed.
3. Use a private Android signing keystore you keep outside version control, preferably outside the
   checkout. This first-beta session has prepared one in the original workspace's already ignored
   `.nodeterm/android-beta-signing/`: alias `nodeterm-beta`, certificate pin in
   `signing-identity.json`, and separate password files. Keep that entire directory backed up
   privately; it is not included in the source bundle or patch. If starting on another machine
   without an existing private signer, create one with JDK `keytool -genkeypair` and retain it for
   all later updates.
   Record the certificate's SHA-256 fingerprint using `keytool -list -v`; this public fingerprint
   is the expected signer pin. The committed `app/debug.keystore` is public and the packager rejects
   it. Keep the keystore and passwords backed up privately; changing the signer prevents updates.
4. Put each password in a separate local file with permissions `0600`, containing one password line.
   On Linux or macOS with Python 3.11+, a JDK, and Android build-tools 36.0.0, run the following from
   the checked-out repository. Replace the local paths and fingerprint with yours; take the versions
   and revision from the downloaded input metadata.

   ```sh
   python3 android/tools/package-beta.py \
     --apk /path/to/unsigned/app-release-unsigned.apk \
     --r8-dir /path/to/r8-release-outputs \
     --build-inputs /path/to/beta-build-inputs.json \
     --keystore /private/path/android-beta.p12 --key-alias nodeterm-beta \
     --store-password-file /private/path/store-password \
     --key-password-file /private/path/key-password \
     --expected-signer-sha256 YOUR_CERTIFICATE_SHA256 \
     --version-code 2 --version-name 0.1.0-beta.1 \
     --source-revision FULL_COMMIT_SHA_FROM_BETA_BUILD_INPUTS \
     --build-tools-dir "$ANDROID_HOME/build-tools/36.0.0" \
     --output-dir /private/path/nodeterm-beta-1
   ```

   The output directory must be new or empty. The tool matches the APK and R8 checksums to the input
   metadata from that CI run, and checks the package, versions, SDK levels,
   `debuggable=false`, R8 runtime keeps, alignment and the APK signature. Only after those checks
   pass does it produce the APK, its `.sha256`, and `beta-metadata.json` with the signer and source
   revision. This verifies packaging; it does not prove the app works on a phone.
5. Verify the checksum in the output directory (`sha256sum -c *.sha256` on Linux, or
   `shasum -a 256 -c *.sha256` on macOS). Sideload that APK onto your phone, then run the mobile-data
   preflight above and the [device checklist](../docs/android.md#device-checklist), including item 5
   on this minified build.

If the public debug build is already installed, Android will reject the private signer as an update
to it. Moving to the private beta requires a deliberate one-time uninstall through Android
settings; uninstalling deletes every pairing and the phone's identity. Revoke the stale
phone entries on the computers and pair again. The packager never uninstalls or installs anything.
Clearing storage alone does not change an installed APK's signing certificate; uninstall the debug
APK before installing the private one.

Every CI job that runs `./gradlew` first checks `gradle/wrapper/gradle-wrapper.jar` against Gradle's
published checksums (`gradle/actions/setup-gradle`, which also caches `~/.gradle`). Dependabot opens
weekly Gradle update PRs for `android/`, the protocol build and the wrapper included (not for
`tools/typecheck`, whose pins follow the app's by hand). The protocol's network and crypto libraries
(okhttp, sshj, eddsa, BouncyCastle) come in a PR of their own, so an androidx bump the app cannot take
yet (one that demands a higher `compileSdk`, say) does not hold them back. CodeQL analyses the app's
and the protocol module's Kotlin (`.github/workflows/android.yml`, job `CodeQL (Kotlin)`) whenever
that workflow runs: on a branch push or a pull request that changes an Android-relevant file, on
`main` when such a change lands, and by hand (workflow_dispatch). A pull request that changes none is
compared with `main`'s analysis. There is no weekly re-scan of unchanged Kotlin, and the job is not a
required check. `GradleCiCoverageTest` pins all of this. The wrapper properties carry no
`distributionSha256Sum` yet, so the Gradle distribution itself is not pinned.

**Debug builds are signed with a public key that is committed on purpose**
(`app/debug.keystore`, password `android`). That is what lets you install a newer CI or local
debug APK over an older one without uninstalling — uninstalling wipes every pairing. The other side
of "public": anyone can sign an APK that installs as an update over a debug build and inherits its
data, including the keys your computers trust. **Install debug APKs only from this repository's CI
or your own build.** Private release builds use their own retained signer; this first-beta session
has prepared it in ignored local state, with actual APK delivery still pending. Debug builds
are also debuggable, which hands the phone's pairing credentials to anyone with adb access to it
(see [Security](#security)).

## Layout

- **`protocol/`** — everything that goes on the wire, as a plain Kotlin/JVM library with no Android
  dependency, so it is tested on a JVM: NaCl box (a TweetNaCl port), the relay client, the host
  RPC vocabulary, pairing, the direct-SSH transport, and the parsers for what the computer serves.
  Its tests run the **desktop's own code** on the other end of the wire — `connectHostSession` and
  `createPairingService` through a local relay broker (`src/test/interop/host-fixture.ts`, bundled
  with the repo's esbuild and type-checked by the repo's `npm run typecheck` against the desktop
  interfaces it implements), and the SSH transport against a real SSH server and a sandboxed tmux.
  They need node and the repo's `node_modules` (esbuild, ws, tweetnacl) and skip without them; a
  desktop checkout's existing `npm install` is enough. `npm ci --ignore-scripts`, which CI runs, is only
  for a machine without the native toolchain: `npm ci` deletes `node_modules` first and the flag skips
  the node-pty patch and build, so over a working desktop checkout it leaves node-pty unpatched (on
  Linux, where node-pty ships no prebuild, not built at all) and `src/main/node-pty-patch.test.ts` red
  until you run `npm install` or `npm run rebuild` again (`bootstrap-windows.bat` on Windows). The
  SSH tests need tmux and `script(1)` (util-linux on Linux, BSD on macOS) and skip without them.
- **`app/`** — the Compose UI on top: pairing, adding a computer by its SSH address, the computers
  list (each with its needs-you count),
  a computer's Sessions / Board / Inbox / Usage tabs, the All computers screen (every computer's
  Inbox and Usage), the terminal screen (with dictation into its input bar), a project's source
  control, settings, background notifications.

## Notifications

The background check never makes a first relay connection (that would put the approval dialog on
an unattended computer): it uses the relay only for a computer that has already approved this
phone. After Deny, or an approval nobody answered, the app stops re-dialing the relay until you tap
Try again or open that computer.


The iOS app is woken by APNs pushes the nodeterm backend sends. That backend has no Android (FCM)
leg, so this app polls instead: checked about every 15 minutes in the background (WorkManager's
floor), and live for the computer whose screen is open, which the app re-lists every 8 seconds.
Other paired computers are not polled while you look at one, so their notifications still come from
the background check only. That includes a computer you just left: the app may still hold its
connection for a while, but no longer re-lists it when it pushes a change. The All computers screen
is not polled either: it re-lists every computer once when you open it, and again on Refresh.
Real-time push on Android needs an FCM leg in the backend. A computer added by its SSH address is
polled the same way, over SSH: the push a Server Edition gives an iOS phone is APNs-only.

The live check leaves out what you are looking at: nothing of a computer is announced while its
Inbox tab (or the All computers Inbox) is on screen, and nothing a session's terminal shows while it
is attached. Those events count as seen, so no later check announces them either. An approval the
computer is holding for an answer (a hook-reply approval) is still announced with its terminal open,
because Claude paints that prompt only once the hold ends. A terminal that shows an error, a relay
offer or an approval code instead of the session hides nothing, and one still connecting leaves the
session's events for the next check.

Tapping a notification opens that session's terminal; Back from it lands on the computer's Inbox. An
approval's notification carries **Approve** and **Deny**, and a question's carries its options when it
has at most three ("Option 1", "Option 2", …, or their text with **Show details in notifications**
on), wherever the Inbox card could answer it in one tap: a held approval (any agent's) or a Claude
prompt, a single-select question. Anything else carries **Open**. An answer needs an unlocked phone
(Android 12 and later ask for the unlock; on older versions the notification says to unlock first).
It goes over your network or through a relay that has already approved this phone, never through a
first relay connection, for the same reason as the background check. The phone cannot tell in
advance whether it is on the computer's network, so a computer paired with an SSH key always gets
the answers: tapped away from that network, the answer goes through the relay if it has approved
this phone, and otherwise is not sent ("couldn't reach"). The notification then says how it went
("Approved.", "Already handled.", or why nothing was sent, with a tap that opens the session). An
answer is sent at most once: if Android interrupts it and runs it again, the second run sends nothing
and the notification says the answer could not be confirmed. A notification left in the shade after
its request was settled and dropped from the computer's list (after 6 hours, or 50 later events)
types nothing into whatever prompt the session shows by then: it says to answer in the session.

Each Inbox event raises at most one notification: only events younger than 6 hours are announced,
and the phone remembers, for each computer, the ones it has announced, you have read or you had on
screen for a day after it last saw them (longer when the computer's clock runs ahead), so nothing
still eligible is forgotten. Forgetting a computer forgets that too; pairing it again keeps it.

A notification names the session, the computer and the kind of event ("Needs you — build-bot",
"Needs approval"), but not the event's own text: the command, file or question, or the agent's last
message. Android shows a notification's full content on a secure lock screen unless you hide
sensitive content there. **Settings → Show details in notifications** (off by default) adds that
text. A lock screen set to hide sensitive content shows only the title ("Needs you — <session>", or
"Completed — <session>" for a finished or interrupted turn) and the computer's name either way. The
iOS app does receive the detail, in the push the desktop sends.

## Security

- The phone's relay identity (a Curve25519 box key) and SSH identity (an Ed25519 seed) are
  generated on the device and stored encrypted under an Android Keystore AES-GCM key. Only their
  public halves are ever sent anywhere; the next point is how the private halves can still be taken.
- **The debug APK is debuggable.** AGP marks every debug build
  `android:debuggable`, so anyone with adb access to your unlocked phone while USB debugging is on
  (from a computer the phone has authorized, or by accepting the prompt on it) can read the app's
  files with `adb shell run-as dev.nodeterm.android` and attach a debugger to the running app. The
  Keystore never hands out the key those files are sealed under, but it lets any code running as the
  app use it, so that is enough to pull the phone's pairing credentials: the SSH private key your computers
  accept, the relay box secret and the relay device token. A signed, non-debuggable release build
  has a local [private-beta packaging path](#private-beta), but no signed nodeterm release has been
  built or device-tested in this session. Keep USB and wireless debugging off when not using them.
- **If someone else may have had adb access, pairing again is not enough.** The phone keeps its SSH
  key, its relay box key and its relay device id through a re-pair, so each computer would trust the
  same keys again. Give the phone a new identity before it pairs:
  1. Revoke every entry for this phone on each computer (nodeterm → Settings → Phone → Revoke).
  2. Uninstall the app, or clear its storage (Android Settings → Apps → nodeterm → Storage → Clear
     storage; the names vary by phone). Either one deletes the app's stored keys and every pairing,
     and the app then makes a new SSH key, relay box key and relay device id.
  3. Pair each computer again.

  A computer without Pro cannot revoke the old relay device token at the relay (that request is
  signed with the Pro entitlement), so whoever took it may still reach that computer through the
  relay with the old box key. The revoke unpinned that key, so the computer shows its approval dialog
  with a code before it lets it in: approve a phone there only while your own phone is showing the
  same code.
- Dictation (the terminal input bar's mic) goes through the phone's speech recognition service,
  which on most phones is Google's and may send what you say to its servers; it is not the on-device
  Whisper of the desktop and iOS. The microphone is used only after a tap on the mic, until the
  sentence ends or the terminal screen leaves, and the app keeps no audio. Type anything you would
  rather not send to that service.
- Nothing of the app's goes into a backup or a phone-to-phone transfer. `allowBackup="false"` stops
  cloud backup, and the manifest's data extraction rules stop the Android 12+ device-to-device
  transfer, which ignores `allowBackup`. A new phone starts unpaired; pair it again.
- The relay device id goes with the relay key: from this build on, if the key ever has to be
  created again (it was lost), a new device id is minted with it, so the phone does not present an
  old device id with a new key. A phone whose key an older build already replaced keeps its device
  id until the app is reinstalled.
- Relay traffic is end-to-end encrypted (NaCl box under a per-session HKDF key) and checked exactly
  as the desktop checks it: role byte (no reflections), strictly increasing sequence numbers (no
  replays), no re-key once ready, and the host key pinned from pairing.
- The computer names its SSH host keys in the sealed pairing answer, and the phone's first connect
  must present one of them; a server that does not is refused before the phone's key is offered. An
  older desktop names none, and the first connect is then trust on first use. Either way the key is
  pinned on the first connect that authenticates (a server that refuses the phone's key is never
  pinned). A changed key is never used over SSH; in Auto the phone goes on to the relay, which
  verifies the computer separately, and shows a warning.
- Over the relay (and only there) a current desktop also reports its LAN address and SSH host keys
  as they are now, and the phone updates the computer from that: the address it dials on your
  network, and a pin the computer's current keys no longer include (the next connect then has to
  present one of them). So a moved address or a reinstalled computer's new key needs no new pairing.
  Nothing learned over SSH ever changes them.
- A computer added by its SSH address has no pairing behind its first connect, so compare the
  fingerprint the Add screen shows with the computer's own (the screen gives the `ssh-keygen`
  command). A changed key stops it; forget it and add it again only if you know why it changed. To
  revoke the phone there, remove the line ending in `nodeterm-android` from that user's
  `~/.ssh/authorized_keys` (the same key every pairing installs, under another comment). The phone
  never asks for or keeps an SSH password.
- No cleartext HTTP anywhere; the LAN `/pair` POST runs over a raw socket and is sealed to the host
  key from the QR. Its answer is read as untrusted: at most 64 KiB, within 45 seconds.

Design notes, the protocol mapping and known gaps: [`docs/android.md`](../docs/android.md).
