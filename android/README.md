# nodeterm for Android

The Android companion to nodeterm: pair your phone with nodeterm on your computer, then watch your
agents, answer their questions and open any terminal on the canvas — on your network over SSH, or
from anywhere through the end-to-end encrypted relay. It is the Android counterpart of the iOS app
and speaks the same protocol to the same desktop; nothing on the computer needs to know which phone
it is talking to.

**New work after beta 10 (2026-10-04):** the branch adds Sessions search by name, agent and folder;
live refresh on All computers while visible; and Find in the terminal's captured-output Copy sheet,
with highlighted matches and Previous/Next. The computer now discovers SSH host-key anchors through
recursive configuration Includes. Beta 11/code 12 is prepared locally; the Pixel still runs
beta 10/code 11. Phone checks remain paused, so none of these additions has a physical pass.

**Prepared private beta 11 (2026-10-04).** `0.1.0-beta.11` / code `12`, clean built source
`314105a435d18e719f53d49bb292d0f3e965ad4a`, includes all four additions (`A96`–`A99`) and the
A95 desktop Board fix. Full offline protocol checks pass **730 tests / 70 suites**, with zero
failures, errors or skips; the offline app compile, **297 affected Vitest tests / 17 files** and
full TypeScript checking pass. The four feature regressions catch **81 isolated mutants**.
The actual offline minified release build passes in **51.78 seconds**, retains the private signer,
and passes the R8/runtime keep and packaging checks. Independent SDK 36/37 signature,
nondebuggable-manifest, payload/provenance and 16-KB ZIP/native checks also pass. The existing
New-session-note layout check passes its control/restored run and catches four additional mutants. APK SHA-256:
`ae052a8a02567c42576012309c5de059827d8b9ff28a9972673af0440d977341`. Artifact:
`.nodeterm/android-beta-11/nodeterm-android-0.1.0-beta.11.apk`; build/regression proof:
`.nodeterm/android-beta-build-11/`. **Prepared, not installed:** beta 10/code 11 remains the last
confirmed phone installation. Phone checks and final fixture/rotation cleanup stay paused;
10 Pass / 22 Partial / 32 Pending remains the device ledger. These source/build checks do not
verify the new touch/keyboard, multi-host freshness or included-key pairing flows on the Pixel.

> **Status (2026-10-04): beta 10/code 11 is installed; paired update passes.** Focused
> plain-SSH creation/history/reconnect and exact End pass on the Pixel (item 32 Partial).
> Fresh-desktop pairing received no relay credential after an observed backend refusal (A93);
> the empty-host loading correction (A94) is delivered and its full focused empty-host flow passes. CI builds the debug APK. The
> private minified beta is installed on the Pixel 10 Pro (Android 17 / API 37); manual SSH lists real
> projects after the update. Historical proof retained through beta 6 covers basic terminal input,
> the code-3 viewport/history correction (`A85`), user-confirmed terminal access with Wi-Fi off over
> mobile-data WireGuard, real SSH background/detach recovery and Inbox/back-stack restoration.
> Encrypted paste pairing and live hosted relay browsing also have historical beta-6 proof. QR pairing, cellular relay,
> actual outage/answer behavior and the full device pass remain unverified. A95's desktop Board fix passes actual phone-to-mounted-desktop verification (item 36). The plan and what is still open are in
> [`docs/android-handover.md`](../docs/android-handover.md); the findings are in
> [`docs/android-audit-2026-09.md`](../docs/android-audit-2026-09.md).

