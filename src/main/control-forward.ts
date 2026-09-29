// Desktop main's half of a canvas-control call: forward it to the renderer's dispatch and wait for
// the one answer, bounded. Pulled out of `src/main/index.ts` (it was the `pendingControl` map) so
// the timeout and what follows it are tested by EFFECT rather than by reading index.ts.
//
// A TIMEOUT HERE IS NOT A REFUSAL. Main gives up waiting; the renderer is not told and does not
// stop. A confirm dialog dismisses itself at the same deadline (ConfirmState.expiresAt), but a verb
// with no dialog — an `open-worktree` whose `git worktree add` outlives the wait, an open whose
// issue lookup is slow — goes on and does its work after the caller was told it got no answer. So
// the timeout answers `indeterminate: true` (the request ledger then refuses a retry as "unknown"
// instead of running it a second time), and an answer that arrives afterwards is handed to the
// caller's `onLate` so the ledger can replay what really happened to the next retry.
import { randomUUID } from 'node:crypto'
import { isDestructiveVerb } from '../shared/control-verbs'
import { REQUEST_ID_VERBS } from '../core/control-request-ledger'

export interface ControlForwardReply {
  ok: boolean
  message?: string
  result?: unknown
  error?: string
  indeterminate?: boolean
}

/**
 * The timeout's sentence, by what the verb could still be doing. Only a confirm-gated verb may be
 * called safe to retry: its dialog is gone, so nothing was confirmed. Anything else may still
 * complete, and telling an agent it is safe to retry an open is how a second node gets opened.
 */
export function controlTimeoutError(verb: string, timeoutMs: number): string {
  const lead = `no answer within ${timeoutMs / 1000}s`
  if (isDestructiveVerb(verb)) return `${lead} — the confirmation dialog has been dismissed; safe to retry`
  if (REQUEST_ID_VERBS.has(verb)) {
    return (
      `${lead} — the request was not cancelled and may still complete, so it may have taken effect: ` +
      'retry the same command with the same --request-id to get its answer, or run `list` before ' +
      'opening anything again'
    )
  }
  return `${lead} — the request was not cancelled and may still complete; check its effect before retrying`
}

/** How long a late renderer answer is still worth handing back. Past it the ledger row stays
 *  unknown and a retry is told to `list`. */
export const LATE_CONTROL_ANSWER_MS = 30 * 60 * 1000

export function createControlForwarder(opts: {
  timeoutMs: number
  lateWindowMs?: number
  newId?: () => string
}): {
  /** Send via `send(requestId)` and wait for `answer` with that id, at most `timeoutMs`. */
  forward(
    verb: string,
    send: (requestId: string) => void,
    onLate?: (reply: ControlForwardReply) => void
  ): Promise<ControlForwardReply>
  /** The renderer's answer (the `agentControlResult` IPC). */
  answer(payload: { requestId: string } & ControlForwardReply): void
} {
  const newId = opts.newId ?? randomUUID
  const lateWindowMs = opts.lateWindowMs ?? LATE_CONTROL_ANSWER_MS
  const pending = new Map<string, { resolve: (r: ControlForwardReply) => void; timer: NodeJS.Timeout }>()
  const late = new Map<string, { onLate: (r: ControlForwardReply) => void; timer: NodeJS.Timeout }>()
  return {
    forward(verb, send, onLate) {
      const requestId = newId()
      return new Promise<ControlForwardReply>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          if (onLate) {
            const lateTimer = setTimeout(() => late.delete(requestId), lateWindowMs)
            late.set(requestId, { onLate, timer: lateTimer })
          }
          resolve({ ok: false, error: controlTimeoutError(verb, opts.timeoutMs), indeterminate: true })
        }, opts.timeoutMs)
        pending.set(requestId, { resolve, timer })
        send(requestId)
      })
    },
    answer({ requestId, ...reply }) {
      const waiting = pending.get(requestId)
      if (waiting) {
        clearTimeout(waiting.timer)
        pending.delete(requestId)
        waiting.resolve(reply)
        return
      }
      const after = late.get(requestId)
      if (!after) return
      clearTimeout(after.timer)
      late.delete(requestId)
      after.onLate(reply)
    }
  }
}
