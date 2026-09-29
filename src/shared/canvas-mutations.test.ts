import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  applyCanvasMutation,
  applyEdgeMutation,
  applyEdgeMutationToScene,
  createMutationGuard,
  diffToMutations,
  isCanvasMutation,
  MUTATION_MAX_BYTES,
  sanitizeCanvasMutation
} from './canvas-mutations'
import type { BridgeLink, CanvasMutation, CanvasNodeState } from './types'

const n = (id: string, x = 0, title = 't'): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title,
    color: '#fff',
    position: { x, y: 0 },
    size: { width: 100, height: 100 }
  }) as CanvasNodeState

describe('applyCanvasMutation', () => {
  it('upserts by id (append when absent, replace when present) without mutating the input', () => {
    const a = [n('1')]
    expect(applyCanvasMutation(a, { op: 'upsert', node: n('2') }).map((x) => x.id)).toEqual([
      '1',
      '2'
    ])
    expect(applyCanvasMutation(a, { op: 'upsert', node: n('1', 9) })[0].position.x).toBe(9)
    expect(a[0].position.x).toBe(0)
  })

  it('removes by id', () => {
    expect(
      applyCanvasMutation([n('1'), n('2')], { op: 'remove', id: '1' }).map((x) => x.id)
    ).toEqual(['2'])
  })
})

describe('diffToMutations', () => {
  it('emits an upsert for added and changed nodes and a remove for dropped ones', () => {
    expect(diffToMutations([n('1')], [n('1', 5)])).toEqual([{ op: 'upsert', node: n('1', 5) }])
    expect(diffToMutations([n('1')], [n('1'), n('2')])).toEqual([{ op: 'upsert', node: n('2') }])
    expect(diffToMutations([n('1'), n('2')], [n('1')])).toEqual([{ op: 'remove', id: '2' }])
  })

  it('emits nothing when the snapshots are deep-equal regardless of key order', () => {
    const a = {
      id: '1',
      kind: 'terminal',
      position: { x: 1, y: 2 },
      size: { width: 3, height: 4 }
    } as CanvasNodeState
    const b = {
      size: { height: 4, width: 3 },
      position: { y: 2, x: 1 },
      kind: 'terminal',
      id: '1'
    } as CanvasNodeState
    expect(diffToMutations([a], [b])).toEqual([])
  })

  it('detects a title/color/collapsed change, not just geometry', () => {
    expect(diffToMutations([n('1')], [n('1', 0, 'renamed')])).toEqual([
      { op: 'upsert', node: n('1', 0, 'renamed') }
    ])
  })
})

