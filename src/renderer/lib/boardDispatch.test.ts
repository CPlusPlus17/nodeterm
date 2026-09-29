import { describe, expect, it } from 'vitest'
import { sanitizeBoardDispatch } from '@shared/board-dispatch'
import {
  DISPATCH_STARTUP_GRACE_MS,
  decideDispatch,
  moveWithdrawsDispatch,
  occupiesSlot,
  queueToDrop,
  queueToStart,
  type DispatchContext,
  type DispatchQueueEntry,
  type DispatchTrigger
} from './boardDispatch'

const dispatch = sanitizeBoardDispatch({
  projects: { p1: { columnId: 'agent-col', agentId: 'claude', maxConcurrent: 2 } }
})

function trigger(over: Partial<DispatchTrigger> = {}): DispatchTrigger {
  return {
    origin: 'user-move',
    projectId: 'p1',
    toColumnId: 'agent-col',
    moveStatus: 'confirmed',
    issue: { number: 7, htmlUrl: 'https://github.com/acme/app/issues/7', state: 'open' },
    ...over
  }
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    dispatch,
    project: { remote: false, relay: false },
    completionColumnId: 'done',
    agentKnown: true,
    boundRuns: 0,
    queuedOrStarting: false,
    occupying: 0,
    ...over
  }
}

describe('decideDispatch — who may trigger a run', () => {
  it('a confirmed move by this person into the dispatch column starts a run bound to the issue', () => {
    const d = decideDispatch(trigger(), ctx())
    expect(d).toEqual({
      kind: 'start',
      ref: { owner: 'acme', repo: 'app', number: 7 },
      key: 'acme/app#7'
    })
  })

  it('a card that arrives in the column any other way (refresh after a GitHub label change, a pulled board) starts nothing', () => {
    expect(decideDispatch(trigger({ origin: 'sync' }), ctx())).toEqual({ kind: 'ignore' })
  })

  it('a project that is not switched on on THIS machine starts nothing (opt-out)', () => {
    expect(decideDispatch(trigger({ projectId: 'p2' }), ctx())).toEqual({ kind: 'ignore' })
    expect(decideDispatch(trigger(), ctx({ dispatch: sanitizeBoardDispatch(undefined) }))).toEqual({ kind: 'ignore' })
  })

  it('a move into another column, or to Ungrouped, is not a dispatch', () => {
    expect(decideDispatch(trigger({ toColumnId: 'other' }), ctx())).toEqual({ kind: 'ignore' })
    expect(decideDispatch(trigger({ toColumnId: null }), ctx())).toEqual({ kind: 'ignore' })
  })

  it('a move GitHub did not confirm is not a dispatch', () => {
    for (const moveStatus of ['stale', 'failed', 'read-only', 'invalid-target', 'configuration-changed']) {
      expect(decideDispatch(trigger({ moveStatus }), ctx())).toEqual({ kind: 'ignore' })
    }
    expect(decideDispatch(trigger({ moveStatus: 'refresh-pending' }), ctx()).kind).toBe('start')
  })

  it('the kill switch refuses, and says so', () => {
    const paused = sanitizeBoardDispatch({ paused: true, projects: { p1: { columnId: 'agent-col', agentId: 'claude' } } })
    expect(decideDispatch(trigger(), ctx({ dispatch: paused }))).toEqual({ kind: 'refuse', reason: 'paused' })
  })

  it('refuses a relay tab, an SSH project, a closed issue, an unreadable address and a missing agent', () => {
    expect(decideDispatch(trigger(), ctx({ project: { remote: false, relay: true } }))).toMatchObject({ reason: 'relay' })
    expect(decideDispatch(trigger(), ctx({ project: undefined }))).toMatchObject({ reason: 'relay' })
    expect(decideDispatch(trigger(), ctx({ project: { remote: true, relay: false } }))).toMatchObject({ reason: 'remote-project' })
    expect(decideDispatch(trigger({ issue: { number: 7, htmlUrl: 'https://github.com/acme/app/issues/7', state: 'closed' } }), ctx()))
      .toMatchObject({ reason: 'issue-closed' })
    expect(decideDispatch(trigger({ issue: { number: 7, htmlUrl: 'https://evil.example/acme/app/issues/7', state: 'open' } }), ctx()))
      .toMatchObject({ reason: 'no-reference' })
    expect(decideDispatch(trigger({ issue: { number: 8, htmlUrl: 'https://github.com/acme/app/issues/7', state: 'open' } }), ctx()))
      .toMatchObject({ reason: 'no-reference' })
    expect(decideDispatch(trigger(), ctx({ agentKnown: false }))).toMatchObject({ reason: 'agent-unavailable' })
  })

  it('refuses a dispatch column that is also the completion column', () => {
    expect(decideDispatch(trigger(), ctx({ completionColumnId: 'agent-col' }))).toMatchObject({ reason: 'completion-column' })
  })

  it('one run per issue: a second trigger for the same issue starts nothing', () => {
    expect(decideDispatch(trigger(), ctx({ boundRuns: 1 }))).toMatchObject({ kind: 'refuse', reason: 'already-running' })
    expect(decideDispatch(trigger(), ctx({ queuedOrStarting: true }))).toMatchObject({ kind: 'refuse', reason: 'already-queued' })
  })

  it('respects the per-project cap: a full project queues instead of starting', () => {
    expect(decideDispatch(trigger(), ctx({ occupying: 1 })).kind).toBe('start')
    expect(decideDispatch(trigger(), ctx({ occupying: 2 })).kind).toBe('queue')
    expect(decideDispatch(trigger(), ctx({ occupying: 5 })).kind).toBe('queue')
  })
})

