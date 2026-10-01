import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import type { Project } from '../shared/types'

let dir: string
let store: WorkspaceStore
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-adopt-'))
  const userData = path.join(dir, 'data')
  fs.mkdirSync(userData)
  initPlatform(fakePlatform({ userDataDir: userData }))
  store = new WorkspaceStore()
})
afterEach(() => {
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

const folder = (name: string): string => {
  const f = path.join(dir, name)
  fs.mkdirSync(f, { recursive: true })
  return f
}
const writeProjectFile = (cwd: string, nodes: unknown[]): void => {
  fs.mkdirSync(path.join(cwd, '.nodeterm'), { recursive: true })
  fs.writeFileSync(
    path.join(cwd, '.nodeterm', 'project.json'),
    JSON.stringify({ version: 1, name: 'Shared', color: '#0a84ff', rev: 3, nodes })
  )
}
const emptyProject = (id: string, name: string, cwd: string): Project =>
  ({ id, name, color: '#7aa2f7', cwd, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] })

describe('WorkspaceStore.adoptFolder', () => {
  it('a folder with no project file becomes an empty project named after the folder, saved', async () => {
    const f = folder('alpha')
    const r = await store.adoptFolder(f, { home: dir })
    expect(r.created).toBe(true)
    expect(r.projectName).toBe('alpha')
    const ws = await store.load({ sideline: false })
    expect(ws.projects.map((p) => p.id)).toContain(r.projectId)
    expect(await store.readProjectContent(r.projectId)).not.toBeNull() // the authority can read it now
  })

  it('an existing project.json keeps its node ids and content, gets a fresh project id, and its ~ cwds expand', async () => {
    const f = folder('beta')
    writeProjectFile(f, [
      { id: 'term-a.1', kind: 'terminal', position: { x: 1, y: 2 }, title: 'A', color: '#fff', cwd: '~/beta', sshRemoteTmux: true, agentId: 'claude' }
    ])
    const r = await store.adoptFolder(f, { home: '/home/u' })
    expect(r.created).toBe(true)
    expect(r.projectId).toMatch(/^project-/)
    const p = (await store.load({ sideline: false })).projects.find((x) => x.id === r.projectId)!
    expect(p.nodes.map((n) => n.id)).toEqual(['term-a.1'])
    expect(p.nodes[0].cwd).toBe('/home/u/beta')
    expect(p.nodes[0].sshRemoteTmux).toBeUndefined()
    expect(p.cwd).toBe(fs.realpathSync(f))
  })

  // Symlinks need a privilege a stock Windows account does not hold; the real-path rule itself is
  // platform-neutral, and the feature it serves (a Linux host's server) never runs there.
  it.skipIf(process.platform === 'win32')('the same folder again — by any path that resolves to it — reuses the id (created:false)', async () => {
    const f = folder('gamma')
    const link = path.join(dir, 'gamma-link')
    fs.symlinkSync(f, link)
    const a = await store.adoptFolder(f, { home: dir })
    const b = await store.adoptFolder(link, { home: dir })
    expect(b).toEqual({ projectId: a.projectId, projectName: a.projectName, created: false })
    expect((await store.load({ sideline: false })).projects.filter((p) => p.cwd === fs.realpathSync(f))).toHaveLength(1)
  })

  // Same reason as above. The other direction: the index holds the folder by a symlinked path (a
  // browser opened it that way), and the real path must still find it.
  it.skipIf(process.platform === 'win32')('reuses a project the index already holds under a path that resolves to the same folder', async () => {
    const f = folder('theta')
    const link = path.join(dir, 'theta-link')
    fs.symlinkSync(f, link)
    await store.save({ version: 2, activeProjectId: 'p-l', projects: [emptyProject('p-l', 'theta', link)] })
    const r = await store.adoptFolder(f, { home: dir })
    expect(r).toEqual({ projectId: 'p-l', projectName: 'theta', created: false })
    expect((await store.load({ sideline: false })).projects).toHaveLength(1)
  })

  it('runs on the save chain: a save queued before it is part of the workspace it writes', async () => {
    const a = folder('zeta')
    const b = folder('eta')
    const saving = store.save({ version: 2, activeProjectId: 'p-a', projects: [emptyProject('p-a', 'zeta', a)] })
    const r = await store.adoptFolder(b, { home: dir })
    await saving
    const ids = (await store.load({ sideline: false })).projects.map((p) => p.id)
    expect(ids).toEqual(['p-a', r.projectId])
  })

  it('E_BAD_CWD for a relative, missing or non-directory path', async () => {
    await expect(store.adoptFolder('rel/x', { home: dir })).rejects.toMatchObject({ code: 'E_BAD_CWD' })
    await expect(store.adoptFolder(path.join(dir, 'nope'), { home: dir })).rejects.toMatchObject({ code: 'E_BAD_CWD' })
    const file = path.join(dir, 'file.txt')
    fs.writeFileSync(file, 'x')
    await expect(store.adoptFolder(file, { home: dir })).rejects.toMatchObject({ code: 'E_BAD_CWD' })
  })

  it('E_ADOPT_FAILED for a corrupt project file, which is left in place (never sidelined, never adopted empty)', async () => {
    const f = folder('delta')
    fs.mkdirSync(path.join(f, '.nodeterm'))
    fs.writeFileSync(path.join(f, '.nodeterm', 'project.json'), '{ not json')
    await expect(store.adoptFolder(f, { home: dir })).rejects.toMatchObject({ code: 'E_ADOPT_FAILED' })
    expect(fs.readFileSync(path.join(f, '.nodeterm', 'project.json'), 'utf8')).toBe('{ not json')
  })

  it('a closed adopted project is reopened when adopted again', async () => {
    const f = folder('eps')
    const a = await store.adoptFolder(f, { home: dir })
    const ws = await store.load({ sideline: false })
    ws.projects.find((p) => p.id === a.projectId)!.closed = true
    await store.save(ws)
    await store.adoptFolder(f, { home: dir })
    expect((await store.load({ sideline: false })).projects.find((p) => p.id === a.projectId)!.closed).toBeFalsy()
  })
})
