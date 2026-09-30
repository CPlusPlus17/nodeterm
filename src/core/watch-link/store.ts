// Active live links survive an app restart (spec D8). The secret is sealed through the platform's
// secret seam: Electron safeStorage on the desktop, and ABSENT on the Server Edition by design
// (headless, no keychain: raw bytes in a 0600 file, the same rule as its node secrets). On the
// desktop there is no plaintext fallback: if sealing throws, the file is written EMPTY and links
// live in memory for this run; a raw secret found on a desktop is refused, never adopted.
//
// What is sealed is the BASE64 TEXT of the secret, never its bytes. The desktop seam is a string
// seam (`safeStorage.encryptString(b.toString('utf8'))` / `Buffer.from(decryptString(b), 'utf8')`),
// so 32 random bytes — almost never valid UTF-8 — come back as different bytes of a different
// length. Same convention as src/core/agents/node-auth-secret.ts. Unsealed entries (Server Edition)
// are the base64 of the raw bytes.
//
// The store never writes over a file it could not read. Only ENOENT means "no links". Any other
// read error, a file over 1 MiB, or a version other than 1 makes `load()` reject and LATCHES the
// store: every later `save()` resolves 'failed' without touching disk, so the file survives for the
// next boot or a newer build. JSON that does not parse is set aside as `<file>.corrupt-<ts>` and the
// store starts empty; if the set-aside fails, the same latch applies.
//
// Saves are SERIALIZED: each write waits for the previous one to finish. Two overlapping atomic
// writes can still complete out of order, and the older snapshot would then be what stays on disk —
// a revoked link resurrected at the next boot. The snapshot is taken (and sealed) when `save` is
// CALLED, so disk order is call order; a failed write never breaks the chain for the next save.
import { promises as fs } from 'node:fs'
import { renameAtomic, writeFileAtomic } from '../fs-atomic'
import { LINK_ID_RE } from '../../shared/watch-link/link'
import type { WatchLinkRole } from '../../shared/watch-link/protocol'
import { isSafeNodeId } from '../../shared/safe-id'

export interface WatchLinkRecord {
  linkId: string
  nodeId: string
  role: WatchLinkRole
  label: string
  title: string
  createdAt: number
  expiresAt: number
  secret: Uint8Array
}
export type SaveOutcome = 'saved' | 'memory-only' | 'failed'

export type WatchLinkStoreUnreadableReason = 'read-error' | 'too-large' | 'unknown-version' | 'set-aside-failed'

/** `load()` could not read the file and will not write over it: the store is now latched. */
export class WatchLinkStoreUnreadable extends Error {
  constructor(
    readonly reason: WatchLinkStoreUnreadableReason,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'WatchLinkStoreUnreadable'
  }
}

interface FileEntry {
  linkId: string
  nodeId: string
  role: WatchLinkRole
  label: string
  title: string
  createdAt: number
  expiresAt: number
  secret: string
  sealed: boolean
}

/** A machine holds a handful of links; anything near this is a hand edit, not our file. */
export const MAX_FILE_BYTES = 1024 * 1024
/** Entries past this are dropped on read. */
export const MAX_ENTRIES = 200
const SECRET_BYTES = 32

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const codeOf = (e: unknown): string =>
  typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''

/** Base64 text → the 32-byte secret, or null. Canonical text only: Node's base64 decoder skips
 *  characters it does not know, so a mangled string could otherwise decode to *some* bytes. */
function decodeSecret(text: string): Uint8Array | null {
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length !== SECRET_BYTES) return null
  if (bytes.toString('base64') !== text) return null
  return new Uint8Array(bytes)
}

export class WatchLinkStore {
  /** The previous save's write, settled either way: the next write starts only after it. */
  private writing: Promise<void> = Promise.resolve()
  /** False once `load()` found a file it could not read: never write over it this run. */
  private writable = true

  constructor(private readonly o: { file: string; seal?: (b: Buffer) => Buffer; unseal?: (b: Buffer) => Buffer }) {}

