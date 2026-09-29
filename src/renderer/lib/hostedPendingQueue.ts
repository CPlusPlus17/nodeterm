// The owner's queue of devices waiting to join a hosted team — pure, so the rules are testable
// without React. The host allows up to 16 requests at once (one per device key), so a single "the
// pending request" slot would silently drop the second knock (R37): every open request is kept,
// keyed by pendingId, oldest first, and the dialog shows the head. Seeded by the pull an owner's tab
// makes on open (R25); the push events are deltas after that, and either may repeat the other.
import type { HostedPending, HostedPendingClosedReason, HostedRole } from '@shared/types'
import { pendingClosedNotice } from './hostedTeam'

/** Where an answer goes: the hosted verbs of the session that raised the request. */
export interface HostedAnswerer {
  approve(pendingId: string, role: HostedRole): Promise<boolean>
  deny(pendingId: string): Promise<boolean>
}

export interface QueuedRequest {
  /** The owner's relay tab the request arrived on (a tab that goes away takes its own requests). */
  projectId: string
  teamLabel: string
  pending: HostedPending
  answerer: HostedAnswerer
}

export interface PendingQueue {
  items: readonly QueuedRequest[]
  /** Requests already answered here or closed at the host, most recent last: a late replay or pull
   *  of one must not bring its dialog back. */
  settled: readonly string[]
  /** Requests whose answer is on its way: off the screen, and not re-added by a replay meanwhile.
   *  Settled only once the host answers; an answer that never landed leaves them answerable. */
  answering?: readonly string[]
}

export const EMPTY_PENDING_QUEUE: PendingQueue = Object.freeze({ items: [], settled: [], answering: [] })

/** How many closed request ids are remembered (4× the host's concurrent cap). */
export const SETTLED_MEMORY = 64

/** A request as the host sends it — these arrive off the wire, so the shape is checked here. */
function wellFormed(p: unknown): p is HostedPending {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return (
    typeof o.pendingId === 'string' &&
    o.pendingId.length > 0 &&
    typeof o.sas === 'string' &&
    typeof o.peerKeyB64 === 'string' &&
    typeof o.since === 'number' &&
    Number.isFinite(o.since)
  )
}

const remember = (settled: readonly string[], id: string): string[] =>
  [...settled.filter((x) => x !== id), id].slice(-SETTLED_MEMORY)

/** Add a request (a push, or one entry of the pull). Unchanged when it is malformed, already queued
 *  or already settled. Kept oldest first; a tie keeps arrival order. */
export function addRequest(q: PendingQueue, item: QueuedRequest): PendingQueue {
  if (!wellFormed(item.pending)) return q
  const id = item.pending.pendingId
  if (q.settled.includes(id) || (q.answering ?? []).includes(id) || q.items.some((i) => i.pending.pendingId === id)) return q
  const at = q.items.findIndex((i) => i.pending.since > item.pending.since)
  const items = at < 0 ? [...q.items, item] : [...q.items.slice(0, at), item, ...q.items.slice(at)]
  return { ...q, items }
}

/** The host says a request is no longer pending. `notice` is set only when it was the one on
 *  screen and ANOTHER owner answered it (approved/denied); expired/gone/replaced close silently. */
export function closeRequest(
  q: PendingQueue,
  pendingId: string,
  reason: HostedPendingClosedReason
): { queue: PendingQueue; notice: string | null } {
  const wasHead = headRequest(q)?.pending.pendingId === pendingId
  const queue: PendingQueue = {
    items: q.items.filter((i) => i.pending.pendingId !== pendingId),
    settled: remember(q.settled, pendingId),
    answering: (q.answering ?? []).filter((x) => x !== pendingId)
  }
  return { queue, notice: wasHead ? pendingClosedNotice(reason) : null }
}

/** Remember a request as answered for good (the host's own close follows). */
export function settleRequest(q: PendingQueue, pendingId: string): PendingQueue {
  return {
    items: q.items.filter((i) => i.pending.pendingId !== pendingId),
    settled: remember(q.settled, pendingId),
    answering: (q.answering ?? []).filter((x) => x !== pendingId)
  }
}

/** This owner answered: the request leaves the screen now, and a replay cannot bring it back while
 *  the answer is on its way. */
export function beginAnswer(q: PendingQueue, pendingId: string): PendingQueue {
  return {
    ...q,
    items: q.items.filter((i) => i.pending.pendingId !== pendingId),
    answering: [...(q.answering ?? []).filter((x) => x !== pendingId), pendingId]
  }
}

/** The answer came back. `landed` (the host said true or false) settles it; an answer that never
 *  landed (the tab dropped, the call failed) leaves it answerable: the reconnect's pull brings the
 *  request back if it is still pending (R40). */
export function finishAnswer(q: PendingQueue, pendingId: string, landed: boolean): PendingQueue {
  if (landed) return settleRequest(q, pendingId)
  return { ...q, answering: (q.answering ?? []).filter((x) => x !== pendingId) }
}

/** The owner's tab went away (dropped, closed): its requests leave the queue unanswered — its
 *  reconnect pulls them again, so they are not marked settled. */
export function dropProjectRequests(q: PendingQueue, projectId: string): PendingQueue {
  const items = q.items.filter((i) => i.projectId !== projectId)
  return items.length === q.items.length ? q : { ...q, items }
}

/** The request the dialog shows: the oldest one. */
export function headRequest(q: PendingQueue): QueuedRequest | null {
  return q.items[0] ?? null
}
