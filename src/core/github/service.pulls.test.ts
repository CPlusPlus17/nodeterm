import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GitHubIssueCache } from './cache'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { PullStatusRead } from './graphql-pulls'
import type { GitHubIssue, IssueHeartbeatResult, NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { GitHubPullChecksResult, PullStatusFacts } from '../../shared/github-pull-status'

let userDataDir: string
beforeEach(async () => { userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-github-pulls-')) })
afterEach(async () => { await fs.rm(userDataDir, { recursive: true, force: true }) })

const HEAD = 'a'.repeat(40)
const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [{ columnId: 'done', label: 'done' }], completionColumnId: 'done',
  revision: 'mapping-1'
}

function facts(number: number, over: Partial<PullStatusFacts> = {}): PullStatusFacts {
  return {
    number, headRefName: `feat/${number}`, headRefOid: HEAD, crossRepository: false, isDraft: false, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', rollup: 'SUCCESS', rollupOid: HEAD, closes: [], ...over
  }
}

class PullClient implements GitHubIssuesClientLike {
  /** The heartbeat's answer: flip `changed` to simulate activity in the repository. */
  changed = false
  heartbeats = 0
  statusReads = 0
  checkReads = 0
  open: PullStatusFacts[] = [facts(1)]
  checks: GitHubPullChecksResult = { status: 'no-checks' }
  failChecks?: Error

  async listIssues() { return { items: [] as GitHubIssue[] } }
  async issuesHeartbeat(_repository: string, etag?: string): Promise<IssueHeartbeatResult> {
    this.heartbeats += 1
    if (this.changed || !etag) { this.changed = false; return { notModified: false, etag: `W/"${Math.random()}"` } }
    return { notModified: true, etag }
  }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels() { return { items: [] } }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async pullRequestStatuses(): Promise<PullStatusRead> {
    this.statusReads += 1
    return { open: this.open, recent: [], access: { ci: true, merge: true }, truncated: false }
  }
  async pullRequestChecks(): Promise<GitHubPullChecksResult> {
    this.checkReads += 1
    if (this.failChecks) throw this.failChecks
    return this.checks
  }
}

function context(client: PullClient): GitHubIssueServiceContext {
  return {
    localApprovalId: 'local-1', projectId: 'project-1', repository: 'o/r', config, controlRevision: 1,
    credentialGeneration: 1, userId: 'user-1', client, columnColors: {}, mappingApproved: true
  }
}

/** The poll and the subscribe refresh write the real on-disk cache, so "nothing else happens"
 *  needs a real settle, not a few microtask turns. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40))
}

function harness(client = new PullClient()) {
  let now = 1_000_000
  let poll: (() => void) | undefined
  let contexts = 0
  const service = new GitHubIssueService({
    cache: new GitHubIssueCache(userDataDir),
    coordinator: new GitHubRequestCoordinator({ now: () => now }),
    contextForProject: async () => { contexts += 1; return context(client) },
    now: () => now,
    setInterval: (fn) => { poll = fn; return 1 },
    clearInterval: () => { poll = undefined }
  })
  return {
    client, service,
    advance: (ms: number) => { now += ms },
    poll: async () => { poll?.(); await flush() },
    contexts: () => contexts
  }
}

describe('GitHubIssueService pull status', () => {
  it('reads pull status on the first heartbeat, then only when the heartbeat reports a change', async () => {
    const h = harness()
    await h.service.subscribe(7, { projectId: 'project-1' })
    await vi.waitFor(() => expect(h.client.statusReads).toBe(1))
    expect((await h.service.pullStatus({ projectId: 'project-1' })).pulls[0]).toMatchObject({ number: 1, ci: 'passed' })

    h.advance(60_000)
    await h.poll()
    // The poll really ran (its heartbeat was sent) and answered 304: no GraphQL read.
    await vi.waitFor(() => expect(h.client.heartbeats).toBe(2))
    await flush()
    expect(h.client.statusReads).toBe(1)

    h.client.changed = true
    h.advance(60_000)
    await h.poll()
    await vi.waitFor(() => expect(h.client.statusReads).toBe(2))
  })

  it('a chase ping costs nothing until a read is due, and never resolves a context early', async () => {
    const h = harness()
    h.client.open = [facts(1, { rollup: 'PENDING' })]
    await h.service.subscribe(7, { projectId: 'project-1' })
    await flush()
    const contextsBefore = h.contexts()
    expect(await h.service.chasePulls({ projectId: 'project-1' })).toBe(false)
    expect(h.contexts()).toBe(contextsBefore)
    h.advance(30_000)
    expect(await h.service.chasePulls({ projectId: 'project-1' })).toBe(true)
    expect(h.client.statusReads).toBe(2)
  })

  it('a chase ping for a project with nothing undecided never reads', async () => {
    const h = harness()
    await h.service.subscribe(7, { projectId: 'project-1' })
    await flush()
    h.advance(3_600_000)
    expect(await h.service.chasePulls({ projectId: 'project-1' })).toBe(false)
    expect(h.client.statusReads).toBe(1)
  })

  it('check detail: hidden for a token that cannot read checks, never a failed board', async () => {
    const h = harness()
    h.client.failChecks = Object.assign(new Error('insufficient-permission'), { code: 'insufficient-permission', status: 403 })
    expect(await h.service.pullChecks({ projectId: 'project-1', pullNumber: 1 })).toEqual({ status: 'hidden' })
    h.client.failChecks = Object.assign(new Error('request-failed'), { code: 'request-failed', status: 502 })
    h.advance(15_000)
    expect(await h.service.pullChecks({ projectId: 'project-1', pullNumber: 1 })).toEqual({ status: 'unavailable' })
    expect(await h.service.pullChecks({ projectId: 'project-1', pullNumber: -3 })).toEqual({ status: 'unavailable' })
  })

  it('bounds check-detail reads: one per PR per 15 s, ten per project per minute', async () => {
    const h = harness()
    h.client.checks = { status: 'no-checks' }
    await h.service.pullChecks({ projectId: 'project-1', pullNumber: 1 })
    await h.service.pullChecks({ projectId: 'project-1', pullNumber: 1 })
    expect(h.client.checkReads).toBe(1)
    for (let number = 2; number <= 10; number++) {
      await h.service.pullChecks({ projectId: 'project-1', pullNumber: number })
    }
    expect(h.client.checkReads).toBe(10)
    const contexts = h.contexts()
    for (let number = 11; number <= 20; number++) {
      expect(await h.service.pullChecks({ projectId: 'project-1', pullNumber: number }))
        .toEqual({ status: 'unavailable' })
    }
    expect(h.client.checkReads).toBe(10)
    // Refused before a context (the credential chain) is resolved.
    expect(h.contexts()).toBe(contexts)
    h.advance(60_000)
    await h.service.pullChecks({ projectId: 'project-1', pullNumber: 21 })
    expect(h.client.checkReads).toBe(11)
  })

  it('does not ask for check detail once the list read showed the token cannot read checks', async () => {
    const h = harness()
    h.client.pullRequestStatuses = async () => {
      h.client.statusReads += 1
      return { open: [facts(1)], recent: [], access: { ci: false, merge: true }, truncated: false }
    }
    await h.service.subscribe(7, { projectId: 'project-1' })
    await flush()
    expect(await h.service.pullChecks({ projectId: 'project-1', pullNumber: 1 })).toEqual({ status: 'hidden' })
    expect(h.client.checkReads).toBe(0)
  })

  it('clearing the cache forgets pull status', async () => {
    const h = harness()
    await h.service.subscribe(7, { projectId: 'project-1' })
    await flush()
    await h.service.clearCache({ projectId: 'project-1' })
    expect((await h.service.pullStatus({ projectId: 'project-1' })).pulls).toEqual([])
  })
})
