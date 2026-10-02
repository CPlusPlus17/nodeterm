# Android companion — design notes

`android/` is the Android counterpart of the iOS companion (nodeterm-ios, a separate private repo).
It speaks the protocol the desktop already serves to phones; the only desktop-side additions were
two relay verbs a relay-only phone was missing (below). This doc records what the app relies on,
where each fact comes from, and what is not done.

## The two transports

A phone reaches a paired computer one of two ways, and the app tries them in the iOS order:

1. **Direct SSH** (the LAN leg). Pairing installs the phone's Ed25519 public key in the computer's
   `~/.ssh/authorized_keys` (`src/main/pairing-service.ts`). Everything after that is POSIX `sh` +
   tmux on the computer (`protocol/.../ssh/SshScripts.kt`): the `-L node-terminal` socket of a
   nodeterm running on the computer, and the `-L nodeterm-rmt` socket of a desktop that drives the
   computer over SSH (audit `A27`, below), each session reached on the socket it was listed on;
   `attach-session` **without `-d`** (the desktop's own client must stay attached), never
   `new-session` (`A08`). PATH is *appended* with the Homebrew dirs, exactly like
   `remoteTmuxPathPrologue`, and the macOS app's bundled `Contents/Resources/bin/tmux` is the last
   resort, as it is for the desktop's `findTmux`. Not available on Windows hosts (the QR says
   `"ssh":false`). A computer with no pairing code can be added by its SSH address instead, and is
   then reached this way only (audit `A27`, below).
2. **The relay** (from anywhere). E2EE through `wss://relay.nodeterm.dev`, to the standing phone
   host (`src/main/remote/standing-host.ts`). The phone trades its device token for a single-use
   relay token (`POST /v1/relay/join`), runs the handshake, and — the first time only — waits while
   the desktop shows the SAS approval dialog (pin-once).

`Auto` tries SSH with a 4 s budget and falls back to the relay. Per-computer overrides live in
Settings ("How to reach each computer").

**SSH host key.** Anchored in the pairing (audit `A49-anchor`): the desktop's sealed `/pair` answer
names its SSH host keys (`sshHostKeyFingerprints`, the `SHA256:…` of every
`/etc/ssh/ssh_host_*_key.pub` and of the keys `sshd_config` and every file in `sshd_config.d/`
name, read by `src/main/ssh-host-keys.ts`; macOS 10.10 and older kept them in `/etc`). The phone stores them on
the paired computer (`PairedHost.sshHostKeyAnchors`), and its first SSH connect must present one of
them: a server whose key is none of them is refused during the key exchange, before the phone's key
is offered, and nothing is pinned (`HostKeyNotPairedException`). The keys ride only the SEALED
answer, which is bound to the host key the QR on the computer's screen carries; a plaintext answer
could be rewritten on the LAN, so the desktop leaves them out of it and the phone ignores them
there, and the QR does not carry them. A desktop that predates the field, a Windows desktop (no SSH
leg) and one that could not read its keys send none, and the first connect is then trust on first
use as before. Either way the pin is saved only once the server has accepted the phone's key (audit
`A49`): a machine that merely answers at the paired address and refuses us never becomes the pin. A
server that presents a host certificate (sshd's `HostCertificate`, which sshj negotiates whenever it is
offered) is matched and pinned by the key the certificate certifies (`hostKeyFingerprint`), which is how
OpenSSH fingerprints a certificate and what the desktop reports, so a certificate reissued for the same
key is not a changed key; a pin an older build took from the certificate itself still matches it and
is rewritten as the key at the next connect (review of `A74-refresh`). A key that differs from the
pin (or, before the first pin, from every key the pairing named) is never used over SSH. In `Auto`
the connect then goes on to the relay (`SshFallback`, audit `A74`), which authenticates the computer
on its own (the relay host key from pairing, then the SAS approval), and the host screen keeps a
warning up while connected that way; the relay dial still goes through
`RelayApprovalGate`, so a background check never makes a first relay handshake because of it. "Only
on my network" stops with the warning. The usual cause is benign: the LAN leg dials the DHCP address
the computer last reported (at pairing, or since through the relay, below), and another SSH-running
machine now has it (or the phone is on another network using the same range). The message points at "Only through the relay". A reinstalled
computer's new key is trusted again by the refresh below, or by pairing again (for a computer added
by its SSH address, by forgetting it and adding it again). A key the computer never reported
(`HostKeyNotPairedException`) takes the same route but not that promise
(`SshFallback.NOT_REPORTED_NOTE`): pairing again and the refresh both re-read the computer's keys the
same way, so they help only when those keys changed, and an SSH server using a key the reader cannot
see stays refused on the network (see Known gaps). The iOS app can adopt the same field: it
is additive in the sealed answer, and a phone that does not read it pairs exactly as before (a
follow-up for @eneskirca in nodeterm-ios).

**The LAN leg is refreshed over the relay** (audit `A74-refresh`). The address the LAN leg dials and
the keys it checks were both facts about the moment of pairing: the QR's `host` is a DHCP lease, and
a reinstall regenerates sshd's keys. So every relay `projects.list` answer carries, beside the blob,
what the computer says about its own SSH leg now: `{ output, lan: { host?, sshHostKeyFingerprints? } }`
(`src/main/remote/host-lan-report.ts`: the same `pickLanIPv4` the QR uses and the same host-key
reader as the sealed `/pair` answer; the keys are re-read at most once a minute, the address on every
answer; never on Windows, which has no SSH leg). The phone updates the paired computer from it
(`LanRefresh`, applied by `HostSession` after the primary relay connection's listings): a different
address replaces `PairedHost.host`, and the reported keys become the anchors. The pin gives way only to
a key the computer CONFIRMS (review of `A74-refresh`): when the SSH leg of the connect that opened this
relay connection was refused a host key (`HostKeyChangedException.actual`, which `SshFallback` hands on
as `TryRelay.refusedHostKey`) and that key is among the reported ones, the pin is dropped, so the next
SSH connect must present one of the computer's current keys and pins it once it has authenticated.
That covers a reinstall (new keys) and an sshd that stopped serving the pinned key while its `.pub`
stays on disk, so the computer still reports it. A pin is never dropped merely for being missing from
the report: the report is what nodeterm on the computer could read of its sshd's keys, not what sshd
serves, and a pin the phone has not seen fail is one that works. No reported keys (an older desktop,
keys it could not read) leave the pin and the anchors alone. The cost of asking for a refusal first: a
computer reinstalled while the phone was away is refused once more at its next connect on the network,
which goes on to the relay, and that relay connection confirms the key for the connect after it. This
is safe because the relay authenticates the computer on its own (end-to-end encrypted to the box key
pinned at pairing, served only once approved).
Nothing that came over SSH ever refreshes these facts (`LanRefresh.afterListing` refuses an SSH
listing, and an SSH listing never carries the field), and neither does the relay held next to a live
SSH connection (`viaRelay`), where the LAN leg as recorded has just authenticated. While the host
screen shows a changed-key warning, a refresh that moved the address or confirmed the refused key adds
a sentence saying so. The field sits beside the blob, not inside it, so the blob stays the shape a phone
on direct SSH reads off the host, and an iOS app that does not read `lan` sees the reply it always saw
(a follow-up for @eneskirca in nodeterm-ios).

**Relay approval.** The standing host raises its SAS dialog as soon as an unpinned phone completes
the handshake, so the phone decides *before dialing* (`RelayApprovalGate`): the background worker
dials only a computer that approves this phone without its dialog (a relay connect has succeeded, or
pairing answered `relayApproved`, below), and a refused or unanswered approval suspends automatic
dials until the user asks again. A current desktop pins the phone's relay key at pairing
(the phone sends `boxPublicKey` inside the sealed `/pair` body; the answer says `relayPinned`), so
most phones never see the dialog. A pairing with no relay leg (remote access off at the scan, or a
failed mint) records the key on the device entry in `agent.json` without pinning it, and the
standing host pins it on the phone's first relay handshake while that pairing is listed (audit
`A07-late`, `approvePairedRelayKey`): the phone that adopts the relay later over SSH (`relay.json`,
below) is not met by a dialog at a desk it has left. Either way the answer says `relayApproved`, which
is what the phone stores as approved, so its background check may use a relay it adopts later. Not
pinning at the scan keeps a LAN-only phone out of the pin store, which host-mode push reads as "a
relay phone is paired". The late pin's "still paired?" check runs inside the pin store's queue, so a
revoke racing a handshake cannot leave the key pinned. While the standing host decides on its own
(its pin store, then the late pin), `connectHostSession` holds the phone's requests instead of
answering "Awaiting host approval.", which a background check reads as an approval it needs: they are
answered once the host has approved the phone or raised its dialog (`PEER_DECISION_HOLD_MS`, 5 s at
most). No new file is involved: the key is the one
the scan already authorized, and someone who could edit `agent.json` has a shell as the user, which
could edit the pin store just as well. Revoking the device drops the pin and closes any relay session
the phone has open at that moment. The phone then redials (about 1.5 s after a drop while its screen
is open), and for the rest of that desktop run such a handshake raises no SAS dialog: the standing
host leaves it unapproved, so the phone hears "Awaiting host approval.", and closes it a few seconds
later (`REVOKED_PHONE_DENY_MS`), which the phone reads as a refusal and stops dialing on its own, as
after Deny. Pairing the phone again lets it back in (the pin or the recorded key is checked first);
after a desktop restart a dial from it shows the dialog again, as for any unpinned phone. If the
desktop cannot write the unpin, the device stays listed and Settings → Phone says to try again,
because the surviving pin would let the phone back in without a dialog.

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
my network"), else unavailable with a reason. Holding a token is not enough on its own: it outlives
the desktop's remote-access toggle, so every listing over SSH also reads whether the computer
advertises its relay right now (`relay=1|0` in the browse script's meta block: is
`~/.nodeterm/relay.json` there, which the desktop writes while its phone host is registered at the
relay and removes when it stops). A token with no advertisement is "remote access is off on the
computer" (`RelayLeg.REMOTE_ACCESS_OFF`), not a tap that waits out the relay's 20 s handshake; an
advertisement with no token yet is picked up by late adoption on the user's refresh, or by the
8 s refresh as soon as it appears (`LegRouting.adoptAfterListing`), and says so meanwhile instead
of "turn on remote access". The token is asked by presence (`SecureStore.hasRelayToken`, no Keystore
decrypt), because the screens ask the routing while composing (`A47`). The screens ask the same
function, so an unavailable control is shown **disabled with that reason** (New session, whose
reason is the Sessions list's first row; the board's card actions; the session menu's
wake/refresh/rename), never hidden; the Source control screen (`A29`) says it in place of the
repository. The relay dial still goes through `RelayApprovalGate` with the caller's trigger: these
are taps (`Trigger.USER`), so the first one on a desktop that has not pinned the phone shows the
approval code on the screen that asked (the host screen, or Source control), and a background path
never makes a first handshake that would raise the dialog (its only first handshakes are with a
computer whose pairing answered `relayApproved`, above). Answering approvals, read-acks, typing keys and ending a session stay
on SSH.

**A computer a desktop drives over SSH, and the Server Edition (audit `A27`, part a).** The SSH
browse reads more than the paired desktop's own files. It finds the data dir of a nodeterm running
on the computer in this order: the desktop app's (`~/Library/Application Support/node-terminal`,
`$XDG_CONFIG_HOME/node-terminal`, then the legacy `nodeterm` spelling), then the Server Edition's
(`$NODETERM_DATA_DIR` when the SSH session carries it, then `~/.nodeterm-server`, the default in
`src/server/config.ts`; a fresh install that has written only `install-meta.json` counts). A server
started with `--data-dir` elsewhere is not found, and a computer with nothing found reads as "not
found, here is where the phone looked", never as an empty computer; it ends by offering the relay
only when the phone has a relay leg for the computer (`NothingFoundException.said`), and for a
computer added by its SSH address it suggests checking the user instead. "Nothing found" is judged
on what the listing can use: the desktop never deletes a status slice, so on a computer a desktop
drove once the old ones stay, and a slice that is no data (stale, unreadable, misnamed) counts as
nothing.
It also lists the `nt-*` sessions on `nodeterm-rmt`, where a desktop ELSEWHERE runs the sessions of
its SSH projects, and reads what that desktop leaves on this computer, since there is no
`workspace.json` for those projects here:

