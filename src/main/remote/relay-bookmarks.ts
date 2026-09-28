// Hosted teams this desktop has joined, one bookmark per host (keyed by hostId).
//
// The join code is PUBLIC material. The device token is a relay credential scoped to this device
// and that host: it lets us ASK to join (the host still decides who gets in), and minting a new one
// spends a damped free-tier mint, so it is kept rather than re-minted. It is a credential all the
// same, so the file is written 0600.
//
// `approvedAt` is the JOINER-SIDE pin: set once both humans approved this device on that host, it is
// what lets a reconnect confirm our half without a SAS dialog — but only for the exact host key it
// was recorded against (see hosted-join.ts). It deliberately does NOT live in the desktop's
// approved-devices store, which counts paired phones.
import { promises as fs } from 'node:fs'
import { writeFileAtomic } from '../../core/fs-atomic'

export interface RelayBookmark {
  hostId: string
  /** The team's `nodeterm://join?code=…` string (public). */
  code: string
  /** The host's own label, from the code. */
  label: string
  /** This device's relay device token for that host, or null before the first mint. */
  deviceToken: string | null
  /** ISO time both humans first approved this device on that host, or null. */
  approvedAt: string | null
  source: 'code' | 'ssh'
}

/** What the renderer is shown of a bookmark: never its device token. */
export function publicBookmark(b: RelayBookmark): { hostId: string; label: string; approved: boolean; code: string } {
  return { hostId: b.hostId, label: b.label, approved: b.approvedAt !== null, code: b.code }
}

function valid(b: unknown): b is RelayBookmark {
  if (!b || typeof b !== 'object') return false
  const o = b as Record<string, unknown>
  return (
    typeof o.hostId === 'string' &&
    typeof o.code === 'string' &&
    typeof o.label === 'string' &&
    (o.deviceToken === null || typeof o.deviceToken === 'string') &&
    (o.approvedAt === null || typeof o.approvedAt === 'string') &&
    (o.source === 'code' || o.source === 'ssh')
  )
}

export class BookmarkStore {
  // Every write re-reads the file and is queued behind the previous one, so two concurrent writes
  // (a join persisting its token while an earlier join records its approval) never lose each other.
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  /** The bookmarks on disk. A missing or unreadable file reads as none; malformed entries are
   *  dropped. Reading never writes, so a corrupt file stays as it is until the next write. */
  async list(): Promise<RelayBookmark[]> {
    try {
      const j = JSON.parse(await fs.readFile(this.file, 'utf-8')) as unknown
      return Array.isArray(j) ? j.filter(valid) : []
    } catch {
      return []
    }
  }

  private write(fn: (l: RelayBookmark[]) => RelayBookmark[] | null): Promise<void> {
    const run = this.tail.then(async () => {
      const next = fn(await this.list())
      if (next) await writeFileAtomic(this.file, JSON.stringify(next, null, 2), { mode: 0o600 })
    })
    this.tail = run.catch(() => {})
    return run
  }

  /** Insert or replace the bookmark for `b.hostId`. */
  upsert(b: RelayBookmark): Promise<void> {
    return this.write((l) => [...l.filter((x) => x.hostId !== b.hostId), b])
  }

  /** Change fields of an EXISTING bookmark; a no-op when there is none. For updates that follow a
   *  connection's events, so a bookmark the user removed meanwhile is not brought back. */
  update(hostId: string, patch: Partial<Pick<RelayBookmark, 'deviceToken' | 'approvedAt'>>): Promise<void> {
    return this.write((l) => (l.some((x) => x.hostId === hostId) ? l.map((x) => (x.hostId === hostId ? { ...x, ...patch } : x)) : null))
  }

  remove(hostId: string): Promise<void> {
    return this.write((l) => l.filter((x) => x.hostId !== hostId))
  }
}
