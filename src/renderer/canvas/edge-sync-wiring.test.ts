// Source pins for the edge half of canvas sync (port of feat/team-sync-gaps 7bcf4e3e, with the
// fixes the port found). Canvas.tsx cannot be rendered in the node test environment, so the
// load-bearing SHAPES are pinned here; the behaviour behind each one is tested where it lives
// (canvas-publish.test.ts, canvas-mutations.test.ts, canvas-sync.convergence.test.ts).
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
describe('edge publish thunk', () => {
  // The publisher resolves an adopted thunk LATE (on the next publish). A thunk that read
  // linkEdgesRef/controlEdgesRef when it ran saw the link the user had drawn since, so the diff was
  // empty and the link was never cast — the teammate's next save then deleted it.
  it('captures the edge arrays when the thunk is CREATED, not when it runs', () => {
    const body = src.slice(src.indexOf('const publishableLater'), src.indexOf('const publishableLater') + 1200)
    expect(body).toMatch(/const bridges = [^\n]*linkEdges/)
    expect(body).not.toMatch(/=>\s*publishableScene\([\s\S]*linkEdgesRef\.current/)
  })
})

describe('edge refs on project load and server change', () => {
  // setLinkEdges/setControlEdges land on a LATER render. A peer's edge op arriving in between was
  // built from the PREVIOUS project's edges and then overwrote the load's queued value.
  it('the load effect sets the edge refs synchronously', () => {
    const load = src.slice(src.indexOf('installEpoch(project.id'), src.indexOf('installEpoch(project.id') + 4000)
    expect(load).toMatch(/linkEdgesRef\.current = /)
    expect(load).toMatch(/controlEdgesRef\.current = /)
  })

  it('the server-change path sets the edge refs synchronously', () => {
    const start = src.indexOf('api.workspace.onServerChange(')
    const body = src.slice(start, src.indexOf('bumpDirty()', start))
    expect(body).toMatch(/controlEdgesRef\.current = /)
    expect(body).toMatch(/linkEdgesRef\.current = /)
  })
})

describe('edge ref render-time mirror', () => {
  // A zustand write re-renders Canvas on the SyncLane, which SKIPS a pending DefaultLane
  // setLinkEdges/setControlEdges (see nodesEpoch.ts). An unconditional `ref = state` mirror in that
  // render put the previous project's edges back into the ref right after the load effect had
  // assigned the new ones — reopening the window the synchronous assignment closes.
  it('mirrors the edge state into the ref only when the state changed', () => {
    expect(src).toMatch(/if \(linkEdgesMirroredRef\.current !== linkEdges\) \{\n\s*linkEdgesMirroredRef\.current = linkEdges\n\s*linkEdgesRef\.current = linkEdges/)
    expect(src).toMatch(/if \(controlEdgesMirroredRef\.current !== controlEdges\) \{\n\s*controlEdgesMirroredRef\.current = controlEdges\n\s*controlEdgesRef\.current = controlEdges/)
    expect(src).not.toMatch(/^ {2}linkEdgesRef\.current = linkEdges$/m)
    expect(src).not.toMatch(/^ {2}controlEdgesRef\.current = controlEdges$/m)
  })
})

describe('the guard refusal message', () => {
  // Only a node upsert can be too large (a sticky's body is the one unbounded field). An edge op is
  // refused only for a malformed / over-long id, and "this note is too large" would name a cause
  // nobody measured.
  it('names the note size only for a node upsert', () => {
    expect(src).toMatch(/stamped\.op === 'upsert'\) setSyncNote/)
  })
})
