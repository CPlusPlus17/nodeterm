/**
 * Which stations have been HANDED NEW WORK they have not finished — the fact plain `--after` needs
 * (@shared/station-handover has the why). ONE module for both shells: desktop main feeds it and
 * pushes its list to the renderer, whose launch loop (`launchesToFire`) reads it; the Server
 * Edition's headless factory asks it directly. So the two editions cannot come to disagree about
 * when a dependent starts.
 *
 * WHAT COUNTS AS A HAND-OVER — the same moments #1042's report rule uses
 * (src/core/station-outcome-store.ts), fed by the same events:
 *   - a `send` / `reply` QUEUED for a busy station (`onHandover` 'queued'): the station is handed
 *     over from that moment — its current `done` is the PREVIOUS task's — until the message lands
 *     and a turn after it ends;
 *   - the bytes LANDING in the pane (`onHandover` 'landed', first attempt or flush) at `at`, which
 *     is when that delivery attempt STARTED;
 *   - a queued message that ends WITHOUT landing (expired, refused on flush): still a hand-over,
 *     at the moment it settled. The orchestrator handed new work and armed a dependent believing it
 *     would be done; releasing that dependent on the older task's `done` is the bug this closes. It
 *     ends with the station's next completed turn (a person may paste the task by hand), or by ▶;
 *   - `write` / `run` succeeding (`noteControlAnswer`), at the time the REQUEST arrived — before any
 *     byte was typed, so a turn the typed text starts is always later.
 *
 * WHEN IT ENDS: a `done` for a turn that STARTED at or after the newest hand-over, with nothing
 * still queued. "Started" is the first active state (working / waiting / blocked) after the
 * station was last idle, stamped by this module's own clock as events arrive — tracked for every
 * station, handed over or not, because a delivered prompt can start (and even finish) its turn
 * before the delivery's `landed` event is emitted. A turn already in progress when the work landed
 * does not end it: the typed text is answered by a LATER turn (if the CLI folds it into the
 * current turn instead, the hold lasts until the next turn — the holding direction, with ▶ and
 * `run` as the way out).
 *
 * BACKGROUND WORK is the second kind of unfinished work, and it holds the same way. Claude's `Stop`
 * carries `background_tasks` — every background task of the session still running at that turn end
 * (background shells, async subagents; `NormalizedAgentEvent.backgroundTaskIds`). A turn that ends
 * with such a task running has not finished the station's work: the output the dependent is armed
 * to read is still being produced (measured live, 2026-09-30: an agent's turn ended while its test
 * suite ran in a background shell, and the node armed `--after` it fired before anything was
 * pushed). So a `done` whose inventory lists a live task holds the station, and only a later
 * `done` whose inventory is PRESENT and EMPTY releases it. Three decisions:
 *   - an ABSENT inventory is "unknown", never "none" — and it changes nothing: a CLI too old to send
 *     the field never sets the hold (today's behaviour, exactly), and a `done` without one (the
 *     idle-prompt rescue, a `StopFailure`, another agent) neither sets nor clears it;
 *   - the hold is not cleared by a turn STARTING (the tasks may well outlive it) — only by a turn
 *     end that says they are gone, or by `SessionEnd` (the CLI exited, taking its tasks with it;
 *     waiting on a session that will never report again would strand the dependent);
 *   - a background task that finishes WITHOUT waking the station for another turn leaves the hold
 *     up until the station's next turn end. That is the holding direction, and ▶ / `run` end it.
 *
 * NOT a hand-over: a board comment (a person steering), a station notice (the app telling an
 * orchestrator something), a person typing in the pane. Deliberately the same set #1042 counts.
 *
 * Bounded (the oldest station with nothing handed over is evicted first) and DURABLE ACROSS A
 * RESTART (`HANDOVER_FACT`, `<userData>/orchestration-state/station-handovers.json`, through
 * core/durable-state.ts). Without it an app restart forgot every hold, and a dependent armed on a
 * station that had just been handed its next task fired on the first `done` after the restart —
 * the previous task's, or a turn in flight before the work landed. What a restart means here:
 *   - the HOLDING stations are stored — `handedAt`, the current turn's start and state, the
 *     background flag — so a hold ends after the restart exactly as it would have without one: on
 *     a `done` for a turn that started at or after the hand-over (wall-clock times, so a turn that
 *     began before the restart still counts if it began after the hand-over);
 *   - `queued` is NOT stored: it is rebuilt from the durable delivery queue, whose restore replays
 *     a `queued` hand-over per waiting message (and a `settled` one, never landed, for each message
 *     that lapsed while the app was down — which is still a hand-over, see above);
 *   - hook events are lost while the app is down (the hook POSTs have nowhere to go), so a turn
 *     that ENDED during the downtime is not seen: the hold lasts until the station's next turn end.
 *     The holding direction, with ▶ / `run` as the way out, like every other uncertainty here;
 *   - a hold is not bound to a session: a station respawned into a new session still owes the work
 *     it was handed, and its next completed turn ends the hold as usual.
 * Loaded by each shell after the station reports and before the delivery queue.
 */
