import { useEffect, useMemo } from 'react'
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
 * only fresh while a board is subscribed). All decisions are `planPullAutoMoves`; this glue only
 * applies them: each move goes to `onAutoMove`, which compare-and-sets against the latest board and
 * writes the board-log line, and the last-seen map goes to this machine's settings.
 */
export function usePullAutoMove(input: {
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
  const { projectId, cards, board, pullBoard, onAutoMove } = input
  useEffect(() => {
    if (!entry || !onAutoMove) return
    const plan = planPullAutoMoves({ cards, board, pullBoard, entry })
    if (plan.seen !== null) {
      // Recorded BEFORE the moves: a re-run triggered by the move then sees the transition as
      // consumed. A move whose compare-and-set fails (the user moved the card meanwhile) is not
      // retried — the user's placement wins.
      const current = sanitizeKanbanPullAutoMove(useSettings.getState().settings.kanbanPullAutoMove)
      const own = current.projects[projectId]
      if (own) {
        const { seen: _old, ...rest } = own
        useSettings.getState().update({
          kanbanPullAutoMove: {
            projects: {
              ...current.projects,
              [projectId]: Object.keys(plan.seen).length ? { ...rest, seen: plan.seen } : rest
            }
          }
        })
      }
    }
    for (const move of plan.moves) {
      onAutoMove(move.cardId, move.fromColumnId, entry.columnId, autoMoveNote(move.pulls))
    }
  }, [entry, cards, board, pullBoard, projectId, onAutoMove])
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
