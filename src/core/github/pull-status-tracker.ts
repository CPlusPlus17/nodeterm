// Pull request CI + mergeability per repository: when to read it, what the board is told, and how
// an undecided PR is chased without webhooks. The GraphQL read itself is the client's; this module
// owns only the decisions, so each rule can be pressed by a test without a network.
//
// WHEN a read happens — nothing else triggers one:
//  1. The issues heartbeat (Wave 1) reported a change. A push, a merge, a label, a comment all move
//     the repository's most recently updated item; a finished check run does NOT, which is why:
//  2. An undecided PR (mergeability UNKNOWN, or a rollup still PENDING) is CHASED — 30 s, 1 min,
//     2 min, then 5 min, at most 12 reads per episode — and only while a board is VISIBLE. The
//     renderer asserts visibility by asking (`claimChase`); a hidden or closed board stops asking.
//  3. The first heartbeat of an app run (nothing known yet), a user's own refresh, a snapshot that
//     is stale, or a read the rate budget skipped earlier (`owed`).
//
// A read the budget holds is skipped, never queued, and remembered as owed; a failed read keeps the
// last snapshot and marks it stale. Neither blanks what the board shows.
import {
  EMPTY_PULL_BOARD,
  PULL_CHASE_MAX,
  nextPullChase,
  pullChaseDue,
  pullStatusFrom,
  type GitHubPullBoard,
  type GitHubPullStatus,
  type PullChaseState
} from '../../shared/github-pull-status'
import type { PullStatusRead } from './graphql-pulls'
import type { GitHubRequestCoordinator } from './request-coordinator'

export type PullReadReason = 'heartbeat' | 'foreground' | 'chase'

type PullRepositoryState = {
  pulls: GitHubPullStatus[]
  observedAt?: number
  stale: boolean
  access: { ci: boolean; merge: boolean }
  truncated: boolean
  chase: PullChaseState | null
  /** A read was skipped by the rate budget; the next opportunity reads even if nothing changed. */
  owed: boolean
  inFlight?: Promise<void>
  /** Bumped by `forget` so a read in flight when the cache was cleared cannot publish. */
  generation: number
}

type TrackerOptions = {
  coordinator: GitHubRequestCoordinator
  now?: () => number
  /** Something the board shows changed for this repository key. */
  onChanged: (key: string, changedPullNumbers: number[]) => void
}

/** Why a read did not produce a snapshot. `hidden` is an ANSWER (the token may not read these
 *  fields), not a failure. */
function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

export class GitHubPullStatusTracker {
  private readonly states = new Map<string, PullRepositoryState>()
  private readonly now: () => number

  constructor(private readonly options: TrackerOptions) {
    this.now = options.now ?? Date.now
  }

  board(key: string): GitHubPullBoard {
    const state = this.states.get(key)
    if (!state) return { ...EMPTY_PULL_BOARD, access: { ...EMPTY_PULL_BOARD.access } }
    return {
      pulls: state.pulls.map((pull) => ({ ...pull, closes: [...pull.closes] })),
      ...(state.observedAt !== undefined ? { observedAt: state.observedAt } : {}),
      stale: state.stale,
      access: { ...state.access },
      undecided: !!state.chase && state.chase.attempts < PULL_CHASE_MAX,
      truncated: state.truncated
    }
  }

  /** Should the heartbeat that just ran be followed by a pull status read? */
  wantsReadAfterHeartbeat(key: string, input: { changed: boolean; foreground: boolean }): boolean {
    const state = this.states.get(key)
    return input.changed || input.foreground || !state || state.observedAt === undefined ||
      state.stale || state.owed
  }

  /**
   * Claims one chase read, synchronously, so two boards asking at once cannot both spend it. True
   * means the caller must now `read(…, 'chase')`. The attempt is counted HERE, before the read: a
   * chase read that fails still spends one of the twelve.
   */
  claimChase(key: string): boolean {
    const state = this.states.get(key)
    if (!state || state.inFlight || !pullChaseDue(state.chase, this.now())) return false
    state.chase = { ...state.chase!, attempts: state.chase!.attempts + 1, lastReadAt: this.now() }
    return true
  }

  /** Drops every repository state for `repository` (a cache clear or revoke). */
  forgetRepository(repository: string): void {
    for (const [key, state] of this.states) {
      if (!key.endsWith(`\0${repository}`)) continue
      state.generation += 1
      this.states.delete(key)
    }
  }

