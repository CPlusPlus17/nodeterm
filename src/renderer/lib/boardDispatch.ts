// Board dispatch decisions (pure). The consent it reads is `@shared/board-dispatch` (machine-local).
//
// THE TRIGGER, and why it is this one: a GitHub issue card that THIS PERSON drags (or moves with
// the card's Move control or the summary modal) into the project's dispatch column, and whose move
// GitHub CONFIRMED. The call site is the board's own move-result path — the one place a human
// gesture in this app reaches — so the trigger is provably local:
//   - a label change made on GitHub (by anyone, on a public repository by ANYONE) reaches this app
//     only as a refreshed page, which never calls this module with `origin: 'user-move'`;
//   - a column change arriving by `git pull` changes the shared board file, which no move-result
//     path reads either.
// The alternative (a GitHub label whose `labeled` actor is on a machine-local allowlist) would work
// from a phone, but it needs one issue-events read per candidate, the actor's identity compared
// against a credential that can change under it, and a poll that today runs only while a board is
// subscribed — i.e. a network-derived fact standing in for consent. v1 takes the gesture.
//
// Every refusal has a reason the card shows; `ignore` is for moves that were never a dispatch at all
// (another column, a project that is not switched on, a move GitHub did not confirm), which say
// nothing.

import type { BoardDispatch } from '@shared/board-dispatch'
import type { AgentState } from '@shared/agents/normalize'
import { issueKey, issueRefFromHtmlUrl, type IssueRef } from '@shared/github-issue-ref'

export type DispatchOrigin = 'user-move' | 'sync'

export interface DispatchTrigger {
  origin: DispatchOrigin
  projectId: string
  toColumnId: string | null
  /** The GitHub move's outcome (`GitHubIssueMoveResult['status']`). */
  moveStatus: string
  issue: { number: number; htmlUrl: string; state: 'open' | 'closed' }
}

export interface DispatchProjectFacts {
  /** An SSH project: its runs cannot start headless (v1 is local projects only). */
  remote: boolean
  /** A relay tab: the board belongs to another machine. */
  relay: boolean
}

export interface DispatchContext {
  dispatch: BoardDispatch
  project: DispatchProjectFacts | undefined
  completionColumnId?: string
  /** Whether the configured agent still exists on this machine (a custom agent may be deleted). */
  agentKnown: boolean
  /** Sessions bound to this issue that still exist, in any project. */
  boundRuns: number
  /** This issue is already queued or starting. */
  queuedOrStarting: boolean
  /** Runs of this project that hold a concurrency slot right now (`occupiesSlot`). */
  occupying: number
}

export type DispatchRefusal =
  | 'paused'
  | 'remote-project'
  | 'relay'
  | 'completion-column'
  | 'issue-closed'
  | 'no-reference'
  | 'agent-unavailable'
  | 'already-running'
  | 'already-queued'

export type DispatchDecision =
  | { kind: 'ignore' }
  | { kind: 'refuse'; reason: DispatchRefusal }
  | { kind: 'start'; ref: IssueRef; key: string }
  | { kind: 'queue'; ref: IssueRef; key: string }

/** The move statuses that mean GitHub now shows the card in the destination column. */
const LANDED = new Set(['confirmed', 'refresh-pending'])

export function decideDispatch(trigger: DispatchTrigger, ctx: DispatchContext): DispatchDecision {
  // Only a person's own move in this app. Anything else — a refresh that finds a card in the
  // column, a pulled board — is never a dispatch.
  if (trigger.origin !== 'user-move') return { kind: 'ignore' }
  const config = ctx.dispatch.projects[trigger.projectId]
  if (!config) return { kind: 'ignore' }
  if (trigger.toColumnId === null || trigger.toColumnId !== config.columnId) return { kind: 'ignore' }
  if (!LANDED.has(trigger.moveStatus)) return { kind: 'ignore' }
  if (ctx.dispatch.paused) return { kind: 'refuse', reason: 'paused' }
  if (!ctx.project || ctx.project.relay) return { kind: 'refuse', reason: 'relay' }
  if (ctx.project.remote) return { kind: 'refuse', reason: 'remote-project' }
  // A dispatch column that closes the issue would start work on an issue the same move closed.
  if (ctx.completionColumnId && ctx.completionColumnId === config.columnId) {
    return { kind: 'refuse', reason: 'completion-column' }
  }
  if (trigger.issue.state !== 'open') return { kind: 'refuse', reason: 'issue-closed' }
  const ref = issueRefFromHtmlUrl(trigger.issue.htmlUrl, trigger.issue.number)
  const key = issueKey(ref)
  if (!ref || !key) return { kind: 'refuse', reason: 'no-reference' }
  if (!ctx.agentKnown) return { kind: 'refuse', reason: 'agent-unavailable' }
  // At most one run per issue: an existing bound session (whatever its state) or one already on
  // its way. A second drag of the same card is a no-op that says so.
  if (ctx.queuedOrStarting) return { kind: 'refuse', reason: 'already-queued' }
  if (ctx.boundRuns > 0) return { kind: 'refuse', reason: 'already-running' }
  return ctx.occupying >= config.maxConcurrent ? { kind: 'queue', ref, key } : { kind: 'start', ref, key }
}