import type { AgentState, NormalizedAgentEvent } from '../shared/agents/normalize'
import { IPC } from '../shared/ipc'
import { isSafeNodeId } from '../shared/safe-id'
import type { StationHandoverRecord } from '../shared/station-handover'
import type { MessageHandover } from './agents/agent-messaging'
import type { CorePlatform } from './platform'
import type { DurableFactFile, DurableFactSpec } from './durable-state'

/** How many stations' activity one process tracks. Far past any canvas; evicts the oldest first. */
export const STATION_HANDOVER_MAX_TRACKED = 2000

/** The messaging verbs whose delivery hands a station new work (#1042's set). */
const HANDOVER_VERBS: ReadonlySet<string> = new Set(['send', 'reply'])

/** The control verbs whose successful ANSWER means new work reached the node they name. */
export const HANDOVER_CONTROL_VERBS: ReadonlySet<string> = new Set(['write', 'run'])

const ACTIVE: ReadonlySet<AgentState> = new Set<AgentState>(['working', 'waiting', 'blocked'])

interface StationTrack {
  /** The last state seen. `undefined` until the first event. */
  state?: AgentState
  /** When the current (or last) turn started: the first active state after an idle one. */
  turnStartedAt?: number
  /** `send` / `reply` entries still queued for this station. */
  queued: number
  /** The newest hand-over that no finished turn has answered yet. */
  handedAt?: number
  /** The last turn end listed background tasks still running (see the header). */
  background?: boolean
}

/** One holding station as it is written to disk (`queued` is rebuilt, never stored). */
export interface PersistedHandover {
  nodeId: string
  handedAt?: number
  turnStartedAt?: number
  state?: AgentState
  background?: true
}

const STATES: ReadonlySet<string> = new Set(['working', 'waiting', 'blocked', 'done'])

/** Re-check one entry read from disk (hand-editable input). `null` drops it. */
export function sanitizePersistedHandover(raw: unknown): PersistedHandover | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.nodeId !== 'string' || !isSafeNodeId(r.nodeId)) return null
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const out: PersistedHandover = { nodeId: r.nodeId }
  for (const k of ['handedAt', 'turnStartedAt'] as const) {
    if (r[k] === undefined) continue
    if (!fin(r[k])) return null
    out[k] = r[k] as number
  }
  if (r.state !== undefined) {
    if (typeof r.state !== 'string' || !STATES.has(r.state)) return null
    out.state = r.state as AgentState
  }
  if (r.background === true) out.background = true
  // An entry that holds nothing is not a hand-over (and would only take a slot).
  if (out.handedAt === undefined && !out.background) return null
  return out
}

function holds(t: StationTrack): boolean {
  return t.queued > 0 || t.handedAt !== undefined || t.background === true
}

