// @vitest-environment jsdom
// jsdom so `pinNeutralMachineNoun` can pin the machine noun the Stop-all copy names.
import { describe, it, expect, vi } from 'vitest'
import {
  liveLinkCommands,
  liveLinkMenuRow,
  liveLinkNodeFor,
  liveLinkPrepare,
  liveLinkUnavailable,
  openLiveLink,
  stopAllConfirm,
  stopLiveLinks,
  type LiveLinkAvailabilityFacts
} from './liveLinkEntry'
import { PRO_GATE_FEATURE, SAVE_FIRST_MESSAGE, STOP_FAILED_MESSAGE } from './liveLink'
import { pinNeutralMachineNoun } from './testMachineNoun'

pinNeutralMachineNoun()

const R43 = 'Live links need a Pro license on this server — not available in the Server Edition yet'
const RELAY = 'Live links are created on the machine that runs this terminal.'
const LIMIT = 'Stop a live link first — 5 can be active at once.'

const facts = (over: Partial<LiveLinkAvailabilityFacts> = {}): LiveLinkAvailabilityFacts => ({
  serverEdition: false,
  source: 'local',
  activeLinks: 0,
  ...over
})
const target = { nodeId: 'n1', title: 'build', projectId: 'p1' }

describe('liveLinkUnavailable', () => {
  it('reads the surface facts in the H1 order', () => {
    expect(liveLinkUnavailable(facts({ serverEdition: true, source: 'relay', activeLinks: 9 }))).toBe(R43)
    expect(liveLinkUnavailable(facts({ source: 'relay', activeLinks: 9 }))).toBe(RELAY)
    expect(liveLinkUnavailable(facts({ activeLinks: 5 }))).toBe(LIMIT)
    expect(liveLinkUnavailable(facts({ activeLinks: 4 }))).toBeNull()
  })
})

describe('openLiveLink: the availability rule runs BEFORE the Pro gate (H1, H4)', () => {
  const run = (f: LiveLinkAvailabilityFacts) => {
    const requirePro = vi.fn((_feature: string, go: () => void) => go())
    const show = vi.fn()
    const notice = vi.fn()
    openLiveLink({ facts: () => f, requirePro, show, notice }, target)
    return { requirePro, show, notice }
  }

  it('a Server Edition tab never reaches the Pro gate — it is told why instead', () => {
    const r = run(facts({ serverEdition: true }))
    expect(r.requirePro).not.toHaveBeenCalled()
    expect(r.show).not.toHaveBeenCalled()
    expect(r.notice).toHaveBeenCalledWith(R43)
  })

  it('a relay tab never reaches the Pro gate', () => {
    const r = run(facts({ source: 'relay' }))
    expect(r.requirePro).not.toHaveBeenCalled()
    expect(r.notice).toHaveBeenCalledWith(RELAY)
  })

  it('five active links: the limit sentence, no gate', () => {
    const r = run(facts({ activeLinks: 5 }))
    expect(r.requirePro).not.toHaveBeenCalled()
    expect(r.notice).toHaveBeenCalledWith(LIMIT)
  })

  it('available: the Pro gate decides, with the ruled feature string, and opens the dialog for the target', () => {
    const r = run(facts())
    expect(r.requirePro).toHaveBeenCalledTimes(1)
    expect(r.requirePro.mock.calls[0][0]).toBe(PRO_GATE_FEATURE)
    expect(r.show).toHaveBeenCalledWith(target)
    expect(r.notice).not.toHaveBeenCalled()
  })

  it('asks the facts for the TARGET project (a relay project is not judged by the active one)', () => {
    const f = vi.fn(() => facts())
    openLiveLink({ facts: f, requirePro: vi.fn(), show: vi.fn(), notice: vi.fn() }, { ...target, projectId: 'relayed' })
    expect(f).toHaveBeenCalledWith('relayed')
  })
})

describe('liveLinkMenuRow', () => {
  const base = {
    node: { id: 'n1', kind: 'terminal', title: 'build' },
    projectId: 'p1',
    hidden: [] as string[],
    facts: facts(),
    icon: null,
    open: vi.fn()
  }

  it('a terminal node gets one enabled row that opens for this node and project', () => {
    const open = vi.fn()
    const rows = liveLinkMenuRow({ ...base, open })
    expect(rows).toHaveLength(1)
    const row = rows[0] as { label: string; disabled?: boolean; onClick: () => void }
    expect(row.label).toBe('Share live link…')
    expect(row.disabled).toBeFalsy()
    row.onClick()
    expect(open).toHaveBeenCalledWith({ nodeId: 'n1', title: 'build', projectId: 'p1' })
  })

  it('is disabled WITH its reason, never hidden, where it cannot work', () => {
    for (const [f, why] of [
      [facts({ serverEdition: true }), R43],
      [facts({ source: 'relay' }), RELAY],
      [facts({ activeLinks: 5 }), LIMIT]
    ] as const) {
      const rows = liveLinkMenuRow({ ...base, facts: f })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ disabled: true, hint: why })
    }
  })

  it('no row for a hidden id, a missing node or a non-terminal node', () => {
    expect(liveLinkMenuRow({ ...base, hidden: ['live-link'] })).toEqual([])
    expect(liveLinkMenuRow({ ...base, node: null })).toEqual([])
    expect(liveLinkMenuRow({ ...base, node: { id: 'n1', kind: 'sticky', title: 'x' } })).toEqual([])
  })

  it('an untitled node is offered as "Terminal"', () => {
    const open = vi.fn()
    const row = liveLinkMenuRow({ ...base, node: { id: 'n1', kind: 'terminal', title: '  ' }, open })[0] as { onClick: () => void }
    row.onClick()
    expect(open).toHaveBeenCalledWith({ nodeId: 'n1', title: 'Terminal', projectId: 'p1' })
  })
})

