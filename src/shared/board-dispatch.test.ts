import { describe, expect, it } from 'vitest'
import {
  BOARD_DISPATCH_MAX_CONCURRENT,
  clampConcurrent,
  pruneBoardDispatch,
  sanitizeBoardDispatch
} from './board-dispatch'

describe('sanitizeBoardDispatch (settings.json is hand-editable)', () => {
  it('absent or garbage is off everywhere, not paused', () => {
    for (const raw of [undefined, null, 5, 'x', [], { projects: [] }, { projects: 'x' }]) {
      expect(sanitizeBoardDispatch(raw)).toEqual({ paused: false, projects: {} })
    }
  })

  it('keeps a well-formed entry', () => {
    const out = sanitizeBoardDispatch({
      paused: false,
      projects: { p1: { columnId: 'col-a', agentId: 'claude', accountId: 'acc1', maxConcurrent: 3 } }
    })
    expect(out.projects.p1).toEqual({ columnId: 'col-a', agentId: 'claude', accountId: 'acc1', maxConcurrent: 3 })
  })

  it('drops an entry with no column or an unsafe agent id — it is OFF, never guessed', () => {
    const out = sanitizeBoardDispatch({
      projects: {
        a: { agentId: 'claude', maxConcurrent: 1 },
        b: { columnId: 'c', agentId: 'claude; rm -rf ~' },
        c: { columnId: 'c', agentId: 42 },
        d: { columnId: 'c', agentId: 'custom:3f2a' }
      }
    })
    expect(Object.keys(out.projects)).toEqual(['d'])
  })

  it('drops an unsafe account id but keeps the entry (project default)', () => {
    const out = sanitizeBoardDispatch({ projects: { p: { columnId: 'c', agentId: 'codex', accountId: '../x' } } })
    expect(out.projects.p).toEqual({ columnId: 'c', agentId: 'codex', maxConcurrent: 1 })
  })

  it('clamps the cap DOWN on anything unreadable, and never above the max', () => {
    expect(clampConcurrent('9')).toBe(1)
    expect(clampConcurrent(NaN)).toBe(1)
    expect(clampConcurrent(0)).toBe(1)
    expect(clampConcurrent(-3)).toBe(1)
    expect(clampConcurrent(2.9)).toBe(2)
    expect(clampConcurrent(999)).toBe(BOARD_DISPATCH_MAX_CONCURRENT)
  })

  it('the kill switch is on only for a literal true', () => {
    expect(sanitizeBoardDispatch({ paused: true }).paused).toBe(true)
    expect(sanitizeBoardDispatch({ paused: 'true' }).paused).toBe(false)
    expect(sanitizeBoardDispatch({ paused: 1 }).paused).toBe(false)
  })
})

describe('pruneBoardDispatch', () => {
  it('drops projects this machine no longer has, keeps the switch', () => {
    const value = sanitizeBoardDispatch({
      paused: true,
      projects: { keep: { columnId: 'c', agentId: 'claude' }, gone: { columnId: 'c', agentId: 'claude' } }
    })
    const out = pruneBoardDispatch(value, new Set(['keep']))
    expect(out.paused).toBe(true)
    expect(Object.keys(out.projects)).toEqual(['keep'])
  })
})
