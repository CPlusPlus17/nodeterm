import { describe, it, expect, vi } from 'vitest'
import {
  OUTCOME_CLEARING_VERBS,
  STATION_OUTCOME_MAX_RECORDS,
  StationOutcomeStore,
  clearOutcomesAfterControl,
  handleReportOutcome,
  registerStationOutcomeIpc,
  type ReportOutcomeDeps
} from './station-outcome-store'
import { REPORT_OUTCOME_CONTROL_REFUSAL } from '../shared/station-outcome'
import { IPC } from '../shared/ipc'
import type { BoardLogEntry } from '../shared/types'

function deps(over: Partial<ReportOutcomeDeps> = {}): ReportOutcomeDeps & { log: BoardLogEntry[] } {
  const log: BoardLogEntry[] = []
  return {
    store: new StationOutcomeStore(),
    now: () => 1_000,
    projectIdOfNode: () => 'p1',
    appendBoardLog: async (_projectId, entry) => {
      log.push(entry)
      return true
    },
    newId: () => 'log-1',
    log,
    ...over
  }
}

describe('handleReportOutcome', () => {
  it('records the caller’s OWN outcome, logs it on its own card and tells it what that releases', async () => {
    const d = deps()
    const onRecorded = vi.fn()
    d.onRecorded = onRecorded
    const r = await handleReportOutcome(
      { nodeId: 'st1', args: { outcome: 'succeeded', note: 'tests\npass' }, verified: true },
      d
    )
    expect(r.ok).toBe(true)
    expect(r.message).toContain('recorded: your task succeeded — "tests pass"')
    expect(r.message).toContain('--after-success')
    expect(r.message).toContain('A new turn does not change it')
    expect(d.store.get('st1')).toEqual({ nodeId: 'st1', outcome: 'succeeded', note: 'tests pass', at: 1_000 })
    expect(d.log).toEqual([
      {
        id: 'log-1',
        ts: 1_000,
        author: { name: 'nodeterm', color: '#8b8b8b' },
        nodeId: 'st1',
        kind: 'event',
        event: { type: 'station-reported', from: 'st1', to: 'succeeded', title: 'tests pass' }
      }
    ])
    expect(onRecorded).toHaveBeenCalledWith(d.store.get('st1'))
  })

  it('refuses an unverified caller and records nothing — a forgeable success is not evidence', async () => {
    const d = deps()
    const r = await handleReportOutcome({ nodeId: 'st1', args: { outcome: 'succeeded' }, verified: false }, d)
    expect(r).toEqual({ ok: false, error: REPORT_OUTCOME_CONTROL_REFUSAL, message: REPORT_OUTCOME_CONTROL_REFUSAL })
    expect(d.store.list()).toEqual([])
    expect(d.log).toEqual([])
  })

  it('refuses a report about ANOTHER node and records nothing, for either node', async () => {
    const d = deps()
    const r = await handleReportOutcome(
      { nodeId: 'orchestrator', args: { outcome: 'succeeded', node: 'st1' }, verified: true },
      d
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^report-outcome-not-self:/)
    expect(d.store.get('st1')).toBeUndefined()
    expect(d.store.get('orchestrator')).toBeUndefined()
    expect(d.log).toEqual([])
  })

  it('a node that is in no saved project is still recorded — the wait reads the store, not the log', async () => {
    const d = deps({ projectIdOfNode: () => undefined })
    const r = await handleReportOutcome({ nodeId: 'st1', args: { outcome: 'failed' }, verified: true }, d)
    expect(r.ok).toBe(true)
    expect(d.store.get('st1')?.outcome).toBe('failed')
    expect(d.log).toEqual([])
    expect(r.result).toMatchObject({ boardLog: false })
  })

  it('a board log that cannot be written does not fail the report', async () => {
    const d = deps({ appendBoardLog: async () => Promise.reject(new Error('disk full')) })
    const r = await handleReportOutcome({ nodeId: 'st1', args: { outcome: 'failed' }, verified: true }, d)
    expect(r.ok).toBe(true)
    expect(d.store.get('st1')?.outcome).toBe('failed')
  })

  it('a later report supersedes the earlier one', async () => {
    const d = deps()
    await handleReportOutcome({ nodeId: 'st1', args: { outcome: 'failed' }, verified: true }, d)
    await handleReportOutcome({ nodeId: 'st1', args: { outcome: 'succeeded' }, verified: true }, d)
    expect(d.store.get('st1')?.outcome).toBe('succeeded')
    expect(d.store.list()).toHaveLength(1)
  })
})