- each project's canvas, `<remoteCwd>/.nodeterm/project.json`, found by walking up from each
  `nodeterm-rmt` session's start directory (`#{session_path}`, the node's cwd the desktop gave
  `new-session -c`); the SSH mirror writes it with the desktop's project id as `id`;
- each status slice, `~/.nodeterm/agent-status-<projectId>.json`
  (`src/main/remote-ssh/remote-status-push.ts`). The desktop re-flushes it at least every
  `STATUS_HEARTBEAT_MS` (60 s) while connected, so a slice whose `updatedAt` is more than twice that
  old is **no data**: its states and Inbox cards are dropped, not shown as current. The comparison
  uses the phone's clock against the desktop's;
- the sessions themselves. One that no project names is still listed, under "Other sessions on this
  computer".

These become projects marked `drivenRemotely` (`HostBrowse`, `android/protocol`), after the host's
own. The host's own index wins: a project id or node it already lists is never listed twice, so a
node of the paired desktop's OWN SSH projects stays relay-routed (`A09`), even when that desktop
drives this very computer. What the machine does works on a driven project's sessions over SSH, on
their own socket: attach (attach-only: a session the driving desktop creates there gets its remote
tmux.conf and hook env, which the phone cannot give it), keys, the wake line, held approvals (a file
on this computer, where that desktop's SSH answer path looks), read-acks (written where that
desktop's ack sweep looks; on a computer that also runs its own nodeterm, see Known gaps), and ending
the tmux session. What needs nodeterm *the app* (a new session, board writes, node actions, git)
belongs to the desktop elsewhere, which neither leg of this computer reaches, so
`LegRouting.forProject` makes it unavailable with that reason, and a driven session that is not
running says it starts from that desktop instead of offering this computer's relay. The relay is
offered for a session that is not running only when it is a node of the computer's OWN index: the
relay's `pty.attach` creates what it does not find, so for any other node (a driven one, or one no
listing names, such as a driven project no longer listed or a deleted node) it would make a bare
`nt-<id>` of no project on `node-terminal`, which later attaches would then find first. Which nodes
are whose comes from a listing, so the first node-scoped call on a connection that has not listed
yet (a redial, or a terminal restored after the process died) lists first. The status block
merges the host's own mirror with the fresh slices (the host's entries, settings, usage and `server`
block win). The Server Edition's `server` block (version, commit, install date) is shown on the
host screen, above its tabs. A computer that has no pairing code to scan reaches this browse
through "Add SSH server", next.

**A computer added by its SSH address (audit `A27`, part b).** A headless Server Edition has no
pairing service anywhere in `src/server`, and a dev host the phone reaches only over SSH has no
nodeterm of its own to show a code, so neither can be paired. "Add SSH server" (from the computers
list, its empty state and the Pair screen) adds one by host, port (22) and user; the rules are
`ManualHost` (`android/protocol`, `ManualHostTest`) and the screen only lays them out:

- **The key.** The phone cannot put its own key on the computer before it can log in, and it never
  asks for or keeps a password. The screen shows the phone's Ed25519 public key line
  (`ssh-ed25519 … nodeterm-android`, the same key every pairing installs; copy or share it) to add
  to `~/.ssh/authorized_keys` of that user, and a one-line command that does it: `sh -c '…'`, so a
  bash, zsh or fish prompt hands it to `sh` as is (only `/bin/sh` itself is tested), which adds the
  line only when it is missing, after a newline when the file's last line has none (appending onto
  it would break both keys), and sets the modes sshd's `StrictModes` wants (`700` / `600`). `ManualHostTest` runs that command under `/bin/sh` and
  then logs in against an SSH server that reads the very file it wrote.
- **The host key.** Nothing like the QR carries anything to check it against, so it is trust on
  first use by A49's rule: Connect pins the key of the first server that **accepts** the phone's
  key (a server that refuses it pins nothing), and the computer is added only then, already pinned,
  so nothing ever dials it in the background before an authenticated connect. The screen shows the
  pinned `SHA256:` fingerprint with the command that prints the computer's own
  (`ssh-keygen -lf` over `/etc/ssh/ssh_host_*_key.pub`) to compare. A refused key says to add the
  line. A login that could not finish (it timed out, or the connection dropped during it) says to
  check the address and the network instead: sshj wraps both in the same `UserAuthException` as a
  refusal, and only one with nothing behind it is the server saying no
  (`SshHostConnection.isAuthRefusal`). An address already in the list (paired or added, same host
  in any case, port and user) is refused with the name it has.
- **SSH only.** The record is the paired one's with `"manual": true` (`PairedHost.manual`): no relay
  block, no host box key, `sshAvailable` true, and a `fromJson` that drops a relay a record might
  carry. Its route is fixed to SSH (`HostStore.route`), Settings shows no choice for it, the late
  relay adoption never runs for it, and `LegRouting.RelayLeg.ADDED_OVER_SSH` makes every relay verb
  (a new session, board writes, node actions, git) unavailable with "remote access isn't set up for
  this computer: it was added by its SSH address". A session that is not running, or a node of an SSH
  project, is refused without the relay offer. Which refusal is said follows the relay leg the
  phone has for the computer (`NeedsRelayException.refusal`): "remote access isn't set up" for one
  added by address and for one the phone never got a relay leg for (paired with remote access off),
  and otherwise what is actually in the way, the way `LegRouting`'s reasons name it: remote access
  turned off since, a relay not picked up yet, or the route "Only on my network (SSH)". A changed
  host key stops with "forget it and add it again". Forget works as for a paired computer, and its
  dialog says the phone's access is revoked by removing the line ending in `nodeterm-android` from
  that `authorized_keys`.
- **Older builds.** A build that predates the flag ignores the `manual` key and reads a computer with
  SSH, no relay and the same pin. The add also stores the route `SSH_ONLY` for it, which such a build
  reads, so it does not dial a relay for it either (its late relay adoption could still read a
  `relay.json` on that computer; this build never does). Such a build also DROPS the key: it rewrites
  the whole list on its next save (pairing or forgetting any computer, a late relay adoption) without
  it. So the flag is also read from the id, the one thing that survives that round trip: an added
  computer's id starts with `ssh-` (`PairedHost.MANUAL_ID_PREFIX`), and a paired one's is the
  desktop's `randomUUID()`, which never does. Back on this build it is an added computer again, and a
  relay block or box key that build adopted for it meanwhile is dropped on read.

## Protocol mapping

The standing phone host still speaks the **legacy relay dialect** (`host-service.ts`
`createHostHandlers` + `framing.ts` opcodes), not the rpc.ts tunnel `docs/ios-protocol-migration.md`
describes as the future. The Android client implements what the host actually serves:

