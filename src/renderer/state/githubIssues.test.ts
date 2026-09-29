import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubIssuesApi } from '@shared/github-issues'
import { useGitHubIssues } from './githubIssues'

const page = (number: number, columnId: string | null, nextCursor?: string) => ({
  items: [{
    id: number, number, title: `Issue ${number}`, body: '', state: 'open' as const,
    stateReason: null, htmlUrl: `https://github.com/o/r/issues/${number}`,
    apiUrl: `https://api.github.com/repos/o/r/issues/${number}`, labels: [], assignees: [],
    createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z', locked: false,
    columnId, conflict: null
  }],
  counts: { [columnId ?? 'ungrouped']: 1 },
  partial: false,
  readOnly: false,
  ...(nextCursor ? { nextCursor } : {})
})

const pullPage = (number: number, columnId: string | null, nextCursor?: string) => {
  const base = page(number, columnId, nextCursor)
  return { ...base, items: [{ ...base.items[0], pull: { draft: false, mergedAt: null } }] }
}

function api(): GitHubIssuesApi {
  return {
    subscribe: vi.fn(async () => page(1, null)),
    unsubscribe: vi.fn(async () => {}),
    query: vi.fn(async (request) => request.kind === 'pull'
      ? pullPage(request.columnId === 'todo' ? 200 : 300, request.columnId)
      : page(request.columnId === 'todo' ? 2 : 3, request.columnId)),
    refresh: vi.fn(async () => {}),
    moveIssue: vi.fn(async () => ({ status: 'configuration-changed' as const })),
    createMissingLabels: vi.fn(async () => ({ status: 'confirmed' as const, created: [], remaining: [] })),
    clearCache: vi.fn(async () => {}),
    pullStatus: vi.fn(async () => ({
      pulls: [], stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
    })),
    chasePulls: vi.fn(async () => false),
    pullChecks: vi.fn(async () => ({ status: 'no-checks' as const })),
    claimPullAutoMove: vi.fn(async () => false),
    notePullWaits: vi.fn(async () => 0),
    projectAvatar: vi.fn(async () => null),
    onChanged: vi.fn(() => () => {})
  }
}

beforeEach(() => useGitHubIssues.setState({ projects: {} }))