**Current private beta and paired update (2026-10-04):** `0.1.0-beta.10` / code `11`,
clean snapshot `e3ce041c752bdef11b378cf301c719a6e62f70ab`, is installed on the intended Pixel with the
unchanged private signer. The actual release build passes in 52.4 seconds with all R8 keeps;
independent SDK 36/37 signature, 16-KB alignment, payload and provenance review passes.
APK SHA-256: `04ace0ea01540bb477fcf823395a299fa211cfef3745aa28674099038ceb3693`. The 10.14-second
same-signer update preserves install identity, notification grant and the owned SSH second
pane. On beta 9, genuine desktop-issued code text re-pairs the complete original owned desktop
profile and receives relay credentials; safely anchored external SSH refuses, then Automatic
falls back to the actual relay. After updating, that saved
pairing reconnects without re-pairing; the own Terminal1 opens and input reaches its real scoped
PTY. **Items 1/36/51 pass; items 35/49 remain Partial, giving current 10 Pass / 22 Partial / 32 Pending.** Debug-key update/migration
variants remain conditional SKIP on this working private installation. The same owned production
desktop profile now runs repaired build `ec12ea9a`; the original failure was on `071735d6`. Local gates pass 689 protocol tests /67 suites with zero
failures/errors/skips (86.08 seconds wall time including a new daemon), offline app compile
(6.78 seconds), 54 affected Vitest tests and full TypeScript checking. The exact built source `e3ce041c` has all five CI jobs green in [run `37194375778`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37194375778). Each later documentation push needs its own green workflow. Private artifact/proof:
`.nodeterm/android-beta-10/` and `.nodeterm/android-beta-build-10/`; the canonical paired-update receipt is `.nodeterm/android-beta-build-10/paired-update-result.json`. Broader relay/managed,
cellular and the full device checklist remain open; installed A91/A94 full focused empty-host flow passes.

**Relay creation, Rename and exact End verified; Refresh dispatch observed (2026-10-04).** On
beta 10, Sessions → New session → Terminal (shell) → Start creates and opens one actual
canvas-registered shell in the exact private project folder. Native input and pwd reach its
scoped bash pane. Rename updates the mounted desktop title without reload. Sessions Refresh
rediscovers both owned rows; the actual owned session-menu Refresh emits exactly one node-refresh
IPC, preserving pane identity and page time origin. Its repaint effect remains unverified.
Exact native End then removes only the adopted node/pane/PID birth; the original producer
terminal remains unchanged. The mounted Board also removes that card without reload.
Item 32's relay plain-shell variant passes; managed-account/cellular and other required variants
remain pending. Item 35 stays Partial for missing Wake and Refresh repaint evidence; item 36
passes actual repaired-desktop move/remove/re-add/create-label checks (A95). Earlier first-round rotation restoration is historical; final restoration remains pending. The tally is 10 Pass / 22 Partial / 32 Pending; no full release/device pass
or final fixture/service cleanup is claimed.

**Settings visible flow passes; item 49 remains Partial (A44, 2026-10-04).** On installed beta 10,
a temporary phone name and safe HTTPS loopback API persist after actual system Back and reopen.
An invalid HTTP address shows its field error after keyboard dismissal and a visually reviewed rejection toast; reopening
retains the prior valid HTTPS value. Reset to default, system Back and reopen restores the built-in
API; the original phone name/API are then restored and verified. Unedited leave/reopen preserves
the visible values. Internal preference-key absence and absence of writes were not physically
inspected on this nondebuggable app; existing `SettingsLeaveTest` behavior/source guards cover
those rules. The strict device ledger therefore marks item 49 Partial, giving 10 Pass /
22 Partial / 32 Pending. Native proof includes `beta10-settings-phase1-result.json`,
`beta10-settings-phase2-result.json` and `beta10-settings-toast-visual-review.json` in the Oct4
checklist directory.

**Final phone cleanup and background watch remain pending (2026-10-04).** The intended Pixel's
wireless ADB endpoint is no longer reachable; its current endpoint has been requested. The guard
refused before the final phone Forget and portrait-lock restoration, so neither action is claimed.
Earlier rotation restoration belongs to the first test round; current final restoration is pending.
The isolated empty SSH service is stopped. Phone name/API and system night mode `yes` restoration
are verified. No natural-periodic background Done watch has started and no result is claimed.
The remaining phone cleanup and notification checks can continue when the correct Pixel returns.

**Phone system-theme compatibility passes (item 51, 2026-10-04).** On the installed beta 10
Pixel, Computers and Settings native screens remain readable under system dark and light modes,
including status/navigation bars; four captured PNGs have a matching visual-review receipt.
The app retains its fixed dark palette in both modes; an automatic light app palette is not claimed.
Original system night mode `yes` is restored and verified. Tablet/foldable is conditional SKIP
because neither is available. Proof: `beta10-system-theme-result.json`,
`beta10-system-theme-restored.json` and `beta10-system-theme-visual-review.json` in the Oct4 checklist
directory. Item 51 passes, giving the current 10 Pass / 22 Partial / 32 Pending ledger.

