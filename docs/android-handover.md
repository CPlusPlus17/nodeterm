# Android companion: handover (2026-09-26)

Read this first if you are picking up the Android work. It records where the work stands, what has
and has not been verified, what is known to be broken, and the plan in order. The full list of
findings, with evidence and fixes for each, is [`android-audit-2026-09.md`](android-audit-2026-09.md)
(IDs `A01`–`A77`). The design notes are [`android.md`](android.md) and the user-facing readme is
[`../android/README.md`](../android/README.md).

## TL;DR

- The Android app exists (`android/`), and **CI built its debug APK successfully with AGP** (run
  [36109984730](https://github.com/CPlusPlus17/nodeterm/actions/runs/36109984730), artifact
  `nodeterm-android-debug`, which expires 2026-12-24). The protocol tests pass in CI too.
- **It has never been run on a phone.** A 170-agent audit found **9 distinct release blockers**.
  WP1 and WP2 (all nine) are fixed on the branch; see the progress log below. Do not hand the APK
  to anyone until the device pass (WP3) has run.
- The next session should **fix the blockers**, then do a **device test pass** using the checklist
  below, then work down the medium findings. No PR is open, and none should be opened unless the
  user asks.

## Progress log

Newest first. Each entry says what landed, how it was checked, and where the fix differs from the
audit's proposal.

### WP4 (medium bugs): in progress

| Finding | Commit | What changed | Checked by |
|---|---|---|---|
| A24 | `8e304db` | `SecretStoreCore` (protocol) replaces a stored secret only on positive evidence it is gone (nothing stored, malformed blob, `AEADBadTagException`); anything else is `SecretUnavailableException` and nothing is written. The identity's first write is durable. `SecureStore` generates the Keystore key only when the alias is absent. | `SecretStoreCoreTest` with real AES-GCM. |

### WP2 (blockers with decisions): done on the branch, not device-verified

| Finding | Commit | What changed | Checked by |
|---|---|---|---|
| A05 / A17 / A23 / A30 | `3d36d60` | `RelayApprovalGate` (protocol): the background worker dials the relay only for a computer where a relay connect has succeeded (persisted `relayApproved.<id>`), and then with `requireApproved`, so a revoked pin gives up instead of waiting and clears the flag. A refused (Deny) or unanswered approval holds automatic dials until the user taps Try again / Refresh or opens the computer. `RelayConnector` reports typed `RelayApprovalRefused/Timeout/RequiredException`. | `RelayApprovalGateTest`; relay interop through the desktop's real host session: Deny reads as a refusal (fixture gained a reject mode), and a `requireApproved` dial fails fast without showing a code. |
| A07 | `0fa0646` | Option (b), additive. The phone sends its box key inside the SEALED `/pair` body; the desktop pins it (same `updateApprovedDevices`/`pinDevice` a SAS approval writes) when the relay leg was minted, answers `relayPinned: true`, records `relayBoxKey` on the device, and unpins it on revoke unless another pairing of the same phone remains. A plaintext body never pins. PairScreen says "Remote access is on" and tells the user after pairing whether one approval is still owed. | vitest `pairing-service.test.ts` (5 new cases); pairing interop through the real `createPairingService`. |
| A08 | `1cdd2f0` | Chose "refuse and route to the relay". SSH attach runs `attach-session` after a `has-session` check (exit 3), never `new-session`; a session that is not running raises `NeedsRelayException`, and the terminal offers "Open through the relay" (`HostSession.viaRelay`, a relay connection held next to the SSH one), where the desktop creates it with its hook env. | SSH transport tests: nothing is created by the transport or by the script itself. |
| A09 / A28 | `726271a` (desktop), `1cdd2f0` (phone) | **Desktop:** the relay `pty.attach` of an SSH-project node now attaches over that project's ControlMaster (`requireRemote`, host-side freshness and snapshot) or refuses with the host's name — never locally. **Phone:** over direct SSH, attach/keys/approvals/kill for those nodes raise `NeedsRelayException` and read-acks are skipped; the terminal, the Inbox and End session retry through the relay. | vitest `remote-security.test.ts` (4 new cases); SSH transport test for the refusals. |

Not done here, noted for later: late relay adoption (`adoptRelayIfAdvertised`) does not pin, so a phone
adopted that way still approves on its first relay connect; revoking a device unpins its key but
does not cut a relay session that is open at that moment (the standing host's revocation path does
that). iOS can adopt `boxPublicKey`/`relayPinned` unchanged.

### WP1 (blockers): done on the branch, not device-verified

| Finding | Commit | What changed | Checked by |
|---|---|---|---|
| A01 / A04 | `af1f820` | `SshStream` owns one single-thread writer for write/resize/scroll; a non-IO exception out of sshj's write path tears the transport down and fires `onClosed` instead of being swallowed. `SshHostConnection.close()` and `HostSession.disconnect()` never touch the socket on the caller's thread, and a failed `SSH_MSG_DISCONNECT` still closes the socket. | `SshTransportTest`: a socket factory that throws when used from a thread marked "main" (a JVM stand-in for StrictMode) drives resize/write/close from that thread; a poisoned transport must surface as `onClosed`. Mutation-checked. |
| A02 | `e7c22eb` | Prelude probes `…/node-terminal` first, `…/nodeterm` as a legacy fallback. A listing with no userData dir is now an explicit error, not an empty computer. `scripts/uninstall.sh` + `docs/uninstall.md` remove `node-terminal` (and legacy `nodeterm`) data, caches, logs and either Keychain spelling. | Fixture uses the real name; new `SshScriptsTest` runs the prelude under `/bin/sh` on Linux, macOS, XDG, legacy and both-present HOMEs. |
| A03 | `cd69a1e` | Attach script exports a UTF-8 LANG by the desktop's `resolveLocaleLang` rule (`en_US.UTF-8` on macOS, `C.UTF-8` elsewhere) and passes `-u`. | Harness no longer leaks the JVM's LANG; `╭é` from ASCII input must arrive intact. Mutation-checked. |
| A06 / A35 | `16706f4` | Desktop writers check `<pendingId>.json` before writing (`fs.access`; `[ -f … ] \|\| exit 3` in the same SSH command) and return `sent \| gone \| failed`; only `sent` emits the synthetic answered event. `approvals.answer` adds `reason` (additive). Phone: `ApprovalOutcome.GONE`; if the node is still blocked, `QuickActions` returns `EXPIRED`, which opens the session with an explanation. | vitest (pending-approvals, ssh-project incl. the remote command under a real `/bin/sh`, host inbox verbs); SSH transport test; relay interop through the desktop's real verb. |
| A10 | `fcda932` | `android/app/debug.keystore` committed and wired as the debug signing config. **Departs from the verifier's advice** (it warned that a public key lets anyone sign an update that inherits the app's data); the user chose it for sideloading. The trade-off is written in `build.gradle.kts` and both READMEs. | CI build (AGP cannot run in the sandbox). |

