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

`Auto` tries SSH with a 4 s budget and falls back to the relay. Per-computer overrides live in
Settings ("How to reach each computer").

**SSH host key.** Trust on first use, and the pin is saved only once the server has accepted the
phone's key (audit `A49`): a machine that merely answers at the paired address and refuses us never
becomes the pin. A key that differs from the pin is never used over SSH. In `Auto` the connect then
goes on to the relay (`SshFallback`, audit `A74`), which authenticates the computer on its own (the
relay host key from pairing, then the SAS approval), and the host screen keeps a warning up while
connected that way; the relay dial still goes through `RelayApprovalGate`, so a background check
never makes a first relay handshake because of it. "Only on my network" stops with the warning. The
usual cause is benign: the LAN leg dials the DHCP address the computer had at pairing, and another
SSH-running machine now has it (or the phone is on another network using the same range). The
message points at "Only through the relay"; pairing again is the way to trust a reinstalled
computer's new key.

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

**The relay leg next to SSH (audit `A26`).** What needs nodeterm *the app* rather than the machine
— a new session (`projects.registerNode`, and the attach that creates it), board writes
(`projects.ensureBoard|setCardColumn|editCardLabels`), node actions (`node.wake|refresh|rename`) and
`git.*` — is the relay's. `Auto` still keeps the SSH leg as the primary connection when it works;
when one of those verbs is needed, `HostSession.connectionFor` opens the computer's relay leg next to
it on that tap and keeps it until the connection is dropped. Which leg answers is ONE pure decision,
`LegRouting.route` (`android/protocol`, `LegRoutingTest`): the primary connection when its
capabilities include the verb, else the relay leg when the phone holds one (a relay block and a
stored device token — often minted while on SSH by late adoption — and a route other than "Only on
my network"), else unavailable with a reason. The screens ask the same function, so an unavailable
control is shown **disabled with that reason** (New session, the board's card actions, the session
menu's wake/refresh/rename), never hidden; the Source control screen (`A29`) says it in place of the
repository. The relay dial still goes through `RelayApprovalGate` with the caller's trigger: these
are taps (`Trigger.USER`), so the first one on a desktop that has not pinned the phone shows the
approval code on the screen that asked (the host screen, or Source control), and a background path
never makes a first handshake. Answering approvals, read-acks, typing keys and ending a session stay
on SSH.

## Protocol mapping

The standing phone host still speaks the **legacy relay dialect** (`host-service.ts`
`createHostHandlers` + `framing.ts` opcodes), not the rpc.ts tunnel `docs/ios-protocol-migration.md`
describes as the future. The Android client implements what the host actually serves:

| Phone action | Relay (host-service.ts) | Direct SSH |
|---|---|---|
| List projects/sessions/status | `projects.list` → the `--NT-PROJECTS-SPLIT--` blob | same blob, from `workspace.json` + `tmux ls` + `agent-status.json`; the v3 index is resolved like `WorkspaceStore` (folder refs → `.nodeterm/project.json`, SSH refs → `cache`, data refs → `inline-projects/<id>.json`) |
| Open a terminal | `pty.attach` → `{streamId, fresh}` (a session the phone starts adds `projectId`/`accountId`/`agentId`; the desktop resolves them itself — the project folder, the account, the agent's hook env and the pane's owning project — and applies them only when this attach creates the session), Snapshot frames, Output frames; a node of an SSH project is attached over that project's ControlMaster (`requireRemote`) or refused | `has-session`, then a pty exec of `tmux attach-session` — never `new-session`: a session that is not running, or a node of an SSH project, is refused with `NeedsRelayException` and the app offers the relay |
| Type / resize | `OP.Input` / `OP.Resize` frames | channel stdin / window-change |
| Scroll | `pty.scroll` (host writes SGR wheel events) | the phone writes the same SGR wheel events |
| Detach / end | `pty.kill` / `pty.destroy` | close channel / `kill-session` |
| Wake on open | the attach itself: host-service reports the viewer (`remoteViewer.attached` → `agent:wake`) and the desktop wakes a Sleeping node it has mounted; the phone offers nothing, so it never types a second `--resume` | nothing reaches the desktop, so opening a Sleeping node offers the desktop's wake line (the agent's `--resume <id>`, plus the permission mode for Claude only, no `cd` or account: the pane's shell already has both), only while a shell owns the pane (`#{pane_current_command}`, read on open and again at the tap), typed only on a tap, after a kill-line |
| Wake, refresh, rename | `node.wake|refresh|rename` | through the relay leg opened next to SSH (`A26`); disabled with the reason when the phone has none |
| Board | `projects.ensureBoard|setCardColumn|editCardLabels` | reads over SSH; writes through the relay leg opened next to it (`A26`), disabled with the reason when the phone has none |
| New session | `pty.attach` of a fresh `term-…` id, launch line, then `projects.registerNode` | the whole launch goes through the relay leg opened next to SSH (`A26`); disabled with the reason when the phone has none |
| Source control (`A29`) | `git.status\|diff\|stage\|unstage\|commit\|push\|pull\|history {cwd, …}`, `cwd` = the project's folder from `projects.list`; the desktop jails it to its project folders and hands each verb to its `GitService` | through the relay leg opened next to SSH (`A26`); the screen says why when the phone has none. There is no SSH git of its own (see Known gaps) |
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
  Ungrouped), `approvals.answer`, `inbox.ack`, registration, and the `git.*` verbs. What is real is
  the verb routing and its validation; the pty, board, inbox and node-action bridges behind the
  verbs are fakes that record what was asked. The git bridge is not: it is the desktop's own
  `GitService` (`src/core/git-service.ts`, what `hostBridge.git` hands both phone hosts) behind the
  production jail, over a repository the fixture makes in the project's folder (`A29`). The
  `projects.list` blob is the desktop's own: `buildProjectsListBlob`
  (`src/core/projects-list-blob.ts`, which the desktop's `listProjectsOutput` calls too) over a real
  `WorkspaceStore` (it writes the v3 index and the project file, then assembles them) and an
  `agent-status.json` written by the real mirror from Claude hook payloads (audit `A64`).
- **Relay security** — scripted-host tests for: no re-key after ready, reflected boxes (own role)
  dropped, replayed/reordered sequence numbers dropped, boxes under a foreign key dropped.
- **Pairing** — against the desktop's real `createPairingService` with HOME in a temp dir: the
  E2EE-sealed exchange, the key landing in `authorized_keys` under `nodeterm-ios-<deviceId>`, the
  relay leg and its `/v1/relay/device` body, a refused wrong token, and the size of the desktop's
  largest answer (606 bytes, counted through a proxy). Scripted local servers pin the client's
  bounds on an answer from whatever `host:pairPort` a code names: a declared length is refused
  above 64 KiB or below zero before anything is allocated, a body with no length stops at 64 KiB,
  and the whole exchange ends at a 45 s deadline (or when the caller is cancelled) by closing the
  socket, so a server that trickles bytes cannot hold the pairing screen.
- **SSH** — against Apache MINA sshd running every command through a shell, with real tmux on a
  private `TMUX_TMPDIR`: v3 index resolution, attach with keystrokes both ways, cold-start
  detection, literal `send-keys` (a leading `-` is text), answer files, read-acks, host-key pinning.
  No desktop code runs on this leg: the test writes the files the desktop would have (the v3
  `workspace.json` index and project files, `agent-status.json`, the held request in
  `~/.nodeterm/pending`), and checks what the phone writes against file names copied from
  `pending-approvals.ts` and `ack-sweep.ts`.
  A command without a pty runs as `/bin/sh -c <cmd>`. One that asks for a pty runs under `script(1)`
  in place of sshd's pty: util-linux's `script -qfec <cmd> /dev/null` on Linux (which runs `<cmd>`
  through `$SHELL`), BSD's `script -q /dev/null /bin/sh -c <cmd>` on macOS. They are told apart by
  `script --version` and a probe (`SshTestHost.kt`); with neither, or without tmux, the class skips.
  The temp root is short and resolved (`/tmp` first): under macOS's `/private/var/folders/…` the
  socket path passed the 103-character `sun_path` limit (audit A62). Only the Linux leg has run.
  One tmux fact measured along the way: an exact-match **pane** target is `=name:`, not `=name`
  (tmux 3.4 answers "can't find pane").

The **app** module is built by CI (`.github/workflows/android.yml`) against the runner's Android
SDK. The first run, [36109984730](https://github.com/CPlusPlus17/nodeterm/actions/runs/36109984730)
on `2f58918`, built the debug APK successfully. CI also builds an unsigned release APK, the only build
type R8 minifies (audit `A37`). A missing `-dontwarn` then fails CI instead of the first release,
because R8 reports the missing class. `tools/check-r8-output.sh` then checks that these existing
keeps for code reached by name matched: the WebView bridge's methods, the WorkManager worker's constructor,
BouncyCastle's provider tables, and one exception class's name (error text can fall back to it). A
missing `-keep` is otherwise not detected: R8 renames or drops code it cannot see used and reports
nothing, so a new reflection or name-dependent target (a new `Class.forName`, a class a library loads
from a string) builds green without its keep. It needs its own keep and a line in
`tools/check-r8-output.sh`. `R8RulesTest` re-derives the classes Android lacks from the jars the
protocol module ships to the app, and requires a keep for every WorkManager worker in the app sources.
The debug APK stays unminified and is the one distributed. The app has no instrumented tests and has
**not been run on a device**, minified or not; the [device checklist](#device-checklist) below is what
a first device pass has to run. An audit of the code found release blockers; the fixed ones are
marked in its index, and the rest are open: [`android-audit-2026-09.md`](android-audit-2026-09.md).
The plan and the decisions still open are in [`android-handover.md`](android-handover.md).

A test caveat (audit `A64`): the relay leg's `projects.list` blob and mirror now come from the
desktop's code, but the SSH leg still hand-copies desktop shapes — the v3 index and project files,
`agent-status.json`, and the `~/.nodeterm/pending` and `acks` files — and nothing tests
`~/.nodeterm/relay.json`. A desktop change to one of those fails no Android test; it needs the
matching hand edit in `SshTransportTest`. That is how a wrong userData path (`A02`: the desktop's
directory is `node-terminal`, not `nodeterm`) once passed its test; the fixture now uses the real
name, and `SshScriptsTest` runs the prelude under `/bin/sh` against both spellings. The parser unit
tests (`ModelTest`, `UsagePaceTest`) also feed hand-written blobs, on purpose: they pin how the
client reads malformed and edge-case input, not what the desktop writes.

Since the audit, the SSH tests also cover: resize/keystrokes/close from a thread that must not do
network I/O (a JVM stand-in for Android's StrictMode, `A01`), a transport that breaks mid-write
(`A01`), and non-ASCII through an attach whose host sets no locale (`A03`). The relay interop tests
cover an approval answered after the hook's hold ended (`A06`), and the desktop tests run the
generated SSH answer command under a real `/bin/sh`. `QuickActionsTest` pins which node state each
Inbox quick answer needs (`A38`): a ticketed approval is judged by its card, so it is answered while
the node still shows WAITING for a held question; keys are typed only for a ticketless approval on a
BLOCKED node or a question on a WAITING one. `QuestionChoicesTest` pins what a question card shows
(`A57`): a single-select question keeps its answer buttons, while a multi-select one lists its options
numbered and read-only under "Choose several — answer in the session." beside "Open session", and
`QuickActions` never types into it. The card's drawing is pinned in the source and only type-checked.
`UsagePaceTest` pins the Usages pace line (`A58`): no line
without a reset time, 300/10080-minute defaults for the session/weekly kinds (Claude reports no
window length), none for an unknown kind, and injected clocks; the elapsed share is taken at the
account's `updatedAt` (when the percentage was measured), so a stale snapshot never drifts toward
"slower". `Osc52Test` pins OSC 52 copy
(`A53`): parsed like the desktop's `parseOsc52` (the `;` is required, a `?` read query is refused,
base64 and UTF-8 are decoded strictly), but capped at 100,000 characters, because the clipboard
write is a binder call whose buffer (about 1 MB, shared) the desktop's 1,000,000-character base64
cap does not respect. `TerminalJsOsc52Test` runs the app's real `terminal.js` in node against stub
xterm/bridge objects and checks that it applies that cap before a copy crosses the WebView bridge.
The app also catches a failing `setPrimaryClip` and says so in a toast; that part is not tested.

An SSH test pins that a server which completes the key exchange and then refuses the phone's key
(or user) leaves the host-key pin empty (`A49`). `SshFallbackTest` pins what follows a failed SSH
leg (`A74`): a changed key goes on to the relay in Auto with a warning, stops on the SSH-only route,
and its text names "Only through the relay" rather than only re-pairing. The app's use of it (the
relay dial behind `RelayApprovalGate`, the warning on the host screen) is only type-checked.

`TerminalHandoffTest` pins the terminal screen's attach hand-off (`A40`). A stream that arrives
after the screen left (back, or the app going to the background), or from an attach a newer one
replaced, is detached instead of shown. A session the phone starts keeps its stream until its launch
line is typed and the node is registered, even when the user leaves during the settle delay: the
request was consumed to get there, so a launch dropped half-way could not be retried, and would
leave an unregistered shell no canvas shows. Going to the background cancels a connect or an
approval wait, but never an attach already sent: that one still arrives, so it can be let go of and
hand its launch on. The terminal screen's use of these rules is only type-checked (its source is
pinned). Both transports also keep the `HostConnection.attach` contract that a cancelled attach
leaves nothing attached: the relay sends `pty.kill` for a stream whose caller gave up while the
request was on the wire (`RelayInteropTest`, through the desktop's real host: its viewer on the node
is released), and SSH detaches a stream whose blocking open finished after its caller was cancelled
(`SshTransportTest`: no tmux client stays attached).

`InputBarTest` pins the terminal input bar's Send (`A34`, `A41`). While no stream is attached
(connecting, disconnected, ended), nothing is sent: the screen keeps the draft and an armed Ctrl
stays armed, instead of clearing text that reached nothing. Attached, Ctrl plus one character sends
that control byte alone, and anything else goes as a paste followed by Enter. The screen disables
Send, the Resume offer and the sending key chips while nothing is attached; that part is only
type-checked. An unanswered Resume offer stays on screen, disabled, through the reattach, and can
be tapped again once the reattach has settled it (see `ResumeOfferTest`).

`TerminalPageTest` pins what happens when the terminal WebView's renderer process goes away
(`A45`). The app handles `onRenderProcessGone` instead of being killed with the renderer: it
detaches the stream, destroys that WebView and builds a new one. Each page has a generation, so a
callback the dead page posted just before the loss cannot mark the new page ready, and JavaScript
queued for the dead page is dropped rather than replayed into the new one. A paint offered before
the new page exists is kept for it. A renderer the system killed is reattached automatically once
the new page has reported its size. The renderer keeps WebView's default priority while the terminal
is visible and has it waived while it is not, so a kill in the background is expected: it is not
counted, and the terminal is reattached when the screen is started again. A crash is not reattached,
because the reattach would repaint the same screen: the screen offers "Reopen terminal" instead. More
than two kills of a visible terminal within a minute (on a monotonic clock) fall back to that offer
too. Only that automatic reattach builds the new WebView at once; otherwise it is built for the next
attach something asks for, so a page whose renderer dies as it loads is not rebuilt and lost in a
loop. A screen that was showing an answer with its own button (the session ended, the connection
dropped, "Open through the relay", or an earlier "Reopen terminal") keeps it, and nothing
reattaches unasked: over the relay, an attach to a pane that has exited creates a new, empty
session. The offer says the session is still running only when a stream was attached. The WebView
handling itself is only type-checked.

`ResumeOfferTest` pins what the terminal screen offers to type after an attach (`A15`, `A76`). A cold
attach (the computer rebooted; only the relay creates a session) gets the cold-restore line: `cd` into
the node's folder, its managed account, and for Claude the permission mode. A Sleeping (Eco-hibernated) node opened over direct
SSH gets the desktop's own wake line instead, with no `cd` and no account prefix, since the pane's
shell is the one the CLI exited back to (again the permission mode for Claude only). It is offered
only while a shell owns the pane: the phone reads the pane's foreground command
(`#{pane_current_command}`) and requires one of the desktop's own shell names (`isShellCommand`,
src/shared/agents/pane.ts, pinned by the test), the gate the desktop's wake keeps. The Sleeping flag
alone is not enough, because it can outlive the sleep. Until the A76 review the desktop cleared it
in the mirror only through its own wake, so a CLI resumed any other way stayed Sleeping there (codex
reports its start as a live state, which the renderer cleared only in its own store). The renderer
now reports that clear and the mirror applies the same rule to the hook events it records, but an
older desktop does not, and with the desktop app not running nothing hears the resumed CLI at all. So after the phone wakes a codex session, the node can still
read Sleeping, and without the pane check every later open would offer `codex resume` into the
running CLI, as a prompt. Accepting a wake clears the prompt's line first (Ctrl-U, the desktop's
kill-line) and re-checks, at the tap, that the node is still Sleeping and that a shell still owns
the pane. A shell outside the desktop's list (nu, pwsh) gets no offer. Through the relay a Sleeping
node gets no offer: the attach already asked the desktop to wake it. A shallow "Pause session" is
Sleeping in the mirror (it carries no `paused`), so it too gets only the offer, which is the explicit
Resume the desktop's PAUSED chip is; a deep pause leaves no Sleeping flag and gets nothing.
A reattach of the same screen (the stream dropped, the app went to the background) is warm, because
the cold attach created the session, so an unanswered resume is carried through it rather than
re-derived from the attach: it is kept while the computer still builds that same line and has heard
nothing from the node since (its mirror entry's `updatedAt`), re-listed right after the reattach, and
dropped otherwise, since a CLI started in the pane meanwhile would take the line as a prompt. Until
the reattach has settled it, it cannot be tapped. A wake is not carried; every attach re-derives it.
Leaving the screen and opening the node again is a new screen, whose warm attach offers nothing.
`SshTransportTest` runs the offer end to end against the real tmux: the line it types starts the
stand-in CLI in the node's own folder even with a half-typed line left at the prompt, and a stand-in
codex the phone woke, still running under a flag nothing cleared, is not offered the wake again on
the next open. The banner
itself is only type-checked.

`TerminalKeyboardChipTest` covers the key row's ⌨ chip (`A46`), which used to leave the soft keyboard
down: it only called `focus()` in the page. The chip now releases the input bar's focus, gives the
WebView Android's focus, moves the page's focus onto xterm's textarea (blurring it first, because
Blink ignores `focus()` on the element that already has focus, which is the usual state after a tap),
and then asks `InputMethodManager` for the keyboard, after the next frame, so the focus change has
been processed first. The page half runs the real `terminal.js` in node against a textarea stub that
follows Blink's rule. The Android half cannot run on a JVM, so the test pins its order in the source.
Whether the keyboard comes up, and stays up, is a device check.