describe('occupiesSlot', () => {
  const now = 1_000_000
  it('working, waiting, blocked and a held launch hold a slot; an idle turn does not', () => {
    expect(occupiesSlot({ state: 'working', pending: false }, now)).toBe(true)
    expect(occupiesSlot({ state: 'waiting', pending: false }, now)).toBe(true)
    expect(occupiesSlot({ state: 'blocked', pending: false }, now)).toBe(true)
    expect(occupiesSlot({ pending: true }, now)).toBe(true)
    expect(occupiesSlot({ state: 'done', pending: false, startedAt: now }, now)).toBe(false)
  })
  it('an unknown state holds a slot only while it is a run this app just started', () => {
    expect(occupiesSlot({ pending: false }, now)).toBe(false)
    expect(occupiesSlot({ pending: false, startedAt: now - 1000 }, now)).toBe(true)
    expect(occupiesSlot({ pending: false, startedAt: now - DISPATCH_STARTUP_GRACE_MS }, now)).toBe(false)
  })
})

describe('queue', () => {
  const two = sanitizeBoardDispatch({
    projects: {
      p1: { columnId: 'c', agentId: 'claude', maxConcurrent: 2 },
      p2: { columnId: 'c', agentId: 'claude', maxConcurrent: 1 }
    }
  })
  const entry = (key: string, projectId: string, queuedAt: number): DispatchQueueEntry => ({
    key,
    projectId,
    ref: { owner: 'a', repo: 'b', number: queuedAt },
    number: queuedAt,
    queuedAt
  })
  const queue = [entry('x3', 'p1', 3), entry('x1', 'p1', 1), entry('x2', 'p1', 2), entry('y1', 'p2', 1), entry('y2', 'p2', 2)]

  it('starts oldest first, never past each project\'s free slots', () => {
    const occ = new Map([['p1', 1], ['p2', 0]])
    expect(queueToStart(queue, two, (p) => occ.get(p) ?? 0).map((e) => e.key)).toEqual(['x1', 'y1'])
    expect(queueToStart(queue, two, () => 0).map((e) => e.key)).toEqual(['x1', 'y1', 'x2'])
    expect(queueToStart(queue, two, () => 9)).toEqual([])
  })

  it('the kill switch starts nothing and drops everything; an opted-out project is dropped', () => {
    const paused = { ...two, paused: true }
    expect(queueToStart(queue, paused, () => 0)).toEqual([])
    expect(queueToDrop(queue, paused)).toHaveLength(queue.length)
    const onlyP1 = sanitizeBoardDispatch({ projects: { p1: { columnId: 'c', agentId: 'claude' } } })
    expect(queueToStart(queue, onlyP1, () => 0).every((e) => e.projectId === 'p1')).toBe(true)
    expect(queueToDrop(queue, onlyP1).map((e) => e.key).sort()).toEqual(['y1', 'y2'])
  })
})

describe('moveWithdrawsDispatch', () => {
  it('a landed move out of the dispatch column withdraws a queued dispatch; nothing else does', () => {
    expect(moveWithdrawsDispatch(trigger({ toColumnId: 'other' }), dispatch)).toBe(true)
    expect(moveWithdrawsDispatch(trigger({ toColumnId: null }), dispatch)).toBe(true)
    expect(moveWithdrawsDispatch(trigger(), dispatch)).toBe(false)
    expect(moveWithdrawsDispatch(trigger({ toColumnId: 'other', moveStatus: 'failed' }), dispatch)).toBe(false)
    expect(moveWithdrawsDispatch(trigger({ toColumnId: 'other', origin: 'sync' }), dispatch)).toBe(false)
    expect(moveWithdrawsDispatch(trigger({ toColumnId: 'other', projectId: 'p9' }), dispatch)).toBe(false)
  })
})
