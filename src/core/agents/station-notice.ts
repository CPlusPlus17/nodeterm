/**
 * The STATION-FAILURE MONITOR — the core half of @shared/station-notice: it watches the normalized
 * hook stream, asks the closed trigger table, and tells the agent that opened a failed station,
 * ONCE per episode.
 *
 * ── WHERE THE FACTS COME FROM ───────────────────────────────────────────────────────────────────
 *
 * - `turn-errored` and `blocked-unanswered` are recomputed HERE from the same normalized events the
 *   canvas badge and the phone mirror consume (`StopFailure` → `errored` on a `done`; a verified
 *   `newTurn` clears it — the renderer's `lastTurnError` rule, restated over the stream because
 *   both shells need it and the Server Edition may have no renderer attached at all).
 * - `dropped` is the RENDERER's pane measurement (`terminal/agent-liveness.ts`), reported in through
 *   `reportDropped`. Core cannot make that call itself: telling a killed CLI from our own Eco exit or
 *   a Pause needs `hibernated`/`paused`, which exist only in the renderer's store. It is therefore
 *   only as available as the liveness check is — which asks only for a node someone is WATCHING —
 *   so a station that dies off screen is noticed when it next comes into view. On the Server
 *   Edition a browser tab that shows the node reports it the same way; a server with no tab
 *   attached reports no DROPPED at all.
 *
 * Only VERIFIED events move a station here (`verified === true`: the POST presented this node's own
 * token). A notice leads an orchestrator to retry, reassign or END a workflow, so an event anyone on
 * the machine could have forged is not evidence — the same rule the delivery receipt keeps.
 *
 * ── ONCE PER EPISODE ────────────────────────────────────────────────────────────────────────────
 *
 * An episode opens when a row of the table first matches and the recipient is resolved; it is
 * re-armed ONLY by a successful turn — a turn that STARTED after the notice and ended in a `done`
 * that was not an error, not an interruption and not the idle-prompt rescue. Not by the failure
 * condition merely clearing: a usage-limit station retried by its orchestrator errors again at
 * once, and re-notifying on every error would turn the notice into a loop that burns the
 * orchestrator's turns all night. The notice itself says so, so the orchestrator knows it will not
 * hear again.
 *
 * Transient by design, like `lastTurnError` and `dropped`: after a restart nothing here remembers a
 * notice, and nothing needs to — every fact that could re-trigger one is transient too.
 */
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import type { AgentState } from '../../shared/agents/normalize'
import type { BoardLogEntry } from '../../shared/types'
import {
  STATION_BLOCKED_NOTICE_MS,
  stationFailure,
  stationNoticeBody,
  type StationFailureReason,
  type StationNoticePane,
  type StationNoticeView,
  type StationRecipient
} from '../../shared/station-notice'
import type { AgentMessageOutcome } from './agent-message-decide'
import type { CorePlatform } from '../platform'
import { IPC } from '../../shared/ipc'
import { isSafeNodeId } from '../../shared/safe-id'

/** How long a notice whose recipient could not yet be resolved keeps retrying. A station that fails
 *  on its FIRST turn (a usage limit does exactly that) can fail before the canvas that holds its
 *  opener rope has been autosaved, so the store core reads is a beat behind. Past this, the station
 *  simply has no orchestrator (a user opened it by hand) and the episode stays closed silently. */
export const STATION_RECIPIENT_GRACE_MS = 2 * 60_000

/** The sweep cadence: the blocked threshold is crossed by time passing, and the grace retry above
 *  needs a clock. 30 s is far below both windows and costs nothing when no station is tracked. */
export const STATION_SWEEP_MS = 30_000

/** The author of the board-log line — the app, like every other trace it writes. */
const NOTICE_AUTHOR = { name: 'nodeterm', color: '#8b8b8b' } as const

