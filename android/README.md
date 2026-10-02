# nodeterm for Android

The Android companion to nodeterm: pair your phone with nodeterm on your computer, then watch your
agents, answer their questions and open any terminal on the canvas — on your network over SSH, or
from anywhere through the end-to-end encrypted relay. It is the Android counterpart of the iOS app
and speaks the same protocol to the same desktop; nothing on the computer needs to know which phone
it is talking to.

> **Status (2026-10-02): private beta updated on the intended Pixel; basic SSH and pre-attach tmux history work.** CI builds the debug APK, and the release blockers
> and medium bugs an audit found are fixed on this branch and tested where the code allows. The
> private minified beta is installed on the Pixel 10 Pro (Android 17 / API 37); manual SSH lists real
> projects and basic terminal input works. The code-3 update fixes the one-row viewport and exposes
> pre-attach tmux history (`A85`). The user confirms the host terminal opens with Wi-Fi off over
> mobile-data WireGuard. QR/code pairing, relay, reconnect/background/answer behavior and the full device pass remain unverified. The plan and what is still open are in
> [`docs/android-handover.md`](../docs/android-handover.md); the findings are in
> [`docs/android-audit-2026-09.md`](../docs/android-audit-2026-09.md).

**Scrolling remains open (`A86`, `A89`):** beta 5 still stops during continuous swiping; the user
must lift before moving again. Real xterm reproduces the cause: redraw detaches the original
text-span touch target, losing later move/end events. `c4b1f6cf` targets the stable screen behind
changing text; beta 6 / code 7 is installed. It passes 658 protocol tests and release/R8/signing
checks. The phone is locked, so post-update SSH and coast/stop checks await unlock; actual user
feel remains open.

## What it does

The APK is built by CI. Manual SSH and basic terminal input have partial real-device evidence;
the feature rows below still require the full device pass. ✓ means the code is written for it and
tested where the layer allows, and the numbered
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

The full device pass is still outstanding. The intended Pixel has the private beta and basic SSH
listing/input works. Its corrected code-3 update (`A85`) fills a 52×45 viewport and shows pre-attach
tmux history after swiping; font and keyboard changes resize the host correctly. The user's intended connection is to this Linux host over their
WireGuard VPN; the user confirms its terminal opens over mobile data with Wi-Fi off.
The user authorized local builds and pushing this branch. Each requested push requires green
Android workflow verification, with no PR requested and `A68` deferred. The beta-3 controlled
scroll checks did not satisfy the user; verify the corrected beta on the intended phone before
calling responsiveness resolved. Beta 5 implements momentum/native stopping but actual drag
still loses its touch target; beta 6 corrects that (`A89`). The SDK-37
packaging follow-up `f5fd3821` passes 39 Python tests against each SDK 36/37 and ten new mutations;
CI4 still failed private packaging, so the next workflow must verify the repair in Actions.