export class StationHandoverTracker {
  // Insertion order IS recency (re-set on every touch), so eviction is one `keys().next()`.
  private readonly byId = new Map<string, StationTrack>()
  private lastSig = ''

  constructor(
    private readonly publish: (records: StationHandoverRecord[]) => void = () => {},
    private readonly now: () => number = Date.now,
    /** Mirror the holding stations to disk; `loadFromDisk` reads them back at boot. */
    private readonly durable?: Pick<DurableFactFile<PersistedHandover>, 'load' | 'save'>
  ) {}

  /**
   * Bring back the holds an earlier process saved (see the header). Called once per shell at boot,
   * BEFORE the delivery queue is restored (its replay adds `queued` on top). Stations this run has
   * already seen win. Never throws: the file layer turns a bad file into an empty list.
   */
  loadFromDisk(): void {
    if (!this.durable) return
    for (const p of this.durable.load()) {
      if (this.byId.has(p.nodeId)) continue
      const t = this.touch(p.nodeId)
      if (p.handedAt !== undefined) t.handedAt = p.handedAt
      if (p.turnStartedAt !== undefined) t.turnStartedAt = p.turnStartedAt
      if (p.state !== undefined) t.state = p.state
      if (p.background) t.background = true
    }
    this.changed()
  }

  private persist(): void {
    if (!this.durable) return
    const out: PersistedHandover[] = []
    for (const [nodeId, t] of this.byId) {
      if (t.handedAt === undefined && !t.background) continue
      out.push({
        nodeId,
        ...(t.handedAt !== undefined ? { handedAt: t.handedAt } : {}),
        ...(t.turnStartedAt !== undefined ? { turnStartedAt: t.turnStartedAt } : {}),
        ...(t.state !== undefined ? { state: t.state } : {}),
        ...(t.background ? { background: true as const } : {})
      })
    }
    this.durable.save(out)
  }

  private touch(nodeId: string): StationTrack {
    const cur = this.byId.get(nodeId) ?? { queued: 0 }
    this.byId.delete(nodeId)
    this.byId.set(nodeId, cur)
    // Evict the oldest station with NOTHING handed over: dropping a held one would release its
    // dependents — the direction nothing can undo. Only a map full of held stations drops one.
    while (this.byId.size > STATION_HANDOVER_MAX_TRACKED) {
      let victim: string | undefined
      for (const [id, t] of this.byId) {
        if (id !== nodeId && !holds(t)) {
          victim = id
          break
        }
      }
      victim ??= this.byId.keys().next().value
      if (victim === undefined) break
      this.byId.delete(victim)
    }
    return cur
  }

  /** Has the turn answering the hand-over already ended? */
  private settle(t: StationTrack): void {
    if (
      t.handedAt !== undefined &&
      t.state === 'done' &&
      t.turnStartedAt !== undefined &&
      t.turnStartedAt >= t.handedAt
    )
      t.handedAt = undefined
  }

  private changed(): void {
    this.persist()
    const list = this.list()
    const sig = list
      .map((r) => `${r.nodeId}:${r.since ?? ''}:${r.queued ? 1 : 0}:${r.background ? 1 : 0}`)
      .join('|')
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.publish(list)
  }

  /** Every agent event of every node, fed BEFORE anything that acts on it (the Server Edition's
   *  `refreshArmed`, the messaging queue's flush on `done`). Events without a state are ignored. */
  onAgentEvent(
    event: Pick<NormalizedAgentEvent, 'nodeId' | 'state'> &
      Partial<Pick<NormalizedAgentEvent, 'backgroundTaskIds' | 'sessionPhase'>>
  ): void {
    if (!event?.nodeId || !isSafeNodeId(event.nodeId)) return
    // The CLI exited: its background tasks died with it, and it will never report them finished.
    if (event.sessionPhase === 'end') {
      const t = this.byId.get(event.nodeId)
      if (t?.background) {
        t.background = false
        this.changed()
      }
      return
    }
    const state = event.state
    if (typeof state !== 'string') return
    const t = this.touch(event.nodeId)
    if (ACTIVE.has(state)) {
      const started = !t.state || !ACTIVE.has(t.state)
      if (started) t.turnStartedAt = this.now()
      t.state = state
      // A held station's turn start is what ends its hold: it must survive a restart too.
      if (started && holds(t)) this.persist()
      return
    }
    t.state = state
    if (state === 'done') {
      // Only a PRESENT inventory speaks about background work; an absent one is unknown.
      if (Array.isArray(event.backgroundTaskIds)) t.background = event.backgroundTaskIds.length > 0
      this.settle(t)
      this.changed()
    }
  }

