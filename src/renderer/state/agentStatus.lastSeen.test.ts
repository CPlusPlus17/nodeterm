import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { buildHibernationCandidates } from '../lib/hibernationCandidates'
import { planHibernation } from '../terminal/hibernation-policy'
import { shouldDeferReleaseForEco } from '../terminal/offscreen-policy'
import { buildStatusList } from '../lib/sessionList'

// The persisted "last seen" clock (`AgentNodeStatus.lastSeen`): restored across an app restart as a
// CLOCK that orders and ages sidebar rows — never as a live state, never as Eco's idle clock.

function memStorage(seed: Record<string, string> = {}): Storage & { map: Map<string, string> } {
  const m = new Map(Object.entries(seed))
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    }
  } as Storage & { map: Map<string, string> }
}

const KEY = 'nodeterm.agentStatus'
const HOUR = 3600_000

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Run one app "session": import a fresh store over `storage`. */
async function boot(storage: Storage): Promise<typeof import('./agentStatus')> {
  vi.resetModules()
  vi.stubGlobal('localStorage', storage)
  return import('./agentStatus')
}

describe('lastSeen survives a restart as a clock, not a state', () => {
  it('persist → new store: the clock and its state come back, the live state and idle clock do not', async () => {
    vi.useFakeTimers()
    const storage = memStorage()
    const run1 = await boot(storage)
    run1.useAgentStatus.getState().setState('a', 'working', 'claude')
    vi.advanceTimersByTime(1000)
    run1.useAgentStatus.getState().setState('a', 'done', 'claude')
    // Debounced — flush it.
    vi.advanceTimersByTime(run1.LAST_SEEN_SAVE_DEBOUNCE_MS + 10)
    const doneAt = run1.useAgentStatus.getState().byId['a'].lastEventAt!

    const run2 = await boot(storage)
    const st = run2.useAgentStatus.getState().byId['a']
    expect(st.lastSeen).toEqual({ at: doneAt, state: 'done' })
    expect(st.state).toBeUndefined()
    expect(st.lastEventAt).toBeUndefined()
    expect(st.stateAt).toBeUndefined()
  })

  it('a same-state hook event moves the clock and is saved on the debounce, not per event', async () => {
    vi.useFakeTimers()
    const storage = memStorage()
    const spy = vi.spyOn(storage, 'setItem')
    const run1 = await boot(storage)
    const s = run1.useAgentStatus.getState()
    s.setState('b', 'working', 'claude')
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(50)
      s.setState('b', 'working', 'claude') // same-state freshness (a tool event)
    }
    expect(spy).not.toHaveBeenCalled() // no write per tool event
    vi.advanceTimersByTime(run1.LAST_SEEN_SAVE_DEBOUNCE_MS + 10)
    expect(spy).toHaveBeenCalledTimes(1)
    const saved = JSON.parse(storage.getItem(KEY)!)
    expect(saved.b.lastSeen.at).toBe(run1.useAgentStatus.getState().byId['b'].stateAt)
    expect(saved.b.lastSeen.at).toBeGreaterThan(run1.useAgentStatus.getState().byId['b'].lastEventAt!)
    expect(saved.b.state).toBeUndefined()
    expect(saved.b.lastEventAt).toBeUndefined()
  })

  it('remove() drops the clock with the node, so a deleted node leaves nothing on disk', async () => {
    vi.useFakeTimers()
    const storage = memStorage()
    const run1 = await boot(storage)
    run1.useAgentStatus.getState().setState('c', 'done', 'claude')
    vi.advanceTimersByTime(run1.LAST_SEEN_SAVE_DEBOUNCE_MS + 10)
    expect(JSON.parse(storage.getItem(KEY)!).c.lastSeen).toBeDefined()
    run1.useAgentStatus.getState().remove('c')
    // Even a debounced save that was already pending cannot resurrect it.
    vi.advanceTimersByTime(run1.LAST_SEEN_SAVE_DEBOUNCE_MS + 10)
    expect(JSON.parse(storage.getItem(KEY)!).c).toBeUndefined()
    const run2 = await boot(storage)
    expect(run2.useAgentStatus.getState().byId['c']).toBeUndefined()
  })

  it('bounds the persisted clocks to the newest LAST_SEEN_MAX', async () => {
    const { lastSeenKeep, LAST_SEEN_MAX } = await boot(memStorage())
    const byId: Record<string, { lastSeen?: { at: number } }> = {}
    for (let i = 0; i < LAST_SEEN_MAX + 5; i++) byId[`n${i}`] = { lastSeen: { at: 1_000 + i } }
    byId.none = {}
    const keep = lastSeenKeep(byId)
    expect(keep.size).toBe(LAST_SEEN_MAX)
    for (let i = 0; i < 5; i++) expect(keep.has(`n${i}`)).toBe(false) // oldest dropped
    expect(keep.has(`n${LAST_SEEN_MAX + 4}`)).toBe(true)
    expect(keep.has('none')).toBe(false)
  })
})

