# Android companion: handover (updated 2026-10-02)

Read this first if you are picking up the Android work. It records where the work stands, what has
and has not been verified, what is known to be broken, and the plan in order. The full list of
findings, with evidence and fixes for each, is [`android-audit-2026-09.md`](android-audit-2026-09.md)
(original IDs `A01`–`A77`, continuation findings `A78`–`A82`). The design notes are [`android.md`](android.md) and the user-facing readme is
[`../android/README.md`](../android/README.md).

## TL;DR

- The Android app exists (`android/`), and **CI builds it with AGP**: a debug APK and, since `A37`,
  a minified release build that runs R8. The private-beta path versions that unsigned release
  and signs/verifies it locally; a verified local AGP build is also authorized for this first beta.
  The first retained private signer is prepared in Git-ignored local state; no signed nodeterm
  APK exists in this session. Historical protocol tests pass in CI; continuation CI is unverified.
- **It has never been run on a phone.** Of the audit's 77 findings, 73 are fixed on the branch:
  all 9 release blockers (WP1 + WP2), every WP4 medium bug, the WP5 parity gaps and nearly all of
  WP6, plus the follow-ups of batch E. Four remain: `A25` is fixed in the app but push needs FCM
  on the backend, `A56` was deliberately not built, `A50` has a private-beta packaging path and
  retained signer but signed delivery/device validation remain open, and `A68` is deferred until
  the branch is ready for a PR. Earlier work was unit/interop-tested where the layer allows and
  type-checked, but **nothing has run on a device**. Do not hand the APK to anyone until the
  device pass (WP3) has run.