  /**
   * Reads now. `run` performs the GraphQL read (through the coordinator and the caller's epoch
   * checks); `userId` names the identity whose `graphql` budget it spends. Single-flight per key:
   * a read already in flight answers every caller that arrives meanwhile.
   */
  read(
    key: string,
    userId: string,
    reason: PullReadReason,
    run: () => Promise<PullStatusRead>
  ): Promise<void> {
    const state = this.stateFor(key)
    if (state.inFlight) return state.inFlight
    // Background reads (heartbeat, chase) respect the whole budget, including the floor Wave 1 keeps
    // for the user's own tools. A read the user asked for respects only a hard limit.
    const throttle = this.options.coordinator.throttle(userId, this.now(), 'graphql')
    if (throttle && (reason !== 'foreground' || throttle.kind === 'rate-limited')) {
      state.owed = true
      return Promise.resolve()
    }
    const generation = state.generation
    const work = this.perform(key, state, generation, userId, run)
    state.inFlight = work
    void work.finally(() => { if (state.inFlight === work) delete state.inFlight })
    return work
  }

  private async perform(
    key: string,
    state: PullRepositoryState,
    generation: number,
    userId: string,
    run: () => Promise<PullStatusRead>
  ): Promise<void> {
    let result: PullStatusRead
    try {
      result = await run()
    } catch (error) {
      if (generation !== state.generation) return
      const code = errorCode(error)
      if (code === 'configuration-changed') return
      if (code === 'rate-limited') {
        // The coordinator has recorded the hold; nothing was learned about the pull requests.
        state.owed = true
        return
      }
      if (code === 'insufficient-permission') {
        this.publish(key, state, {
          open: [], recent: [], access: { ci: false, merge: false }, truncated: false
        }, userId)
        return
      }
      const wasStale = state.stale
      state.stale = true
      // A failed chase read still waits its turn: the next one follows the schedule, not a retry loop.
      if (state.chase) state.chase = { ...state.chase, lastReadAt: this.now() }
      if (!wasStale) this.options.onChanged(key, [])
      return
    }
    if (generation !== state.generation) return
    this.publish(key, state, result, userId)
  }

  private publish(key: string, state: PullRepositoryState, result: PullStatusRead, userId: string): void {
    const now = this.now()
    if (result.rateLimit) {
      // The body's own reading, in case a proxy stripped the headers the client already fed in.
      this.options.coordinator.noteRateSample(userId, {
        resource: 'graphql',
        limit: result.rateLimit.limit,
        remaining: result.rateLimit.remaining,
        resetAt: result.rateLimit.resetAt
      })
    }
    const previous = new Map(state.pulls.map((pull) => [pull.number, pull]))
    const open = result.open.map((facts) => pullStatusFrom(facts, result.access, previous.get(facts.number)))
    const openNumbers = new Set(open.map((pull) => pull.number))
    const finished = result.recent
      .filter((pull) => !openNumbers.has(pull.number))
      .map((pull): GitHubPullStatus => ({
        number: pull.number,
        lifecycle: pull.lifecycle,
        headRefName: pull.headRefName,
        ...(pull.crossRepository ? { crossRepository: true as const } : {}),
        closes: []
      }))
    const pulls = [...open, ...finished]
    const nextNumbers = new Set(pulls.map((pull) => pull.number))
    const changed = [
      ...pulls.filter((pull) => JSON.stringify(pull) !== JSON.stringify(previous.get(pull.number)))
        .map((pull) => pull.number),
      ...state.pulls.filter((pull) => !nextNumbers.has(pull.number)).map((pull) => pull.number)
    ]
    const accessChanged = state.access.ci !== result.access.ci || state.access.merge !== result.access.merge
    const wasStale = state.stale
    const chaseBefore = state.chase
    state.pulls = pulls
    state.observedAt = now
    state.stale = false
    state.owed = false
    state.access = { ...result.access }
    state.truncated = result.truncated
    state.chase = nextPullChase(state.chase, open, now)
    const chaseChanged = !!chaseBefore !== !!state.chase
    if (changed.length || accessChanged || wasStale || chaseChanged) this.options.onChanged(key, changed)
  }

  private stateFor(key: string): PullRepositoryState {
    let state = this.states.get(key)
    if (!state) {
      state = {
        pulls: [], stale: false, access: { ci: true, merge: true }, truncated: false,
        chase: null, owed: false, generation: 0
      }
      this.states.set(key, state)
    }
    return state
  }
}
