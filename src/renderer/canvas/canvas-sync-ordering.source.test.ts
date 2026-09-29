// Source pins for the ordering hardening of canvas sync (Task 3). Canvas.tsx cannot be rendered in
// the node test environment, so the load-bearing SHAPES are pinned here; the behaviour behind each is
// tested where it lives (canvas-order.test.ts, canvas-publish.test.ts,
// canvas-sync.convergence.test.ts, nodesEpoch.test.tsx).
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The publisher's send callback, from its creation to the cast. */
function sendCallback(): string {
  const start = src.indexOf('const pub = createCanvasPublisher(')
  return src.slice(start, src.indexOf('activeSession.api.canvas.mutate(projectId, stamped)', start))
}

/** The peer-mutation receive handler. */
function receiveHandler(): string {
  const start = src.indexOf('return activeSession.api.canvas.onMutation((projectId, mutation) => {')
  return src.slice(start, src.indexOf('}, [activeSession.api, setNodes, setLinkEdges', start))
}

describe('the re-creation gate (canvas-order hasPendingRemove)', () => {
  // A re-creation cast before our own remove's echo carries a `seen` below that remove, and every
  // peer drops it as a stale frame (rule 4) while we keep showing it.
  it('the send callback holds a non-remove op whose key has our remove in flight', () => {
    const body = sendCallback()
    const gate = body.indexOf('if (!isRemoveOp(stamped) && order.hasPendingRemove(mutationKey(stamped))) return false')
    expect(gate).toBeGreaterThan(-1)
    // …before anything records or casts it: a held op must not leave a pending entry behind.
    expect(gate).toBeLessThan(body.indexOf('order.onLocal(stamped)'))
  })

  // Held = owed, but nothing re-publishes on its own: our echo is an ack, it changes no React state,
  // so the [nodes] publish effect never runs. The release has to publish.
  it('our own remove coming back releases what the gate held', () => {
    const body = receiveHandler()
    const held = body.indexOf('const held = order.hasPendingRemove(key)')
    const accept = body.indexOf('order.accept(mutation)')
    expect(held).toBeGreaterThan(-1)
    expect(held).toBeLessThan(accept) // asked BEFORE the ack draws the count down
    expect(body).toMatch(/const released = held && !order\.hasPendingRemove\(key\)/)
    expect(body).toMatch(/if \(released\) queueMicrotask\(releaseHeld\)/)
  })

  it('the release publishes only when something is owed, and never during a load', () => {
    const start = src.indexOf('const releaseHeld = (): void => {')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n    }', start))
    expect(body).toMatch(/!pub\.hasOwed\(\)/)
    expect(body).toMatch(/loadingRef\.current/)
    expect(body).toMatch(/pub\.publish\(publishableLater\(nodesRef\.current\)\)/)
  })
})