  /** New work landed in the station's pane at `at` (this process's clock). */
  markHandedOver(nodeId: string, at: number): void {
    if (!isSafeNodeId(nodeId) || !Number.isFinite(at)) return
    const t = this.touch(nodeId)
    t.handedAt = Math.max(t.handedAt ?? at, at)
    // A delivered prompt can start AND finish its turn before the delivery reports back.
    this.settle(t)
    this.changed()
  }

  /** The messaging layer's hand-over events (`AgentMessagingDeps.onHandover`). */
  onHandover(ev: MessageHandover): void {
    if (!HANDOVER_VERBS.has(ev.verb) || !isSafeNodeId(ev.targetNodeId)) return
    const id = ev.targetNodeId
    if (ev.phase === 'queued') {
      this.touch(id).queued++
      this.changed()
      return
    }
    if (ev.phase === 'landed') {
      this.markHandedOver(id, ev.at)
      return
    }
    const t = this.touch(id)
    t.queued = Math.max(0, t.queued - 1)
    // A queued message that never landed still counts as handed over (see the header).
    if (!ev.landed) t.handedAt = Math.max(t.handedAt ?? 0, this.now())
    this.changed()
  }

  /**
   * One finished `write` / `run`. Run by each shell's control handler on the answer (prompt or
   * late), and only on success: a refused write handed nothing. `requestAt` is when the request
   * ARRIVED, before any byte was typed. A caller naming itself is not handed work by anyone.
   */
  noteControlAnswer(
    verb: string,
    args: Record<string, string | undefined>,
    result: { ok: boolean },
    callerNodeId: string,
    requestAt: number
  ): void {
    if (!result.ok || !HANDOVER_CONTROL_VERBS.has(verb) || typeof args.node !== 'string') return
    for (const id of args.node.split(',').map((s) => s.trim())) {
      if (id && id !== callerNodeId && isSafeNodeId(id)) this.markHandedOver(id, requestAt)
    }
  }

  /** Is `--after` on this station held by unfinished work — handed over, or still running in the
   *  background of its last turn? */
  isHandedOver(nodeId: string): boolean {
    const t = this.byId.get(nodeId)
    return !!t && holds(t)
  }

  /** Every station with unfinished handed-over work, newest first. */
  list(): StationHandoverRecord[] {
    const out: StationHandoverRecord[] = []
    for (const [nodeId, t] of [...this.byId.entries()].reverse()) {
      if (!holds(t)) continue
      out.push({
        nodeId,
        ...(t.handedAt !== undefined ? { since: t.handedAt } : {}),
        ...(t.queued > 0 ? { queued: true as const } : {}),
        ...(t.background ? { background: true as const } : {})
      })
    }
    return out
  }
}

/** The read channel, registered by BOTH shells. `tracker` is a thunk: a shell may build it after
 *  the platform handlers. */
export function registerStationHandoverIpc(
  platform: Pick<CorePlatform, 'handle'>,
  tracker: () => StationHandoverTracker | null
): void {
  platform.handle(IPC.stationHandoverList, () => tracker()?.list() ?? [])
}

/** The tracker's durable file (core/durable-state.ts). */
export const HANDOVER_FACT: DurableFactSpec<PersistedHandover> = {
  kind: 'station-handovers',
  version: 1,
  maxRecords: STATION_HANDOVER_MAX_TRACKED,
  sanitize: sanitizePersistedHandover
}
