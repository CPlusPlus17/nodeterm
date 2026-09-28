// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import { usePullAutoMove } from './usePullAutoMove'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const board: ProjectKanban = {
  columns: [{ id: 'doing', title: 'Doing', color: '#fff' }, { id: 'done', title: 'Done', color: '#fff' }],
  assignments: [{ nodeId: 'card-1', columnId: 'doing' }],
  github: { columnMappings: [], repository: 'o/r' }
}
const cards = [{ id: 'card-1', kind: 'terminal', worktreeBranch: 'feat/x' }]
const merged: GitHubPullBoard = {
  pulls: [{ number: 12, lifecycle: 'merged', headRefName: 'feat/x', closes: [], openSeen: true, mergedSeenAt: 2_000 }],
  observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
}

/** The host's claim: the first ask for a key wins, like GitHubPullStatusTracker.claim. */
function hostClaims() {
  const claimed = new Set<string>()
  return {
    claimPullAutoMove: vi.fn(async (request: { projectId: string; cardId: string; pulls: number[] }) => {
      const key = `${request.projectId}:${request.cardId}:${request.pulls.join(',')}`
      if (claimed.has(key)) return false
      claimed.add(key)
      return true
    })
  }
}

function Probe(props: {
  api: ReturnType<typeof hostClaims>
  pullBoard: GitHubPullBoard
  onAutoMove: (...args: unknown[]) => void
}): null {
  usePullAutoMove({ api: props.api, projectId: 'p1', cards, board, pullBoard: props.pullBoard, onAutoMove: props.onAutoMove })
  return null
}

function arm(remote = false): void {
  useProjects.setState({
    activeProjectId: 'p1',
    projects: [{ id: 'p1', name: 'P', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...(remote ? { remote: true } : {}) }]
  } as never)
  useSettings.setState({
    settings: { ...useSettings.getState().settings, kanbanPullAutoMove: { projects: { p1: { columnId: 'done', armedAt: 1_000 } } } }
  })
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

beforeEach(() => arm())

describe('usePullAutoMove', () => {
  it('moves once after winning the host claim, and never writes settings', async () => {
    const api = hostClaims()
    const onAutoMove = vi.fn()
    const before = useSettings.getState().settings
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove} />))
    act(() => root.render(<Probe api={api} pullBoard={{ ...merged }} onAutoMove={onAutoMove} />))
    await settle()
    expect(onAutoMove).toHaveBeenCalledTimes(1)
    expect(onAutoMove).toHaveBeenCalledWith('card-1', 'doing', 'done', 'PR #12 merged')
    expect(api.claimPullAutoMove).toHaveBeenCalledWith({ projectId: 'p1', cardId: 'card-1', pulls: [12] })
    expect(useSettings.getState().settings).toBe(before)
  })

  it('two windows on one host: only the one that wins the claim moves the card', async () => {
    const api = hostClaims()
    const first = vi.fn()
    const second = vi.fn()
    act(() => createRoot(document.createElement('div')).render(<Probe api={api} pullBoard={merged} onAutoMove={first} />))
    act(() => createRoot(document.createElement('div')).render(<Probe api={api} pullBoard={merged} onAutoMove={second} />))
    await settle()
    expect(first.mock.calls.length + second.mock.calls.length).toBe(1)
  })

  it('never moves a card on a relay tab — that board belongs to the other machine', async () => {
    arm(true)
    const api = hostClaims()
    const onAutoMove = vi.fn()
    act(() => createRoot(document.createElement('div')).render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove} />))
    await settle()
    expect(onAutoMove).not.toHaveBeenCalled()
    expect(api.claimPullAutoMove).not.toHaveBeenCalled()
  })
})
