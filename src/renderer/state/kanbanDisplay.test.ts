import { describe, expect, it } from 'vitest'
import { parseKanbanDisplay, useKanbanDisplay } from './kanbanDisplay'

describe('parseKanbanDisplay', () => {
  it('reads a well-formed per-project map', () => {
    expect(parseKanbanDisplay('{"p1":{"showClosed":true},"p2":{"showClosed":false}}')).toEqual({
      p1: { showClosed: true },
      p2: { showClosed: false }
    })
  })

  it('is empty (every default) for missing or unparseable storage', () => {
    expect(parseKanbanDisplay(null)).toEqual({})
    expect(parseKanbanDisplay('{nope')).toEqual({})
    expect(parseKanbanDisplay('[1,2]')).toEqual({})
    expect(parseKanbanDisplay('"str"')).toEqual({})
  })

  it('keeps only literal booleans — a hand-edited value never flips a default', () => {
    expect(parseKanbanDisplay('{"p1":{"showClosed":"yes"},"p2":7,"p3":{"showClosed":true,"x":1}}')).toEqual({
      p1: {},
      p3: { showClosed: true }
    })
  })
})

describe('useKanbanDisplay', () => {
  it('closed columns are hidden until the user asks, per project', () => {
    const s = useKanbanDisplay.getState()
    expect(s.showClosed('p-a')).toBe(false)
    s.setShowClosed('p-a', true)
    expect(useKanbanDisplay.getState().showClosed('p-a')).toBe(true)
    expect(useKanbanDisplay.getState().showClosed('p-b')).toBe(false)
  })
})