// The publisher's guard: the same verdict as `isCanvasMutation`, but it must not PAY for it twice on
// an unchanged node. The size check serializes the whole node, the publisher re-emits a refused node
// on every publish (that is what makes it sync the moment the user trims it), and a drag publishes at
// 20 Hz — so the one node that is already pathological (a sticky holding a pasted document) was being
// stringified 20×/s, at a cost proportional to its size.
describe('createMutationGuard', () => {
  afterEach(() => vi.restoreAllMocks())

  /** A sticky over the size cap. `text` is the SAME string on every rebuild — exactly what
   *  flowToNodeStates does: it rebuilds the node object each publish but passes `data.text` through
   *  by reference. */
  const bigText = 'x'.repeat(MUTATION_MAX_BYTES)
  const fat = (x = 0, text = bigText): CanvasNodeState =>
    ({ ...n('sticky-1', x), kind: 'sticky', text }) as CanvasNodeState

  /** Count only the serializations of a NODE (the expensive path) — not vitest's own internals. */
  const countSerializations = (): { calls: () => number } => {
    const spy = vi.spyOn(JSON, 'stringify')
    return {
      calls: () =>
        spy.mock.calls.filter((c) => {
          const v = c[0] as { node?: { id?: unknown } } | undefined
          return !!v && typeof v === 'object' && !!v.node
        }).length
    }
  }

  it('serializes an unchanged oversized node ONCE, however many times it is re-published', () => {
    const guard = createMutationGuard()
    const { calls } = countSerializations()

    // 40 publishes of the SAME (still oversized) sticky — two seconds of a 20 Hz drag.
    for (let i = 0; i < 40; i++) {
      expect(guard({ op: 'upsert', node: fat(), src: 'me' })).toBe(false)
    }
    expect(calls()).toBe(1) // was: 40 — one full serialization of a 256 KB node per publish
  })

  it('re-validates the moment the node actually changes (and the trimmed sticky syncs)', () => {
    const guard = createMutationGuard()
    expect(guard({ op: 'upsert', node: fat() })).toBe(false)

    // Still too big, but MOVED: a changed node is a new verdict, so it is paid for again…
    const { calls } = countSerializations()
    expect(guard({ op: 'upsert', node: fat(7) })).toBe(false)
    expect(calls()).toBe(1)

    // …and the user trims it → it is within the cap → it CASTS. (The refusal must not be sticky:
    // the whole point of retrying a refused node is that it syncs as soon as it fits.)
    expect(guard({ op: 'upsert', node: fat(7, 'short') })).toBe(true)
    // …and stays castable afterwards, without re-consulting a stale refusal.
    expect(guard({ op: 'upsert', node: fat(7, 'short') })).toBe(true)
  })

  it('gives exactly the verdict of isCanvasMutation (shape, ids, geometry, size)', () => {
    const guard = createMutationGuard()
    const cases: unknown[] = [
      { op: 'upsert', node: n('1') },
      { op: 'remove', id: '1' },
      { op: 'remove', id: '' },
      { op: 'upsert', node: { ...n('1'), id: '' } },
      { op: 'upsert', node: { ...n('1'), position: { x: NaN, y: 0 } } },
      { op: 'upsert', node: fat() },
      { op: 'nope' },
      null
    ]
    for (const c of cases) {
      expect(guard(c as never), JSON.stringify(c).slice(0, 40)).toBe(isCanvasMutation(c))
    }
  })

  it('remembers a refusal per node — one fat sticky does not mask another', () => {
    const guard = createMutationGuard()
    const other = (): CanvasNodeState =>
      ({ ...n('sticky-2'), kind: 'sticky', text: bigText }) as CanvasNodeState
    expect(guard({ op: 'upsert', node: fat() })).toBe(false)
    expect(guard({ op: 'upsert', node: other() })).toBe(false)
    const { calls } = countSerializations()
    expect(guard({ op: 'upsert', node: fat() })).toBe(false)
    expect(guard({ op: 'upsert', node: other() })).toBe(false)
    expect(calls()).toBe(0) // both refusals are remembered, neither is re-serialized
  })
})

// ── Edges ────────────────────────────────────────────────────────────────────────────────────────
// Edges (`bridges` = context links, `ropes` = display-only lineage) ride the same whole-file save as
// the nodes but were NOT in the mutation vocabulary. So an edge you drew never reached your
// teammate — and their next save, of a canvas that never had it, DELETED it. Syncing them is what
// makes the file both clients converge on the file they both agree with.

const e = (id: string, source = 'a', target = 'b'): BridgeLink => ({ id, source, target })

