import { readFileSync } from 'fs'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import {
  HANDOFF_FOLD_MS,
  handoffsFor,
  noteHandoff,
  resetHandoffsForTests,
  suppressDoneAfterHandoff
} from './handoffPings'

const ME = { name: 'enes', color: '#0a84ff' }
const SAM = { name: 'sam', color: '#ff453a' }

const board = (assignments: ProjectKanban['assignments'], meta: ProjectKanban['meta'] = []): ProjectKanban => ({
  columns: [
    { id: 'todo', title: 'To Do', color: '#0a84ff', category: 'unstarted' },
    { id: 'doing', title: 'In Progress', color: '#ffd60a', category: 'started' },
    { id: 'review', title: 'Review', color: '#bf5af2', category: 'started' },
    { id: 'done', title: 'Done', color: '#32d74b', category: 'done' },
    { id: 'wontfix', title: "Won't fix", color: '#8e8e93', category: 'closed' },
    { id: 'plain', title: 'Plain', color: '#fff' }
  ],
  assignments,
  meta
})

const mine = [{ nodeId: 'n', assignees: [ME] }]
const from = (col: string) => board([{ nodeId: 'n', columnId: col }], mine)

describe('handoffsFor — which moves are a handoff to ME', () => {
  it('entering a started column past the FIRST one (review) is a handoff', () => {
    expect(handoffsFor(from('doing'), from('review'), 'enes')).toEqual([
      { nodeId: 'n', columnId: 'review', columnTitle: 'Review', category: 'started' }
    ])
  })

  it('entering a done column is a handoff', () => {
    expect(handoffsFor(from('review'), from('done'), 'enes')).toEqual([
      { nodeId: 'n', columnId: 'done', columnTitle: 'Done', category: 'done' }
    ])
  })

  it('routine moves are not: into the FIRST started column, back to not-started, closed, uncategorized', () => {
    expect(handoffsFor(from('todo'), from('doing'), 'enes')).toEqual([])
    expect(handoffsFor(from('doing'), from('todo'), 'enes')).toEqual([])
    expect(handoffsFor(from('doing'), from('wontfix'), 'enes')).toEqual([])
    expect(handoffsFor(from('doing'), from('plain'), 'enes')).toEqual([])
  })

  it('a card filed straight from Ungrouped into Done counts', () => {
    const before = board([], mine)
    expect(handoffsFor(before, from('done'), 'enes')).toHaveLength(1)
  })

  it('a reorder within the column is not a move', () => {
    const a = board([{ nodeId: 'x', columnId: 'done' }, { nodeId: 'n', columnId: 'done' }], mine)
    const b = board([{ nodeId: 'n', columnId: 'done' }, { nodeId: 'x', columnId: 'done' }], mine)
    expect(handoffsFor(a, b, 'enes')).toEqual([])
  })

  it('only for cards assigned to ME — unassigned or someone else’s cards never ping here', () => {
    expect(handoffsFor(board([{ nodeId: 'n', columnId: 'doing' }]), board([{ nodeId: 'n', columnId: 'done' }]), 'enes')).toEqual([])
    const sams = [{ nodeId: 'n', assignees: [SAM] }]
    expect(
      handoffsFor(board([{ nodeId: 'n', columnId: 'doing' }], sams), board([{ nodeId: 'n', columnId: 'done' }], sams), 'enes')
    ).toEqual([])
  })

  it('a board with no categories never pings (it has not said what a handoff is)', () => {
    const plain = (col: string): ProjectKanban => ({
      columns: [{ id: 'a', title: 'A', color: '#fff' }, { id: 'b', title: 'B', color: '#fff' }],
      assignments: [{ nodeId: 'n', columnId: col }],
      meta: mine
    })
    expect(handoffsFor(plain('a'), plain('b'), 'enes')).toEqual([])
  })
})

describe('folding the turn-end notification into a handoff ping', () => {
  beforeEach(() => resetHandoffsForTests())

  it('a "finished" notification right after a handoff ping for the same node is folded', () => {
    noteHandoff('n', 1000)
    expect(suppressDoneAfterHandoff('n', 1000 + HANDOFF_FOLD_MS - 1)).toBe(true)
  })

  it('only for that node, and only inside the window', () => {
    noteHandoff('n', 1000)
    expect(suppressDoneAfterHandoff('other', 1001)).toBe(false)
    expect(suppressDoneAfterHandoff('n', 1000 + HANDOFF_FOLD_MS + 1)).toBe(false)
  })

  it('folds ONE notification per handoff — a later turn end still notifies', () => {
    noteHandoff('n', 1000)
    expect(suppressDoneAfterHandoff('n', 2000)).toBe(true)
    expect(suppressDoneAfterHandoff('n', 3000)).toBe(false)
  })
})

// Canvas is too large to mount here; these pin that the two halves are actually wired — a pure
// module nobody calls would pass every test above and ship inert.
describe('Canvas wiring (source pins)', () => {
  const source = (): string => readFileSync('src/renderer/canvas/Canvas.tsx', 'utf8')

  it('the assign verb pings the handoffs of the move it just made, under the existing consent', () => {
    const src = source()
    const assign = src.slice(src.indexOf("case 'assign': {"), src.indexOf("case 'assign': {") + 6000)
    expect(assign).toContain('handoffsFor(prev, next, me)')
    expect(assign).toContain('noteHandoff(h.nodeId, now)')
    expect(assign).toContain('notifyPrefs.notifyOnClaudeDone && notifyPrefs.notifyConsentAsked')
    expect(assign).toContain('!document.hasFocus()')
  })

  it('the turn-end alert folds into a handoff ping just sent (and only the done sound)', () => {
    expect(source()).toContain("if (sound === 'done' && suppressDoneAfterHandoff(e.nodeId, Date.now())) return")
  })
})
