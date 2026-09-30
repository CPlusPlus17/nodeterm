// A live link watcher's OWN tmux client — the one it spawns when no Session is held for the node
// (after an app restart, for a closed project, for a released node). Pure: argv builders and parsers.
//
// The owner's spelling for a client, `new-session -A`, is wrong here in three ways, each measured on
// tmux 3.4 (watcher-client.realtty.test.ts):
//  - SIZE. Under tmux's default `window-size latest` the newest client sets the window size: a watcher
//    at 40x10 shrank the owner's 120x39 window to 40x9 — a SIGWINCH to the agent running there, because
//    somebody opened a link. `-f ignore-size` leaves the window at 120x39 and the owner's client as it was.
//  - ENVIRONMENT. Attaching runs `update-environment`, which copies every listed name from the attaching
//    client's env into the session and STRIPS the ones that client lacks — the account scope
//    (CLAUDE_CONFIG_DIR, …, CLAUDE.md #419) included. `-E` skips it; the session env is untouched.
//  - CREATION. `new-session -A` creates when the session is gone, so a session that died between the
//    strict existence verdict and the spawn would be re-created bare, by a viewer. `attach-session`
//    never creates: it exits 1 ("can't find session") and nothing appears.
// `read-only` is a belt: nothing is ever written into a watcher's pty, and if something were, tmux
// drops input from a read-only client.
//
// The target is exact, `=nt-<id>:` (a bare name prefix-matches another node's session; measured, see
// capture-route.ts). For attach-session both `=name` and `=name:` are exact; `=name:` is kept so every
// watch-link target is spelled one way.
//
// Client flags (`-f`) need tmux 3.2. Locally the version is probed (`supportsWatcherClient`) and an
// older or unreadable one refuses the watcher; over SSH the remote tmux rejects the flags itself.
import { exactPaneTarget } from './capture-route'

export const WATCHER_CLIENT_FLAGS = 'ignore-size,read-only'

/** The local tmux argv (after the binary) for a watcher's own client. */
export function localWatcherAttachArgs(socket: string, sessionName: string): string[] {
  return ['-L', socket, 'attach-session', '-E', '-f', WATCHER_CLIENT_FLAGS, '-t', exactPaneTarget(sessionName)]
}

/** The window's size, so a watcher's client is spawned at what the owner sees. */
export const WINDOW_SIZE_FORMAT = '#{window_width} #{window_height}'

export function localWindowSizeArgs(socket: string, sessionName: string): string[] {
  return ['-L', socket, 'display-message', '-p', '-t', exactPaneTarget(sessionName), WINDOW_SIZE_FORMAT]
}

/** `"<cols> <rows>"`, both positive. An exact-target miss answers exit 0 with every format EMPTY, so
 *  anything else is no size — never 0x0. */
export function parseWindowSize(stdout: string): { cols: number; rows: number } | undefined {
  const m = /^(\d+) (\d+)$/.exec(stdout.replace(/\r?\n$/, ''))
  if (!m) return undefined
  const cols = Number(m[1])
  const rows = Number(m[2])
  return cols > 0 && rows > 0 ? { cols, rows } : undefined
}

export interface TmuxVersion {
  major: number
  minor: number
}

/** `tmux -V` → `{major, minor}`: `tmux 3.4`, `tmux 3.2a`, `tmux next-3.6`. null when unreadable
 *  (`tmux master`, a failed probe). */
export function parseTmuxVersion(stdout: string): TmuxVersion | null {
  const m = /(\d+)\.(\d+)/.exec(stdout)
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null
}

/** Client flags (`attach-session -f`) first shipped in tmux 3.2. An unknown version fails closed. */
export function supportsWatcherClient(v: TmuxVersion | null): boolean {
  return !!v && (v.major > 3 || (v.major === 3 && v.minor >= 2))
}
