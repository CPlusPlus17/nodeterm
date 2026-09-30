import { describe, it, expect, vi } from 'vitest'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { testTmpDir } from '../test-tmp'
import { writeFileAtomic } from '../fs-atomic'
import { WatchLinkStore, type WatchLinkRecord } from './store'

// A pass-through spy, so a test can hold one write open (ordering) or fail one (chain recovery).
vi.mock('../fs-atomic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fs-atomic')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})

const file = () => join(testTmpDir('wl-'), 'watch-links.json')
// Computed once: two `rec()` calls a millisecond apart must still compare equal.
const EXPIRES_AT = Date.now() + 3600_000
const rec = (over: Partial<WatchLinkRecord> = {}): WatchLinkRecord => ({
  linkId: 'AbCdEfGhIjKlMnOpQrStUv', nodeId: 'n1', role: 'viewer', label: 'Ada', title: 'build',
  createdAt: 1, expiresAt: EXPIRES_AT, secret: new Uint8Array(32).fill(7), ...over
})
const seal = (b: Buffer) => Buffer.from(b.toString('hex'))
const unseal = (b: Buffer) => Buffer.from(b.toString(), 'hex')

describe('WatchLinkStore', () => {
  it('round-trips sealed records and writes 0600', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal, unseal })
    expect(await s.save([rec()])).toBe('saved')
    expect(await s.load()).toEqual([rec()])
    expect(readFileSync(f, 'utf8')).not.toContain(Buffer.from(new Uint8Array(32).fill(7)).toString('base64'))
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it('stores raw secrets where the platform has no seal (Server Edition)', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f })
    expect(await s.save([rec()])).toBe('saved')
    expect(await s.load()).toEqual([rec()])
  })

  it('writes an empty file and reports memory-only when sealing throws', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal: () => { throw new Error('locked') }, unseal })
    expect(await s.save([rec()])).toBe('memory-only')
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ v: 1, links: [] })
  })

  it('an unsealable secret is skipped, and a desktop never accepts a raw one', async () => {
    const f = file()
    await new WatchLinkStore({ file: f }).save([rec()]) // raw on disk
    const desktop = new WatchLinkStore({ file: f, seal, unseal: () => { throw new Error('keychain reset') } })
    expect(await desktop.load()).toEqual([])
    const f2 = file()
    await new WatchLinkStore({ file: f2, seal, unseal }).save([rec()])
    expect(await new WatchLinkStore({ file: f2, seal, unseal: () => { throw new Error('reset') } }).load()).toEqual([])
  })

  it('tolerates a missing or corrupt file and drops malformed entries', async () => {
    const f = file()
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([])
    writeFileSync(f, '{nope')
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([])
    writeFileSync(f, JSON.stringify({ v: 1, links: [{ linkId: 'bad', nodeId: 'n', role: 'viewer', secret: 'AA==', sealed: false }] }))
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([])
  })

  it('serializes saves: an older snapshot never lands after a newer one', async () => {
    // A revoke is a save of the smaller list. If two writes overlap and finish out of order, the
    // OLDER snapshot is what stays on disk — and the revoked link comes back at the next boot.
    const f = file()
    const s = new WatchLinkStore({ file: f })
    const { writeFileAtomic: realWrite } = await vi.importActual<typeof import('../fs-atomic')>('../fs-atomic')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    vi.mocked(writeFileAtomic).mockImplementationOnce(async (...args) => {
      await gate // hold the FIRST write open
      return realWrite(...args)
    })
    const a = s.save([rec()])
    const b = s.save([])
    // Unserialized, `b` lands while `a` is held; serialized, it is still waiting behind `a`.
    await Promise.race([b, new Promise((r) => setTimeout(r, 100))])
    release()
    expect(await a).toBe('saved')
    expect(await b).toBe('saved')
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ v: 1, links: [] })
    expect(await s.load()).toEqual([])
  })

  it('a failed save does not break the chain for the next one', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f })
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error('EPERM'))
    const a = s.save([rec()])
    const b = s.save([rec({ label: 'Bob' })])
    expect(await a).toBe('failed')
    expect(await b).toBe('saved')
    expect(await s.load()).toEqual([rec({ label: 'Bob' })])
  })
})
