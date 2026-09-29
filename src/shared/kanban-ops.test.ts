import { describe, it, expect } from 'vitest'
import { applyKanbanOp, diffKanbanOps, sanitizeKanbanOp, kanbanOpKey, isKanbanDeletion } from './kanban-ops'
import { defaultKanbanFor } from './kanban-default-board'
import type { ProjectKanban } from './types'

const P = 'project-1'
const base = (): ProjectKanban => defaultKanbanFor(P)
const [todo, doing] = base().columns.map((c) => c.id)
const live = (...ids: string[]) => new Set(ids)

describe('sanitizeKanbanOp', () => {
  it('refuses a bad id and an unknown op', () => {
    expect(sanitizeKanbanOp({ op: 'kb-card-remove', nodeId: '' })).toBeNull()
    expect(sanitizeKanbanOp({ op: 'kb-nope' })).toBeNull()
  })
  it('repairs label colour, drops bad priority / dueAt / category, keeps good fields', () => {
    expect(sanitizeKanbanOp({ op: 'kb-label', label: { id: 'l1', name: '  Bug ', color: 'neon' } }))
      .toEqual({ op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'default' } })
    expect(sanitizeKanbanOp({ op: 'kb-meta', meta: { nodeId: 'n1', priority: 'extreme', dueAt: Number.NaN } }))
      .toEqual({ op: 'kb-meta', meta: { nodeId: 'n1' } })
    expect(sanitizeKanbanOp({ op: 'kb-column', column: { id: 'c1', title: 'X', color: '#fff', category: 'weird' } }))
      .toEqual({ op: 'kb-column', column: { id: 'c1', title: 'X', color: '#fff' } })
  })
  it('refuses a label name with control characters and an over-long one', () => {
    expect(sanitizeKanbanOp({ op: 'kb-label', label: { id: 'l1', name: 'a\u0007b', color: 'red' } })).toBeNull()
    expect(sanitizeKanbanOp({ op: 'kb-label', label: { id: 'l1', name: 'x'.repeat(61), color: 'red' } })).toBeNull()
  })
  it('drops an invalid rank rather than the whole op', () => {
    expect(sanitizeKanbanOp({ op: 'kb-card', assignment: { nodeId: 'n1', columnId: 'c1', rank: '!!' } }))
      .toEqual({ op: 'kb-card', assignment: { nodeId: 'n1', columnId: 'c1' } })
  })
})

describe('keys and deletions', () => {
  it('uses one k: key space', () => {
    expect(kanbanOpKey({ op: 'kb-card', assignment: { nodeId: 'n1', columnId: 'c' } })).toBe('k:card:n1')
    expect(kanbanOpKey({ op: 'kb-card-remove', nodeId: 'n1' })).toBe('k:card:n1')
    expect(kanbanOpKey({ op: 'kb-column-order', ids: [] })).toBe('k:colorder')
  })
  it('only column/label/view removals are deletions (rule 4); card and meta removals are values', () => {
    expect(isKanbanDeletion({ op: 'kb-column-remove', id: 'c' })).toBe(true)
    expect(isKanbanDeletion({ op: 'kb-card-remove', nodeId: 'n' })).toBe(false)
    expect(isKanbanDeletion({ op: 'kb-meta-remove', nodeId: 'n' })).toBe(false)
  })
})

