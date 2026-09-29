import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createCanvasPublisher,
  isEphemeralNodeId,
  publishableStates,
  PUBLISH_INTERVAL_MS,
  publishableScene
} from './canvas-publish'
import { mutationNodeId } from './canvas-order'
import type { BridgeLink, CanvasMutation, CanvasNodeState } from './types'

const node = (id: string, x = 0): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title: 't',
    color: '#fff',
    position: { x, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNodeState

function collect() {
  const sent: CanvasMutation[] = []
  return {
    sent,
    send: (m: CanvasMutation): void => void sent.push(m) // void: `send` returning false means REFUSED
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createCanvasPublisher', () => {
  it('publishes the diff against the last snapshot (add, move, remove)', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')])
    p.publish([node('a', 5)])
    p.publish([])
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a') },
      { op: 'upsert', node: node('a', 5) },
      { op: 'remove', id: 'a' }
    ])
  })

  it('publishes nothing when the snapshot is unchanged', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')])
    p.publish([node('a')])
    expect(c.sent).toHaveLength(1)
  })

  it('throttles drag frames to ~20 Hz: leading send, one trailing send per interval', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    // 5 drag frames inside one interval → 1 leading send, the rest coalesced.
    for (let x = 1; x <= 5; x++) p.publish([node('a', x)], { throttle: true })
    expect(c.sent).toEqual([{ op: 'upsert', node: node('a', 1) }])
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS)
    // The trailing send carries the LATEST position, not the intermediate ones.
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a', 1) },
      { op: 'upsert', node: node('a', 5) }
    ])
  })

  it('an unthrottled publish (drag settle) sends immediately and cancels the pending frame', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 1)], { throttle: true })
    p.publish([node('a', 2)], { throttle: true })
    p.publish([node('a', 9)]) // settle
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 4)
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a', 1) },
      { op: 'upsert', node: node('a', 9) }
    ])
  })

  it('flush() sends a coalesced drag frame right away', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 1)], { throttle: true })
    p.publish([node('a', 2)], { throttle: true })
    p.flush()
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a', 1) },
      { op: 'upsert', node: node('a', 2) }
    ])
  })

  // THE LOOP GUARD: a snapshot that arrived FROM a peer is adopted, never re-published.
  it('adopt() takes a snapshot as baseline without sending — no infinite echo', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')])
    c.sent.length = 0
    // A peer's mutation lands: Canvas applies it and adopts the result.
    const afterPeer = [node('a'), node('b', 3)]
    p.adopt(afterPeer)
    expect(c.sent).toEqual([])
    // The React effect then fires with exactly that snapshot → the diff is empty → nothing is sent.
    p.publish(afterPeer)
    expect(c.sent).toEqual([])
    // A genuinely local change afterwards still publishes (and only the delta).
    p.publish([node('a'), node('b', 8)])
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 8) }])
  })

  it('dispose() drops a pending drag frame', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 1)], { throttle: true })
    p.publish([node('a', 2)], { throttle: true })
    p.dispose()
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 4)
    expect(c.sent).toEqual([{ op: 'upsert', node: node('a', 1) }])
  })
})

// A cast the reflector would REFUSE (an oversized sticky; a cast with no project active) must not
// be counted as published: it never reaches a peer, and nothing else would ever re-emit it.
describe('a refused cast (send → false)', () => {
  /** Refuses every mutation touching `bad`, records everything it was asked to send. */
  function gate(bad: string) {
    const tried: CanvasMutation[] = []
    const sent: CanvasMutation[] = []
    const send = (m: CanvasMutation): boolean => {
      tried.push(m)
      const id = mutationNodeId(m)
      if (id === bad) return false
      sent.push(m)
      return true
    }
    return { tried, sent, send }
  }

  it('is retried on the next publish (the baseline does not advance over it)', () => {
    const c = gate('a')
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 5)]) // refused: the peers never see it
    expect(c.sent).toEqual([])
    p.publish([node('a', 5)]) // the same snapshot again → still owed, so it is re-emitted
    expect(c.tried).toHaveLength(2)
  })

  it('syncs the moment the edit becomes castable again (the user trims the sticky)', () => {
    let bad = 'a'
    const sent: CanvasMutation[] = []
    const p = createCanvasPublisher((m) => {
      const id = mutationNodeId(m)
      if (id === bad) return false
      sent.push(m)
      return true
    })
    p.adopt([node('a')])
    p.publish([node('a', 5)]) // oversized → refused
    expect(sent).toEqual([])
    bad = '' // trimmed: it fits now
    p.publish([node('a', 6)])
    expect(sent).toEqual([{ op: 'upsert', node: node('a', 6) }]) // …and it carries the LIVE value
  })

  it('does not hold up the other nodes in the same snapshot', () => {
    const c = gate('a')
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a'), node('b')])
    p.publish([node('a', 5), node('b', 5)])
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 5) }])
    p.publish([node('a', 5), node('b', 5)])
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 5) }]) // b was cast: not re-sent
  })

  it('re-emits a refused ADD as an add, and a refused REMOVE as a remove', () => {
    const c = gate('a')
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')]) // an ADD, refused → not in the baseline
    p.publish([node('a')])
    expect(c.tried).toEqual([
      { op: 'upsert', node: node('a') },
      { op: 'upsert', node: node('a') }
    ])

    const d = gate('z')
    const q = createCanvasPublisher(d.send)
    q.adopt([node('z')])
    q.publish([]) // a REMOVE, refused → the node stays in the baseline
    q.publish([])
    expect(d.tried).toEqual([
      { op: 'remove', id: 'z' },
      { op: 'remove', id: 'z' }
    ])
  })
})