The iOS-facing part of A06: `approvals.answer` now replies `{answered:false, reason:"gone"|"failed"}`
when it did not deliver. iOS can adopt `reason` unchanged; an older phone keeps reading `answered`.

## Where things are

| | |
|---|---|
| Repo / branch | `CPlusPlus17/nodeterm`, branch `claude/android-ios-parity-75kfem` (pushed) |
| Commits | `a0c07e6` protocol module + the two desktop relay verbs; `2f58918` the Compose app, docs, CI, desktop copy; plus the handover commit that adds this file |
| PR | none (do not open one unless asked) |
| CI | `.github/workflows/android.yml`: **Protocol** (JVM + desktop interop) and **App** (`assembleDebug`). Both green on `2f58918` |

What is in the tree:

- `android/protocol` is pure Kotlin/JVM with no Android dependency. It holds the NaCl port, the relay
  client, the host RPC, pairing, direct SSH over sshj, and the parsers. It has 41 tests. The
  interop tests run the desktop's own `connectHostSession` / `createPairingService` through
  `android/protocol/src/test/interop/host-fixture.ts`; the SSH tests use Apache MINA sshd with a
  sandboxed tmux.
- `android/app` is the Compose app: pairing, hosts, the Sessions/Board/Inbox/Usage tabs, the
  terminal (xterm.js in a WebView), settings, and WorkManager notifications.
- `android/tools/typecheck` is an offline Kotlin type-check of the app for sandboxes without Google
  Maven. See its README for what it can and cannot catch.
- Desktop side:
  - `src/main/remote/host-service.ts` gained the relay verbs **`approvals.answer`** and
    **`inbox.ack`**, tested in `src/main/remote/host-inbox-verbs.test.ts`.
  - `src/main/index.ts` extracted `answerPermission` and wired `hostBridge.inbox`.
  - The renderer copy now names both phone apps (`PhonePairPopover.tsx`, `PhoneSection.tsx`,
    `lib/links.ts`).
  - CLAUDE.md gained an Android paragraph under Conventions → three surfaces, and CONTRIBUTING.md
    and README.md gained notes.