**A95 is fixed and verified on the rebuilt production desktop (2026-10-04).** The held
`071735d6` build reproduced stale mounted Board moves/labels. The same owned paired profile now
runs the repaired `ec12ea9a` production build; Android remains installed beta10/code11 (`e3ce041c`),
with no APK change for this desktop fix. Actual phone Move to Ungrouped, label removal, re-addition
and creation/application of a second blue label update both persisted state and the mounted
desktop Board without a reload. Baseline and every resulting DOM snapshot share page time origin
`1791111312961.1` and match persisted state. This completes item 36. Nine affected Vitest suites
(133 tests), full and strict acceptance TypeScript checks, and four isolated mutants also pass.
The ledger is 10 Pass / 22 Partial / 32 Pending. This verifies the owned production fixture;
no deployment to the user's regular desktop or full release/device pass is claimed.

**Desktop continuation (`A92`, 2026-10-04):** the shared Desktop/Server renderer now keeps the
hovered row inside its capped wrapped-link paragraph. The focused 24-test Vitest file, all 54
affected link/dialect tests, full TypeScript check and three isolated mutants pass. Fixed in
`127b6b28`; interactive desktop hover remains pending. Android already fixed this in `A32`; no APK or host
contract change, iOS adoption or new phone result follows. This desktop fix alone does not change the installed APK or checklist tally.

**Fresh-desktop relay pairing refusal (A93, open; 2026-10-04).** The same Pixel identity
paired with a fresh isolated production desktop whose remote access was on, but the saved
pairing had no relay credential. A bounded retry using the exact unchanged production request body
returned HTTP 403 reauth_required. Forgetting the old fixture removed its phone-side relay
token; the new desktop has a different identity. The refusal is measured. Original
same-desktop recovery succeeds after ordinary restart of the complete original owned fixture
profile: unchanged host/device identity, genuine beta-9 re-pairing and actual relay credentials.
No backend repository was reviewed, phone identity reset or user credentials copied. This
measures one legitimate recovery case; fresh-different-desktop refusal remains open.
**iOS follow-up for @eneskirca:** verify prior-token lookup and recovery messaging for the same
persistent phone identity after Forget; no new wire field is introduced here.

**Empty-host loading follow-up (A94, fixed in 3c217cba; delivered in beta 10).** On beta 9,
the otherwise-empty SSH fixture completes its listing and shows the error banner, Over SSH and
New terminal, but still says “Loading sessions…”. The initial empty snapshot's zero fetch
timestamp causes that label. The correction stamps the completed empty answer; five actual
Kotlin regression methods and eight isolated mutants pass. Full Gradle checks and beta-10
delivery and installed full focused empty-host End/recreate/open/End verification pass. No host contract changed.

**Installed A91/A94 focused empty-host cycle passes (2026-10-04).** On beta10/code11,
native End of the otherwise-empty fixture's sole owned Home shell removes its row/group and
shows “No sessions on this computer yet.” with no Loading label; Over SSH and the data-not-found
banner remain. New terminal → Home → Create opens a new actual bash pane in Home. Back to
Sessions and exact native End removes that new UUID and restores the same completed empty
screen. All three isolated host sockets are empty. Proof:
`.nodeterm/android-beta-build-9/checklist-20261004/beta10-a94-full-cycle-result.json`,
`beta10-a94-recreated-pane.json` and the matching empty-screen UI receipts. This passes the
focused A91/A94 empty-host flow; item 32 remains Partial because managed and cellular
creation remain open; the relay plain-shell variant passes. Total 10 Pass / 22 Partial / 32 Pending. Final fixture/service cleanup is
not yet claimed.

**Beta 6 verifies continuous dragging, coast, Esc and new-touch stopping (`A86`, `A89`).** SSH
reopened on the intended Pixel with its retained key/pin at 56×48. `c4b1f6cf` targets the stable
screen behind changing text, fixing beta 5's detached touch target. Code 7 passes 658 protocol tests and
release/R8/signing checks. A held touch stops coast at a stable 56×25 keyboard-open viewport;
earlier resizing tap checks were inconclusive. The user confirms normal dragging and coasting
both work now. Remaining lifecycle checks, FPS and custom bindings remain open.