describe('applyKanbanOp', () => {
  it('seeds the deterministic default board when the project has none', () => {
    const b = applyKanbanOp(undefined, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    expect(b.columns.map((c) => c.id)).toEqual(base().columns.map((c) => c.id))
    expect(b.assignments).toEqual([{ nodeId: 'n1', columnId: todo }])
  })
  it('a card op replaces the card and keeps its column in rank order', () => {
    let b = base()
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo, rank: 'm' } }, P)
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'n2', columnId: todo, rank: 'c' } }, P)
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: doing, rank: 'm' } }, P)
    expect(b.assignments.filter((a) => a.columnId === todo).map((a) => a.nodeId)).toEqual(['n2'])
    expect(b.assignments.filter((a) => a.columnId === doing).map((a) => a.nodeId)).toEqual(['n1'])
  })
  it('a column removal also drops the column’s placements', () => {
    let b = applyKanbanOp(base(), { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    b = applyKanbanOp(b, { op: 'kb-column-remove', id: todo }, P)
    expect(b.columns.some((c) => c.id === todo)).toBe(false)
    expect(b.assignments).toEqual([])
  })
  it('a label removal strips it from every card', () => {
    let b = applyKanbanOp(base(), { op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'red' } }, P)
    b = applyKanbanOp(b, { op: 'kb-meta', meta: { nodeId: 'n1', labels: ['l1'] } }, P)
    b = applyKanbanOp(b, { op: 'kb-label-remove', id: 'l1' }, P)
    expect(b.labels).toEqual([])
    expect(b.meta ?? []).toEqual([])
  })
  it('column order: listed ids first, unlisted kept after, unknown ignored', () => {
    const ids = base().columns.map((c) => c.id)
    const b = applyKanbanOp(base(), { op: 'kb-column-order', ids: [ids[2], 'ghost', ids[0]] }, P)
    expect(b.columns.map((c) => c.id)).toEqual([ids[2], ids[0], ids[1]])
  })
})

describe('diffKanbanOps', () => {
  it('one move of one card is one kb-card op', () => {
    const prev = applyKanbanOp(base(), { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    const next = applyKanbanOp(prev, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: doing } }, P)
    expect(diffKanbanOps(prev, next, P, live('n1'))).toEqual([
      { op: 'kb-card', assignment: { nodeId: 'n1', columnId: doing } }
    ])
  })
  it('an absent prev board diffs against the deterministic default (no column ops for the seed)', () => {
    const next = applyKanbanOp(undefined, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    expect(diffKanbanOps(undefined, next, P, live('n1'))).toEqual([
      { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }
    ])
  })
  it('prune removals of dead cards are never cast', () => {
    const prev = applyKanbanOp(base(), { op: 'kb-card', assignment: { nodeId: 'dead', columnId: todo } }, P)
    expect(diffKanbanOps(prev, base(), P, live())).toEqual([])
  })
  it('prune removals of a dead card\'s meta are never cast; a live card\'s cleared meta is', () => {
    const prev = applyKanbanOp(base(), { op: 'kb-meta', meta: { nodeId: 'dead', priority: 'high' } }, P)
    expect(diffKanbanOps(prev, base(), P, live())).toEqual([])
    expect(diffKanbanOps(prev, base(), P, live('dead'))).toEqual([{ op: 'kb-meta-remove', nodeId: 'dead' }])
  })
  it('a live card moved to Ungrouped is a kb-card-remove', () => {
    const prev = applyKanbanOp(base(), { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    expect(diffKanbanOps(prev, base(), P, live('n1'))).toEqual([{ op: 'kb-card-remove', nodeId: 'n1' }])
  })
  it('batch order: upserts before removals; a removed column covers its own cards', () => {
    const prev = applyKanbanOp(base(), { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    let next = applyKanbanOp(prev, { op: 'kb-column-remove', id: todo }, P)
    next = applyKanbanOp(next, { op: 'kb-label', label: { id: 'l1', name: 'x', color: 'red' } }, P)
    const ops = diffKanbanOps(prev, next, P, live('n1')).map((o) => o.op)
    // No separate kb-card-remove: applyKanbanOp drops the column's placements with the column.
    expect(ops).toEqual(['kb-label', 'kb-column-remove'])
  })
  it('never diffs github or pullLinks', () => {
    const prev = base()
    const next: ProjectKanban = {
      ...prev,
      github: { repository: 'a/b', columnMappings: [{ columnId: todo, label: 'status:todo' }] },
      pullLinks: { unlinked: [{ nodeId: 'n1', pull: 7 }], noAutoMove: ['n1'] }
    }
    expect(diffKanbanOps(prev, next, P, live('n1'))).toEqual([])
  })
})