`SettingsLeaveTest` covers leaving Settings (`A44`). The system back (gesture or button) used to pop
the screen without storing the edited phone name or relay API address; only the top-bar arrow stored
them. Both now run one `leave()`, which stores, then pops. A screen taken away without a back (a
notification tap replaces the stack, a pairing link pushes its screen on top) stores the edits as it
goes, silently. Nothing is stored per keystroke. The relay address must be a full `https://` URL
(`ApiBaseSetting`: a host, no query or fragment); one that is not is left unstored, the field says
so while it is being typed, and leaving shows a message. An unusable address an older build stored
is kept without a message, but the field flags it too. Leaving without an edit stores nothing, and
the built-in relay address is never stored: "Reset to default" forgets the stored address instead.
A phone that stores none follows the default of the build it runs, so storing the default would pin
it to this build's for good. The address rule and the leave decision are unit-tested; the wiring is
pinned in the source, and whether the back gesture reaches it is a device check.

`SourceControlTest` and two relay interop tests cover the Source Control screen (`A29`). The app
already had the client half of the desktop's git bridge (`HostConnection.git`) but no screen used
it. A project's Source control (from its heading on the Sessions tab, or beside the Board's project
picker) now shows the status split into staged, changed and untracked files, a file's diff on either
side, stage and unstage (one file or a whole section), a commit of what is staged, push and pull, and
the last 50 commits. The folder is the project's `cwd` from `projects.list`; there is no free-form
git, only the bridge's typed verbs. The interop tests run them through the desktop's real
`GitService` over a repository in the project's folder, from the status to a pushed commit, and check
that the bridge's refusals ("cwd is outside the shared project roots." for a folder outside its jail,
`..` included; "git is not served on this host." for a desktop without the bridge) reach the phone
as those sentences. A git command that fails on the computer is an answer, not an error: `ok: false`
with git's own message, which the screen shows as it is. The unit tests pin the reading of each
reply (a reply of another shape says so instead of showing an empty repository), the diff colouring
(a `+++` inside a hunk is an added line, not a file header; the view keeps the first 4,000 lines and
says how many it left out), the parameters each verb sends, and that push and pull wait three
minutes rather than the usual 30 s, since the desktop sets no limit on them. Whether it can open at
all is decided before any request (`SourceControlGate`): a project with no folder, one of the
desktop's SSH projects (its folder is on another machine, and the listing does not carry its path),
and a computer the phone reaches only over SSH with no relay leg each get their reason on the
screen. The screen is only type-checked; its wiring (the routing decision, the gate, every call
through `connectionFor(Capability.GIT)`) is pinned in the source.