## What is verified, and what is not

Verified:

- The protocol against the desktop's real code: the relay handshake, SAS, approval wait,
  `projects.list`, attach/snapshot/input/resize/exit, scroll, node actions, board verbs,
  `approvals.answer`, `inbox.ack`, registration, and pairing (E2EE `/pair`, the key landing in
  `authorized_keys`).
- Relay security properties: no re-key, reflection, replay/reorder, and a foreign key.
- SSH transport against a real SSH server with tmux.
- The debug APK builds with AGP in CI.

**Not verified:**

- **Anything on a device.** No install, no pairing, no terminal use has happened on a phone.
- The relay join request shape. The client sends `{deviceToken, hostId}` to `POST /v1/relay/join`
  and accepts `pairingToken | token | joinToken` in the reply, but it has not been checked against
  the live backend (the backend repo is not here).
- Release/minified builds. R8 is off; see `A37`.
- **Caveat on the tests:** their fixtures hand-copy some desktop shapes: the mirror, the
  `projects.list` blob and the `~/.nodeterm` files (`A64`). That is how `A02` passed its test while
  being wrong on every real desktop.

## Environment notes for a cloud session

- **Google Maven is blocked** (`dl.google.com` / `maven.google.com` answer 403 from the egress
  proxy). AGP cannot resolve, so `./gradlew :app:assembleDebug` does not work in the sandbox. Do not
  retry it or route around it. Instead:
  - Type-check the app with `cd android/tools/typecheck && gradle compileKotlin`. It passed on the
    handover commit.
  - Rely on CI for the real AGP build: push, then read the Android workflow run.
- Maven Central sometimes answers 429. Retrying works.
- System `gradle` is 8.14.3 on JDK 21 in the sandbox; the wrapper pins 8.14.3 and CI uses JDK 17.
- The protocol tests need `npm ci --ignore-scripts` at the repo root first (for the esbuild-bundled
  interop fixture) and a `tmux` on PATH. Run them with
  `cd android/protocol && gradle test --offline`, or `cd android && ./gradlew -p protocol test`.
  Without node the interop tests skip.
- Desktop checks for any change to `src/main/remote/*`:
  - `npx vitest run src/main/remote/host-inbox-verbs.test.ts`
  - `npm run typecheck`
- Test-writing traps already hit once:
  - A JUnit 5 test whose body returns non-Unit is silently skipped. Use `runBlocking<Unit> { … }`.
  - In the SSH test harness, closing stdin on a pty command sends ^D and kills tmux.
  - An exact-match tmux **pane** target is `=name:`, not `=name`. tmux 3.4 answers "can't find
    pane".

## The findings in one page

77 findings survived verification, and none were refuted. Merging the duplicates (`A01`=`A04`,
`A05`=`A17`=`A23`, `A09`=`A28`, `A11`=`A19`) leaves 72 distinct items. The severity counts below are
over all 77: 8 high and 2 medium release blockers, 26 other medium, and 41 low. The work packages
below use the audit IDs.

### WP1: unambiguous blockers (small, do first)

