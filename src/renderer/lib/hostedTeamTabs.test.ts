import { describe, it, expect, vi } from 'vitest'
import type { Project } from '@shared/types'
import { createTeamTabs, type TeamTabOps } from './hostedTeamTabs'

const proj = (id: string, name = id): Project => ({ id, name, color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] })

const A = proj('A', 'Alpha')
const B = proj('B', 'Beta')
const C = proj('C', 'Gamma')

const team = { hostId: 'host-1', label: 'Team X' }
const live = { ...team, sessionId: 'relay-1' }

/** An in-memory stand-in for the projects store + the session registry's bindings. `adoptProject`
 *  activates what it adopts, exactly as the real store does; `addPlaceholder` (the store's
 *  `addProject`) does not. */
function fakeOps(initial: Project[] = [], active: string | null = null) {
  const projects = new Map<string, Project>(initial.map((p) => [p.id, p]))
  const bindings = new Map<string, string>()
  const state = { active, placeholders: 0 }
  const ops: TeamTabOps = {
    getProject: (id) => projects.get(id),
    isOpenTab: (id) => {
      const p = projects.get(id)
      return !!p && !p.closed
    },
    adoptProject: vi.fn((p: Project) => {
      projects.set(p.id, p)
      state.active = p.id
      return { id: p.id }
    }),
    addPlaceholder: vi.fn((label: string) => {
      const id = `ph-${++state.placeholders}`
      projects.set(id, { ...proj(id), name: label })
      return { id }
    }),
    removeTab: vi.fn((id: string) => {
      projects.delete(id)
    }),
    activeProjectId: () => state.active,
    setActive: (id) => {
      state.active = id
    },
    bind: (projectId, sessionId) => {
      bindings.set(projectId, sessionId)
    },
    unbind: (projectId) => {
      bindings.delete(projectId)
    }
  }
  return { ops, projects, bindings, state }
}

