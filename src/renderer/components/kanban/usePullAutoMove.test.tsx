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
  pulls: [{ number: 12, lifecycle: 'merged', headRefName: 'feat/x', closes: [] }],
  observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
}

function Probe(props: { pullBoard: GitHubPullBoard; onAutoMove: (...args: unknown[]) => void }): null {
  usePullAutoMove({ projectId: 'p1', cards, board, pullBoard: props.pullBoard, onAutoMove: props.onAutoMove })
  return null
}

function arm(remote = false): void {
  useProjects.setState({
    activeProjectId: 'p1',
    projects: [{ id: 'p1', name: 'P', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...(remote ? { remote: true } : {}) }]
  } as never)
  useSettings.setState((state) => ({
    settings: {
      ...state.settings,
      kanbanPullAutoMove: { projects: { p1: { columnId: 'done', seen: { 'card-1': { '12': 'open' } } } } }
    }
  }))
}

beforeEach(() => arm())

describe('usePullAutoMove', () => {
  it('moves once on the observed merge and records it, so a re-run does not move again', () => {
    const onAutoMove = vi.fn()
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<Probe pullBoard={merged} onAutoMove={onAutoMove} />))
    act(() => root.render(<Probe pullBoard={{ ...merged }} onAutoMove={onAutoMove} />))
    expect(onAutoMove).toHaveBeenCalledTimes(1)
    expect(onAutoMove).toHaveBeenCalledWith('card-1', 'doing', 'done', 'PR #12 merged')
    expect(useSettings.getState().settings.kanbanPullAutoMove?.projects.p1.seen)
      .toEqual({ 'card-1': { '12': 'merged' } })
  })

  it('never moves a card on a relay tab — that board belongs to the other machine', () => {
    arm(true)
    const onAutoMove = vi.fn()
    act(() => createRoot(document.createElement('div')).render(<Probe pullBoard={merged} onAutoMove={onAutoMove} />))
    expect(onAutoMove).not.toHaveBeenCalled()
  })
})