- Next finish verification on the reconciled source, build/package the private beta, and run the
  **device checklist** in [`android.md`](android.md#device-checklist) (64 items) if a phone is
  available. Then pick from the known gaps under "What is still open", with `A68` last. No PR is
  open, and none should be opened unless the user asks.

## Progress log

Newest first. Each entry says what landed, how it was checked, and where the fix differs from the
audit's proposal.

### Local host access restored; source reconciliation in progress (2026-10-02)

The user authorized a local build instead of waiting for GitHub Actions. Restored host access
allowed fetching remote tip `82940e17`, whose six batch E follow-up fixes are included in this
reconciliation. The host-side adb lists an MI8 phone on Android 35, with no installed
`dev.nodeterm.android`; no installation or device checklist result is claimed yet. Build the
unsigned minified APK and record APK/R8/source provenance from one successful local build, then
package with the retained signer. Required checks on the reconciled source, the actual APK and
phone validation remain pending. Earlier entries describe the prior restricted sandbox.

### First private signing identity prepared (2026-10-02)

The user confirmed this is their first private beta. A retained RSA-3072 PKCS12 signer, alias
`nodeterm-beta`, is prepared in the original workspace's Git-ignored
`.nodeterm/android-beta-signing/` (outside the temporary source checkout). The directory is `0700`
and every file is `0600`. Separate local password files feed `keytool`/the packager without putting
passwords in arguments or logs. The keystore contains a `PrivateKeyEntry` with a 3072-bit RSA key.
Its exported public certificate hashes to the locally recorded signer pin and differs from the
committed public debug certificate. Keep this directory in a private backup: source exports
deliberately exclude it.

This resolves the missing signer, not `A50` delivery. No actual nodeterm APK has been built or
signed. GitHub DNS, Gradle's lock-service sockets and adb/USB access are still unavailable here.
Next obtain one final green CI run's APK/R8/provenance, package with this retained signer, then
install and complete the mobile-data preflight/device checklist. No PR is opened; `A68` stays last.

### Private beta preparation (2026-10-02): local pipeline and reliability fixes

The user wants a privately sideloaded APK for their own phone. A signed APK is not published to
Actions or a public release: artifacts on a public repository are downloadable by other signed-in
users. `android/tools/package-beta.py` signs the unsigned AGP release locally, rejects the public
debug key and unexpected signer, checks release metadata, R8 keeps and APK alignment/signature,
then emits APK/checksum/provenance together. Version overrides leave ordinary builds unchanged.
Pushes to this exact takeover branch build versioned unsigned beta inputs and run **Private beta
checks**; optional manual **prepare_beta** inputs work once the workflow exists on the default branch
(a GitHub requirement; cached main has no Android workflow). The beta checks require the
protocol/release jobs, desktop type-check and delivery/ack tests, and
real-tool packaging regressions. See the [private-beta procedure](../android/README.md#private-beta).

- `A81` (`86390a49`, `7e11e93c`): relay join/device HTTP calls have a 30-second total deadline and finite I/O
  timeouts, including dispatcher queueing. Coroutine cancellation closes the call through
  response-body consumption and preserves a caller's shorter deadline. Six real
  OkHttp regressions pass over in-memory sockets; three initial and three follow-up mutation checks
  are caught. WebSocket reads remain
  long-lived and request/response shapes stay the same. Full Gradle/backend/device checks pending.
- `A82` (`010240e0`): read acknowledgments are consumed only by a positive owner. Local mirror ownership includes
  unresolved own inbox cards after restart; a retained foreign file is retried if ownership changes.
  Remote ownership aggregates every connected project on the host before the shell reads/removes
  files. Android's existing producer contract is covered in the same change and remains compatible
  with iOS; @eneskirca should verify the multi-desktop behavior on iOS.
- Packaging uses fixture APKs and disposable test keys for regression tests. Those fixtures are
  **not the nodeterm app**. No APK has been built, signed or installed for the user here. Required
  full checks, latest-remote reconciliation, CI and all 64 device items remain open. `A68` is deferred.
  Packaging commits `d5f561ec`, `817fd923` pass 22 SDK-backed tests and 13 mutations. The selected
  beta-version environment guard passes 12 cases and catches its bypass. Ack verification passes
  225 desktop tests, three cached-compiler interop/path checks and eight mutations. CI config passes
  seven checks/six mutations in `6efde5f1`, and existing device/contributor docs pass nine checks. See `android.md`
  for the cached compiler/dependency limits; full required checks remain blocked before execution.

### Continuation (2026-10-02): local fixes, full checks and device pass still pending

This session started from the locally cached branch tip `6afd8f53`. GitHub access failed, so it
could not fetch a newer tip, download a CI APK, push or confirm a workflow run. Commit signing
also cannot access its key service here, so the continuation commits are unsigned local commits. The original
checkout's Git metadata is read-only; the working branch is in `/tmp/nodeterm-android-takeover`.

- `A78` (`bb5b3e54`): desktop quick answers resolve the exact session to a pane ID, cancel copy mode there,
  and deliver to that same pane. Mounted tmux sessions use that path too. Whole deliveries are
  ordered per node; a failed or unconfirmed operation is never retried on another channel.
- `A79` (`e64665c3`): Android's SSH quick answers also pin the pane ID and cancel copy mode before typing;
  lookup, cancellation, send failure and missing SSH exit status cannot report success.
- `A80` (`0f39c33f`): a control-mode client's startup attach reply is consumed before replies to queued
  commands. An attach failure retires the client and rejects queued work.
- No APK has been built or installed in this session. See "What is verified" in `android.md` for
  the local checks and their limits. The full protocol suite, app type-check, desktop type-check,
  real tmux/SSH checks and device pass still need an environment that can run them.

### Batch E (follow-ups, desktop + phone): done on the branch, not device-verified

Six follow-ups from earlier batches. Each had one or two adversarial reviews and a follow-up commit
for every finding above "nit"; all were confirmed against the code before fixing. Four of them
change the desktop, and three add wire fields (all additive, so older phones and iOS are
unaffected until they read them).

| Item | Commits | What changed | Checked by |
|---|---|---|---|
| A12 (SSH projects) | `8430243` | `node.sendKeys` types into a node of the desktop's SSH project over that project's ControlMaster (`PtyManager.backgroundWriteOver`, `send-keys -H` to the exact `=nt-<id>:` pane, copy mode cancelled first). Master down, no remote support or a failed resolve answer `sent:false`; never the local socket. Wire unchanged. | vitest `host-node-actions.test.ts`, `pty-background-write-over.test.ts`, `remote-send-keys.realtmux.test.ts` (the generated line under real `/bin/sh` + tmux, mutation-checked); `RelayInteropTest`. |
| A07 (revoke) | `c199349`, `a988a30` | Revoking a paired phone closes its live relay sessions through the standing host's own Deny path and withdraws a pending consent for that key; other keys are untouched. An unpin that could not be written puts the device back in the list (Revoke retries) instead of reporting success; Settings says when the cut could not be confirmed. | vitest `standing-host.test.ts`, `pairing-service.test.ts`, `peer-revoke-wiring.test.ts`, `PhoneSection.revoke.test.tsx`. |
| A07 (late adoption) | `f66fddf`, `07b7276` | A phone paired while remote access was off is approved on its first relay handshake: the desktop pins a box key that a listed pairing recorded (sealed `/pair` body), re-asked inside the pin queue so a revoke cannot be undone. The `/pair` answer gains `relayApproved`. The host holds the phone's first requests (at most 5 s / 32 requests) until it has decided, so a phone about to be approved silently is not told "awaiting approval" first; a background dial may therefore make the first relay handshake for a pairing that answered `relayApproved`. No new SSH-visible file. | vitest `approved-devices.test.ts`, `pairing-core.test.ts`, `paired-phone-late-pin-wiring.test.ts`, `host-service.decision-hold.test.ts`; `PairingInteropTest`, `RelayInteropTest`. |
| A49 (anchor) | `513c166`, `402f139` | The sealed `/pair` answer carries the computer's SSH host key fingerprints (`sshHostKeyFingerprints`, read from `/etc/ssh` and sshd's `HostKey` lines; never in the QR or a plaintext answer). The phone's first SSH connect accepts only a named key (`HostKeyNotPairedException` otherwise, routed like a changed key with its own advice). | vitest `ssh-host-keys.test.ts`, `pairing-service.test.ts`; `HostKeyAnchorsTest`, `SshFallbackTest`, `PairingInteropTest`, `SshTransportTest`. |
| A74 (refresh) | `cb12f3b`, `898d937` | `projects.list` over the relay answers `{output, lan?}` with the computer's current LAN IPv4 and host key fingerprints beside the blob (not inside it). The phone takes them only from a RELAY listing: a new address replaces the stored one, and the reported keys become the anchors. A host certificate is named by the key it certifies, so it no longer flips the pin. | vitest `host-lan-report.test.ts`; `LanRefreshTest`, `HostCertificatePinTest`, `RelayInteropTest`, `SshTransportTest`. |
| Seen log per computer | `6afd8f5`, `a65e12f` | The notification seen log is keyed by computer, and an event that reaches the phone through two pairings (a desktop and the SSH host it drives) still notifies once (same id and node). The old store migrates as seen for every computer until it ages out; forgetting a computer drops its entries. | `SeenLogTest`, `LiveNotificationsTest`. |

### WP5 batch D (iOS parity features): done on the branch, not device-verified

Each item had an adversarial review and a follow-up commit; the review findings were all checked
against the code before fixing. Most rules live in pure `android/protocol` classes; the Compose
screens are type-checked and source-pinned only.

| Finding | Commits | What changed | Checked by |
|---|---|---|---|
| A26 | `9cdc4cf`, `1eeb5b8` | `LegRouting` decides per capability (board writes, git, node actions, register node, answer approvals) whether the primary leg serves it, the relay leg opened next to SSH does, or it is unavailable with a reason that names the fix (remote access not set up / off on the computer right now / not picked up yet / the "Only on my network (SSH)" route). The browse reports whether `~/.nodeterm/relay.json` is there, so a held token with remote access switched off reads as off. Availability is a presence check (`hasRelayToken`), never a Keystore decrypt while composing. New session and board controls are disabled with the reason instead of failing on tap. | `LegRoutingTest`, `HostBrowseTest`; source pins on the screens. |
| A29 | `0c5a1e1`, `a5f38f5` | A per-project Source Control screen over the desktop's `git.*` verbs (status, diff, stage/unstage, commit, history), routed by `LegRouting` (relay only; no SSH git). Merge conflicts get their own section (no Stage; Commit refuses until resolved), combined-diff markers are read, and long git operations get the desktop's own timeout. | `SourceControlTest`; `RelayInteropTest` drives the desktop's real `GitService` over a temp repository. |
| A32 | `7035bde`, `88beed2` | terminal.js ports the desktop's wrapped-row URL matcher (not addon-web-links), handles OSC 8 through `linkHandler`, and opens http(s) only behind a link bar; a "Copy lines" sheet reads `term.buffer`. Overlays over the terminal stop touches from reaching the WebView or the input bar (`blockTouchesBelow`). | `TerminalJsLinksTest` runs the real terminal.js under node; source pins. |
| A25 (in-app part) | `4ffb8b7`, `0d310cc` | Inbox notifications carry Approve/Deny and option actions, run by a worker through the same `QuickActions` re-checks as the in-app card, never making a first relay handshake. A stale notification cannot type into a newer prompt (the card must still be listed and unresolved), and an interrupted worker never sends an answer twice. A tap opens that session's terminal with the computer's Inbox one Back away; an action that cannot answer from outside the session updates the notification to say so (Android forbids starting the session from a worker or receiver). **FCM is still missing** (backend). | `NotificationActionsTest`, `QuickActionsTest`. |
| A55 | `71b592a`, `0772cbf` | Each computer row shows its needs-you count from the snapshot it already holds (no dialing); with two or more computers an "All computers" screen merges Inbox and Usage, with a per-computer status strip that shows a failed listing and its Try again. | `AllComputersTest`; source pins. |
| A59 | `57804cf`, `8020796` | A mic button in the terminal input bar uses `SpeechRecognizer`; the words go into the draft (cursor after them) and are never sent. No on-device Whisper and no `/v1/transcribe` (that endpoint does not exist yet). | `DictationTest`; source pins. |
| A27 | `8691e6d`, `9b5c342`, `1d8201f`, `c450e16` | (a) The direct-SSH browse reads a Server Edition (`~/.nodeterm-server`) and a host a desktop drives over SSH (both tmux sockets, the per-project status slices); a node no listing names is never offered the relay, so a phantom `nt-<id>` cannot be created. (b) "Add SSH server": add a computer by address, show the phone's public key line for `authorized_keys`, pin the host key after auth, SSH only; the `ssh-` id prefix keeps an added computer added across an older build's rewrite. | `HostBrowseTest`, `ManualHostTest`, SSH transport tests. |

### WP6 batch C (CI, test harness and docs): done on the branch

| Finding | Commits | What changed | Checked by |
|---|---|---|---|
| A60 | `67e6297` | The interop bundle aliases `electron` to a throwing stub instead of loading the real package (whose binary was downloaded at test time); a failed fixture start kills its node process. | `InteropHarnessTest` (no `require("electron")` in the bundle; a never-ready start leaves no process). |
| A62 | `77c760d`, `bf24cfc` | The SSH tests make a short, realpath'd tmux socket root (macOS's 103-character limit) and drive either util-linux or BSD `script`; POSIX-only helper tests skip elsewhere. | `SshTestHostTest`; not run on a Mac. |
| A70 | `68d5da6` | The fixture is bundled through esbuild's JS API by `node` (no `.bin` shim for CreateProcess); the pairing fixture pins its platform and the test isolates `USERPROFILE`. | Bundle byte-identical to the old CLI output; not run on Windows. |
| A67 | `696fd10` | `tsconfig.node.json` includes the interop fixture, so `npm run typecheck` checks it; `HostSessionOptions.pty` narrowed to `HostPtyManager`, removing the fixture's cast. | `npm run typecheck`; a guard test pins the include and bans the casts. |
| A63 | `b3d4c6e`, `9d19bd1` | `android.yml` runs on every file the fixture bundles (`src/core/**`, `src/shared/**`, `src/main/*.ts`, `src/main/remote/**`, `package*.json`, `tsconfig.json`) and on the docs the tests read; the list is derived from esbuild's metafile. | `WorkflowPathFilterTest` re-derives it. |
| A64 | `f9782da` | The relay `projects.list` blob comes from `buildProjectsListBlob` (one assembly for `index.ts` and the fixture); mirror entries from the real writer. Docs now say which contracts are still hand-copied. | vitest `projects-list-blob.test.ts`; a guard test refuses a hand-written blob. |
| A69 | `6f3a8da`, `4806b92`, `86d059d` | `setup-gradle` (wrapper validation, a read-mostly cache) in every Gradle job; Dependabot `gradle` for `/android` with the network/crypto stack in its own group; a Kotlin CodeQL job built under CodeQL (`build-mode: manual`), moved into `android.yml` by `86d059d` so a branch push runs it (`security.yml` has no `workflow_dispatch` and runs only on `main`/PRs/the queue). The gradle-8.14.3 distribution checksum is not pinned yet (no network here). | `GradleCiCoverageTest`. |
| A61 / A71 | `39e7995`, `9d19bd1` | Docs: an existing `npm install` is enough for the interop tests; `npm ci --ignore-scripts` is CI's and replaces `node_modules`. JDK 17–24 (Gradle 8.14.3 cannot start on 25). | `ContributorDocsTest`. |
| A65 / A50 | `33af5e7`, `d092639` | `docs/android.md` gets the numbered device checklist; the READMEs say the debug APK is debuggable, and that a phone exposed over adb needs a new identity (uninstall or clear storage) before re-pairing, not just re-pairing. A signed non-debuggable release is still open (`A50`). | `DeviceChecklistDocsTest`. |
| A66 | `61e218b` | The desktop's Android link reads "nodeterm for Android (build from source)" and is derived from `REPO_URL`. The link resolves once `android/` is on upstream `main`. | vitest `androidAppLink.test.tsx`. |