describe('applyEdgeMutation', () => {
  it('appends, replaces and removes by id without mutating the input', () => {
    const list = [e('x')]
    expect(
      applyEdgeMutation(list, 'bridge', { op: 'edge-upsert', kind: 'bridge', edge: e('y') })
    ).toHaveLength(2)
    expect(
      applyEdgeMutation(list, 'bridge', {
        op: 'edge-upsert',
        kind: 'bridge',
        edge: e('x', 'a', 'z')
      })[0].target
    ).toBe('z')
    expect(
      applyEdgeMutation(list, 'bridge', { op: 'edge-remove', kind: 'bridge', id: 'x' })
    ).toEqual([])
    expect(list).toEqual([e('x')]) // untouched
  })

  it('leaves the OTHER kind alone, by reference (a rope mutation is not a bridge edit)', () => {
    const list = [e('x')]
    expect(applyEdgeMutation(list, 'bridge', { op: 'edge-upsert', kind: 'rope', edge: e('r') })).toBe(
      list
    )
    expect(applyEdgeMutation(list, 'bridge', { op: 'remove', id: 'x' })).toBe(list)
  })

  // A duplicate cast (every Server Edition tab re-casts a server-written edge) must not cost a
  // setState + markDirty + save on every receiver.
  it('keeps identity when an upsert carries the edge we already hold', () => {
    const list = [e('x')]
    expect(applyEdgeMutation(list, 'bridge', { op: 'edge-upsert', kind: 'bridge', edge: e('x') })).toBe(
      list
    )
  })

  it('keeps identity when a remove names an edge we do not have', () => {
    const list = [e('x')]
    expect(applyEdgeMutation(list, 'bridge', { op: 'edge-remove', kind: 'bridge', id: 'q' })).toBe(
      list
    )
  })

  it('carries only the three ids — decoration is re-derived per client, never sent', () => {
    const fat = { ...e('x'), style: { stroke: 'red' } } as unknown as BridgeLink
    const [out] = applyEdgeMutation([], 'bridge', { op: 'edge-upsert', kind: 'bridge', edge: fat })
    expect(Object.keys(out).sort()).toEqual(['id', 'source', 'target'])
  })
})

// `mutationKey` leaves `kind` out (`e:<id>`): one id is one edge. The apply has to agree, or a
// rope upsert for an id the bridge list already holds leaves that id in BOTH lists.
describe('applyEdgeMutationToScene — one id is one edge', () => {
  it('an edge id lives in one list', () => {
    const s0 = { bridges: [{ id: 'x', source: 'a', target: 'b' }], ropes: [] }
    const s1 = applyEdgeMutationToScene(s0, { op: 'edge-upsert', kind: 'rope', edge: { id: 'x', source: 'a', target: 'b' } })
    expect(s1).toEqual({ bridges: [], ropes: [{ id: 'x', source: 'a', target: 'b' }] })
    expect(applyEdgeMutationToScene(s1, { op: 'edge-remove', kind: 'bridge', id: 'x' })).toEqual({ bridges: [], ropes: [] })
  })

  it('keeps both lists by reference when nothing changes (the caller short-circuit fires)', () => {
    const s = { bridges: [e('x')], ropes: [e('r')] }
    const same = (m: Parameters<typeof applyEdgeMutationToScene>[1]) => {
      const out = applyEdgeMutationToScene(s, m)
      expect(out.bridges).toBe(s.bridges)
      expect(out.ropes).toBe(s.ropes)
    }
    same({ op: 'edge-remove', kind: 'bridge', id: 'q' }) // an edge we do not have
    same({ op: 'edge-upsert', kind: 'bridge', edge: e('x') }) // one we already hold, unchanged
    same({ op: 'remove', id: 'x' }) // a NODE op
  })

  it('leaves the list it does not touch by reference', () => {
    const s = { bridges: [e('x')], ropes: [e('r')] }
    const out = applyEdgeMutationToScene(s, { op: 'edge-upsert', kind: 'bridge', edge: e('y') })
    expect(out.bridges.map((b) => b.id)).toEqual(['x', 'y'])
    expect(out.ropes).toBe(s.ropes)
  })
})

describe('applyCanvasMutation with an edge mutation', () => {
  it('is a no-op that keeps the array identity (the caller short-circuit still fires)', () => {
    const nodes = [n('1')]
    expect(applyCanvasMutation(nodes, { op: 'edge-remove', kind: 'bridge', id: 'x' })).toBe(nodes)
    expect(applyCanvasMutation(nodes, { op: 'edge-upsert', kind: 'rope', edge: e('x') })).toBe(nodes)
  })
})

