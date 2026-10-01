// The remote half of the desktop's "Share with team": every command it runs on the SSH host,
// generated here and run over the project's ControlMaster by src/main. Generated shell no compiler
// checks, so share-team-remote.test.ts runs each one under a real /bin/sh against a fake host.
// Rules:
// - every script runs under `sh -c '…'`, never the login shell, which may be zsh or fish;
// - fence markers are printed QUOTED, because an unquoted `#` starts a comment;
// - paths are quoted;
// - session names come only from `sessionName`;
// - kills target `=nt-<id>` exactly, on `nodeterm-rmt` ONLY. That is this desktop's socket. The
//   server core's `node-terminal` sessions are the ones being resumed, so the every-socket kill
//   used elsewhere would stop exactly the sessions the handover exists to start.
import { posixQuote, quoteRemotePath, remoteTmuxPathPrologue } from '../../shared/ssh'
import type { ShareProbe } from '../../shared/share-team'
import { RMT_TMUX_SOCKET } from './control-master'
import { sessionName } from '../tmux-naming'
import { CONTROL_RE } from '../relay/team-admin'

export const SERVER_INSTALL_URL = 'https://raw.githubusercontent.com/eneskirca/nodeterm/main/scripts/install-server.sh'
/** Where a root-installed nodeterm-server's unit lives (the installer's system mode). */
const SYSTEM_UNIT_PATH = '/etc/systemd/system/nodeterm-server.service'
/** The most of `team status --json` the probe carries back; the reply is a few hundred bytes. */
const STATUS_MAX = 65536
/** The most of a non-JSON team reply quoted in an error. */
const SHOWN_MAX = 300
const CONTROL_G = new RegExp(CONTROL_RE.source, 'gu')
const sh = (script: string): string => `sh -c ${posixQuote(script)}`

/** The official installer, downloaded first: `curl … | bash` runs an EMPTY script and exits 0 when
 *  the download fails (no pipefail), so a failed download would look like a successful install. */
export const SHARE_INSTALL_SCRIPT = [
  'f=$(mktemp) || exit 1',
  `if ! curl -fsSL ${posixQuote(SERVER_INSTALL_URL)} -o "$f"; then rm -f "$f"; echo 'nodeterm: could not download the installer.' >&2; exit 1; fi`,
  'bash "$f"; rc=$?',
  'rm -f "$f"',
  'exit $rc'
].join('\n')

/**
 * One round trip that tells `sharePlan` everything: the OS and login, whether git/curl exist, which
 * unit runs nodeterm-server and with which node + main.cjs + data dir, the install meta, whether
 * that build knows `team bootstrap`, whether the CLI answers `team status`, the project folder's
 * real path, and the live panes on this desktop's remote tmux socket. Read by `parseShareProbe`.
 *
 * `systemUnit` exists so a test can point the system-unit check at a fake host tree; the only
 * production value is the default.
 */
export function shareProbeCommand(remoteCwd: string, systemUnit: string = SYSTEM_UNIT_PATH): string {
  return sh(
    [
      // `set -- $X` below splits the unit's ExecStart into words; it must never glob them.
      'set -f',
      "echo '##NTP 1'",
      `printf '##OS %s\\n' "$(uname -s 2>/dev/null)"`,
      `printf '##UID %s\\n' "$(id -u 2>/dev/null)"`,
      `printf '##USER %s\\n' "$(id -un 2>/dev/null)"`,
      `printf '##HOME %s\\n' "$HOME"`,
      `for t in git curl; do if command -v "$t" >/dev/null 2>&1; then printf '##HAVE %s yes\\n' "$t"; else printf '##HAVE %s no\\n' "$t"; fi; done`,
      'U="$HOME/.config/systemd/user/nodeterm-server.service"',
      "NODE=''; MAIN=''; DD=''",
      'if [ -r "$U" ]; then',
      "  echo '##UNIT user'",
      `  X=$(sed -n 's/^ExecStart=//p' "$U" | head -n 1)`,
      '  set -- $X',
      '  NODE=${1:-}; MAIN=${2:-}',
      `  DD=$(sed -n 's/^Environment=NODETERM_DATA_DIR=//p' "$U" | head -n 1)`,
      `elif [ -e ${posixQuote(systemUnit)} ]; then`,
      "  echo '##UNIT system'",
      'else',
      "  echo '##UNIT none'",
      'fi',
      '[ -n "$DD" ] || DD="$HOME/.nodeterm-server"',
      `printf '##NODE %s\\n' "$NODE"`,
      `printf '##MAIN %s\\n' "$MAIN"`,
      `printf '##DATADIR %s\\n' "$DD"`,
      `if [ -r "$DD/install-meta.json" ]; then echo '##META'; head -c 4096 "$DD/install-meta.json"; echo; echo '##METAEND'; fi`,
      'if [ -n "$NODE" ] && [ -x "$NODE" ] && [ -r "$MAIN" ]; then',
      `  if "$NODE" "$MAIN" team --help 2>/dev/null | grep -q '^  bootstrap '; then echo '##BOOTSTRAP yes'; else echo '##BOOTSTRAP no'; fi`,
      '  S=$("$NODE" "$MAIN" team --data-dir "$DD" status --json 2>/dev/null); RC=$?',
      `  printf '##STATUSRC %s\\n' "$RC"`,
      `  echo '##STATUS'; printf '%s\\n' "$S" | head -c ${STATUS_MAX}; echo; echo '##STATUSEND'`,
      'else',
      "  echo '##BOOTSTRAP no'",
      'fi',
      `if cd ${quoteRemotePath(remoteCwd)} 2>/dev/null; then printf '##CWD %s\\n' "$(pwd -P)"; else echo '##CWD'; fi`,
      `${remoteTmuxPathPrologue()}echo '##PANES'; tmux -L ${RMT_TMUX_SOCKET} list-panes -a -F '#{session_name}|#{pane_current_command}' 2>/dev/null; echo '##PANESEND'`,
      "echo '##END'"
    ].join('\n')
  )
}

