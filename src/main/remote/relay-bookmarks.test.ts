// src/main/remote/relay-bookmarks.test.ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BookmarkStore, publicBookmark, type RelayBookmark } from './relay-bookmarks'

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-')), 'relay-bookmarks.json')
const b: RelayBookmark = { hostId: 'H', code: 'nodeterm://join?code=x', label: 'box', deviceToken: null, approvedAt: null, source: 'code' }

describe('relay bookmarks', () => {
  it('upserts by hostId and removes', async () => {
    const s = new BookmarkStore(tmpFile())
    await s.upsert(b)
    await s.upsert({ ...b, approvedAt: '2026-09-28T00:00:00Z' })
    expect(await s.list()).toEqual([{ ...b, approvedAt: '2026-09-28T00:00:00Z' }])
    await s.remove('H')
    expect(await s.list()).toEqual([])
  })

  // POSIX permission bits: Windows has no 0600 (ACLs decide there), so the mode is not observable.
  it.skipIf(process.platform === 'win32')('persists 0600, because a bookmark holds a device token', async () => {
    const file = tmpFile()
    const s = new BookmarkStore(file)
    await s.upsert({ ...b, deviceToken: 'DT' })
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
    // Rewrites keep it (each write is a fresh temp file renamed over the old one).
    await s.upsert({ ...b, hostId: 'H2' })
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
  })

  it('a corrupt file reads as empty and is not overwritten until the next write', async () => {
    const file = tmpFile()
    fs.writeFileSync(file, 'nope')
    expect(await new BookmarkStore(file).list()).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe('nope')
  })

  it('drops malformed entries on read', async () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify([b, { hostId: 'X' }, null, { ...b, hostId: 'Y', source: 'phone' }, { ...b, hostId: 'Z', deviceToken: 5 }]))
    expect(await new BookmarkStore(file).list()).toEqual([b])
  })

  it('concurrent writes are serialized, none is lost', async () => {
    const s = new BookmarkStore(tmpFile())
    await Promise.all(['A', 'B', 'C', 'D'].map((hostId) => s.upsert({ ...b, hostId })))
    expect((await s.list()).map((x) => x.hostId).sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('update patches an existing bookmark and never creates one', async () => {
    const s = new BookmarkStore(tmpFile())
    await s.update('H', { approvedAt: 'now' })
    expect(await s.list()).toEqual([])
    await s.upsert(b)
    await s.update('H', { approvedAt: 'now', deviceToken: 'DT' })
    expect(await s.list()).toEqual([{ ...b, approvedAt: 'now', deviceToken: 'DT' }])
  })

  it('the renderer\'s view of a bookmark never carries its device token', () => {
    const shown = publicBookmark({ ...b, deviceToken: 'SECRET', approvedAt: '2026-09-28T00:00:00Z' })
    expect(shown).toEqual({ hostId: 'H', label: 'box', approved: true, code: 'nodeterm://join?code=x' })
    expect(JSON.stringify(shown)).not.toContain('SECRET')
    expect(publicBookmark(b).approved).toBe(false)
  })
})