1. Prepare and install the [private beta](#private-beta) below from a successful local build or CI
   run of the current branch. The desktop must also include the host-side fixes you want to test. Future private beta
   updates use the same private signer and a higher version code, preserving pairings.
2. For a VPN/SSH route, connect the VPN, use Add SSH server and compare the host-key fingerprint
   with the computer. For the relay route, turn on remote access in Settings → Phone, pair, and open the computer in the
   app. If either screen asks for a first relay approval, compare and approve its code there.
3. Turn the phone's Wi-Fi off. Open a terminal over mobile data, send a harmless command, answer a
   question and a held approval, then reconnect after briefly enabling airplane mode. Confirm the
   answers on the computer. For SSH, keep the VPN active and confirm the route stays SSH; for the
   relay route this also checks the live relay join contract, still unverified here.
4. Keep the computer awake, nodeterm running, and the intended project/session mounted and awake.
   For the relay route, keep remote access on. Offscreen Sleeping sessions remain a known relay gap. Background
   notifications use Android's periodic worker and may take longer than 15 minutes; there is no FCM.
5. Record these results, then finish the [64-item device checklist](../docs/android.md#device-checklist).
   A successful build or cold start alone does not verify pairing, input or connectivity on the phone.

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
a minified APK fully works on the intended phone. The private beta has listed actual projects and
delivered basic terminal input over SSH; the corrected update exposes pre-attach tmux history.
The full device pass remains open.

## Private beta

This path prepares an APK for your own phone. The private signing key and signed APK stay on your
machine. The user authorized a local build for this first beta. The first unsigned release built
with AGP 8.9.1 emitted R8 Kotlin-metadata warnings (`A83`). The corrected AGP 8.10.1 release at
`fa71cb08072f399f24a81bfb361ea852a0275f3b` completed, including an offline rebuild and every R8 keep
check, with those warnings gone. The privately signed `0.1.0-beta.1` (code `2`) was installed on an
MI8 running Android 15 / API 35; after its first notification permission dialog, it showed the empty
Computers screen, Pair button and Settings with no crash markers. Installed metadata and refused
`run-as` confirm it is non-debuggable (minSdk 26, targetSdk 35). Its WebView is
`com.android.webview` `144.0.7559.76`. The user then identified this as the wrong phone. Only the
newly installed app and its test UI dump were removed; its newly authorized SSH key was removed
and the host's `authorized_keys` was restored byte-for-byte. It had no paired host, and no SSH
connection was attempted. The same code-2 beta is now installed on the intended Pixel 10 Pro,
Android 17 / API 37, Vanadium WebView `154.0.8037.92.0`. The user granted notifications normally;
`run-as` is denied. Manual Add SSH server connects to this Linux host, with the authorized phone
key preserving existing authorized entries and the Ed25519 pin matching its public key. The app lists 17
actual projects and a harmless terminal command entered on the phone executed in a controlled
temporary tmux window. The intended route is this host through the user's WireGuard VPN; the user
confirms its terminal opens over mobile data with Wi-Fi off. That code-2 terminal was one row (`A85`), and swiping did not expose old
history. The fix in `febe022a` supplies `MATCH_PARENT` WebView layout parameters; its Gradle
wiring guard and two mutations pass. Actual beta `0.1.0-beta.2` (code `3`) passed its offline AGP
release build in 45 seconds, retained-signer verification and in-place update. Host configuration,
SSH key/pin and notification grant stayed intact. The controlled terminal now fills 52×45, and a
downward swipe entered tmux copy mode and visibly showed rows printed before update/attach.
Inputs/logs are in `.nodeterm/android-beta-build-2/`; APK/checksum/metadata are in
`.nodeterm/android-beta-2/`. APK SHA-256:
`a022a399e23c81607a4a3664862b964ad781f0a589ab77dda902b4c2dc597eca`.
A− restores 56×48, the keyboard changes it to 56×25 and hiding the keyboard returns 56×48.
Esc leaves copy mode, and Send executes a second harmless draft command with its whole output line.
Only the owned temporary test window was removed; the original window/process and intended-phone
configuration remain.

**User-reported mobile check:** with WireGuard enabled and Wi-Fi off, the user confirmed that the
intended Linux host's terminal opens over mobile data. This is separate from the ADB-assisted LAN
checks above. Mobile reconnect, approvals/questions, background behavior and the full 64-item
checklist remain open.

History regressions in `d6619bf6` pass 47 focused real Gradle SSH/terminal/link tests with zero skips. Both JavaScript swipe-direction/disabled-scroll mutations, the real-SSH wheel-direction mutation and the two native layout-policy mutations were caught; production sources were restored. **Beta-2 verification:** all 609 protocol tests passed in 59 suites with zero failures, errors or skips (52 seconds); the offline app `compileKotlin` passed (7 seconds).

**Historical A86 beta-3 update:** private `0.1.0-beta.3` / code `4` from
`40c4ee49592e2f92fc7e6e9b548ba88a33b1e2d3` built locally in 49 seconds, passed every R8 keep
and retained-signer packaging. Signature, alignment and source/hash provenance passed, with all
149 ZIP payloads unchanged by signing. APK SHA-256:
`dda44df7ebb541afccd18b428634d66246349ccb62fd202917b77a333fbadba3`.
The intended Pixel updated in place and preserved manual SSH registration/key/pin and notification
permission. It reopens the Linux host over SSH with a 56×48 test terminal. Five identical controlled
swipes finish at history position 25 versus beta 2's 85; reversal moves 25 to 20 and Esc leaves
copy mode. The phone returned to Sessions and refreshed; only the owned test session was removed,
with user panes untouched. Private proof/screenshot/package checks are in
`.nodeterm/android-beta-build-3/`, including `device-checks.json`. These verify drag gain/order/input
cancellation, not perceived smoothness or FPS. The user subsequently reports both lag and too
little movement; the current `A87` correction supersedes this gain policy. At that checkpoint,
restored-source checks passed all 638 protocol tests in 61 suites with zero failures, errors or skips (51 seconds),
and the final offline app `compileKotlin` (7 seconds). Thirty SSH/JavaScript/actor/wiring mutations were
caught. The later controlled phone trace records sparse updates and does not establish terminal FPS.
At that checkpoint, actual feel, custom wheel bindings and kinetic fling remained open under `A86`.
Push is authorized; each requested push requires green
Android workflow verification.
The matching phone trace records 42 bridge invocations versus 12 and 25 distinct presentations
versus 11 over twelve gestures; first invocations occur at 25–36 ms versus 84–90 ms. These show
more delivered updates, without establishing terminal FPS or end-to-end SSH latency.

**Current stable-touch beta (`A89`):** `0.1.0-beta.6` / code `7` uses source
`c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6`. It targets the stable xterm screen behind changing
rows. Real-bundle redraw regression delivers 24 notches versus one with a detached touch target.
All 658 protocol tests in 63 suites and offline app `compileKotlin` pass; 35 JS, eleven native
and three CSS mutations were caught. Actual AGP release built in 43 seconds and passed every
R8 keep. Retained-signer packaging verifies non-debuggable metadata, signature, 16-KB alignment
and source/hash provenance; all 149 ZIP payloads remain unchanged by signing. APK SHA-256:
`4947133a6ccf9c2b1e775e76d7c24f564e087cf036e59eac4dca08162a076d3c`.
The intended Pixel received a same-signer update preserving app data; notification permission is confirmed. It is
locked, so post-update SSH reopening and phone drag/coast/stop checks await unlock. Actual user
feel, mobile-beta-6 checks and full device validation remain open in the [handover](../docs/android-handover.md#progress-log).

**Historical kinetic beta (`A86`):** `0.1.0-beta.5` / code `6` uses source
`1ad2e94455a7adfb85d41212b12d36df39695324`. A fast release starts bounded decaying movement;
new touch/input/reset/font/lifecycle barriers discard unsent scrolling, preserving accepted
keys/replies and the in-flight operation. Bytes already handed to SSH's writer/network cannot
be recalled. All 658 protocol tests in 63 suites and offline app `compileKotlin` pass; 35 JS and
eleven new native mutations were caught. Its actual AGP release built in 47 seconds and passed
every R8 keep. Retained-signer packaging verifies non-debuggable metadata, signature, 16-KB
alignment and source/hash provenance. APK SHA-256:
`7cc68d384aeb21ab40800fa7c83f006dfbfefba16dd2e945967c8c5376f17655`.
The intended Pixel updated in place with notification permission intact, but its continuous
swipe still stops and shows no coast after the ADB swipe command completes. This actual failure led to `A89`; it is
not momentum-success proof. Actual corrected-beta user feel remains open.

**Packaging CI (`A88`, `f5fd3821`):** CI run `37058184031` passed its four main jobs but failed private
packaging. Real SDK 37 reproduces the new `V3.0 Signer:` format; the follow-up accepts exact
scheme labels while retaining one pinned certificate and verified v2. All 39 Python tests pass
against each SDK 36/37, and ten new parser/fixture-selection mutations are caught. The fixture
now uses CI's installed SDK 36/platform 35 explicitly; the next workflow must confirm CI repair.

**Historical beta-4 correction:** source `3cffb49d8cf64932260e914b42b3883331d0352d`, version
`0.1.0-beta.4` / code `5`, retains the same signer. All 646 protocol tests in 62 suites pass with
zero failures, errors or skips; offline app `compileKotlin` passes (8 seconds). Real xterm
focus/mouse/query reports preserve gestures, while actual keyboard/paste/IME input cancels them;
22 JavaScript and nine actor/native-wiring mutations were caught. `fed68fb3` verifies newer SDK
signer labels without relaxing the expected-certificate/v2 policy; 32 Python tests and ten
mutations pass locally. Successful CI confirmation remains required for that observed workflow failure.
The code-5 local AGP release built in 48 seconds and passed every R8 keep. Retained-signer
packaging verified non-debuggable APK metadata (minSdk 26, targetSdk 35), signature, alignment
and source/hash provenance. APK SHA-256:
`c64d6a8dea9621265f23a679104149e511ecd243fbdfa53ced401f4cb4f0f6b5`.
The intended Pixel updated in place, preserving manual SSH configuration/key/pin and granted
notifications; the installed app remains non-debuggable. Its owned 56×48 terminal now reaches
positions 25, 45, 70, 100, 130 on the same five 1000-native-pixel/350-ms swipes, versus beta 3's
5, 10, 15, 20, 25. Each gesture produces 4–6 observed host-position changes, reversal moves
130 to 110, and the actual Esc chip leaves copy mode. Private inputs/proof are in
`.nodeterm/android-beta-build-4/` and the APK/checksum/metadata in `.nodeterm/android-beta-4/`.
These verify delivered movement/order/cancellation, not terminal FPS or satisfactory user feel.
The user subsequently confirmed more movement but reported missing momentum; the active `A86`
kinetic-scroll work above addresses that remaining gap.

The original workspace holds the input provenance in `.nodeterm/android-beta-build-1/` and the
first finished APK/checksum/metadata in `.nodeterm/android-beta-1/`. QR/code pairing, relay and
mobile reconnect/background/answer checks remain open. The initial full protocol run passed 603 of 605 tests; the two SSH
harness-isolation failures (`A84`) are fixed in tests only (`1d6b04cc`). The earlier A84 full rerun passed
all 606 tests with zero failures, errors or skips, and both harness mutations were caught. CI was waived for the first local build;
every newly requested push still requires green Android workflow verification. Actions
artifacts on a public repository are downloadable by other signed-in users, so they contain only
unsigned build inputs and checks.

1. Obtain verified unsigned release inputs, using the authorized local build or CI. Each later
   beta update needs a higher version code and the same private signer.

   **Local build:** use JDK 21, the Android SDK and a clean committed source revision. From
   `android/`, select the beta versions, build with the pinned wrapper, and check the R8 keeps:

   ```sh
   NODETERM_ANDROID_VERSION_CODE=3 \
   NODETERM_ANDROID_VERSION_NAME=0.1.0-beta.2 \
     ./gradlew :app:assembleRelease --stacktrace
   sh tools/check-r8-output.sh app/build/outputs/mapping/release
   ```

   After both commands succeed, record the actual APK/R8 hashes in `beta-build-inputs.json`. The
   packager requires these keys; `buildOrigin: "local"` distinguishes this from CI. From the same
   `android/` directory, the following records version `3` / `0.1.0-beta.2`:

   ```sh
   python3 - <<'PYTHON'
   import hashlib, json, pathlib, subprocess
   def sha(path):
       with path.open('rb') as stream:
           return hashlib.file_digest(stream, 'sha256').hexdigest()
   apk = pathlib.Path('app/build/outputs/apk/release/app-release-unsigned.apk')
   r8 = pathlib.Path('app/build/outputs/mapping/release')
   pathlib.Path('app/build/outputs/beta-build-inputs.json').write_text(json.dumps({
       'schemaVersion': 1,
       'buildOrigin': 'local',
       'sourceRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
       'versionCode': 3,
       'versionName': '0.1.0-beta.2',
       'unsignedApkSha256': sha(apk),
       'r8MappingSha256': sha(r8 / 'mapping.txt'),
       'r8SeedsSha256': sha(r8 / 'seeds.txt'),
       'signed': False,
   }, indent=2) + '\n')
   PYTHON
   ```

   Keep those files from that same successful build together. Require the full protocol tests,
   app/desktop type-checks and relevant desktop tests; a completed AGP build alone is not proof of
   their results. AGP 8.10.1 supports this build's Kotlin 2.2 metadata (`A83`); do not use the earlier
   warning-producing APK as the final beta.

   **CI alternative:** after the required checks, push `claude/android-ios-parity-75kfem`. Pushes
   to this exact branch prepare version `2` / `0.1.0-beta.1`; increase the workflow's
   `NODETERM_BETA_VERSION_CODE/NAME` for later betas. Optional manual **prepare_beta** inputs work
   once the workflow exists on the default branch, as
   [GitHub requires](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
   Wait for **Protocol**, **App release (R8, unsigned)** and **Private beta checks** to succeed.
2. For CI, download `nodeterm-android-release-unsigned`, `r8-release-outputs`, and
   `nodeterm-android-beta-build-inputs` from that same run and extract them into separate directories.
   For either path, use the exact `sourceRevision` and version fields in `beta-build-inputs.json`.
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
   and revision from the local-build or downloaded input metadata.

   ```sh
   python3 android/tools/package-beta.py \
     --apk /path/to/unsigned/app-release-unsigned.apk \
     --r8-dir /path/to/r8-release-outputs \
     --build-inputs /path/to/beta-build-inputs.json \
     --keystore /private/path/android-beta.p12 --key-alias nodeterm-beta \
     --store-password-file /private/path/store-password \
     --key-password-file /private/path/key-password \
     --expected-signer-sha256 YOUR_CERTIFICATE_SHA256 \
     --version-code 3 --version-name 0.1.0-beta.2 \
     --source-revision FULL_COMMIT_SHA_FROM_BETA_BUILD_INPUTS \
     --build-tools-dir "$ANDROID_HOME/build-tools/36.0.0" \
     --output-dir /private/path/nodeterm-beta-1
   ```

   The output directory must be new or empty. The tool matches the APK and R8 checksums to the input
   metadata from that local build or CI run, and checks the package, versions, SDK levels,
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
has prepared it in ignored local state and installed the signed beta; full phone validation is pending. Debug builds
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
still eligible is forgotten. Forgetting a computer forgets that too; pairing it again keeps it. One
event can reach the phone through two computers: a paired desktop lists the sessions of its SSH
projects, and so does the SSH server they run on when you added that one too. It is still one event:
announcing, reading or looking at it under either computer counts for both.

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
  has been built and privately signed through the [private-beta path](#private-beta). Its wrong-test-device
  installation was removed; the intended Pixel now has the same private beta, with `run-as` denied.
  Basic SSH input, font/keyboard resizing and pre-attach tmux history work; relay and the full
  device pass remain unverified. Keep USB and wireless debugging off when not using them.
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
  relay with the old box key. The revoke unpinned that key, so the computer refuses it without a
  dialog until nodeterm there restarts, and after that shows its approval dialog with a code before it
  lets it in: approve a phone there only while your own phone is showing the same code.
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
  verifies the computer separately, and shows a warning. If the computer's SSH server uses a host key
  nodeterm on the computer cannot read (one with no readable `.pub` beside it, or one named only in a
  config file that only root can read), SSH to it stays refused even after pairing again, which re-reads the
  same keys; the relay still reaches it (see Known gaps in `docs/android.md`).
- Over the relay (and only there) a current desktop also reports its LAN address and SSH host keys
  as they are now, and the phone updates the computer from that: the address it dials on your
  network, and the pin, but only for a key the phone was just refused on your network that the
  computer confirms is one of its own (the next connect then has to present one of its keys). A pin
  that still works is kept, even when the computer does not list it. So a moved address or a
  reinstalled computer's new key needs no new pairing; the new key is accepted on the connect after
  the one that met it. Nothing learned over SSH ever changes them. A host certificate is pinned as the
  key it certifies, so a renewed certificate is not a changed key.
- A computer added by its SSH address has no pairing behind its first connect, so compare the
  fingerprint the Add screen shows with the computer's own (the screen gives the `ssh-keygen`
  command). A changed key stops it; forget it and add it again only if you know why it changed. To
  revoke the phone there, remove the line ending in `nodeterm-android` from that user's
  `~/.ssh/authorized_keys` (the same key every pairing installs, under another comment). The phone
  never asks for or keeps an SSH password.
- No cleartext HTTP anywhere; the LAN `/pair` POST runs over a raw socket and is sealed to the host
  key from the QR. Its answer is read as untrusted: at most 64 KiB, within 45 seconds.

Design notes, the protocol mapping and known gaps: [`docs/android.md`](../docs/android.md).