export interface StationNoticeDeps {
  now(): number
  /** Who is told about a station, or `undefined`. Desktop: `stationRecipient` over the persisted
   *  canvases (the `openedBy` + rope rule). Server Edition: its creator ledger — only a station the
   *  recipient opened during THIS server run. */
  recipientFor(stationNodeId: string): StationRecipient | undefined
  /** The canvas leg's durable line, on the recipient's card. `false` = no reachable log. */
  appendBoardLog(projectId: string, entry: BoardLogEntry): Promise<boolean>
  /** The pane leg: `deliverStationNotice` over the shell's messaging deps. Absent ⇒ canvas only. */
  deliver?(notice: {
    stationNodeId: string
    recipientNodeId: string
    body: string
  }): Promise<AgentMessageOutcome>
  /** Push the full current notice list to every renderer (never a delta). */
  publish(views: StationNoticeView[]): void
  /** Is this node still on some canvas? A node that left drops its notice and its tracking. */
  exists(nodeId: string): boolean
  newId?(): string
}

/** The event fields the monitor reads — deliberately narrow, like the delivery receipt's. */
export type StationNoticeEvent = Pick<
  NormalizedAgentEvent,
  'nodeId' | 'kind' | 'state' | 'newTurn' | 'errored' | 'verified' | 'interrupted' | 'idle' | 'sessionPhase'
>

interface Episode {
  reason: StationFailureReason
  at: number
  /** Set once resolved; while unset the sweep retries until `resolveUntil`. */
  recipient?: StationRecipient
  resolveUntil: number
  pane?: StationNoticePane
  paneDetail?: string
}

interface Tracked {
  state?: AgentState
  errored?: boolean
  dropped?: boolean
  needsYouSince?: number
  episode?: Episode
  /** A turn started after the notice — the first half of "a later successful turn". */
  turnSinceNotice?: boolean
  /** When a long-blocked station last resolved to NO recipient. Resolving reads every persisted
   *  canvas, and a station nobody opened stays unattributed, so the sweep asks again only after
   *  `STATION_RECIPIENT_GRACE_MS` rather than every 30 s for as long as it stays blocked. */
  recipientMissAt?: number
}

/** A messaging outcome, folded into the three things the chip says about the pane leg. */
export function paneResult(o: AgentMessageOutcome): { pane: StationNoticePane; paneDetail?: string } {
  switch (o.kind) {
    case 'delivered':
    case 'stalled':
      // `stalled`: the bytes reached the composer; the target started no turn inside the receipt
      // window. It is not "not sent", and it must not be re-sent.
      return { pane: 'told', paneDetail: o.kind }
    case 'queued':
      return { pane: 'queued' }
    case 'notPermitted':
      return { pane: 'not-sent', paneDetail: `notPermitted:${o.reason}` }
    default:
      return { pane: 'not-sent', paneDetail: o.kind }
  }
}

export class StationNoticeMonitor {
  private readonly nodes = new Map<string, Tracked>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPublished = '[]'

  constructor(private readonly deps: StationNoticeDeps) {}

  start(intervalMs: number = STATION_SWEEP_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), intervalMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Feed one normalized hook event. Every event, from every node: the recipient's own state is
   *  what the blocked row asks about. */
  onAgentEvent(e: StationNoticeEvent): void {
    if (!e?.nodeId || e.verified !== true) return
    const t = this.track(e.nodeId)
    if (e.kind === 'session' && e.sessionPhase === 'end') {
      // An orderly exit: the station's CLI announced its own end. Not a failure, and there is no
      // longer a state to reason about.
      t.state = undefined
      t.needsYouSince = undefined
      return
    }
    if (e.kind !== 'state' || !e.state) return
    // The idle-prompt rescue may only move a WORKING node (the renderer's and the mirror's rule):
    // blocked/waiting is also "idle at the prompt", and a rescue must not clear a live question.
    if (e.idle === true && t.state !== 'working') return
    const prev = t.state
    const now = this.deps.now()
    if (e.newTurn === true) {
      t.errored = false
      if (t.episode) t.turnSinceNotice = true
    }
    if (e.state === 'working' && t.episode) t.turnSinceNotice = true
    if (e.state === 'done' && e.errored === true) t.errored = true
    t.state = e.state
    const needsYou = e.state === 'blocked' || e.state === 'waiting'
    if (!needsYou) t.needsYouSince = undefined
    else if (prev !== 'blocked' && prev !== 'waiting') t.needsYouSince = now
    if (
      t.episode &&
      t.turnSinceNotice &&
      e.state === 'done' &&
      e.errored !== true &&
      e.interrupted !== true &&
      e.idle !== true
    ) {
      // A later successful turn: the episode is over, the chip goes, the next failure is news.
      t.episode = undefined
      t.turnSinceNotice = false
      this.publish()
      return
    }
    this.evaluate(e.nodeId, t)
  }