describe('createTeamTabs', () => {
  it('place: adopts each shared project as a tab in host order, and keeps the user on their tab when asked', () => {
    const f = fakeOps([proj('mine')], 'mine')
    const tabs = createTeamTabs(f.ops)

    expect(tabs.place(team, [A, B], [], { keepActive: true })).toEqual(['A', 'B'])
    expect(f.ops.adoptProject).toHaveBeenCalledTimes(2)
    expect([...f.projects.keys()]).toEqual(['mine', 'A', 'B'])
    expect(f.state.active).toBe('mine')
    expect(tabs.teamOf('A')).toBe('host-1')
    expect(tabs.teamOf('B')).toBe('host-1')
    expect(tabs.teamOf('mine')).toBeUndefined()

    // Not asked to keep it: the user lands where the store's adopt put them.
    const g = fakeOps([proj('mine')], 'mine')
    createTeamTabs(g.ops).place(team, [A, B], [], { keepActive: false })
    expect(g.state.active).toBe('B')
  })

  it('place: with nothing shared, a placeholder tab named after the team', () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)

    expect(tabs.place(team, [], [], { keepActive: false })).toEqual(['ph-1'])
    expect(f.projects.get('ph-1')?.name).toBe('Team X')
    expect(tabs.teamOf('ph-1')).toBe('host-1')

    // Placing nothing again (a reconnect) keeps that one placeholder instead of minting another.
    expect(tabs.place(team, [], ['ph-1'], { keepActive: false })).toEqual(['ph-1'])
    expect(f.ops.addPlaceholder).toHaveBeenCalledTimes(1)
  })

  it('place on reconnect: reuses the existing tabs by id, removes a tab that is no longer shared', () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    expect(tabs.place(team, [A, B], [], { keepActive: false })).toEqual(['A', 'B'])

    // The host now shares only A; the greyed tabs A and B are this team's existing tabs.
    expect(tabs.place(team, [A], ['A', 'B'], { keepActive: false })).toEqual(['A'])
    expect(f.ops.adoptProject).toHaveBeenCalledTimes(2) // A was reused, not adopted a second time
    expect(f.projects.has('A')).toBe(true)
    expect(f.projects.has('B')).toBe(false)
    expect(f.ops.removeTab).toHaveBeenCalledWith('B')
    expect(tabs.teamOf('B')).toBeUndefined()
  })

  it('place: a project the user dismissed is not reopened on reconnect', () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    tabs.place(team, [A, B], [], { keepActive: false })

    expect(tabs.closeTab('B')).toEqual({ remaining: ['A'] })
    f.projects.delete('B') // the store drops the tab the user closed

    expect(tabs.place(team, [A, B], ['A'], { keepActive: false })).toEqual(['A'])
    expect(f.ops.adoptProject).toHaveBeenCalledTimes(2)
    expect(f.projects.has('B')).toBe(false)
  })

  it('sharedChanged: opens and binds a newly shared project, loading the workspace only when something opens', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    tabs.place(team, [A], [], { keepActive: false })
    expect(f.state.active).toBe('A')
    const load = vi.fn(async () => [A, C])

    await expect(tabs.sharedChanged(live, ['A', 'C'], load, { keepActive: true })).resolves.toEqual({
      opened: ['C'],
      closed: []
    })
    expect(load).toHaveBeenCalledTimes(1)
    expect(f.bindings.get('C')).toBe('relay-1')
    expect(f.projects.has('C')).toBe(true)
    expect(f.ops.adoptProject).toHaveBeenCalledTimes(2) // A was already open: only C was adopted
    expect(tabs.teamOf('C')).toBe('host-1')
    expect(f.state.active).toBe('A') // kept, although the store's adopt activated C

    // The same list again opens nothing, so the host's workspace is not loaded again.
    await expect(tabs.sharedChanged(live, ['A', 'C'], load, { keepActive: true })).resolves.toEqual({
      opened: [],
      closed: []
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('sharedChanged: closes and unbinds an unshared tab; the last unshare leaves a bound placeholder', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A, B], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    const load = vi.fn(async () => [A, B])

    await expect(tabs.sharedChanged(live, ['A'], load, { keepActive: false })).resolves.toEqual({
      opened: [],
      closed: ['B']
    })
    expect(f.projects.has('B')).toBe(false)
    expect(f.bindings.has('B')).toBe(false)
    expect(f.bindings.get('A')).toBe('relay-1')
    expect(tabs.teamOf('B')).toBeUndefined()

    await expect(tabs.sharedChanged(live, [], load, { keepActive: false })).resolves.toEqual({
      opened: [],
      closed: ['A']
    })
    expect(f.projects.has('A')).toBe(false)
    expect(f.bindings.has('A')).toBe(false)
    expect(f.projects.get('ph-1')?.name).toBe('Team X')
    expect(f.bindings.get('ph-1')).toBe('relay-1')
    expect(tabs.teamOf('ph-1')).toBe('host-1')
    expect(load).not.toHaveBeenCalled()
  })

  it('sharedChanged: the first real project replaces the placeholder', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    expect(tabs.place(team, [], [], { keepActive: false })).toEqual(['ph-1'])
    f.ops.bind('ph-1', 'relay-1')

    await expect(tabs.sharedChanged(live, ['A'], async () => [A], { keepActive: false })).resolves.toEqual({
      opened: ['A'],
      closed: []
    })
    expect(f.projects.has('A')).toBe(true)
    expect(f.bindings.get('A')).toBe('relay-1')
    expect(f.projects.has('ph-1')).toBe(false)
    expect(f.bindings.has('ph-1')).toBe(false)
    expect(tabs.teamOf('ph-1')).toBeUndefined()
    expect(tabs.teamOf('A')).toBe('host-1')
  })

  it('closeTab: with other tabs open only unbinds this one and reports them; the last tab reports none', () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A, B, C], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    // C was closed in the store behind this controller's back: it is no longer an open tab.
    f.projects.set('C', { ...C, closed: true })

    expect(tabs.closeTab('A')).toEqual({ remaining: ['B'] })
    expect(f.bindings.has('A')).toBe(false)
    expect(f.bindings.get('B')).toBe('relay-1')
    expect(tabs.teamOf('A')).toBeUndefined()
    expect(f.ops.removeTab).not.toHaveBeenCalled() // closing is the caller's; this only bookkeeps

    // The last open tab of the team: its binding stays for the caller that ends the connection.
    expect(tabs.closeTab('B')).toEqual({ remaining: [] })
    expect(f.bindings.get('B')).toBe('relay-1')
    expect(tabs.teamOf('B')).toBeUndefined()

    // A tab that belongs to no team reports nothing and touches nothing.
    expect(tabs.closeTab('mine')).toEqual({ remaining: [] })
  })
})