/** A person moving a card OUT of the dispatch column withdraws it: a queued dispatch is cancelled
 *  and a refusal line stops describing where the card is. (A run that already started is a session;
 *  moving the card never touches it.) */
export function moveWithdrawsDispatch(trigger: DispatchTrigger, dispatch: BoardDispatch): boolean {
  if (trigger.origin !== 'user-move') return false
  const config = dispatch.projects[trigger.projectId]
  return !!config && LANDED.has(trigger.moveStatus) && trigger.toColumnId !== config.columnId
}

export const DISPATCH_REFUSAL_TEXT: Record<DispatchRefusal, string> = {
  paused: 'Dispatch is paused on this machine.',
  'remote-project': 'Dispatch runs only on local projects for now (this is an SSH project).',
  relay: 'Dispatch is managed on the host of this shared project.',
  'completion-column': 'The dispatch column is also the completion column, which closes the issue.',
  'issue-closed': 'The issue is closed.',
  'no-reference': "The issue's GitHub address could not be read.",
  'agent-unavailable': 'The dispatch agent is not available on this machine. Choose one in Settings.',
  'already-running': 'This issue already has a session. Close it to dispatch again.',
  'already-queued': 'This issue is already queued or starting.'
}

// ── Concurrency slots ──────────────────────────────────────────────────────────────────────────

/** How often the queue is re-checked while something is queued. */
export const DISPATCH_DRAIN_MS = 5_000

/** A freshly started run holds its slot this long even before its first hook event. */
export const DISPATCH_STARTUP_GRACE_MS = 120_000

export interface RunSlotFact {
  state?: AgentState
  /** The node still holds a launch (queued, starting). */
  pending: boolean
  /** When dispatch started it, in this app run. */
  startedAt?: number
}

/**
 * Whether a bound session uses one of its project's slots. A turn in flight (working), a session
 * waiting on a person (waiting / blocked) and a launch not yet delivered all do; an idle session
 * (`done`) does not — the cap limits concurrent WORK, and a finished turn is idle whatever the issue
 * says. An UNKNOWN state (no hook event yet this app run) holds a slot only while it is a run this
 * app just started: otherwise every session from before a restart would pin the cap forever.
 */
export function occupiesSlot(fact: RunSlotFact, now: number): boolean {
  if (fact.pending) return true
  if (fact.state === 'working' || fact.state === 'waiting' || fact.state === 'blocked') return true
  if (fact.state === 'done') return false
  return fact.startedAt !== undefined && now - fact.startedAt < DISPATCH_STARTUP_GRACE_MS
}

// ── Queue ──────────────────────────────────────────────────────────────────────────────────────

export interface DispatchQueueEntry {
  key: string
  projectId: string
  ref: IssueRef
  number: number
  queuedAt: number
}

/**
 * The queued entries to start now, oldest first per project, never more than each project's free
 * slots. Paused → nothing. A project whose dispatch was switched off → nothing (its entries are
 * dropped by the caller, which also says why on the card).
 */
export function queueToStart(
  queue: readonly DispatchQueueEntry[],
  dispatch: BoardDispatch,
  occupying: (projectId: string) => number
): DispatchQueueEntry[] {
  if (dispatch.paused) return []
  const free = new Map<string, number>()
  const out: DispatchQueueEntry[] = []
  for (const entry of [...queue].sort((a, b) => a.queuedAt - b.queuedAt)) {
    const config = dispatch.projects[entry.projectId]
    if (!config) continue
    if (!free.has(entry.projectId)) free.set(entry.projectId, config.maxConcurrent - occupying(entry.projectId))
    const left = free.get(entry.projectId)!
    if (left <= 0) continue
    free.set(entry.projectId, left - 1)
    out.push(entry)
  }
  return out
}

/** Queue entries whose project no longer dispatches (switched off, or the machine paused it). */
export function queueToDrop(queue: readonly DispatchQueueEntry[], dispatch: BoardDispatch): DispatchQueueEntry[] {
  return queue.filter((e) => dispatch.paused || !dispatch.projects[e.projectId])
}
