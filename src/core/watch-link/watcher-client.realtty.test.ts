// A LIVE LINK WATCHER'S OWN TMUX CLIENT, ON A REAL TTY (controller ruling R19).
//
// When no Session is held for a node (an app restart, a closed project, a released node), a watcher
// joins by spawning its OWN tmux client. Measured on tmux 3.4, the owner's `new-session -A` spelling
// for that client shrank the owner's 120x39 window to 40x9 (tmux's default `window-size latest`
// makes the newest client the size) — SIGWINCH to a running agent, because somebody opened a link.
// The watcher's client is therefore `attach-session -E -f ignore-size,read-only -t =nt-<id>:`, and
// each word is load-bearing; this file measures each one on a real pty:
//  - ignore-size: the owner's window and the owner's own client keep their size;
//  - read-only:   bytes typed into the watcher's client never reach the pane;
//  - -E:          attaching does not run `update-environment`, which would STRIP every listed name the
//                 watcher's own env lacks (the account scope, CLAUDE_CONFIG_DIR — CLAUDE.md #419);
//  - attach-session (never new-session -A): a session that is gone is not re-created bare;
//  - the exact target: a prefix of a live session's name attaches to nothing.
// The SSH arm is proven the same way: the generated remote line runs under a real /bin/sh inside a
// real pty, with a stub that re-points `-L nodeterm-rmt` at this file's private socket.
//
// Private socket in a private TMUX_TMPDIR; sessions killed by exact target. Skipped (with the reason)
// where there is no tmux binary or node-pty cannot load.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { localWatcherAttachArgs, localWindowSizeArgs, parseWindowSize } from './watcher-client'
import { remoteTmuxWatcherArgs, RMT_TMUX_SOCKET } from '../remote-ssh/control-master'
import { makeTmuxTmpdir } from '../tmux-test-socket'
import { testTmpDir } from '../test-tmp'

let pty: typeof import('node-pty') | null = null
try {
  pty = await import('node-pty')
} catch {
  pty = null
}
const REAL_TMUX = (() => {
  if (process.platform === 'win32') return null
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
})()
// Needs both: the measurement is of tmux, and only a real tty can be a sized tmux client.
const itReal = it.skipIf(!REAL_TMUX || !pty)

const SOCKET = `nt-wlrt-${process.pid}`
/** A variable the conf lists in `update-environment`, like the account-scope names production lists. */
const SCOPED = 'CLAUDE_CONFIG_DIR'
let tmp = ''
let delegateDir = ''
const sessions: string[] = []
const clients: Array<import('node-pty').IPty> = []

function baseEnv(): Record<string, string> {
  const env = { ...process.env, TMUX_TMPDIR: tmp } as Record<string, string>
  delete env.TMUX
  delete env.TMUX_PANE
  delete env[SCOPED]
  return env
}

function tmux(args: string[], env = baseEnv()): string {
  return execFileSync(REAL_TMUX!, ['-L', SOCKET, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function tryTmux(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: tmux(args) }
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: string }).stderr ?? '') }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!check() && Date.now() - start < ms) await sleep(25)
}

interface Client {
  proc: import('node-pty').IPty
  exit: { exitCode: number } | null
  out: string
}
function spawnClient(file: string, args: string[], cols: number, rows: number, env: Record<string, string>): Client {
  const proc = pty!.spawn(file, args, { name: 'xterm-256color', cols, rows, env })
  clients.push(proc)
  const c: Client = { proc, exit: null, out: '' }
  proc.onData((d) => (c.out += d))
  proc.onExit((e) => (c.exit = e))
  return c
}

