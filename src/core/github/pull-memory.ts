// What this machine has OBSERVED about a repository's pull requests, kept across reads and restarts
// (persisted per identity + repository beside the issue cache, see cache.ts). The GraphQL read only
// lists the 50 most recently updated open PRs and the 30 most recently finished ones, so without a
// memory two facts the merge-driven column move depends on would silently expire:
//
//  - "PR #12 closed without merging" — the card linked to it must stay blocked until the user
//    unlinks it, not until 30 other PRs close and #12 drops out of the `recent` list;
//  - "this machine saw PR #15 open, and later saw it merged" — the only thing that counts as an
//    observed transition. A merge first seen already-merged never moves a card.
//
// A remembered PR that neither list covers any more gets its lifecycle from the REST issues harvest
// (which carries every PR's state), so an old merge is still noticed; one the harvest does not have
// keeps its last known lifecycle, which for an open PR means "wait" — the safe answer.
//
// It also holds CLAIMS: one per (project, card, set of PRs) that has been moved. Every board in every
// window asks the host before it moves a card, and only the first ask wins — so two Server Edition
// tabs cannot both move the card, and a card the user dragged back is not moved again for the same
// merges.
import type { GitHubPullStatus, PullLifecycle } from '../../shared/github-pull-status'

export interface RememberedPull {
  number: number
  headRefName: string
  crossRepository?: true
  lifecycle: PullLifecycle
  openSeen?: true
  mergedSeenAt?: number
  /** The same-repository issues it closes, as last seen while it was open — the read only reports
   *  closing issues for OPEN PRs, and the merge is exactly when an issue-bound card needs them. */
  closes?: number[]
}

export interface PullMemory {
  version: 1
  pulls: RememberedPull[]
  claims: string[]
}

export const PULL_MEMORY_MAX = 500
export const PULL_CLAIMS_MAX = 2_000
/** A merged PR stays on the board this long after its merge was observed — long enough for a board
 *  opened days later to see the merge and move the card. Older merges are kept only as memory. */
export const REMEMBERED_MERGE_VISIBLE_MS = 30 * 24 * 60 * 60_000

export function emptyPullMemory(): PullMemory {
  return { version: 1, pulls: [], claims: [] }
}

const LIFECYCLES = new Set<PullLifecycle>(['open', 'draft', 'merged', 'closed'])

function validRemembered(value: unknown): value is RememberedPull {
  if (!value || typeof value !== 'object') return false
  const pull = value as RememberedPull
  return Number.isSafeInteger(pull.number) && pull.number > 0 &&
    typeof pull.headRefName === 'string' && pull.headRefName.length > 0 && pull.headRefName.length <= 255 &&
    (pull.crossRepository === undefined || pull.crossRepository === true) &&
    LIFECYCLES.has(pull.lifecycle) &&
    (pull.openSeen === undefined || pull.openSeen === true) &&
    (pull.mergedSeenAt === undefined || (Number.isSafeInteger(pull.mergedSeenAt) && pull.mergedSeenAt >= 0)) &&
    (pull.closes === undefined || (Array.isArray(pull.closes) && pull.closes.length <= 10 &&
      pull.closes.every((number) => Number.isSafeInteger(number) && number > 0)))
}

export function validPullMemory(value: unknown): value is PullMemory {
  if (!value || typeof value !== 'object') return false
  const memory = value as PullMemory
  return memory.version === 1 &&
    Array.isArray(memory.pulls) && memory.pulls.length <= PULL_MEMORY_MAX && memory.pulls.every(validRemembered) &&
    Array.isArray(memory.claims) && memory.claims.length <= PULL_CLAIMS_MAX &&
    memory.claims.every((claim) => typeof claim === 'string' && claim.length <= 1_024)
}

const UNFINISHED = new Set<PullLifecycle>(['open', 'draft'])

/**
 * Folds one read into the memory. `listed` is what the GraphQL read returned (open + recent);
 * remembered PRs it does not list take their lifecycle from `harvest` (the REST snapshot) when it
 * has them. A merge counts as observed only when this machine had seen the PR open before.
 */