describe('src (the sender tag)', () => {
  // The reflector echoes a mutation back to its sender too — that echo is the ack that carries the
  // total order. `src` is how the sender recognizes it as its own rather than re-applying it.
  it('stamps every emitted mutation with the publisher tag', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send, { src: 'cv-1' })
    p.publish([node('a')])
    p.publish([])
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a'), src: 'cv-1' },
      { op: 'remove', id: 'a', src: 'cv-1' }
    ])
  })
})

// A solo user must not pay for team sync: diffing stableStringifies every node twice (~1.4 ms at
// 100 nodes) and the `nodes` array changes at 60 Hz during a drag, all to cast into a void.
describe('shouldPublish (the solo gate)', () => {
  it('publishes nothing while no peer is attached', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send, { shouldPublish: () => false })
    p.publish([node('a')])
    p.publish([node('a', 5)], { throttle: true })
    p.flush()
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 4)
    expect(c.sent).toEqual([])
  })

  it('does not even arm the drag throttle timer while solo', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send, { shouldPublish: () => false })
    p.publish([node('a')], { throttle: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the baseline still tracks the canvas: the first edit after a peer joins diffs correctly', () => {
    const c = collect()
    let peers = false
    const p = createCanvasPublisher(c.send, { shouldPublish: () => peers })
    p.publish([node('a'), node('b')]) // solo: nothing sent…
    p.publish([node('a', 7), node('b')]) // …and edits keep updating the baseline
    expect(c.sent).toEqual([])

    peers = true // a teammate opens the canvas
    p.publish([node('a', 7), node('b', 3)])
    // ONLY the node that actually changed — no whole-canvas replay, no stale re-send of `a`.
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 3) }])
  })
})

// The gate above only skips the DIFF; serializing the canvas to hand it over is the other half of
// the cost, and it happens in a React effect keyed on the nodes array — once per drag frame. A
// thunk snapshot moves that cost behind the gate too.
describe('lazy snapshots', () => {
  it('never resolves the snapshot while solo — not even to keep the baseline', () => {
    const c = collect()
    const snapshot = vi.fn(() => [node('a')])
    const p = createCanvasPublisher(c.send, { shouldPublish: () => false })
    p.publish(snapshot)
    p.publish(snapshot, { throttle: true })
    p.adopt(snapshot)
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 4)
    expect(snapshot).not.toHaveBeenCalled()
    expect(c.sent).toEqual([])
  })

  it('resolves a deferred baseline once when a peer arrives, and diffs against it', () => {
    const c = collect()
    let peers = false
    const p = createCanvasPublisher(c.send, { shouldPublish: () => peers })
    const solo = vi.fn(() => [node('a'), node('b')])
    p.publish(solo)
    expect(solo).not.toHaveBeenCalled()

    peers = true
    p.publish(() => [node('a'), node('b', 3)])
    // The deferred baseline was resolved exactly once, and only the changed node was cast — the
    // same result the eager path produced.
    expect(solo).toHaveBeenCalledTimes(1)
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 3) }])

    // …and it is not resolved again on the next edit (the baseline is now the resolved snapshot).
    p.publish(() => [node('a'), node('b', 3)])
    expect(solo).toHaveBeenCalledTimes(1)
  })

  it('resolves a coalesced drag frame once, at the trailing edge', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')])
    const frames = [1, 2, 3].map((x) => vi.fn(() => [node('a', x)]))
    for (const f of frames) p.publish(f, { throttle: true })
    // Leading edge took the first frame; the other two coalesced into one trailing send, so the
    // frame in the middle is never serialized at all.
    expect(frames[0]).toHaveBeenCalledTimes(1)
    expect(frames[1]).not.toHaveBeenCalled()
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS)
    expect(frames[1]).not.toHaveBeenCalled()
    expect(frames[2]).toHaveBeenCalledTimes(1)
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a') }, // the initial publish, before the drag
      { op: 'upsert', node: node('a', 1) },
      { op: 'upsert', node: node('a', 3) }
    ])
  })

  it('an adopted thunk is a real baseline: the next identical snapshot diffs to nothing', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt(() => [node('a'), node('b')]) // a peer's mutation applied locally
    p.publish(() => [node('a'), node('b')])
    expect(c.sent).toEqual([])
  })
})

