import { describe, expect, it } from 'vitest'
import { StationHandoverTracker, STATION_HANDOVER_MAX_TRACKED } from './station-handover'

function tracker() {
  let clock = 1_000
  const pushes: string[][] = []
  const t = new StationHandoverTracker(
    (records) => pushes.push(records.map((r) => r.nodeId)),
    () => clock
  )
  return {
    t,
    pushes,
    at: (ms: number) => {
      clock = ms
      return ms
    },
    ev: (state: 'working' | 'waiting' | 'blocked' | 'done', ms?: number) => {
      if (ms !== undefined) clock = ms
      t.onAgentEvent({ nodeId: 'st', state })
    }
  }
}

describe('StationHandoverTracker — when a station counts as finished for plain --after', () => {
  it('a QUEUED send holds the station from the moment it is queued, whatever it reads', () => {
    const h = tracker()
    h.ev('working', 100)
    h.t.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st' })
    expect(h.t.isHandedOver('st')).toBe(true)
    // The station finishes its OLD task: still held (the message has not even landed).
    h.ev('done', 200)
    expect(h.t.isHandedOver('st')).toBe(true)
    // The queue flushes on that idle edge.
    h.t.onHandover({ phase: 'landed', verb: 'send', targetNodeId: 'st', at: h.at(210) })
    h.t.onHandover({ phase: 'settled', verb: 'send', targetNodeId: 'st', landed: true })
    expect(h.t.isHandedOver('st')).toBe(true)
    // The new task's turn starts and ends: released.
    h.ev('working', 220)
    expect(h.t.isHandedOver('st')).toBe(true)
    h.ev('done', 300)
    expect(h.t.isHandedOver('st')).toBe(false)
    expect(h.t.list()).toEqual([])
  })

  it('landed on an idle station but not started yet: the old done does not count', () => {
    const h = tracker()
    h.ev('working', 100)
    h.ev('done', 200)
    h.t.onHandover({ phase: 'landed', verb: 'reply', targetNodeId: 'st', at: 300 })
    expect(h.t.isHandedOver('st')).toBe(true)
    expect(h.t.list()).toEqual([{ nodeId: 'st', since: 300 }])
    // An idle-prompt style `done` with no turn in between releases nothing.
    h.ev('done', 350)
    expect(h.t.isHandedOver('st')).toBe(true)
    h.ev('working', 400)
    h.ev('done', 500)
    expect(h.t.isHandedOver('st')).toBe(false)
  })

  it('a turn that started and ENDED before the delivery reported back already answers it', () => {
    const h = tracker()
    h.ev('done', 100)
    // The delivery attempt started at 200; the prompt's turn ran 210–260; `landed` is emitted at 270.
    h.ev('working', 210)
    h.ev('done', 260)
    h.at(270)
    h.t.onHandover({ phase: 'landed', verb: 'send', targetNodeId: 'st', at: 200 })
    expect(h.t.isHandedOver('st')).toBe(false)
  })

  it('work landing in a turn ALREADY in progress waits for a turn that starts after it', () => {
    const h = tracker()
    h.ev('working', 100)
    h.t.noteControlAnswer('write', { node: 'st', text: 'x' }, { ok: true }, 'orch', 150)
    expect(h.t.isHandedOver('st')).toBe(true)
    h.ev('blocked', 160) // still the same turn
    h.ev('working', 170)
    h.ev('done', 200) // the OLD turn ends
    expect(h.t.isHandedOver('st')).toBe(true)
    h.ev('working', 210)
    h.ev('done', 300)
    expect(h.t.isHandedOver('st')).toBe(false)
  })

  it('write / run count from when the request ARRIVED, only on success, never for the caller itself', () => {
    const h = tracker()
    h.ev('done', 100)
    h.t.noteControlAnswer('write', { node: 'st' }, { ok: false }, 'orch', 150)
    h.t.noteControlAnswer('close', { node: 'st' }, { ok: true }, 'orch', 150)
    h.t.noteControlAnswer('write', { node: 'st' }, { ok: true }, 'st', 150)
    expect(h.t.isHandedOver('st')).toBe(false)
    // run: the turn the launch starts (at 160) happened before main heard the answer (at 400).
    h.ev('working', 160)
    h.ev('done', 390)
    h.at(400)
    h.t.noteControlAnswer('run', { node: 'st' }, { ok: true }, 'orch', 150)
    expect(h.t.isHandedOver('st')).toBe(false)
    // A comma list marks each named node.
    h.t.noteControlAnswer('write', { node: 'st, other' }, { ok: true }, 'orch', 500)
    expect(h.t.isHandedOver('st')).toBe(true)
    expect(h.t.isHandedOver('other')).toBe(true)
  })

  it('a queued message that never lands still holds, until the station finishes a later turn', () => {
    const h = tracker()
    h.ev('working', 100)
    h.t.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st' })
    h.ev('done', 200)
    h.at(250)
    h.t.onHandover({ phase: 'settled', verb: 'send', targetNodeId: 'st', landed: false })
    expect(h.t.isHandedOver('st')).toBe(true)
    h.ev('working', 300)
    h.ev('done', 400)
    expect(h.t.isHandedOver('st')).toBe(false)
  })

  it('board comments and station notices are not a hand-over (#1042 counts the same set)', () => {
    const h = tracker()
    h.t.onHandover({ phase: 'queued', verb: 'board-comment', targetNodeId: 'st' })
    h.t.onHandover({ phase: 'landed', verb: 'station-notice', targetNodeId: 'st', at: 5 })
    expect(h.t.isHandedOver('st')).toBe(false)
    expect(h.pushes).toEqual([])
  })

  it('pushes the whole list only when it changes, and bounds what it tracks', () => {
    const h = tracker()
    h.t.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st' })
    h.ev('working', 10)
    h.ev('done', 20)
    expect(h.pushes).toEqual([['st']])
    for (let i = 0; i < STATION_HANDOVER_MAX_TRACKED + 5; i++) h.t.onAgentEvent({ nodeId: `n${i}`, state: 'done' })
    // The oldest station is the held one, and it is NOT the one evicted: dropping it would release
    // its dependents. The overflow comes out of the stations with nothing handed over.
    expect(h.t.isHandedOver('st')).toBe(true)
    expect(h.t.list().map((r) => r.nodeId)).toEqual(['st'])
  })

  it('ignores unsafe ids and stateless events', () => {
    const h = tracker()
    h.t.markHandedOver('../x', 5)
    h.t.onAgentEvent({ nodeId: 'st', state: undefined })
    expect(h.t.list()).toEqual([])
  })
})
