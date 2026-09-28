// Which pull requests belong to which board card — pure, so the card, the card modal and the
// auto-move all read ONE answer.
//
// Two links, both derived from GitHub's own facts rather than guessed from text:
//  - PR → issue: GitHub's `closingIssuesReferences` (a "Closes #N" GitHub will act on at merge).
//    Deliberately NOT unlinkable on the board: GitHub closes the issue on merge whatever the board
//    shows, so hiding the link would only hide what is going to happen. Edit the PR to change it.
//  - PR → session card: the PR's head branch equals the branch of the worktree the card's group is
//    bound to (`data.worktree.branch`, persisted on the group — no git read is needed to know it).
//    A fork's PR never links: 36 of this repository's 50 open PRs come from forks, and a fork's
//    `feat/x` says nothing about this checkout's `feat/x`. The user can remove a link; the
//    tombstone (`ProjectKanban.pullLinks.unlinked`) keeps the auto-link from coming back.
import type { ProjectKanban } from '@shared/types'
import type { GitHubPullBoard, GitHubPullStatus } from '@shared/github-pull-status'
import { readPullLinks } from '@shared/kanban-pull-links'

const LIFECYCLE_ORDER = { open: 0, draft: 1, merged: 2, closed: 3 } as const

function byRelevance(a: GitHubPullStatus, b: GitHubPullStatus): number {
  return LIFECYCLE_ORDER[a.lifecycle] - LIFECYCLE_ORDER[b.lifecycle] || b.number - a.number
}

export interface CardPullLinks {
  /** PRs whose head is this card's worktree branch, minus the ones the user unlinked. */
  linked: GitHubPullStatus[]
  /** Branch matches the user unlinked — offered back as "Link again". */
  unlinked: GitHubPullStatus[]
}

const NONE: CardPullLinks = { linked: [], unlinked: [] }

export function pullsForCard(
  card: { id: string; worktreeBranch?: string },
  pullBoard: GitHubPullBoard | undefined,
  board: ProjectKanban | undefined
): CardPullLinks {
  if (!card.worktreeBranch || !pullBoard) return NONE
  const tombstones = new Set(readPullLinks(board)
    .unlinked.filter((entry) => entry.nodeId === card.id).map((entry) => entry.pull))
  const matches = pullBoard.pulls
    .filter((pull) => !pull.crossRepository && pull.headRefName === card.worktreeBranch)
    .sort(byRelevance)
  if (!matches.length) return NONE
  return {
    linked: matches.filter((pull) => !tombstones.has(pull.number)),
    unlinked: matches.filter((pull) => tombstones.has(pull.number))
  }
}

/** Open pull requests that close this issue when they merge. */
export function pullsClosingIssue(
  issueNumber: number,
  pullBoard: GitHubPullBoard | undefined
): GitHubPullStatus[] {
  if (!pullBoard) return []
  return pullBoard.pulls
    .filter((pull) => (pull.lifecycle === 'open' || pull.lifecycle === 'draft') &&
      pull.closes.includes(issueNumber))
    .sort(byRelevance)
}

export function pullStatusByNumber(pullBoard: GitHubPullBoard | undefined): Map<number, GitHubPullStatus> {
  return new Map((pullBoard?.pulls ?? []).map((pull) => [pull.number, pull]))
}
