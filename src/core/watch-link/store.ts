// Active live links survive an app restart (spec D8). The secret is sealed through the platform's
// secret seam: Electron safeStorage on the desktop, and ABSENT on the Server Edition by design
// (headless, no keychain: raw bytes in a 0600 file, the same rule as its node secrets). On the
// desktop there is no plaintext fallback: if sealing throws, the file is written EMPTY and links
// live in memory for this run; a raw secret found on a desktop is refused, never adopted.
//
// Saves are SERIALIZED: each write waits for the previous one to finish. Two overlapping atomic
// writes can still complete out of order, and the older snapshot would then be what stays on disk —
// a revoked link resurrected at the next boot. The snapshot is taken (and sealed) when `save` is
// CALLED, so disk order is call order; a failed write never breaks the chain for the next save.
import { promises as fs } from 'node:fs'
import { writeFileAtomic } from '../fs-atomic'
import { LINK_ID_RE } from '../../shared/watch-link/link'
import type { WatchLinkRole } from '../../shared/watch-link/protocol'

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

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export class WatchLinkStore {
  /** The previous save's write, settled either way: the next write starts only after it. */
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly o: { file: string; seal?: (b: Buffer) => Buffer; unseal?: (b: Buffer) => Buffer }) {}

  async load(): Promise<WatchLinkRecord[]> {
    let body: { links?: unknown }
    try {
      body = JSON.parse((await fs.readFile(this.o.file, 'utf8')).replace(/\r\n/g, '\n'))
    } catch {
      return []
    }
    const out: WatchLinkRecord[] = []
    for (const e of Array.isArray(body?.links) ? (body.links as Partial<FileEntry>[]) : []) {
      if (!e || !str(e.linkId, 22) || !LINK_ID_RE.test(e.linkId) || !str(e.nodeId, 200) || !e.nodeId) continue
      if (e.role !== 'viewer' && e.role !== 'commenter') continue
      if (!str(e.label, 40) || !str(e.title, 80) || !num(e.createdAt) || !num(e.expiresAt) || typeof e.secret !== 'string') continue
      const secret = this.readSecret(e.secret, e.sealed === true)
      if (!secret || secret.length !== 32) continue
      out.push({ linkId: e.linkId, nodeId: e.nodeId, role: e.role, label: e.label, title: e.title, createdAt: e.createdAt, expiresAt: e.expiresAt, secret })
    }
    return out
  }

  private readSecret(b64: string, sealed: boolean): Uint8Array | null {
    try {
      const raw = Buffer.from(b64, 'base64')
      if (sealed) return this.o.unseal ? new Uint8Array(this.o.unseal(raw)) : null
      // A desktop (it can seal) never adopts a raw secret it finds on disk.
      return this.o.seal ? null : new Uint8Array(raw)
    } catch {
      return null
    }
  }

  async save(records: readonly WatchLinkRecord[]): Promise<SaveOutcome> {
    let links: FileEntry[]
    let outcome: SaveOutcome = 'saved'
    try {
      links = records.map((r) => ({
        linkId: r.linkId, nodeId: r.nodeId, role: r.role, label: r.label, title: r.title,
        createdAt: r.createdAt, expiresAt: r.expiresAt,
        secret: (this.o.seal ? this.o.seal(Buffer.from(r.secret)) : Buffer.from(r.secret)).toString('base64'),
        sealed: !!this.o.seal
      }))
    } catch {
      links = []
      outcome = 'memory-only'
    }
    const data = JSON.stringify({ v: 1, links })
    // Everything above ran synchronously at call time, so the chain is extended in call order.
    const write = this.writing.then(() => writeFileAtomic(this.o.file, data, { mode: 0o600 }))
    this.writing = write.catch(() => {})
    try {
      await write
      return outcome
    } catch {
      return 'failed'
    }
  }
}