const windowSize = (name: string): string =>
  tmux(['display-message', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}']).trim()
const clientsOf = (name: string): string[] =>
  tmux(['list-clients', '-t', `=${name}`, '-F', '#{client_width}x#{client_height} #{client_flags}'])
    .split('\n')
    .filter(Boolean)

/** The owner: a normal attached client at 120x40 whose env carries the scoped variable. */
async function ownerOf(name: string): Promise<Client> {
  const owner = spawnClient(REAL_TMUX!, ['-L', SOCKET, 'attach-session', '-t', `=${name}`], 120, 40, {
    ...baseEnv(),
    [SCOPED]: '/accounts/a1'
  })
  await until(() => windowSize(name) === '120x39')
  return owner
}

function newSession(name: string, script: string): void {
  tmux(['new-session', '-d', '-s', name, '-x', '120', '-y', '40', script], { ...baseEnv(), [SCOPED]: '/accounts/a1' })
  sessions.push(name)
}

beforeAll(() => {
  if (!REAL_TMUX || !pty) return
  tmp = makeTmuxTmpdir('ntwr-', SOCKET)
  // Boot the private server with a session that keeps it alive, then list the scoped name in
  // `update-environment` exactly as the production conf does for the account scope.
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'keepalive', 'sleep 120'])
  sessions.push('keepalive')
  tmux(['set', '-g', 'update-environment', SCOPED])
  delegateDir = path.join(testTmpDir('ntwrd-'), 'bin')
  fs.mkdirSync(delegateDir)
  fs.writeFileSync(
    path.join(delegateDir, 'tmux'),
    `#!/bin/sh\n[ "$1" = "-L" ] && [ "$2" = "${RMT_TMUX_SOCKET}" ] || exit 99\nshift 2\nexec '${REAL_TMUX}' -L '${SOCKET}' "$@"\n`,
    { mode: 0o755 }
  )
})

