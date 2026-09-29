import type { BoardLogEntry } from '@shared/types'
import {
  boardCommentOutcomeText,
  commentIdOfSource,
  parseMentions,
  type BoardCommentOutcomeView
} from '@shared/board-comment'
import type { MentionDelivery } from '../state/boardCommentDelivery'

/** One mention's delivery, as a comment row shows it. */
export interface MentionStatus {
  nodeId: string
  view: BoardCommentOutcomeView
}

interface TraceOutcome {
  ts: number
  kind: string
  reason?: string
}

/** Is this log line a delivery outcome a board comment produced? (`agent-message` with a
 *  `board-comment:<id>` source.) Such lines belong ON their comment's row, not as rows of their own. */
export function isBoardCommentTrace(e: BoardLogEntry): boolean {
  return e.kind === 'event' && e.event?.type === 'agent-message' && commentIdOfSource(e.event.from) !== null
}

/** Every board-comment delivery outcome in a log, reduced to the LATEST per (comment, target). The
 *  log is a shared file, so every field is re-checked as the type it must be before it is used. */
export function boardCommentTraces(
  entries: readonly BoardLogEntry[]
): Map<string, Map<string, TraceOutcome>> {
  const out = new Map<string, Map<string, TraceOutcome>>()
  for (const e of entries) {
    if (!isBoardCommentTrace(e)) continue
    const ev = e.event!
    const commentId = commentIdOfSource(ev.from)!
    if (typeof ev.to !== 'string' || typeof ev.title !== 'string' || typeof e.ts !== 'number') continue
    const byTarget = out.get(commentId) ?? new Map<string, TraceOutcome>()
    const prev = byTarget.get(ev.to)
    if (!prev || e.ts >= prev.ts)
      byTarget.set(ev.to, {
        ts: e.ts,
        kind: ev.title,
        ...(typeof ev.reason === 'string' ? { reason: ev.reason } : {})
      })
    out.set(commentId, byTarget)
  }
  return out
}

function viewOf(d: MentionDelivery): BoardCommentOutcomeView {
  if (d.state === 'sending') return { tone: 'pending', text: 'sending…' }
  if (d.kind === 'error') return { tone: 'error', text: `not delivered — ${d.error ?? 'unknown error'}` }
  return boardCommentOutcomeText(d.kind, d.reason)
}

/**
 * The delivery status of each session a comment mentions, in the order the text mentions them: the
 * newer of this app run's own record (`transient`) and the latest outcome the log holds. A mention
 * with neither shows nothing — a comment that arrived by git pull, from a relay peer or from before
 * this feature was never delivered by this app, and the row must not suggest otherwise.
 */
export function mentionStatuses(
  comment: BoardLogEntry,
  traces: Map<string, Map<string, TraceOutcome>>,
  transient?: Record<string, MentionDelivery>
): MentionStatus[] {
  if (comment.kind !== 'comment' || typeof comment.text !== 'string') return []
  const logged = traces.get(comment.id)
  const out: MentionStatus[] = []
  for (const nodeId of parseMentions(comment.text)) {
    const t = logged?.get(nodeId)
    const live = transient?.[nodeId]
    if (live && (!t || live.at >= t.ts)) out.push({ nodeId, view: viewOf(live) })
    else if (t) out.push({ nodeId, view: boardCommentOutcomeText(t.kind, t.reason) })
  }
  return out
}