describe('GitHub issue renderer state', () => {
  it('lets only the newest overlapping connection publish or tear down project state', async () => {
    const client = api()
    let resolveFirst!: (value: ReturnType<typeof page>) => void
    const first = new Promise<ReturnType<typeof page>>((resolve) => { resolveFirst = resolve })
    vi.mocked(client.subscribe).mockReturnValueOnce(first)

    const oldConnection = useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    const newConnection = useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    expect(client.subscribe).toHaveBeenCalledTimes(1)
    resolveFirst(page(1, null))
    const [oldDisconnect, newDisconnect] = await Promise.all([oldConnection, newConnection])

    expect(useGitHubIssues.getState().projects.p1.pages.ungrouped.items[0].number).toBe(3)
    oldDisconnect()
    expect(client.unsubscribe).not.toHaveBeenCalled()
    expect(useGitHubIssues.getState().projects.p1.pages.ungrouped.items[0].number).toBe(3)

    newDisconnect()
    expect(client.unsubscribe).toHaveBeenCalledTimes(1)
    expect(useGitHubIssues.getState().projects.p1).toBeUndefined()
  })

  it('releases the shared host subscription when a replacement connection fails', async () => {
    const client = api()
    const oldDisconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    vi.mocked(client.query).mockRejectedValueOnce(new Error('replacement failed'))

    const newDisconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    oldDisconnect()
    expect(client.unsubscribe).not.toHaveBeenCalled()

    newDisconnect()
    expect(client.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('keeps pending subscriptions separate when the project changes host API', async () => {
    const oldApi = api()
    const newApi = api()
    let resolveOld!: (value: ReturnType<typeof page>) => void
    vi.mocked(oldApi.subscribe).mockReturnValue(new Promise((resolve) => { resolveOld = resolve }))

    const oldConnection = useGitHubIssues.getState().connect(oldApi, 'p1', ['todo'])
    const newDisconnect = await useGitHubIssues.getState().connect(newApi, 'p1', ['todo'])
    expect(oldApi.subscribe).toHaveBeenCalledTimes(1)
    expect(newApi.subscribe).toHaveBeenCalledTimes(1)
    resolveOld(page(1, null))
    const oldDisconnect = await oldConnection

    expect(oldApi.unsubscribe).toHaveBeenCalledTimes(1)
    expect(useGitHubIssues.getState().projects.p1.pages.ungrouped.items[0].number).toBe(3)
    oldDisconnect()
    newDisconnect()
    expect(newApi.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('keeps a refresh delta that arrives while initial column queries are pending', async () => {
    const client = api()
    let changed!: (changedIssueNumbers: number[]) => void
    vi.mocked(client.onChanged).mockImplementation((_projectId, callback) => {
      changed = callback
      return () => undefined
    })
    let resolveInitial!: (value: ReturnType<typeof page>) => void
    let initialStarted!: () => void
    const started = new Promise<void>((resolve) => { initialStarted = resolve })
    vi.mocked(client.query).mockImplementationOnce(async () => {
      initialStarted()
      return new Promise((resolve) => { resolveInitial = resolve })
    }).mockImplementation(async (request) =>
      page(request.columnId === 'todo' ? 20 : 30, request.columnId))

    const connecting = useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    await started
    changed([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveInitial(page(2, 'todo'))
    const disconnect = await connecting

    expect(useGitHubIssues.getState().projects.p1.pages.ungrouped.items[0].number).toBe(30)
    expect(useGitHubIssues.getState().projects.p1.pages.todo.items[0].number).toBe(20)
    disconnect()
  })

  it('subscribes once and loads every visible column, in both kinds', async () => {
    const client = api()
    const disconnect = await useGitHubIssues.getState().connect(
      client, 'p1', ['todo', 'done'], ['github:bug']
    )
    expect(client.subscribe).toHaveBeenCalledWith('p1')
    // Three columns × two kinds. Both are served from the one cached snapshot in core, so the
    // pull pass is a read of data the refresh already fetched.
    expect(client.query).toHaveBeenCalledTimes(6)
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({ labelFilter: ['github:bug'] }))
    expect(useGitHubIssues.getState().projects.p1.pages.todo.items[0].number).toBe(2)
    expect(useGitHubIssues.getState().projects.p1.pullPages.todo.items[0].number).toBe(200)
    disconnect()
    expect(client.unsubscribe).toHaveBeenCalledWith('p1')
  })

  it('pages more of the kind it was asked for, leaving the other lane alone', async () => {
    const client = api()
    vi.mocked(client.query).mockImplementation(async (request) => request.kind === 'pull'
      ? pullPage(request.cursor ? 201 : 200, request.columnId, request.cursor ? undefined : '1')
      : page(2, request.columnId))
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])

    await useGitHubIssues.getState().loadMore(client, 'p1', 'todo', 'pull')
    expect(useGitHubIssues.getState().projects.p1.pullPages.todo.items.map((item) => item.number))
      .toEqual([200, 201])
    expect(useGitHubIssues.getState().projects.p1.pages.todo.items.map((item) => item.number))
      .toEqual([2])
    disconnect()
  })

  it('marks only the issue being moved and exposes an actionable non-confirmed status', async () => {
    const client = api()
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    let resolveMove!: (value: { status: 'configuration-changed' }) => void
    vi.mocked(client.moveIssue).mockReturnValue(new Promise((resolve) => { resolveMove = resolve }))
    const moving = useGitHubIssues.getState().move(client, 'p1', 2, 'done', '2026-08-09T00:00:00Z')
    expect(useGitHubIssues.getState().projects.p1.moving[2]).toBe(true)
    resolveMove({ status: 'configuration-changed' })
    await moving
    expect(useGitHubIssues.getState().projects.p1.moving[2]).toBeUndefined()
    expect(useGitHubIssues.getState().projects.p1.issueStatus[2]).toContain('settings changed')
    disconnect()
  })

  it('passes the chosen close reason through to the host', async () => {
    const client = api()
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    await useGitHubIssues.getState().move(client, 'p1', 2, 'done', '2026-08-09T00:00:00Z', 'not_planned')
    expect(client.moveIssue).toHaveBeenCalledWith({
      projectId: 'p1', issueNumber: 2, toColumnId: 'done',
      expectedUpdatedAt: '2026-08-09T00:00:00Z', closeReason: 'not_planned'
    })
    disconnect()
  })

  it('points a move refused for an unapproved mapping at the approval, not at a refresh', async () => {
    const client = api()
    vi.mocked(client.query).mockImplementation(async (request) => ({
      ...page(request.columnId === 'todo' ? 2 : 3, request.columnId),
      readOnly: true,
      mappingNotApproved: true as const
    }))
    vi.mocked(client.moveIssue).mockResolvedValue({ status: 'read-only' })
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    await useGitHubIssues.getState().move(client, 'p1', 2, 'done', '2026-08-09T00:00:00Z')
    const said = useGitHubIssues.getState().projects.p1.issueStatus[2]
    expect(said).toContain('Approve them in Settings')
    expect(said).not.toContain('refresh')
    disconnect()
  })

  it('catches a failed move so fire-and-forget UI calls do not reject', async () => {
    const client = api()
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    vi.mocked(client.moveIssue).mockRejectedValue(new Error('network down'))
    await expect(useGitHubIssues.getState().move(
      client, 'p1', 2, 'done', '2026-08-09T00:00:00Z'
    )).resolves.toEqual({ status: 'failed', message: 'network down' })
    expect(useGitHubIssues.getState().projects.p1.issueStatus[2]).toContain('network down')
    disconnect()
  })

  it('loads the pull board with the pages and refreshes it on reload', async () => {
    const client = api()
    const board = (number: number) => ({
      pulls: [{ number, lifecycle: 'open' as const, headRefName: 'x', closes: [], ci: 'passed' as const }],
      observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
    })
    vi.mocked(client.pullStatus).mockResolvedValueOnce(board(1)).mockResolvedValueOnce(board(2))
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    expect(useGitHubIssues.getState().projects.p1.pullBoard?.pulls[0].number).toBe(1)
    await useGitHubIssues.getState().reload(client, 'p1')
    expect(useGitHubIssues.getState().projects.p1.pullBoard?.pulls[0].number).toBe(2)
    disconnect()
  })

  it('a host that cannot answer pull status leaves the board working and the last pull board in place', async () => {
    const client = api()
    const board = {
      pulls: [], observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
    }
    vi.mocked(client.pullStatus).mockResolvedValueOnce(board).mockRejectedValueOnce(new Error('E_UNKNOWN_METHOD'))
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    await useGitHubIssues.getState().reload(client, 'p1')
    const project = useGitHubIssues.getState().projects.p1
    expect(project.error).toBeUndefined()
    expect(project.pages.todo.items).toHaveLength(1)
    expect(project.pullBoard).toEqual(board)
    disconnect()
  })
})
