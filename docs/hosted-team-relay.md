# Hosted team relay (a Server Edition as the relay host)

**Status:** sub-project 1 of "team on an SSH host", built on `feat/hosted-team-relay` (2026-09).
Everything below was checked against the code on that branch. Where the design spec says something
else, the code wins; the spec is a local planning file and is not the reference.

**Builds on:** `docs/remote-sessions.md` (relay tabs, the trust gate, Team Access) and
`docs/team-presence.md` (presence, co-attach, canvas sync).

## What it is

A Server Edition core on a Linux host can now be a **standing relay host** for a team. Teammates'
desktops join it over the same E2EE relay that Team Access uses, with no SSH access of their own
and no inbound port on the host. The owner does not need their own laptop to be awake: the host
keeps one idle relay listener registered at all times, and each device an owner approved once is
pinned in the host's `team.json`, so it reconnects without anyone approving it again. Each member
has a role (Viewer, Commenter, Editor or Owner), and **the role is enforced in the host core, on
every message**. The desktop's UI only mirrors it.

## How it fits together

| Piece | Where | Notes |
|---|---|---|
| Relay mechanism (E2EE socket, trust gate, host and client sessions) | `src/core/relay/` | Moved from `src/main/remote/`, which now holds re-export shims and the desktop's own wrappers. Team Access and the hosted team run the **same** handshake and tunnel (`relay-host.ts`). |
| The seam | `relay-host.ts` `PeerAttach`, `PinStore`, `RelayHostHooks` | A host that passes no hooks (the desktop's Team Access) takes the unhooked path, unchanged. |
| Hosted service | `src/core/relay/hosted-service.ts` | Composes the host key, team store, scheduler and access policy; holds pending join requests; answers the `relay:hosted:*` verbs. |
| Standing listener | `hosted-scheduler.ts` + `host-token.ts` | A pure scheduler over injected mint / open / timers. |
| Host identity | `host-key.ts` | `<dataDir>/relay/host-key.json`, 0600, plaintext secret (headless Linux has no keyring). |
| Membership | `team-store.ts` | `<dataDir>/relay/team.json`, 0600, single writer. |
| Role policy | `access-policy.ts` | `VIEW`, `COMMENT`, `EDITOR_ONLY`, `VIEW_EVENTS`; the guard test is `access-policy.guard.test.ts`. |
| Admin channel | `team-admin.ts` (socket) + `src/server/team-cli.ts` (CLI) | `<dataDir>/relay/admin.sock`, 0600 in a 0700 directory. |
| Server boot | `src/server/index.ts` (search "Hosted team relay") | Booted in headless AND serving mode, after every handler is registered and the workspace index is loaded. |
| Desktop joiner | `src/main/remote/hosted-join.ts`, `relay-bookmarks.ts`; core `join-code.ts`, `join-token.ts` | Runs the core relay client with **no pin store**. |
| Renderer | `lib/hostedJoin.ts`, `lib/hostedAttempts.ts`, `lib/hostedOwner.ts`, `lib/hostedPendingQueue.ts`, `components/HostedApprovalDialog.tsx`, `bridge/hosted-gate.ts`, `bridge/relay-local-close.ts`, `@shared/hosted-access.ts` | Every hosted branch sits behind a join code, a hosted api or a hosted role, so a Team Access tab and a local tab take their old paths (`canvas/hosted-team.source.test.ts`). |
| End-to-end test | `src/server/hosted-e2e.test.ts` | A real headless server boot, the real admin socket, access policy, `PtyManager` and trust gates, with an in-process relay and a fake token API. |

## Setup over SSH

Run every `team` command **as the unix user the nodeterm service runs as**, on the host. The CLI
never touches `team.json` or the host key itself. It talks to the running server over the admin
socket, so the service must be up. `install-server.sh` puts the app in `~/.nodeterm-server-app` and
the data in `~/.nodeterm-server`. When it provisioned its own Node, `node` may not be on `PATH`;
the service's `ExecStart` line (`systemctl --user cat nodeterm-server`, or the system unit for a
root install) names the exact binary and script to use.

```bash
APP=~/.nodeterm-server-app/out/server/main.cjs

node $APP team init                                    # host key + team.json, starts hosting
node $APP team add-owner <your device key> --label "<you>"
node $APP team share <projectId>                       # what the team can see
node $APP team info --json                             # address + join code
```

`--data-dir <dir>` (anywhere on the line) or `NODETERM_DATA_DIR` points the CLI at a server running
with a non-default data directory. `node $APP team --help` prints the verb list. Exit codes: 0 done,
1 the server refused or could not be reached (or the command ran but its outcome did not happen,
such as hosting not starting), 2 the command line is wrong.