| ID | Problem | Fix direction |
|---|---|---|
| A01 / A04 | `SshStream.write/resize` do socket I/O on the **main thread**. That throws `NetworkOnMainThreadException`, which `runCatching` swallows after sshj has advanced its cipher state, so the next packet kills the connection. Keyboard open, rotation, A−/A+ and the key chips all trigger it. `SshHostConnection.close()` from click handlers (`HostsScreen` Forget, `SettingsScreen` route change, `PairScreen`) leaks the socket the same way. | Give `SshStream` one single-thread executor. Route write, resize and scroll through it: this keeps ordering between main-thread chips and JavaBridge-thread input. Run `close()` / `client.disconnect()` off the main thread (`Dispatchers.IO`). Catch `RuntimeException` by closing the transport, not by swallowing it. |
| A02 | The SSH prelude looks for the desktop's data in `…/nodeterm`, but the desktop's userData is **`…/node-terminal`** (package `name`, no top-level `productName`). Confirmed: `src/core/agents/hook-endpoint-failover-sh.ts:79-80` uses `node-terminal`. | Probe `node-terminal` first and keep `nodeterm` as a fallback, in `SshScripts.kt:38` and its KDoc at :18-19. Fix the `SshTransportTest` fixture (:154) to the real name. The same wrong path is in `docs/uninstall.md:24` and `scripts/uninstall.sh:64` on the desktop side; fix those too. |
| A03 | The SSH tmux client starts without a UTF-8 locale, so ╭, accents, CJK and emoji come out as `_`. | In the attach script, export `LANG=en_US.UTF-8` unless LC_ALL/LC_CTYPE/LANG already says UTF-8 (the rule of `resolveLocaleLang` in `pty-manager.ts`). Add `-u`. Add a test with LANG unset. |
| A06 (+A35) | **Desktop:** `approvals.answer` writes the answer even after the hook's 45 s hold ended, then reports success and emits the synthetic answered event, which clears NEEDS YOU everywhere. The canvas button has the same pre-existing gap. `answered:false` cannot tell "gone" from "write failed". | In `answerPermission` (`src/main/index.ts`), check that `<pendingId>.json` still exists before writing (`fs.access` locally, `test -f` in the same remote command over SSH). Return false and skip the synthetic event when it is gone. Reply with a reason (`gone` / `failed`). On the phone, map `gone` for a still-blocked node to "open the session". |
| A10 | CI debug APKs are signed with a fresh debug key each run, so updating means uninstalling, which wipes pairings. | Commit a debug keystore (`android/.gitignore` already has `!debug.keystore`), point `signingConfigs.debug` at it, and say in the README that it is a public debug key. |

### WP2: blockers that need a decision (recommendations in bold)

