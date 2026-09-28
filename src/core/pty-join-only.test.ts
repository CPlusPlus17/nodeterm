import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'

/**
 * A hosted-relay VIEWER may watch a terminal but never start one, and never constrains the shared
 * pty's size. The relay access policy expresses both as create options (`joinOnly`, `sizeVote:
 * false`); this suite pins what `PtyManager` does with them. Harness copied from
 * pty-coattach.test.ts: a mocked `node-pty` that records each spawn and each resize, so "spawned
 * nothing" is `spawned.length === 0` and "the pty kept its size" is "no resize was pushed".
 */

/** One fake pty per spawn, recorded so a test can assert "exactly one spawn" and push output. */
interface FakePty {
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
}
const spawned: FakePty[] = []

// Pin the persistence backend (see src/core/__fixtures__/no-session-host.ts): without this, a
// checkout that ran `npm run build` would take the session-host branch instead of the mock below.
vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], _opts: unknown) => {
    const p: FakePty = { writes: [], resizes: [], killed: false }
    spawned.push(p)
    return {
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        p.onExitCb = cb
      },
      write: (d: string) => p.writes.push(d),
      resize: (cols: number, rows: number) => p.resizes.push({ cols, rows }),
      pause: () => {},
      resume: () => {},
      kill: () => {
        p.killed = true
      },
      pid: 1234
    }
  }
}))

// A machine with pty devices to spare, always (same reason as pty-coattach.test.ts).
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const OWNER = 1
const VIEWER = 2

let fake: FakePlatform

beforeEach(() => {
  spawned.length = 0
  fake = fakePlatform()
  initPlatform(fake)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  resetPlatformForTests()
})

/** The default manager: no tmux (init() never runs in unit tests), so a session is a plain shell. */
async function manager() {
  const { PtyManager } = await import('./pty-manager')
  const m = new PtyManager()
  m.registerIpc()
  return m
}

/**
 * A manager whose sessions are tmux-BACKED, with the `has-session` probe answering `exists`. The
 * tmux path is forced (as pty-coattach.test.ts does) and every tmux subprocess the spawn path would
 * run is stubbed, so no real tmux socket is touched.
 */
async function tmuxManager(exists: boolean) {
  const m = await manager()
  ;(m as unknown as { tmuxPath: string }).tmuxPath = '/usr/bin/tmux'
  vi.spyOn(
    m as unknown as { tmuxSessionExists: (k: string) => Promise<boolean> },
    'tmuxSessionExists'
  ).mockResolvedValue(exists)
  // The warm-reattach stale-cwd probe runs `tmux display-message`; answer "not stale".
  vi.spyOn(
    m as unknown as { paneCwdStale: (k: string) => Promise<boolean> },
    'paneCwdStale'
  ).mockResolvedValue(false)
  return m
}

const create = (clientId: number, options: Partial<PtyCreateOptions>) =>
  fake.handlers[IPC.ptyCreate](clientId, {
    cols: 80,
    rows: 24,
    persistKey: 'n1',
    ...options
  }) as Promise<PtyCreateResult>
const kill = (clientId: number, sessionId: string) =>
  fake.senderListeners[IPC.ptyKill](clientId, sessionId)
const sizesSent = (sessionId: string) =>
  fake.sent.filter((s) => s.channel === IPC.ptySize(sessionId))

const REFUSED: PtyCreateResult = { sessionId: '', fresh: false, unavailable: 'join-only' }

