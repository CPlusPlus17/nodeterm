# Android companion: audit findings (2026-09-25)

Generated from the adversarially verified audit run `wf_cfa3d2db-264` (170 agents). Six auditors covered build, protocol, runtime, security, iOS parity and CI/docs; a completeness critic ran afterwards. Refuters checked every finding against the source (two refuters for high/critical findings), then an impact judge re-rated its severity. **All 77 findings survived and none were refuted.** Treat that with some caution: a fix session should re-read the cited code before changing it. Line numbers refer to commit `2f58918`.

Severity is the impact judge's rating, not the auditor's claim. **BLOCK** means the judge said it blocks a first sideloaded release. Effort is the judge's estimate.

Prioritised plan and handover: [`android-handover.md`](android-handover.md).

**Status of fixes.** A fixed finding is marked `✅ fixed in <sha>` in the index, and a finding
deliberately not built is marked `📝` with the reason; its section below
keeps the original audit text (line numbers still refer to `2f58918`). Continuation findings
`A78`–`A80` were confirmed against cached branch tip `6afd8f53` on 2026-10-02; their local
fix commits were initially checked only within a restricted sandbox. Later local AGP work found
`A83`, and the first full local protocol run found the test-isolation fault `A84`; current build,
full-suite and phone verification are tracked in the handover. The private APKs use authorized
local builds; each requested push requires green Android workflow verification. Where the fix departs from
the audit's proposal, the handover's progress log says how and why.

## Index

| ID | Sev | Block | Effort | Area | Title |
|---|---|---|---|---|---|
| [A01](#a01) | high | BLOCK | small | build/bug | ✅ fixed in `af1f820` · Direct-SSH terminal writes and resizes run on the Android main thread, which breaks the SSH connection as soon as the keyboard opens |
| [A02](#a02) | high | BLOCK | small | protocol/bug | ✅ fixed in `e7c22eb` · SSH browse looks for the desktop's userData under 'nodeterm', but the desktop writes it under 'node-terminal', so every direct-SSH listing comes back empty |
| [A03](#a03) | high | BLOCK | small | protocol/bug | ✅ fixed in `cd69a1e` · The direct-SSH tmux client starts without a UTF-8 locale, so tmux replaces every non-ASCII character with '_' |
| [A04](#a04) | high | BLOCK | small | runtime/bug | ✅ fixed in `af1f820` · SSH terminal writes and resizes run on the main thread, and the NetworkOnMainThreadException that runCatching swallows leaves sshj's cipher state out of sync, which drops the whole SSH connection |
| [A05](#a05) | high | BLOCK | small | runtime/risk | ✅ fixed in `3d36d60` · The background InboxWorker can open a never-approved relay handshake and raise the desktop's SAS approval dialog while the phone shows no code |
| [A06](#a06) | high | BLOCK | small | security/bug | ✅ fixed in `16706f4` · approvals.answer reports success for a hold that already timed out, and clears NEEDS YOU on every surface |
| [A07](#a07) | high | BLOCK | medium | critic/bug | ✅ fixed in `0fa0646`; follow-ups `c199349`, `a988a30` (revoke closes a live relay session), `f66fddf`, `07b7276` (a late-adopting paired phone is approved on its first handshake) · Remote access fails the first time you are away from the computer: Auto never does the first relay handshake while the phone is at the desk, and pairing does not pin the phone's relay key |
| [A08](#a08) | high | BLOCK | small | critic/bug | ✅ fixed in `1cdd2f0` · A cold attach over direct SSH creates the desktop's tmux session with no hook environment, so an agent resumed there never reports status, and the desktop never repairs it |
| [A09](#a09) | medium | BLOCK | small | protocol/bug | ✅ fixed in `726271a,1cdd2f0` · Nodes of SSH projects open against the desktop's LOCAL tmux, creating an empty phantom session and offering to resume the conversation on the wrong machine |
| [A10](#a10) | medium | BLOCK | small | ci-docs/risk | ✅ fixed in `fcda932` · Debug APKs from CI change signature from run to run; README offers them as the install route, and updating means uninstalling, which wipes pairings |
| [A11](#a11) | medium |  | small | build/bug | ✅ fixed in `de1eded` · Tapping an Inbox notification while the app is in the background does not open that computer |
| [A12](#a12) | medium |  | medium | protocol/bug | ✅ fixed in `ab1335c`; follow-up `8430243` (SSH-project nodes typed over their ControlMaster) · Relay sendKeys (question answers, legacy approvals) writes into a pty that does not exist yet and then kills it immediately, so the keystroke can be lost while the UI reports success |
| [A13](#a13) | medium |  | medium | protocol/bug | ✅ fixed in `68d0925` (phone), `b718a04` / `ed2965be` (desktop, both routes); seven real tmux methods, eight Linux native checks and 24 distinct assertion mutants, physical pending · Registering a phone-started node while the phone is attached lets the desktop's own client attach with `-D`, which detaches the phone; Android then reports the session as ended |
| [A14](#a14) | medium |  | small | protocol/bug | ✅ fixed in `c58ad65` · New sessions in cwd-less (inline) projects are never registered: the desktop refuses them, the refusal is ignored, and the session is orphaned |
| [A15](#a15) | medium |  | small | protocol/bug | ✅ fixed in `c58ad65` · The cold-attach resume offer drops the node's managed Claude account (and on the relay, its cwd), so the resume fails with 'No conversation found' |
| [A16](#a16) | medium |  | small | protocol/gap | ✅ fixed in `c58ad65` · The phone's launch ignores the project's own permission mode (and default account), so a project the user set to a stricter mode starts in the global mode |
| [A17](#a17) | medium |  | small | protocol/risk | ✅ fixed in `3d36d60` · The background inbox worker dials the relay for unapproved phones, putting the desktop's SAS approval dialog up every 15 minutes with no code on the phone to compare it against |
| [A18](#a18) | medium |  | small | runtime/bug | ✅ fixed in `10de4b9` · No lifecycle handling: a backgrounded app keeps the 8 s poll and its relay terminal stream alive indefinitely |
| [A19](#a19) | medium |  | small | runtime/bug | ✅ fixed in `de1eded` · Tapping an inbox notification while the activity is alive ignores the target computer |
| [A20](#a20) | medium |  | small | runtime/bug | ✅ fixed in `d199f03` · Cancelling an in-flight connect leaks the SSH connection and records the cancellation as a connection failure |
| [A21](#a21) | medium |  | small | runtime/bug | ✅ fixed in `daf15d3` · A denied POST_NOTIFICATIONS is never re-requested, and the Settings switch still reads On |
| [A22](#a22) | medium |  | small | runtime/bug | ✅ fixed in `ade7428` · The Navigator back stack is not saved across activity recreation, and the original launch intent is re-applied |
| [A23](#a23) | medium |  | small | security/risk | ✅ fixed in `3d36d60` · Background inbox worker opens unapproved relay connections, raising desktop SAS approval dialogs the phone never shows |
| [A24](#a24) | medium |  | small | security/bug | ✅ fixed in `8e304db` · SecureStore treats ANY decrypt error as 'absent', so getOrCreate32 permanently overwrites the phone's identity |
| [A25](#a25) | medium |  | medium | parity/gap | 🟡 in-app part fixed in `4ffb8b7`, `0d310cc` (notification actions, the tap opens the session); FCM push is still a backend gap · No real push notifications: 15-minute background polling, no notification actions, no Live-Activity equivalent, and the desktop's phone-push switches are ignored |
| [A26](#a26) | medium |  | medium | parity/gap | ✅ fixed in `9cdc4cf`, `1eeb5b8` · New session and board edits were unavailable on the LAN (direct-SSH) connection that Auto picks first; iOS does both over SSH. A108 now serves owned Board writes and Desktop delivery-only nudges over SSH; A90 adds separate plain SSH shells. Canvas registration remains relay-routed |
| [A27](#a27) | medium |  | large | parity/gap | ✅ fixed in `8691e6d`, `9b5c342`, `1d8201f`, `c450e16` · Cannot connect straight to a Linux dev host or a headless Server Edition (iOS's "phone SSHes into the host" setup) |
| [A28](#a28) | medium |  | small | parity/gap | ✅ fixed in `726271a,1cdd2f0` · SSH-project sessions over direct SSH are attached, approved and resumed on the wrong machine |
| [A29](#a29) | medium |  | medium | parity/gap | ✅ fixed in `0c5a1e1`, `a5f38f5` · No source-control screen, although the protocol layer already implements the git verbs iOS uses |
| [A30](#a30) | medium |  | small | critic/bug | ✅ fixed in `3d36d60` · Pressing Deny on the desktop is not respected: the phone re-dials about 8 s later and the SAS approval dialog reappears |
| [A31](#a31) | medium |  | small | critic/bug | ✅ fixed in `a622e71` · A silently dead SSH peer (laptop asleep, desktop IP or VPN change) wedges the host as 'On your network' for many minutes: no detection, no relay fallback, and the error is never shown |
| [A32](#a32) | medium |  | medium | critic/gap | ✅ fixed in `7035bde`, `88beed2` · No way to open a URL or copy text from the phone terminal: no link detection, no touch selection, and the WebView cannot show xterm's link confirm |
| [A33](#a33) | medium |  | medium | critic/bug | ✅ fixed in `0db0b6e` · On a Windows computer, 'New session' starts the agent in the user's home folder instead of the project, and silently drops the chosen Claude account while still registering it |
| [A34](#a34) | medium |  | small | critic/bug | ✅ fixed in `2a273a7` · The Ctrl key-row chip does not apply to text sent from the input bar: arming Ctrl and sending 'z' submits a literal 'z' plus Enter |
| [A35](#a35) | medium |  | small | critic/bug | ✅ fixed in `16706f4` · approvals.answer returns `answered:false` both for 'already handled' and for 'the write failed'; the phone always says 'Already handled.' |
| [A36](#a36) | medium |  | small | critic/gap | ✅ fixed in `2a273a7` · After any connection drop the terminal stays on 'Disconnected. [Reattach]' even though the host connection reconnects by itself |
| [A37](#a37) | low |  | small | build/risk | ✅ fixed in `ac0923a` · proguard-rules.pro would not survive turning on minification (R8 missing-class errors) |
| [A38](#a38) | low |  | small | protocol/bug | ✅ fixed in `5ff8f6c` · Quick approve requires the node to be exactly 'blocked', but the desktop publishes approval tickets while the node stays 'waiting' on a held question |
| [A39](#a39) | low |  | small | protocol/bug | ✅ fixed in `437e359` · The account chip reads `account.label`, which the mirror never writes, so it falls back to the raw account UUID |
| [A40](#a40) | low |  | small | runtime/bug | ✅ fixed in `a38d39d` · The pending-launch path and the attach hand-off never re-check `disposed`: a stream can stay attached forever, or a phone-started node gets registered with no agent launched |
| [A41](#a41) | low |  | small | runtime/bug | ✅ fixed in `94a558a` · The composed prompt is cleared even when no stream is attached, so the text is silently lost |
| [A42](#a42) | low |  | small | runtime/bug | ✅ fixed in `7debe67` · NewSessionDialog crashes if the selected project disappears while the dialog is open |
| [A43](#a43) | low |  | small | runtime/bug | ✅ fixed in `2be5e87` · The HostScreen tab and scroll position reset after returning from a terminal |
| [A44](#a44) | low |  | small | runtime/bug | ✅ fixed in `7988087` · System back discards Settings edits (device name, relay API base) |
| [A45](#a45) | low |  | small | runtime/risk | ✅ fixed in `1901939` · No onRenderProcessGone handler on the terminal WebView |
| [A46](#a46) | low |  | small | runtime/bug | ✅ fixed in `17ee526` · The ⌨ key-row chip only focuses the DOM textarea, which cannot raise the soft keyboard |
| [A47](#a47) | low |  | small | runtime/bug | ✅ fixed in `52df0a3` · The Keystore decrypt runs on the main thread in the host list's composition, once per row per recomposition |
| [A48](#a48) | low |  | small | runtime/bug | ✅ fixed in `d383e76`; follow-up `6afd8f5`, `a65e12f` (the seen log is keyed by computer) · The seen-events set is trimmed in hash order and updated without synchronization, which can produce duplicate notifications |
| [A49](#a49) | low |  | small | security/risk | ✅ fixed in `a40d11b`; follow-up `513c166`, `402f139` (the pin is anchored in the sealed pairing answer) · SSH host-key TOFU pin is saved during key exchange (before auth) and is not tied to the pairing |
| [A50](#a50) | low |  | medium | security/risk | 🟡 private beta10/code11 installed from clean e3ce041c with verified signer/APK/non-debuggable metadata; desktop-issued pairing/relay survives same-signer update and real saved relay reconnect/input pass; A91/A94 full physical empty-host flow passes, 10 Pass / 22 Partial / 32 Pending ledger and broader minified/device validation pending · Debuggable builds expose Keystore-protected credentials over adb/JDWP |
| [A51](#a51) | low |  | small | security/gap | ✅ fixed in `9b4af70` · allowBackup=false does not stop device-to-device migration at targetSdk 35: hosts, pins and deviceId are cloned |
| [A52](#a52) | low |  | small | security/gap | ✅ fixed in `3780f5a` · Approval and finish notifications put command text and the agent's last message on the lock screen |
| [A53](#a53) | low |  | small | security/bug | ✅ fixed in `af587ac` · OSC 52 handler has no size cap (the desktop caps at 1,000,000) and setPrimaryClip is unguarded |
| [A54](#a54) | low |  | small | security/bug | ✅ fixed in `32330df` · PairingClient trusts an unbounded Content-Length / EOF body from the pairing endpoint |
| [A55](#a55) | low |  | medium | parity/gap | ✅ fixed in `71b592a`, `0772cbf` · Inbox and Usage are per computer; iOS merges them across all paired computers |
| [A56](#a56) | low |  | small | parity/gap | ✅ fixed in `db4abccf`, `7c206ec5` (A105): original concrete hook rules, never blind `2`; physical persistence remains open · Approval cards lack iOS's "Always allow" answer |
| [A57](#a57) | low |  | small | parity/gap | ✅ display fixed in `8dbeb48`; full held answers in `db4abccf` (A106) · Multi-select AskUserQuestion cards fall back to "Open session" |
| [A58](#a58) | low |  | small | parity/gap | ✅ fixed in `a44f16c` · Usage and feed cards omit iOS's pace line and the context indicator on event cards |
| [A59](#a59) | low |  | small | parity/gap | ✅ fixed in `57804cf`, `8020796` · No built-in dictation (iOS has on-device Whisper plus a Cloud engine) |
| [A60](#a60) | low |  | small | ci-docs/bug | ✅ fixed in `67e6297` · Interop fixture needs the Electron binary, which is downloaded at test time inside the 20 s ready window, despite the workflow saying 'not Electron' |
| [A61](#a61) | low |  | small | ci-docs/bug | ✅ fixed in `39e7995` · Following CONTRIBUTING / android/README (`npm ci --ignore-scripts`) wipes a desktop developer's patched node_modules |
| [A62](#a62) | low |  | small | ci-docs/bug | ✅ fixed in `77c760d` · SSH transport tests fail, not skip, on macOS: the gate checks only that /usr/bin/script exists, then runs util-linux-only flags |
| [A63](#a63) | low |  | small | ci-docs/gap | ✅ fixed in `b3d4c6e` · Android workflow path filters miss files that change the tested wire behavior, contrary to CLAUDE.md |
| [A64](#a64) | low |  | small | ci-docs/gap | ✅ fixed in `f9782da`; actual relay-file round trip verified 2026-10-05 · Docs say the protocol tests check the mirror, the projects.list blob and the ~/.nodeterm files against desktop code, but those shapes are hand-copied in the tests |
| [A65](#a65) | low |  | small | ci-docs/gap | ✅ fixed in `33af5e7` · User-facing docs and desktop UI present the Android app as working, but it has never been built by AGP or run on a device, and no device checklist exists |
| [A66](#a66) | low |  | small | ci-docs/gap | ✅ fixed in `61e218b` · ANDROID_APP_URL points at a folder that exists on neither upstream nor fork main yet, and it points at source code rather than an installable |
| [A67](#a67) | low |  | small | ci-docs/gap | ✅ fixed in `696fd10` · The interop fixture is excluded from every tsconfig, so `npm run typecheck` never checks it against the desktop interfaces it implements |
| [A68](#a68) | low |  | small | ci-docs/risk | Workflow triggers break repo conventions: every branch push plus pull_request doubles runs, and there is no merge_group |
| [A69](#a69) | low |  | small | ci-docs/gap | ✅ fixed in `6f3a8da` · The Gradle/Kotlin code has no dependency-update, CodeQL or wrapper-validation coverage |
| [A70](#a70) | low |  | small | ci-docs/bug | ✅ fixed in `68d5da6` · On Windows the interop tests fail with CreateProcess instead of skipping |
| [A71](#a71) | low |  | small | ci-docs/gap | ✅ fixed in `39e7995` · android/README says 'JDK 17+', but the pinned Gradle 8.14.3 cannot run on JDK 25 |
| [A72](#a72) | low |  | medium | critic/gap | ✅ fixed in `71290de` · Phone-started sessions are created without the agent-specific env, so for their whole life they get no hook-reply approvals, no canvas control and no pane ownership |
| [A73](#a73) | low |  | small | critic/bug | ✅ fixed in `e055f37` · Notifications are documented as 'live every 8 seconds while a computer is open', but the in-app poll never posts a notification |
| [A74](#a74) | low |  | small | critic/bug | ✅ fixed in `a40d11b`; follow-up `cb12f3b`, `898d937` (the relay refreshes the LAN address and host keys) · The LAN leg dials a DHCP IPv4 frozen at pairing time; when another SSH host answers at that address, the host-key 'hard stop' also blocks the relay fallback |
| [A75](#a75) | low |  | small | critic/gap | ✅ fixed in `437e359` · The New session account picker lists managed Claude accounts by raw UUID |
| [A76](#a76) | low |  | small | critic/gap | ✅ fixed in `6966f25` · Over direct SSH, opening a Sleeping (Eco-hibernated) session lands on a bare shell with no wake or resume offer |
| [A77](#a77) | low |  | small | critic/bug | ✅ fixed in `0a2a1aa` · IME insets are not handled for Android 15's enforced edge-to-edge (targetSdk 35): the terminal gets double bottom padding when the keyboard opens, and other screens have no IME padding at all |
| [A78](#a78) | medium | | small | protocol/bug | ✅ locally fixed in `bb5b3e54`; protocol658/app type-check pass; phone verification pending · Desktop quick answers can hit a prefix-matched or newly selected pane, be swallowed by copy mode, or reorder concurrent writes |
| [A79](#a79) | medium | | small | protocol/bug | ✅ locally fixed in `e64665c3`; protocol658/app type-check pass; phone verification pending · Direct-SSH quick answers can be swallowed by copy mode and an absent SSH exit status can report success |
| [A80](#a80) | medium | | small | protocol/bug | ✅ locally fixed in `0f39c33f`; protocol658/app type-check pass; phone verification pending · The control client's startup attach reply consumes the first queued command's reply slot |
| [A81](#a81) | medium | | small | runtime/bug | ✅ locally fixed in `86390a49`, `7e11e93c`; protocol658/app type-check pass; phone verification pending · Relay join and device mint can hang on stalled mobile connections and ignore coroutine cancellation |
| [A82](#a82) | medium | | medium | protocol/bug | ✅ locally fixed in `010240e0`; protocol658/app type-check pass; phone verification pending · Read-ack sweeps delete files owned by other desktops and lose acknowledgments |
| [A83](#a83) | medium | | small | build/risk | ✅ fixed in `fa71cb08`; actual release/R8 verified, full phone validation pending · AGP 8.9.1 R8 cannot parse Kotlin 2.2 metadata during a successful release build |
| [A84](#a84) | low | | small | tests/bug | ✅ fixed in `1d6b04cc`; full protocol 606/606 pass, two mutants caught · Real SSH tests share Readline state and inherit a login-shell command-not-found hook |
| [A85](#a85) | medium | | small | terminal/bug | ✅ fixed in `febe022a`; code-3 update verifies viewport/font/keyboard resizing and pre-attach tmux history; final protocol609/app type-check pass · WRAP_CONTENT WebView layout parameters force a one-row terminal despite a large native viewport |
| [A86](#a86) | medium | | medium | performance/gap | 🟡 primary drag/coast complaint user-confirmed resolved in code 7; cellular WireGuard SSH connection and smooth scrolling confirmed; Pixel drag/coast/Esc/stable-viewport new-touch stop pass, protocol658/49 gesture mutants pass; reversal/lifecycle/FPS/custom bindings remain open · Scroll responsiveness is poor despite reachable tmux history |
| [A87](#a87) | medium | | medium | runtime/bug | ✅ fixed in `3cffb49d`; protocol658/type-check pass, 31 routing JS/actor/wiring mutations caught; normal drag/coast user-confirmed in beta 6; remaining device checks open · Automatic xterm reports cancel a swipe and discard queued movement |
| [A88](#a88) | medium | | small | tooling/bug | ✅ fixed in `fed68fb3`, `f5fd3821`; actual V3.0 label reproduced, 39 Python tests per SDK36/37 and ten new mutations pass; all five CI37061593216 jobs green · New SDK signer labels make private-beta verification reject the expected certificate |
| [A89](#a89) | medium | | small | runtime/bug | ✅ fixed in `c4b1f6cf`; real xterm redraw/hit-target regression and three CSS mutants pass; protocol658/type-check/code-7 delivery and Pixel continuous drag/coast/Esc/stable-viewport new-touch stop and user drag/coast confirmation pass; other device checks open · Repaint detaches the touched text span and loses continued drag/release events |
| [A90](#a90) | medium | | medium | parity/gap | ✅ implemented in `bcc92367`, `b88d1415`; protocol 684/66 and 32 mutants pass; beta 8/9 focused Pixel Home/project/custom cwd/input/history/restart/update/reconnect/exact End pass; beta 10 relay plain-shell creation/input/exact End also pass; item 32 Partial for managed/cellular variants; beta-9 Oct4 A91 empty-host flow passes · Manual SSH/WireGuard host has no way to create a new plain terminal without a local desktop/relay |
| [A91](#a91) | medium | | small | runtime/bug | ✅ fixed in `4d33a5b5`; protocol 688/67, offline app compile and six mutants pass; beta 9/code 10 installed with verified hash; beta-9 Oct4 physical empty-host first Home/exact last-End/row-group removal/connected SSH/second Home flow pass; A94 delivered full installed End/recreate/open/End flow passes · Ending the last phone shell on an otherwise empty SSH host leaves its cached row visible |
| [A92](#a92) | low | | small | desktop/bug | ✅ fixed in `127b6b28` · Desktop/Server terminal link lookup can exclude the hovered row after 32 continuing rows; 24 focused Vitest tests, full TypeScript check and three isolated mutants pass; interactive desktop hover remains unverified |
| [A93](#a93) | medium | | medium | interop/backend | OPEN · Fresh-desktop remote-on pairing succeeds without relay credentials; bounded retry using the exact production mint request body returns HTTP 403 reauth_required; original same-desktop recovery succeeds; fresh-different-desktop failure remains open |
| [A94](#a94) | medium | | small | runtime/bug | ✅ fixed in `3c217cba`; five Kotlin methods/eight mutants and full689/67 pass, beta 10 delivered; full physical completed-empty End/recreate/open/End flow passes · Authoritative empty SSH listing remains labelled Loading sessions |
| [A95](#a95) | medium | | small | desktop/interop | ✅ fixed in `ec12ea9a`; actual beta 10 phone move/remove/re-add/create-label updates reach rebuilt production desktop Board with unchanged page time origin and matching persisted state; item 36 Pass; nine suites/133 tests, full TypeScript and four mutants pass · Held desktop Board remained stale after phone moves/labels |
| [A96](#a96) | low | | small | phone/UX | ✅ fixed in `f73633fb`; 12 bounded JVM checks / 21 isolated mutants, protocol730/70 and app checks pass; beta 11 prepared, physical follow-up pending · Sessions have no local search |
| [A97](#a97) | low | | small | parity/gap | ✅ fixed in `8443e71e`; isolated control/restored 25-method runs / 31 mutants and protocol730/70/app checks pass; beta 11 prepared, physical follow-up pending · All computers does not refresh live while visible (A55 residual) |
| [A98](#a98) | low | | small | terminal/UX | ✅ fixed in `1b1872f1`; 9 bounded JVM checks / 13 isolated mutants, protocol730/70 and app checks pass; beta 11 prepared, physical follow-up pending · Captured terminal output cannot be searched |
| [A99](#a99) | low | | small | security/risk | ✅ fixed in `e07071e9`; actual Linux control/restored 19 tests / 16 isolated mutants and protocol730/70/app/desktop checks pass; physical included-key pairing pending · SSH host-key discovery ignores recursive external Includes (A49 residual) |
| [A100](#a100) | medium | | medium | terminal/gap | ✅ source fixed in `2f693d83, 97b8a9a4, 4f1985f5` · Retained host history search; new physical checks pending |
| [A101](#a101) | medium | | small | runtime/bug | ✅ source fixed in `fbaa535d` · Interrupted typed session-host reads reconnect; source regression verified |
| [A102](#a102) | medium | | medium | protocol/gap | ✅ source fixed in `e584586f` · Cold relay attach retains trusted project launch settings; new physical checks pending |
| [A103](#a103) | medium | | medium | protocol/gap | ✅ source fixed in `91e6a3f5` · Agent approval policy survives launch, resume and wake; new physical checks pending |
| [A104](#a104) | medium | | medium | runtime/gap | ✅ source fixed in `2d6cb2cd` · Offscreen Sleeping nodes can wake without switching projects; new physical checks pending |
| [A105](#a105) | low | | medium | parity/gap | ✅ source fixed in `db4abccf, 7c206ec5` · Always allow uses original concrete hook rule scopes; new physical checks pending |
| [A106](#a106) | low | | medium | parity/gap | ✅ source fixed in `db4abccf` · Complete held Claude questions have deterministic answers; new physical checks pending |
| [A107](#a107) | medium | | medium | parity/gap | ✅ source fixed in `489c30a8` · Typed source control works on direct SSH; new physical checks pending |
| [A108](#a108) | medium | | medium | parity/gap | ✅ source fixed in `d716138c`, `585e726f` · Owned SSH Board and Desktop session actions; new physical checks pending |
| [A109](#a109) | low | | small | tests/bug | ✅ source fixed in `4e2f877d` · Three-digit findings retain device coverage; source regression verified |
| [A110](#a110) | low | | small | tests/bug | ✅ test fixtures fixed in `8c57016c`, `b2e41255` · SSH profile isolation and actual unsafe-directory mode; merged gates verified |
| [A111](#a111) | medium | | medium | parity/gap | ✅ fixed in `d652b96c`–`ba64f628`; beta-13 local checks pass, physical/live CLI pending · New session needs genuine host-owned create/launch/register over direct SSH |
| [A112](#a112) | low | | small | tests/bug | ✅ fixed in `9675c4d1`; producer/input regressions and mutations pass · Managed producer imports session-host files missing from CI and incremental test inputs |
| [A113](#a113) | medium | | small | desktop/bug | ✅ fixed in `349b791a`; 111 affected tests / 11 assertion mutants · Legacy relay revoke lacks a confirmed remote-access receipt |
| [A114](#a114) | low | | small | phone/UX | ✅ fixed in `6b989e59`; 39 focused methods / 18 assertion mutants; physical pending · Dictation has no language picker |
| [A115](#a115) | medium | | medium | phone/bug | ✅ fixed in `0a71c028`; 73 assertion mutants and one equivalent survivor; physical pending · Replaced records and late connections retain stale preferences/credentials |
| [A116](#a116) | medium | | medium | pairing/UX | ✅ fixed in `a6b3e88b`; six real HTTP / five interop methods, 56 assertion mutants; physical pending · Multiadapter pairing/refresh has no network choice |
| [A117](#a117) | medium | | small | pairing/bug | ✅ fixed in `227a7262`; 22 reader methods, seven reader mutants and actual pairing/Android regression · Relative private HostKey names can enter Include reads |
| [A118](#a118) | medium | | medium | pairing/gap | ✅ eligible legacy association fixed in `aa902d0a`; actual host/Android proof and mutation checks pass; physical pending · Legacy entries cannot revoke their unassociated relay key |
| [A119](#a119) | medium | | small | SSH/setup | ✅ source-fixed in `3a68e42b`; actual Server/SSH and mutation checks pass; physical pending · Explicit saved SSH profile folder for custom Server data directories |
| [A120](#a120) | medium | | medium | SSH/setup | ✅ source-fixed in `2723845e`; 17 JVM methods, seven assertion mutants and 28 native OpenSSH checks; physical pending · One-time password setup with human fingerprint confirmation and retained-key verification |
| [A121](#a121) | low | | small | desktop/bug | ✅ source-fixed; full native UI pending · guarded next-task Canvas blur preserves mouseleave; nine behavioral methods and five assertion mutants pass |

## A01

**Direct-SSH terminal writes and resizes run on the Android main thread, which breaks the SSH connection as soon as the keyboard opens**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: small; area: build; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshHostConnection.kt:221`
- Note: Same bug as A04 (reported by two auditors). Fix once, in SshStream.

**Evidence**

SshStream.write/resize are plain (non-suspend) calls that write to the socket synchronously: `override fun write(text: String) { synchronized(this) { runCatching { stdin.write(...); stdin.flush() } } }` (l.221-228) and `override fun resize(...) { runCatching { (session as Session.Shell).changeWindowDimensions(...) } }` (l.230-233). TerminalController calls them on the MAIN thread: `main.post { ... if (s != null) s.resize(c, r) ... }` (TerminalController.kt l.124-132, fired by xterm's fit whenever the WebView resizes, and TerminalScreen.kt l.77 `.imePadding()` / adjustResize resize it when the soft keyboard opens), `main.post { ... s.resize(cols, rows) }` (l.216), `fitHere()` (l.279), `acceptResume()` -> `stream?.write` (l.270), and `raw()` -> `stream?.write` (l.290) from the ^C/^D/^R/^L key chips (TerminalScreen.kt l.163-166). On Android, socket writes on the main thread throw NetworkOnMainThreadException, a RuntimeException. `javap` of sshj 0.39.0 `TransportImpl.write` shows `Encoder.encode` (offset 108) runs before `OutputStream.write/flush` (131/141). The only handler around the socket write is `java/io/IOException` (range 112-144), and `Encoder.encode` does `putfield seq`, so the sequence number and cipher state have already advanced. The exception escapes sshj and SshStream's runCatching swallows it silently. The next packet (the user's next keystroke, from the JavaBridge thread) is encrypted with a state the server does not expect, so sshd drops the connection. The terminal ends with 'Disconnected.', and the shared SSHClient used for listing and the Inbox dies with it. The relay path is unaffected: RelayHostConnection.Stream.write/resize only enqueue on OkHttp's `ws.send`. The same NetworkOnMainThreadException hits `SshHostConnection.close()` -> `client.disconnect()` when it runs from click handlers (HostsScreen.kt l.145 Forget, SettingsScreen.kt l.109 route change). There it escapes sshj's `sendDisconnect` before `finishOff()`, which leaks the socket and the sshj reader thread. JVM tests cannot see any of this because the JVM has no BlockGuard, and nothing in app/ or protocol/ relaxes StrictMode.

**Proposed fix**

Keep all sshj I/O off the main thread while preserving write order. Give SshStream a single-thread writer, e.g. `Executors.newSingleThreadExecutor()`, and have write/resize enqueue onto it. Alternatively, have TerminalController route every stream.write/resize/raw/acceptResume/fitHere call through one serial off-main dispatcher, such as `Dispatchers.IO.limitedParallelism(1)`. Run `HostSession.disconnect()` / `SshHostConnection.close()` on `Dispatchers.IO` as well.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line numbers and root cause are accurate. Three refinements:
> (a) One more main-thread caller of `close()`: `PairScreen.kt:152` (`graph.connections.forget`), alongside `HostsScreen.kt:145` and `SettingsScreen.kt:109`. `InboxNotifier.kt:127` runs in the worker and is fine.
> (b) Moving sshj writes off the main thread matters even apart from StrictMode. `TransportImpl.write` takes `writeLock` and can block in `kexer.waitForDone()` during a rekey. `ChannelOutputStream.flush` can block in `win.awaitExpansion`. On the main thread either one is an ANR risk.
> (c) The fix must preserve ORDER across two producers: main-thread resize/raw/acceptResume and JavaBridge-thread onInput. So route both `SshStream.write` and `resize` through ONE serial executor inside `SshStream` (e.g. a single-thread executor created per stream and shut down on detach/exit). Fixing each call site separately would leave the ordering unguaranteed. Also make `HostSession.disconnect()` run `c?.close()` on `Dispatchers.IO` (e.g. `graph.scope.launch(Dispatchers.IO)`). For defense, catch `RuntimeException` around `client.disconnect()` and fall back to closing the socket, so a failed `SSH_MSG_DISCONNECT` cannot leak the socket and reader thread.

> The finding is accurate. Four refinements:
> 
> 1. The finding lists the keyboard, rotation, A−/A+ and 'Fit this screen' as triggers. The A−/A+ path is the only one that fires even with a hardware keyboard and no rotation, because TerminalController.setFontSize -> terminal.js `setFontSize` -> `doFit(true)` forces onResize.
> 
> 2. What gets corrupted is broader than the sequence number. Encoder.encode advances both `seq` (putfield at offset 274) and the cipher stream (Cipher.update at 334/381), so every negotiable cipher desyncs.
> 
> 3. For close(): the DisconnectListener fires before the failing sendDisconnect, but it is a no-op because close() already set closedFired=true. The keepalive is interrupted first, so the leaked socket is idle rather than kept alive.
> 
> 4. Put the fix in the protocol layer, not in TerminalController. The TerminalStream contract is non-suspend and callers cannot know that SSH blocks. Give SshStream a single-thread executor and route write, resize and scroll through it; this also serializes main-thread raw()/resize with JavaBridge-thread onInput, keeping them in order. Make SshHostConnection.close() hand client.disconnect() to that executor, or to a background thread. For defense in depth, catch RuntimeException in SshStream by closing the channel/transport instead of silently swallowing it, since the transport is unusable after any exception thrown mid-write.

## A02

**SSH browse looks for the desktop's userData under 'nodeterm', but the desktop writes it under 'node-terminal', so every direct-SSH listing comes back empty**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: small; area: protocol; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshScripts.kt:38`
- Note: Related: A27 (the Server Edition data dir is not probed either).

**Evidence**

Android PRELUDE: `for d in "$HOME/Library/Application Support/nodeterm" "${XDG_CONFIG_HOME:-$HOME/.config}/nodeterm"; do if [ -f "$d/workspace.json" ]; then NT_UD="$d"; ...`. On the desktop, userData is `app.getPath('userData')`, which is appData/<app.name>. package.json has `name: "node-terminal"` and NO top-level productName (only `build.productName: "nodeterm"`). electron-builder's `modifyMainPackageJson` (node_modules/app-builder-lib/out/fileTransformer.js:88-106) merges only `config.extraMetadata` into the packaged package.json, and this repo sets none, so at runtime app.name is `node-terminal`. The desktop's own runtime shell agrees: src/core/agents/hook-endpoint-failover-sh.ts:79-80 walks `"$HOME/.config/node-terminal/hook-endpoint.env"` and `"$HOME/Library/Application Support/node-terminal/hook-endpoint.env"`, and node-token-sh.ts:93-94 uses the same `node-terminal` dirs. Repo tests use the same path as a realistic example (ssh-agent.test.ts:59, codex-relay-daemon.test.ts:925). The mirror is written to `path.join(platform().userDataDir, 'agent-status.json')` (agent-status-mirror.ts:1436). Only scripts/uninstall.sh and docs/uninstall.md say `nodeterm`, and the Android prelude copied that. I ran the prelude under /bin/sh against a fake HOME that had `~/.config/node-terminal/workspace.json`: it printed `ud=` (empty). SshTransportTest.kt:154 passes only because its fixture creates `.config/nodeterm`.

**Proposed fix**

Probe `$HOME/Library/Application Support/node-terminal` and `${XDG_CONFIG_HOME:-$HOME/.config}/node-terminal` first, keeping `nodeterm` as a fallback. Change the SshTransportTest fixture to the real directory name so the test would have caught this.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The core claim and root cause are correct. Two refinements:
> 
> 1. The fix should probe `node-terminal` first on both platforms: `$HOME/Library/Application Support/node-terminal` and `${XDG_CONFIG_HOME:-$HOME/.config}/node-terminal`. Keep the existing `nodeterm` dirs as fallbacks. Also consider `$HOME/.nodeterm-server`, the Server Edition's default data dir (src/server/config.ts:108), which the prelude does not probe either. Update the header comment at SshScripts.kt:17-19 and the SshTransportTest fixture (line 154) to `node-terminal`.
> 
> 2. docs/uninstall.md:24 and scripts/uninstall.sh:64 carry the same wrong `nodeterm` path. That is a separate desktop-side doc/script bug, but it is where the Android prelude copied the path from.

> Mostly correct. A few refinements:
> 
> (a) The KDoc at SshScripts.kt:18-19 states the wrong path too, and should be fixed along with line 38.
> 
> (b) The `nodeterm` spelling appears in more places than scripts/uninstall.sh and docs/uninstall.md. It is also in the src/main/remote-ssh/ssh-agent.ts:76-77 comment, which wrongly says the installed app is "nodeterm". Illustrative paths use it in docs/codex-shared-identity.md:72 and in claude-accounts-core.test.ts / claude-skill-share-core.test.ts. The desktop repo is internally inconsistent, and the Android author followed the wrong half.
> 
> (c) The proposed fix is right. Probe `node-terminal` first in both the macOS and XDG locations, keep `nodeterm` as a fallback, and change the SshTransportTest.kt:154 fixture to `.config/node-terminal` so the test catches this.
> 
> (d) Not strictly needed, but: because the listing is empty rather than failing, ConnectionManager never falls back to the relay even when one is paired. A browse that returns `ud=` with no workspace should be treated as a failed or degraded SSH route rather than a legitimately empty host.

## A03

**The direct-SSH tmux client starts without a UTF-8 locale, so tmux replaces every non-ASCII character with '_'**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: small; area: protocol; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshScripts.kt:92`

**Evidence**

The attach script sets only `TERM=xterm-256color; export TERM` and then `exec "$NT_TMUX" -L node-terminal "$@" new-session -A -s ...`. It never sets LANG/LC_ALL and never passes `-u`, and nothing in the Android code calls sshj `setEnvVar` (grep for LANG/LC_ALL/setEnvVar/` -u ` in android/ finds nothing). tmux marks a client UTF-8-capable only when LC_ALL/LC_CTYPE/LANG contains UTF-8 (or with -u). The desktop solves this for its own clients: pty-manager.ts:512 `resolveLocaleLang()` forces `en_US.UTF-8` into the spawn env ('rounded borders come out as `_`/`|`'), and passes `-e LANG=` per session (pty-manager.ts:3249-3251). An sshd exec channel on a stock macOS host carries no LANG: sshj sends no env, and the `zsh -c` wrapper sources no locale. Measured in the sandbox with tmux 3.4: a client started without LANG received `_ box` instead of `╭ box`; the same client with LANG=en_US.UTF-8 received the real glyphs.

**Proposed fix**

In the attach script, export a UTF-8 locale when the inherited one is not UTF-8 (the same rule as resolveLocaleLang), or add `-u` to the tmux client invocation. Add an SshTransportTest case that runs with LANG unset.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line and root cause are correct (SshScripts.kt:92-93, with the exec on line 93). Two refinements:
> 
> 1. Not every character becomes `_`. Box-drawing characters that have a DEC ACS mapping (─ │ ┌ ┐ └ ┘ and the like) are converted by tmux to `ESC(0` + an ACS letter, and xterm.js renders those correctly. Characters with no ACS mapping become width-many underscores: rounded corners ╭╮╰╯, accented Latin letters, CJK (two underscores each), and symbols and emoji such as ✻ ⏺ ⎿.
> 
> 2. The better fix is to export a UTF-8 LANG in the attach script, using the desktop's `resolveLocaleLang` rule (keep an inherited LC_ALL/LC_CTYPE/LANG that already says UTF-8, otherwise `LANG=en_US.UTF-8`), rather than only adding `-u`. `-u` fixes this client's rendering but not the pane environment when the phone's attach starts the tmux server; exporting LANG covers both. Adding `-u` on top is harmless.
> 
> The regression test should attach under an env with no LANG, LC_ALL or LC_CTYPE and assert that a non-ASCII glyph (e.g. `é`) arrives as UTF-8 bytes, not `_`.

> The line is right (92-93) and so is the root cause. Two additions and a sharper fix:
> 
> (a) The impact is mainly stock macOS hosts, plus Linux hosts without a pam_env locale. Debian/Ubuntu normally get LANG through PAM.
> 
> (b) SshTransportTest.kt:57 hides the bug by passing the JVM's own environment, LANG included, to the fake sshd. The new test must clear LANG, LC_ALL and LC_CTYPE in `childEnv()` and assert that a non-ASCII glyph such as `╭` comes through the attach.
> 
> (c) Fix: add `-u` to the tmux client invocation in `attach()`. That makes the client UTF-8 whatever locale the host has installed. Also export LANG only when LC_ALL, LC_CTYPE and LANG are all non-UTF-8, so that panes of a server the phone starts don't inherit a C locale. Use `en_US.UTF-8` on Darwin, where it is always present and matches the desktop's resolveLocaleLang, and `C.UTF-8` elsewhere. Forcing en_US.UTF-8 on a Linux host that lacks it makes shells print setlocale warnings. `-u` alone fixes rendering but not the pane locale of a phone-created server.

## A04

**SSH terminal writes and resizes run on the main thread, and the NetworkOnMainThreadException that runCatching swallows leaves sshj's cipher state out of sync, which drops the whole SSH connection**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:131`
- Note: Same bug as A01.

**Evidence**

Main-thread callers of TerminalStream.write/resize:
- TerminalController.kt:125-131: `main.post { ... val s = stream; if (s != null) s.resize(c, r) ... }`. This runs on every WebView resize: the soft keyboard (TerminalScreen.kt:77 `Column(...imePadding())` shrinks the WebView), rotation, and A−/A+ (`nt.setFontSize` → `doFit(true)` → `bridge.onResize`).
- :216 `main.post { ... s.resize(cols, rows) }`; :279 fitHere `s.resize(cols, rows)`; :270 acceptResume `stream?.write(offer.second + "\r")`; :290 `fun raw(data: String) { stream?.write(data) }`, which the ^C/^D/^R/^L chips call (TerminalScreen.kt:163-166).

SSH side, SshHostConnection.kt:221-233: `synchronized(this) { runCatching { stdin.write(...); stdin.flush() } }` and `runCatching { (session as Session.Shell).changeWindowDimensions(...) }`. Both write to the socket on the calling thread.

In the sshj 0.39.0 jar, TransportImpl.write calls `Encoder.encode(packet)` at bytecode offset 108; that increments the sequence number and runs cipher.update/MAC. Only then does it call `connInfo.out.write` at offset 131 (a raw java.net.Socket stream, from SocketClient.onConnect). The exception table catches only IOException.

On Android the main thread has StrictMode death-on-network (targetSdk ≥ 11), and SocketOutputStream.socketWrite calls `BlockGuard.getThreadPolicy().onNetwork()`. So the write throws NetworkOnMainThreadException, a RuntimeException that runCatching silently swallows.

**Proposed fix**

Never call TerminalStream.write/resize on the main thread. Either give SshStream a per-stream single-thread executor that does write+flush and changeWindowDimensions (this keeps keystrokes in order), or route raw/acceptResume/fitHere/onResize/the attach-time resize through a serial background dispatcher (e.g. Dispatchers.IO.limitedParallelism(1)). Also stop runCatching-ing a RuntimeException out of sshj: at that point the transport state is corrupt, so close the connection.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The substance is correct. Three refinements:
> 
> (a) Ordinary typed input is NOT affected. `Bridge.onInput` (`TerminalController.kt:136-144`) runs on the WebView's JavaBridge background thread, and so do `submit()`/`key()`, which go through `nt.submit`/`nt.key` → `bridge.onInput`. Only these main-thread paths break: the resize at `:131` and `:216`, `fitHere` at `:279`, `acceptResume` at `:270`, and the KeyRow chips at `:290`. Opening the keyboard alone is enough, because `adjustResize` plus `imePadding` shrinks the WebView, xterm's rows change, and `onResize` fires.
> 
> (b) The fix has to serialize with the JavaBridge-thread `onInput` writes as well. Otherwise ^C from a chip could overtake or interleave with typed bytes. So put the executor or `limitedParallelism(1)` dispatcher inside `SshStream` itself, covering write+flush and `changeWindowDimensions`, rather than in the controller.
> 
> (c) `runCatching` in `write`/`resize` also hides an `IOException`/`TransportException` from a dead socket. Any exception out of `Transport.write` should close the stream or connection, not be ignored.

> The finding is accurate. Three refinements:
> 
> (a) Line 235 (afterAttach) is NOT on the main thread: it runs on graph.scope, which is Dispatchers.Default. Typed keystrokes via Bridge.onInput (:143) run on the WebView JavascriptInterface thread and are also unaffected. The main-thread offenders are exactly :131, :216, :270, :279 and :290.
> 
> (b) The disconnect does not need further user activity. After one swallowed main-thread write, the next packet on the transport breaks the connection. That can be the HostSession poll's exec (every 8 s) or sshj's keep-alive (set to 20 s at SshHostConnection.kt:353). So the terminal drops within about 8 to 20 s of the first keyboard-open, rotation, A−/A+, chip tap, Resume or Fit.
> 
> (c) Fix details:
> - Move SshStream.write and resize onto one per-stream single-thread executor (or a `Dispatchers.IO.limitedParallelism(1)` dispatcher) so writes and resizes keep their order.
> - On any non-IOException thrown from sshj's write path, close the connection: `client.disconnect()` plus `fireClosed`. Do not swallow it.
> - Narrowing runCatching to IOException alone is not enough: the cipher has already advanced before the throw.
> - Optionally, move the controller's main.post resize and raw calls off the main thread as well, which protects any future TerminalStream implementation.

## A05

**The background InboxWorker can open a never-approved relay handshake and raise the desktop's SAS approval dialog while the phone shows no code**

- Severity: **high** (BLOCKS first release); claimed by auditor: medium; effort: small; area: runtime; kind: risk
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:124`
- Note: Same issue as A17 and A23 (three auditors). Related: A07, A30.

**Evidence**

- NodetermApp.kt:45 schedules InboxWorker on every app start.
- InboxNotifier.kt:121-127 runs `withTimeoutOrNull(45_000) { session.refreshNow() }` for every paired host.
- refreshNow → connectLocked (ConnectionManager.kt:99-125) falls through to the relay when SSH fails (phone off the LAN). It then runs RelayConnector.connect, which holds the handshake open and polls projects.list while the desktop waits for approval (RelayConnector.kt:67-86).
- Pairing never pins the phone's box key: the PairingClient body is `{token, publicKey(ssh), deviceName, deviceId, priorDeviceToken}`. standing-host.ts:12-13 says "the first connect from a given phone (its box public key) prompts the host human via the shared SAS dialog".
- A phone paired on the LAN with route AUTO connects over SSH in the foreground, so its first relay connect is usually the worker's, in the background.
- The SAS is rendered only in HostScreen's ConnectionBanner.

**Proposed fix**

Store a per-host "relay approved" flag after the first successful foreground relay connect, and have the worker skip the relay leg until it is set. Alternatively, abort on RelayConnectStatus.AwaitingApproval in background mode and post a notification asking the user to open the app.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause is right. The second proposed fix is not: aborting on `RelayConnectStatus.AwaitingApproval` in background mode would not prevent the desktop prompt. The desktop raises its SAS dialog in `onPeerReady`, as soon as the E2EE handshake completes (`standing-host.ts:256-261`). The phone only learns it is awaiting approval later, when its first `projects.list` fails with "Awaiting host approval." (`RelayConnector.kt:72-80`). Even if the phone closed immediately, the desktop would keep the approvable dialog for 120 s (`phone-approval.ts`).
> 
> The fix that actually prevents the prompt is the first proposal: never enter the relay leg from the background worker until a foreground relay connect for that host has completed. Record a per-host "relay approved" flag when `RelayConnector.connect` returns successfully in the foreground, and have `InboxWorker` pass a background/`allowRelayHandshake=false` mode to `connectLocked`.
> 
> Optionally, when the worker skips a host whose relay leg is unapproved, it can post a local notification asking the user to open the app and approve this phone. One more precision: the prompt does not repeat forever. It recurs every 15 minutes only while the phone is off the LAN and the key is still unpinned.

## A06

**approvals.answer reports success for a hold that already timed out, and clears NEEDS YOU on every surface**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: small; area: security; kind: bug
- Location: `src/main/remote/host-service.ts:690`
- Note: Related: A35 (answered:false is ambiguous).

**Evidence**

The new verb's doc (host-service.ts:690) promises "`answered:false` is an ANSWER (the hook already timed out, the host could not write)". It cannot return that for a timeout. The relay leg reaches `answerPermission` (src/main/index.ts:2774), which calls `writePendingAnswerLocal` (src/core/agents/pending-approvals.ts:42-58: `mkdir` + `writeFileAtomic(file, decision)`, then `return true`). The SSH-project leg is `ssh-project.ts:1823-1845` (`remoteAtomicWrite`, then `code === 0`). Neither checks that `<pendingId>.json` still exists. The hook deletes that file and stops polling when its hold ends: managed-script.ts:423-425, `# Timed out: clean up the request + payload files and print nothing → Claude shows its normal prompt`. On `ok`, answerPermission then emits `syntheticAnsweredEvent`, so the mirror marks the card resolved and flips the node to working (agent-status-mirror.ts:1492-1496). The phone's own SSH leg does check: SshScripts.kt:136 `if [ ! -f "$d/$pendingId.json" ]; then echo gone; exit 0; fi`. On timeout the hook POSTs nothing, so the inbox card keeps its dead `pendingId` (only a `working` event with that id resolves it). QuickActions.stillWaiting still sees BLOCKED and takes the relay path. The hold is `PERM_WAIT_SECS_DEFAULT = 45` (hook-server.ts:65). Android's only background alert path is the 15-minute WorkManager poll (InboxNotifier.kt:64). So an Approve or Deny tapped from an Android notification almost always arrives after the hold has ended.

**Proposed fix**

In answerPermission, check that the request still exists before writing: locally, `fs.access(<pendingDir>/<id>.json)`; over SSH, a `test -f` in the same remote command. Return false otherwise, and skip the synthetic event on false. On the phone, map a 'gone/false' result for a node that is still BLOCKED to OPEN_SESSION (the prompt is now on screen) rather than 'Already handled.'

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The core claim is right. Some details need adjusting:
> 
> 1. **Where the tap happens.** The Android notification has no Approve/Deny actions; it only sets a content intent that opens the app (InboxNotifier.kt:97-113). Approve/Deny live in the Inbox tab (InboxTab.kt:111-114). So the late answer comes from a user who opens the app, from that notification or just by browsing, and taps a card that is still unresolved. The 15-minute poll (InboxNotifier.kt:64) is why that usually happens after the 45 s hold, but any in-app tap more than 45 s after the request hits the bug.
> 
> 2. **The gap is not new, but its reach is.** The writer was extracted unchanged from the pre-existing canvas IPC handler in commit a0c07e6. The desktop canvas Approve/Deny has always had the same problem: the renderer keeps `pendingId` on blocked (agentStatus.ts:558), so the buttons stay after a timeout. On the desktop, though, the prompt is on screen in front of the user. What commit a0c07e6 adds is exposure to a remote phone, plus a doc/test contract (host-service.ts:690, host-inbox-verbs.test.ts:6-7) that the code cannot meet.
> 
> 3. **Severity.** High is defensible, because a phone answer usually lands after the hold. Medium would also be defensible, since it only bites when the phone answers after the 45 s hold.
> 
> 4. **The fix.** The proposed fix is right in substance, with these points:
>    - Check `<pendingDir>/<id>.json` exists before writing, locally and in the same remote command over SSH.
>    - Return false and skip the synthetic event when it is missing.
>    - A small race between the check and the write remains, as it does in SshScripts.kt:136. It is harmless apart from an orphaned `.answer` file that the sweep removes.
>    - On the phone, prefer OPEN_SESSION over "Already handled." when `answered:false` comes back and the node is still BLOCKED, because the interactive prompt is then on screen.

> 1. **Approve/Deny are not notification actions.** The notification built at `InboxNotifier.kt:95-117` only has a content intent that opens the app. The buttons are in the Inbox tab (`InboxTab.kt:109-117`), reached after opening the app or a notification. The timing argument still holds.
> 
> 2. **The root cause is older than this branch.** Commit a0c07e6 only extracted the canvas IPC body into `answerPermission`. The canvas Approve/Deny button (`IPC.agentAnswerPermission`) has had the same no-existence-check behaviour all along. The new relay verb inherits it and documents a `false` result it can never produce. What this branch adds is exposure: the phone's minutes-late tap is now the common case.
> 
> 3. **Severity is arguably medium-high rather than high.** It is limited to relay-only Android phones answering Claude hook-reply approvals. Within that path, it is the dominant outcome.
> 
> 4. **The fix belongs in the writers:**
>    - `writePendingAnswerLocal`: `fs.promises.access(path.join(dir, pendingId + '.json'))` before writing; return false if it is missing.
>    - `SshProjectManager.writePendingAnswer`: put `test -f <dir>/<id>.json || exit 3` in the same remote command.
>    - `answerPermission` already skips the synthetic event when the result is false.
>    - A small race remains: the hook can time out between the check and the write. Closing it fully would need the hook to POST a "timed-out" event, which the mirror would use to strip the `pendingId` from the card. That would also let the desktop badge stop offering dead Approve/Deny buttons.
> 
> 5. **Map the Android dead-ticket results to OPEN_SESSION.** Both the relay `answered:false` and the SSH `gone` currently map to ALREADY_HANDLED. When the fresh status still says BLOCKED, the prompt is now on screen, so the result should be OPEN_SESSION. A claude-only legacy `1`/Esc send-keys would also work there, but only after re-confirming the pane.

## A07

**Remote access fails the first time you are away from the computer: Auto never does the first relay handshake while the phone is at the desk, and pairing does not pin the phone's relay key**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: medium; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/conn/ConnectionManager.kt:76`
- Note: Related: A05, A30. Partly a desktop design gap (the relay key is never pinned at pairing), so iOS likely shares it.

**Evidence**

connectLocked tries direct SSH first whenever `route != RELAY_ONLY && host.sshAvailable` (lines 76-87) and returns on success. The relay is only tried when SSH fails (lines 99-125). After pairing, PairScreen goes straight to Route.Host, which connects over SSH on the LAN. adoptRelayIfAdvertised returns early when a relay leg and token already exist (ConnectionManager.kt:167). So a phone paired on the LAN never does a relay handshake while its owner is at the computer. Nothing else can pre-approve it. The /pair body the phone sends is `{token, publicKey(ssh), deviceName, deviceId, priorDeviceToken}` (PairingClient.kt:45-50), with no box key. The desktop /pair handler never calls pinDevice (grep: pairing-service.ts has no approved/pin reference). The standing host approves a relay peer only if `isPinned(store, pub)` (standing-host.ts:250); otherwise it raises the SAS dialog (standing-host.ts:258). The first relay connect therefore happens off-LAN, usually with nobody at the desktop. RelayConnector waits 5 minutes and then fails with "Nobody approved this phone on your computer in time." (RelayConnector.kt:82). Meanwhile PairScreen told the user "✓ Reachable from anywhere (remote access is on)" (PairScreen.kt:123).

**Proposed fix**

Complete the pin-once approval while the user is at the computer. Either (a) run one relay handshake plus approval right after pairing (and after late adoption), while the phone is still on the LAN, and show the SAS on PairScreen; or (b) send the phone's persistent box public key inside the E2EE-sealed /pair body and have the desktop pin it when pairing succeeds. Until then, PairScreen should say that remote access needs one approval at the computer.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The behaviour is as described, but four things need adjusting.
> 
> (1) Root cause and scope. This is not only an Android client bug. The desktop design itself has no way to pin a phone's relay key at pairing time. The desktop's own documented flow in the standing-host.ts:424-434 comment (put the phone on cellular, "FIRST connect: the desktop shows the SAS approval dialog") treats the first relay connect as the approval moment. So iOS very likely has the same gap; that part is inferred, since the iOS repo is not visible. android/README.md:15 even documents it ("Pin-once: approve the phone on the computer the first time").
> 
> (2) Severity. Medium fits better than high. It is one-time setup friction, not a broken steady state. Workarounds exist: switch the route to Relay-only in Settings (SettingsScreen.kt:104) or connect over cellular while at the desk; approving within the 5-minute wait or the 120 s retention after the phone gives up also pins the key. Windows hosts are not affected, because they have no SSH and their first connect after pairing goes through the relay while the user is still at the desk.
> 
> (3) A related side effect. While the owner is away, the background inbox poll (InboxNotifier.kt:122-124) runs refreshNow under a 45 s timeout. An unapproved phone therefore raises the SAS dialog on the unattended desktop, then gives up on that attempt after 45 s — repeated noise, never an approval.
> 
> (4) Choice of fix. Fix (a) needs only an Android change, and it is enough: after pairing, and after late adoption, run one relay handshake plus approval while still on the LAN, and show the SAS on PairScreen. Fix (b) is cryptographically sound, because the /pair body is sealed to the QR's host key and gated by the one-time QR token. But it needs a desktop change in pairing-service.ts, and it changes the phone trust model that docs/ios-protocol-migration.md §7 leaves as an open question to settle with iOS. At minimum, PairScreen.kt:123 should say that remote access needs one approval at the computer.

> Facts and line numbers are correct.
> 
> Severity should be medium, not high. This is the desktop's documented pin-once design (standing-host.ts:12-14 and the smoke test at 426-434; docs/android.md:23). The iOS app very likely shares it, so it is a real, inherited product gap rather than an Android-only bug that breaks a feature. It is also a one-time cost: approving once from the desk with the phone off the LAN, or with the route set to Relay-only, fixes it permanently. The problem is that nothing tells the user this.
> 
> Root cause: the only way a phone key gets pinned is the standing host's interactive SAS approval (standing-host.ts:180/250), and the Android route order means that approval never happens while the user is at the computer.
> 
> Better fix order:
> (a) Android-only, no desktop or iOS change needed. After a successful pair that returned a relay leg (and after late adoption in adoptRelayIfAdvertised), run one RelayConnector.connect while the user is still at the desk and show the SAS on PairScreen. Use the same flow as HostScreen's AwaitingApproval banner, then close that connection. The user stays at the desk until they approve or skip.
> (b) The desktop-side option is sound but must land together with iOS. It would add the phone's persistent box public key to the E2EE-sealed /pair body. That body is authenticated by the on-screen one-time token and sealed to the QR's hostKey. pairing-service would then pin that key through updateApprovedDevices/pinDevice.
> 
> Interim: PairScreen:123 should say remote access needs one approval at the computer, rather than "✓ Reachable from anywhere".
> 
> Secondary: InboxWorker should not start a relay approval in the background. When state would be AwaitingApproval and nobody is watching, it should skip, so it does not raise unattended SAS dialogs on the desktop every 15 minutes.

## A08

**A cold attach over direct SSH creates the desktop's tmux session with no hook environment, so an agent resumed there never reports status, and the desktop never repairs it**

- Severity: **high** (BLOCKS first release); claimed by auditor: medium; effort: small; area: critic; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshScripts.kt:93`
- Note: Related: A72 (phone-started sessions lack agent env).

**Evidence**

SshScripts.attach runs `exec tmux -L node-terminal [-f conf] new-session -A -s nt-<id> [-c cwd]` (line 93) with no `-e NODETERM_NODE_ID=… -e NODETERM_HOOK_ENDPOINT=…`. When the session is gone (the reboot case the app detects via `hasSession`, SshHostConnection.kt:172), this CREATES it bare. The managed hook script is gated on the variable (`if [ -z "$NODETERM_NODE_ID" ]; then` exit — managed-script.ts:153). An agent started in that pane, including via the phone's own cold-start 'Resume' offer (TerminalController.kt:247-254), therefore reports nothing. When the desktop later mounts the node, the session already exists, so `fresh:false`: no cold restore, and tmux ignores `-e` for an existing session. The relay path does not have this problem, because the desktop's attachDetached injects the hook env from persistKey (pty-manager.ts:2892-2896).

**Proposed fix**

Do not cold-create over SSH. When `hasSession` says no, offer to 'open on the computer' via the relay, or ask the user to open the node on the desktop first. At minimum, pass the hook env the desktop would pass (NODETERM_NODE_ID, NODETERM_HOOK_ENDPOINT pointing at `<userData>/hook-endpoint.env`, NODETERM_HOOK_VERSION) with `-e` when creating.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause and the file:line are correct (`SshScripts.kt:93` has no `-e` hook env when `new-session -A` creates the session). The impact statement is incomplete. The session is only fully "dark" when the phone's attach is what starts the tmux server. When the desktop's tmux client started the server, the bare session inherits the tmux GLOBAL env, which the desktop seeded with another node's `NODETERM_NODE_ID`, `NODETERM_HOOK_ENDPOINT` and possibly `NODETERM_AGENT_ID` / `NODETERM_CANVAS_CONTROL` (`pty-manager.ts:2897` merges `hookEnv` into the client process env, and `NODETERM_*` is not in `update-environment`). That was verified with tmux 3.4. The resumed agent's status, verified token and session id are then attributed to the wrong node, and `Canvas.tsx:13242` overwrites that node's persisted `sessionId`.
> 
> This is also an iOS parity gap. iOS passes `NODETERM_HOOK_ENDPOINT` and `NODETERM_NODE_ID` (`phone-spawned-identity.test.ts:4`, `docs/node-identity.md:185-187`). Severity is at least medium, arguably high, given the cross-node corruption.
> 
> Better fix: when creating, ALWAYS pass `-e NODETERM_NODE_ID=<raw nodeId>` and `-e NODETERM_HOOK_ENDPOINT=<userData>/hook-endpoint.env`, as iOS does. This also overrides any leaked global value. For agent nodes, also pass `-e NODETERM_AGENT_ID=<agentId>`. For a plain terminal, unset the inherited agent/canvas-control vars; `-e` cannot unset, so wrap the command with `env -u NODETERM_AGENT_ID -u NODETERM_CANVAS_CONTROL` or similar. The node id alone is enough to heal the endpoint through the hook's failover (`managed-script.ts:146-152`). `-e` is safe to send on every call because it is ignored when the session already exists.

## A09

**Nodes of SSH projects open against the desktop's LOCAL tmux, creating an empty phantom session and offering to resume the conversation on the wrong machine**

- Severity: **medium** (BLOCKS first release); claimed by auditor: medium; effort: small; area: protocol; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SessionsTab.kt:141`
- Note: Same issue as A28.

**Evidence**

SessionsTab lists every project's sessions, including ones labelled "on user@host" (sshTarget != null), and `onClick` pushes Route.Terminal for any node. Over SSH, SshScripts.attach runs `tmux -L node-terminal new-session -A -s nt-<id>` on the DESKTOP. Over the relay, host-service calls `attachDetached(nodeId, sinks, { cols, rows })` with no sshRemote/requireRemote; pty-manager.ts:2254-2259 says the relay host 'passes only {cols, rows}', so the spawn is local. Neither path finds the session, so `fresh=true`, and TerminalController:253 offers `claude --resume <sid>` in a local shell. CLAUDE.md states 'A remote node is NEVER spawned locally'. The desktop expects phones to reach those sessions on their own host: the mirror pushes per-project slices to `~/.nodeterm/agent-status-<projectId>.json` on the SSH host (docs/mobile-usage-inbox.md), and index.ts's ack sweep notes 'a Mac→SSH node's acks land on the REMOTE fs'. For the same nodes, SshScripts.answerApproval checks for `$HOME/.nodeterm/pending/<id>.json` on the desktop, but the managed hook writes it on the SSH host, so the phone prints `gone` and reports ALREADY_HANDLED for a live approval.

**Proposed fix**

Until the phone can reach the SSH host itself, disable open/resume for nodes whose project has an sshTarget (say why in the row). On the SSH transport, route approvals for those nodes to the relay verb (the desktop writes over the ControlMaster) or show "open on computer".

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Three small corrections, plus a better fix:
> 
> - **"Neither path finds the session, so fresh=true" is not always true.** On the relay, `sessionExists` first checks `liveSessionForPersistKey` (pty-manager.ts:2583). If the SSH node is mounted on the desktop at that moment, the answer is "exists", so `fresh=false`. The phone then gets a blank local shell with no resume offer and no indication that anything is wrong.
> - **The orphan session sticks.** After the first open, the orphan `nt-<id>` stays on the local `node-terminal` socket. Later opens attach to it as a warm session. `listNodetermSessions` also lists it, so the phone starts reporting the SSH node as running.
> - **More entry points than line 141.** The same unguarded open exists at SessionsTab.kt:148, BoardTab.kt:172 and InboxTab.kt:81. "End session" over the relay (SessionsTab.kt:219-220) also attaches first, which creates the orphan before destroying it. Over SSH, `sendKeys` quick answers for these nodes hit a local session that does not exist, so tmux exits 1 and the app shows an error.
> 
> **Better fix — two layers:**
> 1. **Phone:** block open, resume and key-based quick actions for nodes whose project has an `sshTarget`, and say why ("runs on user@host — open it on the computer"). On the SSH transport, send approvals for those nodes to the relay verb when a relay connection exists, otherwise show "open on computer".
> 2. **Desktop:** in `handleAttach`, refuse `pty.attach` for a node where `workspaceStore.sshProjectIdForNode(nodeId)` is set, instead of letting `attachDetached` create a local session. This applies the existing "a remote node is never spawned locally" invariant to the relay attach path as well. It also protects the iOS relay path, which this repo cannot see.

## A10

**Debug APKs from CI change signature from run to run; README offers them as the install route, and updating means uninstalling, which wipes pairings**

- Severity: **medium** (BLOCKS first release); claimed by auditor: medium; effort: small; area: ci-docs; kind: risk
- Location: `README.md:228`

**Evidence**

README.md:227-228 says 'Android — build it from android/ ...; CI also attaches a debug APK to every run of the Android workflow.' android/README.md:37-38 says the same. The app job uploads `android/app/build/outputs/apk/debug/*.apk` (android.yml:77-80). app/build.gradle.kts has no `signingConfigs`, and no debug keystore is committed. android/.gitignore has a `!debug.keystore` exception, but no such file exists and nothing would use it. So each APK is signed with whatever ~/.android/debug.keystore the ephemeral runner has; AGP generates a fresh one when none exists, and runner images are rebuilt regularly. Installing a later run's APK over an earlier one then fails with a signature mismatch (INSTALL_FAILED_UPDATE_INCOMPATIBLE). The only way forward is uninstall. The manifest sets `android:allowBackup="false"` (AndroidManifest.xml:13), so uninstalling irrecoverably drops every paired computer and the Keystore-held relay/SSH identities. Workflow artifacts also require a GitHub login and expire after the default retention period.

**Proposed fix**

Commit a debug keystore and wire `signingConfigs.getByName("debug").storeFile` to it (the .gitignore exception suggests this was intended), or publish consistently signed APKs as release assets. Until then, drop the 'CI attaches a debug APK' install advice or warn that updates need an uninstall and re-pair.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause and citations are right. One refinement: the per-run key change comes mainly from each GitHub-hosted job running on a fresh VM with an empty `~/.android` (nothing in android.yml caches or injects a keystore), not from image rebuilds.
> 
> The first proposed fix is unsafe as written. Committing `debug.keystore` to this public repo, which the `!debug.keystore` .gitignore exception invites, makes the signing key public. Anyone could then build an APK that installs as an in-place update over users' installs. An update keeps the app UID, so that APK inherits the app's data dir and its AndroidKeyStore key. It could then decrypt the SecureStore secrets, including the SSH private key that paired computers trust in authorized_keys and the relay identity.
> 
> Safer options:
> - Sign CI builds with a key held in GitHub Actions secrets (a `signingConfig` fed from env vars, used only in CI), and publish those APKs as release assets.
> - Or, until then, reword README.md:227-228 and android/README.md:37-38. Say CI artifacts are for testing only, that each one needs an uninstall and fresh pairing, and that a locally built APK is the route to keep for updates. A local build is stable because it uses the developer's own `~/.android/debug.keystore`.
> 
> Also drop the `!debug.keystore` exception, so nobody commits a public signing key by accident.

## A11

**Tapping an Inbox notification while the app is in the background does not open that computer**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: build; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/MainActivity.kt:67`
- Note: Same issue as A19.

**Evidence**

The notification's PendingIntent carries `putExtra(MainActivity.EXTRA_HOST_ID, host.id)` with `FLAG_ACTIVITY_NEW_TASK or FLAG_ACTIVITY_CLEAR_TOP` (InboxNotifier.kt l.97-104). MainActivity is `android:launchMode="singleTask"` (AndroidManifest.xml l.24). So when the activity already exists (the common case: app backgrounded with Home), Android delivers the intent to `onNewIntent`, not `onCreate`. `onNewIntent` only does `super.onNewIntent(intent); takePairLink(intent)` (l.67-70), and takePairLink ignores anything that is not a `nodeterm://pair` VIEW intent. EXTRA_HOST_ID is only read in onCreate (`val openHost = intent?.getStringExtra(EXTRA_HOST_ID)`, l.83), and it is consumed inside `remember { Navigator(...) }`, which never re-runs.

**Proposed fix**

In onNewIntent, read EXTRA_HOST_ID into a Compose state, as incomingPairCode already is, and push `Route.Host(hostId, tab = 2)` from a LaunchedEffect keyed on it. Call setIntent(intent) as well.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The diagnosis and line numbers are correct, but the proposed fix is incomplete.
> 
> HostScreen.kt:62 creates the tab as `var tab by rememberSaveable { mutableIntStateOf(initialTab) }`, keyed on neither `hostId` nor `initialTab`. AppContent (MainActivity.kt:112-118) renders every `Route.Host` from the same `when` branch. So if the user is already on a Host screen when the notification arrives, pushing `Route.Host(hostId, tab = 2)` recomposes the same HostScreen slot and keeps the old tab value. The Inbox tab would not open.
> 
> The fix therefore needs a second part. Either:
> - key the state, e.g. `rememberSaveable(hostId, initialTab) { mutableIntStateOf(initialTab) }`, or
> - wrap each destination in `key(...)`, or
> - rebuild the stack with `nav.replaceAll(Route.Hosts); nav.push(Route.Host(id, 2))`.
> 
> The rest of the proposed fix is right: store the extra in a Compose state from `onNewIntent`, call `setIntent(intent)`, and check `graph.hosts.get(id) != null` the same way `onCreate` does.
> 
> Minor: `FLAG_ACTIVITY_CLEAR_TOP` has no effect on a singleTask root activity. It is harmless but does not help here.

## A12

**Relay sendKeys (question answers, legacy approvals) writes into a pty that does not exist yet and then kills it immediately, so the keystroke can be lost while the UI reports success**

- Severity: **medium**; claimed by auditor: medium; effort: medium; area: protocol; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/RelayHostConnection.kt:266`

**Evidence**

Android: `val stream = attach(nodeId, 80, 24, sink); try { stream.write(keys) } finally { stream.detach() }`. The Input frame goes out as soon as the attach RESPONSE arrives, and `pty.kill` follows immediately. Desktop host-service.ts: the response goes first (`socket.respond(req.id, true, { streamId, fresh: !existed })`, line 423). Only after an async `captureSnapshot` does it set `stream.sessionId = pty.attachDetached(...)` (line 432), which spawns a brand-new tmux client (relay ptys are never co-attached: pty-manager.ts:3446-3450, 'Detached (relay-served) ptys are deliberately NOT indexed'). An Input that arrives first hits `pty.write(getClientId(), '', data)`. PtyManager.write (pty-manager.ts:3909-3911) finds no session for '' and falls through to `backgroundWriteBySessionId('')`, which matches nothing, so the input is dropped. If the client was spawned in time, the `pty.kill` processed right after it calls releaseClient → `releasePty` → `proc.destroy()` on a tmux client that has only just been spawned, before it is known to have read and forwarded the byte. The interop fixture's fake `write` accepts any sessionId, so this is not covered by tests. The throwaway 80x24 client also becomes tmux's latest client (the generated conf sets no window-size), so the desktop pane briefly resizes as the key lands.

**Proposed fix**

Don't write until the stream is live: wait for the first OP.Output after SnapshotEnd, which proves attachDetached ran and the tmux client painted. Then write, and delay the detach briefly (or until the pane echoes). Attach at the phone's normal size, not 80x24.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is right on substance. Corrections and additions:
> 
> (a) The kill-after-write loss is worse than "before it is known to have read and forwarded the byte". In node-pty 1.1.0, `write` is an async threadpool `fs.write`, while `destroy()` closes the master straight away (unixTerminal.js:215-225, 296-341). So the byte may never reach the pty at all. Closing the master also hangs up the slave, which likely discards input tmux has not read yet.
> 
> (b) The Esc Deny fallback (QuickActions.kt:37) is lost almost every time, not just sometimes. tmux holds a lone ESC for `escape-time 10` ms (pty-manager.ts:299), and the client is killed well inside that window.
> 
> (c) In the pre-attach race, `attachDetached` never runs, because `handleKill` drops the stream first and the capture continuation returns at host-service.ts:428. It is a clean drop, not a late write.
> 
> Better fix: add a desktop relay verb such as `node.sendKeys {nodeId, keys}`, backed by PtyManager's existing background write / tmux send-keys path. That is the same deterministic route the SSH transport uses, and it needs no throwaway tmux client. Gate it by capability ("not served" means open the session). The PR already adds desktop verbs (`approvals.answer`, `inbox.ack`), so this fits.
> 
> If you stay client-only instead:
> - attach at the phone's real size;
> - wait for the first OP.Output after SnapshotEnd (proof that attachDetached ran and the tmux client is painting) before writing;
> - keep the stream open for well over escape-time, or until the pane echoes, before sending `pty.kill`.
> 
> Either way, `sendKeys` should report failure instead of Unit so that QuickActions does not return SENT unconditionally.

## A13

**Registering a phone-started node while the phone is attached lets the desktop's own client attach with `-D`, which detaches the phone; Android then reports the session as ended**

- Severity: **medium**; claimed by auditor: medium; effort: medium; area: protocol; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:238`

**Evidence**

afterAttach types the launch line and then calls `conn.registerNode(...)` while its relay stream is still attached. Desktop side: `appendRemoteNodeNow` broadcasts `IPC.workspaceExternalChange` (workspace-store.ts:1629). The active project reloads silently, the new TerminalNode mounts and calls create(). create() cannot co-attach to the relay's session, because relay ptys are not in `byPersistKey` (pty-manager.ts:3446-3450). So it spawns a painter with `tmuxAttachFlags(false)` = `['-A', '-D']` (pty-manager.ts:751). `-D` detaches every other client, including the relay-served one. That client exits 0, host `onExit` sends `OP.Error {exitCode:0}`, and Stream.accept calls `sink.onExit(0)`. TerminalController turns that into `TermState.Ended("The session ended (exit 0).")`.

**Proposed fix**

Treat an exit that comes back while the tmux session still exists (re-check isLive / has-session) as a detach, and re-attach automatically instead of showing Ended. Separately, ask the desktop side to co-attach relay viewers instead of `-D`-kicking them.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The mechanism is right, but the impact is overstated in three ways:
> 
> 1. It is recoverable with one tap. The Ended screen has a "Reattach" button (TerminalScreen.kt:89-95) that calls `controller.attach()`. Once the desktop client is attached, that re-attach co-attaches without `-D` and works. The real harm is a false "The session ended (exit 0)." message and a lost view, not a lost session. Medium is borderline; medium-low fits better.
> 
> 2. The immediate kick needs the target project to be the ACTIVE tab on the desktop, not merely open. A background project only gets `replaceProject()`, and its node mounts later on a project switch. That switch then kicks the phone if it is still attached.
> 
> 3. Line refs:
>    - the no-index code is pty-manager.ts:3418 (the `indexKey` line) plus the comment and `set` at 3446-3449;
>    - the renderer spawn with undefined sinks is in `spawnNew` around line 2290.
> 
> Better fix: fix the root cause on the desktop, which also covers iOS. When PtyManager spawns a renderer client for a persistKey that has a live detached (relay) session, it should attach with `-A` and no `-D`. Either track detached sessions by persistKey, or have the renderer spawn check for a live relay pty, as the comment at pty-manager.ts:740-748 already intends. This does not cover the SSH-transport phone's client, which is not in this process's session table, so the Android-side guard below is still needed for that case.
> 
> On Android, as a fallback, treat an exit code of 0 as a possible detach rather than an end. If the node is still in the next snapshot or listing, or a has-session check succeeds, re-attach once automatically. Otherwise show a "Detached — another viewer took over" state instead of "ended".


## Direct SSH coattachment follow-up (A13, 2026-10-04)

Fixed in `ed2965be` after the beta-14 APK checkpoint. A current Desktop app attaches beside
external SSH/relay clients, then replaces only a live app painter attested by an exact PID/birth
receipt in the same private userData profile and tmux socket/session. Both old and incoming client
identities are rechecked in the tmux command queue before an exact-client detach. A failed or
departed new attach cannot evict the old viewer. Unknown, legacy unmarked and other-profile clients
survive; missing process attestation preserves viewers. Existing per-manager joins and grid policy
remain. Exit/quit releases the exact receipt; only proven stale receipts are pruned within bounds.

Private controls/restored pass 122 focused tests and full TypeScript checking. Twenty-four distinct
isolated mutations fail assertions; three critical variants are additionally caught against the
actual tmux server. Seven real private-socket tmux control-client methods pass without skips on
tmux 3.7c: both phone/app attachment orders, unequal native pane grids, remounts, foreign/legacy
clients and stale-client races. Control-client height formatting is empty on this host, so grid
evidence reads the native pane and checks phone-only restoration.

An additional Linux smoke at source `32d412b6` passes eight checks using cached Electron 42.11.3,
Node 24.19.0, actual node-pty and tmux 3.7c. It exercises the production `PtyManager` and painter
tracker in a private home/tmp/run/PID/network namespace: external/app attachment in both orders,
same-manager joins, selective app remount takeover with exact shell output retained, and normal
quit receipt cleanup while the external client and shell survive. Observed native pane grids
return to 56×48 after the 100×40 app replacement leaves. The in-memory `CorePlatform` adapter is
an explicit IPC boundary; no actual renderer, SSH handshake, relay, Pixel, macOS or Windows runtime
pass is claimed. The cached native binding, Electron binary, all 96 bundled source inputs and
external node-pty wrappers are hash-bound and unchanged across the final run.

The private painter receipts are internal app state, outside the phone's named workspace/status/
project files; no host-service verb, payload, mirror or client wire shape changes. Android keeps
its exit-zero reattach fallback for older hosts. The same host policy preserves iOS SSH clients;
@eneskirca should verify physical coattachment. Prepared beta 14/code 15's Android client remains
unchanged and uninstalled; host-side verification uses the later source. The device ledger stays
10 Pass / 22 Partial / 32 Pending, and phone testing remains paused.

## A14

**New sessions in cwd-less (inline) projects are never registered: the desktop refuses them, the refusal is ignored, and the session is orphaned**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: protocol; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SessionsTab.kt:289`

**Evidence**

NewSessionDialog offers `snapshot.openProjects().filter { it.sshTarget == null }`, which includes cwd-less canvases. The desktop registrar only handles folder refs: `const e = this.index?.entries.find((x) => x.id === projectId && x.cwd); if (!e?.cwd) return false` (workspace-store.ts:1607-1608), so the answer is `{registered:false}`. TerminalController.afterAttach wraps the call in `runCatching { conn.registerNode(...) }` and never reads the Boolean. host-service documents a refusal as an answer: 'the phone opened its session either way and just stays unregistered'.

**Proposed fix**

Only offer projects that have a cwd, and check `registered`. On false, tell the user and offer to end the session (or keep it reachable from a phone-local list).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two corrections to the impact, and one to the fix.
> 
> - **Not wholly invisible on the desktop.** The canvas never shows the session, but the desktop's session-memory panel (RAM pill) lists every `nt-*` session. It labels unowned ones as orphans and offers a kill button. So the tmux session can still be found and ended from the desktop; it is not a completely invisible leak.
> - **Two lines to cite.** The offer is at `SessionsTab.kt:289` (and the FAB gate at `HostScreen.kt:71-72`). The ignored refusal is at `TerminalController.kt:236-239`.
> - **The fix has two parts.**
>   1. Filter the dialog and the FAB gate on `it.cwd != null` as well as `it.sshTarget == null`.
>   2. Read the result of `registerNode` instead of swallowing it. This is still needed after the filter, because a folder project can also be refused: its `project.json` may be unreadable or corrupt, or the account binding may be refused. On `false` or an exception, tell the user the session was not added to the project, and offer to end it or keep it reachable (for example, a phone-local list of unregistered live sessions).
> 
> Registering before typing the launch line is not an option: the code comment says registering first would let the desktop cold-mount the node and launch the agent a second time.

## A15

**The cold-attach resume offer drops the node's managed Claude account (and on the relay, its cwd), so the resume fails with 'No conversation found'**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: protocol; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:253`

**Evidence**

On `s.fresh` the phone offers `Launch.resumeCommand(agent, sid)`, which is bare, e.g. `claude --resume <sid>`. It ignores `node.accountId` (parsed in ProjectsParser.parseNode) and settings.claudeAccounts[].dir. The desktop's cold restore runs inside a pty spawned with the node's account env (`CLAUDE_CONFIG_DIR` via tmux `-e`, pty-manager accountTmuxEnvArgs) and the node's cwd, and wraps the command in `withPermissionMode`. A relay cold attach creates the session with only `{cols, rows}`: no account env and cwd = $HOME (pty-manager.ts:2254-2259). A managed account's transcript lives under `<accountDir>/projects/…`, so running under the default `~/.claude` finds nothing.

**Proposed fix**

Build the resume line the way launchCommand builds a first launch: `cd '<node cwd>' && CLAUDE_CONFIG_DIR='<dir of node.accountId>' claude --resume <sid>`, plus the permission-mode flag as the desktop's cold restore would add it.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Mostly accurate. Four refinements:
> 
> 1. **Impact on the relay is probably wider than managed accounts.** Relay cold attach also drops the cwd, and Claude finds a transcript at `<configDir>/projects/<encoded cwd>/<id>.jsonl` (the CLAUDE.md measurement). So `claude --resume <sid>` typed into a relay-recreated pane in $HOME likely fails for system-account Claude nodes too, not only managed ones. That part is inferred from the CLAUDE.md note, not measured here. On direct SSH the cwd is already supplied through `new-session -c`, so there only the account (and permission mode) is missing.
> 
> 2. **The fix belongs in `Launch`.** Add a resume builder that shares `launchCommand`'s prefix logic: `cd '<abs node cwd or project cwd>' &&` gated on `SAFE_DIR`, then `CLAUDE_CONFIG_DIR='<dir>'` only for CLAUDE and only when `node.accountId` matches a `settings.claudeAccounts` entry. Call it from TerminalController.kt:253 with `node?.accountId` and `node?.cwd ?: project cwd`.
>    - The cwd must be absolute. Portable `./` cwds are only resolved on the SSH listing path, in `SshHostConnection`.
>    - Add the same Claude-only permission-mode flag.
> 
> 3. **It remains a partial fix.** It cannot reproduce the desktop's `AUTH_ENV_STRIP` removal of an inherited `ANTHROPIC_API_KEY`. The relay-created pane also still gets no hook env, so status reporting from that pane stays dark.
> 
> 4. **Codex is not fixable from the phone.** Managed Codex accounts (`CODEX_HOME`) are dropped the same way, but the mirror does not advertise Codex account homes.

## A16

**The phone's launch ignores the project's own permission mode (and default account), so a project the user set to a stricter mode starts in the global mode**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: protocol; kind: gap
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/model/Agents.kt:59`

**Evidence**

Android: `val mode = settings?.claudePermissionMode?.takeIf { it in PERMISSION_MODES } ?: "manual"`, i.e. the global mirror value only. The desktop resolves `resolvePermissionMode(project, settings)`, 'the project override, else the global setting' (shared/agents/config.ts:754). `defaultPermissionMode` is carried through project.json into the assembled workspace that `projects.list` serves (workspace-files.ts:377/540), and so is the machine-local `defaultAccountId`. ProjectsParser.parseProject reads neither, and NewSessionDialog defaults the account to System.

**Proposed fix**

Parse `defaultPermissionMode` and `defaultAccountId` in ProjectInfo, and resolve project → global exactly as resolvePermissionMode does (keeping the claude-only autoSupported degrade).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is correct. Three points to make it more precise:
> 1. The loosening to `auto` happens only when the mirror's `autoSupported` is true. Otherwise the global `auto` degrades to the bare command, which is manual, so a stricter project is not loosened in that case. It does still happen when the global mode is `acceptEdits` or `bypassPermissions`, because those modes are emitted without any version gate. The reverse direction also exists: a project override that is looser than the global mode is ignored as well. That is a parity gap, not a security issue.
> 2. More file:line locations for the fix:
>    - SessionsTab.kt:293 (accountId initialised to null)
>    - SessionsTab.kt:330 (launchCommand is not given the project)
>    - ProjectsParser.kt:52-61 (neither field is parsed)
>    - Models.kt:31-42 (ProjectInfo has neither field)
> 3. Fix:
>    - Parse `defaultPermissionMode` and `defaultAccountId` into ProjectInfo.
>    - Pass the project, or the resolved mode, into `launchCommand`, and resolve project → global → default using the same `isPermissionMode` re-validation the desktop uses. Keep the claude-only `autoSupported` degrade after resolving.
>    - Preselect `project.defaultAccountId` in NewSessionDialog, but only when it matches an entry in the mirror's `claudeAccounts`. That mirrors how the desktop validates an account id before stamping it on a node; a stale id should fall back to System.

## A17

**The background inbox worker dials the relay for unapproved phones, putting the desktop's SAS approval dialog up every 15 minutes with no code on the phone to compare it against**

- Severity: **medium**; claimed by auditor: low; effort: small; area: protocol; kind: risk
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:124`
- Note: Same issue as A05.

**Evidence**

InboxWorker runs `withTimeoutOrNull(45_000) { session.refreshNow() }` for every paired host. refreshNow calls ensureConnected, which calls RelayConnector.connect and then polls `projects.list` while the host answers 'Awaiting host approval.'. On the desktop, standing-host.ts onPeerReady sends `remoteHostPeerPending` for any unpinned key, and the consent record outlives the socket by 120 s (#819). A reject pins nothing, so the next run prompts again.

**Proposed fix**

Skip relay connects from the worker until this phone's key has been approved once in the foreground (record that locally after the first successful relay listing).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The cited line (InboxNotifier.kt:124) and the mechanism are right. Two refinements:
> 
> 1. The trigger is broader than "never approved or rejected" phones. On a macOS/Linux computer, every phone that paired on the LAN and has only ever connected over SSH still has an unpinned box key, because pairing-service does not pin it; only standing-host's SAS approval does. That includes phones that picked up a relay block through the QR or through adoptRelayIfAdvertised (ConnectionManager.kt:165-187). The first time such a phone is off the LAN, the SSH attempt fails (4 s AUTO timeout) and the background worker dials the relay. The desktop then gets an unexpected SAS dialog whose code nobody can see. For this app that is the common first-off-LAN path, not an edge case.
> 
> 2. The fix has to be "don't dial the relay at all from the worker until approved". An early abort would not help: the desktop raises the dialog in onPeerReady as soon as the handshake completes, before any request, and keeps it for 120 s after close. Concretely:
>    - Persist a per-host `relayApproved` flag in HostStore when RelayConnector.connect returns (a successful projects.list means the key is pinned).
>    - Skip the relay leg in background runs until that flag is set, e.g. by passing an `allowRelayApproval=false` / background mode into connectLocked.
>    - If the host later answers AWAITING_APPROVAL_MESSAGE (the pin was revoked), clear the flag.
> 
> Side note found while verifying: connectLocked's `catch (e: Exception)` at ConnectionManager.kt:123 also catches the worker's timeout CancellationException (it is an Exception subclass) and rewrites it as a HostException. It is harmless here, because withTimeoutOrNull still returns null, but cancellation is not propagated cleanly.

## A18

**No lifecycle handling: a backgrounded app keeps the 8 s poll and its relay terminal stream alive indefinitely**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalScreen.kt:58`

**Evidence**

- TerminalScreen.kt:57-63 and HostScreen.kt:65-68 call `session.startWatching()` (and the terminal attaches) inside DisposableEffect. DisposableEffect disposes only when the composable leaves composition, not on ON_STOP.
- Nothing under android/app references Lifecycle, onPause/onResume or WebView.onPause (grep).
- ConnectionManager.kt:211-222: pollJob runs on graph.scope, looping `refreshNow(); delay(POLL_MS)` while watchers > 0. Its own KDoc calls this "the iOS foreground cadence".
- Desktop side: host-service.ts:397-402 calls `remoteViewer?.attached(nodeId)` for the relay stream's whole lifetime. index.ts:3970-3978 says this set makes "Eco's isNodeWatched stop hibernating a session someone is watching from a phone". On the session host a relay sink is bounding (pty-manager.ts:3701 `const bounding = session.sizes.has(null) && !session.sinkAdapts`).
- InboxNotifier.kt:127 never disconnects a session whose isWatched is still true.

**Proposed fix**

Tie watching to the Activity lifecycle: use a LifecycleEventObserver on LocalLifecycleOwner, or repeatOnLifecycle(STARTED). On ON_STOP call stopWatching, detach the terminal stream and call webView.onPause(). On ON_START watch again and reattach.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> 1. **"Indefinitely / until the OS kills the process" is overstated.**
>    - When the screen is off and no wakelock is held, the CPU sleeps. Doze and app-standby later cut network access.
>    - On Android 14+ (and some 12/13 builds), the cached-app freezer stops a process once it drops to the cached state.
>    - The accurate claim: the loop keeps running for as long as the process is not frozen or asleep. That covers the whole Home or app-switch window, and screen-lock until the device sleeps. While the process is alive, the phone's keepalives stop the desktop from dropping the stream, so an agent streaming output keeps waking the radio.
>    - The desktop effects (Eco shielding, the session-host size ceiling) are real, and they apply specifically to the relay stream: `remoteViewer` exists only in `host-service`. On SSH, a tmux client simply stays attached.
> 2. **The terminal attach is not inside the `DisposableEffect`.** It is triggered by the JS `Bridge.onResize` in `TerminalController.kt`; only `startWatching` and `dispose` are in the effect. The conclusion is unchanged.
> 3. **Better fix, using the dependency already declared.**
>    - `lifecycle-runtime-compose` 2.9.1 provides `LifecycleStartEffect`. Use `LifecycleStartEffect(hostId) { session.startWatching(); onStopOrDispose { session.stopWatching() } }` in `HostScreen` and `TerminalScreen`.
>    - In `TerminalController`, add a stop/start pair. On ON_STOP: detach the stream and null `stream`, keeping the WebView, then call `webView.onPause()`. On ON_START: call `webView.onResume()` and re-`attach()`.
>    - Optionally, `InboxWorker` could also disconnect when `ProcessLifecycleOwner` reports the app is not STARTED.

## A19

**Tapping an inbox notification while the activity is alive ignores the target computer**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/MainActivity.kt:67`
- Note: Same issue as A11.

**Evidence**

InboxNotifier.kt:97-104 builds the PendingIntent as `Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_HOST_ID, host.id).addFlags(FLAG_ACTIVITY_NEW_TASK or FLAG_ACTIVITY_CLEAR_TOP)`. The activity is `android:launchMode="singleTask"` (AndroidManifest.xml:24), so a live instance receives the intent in onNewIntent. MainActivity.kt:67-70 is `override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); takePairLink(intent) }`, and takePairLink (:60-65) only reads a nodeterm://pair data URI. EXTRA_HOST_ID is read once, in onCreate (:83 `val openHost = intent?.getStringExtra(EXTRA_HOST_ID)`), into the initial Navigator (:89).

**Proposed fix**

In onNewIntent, call setIntent(intent), read EXTRA_HOST_ID into a mutableState (as incomingPairCode does), and have a LaunchedEffect push Route.Host(hostId, tab = 2).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line citations and root cause are correct. The proposed fix has one gap. HostScreen keeps its tab in `var tab by rememberSaveable { mutableIntStateOf(initialTab) }` (HostScreen.kt:62), and AppContent renders every Route.Host from the same `when` branch (MainActivity.kt:116). So pushing Route.Host(hostId, tab = 2) while the current route is already a Route.Host keeps the existing saved tab and ignores `initialTab`. That covers two cases: the user is on that computer's Sessions or Board tab, or they are on a different computer's host screen, which also reuses the slot and its state. The fix needs three parts:
> 1. In `onNewIntent`, read EXTRA_HOST_ID into a mutableState, as `incomingPairCode` does (and optionally call `setIntent`).
> 2. In a LaunchedEffect, validate the id with `graph.hosts.get(id)` and push or replace to Route.Host(id, 2).
> 3. Make HostScreen honour the new route: wrap the branch in `key(r) { … }` or use `rememberSaveable(hostId, initialTab)`. Otherwise the navigation does nothing when a host screen is already showing.

## A20

**Cancelling an in-flight connect leaks the SSH connection and records the cancellation as a connection failure**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/conn/ConnectionManager.kt:94`

**Evidence**

- ConnectionManager.kt:79-96: `val ssh = withContext(Dispatchers.IO) { SshHostConnection.connect(...) }` ... `} catch (e: Exception) { errors += "On your network: ..." }`. CancellationException is an Exception, so this swallows it. withContext's prompt-cancellation guarantee then discards the SshHostConnection that the blocking connect returned, and nothing closes it (keepalive is enabled at SshHostConnection.kt:353).
- The catch at :123 swallows cancellation on the relay leg too, and :132-134 then set `ConnState.Failed("...was cancelled...")`.
- The cancellation comes from stopWatching (:225-231, `pollJob?.cancel()` when watchers reaches 0).
- watchers reaches 0 on every Host→Terminal push as well: Compose dispatches onForgotten before onRemembered (checked in the runtime-desktop 1.8.2 RememberEventDispatcher.dispatchRememberObservers bytecode). So HostScreen.kt:67 `stopWatching()` runs before TerminalScreen.kt:58 `startWatching()`.

**Proposed fix**

Rethrow CancellationException in connectLocked before the generic catches. Make the SSH dial close its result when the caller was cancelled, for example by running it as an async in graph.scope and awaiting it, closing the connection if the awaiting coroutine was cancelled. Also consider keeping one watch token across the Host→Terminal hand-off so the poll job is not cancelled on every navigation.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is correct on mechanism and cause. Refinements:
> 
> (a) The leak site is ConnectionManager.kt:79-85: the discarded result, with `adopt` never reached. :94 is where the cancellation is swallowed. The relay leg swallows it again at :123, and :132-134 set `ConnState.Failed` and throw.
> 
> (b) The wrong "offline" state is not always brief. When the user backs out of HostScreen, nothing else is watching, so no new pollJob replaces it. `ConnState.Failed` stays until the host is reopened: HostsScreen.kt:168/175 shows " — offline" in the attention colour, and `_lastError` holds "StandaloneCoroutine was cancelled". It is brief only on the Host→Terminal hand-off, where TerminalScreen's new pollJob reconnects. That reconnect is a second dial, while the first connection stays leaked.
> 
> (c) There are more cancellation sources than the poll job. BoardTab.kt:98-99 and InboxTab.kt:83-84 call `session.ensureConnected()` inside a `rememberCoroutineScope()` launch. That scope is cancelled when the tab or screen leaves composition, which triggers the same leak if that coroutine holds the mutex during the dial.
> 
> (d) Fix. Rethrow CancellationException before both generic catches in connectLocked. Also close a dial that finished after cancellation. Two ways:
> - Record the result inside the IO block (`.also { dialed = it }`) and, in a `catch (e: CancellationException) { dialed?.close(); throw e }`, close it. withContext does not resume the caller until the blocking block has returned, so `dialed` is set by then.
> - Run the dial as `graph.scope.async(Dispatchers.IO)`. If the await is cancelled, close the result in `invokeOnCompletion`.
> 
> Keeping one watch token across the Host→Terminal hand-off, or delaying the cancel in `stopWatching`, would avoid needlessly cancelling the pollJob. It does not fix the back-out case or the rememberCoroutineScope callers, so the close-on-cancel change is the real fix.
> 
> (e) Severity medium is reasonable. The leak needs the cancel to land during a dial that then succeeds. Each occurrence leaves one live SSH session to the desktop for the life of the process.

## A21

**A denied POST_NOTIFICATIONS is never re-requested, and the Settings switch still reads On**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SettingsScreen.kt:89`

**Evidence**

- MainActivity.kt:72-82 requests POST_NOTIFICATIONS once, in onCreate, with an empty callback commented `/* the Settings switch reflects it */`.
- SettingsScreen.kt:51 is `var notify by remember { mutableStateOf(graph.hosts.notificationsEnabled) }`. The switch at :89-93 only writes the pref and calls InboxNotifier.schedule; it never checks or requests the runtime permission.
- InboxNotifier.kt:74-76 returns 0 silently when the permission is not granted. Meanwhile the worker still dials every paired computer every 15 minutes.

**Proposed fix**

Show the switch as on only when `notificationsEnabled && permission granted`. When the user turns it on, or opens Settings while permission is denied, launch the permission request. If it is permanently denied, deep-link to Settings.ACTION_APP_NOTIFICATION_SETTINGS. Don't run the worker without the permission.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The permission is not requested "once" or "never re-requested". MainActivity.kt:78-81 runs in every onCreate: every cold start, and every activity recreation such as rotation. It fires whenever the pref is on and the permission is not granted. What actually happens:
> 1. On Android 13+ the system stops showing the dialog after the user denies it twice. From then on `launch()` fails silently, and the app has no path to recover.
> 2. Flipping the Settings switch off and on never requests the permission, and nothing opens the system notification settings.
> 3. The launch-time prompt can repeat on every rotation or cold start until that system cutoff.
> 
> The same "switch says On, nothing arrives" state also happens on API 26-32 when the user blocks notifications or a channel in system settings. There `nm.notify` is a silent no-op and the switch still reads On, so the fix should check `NotificationManagerCompat.areNotificationsEnabled()` (and the channel importance), not only the runtime permission.
> 
> Side effect: `announce` returns before `markSeen` when the permission is missing. After a later grant, every unresolved event from the last 6 hours is posted at once (up to 5 per host, via `fresh.takeLast(5)`).
> 
> Better fix:
> - Derive the displayed state as `pref && areNotificationsEnabled()`, re-checked on resume.
> - Request the permission from the switch, and after pairing the first computer rather than in onCreate.
> - Fall back to `Settings.ACTION_APP_NOTIFICATION_SETTINGS` when `shouldShowRequestPermissionRationale` is false after a denial.
> - Skip or cancel the WorkManager job while notifications are disabled.

## A22

**The Navigator back stack is not saved across activity recreation, and the original launch intent is re-applied**

- Severity: **medium**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/MainActivity.kt:87`

**Evidence**

- :87 `val nav = remember { Navigator(Route.Hosts)... }` uses plain remember, not rememberSaveable, and Route has no Saver.
- AndroidManifest.xml:26 configChanges covers orientation/screenSize/uiMode but not density, fontScale, locale or layoutDirection, so those changes (and process death) recreate the activity.
- onCreate reads `intent` again each time (:83-84), and onNewIntent never calls setIntent.

**Proposed fix**

Save the route stack with rememberSaveable and a listSaver. Only apply the intent's extras/data when savedInstanceState == null, or clear them once consumed.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is accurate. Two refinements:
> 
> (a) Re-opening the Pair screen does not re-submit the used token. PairScreen only pre-fills the parsed payload, and the user must tap "Pair" again, which would then fail on the server. So the impact is a stale screen and a confusing error, not a duplicate pairing.
> 
> (b) A related, more impactful bug sits on the same lines. With launchMode="singleTask" (Manifest:24), a notification tap while the activity already exists is delivered to onNewIntent. That PendingIntent is built with NEW_TASK|CLEAR_TOP in InboxNotifier.kt:99-103. onNewIntent (MainActivity.kt:67-70) only calls takePairLink, which returns early because the intent has no data, so EXTRA_HOST_ID is ignored. Tapping a "Needs you" or "Completed" notification while the app is alive in the background just brings it forward on whatever screen it was on, without opening that host's inbox. Only a cold start honours the extra (:83, :89).
> 
> Fix for both:
> - Save the stack with rememberSaveable and a listSaver, or make Route @Parcelize.
> - In onCreate, consume the intent extras/data only when savedInstanceState == null, or clear them after use (setIntent(Intent(intent).setData(null).removeExtra(...))).
> - In onNewIntent, call setIntent(intent) and route EXTRA_HOST_ID into the same state-holder mechanism as incomingPairCode, so the Compose side pushes Route.Host(hostId, tab = 2).

## A23

**Background inbox worker opens unapproved relay connections, raising desktop SAS approval dialogs the phone never shows**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: security; kind: risk
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:124`
- Note: Same issue as A05.

**Evidence**

InboxWorker.doWork calls `withTimeoutOrNull(45_000) { session.refreshNow() }` for every paired host (line 124). That goes to ensureConnected → connectLocked, which in Auto falls to `RelayConnector.connect(...)` (ConnectionManager.kt:99-122). There is no 'already approved' gate. For an unpinned phone key, the standing host raises the approval prompt on every connect: standing-host.ts:250-261 `if (pub && isPinned(store, pub)) { s.approve() ... }` else `send(IPC.remoteHostPeerPending, { sas: s.sas(), ... })`, and the consent record lives 120 s after the socket closes (#819). On the phone, the AwaitingApproval SAS only lands in `_state` (ConnectionManager.kt:114), which nothing renders while no screen is open. This is the common first relay use: a Mac user who paired and used SSH at home first reaches the relay when the phone leaves the LAN, typically from this worker.

**Proposed fix**

Track a per-host 'relay-approved' flag, set after the first successful RelayConnector.connect in the foreground. In background refreshes, refuse to proceed on AWAITING_APPROVAL_MESSAGE: close immediately, and instead post a notification such as 'Open nodeterm to approve this phone on <computer>'.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two corrections.
> 
> **1. The 120 s window is timed from the prompt, not from the socket close.** `PHONE_APPROVAL_TTL_MS` starts in `approvals.add()` (phone-approval.ts:38-45), which runs when the prompt is raised. It is not 120 s "after the socket closes": the desktop dialog lives about 120 s from when it appears, and the phone's socket closes at about 45 s.
> 
> **2. The proposed fix does not work.** "Refuse to proceed on AWAITING_APPROVAL_MESSAGE: close immediately" is too late. The desktop raises the dialog in `onPeerReady`, as soon as the E2EE handshake completes (standing-host.ts:233-261), before the phone sends any request. So the phone first sees AWAITING_APPROVAL_MESSAGE only after the prompt is already on screen, and closing then still leaves a live dialog for 120 s.
> 
> **A fix that works:**
> - **Skip the relay leg in the background.** Persist a per-host "relay approved" flag and set it after the first successful relay `listProjects` (RelayConnector.kt:72-74). In background (worker) refreshes, do not dial the relay at all while the flag is unset. Post a notification instead, such as "Open nodeterm to approve this phone on <computer>".
> - **Show the code on the phone at any time.** The SAS is derived from the static ECDH `baseKey` (relay-socket.ts:168-170, 236, 602-603 and e2ee.ts `sasFromSharedKey`), so it is stable for a given phone key and host key. The app can compute it from `graph.boxKeys` plus `host.relayHostKeyB64` without connecting. It could then show the code in that notification or on the host screen, so a desktop prompt can always be verified. Today the phone only shows the code during a foreground relay connect, and while the phone is on the LAN the foreground connect goes over SSH and never shows it.

## A24

**SecureStore treats ANY decrypt error as 'absent', so getOrCreate32 permanently overwrites the phone's identity**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: security; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/data/SecureStore.kt:60`

**Evidence**

getBytes wraps key lookup, `cipher.init` and `doFinal` in `catch (_: Exception) { null }` (lines 55-64). That catches KeyStoreException, ProviderException, IllegalStateException and other transient keystore failures, not only 'key wiped / wrong device'. getOrCreate32 (lines 77-82) then writes fresh random bytes over the stored value: `getBytes(name)?.takeIf { it.size == 32 }?.let { return it }; val fresh = ...; putBytes(name, fresh)`. AppGraph uses it for both BOX_SECRET and SSH_SEED (NodetermApp.kt:144-147).

**Proposed fix**

Regenerate only on positive evidence: the alias is absent (a new key was just generated), or decrypt fails with AEADBadTagException / KeyPermanentlyInvalidatedException. For any other exception, rethrow or retry and never overwrite. Consider `commit()` for the first write of the identity secrets.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> 1. Wrong location: the AppGraph uses are at NodetermApp.kt:25 and NodetermApp.kt:28, not lines 144-147 (the file has only 51 lines).
> 
> 2. The impact is overstated. The desktop does not "stop accepting" the phone. A relay connect with a new box key reaches standing-host.ts onPeerReady (lines 249-262). The key is not pinned, so the desktop raises a new SAS approval dialog: `approvals.add(pub)` + `remoteHostPeerPending`, and the phone shows AwaitingApproval (ConnectionManager.kt:111-113). The relay device token is not tied to the phone's key; it is minted from deviceId, hostDeviceId, hostPublicKeyB64 and label. So the real cost is:
>    - every paired computer has to re-approve the phone, which needs someone at the desk, and that is the one thing a phone user usually cannot do;
>    - direct SSH fails authentication until the phone is re-paired, because authorized_keys still holds the old public key.
>    In AUTO route, ConnectionManager.kt:75-95 catches the SSH failure and falls back to the relay; SSH_ONLY hosts are simply broken. The stale authorized_keys lines are harmless leftovers: the old seed has been overwritten, so nothing can use them.
> 
> 3. The trigger is narrower than implied. Kotlin's `lazy` does not cache a thrown exception. So if `key` fails to initialise in both `getBytes` and the `putBytes` that follows it, `putBytes` throws out of `getOrCreate32`, the lazy `boxKeys`/`sshIdentity` throws, and the result is a failed connection with no overwrite. An overwrite needs one of two things:
>    - (a) a failure specific to decryption (in `init` or `doFinal`) while encryption, a moment later in the same synchronized call, succeeds; or
>    - (b) `ks.getKey(ALIAS, null)` briefly returning null.
>    Case (b) is worse. Line 31 then calls `KeyGenerator.generateKey()` under the same alias, which replaces the Keystore key itself, so every stored secret becomes undecryptable, the relay tokens included. How often Android Keystore actually does either was not measured here. Without that, severity is medium at most, arguably low.
> 
> 4. The fix needs adjusting. KeyPermanentlyInvalidatedException cannot happen here, because the key has no user-authentication requirement (no `setUserAuthenticationRequired` in lines 34-38). The positive evidence of loss is:
>    - the alias was absent when the key was created (check `ks.containsAlias(ALIAS)` explicitly, and generate only in that case);
>    - AEADBadTagException on `doFinal`;
>    - a malformed blob: IllegalArgumentException from Base64, or a blob shorter than IV + tag.
>    Every other exception should propagate, like the desktop's PeerKeyLockedError, and never lead to a write. `getBytes` should return a three-way result (absent / value / unreadable-now) instead of `ByteArray?`. The relay-token readers (ConnectionManager.kt:101, HostsScreen.kt:121) have the same null-on-error behaviour. For them it only produces a misleading "Remote access isn't set up" message and deletes nothing.

## A25

**No real push notifications: 15-minute background polling, no notification actions, no Live-Activity equivalent, and the desktop's phone-push switches are ignored**

- Severity: **medium**; claimed by auditor: high; effort: medium; area: parity; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:64`
- Note: Related: A73.

**Evidence**

iOS gets server-sent pushes that wake the app: src/core/push-notify.ts:1-8 ("Desktop → paired-phone APNs push … a paired iPhone should get a real APNs push even with the app backgrounded/killed"). Those pushes carry actions: push-notify.ts:57-58 ("The backend renders them as numbered notification actions"). They also drive Live Activities: push-notify.ts:455 ("`POST {apiBase}/v1/push/live-update`, feeding iOS Live Activities"). The user controls them per host and per kind: src/shared/types.ts:1770-1786 (`mobilePushNeedsYou`, `mobilePushDone`, `mobileLiveActivities`, `mobilePushPresenceAware` "Hold phone ALERTS while you're actively at this computer"), and push-notify.ts:92-97 describes a per-host mute (#435). Over plain SSH, iOS drops a grant at `~/.nodeterm/push-grants/<deviceId>.grant` (src/core/remote-push-grants.ts:1-12). Android only polls: `PeriodicWorkRequestBuilder<InboxWorker>(15, TimeUnit.MINUTES)` (InboxNotifier.kt:64). `build()` (InboxNotifier.kt:105-116) creates a plain notification with no `addAction` for Approve/Deny/options, and its tap opens the computer (`putExtra(MainActivity.EXTRA_HOST_ID…)`, :101), not the session. `announce()` posts every unresolved kind with one global switch (`graph.hosts.notificationsEnabled`), so the desktop's Needs-you/Done toggles, presence deferral and per-host mute do not apply.

**Proposed fix**

Add an FCM leg to the backend's `/v1/push/notify` and `/v1/push/live-update`, sharing the existing host-identity and grant auth. Then register an FCM token and write a push grant from the phone. Until that exists: add notification actions (Approve/Deny through `QuickActions`, numbered option actions), deep-link the tap to the node's terminal, and honor the mirror's push preferences if they are published.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Downgrade to medium and restate it as three app-side gaps plus one backend dependency that is already documented:
> (a) Backend (documented at InboxNotifier.kt:31-39, android/README.md:52-57, docs/android.md:90-91): with no FCM leg in `/v1/push/notify` and `/v1/push/live-update`, the app can only poll with WorkManager every 15 minutes, and there is no Live Activity equivalent.
> (b) InboxNotifier.kt:105-114: no notification actions. Add Approve/Deny for APPROVAL and numbered options for QUESTION, handled by a BroadcastReceiver that calls the existing `QuickActions.answerApproval` / `answerQuestion`.
> (c) MainActivity.kt:67-70 and :83-90: with `launchMode="singleTask"`, a tap while the app is alive goes to `onNewIntent`. That only handles the pair link, so the notification's `EXTRA_HOST_ID` is dropped and nothing navigates. Handle it in `onNewIntent`, and add the node id so the tap can open `Route.Terminal` or the Inbox entry.
> (d) Only one global switch (HostStore.kt:83), with no per-host mute.
> Drop the claim that desktop toggles are ignored. `mobilePushNeedsYou`, `mobilePushDone` and `mobilePushPresenceAware` are not in `MirrorSettings` (agent-status-mirror.ts:173-197), so no phone can read them. They only gate the desktop's own APNs send. Android already has separate attention and done channels (InboxNotifier.kt:41-55) for per-kind control.

> Mostly correct, with these fixes:
> 
> **Severity: medium, not high.** The gap is documented (InboxNotifier.kt:31-39, android/README.md:54-57, docs/android.md:90-91), and its root cause is that the backend's `/v1/push/*` is APNs-only. That backend is outside this repo.
> 
> **The deep-link claim is wrong; replace it with the real bug.**
> - The tap does go to the Inbox tab: `Route.Host(openHost, tab = 2)` (MainActivity.kt:88), and tab 2 is Inbox (HostScreen.kt:112).
> - The actual defect: MainActivity is `singleTask` (AndroidManifest.xml:24), and `onNewIntent` (MainActivity.kt:67-70) handles only pair links.
> - `EXTRA_HOST_ID` is read only in `onCreate` (MainActivity.kt:83).
> - So with the app task alive, a notification tap does not navigate at all.
> - Fix: handle `EXTRA_HOST_ID` in `onNewIntent`, e.g. through a state flow the navigator observes. Also consider adding a node id so the tap can open that session directly.
> 
> **Desktop toggles: the proposed fix won't work as written.** The toggles are not published: `MirrorSettings` (src/core/agent-status-mirror.ts:173-197) has no push fields, so "honor them if published" is not possible today.
> - Doing it needs a desktop change: add the needs-you/done/presence flags to `MirrorSettings`.
> - Android already offers per-kind muting through its separate `attention`/`done` channels (InboxNotifier.kt:48-55).
> 
> **Live Activities:** not an independent gap. The Android equivalent (an ongoing notification) would also need FCM or a foreground service.
> 
> **Fixable in-app now:**
> - Add `addAction` Approve/Deny and numbered options in `InboxNotifier.build`, handled by a BroadcastReceiver or worker that calls the existing `QuickActions` (QuickActions.kt:23-48). Only claude approvals can be answered this way (QuickActions.kt:35-37); others return OPEN_SESSION.
> - Fix the `onNewIntent` deep link.

## A26

**Current follow-up:** A107 serves direct Git on admitted local/driven folders independently of
the actions service. A108 adds selected-profile SSH Board on Desktop/Server and delivery-only
node nudges on Desktop. A manually added SSH host has no relay fallback for a missing service
capability. A111 adds host-owned managed New on current enabled local Linux/macOS tmux hosts;
physical verification remains pending. Another desktop's driven projects retain only
machine-local operations, including direct Git, rather than this profile's Board/node actions.

**New session and board edits are unavailable on the LAN (direct-SSH) connection that Auto picks first; iOS does both over SSH**

- Severity: **medium**; claimed by auditor: high; effort: medium; area: parity; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/HostScreen.kt:71`

**Evidence**

iOS registers phone-started sessions over direct SSH: src/core/project-node-append.ts:2-3 ("the phone's twin of this logic lives in nodeterm-ios ProjectNodeRegistrar and writes over direct SSH") and :23 ("the DIRECT-SSH registration path has always written it"). It also moves cards and edits labels over SSH: src/main/index.ts:3940 ("`setCardColumn` moves one card. The phone could already do this over direct SSH") and CLAUDE.md:4784 ("The iOS direct-SSH path has a Swift twin of the transform for projects on the host it dials"). Android: `val canCreate = (state as? ConnState.Connected)?.kind == TransportKind.RELAY && …` (HostScreen.kt:71), so the New-session FAB is hidden on SSH. SshHostConnection sets `HostCapabilities(boardWrites = false, git = false, nodeActions = false, registerNode = false, …)` (SshHostConnection.kt:61-63), and `registerNode`/`setCardColumn`/`editCardLabels` are `relayOnly(...)` (:254-258). BoardTab then shows "Read-only here — board edits need the relay connection." (BoardTab.kt:127-129). The `Auto` route tries SSH first and keeps it when it works (`if (route != RoutePreference.RELAY_ONLY && host.sshAvailable)`, ConnectionManager.kt:76), and the app never opens the relay for a relay-only verb even when the computer has a relay leg.

**Proposed fix**

When connected over SSH, lazily open the relay leg (if the computer has one) for `projects.registerNode` / `ensureBoard` / `setCardColumn` / `editCardLabels` / `node.*`. Or implement the SSH writes the way iOS does, but stream the file over stdin rather than argv so it avoids MAX_ARG_STRLEN.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Real, but the claim is overstated in four places, and I would rate it medium rather than high.
> 
> 1. **Documented, deliberate decision.** docs/android.md:95-98 says: "Direct SSH is POSIX-only by design (like iOS): board writes, node actions and new sessions need the relay. iOS writes `project.json` over SSH for some of these; Android deliberately does not." android/README.md:20-22 also marks these as relay-only / read-only on SSH. Neither doc considers the finding's first fix, which is to open the relay just for these verbs. That fix is still valid.
> 
> 2. **A user-facing workaround exists.** Settings → "How to reach each computer" → "Only through the relay" (SettingsScreen.kt:100-111) forces the relay route. New session and board writes then work on the LAN. The real defect is that the default Auto route hides them, and the missing FAB comes with no explanation (the board tab at least shows a hint).
> 
> 3. **"A phone paired while remote access was off can never do either" is too strong.** If the user later turns on remote access, `adoptRelayIfAdvertised` (ConnectionManager.kt:165-187) mints a relay token over SSH. From then on, "Only through the relay", or being off the LAN, enables both features. The phone stays stuck only while remote access remains off.
> 
> 4. **iOS's SSH parity is narrower than implied.** src/main/index.ts:3940-3942 says the iOS direct-SSH card move works "only for a project whose folder is on THIS machine and only while the whole file still fits in one argv string". CLAUDE.md:4789 measured this repo's own project.json at 114,695 bytes, about 15 KB under the 128 KB MAX_ARG_STRLEN ceiling. So the gap covers local folder projects under that size, not every project.
> 
> **Better fix.** Keep SSH as the primary transport. For `registerNode`, `ensureBoard`, `setCardColumn`, `editCardLabels` and `node.*`, open the relay leg on demand when `host.relay` and a token exist. Where no relay leg exists, show why New session is unavailable instead of silently hiding the FAB.

> Four corrections to the finding:
> 
> 1. **Severity.** I would rate this medium, not high. It is a documented, deliberate gap (docs/android.md:95-98). A user whose computer has remote access on can work around it by setting the route to "Only through the relay" (SettingsScreen.kt:104).
> 
> 2. **"Can never" is overstated.** A phone paired while remote access was off is not stuck forever. Late adoption (ConnectionManager.kt:165-187) mints a relay token from `~/.nodeterm/relay.json` once remote access is turned on. After that, relay-only routing or being off the LAN enables these features. Only while remote access stays off does the phone lose them for good. In that case iOS still has them over SSH.
> 
> 3. **Two UX problems add to it.**
>    - The FAB just disappears on SSH, with no reason shown.
>    - The relayOnly error text (SshHostConnection.kt:261), "turn on remote access in nodeterm → Settings → Phone", is wrong when remote access is already on. The real problem is that the phone picked the SSH leg.
> 
> 4. **Better fix.** In HostSession, when a relay-only verb is needed while `conn` is SSH and `host.relay` plus a stored relay token exist (often already minted by `adoptRelayIfAdvertised`), open a secondary relay connection lazily for `registerNode`, `ensureBoard`, `setCardColumn`, `editCardLabels` and `node.*`. Also show the FAB and board controls disabled with the reason, not hidden. The fallback is an SSH write that streams over stdin to a temp file, then does an atomic mv. That would also work with remote access off, but it must re-implement the kanban and node-append transforms, and it cannot reach SSH-project refs.

**Continuation scope (`A90`, 2026-10-03):** the original `A26` relay-routing fix remains.
The user now needs an explicit plain shell on a manual SSH/WireGuard host with no local
workspace/relay. `A90` adds a phone-owned `nodeterm-phone` session and independent listing,
without registering on the desktop canvas or writing its shared project file. That A90 change
alone did not restore cold managed-agent sessions or supply Board/node/Git verbs over SSH.
At that checkpoint, implementation/tests/build/device verification were pending. The focused
plain-shell flow later passed on the Pixel; A107/A108 now provide the separate typed Git and
owned service paths described above. Their new physical matrices remain pending.

## A27

**Cannot connect straight to a Linux dev host or a headless Server Edition (iOS's "phone SSHes into the host" setup)**

- Severity: **medium**; claimed by auditor: high; effort: large; area: parity; kind: gap
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshScripts.kt:38`

**Evidence**

iOS reaches plain SSH hosts on its own: src/core/remote-push-grants.ts:7 ("phone --SSH--> Linux dev host <--SSH-- macOS nodeterm", called "the common desktop setup"). src/main/remote-ssh/remote-status-push.ts:5-9 says the per-project slice `~/.nodeterm/agent-status-<projectId>.json` exists because "a phone browsing the host directly sees live tmux sessions but no agent states". docs/SERVER.md:81 describes a headless host that "gives a phone SSHing into it full push / Live-Activity coverage", and :142 says "the phone offers this per connection (it installs under whichever user its SSH session logs in as)". The mirror's `server` block is "surfaced to the phone so it can show the installed version / commit" (agent-status-mirror.ts:156-161). Android can only add a computer by scanning a desktop QR (PairScreen.kt; the only entry points are Scan / paste code). Its SSH browse looks for userData only in `~/Library/Application Support/nodeterm` and `~/.config/nodeterm` (SshScripts.kt:38), not the Server Edition's `~/.nodeterm-server` (src/server/config.ts:108). It lists only the `-L node-terminal` socket (SshScripts.kt:56), never `nodeterm-rmt` (Models.kt:228: "never the phone's target"), and never reads `agent-status-<projectId>.json`. `serverVersion` is parsed (ProjectsParser.kt:138) but never shown.

**Proposed fix**

Add a manual "Add SSH server" flow (host, user, port; install the phone's Ed25519 key). Extend the SSH browse to find `~/.nodeterm-server`, list the `nodeterm-rmt` socket, and read `~/.nodeterm/agent-status-*.json` slices, treating a stale `updatedAt` as no data. Show the `server` block (version, commit, installedAt), and offer the install-server.sh one-liner per connection.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The core claim stands, but three details need adjusting.
> 
> 1. **Severity should be medium, not high.** The headline Android flow is pairing with a desktop, and that works. The gap is complete only for SSH-only users and headless Server Edition users. That is a meaningful parity gap in a narrower case, not a feature broken for most users.
> 
> 2. **"Cannot use the Android app with that machine at all" is too strong for the Mac-driven dev host case.** host-service.ts:157-159 notes that in some setups the phone has no credentials for the SSH host. A user whose Mac is paired can still reach that Mac through the relay (and through direct SSH to the Mac) and browse its projects, SSH projects included. The statement is fully true only for:
>    - a headless Server Edition, which has no pairing service anywhere under src/server;
>    - a user who only has SSH access to the dev host.
> 
>    Also, the iOS "add SSH host manually" flow is inferred from the desktop's SSH-only-phone code paths (index.ts:2136-2143, push-notify.ts:92-99). The nodeterm-ios source is not visible to confirm it.
> 
> 3. **The proposed fix needs three refinements:**
>    - **Track the socket per session.** Both `node-terminal` and `nodeterm-rmt` can exist on one host at once (the session-memory notes in CLAUDE.md).
>    - **Make attach on `nodeterm-rmt` attach-only.** `SshScripts.attach` uses `new-session -A`. On `nodeterm-rmt` that would create a missing session without the desktop's hook and account `-e` environment and its remote tmux.conf.
>    - **Discover projects differently on a Mac-driven host.** There is no `workspace.json` there. Node ids would come from the `agent-status-<projectId>.json` slices, the `tmux ls` output and `<remoteCwd>/.nodeterm/project.json`, with a stale `updatedAt` read as "no data" (STATUS_HEARTBEAT_MS = 60 s).
> 
>    `~/.nodeterm-server` is only the default location. It can be changed with `--data-dir` or `NODETERM_DATA_DIR`, so the browse should check the default and treat a miss as "unknown", not as "no nodeterm here".

> Real, with these corrections:
> 
> - **Anchor.** The "only QR/paste" claim belongs at PairScreen.kt:97-115 (accept() at :67-75), not at SshScripts.kt. SshScripts.kt:38 is correct only for the userData probe.
> - **Stronger root cause for the Server Edition.** The issue is not only the missing `~/.nodeterm-server` probe. src/server has no pairing service at all, so no QR exists to scan and Android has no route whatsoever.
> - **Severity.** "High" is defensible for users of these two topologies. Everyone who pairs with a desktop by QR is unaffected, though, so medium–high (a whole-topology parity gap) is more precise than "headline feature broken for most users".
> - **Fix: key install.** The phone cannot install its own Ed25519 key before it can authenticate. The manual "Add SSH server" flow needs a bootstrap: a one-time password login, or showing the public key line for the user to add to authorized_keys. It also needs TOFU host-key pinning like the paired path.
> - **Fix: push.** `~/.nodeterm/push-grants` and the backend's /v1/push fan-out are APNs-only (docs/android.md Known gaps). Adding the host would give Android browse, terminal, status slices and polling, but not headless push. Do not promise the "full push / Live-Activity coverage" from docs/SERVER.md:81.
> - **Fix: status slices.** Reading the `agent-status-<projectId>.json` slices should treat an `updatedAt` older than about 2× STATUS_HEARTBEAT_MS (60 s, remote-status-push.ts:22) as no data.
> - **Fix: nodeterm-rmt targets.** Attaching to nodeterm-rmt sessions must use that socket for attach, has-session, send-keys and kill as well, not only for list.

## A28

**SSH-project sessions over direct SSH are attached, approved and resumed on the wrong machine**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: parity; kind: gap
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshScripts.kt:93`
- Note: Same issue as A09.

**Evidence**

SSH-project sessions run on the remote host. The desktop routes their approval answers there (`writePendingAnswer` writes `~/.nodeterm/pending/<id>.answer` "on the project's host over its ControlMaster", src/main/remote-ssh/ssh-project.ts:1814-1823). CLAUDE.md also states "A remote node is NEVER spawned locally". iOS reaches such sessions on their own host (see the dev-host finding). Android lists them (SessionsTab.kt:111 keeps every open project; :236-238 labels them "on user@host"). Over the direct-SSH connection to the Mac it then runs `exec "$NT_TMUX" -L node-terminal … new-session -A -s 'nt-<id>'` on the Mac (SshScripts.kt:93). That creates an empty local shell, reports `fresh=true`, and TerminalController offers `claude --resume <id>` in it. Approvals take the same wrong path: SshScripts.answerApproval checks the Mac's `~/.nodeterm/pending/<id>.json` and prints `gone` when it is missing (:136). That maps to `ApprovalOutcome.ALREADY_HANDLED` (SshHostConnection.kt:268), and the UI toasts "Already handled." (InboxTab.kt:88) while the remote hook is still holding the request.

**Proposed fix**

Over SSH, refuse or relay-route nodes whose project has `sshTarget` (the relay's `approvals.answer` already routes through the desktop's `answerPermission`). Longer term, reach them by connecting to that host directly, as iOS does.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause and all cited lines are correct, but the proposed fix is only half right.
> 
> **Approvals: relay-routing does fix them.** `approvals.answer` goes through `answerPermission`, which routes to the project's host.
> 
> **Attach: relay-routing does NOT fix it.** The relay `pty.attach` has the same wrong-machine behaviour on the desktop side, where it pre-existed:
> - `host-service.ts` `handleAttach` (:419-432) calls `pty.sessionExists(nodeId)` and then `pty.attachDetached(nodeId, sinks, {cols, rows})`.
> - `PtyManager.attachDetached` (pty-manager.ts:2661-2667) passes only `persistKey`, with no `sshRemote` or `requireRemote`. `spawnSession` therefore runs a local `tmux new-session -A` on the Mac's `node-terminal` socket.
> - It is arguably worse on the relay. When the canvas holds a live remote session, `sessionExists` answers true via `liveSessionForPersistKey`, so the phone gets `fresh:false` over a brand-new empty local shell.
> 
> **Better fix:**
> 1. On BOTH transports, refuse to attach to nodes whose project has `sshTarget`. Show something like "runs on user@host — open it there". The same applies to End session over SSH, which would kill a local `nt-<id>` that never existed.
> 2. For approvals of such nodes, use the relay `approvals.answer` when a relay leg exists. Otherwise tell the user it must be answered on the computer. Do not fall through to OPEN_SESSION or "Already handled."
> 3. Separately, the desktop's relay attach path should refuse (or route over the ControlMaster) for nodes that `workspaceStore.sshProjectIdForNode` resolves to an SSH project.
> 
> A precision note on wording: the resume is only offered, never typed automatically. Accepting it launches the agent CLI on the Mac, where the transcript does not exist.

## A29

**Current follow-up:** A107 adds the same eight typed verbs over direct SSH with a physical project/repository jail and no uncertain replay.

**No source-control screen, although the protocol layer already implements the git verbs iOS uses**

- Severity: **medium**; claimed by auditor: medium; effort: medium; area: parity; kind: gap
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/HostConnection.kt:95`

**Evidence**

The phone vocabulary includes a source-control sheet: src/main/remote/host-service.ts:117-120 ("the jailed core bridge that lets a relay-only phone (no direct SSH) run the source-control sheet in ONE round trip per operation instead of N ssh execs"). src/main/index.ts:3903 ("The jailed core bridge both phone hosts serve: typed git verbs") and host-git-bridge.test.ts:1 ("The jailed core bridge for the PHONE vocabulary: typed `git.*` verbs") agree. "instead of N ssh execs" shows iOS also does source control over SSH. Android declares `suspend fun git(verb: GitVerb, cwd: String, …)` (HostConnection.kt:95; `GitVerb` STATUS/DIFF/STAGE/UNSTAGE/COMMIT/PUSH/PULL/HISTORY at :103), and RelayHostConnection advertises `git = true` (RelayHostConnection.kt:55). But no app code calls `.git(` (grep finds 0 call sites under android/app), and SSH throws `relayOnly("Source control")` (SshHostConnection.kt:258).

**Proposed fix**

Add a per-project Source Control screen over `conn.git(...)`: status list, diff viewer, stage/unstage, commit box, push/pull, history, with the host's error messages shown as returned. Add an SSH implementation that runs `git -C <cwd>` inside the project roots.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Three refinements:
> 
> 1. **The gap is also undocumented.** docs/android.md has a protocol mapping table (lines ~33-45) and a "Known gaps" section (lines 88-104). Neither mentions git or source control, even though the doc says it records "what is not done". The fix should document the gap as well as close it.
> 
> 2. **Better fix: relay first, then SSH.** Ship the screen over the relay first, following the pattern the app already uses for board writes, node actions and new sessions: gate it on `conn.capabilities.git` and hide it or show the relay-only reason on SSH. The relay path already exists (RelayHostConnection.kt:280). Its error contract is explicit: host-service.ts:514-523 answers "git is not served on this host." / "cwd is outside the shared project roots.", and the UI should show those strings as returned. An SSH leg (`git -C <cwd>` over the session) can follow as a separate step. If it is built, restrict cwd to the project roots from `projects.list`, to match the desktop's `isWithinRoots` jail, and use typed verbs only. Otherwise document it in Known gaps, the same way board writes are documented as relay-only.
> 
> 3. **Line and evidence details.** The capability flag is at RelayHostConnection.kt:54-56 (the `HostCapabilities(...)` constructor, `git = true` on :55), and the implementation is at :280-281. The claim that iOS does source control over SSH is inferred from a desktop comment and is not verified.

## A30

**Pressing Deny on the desktop is not respected: the phone re-dials about 8 s later and the SAS approval dialog reappears**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/conn/ConnectionManager.kt:212`
- Note: Related: A05, A07.

**Evidence**

Desktop side: on Deny, standing-host.ts:398-404 (`ipcMain.on(IPC.remoteHostReject…)`) only calls removeFromPool(p) → session.close() and ensurePool(). There is no deny list. Phone side: the close surfaces in RelayConnector as the generic `HostException("The connection closed while waiting for approval.")` (RelayConnector.kt:70), so the phone cannot tell a rejection from a network drop. It becomes ConnState.Failed. While any screen watches the computer, the poll loop `while (isActive) { refreshNow(); delay(POLL_MS) }` (ConnectionManager.kt:212-221) calls refreshNow → ensureConnected → connectLocked again, with no backoff and no memory of the refusal. When SSH is unavailable (off-LAN, a Windows host, or the Relay-only route), each attempt does a fresh /v1/relay/join plus handshake on the replacement listener, and onPeerReady raises a new SAS dialog (standing-host.ts:258). The same loop re-raises the dialog every ~5 min 8 s after an unanswered approval times out (RelayConnector.kt:82).

**Proposed fix**

Treat a close during the approval wait as a terminal refusal for this HostSession. Stop the auto-reconnect and show "The computer declined this phone" with an explicit retry button. Back off after an approval timeout. On the desktop, remember a rejected key for some time instead of prompting again.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The claim is right but understates the scope in one respect, and a few details need adjusting.
> 
> 1. The poll loop is not the only thing that redials. `InboxWorker.doWork` (InboxNotifier.kt:118-129) is a 15-minute `PeriodicWorkRequest` (:64). It calls `withTimeoutOrNull(45_000) { session.refreshNow() }` for every paired host, whether or not a screen is watching. A denied phone on the relay route therefore raises the SAS dialog again about every 15 minutes indefinitely, even with the app closed. Each of those prompts is abandoned 45 s later, when the timeout cancels the connect. A phone-side fix limited to `HostSession` or the poll loop would not stop this. The worker must also skip a host whose last relay attempt was refused or is still unapproved.
> 
> 2. The timing depends on the real relay. "About 8 s" assumes the relay closes the phone's socket when the host closes its side. The test broker does (host-fixture.ts:76-78). If the real relay does not, the phone fails through the 30 s RPC timeout instead (RelaySocket.kt:326), so the redial comes after about 38 s. Either way the dialog comes back.
> 
> 3. Line numbers: the loop body is ConnectionManager.kt:214-219, and :212 is the `startWatching` declaration.
> 
> 4. The fix belongs mainly on the desktop. Any client can simply redial, so the security mitigation is to remember a rejected public key for a while in standing-host.ts or phone-approval.ts and not prompt for it again. Relatedly, `mintDevice` needs only the host's public key and hostDeviceId, which are advertised in relay.json. On the phone, the fix is UX: treat a close during the approval phase as a refusal, stop auto-reconnect in both the poll loop and the worker until the user taps retry, and back off after an approval timeout.
> 
> 5. Severity: medium is reasonable. The case is limited to the relay route and a phone that was denied or left unanswered, but the effect is repeated prompting on a security dialog.

## A31

**A silently dead SSH peer (laptop asleep, desktop IP or VPN change) wedges the host as 'On your network' for many minutes: no detection, no relay fallback, and the error is never shown**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: critic; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshHostConnection.kt:84`

**Evidence**

(1) Keepalive: `client.connection.keepAlive.keepAliveInterval = 20` (line 353) configures sshj's DefaultConfig provider. That provider is KeepAliveProvider.HEARTBEAT (javap of sshj-0.39.0 DefaultConfig), and Heartbeater.doKeepAlive only writes an SSH_MSG_IGNORE and never expects a reply, so it cannot detect a dead peer. The sshj Reader also catches SocketTimeoutException and continues, so `client.timeout = 30_000` does not help either. (2) run(): `val out = cmd.inputStream.readBytes()` runs before `cmd.join(timeoutSec…)` (lines 88-89), and ChannelInputStream.read uses a bare Object.wait(). The timeout never bounds the read, so a command in flight when the peer vanished blocks forever. (3) Every other failure, such as startSession timing out, is wrapped as `HostException("The SSH connection failed…")` (line 96). fireClosed runs only `if (!isConnected)`, which stays true. ConnectionManager.refreshNow treats any HostException as an 'answer' and does NOT disconnect (ConnectionManager.kt:195-203), so the dead connection is reused on every poll and connectLocked's relay fallback is never reached. (4) The only error sink, `_lastError` (ConnectionManager.kt:53-54, 198), is never read by any UI (grep: no reference outside ConnectionManager.kt).

**Proposed fix**

Use `KeepAliveProvider.KEEP_ALIVE` (keepalive@openssh.com with a max missed count) in the SSHClient config. Bound run() with a real deadline (read on a worker thread, or close the channel on timeout). In run() and refreshNow, classify channel-open and transport timeouts as transport failures and disconnect, so Auto falls back to the relay. Surface lastError in HostScreen.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Three refinements, none of which changes the verdict.
> 
> (a) "Heartbeater cannot detect a dead peer" is slightly overstated. Its IGNORE writes are exactly what make the kernel eventually time out an otherwise idle connection. Detection does happen, but only after the TCP retransmission timeout (about 15 minutes), never within an app-level bound. It is not "never".
> 
> (b) A laptop that wakes inside the retransmission window resumes the same TCP connection, so the sleep case is a long stale window rather than a permanent wedge. The desktop IP-change and VPN cases really are dead until the kernel gives up.
> 
> (c) The InboxWorker impact is narrower than stated. For an unwatched host it calls `session.disconnect()` after every run (InboxNotifier.kt:127), and a fresh `connect()` uses a 4 s connectTimeout under Auto, so it falls back to the relay correctly. It only loses time when it reuses a dead conn that was left open: stopWatching does not disconnect. It hangs past its 45 s timeout only if a read was in flight.
> 
> Fix details. Set `KeepAliveProvider.KEEP_ALIVE` on the DefaultConfig BEFORE constructing SSHClient. KeepAliveRunner sends keepalive@openssh.com with want-reply and calls `transport.die()` after `maxAliveCount` misses, which fires the existing disconnectListener → fireClosed → relay fallback. Also bound the read in run() by closing the session or channel from a timer: channel close/notifyError unblocks the wait. Treat a channel-open timeout (ConnectionException) as a transport failure that disconnects, rather than as an "answer" HostException. Show lastError in the HostScreen banner.

## A32

**No way to open a URL or copy text from the phone terminal: no link detection, no touch selection, and the WebView cannot show xterm's link confirm**

- Severity: **medium**; claimed by auditor: medium; effort: medium; area: critic; kind: gap
- Location: `android/app/src/main/assets/terminal/terminal.js:22`

**Evidence**

terminal.js loads only the FitAddon (`term.loadAddon(fit)`, line 22). There is no WebLinksAddon and no `linkHandler`, so plain URLs in agent output are never linkified. OSC 8 links fall back to xterm's default activate, which calls confirm(). The WebView gets only a WebViewClient and no WebChromeClient (TerminalController.kt:175), so that dialog cannot appear and the link does not open. The shouldOverrideUrlLoading branch that 'opens links in the browser' (TerminalController.kt:177) is effectively unreachable. Selection is also unavailable: the vendored xterm.js handles touchstart/touchmove only for viewport scrolling, disables its selection service while mouse events are active (tmux runs `mouse on`), and xterm.css sets `.xterm { user-select: none }`. terminal.js additionally calls `e.preventDefault()` on every single-finger touchmove (line 80). The only copy path is OSC 52 emitted by the host, and on a touch phone the only way to trigger it is tmux copy-mode driven by mouse drag or prefix keys, neither of which is reachable. README.md:18 nevertheless advertises 'OSC 52 copy'.

**Proposed fix**

Load @xterm/addon-web-links with a handler that calls the bridge to open http(s) URLs. Set a linkHandler that skips confirm(), or install a WebChromeClient. Add a long-press 'select / copy screen' mode, e.g. capture the visible buffer via `term.buffer` and offer copy/share of lines, since tmux mouse mode makes xterm's own selection unusable.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Four parts of the finding need correcting.
> 
> 1. Two copy paths do exist, but neither is practical. The finding says OSC 52 copy can't be reached from a touch phone; that is not strictly true.
>    - Prefix keys: the key row has a Ctrl chip (TerminalScreen.kt:153). TerminalController.onInput turns Ctrl+letter into a control byte (TerminalController.kt:138-141). So Ctrl, b, [ enters tmux copy-mode (the default C-b prefix; the conf sets none). From there a keyboard selection and copy are possible but awkward and hard to discover.
>    - Double/triple tap: tmux 3.4's built-in root bindings are `bind -n DoubleClick1Pane { ... if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send -M } { copy-mode -H; send -X select-word; ...; send -X copy-pipe-and-cancel } }`, and the same for TripleClick1Pane (select-line). When the pane's app has not grabbed the mouse (a plain shell, codex), the clicks the WebView synthesizes from taps may therefore copy a word or line via OSC 52. This is not verified on a device. In a Claude pane, where the fullscreen TUI grabs the mouse, the click goes to the app instead.
>    So the accurate statement is: there is no practical or general copy path, and never a selection of arbitrary text. That is not the same as "none at all".
> 
> 2. The OSC 8 part is stronger than the finding shows. Links do reach the phone because pty-manager.ts:326 declares `,*:hyperlinks`.
> 
> 3. Proposed fix, links:
>    - Do not load @xterm/addon-web-links. The desktop replaced it on purpose: the addon cannot join the hard-wrapped rows that tmux repaints, so a long OAuth URL only matched its first row (src/renderer/terminal/file-links.ts:404-409).
>    - Port createUrlLinkProvider and set `term.options.linkHandler` to a handler that calls a new NodetermBridge.openUrl, limited to http(s).
>    - Account for the fact that, with mouse reporting on, a tap on a link is also sent to tmux as a click.
> 
> 4. Proposed fix, copy: a long-press "copy screen" or "select lines" sheet built from `term.buffer.active` remains the right approach.
> 
> The line citations in the finding are correct: terminal.js:22, :80; TerminalController.kt:175, :177; README.md:18.

## A33

**On a Windows computer, 'New session' starts the agent in the user's home folder instead of the project, and silently drops the chosen Claude account while still registering it**

- Severity: **medium**; claimed by auditor: medium; effort: medium; area: critic; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/model/Agents.kt:28`

**Evidence**

The relay attach that creates a phone-started session passes only `{cols, rows}` (host-service.ts:432 `pty.attachDetached(nodeId, sinks, { cols, rows })`). The desktop therefore spawns it in `options.cwd || os.homedir()` (pty-manager.ts:2834), and the session-host backend receives that same `cwd` (pty-manager.ts:3346). The phone's only way to reach the project is the launch line. But `SAFE_DIR = Regex("^/…")` (Agents.kt:28) rejects every Windows path (`C:\Users\…`), so `cd '<cwd>' &&` is omitted (Agents.kt:52). Likewise `CLAUDE_CONFIG_DIR='<dir>'` is omitted for a Windows account dir (Agents.kt:54), and the shell variant's `Regex("^/…")` returns null (SessionsTab.kt:331). TerminalController still registers the node with `launch.accountId` (TerminalController.kt:238). Windows computers are relay-only, and New session is offered only over the relay (HostScreen.kt:71), so Windows is exactly the platform that takes this path.

**Proposed fix**

Have the host own the cwd: extend `pty.attach` or `projects.registerNode` so the desktop creates a phone-started session in the project's cwd with the account env (the desktop already knows both). Failing that, emit a platform-appropriate launch line for a win32 host (the mirror or projects blob can carry the host OS). Never register an accountId the launch did not actually apply.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Mostly accurate. Three refinements.
> 
> (1) "New session is offered only over the relay" is true for every host OS (HostScreen.kt:71). Windows is the platform where that relay-only path also loses the cd/env. Mac and Linux relay launches get `cd '/path' &&` and work.
> 
> (2) The finding's alternative fix is weaker than it sounds. A "platform-appropriate launch line" is not enough on its own. The Windows session host runs the default Windows shell (localSessionShell). There, `cd 'C:\x' && ...` is a parse error in PowerShell 5.1, cmd does not accept single-quoted paths, and the `VAR=value cmd` env prefix is POSIX-only. So simply relaxing SAFE_DIR would make things worse, not better.
> 
> (3) The primary proposed fix should not be `projects.registerNode`. The phone deliberately registers AFTER typing the launch line (TerminalController.kt:231-238), so the node does not exist when `pty.attach` creates the session. The right seam is to extend `pty.attach` (host-service.ts:382-433) with an optional projectId and accountId. The host would resolve the cwd from its own project registry and the account env via `claudeConfigDirFor`, validated the same way the canvas does. Until that exists, the phone should neither offer the account picker nor send `accountId` to registerNode when the launch line could not apply CLAUDE_CONFIG_DIR.

## A34

**The Ctrl key-row chip does not apply to text sent from the input bar: arming Ctrl and sending 'z' submits a literal 'z' plus Enter**

- Severity: **medium**; claimed by auditor: low; effort: small; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:136`

**Evidence**

The Ctrl transform only applies when `ctrlArmed && data.length == 1` (TerminalController.kt:136-144). The input bar sends through `nt.submit` → `term.paste(text)` (terminal.js:129-133). Under a tmux client xterm always has bracketed-paste mode on (CLAUDE.md: tmux's own paste-through `?2004h`), so onData receives `\e[200~z\e[201~` (length > 1) and the Ctrl is not applied. The following '\r' (length 1, outside '@'..'_') then disarms Ctrl. The other way to type into xterm directly, the soft keyboard via the ⌨ chip, does not work (already reported).

**Proposed fix**

Apply an armed Ctrl in Kotlin before submitting: if the draft is a single character, send the control byte via `raw()` and skip Enter. Otherwise disarm the chip when the input bar is used.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> 1. **Wrong line numbers for terminal.js.** The file has 121 lines. `nt.submit` is at terminal.js:110-114 (`term.paste(text)` at 112, the delayed `onInput('\r')` at 113), not 129-133. The onData hookup is at terminal.js:50. The Ctrl condition is TerminalController.kt:138-142 (the finding's line 136 is the `fun onInput` declaration). The input bar is TerminalScreen.kt:124-139 and the chip is at TerminalScreen.kt:153.
> 
> 2. **The impact is slightly overstated.** "Only the four ^C/^D/^R/^L chips work" is not quite right. The chip does apply to single keystrokes typed straight into xterm: tapping the terminal to bring up the soft keyboard, per the comment at terminal.js:48-50. Whether that works with Android IMEs is a separate question. The bug is specifically that the chip has no effect on the input bar, which is the main text entry. Low severity is appropriate.
> 
> 3. **The fix should drop Enter in every case.** Check ctrlArmed in the Kotlin send handler: if the draft is one character that maps to a control byte (`uppercase in '@'..'_'`, optionally `'?'` → 0x7f), send it via `raw()` with no Enter, then disarm. Otherwise disarm when the input bar is used. Point 6 above is why Enter must be dropped even when bracketed paste is off.

## A35

**approvals.answer returns `answered:false` both for 'already handled' and for 'the write failed'; the phone always says 'Already handled.'**

- Severity: **medium**; claimed by auditor: low; effort: small; area: critic; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/RelayHostConnection.kt:255`
- Note: Related: A06.

**Evidence**

Android: `return if (body?.b("answered") == true) SENT else ALREADY_HANDLED` (RelayHostConnection.kt:255), and InboxTab shows the toast "Already handled." (InboxTab.kt:88). Desktop, the verb added in this branch: `.then((answered) => …{ answered })` and `.catch(() => …{ answered: false })` (host-service.ts:724-725). answerPermission returns false when the write fails: writePendingAnswerLocal's `catch { return false }` (pending-approvals.ts:56-58), and for an SSH-project node `sshProjectManager.writePendingAnswer` fails whenever its ControlMaster is down (index.ts:2782-2785). The phone's stillWaiting re-read has just confirmed the node is still blocked.

**Proposed fix**

Return a reason from the verb (`{answered:false, reason:'gone'|'write-failed'}`) and show 'Couldn't answer — try again or open the session' for a failed write.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause is stated a little wrong. The desktop does not return `answered:false` for "already handled" at all: `answerPermission` never checks whether the hook is still holding the request, so on the relay path every `answered:false` is a delivery failure (write error, no SSH conn record, ssh exec failure, or a throw). The desktop comment at host-service.ts:691 and the test header at host-inbox-verbs.test.ts:6-7 are wrong to say otherwise. A related side effect: answering an already-timed-out hook returns `answered:true` (SENT), which the SSH path avoids.
> 
> Better fix, matching the SSH script's semantics:
> - In `answerPermission`, test for `<pendingId>.json` first (local: stat under `pendingDir(homedir())`; SSH: `test -f` over the ControlMaster).
> - Return a discriminated result: `{answered:true} | {answered:false, reason:'gone'|'write-failed'}`.
> - Map only `reason:'gone'` to ALREADY_HANDLED.
> - Map `write-failed`, and an absent reason from an older desktop, to an error toast such as "Couldn't answer — try again or open the session", the same way `SshHostConnection.answerApproval` throws HostException for a failed write.

## A36

**After any connection drop the terminal stays on 'Disconnected. [Reattach]' even though the host connection reconnects by itself**

- Severity: **medium**; claimed by auditor: low; effort: small; area: critic; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:105`

**Evidence**

On a relay drop, RelayHostConnection.onClosed calls `sink.onExit(null)` for every stream (RelayHostConnection.kt:121-126). TerminalController then sets `state = TermState.Ended("Disconnected.")` (TerminalController.kt:105-110). HostSession reconnects automatically 1.5 s later when watched (ConnectionManager.kt:141-149), but that only re-lists projects. TerminalController does not observe `session.state`, and re-attaching needs the manual Reattach button (TerminalScreen.kt:95). The SSH stream behaves the same way (`sink.onExit(cmd.exitStatus)` with a null status).

**Proposed fix**

When the exit code is null (a transport drop, not a pane exit), have TerminalController wait for the HostSession to return to Connected and call attach() again automatically with bounded retries.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The mechanism is right. Four refinements, the last two about the fix:
> 
> 1. **SSH detection is slower.** A dead SSH channel does not null `HostSession.conn` straight away. `fireClosed` runs only when the next `run()` fails (SshHostConnection.kt:84-98), which is usually the next 8 s poll. On SSH the host-level reconnect therefore follows the drop by up to about 8 s, not 1.5 s. An automatic reattach attempted before that point goes through `ensureConnected()`, gets the stale connection back, and its `hasSession` `run()` throws a HostException. That lands the terminal in Ended again, this time with "Couldn't open the terminal over SSH…".
> 2. **Relay reconnect can stall at approval.** The relay re-dial can pass through `ConnState.AwaitingApproval` (ConnectionManager.kt:114). Waiting for `Connected` is correct, but the wait should have no short fixed deadline.
> 3. **A null code is not proof of a transport drop.** A relay `Op.ERROR` frame whose `exitCode` is JSON null also yields `onExit(null)` (RelayHostConnection.kt:68-71; the desktop forwards the pty's `exitCode` verbatim at host-service.ts:342-349). A cleaner signal is to mark streams closed by the connection-level `onClosed` path, or to key the retry on `session.state` leaving `Connected`.
> 4. **Keep the retry bounded and conditional.** Retries should be capped, and they should run only while the screen is showing (not `disposed`), so a real host-side failure cannot loop.

## A37

**proguard-rules.pro would not survive turning on minification (R8 missing-class errors)**

- Severity: **low**; claimed by auditor: low; effort: small; area: build; kind: risk
- Location: `android/app/proguard-rules.pro:3`

**Evidence**

app/build.gradle.kts l.21-23 keeps `isMinifyEnabled = false` and says shrinking 'needs keep rules nobody has written yet'. proguard-rules.pro says: 'If it is ever turned on, sshj, BouncyCastle and EdDSA need keeps …' and adds only `-dontwarn javax.naming.**` and `-dontwarn org.slf4j.**`. jdeps on the actual runtime jars shows references to classes android.jar does not have: sshj 0.39.0 `SSHClient` and `userauth.method.AuthGssApiWithMic` reference `org.ietf.jgss.*` (GSSContext, GSSManager, Oid, …) and `javax.security.auth.login.LoginContext`, and eddsa 0.3.0 `EdDSAEngine` references `sun.security.x509.X509Key`. R8 in AGP 8 fails the build on missing classes unless they are `-dontwarn`ed.

**Proposed fix**

Add `-dontwarn org.ietf.jgss.**`, `-dontwarn javax.security.auth.login.**` and `-dontwarn sun.security.x509.**`, and drop the unnecessary `org.slf4j` dontwarn (slf4j-api is on the classpath). Alternatively, change the comment so it no longer implies the rules are complete.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding holds, with two corrections.
> 
> 1. It overstates the framing. The file does not really present itself as a ready-made, complete rule set. build.gradle.kts:21 says outright "shrinking needs keep rules nobody has written yet", and proguard-rules.pro:1-2 only says keeps "need" to exist. The real inconsistency is smaller: that comment says the rules have not been written, while proguard-rules.pro:3-7 does contain partial keeps. Those keeps would fail R8 on missing classes as soon as they were used.
> 
> 2. A better anchor is proguard-rules.pro:6-7 (the dontwarn block), not line 3. The fix:
>    - Add `-dontwarn org.ietf.jgss.**`, `-dontwarn javax.security.auth.login.LoginContext` (or `.**`) and `-dontwarn sun.security.x509.**`.
>    - `-dontwarn org.slf4j.**` is redundant but harmless, because slf4j-api is a declared runtime dependency of sshj in both its POM and its .module file. It is a nit, not a required part of the fix.
> 
> It is unclear whether the result then passes R8. That needs an actual `assembleRelease`, which cannot run here because Google Maven is blocked. Severity: low (latent). The wording "would break assembleRelease" is accurate only once someone enables minification.

## A38

**Quick approve requires the node to be exactly 'blocked', but the desktop publishes approval tickets while the node stays 'waiting' on a held question**

- Severity: **low**; claimed by auditor: low; effort: small; area: protocol; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/QuickActions.kt:53`

**Evidence**

Android: `if (status.state != expected) return false`, with `expected = AgentState.BLOCKED` for approvals (`WAITING` for questions), which returns ALREADY_HANDLED. Desktop agent-status-mirror.ts:1520-1528: when a parent AskUserQuestion is pending and a concurrent approval arrives, `produceInboxFromState(... 'blocked' ...)` publishes the approval card with its pendingId, but the mirror keeps `state: next.state` = 'waiting' ('keep the parent's waiting badge and question correlation until its own answer'). Conversely, line 1611 (`kind = hasQuestion || nextState === 'waiting' ? 'question' : 'approval'`) can emit a question card while the state is 'blocked'.

**Proposed fix**

For approvals, check that the event is still unresolved and that its pendingId is still live, and accept either needs-you state (blocked or waiting). Do the same for questions.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line citations (mirror 1520-1528 and 1611) are correct. Restrict the finding to the approval direction. The question-while-'blocked' half needs an uncorrelated question and is not reachable in the normal Claude flow after #821.
> 
> The proposed fix is too broad and would be harmful as written. Relax the node-state gate ONLY on the ticketed path. When `event.pendingId != null`, skip the `state == BLOCKED` requirement. Keep only the "fresh event is still unresolved" re-check that hook-reply-approvals.md prescribes, then call `conn.answerApproval`; the desktop or the answer file reports "gone" when the ticket expired. Do NOT accept WAITING for the ticketless send-keys fallback (claude, no pendingId), and do not accept BLOCKED for answerQuestion. On a node whose AskUserQuestion picker is on screen, typing `1` would pick option 1 of the question rather than approve anything.

## A39

**The account chip reads `account.label`, which the mirror never writes, so it falls back to the raw account UUID**

- Severity: **low**; claimed by auditor: low; effort: small; area: protocol; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/model/ProjectsParser.kt:129`

**Evidence**

Android: `accountLabel = account?.let { it.s("label") ?: it.s("accountId") }`. The mirror's `account` is `ObservedClaudeAccount` = `{configDir, accountId: string|null, known, remote?}` (shared/types.ts:1348-1370), which has no `label`. MirrorSettings.claudeAccounts carries only `{id, dir}`. SessionsTab.kt:265 renders `status?.accountLabel`.

**Proposed fix**

Derive the label as the desktop's AccountChip does: for a known managed id, look up a label (or show a short form); for an unlinked dir, use the last segment of configDir.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Three small corrections. Nothing here changes the verdict.
> 
> (1) It is not a separate chip. The value is joined into the Sessions row's " · "-separated detail text (SessionsTab.kt:260-267), so the UUID mostly shows up as ellipsized noise at the end of the line.
> 
> (2) The parse site starts at ProjectsParser.kt:121 (`val account = e.o("account")`). The fallback is on line 129.
> 
> (3) Better fix: the mirror already carries labels for local managed accounts. `usage.accounts[]` has `{accountId, label, email}`, built from settings (agent-status-mirror.ts:312-317, `label: acct?.label ?? null`), and Android already parses that block (ProjectsParser.kt parseUsage → `UsageAccount.label`, used in InboxTab.kt:236). So the fix is:
> - Resolve `account.accountId` against `status.usage.accounts`, using label, then email.
> - If there is no match, show a short form of the id rather than the full UUID. `usage` is dropped from SSH slices, and it is absent when no usage snapshot exists.
> - When `accountId` is null and `known` is false, show the last path segment of `configDir`.
> - When `accountId` is null and `known` is true, show nothing (the system account).
> 
> Dropping the `label` read entirely would also remove dead code.

## A40

**The pending-launch path and the attach hand-off never re-check `disposed`: a stream can stay attached forever, or a phone-started node gets registered with no agent launched**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:234`

**Evidence**

- attach() checks `if (disposed)` once, on the background thread (:209), then posts `main.post { stream = s; state = TermState.Attached ... }` (:213). If dispose() ran on main between that check and the posted runnable, the runnable installs `s` on a disposed controller, and nothing ever detaches it.
- afterAttach (:231-242) runs on graph.scope: `delay(900)`, then `s.write(launch.command + "\r")`, then `conn.registerNode(...)`, with no disposed or stream check. If the user leaves during those 900 ms, dispose() has already detached the stream (relay `pty.kill`), so the launch line is dropped. registerNode still runs, against a tmux session the phone's attach already created.

**Proposed fix**

Re-check `disposed` inside the main.post and detach if it is set. In afterAttach, abort (and don't registerNode) if the controller was disposed or the stream has changed since the delay started.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The mechanism is right, with three clarifications and a better fix.
> 
> 1. (a) and (b) cannot both happen on the same attach. In the (a) race the stream is NOT detached, so the pending launch actually succeeds (the write and registerNode both land). The launch is lost only in the (b) window, where the posted runnable already installed the stream and dispose() then detached it.
> 
> 2. The launch is also unrecoverable. PendingLaunches.take (:229) already consumed the request, so reopening the terminal cannot retry it.
> 
> 3. Cited lines: the (a) window is between TerminalController.kt:209 and :213. The unguarded launch sequence is :234-241.
> 
> Better fix for (b): the proposed "abort and don't registerNode" still leaves the `nt-<id>` tmux session that the attach created (`new-session -A`) running as an invisible orphan with a bare shell. Either:
> - let the launch finish regardless of the viewer: dispose() defers the detach of a stream that still has a pending launch until afterAttach has written the line and called registerNode; or
> - on abort, call `s.endSession()` (`pty.destroy`) so the created session is killed, rather than just skipping registration.
> 
> Fix for (a): in the main.post runnable, re-check `disposed` and detach `s` if it is set. Mark `disposed` @Volatile, or cancel attachJob from dispose().

## A41

**The composed prompt is cleared even when no stream is attached, so the text is silently lost**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalScreen.kt:132`

**Evidence**

TerminalScreen.kt:131-138: `controller.submit(draft, enter = true); draft = ""`, with no state check. submit → JS `term.paste(text)` → `bridge.onInput(d)` → TerminalController.kt:143 `stream?.write(out)`. stream is null while Connecting or after Ended ("Disconnected."), so the bytes are dropped.

**Proposed fix**

Disable Send (or keep the draft and show a message) unless controller.state is Attached.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is correct. On the line reference: the handlers span TerminalScreen.kt:131-138 (onSend at 131-134, the IconButton at 135-138), not just line 132. The same silent drop affects the key-row chips and the ^C/^D chips (`key()` goes to JS and then `bridge.onInput`; `raw()` calls `stream?.write` at :289-291), but those are single keystrokes and lose almost nothing.
> 
> Suggested fix: make `submit` return whether it was delivered, e.g. `fun submit(...): Boolean { if (state != TermState.Attached) return false; ... ; return true }`, and clear `draft` only on true. Alternatively, set `enabled = controller.state == TermState.Attached` on the Send IconButton and ignore onSend when not attached.
> 
> Gate on `state` rather than reading `stream`. The two are updated together in the same main-thread post (:213-215, :107-108), while `stream` is also read from the JS bridge thread without synchronization.

## A42

**NewSessionDialog crashes if the selected project disappears while the dialog is open**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SessionsTab.kt:327`

**Evidence**

`val projects = snapshot.openProjects().filter { it.sshTarget == null }` is recomputed from the live snapshot that HostScreen re-lists every 8 s, while `projectId` is remembered. The Start button does `val p = projects.first { it.id == projectId }` (:327), which throws NoSuchElementException inside onClick when that project was closed or removed on the desktop meanwhile.

**Proposed fix**

Use firstOrNull and dismiss or show an error; alternatively disable Start when projectId is not in `projects`.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line (SessionsTab.kt:327) and the root cause are correct. A more precise fix: work out the selection from the current list, e.g. `val selected = projects.firstOrNull { it.id == projectId } ?: projects.firstOrNull()`. Enable Start only when `selected != null`, and use `selected` in onClick instead of `first {}`. That way the dialog never crashes. It also avoids a subtle trap: if the remembered id disappears and no radio button is shown as selected, Start should not go to a hidden project. If all local open projects are gone, disable Start or dismiss the dialog.

## A43

**The HostScreen tab and scroll position reset after returning from a terminal**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/HostScreen.kt:62`

**Evidence**

`var tab by rememberSaveable { mutableIntStateOf(initialTab) }` (:62). AppContent (MainActivity.kt:112-118) renders only `nav.current` and has no SaveableStateHolder, so HostScreen leaves composition when a Terminal is pushed and its saveable state is dropped. The normal push is `Route.Host(host.id)` (tab 0).

**Proposed fix**

Wrap each route in rememberSaveableStateHolder().SaveableStateProvider(key), or store the selected tab back into the Route on change.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Root cause and line are right. The proposed fix is incomplete, though. `rememberSaveableStateHolder().SaveableStateProvider(key)` only preserves `rememberSaveable` state. The Board tab's selected project is a plain `remember` (`var projectId by remember { mutableStateOf<String?>(null) }`, BoardTab.kt:86), and so is the Inbox archive toggle (`showArchive`, InboxTab.kt:68). Both would still reset to the first project / off after returning from a terminal. They need to become `rememberSaveable`, or be hoisted into the Route. Also, the SaveableStateProvider key must be unique per stack entry (for example a per-entry id), not the Route data class, which can repeat on the stack. And `removeState(key)` must be called on pop, or the saved state leaks. The simpler alternative is to write the selected tab back into the stack entry (replace `stack[i]` with `r.copy(tab = newTab)`). That fixes the tab, but not the scroll positions or BoardTab's projectId.

## A44

**System back discards Settings edits (device name, relay API base)**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SettingsScreen.kt:59`

**Evidence**

The name and apiBase are persisted only in the top-bar back IconButton (:59-63: `graph.hosts.deviceName = name; if (apiBase.startsWith("https://")) graph.hosts.apiBase = apiBase; nav.pop()`). The system back gesture goes to AppContent's `BackHandler(enabled = nav.stack.size > 1) { nav.pop() }` (MainActivity.kt:111), which pops without saving.

**Proposed fix**

Persist on change (or on dispose), or register a BackHandler inside SettingsScreen that saves before popping.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is accurate. On the fix: the simplest change that keeps the https-only rule for apiBase is a `BackHandler { save(); nav.pop() }` inside SettingsScreen. The innermost enabled BackHandler wins, so it takes precedence over AppContent's. It should share one `save()` lambda with the IconButton at :59-63. Saving on every keystroke would be wrong for apiBase: the HostStore setter would persist half-typed values, and the `startsWith("https://")` check would let through intermediate values like "https://a". So if you save outside the back action, use a DisposableEffect onDispose save rather than a per-keystroke write. One more point: when the typed apiBase is not https, the top-bar back also drops it without a message. That is intended validation, but the user is not told.

## A45

**No onRenderProcessGone handler on the terminal WebView**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: risk
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:175`

**Evidence**

The WebViewClient (:175-184) overrides only shouldOverrideUrlLoading. Per WebViewClient.onRenderProcessGone, the default returns false, and then "application will crash if render process crashed, or be killed if render process was killed by the system". Because of the missing lifecycle handling, terminal WebViews are also kept alive in the background.

**Proposed fix**

Override onRenderProcessGone: return true, drop the WebView, and set the controller to Ended ("Reopen terminal") so a new WebView can be created.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The cited line, root cause and severity are right. The proposed fix is incomplete.
> 
> 1. Returning true from `onRenderProcessGone` and setting `TermState.Ended` is not enough on its own. The existing Reattach button (TerminalScreen.kt:95) calls `controller.attach()`, which reuses the controller but never rebuilds the view. The `AndroidView` factory runs once per composition (TerminalScreen.kt:79), so no new WebView is created. After `webView = null`, `js()` returns silently (TerminalController.kt:192-193): a re-attached stream would paint into nothing, and `pageReady`/`pendingJs` would stay stale.
> 
> 2. The handler must also:
>    - detach the current `stream`;
>    - remove the WebView from its parent and call `destroy()`;
>    - reset `pageReady`, `pendingJs` and `cols`/`rows`;
>    - bump a generation counter that keys the `AndroidView` (e.g. `key(gen) { AndroidView(...) }`), so Compose builds a fresh WebView before attaching again.
> 
> 3. Optionally, call `setRendererPriorityPolicy(RENDERER_PRIORITY_BOUND, true)` so a backgrounded renderer is reclaimed ahead of the app, now that the app survives its loss.

## A46

**The ⌨ key-row chip only focuses the DOM textarea, which cannot raise the soft keyboard**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:293`

**Evidence**

`fun focusTerminal() = js("nt.focus()")` → terminal.js `focus: function () { term.focus() }`. Nothing in the app calls webView.requestFocus() or InputMethodManager.showSoftInput (grep finds neither). A script-initiated focus() from evaluateJavascript is not a user gesture, and the Android IME attaches to the focused View (the Compose text field, or nothing).

**Proposed fix**

In focusTerminal, call webView.requestFocus() and then InputMethodManager.showSoftInput(webView, 0) alongside the JS focus.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The conclusion and the line (TerminalController.kt:293, triggered from TerminalScreen.kt:171) are correct. The root-cause wording needs adjusting. Blink does not require a transient user gesture here. Script focus is allowed in a main frame (Frame::AllowFocusWithoutUserActivation returns true outside fenced frames), and the keyboard is gated only on STICKY activation, meaning any gesture since page load. The chip actually fails for three reasons:
> (a) Element::Focus returns immediately when the textarea is already the focused element, which is the normal state after the user has tapped the terminal once.
> (b) Sticky activation is missing if the user has never touched the page.
> (c) The WebView is not the focused Android view while the Compose draft field has focus.
> 
> Better fix:
> 1. In focusTerminal, clear the Compose focus first (LocalFocusManager.clearFocus() from TerminalScreen) so the draft field lets go of the IME.
> 2. Call webView.requestFocus().
> 3. Blur and then refocus the textarea (`nt.blur(); nt.focus()`), so Blink's already-focused early return does not swallow the call.
> 4. Post InputMethodManager.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT) with webView.post {} so it runs after the view has become the IME's served view. A synchronous call right after requestFocus can race.
> 
> Relying on showSoftInput is what makes this work regardless of the page's activation state. Needs a device check, since this was never built or run.

## A47

**The Keystore decrypt runs on the main thread in the host list's composition, once per row per recomposition**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/HostsScreen.kt:121`

**Evidence**

Inside each LazyColumn item, `routeSummary(host, graph.secure.getString(SecureStore.relayTokenKey(host.id)) != null)`. SecureStore.getBytes (SecureStore.kt:56-67) runs Cipher.init + doFinal with an AndroidKeyStore key, which is a binder round trip to keystore2. The row recomposes on every ConnState change (Connecting/AwaitingApproval/Connected/Failed) as well as on list changes.

**Proposed fix**

Store a non-secret `hasRelayToken` flag on the host record, or compute it once in a remembered/background-loaded state.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The mechanism, line and severity (low) are all correct. Three additions:
> 
> 1. **Lock contention.** The `@Synchronized` monitor in SecureStore (lines 44, 52, 70, 76) also makes this composition wait on any concurrent background SecureStore call, such as ConnectionManager.kt:101, 167, 181 or 183.
> 
> 2. **Wasted decrypts.** The decrypt runs even for hosts with `host.relay == null`, where routeSummary ignores the result.
> 
> 3. **Better fix.** Store a non-secret `hasRelayToken` boolean on PairedHost, or check only `prefs.contains(key)` without decrypting. Either one:
>    - moves the check off the Keystore entirely;
>    - updates correctly through the existing `graph.hosts.update` that follows `putString` in adoptRelayIfAdvertised (ConnectionManager.kt:183-186).
> 
>    A plain `remember { }` would still run the decrypt on the main thread once per row. If the decrypt must stay, use `produceState` on `Dispatchers.IO` keyed on `(host.id, host.relay)`.

## A48

**The seen-events set is trimmed in hash order and updated without synchronization, which can produce duplicate notifications**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/data/HostStore.kt:98`

**Evidence**

`fun markSeen(ids) { val next = (seenEvents() + ids).toList().takeLast(500).toSet(); prefs.edit().putStringSet("seenEvents", next).apply() }`. getStringSet returns a HashSet, so takeLast(500) drops arbitrary old ids rather than the oldest. The method is not @Synchronized and is called from the worker thread (InboxNotifier.kt:86), from graph.scope (TerminalController.kt:262) and from main (InboxTab.kt:76). Concurrent read-modify-write loses updates.

**Proposed fix**

Store (id, ts) pairs and trim by age, make markSeen @Synchronized, and use commit()/an atomic update.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Mostly accurate. Two corrections:
> 
> 1. The concurrency half is much narrower than the eviction half. SharedPreferences `apply()` updates the in-memory map synchronously, so the race window is microseconds. Also, TerminalController.kt:262's id is usually resolved on the desktop by the `ackRead` just before it, so losing that write rarely causes a re-notify. The dominant real cause is the hash-order eviction once the set passes 500. Each markSeen of k new ids then evicts k arbitrary old ids, and any of them that is still unresolved and under 6 h old gets re-announced.
> 
> 2. Better fix: announce() only considers events younger than 6 h (InboxNotifier.kt:79). So store id→seenAt (for example a JSON map in one string pref) and prune entries older than about 6 h plus a margin, rather than using a count cap; nothing still eligible is ever evicted. Make markSeen @Synchronized like the other mutators in the class. commit() is not needed, because apply() already publishes to memory atomically; the missing piece is the lock around the read-modify-write.

## A49

**SSH host-key TOFU pin is saved during key exchange (before auth) and is not tied to the pairing**

- Severity: **low**; claimed by auditor: medium; effort: small; area: security; kind: risk
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshHostConnection.kt:330`

**Continuation status (2026-10-04):** the original authentication/pairing-anchor fix remains
in place. The later key-discovery residual is tracked as [A99](#a99): recursive external
`Include` discovery is fixed in `e07071e9`, with actual desktop and full beta 11 source checks
passing; physical included-key pairing remains pending.
Relative `HostKey` values, inaccessible configuration and a key without a readable public
counterpart remain outside discovery. Relative `Include` values are a different case: they are
resolved under the sshd configuration root. No first-use trust or mismatched-key override is added.

**Evidence**

The verifier pins whatever key answers first: `pinned == null -> { pin.pin(fp); true }` (line 330). This runs inside `client.connect()`, before `client.authPublickey(...)` (line 348). The catch block (lines 353-357) never undoes the pin, so an SSH server that REJECTS our key still becomes the pin (it is persisted via HostStore.update, ConnectionManager.kt:154-157). Pairing does not anchor the pin: `PairedHost.from` sets `sshHostKeyFingerprint = null` (PairedHost.kt:83), and neither the QR nor the sealed /pair response carries an SSH host key. Every non-Windows host advertises SSH whether or not sshd is running: pairing-service.ts:440 `directSsh = platform !== 'win32'` and line 652 only adds `ssh:false` on Windows. macOS ships with Remote Login off. For such a host the pin stays null and the phone keeps dialing the host's private LAN IP from whatever network it is on, including every 15 minutes from InboxWorker. Once pinned, a mismatch is a hard stop with no relay fallback: ConnectionManager.kt:88-93 rethrows HostKeyChangedException before the relay block.

**Proposed fix**

Record the fingerprint in verify() but persist it only after authPublickey succeeds. Anchor the pin in pairing: have the desktop return its SSH host key fingerprints (e.g. from /etc/ssh/ssh_host_*_key.pub) inside the sealed /pair response, and store them in PairedHost.from so the first connect is verified. Do not background-dial a host whose SSH has never authenticated, and allow relay fallback when the pin was never confirmed by a successful auth.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Downgrade to low. Four corrections:
> 
> 1. The unpinned window is narrow. On macOS/Linux the pairing QR is only shown while sshd answers on 127.0.0.1:22 (src/shared/pairing-gate.ts; PhonePairPopover.tsx:49; PhoneSection.tsx:95). The app then connects over SSH immediately on the pairing LAN (PairScreen.kt:158 → HostScreen.kt:66 startWatching), so the first pin is normally the real computer's key. The "Remote Login off, so the pin stays null forever" scenario does not happen at pairing.
> 
> 2. Pinning during key exchange mirrors OpenSSH's known_hosts behavior. The real defects are:
>    - The KDoc says the pin is null "before the first successful connect", but a key exchange whose authentication failed also pins (SshHostConnection.kt:44-47 vs 330/346-357).
>    - Pairing cannot anchor the pin: the desktop /pair response (pairing-service.ts:827) and the QR carry no SSH host key. Anchoring needs a desktop change, which would also serve the iOS app.
> 
> 3. The more likely user-facing impact is the one listed only as secondary evidence. After a correct pin, a private-IP collision on another network makes Auto mode fail with a "host key changed" error and never tries the relay (ConnectionManager.kt:88-93).
> 
> 4. Better fix:
>    - On a mismatch, refuse SSH and show the warning, but still fall through to the relay. The relay is independently authenticated (hostKeyB64 / relay host key plus the SAS approval), so this is safe.
>    - Persist the pin only after `authPublickey` succeeds.
>    - Have the desktop return its SSH host key fingerprints inside the sealed /pair response, and store them in `PairedHost.from`.

## A50

**The only distributable build is a debuggable APK, so Keystore-protected secrets can be pulled over adb/JDWP**

- Severity: **low**; claimed by auditor: medium; effort: medium; area: security; kind: risk
- Location: `android/app/build.gradle.kts:19`

**Current private-beta status (2026-10-04):** beta10/code11 from clean e3ce041c is installed on
the intended Pixel with verified signature/non-debuggable metadata, exact APK hash, install
identity and notification grant. Genuine desktop-issued beta9 pairing/relay credentials survive
the same-signer update; actual saved relay reopen/input reaches the scoped PTY. A91/A94 installed
End/recreate/open/End completed-empty flow also passes. Items 1/36 pass and item 49 is Partial, giving 10 Pass / 22 Partial /
32 Pending. This still leaves broader minified worker/QR/cellular-relay/device checks open; the
public distribution/link work is separate from this user's private-beta scope. Receipt:
`.nodeterm/android-beta-build-10/paired-update-result.json`; exact-source CI37194375778 has all
five jobs green. Earlier installation/results below retain their original historical scope.

**Evidence**

The release buildType has no signingConfig (lines 19-25). The README's only install path is `./gradlew :app:assembleDebug → app-debug.apk` (android/README.md:32-38). CI uploads `nodeterm-android-debug` (.github/workflows/android.yml:73-80). The desktop sends users to that folder (src/renderer/lib/links.ts:7 `ANDROID_APP_URL = '.../tree/main/android'`). AGP marks debug builds `android:debuggable=true`, which enables `adb shell run-as dev.nodeterm.android` and JDWP attach to the app process. SecureStore's guarantee ('it never leaves the secure hardware') is about the key material only: the key is usable by any code running as the app's UID or inside its process.

**Proposed fix**

Ship a signed, non-debuggable release build (configure signingConfig and publish release artifacts), and point the README and desktop link at it. Until then, state in the README that the debug APK exposes the phone's keys to anyone with adb access.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> **Severity is overstated. This is closer to low than medium.** The attack needs physical access to an unlocked phone that has USB debugging on and has accepted the attacker's adb RSA prompt. Someone in that position can already drive the non-debuggable app's own UI (terminal, new session) to run commands on the paired computer. What the debuggable flag adds is exfiltration of durable, reusable credentials: the unrestricted SSH key, and relay impersonation via box secret plus device token. Sideloading also does not require USB debugging; an APK can be installed from the browser, so "often switched on precisely to sideload" is plausible but not required.
> 
> **The cited line is right** (build.gradle.kts:19-25). The root cause is more precisely the absence of any signed release artifact or release pipeline. No debug-specific setting is wrong on its own: debug builds are meant to be debuggable.
> 
> **The fix should cover three things:**
> - A signed, non-debuggable release (a `signingConfig` fed from CI secrets, `assembleRelease`, artifacts attached to a GitHub Release).
> - Pointing README and `ANDROID_APP_URL` at that release.
> - Until then, a README warning that the debug APK exposes the phone's pairing credentials to anyone with adb access.
> 
> **A related, unverified distribution problem:** debug APKs built on CI are signed with a per-runner debug keystore. If that keystore is freshly generated each run, one CI artifact cannot update another in place. Uninstalling first wipes the Keystore and the prefs, which forces a re-pair.

**Private-beta continuation (2026-10-02):** local signing/verification is implemented in
`android/tools/package-beta.py`; exact takeover-branch pushes (or later opted-in manual CI runs)
version the unsigned AGP release and gate its
provenance on protocol, release and desktop/packaging checks. The tool verifies APK/R8 hashes from
that run's input metadata, rejects the public debug key, requires the expected private certificate,
checks non-debuggable release metadata/alignment/signature, and emits an APK/checksum/metadata set
only after success. Keys and signed APKs stay local: Actions artifacts on a public repo are not
private downloads. Real Android-tool regressions use disposable fixture keys/APKs, not an app build.
The user confirmed the first private beta and its retained signer is prepared in ignored local
state (RSA-3072 PKCS12, restricted directory/files, verified certificate pin distinct from debug).
The actual private minified beta at `fa71cb08` is signed, verified, and was installed and cold-started on
an MI8 (Android 15 / API 35). Installed metadata confirms version code `2`, minSdk `26`, targetSdk
`35`; refused `run-as` confirms the non-debuggable build. With notification permission granted,
the empty Computers screen, Pair button and Settings appear with no crash markers. This addresses
signed-artifact preparation and part of checklist item 5 on that test device. The user identified
the MI8 as the wrong phone, so only the newly installed app and its test UI dump were removed;
its newly authorized SSH key was removed and host `authorized_keys` restored byte-for-byte.
No host had been paired and no SSH connection attempted. The intended Pixel 10 Pro now has the
same signed beta; it runs Android 17 / API 37 with Vanadium WebView `154.0.8037.92.0`, accepted
notifications through the normal dialog, and refuses `run-as`. Manual SSH uses the authorized phone
key with existing keys preserved and a matching Ed25519 host pin, lists 17 real projects and
delivers a harmless sentinel in a controlled temporary test window. The actual code-3 private
update preserved host configuration, SSH key/pin and notification permission, and fixes the one-row
viewport/history failure (`A85`), including font/keyboard resize, Esc and draft input. QR/code
pairing, relay, reconnect/background/answer behavior and full 64-item phone validation leave `A50`
partly open; the user confirms Wi-Fi-off mobile-data WireGuard terminal access.

**Beta-6 device follow-up (2026-10-02):** the unchanged minified code-7 APK at source
`c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6` passes requirement-audited checklist items 18/19/21/22/24/38/39:
real SSH Unicode rendering, exact 90000-character clipboard/150000-and-450000 size refusals,
silent invalid OSC52 with clipboard preserved, all three keyboard-focus states, and background
process-kill Inbox/back-stack restoration, plus the synthetic shipped-hook lifecycle detailed below.
All 17 sending chips plus four app-mode arrows and software-input/font/rotation SSH survival
complete item 18 on the existing proof. Copy-sheet exact Unicode/Share/modal isolation,
wrapped/OSC8 links and SSH background/detach recovery add partial evidence. Landscape with IME open was 129×1; usable-height
and larger-client Fit remain unverified. The 450000 pre-bridge cap is distinct JVM/JS evidence,
not inferred from a phone toast. Browser/Copy-sheet Open and offer interactions, airplane/outage,
QR/cellular-relay/notification, custom bindings/FPS and remaining variants stay open.
Encrypted paste pairing and a forced relay-only browse of an isolated production desktop
(`58a202be`, real SecretService credential storage) now pass against the live hosted API/relay;
the current `/v1/relay/join` contract is verified beyond interop. Remote access was enabled at
pairing, so no first SAS prompt is expected; QR/scanner, cellular relay, SAS denial/revoke and
remaining node/action behavior remain open. No user-profile credentials were copied into the private home.
The phone then attaches through the relay and sends echo input to an owned real PTY seeded through
production preload/Canvas events; phone New session/folder-picker are not tested. Item 39 now passes:
the shipped managed hook returns actual allow/deny JSON in 17.596/6.571 seconds, and a 45-second
expiry returns empty; the late Approve visibly reports timeout and opens the owned terminal without
false success. The producer is synthetic, with no live Claude CLI/account or requested Bash execution.
Mounted relay single-select one-tap, multi-select Open-session/input and copy-mode answers also
reach the actual synthetic application and its shipped PostToolUse hook/mirror. In the copy-mode
case, the exact owned pane is in mode before PreToolUse; option 3 arrives, mode becomes false,
and the mirror becomes working with its question resolved. Item 41 remains Partial: offscreen/
released/direct-SSH/target-guard device variants and notification questions remain open.
No live Claude CLI/account was used. At that stage required checks passed all 658 protocol
tests in 63 suites (54 seconds) plus offline app `compileKotlin` (5 seconds).
Only disposable fixture resources were cleaned up and the phone returned to regular Sessions;
scoped cleanup is not a full device/backend revoke check. On 2026-10-03 the user confirms the
final beta-6/code-7 usual manual-SSH terminal "Connects and scrolls smoothly", confirming connection
and smooth scrolling with WireGuard enabled and Wi-Fi off over cellular. Cellular hosted relay remains
untested. Item 20 remains Partial; no runtime change, phone command or new product finding resulted.
Protocol/offline app tasks at that stage passed in 50/1 seconds; current A90 checks are recorded below.
The [64-row record](android.md#what-is-verified-and-how) now has ten Pass, 22 Partial and
32 Pending after item 1 paired-update, focused A90 proof and item 36 Board verification; the earlier beta6 7/20/37 checkpoint is preserved, with named
conditional SKIP variants; `A50` remains partial. Private synthetic
proof is in `.nodeterm/android-beta-build-6/checklist-20261002/`. Recorded prior all-green branch `19da35a2` has all
five jobs green in [run `37140762345`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37140762345),
including A90. Historical beta9 source `4d33a5b5` failed documentation mapping in run `37144282865`;
current installed beta 10 source `e3ce041c` passes all five jobs in run `37194375778`. The next documentation push needs
its own checks/green workflow.
The requirement review promotes item 18 using existing all-key/software-input/font/rotation SSH
survival proof, without new phone work. Viewport/Fit belongs to item 23 and stays Partial; item 1
now passes desktop-issued beta9 pairing/relay survival across the code10→11 update.
The user resumed Pixel release checks on Oct4; full release, cellular hosted relay and live-Claude
verification remain open. No new product finding is added.
QA-driver coordinates/side-Back and Compose class assumptions are not product findings. No
production/host contract changed and no new audit finding is added.

**Historical prepared beta-7 update (2026-10-03), unused:** private `0.1.0-beta.7` / code `8` uses
source `b53610deb3843b59fa6a1bed5bdc5f36da0f5146` and the retained signer. The local AGP build
took 47 seconds; R8 and packaging passed. APK SHA-256:
`5141c6484b422b236a98213731076be621c4d14a55f47c79bfd989fb23609e6a`.
Ignored proof/artifacts are in `.nodeterm/android-beta-build-7/` and `.nodeterm/android-beta-7/`.
It was never installed and is superseded by beta 8 / code 9 below. Debug migration stays
conditional SKIP on this working Pixel. Historical beta-6 proof at `c4b1f6cf` and the
seven Pass / 20 Partial / 37 Pending tally remain unchanged. Preparation adds no runtime fix,
finding, phone work or device pass; `A50` stays partial.

**Historical beta-8 update (2026-10-03), superseded by installed beta 9:** A90's code-9 APK at clean
`b88d141528c1051964da07faf22cc7fa923c4846` passes the offline 49-second AGP release, R8 keeps,
retained-signer packaging/provenance and independent SDK 36/37 artifact checks. SHA-256:
`d373ad5c1790f714cb4464ad4a0a38c5ba9ab68e35103e54cf3aef5ce53081ce`.
The exact intended Pixel 10 Pro / Android 17 received a 28.05-second same-signer `adb install -r`.
Pulled pre/post APKs match known beta 6 / beta 8 and the SDK-37 public signer check matches the
retained pin. Post-install metadata is code 9/name beta 8/non-debuggable; `firstInstallTime` and
granted `POST_NOTIFICATIONS` are preserved. The app starts and its existing manual-SSH host row
remains in All computers. Opening that exact host reconnects over SSH and lists real driven
projects. The screenshot shows New terminal and own-app UI XML confirms the FAB is enabled/clickable;
this is not a TalkBack check. No existing pane was touched and no terminal was created or ended.
These facts establish manual-host configuration/reconnect/browse survival, not A90 creation or
desktop-issued pairing/relay credential survival.
Private installation proof is `.nodeterm/android-beta-build-8/device-install-20261003/receipt.json`
plus package/APK/certificate checks, `sessions.png` and `ui-sessions-ready.xml`. After the hike, pair on current beta 9 /
code 10 using desktop-issued JSON or QR, then verify pairing/relay credential survival across a later
same-signer higher-code update without downgrading or uninstalling (item 1). Historical beta-6
physical proof and the seven Pass / 20 Partial / 37 Pending ledger remain unchanged; `A50` stays partial.

## A51

**allowBackup=false does not stop device-to-device migration at targetSdk 35: hosts, pins and deviceId are cloned**

- Severity: **low**; claimed by auditor: low; effort: small; area: security; kind: gap
- Location: `android/app/src/main/AndroidManifest.xml:13`

**Evidence**

The manifest sets only `android:allowBackup="false"`, with no `android:dataExtractionRules`, and build.gradle.kts:14 targets SDK 35. Android 12's behavior changes state that for apps targeting 31+, allowBackup=false disables cloud backup but not device-to-device transfer; only a `<device-transfer>` exclusion in dataExtractionRules does. `nodeterm.hosts` (every PairedHost, its SSH pin and relay block) and the phone's `deviceId` (HostStore.kt:66-69) are plain SharedPreferences and move to the new phone. `nodeterm.secure` ciphertext moves too but cannot be decrypted there, so SecureStore regenerates the identity. The backend keys the device row on that deviceId: pairing-service.ts:921 says the mint 'upserts on it'.

**Proposed fix**

Add android:dataExtractionRules with `<cloud-backup>` and `<device-transfer>` excluding the `nodeterm.secure` and `nodeterm.hosts` shared_prefs (or excluding everything).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Mostly right. Refinements:
> 
> 1. **Revoke only happens on Pro desktops.** `revokeRelayDevice` returns 'skipped' when the desktop holds no entitlement (`pairing-service.ts:156`: `if (!entitlement || !relayDeviceId || !apiBase) return 'skipped'`). So the "Remove revokes both phones" effect only happens on an entitled (Pro) desktop.
> 2. **A second, likely effect on free desktops (backend not in the repo, so not verified).** The mint comment at `pairing-service.ts:84-87` says the backend's free-tier re-registration demands `priorDeviceToken` for an existing deviceId, and without it returns 403, leaving a "silent LAN-only pairing". The migrated phone re-registers an existing deviceId but cannot decrypt its prior token (`PairScreen.kt:140` returns null). Unless the backend's same-desktop allowance applies, its relay leg may be refused. On a Windows desktop that refusal fails the pairing outright (502).
> 3. **Wording of the fix.** Exclusion paths for the sharedpref domain need the `.xml` suffix: `<exclude domain="sharedpref" path="nodeterm.secure.xml"/>` and `path="nodeterm.hosts.xml"`, under both `<cloud-backup>` and `<device-transfer>`, referenced with `android:dataExtractionRules="@xml/data_extraction_rules"`.
> 4. **A sturdier fix.** Keep `deviceId` inside SecureStore, or re-mint it whenever the box secret had to be regenerated. That way the relay id always changes together with the keys it belongs to, whatever the backup rules say.
> 
> Severity "low" is reasonable. It only bites after an Android 12+ phone migration, and the host list is recoverable by re-pairing.

## A52

**Approval and finish notifications put command text and the agent's last message on the lock screen**

- Severity: **low**; claimed by auditor: low; effort: small; area: security; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:108`

**Evidence**

`.setContentText(ev.title + (ev.detail?.let { " — $it" } ?: ""))` plus BigTextStyle with the detail (lines 108-109). There is no setVisibility, setPublicVersion or channel lockscreenVisibility, so the default VISIBILITY_PRIVATE applies, which shows full content on a secure lock screen under Android's default 'show sensitive content' setting. For approvals, `detail` is the tool summary: the first line of the Bash command, the file path with the diff size, or the fetched URL (agent-status-mirror.ts:1143-1198). For DONE events it is the agent's last message line (agent-status-mirror.ts:1691).

**Proposed fix**

Keep `detail` out of the notification by default: for example, set VISIBILITY_PRIVATE with a setPublicVersion that shows only 'Needs you — <session>' / '<computer>', and add an opt-in 'Show details on lock screen' setting. Or use VISIBILITY_SECRET for the attention channel.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The cited line is right: line 108, with line 109 carrying the BigTextStyle.
> 
> The first proposed fix would not work. VISIBILITY_PRIVATE is already the default, and Android shows the public version only when the user has turned on "hide sensitive content" for the lock screen. Under the default setting, a PRIVATE notification is still shown in full whether or not a public version exists. So "VISIBILITY_PRIVATE plus setPublicVersion" does not hide the detail in the case the finding describes.
> 
> Fixes that would work:
> - Use VISIBILITY_SECRET, on the notification or as the channel's lockscreenVisibility.
> - Or leave `detail` out of both contentText and BigTextStyle by default, and put it behind an opt-in setting (for example "show details in notifications").
> 
> The setPublicVersion that shows only "Needs you — <session>" is worth adding alongside either fix. It only helps users who already hide sensitive content, so on its own it does nothing for the default case.
> 
> The finding should also say that the same detail already reaches the iOS phone through the APNs push body (src/core/push-notify.ts:361). This is a difference in platform defaults, not an Android-only leak.

## A53

**OSC 52 handler has no size cap (the desktop caps at 1,000,000) and setPrimaryClip is unguarded**

- Severity: **low**; claimed by auditor: low; effort: small; area: security; kind: bug
- Location: `android/app/src/main/assets/terminal/terminal.js:55`

**Evidence**

Android: `var payload = idx >= 0 ? data.slice(idx + 1) : data; if (payload && payload !== '?') bridge.onCopy(payload)`, with no length limit and no `;` required. TerminalController.kt:153-161 decodes it and calls `cm.setPrimaryClip(...)` inside `main.post {}` with no try/catch. Desktop: src/renderer/terminal/osc52.ts `const MAX_BASE64 = 1_000_000 ... if (i < 0) return null ... if (!payload || payload === '?' || payload.length > MAX_BASE64) return null`, and it decodes with `fatal: true`. The vendored xterm.js accepts OSC payloads up to `PAYLOAD_LIMIT=1e7`.

**Proposed fix**

Mirror parseOsc52: require `;`, cap the base64 at the desktop's limit or lower, and decode strictly. Wrap setPrimaryClip in try/catch and toast on failure.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is correct, but the proposed fix is partly insufficient. Capping at the desktop's `MAX_BASE64 = 1_000_000` would NOT prevent the crash:
> - tmux 3.4 forwards a 986,675-character base64 OSC 52 (measured), which is under 1,000,000 characters.
> - That decodes to about 740 KB of text, which ClipData parcels as UTF-16 at about 1.5 MB, still over the binder limit.
> 
> The fix that actually matters:
> 1. Wrap `setPrimaryClip` in try/catch and show a "copy too large" toast on failure.
> 2. Add a much lower cap in `terminal.js` and/or `onCopy`, for example a few hundred KB of base64 or about 100k characters of decoded text, to stay well under the shared 1 MB binder buffer.
> 
> Requiring `;` and decoding with a strict UTF-8 decoder (`CharsetDecoder` with `CodingErrorAction.REPORT`) are parity niceties only; neither prevents the crash.
> 
> The severity of low is defensible. Medium is also arguable, because remote pane output can crash the app, but only through a deliberately oversized sequence or a very large copy-mode selection.

## A54

**PairingClient trusts an unbounded Content-Length / EOF body from the pairing endpoint**

- Severity: **low**; claimed by auditor: low; effort: small; area: security; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/pairing/PairingClient.kt:253`

**Evidence**

`val buf = ByteArray(length)` uses a Content-Length taken from `toIntOrNull()`, with no upper bound or sign check (lines 247-254). Without a Content-Length it reads with `input.readBytes()` until EOF (line 263). The only limit is the 64 KiB header cap and a per-read soTimeout. PairScreen catches only `Exception` (PairScreen.kt:159). The endpoint is whatever `host:pairPort` the payload names, and a `nodeterm://pair` link from any web page can supply it (the user still has to tap Pair).

**Proposed fix**

Reject a negative Content-Length or one above a small cap (the real response is well under 64 KiB), bound the EOF read the same way, and add an overall deadline for the exchange.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Line numbers: the Content-Length parse is at PairingClient.kt:132-137 (`toIntOrNull()` at line 135), `ByteArray(length)` is at line 139, and the EOF `input.readBytes()` is at line 148. The finding cites 247-254, 253 and 263, which do not exist in this 152-line file.
> 
> The negative-value case does not crash. NegativeArraySizeException is a RuntimeException, so PairScreen.kt:159's `catch (e: Exception)` catches it. The screen then shows the exception's bare message (e.g. "-1") as the error instead of a sentence. Only the huge-positive and unbounded-EOF cases (OutOfMemoryError) crash the app.
> 
> Proposed fix, confirmed as sound:
> - Reject a negative Content-Length, and any value above a small cap such as 64 KiB, with a PairingException.
> - Cap the no-length EOF read at the same size.
> - Bound the whole exchange with an overall deadline, e.g. `withTimeout`, and close the socket on cancellation so the blocking read unblocks.

## A55

**Inbox and Usage are per computer; iOS merges them across all paired computers**

- Severity: **low**; claimed by auditor: medium; effort: medium; area: parity; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/InboxTab.kt:64`

**Evidence**

docs/mobile-usage-inbox.md:130: "**Agents tab (feed)**: merged events across connections, newest first". :124: "**Usages tab**: one section per paired connection that reports `usage` (header: host name + relative `updatedAt`)". Android's `InboxTab(nav, hostId, session, snapshot)` (InboxTab.kt:64) and `UsageTab(snapshot)` each render one computer inside HostScreen's tabs. The only routes are Hosts/PairHost/Settings/Host/Terminal (MainActivity.kt:28-33), with no cross-computer inbox. HostsScreen shows no needs-you count per computer.

**Proposed fix**

Add a top-level Inbox/Usage screen that merges every paired computer's snapshot, labels each card with its computer, and adds a needs-you badge to each computer row.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Refinements only; nothing in the claim is wrong. UsageTab is defined in the same file (InboxTab.kt:213), not in its own file. The Route list is at MainActivity.kt:28-34. HostScreen already computes a per-computer needs-you count (HostScreen.kt:70). The cheapest part of the fix is to lift that `count { it.actionable }` onto each HostsScreen row, using the session's cached snapshot. The merged Agents feed and Usages view also need each card and section to carry its hostId. The feed's Open, Approve and Answer actions have to call the right computer's `session.ensureConnected()`, because QuickActions is per-session today (InboxTab.kt:103-115).


**Continuation status (2026-10-04):** the merged Inbox/Usage and computer labels were fixed in
`71b592a`/`0772cbf`; the original evidence above describes the pre-fix screen. A remaining
freshness gap persisted in the beta 10 source: opening All computers requested one refresh, but
only individual host/terminal screens owned the live eight-second watcher. [A97](#a97) now adds
STARTED-only per-host watching and serialized listing/publication in `8443e71e`. Full beta 11
source checks pass; new physical multi-computer results are pending. The existing item 60
ledger is unchanged.

## A56

**Current follow-up:** A105 implements request-owned remembered rules through hook JSON; the original blind-digit proposal below remains unsafe.

**Approval cards lack iOS's "Always allow" answer**

- Severity: **low**; claimed by auditor: low; effort: small; area: parity; kind: gap
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/QuickActions.kt:23`

**Evidence**

docs/hook-reply-approvals.md:38-40, phone answerer: "`InboxApproval` writes it over the connection when the approval event carries `pendingId`; else falls back to send-keys. Digit `2`/\"Always allow\" keeps using send-keys in v1". Android's `answerApproval(conn, event, allow: Boolean)` (QuickActions.kt:23) supports only allow ("1" or the ticket) and deny (Esc). InboxTab offers only Approve / Deny / Open (InboxTab.kt:107-114).

**Proposed fix**

Add an "Always allow" action for Claude approvals. It re-checks that the node is still blocked, then sends `2` with send-keys; for a held ticket, open the session instead, since the prompt is not on screen.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line references are right. Two corrections:
> 
> 1. **Evidence.** The iOS behaviour rests only on docs/hook-reply-approvals.md:39-40. docs/mobile-usage-inbox.md:135-140, the v1 phone spec, defines only Approve and Deny.
> 
> 2. **Impact and fix.** `hookReplyApprovals` is on by default (src/shared/types.ts:1986), so most Claude approvals are held tickets. A keyed "Always allow" only works for unticketed ones.
>    - For a held ticket, "open the session instead" does not put the choice in front of the user right away. The prompt is not painted until the hook times out (`NODETERM_PERM_WAIT_SECS`, default 45 s, per docs/hook-reply-approvals.md:24-30). Until then the opened pane shows no prompt to pick `2` from.
>    - Better fix: add an "Always allow" button only when `event.agentId == "claude"` and `event.pendingId == null`. Re-check that the node is still BLOCKED with `stillWaiting`, then `sendKeys(nodeId, "2")`.
>    - For ticketed approvals, either hide the button, or open the session with a note that the prompt appears after the hold times out.
>    - Also add the gap to docs/android.md "Known gaps" if it is not built.

## A57

**Current follow-up:** A106 extends the display fix to complete held single/multi question answers through hook JSON. Legacy unheld multi-select still opens the session.

**Multi-select AskUserQuestion cards fall back to "Open session"**

- Severity: **low**; claimed by auditor: low; effort: small; area: parity; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/InboxTab.kt:118`

**Evidence**

src/core/agent-status-mirror.ts:384-386: `multiSelect` "Rides the pipeline so the phone renders multi-select chips". src/core/push-notify.ts:61-62: "Rides the `nt` block so the phone renders multi-select". Android shows option chips only when `ev.options.isNotEmpty() && !ev.multiSelect` (InboxTab.kt:118), and `QuickActions.answerQuestion` returns OPEN_SESSION when `event.multiSelect` (QuickActions.kt:43).

**Proposed fix**

Render toggleable chips for multi-select questions and send the chosen digits followed by the picker's submit key, re-checking that the node is still waiting before each send.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Line and root cause are right: InboxTab.kt:118 and QuickActions.kt:43 both deliberately route multi-select questions to "Open session", in line with the fail-safe policy at QuickActions.kt:17-18. Two corrections to the wider claim.
> 
> 1. The gap that can actually be shown is on the display side. Android does not show a multi-select question's options at all; the else branch at InboxTab.kt:124-126 renders only "Open session". The desktop comments (agent-status-mirror.ts:384-386, push-notify.ts:61-63) say the phone should render multi-select chips. Whether iOS also answers these questions cannot be verified from this repo.
> 
> 2. The proposed answer path is speculative. No keystroke sequence for Claude Code's multi-select picker (toggle key, submit key) is measured or documented anywhere here. A safer fix has two steps:
>    - Now: render the options read-only (numbered, non-interactive) next to "Open session", so the card shows what is being asked.
>    - Later: add answer-from-Inbox only after measuring the picker's real key semantics on a live CLI, and keep the stillWaiting re-check before sending.

## A58

**Usage and feed cards omit iOS's pace line and the context indicator on event cards**

- Severity: **low**; claimed by auditor: low; effort: small; area: parity; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/InboxTab.kt:246`

**Evidence**

docs/mobile-usage-inbox.md:128-129: "Pace line: compare `usedPercent` vs elapsed fraction of the window (`windowMinutes` else 300/10080 by kind) → \"5h usage pace slower/faster\"". :131-132: "Cards show the node's `contextPercent` ring when known". Android's `UsageBar` (InboxTab.kt:246-273) shows only the percentage and reset time, never using `windowMinutes`. `EventCard` (InboxTab.kt:163-208) shows no context % (only the live working cards do).

**Proposed fix**

Compute the pace from `resetsAt` and `windowMinutes`, using the 300/10080-minute defaults by kind, and show `inbox.nodes[nodeId].contextPercent` on approval, question and done cards.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line range for EventCard is slightly off. It is InboxTab.kt:162-206, not 163-208. UsageBar is 245-272 and the reset text is at line 263. The fix should compute the pace only when `resetsAt` is non-null: elapsed = 1 - (resetsAt - now) / (windowMinutes ?: (if kind == "session" then 300 else 10080)) / 60000. Compare that with usedPercent/100 to get "pace slower/faster". Also note that `windowMinutes` is null in some desktop mirror payloads (src/core/agent-status-mirror.test.ts:1584), so the per-kind defaults are required. The context value should come from `snapshot.status?.inbox?.nodes?.get(ev.nodeId)?.contextPercent`, which means passing it into EventCard.

## A59

**No built-in dictation (iOS has on-device Whisper plus a Cloud engine)**

- Severity: **low**; claimed by auditor: low; effort: small; area: parity; kind: gap
- Location: `android/app/src/main/AndroidManifest.xml:4`

**Evidence**

src/core/speech/whisper-models.ts:8-9: "The fences here are lessons already paid for on iOS: a download streams to a per-download `<file>.part.<genId>`". src/core/speech/cloud-speech.ts:4-6: "the SAME wire contract the iOS Cloud engine speaks (multipart WAV + locale, Bearer license token)". CLAUDE.md:5124: "**Mobile** keeps its own list, tracked separately as issue #591" (speech languages). Android has no speech code (a grep for speech/dictat/RECORD_AUDIO under android/ finds nothing), and the manifest declares only INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS and CAMERA (AndroidManifest.xml:4-8). The terminal input bar is a Compose `OutlinedTextField` (TerminalScreen.kt:124), so the keyboard's own voice typing still works.

**Proposed fix**

Add a mic button to the input bar using Android's SpeechRecognizer (or on-device whisper.cpp) that fills the draft and never auto-submits. Send the same multipart request to `/v1/transcribe` once it exists.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two corrections.
> 
> 1. The Cloud half of the parity claim does not matter yet. /v1/transcribe does not exist. CLAUDE.md:5101 says "not built yet", and cloud-speech.ts:6-7 says every call "maps 404 to a friendly 'not available yet'". So the iOS Cloud engine cannot transcribe anything today either. The real, current gap is on-device dictation plus a language choice.
> 
> 2. The gap is also missing from docs/android.md "Known gaps" (lines 88-105). Either implement dictation or list it there. Citing TerminalScreen.kt:123-139 (the input Row) is more precise than manifest line 4.
> 
> The proposed fix is reasonable. Android's SpeechRecognizer needs RECORD_AUDIO plus a runtime permission prompt. It should fill the draft only and never call controller.submit, which matches the desktop rule that nothing auto-submits.

## A60

**Interop fixture needs the Electron binary, which is downloaded at test time inside the 20 s ready window, despite the workflow saying 'not Electron'**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: bug
- Location: `android/protocol/src/test/interop/host-fixture.ts:22`

**Evidence**

The workflow comment at android.yml:39-42 says the fixture needs 'tweetnacl, ws and esbuild — not Electron ... hence no scripts', and InteropHarness.kt:72 bundles with `--external:electron`. The bundle still has three top-level `require("electron")` calls, from host-service.ts (`import { app, ipcMain } from 'electron'`, host-service.ts:28), host-identity.ts and host-canvas-hub.ts. I reproduced this with esbuild in the scratchpad: the bundle's lines 2330, 3565 and 4132 are `var import_electron… = require("electron")`, and they run when the module loads. Electron 42.11.3 has no postinstall. Its index.js ends in `module.exports = getElectronPath()`. When path.txt is missing, that function calls `downloadElectron()`, which does `spawnSync(process.execPath, [install.js])`, a synchronous download of about 110 MB from GitHub releases that extracts to 312 MB. If the download fails, it throws 'Electron failed to install correctly'. I simulated a clean node_modules/electron with an unreachable mirror, and `require` threw after 334 ms. On a fresh runner nothing downloads Electron beforehand. So the first `InteropHarness.start` pays for the download before the fixture can print its ready line, and the harness waits only `h.await(20_000)` for that line (InteropHarness.kt:93). A slow or failed download makes every interop test fail with 'fixture event not seen within 20000ms'. Local corroboration: node_modules/electron/path.txt and ~/.cache/electron are both dated 07:13, 18 minutes after `npm install` (06:54) and just before the protocol commit. That fits the first local interop run having done the download.

**Proposed fix**

Stop the fixture from loading the real electron package. For example, alias `electron` to a tiny stub exporting no-op `app`/`ipcMain` (`--alias:electron=./android/protocol/src/test/interop/electron-stub.ts`), or have the harness set `ELECTRON_OVERRIDE_DIST_PATH`, which makes index.js return a path without downloading. Then correct the workflow comment.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> 1. **Severity is lower than claimed; I'd call it low-to-medium.** On a GitHub-hosted runner, a GitHub-releases download of ~125 MB plus unzip usually finishes well inside 20 s. The normal outcome is a hidden 125 MB download (312 MB on disk) that adds a few seconds. Failures only happen when that download is slow or fails. Then both interop classes fail after 20 s: RelayInteropTest and PairingInteropTest (one `InteropHarness.start` each).
>    - An aggravating detail: when `h.await(20_000)` throws inside `start()`, the handle was never returned, so `close()` never runs. The node process is orphaned and keeps downloading, and the next test can start a second, concurrent download into the same dist/.
> 
> 2. **The local timestamp corroboration does not hold up.** node_modules/electron/path.txt is 07:13:04, but android/protocol/build/interop/ was created at 07:16:38, 3.5 minutes later. The download therefore happened before the first bundle recorded in that directory, and the timestamps do not show that the harness triggered it.
> 
> 3. **The proposed stub is incomplete.** Seven src/main/remote files import from electron, including host-identity.ts (`app, safeStorage`) and approved-devices.ts / peer-identity.ts (`app`), so a stub must also export `safeStorage`.
>    - Today, plain-node `require("electron")` returns a path string, so every member is already undefined at runtime. An empty-object stub is therefore behaviour-preserving for the current tests.
>    - The simplest fix is `pb.environment()["ELECTRON_OVERRIDE_DIST_PATH"] = <any dir>` in InteropHarness.start. The cleaner fix is esbuild `--alias:electron=<stub>`, which also removes the need for the electron package entirely.
>    - Either way, correct the comment at android.yml:39-40.

## A61

**Following CONTRIBUTING / android/README (`npm ci --ignore-scripts`) wipes a desktop developer's patched node_modules**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: bug
- Location: `CONTRIBUTING.md:111`

**Evidence**

CONTRIBUTING.md:107-111 is aimed at desktop contributors who change host-service.ts, the blob, the mirror and similar. It tells them to run `./gradlew -p protocol test` (from `android/`, after `npm ci --ignore-scripts`). android/README.md:48 says the same ('Run `npm ci --ignore-scripts` at the repo root first'). `npm ci` always deletes node_modules, and `--ignore-scripts` skips the root postinstall `node scripts/patch-node-pty.mjs && electron-rebuild -f -w node-pty,smart-whisper` and node-pty's own install script (`node scripts/prebuild.js || node-gyp rebuild`). After that, src/main/node-pty-patch.test.ts, which reads node_modules/node-pty/src/unix/pty.cc and src/win/conpty.cc, goes red in the contributor's `npm test`. On Linux node-pty ships no prebuild (its prebuilds/ folder only has darwin-*/win32-*), so `npm run dev` has no pty.node. On macOS it falls back to the unpatched ptmx-leaking prebuild that CLAUDE.md calls 'not optional' to patch. The harness itself only checks that node_modules/.bin/esbuild, node_modules/ws and node_modules/tweetnacl exist (InteropHarness.kt:81-85), so any ordinary `npm install` / `npm ci` already works.

**Proposed fix**

Say that a normal `npm install` is enough and that `--ignore-scripts` is only for a machine without the native toolchain (as CI uses it). Warn that it replaces an existing node_modules.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is accurate on the facts, the line numbers and the proposed fix. Severity is at the low end of medium, and arguably low: this is a documentation-only problem that affects developers, not the app or its users, and the test's own failure message names the recovery (`npm run rebuild`).
> 
> Recommended fix, in two parts:
> 1. **Scope the flag in both docs.** In CONTRIBUTING.md:110-111 and android/README.md:48, say that an existing `npm install` is enough. `--ignore-scripts` is only for a machine without the native toolchain, as CI uses it (android.yml:39-42).
> 2. **Add a warning.** `npm ci` deletes node_modules, so running it with `--ignore-scripts` over a working desktop checkout leaves node-pty unpatched and unbuilt until `npm install` or `npm run rebuild` is run again.

## A62

**SSH transport tests fail, not skip, on macOS: the gate checks only that /usr/bin/script exists, then runs util-linux-only flags**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: bug
- Location: `android/protocol/src/test/kotlin/dev/nodeterm/protocol/SshTransportTest.kt:54`

**Evidence**

The gate at lines 54-55 is `tmuxAvailable() = ... tmux -V ... && File("/usr/bin/script").exists()`. Every pty-requesting exec then runs `listOf("script", "-qfec", "stty cols $cols rows $lines ...; $command", "/dev/null")` (lines 84-85). `-c <command>` (and `-f`, `-e` in this form) is util-linux syntax. macOS /usr/bin/script is the BSD one (`script [-aeFkqr] [-t time] [file [command ...]]`), which has no `-c` and exits with a usage error. On a Mac with Homebrew tmux on PATH, which is the normal nodeterm developer setup, the gate passes and the pty-backed tests fail: the pane process dies immediately, and `Sink.waitFor` throws "'…' never appeared". This affects the attach and cold-start tests. CONTRIBUTING.md:110-111 tells every contributor to run exactly this suite.

**Proposed fix**

Gate on util-linux `script` (for example, require `script --version` to report util-linux), or `assumeTrue(os.name == Linux)`, with a skip reason. Alternatively, allocate the pty in the MINA command without `script`.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two corrections to the finding:
> - **Root cause and scope.** On macOS the first failure is not `Sink.waitFor` in the pty tests. `@BeforeAll` fails earlier: the private `TMUX_TMPDIR` is made by `Files.createTempDirectory("nt-ssh")` under `/var/folders/…/T/` (line 126). tmux resolves that to `/private/var/…`, so the socket path comes to about 110 characters, over macOS's 103. `tmux new-session` fails with "File name too long", and `assertEquals(0, code, out)` at line 187 throws. That fails all 8 tests in the class, not just attach and cold start. The BSD-`script` incompatibility at line 85 is real but only shows up after that is fixed.
> - **Citation.** The CONTRIBUTING.md reference is lines 106-109.
> 
> The fix needs both parts:
> 1. **Short socket directory.** Create a short, realpath'd `TMUX_TMPDIR`, the way `src/core/tmux-test-socket.ts` `makeTmuxTmpdir` does: prefer `/tmp` resolved to `/private/tmp`, and check `<dir>/tmux-<uid>/node-terminal` fits in 103 characters.
> 2. **`script` handling.** Either gate on util-linux `script` with a skip reason (for example, `script --version` reports util-linux, or `assumeTrue(os.name == Linux)`), or branch to BSD syntax: `script -q /dev/null /bin/sh -c '…'`.

## A63

**Android workflow path filters miss files that change the tested wire behavior, contrary to CLAUDE.md**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: gap
- Location: `.github/workflows/android.yml:7`

**Evidence**

The triggers cover only `android/**`, `src/main/remote/**`, `src/main/pairing-*.ts` and the workflow file itself (lines 6-17). ci.yml runs no Gradle. CLAUDE.md:5390-5396 says a change to 'a host-service.ts verb, the projects.list blob, the pairing payload, the mirror file, or the SSH-visible file contracts ... the Android workflow (.github/workflows/android.yml) runs on those paths'. Several of those producers are outside the filter. (1) host-service.ts validates the phone's params with `isValidPendingId` from src/core/agents/pending-approvals.ts (host-service.ts:37; this is exactly what the interop `approvals.answer` test exercises), with `parseCardLabelEdit` from src/core/project-kanban-write.ts (:36), and with `TITLE_MAX` from src/core/project-node-append.ts (:35). All three are in the fixture bundle; I listed its esbuild metafile inputs. (2) The projects.list blob is built by `listProjectsOutput` in src/main/index.ts:632, whose sync comment at :621-623 names only NodetermProjects.swift, not ProjectsParser.kt. The new approvals.answer/inbox.ack wiring is also in src/main/index.ts (about :4019). (3) The mirror is src/core/agent-status-mirror.ts, and acks are consumed by src/core/ack-sweep.ts. (4) The URL-form pairing QR that PairingPayload parses comes from src/shared/pair-qr.ts. (5) package-lock.json pins the ws/tweetnacl/esbuild/electron the fixture runs. None of these triggers the workflow.

**Proposed fix**

Add the fixture's transitive sources (at least src/core/agents/pending-approvals.ts, src/core/project-kanban-write.ts, src/core/project-node-append.ts, src/shared/**), src/main/index.ts, src/core/agent-status-mirror.ts, src/core/ack-sweep.ts, src/shared/pair-qr.ts and package-lock.json to both path lists. Or drop the path filter, since the protocol job is cheap. Also name ProjectsParser.kt in the index.ts marker comment.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause is right for the fixture's transitive sources, but the list is incomplete and part of the fix does nothing. The esbuild metafile shows 29 of the 43 bundled repo sources outside the filter, including src/main/windows-ssh-keys.ts (via pairing-service), src/core/license.ts, src/core/fs-ops.ts, src/core/platform.ts and many files under src/shared/. So the path list should cover at least `src/core/**`, `src/shared/**`, `src/main/windows-ssh-keys.ts` (or `src/main/*.ts`) and `package-lock.json`. The simplest fix is still to drop the path filter for the cheap protocol job.
> 
> Adding src/main/index.ts, src/core/agent-status-mirror.ts, src/core/ack-sweep.ts and src/shared/pair-qr.ts to the trigger would NOT make drift there fail anything. The fixture serves a hand-written blob and mirror (host-fixture.ts:140-165, :182 `listProjects: async () => blob`), and none of those producers is in the bundle. Closing that gap needs one of two things:
> - tests that build the blob, mirror and QR from the real producers, for example by extracting the blob assembly out of index.ts into a core module the fixture can import;
> - or CLAUDE.md:5392-5396 stops claiming the workflow covers "the projects.list blob ... the mirror file".
> 
> The index.ts marker comment (:621-623) should also name ProjectsParser.kt. Line references: the blob builder is at index.ts:633 (not 632), and the inbox wiring is at index.ts:4024-4025.

## A64

**Docs say the protocol tests check the mirror, the projects.list blob and the ~/.nodeterm files against desktop code, but those shapes are hand-copied in the tests**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: gap
- Location: `CONTRIBUTING.md:107`

**Evidence**

CONTRIBUTING.md:107-111 says a change to 'the `projects.list` blob, ..., the agent-status mirror, or the `~/.nodeterm/{pending,acks,relay.json}` files' is caught because `./gradlew -p protocol test` 'runs it against this repo's own host code'. CLAUDE.md:5392-5396 makes the same promise. In the relay fixture, the blob, including the whole mirror JSON with `inbox.events`/`pendingId`, is a literal written by hand (host-fixture.ts:129-165 and `listProjects: async () => blob` at :180). `answerPermission`, `ackRead`, `registerNode` and the three kanban writers are fakes that only emit events (:181-204). SshTransportTest.kt:168-184 hand-writes workspace.json and agent-status.json, and tests pending/acks by writing files itself (:283-294). No test runs `listProjectsOutput`, `agent-status-mirror.ts`, `ack-sweep.ts` or the index.ts `inbox` wiring. Only connectHostSession's RPC routing/validation and createPairingService are real.

**Proposed fix**

Either narrow the docs to what is actually exercised (relay framing/handshake and host-service validation, pairing service) and name the hand-copied contracts, or generate the fixture's blob and mirror from the real writers (for example, build the mirror with AgentStatusMirror and the blob with the same assembly listProjectsOutput uses).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The CONTRIBUTING.md:107-111 overclaim is real, and the fixture and test citations are correct (host-fixture.ts:129-165, :182, :183-205; SshTransportTest.kt:152-189 and :283-296). One part of the finding is wrong: CLAUDE.md:5388-5390 does not overclaim test coverage. It accurately names connectHostSession, createPairingService and the SSH server, and it tells contributors to update the hand-maintained fixture. CLAUDE.md's false statement is at :5395-5396, "the Android workflow ... runs on those paths". android.yml:5-17 only filters on android/**, src/main/remote/** and src/main/pairing-*.ts. So changes to src/main/index.ts (listProjectsOutput), src/core/agent-status-mirror.ts, src/core/ack-sweep.ts and src/core/agents/pending-approvals.ts do not trigger Android CI at all. docs/android.md:69-70, which lists `projects.list` as verified against the real host, is also overstated. Better fix, either or both of:
> (a) Narrow CONTRIBUTING.md, CLAUDE.md and docs/android.md to what is real: relay framing, handshake and host-service verb routing/validation, pairing, crypto, and the SSH scripts against real tmux. Name the hand-copied contracts (blob, mirror, v3 index, pending/acks, relay.json) and add the missing source paths to android.yml's `paths` filter.
> (b) Generate the fixture's mirror with the real AgentStatusMirror. Export the split markers and the blob assembly from a core module so the fixture and index.ts share one definition. In the SSH test, drive ack-sweep and pending-approvals against the files the Kotlin client writes.

**Current coverage update (2026-10-05):** actual producers now cover relay projects/mirror,
selected Server-profile publications, SSH action/managed writers and local/remote acknowledgement
consumers (A108/A111/A119). The newer relay-advertisement tests additionally run the actual
account-level writer/remover and Kotlin parser through private SSH, with every field, replacement,
removal and profile isolation checked. All 75 affected methods pass; four behavior mutants are
assertion-caught, with passing control/restored runs. The producer has a temporary OS-home adapter
during initialization; full Server boot/hooks/account probes, driven-slice producer parity and
standing-host/token/adoption/SAS/revoke behavior remain outside this proof. Legacy/adversarial
fixtures remain deliberately hand-written. Private evidence:
`.nodeterm/android-beta-build-16/desktop-links-and-advertisement-receipt/a64/`.
No production contract/APK or physical-ledger change follows.

## A65

**User-facing docs and desktop UI present the Android app as working, but it has never been built by AGP or run on a device, and no device checklist exists**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: gap
- Location: `android/README.md:11`
- Note: PARTLY OBSOLETE: the premise "never built by AGP" is wrong. CI run 36109984730 built the debug APK with AGP on 2026-09-25. The "never run on a device" half still holds.

**Evidence**

android/README.md:11-26 marks 15 features ✓ (terminal with OSC 52 copy, swipe-to-scroll, WorkManager notifications, and more) with no caveat. README.md:49 and :103 now say 'phone companions for iOS and Android' and 'scan with the nodeterm app on iPhone or Android'. The desktop UI now links 'nodeterm for Android ↗' (PhonePairPopover.tsx:196-201, PhoneSection.tsx:213-218), and its pairing copy was generalized to 'the nodeterm phone app'. docs/android.md's 'What is verified' section (lines 62-86) only says the app module 'is built by CI ... it has no instrumented tests yet'. On this branch the workflow is new (added in 2f58918) and has never run. The app Kotlin was only type-checked against stubs because Google Maven was unreachable, so aapt2, the manifest merger, D8 and any device run are all unverified. CLAUDE.md requires stating what could not be run as a numbered device checklist (rule 16, docs/grok-agent.md §9 format) and says 'a doc line with no such test is a plan, not a fact'. docs/android.md has no such checklist.

**Proposed fix**

State in android/README.md and docs/android.md that :app has not yet been built by AGP or run on a device. Add a numbered device checklist covering pairing (QR, code, deep link), SSH and relay attach, WebView terminal and OSC 52, notifications, and Keystore persistence. Consider holding the desktop 'nodeterm for Android' link until a CI build has passed.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Drop the build claims and downgrade the severity to low.
> 
> Wrong in the original finding:
> - ".github/workflows/android.yml has never run" and ":app has never been built by AGP" are both false. Run 36109984730 on head 2f58918 passed both jobs, `:app:assembleDebug` included, and uploaded a 15.8 MB debug APK.
> - The list "aapt2, manifest merger, D8 unverified" is false.
> - R8 does not apply (`isMinifyEnabled = false`, android/app/build.gradle.kts:22).
> - Do not tell the docs to say ":app has not been built by AGP". That would now be false, and docs/android.md:85-86 is correct as written.
> 
> The remaining finding is:
> - The app has never been installed or run on a device or emulator, and no doc says so.
> - The android/README.md:11-26 ✓ table has no caveat.
> - docs/android.md has no numbered device checklist in the rule-16 / grok-agent.md §9 format.
> 
> Proposed fix:
> - Add a one-line caveat near the ✓ table, e.g. "the APK is built by CI; no row has yet been checked on a device — see docs/android.md §Device checklist".
> - Add that numbered checklist to docs/android.md. Cover:
>   - QR scan via CameraX/ML Kit, pasted code, and the `nodeterm://pair` deep link from the system camera
>   - SSH attach and TOFU pin on a real LAN
>   - relay attach plus SAS approval
>   - WebView terminal input bar, special keys, swipe scroll and OSC 52 clipboard
>   - WorkManager inbox notifications, including the Android 13+ POST_NOTIFICATIONS grant
>   - Keystore persistence across app restart and reinstall
>   - the cold-start resume offer
> 
> Holding back the desktop "nodeterm for Android" link is optional rather than needed, since a build has passed. Note that ANDROID_APP_URL points at eneskirca/nodeterm tree/main/android, which only exists once this branch merges upstream.

## A66

**ANDROID_APP_URL points at a folder that exists on neither upstream nor fork main yet, and it points at source code rather than an installable**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: gap
- Location: `src/renderer/lib/links.ts:7`

**Evidence**

The constant is `export const ANDROID_APP_URL = 'https://github.com/eneskirca/nodeterm/tree/main/android'`. This checkout's origin is github.com/CPlusPlus17/nodeterm, and `git ls-tree origin/main android` is empty. The android/ folder exists only on claude/android-ios-parity-75kfem, so the link 404s until this lands on eneskirca/nodeterm main specifically. A merge into the fork alone leaves it broken. Even when the folder exists, the link sits beside 'Get the nodeterm iOS app ↗' (PhonePairPopover.tsx:196-201) and after 'Don't have the app yet?' (PhoneSection.tsx:205-219), but it opens a Gradle source tree, not a download. bugReport.ts:7 already defines `REPO_URL` for the same repository.

**Proposed fix**

Derive the link from `REPO_URL` and merge upstream before shipping the copy. Label it as source/build instructions (for example, 'Android (build from source) ↗') until a downloadable release exists.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Line references:
> - PhonePairPopover.tsx: the iOS button is 191-196 and the Android button is 197-202.
> - PhoneSection.tsx: the Android button is 213-218, inside the "Don't have the app yet?" paragraph at 205.
> 
> Root cause: the dead link is a timing artifact, not a shipping defect. It resolves when the branch merges to eneskirca/nodeterm main, and releases are cut from upstream v* tags. The part that stays true after the merge is the wording: "nodeterm for Android ↗" sits beside an App Store link and after "Don't have the app yet?", but the target is a Gradle source tree. The only APK is an expiring CI run artifact that needs a GitHub login.
> 
> Better fix:
> - Relabel both call sites as source/build, e.g. "nodeterm for Android (build from source) ↗". Once a signed APK is published, point the link at a GitHub Release asset.
> - Deriving the URL from REPO_URL (`${REPO_URL}/tree/main/android`) removes the duplicate constant. It does not change behaviour on a fork, because REPO_URL is also hardcoded to upstream.

## A67

**The interop fixture is excluded from every tsconfig, so `npm run typecheck` never checks it against the desktop interfaces it implements**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: gap
- Location: `tsconfig.node.json:17`

**Evidence**

tsconfig.node.json's `include` covers electron.vite.config.ts, src/main, src/preload, src/shared, src/core, src/server and src/session-host. tsconfig.web.json covers src/renderer and src/shared. Neither covers android/protocol/src/test/interop/host-fixture.ts. That file implements `HostPtyManager` and the kanban/inbox/nodeActions bridge (host-fixture.ts:97-204) and is only bundled by esbuild, which strips types without checking them (InteropHarness.kt:67-75). It passes tsc today (I checked it with a scratch config extending tsconfig.node.json), but nothing keeps it that way.

**Proposed fix**

Add `android/protocol/src/test/interop/**/*.ts` to tsconfig.node.json's include (or a small dedicated tsconfig run by `npm run typecheck`).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line reference is slightly off: the `include` array in tsconfig.node.json is at lines 18-26 (line 17 is the closing brace of `compilerOptions`). The implementing code spans host-fixture.ts:97-212, not 97-204. The esbuild call in InteropHarness.kt is at lines 67-71 (about 65-75 including the setup around it).
> 
> Two additions to the finding:
> - android.yml's path filter leaves out `src/core/**`, but the fixture imports `src/core/platform` and `src/core/pty-manager`. Some desktop drift therefore skips even the runtime interop tests.
> - The `pty as unknown as PtyManager` cast at host-fixture.ts:178 means even a type-checked fixture only checks the `HostPtyManager` interface, not its fit to `PtyManager`.
> 
> The proposed fix works: add `android/protocol/src/test/interop/**/*.ts` to tsconfig.node.json's `include`. I verified the file compiles clean under that config, with `@types/ws` resolving from the repo's node_modules.

## A68

**Workflow triggers break repo conventions: every branch push plus pull_request doubles runs, and there is no merge_group**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: risk
- Location: `.github/workflows/android.yml:6`

**Evidence**

`push:` has only `paths:` and no `branches:` (lines 6-11), and `pull_request:` has the same paths (lines 12-17). For a PR branch in this repo, each commit therefore runs both jobs twice. The concurrency group `${{ github.workflow }}-${{ github.ref }}` separates refs/heads/<branch> from refs/pull/<n>/merge, so neither run cancels the other. ci.yml:7-11 and security.yml:10-14 restrict `push` to `branches: [main]` and add `merge_group:` because 'required checks must also report on the queue's synthetic merge commits'. android.yml has no merge_group, so the queue's combined commit is never tested against the Android contract.

**Proposed fix**

Use `push: branches: [main]` like ci.yml, keep `pull_request` (with widened paths), and add `merge_group:`.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Keep the duplicate-run finding (android.yml:6-17 and 20-22), severity low.
> 
> Fix: add `branches: [main]` to `push:` and keep its `paths:` filter, so the merged commit on main is still tested. Keep `pull_request:` with `paths:` (widening the paths is a separate matter). That removes the duplicate runs on same-repo PR branches, and possible tag-push runs as well.
> 
> Drop the merge_group reasoning or reframe it. The merged commit is tested post-merge through push-to-main. The workflow cannot be a required check because of its `paths` filters, not because merge_group is missing. And merge_group takes no `paths` filter, so adding it would run Android on every queued PR. Only add merge_group if Android is deliberately made a required check. In that case, replace the workflow-level `paths` filter with an in-job path check that always reports a status.

## A69

**The Gradle/Kotlin code has no dependency-update, CodeQL or wrapper-validation coverage**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: gap
- Location: `.github/dependabot.yml:4`

**Evidence**

dependabot.yml has only the `npm` and `github-actions` ecosystems. There is no `gradle` entry for /android or /android/protocol, whose crypto and network stack is pinned in protocol/build.gradle.kts:28-34 and app/build.gradle.kts:78 (okhttp 4.12.0, sshj 0.39.0, bcprov-jdk18on 1.78.1). security.yml:40 limits CodeQL to `languages: javascript-typescript`, so the new Kotlin NaCl port, relay socket, host-key pinning and Keystore code get no static analysis. android.yml runs a committed binary, android/gradle/wrapper/gradle-wrapper.jar (sha256 7d3a4ac4…), without a wrapper-validation step, and it has no Gradle cache, so every run downloads the distribution, AGP and all dependencies again.

**Proposed fix**

Add Dependabot `gradle` entries for /android and /android/protocol. Add `java-kotlin` to CodeQL (build-mode none works without the Android SDK). Add `gradle/actions/wrapper-validation` (or setup-gradle, which also caches) to android.yml.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Three corrections, one of them material.
> 
> 1. Line numbers.
>    - `dependabot.yml:4` is a comment; the ecosystem entries are at lines 5 and 36.
>    - The pins are at `protocol/build.gradle.kts:27` (okhttp), `:30` (sshj) and `:32` (eddsa), not lines 28-34.
>    - `app/build.gradle.kts:78` (bcprov) is correct.
> 
> 2. The CodeQL fix as proposed would analyse nothing. `build-mode: none` for `java-kotlin` covers Java source only; Kotlin needs a build, and every file under `android/` is Kotlin (43 `.kt`, 0 `.java`). Adding `java-kotlin` with build-mode none would scan nothing while looking like coverage. The fix needs `build-mode: manual` (or autobuild) with a build step:
>    - `./gradlew -p protocol compileKotlin` needs no Android SDK.
>    - `:app:compileDebugKotlin` works on ubuntu-latest, which ships the Android SDK.
> 
> 3. The impact wording is stronger than I could verify. Dependabot security alerts come from GitHub's dependency graph, not from `dependabot.yml`. I believe (from memory, not checked) that Gradle coverage in that graph needs the dependency submission API. If so, the complete fix also adds `gradle/actions/dependency-submission`; that would also make the existing `dependency-review` job in `security.yml` see Gradle changes.
> 
> The rest of the proposed fix stands: Dependabot `gradle` entries for `/android` and `/android/protocol`, and `gradle/actions/setup-gradle` in `android.yml`, which validates the wrapper and caches. Adding `distributionSha256Sum` to `gradle-wrapper.properties` would also pin the distribution itself.

## A70

**On Windows the interop tests fail with CreateProcess instead of skipping**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: bug
- Location: `android/protocol/src/test/kotlin/dev/nodeterm/protocol/InteropHarness.kt:66`

**Evidence**

The harness does `val esbuild = File(repoRoot, "node_modules/.bin/esbuild")` and then `ProcessBuilder(esbuild.path, ...)` (lines 66-68). `available()` gates only on that file existing (line 83). On Windows, npm also creates the extensionless sh shim, so the gate passes. CreateProcess cannot run a shell script, though: it looks for `esbuild.exe`, which does not exist beside esbuild.cmd. The lazy `bundle` then throws, and the test errors instead of skipping. CLAUDE.md treats Windows as a first-class desktop target and requires platform-bound tests to be gated.

**Proposed fix**

Invoke esbuild through node (`node node_modules/esbuild/bin/esbuild …`) or through its JS API, or resolve `esbuild.cmd` on Windows.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause and the line numbers are right. Minor wording: CreateProcess may fail with error 193 (tries the sh file) rather than error 2 (looks for esbuild.exe); either way the result is an IOException.
> 
> The proposed fix is incomplete, and on its own it is harmful. If only the esbuild call is changed (for example `node node_modules/esbuild/bin/esbuild ...`), bundling succeeds on Windows and two new problems appear in PairingInteropTest:
> 
> (a) The pairing tests are platform-bound. The fixture calls `createPairingService(..., { timeoutMs: 60_000 })` without a `platform` option (host-fixture.ts:237-247). On win32, `directSsh = platform !== 'win32'` is false (pairing-service.ts:440), so the QR carries `ssh:false` (line 652). The first test's `assertTrue(payload.sshAvailable)` (PairingInteropTest.kt:53) then fails.
> 
> (b) The tests' home isolation does not work on Windows. PairingInteropTest.kt:38 sets only `HOME`, but pairing-service.ts:259-260 resolves `AGENT_DIR` from `os.homedir()`, which reads `USERPROFILE` on Windows. The relay-on test would reach the win32 branch, which mints and then calls `persistDevice({... token: agentToken ...})` (pairing-service.ts:803-822). That writes a paired test device, with a live bearer token, into the contributor's real `%USERPROFILE%\.nodeterm\agent.json`.
> 
> A correct fix has two parts:
> 1. Invoke esbuild through node, not the `.bin` shim, so RelayInteropTest can run on Windows.
> 2. Either gate PairingInteropTest off Windows (`assumeFalse(System.getProperty("os.name").startsWith("Windows"), reason)`), or have the fixture pass `platform: 'linux'` and have the test also set `USERPROFILE` to the temp home.

## A71

**android/README says 'JDK 17+', but the pinned Gradle 8.14.3 cannot run on JDK 25**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: gap
- Location: `android/README.md:36`

**Evidence**

The README says 'Needs JDK 17+ and the Android SDK'. The wrapper pins `gradle-8.14.3-bin.zip` (gradle-wrapper.properties:3). Gradle 8.14 supports running on Java up to 24; Java 25 support arrived in Gradle 9.1. A contributor whose default JAVA_HOME is the current LTS (25) gets a Gradle startup failure from `./gradlew`. CI pins 17 (android.yml:47-50, 68-71), and the protocol tests were run locally on 21.

**Proposed fix**

State the supported range ('JDK 17–24; Android Studio's bundled JDK works'), or bump the wrapper to a Gradle version that supports 25 (check AGP compatibility).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line (android/README.md:36) and the conclusion are correct. The finding says only "Gradle startup failure"; the precise cause is the Kotlin 2.0.21 compiler embedded in Gradle 8.14.3. Its `com.intellij.util.lang.JavaVersion.parse` rejects "25"/"25.0.1" with an IllegalArgumentException. This fires while settings.gradle.kts compiles, so the user sees "What went wrong: 25.0.1". The Kotlin DSL's own JVM-target mapping clamps unknown versions to JVM_22, so that part is safe.
> 
> Fix options:
> 1. Simplest: change the README to "JDK 17–24 (Android Studio's bundled JDK works; JDK 25 needs Gradle 9.1+)".
> 2. Add `gradle/gradle-daemon-jvm.properties` with `toolchainVersion=17`, so the daemon runs on 17 whatever JAVA_HOME is. This is incubating in 8.14, and the launcher still starts on JAVA_HOME.
> 3. Bump the wrapper to Gradle 9.1+. This needs its AGP compatibility with AGP 8.9.1 checked first; I have not verified that.

## A72

**Current follow-up:** A102 now includes trusted project env/shell and A103 preserves measured per-agent policy; old evidence below describes the earlier gap.

**Phone-started sessions are created without the agent-specific env, so for their whole life they get no hook-reply approvals, no canvas control and no pane ownership**

- Severity: **low**; claimed by auditor: medium; effort: medium; area: critic; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:229`
- Note: Related: A08.

**Evidence**

New session works by attaching a fresh `term-…` id and typing the launch line (TerminalController.kt:229-241; the docs/android.md table says 'pty.attach of a fresh term-… id, launch line, then projects.registerNode'). The relay attach passes no agentId (host-service.ts:432), and the desktop's own comment at pty-manager.ts:2254-2259 says these spawns carry 'no ownerProjectId — and no cwd, agent, account…'. hookServer.buildPtyEnv therefore omits `NODETERM_AGENT_ID`, `NODETERM_PERM_WAIT_SECS` and `NODETERM_CANVAS_CONTROL`, all gated on agentId (hook-server.ts:1249-1251). Pane ownership is recorded only when an ownerProjectId is supplied (pty-manager.ts:2309-2310). The node is registered afterwards, so the desktop mounts it warm, and tmux ignores `-e` on an existing session (CLAUDE.md: 'Sessions are pinned for life'). Nothing ever adds the missing env.

**Proposed fix**

Pass the intended agentId (and project and account) through the create path: add optional `agentId/projectId/accountId` to `pty.attach` for a not-yet-existing session, validated host-side like registerNode, or register first and let the desktop spawn with a held launch. Then the session gets the same env a canvas-started node does.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The behaviour is real, but four details need correcting.
> 
> 1. **Root cause is on the desktop, not in the Android code.** The gap is in the relay host's `pty.attach` verb (`host-service.ts:432` passes only `{cols, rows}`), and the desktop documents it at `pty-manager.ts:2254-2259`. Android is copying the iOS new-session flow (`docs/android.md:43`), so iOS presumably has the same gap. The fix belongs on the desktop side, with the Android client sending the extra fields.
> 
> 2. **"No hook env" is too broad, and so is the desktop's own comment.** `hookEnv` is still built for every `persistKey` (`pty-manager.ts:2893-2896`). `NODETERM_NODE_ID` and `NODETERM_HOOK_ENDPOINT` are present, so status badges and inbox events still work. What is missing is only the agent-gated part: `NODETERM_AGENT_ID`, `NODETERM_PERM_WAIT_SECS`, `NODETERM_CANVAS_CONTROL` and the Codex launcher PATH. Approvals still work from the phone through the keystroke fallback (`QuickActions.kt:36-38`), so this is a degraded path, not a broken one.
> 
> 3. **Severity should be medium-low.**
>    - Agent messaging is off by default (`agentMessagingDefault`).
>    - Every pane is already unproven after a desktop restart.
>    - Plain Codex is a supported mode.
>    - The real losses are deterministic approvals and canvas control for Claude sessions started from the phone.
>    - The user can repair a session on the desktop with "Restart agent and shell", which recycles the session so it respawns with the right env.
> 
> 4. **Of the two proposed fixes, only the first is sound.**
>    - "Register first and let the desktop spawn" does not work in general. The desktop only mounts nodes of the active project, and nothing spawns a registered node in a background project. The phone's own `pty.attach` would still create a bare session.
>    - The workable fix is optional `agentId` (and account) on `pty.attach`, applied only when the session does not yet exist. The host should validate the value against builtin/custom agents and let `buildPtyEnv`/`canControlCanvas` decide the grant.
>    - `ownerProjectId` must be resolved on the host (the index entry id), not taken from the phone. Otherwise it breaks `pane-ownership.ts`'s rule that ownership never comes "off the wire".

## A73

**Notifications are documented as 'live every 8 seconds while a computer is open', but the in-app poll never posts a notification**

- Severity: **low**; claimed by auditor: medium; effort: small; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:125`
- Note: Related: A25.

**Evidence**

InboxNotifier.announce has exactly one caller: InboxWorker.doWork (InboxNotifier.kt:125), the 15-minute WorkManager job. HostSession's 8 s poll (ConnectionManager.kt:212-221) only updates `_snapshot`. Yet the kdoc says '…plus the in-app 8 s refresh while a computer's screen is open' (InboxNotifier.kt:37-38). The Settings switch tells the user 'Checked about every 15 minutes in the background, and live while a computer is open.' (SettingsScreen.kt:84). android/README.md:55-56 says '…and live every 8 seconds while a computer is open'.

**Proposed fix**

Call InboxNotifier.announce from HostSession after each successful refresh, skipping events the user is currently looking at (e.g. the open terminal's node, or the Inbox tab). Alternatively, correct the copy in all three places.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line is correct: :125 is the only caller, and the definition is at :71. Three corrections:
> 
> 1. **Impact.** On the HostScreen, the Inbox tab badge ("Inbox (N)", HostScreen.kt:70,112) already shows new actionable events live. The unannounced cases are the terminal screen, other paired computers, and the app in the background.
> 2. **The proposed fix only covers the computer being watched.** "Call announce from HostSession after each refresh" works only for that computer, because other computers' sessions are not polled at all (`startWatching` is per-host and is started only by HostScreen and TerminalScreen). So it does not fix the "on another computer's screen" case the finding describes.
> 3. **Better fix.** Either:
>    - Call `announce` from `refreshNow` and skip the node open in the terminal. This also needs the seen-set updated for events shown on the Inbox tab, or the worker will later re-announce events the user already saw.
>    - Or, simpler and honest: change the three copy sites to say notifications arrive only from the ~15-minute background check, and that the Inbox tab updates live while a computer's screen is open.
> 
> Severity: medium is arguable, low-medium is more accurate. It is a documentation promise that is not kept, not a broken headline flow.

## A74

**The LAN leg dials a DHCP IPv4 frozen at pairing time; when another SSH host answers at that address, the host-key 'hard stop' also blocks the relay fallback**

- Severity: **low**; claimed by auditor: medium; effort: small; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/conn/ConnectionManager.kt:88`

**Evidence**

PairedHost.host is the QR's `host` (PairedHost.from, PairedHost.kt), which the desktop fills with `pickLanIPv4(os.networkInterfaces())` (pairing-service.ts:588). Nothing ever updates it: late adoption reads relay.json but not the address. connectLocked tries SSH to that address first in Auto. On a HostKeyChangedException it sets Failed and throws immediately: 'A changed host key is a security signal … do not quietly route around it' (lines 88-93), so the independently authenticated relay leg is never attempted. The error text says 'someone may be intercepting the connection'. The same private address commonly belongs to a different SSH-running machine: the computer's lease reassigned at home, or the phone on another network using the same 192.168.x.y range.

**Proposed fix**

Key the SSH pin to the computer rather than to the IP, and on a mismatch skip SSH but still try the relay (its identity is pinned separately, so no trust is lost). Refresh the LAN address when you can: publish it in `~/.nodeterm/relay.json` or the mirror and update it over the relay, or re-resolve it from a stable hostname.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two parts of the finding are overstated and should be corrected.
> 
> 1. The user is not locked out until they re-pair. SettingsScreen.kt:98-110 has a per-computer route override, "Only through the relay" (`RoutePreference.RELAY_ONLY`), which skips the SSH leg (ConnectionManager.kt:76) and reaches the computer through the relay. The real problem is that the error text never mentions that setting. It tells the user to "remove and re-pair", or implies an attack. Severity is medium at most: the case is narrow and there is a manual workaround. Low is also defensible.
> 
> 2. The proposed fix "key the SSH pin to the computer rather than to the IP" is based on a misreading. The pin is already stored per paired computer, not per IP: `PairedHost.sshHostKeyFingerprint`, read through `pinFor(host)` via `graph.hosts.get(host.id)` (ConnectionManager.kt:154-157). What goes wrong is the stale dial target, not how the pin is keyed.
> 
> Better fix:
> - In AUTO, when `HostKeyChangedException` is thrown, record and show the warning but keep going to the relay leg, which has its own pinned identity. Keep the hard stop for SSH_ONLY.
> - Change the message to point at the "Only through the relay" setting.
> - Optionally, have the desktop publish its current LAN address (for example in relay.json, or in the relay's `projects.list` reply). The phone could then refresh `host.host` after a successful relay connect. Clear the SSH pin only if the relay-authenticated computer confirms the new host key.

## A75

**The New session account picker lists managed Claude accounts by raw UUID**

- Severity: **low**; claimed by auditor: low; effort: small; area: critic; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SessionsTab.kt:316`

**Evidence**

The picker renders `Text(id ?: "System account")` for each `snapshot.status?.settings?.claudeAccounts` entry (SessionsTab.kt:316-320). The mirror's settings block carries only `{id, dir}` (agent-status-mirror.ts:184 `claudeAccounts?: { id: string; dir: string }[]`). The same snapshot does carry each account's `label`/`email` in `usage.accounts` (buildMirrorUsage, agent-status-mirror.ts:299-321; parsed into UsageAccount), but the picker never looks there.

**Proposed fix**

Resolve display names from `snapshot.status?.usage?.accounts` (label, else email) by accountId, falling back to the id. Longer term, add label/email to MirrorSettings.claudeAccounts.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is correct. Two refinements:
> 
> 1. **Line numbers.** The rows are built at SessionsTab.kt:316 and the `Text(id ?: "System account")` call is at line 319; the source list is set at line 292.
> 
> 2. **The fix only works on the desktop.** Only the desktop shell calls setMirrorUsageProvider (src/main/index.ts:3890). src/server/index.ts has no buildMirrorUsage/setMirrorUsageProvider call, so a Server Edition host publishes settings.claudeAccounts but no usage block. Usage can also be empty before the first poll. Looking the name up in `usage.accounts` (label, else email, else id) therefore only helps desktop hosts once usage has loaded.
> 
>    The durable fix is an additive `label` (and optionally `email`) field on MirrorSettings.claudeAccounts. It should be written by both producers (src/main/index.ts:2112 and src/server/index.ts:460, which already have `a.label` from settings) and parsed into ManagedAccount on Android. Old readers ignore unknown fields.

## A76

**Over direct SSH, opening a Sleeping (Eco-hibernated) session lands on a bare shell with no wake or resume offer**

- Severity: **low**; claimed by auditor: low; effort: small; area: critic; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:247`

**Evidence**

Eco exits the CLI and leaves a shell in the pane. Over the relay, attaching wakes it: host-service calls `remoteViewer.attached`, which fires `agent:wake` (index.ts:3986-3989). Over SSH nothing tells the desktop about the attach. SshHostConnection.wake is `relayOnly(...)` (SshHostConnection.kt:251), and SessionsTab hides 'Wake' unless `capabilities.nodeActions` (SessionsTab.kt:150-156). The phone's own resume offer fires only when `s.fresh` (TerminalController.kt:247), and a hibernated session is not fresh. The app knows both `hibernated` and the sessionId (Launch.resumeCommand) but offers nothing.

**Proposed fix**

Show the same resume banner when `snapshot.statusOf(nodeId)?.hibernated == true` on an SSH attach, reusing Launch.resumeCommand with the node's cwd and account. Or route the wake through the relay when a relay leg exists.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two details are overstated or wrong.
> 
> 1. **"No in-app way" is too strong.** Settings has a route choice, "Only through the relay" (SettingsScreen.kt:104, `RoutePreference.RELAY_ONLY`). If remote access is set up, switching to it makes the next attach go over the relay, and that attach wakes the node. The user can also type the resume line by hand. The real gap is narrower: in the default AUTO route on the LAN, the app shows nothing for a Sleeping session.
> 
> 2. **The proposed fix's signature is wrong.** `Launch.resumeCommand(agent, sessionId)` (Agents.kt:31) takes no cwd or account. None are needed either: the hibernated pane already sits in the node's cwd, and its tmux session env already carries the account's CLAUDE_CONFIG_DIR / CODEX_HOME.
> 
> The simplest fix is to widen the condition at TerminalController.kt:247 from `if (s.fresh)` to `if (s.fresh || status?.hibernated == true)`, and word the banner as "Wake <agent>".
> - It stays an offer the user accepts, never typed unasked, matching the existing rule.
> - The desktop's `hibernated` flag clears itself on the resumed CLI's SessionStart / live hook states, so a resume started from the phone leaves the desktop consistent.
> - One weaker spot: the desktop's wake checks that a shell owns the pane before typing, and uses KILL_LINE. This banner does neither, but the user can see the pane before tapping.

## A77

**IME insets are not handled for Android 15's enforced edge-to-edge (targetSdk 35): the terminal gets double bottom padding when the keyboard opens, and other screens have no IME padding at all**

- Severity: **low**; claimed by auditor: low; effort: small; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalScreen.kt:77`

**Evidence**

targetSdk = 35 (app/build.gradle.kts), so edge-to-edge is enforced on Android 15+. `android:statusBarColor` in themes.xml is ignored and adjustResize no longer resizes the window. TerminalScreen applies `Modifier.padding(padding).imePadding()` (line 77) without `consumeWindowInsets(padding)`. Material3 Scaffold only observes consumed insets and does not consume them for content: the material3 1.8.2 bytecode shows `onConsumedWindowInsetsChanged` and `exclude`, but no `consumeWindowInsets`. The bottom inset is therefore navigation bar plus IME height, and the IME inset already includes the navigation bar. PairScreen's paste field and SettingsScreen's 'Relay API' field, at the bottom of a scrolling Column, have no imePadding at all.

**Proposed fix**

Use `Modifier.padding(padding).consumeWindowInsets(padding).imePadding()` in TerminalScreen, and add `imePadding()` to the scrolling columns in PairScreen and SettingsScreen. Call `enableEdgeToEdge()` so behaviour is the same on API < 35.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> 1. **Scope is Android 15+ (API 35) devices only, not "all devices with targetSdk 35".**
>    - On API 26-34 the decor still fits system windows because the app never enables edge-to-edge.
>    - There the root layout consumes the system-bar and IME insets, so Compose's `WindowInsets` read 0. Scaffold's padding and `imePadding()` are both no-ops, and `adjustResize` really resizes the window.
>    - So TerminalScreen, Pair and Settings behave correctly there.
> 
> 2. **`enableEdgeToEdge()` is optional consistency, not part of the fix.**
>    - The needed change is `consumeWindowInsets(padding)` before `imePadding()` at `TerminalScreen.kt:77`, plus `imePadding()` on the scrolling Columns at `PairScreen.kt:92` and `SettingsScreen.kt:69`.
>    - Adding `enableEdgeToEdge()` would move API 26-34 onto the inset path as well, so every screen would then depend on its inset handling.
> 
> 3. **The PairScreen claim is narrower than stated.**
>    - The paste field (`PairScreen.kt:109-114`) sits fairly high on the screen: after two text lines and a button, and it is 120dp tall. On a typical portrait phone it usually stays above the keyboard.
>    - What is more likely covered is the "Use this code" button beneath it (line 115), and the field itself in landscape or on short screens.
>    - The Settings "Relay API" field is the stronger case.
> 
> 4. **Version note.** The bytecode cited (material3 1.8.2) is the JetBrains desktop stub. The Android build uses material3 from BOM 2025.06.00 (1.3.x), which has the same Scaffold inset logic.


## A78

**Desktop quick-answer false success (continuation, 2026-10-02).**

Re-read at cached branch tip `6afd8f53`: `PtyManager.backgroundWrite` sent live answers through
its painter and released answers through a name-targeted control command. Neither cancelled copy
mode; a missing name could match a longer session name. Multi-step delivery also needs to preserve
write order and pin the resolved pane across awaits.

The local fix resolves `=session:` to a numeric pane ID once, cancels copy mode there and sends hex
bytes to that same pane. Complete calls queue per node, including live and released paths; another
node remains independent. Unconfirmed channels are retired without retrying keys. Regression tests
judge delivered bytes, prefix collisions, active-pane changes, cancellation failure and concurrent
write order. Real-tmux cases are added but cannot run in this socket-restricted sandbox.

## A79

**Direct-SSH quick-answer false success (continuation, 2026-10-02).**

`SshScripts.sendKeys` used an exact session target but did not leave copy mode, so tmux could return
zero while the application received nothing. `SshHostConnection.sendKeys` also accepted a missing
SSH exit status as success.

The local fix resolves and validates the pane ID, cancels copy mode and types into that ID, and
requires exit status zero. Lookup/cancel/send failures propagate. Three generated-shell regression
tests pass under a cached compiler; four shell mutations and the null-as-success mutation are
caught. Full protocol, MINA, real tmux and device execution remain pending.

## A80

**Control-mode startup reply consumes a queued command (continuation, 2026-10-02).**

`ControlModeClient.start` launches `attach-session`, which has its own control reply block. The
client previously queued only stdin commands and shifted that queue for every reply. When a pane
probe was queued immediately after start, the empty startup reply resolved it; its actual reply
then belonged to the next command. A socket-free reproduction against the real client confirmed
this mismatch.

The local fix reserves and consumes the startup reply before resolving stdin commands, and retires
the client if attach fails. Behavioral regressions feed the initial reply after a command is
already queued and verify that only the command's own reply resolves it. Test children now emit the
startup block too. Full real-tmux and device verification remain pending.

## A81

**Relay HTTP token requests can stall indefinitely (continuation, 2026-10-02).**

`RelayApi` shared the long-lived WebSocket client, whose read timeout is deliberately zero, with
join/device HTTP calls. A server accepting a connection but stalling its headers or body could
leave the app connecting indefinitely. Blocking `execute` inside `withContext(IO)` did not cancel
the call when the coroutine was cancelled.

The local fix gives HTTP its own finite I/O limits and a 30-second total deadline, applies that
deadline even to an injected client, and keeps coroutine cancellation bound to `Call.cancel` until
the response body is closed. A coroutine deadline also covers OkHttp dispatcher queueing while
preserving an outer caller's cancellation. WebSocket reads and wire shapes are unchanged. Six regression methods
run real OkHttp over in-memory sockets, covering both endpoints, stalled headers/body, trickling
body, cancellation, dispatcher queueing, caller deadlines and successful wire shapes. Three initial
and three follow-up mutation checks are caught. Required Gradle, live
backend, roaming and device verification remain pending.

## A82

**Shared read-ack files are stolen by other desktops (continuation, 2026-10-02).**

The local sweeper read and deleted every `.seen` file under `~/.nodeterm/acks` before establishing
ownership. The remote shell did the same glob for a shared SSH host. Whichever desktop swept first
could consume another desktop's acknowledgment, leaving its unread badge/card intact forever.

Local consumption now requires positive mirror ownership, including an unresolved own inbox card
whose old node entry expired after restart. Unknown files remain unread and untouched; retained
files bypass the directory-mtime cache because ownership can appear without another phone write.
The remote manager forms the union of every connected project's nodes per host and sends validated
IDs on stdin; the shell reads/deletes only that allowlist, and its output is checked against it.
Regression tests cover two owners, late ownership, expired-node inbox cards, multiple projects on
one host and refusal of unexpected output. Android interop uses the actual `SshScripts.ackRead`
producer against the desktop's real local/remote consumers. File names/content stay compatible with
iOS; @eneskirca should validate multi-desktop behavior. Full checks and device execution remain open.

## A83

**Release R8 cannot parse Kotlin 2.2 metadata (local build, 2026-10-02).**

The first actual local `:app:assembleRelease` completed under AGP 8.9.1, Kotlin 2.2.0, wrapper
Gradle 8.14.3 and JDK 21, but emitted many R8 Kotlin-metadata parsing warnings. A successful task
therefore did not establish that the shrinker supported the metadata in its inputs. The APK was
not accepted as the final beta.

The configuration fix in `fa71cb08` changes only AGP to 8.10.1 in `android/build.gradle.kts`;
Kotlin 2.2.0, Gradle 8.14.3 and JDK 21 remain unchanged. `GradleCiCoverageTest` now guards the
Kotlin/AGP/R8 compatibility boundary and AGP's Gradle minimum. Eight bounded guard tests pass and
two mutations are caught. These checks establish the version policy, not an app build.

The corrected actual release and final offline `:app:assembleRelease` succeeded; the metadata
warnings are gone, and every R8 runtime keep passed. That APK was privately signed, verified,
installed and cold-started on an MI8 (Android 15 / API 35), then removed when it was identified as
the wrong phone. Its newly authorized SSH key was removed; no host was paired or SSH connection
attempted. The same beta is subsequently installed on the intended Pixel with basic manual SSH
proof, and its corrected code-3 update verifies `A85` sizing/pre-attach tmux history. These results
establish the build fix; the full phone pass stays open under `A50`.
The test-only `A84` fix passed all 606 protocol tests. The compatibility sources are linked from the guard:
[Android Kotlin support](https://developer.android.com/build/kotlin-support) and
[AGP 8.10 release notes](https://developer.android.com/build/releases/agp-8-10-0-release-notes).

## A84

**Real SSH tests inherit host login hooks and share interactive Readline state (local verification, 2026-10-02).**

- Severity: **low**; effort: small; area: tests; kind: bug
- Location: `android/protocol/src/test/kotlin/dev/nodeterm/protocol/SshTransportTest.kt`

The first restored-host full protocol run executed 605 tests: 603 passed, two real-SSH tests
failed, and none were skipped. Both failures are confirmed harness isolation faults. The literal
leading-dash test types `-R; echo sk_$((2+3))` into a login Bash pane; Fedora's PackageKit
`command_not_found_handle` delays that command beyond the assertion deadline. The earlier test
which refuses a missing SSH exit status still delivers its lone Escape byte into the shared pane.
Readline keeps that state for the next test and turns its `echo` into `cho`.

The test-only fix in `1d6b04cc` starts a fresh primary pane for each test with a non-login shell and
isolates its initialization environment. It retains real SSH/tmux execution and the literal
leading-dash and missing-exit-status assertions. Both isolation mutations were caught, the fixed
source was restored, and the final full rerun passed all 606 tests with zero failures, errors or
skips. This was not an observed phone/APK failure; production app source and the `fa71cb08` APK
build are unchanged.

## A85

**WebView WRAP_CONTENT layout parameters collapse the terminal's CSS viewport to one row (device verification, 2026-10-02).**

- Severity: **medium**; effort: small; area: terminal; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt`, `createWebView`

On the intended Pixel 10 Pro (Android 17 / API 37, Vanadium WebView `154.0.8037.92.0`), private beta
`0.1.0-beta.1` / code `2` opens a large native terminal view but advertises 52/56 columns by one
row, despite native bounds `[0,396][1280,2448]`. The one-row height persists after a font change.
Manual SSH authentication, real project
listing and a harmless command in a controlled temporary test tmux window work; swipe does not
enter copy mode or expose old history in this one-row state.

The WebView lacked explicit layout parameters, so AndroidView supplied `WRAP_CONTENT`.
[Chromium's AwLayoutSizer](https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/java/src/org/chromium/android_webview/AwLayoutSizer.java)
sets forced zero layout height from that height policy. Large measured native bounds therefore
do not establish a nonzero CSS viewport, and FitAddon clamps terminal rows to one.

The minimal fix in `febe022a` sets both layout dimensions to `MATCH_PARENT` before loading the
terminal page; CSS and JavaScript are unchanged. The real Gradle `TerminalWebViewLayoutTest`
wiring guard passes, and the height-`WRAP_CONTENT` and removed-assignment mutations are caught in a
temporary source mirror. Actual retained-signer beta `0.1.0-beta.2` / code `3` from
`febe022ad2fc373f27ac11d9ad5f130f36f027a5` passed its offline AGP build (45 seconds), signature,
alignment/provenance verification and in-place update. Its host configuration, SSH key/pin and
notification grant survived. The controlled terminal now fills 52×45, and a downward swipe enters
tmux copy mode at position 82. A screenshot visibly shows the pre-attach ready/sentinel and marker
rows 001–039 from 120 rows printed before update/attach. History is restored by the native layout
fix; no production SSH-scroll change was needed. A− restores font 13 and 56×48, the soft keyboard
changes it to 56×25, and hiding the keyboard restores 56×48. Esc leaves copy mode; a second
harmless draft command executes with its whole output line visible. The owned temporary test
window alone was removed, with the previous window/process intact and intended-phone app/key/config
retained.

**User-reported mobile check:** with WireGuard enabled and Wi-Fi off, the user confirmed that the
intended Linux host's terminal opens over mobile data. This is separate from the ADB-assisted LAN
checks above. Mobile reconnect, approvals/questions, background behavior and the full 64-item
checklist remain open.

History regressions in `d6619bf6` pass 47 focused real Gradle SSH/terminal/link tests with zero skips. Both JavaScript swipe-direction/disabled-scroll mutations, the real-SSH wheel-direction mutation and the two native layout-policy mutations were caught; production sources were restored. **Final verification:** all 609 protocol tests passed in 59 suites with zero failures, errors or skips (52 seconds); the offline app `compileKotlin` passed (7 seconds).

Checklist items 20 and 23
cover history and viewport sizing without adding or removing any of the 64 items.

## A86

**Scroll responsiveness is poor despite reachable tmux history (post-beta investigation, 2026-10-02).**

- Severity: **medium**; effort: medium; area: performance; kind: gap
- Locations: `android/app/src/main/assets/terminal/terminal.js` touch handlers,
  `TerminalController.Bridge.onScroll`, `SshHostConnection.SshStream.scroll`

The user reports slow scrolling on both Wi-Fi and mobile-data VPN after the signed-beta checkpoint
`cf0487a3`, so a VPN-only cause is not supported. History is reachable; the issue is responsiveness
and gesture behavior. The initial investigation changed no source, installed APK or phone setting.

In a bounded private MINA/SSH/tmux fixture at 52×45, 240 wheel notches over two seconds move 1195
history rows: the first notch enters copy mode and later notches move five rows each. Production
JavaScript at checkpoint `cf0487a3` emits a notch per roughly 18.2 CSS pixels at font 13 and has no fling. This amplifies
drag distance into coarse steps. A single 700-CSS-pixel movement requests 38 notches, but SSH clamps
the call to 20, losing distance.

The fixture's connected socket has TCP_NODELAY disabled. At 30/60 Hz, its output-tail measurement
is about 40.8 ms with that setting versus 1.2–1.4 ms enabled; at 120 Hz both remain around 41 ms.
Writer-queue tails stay below 0.5 ms, so this controlled loopback run shows no host writer backlog.
These results do not establish TCP_NODELAY as the sole cause. Android uses xterm's DOM renderer,
while desktop defaults to WebGL.

The actual 194452-byte, two-second SSH capture was replayed through bundled xterm's DOM renderer
in Electron 42 / Chrome 148 under Xvfb, at 426×684 CSS pixels and DPR 1. Normal `renderRows` mean
was 0.14 ms, p95 at most 0.3 ms; with JIT-less mode requested, mean was 1.5 ms and p95 at most
1.9 ms. Pending writes peaked at one and 1622 bytes, with no final backlog, unrendered output or
long tasks and a stable 60 Hz animation-frame cadence. This excludes base64/DOM queue backlog as
the primary cause at this bounded desktop load; it does not establish Pixel performance.

**Implemented mitigations (2026-10-02).** `e6bdb157` enables TCP_NODELAY on the connected SSH
socket. `245b42e6` measures row height once per gesture and accounts for stock tmux's five rows per
wheel notch, batches same-direction movement by animation frame and preserves fast-swipe distance
in ordered calls of at most 20 notches. `2c5d15a8` adds one bounded serial `TerminalActions` drain
per accepted stream; suspended relay RPCs cannot reorder reversals or input. Input cancels unsent
scrolls and follows the in-flight call; retiring the viewer clears/cancels the queue. Native raw
chips and resume writes cancel page scrolling first, and callbacks remain bound to their accepted
stream. `40c4ee49` also cancels scrolling immediately before the delayed paste Enter. No host verb,
payload or SSH-visible file contract changed; this fix needs no iOS payload/interop fixture change.

The full restored-source protocol suite passed **638 tests in 61 suites**, with zero failures,
errors or skips (51 seconds); the final offline app `compileKotlin` passed (7 seconds). **30 mutations** were
caught: two SSH socket-policy, fourteen JavaScript gesture/input and fourteen actor/native-wiring
mutations. Private beta `0.1.0-beta.3` / code `4` from
`40c4ee49592e2f92fc7e6e9b548ba88a33b1e2d3` built locally in 49 seconds, passed every R8 keep
and retained-signer packaging; signature, source/hash provenance and alignment were verified, with
all 149 ZIP payloads unchanged by signing. Its in-place update on the intended Pixel succeeded,
preserving manual SSH registration/key/pin and notification permission. Push is
user-authorized and each requested push requires green Android workflow verification; no PR is
requested and `A68` remains deferred.

**Controlled Pixel proof.** The updated app reopens the intended Linux host over SSH and the owned
test terminal fills 56×48. Five identical downward swipes of 1000 native pixels over 350 ms produced
history positions 25, 40, 55, 70, 85 on beta 2, versus 5, 10, 15, 20, 25 on beta 3. Reversal moved
25 to 20; the actual Esc chip left copy mode (`pane_in_mode=0`). A screenshot records the controlled
test history. The phone returned to Sessions and refreshed; only the owned test session was removed,
with user panes untouched. These establish reduced drag gain, reversal and input cancellation, not smoother
rendering. Isolated `gfxinfo` samples contained only 11/12 frames and 5/6 janky frames respectively;
they establish no FPS improvement and are not a WebView renderer trace.

**Superseding user failure and next correction.** The user reports that beta 3 still has both lag
and too little movement on Wi-Fi and mobile-data VPN. Its controlled mechanical results above do
not establish satisfactory responsiveness. `A87` fixes report-triggered cancellation and restores
one measured row per notch, keeping frame batching, lossless ordered chunks, lifecycle barriers and
TCP_NODELAY. All 646 protocol tests in 62 suites pass with zero failures/errors/skips, and offline
app `compileKotlin` passes (8 seconds); 22 JavaScript and nine actor/native-wiring mutations are caught.
Code-5 beta built/signed and updated in place; user feel remained open at that checkpoint.
The beta-6 verification below now resolves the primary drag/coast complaint.

**Controlled beta-3 phone trace.** Twelve alternating gestures in an owned 56×48 dummy-history
terminal produce one JavaBridge invocation per gesture, 24 RAF callback collections and 11 distinct
presented pipelines. First invocation is 84–90 ms after touchstart; first presentation 170–196 ms is
correlation without an input→SSH→render flow. Presented Chromium scroll events measure 36–56 ms;
>1-second aggregate EventLatency mainly counts no-paint termination. No named JS/native methods or
scheduler/V8 measurements exist, and some newer extension fields are unparsed. Sparse FrameTimeline
and non-damaging ScrollJank events establish no terminal FPS/jank rate or renderer cause. These
measurements support comparing delivered updates after the correction, not blaming JIT or claiming
a one-second paint. No RTT emulation has run.

The matching beta-4 trace records 42 bridge invocations versus 12, 26 content commits versus 12,
and 25 distinct presentations versus 11 over twelve gestures. First invocations occur at 25–36 ms
versus 84–90 ms; this supports more frequent delivered updates, without establishing terminal FPS
or end-to-end SSH latency. Both traces and queries are retained in the private beta-4 evidence.

**Beta-4 user feedback and bounded fling correction.** The user reports that beta 4 moves more
lines but lacks momentum after finger lift. `1ad2e944` adds a velocity fling sampled over 120 ms,
released within 80 ms of recent movement at 0.45–3 CSS pixels/ms. Exponential decay uses a
240-ms constant, stops at 0.06 pixels/ms, and has hard 1000-ms/1200-pixel caps. Existing calls
carry at most 20 notches; frame gaps over 250 ms stop movement. `53462f96` adds `onScrollStop`
for new touch/input/reset/font/lifecycle barriers without typing into the pane. Queued keys/replies
and the in-flight operation survive; bytes already handed to SSH's writer/network cannot be recalled.
Automatic xterm reports preserve coast. No host/payload/SSH-file contract or iOS fixture changed.

All 658 protocol tests in 63 suites pass with zero failures/errors/skips (59 seconds), plus offline
app `compileKotlin` (10 seconds). Thirty-five JS and eleven new native mutations were caught;
seven strengthened kinetic tests and real bundled-xterm coast/report behavior pass. Private
`0.1.0-beta.5` / code `6` uses source `1ad2e94455a7adfb85d41212b12d36df39695324`; actual AGP
release built in 47 seconds and passed every R8 keep. Retained-signer packaging verifies metadata,
signature, 16-KB alignment and source/hash provenance. APK SHA-256:
`7cc68d384aeb21ab40800fa7c83f006dfbfefba16dd2e945967c8c5376f17655`.
It updated the intended Pixel in place with code-6/non-debuggable metadata and notification
permission confirmed. The user still reports continuous swiping stops and requires lifting; the
controlled test shows no coast after command completion. `A89` records the detached target cause
and stable-screen fix. Beta-6 build/sign/update and SSH reopening with retained key/pin pass.
Controlled Pixel continuous dragging, post-command coast and Esc stopping now pass; a held
touch also stops coast at a stable 56×25 viewport (see `A89`).

The user confirms normal continuous dragging and coast “Both work now”, resolving the primary
complaint. Separately, the user's final beta-6 cellular WireGuard SSH check confirms connection
and smooth scrolling.
**Still open:** reversal/lifecycle, custom wheel bindings and FPS.
Earlier new-touch checks opened the IME and resized tmux, so those results were inconclusive.
Custom tmux wheel bindings and FPS remain open. Existing checklist item 20 covers these checks;
the checklist remains 64 items.

## A87

**Automatic xterm reports cancel a swipe and discard queued movement (2026-10-02).**

- Severity: **medium**; effort: medium; area: runtime; kind: bug
- Locations: `android/app/src/main/assets/terminal/terminal.js` input handlers,
  `TerminalController.Bridge`, `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/TerminalActions.kt`

The installed beta-3 page treats every xterm `onData` event as user input. xterm also emits focus,
mouse and terminal-query replies on that event. `cancelScroll()` clears the page queue and the
active touch position; native `TerminalActions.write()` drops unsent movement. A report during a
gesture therefore stops its subsequent moves, despite no user key or paste. The pinned xterm 5.5
CoreService marks keyboard/paste/IME input before `onData`, but also marks SGR mouse reports as
user input; using that flag alone still misclassifies mouse reports.

**Fix:** `3cffb49d` consumes the pinned input-origin event once, excludes full SGR mouse reports,
and routes automatic `onData` and legacy `onBinary` replies through `Bridge.onReport`. The bridge
captures its accepted stream and checks the page generation. `TerminalActions.report()` uses the
same bounded FIFO and serial drain while preserving pending scroll distance/direction; ordinary
user `write()` retains its cancellation barrier. Report errors do not retry or discard following
movement. Keys, paste and IME input still cancel scrolling. Gesture gain returns to one measured
text row per wheel notch; ordered frame batching, lossless 20-notch chunks, lifecycle retirement,
SSH TCP_NODELAY and delayed-Enter cancellation remain.

Real bundled xterm/Fit/page regressions exercise touch, focus, SGR/legacy mouse, query replies,
keyboard, paste and IME. Actor regressions cover reports between suspended chunks/reversals,
user-input barriers, shared bounds and non-retryable report errors; source pins verify generation,
stream identity, snapshot ordering, JavascriptInterface and no Ctrl transformation. All 646 protocol
tests in 62 suites pass with zero failures, errors or skips; offline app `compileKotlin` passes (8 seconds).
Twenty-two JS and nine actor/native-wiring mutations were caught. This proves the routing/queue
policy, not corrected phone feel; beta-4 delivery and controlled movement pass below. At that
checkpoint user follow-up remained open; the later beta-6 drag/coast confirmation is under `A89`.

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
These verify delivered movement/order/cancellation, not terminal FPS or satisfactory user feel;
at that checkpoint corrected-beta user follow-up remained open under `A86`; beta 6 now has
normal drag/coast confirmation.

**Residual:** a direct xterm/browser unbracketed user paste whose entire content exactly matches
an SGR mouse report can still take the automatic-report path. The native draft submission now
cancels JS/native scrolling before paste (`53462f96`/`1ad2e944`). Recheck this edge if the input-origin adapter changes.
No host verb, payload, mirror or SSH-visible file contract changed, so iOS owes no payload fixture
update for this fix. Revalidate the pinned internal xterm input-origin adapter on a bundle upgrade.

## A88

**New SDK signer labels reject a correctly signed private-beta artifact (2026-10-02).**

- Severity: **medium**; effort: small; area: tooling; kind: bug
- Locations: `android/tools/package-beta.py` `verified_signer`/signing command,
  `test_beta_signer.py`, `test_package_beta.py`, `test_beta_sdk.py`

The original verifier assumes one `Signer #1 certificate SHA-256 digest` line. `fed68fb3`
added strict SDK-range labels and explicit v2 signing, with 32 local tests and ten mutations.
CI run `37058184031` at `9ced6781` still failed five of 32 private-packaging tests at the same
signer/v2 gate; protocol, debug, release and CodeQL passed. The runner image includes SDK 37,
and the old fixture chose its highest lexical tools/platform instead of the installed SDK 36/35.
The raw CI verifier report was not captured. A local reproduction with official SDK 37 now
confirms a real format discrepancy: verification exits 0, v2 is true and there is one signer,
but its certificate label is `V3.0 Signer:`. The earlier range-only hypothesis did not cover it.

**SDK-37 follow-up (`f5fd3821`):** accept exact `V2 Signer:`/`V3.0 Signer:` single labels with a required
`Number of signers: 1`, and exact V3.0/V3.1 SDK-range labels with the existing one-certificate,
non-overlapping-range policy. Older indexed/range reports remain supported. Consider every APK
signer certificate line except source stamps; reject duplicate or conflicting certificates and
unknown/V3.2 hybrid classical/PQC identities rather than silently ignoring them. The expected certificate pin and
verified v2 gate are unchanged; signing explicitly enables v2. Fixtures now require the explicitly
installed SDK 36/platform 35, with exact reproduction overrides, and signature-gate failures
include safe verifier diagnostics from a disposable test key/APK only.

All 39 Python tests pass against each real SDK 36/37; six new parser and four fixture-selection
mutants are caught. Removing the single-label support also kills the actual SDK-37 acceptance
fixture. Proof/logs are in `.nodeterm/android-beta-build-4/ci-verification/` (working evidence:
`/tmp/nodeterm-beta4-ci-check/`). Follow-up [run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming
observed CI repair. Each subsequent push still needs its own green workflow. Local reproduction
establishes the SDK-37 bug, not captured output from the original failed job.
No private key, APK, app code or phone setting changed from this tooling correction.


## A89

**Repaint detaches the touched text span and loses continued drag/release events (2026-10-02).**

- Severity: **medium**; effort: small; area: runtime; kind: bug
- Locations: `android/app/src/main/assets/terminal/index.html` terminal CSS,
  xterm DOM renderer row spans, `TerminalJsXtermInteractionTest`

The user reports that beta 5 stops during continuous swiping and only moves again after lifting.
The intended Pixel's controlled gesture updates history 0→15 at 369 ms, 25 at 391 ms and 30 at
412 ms, then remains fixed through 1.4 seconds after the ADB swipe command completes at 561 ms.
That is command completion, not a measured physical touchend timestamp. There is no verified coast.
The real bundled DOM renderer replaces row text spans during a redraw, detaching the element
that received touchstart. Later touchmove/touchend still target that detached span and no longer
bubble to the live page handlers. Tests dispatching events directly on the terminal host missed
this target-lifetime failure.

**Fix (`c4b1f6cf`):** set `.xterm-screen { touch-action: none; }` and
`.xterm-rows, .xterm-rows * { pointer-events: none; }`. Hit testing chooses the stable screen
behind painted text, keeping later move/end events connected across redraws. Existing fling,
ordered 20-notch batching, automatic-report routing and native stop/input/lifecycle barriers remain.

The actual bundled-xterm regression verifies the old span is removed, subsequent events on it
lose the live handler, and computed production CSS instead targets the connected screen so
continued movement and release coast survive a real redraw (24 notches versus one). A real
Electron 42.11.3 / Chromium 148.0.7778.280 probe of the shipped page confirms `elementFromPoint`
hits the stable connected screen across redraws; original CSS hits the detached span. This closes
the jsdom hit-test limitation for desktop Chromium, not actual Pixel touch behavior. All 658
protocol tests in 63 suites pass with zero failures/errors/skips (67 seconds), plus offline app
`compileKotlin` (8 seconds). Three CSS mutations are caught alongside 35 JS and eleven native
mutations. Private `0.1.0-beta.6` / code `7` uses source `c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6`;
actual AGP release built in 43 seconds and passed every R8 keep. Retained-signer packaging verifies
metadata/signature/16-KB alignment/source hashes and preserves all 149 payloads. APK SHA-256:
`4947133a6ccf9c2b1e775e76d7c24f564e087cf036e59eac4dca08162a076d3c`.
The intended Pixel received a same-signer update preserving app data; notification permission
is confirmed. SSH reopened with the retained key/pin at 56×48. A 1000-native-pixel/1200-ms swipe
produced 23 observed positions from 0 to 110 over about 1103 ms (ADB command complete at
1535 ms). A 1000-pixel/200-ms swipe reached 110 at command completion (540.5 ms), then 250 at
1339 ms, about 799 ms later, with 29 observed updates overall. Continuous drag delivery and
post-command coast pass. Esc during coast left copy mode and remained out for 1.4 seconds.
New-touch stopping also passes with the keyboard already open and all sampled viewports at
56×25. After a 500-native-pixel/100-ms swipe, the DOWN command completed 152 ms after the swipe
command; the script then waited 1.2 seconds before issuing CANCEL. The last position change was at 503.6 ms, before DOWN completed at
588.8 ms; final position 100 remained unchanged through CANCEL. Earlier IME-resizing tap/DOWN
checks rebased tmux positions and were inconclusive, not additional failures. Evidence includes
`beta6-stable-viewport-touch-stop.json` and `stable-touch-check.log` in the private beta-6 proof.
Esc and Header Back then returned to Sessions and detached the owned client; only its exact
owned tmux session and phone UI XML were removed. Private evidence, including
`device-summary.json`, is in `.nodeterm/android-beta-build-6/` and `.nodeterm/android-beta-6/`.
No host verb, payload, mirror or SSH-visible file contract changed; no iOS fixture change is owed.
The user confirms normal continuous dragging and coast both work now. Reversal/lifecycle,
custom wheel bindings, FPS and the full device pass remain open. The user confirms final beta-6
connection and smooth scrolling on cellular WireGuard with Wi-Fi off over regular manual SSH;
cellular hosted relay remains untested.


## A90

**Manual SSH/WireGuard host cannot create a new plain terminal without a local desktop/relay (2026-10-03).**

- Severity: **medium**; effort: medium; area: parity; kind: gap
- Status: **implemented and host-verified** in `bcc92367` / `b88d1415`; beta 10/code 11 installed.
  Focused physical plain-SSH and beta 10 relay plain-shell creation/input/exact End pass;
  item 32 stays Partial for managed/cellular variants.
  The separate A91 otherwise-empty-host flow passes on beta 9 Oct4.
- Locations: Android Host screen/new-terminal choice, SSH scripts/connection and host listing

The user can browse and open existing sessions on their Linux host over manual SSH/WireGuard,
but cannot create a new shell. Another desktop drives that host's `nodeterm-rmt` sessions and
project files; the host has no own workspace or relay. `A26`'s canvas New-session flow still
requires `projects.registerNode` on the owning desktop, so it cannot serve this request.

**Implemented design:** explicitly create a plain shell on the separate `nodeterm-phone` socket
in a discovered host folder or Home. Creation marker/session metadata rediscover it under a
synthetic **Phone terminals** group; the shell survives disconnect and End addresses only its
exact owned session. Clear inherited nodeterm identities before starting the shell, and configure
only this socket for the terminal's mouse/history/UTF-8 behavior. Do not modify shared project
files, borrow an existing node's hook token or claim desktop-canvas registration. Desktop and
Server Edition keep scanning/reaping their own `node-terminal` / `nodeterm-rmt` sockets.

The `A08` refusal to create a missing managed/canvas session and existing relay New session stay
intact. No current host RPC, projects blob, pairing payload, mirror or SSH-visible file contract
changes. **iOS follow-up for @eneskirca:** consider the isolated phone socket, explicit creation
marker and session metadata rather than a canvas append for this independent-shell feature.

Atomic ID/resolved-cwd/request/fingerprint session environment allows rediscovery even if creation
stops before option finalization. The parser verifies the request's SHA-256, and actions pin the
validated fingerprint before checking live ownership. Reserved phone UUIDs never attach to either
desktop socket or send a creating relay RPC. Same-ID/folder retries retain a shell after directory
rename. New panes clear inherited managed identities and warm non-UTF-8 overrides; partial attach
restores phone-only settings. Host-owned creation survives dismissal/background, and Main
navigation checks the visible screen/ticket before opening.

**Verification:** the full real protocol suite passes **684 tests / 66 suites**, zero
failures/errors/skips, in 48 seconds; final offline app `compileKotlin` passes in 1 second.
Nine new real SSH/tmux methods, four pure phone-metadata tests and a relay interop refusal cover
creation/folders, quoting/idempotency, interrupted discovery, reconnect/history/End, stale/foreign
ownership, warm environment and reserved socket IDs; helper/wiring regressions cover UI lifecycle.
All **32 new mutants are caught**: eleven actual Gradle/Kotlin 2.2 protocol behavioral variants,
twelve helper behavior variants and nine native wiring variants. These are host/fixture results,
not physical phone results.

Historical `0.1.0-beta.8` / code `9`, clean source `b88d141528c1051964da07faf22cc7fa923c4846`, was
**installed on the intended Pixel, now superseded by beta 9**. The actual offline AGP release builds in 49 seconds; R8 keeps,
retained-signer packaging, 16-KB alignment and source/hash provenance pass. Independent SDK 36/37
tools verify v2/v3 signatures and one retained signer, all 149 unsigned payloads are byte-preserved
with three signing entries added, all four ELF PT_LOAD alignments pass, and R8/service mapping
agrees with the source/version/hash/build inputs. Terminal assets/native libraries are unchanged
from beta 6. APK SHA-256:
`d373ad5c1790f714cb4464ad4a0a38c5ba9ab68e35103e54cf3aef5ce53081ce`.
Private artifact/proof are in `.nodeterm/android-beta-8/` and `.nodeterm/android-beta-build-8/`.

The 28.05-second exact-Pixel same-signer update verifies matching pre/post APK hashes and signer,
code 9/name beta 8/non-debuggable metadata, retained install identity/notification grant and an
existing manual-SSH host row. Receipt: `.nodeterm/android-beta-build-8/device-install-20261003/receipt.json`.
The existing host reconnects over SSH and lists real driven projects; New terminal is visually
present and its FAB is enabled/clickable in own-app UI XML. No existing pane was touched and no
terminal was created or ended. This is installation/reconnect/browse/UI-availability proof, not
Create/cwd/history/reconnect/End or TalkBack proof. Historical beta-6/code-7
device evidence and prepared unused beta 7 / code 8 are preserved; at that installation checkpoint
the ledger remained seven Pass /
20 Partial / 37 Pending. After the hike, pair on current beta 9 then use a later same-signer
higher-code update for item 1, keeping the working app installed. For item 32 use Linux host →
Sessions → New terminal → Home/project/custom absolute folder → Create; verify real cwd/input/history,
disconnect/app-restart rediscovery and exact owned End on the intended Pixel over SSH/WireGuard.
Existing desktop sessions, project files and canvas must remain unchanged. Full relay/managed-agent
creation and the rest of the 64-item matrix remain separate pending requirements.

**Completed focused Pixel proof:** beta 8/code 9 creates Home, discovered-project and custom-folder
shells with verified cwd/input, pre-attach history, drag/coast/Esc, no duplicate from rapid double
Create and visible missing-folder error/corrected retry without an orphan. Force-stop/restart
retains three shell PIDs/history and SSH rediscovery. Beta9/code10 update, reconnect and same-pane
native input pass. Native UI End of custom→project→Home removes exactly each selected UUID,
retains sibling immutable fingerprints/PIDs, changes counts 3→2→1→0 and removes the final Phone
terminals group. Eleven desktop session IDs/pane PIDs and nine protected project/workspace hashes
are unchanged. Owned shells, empty fixture folders and UI dumps are removed; the phone returns
to regular host Sessions. Proof:
`.nodeterm/android-beta-build-8/a90-pixel-check-20261003/final-focused-results.json` and
`beta9-exact-ui-end.json`. Only item 32 is promoted to Partial: current **7 Pass /21 Partial /36 Pending**.
The Oct3 proof does not verify relay canvas/managed or cellular creation or the full checklist.
The separate A91 otherwise-empty-host last-End variant passes on beta 9 Oct4 below. The isolated bare-Esc/paste contamination was a QA input
artifact, and clean native input passed; it did not produce a paste finding.

## A91

**Ending the last phone shell on an otherwise empty SSH host leaves its cached row visible (2026-10-03).**

- Severity: **medium**; effort: small; area: runtime; kind: bug
- Status: **fixed in `4d33a5b5`, delivered in installed beta 9/code 10**.
  The physical otherwise-empty-host flow passes on beta9 Oct4; A94 is delivered in beta 10 with its full focused empty-host flow passed.
- Locations: `android/app/src/main/kotlin/dev/nodeterm/android/conn/ConnectionManager.kt`
  (`HostSession.refreshNow`), `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/ListingFailure.kt`

When the last phone-owned shell is ended and the SSH host has no workspace, driven sessions or
other phone shells, browse throws `NothingFoundException`. The session has ended, but native
refresh previously kept the last successful snapshot, so Sessions still showed its row. A lost
reply or host refusal cannot prove nodes are gone; blindly clearing every failed listing would
also discard useful cached rows during an outage.

**Fix:** `ListingFailure.snapshot` returns `ProjectsSnapshot.EMPTY` only for the authoritative
`NothingFoundException`; generic host/transport failures retain the previous snapshot, and
cancellation rethrows before replacement. `ConnectionManager` applies the policy while preserving
the route-specific error and existing connection rules. The authoritative empty answer leaves
SSH connected and New terminal available. No current RPC, projects blob, pairing, mirror or
SSH-visible file contract changes.

**Verification:** four `ListingFailureTest` methods use an actual parsed phone listing to verify
last-row removal, generic-error retention, cancellation identity and native error/connection
wiring. Full real Gradle protocol passes **688 tests / 67 suites**, zero failures/errors/skips,
in 52 seconds; offline app `compileKotlin` passes in 6 seconds. All six isolated Kotlin 2.2/JDK 21
mutants are caught, and independent review finds no blocker. Ignored XML/mutation proof is in
`.nodeterm/android-beta-build-9/`.

**Physical otherwise-empty-host pass (2026-10-04):** installed beta 9/code 10 creates and opens
its first Home shell through New terminal. Native End removes the exact row and Phone terminals
group while SSH stays connected. New terminal remains usable and creates/opens a second Home
shell. That second shell was retained for the beta 10 update and subsequently ended in the full
A91/A94 flow below; final fixture/service cleanup is not yet claimed. Proof:
`.nodeterm/android-beta-build-9/checklist-20261004/a91-beta9-focused-results.json` plus UI receipts.
This closes A91's focused empty-host physical variant. Item 32 stays Partial and the ledger stays
At that checkpoint7 Pass /21 Partial /36 Pending because relay/managed and cellular creation remain open;
later paired-update and item 36 Board verification bring the current tally to 10 Pass / 22 Partial / 32 Pending.
A94's separate false Loading label was observed; beta 10 delivers the correction and its full installed End/recreate/open/End completed-empty flow passes.

Private beta `0.1.0-beta.9` / code `10`, clean source
`4d33a5b5366c99479b648086649205350c7752b1`, built in 43 seconds and updated the exact intended
Pixel with the retained signer in 6.46 seconds. Its pulled installed APK matches SHA-256
`719cfeea1dcf27900dd35692a59004ca07e8261b3f14bd43922f0706b6b4ab54`.
Three owned beta-8 shells survived and were rediscovered after updating, then all were ended
through verified exact-session cleanup. Historical source CI run
`37144282865` failed the device-checklist documentation mapping; debug/release APK and CodeQL
passed, private packaging was skipped. Recorded prior all-green branch is `19da35a2`, all five jobs in
run `37140762345`; the next push needs its own checks/green workflow.
This revision adds the A91 item 32 mapping and isolates its Known gaps paragraph, without
weakening the test. The recorded local 688/67 source baseline predates the final documentation;
fresh full protocol/offline app gates follow the frozen docs and exact-head CI proof is retained
separately after the next push.
Independent SDK 36/37 review verifies signature/alignment, all 149 unsigned payloads preserved,
four ELF alignments, expected R8/service metadata and source/hash provenance. The non-debuggable
installation preserves install identity, notification grant and app data; pairing/relay credential
survival is not proved. Receipts: `.nodeterm/android-beta-build-9/artifact-review.json` and
`.nodeterm/android-beta-build-9/device-install-20261003/receipt.json`; private APK:
`.nodeterm/android-beta-9/nodeterm-android-0.1.0-beta.9.apk`.

## A92

**Desktop/Server link lookup can exclude the hovered row after a long wrapped run (2026-10-04).**

- Severity: **low**; effort: small; area: desktop renderer; kind: bug
- Status: **fixed in `127b6b28`**. Interactive desktop hover has not been exercised.
- Locations: `src/renderer/terminal/file-links.ts` (`paragraphContaining`) and `file-links.test.ts`

This was the desktop follow-up recorded while fixing Android `A32`. The exported helper walks up
as many as 32 continuing rows, then joins at most 32 rows downward. Hovering row 32 or later in
a full-width run can therefore return a paragraph ending before the requested row. URL lookup
on a tail row can offer only `https://x` instead of the complete `https://x.io/a`.

**Fix:** reserve the requested row by limiting the upward walk to `MAX_JOIN_ROWS - 1`, retaining
the 32-row total budget. This affects the shared Desktop/Server renderer only. Android's
`terminal.js` already has the corresponding `A32` fix; no Android APK change, host-service verb,
projects blob, pairing payload, mirror or SSH-visible file change is involved, and no iOS
adoption is owed.

**Verification:** the 24-test focused Vitest file passes, including exhaustive containment/text
checks for every row in 80-row hard/soft wrapped runs and actual URL-provider range/activation on
a tail row beyond the cap. All 54 tests across the three affected link/dialect files and the full
`npm run typecheck` pass. Three isolated production-copy mutants are caught: restore the old
upward bound, expand the total budget, or omit the hovered tail from the downward window.
Control and restored copies pass. Private evidence: `/tmp/nodeterm-file-link-fix-verify/results.json`
and per-variant logs. No active source was changed for mutation runs; desktop `out/` remains the
previous `071735d6` build while the isolated production pairing fixture runs. Android's installed
beta 9 and the 7 Pass / 21 Partial / 36 Pending ledger are unchanged; no new phone results are claimed.

## A93

**Fresh-desktop remote-on pairing succeeds without relay credentials (2026-10-04).**

- Severity: **medium**; effort: medium; area: pairing/hosted relay; kind: interop/backend
- Status: **open**. A backend refusal is confirmed; its recovery policy and a repair are unverified.
- Locations: src/main/pairing-service.ts (mintRelayDevice and the direct-SSH pairing branch),
  android/app/src/main/kotlin/dev/nodeterm/android/ui/PairScreen.kt (previous token lookup),
  and the external hosted /v1/relay/device endpoint.

**Observed:** the intended Pixel, still on private beta 9/code 10, accepted genuine pairing JSON
from a fresh isolated production desktop with remote access on. Local pairing succeeded, but
the saved host received no relay credential. A bounded retry using the same request body as production
mint returned HTTP 403 with error reauth_required. No backend repository was read or changed.

**Relevant state:** the previous owned fixture had been forgotten on the phone, removing its
saved relay token while preserving the global phone identity. The fresh desktop has a different
device/host-key identity. Android looks for a prior token by the pairing's host key; production
desktop code forwards it when supplied, and carries its own normal device id. These facts
suggest a backend re-registration/C2 constraint, but do not establish the backend's exact rule.

For a direct-SSH desktop, production pairing deliberately retains its working SSH registration
when relay mint fails. That explains local success; it does not establish working “from anywhere”
access or complete checklist items 8/12/17. Historical beta-6 hosted-relay proof remains valid.
No phone identity reset, individual desktop identity/token copying or user-secret import was
performed. Ordinary restart/re-pairing of the complete original owned fixture profile now
succeeds, preserving host/device identity and issuing actual relay credentials on beta 9.
After the retained-signer code10→11 update, beta 10 reconnects through the saved relay pairing,
opens the owned terminal and sends input to its real scoped PTY. An anchored SSH refusal warning
remains before AUTO relay fallback; this does not claim OnlyRelay preference survival. This verifies one legitimate
same-desktop recovery case, not the backend's full C2 policy or fresh-different-desktop repair.
**iOS implication for @eneskirca:** check prior-token lookup and recovery messaging when Forget
removes a relay token but persistent phone identity remains. No new external field/fixture
change is introduced by this finding.
New private evidence belongs in .nodeterm/android-beta-build-9/checklist-20261004/.
Item 1 paired-update and item 36 rebuilt-Board verification pass; item 35 stays Partial, giving current 10 Pass / 22 Partial / 32 Pending.

## A94

**Completed empty SSH listings still show “Loading sessions…” (2026-10-04).**

- Severity: **medium**; effort: small; area: native Sessions state; kind: runtime bug
- Status: **fixed in 3c217cba; delivered in beta10/code11**. Five actual Kotlin regression
  methods/eight isolated mutants and full Gradle 689/67 zero failures/errors/skips pass;
  the full installed End/recreate/open/End completed-empty flow passes.
- Locations: android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/ListingFailure.kt,
  ListingFailureTest.kt and android/app/src/main/kotlin/dev/nodeterm/android/ui/SessionsTab.kt.

**Physical failure:** the intended Pixel's beta 9 finishes listing the otherwise-empty private
OpenSSH fixture and shows the completed error banner, Over SSH and an available New terminal.
Its Sessions content nevertheless keeps “Loading sessions…”. Private before-fix proof:
.nodeterm/android-beta-build-9/checklist-20261004/a91-initial-empty.json and .png.

A91 correctly replaces stale rows after NothingFoundException, but used ProjectsSnapshot.EMPTY
with fetchedAt=0, the marker for a first listing still pending. SessionsTab chooses its loading
label from that timestamp. The fix stamps this authoritative empty answer with its completion
time, retaining cancellation and the prior uncertain-failure cache/route/error behavior.
No external host-service, pairing, mirror or SSH-file contract changed; no iOS adoption is owed.
The clean e3ce041c snapshot builds private beta10/code11 in 52.4 seconds; R8 keeps and independent
SDK36/37 artifact review pass. The retained-signer update is installed on the intended Pixel,
with matching SHA-256 04ace0ea01540bb477fcf823395a299fa211cfef3745aa28674099038ceb3693,
install identity/notification grant and the owned SSH pane preserved. Full protocol passes 689
tests/67 suites with zero failures/errors/skips (86.08 seconds wall time including a new daemon),
offline app compile passes in 6.78 seconds. The exact built source `e3ce041c` has all five CI jobs green in [run `37194375778`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37194375778). Each later documentation push needs its own green workflow. The installed full End/recreate/open/End completed-empty flow passes.
Beta9 A91 last-End/recreate proof remains separate. No item 32 promotion follows.
Item 1 paired-update and item 36 Board verification pass, giving 10 Pass / 22 Partial / 32 Pending.

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


## A95

**Phone Board move and label persist but the mounted desktop Board remains stale (2026-10-04).**

- Severity: **medium**; effort: small; area: desktop/phone interop; kind: runtime bug
- Status: **fixed in `ec12ea9a`; rebuilt production desktop physical verification passes**.
  Actual beta 10 phone move/remove/re-add/create-label checks complete item 36; Android APK is unchanged.
- Locations: `src/core/workspace-store.ts` (`kanbanWriteNow`/`announceProjectFile`),
  `src/renderer/canvas/Canvas.tsx` (`onExternalChange`/`onServerChange`), Desktop
  `src/preload/index.ts` (`workspace.onServerChange`) and the mounted
  `src/renderer/components/kanban/KanbanView.tsx`.

**Observed:** on the installed beta10/code11 Pixel, the phone's Board moves its owned
relay-created plain shell to In Progress. Its card moves and the actual persisted project
board assigns that exact node to the In Progress column. The already mounted desktop Board
still places it in Ungrouped at two snapshots approximately 60 seconds apart, with unchanged
page time origin and no reload. A new blue label is also created and applied through the phone: persisted metadata and the
mobile card have it, while the mounted desktop still has no labels. The same view had already
picked up phone New-session node
creation and Rename, so those successes do not prove board propagation. The production desktop
was the held `071735d6` build; Android uses the clean beta 10 snapshot `e3ce041c`. Those commits have
identical relevant core/Canvas/Board code. Source tracing confirms `announceProjectFile` sends
this core-owned Board write as `workspaceExternalChange`. The active dirty canvas classifies
changed kanban metadata as a conflict and does not replace the projects-store Board; its conflict
strip is under the Board overlay. The existing `onServerChange` path already applies core-owned
updates while preserving live Flow state. Desktop's actual preload had deliberately made
`workspace.onServerChange` a no-op under the old server-only assumption. A core-channel-only
change would repair Server Edition but leave Desktop unaffected. Commit `ec12ea9a` includes
both the existing server-change announcement and real Desktop IPC subscription with unsubscribe.
The same owned paired profile was then restarted with the repaired production `ec12ea9a` build;
the actual no-reload phone/desktop move/add/remove/create-label checks below pass.

**Source verification:** nine affected Vitest suites (133 tests), full `npm run typecheck` and
strict TypeScript checking of the acceptance test pass. Four isolated source mutants are caught,
including the original Desktop preload no-op. `src/core/workspace-store.kanban.test.ts` verifies
the own-write channel; `src/preload/index.test.ts` verifies payload delivery, channel separation
and exact unsubscribe. `test/acceptance/phone-board-updates.test.ts` uses the actual Desktop preload
and Server WebSocket adapters, production change planners and mounted real `KanbanView` for local
and SSH projects, including default Board seeding and preservation of unsaved canvas movement on
the next ordinary save. This does not replace physical rebuilt-desktop verification.

**Private evidence:** the owned fixture's proof directory contains
`release-qa-board-snapshot-1791110071897978622-f0b5c9.json` (persisted In Progress) and
`release-qa-board-dom-1791110071897952231-481e0f.json` plus
`release-qa-board-dom-1791110131369275364-a2e18b.json` (mounted Ungrouped, matchesPersisted=false,
same page time origin). Native mobile proof is in
`.nodeterm/android-beta-build-9/checklist-20261004/beta10-board-after-move-portrait` UI receipts.
These observations preserve the original held-build failure separately from the repaired result.

**Rebuilt physical verification:** the actual beta 10 phone moves the owned card to Ungrouped,
removes its blue label, re-adds that label, and creates/applies a second blue label. Each action
updates persisted state and the already mounted production desktop Board. Baseline
`release-qa-board-dom-1791111329350981266-9c35ac.json` and resulting DOM receipts
`release-qa-board-dom-1791111393296743731-3f0e0a.json`,
`release-qa-board-dom-1791111472591205070-dde430.json` and
`release-qa-board-dom-1791111663350183645-51ca7c.json` all match persisted state and share page time
origin `1791111312961.1`; no reload is performed. Matching native result/UI receipts are
`beta10-a95-rebuilt-first-move-result.json`, `beta10-a95-label-removal-result.json` and
`beta10-a95-label-readd-create-result.json` under the Oct4 checklist directory. This completes
item 36. Including item 49 Settings evidence, the current tally is 10 Pass / 22 Partial / 32 Pending. It verifies the owned production fixture,
without deployment to the user's regular desktop or a new Android APK.
Exact phone End also removes the adopted card from the mounted Board with the same page origin
and matching persisted state (`release-qa-board-dom-1791111853036062170-ed2205.json`); the original
producer terminal is preserved. This does not complete Wake/Refresh repaint checks in item 35.
This is an existing remote-action behavior shared by phone clients; @eneskirca should verify
iOS-triggered board changes after the repair. No external verb, payload or project-file format changes.

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

**Phone system-theme compatibility passes (item 51, 2026-10-04).** On the installed beta 10
Pixel, Computers and Settings native screens remain readable under system dark and light modes,
including status/navigation bars; four captured PNGs have a matching visual-review receipt.
The app retains its fixed dark palette in both modes; an automatic light app palette is not claimed.
Original system night mode `yes` is restored and verified. Tablet/foldable is conditional SKIP
because neither is available. Proof: `beta10-system-theme-result.json`,
`beta10-system-theme-restored.json` and `beta10-system-theme-visual-review.json` in the Oct4 checklist
directory. Item 51 passes, giving the current 10 Pass / 22 Partial / 32 Pending ledger.

**Final phone cleanup and background watch remain pending (2026-10-04).** The intended Pixel's
wireless ADB endpoint is no longer reachable; its current endpoint has been requested. The guard
refused before the final phone Forget and portrait-lock restoration, so neither action is claimed.
Earlier rotation restoration belongs to the first test round; current final restoration is pending.
The isolated empty SSH service is stopped. Phone name/API and system night mode `yes` restoration
are verified. No natural-periodic background Done watch has started and no result is claimed.
The remaining phone cleanup and notification checks can continue when the correct Pixel returns.

## A96

**Sessions have no local search (2026-10-04).**

- Severity: **low**; effort: small; area: phone UX; kind: feature gap
- Status: **fixed in `f73633fb`; full candidate-source checks pass, physical follow-up pending**.
- Locations: `SessionsTab.kt`, protocol `model/SessionSearch.kt` and `SessionSearchTest.kt`.

**Before:** the installed beta 10 source `e3ce041c` lists every open project's sessions in status
buckets; finding a named session or folder requires scrolling. There is no query field or filter.
**Implementation:** a native Search sessions field uses trimmed, case-insensitive literal matching
against the displayed session name, visible agent label, project name/folder and node folder.
Project matches retain the group; session matches retain only those original rows. Project order,
status buckets, actions and the unavailable-New-session note remain intact. Loading, a completed
empty host and no search matches have distinct labels. The host/tab's existing A43 saved-state
holders preserve the query across terminal navigation and recreation; Clear search is labelled.

**Bounded verification:** all 12 actual `SessionSearchTest` JVM methods pass using cached
Kotlin 2.2/JDK 21 compilation: ten behavior tests and two native wiring guards. Twenty-one
isolated-copy mutants are caught by assertions; restored tests pass and production inputs are
unchanged. This is not a Gradle/Compose runtime or physical search result.
Private proof: `/tmp/nodeterm-session-search-verify/results.json`.
The subsequently coordinated actual eight-class focused Gradle run passes
(`precommit-focused-protocol-2.log`), and the final callback-aware offline app compile passes
(`precommit-app-compile-final.log`). Full candidate-source protocol/app gates subsequently pass
at `314105a4`, as recorded in the delivery receipt below. Physical search is not verified.

**Follow-up:** add search/restoration checks alongside existing item 10's session-grouping checks,
without replacing that item's required route/status evidence. New phone touch/keyboard proof is
pending. No desktop/server host contract changes; the iOS search UI is separate UX work.

## A97

**All computers does not refresh live while visible (A55 residual, 2026-10-04).**

- Severity: **low**; effort: small; area: parity; kind: freshness gap
- Status: **fixed in `8443e71e`; full candidate-source and mutation checks pass, physical results pending**.
- Locations: `AllComputersScreen.kt`, `conn/ConnectionManager.kt`, protocol
  `host/ForegroundRefresh.kt`, `host/ConnectionUsers.kt` and `ForegroundRefreshTest.kt`.

**Before:** the merged screen in `e3ce041c` refreshes each paired computer once on START and on
explicit Refresh/Try again or an answer. Its Inbox and Usage can remain stale while open; the
eight-second watcher is owned only by individual host/terminal screens. This is separate from
the already-fixed merged-feed layout in A55.
**Implementation:** each paired host has a keyed STARTED watcher, using AUTO initially and on
later ticks. Denied/unanswered approval holds remain in place; only that host's Try again requests
USER approval. The initial UI task yields so on-screen Inbox registration precedes listing and
notification announcement. STOP/removal cancels that host's watcher. The last All-computers
watcher requests closure only after in-flight users finish; a newer watcher supersedes an old
deferred close. Individual host opening retains USER-first behavior and its quick-return policy.
One per-host serial operation covers connect, listing, snapshot publication and announcement,
including manual, pushed and polled refreshes. Pushed changes and delayed reconnect jobs are
children of the current watcher, including while delayed or queued behind that serial operation.
STOP cancels them; cancellation/current-connection guards prevent an old job from reopening a
hidden host or moving to a replacement watcher. The poll job is assigned before its lazy start.

**Verification:** `ForegroundRefreshTest` defines 19 methods (18 behavior, one native
wiring), and the focused ownership run also includes six `ConnectionUsersTest` methods. They
cover cadence, trigger gates, cancellation, ownership, serialized relisting, host removal and
watcher-owned pushed/delayed work. Actual cached Kotlin 2.2/JDK 21 control/restored runs pass all
25 methods. Thirty-one non-equivalent isolated-copy mutants are assertion-killed: 17 behavior
and 14 native-wiring mutants. Ten source hashes remain unchanged and bind the receipt to
`8443e71ee872db46da68380a9db1ab05748818d2`; an equivalent redundant-guard mutation is excluded.
Private proof: `/tmp/nodeterm-all-computers-refresh-verify/results.json`. The earlier
eight-class focused Gradle run passes 134 methods with zero failures, errors or skips; that run
preceded final assertion-cleanup additions. Full candidate-source protocol/app checks
subsequently pass at `314105a4`, including these final assertions.
Physical item 60 multi-computer freshness, notification suppression and lifecycle
checks remain pending; no device-ledger promotion follows the source implementation.

## A98

**Captured terminal output cannot be searched (2026-10-04).**

- Severity: **low**; effort: small; area: terminal UX; kind: feature gap
- Status: **fixed in `1b1872f1`; full candidate-source checks pass, physical follow-up pending**.
- Locations: `TerminalScreen.kt` (`CopySheet`/Find chip), protocol `model/TerminalCopy.kt` and
  `TerminalSearchTest.kt`.

**Before:** `e3ce041c` already offers snapshot lines, link actions, line/range selection, Copy and
Share, but no text search. **Implementation:** Find opens that same local captured-output sheet.
A native query field highlights literal case-insensitive occurrences and moves Previous/Next
through matches with wrapping navigation. UTF-16/exclusive offsets match Compose spans; rows and
selected line identities stay unchanged. Query changes reset the cursor, Clear removes the query,
and no-match/truncated counts are explicit. Matching is capped at 2,000 occurrences, with
truncation reported only when another match exists. Whitespace in a nonblank query is significant.
This searches the existing captured snapshot, including joined soft wraps; it does not fetch or
search all remote tmux history, and no query is typed into the pane.

**Bounded verification:** all nine actual `TerminalSearchTest` JVM methods pass and 13
isolated-copy mutants are caught. Tests cover literal punctuation,
Unicode offsets, empty/long queries, navigation, the exact cap, original copy order and native
wiring. The coordinated actual eight-class focused Gradle run and final callback-aware offline
app compile pass (`precommit-focused-protocol-2.log`, `precommit-app-compile-final.log`).
Full candidate-source protocol/app checks subsequently pass at `314105a4`; physical results
remain pending.

**Follow-up:** record the extra Find/query/selection checks beside existing Copy-sheet item 56,
and keyboard-open layout/closing checks beside item 50. Preserve all of those items' original
requirements and current statuses. No external protocol change; iOS UX parity can be considered
separately by @eneskirca.

## A99

**SSH host-key discovery ignores recursive external Includes (A49 residual, 2026-10-04).**

- Severity: **low**; effort: small; area: security; kind: discovery gap
- Status: **fixed in `e07071e9`; full candidate-source checks pass, physical included-key pairing pending**.
- Locations: `src/main/ssh-host-keys.ts`/`.test.ts`,
  `android/protocol/src/test/interop/host-fixture.ts` and `PairingInteropTest.kt`.

**Before:** `e3ce041c` discovers standard public-key names and direct HostKey entries in the
readable main config/drop-ins. A served key named only through an external/nested Include can be
absent from the sealed pairing anchors; the phone correctly refuses that first SSH key, and
pairing again repeats the incomplete discovery.
**Implementation:** readable Includes are followed recursively, including quoted/multiple paths
and lexically expanded glob components. Relative Includes resolve under the configuration root,
including when the including file is external. Canonical paths stop cycles; discovery has
depth/file/byte/directory/glob/public-file budgets, and nonregular/oversized/unreadable inputs are
skipped. Reads are bounded and use nonblocking/no-follow plus opened-inode checks. Public-key
fingerprinting retains the public-target guard; private HostKey paths named by the config are
excluded from Include reads. Relative HostKey values remain unsupported; no new trust override
or weakening of pin/anchor checks is introduced.
HostKey paths are deduplicated per file/across configs, with at most 256 distinct configured
paths canonicalized. Exhausting that budget stops further Include traversal so unresolved
private-key aliases cannot become later configuration reads.

**Source verification:** the actual Linux Vitest control/restored runs pass all 19 tests,
including a real FIFO replacement boundary. Sixteen isolated-copy source mutants are caught by
assertions, including repeated/unbounded key canonicalization and continuing after key overflow.
Proof: `/tmp/nodeterm-ssh-include-root-verify/results.json`; the recorded inputs remain unchanged.
Desktop regressions cover recursive/relative Includes, glob ordering, cycles, budgets and read
boundaries. The Android fixture and new `PairingInteropTest` case use
scratch configuration/public keys with the actual production pairing service: the returned
sealed anchors are stored and used for an actual fixture SSH authentication. The actual
eight-class focused Android Gradle run and final offline app compile pass
(`precommit-focused-protocol-2.log`, `precommit-app-compile-final.log`). Full candidate-source
protocol/app and desktop checks subsequently pass at `314105a4`.
Physical included-key pairing is an item 11 follow-up, with the existing 64-item ledger unchanged.
The pairing field and SSH-visible contracts are unchanged; @eneskirca should check that iOS uses
the supplied anchors and presents the existing refusal/recovery messages consistently.

**Current delivery boundary:** installed beta 10 / code 11 and its 10 Pass / 22 Partial /
32 Pending ledger remain the device checkpoint. These four source additions are not yet
physically verified. Private beta 11 / code 12 is now **prepared, not installed**, from clean
source `314105a435d18e719f53d49bb292d0f3e965ad4a`. The local AGP release completes in 51.78
seconds, with R8 keeps passing. Candidate-source required gates report **730 protocol tests in
70 suites**, zero failures/errors/skips, offline app compile, **17 affected Vitest suites /
297 tests** and full desktop TypeScript passing. Proof:
`.nodeterm/android-beta-build-11/build-source-3/required-gates.json`. The existing layout source
pin in `LegRoutingTest` is corrected in `314105a4` to reflect the weighted list below Search;
that follow-up changes the test assertion, not product behavior. Across A96–A99, **81
non-equivalent isolated mutants** are caught (21 + 31 + 13 + 16).

**Independent artifact review passes:** candidate APK SHA-256
`ae052a8a02567c42576012309c5de059827d8b9ff28a9972673af0440d977341` is verified against its
metadata and build/R8 provenance. Official SDK 36 and 37 both verify v2/v3 signatures, one
expected retained signer, package/version, minSdk 26/targetSdk 35, nondebuggable metadata and
16 KB ZIP alignment; all four native libraries satisfy 16 KB ELF alignment. Signing preserves
all 149 unsigned ZIP payloads and adds only the three v1 signature entries. Terminal assets
and native libraries are byte-identical to beta 10; DEX, version/signature/optimization metadata
and an R8-mapped service-loader descriptor change as expected. Service-loader entries match
the actual R8 mapping. Receipt: `.nodeterm/android-beta-build-11/artifact-review.json`;
private APK: `.nodeterm/android-beta-11/nodeterm-android-0.1.0-beta.11.apk`.
No installation, new physical PASS or new CI result is claimed by this preparation. Each
requested push still requires green exact-head workflow verification; current phone cleanup,
rotation restoration and background watcher checks remain pending.

## A100

**Retained host history search**

Source change: `2f693d83, 97b8a9a4, 4f1985f5`.

Find previously searched only phone-captured output. It now searches retained host history on the attached generation/exact pane, with literal case-sensitive queries, original line numbers and explicit capture/result bounds. Search does not change copy mode or input. Old backends refuse without replacement. Query/stream/lifecycle fences discard stale answers. Actual producer/consumer and retained output-order tests pass; physical Find flow remains pending.

## A101

**Interrupted typed session-host reads reconnect**

Source change: `fbaa535d`.

An EPIPE in the existing socket suite also reproduced on the earlier baseline. Bounded reconnect/resend now allows only named typed reads after EPIPE/ECONNRESET. Sent writes, deadlines, host refusals and unknown errors do not replay. Actual socket tests and three isolated policy mutants pass.

## A102

**Cold relay attach retains trusted project launch settings**

Source change: `e584586f`.

Cold phone attaches previously omitted project env/shell. The host prepares trust-aware settings without spawning, resolves saved project/account/agent ownership ahead of phone hints, rechecks warm races, then commits reply/snapshot/attach synchronously. Existing warm sessions retain launch facts. Real shared launch builders and 22 mutations verify the source; actual fixture discovery is isolated from host tmux. Physical/live launches remain pending.

## A103

**Agent approval policy survives launch, resume and wake**

Source change: `91e6a3f5`.

Non-Claude launch/resume/wake previously dropped project approval policy. Android now matches measured desktop agent dialects and the actual host Codex vocabulary; only Claude uses its own auto capability gate. Unsupported modes retain CLI defaults. Eight actual mirror/desktop-builder fixtures and six mutations pass; a live agent/device matrix remains pending.

## A104

**Offscreen Sleeping nodes can wake without switching projects**

Source change: `2d6cb2cd`.

The renderer-only mounted-node nudge left offscreen/closed-project sessions Sleeping. The desktop now resolves unique saved ownership and actual live/released session proof across awaits, preserving Pause, exit/process/generation guards and original SSH routing. A typed persistent-backend wake is additive; an old backend refuses without restart. Actual socket/tmux regressions and 22 mutations pass. Windows runtime and physical inactive-project/lifecycle checks remain open.

## A105

**Always allow uses original concrete hook rule scopes**

Source change: `db4abccf, 7c206ec5`.

A56 is now implemented without its unsafe proposed blind digit. Eligible original addRules suggestions carry exact tool/content/destination and UI confirmation; the guarded v2 reply uses updatedPermissions. Android and Desktop/Server offer the same original scopes. Gone/replaced/unsupported requests never type keys. Actual shipped managed-shell consumer and Kotlin/TypeScript fixtures pass; live CLI rule application and physical persistence remain open. iOS adoption is owed to @eneskirca.

## A106

**Complete held Claude questions have deterministic answers**

Source change: `db4abccf`.

A57 display-only work is extended to all supported held questions. Parent PreToolUse AskUserQuestion requests publish full question schemas, submit every selected index, preserve original input and derive exact answer labels through hook JSON. Held v2 cards omit legacy digits for old phones; unheld multi-select remains Open session. Request/card/file fences and consumed-hook POST govern settlement. The 52 shared hook/Android mutants cover A105/A106 together; live CLI and physical question flows remain open.

## A107

**Typed source control works on direct SSH**

Source change: `489c30a8`.

The existing eight Git verbs now execute over POSIX SSH inside physically admitted local/driven roots and repository roots, with quoted argv/literal paths, NUL-delimited parsing, bounded output and confirmed status. Git capability does not depend on an actions-service advertisement or a relay leg. Third-machine projects refuse. Unknown writes retire the connection with no replay. Upstream fallback requires the exact native exit-128 missing-upstream diagnostic for the pre-dispatch branch. Real SSH Git tests include hostile filenames, symlink jail escape, hooks/signatures, rejected pushes and transport uncertainty. Twenty-six pure and five real transport/routing mutants are caught; physical Source Control remains pending.

## A108

**Owned SSH Board and Desktop session actions**

Source change: `d716138c`, `585e726f`.

At the A108 checkpoint, Desktop/Server exposes bounded private typed request/response files under the exact selected userData profile, with fresh instance/host-time advertisement, ownership and nonce guards. Board operations use the actual WorkspaceStore save queue and change broadcasts. Desktop offers delivery-only wake/refresh/rename nudges; Server offers Board only. Duplicate requests do not execute twice inside their immutable retry window; unknown results never replay/fallback. Another desktop's unowned driven projects refuse. Canvas cold New was outside the A108 service scope. A111 now adds a host-owned launch API on current enabled local Linux/macOS tmux hosts, including Server; its physical checks remain pending. Actual filesystem/FIFO, Desktop wiring and headless Server checks pass (33 tests); 29 native and 29 Android client mutation variants catch regressions. Real Node/Kotlin/generated-shell interop passes; the full merged Gradle gate verifies MINA and bundle coverage. Physical service flows remain pending.

## A109

**Three-digit findings retain device coverage**

Source change: `4e2f877d`.

The documentation scanner recognized only two-digit finding IDs, silently ignoring continuation IDs from A100. Both heading and reference scanners now accept full IDs with at least two digits and reject malformed suffixes. The actual regression and restored control pass; reverting either production regex is caught by an assertion. Two mutants are killed.

## A110

**SSH integration fixtures retain their own profiles and actual permissions**

Test changes: `8c57016c`, `b2e41255`.

The first merged protocol run exposed shared-home pollution: the new file-service tests reused
one class fixture and changed the workspace later transport tests expected. Each service method
now owns and closes its own SSH server, private home/profile, tmux root and command observer.
Existing browse, third-machine refusal and uncertainty assertions are preserved. A real MINA
mutation restores the shared home: the first service succeeds, later producers fail with EEXIST,
and the unchanged browse and NeedsRelay assertions catch the corrupted fixture. Control and
restored runs pass all six real methods. Nine additional Inbox mutants verify host/event admission,
busy state, cancellation and finally retirement; they extend the stale merged wiring assertion.

The affected native suite also exposed a test-created mode narrowed by inherited umask `0077`.
Explicit chmod makes the unsafe service directory actually `0755` before asserting Unsafe refusal.
All 30 tests pass under `0077` and `0022` in both control and restored runs; removing chmod triggers
the exact Vitest rejection assertion. The assertion still requires Unsafe refusal. Full merged gates pass
815 protocol tests / 83 suites and 1,314 affected Vitest tests / 53 files, with zero failures and only
the ten named existing Windows/macOS runtime skips on Linux; app and TypeScript checking pass.

**Prepared private beta 12 (2026-10-04).** `0.1.0-beta.12` / code `13`, clean built source
`b2e41255d8b2cf7bb342b78b7f686b8b0191879e`, includes A100–A110 and the earlier beta-11 additions. Full offline protocol
checks pass **815 tests / 83 suites**, with zero failures, errors or skips.
Offline app compilation, **1314 affected Vitest tests / 53 files** and full TypeScript
checking pass. The ten existing Windows/macOS runtime cases are explicitly skipped on this Linux
host; no additional skip is accepted. The minified offline release build passes in
**52.47 seconds**, with retained private signer, R8/runtime keeps and source/hash provenance.
Independent SDK 36/37 signature, nondebuggable manifest, payload and 16-KB ZIP/native checks pass.
The private support archive retains **236 isolated mutation variants** with passing controls and
restored runs: 228 assertion cases, six named executable-contract failures and two bounded timeouts.
Historical source hashes remain attached to their own receipts; this count does not claim that
all earlier worktrees were identical to the final merged source. Full merged release gates pass.
APK SHA-256: `d5a350a1f7c6f05f1ab476f25cbe58441eb666d61d1a4b62610a3faa2e058e1f`. Artifact:
`.nodeterm/android-beta-12/nodeterm-android-0.1.0-beta.12.apk`; build and mutation proof:
`.nodeterm/android-beta-build-12/`. **Prepared, not installed:** beta 10/code 11 remains the last
confirmed Pixel installation. Phone checks are paused, with **10 Pass / 22 Partial / 32 Pending**;
live Claude rule/question application and the new physical feature matrix remain unverified.
Each requested push still needs its own exact-head green Android workflow. No PR opened; A68
remains deferred until a PR is requested.

**Prepared private beta 14 (2026-10-04).** `0.1.0-beta.14` / code `15`, clean built source
`facbbd0384bb5b0ee91656f364793a12f8f41eb1`, adds A113 truthful revoke outcomes, A114 dictation language, A115 exact host/session
retirement and A116 saved pairing/LAN adapter choice. Full offline protocol checks pass
**890 tests / 92 suites**, with zero failures, errors or skips.
Offline app compilation, **1628 affected Vitest tests / 71 files** and full
TypeScript checking pass. Only the ten existing Windows/macOS runtime cases are skipped on Linux.
The minified offline release build passes in **47.96 seconds** with the retained private
signer and R8/runtime keeps. Independent SDK 36/37 signature, nondebuggable manifest, payload/
provenance and 16-KB ZIP/native checks pass.

The private archive records **158 assertion-caught isolated mutation variants**,
with passing controls/restored runs and each receipt's source bindings. One additional redundant
retired-guard variant survives equivalently and is recorded separately, never counted as caught.
Historical/intermediate bindings stay separate; full merged gates verify the release source.
Actual local HTTP and producer→Android tests use synthetic OS/key facts; HostStore tests use
in-memory Android interfaces. Native wiring source guards and cached compilation do not prove
physical recognition, VPN reachability, relay revocation or replacement behavior. Earlier beta
proof remains historical. APK SHA-256: `3c75912a5b7bb561fa9a0720be5cb11be75e1672f98379e4745871bf2729f8f6`. Artifact:
`.nodeterm/android-beta-14/nodeterm-android-0.1.0-beta.14.apk`; private proof:
`.nodeterm/android-beta-build-14/`. **Prepared, not installed:** beta 10/code 11 remains the last
confirmed Pixel installation. Phone testing is paused; the ledger stays **10 Pass / 22 Partial /
32 Pending**. No PR opened; A68 stays deferred. Each push requires its own exact-head green
Android workflow. At this APK source checkpoint A13 direct-SSH Desktop detachment, full legacy
identity association and A25/A93 hosted backend dependencies remained open. The later A13 host
follow-up below closes the coattachment source gap; its physical checks remain pending.

**Historical prepared private beta 13 (2026-10-04).** `0.1.0-beta.13` / code `14`, clean built source
`ba64f6289c0f552b85bfc17f99aee879aaf45975`, includes A111 managed SSH New and A112 producer-input coverage,
along with the beta-12 changes. Full offline protocol checks pass **845 tests / 87 suites**,
with zero failures, errors or skips. Offline app compilation, **1433 affected Vitest tests /
60 files** and full TypeScript checking pass; the ten existing Windows/macOS runtime cases
are explicitly skipped on Linux. The minified offline release build passes in **47.77
seconds** with the retained private signer and R8/runtime keeps. Independent SDK 36/37
signature, nondebuggable manifest, payload/provenance and 16-KB ZIP/native checks pass.
The new managed-creation and input-coverage regressions catch **148 isolated behavioral mutation
variants**, with passing controls/restored runs and per-receipt source hashes. Receipts distinguish
assertion failures from the named runtime contract failure; earlier beta-12 proof remains separate.
An isolated native node-pty/Electron/tmux fixture verifies host cwd/account/hooks/env/policy,
one launch submission and uncertainty fences. It uses a fixture CLI; real Claude startup,
macOS native creation and physical power-loss durability are unverified.
APK SHA-256: `faf9e508fa82355f640512ec1861ba886d0e48b8aef3e724edc6435c9f8c134b`. Artifact:
`.nodeterm/android-beta-13/nodeterm-android-0.1.0-beta.13.apk`; build and mutation proof:
`.nodeterm/android-beta-build-13/`. **Prepared, not installed:** beta 10/code 11 remains the last
confirmed Pixel installation. Phone testing is paused; **10 Pass / 22 Partial / 32 Pending**
remains the device ledger. Managed New and the other new source flows require physical checks.
Each push requires its own exact-head green Android workflow; no PR opened, and A68 stays deferred.

## A111

**Canvas New over direct SSH needs host-owned creation, not registration metadata (2026-10-04).**

A108's private actions service supplies Board/node metadata actions but cannot safely recreate a
cold managed pane by registering a node alone. Phone-built commands would duplicate the desktop's
account, trust, hook and launch policy; ordinary SSH attach must continue refusing missing panes.

The additive `sessions.createManagedV1` action resolves actual open local project/settings/account
facts through the host planner. An enabled Linux/macOS tmux backend exclusively creates a new
host-minted session, confirms one exact pane/PID/kernel birth and records runtime ownership. The
WorkspaceStore queue saves portable cwd and local shell, preserving pending intent until one
attested host submission is confirmed. Its private journal syncs file and directory phases before
side effects. Expanded launch text stays in private state/stdin, never shared project/receipt.
Failures expose an inert manual recovery notice; restart/uncertain/different-choice requests never
replay a launch or grant ownership from disk. Removed/pending accounts and changed cwd are refused
again at synchronous spawn, while ordinary renderer Home fallback stays intact.

Android saves the exact UUID/nonce/instance request before dispatch and public receipts until an
actual guarded SSH viewer is confirmed. The first attach pins selected profile/service, whole
single-pane session, creation/PID/birth marker, and fresh SSH tty; it is attach-only. Closing the
dialog/backgrounding cannot resend or navigate a stale screen. Stale proof requires explicit
inspection/discard; no automatic relay fallback or replacement creation. Older hosts retain the
relay New flow. Windows/non-tmux and third-machine/driven project creation are unsupported V1.
Managed canvas End remains relay-only so terminal termination also removes the canvas node;
SSH viewer close leaves it running. The separate phone-owned plain terminal End is unchanged.

Actual isolated native node-pty/Electron and tmux creation with a fixture agent passes; this proves
one submission with the host cwd/account/hooks/env/policy, not real Claude startup. Protocol,
producer interop, mutation and minified beta-13 local release gates pass. The Pixel remains on
beta 10 and the 64-row ledger remains 10 Pass / 22 Partial / 32 Pending. iOS @eneskirca needs the
new advertised action and durable attach-only receipt contract; no external message or PR opened.

## A112

**The managed producer exposes missing session-host CI and local incremental coverage (2026-10-04).**

A111's actual PtyManager fixture imports `src/session-host/**`; the esbuild-metafile regression
found those repository inputs absent from both Android workflow path filters. Gradle's declared
external source input directories also omitted them, so a source edit could leave local protocol
tests up to date. Both push/pull_request filters and Gradle inputs now include the directory.
Actual fixture graph/declared-input regressions cover this addition; removing either trigger
filter or the Gradle input fails its isolated mutation check. The actual producer/consumer
fixture and coverage guards pass, catching nine isolated variants. A68's PR-stage trigger
restriction stays deferred; each push still requires exact-head green Android CI.

## A113

**A legacy pairing can report a successful revoke without proof that relay access was removed (2026-10-04).**

Fixed in `349b791a`. Desktop revocation now reports `unconfirmed` for a saved pairing with no
recorded relay key or no available revoker, and `retained` when another saved pairing still
authorizes that exact key. Settings shows these outcomes separately from local SSH-key removal
and Pro expiry. An absent relay outcome from an older main process also remains unconfirmed;
the confirmation dialog no longer promises removal of every connection. Confirmed last-key
unpin/session closure remains required for the clean relay receipt. Seven affected main/renderer
suites pass 111 tests; eleven isolated assertion mutants are caught with passing control/restored
runs. The source-bound mutation fixture uses a temporary-home service boundary and mounted React.
These additive local Desktop IPC outcomes do not change the phone wire contract. Full legacy
identity association/migration and physical relay revocation remain open; no unrelated approved
key is guessed or removed.

## A114

**Android dictation has no language choice (A59 follow-up, 2026-10-04).**

Fixed in `6b989e59`. Settings offers a searchable language/region picker using human-readable
locale names and an explicit System default. The phone-wide preference is separate from host
identities and is frozen when a dictation starts. System default omits the native language extra;
a chosen language sends its canonical BCP47 tag. Partial/final results still fill only the draft,
and microphone, cancellation and lifecycle rules remain unchanged. The bounded catalogue lists
locales, not installed speech models: native unsupported/unavailable errors stay visible.
Three focused protocol classes pass 39 methods, offline app compilation passes, and eighteen
isolated compiled mutants fail assertions with passing control/restored runs. Native intent/UI
wiring is covered by source guards; the cached Kotlin/Compose compilation is separate evidence,
not a recognizer/device pass. Physical language availability, recognition and layout checks remain
pending. No host wire contract changes.

## A115

**Re-pairing leaves local host preferences and lets retired connections publish late (2026-10-04).**

Fixed in `0a71c028`. Replacing a paired record retires its route, relay approval,
managed-creation checkpoint and old token while preserving unrelated computers and same-ID preference
updates. Forget and re-pair retire the exact old connection objects; a shared session-admission
barrier covers local record/token publication, including incoming IDs with no previous key match.
No network await runs under that barrier. A failed local secret write retains the record, while its
old socket remains retired. This is a local monitor fence, not a crash-safe Keystore/preferences
transaction.

Owner-bound lifetime leases cancel pending dials and prevent late pin, LAN, relay-token, approval,
notification or checkpoint publication into a successor, even when it reuses the ID and key.
Normal disconnect still permits reconnect and retains an uncertain creation receipt; permanent
retirement never reconnects. Both primary and side relay results are retained before cancellable
handoff and closed on cancellation. Quiet notification reach uses the exact session without a
reverse manager lookup. Closing local polling does not revoke an existing Desktop SAS consent.

Private controls/restored runs execute 177 repository methods and 29 actual
production HostStore adapter cases against in-memory Android interfaces. 73 isolated variants
fail assertions. One additional redundant retired-guard experiment survives equivalently because
retirement also invalidates every admitted generation; it is recorded separately and is not counted
as caught. Native wiring remains source-guard evidence, with app compilation checked separately.
No phone, live transport, physical durability or full legacy Desktop identity migration pass is
claimed. No host wire contract changes.

## A116

**Pairing can advertise a Docker/VPN address the phone cannot reach (A49/A74 follow-up, 2026-10-04).**

Fixed in `a6b3e88b`. Desktop Settings → Phone lists current IPv4 adapters and an Automatic choice.
The saved selection is an adapter name, so each new QR and authenticated relay LAN report follows
its current address across DHCP. An unavailable explicit adapter prevents a new QR and omits the
report's dial address; it never silently substitutes another adapter. Automatic prefers a physical
adapter on POSIX, retains Windows' validated current route hint, and permits a virtual-only fallback.
The list describes current local addresses, not proof that the phone can reach them. Windows remains
relay-only; browser Server pairing/network controls deliberately remain unsupported.

Both Settings and quick pairing acknowledge pending settings writes before starting. Changing the
choice hides/stops the old QR first, offers an explicit failed-save retry, and cannot restart after
its visible row is hidden. Real global-search rows work too; hiding that row retires only its own
listener, including while its parent hook remains mounted. Old replies/events cannot stop or update
a newer pairing view. The legacy exported picker helpers also use the shared policy.

Isolated Desktop controls/restored runs pass 156 methods; one unrelated pre-existing worker-spawn
guard is explicitly filtered in that private sandbox and remains part of the full merged gate.
Root's actual local HTTP-listener controls/restored pass all six methods. Five producer→Android
methods call the real policy, QR builder and LAN reporter with a fake OS table/public-key directory,
then the existing Android parser and LAN-refresh policy. They prove paired-host identity/pin
preservation, not Keystore or approval publication. The three final proof groups catch 56 assertion
mutants (32 Desktop, six real HTTP, eighteen interop); preliminary receipts remain separate.
The existing wire shape is unchanged and the Android client needs no parser change. iOS @eneskirca
should adopt the existing authenticated `lan` field; it now reflects the saved Desktop adapter.
Physical QR/VPN/DHCP, search UI and multiadapter checks remain pending. No external message sent.

## A117

**Relative private HostKey declarations can be opened by a configuration Include (2026-10-04).**

A relative `HostKey` is still excluded from SSH anchors because discovery does not know the
daemon's working directory. Its normalized private basename now also excludes lexical and
canonical Include candidates before they are opened. Explicit public `.pub` declarations remain
readable, and relative declarations share the existing bounded declaration budget. This is a
conservative exclusion by name; it does not infer relative paths or discover unknown aliases.

All 22 host-reader methods pass on this Linux host, including the existing real FIFO race.
Seven isolated reader mutations fail assertions with passing controls/restored runs. The real
pairing-service → Android regression seals only a disposable server's permitted key, preserves
the anchors in the phone record, accepts that real SSH server and refuses a second real server.
The original source and removal of the canonical exclusion both fail that regression; restored
source passes. Private-file inputs are synthetic config sentinels, never actual private keys.
Proof is retained in `.nodeterm/android-relative-hostkey-2026-10-04/`.

The sealed field and Android production code are unchanged; the actual interop fixture is updated
with the producer. iOS @eneskirca should verify the existing anchor handling against the current
host. Prepared beta 14 remains valid client source and is not installed. Physical checks remain
pending; phone testing is paused and the ledger stays 10 Pass / 22 Partial / 32 Pending.

## A118

**Eligible older pairings cannot associate their existing relay key with a saved device (2026-10-04).**

The standing phone host now offers `pairing.relayKeyChallengeV1 {pairingId}` and
`pairing.relayKeyProofV1 {challengeId, signatureB64}` only after the normal relay approval gate.
A legacy pairing is eligible only when its exact host-minted UUID has one unambiguous, canonical
Ed25519 public key under the host's existing `nodeterm-ios-<id>` authorized_keys attribution.
Missing, option-bearing, duplicate, malformed, replaced or unsafe files refuse proof; relative
identity guesses and device names are never used.

Each connection holds at most one ephemeral challenge and one in-flight inspection. It binds
version, challenge UUID, pairing UUID, pinned host box key, authenticated peer box key, raw SSH
public key, random nonce and expiry. All fields use the fixed newline encoding in
`src/shared/relay-pairing-proof.ts` and Android `RelayPairingProof.Challenge.signingBytes`.
Both wall and monotonic host time enforce 60 seconds. Every proof attempt consumes the challenge
before awaiting publication, including malformed signatures; another session cannot use it.

Android attempts the optional proof only after an approved first listing, using its existing
encrypted SSH seed. It validates the captured host, peer and SSH keys before signing, checks the
current record/lifetime around awaits, and never creates an identity, changes approval or tokens,
or retries an uncertain proof. Missing identity, unsupported older hosts and ordinary optional
errors preserve browsing; cancellation propagates. A socket closed during proof cannot be handed
off as connected, and a later network close after proved approval is not reported as Deny.

The actual host pairing queue stages a private association, then rechecks the bounded exact
registry snapshot, attributed public key, approval, connection lifetime and expiry immediately
before synchronous atomic publication. Existing same-key association is idempotent; conflicts and
deleted/replaced entries refuse. This is a same-service queue, not a cross-process transaction.
Normal revocation can then unpin/cut the exact proven last key; a sibling pairing still authorizing
that key keeps the explicit retained outcome.

Focused controls pass 87 host and 15 Android helper methods. Forty compiled host and 25 compiled
helper mutation variants fail assertions. Seven real producer→Kotlin encrypted interop methods
cover sealed legacy pairing, actual signature verification, exact publication/revoke, distinct and
shared-key siblings, wrong SSH identity, cross-session/consumed challenges, old-host fallback,
unapproved access and the close/callback ordering. Six additional interop variants fail assertions
with passing controls/restored. The public-pin adapter, human decision, OS address and unused PTY
are explicit fixture boundaries. Private evidence: `.nodeterm/android-legacy-relay-proof-2026-10-04/`.

This is an additive host/Android contract. iOS @eneskirca needs the same retained-key signer and
exact encoding to repair eligible legacy records; old iOS remains usable. A phone without its
retained SSH seed, its matching attributed SSH public key in the host's authorized_keys or SSH support still needs re-pairing. This proof never
bypasses first SAS approval and does not solve hosted FCM or A93. New Android source needs a later
APK than beta 14; no new installation or physical/live transport pass is claimed. Phone testing
remains paused, beta 10/code 11 is last installed, and the ledger stays 10 Pass / 22 Partial / 32 Pending.

## Prepared private beta 15 and verification checkpoint (2026-10-04)

`0.1.0-beta.15` / code `16` is built from clean signed source `aa902d0a52ba8ccfa0be57e073c350e90cfad5d3` and includes
A118's optional retained-SSH legacy relay identity proof. The host must also run this source for
migration; older or unprovable hosts remain browsable. A117's relative private-key Include fix and
A13's coattachment fix are included in the host source.

Required source checks pass: 912 protocol methods / 94 suites, zero failures/errors/skips;
offline app compile; 1,919 affected desktop methods with exactly ten known macOS/Windows skips;
full TypeScript checking. All five exact-source Android jobs pass: [source CI](https://github.com/CPlusPlus17/nodeterm/actions/runs/37228985208).
A118's focused proof remains 87 host and 15 helper methods, 40 + 25 compiled assertion-caught
mutants and seven actual producer→Kotlin methods with six additional assertion-caught variants.

The local release build uses a fresh tracked Android-only snapshot, cached AGP 8.10.1/Kotlin 2.2.0/
Gradle 8.14.3/JDK 21 and `--offline`. R8 runtime keeps and 56 independent artifact checks pass:
SDK 36/37 signatures and 16 KB alignment, retained signer, actual version/manifest/provenance,
service-loader mappings and unchanged terminal/native assets versus beta 10.
Private APK: `.nodeterm/android-beta-15/nodeterm-android-0.1.0-beta.15.apk`.
SHA-256: `c1e707c8a18555db7e01129b709d39db342128f3c54d8103d548cc177bc9abaf`.
Signer SHA-256: `c610c3a0b637a8005b6fd858587e8cbf5260622648bc1cd97c0de0ab5f146dbd`. Private build/review evidence:
`.nodeterm/android-beta-build-15/`. The APK, signer and proof remain outside source exports.

Live A105/A106 application is still unverified. An isolated installed Claude 2.1.289 fixture uses
the actual managed hook server/script/writer with an in-memory CorePlatform. Its fresh-context,
read-only credential/config and fixed-tool guards pass 34 static checks and the exact offline
mount/auth gate. The first attempt hid the system DNS target and timed out before tools; a
separate corrected fixture exposes only that regular resolver file read-only. It reaches the
provider, but receives authentication HTTP 401 before any tool request. No application pass is
claimed. Original profile/source/binary/resolver metadata remains unchanged; raw diagnostics stay
private and no credential refresh/reset is attempted. After the existing CLI account is usable
for inference, rerun the isolated remembered-rule/full-question checks. This gives no physical,
renderer, SSH or hosted-relay proof.

Phone testing remains paused. Beta 10/code 11 is last confirmed installed; beta 15 is prepared
and not installed. The ledger stays **10 Pass / 22 Partial / 32 Pending**. Next device work uses
this APK and current host source, checks saved key/pin survival and the expanded checklist,
then restores rotation and removes only owned QA host state. A25/A93 still require hosted-backend
maintainers; iOS @eneskirca owes the new proof contract and earlier mirror/verb/v2-answer adoption.
No PR is opened; A68 stays deferred until requested PR preparation.

## A118 JUnit registration follow-up (2026-10-04)

The focused Kotlin runner exercised all 15 helper methods, but the initial Gradle/JUnit run
registered only 14: the outer-timeout coroutine test inferred an exception-valued return.
Its explicit `runBlocking<Unit>` signature now lets JUnit discover it. Actual offline Gradle
controls register all 15 with no failures/errors/skips. Removing the signature compiles and
passes 14 methods, then fails the exact method-registration assertion; restoration passes 15.
The seven actual host/Android interop methods were already registered. Private evidence:
`.nodeterm/android-legacy-relay-proof-2026-10-04/junit-registration/`.

The required local gate now checks the actual JUnit helper inventory and the outer-timeout
method explicitly. This correction changes only a protocol test and documentation after
beta 15's `aa902d0a` source; its shipped Android runtime inputs and private APK are unchanged.
The APK remains prepared and uninstalled, live Claude application remains unverified after
provider HTTP 401, and the physical ledger stays 10 Pass / 22 Partial / 32 Pending.

## A119

**Explicit SSH profile folder (2026-10-04).**

Add SSH server now accepts an optional absolute **Profile folder**. Existing computers can change
**SSH profile folder** in Settings → How to reach each computer. The saved phone-local choice
selects a custom Desktop/Server data directory ahead of all automatic discovery. Blank restores
discovery. A missing or invalid explicit choice reports an error and never selects another profile.
Board, project reads and all three managed-view stages use the same captured profile. Saving a
change invalidates pending connection work and clears old displayed rows while retaining uncertain
creation receipts; it never recreates a session. SSH host pins, pairing and relay credentials remain
unchanged. Paths are quoted literally and reject relative/dot components, controls and oversized input.

Regression coverage uses actual Server config/platform/WorkspaceStore/mirror/actions producers,
a real private MINA SSH server and isolated tmux. The fixture supplies a plain-shell planner/native
create boundary; it does not run full Server boot, installed hooks or account probes. Native storage
coverage uses actual app classes with in-memory Android adapters. Ten protocol model methods,
three actual Server/SSH methods and the complete 62-method SSH/10-method workflow suites pass.
Four compiled SSH profile mutants fail their intended assertions. Final native control/restored
runs pass 19 cases and catch the retired-session mutation; seven earlier native variants have
separate historical source bindings. Private receipts: `.nodeterm/android-ssh-setup-2026-10-04/`. Physical setup/profile switching remains unverified;
phone testing is paused and the ledger stays **10 Pass / 22 Partial / 32 Pending**. At this source checkpoint, beta 15 was
the latest prepared APK and excluded A119. The beta-16 receipt below records its later packaging.
iOS implication for @eneskirca: offer an explicit saved SSH profile choice consistently for discovery
and managed attachment. No host verb or pairing payload changed. A25/A93 and A68 remain open;
no PR is opened.

## A120

**One-time password SSH setup (2026-10-04).**

Add SSH server keeps its public-key Copy/Share/manual command and adds **Set up with a password**.
The app inspects the SSH host key without authentication. Compare its fingerprint on the computer,
then explicitly confirm **I compared it — it matches** before entering the password. Password login
rechecks that exact key, installs only the retained phone public key, closes the setup connection,
and proves a separate pinned key-only login before saving the host. A changed key, refused password,
unsafe key-file target, uncertain command or failed key verification never saves a computer.
No setup write is automatically replayed. A lost acknowledgement may leave the public key installed;
use the normal key connection or check authorized_keys on the computer before starting a new attempt.

The password is memory-only, absent from saved state/preferences, shell text and diagnostics. Leaving
or backgrounding setup cancels owned sockets and clears its password/fingerprint approval. JVM/library
transient copies cannot all be erased. Existing keys and restrictions are preserved; commented or
trailing key-like text is not an installed declaration. Symlink, nonregular, foreign-owned and hardlinked
targets refuse. These are bounded pathname preflight checks, not descriptor-atomic protection against
concurrent same-user replacement. Keyboard-interactive/MFA, password changes and Server installation
remain unsupported. Host pins, pairing/relay credentials and ordinary key-based connections retain
existing behavior. iOS implication for @eneskirca: confirm fingerprints before password auth and verify
fresh retained-key auth before saving; no host-service verb or pairing payload changed.

Seventeen actual protocol methods pass against a private MINA SSH server and private POSIX HOME.
They cover fingerprint/auth order, other/restricted keys, uncertainty/no replay, both-stream output
limits, own timeout versus external cancellation and socket closure. Offline app compilation passes.
Seven isolated compiled semantic variants fail assertions, with 17 passing control/restored
methods and exact integrated source hashes. Private proof: `.nodeterm/android-ssh-setup-2026-10-04/password-final/`.
The full required gate verifies actual Gradle/JUnit method registration too. This is source/fixture proof.
Actual Android setup UX, ordinary PAM/account behavior and macOS runtime checks remain pending;
the controlled native OpenSSH receipt below adds wire/exec evidence. Phone testing stays paused,
with beta 10/code 11 last installed and **10 Pass / 22 Partial / 32 Pending**. Beta 15 excluded A119/A120;
the subsequent beta-16 receipt below includes both. A25/A93 require the hosted-backend maintainers; A68 stays deferred and no PR opens.

## Prepared private beta 16 and verification checkpoint (2026-10-04)

`0.1.0-beta.16` / code `17` is built from clean signed source
`2723845efac75cfcf2cd0a9fdfa11d9496699641`. It includes A119's explicit saved SSH profile folder and
A120's opt-in password enrollment, along with the earlier beta-15 changes. Missing explicit profiles
never fall back to another profile; enrollment saves a host only after a separate pinned key login.
Full offline protocol checks pass **944 tests / 98 suites**, with zero failures, errors or skips.
Offline app compilation, **151 affected desktop Vitest tests / eight files** with zero skips, and
full TypeScript checking pass. Actual JUnit inventories include the new setup tests. An obsolete
inline UI behavior source pin was removed; actual SSH authentication regressions remain.
All five Android jobs pass for the APK source:
[workflow 37233114167](https://github.com/CPlusPlus17/nodeterm/actions/runs/37233114167).

The minified release build passes offline in **54.87 seconds**. Packaging uses the retained private
signer; all **56 independent artifact checks** pass, including official SDK 36/37 signatures,
nondebuggable version/manifest, R8/runtime keeps, payload/provenance and 16-KB ZIP/native alignment.
APK SHA-256: `9c5309c8cfb225daf59f7fac70be1760fb0abdaac36cb55005b958f2186c8ce3`.
Private APK: `.nodeterm/android-beta-16/nodeterm-android-0.1.0-beta.16.apk`.
Build proof: `.nodeterm/android-beta-build-16/`; behavioral/mutation proof:
`.nodeterm/android-ssh-setup-2026-10-04/`. Earlier failed or historical runs retain their separate
receipts; they are not counted as successful merged gates. The release receipt changes only docs.

**Prepared, not installed.** Phone testing remains explicitly paused, beta 10/code 11 is last
confirmed installed, and the device ledger stays **10 Pass / 22 Partial / 32 Pending**.
When authorized, install beta 16 as a same-signer update and verify saved identities, profile
selection/switching/no fallback, password/fingerprint/cancellation UX on actual OpenSSH, and the
remaining managed-session, relay/cellular, notification and lifecycle matrix. MINA/POSIX fixtures
and in-memory app adapters do not verify physical Android or macOS behavior. Live Claude rule and
question application remains unverified after provider HTTP 401. A25 FCM and A93 fresh-desktop
relay recovery require the hosted-backend maintainers. For iOS, @eneskirca should adopt the saved
profile/enrollment UX and review the earlier host protocol changes. No PR opened; A68 remains
deferred until a PR is requested. Every push requires its own exact-head green Android workflow.

## Native OpenSSH enrollment verification (2026-10-04)

A120 now has an actual **OpenSSH 10.2p1** control run in addition to its MINA regressions.
The actual protocol sources at `bac1aa7fe90416b07dd0de47ac95049e817ce8b5` were compiled privately;
**28 distinct assertions / 40 passing assertion events** verify inspection against an independently
measured public fingerprint, password login followed by fresh pinned key login and exec,
retained unrelated keys, newline/mode handling, idempotence, consumed confirmation, rejected password
and host pin, commented key text, restricted keys, symlink/nonregular targets, and closed client sockets.
These are native fixture assertions, not additional Gradle/JUnit methods or physical checklist passes.

The daemon ran as UID 1000 in a filesystem/user/PID sandbox exposing only read-only `/usr` and private
account files/home. Its password and SSH identities were newly generated for this test. It listened
only on loopback, with PAM, keyboard-interactive, forwarding, PTY and source penalties disabled.
This Fedora build warns that `UsePAM no` is unsupported; the asserted crypt/password and public-key
wire/exec flow nevertheless passes in that exact controlled configuration. This does not verify a
normal PAM/account backend, MFA, macOS, Android setup UX/Keystore, native cancellation/timeouts,
or profile/managed-session behavior. The earlier MINA tests retain their separate coverage.
Both disposable daemon runs are closed; their generated passwords/private keys/account hashes were
removed after the run. No host account, credential, SSH configuration, retained phone identity or
phone state was changed. Private proof: `.nodeterm/android-beta-build-16/openssh-native/`.

The stale SSH class comment now describes A111's host-owned managed New support; missing existing
canvas sessions remain attach-only. It changes only KDoc, with the same source line count.
The prepared beta-16 APK remains source `2723845e`, code 17 and the same retained signature/checksum;
no new APK is built or installed for this verification/comment checkpoint. Fresh compilation in the
same AGP graph confirms every protocol class byte matches the immutable beta-16 build. This byte
comparison is a required gate before publishing the receipt. Required local gates and exact-head Android CI also remain mandatory.
Phone checks stay paused at **10 Pass / 22 Partial / 32 Pending**, with beta 10/code 11 last installed.
Actual Pixel setup/lifecycle, ordinary PAM accounts, macOS and live Claude checks remain open;
A25/A93 still need hosted-backend maintainers, iOS follow-up stays with @eneskirca, and A68 remains
deferred until a requested PR. No PR opened.

## A121

**Canvas terminal blur can leave a stale link pointer (2026-10-05).**

- Severity: **low**; effort: small; area: desktop renderer; kind: bug
- Status: **source-fixed; complete native verification pending**.

**Observed:** the isolated full Linux Electron Desktop UI at `c0accdfcb0642dc2d643e1794640065f61906f34` rendered a wrapped URL through the real plain NodePTY and bundled xterm DOM renderer. Tail hover, complete URL activation by Ctrl-click, and native non-drag movement outside the terminal were delivered. In the SGR mouse case, moving to the canvas left xterm's active link and pointer state set (`A92_HOVER_CLEAR_FAILED`). No pointer capture was active. The normal mouse case completed the same leave successfully.

**Cause:** `src/renderer/nodes/TerminalNode.tsx` calls `term.blur()` synchronously from `onBodyLeave`. The bundled xterm DOM renderer handles blur by immediately rendering all rows with `replaceChildren`. The native trace records screen `pointerleave` and `mouseout`, then destination `mouseover` whose former span is detached, with no actual screen `mouseleave`. Linkifier clears its hover on that missing `mouseleave`, so its `mouseOut` stays false and pointer/link state survives. The visible row underline can disappear during blur even though Linkifier's hovered decoration state and pointer remain; this finding does not claim every visible underline persisted.

**Source repair:** `terminal/deferred-blur.ts` defers only the captured terminal's blur with `setTimeout(0)`. Re-entry, intentional focus and lifecycle cleanup cancel it; generation and exact current-terminal identity reject stale callbacks, including same-object park/adopt. The controller remains reusable after cleanup. Status/presence release stays synchronous. Nine behavioral methods pass, all 63 tests in four affected terminal files and the full TypeScript check pass, and five isolated production mutations fail on assertions (immediate blur, microtask, ignored cancel, missing generation, missing owner). The control/restored copies pass. Private proof: `.nodeterm/android-beta-build-16/desktop-links-and-advertisement-receipt/a121-unit/`. A fresh full eight-case native Desktop UI control and deliberate synchronous-blur mutant are still required to verify the actual wiring.

**Scope:** Desktop and Server share the Canvas `TerminalNode` handler. The observed execution is Linux Desktop only; Server behavior remains a shared-source implication until executed. Modal terminal leave does not use this handler. Android's terminal is unaffected, and this repair changes no external protocol or iOS contract. The Android APK source, installed phone version and 64-item physical ledger stay unchanged.

**Separate A92 evidence:** the old upward-bound link mutant already fails with the named `A92_TAIL_HOVER_MISSING` in a real native tail hover. That establishes sensitivity to A92's lookup cap defect; it does not turn this incomplete control into a full A92 UI pass. Preserve that receipt separately from A121's leave failure.

Private evidence:
- Current failed control: `/tmp/nodeterm-a92-current-ys5prgif/runtime/control-7yoizvhv/proof/{receipt.json,runtime-result.json,canvas-soft-sgr-hover-clear-failed.png}`.
- A92 old-bound mutant: `/tmp/nodeterm-a92-mutant-7dyrrp0u/runtime/old-upward-bound-mgnkw593/proof/{receipt.json,runtime-result.json}`.
