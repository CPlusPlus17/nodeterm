/**
 * Team progress: how far along the stations an orchestrator session opened are.
 *
 * A STATION is a session node this node opened — a target of one of the project's ropes
 * (`project.ropes`, `ctrl-<source>-<target>`). The orchestrator's card, its card modal and its
 * canvas node header show "N of M done" over those stations, and clicking the ring lists them.
 *
 * Four rules decided here, each with its reason:
 *
 * 1. **A rope names an opener only when it is the FIRST rope into its target.** Ropes carry two
 *    relations with one id shape: "opened by" and "waits for" (`--after`, and the `verify` panel's
 *    sequencing). Nothing on the node records which rope was the opener, but every writer appends
 *    the opener's rope BEFORE the dep ropes of the same command (`connect` then `ropeDeps`; the
 *    load-time `missingDepRopes` heal appends after whatever the file already holds). So the first
 *    incoming rope is the opener, and a later one is a wait. Without this, every `--after`
 *    dependency would read as a team leader: in a pipeline A → B → C each station would show the
 *    next one as its team, and in a verify panel each reviewer would show the judge.
 * 2. **Unknown is unknown, never done.** Agent state is transient; after an app restart nobody has
 *    reported yet. A station with no state reads `unknown` and does not count toward N. The only
 *    idle facts that survive a restart are `paused` / `hibernated`, and both are written only by an
 *    exit that refused a busy session — so they count as a finished turn (`paused`).
 * 3. **A station that can never report is not in M.** A plain terminal (a dev server an orchestrator
 *    started) or an agent with no hooks never says `done`; counting it would pin the ring below
 *    complete forever. It is listed as `untracked` and left out of the fraction — the same line
 *    `--after` draws when it refuses to wait on such a node.
 * 4. **A station that is gone is not a station.** A rope whose target is no longer a session node
 *    on this canvas (deleted, or never there in a hand-edited file) is skipped: a closed station is
 *    not outstanding work, and there is nothing to travel to.
 *
 * The card subscribes to `teamProgressSig(byId, stations)` — one character per station — never to
 * the whole `byId` map (the `armedDepSig` / `loopSig` discipline). The signature carries no node
 * ids, so a hostile id cannot forge an entry for another station.
 *
 * `project.ropes` comes out of a git-shared, hand-editable file and is not sanitized on load, so
 * `stationsByOpener` accepts `unknown` and skips every entry it cannot read rather than throwing.
 */
import { capabilityAgentId, hasHooks, type AgentId } from '@shared/agents/config'
import type { AgentNodeStatus } from '../state/agentStatus'

export type StationKind =
  | 'done'
  | 'paused'
  | 'working'
  | 'needs'
  | 'errored'
  | 'dropped'
  | 'queued'
  | 'unknown'
  | 'untracked'

export interface TeamStation {
  id: string
  title: string
  /** The agent the node was created with (node data), when it says. */
  agentId?: string
  /** The node holds a launch it has not delivered yet (`pendingLaunch`). */
  queued: boolean
}

/** The fields `stationsByOpener` reads from a node — live canvas node or serialized state alike. */
export interface StationNodeLike {
  id: unknown
  /** React Flow `type` for a live node, `kind` for serialized state. */
  kind: unknown
  title?: unknown
  agentId?: unknown
  queued?: boolean
}

/** Shared empty list, so a card with no stations keeps a stable prop. */
export const NO_STATIONS: readonly TeamStation[] = Object.freeze([])

function readRope(r: unknown): { source: string; target: string } | null {
  if (!r || typeof r !== 'object') return null
  const { source, target } = r as { source?: unknown; target?: unknown }
  if (typeof source !== 'string' || typeof target !== 'string') return null
  if (!source || !target || source === target) return null
  return { source, target }
}

function sameStations(a: readonly TeamStation[], b: readonly TeamStation[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (s, i) =>
        s.id === b[i].id && s.title === b[i].title && s.agentId === b[i].agentId && s.queued === b[i].queued
    )
  )
}

/**
 * Stations grouped by the node that opened them (rule 1 above), in rope order. Pass the previous
 * result to keep each group's array identity — and the map's own identity — when nothing changed:
 * the canvas recomputes this on node changes, and a fresh array per render would defeat the card's
 * memo and wake every subscriber of the store it is published to.
 */
export function stationsByOpener(
  ropes: unknown,
  nodes: readonly StationNodeLike[],
  previous?: ReadonlyMap<string, readonly TeamStation[]>
): ReadonlyMap<string, readonly TeamStation[]> {
  const sessions = new Map<string, StationNodeLike>()
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (n && typeof n.id === 'string' && n.kind === 'terminal') sessions.set(n.id, n)
  }
  const grouped = new Map<string, TeamStation[]>()
  if (Array.isArray(ropes) && sessions.size > 0) {
    const opened = new Set<string>()
    for (const raw of ropes) {
      const rope = readRope(raw)
      if (!rope || opened.has(rope.target)) continue
      // The first rope into a target is its opener's, whether or not that target is still here —
      // a later rope into the same target is a wait, and must not be promoted by a deletion.
      opened.add(rope.target)
      const node = sessions.get(rope.target)
      if (!node || !sessions.has(rope.source)) continue
      const list = grouped.get(rope.source) ?? []
      list.push({
        id: rope.target,
        title: typeof node.title === 'string' ? node.title : '',
        ...(typeof node.agentId === 'string' && node.agentId ? { agentId: node.agentId } : {}),
        queued: !!node.queued
      })
      grouped.set(rope.source, list)
    }
  }
  const out = new Map<string, readonly TeamStation[]>()
  let unchanged = !!previous && previous.size === grouped.size
  for (const [opener, list] of grouped) {
    const prev = previous?.get(opener)
    if (prev && sameStations(prev, list)) out.set(opener, prev)
    else {
      out.set(opener, list)
      unchanged = false
    }
  }
  return unchanged && previous ? previous : out
}

