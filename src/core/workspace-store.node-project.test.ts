// `projectIdForNode` is asked once per access decision for every hosted-team viewer (every
// agent:status event, every subagent-activity chunk, every unread-clear, every snapshot element).
// `persistedCanvases()` re-parses every local project's cached project.json on each call, so the
// answer is memoized — and the memo must never serve a stale answer after ANY writer changed a
// project's nodes, including the ones that change the cache without going through save()/load().
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

let userData: string
const roots: string[] = []

const node = (id: string): CanvasNodeState =>
  ({ id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: id, color: '#fff', group: null }) as CanvasNodeState
const project = (id: string, cwd: string | undefined, nodeIds: string[]): Project => ({
  id,
  name: id,
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: nodeIds.map(node),
  ...(cwd ? { cwd } : {})
})
const ws = (projects: Project[]): Workspace => ({ version: 2, activeProjectId: projects[0]?.id ?? '', projects })
const newRoot = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-np-'))
  roots.push(d)
  return d
}

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-np-ws-'))
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  for (const d of roots.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

/** How many times `JSON.parse` runs inside `fn` (synchronous, so nothing else runs meanwhile). */
function parses(fn: () => void): number {
  const spy = vi.spyOn(JSON, 'parse')
  try {
    fn()
    return spy.mock.calls.length
  } finally {
    spy.mockRestore()
  }
}

describe('WorkspaceStore.projectIdForNode', () => {
  it('answers exactly what a persistedCanvases scan answers', async () => {
    const [a, b] = [await newRoot(), await newRoot()]
    const store = new WorkspaceStore()
    await store.save(ws([project('pa', a, ['n1', 'n2']), project('pb', b, ['n3']), project('inline', undefined, ['n4'])]))
    const scan = (id: string): string | undefined => store.persistedCanvases().find((c) => c.nodes.some((n) => n.id === id))?.id
    for (const id of ['n1', 'n2', 'n3', 'n4', 'nope']) expect(store.projectIdForNode(id)).toBe(scan(id))
    expect(store.projectIdForNode('n3')).toBe('pb')
    expect(store.projectIdForNode('nope')).toBeUndefined()
  })

  it('parses each project file at most once for any number of lookups', async () => {
    const dirs = await Promise.all(Array.from({ length: 5 }, () => newRoot()))
    const store = new WorkspaceStore()
    await store.save(ws(dirs.map((d, i) => project(`p${i}`, d, Array.from({ length: 50 }, (_, j) => `p${i}-n${j}`)))))
    const n = parses(() => {
      for (let k = 0; k < 1000; k++) store.projectIdForNode(`p${k % 5}-n${k % 50}`)
    })
    // One rebuild after the save (one parse per local project), then pure map lookups.
    expect(n).toBeLessThanOrEqual(5)
    // And a further burst with nothing changed parses nothing at all.
    expect(parses(() => { for (let k = 0; k < 1000; k++) store.projectIdForNode('p1-n1') })).toBe(0)
  })

  it('a save that adds a node or moves one to another project is seen at once', async () => {
    const [a, b] = [await newRoot(), await newRoot()]
    const store = new WorkspaceStore()
    await store.save(ws([project('pa', a, ['n1']), project('pb', b, ['n2'])]))
    expect(store.projectIdForNode('n1')).toBe('pa')
    expect(store.projectIdForNode('n9')).toBeUndefined()
    await store.save(ws([project('pa', a, ['n9']), project('pb', b, ['n2', 'n1'])]))
    expect(store.projectIdForNode('n9')).toBe('pa')
    expect(store.projectIdForNode('n1')).toBe('pb')
    // Into and out of an inline (cwd-less) project, whose nodes live in the index entry itself.
    await store.save(ws([project('pa', a, ['n9']), project('pb', b, ['n2']), project('inline', undefined, ['n1'])]))
    expect(store.projectIdForNode('n1')).toBe('inline')
  })

  it('a write that bypasses save() (a phone-registered node) is seen at once', async () => {
    const a = await newRoot()
    const store = new WorkspaceStore()
    await store.save(ws([project('pa', a, ['n1'])]))
    expect(store.projectIdForNode('term-abc123-phone1')).toBeUndefined()
    expect(await store.appendRemoteNode('pa', { id: 'term-abc123-phone1', title: 'from the phone' })).toBe(true)
    expect(store.projectIdForNode('term-abc123-phone1')).toBe('pa')
  })

  it('an outside edit picked up by load() (git pull, hand edit) is seen at once', async () => {
    const [a, b] = [await newRoot(), await newRoot()]
    const store = new WorkspaceStore()
    await store.save(ws([project('pa', a, ['n1']), project('pb', b, ['n2'])]))
    expect(store.projectIdForNode('n1')).toBe('pa')
    // Move n1 from pa's file to pb's file behind the store's back, then reload.
    const fa = path.join(a, '.nodeterm', 'project.json')
    const fb = path.join(b, '.nodeterm', 'project.json')
    const ja = JSON.parse(await fs.readFile(fa, 'utf-8'))
    const jb = JSON.parse(await fs.readFile(fb, 'utf-8'))
    jb.nodes.push(...ja.nodes)
    ja.nodes = []
    ja.rev += 1
    jb.rev += 1
    await fs.writeFile(fa, JSON.stringify(ja, null, 2))
    await fs.writeFile(fb, JSON.stringify(jb, null, 2))
    await store.load()
    expect(store.projectIdForNode('n1')).toBe('pb')
  })
})
