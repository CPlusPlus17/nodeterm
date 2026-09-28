import { useEffect, useMemo, useRef } from 'react'
import type { ProjectKanban } from '@shared/types'
import type { GitHubIssuesApi } from '@shared/github-issues'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import { sanitizeKanbanPullAutoMove } from '@shared/kanban-pull-links'
import { useSettings } from '../../state/settings'
import { useProjects } from '../../state/projects'
import { autoMoveNote, planPullAutoMoves } from '../../lib/pullAutoMove'
import { documentChaseDeps, startPullChase } from '../../lib/pullChase'

/**
 * Runs the merge-driven move for SESSION cards while the board is open (the pull status it reads is
 * only fresh while a board is subscribed). All decisions are `planPullAutoMoves`, which writes
 * nothing; this glue asks the host for each move's one-time claim and applies only the moves it wins,
 * through `onAutoMove` (a compare-and-set against the latest board + the board-log line). It never
 * writes settings: a background settings write from one Server Edition tab would overwrite whatever
 * the user just changed in another.
 */
export function usePullAutoMove(input: {
  api: Pick<GitHubIssuesApi, 'claimPullAutoMove'>
  projectId: string
  cards: Array<{ id: string; kind: string; worktreeBranch?: string }>
  board: ProjectKanban
  pullBoard: GitHubPullBoard | undefined
  onAutoMove?: (cardId: string, fromColumnId: string | null, toColumnId: string, note: string) => void
}): void {
  const raw = useSettings((state) => state.settings.kanbanPullAutoMove)
  // A relay tab is another machine's project: that machine decides whether its board moves itself.
  // Settings refuses to arm one; this is the backstop for a hand-edited settings.json.
  const relay = useProjects((state) => !!state.projects.find((item) => item.id === input.projectId)?.remote)
  const entry = useMemo(
    () => relay ? undefined : sanitizeKanbanPullAutoMove(raw).projects[input.projectId],
    [raw, input.projectId, relay]
  )
  const { api, projectId, cards, board, pullBoard, onAutoMove } = input
  // The BOARD's lifetime, not one effect run: the pull board is re-read every minute, and a re-render
  // landing between a won claim and its answer must not throw the move away — the claim is spent
  // either way, so dropping it would lose the move for good.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const latest = useRef(onAutoMove)
  latest.current = onAutoMove
  useEffect(() => {
    if (!entry || !onAutoMove) return
    for (const move of planPullAutoMoves({ cards, board, pullBoard, entry }).moves) {
      void api.claimPullAutoMove({ projectId, cardId: move.cardId, pulls: move.pulls })
        .then((claimed) => {
          // A claim that lands after this board closed is spent, not applied: the card stays where it
          // is, which is the safe side of a lost move. The move itself is a compare-and-set against
          // the latest board, so a late answer cannot undo a drag made meanwhile.
          if (claimed && mounted.current) {
            latest.current?.(move.cardId, move.fromColumnId, entry.columnId, autoMoveNote(move.pulls))
          }
        })
        .catch(() => undefined)
    }
  }, [api, entry, cards, board, pullBoard, projectId, onAutoMove])
}

/** While some PR is undecided, ask the host (only while the page is visible) whether a chase read
 *  is due. The host keeps the schedule and the cap. */
export function usePullChase(api: GitHubIssuesApi, projectId: string, undecided: boolean): void {
  useEffect(() => {
    if (!undecided || !projectId) return
    return startPullChase(documentChaseDeps(() => {
      void api.chasePulls(projectId).catch(() => undefined)
    }))
  }, [api, projectId, undecided])
}