| ID | Problem | Options |
|---|---|---|
| A05 / A17 / A23 (+A30) | The background `InboxWorker` can make the phone's **first** relay handshake, which raises the desktop's SAS approval dialog while the phone shows nothing. It repeats every 15 min, and pressing Deny is not respected: the phone re-dials about 8 s later. | **Add a per-host "relay approved" flag, set only after a foreground relay connect succeeds. The worker never enters the relay leg until it is set.** After "Awaiting approval" or a refusal, back off and stop re-dialing until the user acts. (Aborting on AwaitingApproval does NOT help: the desktop raises the dialog at handshake completion, `standing-host.ts:256-261`.) |
| A07 | Pairing never pins the phone's relay (box) key, and Auto prefers SSH on the LAN. So the one-time relay approval never happens while the user is at the desk, and the first remote connect waits 5 min and fails. The desktop design has the same gap, so iOS likely shares it (`standing-host.ts:424-434`). | **(b) Send the phone's persistent box public key inside the sealed `/pair` body and have `pairing-service.ts` pin it (the standing host's `isPinned` store) when pairing succeeds.** This is additive: an older desktop ignores the field. Raise it for iOS with @eneskirca. Interim alternative (a): right after pairing, run one relay handshake on the LAN and show the SAS on PairScreen. Either way, PairScreen must stop saying "✓ Reachable from anywhere" before approval. |
| A08 (+A72) | A cold attach over direct SSH (`new-session -A` with no `-e` env) creates the desktop's tmux session **without the hook env**. An agent resumed there never reports status, the desktop never repairs it, and if the desktop's client started the tmux server the session inherits **another node's** `NODETERM_NODE_ID` (misattribution). | **Do not cold-create over SSH. When `hasSession` says no, offer "Open on your computer" and use the relay when available, where `attachDetached` injects the env.** The alternative is to pass the full hook env with `-e` (NODETERM_NODE_ID, NODETERM_HOOK_ENDPOINT, NODETERM_HOOK_VERSION, …); that duplicates desktop logic and drifts. |
| A09 / A28 | Nodes of the desktop's **SSH projects** live on a third machine, but over direct SSH the phone attaches to the desktop's LOCAL tmux. That creates an empty phantom session and offers to resume on the wrong machine. | **Over direct SSH, don't attach nodes whose project is an ssh-ref. Show them with "open via remote access" and use the relay.** Check first how the desktop's `pty.attach` handles a remote node. |

### WP3: device test pass (after WP1 + WP2)

Install the CI APK (from the new stable debug key) on a real phone and walk the checklist below.
Record results in `docs/android.md` → "What is verified". Anything that fails becomes a new finding.

### WP4: medium bugs (after the device pass)

`A11`/`A19` notification tap ignores the target computer · `A12` relay `sendKeys` into a pty that
does not exist yet · `A13` registering while attached lets the desktop attach with `-D` and detach
the phone · `A14` inline (cwd-less) project sessions never registered · `A15` resume drops the
Claude account (and cwd over relay) · `A16` project permission mode/default account ignored ·
`A18` no lifecycle handling (8 s poll + relay stream keep running in background) · `A20` cancelled
connect leaks SSH and counts as failure · `A21` denied notification permission never re-requested ·
`A22` back stack not saved across recreation · `A24` SecureStore overwrites identity on any decrypt
error (**data loss: fix early**) · `A31` silently dead SSH peer wedges "On your network" ·
`A33` Windows host new-session cwd/account · `A34` Ctrl chip not applied to input-bar text ·
`A36` terminal stays "Disconnected" after auto-reconnect.

### WP5: iOS parity gaps

`A25` real push (needs an FCM leg in the backend; also notification actions) · `A26` new session
and board edits over direct SSH · `A27` connect straight to a Linux host / Server Edition (also
probe `~/.nodeterm-server`) · `A29` source-control screen (verbs already in `HostConnection`) ·
`A32` link opening and text selection in the terminal · `A55` merged inbox/usage across computers ·
`A56` "Always allow" · `A57` multi-select questions · `A58` pace line / context indicator ·
`A59` dictation · `A75` account picker shows UUIDs · `A76` wake/resume for Sleeping sessions over SSH.

### WP6: low-severity, docs and CI

The rest of `A37`–`A77`: R8 rules, lock-screen notification content, OSC 52 size cap, pairing
response size cap, SSH TOFU pin timing, device-to-device migration, the CI path filters and trigger
conventions, dependabot/CodeQL/wrapper validation, test gates on macOS/Windows, doc claims, the
tsconfig coverage of the interop fixture, and `ANDROID_APP_URL` pointing at a folder not on the
default branch yet. `A65` is partly obsolete (CI did build the APK).

### WP7: PR

When the user asks: open a PR from this branch, following the repo's `pr-writing` rules and any PR
template. Mention @eneskirca for the mobile implications: the pairing-key pin from `A07`, and
`approvals.answer` / `inbox.ack`, which the iOS app can adopt.

## Decisions the user still has to make

1. **A07**: pin the phone's relay key at pairing (desktop + protocol change, additive), or the
   interim "one handshake right after pairing" flow? Recommended: pin at pairing.
2. **A08**: refuse cold-create over direct SSH, or inject the hook env? Recommended: refuse and
   route to the computer.
3. **A09**: hide or relay-route SSH-project nodes over direct SSH? Recommended: relay-route.
4. **Distribution**: a committed public debug key for sideloading (`A10`), and later a real release
   signing key plus a store listing. Nothing exists yet for the latter.

## Device checklist (owed; nothing here has been run)

Run each on a real phone against a real desktop, and note OS versions.

1. Install the CI APK. Install the next CI APK over it without uninstalling (checks `A10`).
2. Pair by QR with a macOS desktop, then with a Linux desktop, then with a Windows desktop (the
   Windows QR carries `"ssh":false`, so pairing is relay-only).
3. Pair by pasting the code, and by opening a `nodeterm://pair?code=…` link.
4. On the LAN (Auto route): the session list shows the desktop's projects and sessions (checks
   `A02`).
5. Open a terminal and type with the soft keyboard. Rotate. Use A−/A+ and each key chip. The
   connection must survive (checks `A01`).
6. Non-ASCII renders correctly: Claude's rounded borders, accented letters, CJK, emoji (checks
   `A03`).
7. Swipe to scroll tmux history. Copy via tmux selection (OSC 52 reaches the Android clipboard).
8. "Sized to another screen · Fit this screen" appears when the desktop is larger, and Fit works.
9. On cellular (not the LAN): connect through the relay. The desktop shows the SAS; the phone shows
   the same code; approve. Reconnect later: no second prompt.
10. With the phone backgrounded for 15+ minutes, no unexpected SAS dialog appears on the desktop
    (checks `A05`).
11. Approve and deny a held Claude permission from the Inbox within 45 s. Retry after the hold
    expired: the phone must not report success (checks `A06`).
12. Answer an AskUserQuestion from the Inbox.
13. Open a finished session on the phone: the desktop's unread dot clears.
14. Board: move a card, add/remove/create a label; the desktop board updates without a reload.
15. New session (Claude, shell) from the phone: the node appears on the canvas, the agent runs, and
    status badges update.