describe('isCanvasMutation — edge ops', () => {
  it('accepts well-formed edge mutations', () => {
    expect(isCanvasMutation({ op: 'edge-upsert', kind: 'bridge', edge: e('x') })).toBe(true)
    expect(isCanvasMutation({ op: 'edge-remove', kind: 'rope', id: 'x' })).toBe(true)
  })

  it('rejects an unknown kind — the kind picks which persisted list is written', () => {
    expect(isCanvasMutation({ op: 'edge-upsert', kind: 'bridges', edge: e('x') })).toBe(false)
    expect(isCanvasMutation({ op: 'edge-remove', id: 'x' })).toBe(false)
  })

  it('rejects a malformed or over-long endpoint — an edge id is an ADDRESS, never truncated', () => {
    expect(isCanvasMutation({ op: 'edge-upsert', kind: 'bridge', edge: { id: 'x', source: 'a' } })).toBe(
      false
    )
    expect(isCanvasMutation({ op: 'edge-upsert', kind: 'bridge', edge: e('x', '', 'b') })).toBe(false)
    expect(
      isCanvasMutation({ op: 'edge-upsert', kind: 'bridge', edge: e('x', 'a'.repeat(129), 'b') })
    ).toBe(false)
    expect(isCanvasMutation({ op: 'edge-upsert', kind: 'bridge' })).toBe(false)
  })
})

describe('diffToMutations — scenes', () => {
  const scene = (
    nodes: CanvasNodeState[],
    bridges: BridgeLink[] = [],
    ropes: BridgeLink[] = []
  ) => ({ nodes, bridges, ropes })

  it('reads a bare node array as a scene with no edges (every pre-edge caller is unchanged)', () => {
    expect(diffToMutations([n('1')], [n('1')])).toEqual([])
    expect(diffToMutations([], [n('1')])).toEqual([{ op: 'upsert', node: n('1') }])
  })

  it('emits an edge-upsert for a drawn edge and an edge-remove for a deleted one', () => {
    expect(diffToMutations(scene([]), scene([], [e('x')]))).toEqual([
      { op: 'edge-upsert', kind: 'bridge', edge: e('x') }
    ])
    expect(diffToMutations(scene([], [e('x')]), scene([]))).toEqual([
      { op: 'edge-remove', kind: 'bridge', id: 'x' }
    ])
  })

  it('tags each list with its own kind', () => {
    expect(diffToMutations(scene([]), scene([], [], [e('r')]))).toEqual([
      { op: 'edge-upsert', kind: 'rope', edge: e('r') }
    ])
  })

  it('emits nothing when only the decoration would have differed (three ids are the value)', () => {
    const before = scene([], [e('x')])
    const after = scene([], [{ ...e('x') }])
    expect(diffToMutations(before, after)).toEqual([])
  })

  it('re-emits an edge whose endpoint was re-pointed', () => {
    expect(diffToMutations(scene([], [e('x', 'a', 'b')]), scene([], [e('x', 'a', 'c')]))).toEqual([
      { op: 'edge-upsert', kind: 'bridge', edge: e('x', 'a', 'c') }
    ])
  })

  // One id is one edge (see applyEdgeMutationToScene): an id that moves from one list to the other
  // is still on the canvas, so it is an upsert of its new kind and NOT also a remove of its old one.
  // A receiver applies the batch in order, and a trailing `edge-remove` would delete it from both.
  it('an edge moving between the lists casts its upsert and no remove', () => {
    expect(diffToMutations(scene([], [e('x')]), scene([], [], [e('x')]))).toEqual([
      { op: 'edge-upsert', kind: 'rope', edge: e('x') }
    ])
  })

  // A peer applies these ONE AT A TIME, so the batch order decides whether an edge ever lands: an
  // edge-upsert naming a node that has not arrived yet draws into nothing, and an edge-remove for an
  // edge whose node dies in the same batch has to land while the edge is still there.
  it('orders the batch: node adds → edge adds → edge removes → node removes', () => {
    const before = scene([n('old')], [e('gone', 'old', 'old')])
    const after = scene([n('new')], [e('fresh', 'new', 'new')])
    expect(diffToMutations(before, after).map((m) => m.op)).toEqual([
      'upsert',
      'edge-upsert',
      'edge-remove',
      'remove'
    ])
  })
})

