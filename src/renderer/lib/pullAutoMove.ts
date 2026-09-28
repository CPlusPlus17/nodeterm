// Moving a session card when the work it tracks has merged — the decision, pure.
//
// SESSION CARDS ONLY. A GitHub issue card is never moved here: GitHub already closes an issue when a
// PR with "Closes #N" merges, and a second writer would race it (and could overwrite the
// `state_reason` GitHub records). The board shows that close through its normal sync.
//
// The guards, in this order, each a refusal:
//   1. the card opted out                      → never
//   2. no linked PR                            → nothing to decide
//   3. any linked PR still open or a draft     → wait
//   4. any linked PR closed WITHOUT merging    → blocked until the user removes that link; an
//                                                abandoned PR is not finished work
//   5. already in the target column            → nothing to do
//   6. all merged, but this machine never saw one of them open → no move: it only acts on a
//      transition it observed, so arming the switch (or cloning a repo whose PRs merged long ago)
//      never sweeps old cards across the board.
import type { ProjectKanban } from '@shared/types'
import type { GitHubPullBoard, PullLifecycle } from '@shared/github-pull-status'
import { readPullLinks, type KanbanPullAutoMoveEntry } from '@shared/kanban-pull-links'
import { assignNode, columnForNode } from './kanban'
import { pullsForCard } from './pullLinks'

export type PullAutoMoveDecision =
  | { kind: 'move'; pulls: number[] }
  | {
    kind: 'none'
    reason: 'opted-out' | 'no-links' | 'waiting' | 'blocked' | 'in-target' | 'no-transition'
  }

export function decidePullAutoMove(input: {
  optedOut: boolean
  linked: Array<{ number: number; lifecycle: PullLifecycle }>
  /** What this machine last saw for this card, by PR number. */
  seen: Record<string, PullLifecycle> | undefined
  columnId: string | null
  targetColumnId: string
}): PullAutoMoveDecision {
  if (input.optedOut) return { kind: 'none', reason: 'opted-out' }
  if (input.linked.length === 0) return { kind: 'none', reason: 'no-links' }
  if (input.linked.some((pull) => pull.lifecycle === 'open' || pull.lifecycle === 'draft')) {
    return { kind: 'none', reason: 'waiting' }
  }
  if (input.linked.some((pull) => pull.lifecycle === 'closed')) return { kind: 'none', reason: 'blocked' }
  if (input.columnId === input.targetColumnId) return { kind: 'none', reason: 'in-target' }
  const observed = input.linked.some((pull) => {
    const before = input.seen?.[String(pull.number)]
    return before === 'open' || before === 'draft'
  })
  if (!observed) return { kind: 'none', reason: 'no-transition' }
  return { kind: 'move', pulls: input.linked.map((pull) => pull.number).sort((a, b) => a - b) }
}

/** The card's next "last seen" record: exactly its linked PRs, as they are now. Returns the SAME
 *  object when nothing changed, so an unchanged observation writes nothing to settings. */
export function nextSeen(
  previous: Record<string, PullLifecycle> | undefined,
  linked: Array<{ number: number; lifecycle: PullLifecycle }>
): Record<string, PullLifecycle> | undefined {
  if (!linked.length) return undefined
  const next = Object.fromEntries(linked.map((pull) => [String(pull.number), pull.lifecycle]))
  if (previous && Object.keys(previous).length === linked.length &&
      linked.every((pull) => previous[String(pull.number)] === pull.lifecycle)) return previous
  return next
}

/**
 * The move itself, as a compare-and-set: it applies only if the card is still in the column the
 * decision saw (a teammate's pull, a drag a moment ago, or another window's move all make it a
 * no-op) and the target column still exists. Null = nothing to write.
 */
export function applyPullAutoMove(
  board: ProjectKanban,
  cardId: string,
  expectedColumnId: string | null,
  targetColumnId: string
): ProjectKanban | null {
  const current = columnForNode(board, cardId)?.id ?? null
  if (current !== expectedColumnId || current === targetColumnId) return null
  if (!board.columns.some((column) => column.id === targetColumnId)) return null
  return assignNode(board, cardId, targetColumnId, null)
}

/** The board-log line's reason: it names the PRs, so the move can be traced to what caused it. */
export function autoMoveNote(pulls: number[]): string {
  const list = pulls.map((number) => `#${number}`).join(', ')
  return pulls.length === 1 ? `PR ${list} merged` : `PRs ${list} merged`
}

/** The board cards the auto-move may touch: the SESSION source, and only it. An issue card is not
 *  in this list by construction, and the planner re-checks the kind rather than trusting callers. */
const SESSION_CARD_KINDS = new Set(['terminal', 'sticky', 'browser'])

export interface PullAutoMovePlan {
  moves: Array<{ cardId: string; fromColumnId: string | null; pulls: number[] }>
  /** This project's next last-seen map, or null when nothing changed (write nothing). */
  seen: NonNullable<KanbanPullAutoMoveEntry['seen']> | null
}

/**
 * One pass over the board: what to move, and what this machine has now seen. Nothing happens while
 * the switch is off, while the pull status is unknown or STALE (a decision on a snapshot GitHub
 * could not confirm is a guess), or while the target column does not exist.
 */
export function planPullAutoMoves(input: {
  cards: Array<{ id: string; kind: string; worktreeBranch?: string }>
  board: ProjectKanban
  pullBoard: GitHubPullBoard | undefined
  entry: KanbanPullAutoMoveEntry | undefined
}): PullAutoMovePlan {
  const idle: PullAutoMovePlan = { moves: [], seen: null }
  const { entry, pullBoard, board } = input
  if (!entry || !pullBoard || pullBoard.observedAt === undefined || pullBoard.stale) return idle
  if (!board.columns.some((column) => column.id === entry.columnId)) return idle
  const optedOut = new Set(readPullLinks(board).noAutoMove)
  const previous = entry.seen ?? {}
  const seen: NonNullable<KanbanPullAutoMoveEntry['seen']> = {}
  const moves: PullAutoMovePlan['moves'] = []
  for (const card of input.cards) {
    if (!SESSION_CARD_KINDS.has(card.kind)) continue
    const linked = pullsForCard(card, pullBoard, board).linked
      .map((pull) => ({ number: pull.number, lifecycle: pull.lifecycle }))
    const fromColumnId = columnForNode(board, card.id)?.id ?? null
    const decision = decidePullAutoMove({
      optedOut: optedOut.has(card.id),
      linked,
      seen: previous[card.id],
      columnId: fromColumnId,
      targetColumnId: entry.columnId
    })
    if (decision.kind === 'move') moves.push({ cardId: card.id, fromColumnId, pulls: decision.pulls })
    const next = nextSeen(previous[card.id], linked)
    if (next) seen[card.id] = next
  }
  const changed = Object.keys(seen).length !== Object.keys(previous).length ||
    Object.entries(seen).some(([cardId, value]) => previous[cardId] !== value)
  return { moves, seen: changed ? seen : null }
}