describe('StationOutcomeStore', () => {
  it('publishes the WHOLE list, newest first, on every change', () => {
    const publish = vi.fn()
    const s = new StationOutcomeStore(publish)
    s.record({ nodeId: 'a', outcome: 'failed', at: 1 })
    s.record({ nodeId: 'b', outcome: 'succeeded', at: 2 })
    expect(publish).toHaveBeenLastCalledWith([
      { nodeId: 'b', outcome: 'succeeded', at: 2 },
      { nodeId: 'a', outcome: 'failed', at: 1 }
    ])
    expect(s.clear('a')).toBe(true)
    expect(publish).toHaveBeenLastCalledWith([{ nodeId: 'b', outcome: 'succeeded', at: 2 }])
    // Clearing nothing publishes nothing.
    const calls = publish.mock.calls.length
    expect(s.clear('zzz')).toBe(false)
    expect(publish.mock.calls.length).toBe(calls)
  })

  it('is bounded, evicting the oldest first', () => {
    const s = new StationOutcomeStore()
    for (let i = 0; i < STATION_OUTCOME_MAX_RECORDS + 3; i++) {
      s.record({ nodeId: `n${i}`, outcome: 'succeeded', at: i })
    }
    expect(s.list()).toHaveLength(STATION_OUTCOME_MAX_RECORDS)
    expect(s.get('n0')).toBeUndefined()
    expect(s.get('n2')).toBeUndefined()
    expect(s.get('n3')).toBeDefined()
  })

  it('serves the read channel from the store the thunk returns', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const s = new StationOutcomeStore()
    s.record({ nodeId: 'a', outcome: 'succeeded', at: 1 })
    let current: StationOutcomeStore | null = null
    registerStationOutcomeIpc({ handle: (ch, fn) => handlers.set(ch, fn) }, () => current)
    expect(handlers.get(IPC.stationOutcomeList)?.()).toEqual([])
    current = s
    expect(handlers.get(IPC.stationOutcomeList)?.()).toEqual([{ nodeId: 'a', outcome: 'succeeded', at: 1 }])
  })
})

describe('clearOutcomesAfterControl — new work handed through canvas control withdraws a report', () => {
  const seeded = () => {
    const s = new StationOutcomeStore()
    s.record({ nodeId: 'st1', outcome: 'succeeded', at: 1 })
    s.record({ nodeId: 'st2', outcome: 'succeeded', at: 2 })
    return s
  }

  it.each(['send', 'reply', 'write', 'run'])('a successful %s aimed at a station clears its report', (verb) => {
    const s = seeded()
    clearOutcomesAfterControl(s, verb, { node: 'st1', text: 'next task' }, { ok: true }, 'orch')
    expect(s.get('st1')).toBeUndefined()
    expect(s.get('st2')).toBeDefined()
  })

  it('a refused or failed request handed nothing, so nothing is cleared', () => {
    const s = seeded()
    clearOutcomesAfterControl(s, 'send', { node: 'st1' }, { ok: false }, 'orch')
    expect(s.get('st1')).toBeDefined()
  })

  it('notify types nothing into a pane, and other verbs hand no work', () => {
    const s = seeded()
    for (const verb of ['notify', 'rename', 'list', 'close', 'color', 'assign']) {
      clearOutcomesAfterControl(s, verb, { node: 'st1' }, { ok: true }, 'orch')
    }
    expect(s.get('st1')).toBeDefined()
    expect([...OUTCOME_CLEARING_VERBS].sort()).toEqual(['reply', 'run', 'send', 'write'])
  })

  it('a node writing into its OWN pane is not handed work by anyone', () => {
    const s = seeded()
    clearOutcomesAfterControl(s, 'write', { node: 'st1' }, { ok: true }, 'st1')
    expect(s.get('st1')).toBeDefined()
  })

  it('reads a comma list, and ignores an id it would not vouch for', () => {
    const s = seeded()
    clearOutcomesAfterControl(s, 'send', { node: 'st1, st2, ../x' }, { ok: true }, 'orch')
    expect(s.list()).toEqual([])
  })
})