afterAll(() => {
  for (const c of clients) {
    try {
      c.kill()
    } catch {
      /* already gone */
    }
  }
  if (!REAL_TMUX || !pty) return
  // Every session on this file's PRIVATE socket, each by exact target — including one a regression
  // might have CREATED (a watcher spelled `new-session -A` makes a login shell that never exits and
  // would keep the server alive after the directory is gone).
  const listed = tryTmux(['list-sessions', '-F', '#{session_name}'])
  const names = new Set([...sessions, ...(listed.ok ? listed.out.split('\n').filter(Boolean) : [])])
  for (const name of names) tryTmux(['kill-session', '-t', `=${name}`])
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("a watcher's own tmux client (local)", () => {
  itReal('never resizes the owner: the window stays 120x39 and the owner keeps its view', async () => {
    newSession('nt-own', 'sleep 120')
    await ownerOf('nt-own')
    const before = clientsOf('nt-own')
    const watcher = spawnClient(REAL_TMUX!, localWatcherAttachArgs(SOCKET, 'nt-own'), 40, 10, baseEnv())
    await until(() => clientsOf('nt-own').length === 2)
    await sleep(200)
    expect(watcher.exit).toBeNull()
    expect(windowSize('nt-own')).toBe('120x39')
    const after = clientsOf('nt-own')
    expect(after).toContain(before[0]) // the owner's client: same size, same flags
    expect(after.some((c) => c.includes('ignore-size') && c.includes('read-only'))).toBe(true)
    watcher.proc.kill()
  })

  itReal('does not strip the session env the watcher lacks (-E: no update-environment)', async () => {
    newSession('nt-env', 'sleep 120')
    await ownerOf('nt-env')
    expect(tmux(['show-environment', '-t', '=nt-env', SCOPED]).trim()).toBe(`${SCOPED}=/accounts/a1`)
    const watcher = spawnClient(REAL_TMUX!, localWatcherAttachArgs(SOCKET, 'nt-env'), 40, 10, baseEnv())
    await until(() => clientsOf('nt-env').length === 2)
    await sleep(200)
    expect(watcher.exit).toBeNull()
    expect(tmux(['show-environment', '-t', '=nt-env', SCOPED]).trim()).toBe(`${SCOPED}=/accounts/a1`)
    watcher.proc.kill()
  })

  itReal('read-only: what reaches the watcher client never reaches the pane', async () => {
    newSession('nt-ro', 'cat')
    const owner = await ownerOf('nt-ro')
    const watcher = spawnClient(REAL_TMUX!, localWatcherAttachArgs(SOCKET, 'nt-ro'), 40, 10, baseEnv())
    await until(() => clientsOf('nt-ro').length === 2)
    watcher.proc.write('FROM-WATCHER\r')
    await sleep(300)
    expect(tmux(['capture-pane', '-p', '-t', '=nt-ro:'])).not.toContain('FROM-WATCHER')
    // Control: the owner's client does type.
    owner.proc.write('FROM-OWNER\r')
    await until(() => tmux(['capture-pane', '-p', '-t', '=nt-ro:']).includes('FROM-OWNER'))
    expect(tmux(['capture-pane', '-p', '-t', '=nt-ro:'])).toContain('FROM-OWNER')
    watcher.proc.kill()
  })

  itReal('a session that is gone is not created: the client exits and nothing appears', async () => {
    const watcher = spawnClient(REAL_TMUX!, localWatcherAttachArgs(SOCKET, 'nt-gone'), 40, 10, baseEnv())
    await until(() => watcher.exit !== null)
    expect(watcher.exit?.exitCode).not.toBe(0)
    expect(tryTmux(['has-session', '-t', '=nt-gone']).ok).toBe(false)
  })

  itReal('a prefix of a live session name attaches to nothing', async () => {
    newSession('nt-p-12', 'sleep 120')
    const watcher = spawnClient(REAL_TMUX!, localWatcherAttachArgs(SOCKET, 'nt-p-1'), 40, 10, baseEnv())
    await until(() => watcher.exit !== null)
    expect(watcher.exit?.exitCode).not.toBe(0)
    expect(clientsOf('nt-p-12')).toEqual([])
    expect(tryTmux(['has-session', '-t', '=nt-p-1']).ok).toBe(false)
  })

  itReal('the window-size read answers the live window, and nothing for a miss', async () => {
    newSession('nt-sz', 'sleep 120')
    await ownerOf('nt-sz')
    expect(parseWindowSize(tmux(localWindowSizeArgs(SOCKET, 'nt-sz').slice(2)))).toEqual({ cols: 120, rows: 39 })
    expect(parseWindowSize(tmux(localWindowSizeArgs(SOCKET, 'nt-s').slice(2)))).toBeUndefined()
  })
})

describe("a watcher's own tmux client (SSH arm, the generated remote line under a real /bin/sh)", () => {
  itReal('attaches read-only and size-neutral: the owner window stays 120x39, env intact', async () => {
    newSession('nt-rw', 'sleep 120')
    await ownerOf('nt-rw')
    const line = remoteTmuxWatcherArgs({ host: 'h', user: 'u' }, '/cm/p1', 'nt-rw').at(-1)!
    const watcher = spawnClient('/bin/sh', ['-c', line], 40, 10, { ...baseEnv(), PATH: `${delegateDir}:/usr/bin:/bin` })
    await until(() => clientsOf('nt-rw').length === 2)
    await sleep(200)
    expect(watcher.exit).toBeNull()
    expect(windowSize('nt-rw')).toBe('120x39')
    expect(clientsOf('nt-rw').some((c) => c.includes('ignore-size') && c.includes('read-only'))).toBe(true)
    expect(tmux(['show-environment', '-t', '=nt-rw', SCOPED]).trim()).toBe(`${SCOPED}=/accounts/a1`)
    watcher.proc.kill()
  })

  itReal('a gone remote session is not created', async () => {
    const line = remoteTmuxWatcherArgs({ host: 'h', user: 'u' }, '/cm/p1', 'nt-rgone').at(-1)!
    const watcher = spawnClient('/bin/sh', ['-c', line], 40, 10, { ...baseEnv(), PATH: `${delegateDir}:/usr/bin:/bin` })
    await until(() => watcher.exit !== null)
    expect(watcher.exit?.exitCode).not.toBe(0)
    expect(tryTmux(['has-session', '-t', '=nt-rgone']).ok).toBe(false)
  })
})
