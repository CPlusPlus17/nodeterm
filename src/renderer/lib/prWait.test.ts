import { describe, expect, it, vi } from 'vitest'
import { EMPTY_PULL_BOARD, type GitHubPullBoard, type GitHubPullStatus } from '@shared/github-pull-status'
import { INVALID_PR_WAIT_HOLD, type PrWaitHold } from '@shared/pr-wait'
import {
  evaluatePrWait,
  prHoldExpired,
  prHoldSatisfied,
  prHoldSummary,
  resolvePrWaitFor,
  type PrLookup,
  type PrWaitArmDeps
} from './prWait'

const NOW = 1_000_000
const hold = (waits: PrWaitHold['waits'], deadlineAt = NOW + 3_600_000): PrWaitHold => ({
  repository: 'o/r',
  waits,
  deadlineAt
})
const pull = (number: number, patch: Partial<GitHubPullStatus> = {}): GitHubPullStatus => ({
  number,
  lifecycle: 'open',
  headRefName: 'b',
  headRefOid: 'abc',
  closes: [],
  ...patch
})
const board = (pulls: GitHubPullStatus[], patch: Partial<GitHubPullBoard> = {}): GitHubPullBoard => ({
  ...EMPTY_PULL_BOARD,
  repository: 'o/r',
  pulls,
  observedAt: NOW - 1000,
  ...patch
})

describe('evaluatePrWait — merged', () => {
  const w = { number: 7, until: 'merged' as const }
  it('is met by a merged PR, even from a stale snapshot (a merge cannot be undone)', () => {
    expect(evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'merged' })])).state).toBe('met')
    expect(evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'merged' })], { stale: true })).state).toBe('met')
  })
  it('waits on an open or draft PR', () => {
    expect(evaluatePrWait(w, hold([w]), board([pull(7)])).state).toBe('waiting')
    expect(evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'draft' })])).state).toBe('waiting')
  })
  it('is blocked (named) by a PR closed without merging — a reopen would release it again', () => {
    const r = evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'closed' })]))
    expect(r.state).toBe('blocked')
    expect(r.detail).toMatch(/closed without merging/)
  })
})

describe('evaluatePrWait — checks (SUCCESS at the PR’s current head)', () => {
  const w = { number: 7, until: 'checks' as const }
  const h = hold([w])
  it('is met by passed checks on a fresh board', () => {
    expect(evaluatePrWait(w, h, board([pull(7, { ci: 'passed' })])).state).toBe('met')
    expect(evaluatePrWait(w, h, board([pull(7, { ci: 'passed', lifecycle: 'draft' })])).state).toBe('met')
  })
  it('does NOT trust a stale snapshot: a push since the last read would carry other checks', () => {
    expect(evaluatePrWait(w, h, board([pull(7, { ci: 'passed' })], { stale: true })).state).toBe('unknown')
  })
  it('waits while checks run, after they fail (a re-run or push can still pass), and with none reported', () => {
    for (const ci of ['pending', 'failed', 'none'] as const) {
      expect(evaluatePrWait(w, h, board([pull(7, { ci })])).state).toBe('waiting')
    }
  })
  it('a missing rollup is never "passed" — no checks is not green', () => {
    expect(evaluatePrWait(w, h, board([pull(7, { ci: 'none' })])).detail).toMatch(/no checks/)
  })
  it('an unknown ci (the host has not said) is unknown, not met', () => {
    expect(evaluatePrWait(w, h, board([pull(7)])).state).toBe('unknown')
  })
  it('is blocked when the token cannot read checks at all', () => {
    const r = evaluatePrWait(w, h, board([pull(7, { ci: 'passed' })], { access: { ci: false, merge: true } }))
    expect(r.state).toBe('blocked')
    expect(r.detail).toMatch(/cannot read checks/)
  })
  it('is blocked by a PR that merged before its checks were seen passing', () => {
    expect(evaluatePrWait(w, h, board([pull(7, { lifecycle: 'merged' })])).state).toBe('blocked')
  })
})

