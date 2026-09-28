import { describe, expect, it } from 'vitest'
import { GitHubPullStatusTracker } from './pull-status-tracker'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { PullStatusRead } from './graphql-pulls'
import { PULL_CHASE_MAX } from '../../shared/github-pull-status'
import type { PullStatusFacts } from '../../shared/github-pull-status'

const HEAD = 'a'.repeat(40)
const KEY = 'user-1\0o/r'

function facts(number: number, over: Partial<PullStatusFacts> = {}): PullStatusFacts {
  return {
    number, headRefName: `feat/${number}`, headRefOid: HEAD, crossRepository: false, isDraft: false, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', rollup: 'SUCCESS', rollupOid: HEAD, closes: [], ...over
  }
}

function read(open: PullStatusFacts[], over: Partial<PullStatusRead> = {}): PullStatusRead {
  return { open, recent: [], access: { ci: true, merge: true }, truncated: false, ...over }
}

function tracker(start = 0) {
  let now = start
  const changes: number[][] = []
  const coordinator = new GitHubRequestCoordinator({ now: () => now })
  const subject = new GitHubPullStatusTracker({
    coordinator, now: () => now, onChanged: (_key, numbers) => changes.push(numbers)
  })
  return { subject, coordinator, changes, advance: (ms: number) => { now += ms }, at: () => now }
}

describe('GitHubPullStatusTracker', () => {
  it('publishes open pull requests and recent merges', async () => {
    const { subject } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)], {
      recent: [{ number: 2, headRefName: 'feat/2', crossRepository: false, lifecycle: 'merged' }]
    }))
    const board = subject.board(KEY)
    expect(board.pulls.map((pull) => [pull.number, pull.lifecycle, pull.ci, pull.merge])).toEqual([
      [1, 'open', 'passed', 'ready'], [2, 'merged', undefined, undefined]
    ])
    expect(board.stale).toBe(false)
    expect(board.observedAt).toBe(0)
  })

  it('a failed read keeps the last snapshot and marks it stale instead of going blank', async () => {
    const { subject, changes } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)]))
    changes.length = 0
    await subject.read(KEY, 'user-1', 'heartbeat', async () => {
      throw Object.assign(new Error('request-failed'), { code: 'request-failed', status: 502 })
    })
    const board = subject.board(KEY)
    expect(board.stale).toBe(true)
    expect(board.pulls.map((pull) => pull.ci)).toEqual(['passed'])
    expect(changes).toEqual([[]])
    // A stale snapshot is worth re-reading at the next heartbeat even when nothing changed.
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: false, foreground: false })).toBe(true)
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)]))
    expect(subject.board(KEY).stale).toBe(false)
  })

  it('reads after a heartbeat only when something changed, once it knows the repository', async () => {
    const { subject } = tracker()
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: false, foreground: false })).toBe(true)
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)]))
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: false, foreground: false })).toBe(false)
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: true, foreground: false })).toBe(true)
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: false, foreground: true })).toBe(true)
  })

  it('chases an undecided PR on the schedule and stops after 12 reads', async () => {
    const { subject, advance } = tracker()
    const undecided = async () => read([facts(1, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })])
    await subject.read(KEY, 'user-1', 'heartbeat', undecided)
    expect(subject.board(KEY).undecided).toBe(true)
    let reads = 0
    for (let tick = 0; tick < 400; tick++) {
      advance(15_000)
      if (!subject.claimChase(KEY)) continue
      reads += 1
      await subject.read(KEY, 'user-1', 'chase', undecided)
    }
    expect(reads).toBe(PULL_CHASE_MAX)
    expect(subject.board(KEY).undecided).toBe(false)
  })

  it('does not chase before the first delay, and a failed chase read still spends its attempt', async () => {
    const { subject, advance } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () =>
      read([facts(1, { rollup: 'PENDING' })]))
    advance(29_999)
    expect(subject.claimChase(KEY)).toBe(false)
    advance(1)
    expect(subject.claimChase(KEY)).toBe(true)
    await subject.read(KEY, 'user-1', 'chase', async () => { throw Object.assign(new Error('x'), { code: 'request-failed' }) })
    // The next step is one minute after the failed read, not an immediate retry.
    advance(59_999)
    expect(subject.claimChase(KEY)).toBe(false)
    advance(1)
    expect(subject.claimChase(KEY)).toBe(true)
  })

  it('stops chasing once the PR settles', async () => {
    const { subject, advance } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1, { rollup: 'PENDING' })]))
    advance(30_000)
    expect(subject.claimChase(KEY)).toBe(true)
    await subject.read(KEY, 'user-1', 'chase', async () => read([facts(1)]))
    advance(3_600_000)
    expect(subject.claimChase(KEY)).toBe(false)
  })

  it('a background read the graphql budget holds is skipped and owed; REST budget does not hold it', async () => {
    const { subject, coordinator } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)]))
    coordinator.noteRateSample('user-1', { resource: 'core', limit: 5_000, remaining: 10, resetAt: 60_000 })
    let ran = 0
    await subject.read(KEY, 'user-1', 'heartbeat', async () => { ran += 1; return read([facts(1)]) })
    expect(ran).toBe(1)
    coordinator.noteRateSample('user-1', { resource: 'graphql', limit: 5_000, remaining: 10, resetAt: 60_000 })
    await subject.read(KEY, 'user-1', 'heartbeat', async () => { ran += 1; return read([facts(1)]) })
    expect(ran).toBe(1)
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: false, foreground: false })).toBe(true)
    // The user's own refresh is not held by the floor — only by a hard limit.
    await subject.read(KEY, 'user-1', 'foreground', async () => { ran += 1; return read([facts(1)]) })
    expect(ran).toBe(2)
    coordinator.noteRateSample('user-1', { resource: 'graphql', limit: 5_000, remaining: 0, resetAt: 60_000 })
    await subject.read(KEY, 'user-1', 'foreground', async () => { ran += 1; return read([facts(1)]) })
    expect(ran).toBe(2)
  })

  it('a token without permission hides CI and mergeability instead of marking anything stale', async () => {
    const { subject } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => {
      throw Object.assign(new Error('insufficient-permission'), { code: 'insufficient-permission', status: 403 })
    })
    expect(subject.board(KEY)).toMatchObject({ pulls: [], stale: false, access: { ci: false, merge: false } })
  })

  it('a read in flight when the cache is cleared publishes nothing', async () => {
    const { subject } = tracker()
    let release!: (value: PullStatusRead) => void
    const pending = subject.read(KEY, 'user-1', 'heartbeat', () => new Promise((resolve) => { release = resolve }))
    subject.forgetRepository('o/r')
    release(read([facts(1)]))
    await pending
    expect(subject.board(KEY).pulls).toEqual([])
  })

  it('never carries a CI result from an older head across reads', async () => {
    const { subject } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1, { rollup: 'SUCCESS' })]))
    const pushed = 'c'.repeat(40)
    await subject.read(KEY, 'user-1', 'heartbeat', async () =>
      read([facts(1, { headRefOid: pushed, rollup: 'SUCCESS', rollupOid: HEAD })]))
    expect(subject.board(KEY).pulls[0]).toMatchObject({ headRefOid: pushed, ci: 'pending' })
  })
})
