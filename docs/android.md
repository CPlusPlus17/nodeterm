# Android companion — design notes

`android/` is the Android counterpart of the iOS companion (nodeterm-ios, a separate private repo).
It speaks the protocol the desktop already serves to phones; the only desktop-side additions were
two relay verbs a relay-only phone was missing (below). This doc records what the app relies on,
where each fact comes from, and what is not done.

## The two transports

A phone reaches a paired computer one of two ways, and the app tries them in the iOS order:

1. **Direct SSH** (the LAN leg). Pairing installs the phone's Ed25519 public key in the computer's
   `~/.ssh/authorized_keys` (`src/main/pairing-service.ts`). Everything after that is POSIX `sh` +
   tmux on the computer (`protocol/.../ssh/SshScripts.kt`): the desktop's `-L node-terminal` socket,
   its generated `<userData>/tmux.conf`, `new-session -A` **without `-D`** (the desktop's own client
   must stay attached). PATH is *appended* with the Homebrew dirs, exactly like
   `remoteTmuxPathPrologue`, and the macOS app's bundled `Contents/Resources/bin/tmux` is the last
   resort, as it is for the desktop's `findTmux`. Not available on Windows hosts (the QR says
   `"ssh":false`).
2. **The relay** (from anywhere). E2EE through `wss://relay.nodeterm.dev`, to the standing phone
   host (`src/main/remote/standing-host.ts`). The phone trades its device token for a single-use
   relay token (`POST /v1/relay/join`), runs the handshake, and — the first time only — waits while
   the desktop shows the SAS approval dialog (pin-once).

`Auto` tries SSH with a 4 s budget and falls back to the relay; a changed SSH host key is a hard
stop, never a fallback. Per-computer overrides live in Settings.

**Relay approval.** The standing host raises its SAS dialog as soon as an unpinned phone completes
the handshake, so the phone decides *before dialing* (`RelayApprovalGate`): the background worker
dials only a computer that has approved this phone, and a refused or unanswered approval suspends
automatic dials until the user asks again. A current desktop pins the phone's relay key at pairing
(the phone sends `boxPublicKey` inside the sealed `/pair` body; the answer says `relayPinned`), so
most phones never see the dialog. The pin is dropped when the device is revoked.

**What direct SSH will not do.** It never creates a tmux session (the desktop injects the hook
environment at creation, which the phone cannot reproduce) and never touches nodes of the desktop's
SSH projects (they live on another host). Both surface as `NeedsRelayException`, and the app opens
the session through a relay connection held next to the SSH one (`HostSession.viaRelay`).

## Protocol mapping

The standing phone host still speaks the **legacy relay dialect** (`host-service.ts`
`createHostHandlers` + `framing.ts` opcodes), not the rpc.ts tunnel `docs/ios-protocol-migration.md`
describes as the future. The Android client implements what the host actually serves:

| Phone action | Relay (host-service.ts) | Direct SSH |
|---|---|---|
| List projects/sessions/status | `projects.list` → the `--NT-PROJECTS-SPLIT--` blob | same blob, from `workspace.json` + `tmux ls` + `agent-status.json`; the v3 index is resolved like `WorkspaceStore` (folder refs → `.nodeterm/project.json`, SSH refs → `cache`, data refs → `inline-projects/<id>.json`) |
| Open a terminal | `pty.attach` → `{streamId, fresh}`, Snapshot frames, Output frames; a node of an SSH project is attached over that project's ControlMaster (`requireRemote`) or refused | `has-session`, then a pty exec of `tmux attach-session` — never `new-session`: a session that is not running, or a node of an SSH project, is refused with `NeedsRelayException` and the app offers the relay |
| Type / resize | `OP.Input` / `OP.Resize` frames | channel stdin / window-change |
| Scroll | `pty.scroll` (host writes SGR wheel events) | the phone writes the same SGR wheel events |
| Detach / end | `pty.kill` / `pty.destroy` | close channel / `kill-session` |
| Wake, refresh, rename | `node.wake|refresh|rename` | — (needs the desktop app) |
| Board | `projects.ensureBoard|setCardColumn|editCardLabels` | read-only |
| New session | `pty.attach` of a fresh `term-…` id, launch line, then `projects.registerNode` | — |
| Answer a held approval | **`approvals.answer`** (new) → `{answered}`, plus `reason: gone\|failed` when not | write `~/.nodeterm/pending/<id>.answer` (prints `gone` when the hold ended) |
| Read-ack | **`inbox.ack`** (new) | write `~/.nodeterm/acks/<nodeId>.seen` |
| Quick answer keys (question digits, legacy approve/deny) | **`node.sendKeys {nodeId, keys}`** (new) → `{sent}`, typed through the node's existing session; an older desktop gets attach → wait for paint → write → linger | `tmux send-keys -l` |

`resizedFrames` is deliberately not sent on attach, matching iOS: the phone is a size *ceiling* on
the shared pty. An `OP.Resized` still shows a "sized to another screen · fit this screen" hint.