### WP6 batch B (app-only low-severity items): done on the branch, not device-verified

Most of the logic moved into pure, JVM-tested classes in `android/protocol` (the Compose wiring is
type-checked and source-pinned only). Every item had an adversarial review; the follow-up commits
are listed with it.

| Finding | Commits | What changed | Checked by |
|---|---|---|---|
| A40 | `a38d39d`, `5fb3aea` | `TerminalHandoff` (StreamLease, ViewerSlot, PhoneLaunch): a stream is installed only for the current attach ticket; a phone launch holds its own lease, so Back or backgrounding within the settle delay still writes the line and registers the node. Review follow-up: once a request is on the wire it is not cancelled, and both transports now detach a stream whose caller was cancelled (relay `pty.kill`, SSH client close). | `TerminalHandoffTest`; relay interop and SSH tests for the cancelled attach. |
| A41 | `94a558a`, `0507555` | `InputBar.plan`: Send keeps the draft while detached; byte-sending chips are disabled. The resume offer survives a reattach of the same screen and is re-checked against a fresh listing before it can be tapped. | `InputBarTest`, `ResumeOfferTest`. |
| A45 | `1901939`, `a371483`, `46b0897` | `onRenderProcessGone` handled: a kill reattaches automatically once a fresh WebView reports its size (bounded, visible screen only, monotonic clock); a crash offers "Reopen terminal", and the WebView is rebuilt only when something asks to attach. Renderer priority IMPORTANT, waived when not visible. | `TerminalPageTest`. |
| A46 | `17ee526` | The ⌨ chip clears Compose focus, focuses the WebView, blur/refocuses xterm, and asks the IME after a frame. | Source pins; device check owed. |
| A76 | `6966f25`, `4ef21f0` | "Wake <agent>" over direct SSH for a Sleeping node, only while a shell owns the pane (read before offering and again at the tap), with Ctrl-U first. **Desktop:** the mirror (and the renderer's self-heal report) now drops `hibernated` on a live state or session start, so a CLI resumed outside the desktop's own wake no longer stays Sleeping. | `ResumeOfferTest`; SSH transport test with a real tmux; vitest mirror + agentStatus tests. |
| A43 | `2be5e87` | `BackStack`: per-entry keys for `SaveableStateHolder`, retired keys removed (persisted across process death); Board project and Inbox archive toggle saveable. | `BackStackTest`. |
| A44 | `7988087`, `582bdae`, `46b0897` | `ApiBaseSetting`: system back saves like the arrow; an unedited address is not stored (the built-in default stays a default); leaving by a notification tap or a pairing link saves too; a refused or unusable stored address is flagged in the field. | `SettingsLeaveTest`. |
| A42 | `7debe67` | `NewSessionChoice`: the selection is derived from the current listing; Start is disabled when nothing is offered. | `NewSessionChoiceTest`. |
| A57 | `8dbeb48` | Multi-select questions list their options read-only with "answer in the session". | `QuestionChoicesTest`. |
| A47 | `52df0a3` | The host list asks `SecretStoreCore.contains` (no decrypt, no lock) keyed on a revision flow. | `SecretStoreCoreTest`. |
| A52 | `3780f5a`, `46b0897` | `InboxNotificationText`: no event text in notifications by default ("Show details in notifications" opts in); a public version for lock screens that hide sensitive content. | `InboxNotificationTextTest`. |
| A73 | `e055f37`, `27ee194`, `46b0897` | Live notifications for the watched computer: every successful listing announces, skipping what is on screen (the Inbox tab; the open terminal's node, except a held hook-reply approval, which is not painted). A computer the user left is not announced from pushes. | `LiveNotificationsTest`. |
| A51 | `9b4af70`, `46b0897` | `data_extraction_rules.xml` excludes everything from cloud backup and device transfer; a box key created anew drops the device id so a new one is minted with it. | `PhoneIdentityTest`; device check owed. |
| A77 | `0a2a1aa` | `Modifier.aboveKeyboard`: Scaffold padding, consume, then IME padding, on the terminal, Pair and Settings screens; no `enableEdgeToEdge()`. | Source pins; device check owed. |
| A37 | `ac0923a`, `e0a7883` | Real R8 rules (`-dontwarn` for what jdeps finds missing, keeps for the WebView bridge, name-loaded crypto classes, the worker); release is minified; CI builds `assembleRelease` and checks the named keeps matched. A missing `-dontwarn` fails CI, a missing keep for new reflection does not. | CI job "App release (R8, unsigned)" green on its first run; `R8RulesTest`. |

### WP4 remainder, WP5/WP6 batch A (desktop root causes, protocol-testable items): done on the branch, not device-verified

| Finding | Commit | What changed | Checked by |
|---|---|---|---|
| A13 (desktop) | `b718a04` | The app's own tmux client attaches with `-A` and no `-D` while a relay-served client of the same node is live in this process (found by walking the session table at spawn time: local tmux, sink attached, not over SSH, not the session host). With no phone attached the argv is unchanged. The remote (SSH-project) attach never used `-D`; now pinned by a test. | vitest `pty-relay-coattach.test.ts` (argv, both orders, remote) and `relay-coattach.realtmux.test.ts` (real tmux in the sandbox: `-A -D` kicks a control-mode client with exit 0, `-A` keeps both). Mutation-checked. |
| A72 | `71290de` | A phone-started session (A33's `projectId`/`agentId` on `pty.attach`) now gets the agent-gated hook env (`NODETERM_AGENT_ID`, the approval wait, canvas control by `canControlCanvas`) and a proven pane owner, resolved on the host from the index entry the project id matched. Resolver moved to `host-new-sessions.ts`. | vitest `host-new-sessions.test.ts`, `pty-relay-create.test.ts`, `remote-security.test.ts`. |
| A39 / A75 | `437e359`, `ea19490` | Additive `label`/`email` on the mirror's `settings.claudeAccounts`, written by one shared builder in both shells and the SSH slice. One protocol helper names accounts: settings label, usage label, email, then `Account <first 8>` — never the full UUID; an unlinked config dir shows its last path segment. Used by the picker, the sessions row and the usage card. | Protocol `AccountNamesTest`; vitest mirror test; the interop fixture's settings entry is built by the real desktop builder. |
| A38 | `5ff8f6c` | A ticketed approval is answered while the node is WAITING on a held parent question (the desktop's "gone" still guards an expired hold). The keyed paths keep their exact-state gates. | Protocol QuickActions tests. |
| A56 | `38fa6c4`, `45e21ec` | **Not built, by decision.** A static read of Claude Code 2.1.283 shows option 2 of the permission prompt is conditional: when there is no "don't ask again" row, `2` is "Yes, and switch to auto mode" or "No". A blind `2` can therefore deny or widen permissions. Documented in `docs/android.md` (Known gaps) and `docs/hook-reply-approvals.md`, including that **the iOS "Always allow" has the same hazard** (for @eneskirca). The safe route is a hook-level allow with `updatedPermissions`, which needs a cross-surface design. | Docs only. |
| A58 | `a44f16c`, `144bd40` | Usage pace line ("5h usage pace slower/faster", "on pace" within ±5 points), computed at the usage snapshot's own time, refusing stale or unknown windows; a context ring on approval, question and done cards. | Protocol `UsagePaceTest` (15 cases). |
| A48 | `d383e76` | The seen log is id → time, pruned by age past the 6 h announce window (+18 h margin), claimed and marked under one lock; the old string set migrates as "seen now". | Protocol `SeenLogTest`. |
| A53 | `af587ac`, `ec203db` | OSC 52: the `;` is required, a 16-character selection field at most, 100,000 characters of text (400,000 base64) at most, strict base64 and UTF-8; terminal.js applies the cap before the bridge; a failed or too-large clipboard write shows a toast instead of crashing. | Protocol `Osc52Test`; `TerminalJsOsc52Test` runs the real terminal.js under node. |
| A54 | `32330df`, `ec203db` | `/pair`: a negative, non-numeric or over-64 KiB Content-Length is refused, a length-less body stops at 64 KiB, a 45 s watchdog closes the socket (also on cancellation), and a refusal body is shown as one line of at most 300 characters. | Protocol `PairingClientBoundsTest`; an interop test measures the real answer (606 bytes with the fixture's short token). |
| A49 / A74 | `a40d11b` | The SSH host-key pin is persisted only after public-key auth succeeds. In Auto, a changed host key refuses SSH, shows a warning, and falls through to the relay leg; SSH_ONLY keeps the hard stop. The message points at Settings → "Only through the relay". | SSH transport test (a failed auth does not pin); protocol `SshFallbackTest`. |

### WP4 (medium bugs): done on the branch, not device-verified

| Finding | Commit | What changed | Checked by |
|---|---|---|---|
| A24 | `8e304db` | `SecretStoreCore` (protocol) replaces a stored secret only on positive evidence it is gone (nothing stored, malformed blob, `AEADBadTagException`); anything else is `SecretUnavailableException` and nothing is written. The identity's first write is durable. `SecureStore` generates the Keystore key only when the alias is absent. | `SecretStoreCoreTest` with real AES-GCM. |
| A20 | `d199f03` | `connectLocked` rethrows cancellation on both legs (state back to Idle, no "offline"), and closes an SSH connection that finished dialing after its caller was cancelled. | Type-check + CI build only. |
| A11 / A19 | `de1eded` | `onNewIntent` records the host id (and `setIntent`); a LaunchedEffect opens Hosts → that computer's Inbox. A re-navigated Host screen starts on the Inbox tab (the per-entry state holders of A43 now do what a `key(route)` did here). | Type-check + CI build only. |
| A34 / A36 | `2a273a7` | A34: an armed Ctrl applies to the input bar (`Keys.ctrl`, one control byte, no Enter). A36: a null exit (connection gone) reattaches automatically once the host connection is back — bounded (3 per flapping stretch), only while the screen is showing. | `KeysTest`; the controller is type-checked only. |
| A14 / A15 / A16 | `c58ad65` | A16: the project's `defaultPermissionMode` wins over the global one (both re-validated); its `defaultAccountId` is preselected only while the host still has it. A15: the resume offer is built like the desktop's cold restore (`cd`, `CLAUDE_CONFIG_DIR`, mode; portable `./` cwds resolved). A14: cwd-less projects are no longer offered, and a refused registration shows a notice. | `ModelTest` (4 new cases). |
| A12 | `ab1335c` | New additive desktop verb `node.sendKeys {nodeId, keys}` → `{sent}` via `PtyManager.backgroundWrite` (no throwaway client; short answers only; SSH-project nodes answer `sent:false`). The phone uses it; `sent:false` opens the session; an older desktop gets attach → wait for paint → write → 400 ms linger. | vitest `host-node-actions.test.ts`; relay interop incl. the older-desktop fallback. |
| A31 | `a622e71` | sshj `KEEP_ALIVE` (want-reply, 15 s × 3 misses) instead of `HEARTBEAT`; `run()` has a real deadline that tears the transport down; a command that cannot run drops the connection. HostScreen shows a listing error while connected. | SSH transport test: a hung command returns within its deadline and fires `onClosed`. The keepalive-miss path itself is not exercised. |
| A18 | `10de4b9` | `LifecycleStartEffect` in HostScreen and TerminalScreen: watching and the terminal stream stop on ON_STOP (WebView paused) and resume on ON_START. | Type-check (new stub) + CI build. |
| A21 | `daf15d3` | The switch shows On only when the pref is on AND `areNotificationsEnabled()`; switching on asks for the permission or opens the app's notification settings; the worker does nothing when nothing can be shown; the launch-time ask happens on a fresh start only. | Type-check + CI build only. |
| A22 | `ade7428` | The back stack is `rememberSaveable` (JSON Saver); pairing routes are not restored; routes naming a forgotten computer are dropped; the launch intent applies only on a fresh start. | Type-check + CI build only. |
| A13 | `68d0925` | **Phone side only.** An exit 0 while the session is still listed as live (another client attached with `-D`) reattaches instead of reading "ended". The desktop root cause is open (see below). | Type-check + CI build only. |
| A33 | `0db0b6e` | New optional `pty.attach` fields `projectId`/`accountId`/`agentId` (additive). The desktop resolves the project folder and a local, logged-in managed Claude account itself, applied only when the attach creates the session. The phone sends them for a session it starts. | vitest `remote-security.test.ts` (3 new cases); relay interop through the real handler. |

### What is still open

**Next work, in order** (item lists were written for this session's workflows; re-read each audit
section before starting, since the verifier corrections take precedence):

1. **Finish continuation verification and obtain release inputs.** Reconcile the latest branch
   with these local commits and run the required full checks. The user authorized a local AGP
   release build for this first beta: record its unsigned APK, R8 outputs, source revision, beta
   versions and hashes together after that same build succeeds. CI remains unverified; if using
   the CI path later, push after the required checks, confirm Android CI and download all three
   inputs from the same successful run.
2. **Package and install the private beta, then device pass:** use those verified local-build or
   CI inputs and the local private signing procedure. Run all 64 items in `android.md`. Before
   leaving the computer, also run the README's mobile-data preflight. Record results and turn
   every failure into a finding. No device result has been recorded yet.
3. **Pick a remaining known gap.** Batch D and E are done; do not repeat their completed work.
   Remaining examples: the live backend join contract, offscreen Sleeping nodes and non-Claude
   permission flags. Read-ack ownership is locally fixed in `A82`; finish its full interop and
   device verification. For iOS adoption, @eneskirca should read `relayApproved` and
   `sshHostKeyFingerprints` in the sealed `/pair` answer and `lan` beside `projects.list` output;
   iOS also needs to send `boxPublicKey` there for late-adoption approval and the revoke cut, and
   should key notification seen state by computer.
4. **`A68` last.** `push: branches: [main]` + `pull_request`, no `merge_group` (see the verifier).
   After it, pushes to this branch no longer run the Android workflow until a PR exists, so do it
   when the branch is ready for one. No PR should be opened unless asked.

**Known gaps and caveats:**

- **A13 for direct-SSH phones.** The desktop fix covers phones attached through the relay. A phone
  attached over direct SSH (Android or iOS) is still detached by the app's `-D`, because its tmux
  client is not spawned by this process; the Android exit-0 reattach (`68d0925`) covers it.
- **A56 "Always allow".** Needs a layout-independent answer: the hook replies `allow` with
  `updatedPermissions`, carried by the answer file and `approvals.answer`. That spans the desktop,
  the `~/.nodeterm/pending` contract, iOS and Android, so it needs a design decision. The iOS app's
  blind `2` should be re-checked by @eneskirca.
- **A49 / A74 residuals.** Phones paired before batch E have no anchors and stay on
  trust-on-first-use until they pair again or get a relay listing. A host key sshd serves from an
  `Include` outside `sshd_config.d` or a relative `HostKey` path is not read, so SSH is refused for
  it (Auto falls back to the relay). `pickLanIPv4` reports the first non-internal adapter, which
  may not be the one the phone can reach. A phone that only uses "Only on my network" never gets a
  refresh.
- **A72 project overrides.** A phone-started session gets the agent env and a proven owner, but not
  the project's `.nodeterm/settings.json` env/shell overrides (that read is async and may raise a
  trust dialog).
- **Quick-answer false-success hazards found during batch E.** Local desktop input previously
  used a prefix-matching target and did not cancel copy mode; direct-SSH phone input targeted
  exactly but did not cancel copy mode. Those continuation hazards are locally fixed in `A78`
  and `A79`: both paths pin the resolved pane ID and cancel copy mode before sending, desktop
  deliveries are ordered per node, and an unconfirmed operation never reports success. Full
  checks and phone verification of the reconciled tree remain pending.
- **A33 on an older desktop.** An older desktop ignores the new attach fields, so a Windows host
  still starts phone sessions in the home folder until it is updated.
- **A07 for older pairings.** A device paired without a recorded `relayBoxKey` (before A07, or
  any phone that does not send `boxPublicKey`, which includes current iOS builds) has nothing to
  unpin or cut on revoke and is not approved on a late adoption. Fixing it needs a SAS-approval pin
  to be linked to a device entry, which the approved-devices store does not record.
- **Batch D leftovers.** No git over direct SSH (Source Control needs the relay leg; `A29`). With
  remote access off, New session and board edits are disabled with the reason, where iOS writes
  `project.json` over SSH (`A26`). No FCM push and no Live-Activity equivalent (`A25`). The All
  computers screen is not polled; it refreshes on open, on Refresh and after an answer (`A55`).
  Dictation uses the phone's own language with no picker (`A59`). "Add SSH server" has no one-time
  password bootstrap and does not offer the Server Edition install one-liner (`A27`).
- **Desktop file links, found during A32.** `src/renderer/terminal/file-links.ts`
  `paragraphContaining` has the same walk-up limit A32 fixed in terminal.js: below a run of more than
  32 continuing full-width rows the paragraph it returns does not contain the row, so a link there is
  missed. One-character fix (`MAX_JOIN_ROWS - 1`), owed with its own vitest.
- **A10/A50 trade-off.** The debug key is public by the user's decision. The private-beta packager
  rejects it; a private signer is supplied locally and must be retained for updates. Moving from
  debug to private beta requires a deliberate uninstall/re-pair once. The first retained private
  key is prepared in ignored local state; no real app APK has been built or signed in this session.
- **HostStore leftovers.** `HostStore.upsert` leaves a replaced record's `route.<id>` /
  `relayApproved.<id>` prefs behind (pre-existing).
- **Server-e2e and native-module vitest suites** could not run in this sandbox (`npm ci
  --ignore-scripts` skips the native builds, and there is no `ssh` client); the same 14 tests and 31
  files fail identically on the pre-session commit. Desktop CI does not run on branch pushes here,
  so the desktop changes are checked by targeted vitest files + `npm run typecheck` only.

### WP2 (blockers with decisions): done on the branch, not device-verified

| Finding | Commit | What changed | Checked by |
|---|---|---|---|
| A05 / A17 / A23 / A30 | `3d36d60` | `RelayApprovalGate` (protocol): the background worker dials the relay only for a computer where a relay connect has succeeded (persisted `relayApproved.<id>`), and then with `requireApproved`, so a revoked pin gives up instead of waiting and clears the flag. A refused (Deny) or unanswered approval holds automatic dials until the user taps Try again / Refresh or opens the computer. `RelayConnector` reports typed `RelayApprovalRefused/Timeout/RequiredException`. | `RelayApprovalGateTest`; relay interop through the desktop's real host session: Deny reads as a refusal (fixture gained a reject mode), and a `requireApproved` dial fails fast without showing a code. |
| A07 | `0fa0646` | Option (b), additive. The phone sends its box key inside the SEALED `/pair` body; the desktop pins it (same `updateApprovedDevices`/`pinDevice` a SAS approval writes) when the relay leg was minted, answers `relayPinned: true`, records `relayBoxKey` on the device, and unpins it on revoke unless another pairing of the same phone remains. A plaintext body never pins. PairScreen says "Remote access is on" and tells the user after pairing whether one approval is still owed. | vitest `pairing-service.test.ts` (5 new cases); pairing interop through the real `createPairingService`. |
| A08 | `1cdd2f0` | Chose "refuse and route to the relay". SSH attach runs `attach-session` after a `has-session` check (exit 3), never `new-session`; a session that is not running raises `NeedsRelayException`, and the terminal offers "Open through the relay" (`HostSession.viaRelay`, a relay connection held next to the SSH one), where the desktop creates it with its hook env. | SSH transport tests: nothing is created by the transport or by the script itself. |
| A09 / A28 | `726271a` (desktop), `1cdd2f0` (phone) | **Desktop:** the relay `pty.attach` of an SSH-project node now attaches over that project's ControlMaster (`requireRemote`, host-side freshness and snapshot) or refuses with the host's name — never locally. **Phone:** over direct SSH, attach/keys/approvals/kill for those nodes raise `NeedsRelayException` and read-acks are skipped; the terminal, the Inbox and End session retry through the relay. | vitest `remote-security.test.ts` (4 new cases); SSH transport test for the refusals. |

The original A07 follow-ups (`adoptRelayIfAdvertised` and the live-session revoke cut) landed in batch E: late relay adoption approves a recorded box key,
and revoking a paired phone cuts its open relay session. Older pairings without a recorded key
still need foreground SAS approval. iOS can adopt `boxPublicKey`/`relayPinned` unchanged.

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
| Commits | `a0c07e6` protocol module + the two desktop relay verbs; `2f58918` the Compose app, docs, CI, desktop copy; `2dd539f` this handover; then every fix and feature in the progress log, newest first (`git log` on the branch) |
| PR | none (do not open one unless asked) |
| CI | `.github/workflows/android.yml`: **Protocol**, **App** (`assembleDebug`), **App release** (R8, unsigned), **CodeQL (Kotlin)** and **Private beta checks** on exact takeover-branch pushes or opted-in manual runs. Historical green runs are described above; continuation commits are unpushed and CI-unverified |

What is in the tree:

- `android/protocol` is pure Kotlin/JVM with no Android dependency. It holds the NaCl port, the relay
  client, the host RPC, pairing, direct SSH over sshj, the parsers, and the pure rules the app's
  screens use (most app logic lives here so it can be tested). The remote branch had 589 tests
  before these continuation additions; the full reconciled suite remains to be run. Its JVM tests
  include desktop interop and SSH harnesses. The
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
  - Later additive changes the phone uses: `node.sendKeys` (`A12`, SSH-project nodes over their
    ControlMaster since batch E), the `projectId`/`accountId`/`agentId` fields on `pty.attach`
    (`A33`/`A72`), `relayPinned`, `relayApproved` and `sshHostKeyFingerprints` in the sealed `/pair`
    answer (`A07`, `A49`), `lan` beside the `projects.list` output (`A74`), additive account
    `label`/`email` in the mirror (`A39`), the `-D`-free attach while a relay phone is attached
    (`A13`), the hibernated self-heal in the mirror (`A76`), and the revoke cut (`A07`).
  - The renderer copy now names both phone apps (`PhonePairPopover.tsx`, `PhoneSection.tsx`,
    `lib/links.ts`).
  - CLAUDE.md gained an Android paragraph under Conventions → three surfaces, and CONTRIBUTING.md
    and README.md gained notes.

## What is verified, and what is not

Verified:

- The protocol against the desktop's real code: the relay handshake, SAS, approval wait (and the
  host's decision hold), `projects.list` with its `lan` report, attach/snapshot/input/resize/exit,
  scroll, node actions (quick answers into SSH-project nodes through a fake remote writer), board
  verbs, `git.*` through the real `GitService`, `approvals.answer`, `inbox.ack`, registration, and
  pairing (E2EE `/pair`, the key landing in `authorized_keys`, the relay pin, the SSH host key
  fingerprints from a fixture key directory).
- Relay security properties: no re-key, reflection, replay/reorder, and a foreign key.
- SSH transport against a real SSH server with tmux, including the pin anchors, a host
  certificate, and the Server Edition / driven-host browse.
- The remote `send-keys` line the desktop generates for SSH-project nodes, under a real `/bin/sh`
  and tmux (not over a real ControlMaster).
- The debug APK builds with AGP in CI.

**Not verified:**

- **Anything on a device.** No install, no pairing, no terminal use has happened on a phone.
- The relay join request shape. The client sends `{deviceToken, hostId}` to `POST /v1/relay/join`
  and accepts `pairingToken | token | joinToken` in the reply, but it has not been checked against
  the live backend (the backend repo is not here).
- Release/minified builds on a device. R8 runs for release in CI (`A37`: `assembleRelease` plus
  `tools/check-r8-output.sh`). Local private packaging is implemented, but no actual signed
  nodeterm APK has been made or installed. A retained private signing key is now prepared locally.
- **Caveat on the tests:** since `A64` the relay leg's `projects.list` blob comes from the
  desktop's own assembly (`src/core/projects-list-blob.ts`, shared with `src/main/index.ts`) and its
  mirror entries from the real mirror writer; the session list inside the blob and the mirror's
  `settings` provider are still fixture-authored. The SSH leg's shapes (the v3 index, project files,
  `agent-status.json`, the status slices, the pending/acks files, `relay.json`) are still hand-copied in
  `SshTransportTest`; `docs/android.md` names them. That hand-copying is how `A02` passed its test
  while being wrong on every real desktop.

## Environment notes for a cloud session

- **Google Maven is blocked** (`dl.google.com` / `maven.google.com` answer 403 from the egress
  proxy). AGP cannot resolve, so `./gradlew :app:assembleDebug` does not work in the sandbox. Do not
  retry it or route around it. Instead:
  - Type-check the app with `cd android/tools/typecheck && gradle compileKotlin`. It passed on the
    handover commit.
  - Rely on CI for the real AGP build: push, then read the Android workflow run.
- Maven Central sometimes answers 429. Retrying works.
- System `gradle` is 8.14.3 on JDK 21 in the sandbox; the wrapper pins 8.14.3 and CI uses JDK 17.
- The protocol tests need the repo's `node_modules` (an existing `npm install` is enough; on a
  machine without the native toolchain use `npm ci --ignore-scripts`, as CI does — it replaces
  `node_modules`, so a desktop checkout then needs `npm install` or `npm run rebuild`) and a `tmux`
  on PATH. Run them with
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

Install the CI APK (from the new stable debug key) on a real phone and walk the numbered checklist in
[`android.md` → Device checklist](android.md#device-checklist) (64 items, each naming the finding it
checks).
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

## Decisions made (2026-09-26)

1. **A07**: pin the phone's relay key at pairing (desktop + protocol change, additive). Done.
2. **A08**: refuse cold-create over direct SSH and route to the relay. Done.
3. **A09**: relay-route SSH-project nodes; the desktop attaches them over the project's ControlMaster.
   Done.
4. **Distribution**: a committed public debug key for sideloading (`A10`). Done. A real release
   key/store listing were deferred. The 2026-10-02 continuation prepares a private sideloaded beta:
   sign locally with a retained private key; no public release or store listing is requested.

## Device checklist

Moved to [`android.md` → Device checklist](android.md#device-checklist) (`A65`): one numbered list,
grouped by area, each item naming the finding it checks, including every device check the fix
commits asked for. Nothing on it has been run.

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

Paste this into the next session.

```text
Continue the Android companion work on branch claude/android-ios-parity-75kfem of CPlusPlus17/nodeterm.

Start by reading docs/android-handover.md (progress log, "What is still open", environment notes,
conventions) and docs/android-audit-2026-09.md (fixed findings are marked in the index). 73 of the
77 findings and the batch E follow-ups are fixed on the branch, but nothing has run on a device.

1. When a verified signed APK is available and a phone is connected, run the device checklist in
   docs/android.md (#device-checklist), record results in docs/android.md → "What is verified", and
   turn every failure into a finding. A local build is authorized for this first private beta.
2. Reconcile the latest remote branch and local A78–A82/private-beta commits and finish their
   required full checks. The user authorized this first beta's local AGP build instead of waiting
   for Actions; record unsigned APK/R8/source/version/hash provenance from that same successful
   build. CI remains unverified. Batch D and E are done; keep A68 last, when ready for a PR.
3. Sign locally with the retained private key and expected signer pin, then run the mobile-data
   preflight and all 64 device items on the signed minified APK. When using CI instead, push only
   after required checks, confirm Android CI (including Private beta checks) and take unsigned
   APK/R8/provenance from one successful run. No actual app artifact or device result is claimed
   for this reconciliation yet.

Before each push run the protocol tests (cd android/protocol && gradle test --offline; an existing
npm install at the repo root is enough), the offline type-check (cd android/tools/typecheck && gradle
compileKotlin --offline), and for desktop changes the affected vitest files plus npm run typecheck;
after each push confirm the Android workflow is green. Keep docs/android.md, android/README.md, the
handover and the audit index in sync. Do not open a PR unless asked.
```
