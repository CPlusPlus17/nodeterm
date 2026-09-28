// src/core/relay/team-store.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TeamStore, parseTeam, emptyTeam, upsertPeer, removePeer, setShared, peerFor } from './team-store'

const made: string[] = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'team-'))
  made.push(d)
  return d
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const owner = { pubkeyB64: 'O', label: 'Enes', role: 'owner' as const, addedAt: '2026-09-28T00:00:00Z', addedBy: 'cli' }
const writeDoc = (dir: string, doc: unknown) =>
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(doc))

describe('team doc', () => {
  it('rejects a forged role and unknown shapes', () => {
    expect(parseTeam({ v: 1, peers: [{ ...owner, role: 'root' }], sharedProjects: [] })).toBeNull()
    expect(parseTeam({ v: 2, peers: [], sharedProjects: [] })).toBeNull()
    expect(parseTeam(null)).toBeNull()
    expect(parseTeam({ v: 1, peers: [owner], sharedProjects: ['p1'] })).toEqual({ v: 1, peers: [owner], sharedProjects: ['p1'] })
  })
  it('upsert replaces by key; remove refuses the last owner without force', () => {
    let d = upsertPeer(emptyTeam(), owner)
    d = upsertPeer(d, { ...owner, label: 'E2' })
    expect(d.peers).toHaveLength(1)
    expect(peerFor(d, 'O')?.label).toBe('E2')
    expect(removePeer(d, 'O', false)).toBe('last-owner')
    expect(removePeer(d, 'O', true)).toEqual({ ...d, peers: [] })
  })
  it('remove refuses when a key listed twice as owner is the only owner key', () => {
    // A hand-edited file can list one key twice. Counting ENTRIES would see two owners and let
    // the removal (which drops every entry for that key) leave the team with none.
    const doubled = { ...emptyTeam(), peers: [owner, { ...owner, label: 'dup' }] }
    expect(removePeer(doubled, 'O', false)).toBe('last-owner')
    // A non-owner leaving a team that has no owner at all is not a last-owner removal.
    const noOwner = upsertPeer(emptyTeam(), { ...owner, pubkeyB64: 'V', role: 'viewer' })
    expect(removePeer(noOwner, 'V', false)).toEqual(emptyTeam())
  })
  it('setShared is idempotent', () => {
    const d = setShared(setShared(emptyTeam(), 'p', true), 'p', true)
    expect(d.sharedProjects).toEqual(['p'])
    expect(setShared(d, 'p', false).sharedProjects).toEqual([])
  })
})

describe('TeamStore', () => {
  it('persists 0600 and reloads', async () => {
    const dir = tmp()
    const s = new TeamStore(dir)
    await s.load()
    await s.update((d) => upsertPeer(d, owner))
    expect((fs.statSync(path.join(dir, 'team.json')).mode & 0o777).toString(8)).toBe('600')
    const again = new TeamStore(dir)
    expect(peerFor(await again.load(), 'O')?.role).toBe('owner')
  })
  it('a corrupt file is set aside and the store starts CLOSED (no pins)', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'team.json'), '{not json')
    const s = new TeamStore(dir)
    expect((await s.load()).peers).toEqual([])
    expect(fs.readdirSync(dir).some((f) => f.startsWith('team.json.corrupt-'))).toBe(true)
  })
  it('concurrent updates never lose a write', async () => {
    const s = new TeamStore(tmp())
    await s.load()
    await Promise.all(['a', 'b', 'c'].map((k) => s.update((d) => upsertPeer(d, { ...owner, pubkeyB64: k }))))
    expect(s.current().peers.map((p) => p.pubkeyB64).sort()).toEqual(['a', 'b', 'c'])
  })
  it('an update on a never-loaded store loads the file first instead of replacing it', async () => {
    // The admin `add-owner` path can run while start() never loaded (e.g. the host key was
    // unreadable). Writing from the in-memory empty doc would wipe every existing member.
    const dir = tmp()
    writeDoc(dir, { v: 1, peers: [owner, { ...owner, pubkeyB64: 'E', role: 'editor' }], sharedProjects: ['p1'] })
    const s = new TeamStore(dir)
    await s.update((d) => upsertPeer(d, { ...owner, pubkeyB64: 'V', role: 'viewer' }))
    const onDisk = await new TeamStore(dir).load()
    expect(onDisk.peers.map((p) => p.pubkeyB64).sort()).toEqual(['E', 'O', 'V'])
    expect(onDisk.sharedProjects).toEqual(['p1'])
  })
  it('an unreadable file is never overwritten, and the next update retries the load', async () => {
    const dir = tmp()
    const file = path.join(dir, 'team.json')
    fs.mkdirSync(file) // readFile → EISDIR: unreadable, which is not the same as absent
    const s = new TeamStore(dir)
    await expect(s.update((d) => upsertPeer(d, owner))).rejects.toThrow()
    expect(fs.statSync(file).isDirectory()).toBe(true)
    fs.rmdirSync(file)
    writeDoc(dir, { v: 1, peers: [{ ...owner, pubkeyB64: 'E', role: 'editor' }], sharedProjects: [] })
    await s.update((d) => upsertPeer(d, owner))
    expect(s.current().peers.map((p) => p.pubkeyB64).sort()).toEqual(['E', 'O'])
  })
  it('a load() called after an update() sees that update (loads are serialized with writes)', async () => {
    // An unserialized read issued while a write is queued returns the pre-write file and resets
    // the in-memory doc to it — the next update then computes from stale state and drops a write.
    const dir = tmp()
    writeDoc(dir, { v: 1, peers: [owner], sharedProjects: [] })
    const s = new TeamStore(dir)
    await s.load()
    const u = s.update((d) => upsertPeer(d, { ...owner, pubkeyB64: 'B', role: 'editor' }))
    const l = s.load()
    await u
    expect(peerFor(await l, 'B')?.role).toBe('editor')
    expect(peerFor(s.current(), 'B')?.role).toBe('editor')
  })
})
