import { describe, it, expect, beforeEach } from 'vitest'
import { useProjects } from './projects'
import type { CanvasNodeState } from '@shared/types'

const node = (id: string, x = 0): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x, y: 0 },
  size: { width: 480, height: 320 },
  title: id,
  color: '#fff',
  group: ''
})

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
})

/** A peer's mutation for a project that is loaded but NOT the active canvas. React Flow only
 *  holds the ACTIVE project's nodes, so the mutation has to land in the serialized copy the
 *  projects store keeps — otherwise the next whole-file workspace.save writes back a stale
 *  canvas (resurrecting a node the peer deleted), which is the exact bug Stage 3 exists to kill. */
describe('applyNodeMutation', () => {
  it('upserts a node into a background project and reports it applied', () => {
    const p = useProjects.getState().addProject('p', '/tmp/p')
    useProjects.getState().commitCanvas(p.id, [node('a')], { x: 0, y: 0, zoom: 1 })

    const applied = useProjects.getState().applyNodeMutation(p.id, {
      op: 'upsert',
      node: node('b', 100)
    })

    expect(applied).toBe(true)
    expect(useProjects.getState().getProject(p.id)?.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('replaces an existing node (a peer moved / renamed it)', () => {
    const p = useProjects.getState().addProject('p')
    useProjects.getState().commitCanvas(p.id, [node('a'), node('b')], { x: 0, y: 0, zoom: 1 })

    useProjects.getState().applyNodeMutation(p.id, { op: 'upsert', node: node('a', 999) })

    const nodes = useProjects.getState().getProject(p.id)?.nodes ?? []
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(nodes[0].position.x).toBe(999)
  })

  it('removes a node a peer deleted, so the next whole-file save cannot resurrect it', () => {
    const p = useProjects.getState().addProject('p')
    useProjects.getState().commitCanvas(p.id, [node('a'), node('b')], { x: 0, y: 0, zoom: 1 })

    useProjects.getState().applyNodeMutation(p.id, { op: 'remove', id: 'a' })

    expect(useProjects.getState().getProject(p.id)?.nodes.map((n) => n.id)).toEqual(['b'])
    expect(useProjects.getState().toWorkspace().projects[0].nodes.map((n) => n.id)).toEqual(['b'])
  })

  it('leaves other projects untouched', () => {
    const a = useProjects.getState().addProject('a')
    const b = useProjects.getState().addProject('b')
    useProjects.getState().commitCanvas(a.id, [node('n1')], { x: 0, y: 0, zoom: 1 })
    useProjects.getState().commitCanvas(b.id, [node('n2')], { x: 0, y: 0, zoom: 1 })

    useProjects.getState().applyNodeMutation(a.id, { op: 'remove', id: 'n1' })

    expect(useProjects.getState().getProject(b.id)?.nodes.map((n) => n.id)).toEqual(['n2'])
  })

  // A mutation for a project this client does not have (a peer opened a folder we never did):
  // nothing to apply, and we must NOT invent a project — report it so the caller can skip the
  // dirty flag rather than scheduling a pointless save.
  it('reports false for an unknown project and creates nothing', () => {
    const applied = useProjects.getState().applyNodeMutation('nope', { op: 'remove', id: 'x' })
    expect(applied).toBe(false)
    expect(useProjects.getState().projects).toHaveLength(0)
  })
})

/** The edge twin of applyNodeMutation: a background project's serialized edges are what our next
 *  whole-file save writes, so a peer's edge op for it must land there. */
describe('applyEdgeMutation', () => {
  const link = (id: string, source = 'a', target = 'b') => ({ id, source, target })

  it('reports false for an unknown project and creates nothing', () => {
    expect(useProjects.getState().applyEdgeMutation('nope', { op: 'edge-remove', kind: 'bridge', id: 'x' })).toBe(false)
    expect(useProjects.getState().projects).toHaveLength(0)
  })

  it('adds a peer edge to a background project', () => {
    const p = useProjects.getState().addProject('p')
    useProjects.getState().commitCanvas(p.id, [node('a'), node('b')], { x: 0, y: 0, zoom: 1 })
    expect(
      useProjects.getState().applyEdgeMutation(p.id, { op: 'edge-upsert', kind: 'bridge', edge: link('x') })
    ).toBe(true)
    expect(useProjects.getState().getProject(p.id)?.bridges).toEqual([link('x')])
  })

  // A project that never had a list must not have `"bridges": []` materialized into its file by a
  // ROPE op (or by a remove of an edge it does not hold).
  it('leaves an absent list absent and the untouched kind by reference', () => {
    const p = useProjects.getState().addProject('p')
    useProjects.getState().commitCanvas(p.id, [node('a'), node('b')], { x: 0, y: 0, zoom: 1 })
    expect(useProjects.getState().getProject(p.id)?.bridges).toBeUndefined()
    useProjects.getState().applyEdgeMutation(p.id, { op: 'edge-upsert', kind: 'rope', edge: link('ctrl-1') })
    const after = useProjects.getState().getProject(p.id)
    expect(after?.bridges).toBeUndefined()
    expect(after?.ropes).toEqual([link('ctrl-1')])

    const ropes = after?.ropes
    useProjects.getState().applyEdgeMutation(p.id, { op: 'edge-upsert', kind: 'bridge', edge: link('x') })
    expect(useProjects.getState().getProject(p.id)?.ropes).toBe(ropes)
  })

  it('an edge id lives in one list', () => {
    const p = useProjects.getState().addProject('p')
    useProjects
      .getState()
      .commitCanvas(p.id, [node('a'), node('b')], { x: 0, y: 0, zoom: 1 }, [link('x')], [])
    useProjects.getState().applyEdgeMutation(p.id, { op: 'edge-upsert', kind: 'rope', edge: link('x') })
    expect(useProjects.getState().getProject(p.id)?.bridges).toEqual([])
    expect(useProjects.getState().getProject(p.id)?.ropes).toEqual([link('x')])
    useProjects.getState().applyEdgeMutation(p.id, { op: 'edge-remove', kind: 'bridge', id: 'x' })
    expect(useProjects.getState().getProject(p.id)?.ropes).toEqual([])
  })
})