| Phone action | Relay (host-service.ts) | Direct SSH |
|---|---|---|
| List projects/sessions/status | `projects.list` → the `--NT-PROJECTS-SPLIT--` blob, and beside it **`lan`** (new, `A74-refresh`): the computer's current LAN address and SSH host keys, which refresh the paired record | same blob (and never a `lan`), from `workspace.json` + `tmux ls` + `agent-status.json` in the desktop's userData or the Server Edition's data dir; the v3 index is resolved like `WorkspaceStore` (folder refs → `.nodeterm/project.json`, SSH refs → `cache`, data refs → `inline-projects/<id>.json`). Then what a desktop that drives the computer over SSH left there (`A27`): `nodeterm-rmt` sessions, the `.nodeterm/project.json` above each, and the `~/.nodeterm/agent-status-<projectId>.json` slices (stale after 120 s) |
| Open a terminal | `pty.attach` → `{streamId, fresh}` (a session the phone starts adds `projectId`/`accountId`/`agentId`; the desktop resolves them itself — the project folder, the account, the agent's hook env and the pane's owning project — and applies them only when this attach creates the session), Snapshot frames, Output frames; a node of an SSH project is attached over that project's ControlMaster (`requireRemote`) or refused | which socket has the session (`node-terminal` first, then `nodeterm-rmt`), then a pty exec of `tmux attach-session` on it — never `new-session`: a session of the computer's own index that is not running, or a node of an SSH project, is refused with `NeedsRelayException` and the app offers the relay (a driven project's session that is not running says it starts from its own desktop, and one no listing names is refused without the relay) |
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
| Quick answer keys (question digits, legacy approve/deny) | **`node.sendKeys {nodeId, keys}`** (new) → `{sent}`; local tmux answers resolve the exact session to a pane ID, cancel copy mode and type there, also while mounted. Complete writes are ordered per node. SSH-project answers use the project's ControlMaster; unavailable sessions return `sent:false` (the phone opens the session). An older desktop gets attach → wait for paint → write → linger | resolve the exact session to a pane ID, cancel copy mode, then `tmux send-keys -l` there; missing exit status or any command failure opens the session without resending. SSH-project nodes go through the relay leg (`A09`) |

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

**Current stable-touch correction (`A89`, 2026-10-02):** beta 5 still stops during continuous
swiping and the user must lift to continue. Its controlled phone history shows no coast after the ADB
swipe command completes. Real xterm reproduces the cause: redraw replaces the touched text
span, so later touchmove/touchend no longer bubble to the handlers. `c4b1f6cf` gives the stable
screen `touch-action: none` and changing rows/descendants `pointer-events: none`. The real-bundle
regression verifies computed CSS hit testing and continued drag/release across an actual redraw.
The real-bundle redraw case delivers 24 notches versus one with a detached span. All 658 protocol
tests in 63 suites pass with zero failures/errors/skips (67 seconds), and offline app
`compileKotlin` passes (8 seconds). Thirty-five JS, eleven native and three CSS mutants were caught.

Private `0.1.0-beta.6` / code `7` uses source `c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6`.
Actual AGP release built in 43 seconds and passed every R8 keep. Retained-signer packaging verifies
non-debuggable metadata, signature, 16-KB alignment and source/hash provenance; signing preserves
all 149 ZIP payloads and adds only three signature metadata entries. APK SHA-256:
`4947133a6ccf9c2b1e775e76d7c24f564e087cf036e59eac4dca08162a076d3c`.
The intended Pixel received a same-signer update preserving app data; notification permission
is confirmed. SSH reopened with the retained key/pin in the owned 56×48 pane. A
1000-native-pixel/1200-ms swipe produced 23 observed history-position updates, from 0 to 110 over
about 1103 ms; its ADB command completed at 1535 ms. A 1000-pixel/200-ms swipe reached position
110 when its ADB command completed at 540.5 ms, then 250 at 1339 ms (about 799 ms later), with
29 observed updates overall. This verifies continuous drag delivery and post-command coast.
Esc during coast left copy mode (`mode=0`) and remained out for 1.4 seconds.

New-touch stopping also passes with the keyboard already open and all sampled viewports at
56×25. After a 500-native-pixel/100-ms swipe, the DOWN command completed 152 ms after the swipe
command; the script then waited 1.2 seconds before issuing CANCEL. The last position change was at 503.6 ms, before DOWN completed at
588.8 ms; final position 100 remained unchanged through CANCEL. Earlier tap/DOWN checks opened
the IME and rebased positions; those results were inconclusive, not additional failures.
After normal terminal use, the user confirmed “Both work now” for continuous dragging and coast.
The primary `A86` drag/coast complaint is resolved; reversal/lifecycle, mobile-beta-6, FPS/custom
bindings and the full 64-item pass remain open. After testing, Esc and Header Back returned to
Sessions and detached the owned client; only the exact owned `nt-term-000android-scroll-20261002-c` session and owned phone UI
XML were removed. Private proof, including `device-summary.json`, is in
`.nodeterm/android-beta-build-6/`, signed artifacts in `.nodeterm/android-beta-6/`.

**Historical kinetic beta (`A86`, 2026-10-02):** beta 4 moves more lines but the user reports missing
momentum on finger lift. `1ad2e944` adds bounded velocity fling; `53462f96` adds `onScrollStop`
to discard unsent native scrolling on new touch/input/reset/font/lifecycle barriers without
pane input or loss of accepted keys/replies. Automatic xterm reports preserve it. Bytes already
handed to SSH's separate writer/network cannot be recalled. All 658 protocol tests in 63 suites
pass with zero failures/errors/skips (59 seconds), and offline app `compileKotlin` passes (10 seconds).
Thirty-five JS and eleven new native mutations were caught; seven strengthened kinetic tests pass.

Private `0.1.0-beta.5` / code `6` uses source `1ad2e94455a7adfb85d41212b12d36df39695324`.
The actual AGP release built in 47 seconds and passed every R8 keep. Retained-signer packaging
verified non-debuggable metadata, signature, 16-KB alignment and source/hash provenance. APK
SHA-256: `7cc68d384aeb21ab40800fa7c83f006dfbfefba16dd2e945967c8c5376f17655`.
It updated the intended Pixel in place; installed code-6/non-debuggable metadata and notification
permission are confirmed. Private proof is in `.nodeterm/android-beta-build-5/`, signed artifacts
in `.nodeterm/android-beta-5/`. The actual gesture reaches history 15 at 369 ms, 25 at 391 ms,
and 30 at 412 ms, then stays fixed through 1.4 seconds after the ADB swipe command completes at
561 ms. Command completion is not a measured physical touchend timestamp. The user reports
continued swiping stops; this failure led to `A89`. Beta-5 build/tests do not prove phone coast.

**Historical report-routing correction (`A86`, `A87`, 2026-10-02):** the user reports that installed
beta 3 still has both lag and too little movement, on Wi-Fi and mobile-data VPN. Its controlled
gain/reversal/Esc results below did not establish satisfactory feel. `3cffb49d` restores one
measured text row per wheel notch and separates automatic xterm focus/mouse/query replies from
user input: reports preserve queued movement; keys, paste and IME input still cancel it. Frame
batching, lossless ordered chunks, stream retirement and SSH TCP_NODELAY remain. Real bundled
xterm interaction regressions pass; 22 JavaScript and nine actor/native-wiring mutations were
caught. All 646 protocol tests in 62 suites passed with zero failures, errors or skips (50 seconds), and the
offline app `compileKotlin` passed (8 seconds). At that checkpoint, `A86` still needed
intended-Pixel/user follow-up and kinetic fling was absent; beta 6 now has drag/coast confirmation.

**Historical beta-4 delivery:** `0.1.0-beta.4` / code `5` built locally from
`3cffb49d8cf64932260e914b42b3883331d0352d` with the retained signer.
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

**Phone trace limits:** the controlled beta-3 trace records one bridge invocation per gesture and
roughly one content presentation per gesture. Invocation begins 84–90 ms after touchstart; first
presentations occur 170–196 ms after touchstart, as temporal correlation without an SSH/action flow.
Presented Chromium scroll events measure roughly 36–56 ms; the >1-second aggregate mostly counts
no-paint termination. Sparse FrameTimeline data and non-damaging scroll-jank events establish no
terminal FPS or renderer cause. There are no named JavaScript/native methods or scheduler/V8
measurements, and the parser reports unknown newer extension fields. The trace supports comparing
delivered updates after the fix, not a claim that WebView spends a second painting.

The matching beta-4 trace records 42 bridge invocations versus 12, 26 content commits versus 12,
and 25 distinct presentations versus 11 over twelve gestures. First invocations occur at 25–36 ms
versus 84–90 ms; this supports more frequent delivered updates, without establishing terminal FPS
or end-to-end SSH latency. Both traces and queries are retained in the private beta-4 evidence.

**Packaging verifier (`A88`):** the earlier range-label fix `fed68fb3` passed 32 local tests, but
CI run `37058184031` again failed private packaging (five of 32 tests); protocol/debug/release/CodeQL
passed. Official SDK 37 reproduces verification exit 0, one signer and v2 true with `V3.0 Signer:`
certificate labels. `f5fd3821` accepts exact V2/V3.0 single labels and V3.0/V3.1 ranges,
requires one pinned certificate and verified v2, and rejects duplicate/unknown/hybrid identities.
Fixtures use the explicitly installed SDK 36/platform 35 unless a reproduction override is set;
only disposable-fixture verifier output is included in failure diagnostics. All 39 Python tests
pass against each real SDK 36/37, and ten new parser/fixture-selection mutants are caught.
Follow-up [run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming
observed CI repair. Each subsequent push still requires its own green workflow.
Every requested push owes green Android workflow verification; `A68` remains deferred and no PR
is requested.

**Historical beta-3 scroll update (`A86`):** after checkpoint `cf0487a3`, the user reports poor responsiveness on
both Wi-Fi and mobile-data VPN. Controlled SSH/tmux measurements found amplified wheel steps,
fast-swipe clipping and some TCP_NODELAY-sensitive latency; a bounded desktop DOM replay showed
no backlog at that load. The implemented mitigations match drag distance to stock tmux's five-row
wheel steps, batch by frame without losing distance, serialize scroll/input, cancel unsent scroll
before input and enable SSH TCP_NODELAY. No external host/payload contract or phone setting changed.
All 638 protocol tests in 61 suites passed with zero failures, errors or skips (51 seconds), and
the final offline app `compileKotlin` passed (7 seconds); 30 mutations were caught. Private
`0.1.0-beta.3` / code `4` from `40c4ee49592e2f92fc7e6e9b548ba88a33b1e2d3` built locally in
49 seconds, passed every R8 keep and retained-signer packaging, and updated the intended Pixel in
place. Signature, alignment and source/hash provenance passed; all 149 ZIP payloads were unchanged
by signing. APK SHA-256: `dda44df7ebb541afccd18b428634d66246349ccb62fd202917b77a333fbadba3`.
Manual SSH registration/key/pin and notification permission survived. The app reopens the intended
Linux host over SSH and its controlled test terminal fills 56×48. Five identical 1000-native-pixel,
350-ms downward swipes reached positions 25, 40, 55, 70, 85 on beta 2 versus 5, 10, 15, 20, 25 on
beta 3. Reversal moved 25 to 20 and the actual Esc chip left copy mode. The phone returned to
Sessions and refreshed; only the owned test session was removed, with user panes untouched.
Private proof/screenshot/installed-package checks are in `.nodeterm/android-beta-build-3/`,
including `device-checks.json`. These establish drag gain/order/input cancellation, not FPS
or perceived smoothness. The tiny isolated UI-frame samples are not a WebView renderer trace.
The user subsequently reports that beta 3 still lags and moves too little. Those historical
checks verify gain/order/cancellation, not satisfactory feel; the current correction is above.
At that checkpoint, custom wheel bindings and kinetic fling remained open. The [finding](android-audit-2026-09.md#a86) records the evidence and limits. Push is
authorized, each requested push requires green Android workflow verification, no PR is requested
and `A68` stays deferred.

**Installed beta history (2026-10-02):** restored host access allowed reconciling remote tip
`82940e17` in `990f90c6` and building the actual app locally. The first AGP 8.9.1 release exposed
R8 Kotlin-metadata warnings (`A83`). The corrected source
`fa71cb08072f399f24a81bfb361ea852a0275f3b` uses AGP 8.10.1 with Kotlin 2.2.0, wrapper Gradle 8.14.3
and JDK 21. Its real release and final offline `:app:assembleRelease` (15 seconds) passed, the
metadata warnings are gone, and `check-r8-output.sh` passed every runtime keep.

`0.1.0-beta.1`, version code `2`, was privately signed with the retained signer, verified as
non-debuggable with the expected certificate and local APK/R8/source/hash provenance, and installed
on an MI8 running Android 15 / API 35. The first cold start succeeded and reached the notification
permission dialog. After granting `POST_NOTIFICATIONS`, the app shows its empty Computers screen,
Pair button and Settings, with no crash markers. Installed metadata confirms version code `2`,
minSdk `26` and targetSdk `35`; `run-as` is refused because the app is non-debuggable. The phone's
WebView is `com.android.webview` `144.0.7559.76`. Inputs/logs are in the original workspace's ignored
`.nodeterm/android-beta-build-1/`; the APK/checksum/metadata are in `.nodeterm/android-beta-1/`.
APK SHA-256: `39afa15f15219536e3de1a462f2e5018515847a43684093eef18d95faf5e7fb4`.
**Wrong test device:** the user identified the MI8 as the wrong phone. The newly installed app and
its test UI dump were removed. The phone's newly authorized SSH public key was removed, restoring
the host's `authorized_keys` byte-for-byte to its pre-change state. The MI8 had no paired host and
no SSH connection was attempted. The device evidence above remains first-launch evidence for that
test device only. The subsequent intended-phone results are below. The user's target is this
Linux host over their WireGuard VPN; full validation remains open under `A50`.

**Intended phone, initial beta:** the user supplied the intended phone's ADB endpoint. The Pixel
10 Pro runs Android 17 / API 37 with Vanadium WebView `154.0.8037.92.0`. Private beta
`0.1.0-beta.1` (code `2`) installed, the user granted notifications through Android's normal dialog,
and `run-as` was refused on the non-debuggable build. Its SSH public key was authorized while
preserving existing authorized entries. Through Add SSH server, the app connected to this Linux host;
the pinned Ed25519 fingerprint matches the host's public key. It lists 17 actual projects, and a
harmless `echo` sentinel entered from the phone executed in a controlled temporary tmux window.
This is manual direct-SSH registration/authentication, not verification of QR/code or relay pairing.

The initial terminal still advertises only 52/56 columns by one row despite a large visible
viewport, including after changing the font (`A85`). Chromium treats a WebView's `WRAP_CONTENT`
height as zero CSS layout height, despite its large native bounds. The local fix supplies explicit
`MATCH_PARENT` layout parameters before loading the terminal page (`febe022a`); the real Gradle
`TerminalWebViewLayoutTest` wiring guard passes, and two layout-policy mutations were caught in a
temporary source mirror. The actual `0.1.0-beta.2` (code `3`) from
`febe022ad2fc373f27ac11d9ad5f130f36f027a5` passed its offline AGP release build in 45 seconds and was
signed with the retained certificate; signature, alignment and same-build provenance were verified.
Inputs/logs are in `.nodeterm/android-beta-build-2/`; finished APK/checksum/metadata are in
`.nodeterm/android-beta-2/`. APK SHA-256:
`a022a399e23c81607a4a3664862b964ad781f0a589ab77dda902b4c2dc597eca`.
An independent artifact review verified v2/v3 signatures with the same retained certificate,
all APK/provenance hashes, 16 KiB ZIP alignment and 16 KiB load-segment alignment for all four
native libraries.

Updating the Pixel with `adb install -r` succeeded and preserved its host configuration, phone SSH
key, host-key pin and notification grant. The app reopened the intended Linux host over SSH. The
controlled terminal now reports 52×45 instead of 52×1 and fills its viewport. A downward swipe
entered tmux copy mode at position 82; a screenshot visibly showed the pre-attach ready/sentinel
and marker rows 001–039, from 120 rows printed before the update/attach. The layout fix restores
this pre-attach tmux history without any production SSH-scroll change. A− restored font size 13
and a 56×48 terminal; showing the soft keyboard resized it to 56×25 with native bounds
`[0,396][1280,1462]`, and hiding the keyboard restored 56×48. The Esc chip left tmux copy mode
(`pane_in_mode=0`). Sending a second unique `echo` marker through the updated beta's draft executed
and displayed the entire output line. The app returned to Sessions; only the owned temporary test
window was removed, with the previous window restored and its original Python process still alive.
The intended phone's app, SSH key and configuration remain. Device checks and controlled screenshots
are retained in `.nodeterm/android-beta-build-2/`, including `device-checks.json`. The full phone
pass remains pending; the subsequent user-reported mobile connection is below.

**User-reported mobile check:** with WireGuard enabled and Wi-Fi off, the user confirmed that the
intended Linux host's terminal opens over mobile data. This is separate from the ADB-assisted LAN
checks above. Mobile reconnect, approvals/questions, background behavior and the full 64-item
checklist remain open.

History regressions in `d6619bf6` pass 47 focused real Gradle SSH/terminal/link tests with zero skips. Both JavaScript swipe-direction/disabled-scroll mutations, the real-SSH wheel-direction mutation and the two native layout-policy mutations were caught; production sources were restored. **Beta-2 verification:** all 609 protocol tests passed in 59 suites with zero failures, errors or skips (52 seconds); the offline app `compileKotlin` passed (7 seconds).

The full desktop type-check and 679 desktop tests passed, with three platform skips. The offline
Gradle app type-check passed, and 23 Python beta-tool tests passed with real SDK APK/signature
fixtures. Eight bounded compatibility/CI guard tests and two toolchain mutations also passed.
The real Gradle protocol run executed 605 tests: 603 passed, two real-SSH tests failed, none skipped.
The two initial SSH failures were test-harness isolation faults (`A84`): a Fedora login-shell
command-not-found handler delays the literal `-R` command, and an earlier no-exit-status test leaves
Escape in the shared pane's Readline state, corrupting the next `echo` into `cho`. The test-only fix
in `1d6b04cc` isolates a fresh non-login pane and initialization environment per test. That earlier
full protocol rerun passed all 606 tests with zero failures, errors or skips; both harness mutations were caught,
and the fixed test source was restored before that rerun. The user authorized this local build
instead of requiring CI for the first beta; each newly requested push still requires green Android
workflow verification.

Device results are partial: item 1 has first-install evidence and item 5 has install,
non-debuggable, initial-launch and basic direct-SSH/terminal-input evidence on the intended Pixel.
Manual SSH key/pin/project checks also cover parts of items 10 and 63. No complete item has passed.
The private update preserved manual SSH registration and its identities; pre-attach tmux history
is visible in the controlled test window. QR/code pairing, relay,
mobile reconnect/background/answer behavior and the full 64-item pass remain open. The current complete
protocol run after the stable-touch correction passed all 658 tests, as recorded above. Use the
[private-beta procedure](../android/README.md#private-beta), which accepts same-build local
APK/R8/source/version/hash provenance with `buildOrigin: "local"`.

**Continuation checks (2026-10-02, cached branch base `6afd8f53`):** the new `A78`–`A80` fixes are
local and have not run in CI. Six targeted desktop unit suites pass (170 tests), and eleven
production mutations fail the relevant regressions. These run with a cached Vitest 4.1.9 runtime;
the lockfile's runtime is 4.1.11. Two additional relay verb suites could not load because Electron
is missing. The new SSH shell tests compile and execute
with a cached Kotlin 2.3.20 compiler, minimal model dependencies and temporary test assertion stubs:
three shell tests pass, covering both sockets, copy mode, literal answers/Enter/Escape and errors;
four shell mutations fail. An isolated adapter containing the actual SSH `sendKeys` method refuses
null/nonzero exit status; restoring null-as-success fails that check. This is narrower than compiling
the full SSH transport or running JUnit/MINA.

In the earlier restricted sandbox, the required full protocol tests and app type-check could not start: system Gradle is absent, and
a recovered Gradle 9.5.1 fails initializing its socket-based lock service in this sandbox. Real
tmux/SSH checks and adb are also blocked by socket permissions. `npm run typecheck` is blocked by
missing desktop dependencies, and `npm ci --offline --ignore-scripts` cannot complete from the cache.
That command deletes `node_modules` and leaves node-pty unpatched/unbuilt; a desktop checkout
recovers with `npm install` or `npm run rebuild` once dependencies can be installed.
GitHub DNS was unavailable in that sandbox, so fetching, downloading an APK, pushing and checking
Android CI were not possible at that stage. **No device checklist item had been run at that stage.**
The checks below describe earlier work; current local checks and partial phone results are above.

No relay verb or payload changes in this continuation. The desktop fix serves Android and iOS;
@eneskirca should check the iOS direct-SSH answer path for the same copy-mode and exit-status hazards.

Private beta preparation adds bounded relay HTTP requests (`A81`) and owned read-ack consumption
(`A82`). `RelayApiTest` passed all six methods with real cached OkHttp, Okio, serialization and
coroutines, using in-memory sockets for stalled headers/body, trickling responses and cancellation;
the deadline also bounds dispatcher queueing and preserves a caller's shorter cancellation.
Three initial and three follow-up mutation checks were caught. This is a direct compiler run
(Kotlin 2.3.20, language 2.2), not the
required Gradle suite or a live backend test. The ack changes retain foreign files before reading or
deleting them and aggregate ownership across every project on an SSH host; Android's producer format
stays the same, with new producer/consumer interop coverage. iOS should preserve the same ack format
and confirm multiple-desktop behavior with @eneskirca.

For `A82`, five desktop suites pass 225 tests (ack sweep, mirror, remote ack/project teardown), and
the actual Android producer plus real desktop consumers pass two ack interop methods and the new
bundle path-coverage check under that cached compiler. Eight mutations were caught; a focused
strict TypeScript check of the ack core/new fixture also passes. The separate fixture guard's
`tsc --listFilesOnly` child fails with `EPERM` here, so its full check remains unverified.

The [private beta procedure](../android/README.md#private-beta) keeps the signing key and finished
APK local. Pushes to the exact takeover branch prepare versioned unsigned beta inputs without a
PR; manual CI beta inputs provide the later optional path once the workflow is on the default branch.
A verified local AGP build is now also authorized; its same-build unsigned APK, R8 reports and
provenance use the same required fields, with `buildOrigin: "local"`. The CI path selects those inputs;
the beta checks require protocol/release success, desktop type-check and delivery/ack tests, and
real-tool packaging regressions. Local packaging verifies the expected private signer, release
manifest, R8 keeps, alignment and checksum. **The actual corrected release is signed and installed
on the intended Pixel; the code-3 update preserves identities, resizes with font/keyboard changes
and exposes pre-attach tmux history. The remaining full phone validation is pending.** Packaging fixture APKs prove the tool's gates only; the
actual APK and partial phone results are recorded above. `A50` stays partly open until the full
phone pass.

The user confirmed a first private beta; its retained RSA-3072 PKCS12 signer is now prepared in
the original workspace's ignored `.nodeterm/android-beta-signing/`, outside the temporary source
checkout. The directory is `0700` and every file `0600`; passwords stay in separate local files.
The private-key entry, certificate fingerprint and distinction from the public debug certificate
are verified. Source exports contain none of these private files. Preserve a private backup for
future APK updates. The wrong MI8 installation was removed; the same first signed APK is now on
the intended Pixel and updated in place to the code-3 sizing fix. The full phone pass remains open;
each requested push requires green Android workflow verification.

Beta tooling checks pass 22 real SDK packaging fixture tests plus one selected-version environment
test (12 cases), with 13 packaging mutations and one version-validation bypass caught. Seven CI
configuration tests pass under the cached compiler; six workflow mutations are caught. Nine existing
device/contributor documentation tests pass under that runner. The extracted Gradle version
expressions also pass nine boundary/default cases; this does not run Gradle configuration. The full
protocol/app Gradle commands were retried in the restricted sandbox and stopped before project tasks
at the lock service; desktop type-check stopped at missing `electron-vite/node` types. Restored-host
results supersede those limits above. No continuation CI result is available.

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
  `agent-status.json` written by the real mirror from Claude hook payloads (audit `A64`). The `lan`
  field beside it is the desktop's own `createHostLanReporter` over the test's interfaces and
  host-key dir (`A74-refresh`): the phone parses the address and keys, and a record that pins a key
  the computer no longer has is refused by a real MINA server before the refresh and accepted (and
  pinned) after it, once the report confirms the key that server was refused; a pin the computer
  still reports but its sshd no longer serves gives way the same way; a desktop that sends no field
  changes nothing.
- **Relay security** — scripted-host tests for: no re-key after ready, reflected boxes (own role)
  dropped, replayed/reordered sequence numbers dropped, boxes under a foreign key dropped.
- **Pairing** — against the desktop's real `createPairingService` with HOME in a temp dir: the
  E2EE-sealed exchange, the key landing in `authorized_keys` under `nodeterm-ios-<deviceId>`, the
  relay leg and its `/v1/relay/device` body, a refused wrong token, the relay key pinned at the scan
  and, without a relay leg, recorded and approved on the first relay handshake (`A07-late`: the
  fixture asks the service what the standing host asks, for the phone's key and a stranger's, before
  and after revoking), the SSH host keys a sealed answer names (`A49-anchor`: read from a host-key
  dir the fixture is pointed at, never the machine's `/etc`; in the form sshj reports; none in a
  plaintext answer; a first connect to a real MINA server whose key they name pins it, and one whose
  key they do not name is refused), and the size of the desktop's largest answer (1,803 bytes with
  the 16 host keys it sends at most, counted through a proxy). Scripted local servers pin the client's
  bounds on an answer from whatever `host:pairPort` a code names: a declared length is refused
  above 64 KiB or below zero before anything is allocated, a body with no length stops at 64 KiB,
  and the whole exchange ends at a 45 s deadline (or when the caller is cancelled) by closing the
  socket, so a server that trickles bytes cannot hold the pairing screen.
- **SSH** — against Apache MINA sshd running every command through a shell, with real tmux on a
  private `TMUX_TMPDIR`: v3 index resolution, attach with keystrokes both ways, cold-start
  detection, literal `send-keys` (a leading `-` is text), answer files, read-acks, host-key pinning.
  Both sockets (`A27`): a computer with no nodeterm of its own that another desktop drives (its
  `nodeterm-rmt` sessions, project file and slices, a stale slice dropped, attach / keys / pane read /
  kill landing on `nodeterm-rmt`, nothing created for a session that is not running, also on a
  connection that has not listed yet), one with both sockets in use (a name on both is the host's
  own; the paired desktop's own SSH project stays relay-routed), a Server Edition data dir, and a
  computer where nothing is found, also when only stale slices remain. A node no listing names is
  not offered the relay, and the first node-scoped call on a fresh connection settles which nodes are
  whose. The SSH server's commands get none of the developer's `NODETERM_*` variables. A computer
  added by its SSH address (`A27`, `ManualHostTest`, its own MINA server whose authenticator reads
  `~/.ssh/authorized_keys`): refused before the key line is installed (no pin, no record), the
  install command run under `/bin/sh`, then accepted and pinned to exactly the server's host key; a
  later connect verifies that pin and another server at the address is refused; a server that drops
  the connection during login is reported as unreachable, not as a refused key; the form's checks,
  the record's JSON (and what an older build reads of it, and what this build reads back after an
  older build saved it without the flag), and the app's wiring, pinned in its source.
  No desktop code runs on this leg: the test writes the files the desktop would have (the v3
  `workspace.json` index and project files, `agent-status.json`, the status slices, the held request
  in `~/.nodeterm/pending`), and checks what the phone writes against file names copied from
  `pending-approvals.ts` and `ack-sweep.ts`. `SshScriptsTest` runs the browse under `/bin/sh` with a
  stand-in tmux for the walk up to project files, the slice names and the Server Edition's data dir;
  `HostBrowseTest` pins the assembly rules and reads the desktop's heartbeat, slice file name, server
  data dir and socket names from its sources.
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
The debug APK stays unminified. CI attaches unsigned release inputs; the private-beta path signs
them locally. The app has no instrumented tests. The actual private minified APK is installed on
the intended Pixel and has listed real projects and delivered basic terminal input over SSH.
The corrected code-3 update resizes for font/keyboard changes and exposes pre-attach tmux history;
code 4 verifies reduced drag gain, reversal and Esc cancellation. Remaining
relay and device behavior are unverified; the
[device checklist](#device-checklist) below is what the full device pass has to run. An audit of the code found release blockers; the fixed ones are
marked in its index, and the rest are open: [`android-audit-2026-09.md`](android-audit-2026-09.md).
The plan and the decisions still open are in [`android-handover.md`](android-handover.md).

A test caveat (audit `A64`): the relay leg's `projects.list` blob and mirror now come from the
desktop's code, but the SSH leg still hand-copies desktop shapes — the v3 index and project files,
`agent-status.json`, the `agent-status-<projectId>.json` slices, and the `~/.nodeterm/pending` and
`acks` files — and `~/.nodeterm/relay.json` only by its presence (`SshTransportTest` writes it, and
`HostBrowseTest` reads its path and its removal when the phone host stops from the desktop's sources);
its content, which late adoption reads, is tested nowhere. A desktop change to one of those fails no
Android test; it needs the matching hand edit in `SshTransportTest`. That is how a wrong userData path (`A02`: the desktop's
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
BLOCKED node or a question on a WAITING one, and only while the fresh listing still lists the card
unresolved. A card the computer's feed has dropped (it keeps an event 6 hours, and trims its feed to
50 events, keeping only each node's newest unresolved ask) opens the session instead: a key carries no
identity of the prompt it answers, and the node may be blocked on a newer one by then (the review of
`A25`). `QuestionChoicesTest` pins what a question card shows (`A57`): a single-select question keeps its answer buttons, while a multi-select one lists its options
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

Links and copying in the terminal (`A32`) had no way in: tmux runs `mouse on`, so xterm's own
selection never runs, its link handling stands aside, and tmux's copy-mode is out of easy reach on a
touch screen. `TerminalJsLinksTest` runs the real `terminal.js` in node against a stub xterm buffer.
A URL is matched across the rows it wraps over: xterm's soft wraps, and the full-width rows a tmux
repaint or an agent's fullscreen TUI paints with no wrap flag (the desktop's `file-links.ts` URL
matcher, ported; `@xterm/addon-web-links` joins only soft wraps, so a long OAuth URL opened its first
row's fragment). A tap on a link, an OSC 8 link included (its label hides the URL), hands the bridge
the URL as the URL parser writes it and cancels the touchend, so the click the tap makes never
reaches tmux or the app in the pane; a tap anywhere else, a swipe or two fingers are left alone. OSC 8
links go through `options.linkHandler`, never xterm's `confirm()` (the WebView has no WebChromeClient
to show one), and only http(s) crosses from any way in. The app then names the host (`Open <host>?`)
and shows the URL, two lines of it until All shows the whole (a long one scrolls inside the bar), and
opens it with a browsable `ACTION_VIEW` only on Open; `ExternalLink`
(`TerminalCopyTest`) checks the URL again: http(s), a host, printable ASCII, and the host named is the
one after any user info. The key row's Copy chip opens a sheet of what the buffer holds (its last 500
rows, which under tmux is the visible screen; soft wraps joined) and the links in it. `TerminalCopyTest`
covers how `TerminalCopy` reads that snapshot, the selection (a tap toggles a line, a long-press
selects the range from the last line tapped), and the 100,000-character cap the OSC 52 copy keeps,
for Copy and Share alike. `TerminalLinksWiringTest` pins the Android half in the source, including
that every bar, card and sheet drawn over the terminal keeps a touch on it from reaching what it
covers (`blockTouchesBelow`): Compose hands a touch to the sibling below wherever the one on top has
no pointer-input node, and a background or a `Text` has none, so a tap on the bar's URL or the
sheet's title reached the WebView (a click or a scroll in the pane) or the input bar (the keyboard).
The blocker consumes nothing, since a consumed move would cancel the overlay's own taps and scrolls.
The offer, the sheet, the intents, whether a touch on them stays there, and whether a tap on a phone
produces the events the page expects are a device check. The matching shares the desktop's limits:
text that exactly fills a row can be joined with the next, a URL inside a box a TUI draws with `│` at
both edges is not joined, and each CJK character before a URL on its row shifts where a tap lands by
a column. One difference: below a run
of more than 32 such full-width rows, the desktop's join could leave out the row asked about (a
missed link there); the port's always includes it, which also keeps the Copy sheet's scan through
such a run from standing still (a test runs one).

An SSH test pins that a server which completes the key exchange and then refuses the phone's key
(or user) leaves the host-key pin empty (`A49`), and that a first connect to a server whose key the
pairing did not name is refused before the phone's key is offered, while one whose key it named
connects and pins exactly that key (`A49-anchor`). `HostCertificatePinTest` runs a MINA sshd that
presents a host certificate: the phone matches the pairing and pins by the key it certifies (not the
certificate's own fingerprint, which the desktop never reports), a reissued certificate for the same
key connects with that pin, and a pin an older build took from the certificate itself still connects
and is rewritten as the key (review of `A74-refresh`). `HostKeyAnchorsTest` checks that sshj
fingerprints GitHub's published host keys exactly as OpenSSH prints them
(`src/main/ssh-host-keys.test.ts` checks the desktop's reader against the same pair), the parsing
and the record, and that a plaintext answer's keys are ignored.
`SshFallbackTest` pins what follows a failed SSH leg (`A74`): a changed key goes on to the relay in
Auto with a warning, stops on the SSH-only route, and its text names "Only through the relay" rather
than only re-pairing; a key the computer never reported is sent to the relay without the promise
that pairing again trusts it (review of `A49-anchor`). `HostKeyAnchorsTest` also pins, in the app's
source, that its pin (`ConnectionManager.pinFor`) hands the verifier the anchors its record keeps and
that the SSH dial uses that pin: the interface's default (no anchors) would compile without it.
`LanRefreshTest` pins the refresh (`A74-refresh`): only a relay listing counts,
only a dialable IPv4 is taken, the pin gives way only to a refused key the computer reports (also when
the pin is still among them) and never merely for missing from the report, no keys leave the pin
alone, and a computer added by its SSH address or paired relay-only is untouched; `SshFallbackTest`
pins that the relay leg is handed the refused key.
The app's use of them (the relay dial behind `RelayApprovalGate`, the warning on the host screen,
the refresh after each primary relay listing, whose order in the source is pinned) is only
type-checked.

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

`SourceControlTest` and three relay interop tests cover the Source Control screen (`A29`). The app
already had the client half of the desktop's git bridge (`HostConnection.git`) but no screen used
it. A project's Source control (from its heading on the Sessions tab, or beside the Board's project
picker) now shows the status split into conflicts, staged, changed and untracked files, a file's
diff on either side, stage and unstage (one file or a whole section), a commit of what is staged,
push and pull, and the last 50 commits. The folder is the project's `cwd` from `projects.list`;
there is no free-form git, only the bridge's typed verbs. The interop tests run them through the
desktop's real `GitService` over a repository in the project's folder, from the status to a pushed
commit, and check that the bridge's refusals ("cwd is outside the shared project roots." for a
folder outside its jail, `..` included; "git is not served on this host." for a desktop without the
bridge) reach the phone as those sentences. A git command that fails on the computer is an answer,
not an error: `ok: false` with git's own message, which the screen shows as it is. The desktop's
status sends `U` both for an untracked file (porcelain `??`) and for a path git reports as unmerged,
and has no field telling them apart; an unmerged path is the one it sends in BOTH lists. The phone
takes those out into a Conflicts section (git's `UU`, `AA`, … with its wording), opens one as plain
`git diff` (the combined diff with the conflict markers, never the untracked form, which shows it as
a new file) and offers no Stage for it, since `git add` would mark it resolved, markers and all;
Commit says to resolve them first, as git would. An interop test drives the real `GitService` over a
merge that conflicted. The unit tests pin the reading of each reply (a reply of another shape says
so instead of showing an empty repository), every unmerged state, the diff colouring (a `+++` inside
a hunk is an added line, not a file header; a combined diff's two marker columns; the view keeps the
first 4,000 lines and says how many it left out), the parameters each verb sends, and that every
write (stage, unstage, commit, push, pull) waits three minutes rather than the usual 30 s: the
desktop sets no limit on them, and a commit runs the repository's hooks, a stage its clean filters.
A write that still gets no answer (that wait, or a connection that dropped) says it may still be
running or have finished there, and the screen reads the status again after every write, failed or
not. Whether it can open at all is decided before any request (`SourceControlGate`): a project with
no folder, one of the desktop's SSH projects (the listing names its folder, but that is a path on
the host the desktop reaches over SSH, which the bridge's jail of this computer's own project
folders normally does not include), and a computer the phone reaches only over SSH with no relay leg
each get their reason on the screen. The screen is only type-checked; its wiring (the routing
decision, the gate, every call through `connectionFor(Capability.GIT)`) is pinned in the source.

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
text, the README and the notifier's comment now say exactly that. The All computers screen (`A55`)
is not polled either: it re-lists every computer once when it opens (and on Refresh), and while its
Inbox tab is on screen every computer's Inbox counts as on screen. A computer the user just left is
one of them: its connection can stay open until it drops or the background check closes it, and a
change it pushes meanwhile is no longer re-listed (it used to be, and so announced live; the review
of A73). What that push carried is not recorded as seen, so the background check announces it. The
announce costs no network call (the listing already arrived), and the check writes the phone's
seen-log only when something is new. The decision and the screen bookkeeping are unit-tested; the
wiring into the refresh, the worker and the two screens is pinned in the source, and whether a
notification appears on a phone is a device check.

`SeenLogTest` covers the seen-log itself (`A48`, and its per-computer follow-up). It keeps each event
id with the time the phone last saw it (or the event's own time, when the computer's clock runs
ahead), and drops an entry a day after that, past the 6 h announce window, never by count (bar a
memory backstop no real Inbox reaches), so nothing still eligible is forgotten. It is kept PER COMPUTER: a desktop's
event id is `<ts>-<seq>` with a counter that restarts with each app run, so two computers can mint
the same id in the same millisecond, and with one phone-wide log the first computer's event would
have silenced the second one's notification. Every entry is filed under the pairing id of the
computer whose listing it came from, with the node its event belongs to. The node is what keeps one
event that reaches the phone through two pairings from being announced twice: a desktop's listing
carries the nodes of its SSH projects, and the SSH host it drives, when the phone added that one too,
lists the slice the desktop pushes there (`A27`), with the same event ids. So an event also counts
as seen when another pairing recorded the same id for the same node, and meeting it that way records
it under this pairing too, so forgetting the other one later does not announce it again. A real
collision, two computers minting the same id for different nodes, stays apart; the same id for the
same node on two computers would need one node id on both (a canvas committed to two repositories)
and the same millisecond and counter value. Forgetting a computer drops its entries; pairing the same
computer again (a new pairing id) carries them over, since its ids continue, so pairing again
announces nothing a second time; and nothing is recorded for a computer no longer paired. The
phone-wide log of the previous build (and the older bare id set) migrates on first use as seen for
EVERY computer, because it never said which computer an entry came from; those entries age out a day
after they were last seen and nothing new is added to them, so an upgrade announces nothing again
and the old phone-wide behaviour lasts only that day, for those ids alone. The log's rules are
unit-tested; which computer each caller names is pinned in the source.

`NotificationActionsTest` covers answering from a notification, and where its tap goes (`A25`, the
in-app part). A notification had no actions, and its tap opened only the computer's Inbox. Now an
approval carries Approve and Deny and a single-select question its options, and the tap opens that
session's terminal, with the computer's Inbox one Back away. Which actions an event gets is the pure
`InboxNotificationActions.plan`, on the Inbox card's own rules: Approve and Deny only where
`QuickActions` can answer from outside the session (a held ticket, or a claude prompt), options only
where `QuestionChoices` lists them as answers, and at most three, Android's limit. A question with more
options, a multi-select one, another agent's approval without a ticket, and a computer the phone could
reach only through a first relay handshake get Open instead. With "Show details in notifications" off
the options are labelled "Option 1", "Option 2", … (`A52`). A tap reaches an unexported receiver
through an explicit, immutable PendingIntent. The receiver takes the actions off the notification
("Approving…", so a second tap cannot send a second answer) and hands the answer to expedited work, one
per event. The work connects the way the background check does and never makes a first relay
handshake, since the user tapped but is not looking at the app to compare the desktop's code (`A05`):
it reuses a connection already open, or takes the SSH leg or a relay that has already approved this
phone; otherwise the notification says to open the app. The phone cannot tell whether it is on a
computer's network before it dials, so a computer paired with an SSH key always gets the answers; one
tapped away from its network goes through a relay that has already approved this phone, or is not
sent ("couldn't reach"). Open replaces the answers only for a computer reached through the relay
alone that has not approved this phone; the listing that raised the notification normally came over
that relay and approved it. The answer is `QuickActions`', with its re-checks (still unresolved, the
node-state rules, the ticketed path of `A38`, and keys only for a card the computer still lists, since
a notification outlives the card in the desktop's feed), and it is sent at most once: a run
WorkManager starts again by itself after an interrupted one (the system stopped the work, or the
process died during it) sends nothing and says the answer could not be confirmed
(`InboxNotificationActions.answerOnce`, on the run attempt count). The answer, the background check
and the screens share one connection per computer, which is closed when a background job ends only if
no other job and no screen still uses it (`ConnectionUsers`). The notification then says how it went.
"Approved.", "Denied.", "Answered with option N." and "Already handled." go away after 10 s; a
timed-out hold, a request only the session can answer, an answer not sent (and why) and one that could
not be confirmed stay, and their tap opens the session.
The app does not open the session by itself at that point: Android 12 forbids starting an activity
from a notification's receiver or service (a "trampoline"), and Android 10 forbids starting one from
the background, so the notification says "Tap to …" instead. An answering action needs an unlocked
phone: Android 12 and later ask for the unlock before they send it (`setAuthenticationRequired`);
Android 11 and lower send it from a locked screen, so there the receiver refuses and says to unlock.
The plan, the answer run against `QuickActions` (every answer the plan offers is one `QuickActions`
sends, and none is typed for a card the feed dropped), the work's whole run (a rerun sends nothing,
every dial happens while the connection is held), the outcomes and the hand-off's encoding are
unit-tested, and `ConnectionUsersTest` covers the shared connection (two overlapping jobs close it
once, after the last); the PendingIntents, the receiver, the work, its dial trigger and the tap's
route are pinned in the source, and whether the actions show and answer on a phone is a device
check.

`AllComputersTest` covers the All computers screen and the needs-you counts (`A55`). iOS merges its
Agents feed across every paired connection and shows one Usages section per connection that reports
usage (docs/mobile-usage-inbox.md); Android had one computer's Inbox and Usage, inside that
computer's screen, and the computers list showed no count. Now each computer's row shows how many of
its approvals and questions are open, read from the listing its session already holds (the open
screen's, the background check's, or the last one this process made), so the list dials nothing;
before a computer's first listing in a process its row shows no count. With two or more computers
paired, the list starts with "All computers": every computer's Inbox and Usage on one screen. The
rules are the pure `AllComputers` and `InboxFeed`: events of every computer newest first (a stable
sort, so the same moment keeps the computers' order), open cards above the archive, the working
sessions in the computers' order rather than by time (their time moves with every tool call), every
card keyed and labelled by its computer (a name two computers share gets `user@host`, and the same
computer paired twice a number), and one Usage section per computer whose mirror has accounts in its
`usage` block. A computer's own Inbox tab is the same `InboxFeed` of that one computer, so the two
cannot sort or count differently. Opening the screen (and coming back to it, or Refresh) re-lists
every paired computer once through its normal connect path, so a relay leg goes through
`RelayApprovalGate`; it is not polled after that. That re-list is the app's own foreground refresh
(`Trigger.AUTO`), not a tap on each computer: a computer that has never approved this phone shows its
approval code on this screen, labelled with its computer, but one whose approval was refused or went
unanswered keeps its hold, and says so with a Try again of its own (`Trigger.USER`). Lifting every
hold on every visit would raise the desktop's dialog again, each time, on a computer the user did not
ask about and may not be at (`A05`/`A23`). A computer whose last listing failed says so too, with the
same Try again, also when the failure dropped its connection (an error the phone did not expect leaves
the session idle): nothing on this screen re-lists it on its own, so its cached cards would otherwise
stay on screen looking current. A computer's own screen shows that error under the same rule
(`ConnState.showsListError`). Open, Approve and Answer on a card go to the card's own
computer: its session and connection, and its relay leg for a node of that computer's SSH projects.
The cards are the Inbox tab's composables (`InboxFeedList`, `UsageCard`), not copies. The rules are
unit-tested; the screen, the row count and the route (saved in the back stack as `["all"]`, a name
of its own, so every earlier entry restores as before and a build that does not know it drops just
that entry) are type-checked and pinned in the source, and how the screen looks and answers on a
phone is a device check.

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

`DictationTest` covers dictation into the terminal's input bar (`A59`). The phone had none: iOS and
the desktop dictate with on-device Whisper, and Android had only the keyboard's own voice typing,
which still works in the field. Now a mic button beside Send runs Android's `SpeechRecognizer` and
writes what it hears into the draft, and never sends it: the draft reaches the pane only on Send,
the desktop's rule for its own dictation ("nothing auto-submits"). The rules are the pure
`Dictation` machine. Its phases are idle, listening, partial (words heard so far, shown in the draft
as they come), finishing and an error with a short sentence. A tap on the mic while listening asks
for the final result (finishing), and a second tap cancels, so a recognizer that never answers
cannot keep the button stuck. The final result is an event that fills the draft and returns to idle.
The draft as it was when the dictation started is kept, and the heard words are appended after a
space (none after a trailing space or newline). Each partial result replaces the previous one rather
than piling up, and a blank final result keeps what the partial results showed. Each time dictation
writes the draft the cursor goes to its end, after the heard words, so typing after a dictation
continues there. (The draft was a plain string at first, and the field's string overload keeps the
previous cursor when the text is set from code: after dictating into an empty draft the cursor stayed
at the start, and the next keystroke went in front of the words.) Any other change to the draft's
text while listening (typing, or Send clearing it) ends the dictation, so its late results cannot
bring back text that was sent or deleted; moving the cursor changes no text and ends nothing.
Whatever the draft shows when a dictation is cancelled or fails stays in it. Each of the 15
`SpeechRecognizer.ERROR_*` codes maps to a failure with a short message, and any other code to a
generic one; a test reads the codes out of the android-all jar the type-check compiles against,
and is skipped where that jar is not in the Gradle cache (CI). The microphone permission (`RECORD_AUDIO`) is asked for on the first tap. A refusal says
how to allow it, and the manifest does not require a microphone. The button is hidden when
`SpeechRecognizer.isRecognitionAvailable` is false, which on Android 11 and later needs the
manifest's `<queries>` entry for `android.speech.RecognitionService`. The screen cancels a dictation
when it stops (nothing listens in the background) and releases the recognizer when it goes. No
language is set (`RecognizerIntent.EXTRA_LANGUAGE` is left out), so the recognizer uses the phone's
own language: the one the user chose for the phone and its voice input. The desktop's dictation
likewise pins no language by default (`auto`, Whisper's own detection). A picker would have to come from the recognizer's own supported list
(`checkRecognitionSupport`, Android 13 and later), not the desktop's Whisper list. The recognizer is
the phone's recognition service (Google's on most phones), which may send the audio to its servers,
unlike Whisper. The machine and the error codes are unit-tested; the recognizer's wiring, the
permission request and the manifest are pinned in the source; how the dictation sounds and behaves
on a phone is a device check.

## Device checklist

Partial results are recorded in "What is verified, and how": the private minified beta is installed
on the intended Pixel 10 Pro (Android 17 / API 37, Vanadium WebView `154.0.8037.92.0`), with manual
SSH key/pin authentication, 17 real projects listed and basic terminal input executed. The wrong
MI8 installation and its newly authorized SSH key were removed. The terminal-sizing/history
failure `A85` is fixed in code-3 beta, with a 52×45 viewport and pre-attach tmux history visible after
swiping. The code-4 scroll mitigation update also preserved SSH registration/key/pin and notification
permission and verified reduced drag gain, reversal and Esc cancellation. Beta 4 delivered more
movement but lacked momentum; installed code-6 beta implements bounded fling/native stop but
still loses continued swipe/release events (`A89`). Code 7 received a same-signer update preserving
app data and notification permission; SSH reopened with the retained key/pin at 56×48. Controlled
continuous drag, coast and Esc stopping pass; a held touch stops coast at a stable 56×25 viewport.
Earlier IME-resizing touch checks were inconclusive; the user confirms normal drag/coast both
work now. Reversal/lifecycle/mobile and full checklist checks remain open. No complete item below has passed. Run these
on a real phone against a real desktop and record, for each item, pass or
fail, the phone model, its Android and WebView versions, the desktop's OS and nodeterm version, and
the route (network or relay). Write the results into "What is verified, and how" above, and turn each
failure into a new finding. Every item names the audit finding it checks; `A65` marks the baseline
checks that finding asked for, where the feature table is the only claim. An item that needs
something a tester may not have (a Windows desktop, Android 15, a second phone, a release key) says
so; skip it and record why. The list starts from the 23 items the handover drew up and adds what each
later fix left to a device.

### Install, update and what stays on the phone

1. For beta readiness, install two consecutive private betas using the same private signer and
   increasing version codes; pair on the first and update to the second without uninstalling, keeping
   the pairing. Also check the committed-debug-key path separately with two CI debug APKs (artifact
   `nodeterm-android-debug`). Migrating from debug to private beta needs one deliberate uninstall
   because the signing certificates differ; revoke the stale phone entries and pair again.
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
5. With the private-beta signing key: install the signed, minified release APK and run the pairing,
   SSH, relay, OSC 52 copy, links and Copy sheet, and background-notification items on it, since that is where code R8 could
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
   raises no SAS dialog on the desktop. Revoke the phone there (Settings → Phone → Revoke) while it
   has a terminal open over the relay (route Only through the relay): that terminal ends at once, SSH
   is refused, and the phone's automatic redial shows a code for a few seconds and then says the
   computer did not approve it, while the desktop shows no dialog at all; it stops dialing until Try
   again, which ends the same way. Restart nodeterm on the desktop and tap Try again: now the SAS
   dialog appears (deny it). Against an older desktop the toast says an approval is still owed, and
   the first relay connect shows the code. *(A07, A07-revoke)*
9. A pairing code whose computer does not answer (the desktop quit after showing the QR, or the phone
   is on another network) ends within about 45 s with a sentence, not an exception name, and Back
   during the wait works without a hang. An expired or already-used code shows the desktop's one-line
   refusal. *(A54)*

### Connecting

10. On the LAN (route Automatic): the Sessions tab shows the desktop's projects and sessions, grouped
    Needs you / Running / Sleeping, with activity and context %. *(A02, A65)*
11. Pair with a current desktop (macOS and Linux), then connect over the network: the first connect
    is accepted (the key the computer's sshd serves is one the pairing named) and pins it, and later
    connects use it silently. Then present a different key at that address (another SSH-running
    machine takes the desktop's LAN address, or the desktop's host keys are regenerated): on
    Automatic the phone refuses SSH, connects through the relay and keeps a warning on the host
    screen that names "Only through the relay"; on "Only on my network (SSH)" it stops with the
    warning. Do the same once between pairing and the first connect: the phone says the key is not
    one the computer reported, and pins nothing. With a current desktop, move it to another address
    on the LAN while the phone is away and connect through the relay, then come back: the next
    connect on the network dials the new address. Regenerate its host keys instead: the next connect
    on the network is refused and goes on to the relay, and the host screen's warning adds that the
    computer confirmed the key its SSH server presented; the connect after that (once the relay
    connection has ended) accepts the new key without pairing again. With sshd serving a host
    certificate, the pin is the certified key (`ssh-keygen -lf` of its `.pub`), and a renewed
    certificate connects silently. On a Linux computer, make sshd serve only a key the desktop
    cannot see (a `HostKey` outside `/etc/ssh` with no `.pub` beside it) and pair: the phone refuses
    SSH, connects through the relay on Automatic, and its warning says that pairing again changes
    this only if the keys changed.
    *(A49, A74)*
12. On cellular, off the LAN: connect through the relay. The desktop shows the SAS dialog and the phone
    shows the same code; approve. Reconnect later: no second prompt. On another pairing press Deny: the
    phone says it was not approved and does not dial again until Try again. Briefly enable airplane
    mode during connection, then recover: a stalled relay token request fails within about 30 s
    rather than connecting indefinitely; leaving the screen cancels it, and reopening can connect.
    *(A65, A30, A81)*
13. Leave the phone in the background for 15 minutes or more with a paired computer that has never
    approved it over the relay: no SAS dialog appears on the desktop. *(A05, A17, A23)*
14. Put the desktop to sleep (or pull its network) while the phone is connected over SSH: within about
    45 s the phone notices, and on Automatic it moves to the relay or says the computer is offline.
    Waking the desktop reconnects. *(A31)*
15. Open a computer and go Back before it has connected, several times in a row: no connection error
    is recorded for it, and the next open connects normally. *(A20)*
16. Change a computer's route in Settings → How to reach each computer and check that the next connect
    follows it; forget a computer; pair two computers and move between them. *(A65)*
17. Pair while the desktop's remote access is off (the toast says the phone is approved for remote
    access once the computer offers it), then turn it on and open the computer over the network: the
    host list gains "From anywhere" without the app being restarted. Then take the phone off the LAN
    with the app in the background for 15 minutes or more: the background check reaches the computer
    through the relay, and the desktop shows no SAS dialog; its `remote-approved-devices.json` now
    lists the phone's key. Open the computer off the LAN: it connects through the relay, again with
    no dialog. Revoke the phone on the desktop, pair it again with remote access off, and adopt the
    relay as above: still no dialog. The host list stays smooth while a connection is being made.
    *(A47, A65, A07-late)*

### Terminal

18. Open a terminal over SSH and type with the soft keyboard. Rotate the phone. Use A−/A+ and every
    key chip (Esc, Tab, ⇧Tab, the arrows, ⏎, ⇧⏎, ^C, ^D, ^R, ^L, Home, End, PgUp, PgDn): the
    connection survives all of it. *(A01, A04)*
19. Non-ASCII renders over SSH: Claude's rounded borders, accented letters, CJK, emoji. *(A03)*
20. Swipe to scroll the tmux history. A copy the pane makes reaches Android's clipboard (OSC 52) with a
    "Copied N lines" toast: in tmux's copy-mode (Ctrl, then b, then [ from the key row and the input
    bar), or from an application such as vim (`"+y`). Record slow/fast drag gain, reversal and
    movement after finger lift, stopping on a new touch, and automatic focus/mouse reports during a
    drag. Keep moving through terminal redraws and check that the remaining drag and release still
    work. *(A65, A85, A86, A87, A89)*
21. A large OSC 52 copy. In the pane, run
    `printf '\033]52;c;%s\a' "$(head -c 150000 /dev/zero | tr '\0' x | base64 | tr -d '\n')"`
    (the desktop's tmux passes an application's OSC 52 on): the phone says it is too large to copy and
    nothing crashes. With 450000 in place of 150000 the page refuses it before it crosses the bridge,
    with the same message. With 90000 it is copied, or, if the system refuses a clip that size, "Could
    not copy: too large for the clipboard." shows; never a crash. *(A53)*
22. Invalid OSC 52 is ignored silently: a payload that is not base64, one with no `;`, a `?` read
    query, and a selection field longer than 16 characters copy nothing, show nothing and leave the
    clipboard as it was. *(A53)*
23. The terminal uses its visible viewport height on initial open, after changing font size and
    with the keyboard shown/hidden; its host receives more than one row when the viewport has room.
    "Sized to another screen · Fit this screen" appears when the desktop's view of the session is
    larger, and Fit works. *(A65, A85)*
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
    beside "Open session". Repeat with the pane scrolled into tmux copy mode: the answer reaches the
    application and leaves copy mode, on both routes. Through the relay repeat with the desktop's
    terminal mounted and with its project offscreen/released, so the first background answer also
    works. A missing session must not type into a longer session name sharing its prefix.
    *(A12, A57, A65, A78, A79, A80)*
42. Open a finished session on the phone: the desktop's unread dot clears. On a host that runs its
    own nodeterm and is driven over SSH by another desktop, repeat for each desktop's sessions while
    both sweepers run: the owning desktop's unread dot/Done card clears and the other's pending
    acknowledgment is retained for its owner. Repeat with two SSH projects on the same host and
    after an owning desktop restarts with an old unresolved Done card. *(A65, A82)*
43. A background notification arrives within about 15 minutes; tapping it opens that session's
    terminal, with that computer's Inbox one Back away: at launch, with the app in the background, and
    with the app open on another computer. *(A11, A19, A25)*
44. Notification permission on Android 13 or later: deny it at first launch; Settings → Notifications
    then reads Off; switching it on asks again or opens the app's notification settings; nothing is
    posted while it is denied. *(A21)*
45. Live notifications for the computer on screen: with its Sessions tab open, a turn finishing on the
    desktop raises a notification within about 8 s; with its Inbox tab open, none, and none later;
    with a session's terminal attached, none for that session, except a held hook-reply approval.
    Another paired computer's events arrive only from the background check. *(A73)*
46. Each event notifies once: an event announced once is not announced again by later refreshes, by
    the background check, or after the next APK is installed over this one. With a desktop paired and
    the SSH server one of its projects runs on added too (item 64), an approval in that project
    notifies once, not once per computer, and reading it on either computer's Inbox keeps the other
    quiet. *(A48, A27)*
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
    reason that matches the case (New session's is the first row of the Sessions list, and the last
    session stays reachable above the button), and none of them opens a relay connection. In both
    cases a node of one of the desktop's SSH projects, opened, ended from the Sessions list or
    answered from the Inbox, is refused without a relay offer: "remote access isn't set up" in the
    first case, the "Only on my network (SSH)" setting named in the second. Then, with
    the host screen open on the same network: turn remote access OFF on a computer this phone already
    holds a relay token for — within one refresh (8 s) the controls turn disabled with "remote access
    is off on the computer", and no tap waits for the relay; turn it back ON — within one refresh
    they are enabled again. On a phone paired with it off, turning it on while the host screen is
    open enables them within a refresh or two, with no reconnect. *(A26)*

### Source control

53. From a project's heading (Sessions) or beside the Board's project picker, open Source control,
    through the relay and again on the same network (the relay leg next to SSH): the branch, the
    staged, changed and untracked files and the recent commits match the desktop's Source Control;
    a file's diff opens and Back closes it; stage, unstage, commit (the message box stays above the
    keyboard), push and pull act and the desktop shows the result; a push that fails there (no
    network, a rejected push) shows git's own message. An SSH project and a project with no folder
    say why instead of opening. With a merge that conflicted (on the computer, or a Pull from the
    phone), the conflicted files are under Conflicts, not Untracked, their diff shows the conflict
    markers, and Commit says to resolve them first. A commit whose pre-commit hook runs longer than
    30 s still lands, and the phone shows it. *(A29)*

### Links and copy in the terminal

54. Print a URL long enough to wrap over several rows, e.g.
    `printf 'https://example.com/%s/end\n' "$(head -c 300 /dev/zero | tr '\0' a)"` in a shell, and
    ask a Claude session to print one: tap the URL on its first, a middle and its last row. Each time
    a bar names the host and shows two lines of the URL, and nothing reached the pane (no click in
    Claude, no soft keyboard). The bar's All shows the WHOLE URL, scrolling inside the bar when it is
    long: the printf one starts `https://example.com/` and ends in `/end`, wherever the tap was; Less
    shortens it again. Open opens the browser on the whole URL; Copy puts it on the clipboard ("Copied
    the link"); × closes the bar. A tap or a drag on the bar's text, away from its buttons, changes
    nothing: no click or scroll in the pane, and the bar keeps its link even with another link under
    that spot. A tap on plain text, and a swipe that starts on a URL, behave as before. *(A32)*
55. An OSC 8 link: `printf '\033]8;;https://example.com/osc8\033\\label\033]8;;\033\\\n'` in the
    pane, then tap "label": the bar offers example.com and opens `https://example.com/osc8`. The same
    with `file:///etc/passwd` in place of the URL offers nothing. With a mouse connected, a click on a
    link in a session that is not under tmux (a Windows computer's), where the pane does not report
    the mouse, offers it too. *(A32)*
56. The key row's Copy chip opens a sheet of the screen's lines (with a session that is not under tmux,
    some scrollback too) and, above them, its links with Open and Copy. Tap lines to select them,
    long-press one to select the range from the last line tapped; Copy puts them on the clipboard
    ("Copied N lines"), Share opens the system share sheet, and Back or × closes the sheet. The sheet
    opens on the line at the top of the screen. A tap on the sheet's title, its instructions or its
    "No lines selected" line does nothing: no soft keyboard comes up, and nothing reaches the pane
    under the sheet (after closing it, the pane shows no click or scroll there). *(A32)*

### Notification actions

57. An approval notification (a held Claude permission, through the relay and again on the same
    network) shows Approve and Deny. With the phone unlocked, Approve answers it within a few seconds:
    the notification reads "Approving…", then "Approved." and goes away by itself, and the desktop's
    prompt is answered. Deny the same way. With the phone locked: on Android 12 or later the tap asks
    for the unlock first; on Android 8 to 11 the notification says to unlock and nothing is sent. On
    Android 11 or lower a short "Sending your answer…" notification shows while an answer is sent.
    *(A25)*
58. A single-select question with up to three options shows "Option 1", "Option 2", … (the options'
    text with "Show details in notifications" on, cut to fit); a tap answers it in the live session.
    One with four or more options, and a multi-select one, shows Open, which opens the session.
    *(A25, A57)*
59. Answer from a notification something already answered on the desktop: "Already handled.". Answer a
    held approval after its hold expired: the notification says it timed out, and its tap opens the
    session. Pair a computer with remote access off, let it raise an approval's notification on the
    same network, then leave that network (mobile data) and tap Approve: the notification reads
    "Not sent: couldn't reach …", and nothing appears on the desktop; with remote access on (and the
    phone approved for it at the scan), the same tap answers it through the relay. Tapping Approve twice quickly sends one answer, and Approve on
    two notifications of one computer a few seconds apart answers both. *(A25, A05, A06)*

### All computers

60. Pair two computers. Each row of the computers list shows "N need you" once that computer has
    been listed (opened, or checked in the background), and nothing before. "All computers" at the
    top of the list opens one screen: its Inbox lists both computers' cards newest first, each
    naming its computer; Approve, Answer and Open on a card act on that card's computer (try one on
    each, through the relay and on the same network), and its Usage tab shows one section per
    computer that reports usage, with the computer's name and when it was measured. Away from the
    network of a computer that has never approved this phone through the relay, opening the screen
    shows that computer's approval code under its name; deny it there, and opening the screen again
    shows the refusal with a Try again and puts no dialog on that desktop until Try again is tapped.
    With the screen on its Inbox tab, raise a permission prompt on one desktop and tap Refresh: its
    card appears on top, and no notification follows, then or later. Open a terminal from a card and
    come back, and kill the process in the background: the screen and its tab come back. *(A55, A05,
    A22, A43, A73)*

### Dictation

61. In a terminal, tap the mic beside Send. The first time, Android asks for the microphone: deny it,
    and the input bar says how to allow it; tap again and allow it. Speak a sentence: the words show in
    the draft as you speak, the final words replace them when you stop, and nothing reaches the pane
    until you tap Send. With text already typed, the dictation is added after it with one space. Type
    right after a dictation, with the keyboard still up: the text goes at the end, after the dictated
    words, both into an empty draft and after text typed before with the cursor moved into it. Tap
    the mic while speaking: it stops and fills the draft. Type while it listens: the dictation stops
    and later words do not come back. Move the cursor while it listens: it keeps listening. Start one
    and say nothing: one line says so ("No speech heard." or "Didn't catch that."), with an OK. In
    airplane mode, on a phone without offline speech recognition, one line says it could not reach
    the network. Send the app to the background while it listens: the microphone indicator (Android
    12 and later) goes off. On a phone with no speech recognition service (no Google app, say) the mic
    is not shown, and the keyboard's own voice typing still fills the field. *(A59)*

### A computer a desktop drives over SSH

62. Pair with a Linux computer that runs nodeterm and that another computer's nodeterm also uses as an
    SSH project host. On the same network, the Sessions tab lists that other desktop's project after
    this computer's own ones, marked "run here over SSH", with its sessions and, while that desktop is
    connected, their states; quit that desktop and within about two minutes those states read
    Unknown, while the sessions stay listed. Open one of its sessions and type; answer one of its
    approvals from the Inbox; end one of its sessions: the other desktop shows it ended. Its New
    session, board writes and Wake / Refresh / Rename say they belong to the other computer. A node of
    the paired desktop's own SSH projects still opens through the relay. *(A27, A09)*

### A computer added by its SSH address

63. On a Linux computer with a Server Edition installed (`install-server.sh`) and no desktop app,
    tap "Add SSH server" on the computers list, fill in address, port and user, and tap Connect
    before adding the key: it says the computer did not accept the phone's key, and nothing is
    added. Share the key line to yourself, run the screen's command on the computer as that user (in
    bash, then once more in fish or zsh: the key is in `~/.ssh/authorized_keys` once, the file `600`
    and `~/.ssh` `700`), and tap Connect: the computer is added and the screen shows a `SHA256:`
    fingerprint that matches one line of the screen's `ssh-keygen` command on the computer. Open it:
    the Sessions tab lists the Server Edition's projects, the host screen shows its version, and a
    session opens and takes keys. New session, board writes and Wake / Refresh / Rename say remote
    access isn't set up for this computer, and so does a session that is not running; Settings → How
    to reach each computer offers no choice for it. *(A27)*
64. Add a Linux dev host that another computer's nodeterm drives over SSH (no nodeterm of its own) by
    its address: its projects and sessions are listed as in item 62, and approvals are answered from
    the Inbox. Open one of its finished sessions on the phone: within about 15 s the other computer's
    nodeterm clears that session's unread dot. Then reinstall its SSH host keys (or point the address
    at another machine): the phone refuses it, saying to forget it and add it again. Forget it: the
    dialog names the `nodeterm-android` line to remove on the computer, and the computer leaves the
    list. Adding an address that is already in the list (paired or added) is refused with its name.
    *(A27, A49)*