  async load(): Promise<WatchLinkRecord[]> {
    let text: string
    try {
      const handle = await fs.open(this.o.file, 'r')
      try {
        const { size } = await handle.stat()
        if (size > MAX_FILE_BYTES) {
          throw this.latch('too-large', `${this.o.file} is ${size} bytes, over the ${MAX_FILE_BYTES}-byte limit`)
        }
        text = await handle.readFile('utf8')
      } finally {
        await handle.close().catch(() => {})
      }
    } catch (e) {
      if (e instanceof WatchLinkStoreUnreadable) throw e
      if (codeOf(e) === 'ENOENT') return []
      throw this.latch('read-error', `could not read ${this.o.file}: ${(e as Error)?.message ?? e}`, e)
    }

    let body: unknown
    try {
      body = JSON.parse(text.replace(/\r\n/g, '\n'))
    } catch {
      body = undefined
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      // Not JSON, or JSON that cannot be any version of this envelope: keep a copy, start empty.
      await this.setAside()
      return []
    }
    const { v, links } = body as { v?: unknown; links?: unknown }
    if (v !== 1) throw this.latch('unknown-version', `${this.o.file} has version ${JSON.stringify(v)}, expected 1`)

    const out: WatchLinkRecord[] = []
    for (const e of Array.isArray(links) ? (links.slice(0, MAX_ENTRIES) as Partial<FileEntry>[]) : []) {
      if (!e || !str(e.linkId, 22) || !LINK_ID_RE.test(e.linkId) || !isSafeNodeId(e.nodeId)) continue
      if (e.role !== 'viewer' && e.role !== 'commenter') continue
      if (!str(e.label, 40) || !str(e.title, 80) || !num(e.createdAt) || !num(e.expiresAt) || typeof e.secret !== 'string') continue
      const secret = this.readSecret(e.secret, e.sealed === true)
      if (!secret) continue
      out.push({ linkId: e.linkId, nodeId: e.nodeId as string, role: e.role, label: e.label, title: e.title, createdAt: e.createdAt, expiresAt: e.expiresAt, secret })
    }
    return out
  }

  private latch(reason: WatchLinkStoreUnreadableReason, message: string, cause?: unknown): WatchLinkStoreUnreadable {
    this.writable = false
    return new WatchLinkStoreUnreadable(reason, message, cause === undefined ? undefined : { cause })
  }

  private async setAside(): Promise<void> {
    const aside = `${this.o.file}.corrupt-${Date.now()}`
    try {
      await renameAtomic(this.o.file, aside)
    } catch (e) {
      throw this.latch('set-aside-failed', `${this.o.file} does not parse and could not be set aside as ${aside}`, e)
    }
  }

  private readSecret(stored: string, sealed: boolean): Uint8Array | null {
    try {
      if (sealed) {
        if (!this.o.unseal) return null
        return decodeSecret(this.o.unseal(Buffer.from(stored, 'base64')).toString('utf8'))
      }
      // A desktop (it can seal) never adopts a raw secret it finds on disk.
      return this.o.seal ? null : decodeSecret(stored)
    } catch {
      return null
    }
  }

  async save(records: readonly WatchLinkRecord[]): Promise<SaveOutcome> {
    let links: FileEntry[] = []
    let outcome: SaveOutcome = 'saved'
    try {
      for (const r of records) {
        const text = Buffer.from(r.secret).toString('base64')
        let secret = text
        if (this.o.seal) {
          try {
            secret = this.o.seal(Buffer.from(text, 'utf8')).toString('base64')
          } catch {
            // The keychain refused: no plaintext fallback. Write nothing, keep links in memory.
            outcome = 'memory-only'
            break
          }
        }
        links.push({
          linkId: r.linkId, nodeId: r.nodeId, role: r.role, label: r.label, title: r.title,
          createdAt: r.createdAt, expiresAt: r.expiresAt, secret, sealed: !!this.o.seal
        })
      }
    } catch {
      // Not a seal failure (a malformed record): leave the old file exactly as it is.
      return 'failed'
    }
    if (outcome === 'memory-only') links = []
    const data = JSON.stringify({ v: 1, links })
    // Everything above ran synchronously at call time, so the chain is extended in call order.
    const write = this.writing.then(() => {
      if (!this.writable) throw new Error('watch-link store is latched: it could not read its file')
      return writeFileAtomic(this.o.file, data, { mode: 0o600 })
    })
    this.writing = write.catch(() => {})
    try {
      await write
      return outcome
    } catch {
      return 'failed'
    }
  }
}
