// AUDIT A13, AGAINST A REAL TMUX: the app's client must not detach a phone's relay-served client.
//
// pty-relay-coattach.test.ts pins the ARGV `PtyManager` builds: `-A -D` for the app's own client
// normally, `-A` alone while a relay-served client of the same node is attached. What those flags
// DO to a client that is already attached is a property of tmux, so it is measured here, with the
// flags taken from the same `tmuxAttachFlags` the spawn path calls and the exact conf `tmuxConf()`
// ships.
//
// The first test is the control, and it is the A13 mechanism itself: the app's `-A -D` detaches the
// phone's client, which exits 0 — the "The session ended (exit 0)." the phone showed. Without it,
// the second test could pass on a harness that simply cannot observe a detach.
//
// The clients are CONTROL-MODE clients (`tmux -C` over plain pipes) rather than pty-backed ones:
// they need no terminal, and node-pty is a native module this suite must not depend on. `-D`
// detaches every other client of the session whatever its mode (measured on tmux 3.4), so a control
// client stands in for the phone's pty client exactly where it matters.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { tmuxAttachFlags, tmuxConf } from './pty-manager'
import { makeTmuxTmpdir } from './tmux-test-socket'

// Only two PURE exports of pty-manager are used here; the module still imports node-pty at load,
// and a checkout whose native build was skipped (`npm ci --ignore-scripts`) has no binary for it.
// Nothing below spawns through it — the clients are plain `child_process` children.
vi.mock('node-pty', () => ({
  spawn: () => {
    throw new Error('node-pty is not used by this suite')
  }
}))

/** A private socket, never the app's — this must not touch a running nodeterm's tmux server. */
const SOCKET = `nt-relayco-${process.pid}`

function findTmux(): string | null {
  for (const c of ['/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/bin/tmux']) {
    if (fs.existsSync(c)) return c
  }
  return null
}

const TMUX = process.platform === 'win32' ? null : findTmux()
let work: string
let conf: string
const children: ChildProcess[] = []

/** The sandbox dir LAST: a caller never chooses which server it reaches. */
function tmuxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: work }
  delete env.TMUX
  delete env.TMUX_PANE
  return env
}

function tmux(args: string[]): string {
  return execFileSync(TMUX as string, ['-L', SOCKET, ...args], {
    encoding: 'utf8',
    env: tmuxEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/** A tmux client attaching the way `spawnSession` attaches a node: `new-session <flags> -s <name>`. */
function attach(session: string, flags: string[]): ChildProcess {
  const child = spawn(
    TMUX as string,
    ['-L', SOCKET, '-f', conf, '-C', 'new-session', ...flags, '-s', session, 'sleep', '300'],
    // stdin stays OPEN: a control client exits on EOF, which would read as a detach.
    { env: tmuxEnv(), stdio: ['pipe', 'pipe', 'pipe'] }
  )
  child.stdout?.resume()
  child.stderr?.resume()
  children.push(child)
  return child
}

/** The pids of the clients attached to `session` — the tmux client processes themselves. */
function clientPids(session: string): number[] {
  try {
    return tmux(['list-clients', '-t', `=${session}`, '-F', '#{client_pid}'])
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

async function waitUntil(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Resolve with the exit code, or `'still-attached'` if the client is alive after `ms`. */
function exitWithin(child: ChildProcess, ms: number): Promise<number | null | 'still-attached'> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still-attached'), ms)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

beforeAll(() => {
  if (!TMUX) return
  work = makeTmuxTmpdir('ntrelayco-', SOCKET)
  conf = path.join(work, 'tmux.conf')
  fs.writeFileSync(conf, tmuxConf(2000))
})

afterAll(() => {
  if (!TMUX) return
  for (const c of children) if (c.exitCode === null) c.kill()
  try {
    tmux(['kill-server']) // our PRIVATE socket — nothing else can be on it
  } catch {
    /* already gone */
  }
  fs.rmSync(work, { recursive: true, force: true })
})

describe('a relay-served client beside the app client on a real tmux (audit A13)', () => {
  it.skipIf(!TMUX)('control: the app attaching with -A -D detaches the phone, which exits 0', async () => {
    const session = 'nt-a13-kick'
    const phone = attach(session, tmuxAttachFlags(true)) // the relay-served pty (attachDetached)
    await waitUntil(() => clientPids(session).includes(phone.pid as number))

    // The pre-A13 app client: no relay client known, or not asked.
    const app = attach(session, tmuxAttachFlags(false))
    await waitUntil(() => clientPids(session).includes(app.pid as number))

    expect(await exitWithin(phone, 3000)).toBe(0)
    expect(clientPids(session)).toEqual([app.pid])
  })

  it.skipIf(!TMUX)('the fix: the app attaching beside a live relay client leaves the phone attached', async () => {
    const session = 'nt-a13-beside'
    const phone = attach(session, tmuxAttachFlags(true))
    await waitUntil(() => clientPids(session).includes(phone.pid as number))

    // What `spawnSession` now builds while a relay-served client of the node is attached.
    const app = attach(session, tmuxAttachFlags(false, true))
    await waitUntil(() => clientPids(session).includes(app.pid as number))

    // A `-D` detach happens while tmux processes the attach, before the new client is listed, so
    // the control above exits well inside this window.
    expect(await exitWithin(phone, 750)).toBe('still-attached')
    expect(clientPids(session).sort()).toEqual([phone.pid, app.pid].sort())
  })
})
