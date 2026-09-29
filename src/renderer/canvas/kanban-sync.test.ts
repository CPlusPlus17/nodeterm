import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { boardLiveNodeIds, createKanbanPublisher, type KanbanPublisherDeps } from './kanban-sync'
import { applyKanbanOp } from '@shared/kanban-ops'
import { defaultKanbanFor } from '@shared/kanban-default-board'
import type { CanvasMutation, KanbanOp, ProjectKanban } from '@shared/types'
import { setKanbanPublishHook, useProjects } from '../state/projects'

const P = 'project-1'
const todo = defaultKanbanFor(P).columns[0].id
const doing = defaultKanbanFor(P).columns[1].id

/** A publisher over recording deps: every cast and every local repair it makes lands in a list. */
function harness(over: Partial<KanbanPublisherDeps> = {}) {
  const sent: Array<[string, CanvasMutation]> = []
  const repaired: Array<[string, CanvasMutation]> = []
  const pub = createKanbanPublisher({
    send: (id, m) => { sent.push([id, m]); return true },
    liveNodeIds: () => new Set(['n1', 'n2']),
    shouldPublish: () => true,
    applyLocal: (id, m) => { repaired.push([id, m]) },
    ...over
  })
  return { pub, sent, repaired }
}

const withCard = (board: ProjectKanban | undefined, nodeId: string, columnId: string): ProjectKanban =>
  applyKanbanOp(board, { op: 'kb-card', assignment: { nodeId, columnId } }, P)