// Kanban ops ride canvas:mut too (@shared/kanban-ops). The guard is `sanitizeKanbanOp`'s verdict —
// one set of shape rules, not a second copy here — plus the same byte cap every mutation has.
describe('isCanvasMutation — kanban ops', () => {
  it('accepts a well-formed kanban op of every kind', () => {
    const ok: unknown[] = [
      { op: 'kb-column', column: { id: 'c1', title: 'To Do', color: '#fff' } },
      { op: 'kb-column-remove', id: 'c1' },
      { op: 'kb-column-order', ids: ['c1', 'c2'] },
      { op: 'kb-card', assignment: { nodeId: 'n1', columnId: 'c1' } },
      { op: 'kb-card-remove', nodeId: 'n1' },
      { op: 'kb-meta', meta: { nodeId: 'n1', priority: 'high' } },
      { op: 'kb-meta-remove', nodeId: 'n1' },
      { op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'red' } },
      { op: 'kb-label-remove', id: 'l1' },
      { op: 'kb-label-order', ids: ['l1'] },
      { op: 'kb-view', view: { id: 'v1', name: 'Mine', query: {} } },
      { op: 'kb-view-remove', id: 'v1' }
    ]
    for (const m of ok) expect(isCanvasMutation(m), JSON.stringify(m)).toBe(true)
  })

  it('refuses what sanitizeKanbanOp refuses — an unknown kb- op, a bad id, a control character', () => {
    expect(isCanvasMutation({ op: 'kb-nope' })).toBe(false)
    expect(isCanvasMutation({ op: 'kb-card-remove', nodeId: '' })).toBe(false)
    expect(isCanvasMutation({ op: 'kb-column-remove', id: 'x'.repeat(129) })).toBe(false)
    expect(isCanvasMutation({ op: 'kb-label', label: { id: 'l1', name: 'a\u0007b', color: 'red' } })).toBe(false)
  })

  it('accepts a repairable op (the repair is sanitizeCanvasMutation\'s job, not a refusal)', () => {
    expect(isCanvasMutation({ op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'neon' } })).toBe(true)
  })

  it('bounds a kanban op by the same byte cap', () => {
    const big = { op: 'kb-card', assignment: { nodeId: 'n1', columnId: 'c1' }, pad: 'x'.repeat(MUTATION_MAX_BYTES) }
    expect(isCanvasMutation(big)).toBe(false)
  })
})

describe('sanitizeCanvasMutation', () => {
  it('repairs a kanban op and keeps its stamp fields', () => {
    const raw = { op: 'kb-label', label: { id: 'l1', name: ' Bug ', color: 'neon', junk: 1 }, src: 'cv-a', seq: 4, seen: 3 } as unknown as CanvasMutation
    expect(sanitizeCanvasMutation(raw)).toEqual({
      op: 'kb-label',
      label: { id: 'l1', name: 'Bug', color: 'default' },
      src: 'cv-a',
      seq: 4,
      seen: 3
    })
  })

  it('refuses (null) a kanban op sanitizeKanbanOp refuses', () => {
    expect(sanitizeCanvasMutation({ op: 'kb-card-remove', nodeId: '' })).toBeNull()
  })

  it('strips the exec-enabling fields off a node upsert, and passes other ops through', () => {
    const withShell = { op: 'upsert', node: { ...n('1'), shell: '/bin/evil' } } as CanvasMutation
    const out = sanitizeCanvasMutation(withShell) as Extract<CanvasMutation, { op: 'upsert' }>
    expect(out.node.shell).toBeUndefined()
    const rm: CanvasMutation = { op: 'remove', id: '1', src: 'a' }
    expect(sanitizeCanvasMutation(rm)).toBe(rm)
  })
})

describe('applyCanvasMutation with a kanban op', () => {
  it('leaves the node list untouched, by reference (a kanban op addresses the board, not a node)', () => {
    const a = [n('1')]
    expect(applyCanvasMutation(a, { op: 'kb-card', assignment: { nodeId: '1', columnId: 'c' } })).toBe(a)
    expect(applyCanvasMutation(a, { op: 'kb-card-remove', nodeId: '1' })).toBe(a)
  })
})