type StatusLike = Pick<AgentNodeStatus, 'state'> &
  Partial<Pick<AgentNodeStatus, 'dropped' | 'paused' | 'hibernated' | 'lastTurnError' | 'agentId'>>

function reports(agentId: string | undefined): boolean {
  if (!agentId) return false
  try {
    return hasHooks(capabilityAgentId(agentId as AgentId))
  } catch {
    return false
  }
}

/**
 * One station's state. The ranking: a dead CLI first (the strongest claim, and only ever raised on
 * a `done` node), then the states a person must act on, then work in flight. A held launch outranks
 * every idle reading — nothing the node reported can be about a run that has not started — but not
 * a live `working` / `needs`: a user can launch a `manualOnly` station by hand, and its hooks are
 * then the truth. `done` with a live turn error is `errored`, the same verdict `--after` refuses on.
 */
export function stationKind(station: TeamStation, status: StatusLike | undefined): StationKind {
  if (status?.dropped) return 'dropped'
  const state = status?.state
  if (state === 'waiting' || state === 'blocked') return 'needs'
  if (state === 'working') return 'working'
  if (station.queued) return 'queued'
  if (state === 'done') return status?.lastTurnError ? 'errored' : 'done'
  if (status?.paused || status?.hibernated) return 'paused'
  return reports(station.agentId ?? status?.agentId) ? 'unknown' : 'untracked'
}

const CHAR: Record<StationKind, string> = {
  done: 'd',
  paused: 'p',
  working: 'w',
  needs: 'n',
  errored: 'e',
  dropped: 'x',
  queued: 'q',
  unknown: '?',
  untracked: '-'
}
const KIND_OF: Record<string, StationKind> = Object.fromEntries(
  Object.entries(CHAR).map(([kind, ch]) => [ch, kind as StationKind])
)

/** The primitive a card subscribes to: one character per station, in station order. */
export function teamProgressSig(
  byId: Readonly<Record<string, StatusLike | undefined>>,
  stations: readonly TeamStation[]
): string {
  let sig = ''
  for (const s of stations) sig += CHAR[stationKind(s, byId[s.id])]
  return sig
}

/** The kinds back out of a signature. A character it does not know reads as `unknown`. */
export function parseTeamProgressSig(sig: string): StationKind[] {
  return [...sig].map((ch) => KIND_OF[ch] ?? 'unknown')
}

export interface TeamProgress {
  /** Stations whose last turn ended cleanly (`done`, or paused/hibernated after one). */
  done: number
  /** Stations that can report — everything but `untracked`. The denominator. */
  total: number
  counts: Record<StationKind, number>
  /** What the ring's accent should say, strongest first. */
  attention: 'error' | 'needs' | 'working' | null
}

export function summarizeTeam(kinds: readonly StationKind[]): TeamProgress {
  const counts = Object.fromEntries(Object.keys(CHAR).map((k) => [k, 0])) as Record<StationKind, number>
  for (const k of kinds) counts[k]++
  const done = counts.done + counts.paused
  const total = kinds.length - counts.untracked
  const attention =
    counts.errored + counts.dropped > 0
      ? 'error'
      : counts.needs > 0
        ? 'needs'
        : counts.working > 0
          ? 'working'
          : null
  return { done, total, counts, attention }
}

export const STATION_LABEL: Record<StationKind, string> = {
  done: 'done',
  paused: 'done · paused',
  working: 'working',
  needs: 'needs you',
  errored: 'last turn failed',
  dropped: 'dropped',
  queued: 'queued',
  unknown: 'unknown',
  untracked: 'no status'
}

/** Order of the breakdown in the tooltip and the list header — attention first. */
const BREAKDOWN: readonly StationKind[] = [
  'dropped', 'errored', 'needs', 'working', 'queued', 'unknown', 'done', 'paused', 'untracked'
]

/** "2 of 5 done — 1 working, 1 needs you, 1 unknown" (+ the untracked count, outside M). */
export function teamProgressText(p: TeamProgress): string {
  const parts = BREAKDOWN.filter((k) => k !== 'done' && k !== 'paused' && k !== 'untracked' && p.counts[k] > 0).map(
    (k) => `${p.counts[k]} ${STATION_LABEL[k]}`
  )
  const head = `${p.done} of ${p.total} done`
  const tail = p.counts.untracked > 0 ? ` (+${p.counts.untracked} without status)` : ''
  return `${head}${parts.length ? ` — ${parts.join(', ')}` : ''}${tail}`
}
