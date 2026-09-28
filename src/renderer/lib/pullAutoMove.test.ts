import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import type { GitHubPullBoard, GitHubPullStatus } from '@shared/github-pull-status'
import { setNoAutoMove, unlinkPull } from '@shared/kanban-pull-links'
import {
  applyPullAutoMove,
  autoMoveNote,
  decidePullAutoMove,
  nextSeen,
  planPullAutoMoves
} from './pullAutoMove'

const board = (over: Partial<ProjectKanban> = {}): ProjectKanban => ({
  columns: [
    { id: 'doing', title: 'Doing', color: '#0a84ff' },
    { id: 'done', title: 'Done', color: '#30d158' }
  ],
  assignments: [{ nodeId: 'card-1', columnId: 'doing' }],
  ...over
})

const pull = (number: number, lifecycle: GitHubPullStatus['lifecycle'], over: Partial<GitHubPullStatus> = {}): GitHubPullStatus =>
  ({ number, lifecycle, headRefName: 'feat/x', closes: [], ...over })

const pulls = (items: GitHubPullStatus[], over: Partial<GitHubPullBoard> = {}): GitHubPullBoard => ({
  pulls: items, observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false,
  truncated: false, ...over
})

const card = { id: 'card-1', kind: 'terminal', worktreeBranch: 'feat/x' }
const entry = (seen?: Record<string, Record<string, 'open' | 'draft' | 'merged' | 'closed'>>) =>
  ({ columnId: 'done', ...(seen ? { seen } : {}) })

describe('decidePullAutoMove — the guard order', () => {
  const base = { optedOut: false, seen: { '1': 'open' as const }, columnId: 'doing', targetColumnId: 'done' }

  it('an opted-out card never moves, even when everything merged', () => {
    expect(decidePullAutoMove({ ...base, optedOut: true, linked: [{ number: 1, lifecycle: 'merged' }] }))
      .toEqual({ kind: 'none', reason: 'opted-out' })
  })

  it('waits while any linked PR is open or a draft', () => {
    expect(decidePullAutoMove({ ...base, linked: [
      { number: 1, lifecycle: 'merged' }, { number: 2, lifecycle: 'draft' }
    ] })).toEqual({ kind: 'none', reason: 'waiting' })
  })

  it('a PR closed without merging blocks the move', () => {
    expect(decidePullAutoMove({ ...base, linked: [
      { number: 1, lifecycle: 'merged' }, { number: 2, lifecycle: 'closed' }
    ] })).toEqual({ kind: 'none', reason: 'blocked' })
  })

  it('moves only on a transition this machine observed', () => {
    const linked = [{ number: 1, lifecycle: 'merged' as const }]
    expect(decidePullAutoMove({ ...base, linked })).toEqual({ kind: 'move', pulls: [1] })
    expect(decidePullAutoMove({ ...base, linked, seen: undefined }))
      .toEqual({ kind: 'none', reason: 'no-transition' })
    expect(decidePullAutoMove({ ...base, linked, seen: { '1': 'merged' } }))
      .toEqual({ kind: 'none', reason: 'no-transition' })
  })

  it('does nothing for a card already in the target column', () => {
    expect(decidePullAutoMove({ ...base, columnId: 'done', linked: [{ number: 1, lifecycle: 'merged' }] }))
      .toEqual({ kind: 'none', reason: 'in-target' })
  })
})

describe('applyPullAutoMove — compare-and-set', () => {
  it('moves the card from the column the decision saw', () => {
    expect(applyPullAutoMove(board(), 'card-1', 'doing', 'done')?.assignments)
      .toEqual([{ nodeId: 'card-1', columnId: 'done' }])
  })

  it('does nothing when the card moved since the decision', () => {
    expect(applyPullAutoMove(board(), 'card-1', null, 'done')).toBeNull()
  })

  it('does nothing when the target column is gone', () => {
    expect(applyPullAutoMove(board(), 'card-1', 'doing', 'deleted')).toBeNull()
  })
})