## Known gaps

- **A pairing that recorded no relay key still asks once on the relay** (audit `A07-late`). The
  desktop approves a late-adopting phone by the box key its pairing recorded from the sealed `/pair`
  body. A pairing made by a phone that does not send `boxPublicKey` (the iOS app, until it adopts the
  field), or by a desktop older than `A07`, recorded none, so that phone's first relay connect after
  a late adoption still shows the SAS dialog, as it always did. Pairing again records the key. iOS can
  adopt `boxPublicKey` and `relayApproved` unchanged.
- **Push.** No FCM leg exists in the backend; the app polls (see android/README.md). The backend's
  `/v1/push/*` fan-out is APNs-only, so nothing wakes the app when an agent needs you, and there is no
  equivalent of iOS's Live Activities (an ongoing notification would need FCM or a foreground
  service). The desktop's phone-push switches (Needs you, Done, hold alerts while at the computer, the
  per-computer mute) gate only its own APNs send and are not in the mirror's `settings`, so no phone
  can read them; Android's per-kind control is its two notification channels. What the app does have
  (`A25`): the notifications it posts itself carry Approve / Deny and a question's options, and their
  tap opens the session.
- **`/v1/relay/join`.** The request/response shape is not in this repo (the backend is separate).
  The client sends `{deviceToken, hostId}` and accepts `pairingToken`, `token` or `joinToken` —
  unverified against the live backend.
