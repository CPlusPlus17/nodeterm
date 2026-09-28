// Reading a REMOTE (SSH-project) grok node's conversation ON ITS HOST.
//
// A remote grok session's `chat_history.jsonl` lives on the host, under the host's `$GROK_HOME`.
// Nothing on this machine can stand in for it: the desktop's hook listener derives a session
// directory from the LOCAL sessions root and the host's cwd (a path on the wrong machine), so every
// local locator is wrong by construction for these nodes. This module is therefore the only way a
// remote grok node's ⌘M panel — and the phone's Chat screen, which reads through the same deps — can
// show anything, and its failures are TERMINAL in `readChatTranscript`: never a fall-through to this
// machine's disk.
//
// One round trip, one generated `sh` line, built from the session id alone:
//
//   - The ROOT is `$GROK_HOME` when the host sets it to an absolute path, else `$HOME/.grok` — the
//     same rule `RemoteHooks.installGrokRemote` applies before it writes the hook grok fires, and
//     read over the same plain exec channel, so the hook and the reader agree on where grok lives.
//   - The FILE is found by the session id, which is the one key no other session shares:
//     `<root>/sessions/*/<id>/chat_history.jsonl`. No cwd is needed, which also covers grok's
//     slug+hash group for a cwd longer than 255 encoded bytes (`grokEncodedCwdDirName` cannot name
//     it). Two matches are REFUSED (exit 3), never resolved by picking one.
//   - The READ is the paged transcript command (`transcriptPageCommand`: size + a byte window, dd
//     status framed inside the base64) at a `CHAT_PAGE_MAX_BYTES` window — exactly the cap the local
//     leg's `readCappedTail` applies. grok does not page (its file is rewritten in place, see
//     `grok-chat.ts`), so this is its whole read.
//
// The path the file is read from never crosses the machine boundary as an input: the glob and the
// read run in the same script, and the only interpolated values are app-built constants and the
// session id, validated by `isSafeGrokSessionId` (no `/`, `.`, quote or space can pass).
import { posixQuote } from '../shared/ssh'
import { CHAT_PAGE_MAX_BYTES } from '../shared/chat-page'
import { GROK_CHAT_HISTORY_FILE, isSafeGrokSessionId } from './agents/grok-paths'
import { parseTranscriptPage, transcriptPageCommand } from './remote-ssh/transcript-window'

/** What the host answered for a clean miss (status 0) — the same word the page commands use. */
const ABSENT = 'NODETERM_ABSENT'

/** Exit status for "the id names more than one session": a refusal to guess, read as a failure. */
const AMBIGUOUS_EXIT = 3

/**
 * The host-side read for `sessionId`, or null when no transcript file can carry that id.
 *
 * Wrapped in `sh -c` because the ssh exec channel runs the USER's login shell: under zsh a glob
 * that matches nothing is an error ("no matches found") rather than a literal, which would turn
 * every clean miss into a failed read. The inner script is POSIX sh either way.
 */
export function remoteGrokChatCommand(sessionId: string, maxBytes: number = CHAT_PAGE_MAX_BYTES): string | null {
  if (!isSafeGrokSessionId(sessionId)) return null
  const id = posixQuote(sessionId)
  const file = posixQuote(GROK_CHAT_HISTORY_FILE)
  const script = [
    'case "${GROK_HOME:-}" in /*) r=$GROK_HOME ;; *) r=$HOME/.grok ;; esac',
    'n=0; d=',
    // `*` outside the quotes (it must glob); the root is quoted, so a `[` or `*` in it is a path.
    `for p in "$r"/sessions/*/${id}; do if [ -f "$p"/${file} ]; then n=$((n + 1)); d=$p; fi; done`,
    `if [ "$n" -eq 0 ]; then printf '%s\\n' ${ABSENT}; exit 0; fi`,
    `if [ "$n" -gt 1 ]; then exit ${AMBIGUOUS_EXIT}; fi`,
    'cd "$d" || exit 1',
    transcriptPageCommand(GROK_CHAT_HISTORY_FILE, null, maxBytes)
  ].join('\n')
  return `sh -c ${posixQuote(script)}`
}

/**
 * The reply of `remoteGrokChatCommand` (status 0): `{absent}` for a clean miss, else the text of
 * the tail window with its partial leading line dropped. STRICT: anything malformed throws, because
 * the caller must tell "the host could not be read" from "an empty conversation".
 */
export function parseRemoteGrokChat(
  stdout: string,
  maxBytes: number = CHAT_PAGE_MAX_BYTES
): { absent: true } | { text: string } {
  if (stdout === `${ABSENT}\n`) return { absent: true }
  const page = parseTranscriptPage(stdout, null, maxBytes)
  let data = page.data
  if (page.start > 0) {
    // The window opened mid-file: everything through the first newline is the partial line (the
    // lookbehind byte makes a line that begins exactly on the edge survive — its `\n` is byte 0).
    const nl = data.indexOf(0x0a)
    data = nl < 0 ? Buffer.alloc(0) : data.subarray(nl + 1)
  }
  return { text: data.toString('utf8') }
}

/** A remote grok read: the host's text, a clean miss (`absent`), or could-not-read. */
export type RemoteGrokChat = { ok: true; text: string } | { ok: false; absent?: true }

/**
 * The desktop's remote grok leg, injected into `readChatTranscript` as `readRemoteGrok`. `null` =
 * not a remote session (take the local path); everything else is final.
 *
 * Remoteness is the shell's own records OR a live master for the node — the same two sources the
 * claude leg uses (`locateRemoteTranscriptRef`) — and a remote node with no reachable master is
 * `{ok:false}` (could not ask), never `null`, which would send it to this machine's disk.
 */
export function createReadRemoteGrokChat<T>(deps: {
  isRemote(nodeId: string): boolean
  /** The master to ask over (live pty, else the node's SSH project), or undefined when none. */
  target(nodeId: string): T | undefined
  run(target: T, cmd: string): Promise<{ code: number; stdout: string }>
  /** Test seam; defaults to the local leg's cap. */
  maxBytes?: number
}): (q: { sessionId?: string; nodeId?: string }) => Promise<RemoteGrokChat | null> {
  const maxBytes = deps.maxBytes ?? CHAT_PAGE_MAX_BYTES
  return async (q) => {
    if (!q.nodeId) return null
    const t = deps.target(q.nodeId)
    if (!t && !deps.isRemote(q.nodeId)) return null
    // No id, or one no transcript file can carry: nothing to find — an answer, not a failure.
    const cmd = q.sessionId ? remoteGrokChatCommand(q.sessionId, maxBytes) : null
    if (!cmd) return { ok: false, absent: true }
    if (!t) return { ok: false }
    try {
      const r = await deps.run(t, cmd)
      if (r.code !== 0) return { ok: false }
      const got = parseRemoteGrokChat(r.stdout, maxBytes)
      return 'absent' in got ? { ok: false, absent: true } : { ok: true, text: got.text }
    } catch {
      return { ok: false }
    }
  }
}
