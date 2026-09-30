// N2: a node or edge THIS renderer writes into a project that is not on screen (⌘⇧T / "Recently
// closed" reopen, a cold open, an off-canvas display node, a headless start's launch patch) goes
// through the projects store, never React Flow — so the node publisher never casts it, and on a
// governed project the canvas authority's save overlay dropped it from disk. The store now hands
// every such write to one hook, and Canvas casts it through the same gate as everything else.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { setStoredCanvasPublishHook, useProjects } from '../state/projects'
import { createStoredCanvasPublisher } from './stored-publish'
import { applyCanvasOp, contentOf } from '@shared/canvas-content'
import { sanitizeInboundMutation } from '@shared/node-exec'
import type { CanvasMutation, CanvasNodeState, Project } from '@shared/types'

const node = (id: string, x = 0, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x, y: 0 },
  size: { width: 480, height: 320 },
  title: id,
  color: '#fff',
  group: '',
  ...over
})

const project = (id: string, nodes: CanvasNodeState[]): Project => ({
  id,
  name: id,
  color: '#0a84ff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes
})

interface Wiring {
  casts: Array<[string, CanvasMutation]>
  rendered: string | null
  governed: Set<string>
  gateOpen: boolean
}

function wire(): Wiring {
  const w: Wiring = { casts: [], rendered: 'A', governed: new Set(['G']), gateOpen: true }
  setStoredCanvasPublishHook(
    createStoredCanvasPublisher({
      renderedProjectId: () => w.rendered,
      isGoverned: (id) => w.governed.has(id),
      shouldPublish: () => w.gateOpen,
      send: (id, m) => {
        w.casts.push([id, m])
        return true
      }
    })
  )
  return w
}

beforeEach(() => {
  useProjects.getState().hydrate({
    version: 2,
    activeProjectId: 'A',
    projects: [project('A', [node('a1')]), project('G', [node('g1')]), project('U', [node('u1')])]
  })
})

afterEach(() => {
  setStoredCanvasPublishHook(null)
})

describe('own writes into a stored project are cast (N2)', () => {
  it('a reopen into an off-screen GOVERNED project casts the upsert, and the authority holds it', () => {
    const w = wire()
    // What ⌘⇧T's `insertStored` does for a project that is not on screen.
    const reopened = node('g2', 300, { pendingLaunch: { after: [], command: 'claude' } })
    useProjects.getState().applyOwnNodeMutation('G', { op: 'upsert', node: reopened })
    expect(w.casts).toEqual([['G', { op: 'upsert', node: reopened }]])

    // The authority hears the cast (the reflector hands it on without the launch) and folds it into
    // its content through the one reducer, so its save overlay now carries the node instead of
    // dropping it (the core half is pinned in canvas-authority.test.ts).
    let authority = contentOf(project('G', [node('g1')]))
    for (const [id, m] of w.casts) authority = applyCanvasOp(authority, sanitizeInboundMutation(m), id)
    expect(authority.nodes.map((n) => n.id)).toEqual(['g1', 'g2'])
    expect(authority.nodes.find((n) => n.id === 'g2')?.pendingLaunch).toBeUndefined()
  })

  it('a link appended to an off-screen governed project casts each NEW edge once', () => {
    const w = wire()
    const rope = { id: 'ctrl-a1-g1', source: 'a1', target: 'g1' }
    const bridge = { id: 'bridge-g1-a1', source: 'g1', target: 'a1' }
    useProjects.getState().appendCanvasLinks('G', { ropes: [rope], bridges: [bridge] })
    expect(w.casts).toEqual([
      ['G', { op: 'edge-upsert', kind: 'bridge', edge: bridge }],
      ['G', { op: 'edge-upsert', kind: 'rope', edge: rope }]
    ])
    // A re-link is a no-op in the store, and casts nothing.
    useProjects.getState().appendCanvasLinks('G', { ropes: [rope], bridges: [{ ...bridge, id: 'other-id' }] })
    expect(w.casts).toHaveLength(2)
  })

  it('casts nothing where the gate is off: an unshared project, the rendered one, a closed gate', () => {
    const w = wire()
    // Unshared, even with a teammate attached (the gate itself open): byte-identical to before.
    useProjects.getState().applyOwnNodeMutation('U', { op: 'upsert', node: node('u2') })
    useProjects.getState().appendCanvasLinks('U', { ropes: [{ id: 'r', source: 'u1', target: 'u2' }] })
    // The project React Flow holds belongs to the node publisher.
    w.governed.add('A')
    useProjects.getState().applyOwnNodeMutation('A', { op: 'upsert', node: node('a2') })
    // The publish gate closed (a viewer, another core, or nobody to publish to).
    w.gateOpen = false
    useProjects.getState().applyOwnNodeMutation('G', { op: 'upsert', node: node('g3') })
    expect(w.casts).toEqual([])
    // The store writes themselves are unchanged.
    expect(useProjects.getState().getProject('U')?.nodes.map((n) => n.id)).toEqual(['u1', 'u2'])
    expect(useProjects.getState().getProject('G')?.nodes.map((n) => n.id)).toEqual(['g1', 'g3'])
  })

  it('with no hook registered (no Canvas bound), a store write casts nothing and still applies', () => {
    useProjects.getState().applyOwnNodeMutation('G', { op: 'upsert', node: node('g4') })
    expect(useProjects.getState().getProject('G')?.nodes.map((n) => n.id)).toEqual(['g1', 'g4'])
  })

  it('Canvas registers the hook in the publisher effect, behind its gate, and clears it on teardown', () => {
    const src = fs.readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const wiring = src.indexOf('setStoredCanvasPublishHook(\n      createStoredCanvasPublisher(')
    expect(wiring).toBeGreaterThan(-1)
    const body = src.slice(wiring, wiring + 900)
    expect(body).toMatch(/send: \(projectId, m\) => castFor\(projectId, m\)/)
    expect(body).toMatch(/shouldPublish: \(projectId\) => shouldPublishFor\(projectId\)/)
    expect(body).toMatch(/isGoverned: \(projectId\) => governedRef\.current\.has\(projectId\)/)
    expect(body).toMatch(/renderedProjectId: \(\) => nodesProjectIdRef\.current/)
    expect(src).toContain('setStoredCanvasPublishHook(null)')
  })
})