describe('ephemeral nodes are never published', () => {
  it('isEphemeralNodeId matches subagent cards (by id set) and loop cards (by prefix)', () => {
    const eph = new Set(['sub-123'])
    expect(isEphemeralNodeId('sub-123', eph)).toBe(true)
    expect(isEphemeralNodeId('loop-n1', eph)).toBe(true)
    expect(isEphemeralNodeId('n1', eph)).toBe(false)
  })

  it('publishableStates strips them, so no mutation is ever emitted for one', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    const eph = new Set(['sub-123'])
    const states = [node('n1'), node('sub-123'), node('loop-n1')]
    expect(publishableStates(states, eph).map((n) => n.id)).toEqual(['n1'])
    p.publish(publishableStates(states, eph))
    expect(c.sent).toEqual([{ op: 'upsert', node: node('n1') }])
    // Moving an ephemeral card produces NO mutation at all.
    const moved = [node('n1'), node('sub-123', 99), node('loop-n1', 99)]
    p.publish(publishableStates(moved, eph))
    expect(c.sent).toHaveLength(1)
  })
})

describe('publishableScene', () => {
  const link = (id: string, source: string, target: string) => ({ id, source, target })

  it('carries the nodes and both edge lists', () => {
    const scene = {
      nodes: [node('a'), node('b')],
      bridges: [link('e1', 'a', 'b')],
      ropes: [link('ctrl-1', 'a', 'b')]
    }
    const out = publishableScene(scene, new Set())
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(out.bridges).toEqual(scene.bridges)
    expect(out.ropes).toEqual(scene.ropes)
  })

  // The edge half of the ephemeral rule. A subagent / loop card is DERIVED per client from the
  // agent:status stream, so an edge naming one addresses a node with a different lifetime on the
  // peer — it would be pruned there at a moment we do not control and re-published back at us.
  it('drops an edge whose endpoint is an ephemeral card', () => {
    const scene = {
      nodes: [node('a'), node('sub-1'), node('loop-a')],
      bridges: [link('e1', 'a', 'sub-1'), link('e2', 'a', 'a')],
      ropes: [link('ctrl-1', 'loop-a', 'a')]
    }
    const out = publishableScene(scene, new Set(['sub-1']))
    expect(out.nodes.map((n) => n.id)).toEqual(['a'])
    expect(out.bridges).toEqual([link('e2', 'a', 'a')])
    expect(out.ropes).toEqual([])
  })

  it('drops an edge whose endpoint is not on the canvas at all (a dangling link)', () => {
    const out = publishableScene(
      { nodes: [node('a')], bridges: [link('e1', 'a', 'ghost')], ropes: [] },
      new Set()
    )
    expect(out.bridges).toEqual([])
  })
})

// ── Edges and the lazy baseline ──────────────────────────────────────────────────────────────────
// `adopt` keeps a thunk UNRESOLVED until the next emit. Canvas's thunk used to read the edge refs
// when it RAN — so after a peer op (or a project load) the baseline, resolved at the next publish,
// already held the link the user had just drawn: the diff was empty, nothing was cast, and the
// teammate's next whole-file save deleted the link. The thunk must close over the edges AS OF THE
// CALL (CanvasSnapshot's contract); this pins the publisher side of that contract.
describe('edges in a lazy baseline', () => {
  it('a link drawn right after an adopt is cast (the baseline thunk captured the edges eagerly)', () => {
    const sent: CanvasMutation[] = []
    const pub = createCanvasPublisher((m) => { sent.push(m) }, { src: 'a' })
    const n1 = { id: 'n1', kind: 'terminal', position: { x: 0, y: 0 } } as CanvasNodeState
    const n2 = { id: 'n2', kind: 'terminal', position: { x: 1, y: 0 } } as CanvasNodeState
    let bridges: BridgeLink[] = []
    // What Canvas does: a snapshot thunk that closes over the arrays AS OF THE CALL.
    const snapshot = () => {
      const b = bridges
      return () => ({ nodes: [n1, n2], bridges: b, ropes: [] })
    }
    pub.adopt(snapshot())                  // a peer op landed → lazy baseline
    bridges = [{ id: 'bridge-n1-n2', source: 'n1', target: 'n2' }]
    pub.publish(snapshot())
    expect(sent).toEqual([
      expect.objectContaining({ op: 'edge-upsert', kind: 'bridge', edge: { id: 'bridge-n1-n2', source: 'n1', target: 'n2' } })
    ])
  })
})

