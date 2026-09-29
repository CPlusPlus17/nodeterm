import { describe, expect, it } from 'vitest'
import { normalizePendingLaunch } from './pending-launch-shape'
import { INVALID_PR_WAIT_HOLD } from './pr-wait'

describe('normalizePendingLaunch — the held launch as a hostile project file carries it', () => {
  it('absent, null and non-objects are no hold', () => {
    expect(normalizePendingLaunch(undefined)).toBeUndefined()
    expect(normalizePendingLaunch(null)).toBeUndefined()
    expect(normalizePendingLaunch('claude')).toBeUndefined()
    expect(normalizePendingLaunch([])).toBeUndefined()
  })

  it('a hold with no typeable command is no hold — there is nothing to launch', () => {
    expect(normalizePendingLaunch({ after: [], command: 42 })).toBeUndefined()
  })

  it('a well-formed hold round-trips unchanged', () => {
    const hold = {
      after: ['a', 'b'],
      command: 'claude "go"',
      attempted: false,
      awaitSetupGroup: 'g1',
      afterPr: { repository: 'o/r', waits: [{ number: 3, until: 'merged' as const }], deadlineAt: 99 }
    }
    expect(normalizePendingLaunch(hold)).toEqual(hold)
  })

  it('an `after` that is not a list becomes a MANUAL hold instead of throwing in the launch loop', () => {
    // `p.after.every(...)` and the canvas's dep signature both iterate it. A string would iterate
    // its characters; a number throws. An empty list would fire the node at once — early.
    const out = normalizePendingLaunch({ after: 'a,b', command: 'x' })
    expect(out).toMatchObject({ after: [], command: 'x', manualOnly: true })
  })

  it('non-string dependency ids are dropped AND the hold turns manual — the dep set is not what was armed', () => {
    const out = normalizePendingLaunch({ after: ['a', 7, { id: 'b' }], command: 'x' })
    expect(out).toMatchObject({ after: ['a'], manualOnly: true })
  })

  it('a malformed PR wait stays a hold that never fires by itself', () => {
    const out = normalizePendingLaunch({ after: [], command: 'x', afterPr: { repository: 5 } })
    expect(out?.afterPr).toEqual(INVALID_PR_WAIT_HOLD)
  })

  it('an unreadable setup gate or executor turns the hold manual rather than opening it early', () => {
    expect(normalizePendingLaunch({ after: [], command: 'x', awaitSetupGroup: 3 })).toMatchObject({
      manualOnly: true
    })
    expect(normalizePendingLaunch({ after: [], command: 'x', executor: 'robot' })).toMatchObject({
      manualOnly: true
    })
  })

  it('keeps a field this build does not know, so an older save does not erase a newer one', () => {
    expect(normalizePendingLaunch({ after: [], command: 'x', futureGate: { k: 1 } })).toMatchObject({
      futureGate: { k: 1 }
    })
  })

  it('never throws, whatever it is handed', () => {
    const weird: unknown[] = [
      { after: null, command: 'x' },
      { after: [], command: 'x', attempted: 'yes', manualOnly: 1 },
      { after: [], command: 'x', awaitWorking: 'a' },
      { after: [], command: 'x', afterPr: [] },
      Object.create(null)
    ]
    for (const w of weird) expect(() => normalizePendingLaunch(w)).not.toThrow()
  })
})