describe('planPullAutoMoves', () => {
  it('moves a card whose only PR went from open to merged, and records what it saw', () => {
    const plan = planPullAutoMoves({
      cards: [card], board: board(), pullBoard: pulls([pull(1, 'merged')]), entry: entry({ 'card-1': { '1': 'open' } })
    })
    expect(plan.moves).toEqual([{ cardId: 'card-1', fromColumnId: 'doing', pulls: [1] }])
    expect(plan.seen).toEqual({ 'card-1': { '1': 'merged' } })
  })

  it('arming the switch over PRs that merged long ago moves nothing, it only records them', () => {
    const plan = planPullAutoMoves({
      cards: [card], board: board(), pullBoard: pulls([pull(1, 'merged')]), entry: entry()
    })
    expect(plan.moves).toEqual([])
    expect(plan.seen).toEqual({ 'card-1': { '1': 'merged' } })
  })

  it('does nothing at all while the switch is off, the status is stale, or unknown', () => {
    const seenOpen = entry({ 'card-1': { '1': 'open' } })
    const merged = pulls([pull(1, 'merged')])
    expect(planPullAutoMoves({ cards: [card], board: board(), pullBoard: merged, entry: undefined }))
      .toEqual({ moves: [], seen: null })
    expect(planPullAutoMoves({ cards: [card], board: board(), pullBoard: { ...merged, stale: true }, entry: seenOpen }))
      .toEqual({ moves: [], seen: null })
    expect(planPullAutoMoves({ cards: [card], board: board(), pullBoard: undefined, entry: seenOpen }))
      .toEqual({ moves: [], seen: null })
  })

  it('an unlinked PR does not count, and an opted-out card stays put', () => {
    const seenOpen = entry({ 'card-1': { '1': 'open' } })
    const merged = pulls([pull(1, 'merged')])
    expect(planPullAutoMoves({ cards: [card], board: unlinkPull(board(), 'card-1', 1), pullBoard: merged, entry: seenOpen }).moves)
      .toEqual([])
    expect(planPullAutoMoves({ cards: [card], board: setNoAutoMove(board(), 'card-1', true), pullBoard: merged, entry: seenOpen }).moves)
      .toEqual([])
  })

  it('a closed-unmerged sibling blocks until the user removes that link', () => {
    const seenOpen = entry({ 'card-1': { '1': 'open', '2': 'open' } })
    const both = pulls([pull(1, 'merged'), pull(2, 'closed')])
    expect(planPullAutoMoves({ cards: [card], board: board(), pullBoard: both, entry: seenOpen }).moves).toEqual([])
    expect(planPullAutoMoves({ cards: [card], board: unlinkPull(board(), 'card-1', 2), pullBoard: both, entry: seenOpen }).moves)
      .toEqual([{ cardId: 'card-1', fromColumnId: 'doing', pulls: [1] }])
  })

  it('a fork PR on a same-named branch is not this card\'s work', () => {
    const plan = planPullAutoMoves({
      cards: [card], board: board(), pullBoard: pulls([pull(1, 'merged', { crossRepository: true })]),
      entry: entry({ 'card-1': { '1': 'open' } })
    })
    expect(plan.moves).toEqual([])
  })

  it('GitHub issue cards are never moved — GitHub closes them itself', () => {
    const plan = planPullAutoMoves({
      cards: [{ id: 'github:12', kind: 'github', worktreeBranch: 'feat/x' }],
      board: board({ assignments: [{ nodeId: 'github:12', columnId: 'doing' }] }),
      pullBoard: pulls([pull(1, 'merged', { closes: [12] })]),
      entry: entry({ 'github:12': { '1': 'open' } })
    })
    expect(plan.moves).toEqual([])
  })

  it('the planner and its hook never reach the GitHub issue write path', () => {
    for (const file of ['pullAutoMove.ts', '../components/kanban/usePullAutoMove.ts']) {
      const source = readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n')
      expect(source).not.toMatch(/moveIssue|githubIssues\s*\.\s*move|updateIssue/)
    }
  })

  it('writes nothing when nothing changed', () => {
    const seen = { 'card-1': { '1': 'open' as const } }
    expect(planPullAutoMoves({ cards: [card], board: board(), pullBoard: pulls([pull(1, 'open')]), entry: entry(seen) }).seen)
      .toBeNull()
  })
})

describe('helpers', () => {
  it('nextSeen keeps identity when unchanged', () => {
    const previous = { '1': 'open' as const }
    expect(nextSeen(previous, [{ number: 1, lifecycle: 'open' }])).toBe(previous)
    expect(nextSeen(previous, [{ number: 1, lifecycle: 'merged' }])).toEqual({ '1': 'merged' })
    expect(nextSeen(previous, [])).toBeUndefined()
  })

  it('names the PRs in the board-log line', () => {
    expect(autoMoveNote([12])).toBe('PR #12 merged')
    expect(autoMoveNote([12, 15])).toBe('PRs #12, #15 merged')
  })
})
