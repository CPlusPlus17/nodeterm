import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createControlForwarder, controlTimeoutError } from './control-forward'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createControlForwarder', () => {
  it('resolves with the renderer answer that carries its request id', async () => {
    const sent: string[] = []
    const fwd = createControlForwarder({ timeoutMs: 1000 })
    const p = fwd.forward('open-agent', (id) => sent.push(id))
    fwd.answer({ requestId: sent[0], ok: true, message: 'opened n1' })
    await expect(p).resolves.toEqual({ ok: true, message: 'opened n1' })
  })

  it('a timeout is INDETERMINATE: the renderer may still do it, so nobody may claim it did not happen', async () => {
    const fwd = createControlForwarder({ timeoutMs: 1000 })
    const p = fwd.forward('open-worktree', () => {})
    vi.advanceTimersByTime(1000)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.indeterminate).toBe(true)
  })

  it('an answer that arrives after the timeout is handed to the late-answer callback, once', async () => {
    const sent: string[] = []
    const late = vi.fn()
    const fwd = createControlForwarder({ timeoutMs: 1000, lateWindowMs: 60_000 })
    const p = fwd.forward('open-worktree', (id) => sent.push(id), late)
    vi.advanceTimersByTime(1000)
    await p
    fwd.answer({ requestId: sent[0], ok: true, message: 'opened worktree feat-x' })
    fwd.answer({ requestId: sent[0], ok: true, message: 'a duplicate answer' })
    expect(late).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledWith({ ok: true, message: 'opened worktree feat-x' })
  })

  it('forgets a late answer past its window, and never calls a callback nobody registered', async () => {
    const sent: string[] = []
    const late = vi.fn()
    const fwd = createControlForwarder({ timeoutMs: 1000, lateWindowMs: 5000 })
    const p = fwd.forward('open-terminal', (id) => sent.push(id), late)
    vi.advanceTimersByTime(1000)
    await p
    vi.advanceTimersByTime(5000)
    fwd.answer({ requestId: sent[0], ok: true, message: 'too late' })
    expect(late).not.toHaveBeenCalled()
    // No callback: a late answer is dropped exactly as before.
    const q = fwd.forward('open-terminal', (id) => sent.push(id))
    vi.advanceTimersByTime(1000)
    await q
    expect(() => fwd.answer({ requestId: sent[1], ok: true })).not.toThrow()
  })

  it('an answer for an unknown request id is ignored', () => {
    const fwd = createControlForwarder({ timeoutMs: 1000 })
    expect(() => fwd.answer({ requestId: 'nope', ok: true })).not.toThrow()
  })
})

describe('controlTimeoutError', () => {
  it('a confirm-gated verb keeps its dialog wording: the dialog dismisses itself at the same deadline', () => {
    expect(controlTimeoutError('write', 120_000)).toBe(
      'no answer within 120s — the confirmation dialog has been dismissed; safe to retry'
    )
  })

  it('a verb that creates something is NOT called safe to retry: the renderer was not cancelled', () => {
    const msg = controlTimeoutError('open-worktree', 120_000)
    expect(msg).toMatch(/^no answer within 120s/)
    expect(msg).not.toMatch(/safe to retry/)
    expect(msg).toMatch(/may still complete/)
    expect(msg).toMatch(/--request-id/)
    expect(msg).toMatch(/`list`/)
  })

  it('any other verb is told to check before retrying, and is not pointed at a flag it cannot take', () => {
    const msg = controlTimeoutError('rename', 120_000)
    expect(msg).not.toMatch(/safe to retry/)
    expect(msg).not.toMatch(/--request-id/)
    expect(msg).toMatch(/may still complete/)
  })
})
