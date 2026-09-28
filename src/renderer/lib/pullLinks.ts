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
//  - PR → issue → session card: a session started on an issue carries `issueRef`; every PR whose
//    `closingIssuesReferences` name that issue links to the card too. Here a fork's PR DOES count —
//    GitHub's own "Closes #N" is meaningful wherever the PR comes from, unlike a branch name. The
//    host remembers what a PR closed while it was open, so the link survives the merge. The same
//    tombstones apply.
import type { ProjectKanban } from '@shared/types'
import type { IssueRef } from '@shared/github-issue-ref'
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

/** The issue a card was started on, when it is in the repository these pull requests belong to —
 *  `closes` numbers mean nothing in any other repository. */
function sameRepositoryIssue(issueRef: IssueRef | undefined, repository: string | undefined): number | null {
  if (!issueRef || !repository) return null
  return `${issueRef.owner}/${issueRef.repo}`.toLocaleLowerCase('en-US') === repository.toLocaleLowerCase('en-US')
    ? issueRef.number
    : null
}

export function pullsForCard(
  card: { id: string; worktreeBranch?: string; issueRef?: IssueRef },
  pullBoard: GitHubPullBoard | undefined,
  board: ProjectKanban | undefined
): CardPullLinks {
  const issue = sameRepositoryIssue(card.issueRef, pullBoard?.repository)
  if ((!card.worktreeBranch && issue === null) || !pullBoard) return NONE
  const tombstones = new Set(readPullLinks(board)
    .unlinked.filter((entry) => entry.nodeId === card.id).map((entry) => entry.pull))
  const matches = pullBoard.pulls
    .filter((pull) =>
      (!!card.worktreeBranch && !pull.crossRepository && pull.headRefName === card.worktreeBranch) ||
      (issue !== null && pull.closes.includes(issue)))
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