const PROBE_CUT = 'The host did not finish the probe.'
const PANE_SESSION_RE = /^nt-[A-Za-z0-9_-]+$/
type ProbeBlock = 'meta' | 'status' | 'panes'
const BLOCK_START: Record<string, ProbeBlock> = { '##META': 'meta', '##STATUS': 'status', '##PANES': 'panes' }
const BLOCK_END: Record<ProbeBlock, string> = { meta: '##METAEND', status: '##STATUSEND', panes: '##PANESEND' }

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Read `shareProbeCommand`'s reply. Login noise before `##NTP 1` is skipped; a reply that never
 *  reaches `##END` (a dropped channel, a timeout) is an error, never a half-filled probe that
 *  `sharePlan` would read as "nothing installed". */
export function parseShareProbe(stdout: string): ShareProbe | { error: string } {
  const lines = stdout.split('\n')
  const start = lines.indexOf('##NTP 1')
  if (start < 0) return { error: PROBE_CUT }
  const probe: ShareProbe = {
    os: '',
    uid: null,
    user: '',
    home: '',
    have: { git: false, curl: false },
    unit: 'none',
    node: '',
    main: '',
    dataDir: '',
    meta: null,
    hasBootstrap: false,
    statusRc: null,
    teamExists: false,
    adoptCwd: null,
    panes: []
  }
  let unitSeen = false
  let done = false
  let block: ProbeBlock | null = null
  let body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (block) {
      if (line !== BLOCK_END[block]) {
        body.push(line)
        continue
      }
      if (block === 'meta') {
        const m = parseJson(body.join('\n'))
        probe.meta =
          isRecord(m) && typeof m.version === 'string' && typeof m.commit === 'string'
            ? { version: m.version, commit: m.commit }
            : null
      } else if (block === 'status') {
        const s = parseJson(body.join('\n').trim())
        const off = isRecord(s) && isRecord(s.off) ? s.off : null
        probe.teamExists = isRecord(s) && (s.enabled === true || (off !== null && off.reason !== undefined && off.reason !== 'no-team'))
      } else {
        for (const row of body) {
          const bar = row.indexOf('|')
          if (bar < 0) continue
          const session = row.slice(0, bar)
          if (PANE_SESSION_RE.test(session)) probe.panes.push({ session, command: row.slice(bar + 1) })
        }
      }
      block = null
      body = []
      continue
    }
    if (line === '##END') {
      done = true
      break
    }
    if (BLOCK_START[line]) {
      block = BLOCK_START[line]
      continue
    }
    const space = line.indexOf(' ')
    const tag = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    switch (tag) {
      case '##OS':
        probe.os = value
        break
      case '##UID': {
        const n = Number.parseInt(value, 10)
        probe.uid = Number.isNaN(n) ? null : n
        break
      }
      case '##USER':
        probe.user = value
        break
      case '##HOME':
        probe.home = value
        break
      case '##HAVE': {
        const m = /^(git|curl) (yes|no)$/.exec(value)
        if (m) probe.have[m[1] as 'git' | 'curl'] = m[2] === 'yes'
        break
      }
      case '##UNIT':
        if (value !== 'user' && value !== 'system' && value !== 'none') return { error: `The host reported an unknown service kind: ${shown(value)}` }
        probe.unit = value
        unitSeen = true
        break
      case '##NODE':
        probe.node = value
        break
      case '##MAIN':
        probe.main = value
        break
      case '##DATADIR':
        probe.dataDir = value
        break
      case '##BOOTSTRAP':
        probe.hasBootstrap = value === 'yes'
        break
      case '##STATUSRC': {
        const n = Number.parseInt(value, 10)
        probe.statusRc = Number.isNaN(n) ? null : n
        break
      }
      case '##CWD':
        probe.adoptCwd = value === '' ? null : value
        break
    }
  }
  // `##UNIT` is printed unconditionally, so a reply without it was cut short however it ended.
  if (!done || !unitSeen) return { error: PROBE_CUT }
  return probe
}