`InboxNotificationTextTest` pins what an Inbox notification says (`A52`). An approval's notification
used to carry the desktop's tool summary (the command's first line, a file path, a fetched URL), and
a finished turn's the agent's last message. Android shows a notification's full content on a secure
lock screen under its default setting, and a public version changes that only for users who hide
sensitive content, so the event's own text is now left out unless the user turns on **Settings →
Show details in notifications** (off by default). The title keeps the session and whether it needs
you or completed ("Needs you — build-bot"), and the text says the kind ("Needs approval", "Has a
question", "Finished", "Interrupted"). A public version with only that title and the computer's name
is always set. The iOS app does get the detail: the desktop sends the event's title and detail in
the APNs push body (`src/core/push-notify.ts`), and what iOS shows on its lock screen is iOS's own
preview setting. That is a difference in platform defaults, not an Android-only leak. The words are
unit-tested; the notification's use of them and the setting's default are pinned in the source, and
what a lock screen shows is a device check.

`LiveNotificationsTest` covers when notifications are posted (`A73`). The app said they were live
every 8 s while a computer was open, but only the 15-minute background check ever posted one; the
in-app refresh only updated the listing. Now every listing that arrives (the 8 s refresh of the
computer on screen, a change that computer pushes, the background check) runs the one announce path,
so notifications are live for the computer whose screen is open. What the user is looking at is left
out and recorded as seen instead, so no later check announces it: every event while that computer's
Inbox tab is on screen, and what a session's terminal shows while it is attached. That is recorded
even with notifications off, so turning them on later does not announce it either. Recording is
permanent, so it must never claim more than the screen shows (the review of A73): a held hook-reply
approval (it carries a `pendingId`) is announced with its terminal open, because Claude paints that
prompt only once the hold ends; a terminal showing an overlay instead of its pane (ended, relay
offer, approval code, lost view) hides nothing; and one still connecting leaves its session's events
for a later listing, which the attach settles at once from the latest listing. Other computers are not
polled while one is open, so theirs still come only from the background check, and the Settings
text, the README and the notifier's comment now say exactly that. A computer the user just left is
one of them: its connection can stay open until it drops or the background check closes it, and a
change it pushes meanwhile is no longer re-listed (it used to be, and so announced live; the review
of A73). What that push carried is not recorded as seen, so the background check announces it. The
announce costs no network call (the listing already arrived), and the check writes the phone's
seen-log only when something is new. The decision and the screen bookkeeping are unit-tested; the
wiring into the refresh, the worker and the two screens is pinned in the source, and whether a
notification appears on a phone is a device check.

`PhoneIdentityTest` and `BackupRulesTest` cover what leaves the phone (`A51`). `allowBackup="false"`
stops cloud backup, but an app that targets Android 12 or later is still copied by a
device-to-device transfer unless its data extraction rules exclude it. The transfer carried
`nodeterm.hosts` (every paired computer, its SSH pin and the phone's relay deviceId) to the new
phone, while the Keystore-sealed secrets could not follow. The manifest now names rules that exclude
every domain from both cloud backup and device transfer, so a new phone starts unpaired.
`BackupRulesTest` pins those files and checks that every preferences file the app opens is covered;
what a real transfer copies is a device check. Independently of the rules, the relay deviceId now
goes with the box key (`PhoneIdentity`): when the key has to be created (absent, or provably lost),
the stored deviceId is removed first, durably, and a deviceId is minted only once the key exists. A
phone whose key was lost therefore registers with the relay backend under a new id instead of
re-registering the old one without its previous device token, which the free tier can refuse (per
the desktop's note on `priorDeviceToken` in `pairing-service.ts`; the backend is not in this repo).
From this build on, it also no longer shares a device row with the phone it was copied from, so
removing one pairing on an entitled desktop cannot revoke the other phone. The old row is left unused
on the backend, as after an uninstall. An existing install keeps its id while its key still opens,
so a phone whose key an older build already replaced keeps the id it had (and any row it shares)
until the app is reinstalled.

`KeyboardInsetsTest` covers the soft keyboard on Android 15 (`A77`). The app targets API 35, so on
Android 15 its window is edge-to-edge whether it asks or not: the keyboard no longer resizes the
window, and its inset reaches Compose instead. The terminal screen added the keyboard's inset on top
of the Scaffold's padding, which already held the navigation bar, so with the keyboard up the
navigation bar was counted twice. Pair and Settings, whose text fields sit in a scrolling column,
made no room for the keyboard at all. All three now go through one helper (`aboveKeyboard`), which
consumes the Scaffold's padding before it adds the keyboard's inset, and which comes before the
scroll, so the keyboard shrinks the visible part instead of padding the end. The app still does not
call `enableEdgeToEdge()`: on Android 8 to 14 the window keeps fitting the system bars and makes room
for the keyboard itself, as before, and the helper adds nothing there. Text fields in dialogs are left
alone: a dialog is a floating window, and the framework clears inset fitting only for non-floating
windows (read from Android 15's `PhoneWindow` classes, not measured). The test pins the helper, that
nothing else asks for the keyboard's inset, and that every Scaffold body with a text field uses it;
how the screens and the dialogs look with the keyboard up is a device check.

## Device checklist

Nothing in this section has been run. CI builds the APK, but no row of the README's feature table and
no fix above has been checked on a phone: the tests stop at the JVM, and the app's screens are only
type-checked. Run these on a real phone against a real desktop and record, for each item, pass or
fail, the phone model, its Android and WebView versions, the desktop's OS and nodeterm version, and
the route (network or relay). Write the results into "What is verified, and how" above, and turn each
failure into a new finding. Every item names the audit finding it checks; `A65` marks the baseline
checks that finding asked for, where the feature table is the only claim. An item that needs
something a tester may not have (a Windows desktop, Android 15, a second phone, a release key) says
so; skip it and record why. The list starts from the 23 items the handover drew up and adds what each
later fix left to a device.

### Install, update and what stays on the phone

1. Install the CI debug APK (artifact `nodeterm-android-debug`) and pair a computer. Install the next
   CI APK over it without uninstalling: it installs as an update and the pairing is still there.
   *(A10)*
2. Pairings survive a restart: force-stop the app, reboot the phone, reopen the app. The computer is
   still listed and connects on both routes without pairing again, the desktop's Settings → Phone
   still shows one entry for this phone, and no new relay approval is asked for. *(A24, A65)*
3. Uninstall, then install again: the app starts with no computers (its Keystore key and data went
   with it). Pairing the same computer again works, relay included, also on a desktop without Pro.
   Revoke the stale entry on the desktop. Then do it once more with Clear storage (Android Settings →
   Apps → nodeterm → Storage) in place of the uninstall. After either one the phone has a new
   identity, which the README's recovery after adb access depends on: on a macOS or Linux desktop the
   key the new pairing adds to `~/.ssh/authorized_keys` differs from the stale entry's, and the box key
   the desktop pins (`remote-approved-devices.json` in its app data) differs from the old one.
   *(A51, A65, A50)*
4. Android 12 or later, with a second phone: a device-to-device transfer ("copy apps and data" in the
   new phone's setup) leaves the app there with no computers and no pins. Pair it too, then revoke
   one of the two phones on an entitled (Pro) desktop: the other keeps working. A cloud backup
   restored onto a fresh install brings back nothing of the app either. *(A51)*
5. Once a release signing key exists: install the signed, minified release APK and run the pairing,
   SSH, relay, OSC 52 copy and background-notification items on it, since that is where code R8 could
   have broken runs (BouncyCastle's provider tables on the first connect, the WebView bridge, the
   WorkManager worker). An error message names a real exception class, not an obfuscated one.
   `adb shell run-as dev.nodeterm.android` is refused on it, while on the debug APK it opens a shell
   in the app's data, which is what the README's debuggable warning says. *(A37, A50)*

### Pairing

6. Pair by QR from the Pair screen's scanner with a macOS desktop, then a Linux desktop, then a
   Windows desktop. The Windows QR carries `"ssh":false`, so that pairing is relay-only, and a failed
   relay mint pairs nothing. *(A65)*
7. Pair by pasting the code's text, and by scanning the desktop's QR with the phone's own camera app.
   The desktop's QR is raw JSON by default, which a camera app shows only as text: check that nothing
   opens. For the camera, first choose "Scan with the phone's Camera app instead" under the QR in the
   desktop's Settings → Phone (the quick-pair popover has no such switch); that QR carries the
   `nodeterm://pair?code=…` link, which the camera hands to the app. Scan it once with the app closed,
   once with it open on another screen. Deny the camera permission: pasting still pairs. *(A65)*
8. With remote access on, against a current desktop: the Pair screen says "Remote access is on", the
   pairing ends with "Paired, and approved for remote access.", and the first relay connect later
   raises no SAS dialog on the desktop. Revoke the phone there (Settings → Phone → Revoke): SSH is
   refused, and a relay connect needs the SAS approval again. Against an older desktop the toast says
   an approval is still owed, and the first relay connect shows the code. *(A07)*
9. A pairing code whose computer does not answer (the desktop quit after showing the QR, or the phone
   is on another network) ends within about 45 s with a sentence, not an exception name, and Back
   during the wait works without a hang. An expired or already-used code shows the desktop's one-line
   refusal. *(A54)*

### Connecting

10. On the LAN (route Automatic): the Sessions tab shows the desktop's projects and sessions, grouped
    Needs you / Running / Sleeping, with activity and context %. *(A02, A65)*
11. The first connect over the network pins the computer's SSH host key, and later connects use it
    silently. Then present a different key at that address (another SSH-running machine takes the
    desktop's LAN address, or the desktop's host keys are regenerated): on Automatic the phone refuses
    SSH, connects through the relay and keeps a warning on the host screen that names "Only through
    the relay"; on "Only on my network (SSH)" it stops with the warning. *(A49, A74)*
12. On cellular, off the LAN: connect through the relay. The desktop shows the SAS dialog and the phone
    shows the same code; approve. Reconnect later: no second prompt. On another pairing press Deny: the
    phone says it was not approved and does not dial again until Try again. *(A65, A30)*
13. Leave the phone in the background for 15 minutes or more with a paired computer that has never
    approved it over the relay: no SAS dialog appears on the desktop. *(A05, A17, A23)*
14. Put the desktop to sleep (or pull its network) while the phone is connected over SSH: within about
    45 s the phone notices, and on Automatic it moves to the relay or says the computer is offline.
    Waking the desktop reconnects. *(A31)*
15. Open a computer and go Back before it has connected, several times in a row: no connection error
    is recorded for it, and the next open connects normally. *(A20)*
16. Change a computer's route in Settings → How to reach each computer and check that the next connect
    follows it; forget a computer; pair two computers and move between them. *(A65)*
17. Pair while the desktop's remote access is off, then turn it on and open the computer over the
    network: the host list gains "From anywhere" without the app being restarted, and a relay connect
    then works (after one approval, since this path does not pin). The host list stays smooth while a
    connection is being made. *(A47, A65)*

### Terminal

18. Open a terminal over SSH and type with the soft keyboard. Rotate the phone. Use A−/A+ and every
    key chip (Esc, Tab, ⇧Tab, the arrows, ⏎, ⇧⏎, ^C, ^D, ^R, ^L, Home, End, PgUp, PgDn): the
    connection survives all of it. *(A01, A04)*
19. Non-ASCII renders over SSH: Claude's rounded borders, accented letters, CJK, emoji. *(A03)*
20. Swipe to scroll the tmux history. Select text in tmux: the copy reaches Android's clipboard (OSC 52)
    with a "Copied N lines" toast. *(A65)*
21. A large OSC 52 copy. In the pane, run
    `printf '\033]52;c;%s\a' "$(head -c 150000 /dev/zero | tr '\0' x | base64 | tr -d '\n')"`
    (the desktop's tmux passes an application's OSC 52 on): the phone says it is too large to copy and
    nothing crashes. With 450000 in place of 150000 the page refuses it before it crosses the bridge,
    with the same message. With 90000 it is copied, or, if the system refuses a clip that size, "Could
    not copy: too large for the clipboard." shows; never a crash. *(A53)*
22. Invalid OSC 52 is ignored silently: a payload that is not base64, one with no `;`, a `?` read
    query, and a selection field longer than 16 characters copy nothing, show nothing and leave the
    clipboard as it was. *(A53)*
23. "Sized to another screen · Fit this screen" appears when the desktop's view of the session is
    larger, and Fit works. *(A65)*
24. The ⌨ chip raises the soft keyboard, and it stays up, in three states: right after the terminal
    opens, before the page was ever touched; after tapping the terminal and then dismissing the
    keyboard (the page's input already has focus); and while the input bar has focus. The keys then
    go to the pane, not to the input bar. *(A46)*
25. With a terminal open, turn on airplane mode: the input bar's draft stays (Send, the sending key
    chips and Resume are disabled, and the keyboard's Send leaves the text in place). Turn it off: the
    terminal reattaches by itself ("Disconnected. Reconnecting…" clears) and the draft then sends. Arm Ctrl and send "c" from the input bar: the
    pane gets ^C, with no Enter after it. *(A41, A34, A36)*
26. The terminal WebView's renderer goes away. A kill while the terminal is on screen: the app stays
    open and the terminal is rebuilt and reattached by itself; a third kill within a minute offers
    "Reopen terminal" instead. A crash offers "Reopen terminal", never an automatic reattach. A kill
    while the app is in the background: the terminal is back when the app returns. A kill while the
    screen shows "The session ended", "Open through the relay" or "Reopen terminal": that answer stays
    and nothing attaches. One way to provoke them, not tried: on an emulator with `adb root`, `kill -9`
    the WebView's renderer process for a kill; a crash needs the renderer itself to crash (for
    example `chrome://crash` from DevTools). *(A45)*
27. Send the app to the background with a terminal attached through the relay, for a few minutes: the
    desktop's view of that session is no longer held to the phone's size, and the 8 s refresh stops.
    Coming back reattaches. *(A18)*
28. On the desktop, open the project of a session the phone is attached to, so the desktop mounts that
    node: through the relay the phone stays attached; over direct SSH it may be detached, and then
    reattaches by itself rather than saying the session ended. *(A13)*
29. A Sleeping (Eco) session opened over direct SSH offers "Wake <agent>" while a shell owns its pane.
    The tap wakes the conversation, and opening it again (the CLI now running) offers nothing. Through
    the relay, opening it wakes it with no offer. *(A76)*
30. Reboot the desktop, then open a session through the relay: the resume offer appears, and Resume
    continues the right conversation, in the node's folder, under its Claude account and with the
    project's permission mode. Drop the connection before tapping it: the offer comes back with the
    reattach and can be tapped once the reattach has settled. Over direct SSH such a session is not
    created: the phone offers "Open through the relay". *(A15, A16, A41, A08)*
31. A session of one of the desktop's SSH projects: over direct SSH the phone offers the relay
    instead, and through the relay it opens on that project's host. *(A09, A28)*

### Sessions, the board and new sessions

32. New session from the phone (Claude, then a shell), through the relay: the node appears on the
    canvas, the agent runs in the project's folder, and its status badges update on both sides; a
    Claude permission prompt reaches the phone's Inbox as an approval. Managed Claude accounts are
    named by their label or email in the picker, the session row and the Usage card, never by an id.
    Repeat against a Windows desktop: the session starts in the project's folder under the chosen
    account there too. *(A72, A33, A14, A39, A75)*
33. New session, then Back within a second of Start (before the launch line is typed), and once more
    by sending the app to the background right after Start: both times the node still appears on the
    canvas with its agent running, not a bare shell. *(A40)*
34. With the New-session dialog open, close the selected project on the desktop (or remove the
    selected account): within a refresh the dialog moves to a project it still offers, or disables
    Start with a line saying why; nothing crashes. *(A42)*
35. Wake, refresh, rename and end a session from the phone. *(A65)*
36. Board: move a card, add and remove a label, create a new one; the desktop's board updates without a
    reload. *(A65)*
37. On the Board tab, pick a project and scroll; open a terminal and come back: the same tab, scroll
    position and project. Switching tabs and back keeps them too. *(A43)*
38. Kill the app's process in the background (Developer options → "Don't keep activities", or
    `adb shell am kill dev.nodeterm.android`) and reopen it: the screen and the back stack are
    sensible, and the tab is kept. *(A22, A43)*

### Inbox, notifications and usage

39. Approve and deny a held Claude permission from the Inbox within 45 s. Answer one after its hold
    has expired: the phone must not report success. *(A06, A35)*
40. A subagent's approval while its parent waits on a question: Approve from the Inbox answers it,
    rather than saying "Already handled." *(A38)*
41. Answer a single-select AskUserQuestion from the Inbox, through the relay and over the network: the
    answer lands in the live session in one tap. A multi-select question lists its options read-only
    beside "Open session". *(A12, A57, A65)*
42. Open a finished session on the phone: the desktop's unread dot clears. *(A65)*
43. A background notification arrives within about 15 minutes; tapping it opens that computer's Inbox,
    also when the app is already open on another computer. *(A11, A19)*
44. Notification permission on Android 13 or later: deny it at first launch; Settings → Notifications
    then reads Off; switching it on asks again or opens the app's notification settings; nothing is
    posted while it is denied. *(A21)*
45. Live notifications for the computer on screen: with its Sessions tab open, a turn finishing on the
    desktop raises a notification within about 8 s; with its Inbox tab open, none, and none later;
    with a session's terminal attached, none for that session, except a held hook-reply approval.
    Another paired computer's events arrive only from the background check. *(A73)*
46. Each event notifies once: an event announced once is not announced again by later refreshes, by
    the background check, or after the next APK is installed over this one. *(A48)*
47. The lock screen: with "Show details in notifications" off (the default), a notification shows its
    title ("Needs you — <session>" or "Completed — <session>"), the kind and the computer, but no
    command, question or last message; turned on, the shade shows those too. With the lock screen set
    to hide sensitive content, only the title and the computer's name show there, either way. *(A52)*
48. The Usage tab shows a pace line ("5h usage pace faster", "slower" or "on pace") when a limit's reset
    time is known, and none when it is not. Approval, question and done cards show the node's context
    ring and "N% context", matching the desktop's meter. *(A58)*

### Settings and system UI

49. Settings: edit the phone's name and the relay API address, then leave with the system back gesture:
    both are stored (reopen Settings to see). An address that is not a full `https://` URL shows the
    field's error and a toast on leaving, and is not stored. "Reset to default" forgets a stored
    address. Leaving without an edit stores nothing. *(A44)*
50. Android 15 (edge-to-edge) with the soft keyboard up: the terminal sits right above the keyboard
    with no extra gap the height of the navigation bar, and the Pair and Settings text fields scroll
    into view above it; the label and rename dialogs look right. On Android 8 to 14 the same screens
    are unchanged. *(A77)*
51. Light and dark system theme; a tablet or a foldable if one is available. *(A65)*

### The relay leg next to SSH

52. On the same network as the computer, with remote access on and the route Automatic (the host
    screen says "On your network"): New session starts a session that appears on the canvas; a card
    moved or labelled on the Board moves there; Wake, Refresh and Rename from a session's menu act.
    On a desktop that has not pinned this phone, the first of these shows the approval code on the
    host screen. With remote access off (re-pair with it off), and again with the route "Only on my
    network", the New session button, the card actions and the menu items are shown disabled with a
    reason that matches the case, and none of them opens a relay connection. *(A26)*

### Source control

53. From a project's heading (Sessions) or beside the Board's project picker, open Source control,
    through the relay and again on the same network (the relay leg next to SSH): the branch, the
    staged, changed and untracked files and the recent commits match the desktop's Source Control;
    a file's diff opens and Back closes it; stage, unstage, commit (the message box stays above the
    keyboard), push and pull act and the desktop shows the result; a push that fails there (no
    network, a rejected push) shows git's own message. An SSH project and a project with no folder
    say why instead of opening. *(A29)*

## Known gaps

- **Push.** No FCM leg exists in the backend; the app polls (see android/README.md). The backend's
  `/v1/push/*` fan-out is APNs-only.
- **`/v1/relay/join`.** The request/response shape is not in this repo (the backend is separate).
  The client sends `{deviceToken, hostId}` and accepts `pairingToken`, `token` or `joinToken` —
  unverified against the live backend.
- **Direct SSH is POSIX-only by design** (like iOS): board writes, node actions and new sessions
  go through nodeterm the app, so on the LAN the phone opens the computer's relay leg next to the
  SSH connection for them (`A26`, see "The relay leg next to SSH"). iOS writes `project.json` over
  SSH for some of these; Android deliberately does not (the host verbs exist because that write
  breaks past `MAX_ARG_STRLEN` and cannot reach an SSH project's file at all). The cost: a phone
  whose computer has remote access OFF (so it holds no relay leg) cannot do them on the LAN at all,
  where iOS can for a local folder project whose file still fits in one argv string. The controls
  say so instead of vanishing.
- **Source control is the desktop's git bridge, and only that** (audit `A29`). Over direct SSH the
  phone has no git of its own: it opens the relay leg next to SSH for it, as for the other app-only
  verbs, so a phone with no relay leg (remote access off, or the route "Only on my network") cannot
  use it on the LAN, and says so. An SSH implementation (`git -C <cwd>` over the session, jailed to
  the project folders like the desktop's `isWithinRoots`) was deliberately not built: it would be a
  second copy of the bridge's rules on the phone. The bridge serves no branch switch, discard, init,
  publish, per-commit file list or older history (the desktop's default 50 commits), so the phone
  offers none of them. The desktop's SSH projects are not reachable from the phone's Source Control:
  their folder is on another host, the listing does not carry its path, and the bridge's jail is the
  computer's own project folders.
- **A desktop mounting a node can still detach a direct-SSH phone.** The desktop leaves `-D` off
  its own tmux client only while a relay-served client of that node is attached (it spawned that
  one itself, so it can see it). A phone attached over direct SSH is detached (exit 0), and so is a
  relay phone on a desktop older than that change; the app checks that the session is still live
  and reattaches.
- **No "Always allow" on approval cards** (audit `A56`). iOS has one that types `2`, and
  docs/hook-reply-approvals.md is the only place the repo states that digit. Read from the Claude
  Code 2.1.283 bundle (not measured on a live prompt), option 2 depends on the ask: the Bash prompt
  offers `Yes`, then a "don't ask again" row only when Claude has one for this ask, then an
  optional "Yes, and switch to auto mode", then `No`. So a blind `2` can deny the request or switch
  the session to auto mode, and the phone cannot see which. The same hazard applies to iOS's `2`:
  an iOS follow-up for @eneskirca (this repo cannot see whether the iOS code guards the digit).
  A held ticket (the default, since `hookReplyApprovals` is on) has no prompt on screen at all.
  The layout-independent route is the hook's own: answer `allow` with `updatedPermissions` taken
  from the request's `permission_suggestions` (both fields exist in that CLI's hook schema). That
  changes the `~/.nodeterm/pending` answer file and `approvals.answer`, so it needs the desktop,
  iOS and Android together.
- **Multi-select questions are answered in the session** (audit `A57`). The Inbox card lists the
  options, numbered and read-only, but offers no answer: nothing in this repo measures how Claude
  Code's multi-select picker toggles an option or submits the selection, and the phone cannot see the
  picker, so a guessed key sequence could submit the wrong set. Answering from the Inbox needs those
  keys measured on a live CLI, and would keep the still-waiting re-check the single-select digits
  have. Whether iOS answers these cannot be seen from this repo.
- **A Sleeping node the desktop has not mounted stays asleep through the relay** (`A76`). The relay
  attach's wake is the desktop's `wakeHibernatedNode` nudge, which does nothing for a node that is
  not on screen (a project other than the active one), and the phone offers no wake there because
  it cannot tell the two apart: a second `--resume` typed into a CLI the desktop just woke arrives
  as a prompt. Typing the resume by hand, or opening the node over direct SSH, works.
- **Codex/Gemini/… launch flags.** A phone-started non-Claude agent launches bare (its own default
  approval mode): the per-agent approval table needs host facts (codex's vocabulary moved between
  releases, #785) the mirror only partly publishes. The same holds for the resume lines the phone
  offers: a cold-attach resume and a Sleeping node's wake carry the permission mode for Claude only,
  where the desktop's own wake and cold restore append each capable agent's flag. Some of those
  sessions come back looser than their mode: a Gemini or Grok session whose mode is `plan` (read-only)
  resumes in its CLI's default, which can edit after asking, and a Codex node in `manual` on a
  codex before 0.149 loses `--ask-for-approval untrusted` and resumes in `on-request`, where the
  model decides when to ask.
- **The SSH pin is not anchored in pairing, and the LAN address is frozen at pairing** (audit
  `A49`/`A74`). Neither the QR nor the sealed `/pair` answer carries the computer's SSH host key, so
  the first connect is trust on first use (on the pairing LAN, right after the QR, so normally the
  real computer). A server that accepts any key could still become the pin. The fix is desktop-side
  as well (return the host key fingerprints inside the sealed `/pair` answer and store them in
  `PairedHost.from`; it would serve iOS too). Nothing refreshes `PairedHost.host` either: the desktop
  could publish its current LAN address over the relay, letting the phone update it after a relay
  connect.
- **No signed release build** (audit `A50`). The only APK there is to install is the debug build,
  and AGP marks every debug build debuggable: anyone with adb access to the unlocked phone while USB
  debugging is on can read the app's files (`run-as`) and attach a debugger to the running app, whose
  code can use the Keystore key those files are sealed under. That is the phone's pairing
  credentials: the SSH key its computers accept, the relay box secret and the relay device token.
  android/README.md says so under Security. A signed, non-debuggable release needs a release
  `signingConfig` fed from CI secrets, published artifacts, and the README and `ANDROID_APP_URL`
  pointed at them. Until then the desktop's Android link opens the `android/` source folder and both
  phone surfaces label it "nodeterm for Android (build from source)" (`ANDROID_APP_LABEL` in
  `src/renderer/lib/links.ts`, audit `A66`); drop that label when the link points at a release.
- **Instrumented UI tests** and a store listing do not exist yet.