describe('createKanbanPublisher', () => {
  it('casts item ops for the project, and nothing when publishing is off', () => {
    const sent: Array<[string, CanvasMutation]> = []
    let on = true
    const pub = createKanbanPublisher({
      send: (id, m) => { sent.push([id, m]); return true },
      liveNodeIds: () => new Set(['n1']),
      shouldPublish: () => on,
      applyLocal: () => {}
    })
    const next = applyKanbanOp(undefined, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    pub.publish(P, undefined, next)
    expect(sent).toEqual([[P, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }]])
    on = false
    pub.publish(P, next, undefined)
    expect(sent).toHaveLength(1)
  })

  // The test above closes the gate on a write to `undefined`, which diffs to nothing whatever the
  // gate says. A REAL change must also stay home while the gate is closed (solo, read-only role).
  it('a real change is not cast, and nothing is repaired, while the gate is closed', () => {
    const { pub, sent, repaired } = harness({ shouldPublish: () => false })
    pub.publish(P, withCard(undefined, 'n1', todo), withCard(undefined, 'n1', doing))
    pub.publish(P, defaultKanbanFor(P), { ...defaultKanbanFor(P), labels: [{ id: 'l', name: 'y'.repeat(80), color: 'red' }] })
    expect(sent).toEqual([])
    expect(repaired).toEqual([])
  })

  it('never casts a pruned dead card', () => {
    const sent: CanvasMutation[] = []
    const pub = createKanbanPublisher({
      send: (_id, m) => { sent.push(m); return true },
      liveNodeIds: () => new Set(),
      shouldPublish: () => true,
      applyLocal: () => {}
    })
    const prev = applyKanbanOp(undefined, { op: 'kb-card', assignment: { nodeId: 'dead', columnId: todo } }, P)
    pub.publish(P, prev, defaultKanbanFor(P))
    expect(sent).toEqual([])
  })

  it('never casts a pruned dead card’s meta either', () => {
    const { pub, sent } = harness({ liveNodeIds: () => new Set() })
    const prev = applyKanbanOp(undefined, { op: 'kb-meta', meta: { nodeId: 'dead', priority: 'high' } }, P)
    pub.publish(P, prev, { ...prev, meta: [] })
    expect(sent).toEqual([])
  })

  // The other half of the prune rule: a LIVE card taken off the board is a real edit and is cast.
  // Without this the two tests above would pass for a publisher that casts no removal at all.
  it('casts the removal of a live card (a person moving it back to Ungrouped)', () => {
    const { pub, sent } = harness()
    const prev = withCard(undefined, 'n1', todo)
    pub.publish(P, prev, defaultKanbanFor(P))
    expect(sent).toEqual([[P, { op: 'kb-card-remove', nodeId: 'n1' }]])
  })

  it('asks the gate with the project it publishes for, and reads that project’s live nodes', () => {
    const asked: string[] = []
    const { pub, sent } = harness({
      shouldPublish: (id) => { asked.push(`gate:${id}`); return true },
      liveNodeIds: (id) => { asked.push(`live:${id}`); return new Set(['n1']) }
    })
    const other = defaultKanbanFor('other')
    const prev = applyKanbanOp(other, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: other.columns[0].id } }, 'other')
    pub.publish('other', prev, other)
    expect(asked).toEqual(['gate:other', 'live:other'])
    expect(sent).toEqual([['other', { op: 'kb-card-remove', nodeId: 'n1' }]])
  })

  it('a write that changes nothing the vocabulary carries casts nothing (github config)', () => {
    const { pub, sent } = harness()
    const prev = withCard(undefined, 'n1', todo)
    pub.publish(P, prev, { ...prev, github: { repo: 'o/r' } } as unknown as ProjectKanban)
    expect(sent).toEqual([])
  })

  // RULING R2. The reflector repairs a name and the sender drops its own echo, so a board holding
  // the unrepaired value would show something no peer has, forever. The clean form is what is cast,
  // and — when it differs from what the board holds — what the board is set to, through the store
  // reducer (never setProjectKanban: that would publish again).
  describe('R2: the clean form is cast, and applied locally when it differs', () => {
    const long = 'x'.repeat(80)
    const board = (name: string): ProjectKanban => ({
      ...defaultKanbanFor(P),
      labels: [{ id: 'lab-1', name, color: 'red' }]
    })

    it('an over-long label name is cast cut to 60, and the cut form is applied locally', () => {
      const { pub, sent, repaired } = harness()
      pub.publish(P, defaultKanbanFor(P), board(long))
      const clean = { op: 'kb-label', label: { id: 'lab-1', name: 'x'.repeat(60), color: 'red' } }
      expect(sent).toContainEqual([P, clean])
      expect(repaired).toEqual([[P, clean]])
    })

    it('a value that is already clean is not re-applied', () => {
      const { pub, sent, repaired } = harness()
      pub.publish(P, defaultKanbanFor(P), board('bug'))
      expect(sent.length).toBeGreaterThan(0)
      expect(repaired).toEqual([])
    })

    it('key order alone is not a difference', () => {
      const { pub, repaired } = harness()
      const next: ProjectKanban = {
        ...defaultKanbanFor(P),
        columns: defaultKanbanFor(P).columns.map((c) => ({ category: c.category, color: c.color, title: c.title, id: c.id }))
      }
      pub.publish(P, withCard(undefined, 'n1', todo), withCard(next, 'n1', doing))
      expect(repaired).toEqual([])
    })

    it('nothing is applied locally for an op that was not cast', () => {
      const { pub, repaired } = harness({ send: () => false })
      pub.publish(P, defaultKanbanFor(P), board(long))
      expect(repaired).toEqual([])
    })

    it('an op the sanitizer refuses is never cast (the reflector would refuse it too)', () => {
      const { pub, sent } = harness()
      // An id is an address: never repaired, only refused (here: past the 128-char ref bound).
      const bad = { ...defaultKanbanFor(P), labels: [{ id: 'l'.repeat(129), name: 'bell', color: 'red' }] } as ProjectKanban
      pub.publish(P, defaultKanbanFor(P), bad)
      expect(sent.filter(([, m]) => m.op === 'kb-label')).toEqual([])
    })
  })
})

