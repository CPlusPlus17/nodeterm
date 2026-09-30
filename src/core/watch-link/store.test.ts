import { describe, it, expect, vi } from 'vitest'
import { promises as fsp, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { testTmpDir } from '../test-tmp'
import { renameAtomic, writeFileAtomic } from '../fs-atomic'
import { WatchLinkStore, WatchLinkStoreUnreadable, type WatchLinkRecord } from './store'

// Pass-through spies, so a test can hold one write open (ordering), fail one (chain recovery,
// set-aside failure) or count them (a latched store must not write at all).
vi.mock('../fs-atomic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fs-atomic')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic), renameAtomic: vi.fn(actual.renameAtomic) }
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

// The shape of the real desktop seam (src/main/platform-electron.ts): safeStorage encrypts the
// buffer's UTF-8 TEXT and decrypts back to text. Reversing the code points stands in for the cipher;
// what matters is the two UTF-8 conversions, which mangle any byte sequence that is not valid UTF-8.
const reverseText = (s: string) => [...s].reverse().join('')
const electronSeal = (b: Buffer) => Buffer.from(reverseText(b.toString('utf8')), 'utf8')
const electronUnseal = (b: Buffer) => Buffer.from(reverseText(b.toString('utf8')), 'utf8')
// 0x80..0x9f: every byte a lone UTF-8 continuation byte, so `toString('utf8')` replaces each one.
const HIGH_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i)

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const rawEntry = (over: Record<string, unknown> = {}) => ({
  linkId: 'AbCdEfGhIjKlMnOpQrStUv', nodeId: 'n1', role: 'viewer', label: 'Ada', title: 'build',
  createdAt: 1, expiresAt: EXPIRES_AT, secret: b64(new Uint8Array(32).fill(7)), sealed: false, ...over
})
const writeLinks = (f: string, links: unknown[], v: unknown = 1) => writeFileSync(f, JSON.stringify({ v, links }))