  /** The renderer's DROPPED verdict (true) or its withdrawal (false). */
  reportDropped(nodeId: string, dropped: boolean): void {
    if (typeof nodeId !== 'string' || !nodeId) return
    const t = this.track(nodeId)
    t.dropped = dropped === true
    if (t.dropped) this.evaluate(nodeId, t)
  }

  /** The current notices, as every renderer should draw them. */
  list(): StationNoticeView[] {
    const out: StationNoticeView[] = []
    for (const [stationNodeId, t] of this.nodes) {
      const ep = t.episode
      if (!ep?.recipient) continue
      out.push({
        stationNodeId,
        recipientNodeId: ep.recipient.recipientNodeId,
        projectId: ep.recipient.projectId,
        reason: ep.reason,
        at: ep.at,
        stationTitle: ep.recipient.stationTitle,
        ...(ep.pane ? { pane: ep.pane } : {}),
        ...(ep.paneDetail ? { paneDetail: ep.paneDetail } : {})
      })
    }
    return out.sort((a, b) => a.at - b.at)
  }

  /** Time-driven work: the blocked threshold, the recipient grace retry, and pruning. */
  sweep(): void {
    const now = this.deps.now()
    let changed = false
    for (const [id, t] of [...this.nodes]) {
      if (!this.deps.exists(id)) {
        if (t.episode?.recipient) changed = true
        this.nodes.delete(id)
        continue
      }
      const ep = t.episode
      if (ep && !ep.recipient) {
        if (now <= ep.resolveUntil) this.resolveAndTell(id, ep)
        continue
      }
      if (ep?.recipient && !this.deps.exists(ep.recipient.recipientNodeId)) {
        // The orchestrator was closed: nobody left to show the chip on.
        t.episode = { ...ep, recipient: undefined, resolveUntil: 0 }
        changed = true
        continue
      }
      if (!ep) this.evaluate(id, t)
    }
    if (changed) this.publish()
  }

  forget(nodeId: string): void {
    const had = !!this.nodes.get(nodeId)?.episode?.recipient
    this.nodes.delete(nodeId)
    if (had) this.publish()
  }

  resetForTests(): void {
    this.nodes.clear()
    this.lastPublished = '[]'
    this.stop()
  }

  private track(nodeId: string): Tracked {
    let t = this.nodes.get(nodeId)
    if (!t) {
      t = {}
      this.nodes.set(nodeId, t)
    }
    return t
  }