describe('evaluatePrWait — what the board does not know', () => {
  const w = { number: 7, until: 'merged' as const }
  it('no board yet is unknown', () => {
    expect(evaluatePrWait(w, hold([w]), undefined).state).toBe('unknown')
  })
  it('a PR the board does not list is unknown, and a truncated board says why', () => {
    expect(evaluatePrWait(w, hold([w]), board([])).state).toBe('unknown')
    expect(evaluatePrWait(w, hold([w]), board([], { truncated: true })).detail).toMatch(/more open pull requests/)
  })
  it('a board that now syncs ANOTHER repository cannot satisfy the hold', () => {
    const r = evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'merged' })], { repository: 'o/other' }))
    expect(r.state).toBe('blocked')
  })
  it('compares repositories case-insensitively, as GitHub does', () => {
    const r = evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'merged' })], { repository: 'O/R' }))
    expect(r.state).toBe('met')
  })
})

describe('prHoldSatisfied / prHoldExpired', () => {
  const a = { number: 7, until: 'merged' as const }
  const b = { number: 8, until: 'checks' as const }
  const both = board([pull(7, { lifecycle: 'merged' }), pull(8, { ci: 'passed' })])
  it('needs EVERY wait met', () => {
    expect(prHoldSatisfied(hold([a, b]), both, NOW)).toBe(true)
    expect(prHoldSatisfied(hold([a, b]), board([pull(7, { lifecycle: 'merged' }), pull(8, { ci: 'pending' })]), NOW)).toBe(false)
  })
  it('never fires past the deadline, however green the PR is', () => {
    expect(prHoldExpired(hold([a], NOW), NOW)).toBe(true)
    expect(prHoldSatisfied(hold([a], NOW), both, NOW)).toBe(false)
    expect(prHoldExpired(hold([a], NOW + 1), NOW)).toBe(false)
  })
  it('an invalid (hostile or corrupt) hold is expired and never satisfied', () => {
    expect(prHoldExpired(INVALID_PR_WAIT_HOLD, NOW)).toBe(true)
    expect(prHoldSatisfied(INVALID_PR_WAIT_HOLD, both, NOW)).toBe(false)
  })
})