| Command | Effect |
|---|---|
| `team init` | Creates the host key (once) and `team.json` if absent, then starts hosting. Prints the address and join code when hosting started. An unreadable key is refused, never replaced. |
| `team add-owner <device-key> [--label <name>]` | Pins that device as an **owner**. An existing member's key is promoted to owner. The key must be the canonical 44-character base64 public key; a typo gets its own message before anything is sent. |
| `team remove <device-key> [--force]` | Unpins the key and cuts its live sessions (they are told `removed`). Removing the last owner needs `--force`. |
| `team share <projectId>` / `team unshare <projectId>` | Adds or removes a project in `sharedProjects`. The id is **not** checked against the workspace. An unshare applies to the next message: a Viewer already watching one of its terminals gets no more output from it. |
| `team info [--json]` | The team address and join code. The plain form prints the join code only while hosting is on; `--json` returns `{enabled, info, joinCode}`. |
| `team status [--json]` | Hosting state, members, and pending join requests (see [Status and troubleshooting](#status-and-troubleshooting)). |
| `team rotate-key` | Replaces the host key. Every bookmark and join code stops working. A hosting service restarts on the new key; one that was not hosting stays off. |

With no team on the server, the admin socket answers only `init`, `status` and `info`: every other
verb would create team state on a server that never asked to host.

### 1. The project must already be on this core

`team share` takes a project id from this core's workspace index, `<dataDir>/workspace.json`
(`entries[].id`, beside each entry's `name` and `cwd`). Adopting an existing SSH project into the
server core is sub-project 3; in v1 the folder has to be opened on the core once, from the Server
Edition's browser UI. The installer's unit runs the server **headless** (`NODETERM_HEADLESS=1`), so
there is no UI until you run it once in serving mode:

```bash
systemctl --user stop nodeterm-server        # `systemctl stop …` for a root install
cd ~/.nodeterm-server-app                    # REQUIRED: the UI is found relative to this directory
NODETERM_SERVER_PASSWORD='<choose one>' node out/server/main.cjs
# From your desktop: ssh -L 8443:127.0.0.1:8443 <host>, open http://127.0.0.1:8443, sign in,
# open the folder as a project. Then Ctrl-C the server and:
systemctl --user start nodeterm-server
```

**Run it from the app directory** (or pass `--renderer-dir ~/.nodeterm-server-app/out/renderer`).
The built UI is looked up as `out/renderer` relative to the current directory; the unit only works
because it sets `WorkingDirectory` to the app directory. Started from `$HOME`, sign-in succeeds and
then `/` answers `{"error":"not_found"}`, with no warning at boot.

Serving mode puts the web UI (password sign-in) on the configured bind, `127.0.0.1:8443` by
default, so you reach it through an SSH tunnel. The password seeds only when none exists yet
(`docs/SERVER.md`), and serving mode hosts the team too. **Stop the service first.** A second server
on the same data directory still serves the UI, but it skips hosting ("Hosted team relay: NOT
started — another nodeterm server is already running on this data directory …") and disables its
agent hooks.

To keep the UI running instead (the route [Limitations](#limitations-v1) needs for saving canvas
edits), switch the unit to serving mode with a drop-in rather than by editing the unit:

```bash
mkdir -p ~/.config/systemd/user/nodeterm-server.service.d
printf '[Service]\nEnvironment=NODETERM_HEADLESS=\n' \
  > ~/.config/systemd/user/nodeterm-server.service.d/serving.conf
systemctl --user daemon-reload && systemctl --user restart nodeterm-server
```

An empty `NODETERM_HEADLESS` is not headless. A drop-in is parsed after the unit and the later
assignment wins, and the installer (re-run daily by its auto-update) rewrites only the `.service`
file, never its `.d/` directory, so the drop-in survives updates. For a root install the directory
is `/etc/systemd/system/nodeterm-server.service.d/`, with plain `systemctl`. If no password exists
yet, the first boot prints a one-time setup URL to the journal.

A joiner's tab shows **one** project: the first shared project in the host's workspace order
(`openRelayTab` adopts `projects[0]` of the narrowed workspace). With nothing shared, even an owner
gets an empty tab, because `workspace:load` is narrowed to `sharedProjects` for every hosted peer,
owners included.

### 2. Your desktop's device key

The key is the `publicKey` field of `<userData>/remote-peer-key.json` on your desktop
(`src/main/remote/peer-identity.ts`). The public key is always stored as plaintext base64, even when
the keyring encrypts the secret next to it (`key-file-codec.ts`), so it is readable either way.

`<userData>` is named after `package.json`'s `name`, **`node-terminal`**, not the product name
(the shipped hook scripts search the same directories): `~/Library/Application Support/node-terminal`
on macOS, `~/.config/node-terminal` on Linux, `%APPDATA%\node-terminal` on Windows. On macOS:

```bash
grep -o '"publicKey":"[^"]*"' ~/Library/Application\ Support/node-terminal/remote-peer-key.json | cut -d'"' -f4
# not there? look under any app name before assuming there is no key yet:
ls ~/Library/Application\ Support/*/remote-peer-key.json
```

No UI shows this key in v1; sub-project 3 automates this step.

The file is created the first time the desktop hosts a Team Access invite, connects to another
desktop's pairing code (New Remote Connection) or joins a hosted team. Pairing a **phone** does not
create it; that uses a different key file (`remote-host-key.json`). Only if the file is really not
there, paste the team's join code once (step 3); that join spends one of the team's shared device
mints.
While your desktop asks you to read a code to an owner, `team status --json` lists your device under
`pending` with its `peerKeyB64` and `sas`. Take the key whose `sas` matches your prompt, press Cancel
on the prompt (that ends the request), run `team add-owner` with that key, and paste the code again.
A request that is still pending when its key becomes an owner is not upgraded; it would wait out its
10 minutes.

### 3. The first connect

On the desktop, choose **New Remote Connection** (dock or ⌘K) and paste the
`nodeterm://join?code=…` code. The host already trusts an owner's key, so it approves its own half
without anyone. Your desktop has no record of this host yet, so it asks once, with the SAS, to "read
this code to an owner"; nobody on the host compares it (the host key itself is checked against the
one in the join code), so press OK. The desktop records the approval in its bookmark, and every
later connect opens without a prompt.

### 4. Inviting teammates

An owner's hosted tab has **Copy team invite code** in the command palette; `team info` prints the
same code. A join code carries public material only (relay endpoint, host id, host public key, host
device id, label). A leaked code cannot get anyone in, because an owner still approves each device.
It **can** take hosting offline, though, and removing the member who leaked it does not stop that:
see [Threat notes](#threat-notes).

The teammate pastes it into New Remote Connection and reads the SAS it shows to an owner (a call
or a chat). The owner's desktop shows "A device wants to join" with the same SAS, a device-key
fingerprint (the key's first 8 characters) and a role picker that defaults to **Viewer**. Allow
grants the chosen role once the joiner has pressed OK too.

## Roles

Generated from `src/core/relay/access-policy.ts`. Owners and editors pass every check (Editor is
shell access, so gating it would be theatre); Viewers and Commenters get **only** what `VIEW` /
`COMMENT` list, each with its own argument check. Anything else, including every channel added
later, is Editor-only until someone decides otherwise.

| Capability | Viewer | Commenter | Editor | Owner |
|---|---|---|---|---|
| See the shared projects' canvas, presence and cursors (`workspace:load`, `presence:hello/cursor/focus/project`) | ✓ | ✓ | ✓ | ✓ |
| Watch a terminal of a shared project that is **already running** | ✓ | ✓ | ✓ | ✓ |
| Read files inside a shared project | ✓ | ✓ | ✓ | ✓ |
| Read a shared project's git state (status, diffs, history, file versions) | only when the project is the top folder of its own repository | same as Viewer | ✓ | ✓ |
| Read a shared project's board log | ✓ | ✓ | ✓ | ✓ |
| Cursor chat (`presence:chat`), board-log comments (`board-log:append`) | — | ✓ | ✓ | ✓ |
| Type into terminals, start terminals, write files, every git mutation, canvas edits, settings, credentials, logs, GitHub | — | — | ✓ | ✓ |
| Approve or deny join requests, read the invite code, see pending requests | — | — | — | ✓ |

`relay:hosted:self` (the caller's own role) is open to any member. The `relay:hosted:*` verbs are
intercepted by `hosted-service.ts` before the table is consulted, and each judges the **caller's own
session key** in the team store.

**"Read" is not "safe": every viewer channel carries its own check.**

| Channels | What a Viewer / Commenter may do |
|---|---|
| `pty:create` | Only for a node of a shared project. The options are rewritten to `persistKey`, `cols`, `rows` and `viewerId`, plus `joinOnly: true` and `sizeVote: false`. Everything else is stripped, including `sshRemote`, whose ssh args would run on the host during the existence probe. A join-only create that would spawn a new session answers `unavailable: 'join-only'`. |
| `pty:resize` | Rewritten to "not looking" (`null, null`): a viewer's window never sizes the shared terminal. |
| `pty:flow` | Resume only: a pause would freeze the shared process for everyone. |
| `pty:kill` | Detaches the caller's own view; the session keeps running. |
| `pty:capture`, `pty:read-scrollback`, `pty:pane-command` | Nodes of shared projects only. |
| `pty:tmux-status` | Allowed. |
| `fs:list`, `fs:read`, `fs:read-binary`, `fs:exists` | The path must be absolute and its **realpath** inside a shared project's cwd (also realpathed). A symlink planted inside the project that points out of it is outside. |
| `git:status`, `git:repo-root`, `git:history` | The cwd is jailed like a file read, **and** the shared project that contains it must be the top folder of its own repository: a `.git` directory, or a worktree's `.git` file. Otherwise: "Git is available to viewers only in a project that is the top folder of its own repository, never in a subfolder of a larger one." A cwd jail alone does not bound git: `git status` and `git log` report the whole repository, and `git show <ref>:<path>` reads `<path>` from the repository's top level, so from a shared `repo/shared/` a Viewer could read `repo/secret/key.txt`. |
| `git:diff` | The cwd (with the repository rule above) **and** the file are jailed; a pathspec starting with `:` is refused; an untracked diff (`git diff --no-index`, which diffs any file) needs a real path inside. The file is relative to the cwd, not the repository's top level. |
| `git:show-file` | The cwd jailed, with the repository rule above; a ref starting with `-` is refused (it would become an option, and `--output=` writes a file). Any other revision is allowed. |
| `agent:subagent-snapshot` | The response is trimmed to shared nodes. |
| `board-log:read/subscribe/unsubscribe` (+ `append` for Commenters) | Shared projects only. A Commenter's `append` must be a comment (`kind: 'comment'`): an activity entry ("moved a card to Done") is Editor-only. |

**Which project a node is in** is read from the saved canvases (`WorkspaceStore.projectIdsForNode`).
Node ids travel in git-shared project files, so one id can sit in several projects; it counts as
shared only when **every** project holding it is shared, never by whichever comes first.

**Outbound is deny-by-default too.** The core broadcasts to every attached client, so a non-editor
receives only the events `VIEW_EVENTS` lists: `canvas:mut`, `workspace:external-change` /
`server-change` and `project-trust:changed` for shared projects; `agent:status` and
`agent:unread-clear` for shared nodes; `agent:subagent-activity` for subagents a shared node
started; `context:update`, `presence:sync` and `presence:peer` for everyone (see
[Limitations](#limitations-v1)); the per-session pty channels, which only a session's subscribers
receive; and `board-log:changed:<id>` / `project-setup:event:<id>` for shared projects.

**A terminal is judged by its node on every frame.** Terminal output and `pty:resync` (a repaint of
the screen) reach a non-editor only while the session's node is in a shared project. `pty:size`,
`pty:exit`, `pty:closed` and `pty:recycled` stop once the node is known to be outside every shared
project; for a session that has already ended they still pass, since all they carry is that fact.
This is what makes `team unshare` stop a terminal a Viewer is already watching: the subscription
itself outlives the unshare, but nothing more of that terminal is delivered to it.

The renderer mirrors the two allowlists in `@shared/hosted-access.ts` (`bridge/hosted-gate.ts`
answers a refused call locally, in the host's words), and the guard test pins the mirror equal to
the host's tables. The mirror is convenience; the host is the boundary.

## Joining and reconnecting (desktop)

A join code runs `joinHostedTeam` in the main process:

1. Decode and verify the code: the host id must derive from the host key, and the relay must be
   `wss:` (or `ws:` to loopback). The same rule applies to the endpoint the API hands back.
2. Load this desktop's peer key **before** any mint, so a locked keyring costs nothing.
3. Get a device token: the bookmarked one, else **one** fresh `POST /v1/relay/device`. The device
   id sent is `<machine id>:<hostId>`, one per team: the backend refuses to re-register a device id
   for a second host on the free tier.
4. Trade it for a client token (`POST /v1/relay/join`). A `401` on a kept token earns one re-mint;
   a `403` earns none.
5. Connect with the host key from the code pinned. The core relay client runs with **no pin store**;
   the joiner-side pin is the bookmark's `approvedAt`.

Bookmarks live in `<userData>/relay-bookmarks.json` (0600, one per `hostId`): the join code, the
label, the device token, `approvedAt` and `source`. A bookmark auto-confirms only when `approvedAt`
is set **and** the code carries exactly the key it was recorded for. A host that refuses the device
(denied, removed, expired) withdraws `approvedAt`, so the next attempt shows the SAS again. The
token is never sent to the renderer.

A device token is never minted when it could not be kept. Before a mint, the bookmarks file must
be readable and parseable and its directory writable; a token whose write still fails is kept in
memory for the rest of the app run. A second join for the same team while one is still minting or
joining answers `E_JOIN_BUSY`.

**Reconnect, as built:**

- At boot, every **approved** bookmark reconnects in the background. No greyed tab is persisted;
  the tab appears once the connection is approved.
- A live hosted tab whose connection dropped with no reason from the host reconnects in place. It
  waits 1 s first, then tries at most 5 times (1, 2, 4, 8, 15 s, about 30 s in all), then stops
  with one notice ("Couldn't reconnect to X. Click its tab to try again."). A click is a fresh
  attempt. A boot reconnect that runs out says to paste the invite code instead.
- Unattended attempts (boot and drop reconnects) retry `E_JOIN_NETWORK` on 1, 2, 4, 8, 15 s, then
  every 60 s, and `E_JOIN_THROTTLED` no sooner than 60 s (or the Retry-After), announced once per
  streak. Nothing else retries, and a pasted code never retries: it is told once.
- Closing or deleting the tab cancels its team's attempt in any phase. At most one attempt and one
  live connection exist per team.
- **Forget hosted team: <name>** in the palette removes the bookmark and stops the reconnect. It
  changes nothing on the host; the device stays a member until `team remove`.
- A reconnect in place keeps the tab's last-seen nodes (the pre-existing re-fetch follow-up in
  `docs/remote-sessions.md`).

**What the joiner is told** (`@shared/relay-join-errors.ts` for the codes, `lib/hostedTeam.ts` for
the sentences):

| Code | Cause (main) | Retried unattended? | What the user sees |
|---|---|---|---|
| `E_JOIN_BAD_CODE` | The code does not decode or verify | No | "The invite code for X is not valid. Ask an owner for a fresh code." |
| `E_JOIN_REFUSED` | `/device` refused (not 429 or 5xx), a freshly minted token rejected, or an unreadable/unwritable bookmarks file | No | "Could not join X: " + main's sentence (it names the file when that is the cause) |
| `E_JOIN_RATE` | `/device` 429 without `scope:'ip'`: the free daily device-mint damper | No | "Too many join attempts for X today. Try again tomorrow." |
| `E_JOIN_THROTTLED` | A 429 with `scope:'ip'` on `/device`, or any 429 on `/join`: the per-IP limiter (30 a minute) | Yes, ≥ 60 s | Unattended: "The nodeterm service is limiting requests from this network — retrying in a minute." (once per streak). A pasted code: "… Try again in a minute." |
| `E_JOIN_NETWORK` | Fetch failure or timeout, a 5xx, a malformed reply, a relay endpoint the desktop will not dial, anything unexpected | Yes | A pasted code: "Could not reach X: …". An unattended attempt keeps retrying without a notice. |
| `E_JOIN_REVOKED` | `/join` 403: the backend revoked this device | No | "This device's access to X was revoked. Remove the team and join again with a fresh invite code.", with a **Remove and rejoin** action |
| `E_JOIN_KEY_LOCKED` | Loading this desktop's peer key failed: a locked keyring, or any other failure to read `remote-peer-key.json` | No | "Could not load this device's identity to join X: " + the loader's sentence (for a locked keyring, how to unlock) |
| `E_JOIN_BUSY` | Another join of ours for the same team is still running | No | Nothing: the running attempt answers |

Once connected, the host's own refusals arrive over the encrypted tunnel: "An owner declined the
request.", "No owner answered the request in time." (a first join waits up to the host's 10-minute
pending window) and "Your access to this team was removed by an owner.". While a mount is still
unapproved after 2.5 s, the tab says "Waiting for an owner of X to approve this device…".

## Owner approval

- A device whose key is not in `team.json` becomes a **pending request**: `{pendingId, sas,
  peerKeyB64, since}`. It is sent to connected **owners only**, never broadcast, so a viewer never
  learns who is knocking. An owner who connects later is sent the ones still open, and pulls them
  once more on mount (`relay:hosted:pending`), because that replay can land before the tab
  subscribed.
- At most **one** request per device key (a newer connection replaces the older one) and **16** at
  once. A request expires after **10 minutes** or when the joiner's socket closes. Pending requests
  live in memory, so a service restart drops them. Only a bookmarked (already approved) reconnect
  retries on its own; a joiner who pasted a code reads "Could not open X: The relay connection
  closed before it was approved." once and pastes it again.
- Owners answer from a **desktop** hosted tab. The dialog queues requests (keyed by `pendingId`,
  oldest first). Enter never approves, Escape denies only once the dialog is armed and never on a
  held key, and focus lands on Deny. When two owners answer one request, a second Allow is refused
  (the first one stands), but a **Deny beats an earlier Allow** until the request actually opens:
  an Allow still waits for the joiner's own OK and for the pin write, and a Deny that lands in that
  window refuses the device. An owner whose screen still showed a request that closed is told
  "Another owner answered this request."
- An approval is pinned only after **both** humans confirmed. A deny or expiry that lands while that
  pin is being written wins: the write is skipped, or taken back. A key that gained a team entry
  meanwhile (a `team add-owner` of the same key) keeps that entry: the approval writes nothing.
- The CLI has **no** approve verb. `team status` lists pending requests by SAS and says to approve
  from an owner's desktop. The only way the CLI admits a device is `team add-owner`, which makes it
  an owner.

## Status and troubleshooting

`team status --json` returns:

| Field | Meaning |
|---|---|
| `enabled` | A scheduler is running (hosting is on). |
| `off` | `null` while hosting is on; otherwise `{reason}`: `no-team` (run `team init`), `no-host-key`, `host-key-unreadable` (with `detail`, the loader's sentence), or `stopped`. |
| `scheduler.state` | `running`, `stopped`, or `backend-refused` (a 402/403 from `/v1/relay/host-token`: minting stops until the service restarts; `team init` does not restart it). |
| `scheduler.lastError` | The most recent failure **since the relay leg was last proven to work**, not a current fault: `network`, `network (<status>)`, `rate-limited (429)`, `refused (402)` / `refused (403)`, `bad-response`, `mint failed: …`, `relay closed the idle listener`, `open failed: …`, or `mint budget`. It clears when an idle listener holds its registration to its refresh, or when a peer completes a handshake. |
| `scheduler.mintsLastHour` | Host tokens minted in the last (rolling) hour. The scheduler never mints more than **200** in an hour (counted per running service, so a restart starts over); the backend's free limit is 240. |
| `scheduler.idle` / `scheduler.bridged` | Idle listeners (the target is one) / sessions joined or awaiting approval. |
| `peers[]` | `{label, role, connected}`. No keys: find them in `team.json`. |
| `pending[]` | `{pendingId, sas, peerKeyB64, since}`. |

The human `team status` reads `state`, `idle` and `lastError` together:

| Line | Means |
|---|---|
| `Hosting: OFF — …` | `off.reason`, spelled out. For `host-key-unreadable` it is the loader's sentence. |
| `Hosting: STOPPED — the nodeterm API refused to issue relay tokens (…)` | `backend-refused`. Restart the service once the backend side is fixed. |
| `Hosting: ON — listening for teammates.` | An idle listener is registered. An "Earlier failure" line under it is history, not a fault. |
| `Hosting: ON, but not reachable yet — retrying. Last error: …` | No idle listener and a recent failure: minting or the relay is failing, with backoff. |
| `Hosting: ON — opening a listener.` | Starting up. |

**The scheduler's rules**, since they explain most of what `status` shows:

- Keep **one** idle listener registered. Refresh it 30 s before its token expires (measured on the
  server's clock from the response's `Date` header), never sooner than 15 s. With the relay's
  120 s host tokens that is one mint per 90 s, about 40 an hour while idle, plus one per peer that
  completes a handshake (its listener is replaced).
- Back off 1, 2, 4, 8, then every 15 s on failure. The backoff resets only on **proof the relay leg
  works** (an idle listener held to its refresh, or a completed handshake), or on a fresh start.
  **Never on a successful mint**: when the API is up and the relay is down every mint succeeds and
  every socket dies, and resetting on the mint re-minted at round-trip speed (relay log,
  2026-09-27).
- A 429 waits at least 60 s (longer if `Retry-After` says so).

**Common situations:**

- **`host-key-unreadable`.** Hosting stays off and the key is **not** replaced (a new key would
  invalidate every bookmark). Restore `host-key.json` from a backup and run `team init` (no restart
  needed). Or, on purpose, run `team rotate-key` **and then `team init`**: a rotation on a service
  that is not hosting (which an unreadable key means) leaves hosting off, and the CLI says so. Then
  hand out new join codes.
- **A corrupt `team.json`** is set aside as `team.json.corrupt-<ms>` and hosting starts **closed**:
  no members, so nobody auto-reconnects. Recover with `team add-owner`. A file listing one key twice
  counts as corrupt.
- **`team.json` edited by hand while the service runs** is not re-read until the service restarts;
  the next CLI write replaces it with the service's copy. Use the CLI.
- **Two servers on one data directory:** the second one finds the admin socket answering and
  **does not host** (it logs "Hosted team relay: NOT started — another nodeterm server is already
  running on this data directory …").
- **"The nodeterm server is not running (no admin socket …)"**: the service is down, runs with
  another data directory (pass `--data-dir`), or predates this feature and needs a restart after
  updating.
- **"Permission denied on …admin.sock"**: run `team` as the service's unix user.
- **The installer's daily auto-update** (unless installed with `NODETERM_NO_AUTOUPDATE=1`) rebuilds
  and restarts the service: live tabs drop and reconnect, and pending requests are lost.
- **Windows:** the admin channel is a unix socket, so both ends refuse by name. A team cannot be
  created on a Windows Server Edition in v1.
- **Hosting knocked offline by a join code** (see [Threat notes](#threat-notes)). `team status`
  shows `rate-limited (429)` as the last error, or teammates read "Too many join attempts … today".
  Give the host a new device id **and** a new key, then new codes:

  ```bash
  systemctl --user stop nodeterm-server        # `systemctl stop …` for a root install
  mv ~/.nodeterm-server/device-id ~/.nodeterm-server/device-id.old   # <dataDir>/device-id
  systemctl --user start nodeterm-server
  node $APP team rotate-key
  node $APP team info                          # the new join code
  ```

  The device id is a random id in `<dataDir>/device-id`; the service reads it on first use and keeps
  it for the life of the process, so replace it while the service is stopped. Hosting creates a new
  one when it next mints. The only other thing on the server that depends on that file is a stored
  Pro license (`<dataDir>/license.json`), which is bound to the id it was minted for and stops
  validating. `team rotate-key` gives the team a new address, so every bookmark and old code stops
  working. Members stay in `team.json`: each teammate pastes the new code once and presses OK on
  its prompt (the host approves a known key on its own), and each such rejoin spends one of the new
  device id's 10 daily device mints. Remove the member who leaked the code (`team remove`) if you
  have not.
- **Removing a teammate.** Approved devices are pinned with an **empty label**, and `team status`
  shows no keys. Find the key in `<dataDir>/relay/team.json` (match `addedAt`, or the 8-character
  fingerprint the approval dialog showed), then `team remove <key>`.
- **Changing a role.** There is no verb in v1. `team add-owner` promotes a key to owner; for any
  other change, `team remove` the key and approve the device again with the new role.

## Threat notes

- **The root of trust is the core's unix user.** Anyone who can run as it can read `host-key.json`
  and `team.json` and reach the admin socket, so they can make themselves owner. The socket's
  filesystem permissions are the whole gate (0600 in a 0700 directory); there is no admin token to
  leak into a pane's environment, but there is also no boundary inside one unix account.
- **Editor means shell access** as the core's unix user, and so, in practice, owner: an Editor's
  terminal runs as that user and can run `team add-owner`. The approval dialog says Editor is "the
  same as SSH access".
- **A Viewer sees terminal output** and can read **every file** under a shared project's folder,
  including `.env` files and `.git`. The approval dialog says so for the Viewer role: "Can read every
  file in the shared project's folder, .env files included, and watch its terminals and anything
  printed in them. Its git history too, when the folder is a repository of its own."
- **Sharing a repository shares its whole history.** When a shared project is the top folder of its
  own repository, `git:show-file` takes any revision, so a Viewer can read every branch, tag, stash
  and past commit of it, including files deleted since. A worktree shares its main repository's
  object store and refs, so sharing a worktree's folder exposes the whole repository's history
  (the main checkout's stash included), not only that checkout. A project that is a subfolder of a
  larger repository gets no git at all for Viewers and Commenters.
- **Nothing is served before mutual approval.** A pre-approval request answers `E_UNAUTHORIZED`
  and never reaches a handler. Frames that arrive between approval and open (while the pin is
  written) are held (at most 256), then served through the same checks.
- **A leaked join code cannot let anyone in**: every device still needs an owner's approval. At most
  16 requests wait at once, one per device key, each for 10 minutes; the 17th is refused.
- **A join code is enough to take hosting offline** (ruling R44). The code carries the host's device
  id and public key (`hosted-service.ts` `info()`), and those are exactly what the backend's
  `POST /v1/relay/host-token` takes: `{deviceId, hostPublicKeyB64}` (`host-token.ts`), with no proof
  that the caller holds the host's secret key. Its free-tier limit (240 host tokens an hour, a fixed
  window) is keyed by the `deviceId` sent, and the team's device mints (`POST /v1/relay/device`, 10 a
  day) by the host device id. So anyone holding a code, a teammate you removed included, can:
  - spend the host's hourly host-token budget, so the host's own mints are refused with 429 and
    hosting stays down until the window resets;
  - register listeners under the team's address. A joiner paired with one of them fails its
    handshake (only the real host has the secret key), so nothing is exposed, but that join fails;
  - open join requests with throwaway device keys until the 16 pending slots are full;
  - spend the team's 10 daily device mints, so a new teammate reads "Too many join attempts … today".

  `team remove` does not stop this, and neither does `team rotate-key` on its own: it changes the
  address, not the device id the budgets are keyed by. Recovery: "Hosting knocked offline by a join
  code" under [Status and troubleshooting](#status-and-troubleshooting). The real fix is on the
  backend (proof that the caller holds the host key before `/v1/relay/host-token` mints), a
  follow-up in `nodeterm-server`.
- **A pinned device key is a long-lived credential**, like an SSH key: a stolen laptop gets in
  until `team remove`. A removed key's live sessions are cut and told `removed`, and until the kill
  lands a session with no team entry is served nothing.
- **Mid-session key swap** cuts the session on both ends.
- **No forward secrecy.** The session key is derived from the two static keys plus per-session
  nonces exchanged in the handshake (`e2ee.ts`), so whoever later obtains either secret key can
  decrypt a recorded session. This predates the hosted relay.
- **The host key is never silently regenerated.** Only `team rotate-key` replaces it.

## Limitations (v1)

- **Presence and context metadata cross projects.** Non-editors receive `presence:sync` /
  `presence:peer` (focus, project ids, cursor chat of every client on the core) and
  `context:update` (token counts and model per agent session) for everything on the core, shared or
  not. The recommended deployment is **one core per team**.
- **A Viewer can still pause a shared terminal indirectly.** `pty:flow` pauses are refused, but a
  relay peer whose socket backlog passes 1 MB takes Stage 2's socket-backpressure ticket, which
  pauses the shared pty for every subscriber until that backlog drains below 256 KB or the peer
  leaves. Past 8 MB its output is dropped (redrawn later) and the pause is handed back
  (`ui-sink-registry.ts`).
- **Canvas edits in a hosted tab are not saved on the host.** A relay tab never writes the host's
  workspace (it would replace the whole host index with one project), and the core's canvas
  reflector persists nothing. So nodes a teammate adds, moves or deletes are live for everyone
  connected, but are not in the host's project file: a teammate who connects later, or everyone
  after a host restart, sees the saved canvas. A terminal an Editor starts that way keeps running
  on the host, but Viewers cannot watch it, because node membership is read from the saved canvas.
  **Workaround (verified in code, not yet run; device checklist item 12):** run the service in
  serving mode with the drop-in from setup step 1, and keep a Server Edition browser tab open on it
  through an SSH tunnel. The one-off serving run in step 1 is not enough: it ends by restarting the
  headless unit. The reflector sends every mutation to every attached client, and a browser's canvas
  applies it and marks itself dirty (to its store for a background project, to the live canvas for
  the active one), so its own autosave writes the edit. Edits made while no browser tab is attached,
  including across a service restart, are lost. This is a v1 limitation (ruling R42); a server-side
  persister belongs to sub-project 2.
- **Kanban, bridge and rope edits made in a relay tab are never propagated or saved.** `canvas:mut`
  carries nodes only (an upsert or a remove), so project-level state (`kanban`, `bridges`, `ropes`)
  never leaves the tab. This predates the hosted relay; it holds for Team Access relay tabs too.
- **No git for Viewers in a subfolder of a larger repository.** Viewers and Commenters get the git
  panel only for a project that is the top folder of its own repository (or a worktree's). A
  monorepo subfolder shows its files but refuses every git read (see [Roles](#roles)).
- **One shared project per tab.** A joiner's tab adopts the first shared project; other shared
  projects are allowed by the policy but not reachable from the UI.
- **Viewers watch only what is already running.** A terminal must be live on the host (a tmux
  session, or a session a client holds open). An SSH-project node is watchable only while the host
  core holds it live, because `sshRemote` is stripped from a viewer's create.
- **The role is read once per connection in the renderer.** A promotion or demotion reaches the tab's
  UI only after a reconnect. The host enforces the current role on every message regardless.
- **Viewer affordances are offered and then refused:** kanban card moves and column edits (they
  snap back), the add-node menus (the host refuses the terminal), Source Control and Explorer writes,
  and the board-log comment box for Viewers. Typing is blocked (`disableStdin`) and nodes cannot be
  dragged.
- **Owners approve only from a desktop hosted tab.** A Server Edition browser tab has no hosted api,
  and the CLI cannot approve.
- **A `pinFailed` session cannot be removed with `team remove`.** When both humans approved but the
  pin write failed, the session is served as a Viewer with no team entry, so `team remove` answers
  "No team member has that key." Restart the service: every session is cut, members reconnect on
  their own, and that device becomes a pending request again. (`team rotate-key` also works, but
  invalidates every join code.)
- **A board-log comment's author is what the commenter's tab says.** The entry is written as the
  client sent it, author included (its presence name and color), so a Commenter can post a comment
  under another member's name. The host checks the project and that it is a comment, not who wrote it.
- **Approved devices have no label** in `team.json` and `team status`, and there is no relabel verb.
- **Device mints are shared by the team.** The backend's free device-mint damper (10 per 24 h) is
  keyed by the **host's** device id, so every joiner of one team draws from one budget. A device
  mint that times out after the backend committed it mints again on the next attempt (the endpoint
  is not idempotent).
- **The 17th concurrent join request** (and an older request replaced by a newer one from the same
  device) is refused with the same `denied` reason an owner's decline sends, so that joiner reads
  "An owner declined the request."
- **Tabs are not persisted.** After an app restart the tab comes back when its boot reconnect is
  approved, never as a greyed placeholder.

## Surfaces

- **Desktop:** full. It joins by code, reconnects from bookmarks, and an owner's hosted tab
  approves requests and copies the invite code. A Viewer's tab gets the read-only banner, a
  read-only canvas and read-only terminals (canvas node and kanban card modal).
- **Server Edition:** the **host**, managed with the `team` CLI over SSH. Its browser clients are
  not hosted peers; the access policy never applies to them, and they cannot call `relay:hosted:*`
  (those verbs are intercepted inside the relay session and never registered on the platform). A
  join code pasted into a browser tab gets one "not supported in the browser build" notice.
- **Mobile:** N/A for v1. The phone still speaks the legacy relay dialect. The host it would join
  now exists in core (a standing listener on the tunnel dialect); the phone side needs the
  tunnel-dialect migration (`docs/ios-protocol-migration.md`) and a join flow modelled on
  `hosted-join.ts`. Nothing here has run against a phone. That is a follow-up for `nodeterm-ios`.

## Device checklist

Owed before recommending the feature. Run the core on a Linux host under a sub-user, with the owner
on a Mac and a second desktop as a teammate. Record `team status --json` at each step.

1. **Mac lid closed.** With the owner's Mac lid closed, an Editor teammate keeps typing, and can quit
   and relaunch the app and reconnect with no prompt on either side.
2. **Mints over one day.** Sample `scheduler.mintsLastHour` hourly for 24 h. Expected about 40 in an
   idle hour plus one per teammate connection; pass at 60 or less in an ordinary hour, and never
   `lastError: mint budget` (the 200 cap).
3. **Viewer refusals.** As a Viewer: the banner says "You're a Viewer in X — terminals are read-only.
   Ask an owner for Editor access."; typing into a terminal does nothing; nodes do not drag; an
   editor-node save and a Source Control commit are refused with "Viewers can't do that here. Ask an
   owner for Editor access." (record where each surface shows it); a kanban card move snaps back.
4. **Service restart.** `systemctl --user restart nodeterm-server`: every teammate's tab greys and
   comes back on its own within about 30 s, with no dialog. If the service takes longer, each tab
   needs one click.
5. **Removal.** `team remove <key>` on a connected teammate: their tab says "X: Your access to this
   team was removed by an owner.", and their next attempt is a new join request.
6. **Owner offline, new device.** With no owner connected, a new device pastes the code and presses
   OK on its SAS prompt. About 2.5 s later it shows "Waiting for an owner of X to approve this
   device…" (the notice starts only after that OK), `team status` lists the request, and after 10
   minutes the joiner reads "Could not open X: No owner answered the request in time."
7. **Corrupt host key.** Corrupt `host-key.json` and restart: the journal says "Hosted team relay:
   OFF — the host key could not be read", `team status` says why, `team init` refuses, and the key
   file is left as it was.
8. **Long session.** A teammate stays connected for over an hour without the tab greying. The host
   never refreshes a bridged session, and the relay broker's source checks a token only when a
   socket joins, but whether production ends a bridged socket at its token's lifetime is unverified
   (the comments in `hosted-scheduler.ts` and `standing-host.ts` say so). This item settles it.
9. **Viewer size.** A Viewer with a small window does not shrink the Editor's terminal.
10. **Two owners.** With two owners connected, one approves a request; the other owner's dialog
    closes with "Another owner answered this request."
11. **Device-key path on a real Mac.** On a packaged Mac build, after the desktop has joined a hosted
    team or used a Team Access invite or pairing code (phone pairing does not count), the key file
    is `~/Library/Application Support/node-terminal/remote-peer-key.json` (the setup step 2 command
    prints the key), and `ls ~/Library/Application\ Support/*/remote-peer-key.json` finds no other
    copy.
12. **Canvas edits survive with a browser tab attached (R42 workaround).** With the service in
    serving mode (the setup step 1 drop-in) and a Server Edition browser tab open on it, a teammate
    adds and moves a node in their hosted tab. After `systemctl --user restart nodeterm-server`, a
    reconnected teammate (and the browser tab) still sees the node where it was moved. Repeat with no
    browser tab attached: the edit is lost, as documented.
