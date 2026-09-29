// Board dispatch's security rests on ONE fact: a run starts only from the move a person makes in
// this app. `decideDispatch` refuses every origin but `'user-move'`, so the remaining question is
// who may SAY `'user-move'` — and the answer must stay "the board's own move-result path". A
// refresh that finds a card in the dispatch column (a label someone set on GitHub) or a board that
// arrives by git pull must have no path into it. This scan pins the whole chain, line by line.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

const src = files(ROOT).map((p) => ({ p: p.slice(ROOT.length + 1), text: readFileSync(p, 'utf8').replace(/\r\n/g, '\n') }))

function sitesOf(pattern: RegExp): string[] {
  return src.flatMap(({ p, text }) =>
    text.split('\n').flatMap((line) => (pattern.test(line) && !/^\s*(\/\/|\*)/.test(line) ? [p] : []))
  )
}

describe('board dispatch: the trigger is the person\'s own move, and nothing else', () => {
  it("only Canvas's dispatchOnUserMove asks decideDispatch, and only with origin 'user-move'", () => {
    expect(sitesOf(/decideDispatch\(/)).toEqual(['canvas/Canvas.tsx', 'lib/boardDispatch.ts'])
    expect(sitesOf(/origin: 'user-move'/)).toEqual(['canvas/Canvas.tsx'])
    const canvas = src.find((f) => f.p === 'canvas/Canvas.tsx')!.text
    const body = canvas.slice(canvas.indexOf('const dispatchOnUserMove = useCallback'))
    expect(body.indexOf("origin: 'user-move'")).toBeLessThan(body.indexOf('const drainDispatchQueue'))
  })

  it("dispatchOnUserMove is wired ONLY to the board's onIssueMoved", () => {
    expect(sitesOf(/dispatchOnUserMove\b/)).toEqual(['canvas/Canvas.tsx', 'canvas/Canvas.tsx'])
    const canvas = src.find((f) => f.p === 'canvas/Canvas.tsx')!.text
    const uses = canvas
      .split('\n')
      .filter((l) => /dispatchOnUserMove\b/.test(l) && !/const dispatchOnUserMove/.test(l) && !/^\s*(\/\/|\*)/.test(l))
    expect(uses.map((l) => l.trim())).toEqual(['onIssueMoved={dispatchOnUserMove}'])
  })

  it('onIssueMoved fires only after a person-initiated GitHub move (moveIssueByUser)', () => {
    expect(sitesOf(/onIssueMoved\?\.\(/)).toEqual(['components/kanban/KanbanView.tsx'])
    const view = src.find((f) => f.p === 'components/kanban/KanbanView.tsx')!.text
    const fire = view.indexOf('onIssueMoved?.(')
    expect(view.lastIndexOf('const moveIssueByUser = useCallback', fire)).toBeGreaterThan(-1)
    // moveIssueByUser is called from exactly the two human paths: requestGitHubMove (drag, Move
    // control, summary modal) and the close/reopen confirm dialog's onConfirm.
    const calls = view.split('\n').filter((l) => /moveIssueByUser\(/.test(l) && !/const moveIssueByUser/.test(l))
    expect(calls.map((l) => l.trim())).toEqual([
      'void moveIssueByUser(issue, columnId)',
      'void moveIssueByUser(issue, columnId, closeReason)'
    ])
  })

  it('the refresh / sync code never reaches the dispatcher', () => {
    for (const file of ['state/githubIssues.ts']) {
      const text = src.find((f) => f.p === file)!.text
      expect(text).not.toMatch(/boardDispatch|onIssueMoved|dispatchOnUserMove/)
    }
  })
})
