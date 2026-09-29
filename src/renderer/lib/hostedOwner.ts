// An OWNER's relay tab on a hosted team: listen for devices asking to join and answer them.
//
// Subscribe FIRST, then pull (R25). The host tells a connected owner every open request as it
// arrives and replays the open ones when the owner's session opens — that replay can land before
// this tab subscribed, and the pull (`relay:hosted:pending`) is what makes that safe. The queue
// de-dupes, so the two overlapping is harmless. See docs/hosted-team-relay.md.
import type { HostedPendingClosedReason, HostedRole, HostedSessionApi } from '@shared/types'
import type { QueuedRequest } from './hostedPendingQueue'
import { stripIpcPrefix } from './hostedTeam'

export interface OwnerQueueSink {
  add(item: QueuedRequest): void
  close(pendingId: string, reason: HostedPendingClosedReason): void
  /** The tab is going away: drop its requests. */
  drop(projectId: string): void
}

/** Start feeding one owner tab's requests into the queue. Returns its teardown (idempotent). */
export function attachHostedOwner(
  hosted: HostedSessionApi,
  ctx: { projectId: string; teamLabel: string },
  sink: OwnerQueueSink
): () => void {
  let live = true
  const add = (pending: unknown): void => {
    if (live) sink.add({ projectId: ctx.projectId, teamLabel: ctx.teamLabel, pending: pending as QueuedRequest['pending'], answerer: hosted })
  }
  const unPending = hosted.onPeerPending(add)
  const unClosed = hosted.onPendingClosed((c) => {
    if (live && c && typeof c.pendingId === 'string') sink.close(c.pendingId, c.reason)
  })
  hosted.pending().then(
    (list) => {
      if (Array.isArray(list)) for (const p of list) add(p)
    },
    // A failed pull (the tab dropped, the host refused) costs only the replay safety net: the push
    // deltas keep arriving, and a reconnect pulls again.
    () => {}
  )
  return () => {
    if (!live) return
    live = false
    unPending()
    unClosed()
    sink.drop(ctx.projectId)
  }
}

export type HostedAnswer = { kind: 'approve'; role: HostedRole } | { kind: 'deny' }

/** Send an owner's answer. Resolves with the line to show the owner, or null when it landed. */
export async function answerHostedRequest(
  item: QueuedRequest,
  answer: HostedAnswer
): Promise<{ kind: 'info' | 'error'; text: string } | null> {
  const id = item.pending.pendingId
  try {
    const ok = answer.kind === 'approve' ? await item.answerer.approve(id, answer.role) : await item.answerer.deny(id)
    // False is an answer, not a failure: another owner got there first, or the device left.
    return ok ? null : { kind: 'info', text: 'That request was already answered or has gone.' }
  } catch (err) {
    return { kind: 'error', text: `Could not answer the request: ${stripIpcPrefix(err instanceof Error ? err.message : String(err))}` }
  }
}
