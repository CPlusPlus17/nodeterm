import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'

/**
 * A live link's viewer joins a node's RUNNING session: `joinAsWatcher` must never spawn one and never
 * vote on its size, whatever the caller hands it, and `watchSizeFor` names the size the link reports.
 * Harness copied from pty-join-only.test.ts (a mocked `node-pty` that records each spawn and each
 * resize, so "spawned nothing" is `spawned.length === 0` and "kept its size" is "no resize pushed").
 */

interface FakePty {
  args: string[]
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
}
const spawned: FakePty[] = []

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (_file: string, args: string[], _opts: unknown) => {
    const p: FakePty = { args: [...(args ?? [])], resizes: [], killed: false }
    spawned.push(p)
    return {
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        p.onExitCb = cb
      },
      write: () => {},
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

vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const OWNER = 1
const WATCHER = 7
const REFUSED: PtyCreateResult = { sessionId: '', fresh: false, unavailable: 'join-only' }

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

type ConfirmedProcessRun = (file: string, args: readonly string[], opts?: object) => Promise<unknown>

async function manager(deps: { confirmedProcessRun?: ConfirmedProcessRun } = {}) {
  const { PtyManager } = await import('./pty-manager')
  const m = new PtyManager(deps)
  m.registerIpc()
  return m
}

/** `has-session` as tmux 3.4 resolves it: `=name` is exact, a bare name prefix-matches a miss. */
function hasSession(live: string[], args: readonly string[]): boolean {
  const target = args[args.indexOf('-t') + 1] ?? ''
  if (target.startsWith('=')) return live.includes(target.slice(1))
  return live.some((s) => s === target || s.startsWith(target))
}

/** A tmux-backed manager whose probes answer from `live` without touching a tmux socket. */
async function tmuxManager(live: string[]) {
  const confirmedProcessRun: ConfirmedProcessRun = async (_file, args) => {
    if (hasSession(live, args)) return { stdout: '', stderr: '' }
    throw Object.assign(new Error("can't find session"), { code: 1 })
  }
  const m = await manager({ confirmedProcessRun })
  ;(m as unknown as { tmuxPath: string }).tmuxPath = '/usr/bin/tmux'
  vi.spyOn(
    m as unknown as { tmuxSessionExists: (k: string) => Promise<boolean> },
    'tmuxSessionExists'
  ).mockImplementation(async (k: string) => hasSession(live, ['-t', `nt-${k}`]))
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
const WATCH = { persistKey: 'n1', viewerId: 'watch-s1', cols: 40, rows: 10 }

describe('joinAsWatcher', () => {
  it('never starts a session: no live session is a join-only refusal, and nothing spawns', async () => {
    const m = await manager()
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('refuses when only a session whose name EXTENDS this node id is alive', async () => {
    const m = await tmuxManager(['nt-n12'])
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it("joins the owner's live session and never shrinks it", async () => {
    const m = await manager()
    const a = await create(OWNER, { cols: 120, rows: 40 })
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    expect(w.sessionId).toBe(a.sessionId)
    expect(w.fresh).toBe(false)
    expect(w.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].resizes).toEqual([])
    // Still a subscriber: told the authoritative size to render.
    const sizes = fake.sent.filter((s) => s.channel === IPC.ptySize(a.sessionId))
    expect(sizes.map((s) => s.to)).toEqual([WATCHER])
    expect(sizes[0].args[0]).toEqual({ cols: 120, rows: 40 })
  })

  it('warm-reattaches a running tmux session as a mirror (no -D), never creating one', async () => {
    const m = await tmuxManager(['nt-n1'])
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    expect(w.unavailable).toBeUndefined()
    expect(w.fresh).toBe(false)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].args).toContain('-A')
    expect(spawned[0].args).not.toContain('-D')
  })

  it('the join-only, non-voting rules are FORCED — a caller cannot turn them off', async () => {
    const m = await manager()
    const smuggled = { ...WATCH, joinOnly: false, sizeVote: true } as never
    expect(await m.joinAsWatcher(WATCHER, smuggled)).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)

    await create(OWNER, { cols: 120, rows: 40 })
    await m.joinAsWatcher(WATCHER, smuggled)
    expect(spawned[0].resizes).toEqual([])
  })
})

describe('watchSizeFor', () => {
  it('is the size the live pty runs at, whatever the watcher reported', async () => {
    const m = await manager()
    await create(OWNER, { cols: 120, rows: 40 })
    await m.joinAsWatcher(WATCHER, WATCH)
    expect(m.watchSizeFor('n1')).toEqual({ cols: 120, rows: 40 })
  })

  it('follows the pty when the owner resizes it', async () => {
    const m = await manager()
    const { sessionId } = await create(OWNER, { cols: 120, rows: 40 })
    fake.senderListeners[IPC.ptyResize](OWNER, sessionId, 100, 30)
    expect(m.watchSizeFor('n1')).toEqual({ cols: 100, rows: 30 })
  })

  it('is the size the pty had when its last client was released', async () => {
    const m = await tmuxManager(['nt-n1'])
    const { sessionId } = await create(OWNER, { cols: 132, rows: 43 })
    kill(OWNER, sessionId)
    expect(spawned[0].killed).toBe(true)
    expect(m.watchSizeFor('n1')).toEqual({ cols: 132, rows: 43 })
  })

  it('is undefined for a node this process never ran', async () => {
    const m = await manager()
    expect(m.watchSizeFor('n1')).toBeUndefined()
  })

  it('hands back a copy, not the live size record', async () => {
    const m = await manager()
    await create(OWNER, { cols: 120, rows: 40 })
    const size = m.watchSizeFor('n1')!
    size.cols = 1
    expect(m.watchSizeFor('n1')).toEqual({ cols: 120, rows: 40 })
  })
})