describe('joinOnly: a viewer may watch a terminal but never start one', () => {
  it('refuses when no session exists and spawns nothing', async () => {
    await manager()
    expect(await create(VIEWER, { joinOnly: true })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('refuses when tmux says the session is gone, and spawns no tmux client', async () => {
    await tmuxManager(false)
    expect(await create(VIEWER, { joinOnly: true })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('refuses a create with no persistKey (there is nothing it could ever reattach to)', async () => {
    await manager()
    expect(await create(VIEWER, { joinOnly: true, persistKey: undefined })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('joins a live session (co-attach)', async () => {
    await manager()
    const a = await create(OWNER, {})
    const b = await create(VIEWER, { joinOnly: true })
    expect(b.sessionId).toBe(a.sessionId)
    expect(b.fresh).toBe(false)
    expect(b.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1) // the owner's pty — the viewer subscribed to it
  })

  it("joins the owner's spawn when it races it (the in-flight barrier, not a refusal)", async () => {
    await manager()
    const [a, b] = await Promise.all([create(OWNER, {}), create(VIEWER, { joinOnly: true })])
    expect(b.sessionId).toBe(a.sessionId)
    expect(b.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
  })

  it('warm-reattaches a tmux session that is still running', async () => {
    await tmuxManager(true)
    const res = await create(VIEWER, { joinOnly: true })
    expect(res.unavailable).toBeUndefined()
    expect(res.sessionId).not.toBe('')
    expect(res.fresh).toBe(false)
    expect(spawned).toHaveLength(1) // a tmux CLIENT onto the existing session, not a new session
  })

  it('a refusal leaves nothing behind: the owner still opens the node normally afterwards', async () => {
    await manager()
    expect(await create(VIEWER, { joinOnly: true })).toEqual(REFUSED)
    const a = await create(OWNER, {})
    expect(a.sessionId).not.toBe('')
    expect(a.fresh).toBe(true)
    expect(spawned).toHaveLength(1)
  })

  it('an absent joinOnly still spawns (the non-viewer path is unchanged)', async () => {
    await manager()
    const a = await create(OWNER, {})
    expect(a.sessionId).not.toBe('')
    expect(a.fresh).toBe(true)
    expect(a.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
  })
})

describe('sizeVote: false — a viewer never constrains the shared pty size', () => {
  it('never shrinks the shared pty', async () => {
    await manager()
    const a = await create(OWNER, { cols: 120, rows: 40 })
    await create(VIEWER, { cols: 40, rows: 10, sizeVote: false })
    // The pty was spawned at 120x40 and nothing was pushed since: it still runs at the owner's size.
    expect(spawned[0].resizes).toEqual([])
    expect(a.sessionId).not.toBe('')
  })

  it('control: the same join WITHOUT sizeVote:false does shrink it (smallest subscriber wins)', async () => {
    await manager()
    await create(OWNER, { cols: 120, rows: 40 })
    await create(VIEWER, { cols: 40, rows: 10 })
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 40, rows: 10 })
  })

  it('is still a subscriber: it is told the authoritative size and receives output', async () => {
    await manager()
    const { sessionId } = await create(OWNER, { cols: 120, rows: 40 })
    fake.sent.length = 0
    await create(VIEWER, { cols: 40, rows: 10, sizeVote: false })

    const sent = sizesSent(sessionId)
    expect(sent.map((s) => s.to)).toEqual([VIEWER]) // the owner already renders 120x40
    expect(sent[0].args[0]).toEqual({ cols: 120, rows: 40 })

    spawned[0].onDataCb?.('hello')
    vi.advanceTimersByTime(20) // FLUSH_MS coalescing window
    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))
    expect(data.map((s) => s.to).sort()).toEqual([OWNER, VIEWER])
  })

  it('when the only voter leaves, the pty keeps its size rather than taking the viewer’s', async () => {
    await manager()
    const { sessionId } = await create(OWNER, { cols: 120, rows: 40 })
    await create(VIEWER, { cols: 40, rows: 10, sizeVote: false })
    kill(OWNER, sessionId)
    expect(spawned[0].killed).toBe(false) // the viewer still watches
    expect(spawned[0].resizes).toEqual([])
  })

  it('a viewer that warm-reattached holds no vote once the owner joins', async () => {
    // The viewer's create is the first in this process, so it SPAWNS the tmux client (at its own
    // grid — the pty needs some size). That must not seed a vote: when the owner then co-attaches,
    // the pty takes the owner's size instead of staying pinned at the viewer's small window.
    await tmuxManager(true)
    const v = await create(VIEWER, { cols: 40, rows: 10, joinOnly: true, sizeVote: false })
    expect(v.fresh).toBe(false)
    const a = await create(OWNER, { cols: 120, rows: 40 })
    expect(a.sessionId).toBe(v.sessionId)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 120, rows: 40 })
  })
})