### Why the two new relay verbs

Both already existed for a phone on SSH — as files it writes on the host. A relay-only phone (every
Windows host, and any phone off the LAN) had neither: `fs.*` is jailed to project roots, correctly.
Typing `1` into the pane is **not** a substitute for answering a held hook-reply approval: while the
hook holds the request the prompt is not on screen, so the keystroke lands in the agent's composer.
`approvals.answer` routes to the same `answerPermission` the canvas Approve/Deny button uses, and
`inbox.ack` runs the same `ackDone` + unread-clear the ack-file sweep runs
(`src/main/remote/host-inbox-verbs.test.ts`). An older desktop answers "not served", which the
phone treats as "open the session" — never a guessed keystroke. The iOS app can adopt both verbs
unchanged.

## What is verified, and how

`android/protocol` has no Android dependency and is tested on a JVM (`./gradlew -p protocol test`):

- **Crypto** — byte-for-byte against vectors generated by the desktop's own `tweetnacl` and
  `node:crypto` HKDF (`scripts/gen-crypto-vectors.cjs`): key derivation, `box.before`, secretbox
  across block boundaries, tamper rejection, session key, SAS, relay host id.
- **Relay** — the Kotlin client against the desktop's real `connectHostSession`/`connectRelay`
  through a local broker: handshake, SAS agreement, approval wait, `projects.list`, attach with
  snapshot paint (including a >256 KB snapshot whose chunk boundary splits a code point), input,
  resize/`OP.Resized`, exit codes, scroll, detach/destroy, node actions, board verbs (`null` =
  Ungrouped), `approvals.answer`, `inbox.ack`, registration.
- **Relay security** — scripted-host tests for: no re-key after ready, reflected boxes (own role)
  dropped, replayed/reordered sequence numbers dropped, boxes under a foreign key dropped.
- **Pairing** — against the desktop's real `createPairingService` with HOME in a temp dir: the
  E2EE-sealed exchange, the key landing in `authorized_keys` under `nodeterm-ios-<deviceId>`, the
  relay leg and its `/v1/relay/device` body, a refused wrong token.
- **SSH** — against Apache MINA sshd running every command through `/bin/sh`, with real tmux on a
  private `TMUX_TMPDIR`: v3 index resolution, attach with keystrokes both ways, cold-start
  detection, literal `send-keys` (a leading `-` is text), answer files, read-acks, host-key pinning.
  One tmux fact measured along the way: an exact-match **pane** target is `=name:`, not `=name`
  (tmux 3.4 answers "can't find pane").

The **app** module is built by CI (`.github/workflows/android.yml`) against the runner's Android
SDK. The first run, [36109984730](https://github.com/CPlusPlus17/nodeterm/actions/runs/36109984730)
on `2f58918`, built the debug APK successfully. The app has no instrumented tests and has **not been
run on a device**. An audit of the code found release blockers; the fixed ones are marked in its
index, and the rest are open: [`android-audit-2026-09.md`](android-audit-2026-09.md). The plan, the device checklist and the
decisions still open are in [`android-handover.md`](android-handover.md).

A test caveat: the fixtures hand-copy some desktop shapes — the mirror, the `projects.list` blob
and the `~/.nodeterm` files (audit `A64`). That is how a wrong userData path (`A02`: the desktop's
directory is `node-terminal`, not `nodeterm`) once passed its test; the fixture now uses the real
name, and `SshScriptsTest` runs the prelude under `/bin/sh` against both spellings.

Since the audit, the SSH tests also cover: resize/keystrokes/close from a thread that must not do
network I/O (a JVM stand-in for Android's StrictMode, `A01`), a transport that breaks mid-write
(`A01`), and non-ASCII through an attach whose host sets no locale (`A03`). The relay interop tests
cover an approval answered after the hook's hold ended (`A06`), and the desktop tests run the
generated SSH answer command under a real `/bin/sh`.

## Known gaps

- **Push.** No FCM leg exists in the backend; the app polls (see android/README.md). The backend's
  `/v1/push/*` fan-out is APNs-only.
- **`/v1/relay/join`.** The request/response shape is not in this repo (the backend is separate).
  The client sends `{deviceToken, hostId}` and accepts `pairingToken`, `token` or `joinToken` —
  unverified against the live backend.
- **Direct SSH is POSIX-only by design** (like iOS): board writes, node actions and new sessions
  need the relay. iOS writes `project.json` over SSH for some of these; Android deliberately does
  not (the host verbs exist because that write breaks past `MAX_ARG_STRLEN` and cannot reach an SSH
  project's file at all).
- **Codex/Gemini/… launch flags.** A phone-started non-Claude agent launches bare (its own default
  approval mode): the per-agent approval table needs host facts (codex's vocabulary moved between
  releases, #785) the mirror only partly publishes.
- **Instrumented UI tests** and a store listing do not exist yet.