- **A computer added by its SSH address is SSH only, and has no push** (audit `A27`, part b). "Add
  SSH server" reaches a headless Server Edition or a dev host the phone reaches only over SSH, but
  only where the phone can open an SSH connection to it (the same network, or a VPN): there is no
  relay leg for it, ever, so nothing that goes through nodeterm the app (a new session, board writes,
  node actions, git) and no "from anywhere". It gets no push either: the grant an iOS phone drops in
  such a host's `~/.nodeterm/push-grants` and the backend's `/v1/push` fan-out are APNs-only (see
  Push), and Android drops none, so the phone polls it like any other computer; docs/SERVER.md's
  "full push / Live-Activity coverage" is iOS's. Not built: a one-time password login to install the key (the user adds the
  line), the Server Edition's `install-server.sh` one-liner offered per connection, and Windows (the
  browse is POSIX `sh` + tmux, as for a paired computer). The host key is trust on first use, as for
  a paired computer, but with no pairing LAN behind the first connect: compare the fingerprint the
  screen shows. Smaller limits of the browse: a Server Edition with a `--data-dir` elsewhere is not found unless the SSH session carries
  `NODETERM_DATA_DIR`; a slice's freshness compares the phone's clock with the driving desktop's; on a
  computer that runs its own nodeterm AND is driven, launch settings come from its own mirror (a
  driven session's wake line uses its permission mode); a project whose sessions all start outside
  its folder (a worktree beside it) has no file found, so it is named by its id from its slice, and
  its plain terminals are listed under "Other sessions on this computer". When no data dir is found
  but another desktop's sessions are, the listing shows that desktop's projects and nothing of the
  `node-terminal` sessions of a nodeterm whose data dir the phone could not find (a Server Edition
  with `--data-dir` elsewhere), and nothing says they are missing.
- **Read-ack ownership is locally fixed; device validation remains open** (`A82`). Both the local
  `src/core/ack-sweep.ts` consumer and `sweepRemoteAcks` require ownership before reading/removing
  `~/.nodeterm/acks/<nodeId>.seen`. Remote ownership combines all connected projects on the host.
  Retained local files are retried when ownership changes, including restored unresolved Done
  cards. Android's actual producer/consumer interop is covered; the multi-desktop device case and
  iOS verification remain pending. Held approvals continue to use each hook's own `.answer` file.
- **Direct SSH is POSIX-only by design** (like iOS): board writes, node actions and new sessions
  go through nodeterm the app, so on the LAN the phone opens the computer's relay leg next to the
  SSH connection for them (`A26`, see "The relay leg next to SSH"). iOS writes `project.json` over
  SSH for some of these; Android deliberately does not (the host verbs exist because that write
  breaks past `MAX_ARG_STRLEN` and cannot reach an SSH project's file at all). The cost: while the
  computer has remote access OFF the phone cannot do them on the LAN at all (a relay token it got
  while remote access was on does not help: there is no relay to reach), where iOS can for a local
  folder project whose file still fits in one argv string. The controls say so instead of vanishing.
  How fast they notice is one listing: a toggle changed while no screen of that computer is open is
  seen when one is (the desktop's `relay.json` is the signal, and it can lag a desktop that crashed
  or quit with remote access on: the file stays, and a tap then waits out the relay before saying
  the computer did not answer).
- **Source control is the desktop's git bridge, and only that** (audit `A29`). Over direct SSH the
  phone has no git of its own: it opens the relay leg next to SSH for it, as for the other app-only
  verbs, so a phone with no relay leg (remote access off, or the route "Only on my network") cannot
  use it on the LAN, and says so. An SSH implementation (`git -C <cwd>` over the session, jailed to
  the project folders like the desktop's `isWithinRoots`) was deliberately not built: it would be a
  second copy of the bridge's rules on the phone. The bridge serves no branch switch, discard, init,
  publish, per-commit file list or older history (the desktop's default 50 commits), so the phone
  offers none of them. The desktop's SSH projects are not reachable from the phone's Source Control:
  the listing names their folder (`ssh.remoteCwd`), but that is a path on another host, which the
  desktop's own Source Control reaches over its ControlMaster, and the bridge's jail is this
  computer's local project folders, which normally do not include it. Merge conflicts are shown,
  never resolved: the phone neither edits a file nor stages an unmerged one (a terminal session can).
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
- **The SSH pin is anchored only by a current desktop, and the LAN address is refreshed only over the
  relay** (audit `A49`/`A74`). A desktop with `A49-anchor` names its SSH host keys in the sealed `/pair`
  answer and the first connect must present one of them; an older desktop, one that could not read
  its keys, a computer paired before this build and one added by its SSH address still pin on first
  use (on the pairing LAN, right after the QR, so normally the real computer), where a server that
  accepts any key could become the pin. An sshd that serves a key `ssh-host-keys.ts` cannot see is
  refused over SSH, as a key the computer did not report: a `HostKey` in a file `sshd_config`
  includes from elsewhere than `sshd_config.d/`, a relative `HostKey` path, a key with no `.pub`
  beside it (sshd needs only the private key), and a `HostKey` named only in a config file the
  desktop's user cannot read (some distributions install `sshd_config` and its drop-ins readable by
  root only; `/etc/ssh/ssh_host_*_key.pub` are still read there). Pairing again does not help: it
  re-reads the same files and names the same keys, and the phone has no way to accept the key it was
  refused (forgetting the computer and pairing again sets the same anchors). In Auto, with a relay
  leg, the phone then uses the relay and keeps its warning up at every connect; with "Only on my
  network", or a pairing with no relay leg, the computer is unreachable over SSH. The ways out:
  choose "Only through the relay" for it; or make the key visible to nodeterm on the computer (a
  readable `.pub` beside a key that is an `/etc/ssh/ssh_host_*_key` or a `HostKey` in a readable
  config) and pair again, or let a relay connect report it; or forget it and add it by its SSH
  address, which trusts on first use and has no relay or push (its screen's `ssh-keygen` command
  reads only `/etc/ssh`, so compare the fingerprint with `ssh-keyscan localhost | ssh-keygen -lf -`
  on the computer instead). The iOS app does not read the field yet. The relay refresh
  (`A74-refresh`) does not take the reader's answer as the truth about the pin: it drops one only for a
  key the SSH leg was refused that the reader also names, so a pin that works (one trusted on first use
  with an older desktop, on a computer whose sshd serves a key the reader misses) is kept. The
  refreshed address is the QR's `pickLanIPv4`, the first non-internal IPv4 adapter: on a computer
  with several (Ethernet and Wi-Fi, a VPN), it is whichever the OS lists first, which may not be the
  one the phone can reach; the relay then still serves. The refresh needs a relay connection, so a phone that only ever uses
  "Only on my network" keeps the pairing's address and keys, and the iOS app does not read `lan` yet.
- **Private beta device validation pending** (audit `A50`). AGP marks every debug build
  debuggable: anyone with adb access to the unlocked phone while USB
  debugging is on can read the app's files (`run-as`) and attach a debugger to the running app, whose
  code can use the Keystore key those files are sealed under. That is the phone's pairing
  credentials: the SSH key its computers accept, the relay box secret and the relay device token.
  android/README.md says so under Security. A private beta now has a local signing/verification
  tool and opt-in versioned unsigned CI inputs, documented in the README; its key and signed APK
  stay off Actions. The first private minified APK is installed on the intended Pixel and basic
  SSH listing/input works. The code-3 update fixes sizing/history (`A85`) and preserves identities;
  code-4 scroll mitigations pass protocol/type-check and local AGP/R8/signing checks, and its
  in-place update verifies identity persistence, reduced drag gain, reversal and Esc cancellation.
  The user reports that beta 3 still lags and moves too little; `A87` corrects automatic-report
  cancellation and restores responsive gesture gain. Beta-4 delivery and controlled movement pass
  in the verification record above. The user reports more movement but no momentum on finger lift;
  the bounded-fling code-6 beta builds/signs/updates and passes 658 protocol tests, but actual
  continuous swiping still stops. `A89` fixes the detached target; code-7 build/sign/update and
  658 protocol tests pass. Code 7 reopens SSH with its retained key/pin and verifies controlled
  continuous drag/coast/Esc. A held touch stops coast at a stable 56×25 viewport; earlier
  IME-resizing touch checks were inconclusive. The user confirms normal drag/coast both work.
  Reversal/lifecycle/mobile, FPS/custom bindings and the full device pass remain open.
  The desktop's Android link continues to open the `android/` source folder and both
  phone surfaces label it "nodeterm for Android (build from source)" (`ANDROID_APP_LABEL` in
  `src/renderer/lib/links.ts`, audit `A66`); drop that label when the link points at a release.
- **Dictation is the phone's own recognizer, not Whisper** (audit `A59`). The input bar's mic uses
  Android's `SpeechRecognizer` (see "What is verified, and how"), which on most phones is Google's
  service and may send the audio to its servers. iOS and the desktop transcribe on the device with
  Whisper; running whisper.cpp on the phone would be a native build and model downloads of its own.
  The Cloud engine iOS and the desktop share (`/v1/transcribe`, multipart WAV and a locale) does not
  exist on the backend yet (`src/core/speech/cloud-speech.ts` maps its 404 to "not available yet"),
  so there is nothing for Android to send that request to either. The language is the phone's own,
  with no picker (the desktop's list is Whisper's; iOS keeps its own, issue #591). The phone
  keyboard's own voice typing (Gboard's mic, say) also works in the input bar, mic button or not.
- **Instrumented UI tests** and a store listing do not exist yet.
