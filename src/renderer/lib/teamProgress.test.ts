import { describe, expect, it } from 'vitest'
import {
  parseTeamProgressSig,
  stationKind,
  stationsByOpener,
  summarizeTeam,
  teamProgressSig,
  teamProgressText,
  type StationNodeLike,
  type TeamStation
} from './teamProgress'
import type { AgentNodeStatus } from '../state/agentStatus'

const term = (id: string, extra: Partial<StationNodeLike> = {}): StationNodeLike => ({
  id,
  kind: 'terminal',
  title: id.toUpperCase(),
  agentId: 'claude',
  ...extra
})
const rope = (source: string, target: string) => ({ id: `ctrl-${source}-${target}`, source, target })
const st = (patch: Partial<AgentNodeStatus>): AgentNodeStatus => ({ unread: false, ...patch }) as AgentNodeStatus

describe('stationsByOpener', () => {
  it('groups the rope targets under the node that opened them, in rope order', () => {
    const map = stationsByOpener([rope('o', 'a'), rope('o', 'b')], [term('o'), term('a'), term('b')])
    expect(map.get('o')?.map((s) => s.id)).toEqual(['a', 'b'])
    expect(map.get('o')?.[0]).toEqual({ id: 'a', title: 'A', agentId: 'claude', queued: false })
  })

  it('a later rope into the same target is a wait, not a second opener (pipeline + verify panel)', () => {
    // o opened a, b, c; b waits on a, c waits on b (`--after` writes its dep rope AFTER the opener's).
    const ropes = [rope('o', 'a'), rope('o', 'b'), rope('a', 'b'), rope('o', 'c'), rope('b', 'c')]
    const map = stationsByOpener(ropes, [term('o'), term('a'), term('b'), term('c')])
    expect(map.get('o')?.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(map.has('a')).toBe(false)
    expect(map.has('b')).toBe(false)
  })

  it('a deleted station is not a station, and its wait rope is not promoted to opener', () => {
    const ropes = [rope('o', 'a'), rope('o', 'gone'), rope('a', 'gone')]
    const map = stationsByOpener(ropes, [term('o'), term('a')])
    expect(map.get('o')?.map((s) => s.id)).toEqual(['a'])
    expect(map.has('a')).toBe(false)
  })

  it('a deleted opener shows nowhere, and does not hand its station to the next rope', () => {
    const map = stationsByOpener([rope('gone', 'a'), rope('b', 'a')], [term('a'), term('b')])
    expect(map.size).toBe(0)
  })

  it('only session nodes are stations (a browser popup rope is lineage, not a team member)', () => {
    const map = stationsByOpener(
      [rope('o', 'web'), rope('o', 'note'), rope('o', 'a')],
      [term('o'), { id: 'web', kind: 'browser' }, { id: 'note', kind: 'sticky' }, term('a')]
    )
    expect(map.get('o')?.map((s) => s.id)).toEqual(['a'])
  })

  it('carries the held launch as `queued`', () => {
    const map = stationsByOpener([rope('o', 'a')], [term('o'), term('a', { queued: true })])
    expect(map.get('o')?.[0].queued).toBe(true)
  })

  it('reuses the previous arrays and map when nothing changed', () => {
    const nodes = [term('o'), term('a'), term('p'), term('b')]
    const ropes = [rope('o', 'a'), rope('p', 'b')]
    const first = stationsByOpener(ropes, nodes)
    const again = stationsByOpener(ropes, nodes.map((n) => ({ ...n })), first)
    expect(again).toBe(first)
    const renamed = stationsByOpener(ropes, [term('o'), term('a', { title: 'new' }), term('p'), term('b')], first)
    expect(renamed).not.toBe(first)
    expect(renamed.get('p')).toBe(first.get('p'))
    expect(renamed.get('o')).not.toBe(first.get('o'))
  })

  it('a dropped group changes the map identity', () => {
    const first = stationsByOpener([rope('o', 'a')], [term('o'), term('a')])
    expect(stationsByOpener([], [term('o'), term('a')], first)).not.toBe(first)
  })

  it('hostile ropes and nodes from a hand-edited project.json never throw', () => {
    const hostile: unknown[] = [
      null,
      5,
      'ctrl-o-a',
      [],
      { source: {}, target: 'a' },
      { source: 'o', target: 7 },
      { source: '', target: 'a' },
      { source: 'o', target: 'o' },
      { source: '__proto__', target: 'constructor' },
      { source: 'o', target: 'a', id: { evil: true } },
      Object.create(null)
    ]
    const nodes = [
      term('o'),
      term('a', { title: { toString: () => 'x' }, agentId: 42 }),
      term('__proto__'),
      term('constructor'),
      { id: 5, kind: 'terminal' },
      null as unknown as StationNodeLike
    ]
    for (const ropes of [hostile, 'nope', { length: 3 }, null, undefined, 12]) {
      expect(() => stationsByOpener(ropes, nodes)).not.toThrow()
    }
    const map = stationsByOpener(hostile, nodes)
    expect(map.get('o')).toEqual([{ id: 'a', title: '', queued: false }])
    expect(map.get('__proto__')?.map((s) => s.id)).toEqual(['constructor'])
    expect(() => stationsByOpener([rope('o', 'a')], 'nodes' as never)).not.toThrow()
  })
})

describe('stationKind', () => {
  const s = (patch: Partial<TeamStation> = {}): TeamStation => ({ id: 'a', title: 'A', agentId: 'claude', queued: false, ...patch })

  it('maps each hook state', () => {
    expect(stationKind(s(), st({ state: 'done' }))).toBe('done')
    expect(stationKind(s(), st({ state: 'working' }))).toBe('working')
    expect(stationKind(s(), st({ state: 'waiting' }))).toBe('needs')
    expect(stationKind(s(), st({ state: 'blocked' }))).toBe('needs')
    expect(stationKind(s(), st({ state: 'done', lastTurnError: { at: 1 } }))).toBe('errored')
    expect(stationKind(s(), st({ state: 'done', dropped: true }))).toBe('dropped')
  })

  it('unknown is unknown — never done — for an agent that can report', () => {
    expect(stationKind(s(), undefined)).toBe('unknown')
    expect(stationKind(s(), st({}))).toBe('unknown')
  })

  it('a node that can never report is untracked, not unknown', () => {
    expect(stationKind(s({ agentId: undefined }), undefined)).toBe('untracked')
    expect(stationKind(s({ agentId: 'custom:nohooks' }), undefined)).toBe('untracked')
    // …unless the store has seen it run a reporting agent (a hand-launched claude in a plain terminal).
    expect(stationKind(s({ agentId: undefined }), st({ agentId: 'claude' }))).toBe('unknown')
    expect(stationKind(s({ agentId: undefined }), st({ state: 'done' }))).toBe('done')
  })

  it('paused / hibernated survive a restart as a finished turn', () => {
    expect(stationKind(s(), st({ paused: true }))).toBe('paused')
    expect(stationKind(s(), st({ hibernated: true }))).toBe('paused')
  })

  it('a held launch outranks idle readings but not live ones', () => {
    expect(stationKind(s({ queued: true }), undefined)).toBe('queued')
    expect(stationKind(s({ queued: true }), st({ state: 'done' }))).toBe('queued')
    expect(stationKind(s({ queued: true }), st({ state: 'working' }))).toBe('working')
    expect(stationKind(s({ queued: true }), st({ state: 'waiting' }))).toBe('needs')
  })
})

describe('teamProgressSig / summarizeTeam', () => {
  const stations: TeamStation[] = ['d', 'w', 'n', 'e', 'x', 'q', 'u', 'p', 'plain'].map((id) => ({
    id,
    title: id,
    agentId: id === 'plain' ? undefined : 'claude',
    queued: id === 'q'
  }))
  const byId: Record<string, AgentNodeStatus> = {
    d: st({ state: 'done' }),
    w: st({ state: 'working' }),
    n: st({ state: 'blocked' }),
    e: st({ state: 'done', lastTurnError: { at: 1 } }),
    x: st({ state: 'done', dropped: true }),
    p: st({ hibernated: true })
  }

  it('counts per state, unknown and untracked kept out of N', () => {
    const kinds = parseTeamProgressSig(teamProgressSig(byId, stations))
    expect(kinds).toEqual(['done', 'working', 'needs', 'errored', 'dropped', 'queued', 'unknown', 'paused', 'untracked'])
    const p = summarizeTeam(kinds)
    expect(p.done).toBe(2)
    expect(p.total).toBe(8)
    expect(p.counts.unknown).toBe(1)
    expect(p.attention).toBe('error')
    expect(teamProgressText(p)).toBe(
      '2 of 8 done — 1 dropped, 1 last turn failed, 1 needs you, 1 working, 1 queued, 1 unknown (+1 without status)'
    )
  })

  it('the signature carries no ids, and is stable across same-state events', () => {
    const sig = teamProgressSig(byId, stations)
    expect(sig).not.toContain('plain')
    const refreshed = { ...byId, d: st({ state: 'done', stateAt: 999 }) }
    expect(teamProgressSig(refreshed, stations)).toBe(sig)
  })

  it('a station that is not in the store reads unknown', () => {
    const p = summarizeTeam(parseTeamProgressSig(teamProgressSig({}, stations.slice(0, 2))))
    expect(p).toMatchObject({ done: 0, total: 2, attention: null })
    expect(p.counts.unknown).toBe(2)
  })

  it('attention ranks needs over working', () => {
    expect(summarizeTeam(['working', 'needs', 'done']).attention).toBe('needs')
    expect(summarizeTeam(['working', 'done']).attention).toBe('working')
    expect(summarizeTeam(['done', 'done']).attention).toBeNull()
  })

  it('an unreadable signature character reads as unknown, never done', () => {
    expect(parseTeamProgressSig('dZ')).toEqual(['done', 'unknown'])
  })
})