describe('WatchLinkStore', () => {
  it('round-trips sealed records and writes 0600', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal, unseal })
    expect(await s.save([rec()])).toBe('saved')
    expect(await s.load()).toEqual([rec()])
    expect(readFileSync(f, 'utf8')).not.toContain(Buffer.from(new Uint8Array(32).fill(7)).toString('base64'))
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it('round-trips a high-byte secret through an Electron-shaped (UTF-8 text) seam', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal: electronSeal, unseal: electronUnseal })
    const r = rec({ secret: HIGH_BYTES })
    expect(await s.save([r])).toBe('saved')
    expect(await new WatchLinkStore({ file: f, seal: electronSeal, unseal: electronUnseal }).load()).toEqual([r])
  })

  it('stores raw secrets where the platform has no seal (Server Edition)', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f })
    expect(await s.save([rec()])).toBe('saved')
    expect(await s.load()).toEqual([rec()])
    expect(await s.save([rec({ secret: HIGH_BYTES })])).toBe('saved')
    expect(await s.load()).toEqual([rec({ secret: HIGH_BYTES })])
  })

  it('writes an empty file and reports memory-only when sealing throws', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal: () => { throw new Error('locked') }, unseal })
    expect(await s.save([rec()])).toBe('memory-only')
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ v: 1, links: [] })
  })

  it('reports a non-seal error while building the file as failed, and leaves the old file intact', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal, unseal })
    expect(await s.save([rec()])).toBe('saved')
    const before = readFileSync(f, 'utf8')
    const broken = { ...rec({ linkId: 'BbCdEfGhIjKlMnOpQrStUv' }), secret: undefined } as unknown as WatchLinkRecord
    expect(await s.save([rec(), broken])).toBe('failed')
    expect(readFileSync(f, 'utf8')).toBe(before)
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

  it('drops an entry whose node id is not a safe node id', async () => {
    const f = file()
    writeLinks(f, [
      rawEntry({ nodeId: '../x', linkId: 'A1CdEfGhIjKlMnOpQrStUv' }),
      rawEntry({ nodeId: 'a b', linkId: 'A2CdEfGhIjKlMnOpQrStUv' }),
      rawEntry({ nodeId: 'x'.repeat(129), linkId: 'A3CdEfGhIjKlMnOpQrStUv' }),
      rawEntry()
    ])
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([rec()])
  })

  it('drops a secret of the wrong length, sealed and unsealed', async () => {
    // Each bad entry is otherwise valid, so nothing but the length check can reject it.
    const f = file()
    writeLinks(f, [rawEntry({ linkId: 'ShortRawGhIjKlMnOpQrSt', secret: b64(new Uint8Array(1).fill(7)) }), rawEntry()])
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([rec()])

    const f2 = file()
    const sealB64 = (bytes: Uint8Array) => seal(Buffer.from(b64(bytes), 'utf8')).toString('base64')
    writeLinks(f2, [
      rawEntry({ linkId: 'ShortSealIjKlMnOpQrStUv'.slice(0, 22), secret: sealB64(new Uint8Array(31).fill(7)), sealed: true }),
      rawEntry({ linkId: 'LongSealhIjKlMnOpQrStUv'.slice(0, 22), secret: sealB64(new Uint8Array(33).fill(7)), sealed: true }),
      rawEntry({ secret: sealB64(new Uint8Array(32).fill(7)), sealed: true })
    ])
    expect(await new WatchLinkStore({ file: f2, seal, unseal }).load()).toEqual([rec()])
  })

  it('returns at most 200 entries', async () => {
    const f = file()
    const id = (i: number) => `L${String(i).padStart(21, '0')}`
    writeLinks(f, Array.from({ length: 250 }, (_, i) => rawEntry({ linkId: id(i) })))
    const loaded = await new WatchLinkStore({ file: f }).load()
    expect(loaded).toHaveLength(200)
    expect(loaded[199].linkId).toBe(id(199))
  })

  it('sets an unparseable file aside and stays writable', async () => {
    const f = file()
    writeFileSync(f, '{nope')
    const s = new WatchLinkStore({ file: f })
    expect(await s.load()).toEqual([])
    expect(existsSync(f)).toBe(false)
    const aside = readdirSync(dirname(f)).filter((n) => n.startsWith('watch-links.json.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dirname(f), aside[0]), 'utf8')).toBe('{nope')
    expect(await s.save([rec()])).toBe('saved')
    expect(await s.load()).toEqual([rec()])
  })

  describe('never writes over a file it could not read', () => {
    const expectLatched = async (s: WatchLinkStore, f: string, before: string) => {
      const writes = vi.mocked(writeFileAtomic).mock.calls.length
      expect(await s.save([])).toBe('failed')
      expect(await s.save([rec()])).toBe('failed')
      expect(vi.mocked(writeFileAtomic).mock.calls.length).toBe(writes)
      expect(readFileSync(f, 'utf8')).toBe(before)
    }

    it('a read error other than ENOENT rejects and latches the store', async () => {
      const f = file()
      expect(await new WatchLinkStore({ file: f }).save([rec()])).toBe('saved')
      const before = readFileSync(f, 'utf8')
      const eio = Object.assign(new Error('EIO: i/o error, open'), { code: 'EIO' })
      const open = vi.spyOn(fsp, 'open').mockRejectedValueOnce(eio)
      const s = new WatchLinkStore({ file: f })
      await expect(s.load()).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      open.mockRestore()
      await expectLatched(s, f, before)
    })

    it('a path that cannot be read as a file (a directory) rejects', async () => {
      const f = file()
      mkdirSync(f)
      const s = new WatchLinkStore({ file: f })
      await expect(s.load()).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      expect(await s.save([rec()])).toBe('failed')
      expect(statSync(f).isDirectory()).toBe(true)
    })

    it('a file larger than 1 MiB rejects and latches the store', async () => {
      const f = file()
      writeLinks(f, [rawEntry({ pad: 'x'.repeat(1024 * 1024) })])
      const before = readFileSync(f, 'utf8')
      const s = new WatchLinkStore({ file: f })
      await expect(s.load()).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      await expectLatched(s, f, before)
    })

    it('a version other than 1 rejects and latches the store', async () => {
      const f = file()
      writeLinks(f, [rawEntry()], 2)
      const before = readFileSync(f, 'utf8')
      const s = new WatchLinkStore({ file: f })
      await expect(s.load()).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      await expectLatched(s, f, before)
    })

    it('an unparseable file that cannot be set aside rejects and latches the store', async () => {
      const f = file()
      writeFileSync(f, '{nope')
      vi.mocked(renameAtomic).mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
      const s = new WatchLinkStore({ file: f })
      await expect(s.load()).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      await expectLatched(s, f, '{nope')
    })
  })

  it('serializes saves: an older snapshot never lands after a newer one', async () => {
    // A revoke is a save of the smaller list. If two writes overlap and finish out of order, the
    // OLDER snapshot is what stays on disk — and the revoked link comes back at the next boot.
    const f = file()
    const s = new WatchLinkStore({ file: f })
    const { writeFileAtomic: realWrite } = await vi.importActual<typeof import('../fs-atomic')>('../fs-atomic')
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let bLanded!: () => void
    const bDone = new Promise<void>((r) => { bLanded = r })
    vi.mocked(writeFileAtomic)
      .mockImplementationOnce(async (...args) => {
        events.push('a:start')
        await gate // the FIRST write is held until the test releases it
        await realWrite(...args)
        events.push('a:end')
      })
      .mockImplementationOnce(async (...args) => {
        events.push('b:start')
        await realWrite(...args)
        events.push('b:end')
        bLanded()
      })
    const a = s.save([rec()])
    const b = s.save([])
    // Let already-scheduled work run (microtasks only, no timers). Serialized, the second write has
    // still not been called: it waits on the held first one. If it has (the bug), let it land
    // before releasing the first, so the out-of-order finish is certain rather than a race.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    if (events.includes('b:start')) await bDone
    release()
    expect(await a).toBe('saved')
    expect(await b).toBe('saved')
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
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