  private evaluate(stationNodeId: string, t: Tracked): void {
    if (t.episode) return // once per episode
    const now = this.deps.now()
    const obs = {
      state: t.state,
      lastTurnErrored: t.errored,
      dropped: t.dropped,
      needsYouSince: t.needsYouSince
    }
    // The table is asked twice at most: first without the recipient (DROPPED and ERRORED do not
    // depend on it — and resolving a recipient reads the persisted canvases, so a station that
    // matches nothing never pays for it), then, only for a long-blocked station, with its
    // recipient's state.
    let reason = stationFailure(obs, { now })
    let recipient: StationRecipient | undefined
    if (
      !reason &&
      t.needsYouSince !== undefined &&
      now - t.needsYouSince >= STATION_BLOCKED_NOTICE_MS
    ) {
      if (t.recipientMissAt !== undefined && now - t.recipientMissAt < STATION_RECIPIENT_GRACE_MS)
        return
      recipient = this.deps.recipientFor(stationNodeId)
      if (!recipient) {
        t.recipientMissAt = now
        return
      }
      t.recipientMissAt = undefined
      reason = stationFailure(obs, {
        now,
        recipientState: this.nodes.get(recipient.recipientNodeId)?.state
      })
    }
    if (!reason) return
    const ep: Episode = { reason, at: now, resolveUntil: now + STATION_RECIPIENT_GRACE_MS }
    t.episode = ep
    t.turnSinceNotice = false
    if (recipient) this.tell(stationNodeId, ep, recipient)
    else this.resolveAndTell(stationNodeId, ep)
  }

  private resolveAndTell(stationNodeId: string, ep: Episode): void {
    const recipient = this.deps.recipientFor(stationNodeId)
    if (recipient) this.tell(stationNodeId, ep, recipient)
  }

  /** Both legs. The canvas leg needs no switch; the pane leg is the messaging service's to refuse. */
  private tell(stationNodeId: string, ep: Episode, recipient: StationRecipient): void {
    ep.recipient = recipient
    const at = ep.at
    const entry: BoardLogEntry = {
      id: this.deps.newId?.() ?? `station-notice-${stationNodeId}-${at}`,
      ts: at,
      author: NOTICE_AUTHOR,
      nodeId: recipient.recipientNodeId,
      kind: 'event',
      event: {
        type: 'station-failed',
        from: stationNodeId,
        to: ep.reason,
        title: recipient.stationTitle
      }
    }
    void this.deps.appendBoardLog(recipient.projectId, entry).catch(() => false)
    this.publish()
    const deliver = this.deps.deliver
    if (!deliver) return
    const body = stationNoticeBody({ id: stationNodeId, title: recipient.stationTitle }, ep.reason)
    void deliver({ stationNodeId, recipientNodeId: recipient.recipientNodeId, body })
      .then((o) => paneResult(o))
      .catch(() => ({ pane: 'not-sent' as const, paneDetail: 'error' }))
      .then((r) => {
        // The episode may have been re-armed (or the node forgotten) while the delivery ran; only
        // the episode this delivery belonged to takes its result.
        if (this.nodes.get(stationNodeId)?.episode !== ep) return
        ep.pane = r.pane
        if (r.paneDetail) ep.paneDetail = r.paneDetail
        this.publish()
      })
  }

  private publish(): void {
    const views = this.list()
    const key = JSON.stringify(views)
    if (key === this.lastPublished) return
    this.lastPublished = key
    this.deps.publish(views)
  }
}

/**
 * The two request channels, registered by BOTH shells. `monitor` is a thunk because the Server
 * Edition's monitor exists only once its canvas-control runtime is up (it needs the creator
 * ledger); before that — or with canvas control off — the list is empty and a DROPPED report is
 * dropped, which is exactly "no agent opened any station here".
 */
export function registerStationNoticeIpc(
  platform: Pick<CorePlatform, 'handle'>,
  monitor: () => StationNoticeMonitor | null
): void {
  platform.handle(IPC.stationNoticeList, () => monitor()?.list() ?? [])
  platform.handle(IPC.stationNoticeDropped, (nodeId: unknown, dropped: unknown) => {
    // Shape-checked at the boundary: the verdict arrives over IPC (or the browser bridge).
    if (typeof nodeId !== 'string' || !isSafeNodeId(nodeId) || typeof dropped !== 'boolean')
      return false
    monitor()?.reportDropped(nodeId, dropped)
    return true
  })
}