/** Run `main.cjs team --data-dir <dir> <args…>` with every word quoted. Anything the caller pipes
 *  in reaches the CLI's stdin (the resume list travels there, never on argv). The reply is fenced
 *  so a login banner cannot be mistaken for it; the exit code rides its own marker line, after a
 *  newline so a reply without a trailing one cannot swallow it. */
export function teamCliCommand(p: Pick<ShareProbe, 'node' | 'main' | 'dataDir'>, args: readonly string[]): string {
  const argv = [p.node, p.main, 'team', '--data-dir', p.dataDir, ...args].map(posixQuote).join(' ')
  return sh(`echo '##NTB'; ${argv}; rc=$?; printf '\\n##NTRC %s\\n' "$rc"`)
}

/** Strip what must never reach the screen (controls, text-direction overrides) and bound it. */
const shown = (text: string): string => text.replace(CONTROL_G, ' ').slice(0, SHOWN_MAX)

/** Read `teamCliCommand`'s reply. The body is everything between the fences, parsed as ONE JSON
 *  value: a refusal is a single line, a success is pretty-printed over several. */
export function parseTeamCliOutput(stdout: string): { rc: number; body: unknown } | { error: string } {
  const lines = stdout.split('\n')
  const start = lines.indexOf('##NTB')
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.startsWith('##NTRC '))
  if (start < 0 || end < 0) return { error: 'The host did not finish running the team command.' }
  const rc = Number.parseInt(lines[end].slice('##NTRC '.length), 10)
  const text = lines.slice(start + 1, end).join('\n').trim()
  try {
    return { rc: Number.isNaN(rc) ? 1 : rc, body: JSON.parse(text) }
  } catch {
    return { error: `The server answered something that is not JSON: ${shown(text) || '(nothing)'}` }
  }
}

/**
 * Stop each node's session on this desktop's remote tmux socket and check that it is gone. Every
 * target is exact (`=nt-<id>`): without `=` tmux falls back to prefix matching on a miss, and
 * `nt-…-1` is a prefix of `nt-…-12`. `has-session` exiting 1 means "gone" — tmux answers 1 both
 * for "can't find session" and for "no server running", and either way nothing is running there.
 * Any other code (126/127: tmux could not run) is "unknown", and only a `gone` node is resumed.
 */
export function killVerifyCommand(nodeIds: readonly string[]): string {
  const body = nodeIds.map((id) => {
    const t = posixQuote(`=${sessionName(id)}`)
    const n = posixQuote(sessionName(id))
    return [
      `tmux -L ${RMT_TMUX_SOCKET} kill-session -t ${t} >/dev/null 2>&1`,
      `tmux -L ${RMT_TMUX_SOCKET} has-session -t ${t} >/dev/null 2>&1; r=$?`,
      `case $r in 0) s=alive;; 1) s=gone;; *) s=unknown;; esac; printf '##K %s %s\\n' ${n} "$s"`
    ].join('\n')
  })
  return sh([`${remoteTmuxPathPrologue()}echo '##NTK'`, ...body, "echo '##NTKEND'"].join('\n'))
}

export type KillVerifyState = 'gone' | 'alive' | 'unknown'

/** Read `killVerifyCommand`'s reply: one state per requested node, in request order. A node the
 *  reply does not mention is `unknown`; a reply that never reaches its end marker is an error. */
export function parseKillVerify(
  stdout: string,
  nodeIds: readonly string[]
): Array<{ nodeId: string; state: KillVerifyState }> | { error: string } {
  const lines = stdout.split('\n')
  const start = lines.indexOf('##NTK')
  const end = start < 0 ? -1 : lines.indexOf('##NTKEND', start + 1)
  if (start < 0 || end < 0) return { error: 'The host did not finish stopping the sessions.' }
  const states = new Map<string, KillVerifyState>()
  for (const l of lines.slice(start + 1, end)) {
    const m = /^##K (\S+) (gone|alive|unknown)$/.exec(l)
    if (m) states.set(m[1], m[2] as KillVerifyState)
  }
  return nodeIds.map((nodeId) => ({ nodeId, state: states.get(sessionName(nodeId)) ?? 'unknown' }))
}

/** Map probe panes onto node ids (session names come only from `sessionName`). */
export function paneCommandsByNode(panes: ShareProbe['panes'], nodeIds: readonly string[]): Record<string, string> {
  const bySession = new Map(panes.map((p) => [p.session, p.command]))
  const out: Record<string, string> = {}
  for (const id of nodeIds) {
    const c = bySession.get(sessionName(id))
    if (c !== undefined) out[id] = c
  }
  return out
}