export function rememberPulls(
  previous: RememberedPull[],
  listed: GitHubPullStatus[],
  harvest: ReadonlyMap<number, PullLifecycle>,
  now: number
): RememberedPull[] {
  const byNumber = new Map(previous.map((pull) => [pull.number, pull]))
  const next = new Map<number, RememberedPull>()
  const apply = (
    number: number, headRefName: string, crossRepository: boolean, lifecycle: PullLifecycle, closes: number[]
  ): void => {
    const before = byNumber.get(number)
    const openSeen = !!before?.openSeen || UNFINISHED.has(lifecycle)
    const mergedSeenAt = before?.mergedSeenAt ??
      (lifecycle === 'merged' && before?.openSeen ? now : undefined)
    // An open PR's read is the truth about what it closes; a finished one's read says nothing, so
    // what was seen while it was open stands.
    const closing = UNFINISHED.has(lifecycle) ? closes.slice(0, 10) : before?.closes ?? closes.slice(0, 10)
    next.set(number, {
      number,
      headRefName,
      ...(crossRepository ? { crossRepository: true as const } : {}),
      lifecycle,
      ...(openSeen ? { openSeen: true as const } : {}),
      ...(mergedSeenAt !== undefined ? { mergedSeenAt } : {}),
      ...(closing.length ? { closes: closing } : {})
    })
  }
  for (const pull of listed) apply(pull.number, pull.headRefName, !!pull.crossRepository, pull.lifecycle, pull.closes)
  for (const pull of previous) {
    if (next.has(pull.number)) continue
    const lifecycle = harvest.get(pull.number) ?? pull.lifecycle
    apply(pull.number, pull.headRefName, !!pull.crossRepository, lifecycle, pull.closes ?? [])
  }
  // Bound: unfinished PRs are kept first (dropping one would turn "wait" into "not linked"), then the
  // newest. An evicted merged PR only loses its place on a board long after it mattered.
  return [...next.values()]
    .sort((a, b) => Number(UNFINISHED.has(b.lifecycle)) - Number(UNFINISHED.has(a.lifecycle)) ||
      b.number - a.number)
    .slice(0, PULL_MEMORY_MAX)
}

/** The remembered PRs the board still needs that the read did not list: every unfinished or
 *  closed-unmerged one (a closed PR keeps blocking its card until unlinked), and merges observed
 *  within `REMEMBERED_MERGE_VISIBLE_MS`. */
export function rememberedForBoard(
  memory: RememberedPull[],
  listed: ReadonlySet<number>,
  now: number
): GitHubPullStatus[] {
  return memory
    .filter((pull) => !listed.has(pull.number))
    .filter((pull) => pull.lifecycle !== 'merged' ||
      (pull.mergedSeenAt !== undefined && now - pull.mergedSeenAt < REMEMBERED_MERGE_VISIBLE_MS))
    .map((pull): GitHubPullStatus => ({
      number: pull.number,
      lifecycle: pull.lifecycle,
      headRefName: pull.headRefName,
      ...(pull.crossRepository ? { crossRepository: true as const } : {}),
      closes: pull.closes ?? [],
      ...(pull.openSeen ? { openSeen: true as const } : {}),
      ...(pull.mergedSeenAt !== undefined ? { mergedSeenAt: pull.mergedSeenAt } : {})
    }))
}

/** A listed status with what the memory knows about it. */
export function withObservations(status: GitHubPullStatus, remembered: RememberedPull | undefined): GitHubPullStatus {
  if (!remembered) return status
  return {
    ...status,
    // A finished PR's read carries no closing issues; the ones seen while it was open still apply.
    ...(status.closes.length === 0 && remembered.closes?.length ? { closes: remembered.closes } : {}),
    ...(remembered.openSeen ? { openSeen: true as const } : {}),
    ...(remembered.mergedSeenAt !== undefined ? { mergedSeenAt: remembered.mergedSeenAt } : {})
  }
}

/** Records a claim; `claimed` is false when it was already there. */
export function claimInMemory(memory: PullMemory, key: string): { memory: PullMemory; claimed: boolean } {
  if (memory.claims.includes(key)) return { memory, claimed: false }
  return { memory: { ...memory, claims: [...memory.claims, key].slice(-PULL_CLAIMS_MAX) }, claimed: true }
}