describe('hostile / corrupt persisted values', () => {
  const now = Date.UTC(2026, 8, 30)
  it('readLastSeen refuses what is not a sane past clock', async () => {
    const { readLastSeen, LAST_SEEN_MAX_AGE_MS, LAST_SEEN_FUTURE_SLACK_MS } = await boot(memStorage())
    for (const bad of [
      null,
      undefined,
      42,
      'x',
      [],
      {},
      { at: 'yesterday' },
      { at: NaN },
      { at: Infinity },
      { at: -5 },
      { at: 0 },
      { at: now + LAST_SEEN_FUTURE_SLACK_MS + 1 }, // future: would pin a row to the top
      { at: now - LAST_SEEN_MAX_AGE_MS - 1 }
    ]) {
      expect(readLastSeen(bad, now)).toBeUndefined()
    }
    // Unknown state: keep the time, drop the state. Prototype names are not states.
    expect(readLastSeen({ at: now - HOUR, state: 'constructor' }, now)).toEqual({ at: now - HOUR })
    expect(readLastSeen({ at: now - HOUR, state: 7 }, now)).toEqual({ at: now - HOUR })
    expect(readLastSeen({ at: now - HOUR, state: 'blocked', extra: 1 }, now)).toEqual({
      at: now - HOUR,
      state: 'blocked'
    })
  })

  it('a corrupt entry never breaks the load of its neighbours, and never becomes a state', async () => {
    const storage = memStorage({
      [KEY]: JSON.stringify({
        good: { unread: true, lastSeen: { at: Date.now() - HOUR, state: 'working' } },
        nullEntry: null,
        numEntry: 5,
        badClock: { sessionId: 's', lastSeen: { at: 'soon', state: 'done' }, state: 'working', lastEventAt: 1 }
      })
    })
    const { useAgentStatus } = await boot(storage)
    const byId = useAgentStatus.getState().byId
    expect(byId.good.unread).toBe(true)
    expect(byId.good.lastSeen?.state).toBe('working')
    expect(byId.good.state).toBeUndefined() // a restored "working" is not a live one
    expect(byId.badClock.sessionId).toBe('s')
    expect(byId.badClock.lastSeen).toBeUndefined()
    expect(byId.badClock.state).toBeUndefined()
    expect(byId.badClock.lastEventAt).toBeUndefined()
    expect(byId.nullEntry).toBeUndefined()
    expect(byId.numEntry).toBeUndefined()
  })

  it('a non-object top level loads as empty', async () => {
    const { useAgentStatus } = await boot(memStorage({ [KEY]: '"hello"' }))
    expect(useAgentStatus.getState().byId).toEqual({})
  })
})