// A node the guard refuses (an oversized sticky) never reaches the peer. An edge to it that DID go
// out would name a node the peer does not have; the peer's link-prune effect then drops it and casts
// an `edge-remove` — deleting the link on OUR canvas too. So an edge-upsert waits for its endpoints.
describe('an edge to a refused node', () => {
  const link = (id: string, source: string, target: string): BridgeLink => ({ id, source, target })
  const scene = (nodes: CanvasNodeState[], bridges: BridgeLink[] = [], ropes: BridgeLink[] = []) => ({
    nodes,
    bridges,
    ropes
  })
  /** Refuses every node op for the ids in `bad`; records what was actually cast. */
  function refusing(bad: Set<string>) {
    const sent: CanvasMutation[] = []
    const send = (m: CanvasMutation): boolean => {
      const id = mutationNodeId(m)
      if (id !== null && bad.has(id)) return false
      sent.push(m)
      return true
    }
    return { sent, send }
  }

  it('is not cast in the same emit that refused its endpoint', () => {
    const c = refusing(new Set(['big']))
    const p = createCanvasPublisher(c.send)
    p.publish(scene([node('big'), node('t')], [link('b1', 'big', 't')], [link('ctrl-1', 't', 'big')]))
    expect(c.sent).toEqual([{ op: 'upsert', node: node('t') }])
    expect(p.refusedNodeIds()).toEqual(new Set(['big']))
  })

  it('follows its endpoint the moment the endpoint casts — in the same batch, after it', () => {
    const bad = new Set(['big'])
    const c = refusing(bad)
    const p = createCanvasPublisher(c.send)
    p.publish(scene([node('big'), node('t')], [link('b1', 'big', 't')]))
    bad.clear() // the user trimmed the sticky
    p.publish(scene([node('big', 1), node('t')], [link('b1', 'big', 't')]))
    expect(c.sent.slice(1)).toEqual([
      { op: 'upsert', node: node('big', 1) },
      { op: 'edge-upsert', kind: 'bridge', edge: link('b1', 'big', 't') }
    ])
    expect(p.refusedNodeIds().size).toBe(0)
  })

  // Why the hold lives INSIDE the publisher rather than as a filter on the scene it is handed: a
  // filtered-out edge that the baseline already holds diffs as an `edge-remove` — the exact delete
  // this exists to prevent, cast by us instead of by the peer.
  it('never removes an edge the peer already has when its endpoint later becomes unsendable', () => {
    const bad = new Set<string>()
    const c = refusing(bad)
    const p = createCanvasPublisher(c.send)
    p.publish(scene([node('n'), node('t')], [link('b1', 'n', 't')]))
    const cast = c.sent.length
    bad.add('n') // n's next edit is too large
    p.publish(scene([node('n', 9), node('t')], [link('b1', 'n', 't')]))
    p.publish(scene([node('n', 9), node('t')], [link('b1', 'n', 't')]))
    expect(c.sent.slice(cast)).toEqual([])
  })

  it('stays held across an adopt that took the refused node into the baseline', () => {
    const c = refusing(new Set(['big']))
    const p = createCanvasPublisher(c.send)
    p.publish(scene([node('big'), node('t')]))
    p.adopt(scene([node('big'), node('t')])) // a peer op landed: the baseline now holds `big`
    p.publish(scene([node('big'), node('t')], [link('b1', 'big', 't')]))
    expect(c.sent.filter((m) => m.op === 'edge-upsert')).toEqual([])
    expect(p.refusedNodeIds()).toEqual(new Set(['big']))
  })

  it('forgets a refused node once it is gone from the canvas', () => {
    const c = refusing(new Set(['big']))
    const p = createCanvasPublisher(c.send)
    p.publish(scene([node('big'), node('t')]))
    p.publish(scene([node('t')])) // the user deleted it before it ever synced
    expect(p.refusedNodeIds().size).toBe(0)
  })
})