describe('prHoldSummary', () => {
  it('says, per pull request, what is still being waited for', () => {
    const s = prHoldSummary(
      hold([{ number: 7, until: 'merged' }, { number: 8, until: 'checks' }]),
      board([pull(7), pull(8, { ci: 'pending' })])
    )
    expect(s).toMatch(/PR #7 merged/)
    expect(s).toMatch(/PR #8 checks/)
    expect(s).toMatch(/running/)
  })
})

// ── Arming: what an open with --after-pr is allowed to store ──────────────────────────────────

function deps(patch: Partial<PrWaitArmDeps> = {}): PrWaitArmDeps {
  return {
    project: { id: 'p1', cwd: '/w', kanban: { github: { repository: 'o/r' } } },
    controlStatus: vi.fn(async () => ({ repository: 'o/r', approved: true })),
    lookupPulls: vi.fn(async (_id: string, numbers: number[]) =>
      new Map<number, PrLookup>(numbers.map((n) => [n, { found: true, lifecycle: 'open' }]))
    ),
    now: () => NOW,
    ...patch
  }
}

describe('resolvePrWaitFor — the refusal matrix', () => {
  it('no flag, nothing to do (and nothing is asked)', async () => {
    const d = deps()
    expect(await resolvePrWaitFor(undefined, undefined, 'open-agent', d)).toEqual({ ok: true, alreadyMerged: [] })
    expect(d.controlStatus).not.toHaveBeenCalled()
  })

  it('stores a hold on the board repository with the deadline on this clock', async () => {
    const r = await resolvePrWaitFor('7:checks', '2h', 'open-agent', deps())
    expect(r).toEqual({
      ok: true,
      hold: { repository: 'o/r', waits: [{ number: 7, until: 'checks' }], deadlineAt: NOW + 2 * 3_600_000 },
      alreadyMerged: []
    })
  })

  it('a relay tab is refused by name', async () => {
    const r = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({ project: { id: 'p', remote: true } }))
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.error).toMatch(/^after-pr-unavailable: .*relay/)
  })

  it('a project whose board has no GitHub sync is refused by name — and a cwd-less one says why', async () => {
    const plain = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({ project: { id: 'p', cwd: '/w' } }))
    expect(!plain.ok && plain.error).toMatch(/^after-pr-unavailable: this project's kanban board is not connected to GitHub/)
    const cwdless = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({ project: { id: 'p' } }))
    expect(!cwdless.ok && cwdless.error).toMatch(/no folder/)
  })

  it('an SSH project with a GitHub board is NOT refused — the PR status is read on this machine', async () => {
    const r = await resolvePrWaitFor(
      '7:merged',
      undefined,
      'open-agent',
      deps({ project: { id: 'p', ssh: { host: 'h' }, kanban: { github: {} } } })
    )
    expect(r.ok).toBe(true)
  })

  it('a board with no repository, or an unapproved one, is refused by name', async () => {
    const none = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      controlStatus: vi.fn(async () => ({ approved: false }))
    }))
    expect(!none.ok && none.error).toMatch(/names no GitHub repository/)
    const unapproved = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      controlStatus: vi.fn(async () => ({ repository: 'o/r', approved: false }))
    }))
    expect(!unapproved.ok && unapproved.error).toMatch(/not approved on this machine/)
    const threw = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      controlStatus: vi.fn(async () => { throw new Error('boom') })
    }))
    expect(!threw.ok && threw.error).toMatch(/^after-pr-unavailable:/)
  })

  it('refuses a full reference into another repository', async () => {
    const r = await resolvePrWaitFor('x/y#7:merged', undefined, 'open-agent', deps())
    expect(!r.ok && r.error).toMatch(/^after-pr-other-repository: x\/y#7/)
    // The same repository in another case is the same repository.
    expect((await resolvePrWaitFor('O/R#7:merged', undefined, 'open-agent', deps())).ok).toBe(true)
  })

  it('refuses a number the repository does not have', async () => {
    const r = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([[7, { found: false, complete: true }]]))
    }))
    expect(!r.ok && r.error).toMatch(/^after-pr-unknown: o\/r has no pull request #7/)
  })

  it('does not call an incomplete read evidence of absence — a retryable refusal instead', async () => {
    const r = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([[7, { found: false, complete: false }]]))
    }))
    expect(!r.ok && r.error).toMatch(/^after-pr-unconfirmed:.*retry/)
    const threw = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => { throw new Error('offline') })
    }))
    expect(!threw.ok && threw.error).toMatch(/^after-pr-unconfirmed:/)
  })

  it('refuses a closed-unmerged PR, and checks on a merged one', async () => {
    const closed = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([[7, { found: true, lifecycle: 'closed' }]]))
    }))
    expect(!closed.ok && closed.error).toMatch(/^after-pr-closed:/)
    const merged = await resolvePrWaitFor('7:checks', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([[7, { found: true, lifecycle: 'merged' }]]))
    }))
    expect(!merged.ok && merged.error).toMatch(/^after-pr-merged:/)
  })

  it('a :merged wait on an already-merged PR is met now, reported, and not stored', async () => {
    const r = await resolvePrWaitFor('7:merged,8:checks', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([
        [7, { found: true, lifecycle: 'merged' }],
        [8, { found: true, lifecycle: 'open' }]
      ]))
    }))
    expect(r).toMatchObject({ ok: true, alreadyMerged: [7], hold: { waits: [{ number: 8, until: 'checks' }] } })
    const all = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([[7, { found: true, lifecycle: 'merged' }]]))
    }))
    expect(all).toEqual({ ok: true, alreadyMerged: [7] })
  })

  it('re-parses the flag: the renderer never trusts that main’s gate ran', async () => {
    const r = await resolvePrWaitFor('7', undefined, 'open-agent', deps())
    expect(!r.ok && r.error).toMatch(/^open-agent: --after-pr must be/)
  })
})
