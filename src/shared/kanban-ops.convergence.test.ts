// Board convergence under concurrency: two clients and the authority, each applying the reflector's
// stream through the SAME order (`createCanvasOrder`) and the SAME reducer (`applyKanbanOp`), with
// every client publishing through `diffKanbanOps`. A column list is a LIST, and an item op
// (`kb-column`) only says the column exists — its place comes from the order op (ruling R3). Two
// people adding a column at once used to leave A at …,X,Y and B at …,Y,X for good.

import { describe, expect, it } from 'vitest'
import { applyKanbanOp, diffKanbanOps } from './kanban-ops'
import { createCanvasOrder } from './canvas-order'
import { defaultKanbanFor } from './kanban-default-board'
import type { CanvasMutation, KanbanOp, ProjectKanban } from './types'

const P = 'project-1'

interface Replica {
  name: string
  order: ReturnType<typeof createCanvasOrder>
  board: ProjectKanban
}

/** A bus with the reflector's contract: one total order (`seq`), delivered to every replica — the
 *  sender included (its copy is its ack) — and to the authority, in that order. */
function world(names: string[]) {
  let seq = 0
  let authority: ProjectKanban = defaultKanbanFor(P)
  const wire: CanvasMutation[] = []
  const replicas: Replica[] = names.map((name) => ({
    name,
    order: createCanvasOrder(name),
    board: defaultKanbanFor(P)
  }))
  const byName = new Map(replicas.map((r) => [r.name, r]))
  return {
    replicas,
    authority: () => authority,
    /** A local edit on one replica: take the new board, cast its diff (what the publisher does). */
    edit(name: string, next: (b: ProjectKanban) => ProjectKanban) {
      const r = byName.get(name)!
      const after = next(r.board)
      for (const op of diffKanbanOps(r.board, after, P, new Set())) {
        const m = r.order.stamp({ ...op, src: r.name } as CanvasMutation)
        r.order.onLocal(m, P)
        wire.push(m)
      }
      r.board = after
    },
    /** The reflector stamps what arrived, in arrival order, and fans it out. */
    reflect() {
      for (const m of wire.splice(0).map((x) => ({ ...x, seq: ++seq }))) {
        authority = applyKanbanOp(authority, m as unknown as KanbanOp, P)
        for (const r of replicas) {
          if (r.order.accept(m, P)) r.board = applyKanbanOp(r.board, m as unknown as KanbanOp, P)
        }
      }
    }
  }
}

const ids = (k: ProjectKanban) => k.columns.map((c) => c.id)
const add = (id: string, title: string) => (b: ProjectKanban): ProjectKanban => ({
  ...b,
  columns: [...b.columns, { id, title, color: '#123456' }]
})

describe('board convergence (ruling R3)', () => {
  it('two clients adding a column at once converge on every replica and the authority', () => {
    const w = world(['A', 'B'])
    w.edit('A', add('kcol-X', 'X'))
    w.edit('B', add('kcol-Y', 'Y'))
    w.reflect()
    const [a, b] = w.replicas
    expect(ids(a.board)).toEqual(ids(b.board))
    expect(ids(a.board)).toEqual(ids(w.authority()))
    // …on the LATER order op's list: B cast after A, so B's order (…, Y) leads and X follows
    expect(ids(a.board).slice(-2)).toEqual(['kcol-Y', 'kcol-X'])
  })

  it('a column inserted mid-list lands mid-list on the peer (add + move in one edit)', () => {
    const w = world(['A', 'B'])
    w.edit('A', (b) => {
      const [c0, ...rest] = b.columns
      return { ...b, columns: [c0, { id: 'kcol-new', title: 'New', color: '#123456' }, ...rest] }
    })
    w.reflect()
    const [a, b] = w.replicas
    expect(ids(b.board)).toEqual(ids(a.board))
    expect(ids(b.board)[1]).toBe('kcol-new')
    expect(ids(w.authority())).toEqual(ids(a.board))
  })

  it('two clients adding a label at once converge too (kb-label-order)', () => {
    const w = world(['A', 'B'])
    w.edit('A', (b) => ({ ...b, labels: [...(b.labels ?? []), { id: 'l-x', name: 'x', color: 'red' }] }))
    w.edit('B', (b) => ({ ...b, labels: [...(b.labels ?? []), { id: 'l-y', name: 'y', color: 'blue' }] }))
    w.reflect()
    const [a, b] = w.replicas
    const labels = (k: ProjectKanban) => (k.labels ?? []).map((l) => l.id)
    expect(labels(a.board)).toEqual(labels(b.board))
    expect(labels(a.board)).toEqual(labels(w.authority()))
  })
})
