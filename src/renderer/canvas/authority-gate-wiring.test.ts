// Source pins for the canvas-authority half of the publish gate (docs/hosted-team-relay.md). Canvas.tsx
// cannot be rendered in the node test environment, so the load-bearing SHAPES are pinned here; the
// behaviour behind them is collab-sync.test.ts (the rule), the bridge tests (who answers `governed`)
// and canvas-sync.convergence.test.ts (a solo edit on a governed project reaches the authority).
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
const canvas = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function between(src: string, start: string, end: string): string {
  const i = src.indexOf(start)
  expect(i, `missing: ${start}`).toBeGreaterThan(-1)
  const j = src.indexOf(end, i + start.length)
  return src.slice(i, j === -1 ? undefined : j)
}

describe('the publish gate hears the canvas authority', () => {
  it('the ONE gate opens for a peer OR a governed project, the peer check still first', () => {
    const gate = between(canvas, 'const shouldPublishFor = (projectId: string): boolean =>', 'const pub = createCanvasPublisher(')
    expect(gate).toContain('(hasPeersRef.current || governedRef.current.has(projectId))')
    expect(gate.indexOf('hasPeersRef.current')).toBeLessThan(gate.indexOf('governedRef.current'))
    // The two other halves are unchanged: the same core, and never a hosted viewer/commenter.
    expect(gate).toContain('sessionForProject(projectId).api === activeSession.api')
    expect(gate).toContain('!isHostedReadOnly(activeSession.id)')
  })

  it('the governed set is read from the ACTIVE core, reset on every re-bind, and kept current', () => {
    const effect = between(canvas, 'const order = createCanvasOrder(src)', 'orderRef.current = null')
    // Per core, like `hasPeersRef`: a relay tab's governed projects must not leak onto a local tab.
    expect(effect).toContain('governedRef.current = new Set()')
    // `followGoverned` (collab-sync.test.ts) asks the core and follows its changes.
    expect(effect).toContain('const offGoverned = followGoverned(activeSession.api, (ids) => {')
    expect(effect).toContain('governedRef.current = ids')
    // The subscription is released with the effect.
    expect(effect).toMatch(/offGoverned\(\)/)
  })
})