// RULING R6. The Omni board prunes each lane against the STORED nodes, and for the project React Flow
// holds that copy lags the canvas while the board is open (a peer's node op, a "+ New" or an agent
// spawn lands in React Flow only). A card the Omni board just pruned because its node is not stored
// yet must not read as a live card someone took off the board — that removal would delete it for
// everyone. So while the Omni board is open the rendered project's live set is React Flow ∩ store.
describe('boardLiveNodeIds (R6)', () => {
  it('a project React Flow does not hold answers from its stored nodes', () => {
    expect([...boardLiveNodeIds({ rendered: null, stored: ['a', 'b'], omniOpen: true })]).toEqual(['a', 'b'])
    expect([...boardLiveNodeIds({ rendered: null, stored: ['a'], omniOpen: false })]).toEqual(['a'])
  })

  it('the rendered project answers from React Flow while the Omni board is closed', () => {
    expect([...boardLiveNodeIds({ rendered: ['a', 'n'], stored: ['a'], omniOpen: false })].sort()).toEqual(['a', 'n'])
  })

  it('…and from React Flow ∩ store while it is open', () => {
    expect([...boardLiveNodeIds({ rendered: ['a', 'n'], stored: ['a', 'gone'], omniOpen: true })]).toEqual(['a'])
  })

  it('a card the Omni board pruned because its node is not stored yet is never removed for everyone', () => {
    // n is on the canvas (a peer's node op landed in React Flow) but not in the stored copy the Omni
    // lane prunes against. The peer's card for n arrived; the Omni user moved another card.
    const sent: CanvasMutation[] = []
    const live = { rendered: ['m', 'n'], stored: ['m'] }
    const pub = createKanbanPublisher({
      send: (_id, m) => { sent.push(m); return true },
      liveNodeIds: () => boardLiveNodeIds({ ...live, omniOpen: true }),
      shouldPublish: () => true,
      applyLocal: () => {}
    })
    const prev: ProjectKanban = {
      ...withCard(withCard(undefined, 'm', todo), 'n', todo),
      meta: [{ nodeId: 'n', priority: 'high' }]
    }
    // What the Omni lane commits: m moved, and n's card + meta pruned (n is not a stored session).
    const next: ProjectKanban = { ...withCard(prev, 'm', doing), assignments: [{ nodeId: 'm', columnId: doing }], meta: [] }
    pub.publish(P, prev, next)
    expect(sent.filter((m) => m.op === 'kb-card-remove' || m.op === 'kb-meta-remove')).toEqual([])
    expect(sent).toContainEqual({ op: 'kb-card', assignment: { nodeId: 'm', columnId: doing } })
  })
})

// The store funnel + the publisher + the store reducer, together: what Canvas wires up.
describe('the store funnel publishes, and only the funnel', () => {
  const node = { id: 'n1', kind: 'terminal', title: 'n1', color: '#fff', group: '', position: { x: 0, y: 0 }, size: { width: 10, height: 10 } }
  let calls: Array<[string, ProjectKanban | undefined, ProjectKanban | undefined]>
  let sent: CanvasMutation[]
  let pid: string

  beforeEach(() => {
    useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
    pid = useProjects.getState().addProject('p').id
    useProjects.getState().commitCanvas(pid, [node as never], { x: 0, y: 0, zoom: 1 })
    calls = []
    sent = []
    const pub = createKanbanPublisher({
      send: (_id, m) => { sent.push(m); return true },
      liveNodeIds: (id) => new Set((useProjects.getState().getProject(id)?.nodes ?? []).map((n) => n.id)),
      shouldPublish: () => true,
      applyLocal: (id, m) => { useProjects.getState().applyCanvasOp(id, m) }
    })
    setKanbanPublishHook((id, prev, next) => {
      calls.push([id, prev, next])
      pub.publish(id, prev, next)
    })
  })
  afterEach(() => setKanbanPublishHook(null))

  it('R2 end to end: the board ends on the clean name, and the repair publishes nothing more', () => {
    const next: ProjectKanban = { ...defaultKanbanFor(pid), labels: [{ id: 'lab-1', name: 'y'.repeat(90), color: 'red' }] }
    useProjects.getState().setProjectKanban(pid, next)
    expect(useProjects.getState().getProject(pid)?.kanban?.labels).toEqual([{ id: 'lab-1', name: 'y'.repeat(60), color: 'red' }])
    expect(calls).toHaveLength(1) // the repair went through the reducer, not the funnel
    expect(sent.filter((m) => m.op === 'kb-label')).toHaveLength(1)
  })

  it('a peer op applied through the store reducer never publishes', () => {
    const op: KanbanOp = { op: 'kb-card', assignment: { nodeId: 'n1', columnId: defaultKanbanFor(pid).columns[0].id } }
    expect(useProjects.getState().applyCanvasOp(pid, op)).toBe(true)
    expect(useProjects.getState().getProject(pid)?.kanban?.assignments).toEqual([op.assignment])
    expect(calls).toEqual([])
    expect(sent).toEqual([])
  })
})