describe('liveLinkNodeFor (R49)', () => {
  const live = [{ id: 'n1', type: 'terminal', data: { title: 'live title' } }]
  const stored = [
    { id: 'n1', kind: 'terminal', title: 'stored title' },
    { id: 's1', kind: 'sticky', title: 'note' }
  ]

  it('the active project is read from the live canvas', () => {
    expect(liveLinkNodeFor({ nodeId: 'n1', projectId: 'a', activeProjectId: 'a', live, stored })).toEqual({
      id: 'n1',
      kind: 'terminal',
      title: 'live title'
    })
  })

  it('any other project (a non-active sidebar row, an Omni lane) from its stored copy', () => {
    expect(liveLinkNodeFor({ nodeId: 'n1', projectId: 'b', activeProjectId: 'a', live: [], stored })).toEqual({
      id: 'n1',
      kind: 'terminal',
      title: 'stored title'
    })
    // …so the row it feeds is offered there, for THAT project.
    const open = vi.fn()
    const row = liveLinkMenuRow({
      node: liveLinkNodeFor({ nodeId: 'n1', projectId: 'b', activeProjectId: 'a', live: [], stored }),
      projectId: 'b',
      hidden: [],
      facts: facts(),
      icon: null,
      open
    })[0] as { onClick: () => void }
    row.onClick()
    expect(open).toHaveBeenCalledWith({ nodeId: 'n1', title: 'stored title', projectId: 'b' })
  })

  it('a node that is not there, or a hand-mangled stored list, is no node', () => {
    expect(liveLinkNodeFor({ nodeId: 'zz', projectId: 'b', activeProjectId: 'a', live, stored })).toBeNull()
    expect(liveLinkNodeFor({ nodeId: 'n1', projectId: 'b', activeProjectId: 'a', live, stored: undefined })).toBeNull()
    expect(
      liveLinkNodeFor({ nodeId: 'n1', projectId: 'b', activeProjectId: 'a', live, stored: 5 as never })
    ).toBeNull()
  })
})

describe('liveLinkPrepare (R47)', () => {
  it('nothing to save: no save, no refusal', async () => {
    const save = vi.fn(async () => true)
    expect(await liveLinkPrepare({ needed: false, conflict: true, save })).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('a dirty canvas is saved first', async () => {
    const save = vi.fn(async () => true)
    expect(await liveLinkPrepare({ needed: true, conflict: false, save })).toBeNull()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('never saves over an unresolved conflict', async () => {
    const save = vi.fn(async () => true)
    expect(await liveLinkPrepare({ needed: true, conflict: true, save })).toBe(SAVE_FIRST_MESSAGE)
    expect(save).not.toHaveBeenCalled()
  })

  it('a failed or throwing save refuses with the ruled sentence', async () => {
    expect(await liveLinkPrepare({ needed: true, conflict: false, save: async () => false })).toBe(SAVE_FIRST_MESSAGE)
    expect(
      await liveLinkPrepare({
        needed: true,
        conflict: false,
        save: async () => {
          throw new Error('disk')
        }
      })
    ).toBe(SAVE_FIRST_MESSAGE)
  })
})

describe('Stop all (R48)', () => {
  it('the confirm names other machines, is danger-styled, and stops only on confirm', () => {
    const close = vi.fn()
    const stop = vi.fn()
    const spec = stopAllConfirm({ close, stop })
    expect(spec.message).toBe(
      'Stop every live link on your license? This also ends links shared from other computers. Viewers are disconnected at once.'
    )
    expect(spec.confirmLabel).toBe('Stop all')
    expect(spec.danger).toBe(true)
    expect(stop).not.toHaveBeenCalled()
    spec.onConfirm()
    expect(close).toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('a rejected stop is reported, never swallowed (H23)', async () => {
    const onError = vi.fn()
    expect(await stopLiveLinks(() => Promise.reject(new Error('socket down')), onError)).toBe(false)
    expect(onError).toHaveBeenCalledWith(STOP_FAILED_MESSAGE)
    const ok = vi.fn()
    expect(await stopLiveLinks(() => Promise.resolve(), ok)).toBe(true)
    expect(ok).not.toHaveBeenCalled()
  })
})

describe('liveLinkCommands (palette)', () => {
  it('Manage always; Stop all only with links, labelled for every machine, and it CONFIRMS', () => {
    const manage = vi.fn()
    const confirmStopAll = vi.fn()
    const none = liveLinkCommands({ activeLinks: 0, icon: null, manage, confirmStopAll })
    expect(none.map((c) => c.id)).toEqual(['live-links-manage'])
    const some = liveLinkCommands({ activeLinks: 2, icon: null, manage, confirmStopAll })
    expect(some.map((c) => c.id)).toEqual(['live-links-manage', 'live-links-stop-all'])
    expect(some[0].label).toBe('Manage live links')
    expect(some[1].label).toBe('Stop all live links (every machine on this license)')
    some[0].run()
    expect(manage).toHaveBeenCalledTimes(1)
    some[1].run()
    expect(confirmStopAll).toHaveBeenCalledTimes(1)
  })
})