**Requirement-audited real Pixel QA:** complete checklist passes are **1, 18, 19, 21, 22, 24, 36, 38, 39 and 51**:
SSH software input/key chips/font/rotation survival, Unicode rendering,
large/invalid OSC52 handling, all three keyboard-focus states, and background-process tab/back-stack
restoration and the shipped managed-hook Approve/Deny/expiry lifecycle. The hook producer is
synthetic; no live Claude CLI/account or requested Bash execution was involved. Seventeen sending
chips plus four app-mode arrows and font/rotation complete item 18 on the existing proof;
wrapped/OSC8 links, Copy-sheet Unicode/Share and real SSH recovery have partial evidence. Landscape with IME open
was 129×1; usable-height and larger-client Fit checks remain open. The [64-row result table](../docs/android.md#what-is-verified-and-how)
records ten Pass, 22 Partial and 32 Pending items with conditional SKIP variants. Item 1 adds
paired-update proof; the focused A90 proof leaves item 32 Partial. The earlier 7/20/37 checkpoint used beta6/code7. Encrypted PairingService JSON paste and **Only through the relay**
browse succeed against production desktop source `58a202be`, with the actual hosted API/relay;
the current `/v1/relay/join` shape is verified beyond interop tests. Remote access was already
enabled, so this pairing approves the phone without a first SAS prompt. The desktop uses an
isolated home and real SecretService encrypted credential storage; no user credentials were copied.
The phone also attaches and sends echo input through the relay to an owned real PTY, created by
production preload/Canvas events rather than phone New session. At that stage checks passed all 658
protocol tests in 63 suites (54 seconds) and offline app `compileKotlin` (5 seconds).
Mounted relay single-select answers and multi-select Open-session/input reach the synthetic
application and its actual PostToolUse/mirror. A one-tap answer from copy mode also reaches the
application, leaves copy mode and resolves the question. Item 41 stays Partial: offscreen/released,
direct-SSH and target-guard variants lack device proof. No live Claude CLI/account was used.
QR/scanner, cellular relay, SAS denial/revoke, remaining node actions, remaining question routes,
notifications
remain open. Recorded prior all-green branch CI is `19da35a2`, all five jobs in [run `37140762345`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37140762345). Installed beta 9 is separately bound to `4d33a5b5`, whose source CI failed the documentation checklist mapping. Each later push still requires its own green workflow.
Only disposable fixture resources were removed and the phone returned to regular Sessions;
cleanup does not establish the full revoke matrix. **Final beta-6/code-7 cellular check:** with
WireGuard enabled and Wi-Fi off, the user confirms "Connects and scrolls smoothly" in their usual
manual-SSH terminal, confirming connection and smooth scrolling. Cellular hosted relay remains untested;
item 20 stays Partial and the full 64-item pass remains open. No runtime change or phone command
was needed. The 50/1-second protocol/offline app tasks at that stage are historical; current A90
checks are recorded below. Each subsequent push still requires green CI.

The user resumed remaining Pixel release checks on 2026-10-04 after the hike. The requirement review adds
item 18's Pass without new phone work; viewport/Fit remains item 23's open scope. Item 1 requires
desktop-issued pairing/relay credentials through a higher-code update, using JSON or QR. Full
release readiness, hosted cellular relay and live-Claude checks remain unverified.

Historical private `0.1.0-beta.7` / code `8` was **prepared, never installed**, from
`b53610deb3843b59fa6a1bed5bdc5f36da0f5146`, using the retained signer. Local AGP built in
47 seconds; R8 and packaging passed. APK SHA-256:
`5141c6484b422b236a98213731076be621c4d14a55f47c79bfd989fb23609e6a`.
Ignored proof/artifacts are in `.nodeterm/android-beta-build-7/` and `.nodeterm/android-beta-7/`.
Beta 8 below replaced it and is now installed; beta-7 preparation added no runtime
fix or device pass.

**Plain SSH terminals (`A90`) are implemented and host-verified.** On the Linux SSH host, use
**Sessions → New terminal → Home folder / project folder / custom absolute folder → Create**.
The shell appears under **Phone terminals**, persists when the viewer/app closes, and can be
reopened or stopped with that row's **End session…**. These are independent shells, with no
automatic desktop-canvas registration or managed-agent identity. Protocol `bcc92367` and UI/model
`b88d1415` preserve existing cold-agent SSH refusal and relay canvas creation. All **684 protocol
tests in 66 suites pass with zero failures/errors/skips** (48 seconds), offline app `compileKotlin`
passes (1 second), and **32** protocol/helper/native-wiring mutations are caught (11/12/9).
Desktop and Server Edition retain their own sockets and canvas behavior; existing RPC, projects
blob, pairing, mirror and SSH-visible file contracts are unchanged. **iOS follow-up for @eneskirca:**
adopt the isolated phone socket and atomic creation marker/session metadata for independent shells.

**Focused physical A90 checks pass on the intended Pixel.** Beta8/code9 creates Home, discovered
project and custom-folder shells (spaces/apostrophe/dollar), with verified cwd/input/pre-attach
history, continuous dragging/coast/Esc, rapid double-Create without duplicates and visible
missing-folder refusal followed by a corrected retry. Force-stop/restart retains three PIDs and
history; beta 9/code 10 update, reconnect and same-pane input also pass. Native UI End of custom,
project then Home removes only each selected UUID, retains sibling fingerprints/PIDs and clears
the final Phone terminals group. Eleven desktop sessions/PIDs and nine project/workspace hashes
are unchanged; owned shells/folders/UI dumps are removed and the phone returns to regular Sessions.
Proof: `.nodeterm/android-beta-build-8/a90-pixel-check-20261003/final-focused-results.json` and
`beta9-exact-ui-end.json`. **Item 32 remains Partial; this Oct3 checkpoint was 7 Pass /21 Partial /36 Pending.**
Relay canvas/managed and cellular creation remain pending. The separate A91 otherwise-empty-host
variant passes on beta 9 on 2026-10-04. Broader release checks resumed on 2026-10-04; new outcomes are recorded separately.

**Empty-host refresh fix (`A91`) is delivered in beta 9/code 10.** Ending the last phone shell
on an otherwise empty SSH host returns an authoritative "nothing found" answer. Beta 8
kept its stale cached row; `4d33a5b5` now clears that listing while preserving the error and
connected SSH route. Other failed refreshes keep the last listing, and cancellation propagates.
The full real Gradle suite passes **688 tests / 67 suites**, zero failures/errors/skips (52 seconds),
offline app `compileKotlin` passes (6 seconds), and six isolated Kotlin 2.2/JDK 21 mutants are caught.
Proof is in `.nodeterm/android-beta-build-9/`. No shared host contract changes.
**Physical empty-host variant passes (2026-10-04).** On installed beta 9, the otherwise-empty
private SSH fixture creates and opens a first Home shell. Native End removes its exact row and
Phone terminals group while SSH stays connected. New terminal then creates and opens a second
Home shell, then retained for the beta 10 update and subsequently ended in the A91/A94 flow above. This is not final fixture cleanup.
Proof: `.nodeterm/android-beta-build-9/checklist-20261004/a91-beta9-focused-results.json`.
A94's loading-label correction is delivered in beta 10 and the full installed empty-screen End/recreate/open/End cycle passes.
Item 32 stays Partial; item 1 separately brings the current tally to 10 Pass / 22 Partial / 32 Pending.

**Historical beta-9 delivery:** `0.1.0-beta.9` / code `10`, clean source
`4d33a5b5366c99479b648086649205350c7752b1`, built in 43 seconds and updated the exact intended
Pixel with the retained signer in 6.46 seconds. The pulled installed APK matches SHA-256
`719cfeea1dcf27900dd35692a59004ca07e8261b3f14bd43922f0706b6b4ab54`.
Three owned beta-8 shells survived the update and were rediscovered on beta 9, then all were
ended through verified exact-session cleanup. Historical source CI
[run `37144282865`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37144282865) failed the
device-checklist documentation mapping; debug/release APK and CodeQL jobs passed, private-beta
packaging was skipped. Do not treat it as green; the next push needs its own passing workflow.
This revision maps A91 into item 32 and isolates its Known gaps paragraph. The recorded local
688/67 source baseline predates the final documentation; fresh required gates follow the frozen
docs, and the final exact-head CI receipt is retained separately after pushing.
Independent SDK 36/37 signature/alignment, unchanged signed payloads, R8/service metadata and
source/hash provenance checks pass. The non-debuggable installation preserves install identity,
notification grant and app data; paired relay survival was unverified at that checkpoint and
is now proven by beta9→10 above. Historical receipts:
`.nodeterm/android-beta-build-9/artifact-review.json` and
`.nodeterm/android-beta-build-9/device-install-20261003/receipt.json`; private APK:
`.nodeterm/android-beta-9/nodeterm-android-0.1.0-beta.9.apk`.

**Historical installed beta 8, now superseded by beta 9:** private `0.1.0-beta.8` / code `9`, from clean source
`b88d141528c1051964da07faf22cc7fa923c4846`, using the retained signer. Offline AGP built in
49 seconds; R8 keeps, signature, 16-KB alignment and source/hash provenance checks pass.
Independent SDK 36/37 signature/alignment, unsigned-payload preservation and R8 service-mapping
checks also pass. APK SHA-256:
`d373ad5c1790f714cb4464ad4a0a38c5ba9ab68e35103e54cf3aef5ce53081ce`.
Private APK: `.nodeterm/android-beta-8/nodeterm-android-0.1.0-beta.8.apk`; proof is in
`.nodeterm/android-beta-build-8/`. The exact Pixel 10 Pro / Android 17 received a 28.05-second
same-signer update without uninstalling. Pulled before/after APKs match beta 6 / beta 8, the public
signer matches, and code 9/name beta 8/non-debuggable metadata is confirmed. Install identity and
notification permission remain; the app starts and the existing manual-SSH host entry is present.
Opening that host reconnects over SSH and loads real driven projects. **New terminal** is visible
and enabled/clickable; no existing pane was touched and no terminal was created or ended. This
does not establish creation/persistence/End or paired relay-credential survival. Receipt:
`.nodeterm/android-beta-build-8/device-install-20261003/receipt.json`.
The later beta9→10 paired update above passes item 1 without uninstalling the working app.
Future private betas retain the same signer and increase the version code. Verify real SSH creation/cwd/input/history, disconnect/app-restart
rediscovery and exact End ([item 32](../docs/android.md#device-checklist)). Historical beta-6 proof
and its historical **7 Pass / 20 Partial / 37 Pending** checkpoint are preserved; focused A90
proof changes item 32 to Partial. Item 1 and later item 36 pass, giving current **10 Pass / 22 Partial / 32 Pending**. Debug migration stays
conditional SKIP on the working Pixel.

## What it does

The APK is built by CI. The signed minified beta has real Pixel terminal/copy/keyboard and partial
SSH/link/lifecycle evidence; the feature rows below still require the full device pass. ✓ means the code is written for it and
tested where the layer allows, and the numbered
[device checklist](../docs/android.md#device-checklist) is what will check it.

| | Android | Notes |
|---|---|---|
| Pair by QR (or pasted code, or a `nodeterm://pair` link) | ✓ | E2EE-sealed `/pair`, Ed25519 key made on the phone |
| Add a computer by its SSH address ("Add SSH server") | ✓ | For a computer with no pairing code: a headless Server Edition, or a macOS / Linux host you reach only over SSH. Shows the phone's key line (copy, share, or a one-line command) to add to `~/.ssh/authorized_keys`; Connect pins the SSH host key once the computer accepts that key, and shows the fingerprint to compare. **SSH only**: no relay (so no canvas-registered new session, board writes, node actions or source control from the phone, and nothing "from anywhere" beyond what reaches its SSH, a VPN say) and no push. No password login, no Windows |
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
| New plain terminal on an SSH host | ✓ (`A90`, installed beta 10/code 11) | Focused Pixel Home/project/custom cwd/input/history, restart/update/reconnect and exact End pass. Independent Phone terminals group; no desktop canvas/agent registration. Item 32 Partial: relay plain-shell creation/input/End pass, managed and cellular creation pending; A91 empty-host variant passes |
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
CI4 still failed private packaging. [Run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming
observed CI repair. Any later push still requires its own green workflow.

1. Prepare and install the [private beta](#private-beta) below from a successful local build or CI
   run of the current branch. The desktop must also include the host-side fixes you want to test. Future private beta
   updates use the same private signer and a higher version code, preserving pairings.
2. For a VPN/SSH route, connect the VPN, use Add SSH server and compare the host-key fingerprint
   with the computer. For the relay route, turn on remote access in Settings → Phone, pair, and open the computer in the
   app. If either screen asks for a first relay approval, compare and approve its code there.
3. Turn the phone's Wi-Fi off. Open a terminal over mobile data, send a harmless command, answer a
   question and a held approval, then reconnect after briefly enabling airplane mode. Confirm the
   answers on the computer. For SSH, keep the VPN active and confirm the route stays SSH; for the
   relay route this checks cellular connectivity and action/recovery behavior; the current live
   join contract already passed the controlled relay-only browse check.
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
connection was attempted. At that stage the same code-2 beta was installed on the intended Pixel 10 Pro,
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

**Historical stable-touch beta (`A89`):** `0.1.0-beta.6` / code `7` uses source
`c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6`. It targets the stable xterm screen behind changing
rows. Real-bundle redraw regression delivers 24 notches versus one with a detached touch target.
All 658 protocol tests in 63 suites and offline app `compileKotlin` pass; 35 JS, eleven native
and three CSS mutations were caught. Actual AGP release built in 43 seconds and passed every
R8 keep. Retained-signer packaging verifies non-debuggable metadata, signature, 16-KB alignment
and source/hash provenance; all 149 ZIP payloads remain unchanged by signing. APK SHA-256:
`4947133a6ccf9c2b1e775e76d7c24f564e087cf036e59eac4dca08162a076d3c`.
The intended Pixel received a same-signer update preserving app data; notification permission
is confirmed. SSH reopened with the retained key/pin at 56×48. A slow swipe produced 23 position
updates; a fast swipe kept moving for about 799 ms after its ADB command completed, and Esc
left copy mode for the following 1.4 seconds. A held touch stops coast at a stable 56×25 viewport,
with position unchanged through CANCEL after 1.2 seconds. Earlier keyboard-resizing touch checks
were inconclusive. The user confirms normal continuous dragging and coast both work now.
The final user check also confirms beta-6 manual-SSH connection and smooth scrolling on cellular WireGuard with
Wi-Fi off; cellular hosted relay remains untested. Reversal/lifecycle, FPS/custom-binding checks
and full device validation remain open
in the [handover](../docs/android-handover.md#progress-log).
Testing returned the app to Sessions, detached the owned client and removed only its exact owned
tmux session and phone UI XML; private `device-summary.json` records cleanup.

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
not momentum-success proof. The newer beta-6 checks and user confirmation above establish
drag/coast success.

**Packaging CI (`A88`, `f5fd3821`):** CI run `37058184031` passed its four main jobs but failed private
packaging. Real SDK 37 reproduces the new `V3.0 Signer:` format; the follow-up accepts exact
scheme labels while retaining one pinned certificate and verified v2. All 39 Python tests pass
against each SDK 36/37, and ten new parser/fixture-selection mutations are caught. The fixture
now uses CI's installed SDK 36/platform 35 explicitly. [Run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming
observed packaging repair.

**Historical beta-4 correction:** source `3cffb49d8cf64932260e914b42b3883331d0352d`, version
`0.1.0-beta.4` / code `5`, retains the same signer. All 646 protocol tests in 62 suites pass with
zero failures, errors or skips; offline app `compileKotlin` passes (8 seconds). Real xterm
focus/mouse/query reports preserve gestures, while actual keyboard/paste/IME input cancels them;
22 JavaScript and nine actor/native-wiring mutations were caught. `fed68fb3` verifies newer SDK
signer labels without relaxing the expected-certificate/v2 policy; 32 Python tests and ten
mutations pass locally. At that checkpoint, CI repair still required confirmation; the later
`f5fd3821` follow-up and green run above provide it.
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
first finished APK/checksum/metadata in `.nodeterm/android-beta-1/`. At that first-beta checkpoint,
QR/code pairing, relay and mobile reconnect/background/answer checks remained open. The initial full protocol run passed 603 of 605 tests; the two SSH
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
floor), and live while the computer or All computers is on screen. An individual computer or
terminal refreshes its host every 8 seconds; All computers refreshes every paired host while visible.
Other paired computers are not polled while you look at one individual computer, so their notifications still come from
the background check only. That includes a computer you just left: the app may still hold its
connection for a while, but no longer re-lists it when it pushes a change. All computers stops its
polls when it leaves the screen and closes connections after their last active user finishes.
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
  Real Pixel paired update, SSH/input/font/history, clipboard and keyboard checks work; ten complete checklist
  items pass, and encrypted paste pairing/live relay browse/input plus synthetic shipped-hook
  Approve/Deny/expiry and mounted relay question/copy-mode answers also work. QR/cellular-relay/SAS/worker
  and remaining device variants remain unverified. Keep USB and wireless debugging off when not using them.
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