describe('Eco stays inert for a restored clock', () => {
  const nodes = [{ id: 'e', agentId: 'claude' }]
  const base = {
    nodes,
    subagents: [],
    isOffscreen: () => true,
    isWired: () => true,
    isRemote: () => false
  }
  const cfg = { enabled: true, idleMinutes: 30 }

  it('a status restored from disk (lastSeen done, hours old) is never a candidate', async () => {
    const storage = memStorage({
      [KEY]: JSON.stringify({
        e: { agentId: 'claude', sessionId: 'sess', lastSeen: { at: Date.now() - 6 * HOUR, state: 'done' } }
      })
    })
    const { useAgentStatus } = await boot(storage)
    const st = useAgentStatus.getState().byId['e']
    const rows = buildHibernationCandidates({ ...base, statusById: { e: st } })
    expect(rows[0].lastEventAt).toBeUndefined()
    expect(rows[0].state).toBeUndefined()
    expect(planHibernation(rows, Date.now(), cfg)).toEqual([])
    // Nor does it hold its viewer waiting for a hibernation that cannot come.
    expect(
      shouldDeferReleaseForEco({
        ecoEnabled: true,
        resumableAgent: true,
        hibernated: false,
        idleKnown: st.lastEventAt !== undefined,
        offscreenElapsedMs: HOUR,
        idleMinutes: 30,
        offscreenMinutes: 10
      })
    ).toBe(false)
  })

  it('pins why neither field may be restored: fed a guessed done + the old clock, the plan WOULD exit it', () => {
    // Pins WHY the adapter must not read lastSeen: were the restored clock fed in as lastEventAt with a
    // restored state, the pure plan WOULD pick it. The only thing keeping Eco inert is that neither
    // field is restored — which the test above pins through the real store.
    const guessed = buildHibernationCandidates({
      ...base,
      statusById: { e: { state: 'done', sessionId: 's', lastEventAt: Date.now() - 6 * HOUR } }
    })
    expect(planHibernation(guessed, Date.now(), cfg)).toEqual(['e'])
    const restored = buildHibernationCandidates({
      ...base,
      statusById: { e: { sessionId: 's' } }
    })
    expect(planHibernation(restored, Date.now(), cfg)).toEqual([])
  })

  it('the first live done after boot starts the idle window from NOW, not from the restored clock', async () => {
    vi.useFakeTimers()
    const storage = memStorage({
      [KEY]: JSON.stringify({ e: { agentId: 'claude', sessionId: 's', lastSeen: { at: Date.now() - 6 * HOUR, state: 'done' } } })
    })
    const { useAgentStatus } = await boot(storage)
    useAgentStatus.getState().setState('e', 'done', 'claude')
    const st = useAgentStatus.getState().byId['e']
    const rows = buildHibernationCandidates({ ...base, statusById: { e: st } })
    expect(planHibernation(rows, Date.now(), cfg)).toEqual([])
    expect(planHibernation(rows, Date.now() + 31 * 60_000, cfg)).toEqual(['e'])
  })
})

describe('sidebar ordering and age label', () => {
  it('orders rows by the restored clock and labels it as from before the restart', async () => {
    const now = Date.now()
    const storage = memStorage({
      [KEY]: JSON.stringify({
        old: { agentId: 'claude', lastSeen: { at: now - 5 * HOUR, state: 'done' } },
        recent: { agentId: 'claude', lastSeen: { at: now - 1 * HOUR, state: 'working' } },
        // A persisted clock for a node that no longer exists on any canvas: it must not make a row.
        ghost: { agentId: 'claude', lastSeen: { at: now - 60_000, state: 'done' } }
      })
    })
    const { useAgentStatus } = await boot(storage)
    const { sessionStateAgeLabel, sessionStateAgeTitle } = await import('../lib/sessionList')
    const statusById = useAgentStatus.getState().byId
    const project = {
      id: 'p',
      name: 'P',
      color: '#fff',
      nodes: [
        { id: 'noClock', kind: 'terminal' as const, title: 'a-no-clock', color: '#fff', agentId: 'claude' as const },
        { id: 'old', kind: 'terminal' as const, title: 'b-old', color: '#fff', agentId: 'claude' as const },
        { id: 'recent', kind: 'terminal' as const, title: 'c-recent', color: '#fff', agentId: 'claude' as const }
      ]
    }
    const groups = buildStatusList([project], null, 'p', statusById, '')
    const unknown = groups.find((g) => g.kind === 'unknown')!
    expect(unknown.rows.map((r) => r.id)).toEqual(['recent', 'old', 'noClock'])
    expect(groups.flatMap((g) => g.rows).some((r) => r.id === 'ghost')).toBe(false)
    const recent = unknown.rows[0]
    expect(recent.statusClockRestored).toBe(true)
    expect(recent.lastSeenState).toBe('working')
    expect(recent.statusKind).toBe('unknown') // the restored state is display-only
    const label = sessionStateAgeLabel(recent.statusUpdatedAt, now, recent.statusClockRestored)
    expect(label).toBe('seen 1h ago')
    expect(sessionStateAgeTitle(label!, true, 'working')).toMatch(/before nodeterm restarted/)
    expect(sessionStateAgeTitle(label!, true, 'working')).toMatch(/Running/)
    // A live clock wins and is not marked restored.
    useAgentStatus.getState().setState('old', 'done', 'claude')
    const after = buildStatusList([project], null, 'p', useAgentStatus.getState().byId, '')
    const oldRow = after.flatMap((g) => g.rows).find((r) => r.id === 'old')!
    expect(oldRow.statusClockRestored).toBeUndefined()
    expect(sessionStateAgeLabel(oldRow.statusUpdatedAt, Date.now(), oldRow.statusClockRestored)).toBe('just now')
  })
})