16. Wake / refresh / rename / end session from the phone.
17. Reboot the desktop, then open a session from the phone: the resume offer appears and resumes
    the right conversation under the right account (checks `A15`).
18. A background notification arrives (within ~15 min); tapping it opens that computer (checks
    `A11`).
19. Kill the app process in the background (via developer options) and reopen it: the screen and
    back stack are sensible (checks `A22`).
20. Forget a host; change a host's route in Settings; pair two computers at once.
21. Put the desktop to sleep while the phone is connected over SSH: the phone notices and falls back
    (checks `A31`).
22. Android 15 edge-to-edge: the keyboard does not double-pad the terminal (checks `A77`).
23. Light and dark system theme; a tablet or foldable if available.

## Conventions for whoever continues

- Develop on `claude/android-ios-parity-75kfem`, and push with
  `git push -u origin claude/android-ios-parity-75kfem`. Commit messages end with the session's
  attribution trailer lines.
- CLAUDE.md → Conventions → three surfaces has the Android rule. A change to a `host-service.ts`
  verb, the `projects.list` blob, the pairing payload, the mirror file or the `~/.nodeterm` file
  contracts owes the Android client and its interop fixture **in the same change**.
- Every fix gets a regression test where the layer allows. The protocol layer is JVM-testable, and
  the WP1 SSH fixes are testable against the MINA/tmux harness. Fix the test fixtures that
  hand-copied wrong shapes (`A02`, `A64`) so they would have failed.
- Before pushing, run:
  - the protocol tests;
  - the offline type-check;
  - for desktop changes, the affected vitest files and `npm run typecheck`.

  After pushing, confirm the Android workflow is green.
- Update this file, `docs/android.md` and the audit index when work lands. Mark a finding as fixed
  by editing its index row, e.g. `A02 ✅ fixed in <sha>`.
- Never claim device verification that did not happen.

## Follow-up prompt

Paste this into the next session. Edit the "Decisions" line first if you want different choices
than the recommendations.

```text
Continue the Android companion work on branch claude/android-ios-parity-75kfem of CPlusPlus17/nodeterm.

Start by reading docs/android-handover.md (status, plan, environment notes, conventions) and
docs/android-audit-2026-09.md (findings A01–A77 with evidence and fixes). Re-read the cited code
before changing it; the audit is at commit 2f58918.

Do, in order, committing in small logical commits and pushing when each work package is green:
1. WP1 blockers: A01/A04 (SSH I/O off the main thread, one serial executor in SshStream, close()
   off main), A02 (desktop userData dir is node-terminal; fix the SSH prelude, its test fixture,
   and docs/uninstall.md + scripts/uninstall.sh), A03 (UTF-8 locale for the SSH tmux client),
   A06 + A35 (approvals.answer must not report success after the hold expired; reason in the reply;
   phone maps "gone" to open-session), A10 (committed public debug keystore so CI APKs update in place).
2. WP2 with these decisions: A05/A17/A23/A30 — background worker never makes a first relay
   handshake (per-host relayApproved flag set by a successful foreground relay connect) and a denied
   or pending approval backs off instead of re-dialing; A07 — send the phone's box public key in
   the sealed /pair body and have the desktop pin it on successful pairing (additive; keep older
   desktops working), and fix PairScreen's "reachable from anywhere" claim; A08 — never cold-create
   a tmux session over direct SSH, offer to open it via the relay instead; A09/A28 — nodes of the
   desktop's SSH projects are opened via the relay, never against the desktop's local tmux.
3. Then WP4 (medium bugs), starting with A24 (SecureStore identity overwrite).

For every fix add a regression test where the layer allows (protocol tests are JVM + interop +
MINA/tmux). Before each push run: the protocol tests (cd android/protocol && gradle test --offline,
after npm ci --ignore-scripts at the repo root), the offline app type-check
(cd android/tools/typecheck && gradle compileKotlin), and for desktop changes the affected vitest
files plus npm run typecheck. After each push, check that the Android GitHub workflow is green.
Google Maven is blocked in this sandbox — do not try to reach it; CI does the real AGP build.
Keep docs/android.md, android/README.md, docs/android-handover.md and the audit index in sync
(mark fixed findings). Follow CLAUDE.md, including the Android rule under Conventions. Do not open a
PR unless I ask. At the end, report what was fixed, how it was verified, what is still unverified
(nothing has run on a device yet), and the updated next steps.
```
