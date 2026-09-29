/**
 * The core half of @shared/station-outcome: what each station last REPORTED about its task, and the
 * `report-outcome` verb that records it. ONE module for both shells — desktop main and the Server
 * Edition both answer the verb here and both register the read channel — so the two cannot come to
 * accept different reports or keep them differently.
 *
 * TRANSIENT, like the agent state it sits beside and for the same reason `lastTurnError` is: after
 * a restart no station has spoken in this run, and a success restored from disk would describe a
 * task from another app run. Held in MAIN rather than the renderer so a renderer reload (⌘R, a
 * Server Edition browser tab closing) does not lose it — the station-notice monitor learned that
 * lesson with its DROPPED verdict.
 *
 * WHEN A REPORT ENDS (the "new task" rule):
 *   - the station reports again — the later report supersedes;
 *   - the station is handed new work THROUGH CANVAS CONTROL — a `send` / `reply` / `write` into its
 *     pane, or a `run` of its held launch (`OUTCOME_CLEARING_VERBS`). Those are the moments nodeterm
 *     itself sees new work arrive, and they are how an orchestrator reuses a station: without the
 *     withdrawal, "hand the station its next task, then open a dependent `--after-success` it" would
 *     release that dependent at once on the PREVIOUS task's success — early, the direction nothing
 *     can undo. Withdrawing errs toward holding, which the deadline and ▶ / `run` can always end;
 *   - NOT a new turn. A turn is not a task: a station may report mid-turn and keep summarising, and
 *     a person typing "thanks" into its pane starts a turn without starting a task. nodeterm cannot
 *     tell a new task from a follow-up by looking at a turn, so a turn changes nothing here; the
 *     skill tells every station to report at the end of every task, which supersedes the old one;
 *   - NOT the station being closed. A closed station's success still counts for the dependents it
 *     already had (`evaluateSuccessDep`): closing finished stations is ordinary tidying.
 * The store is bounded, oldest evicted first, so a long session cannot grow it without limit.
 */
import type { BoardLogEntry } from '../shared/types'
import { IPC } from '../shared/ipc'
import { isSafeNodeId } from '../shared/safe-id'
import {
  REPORT_OUTCOME_CONTROL_REFUSAL,
  parseReportOutcome,
  type StationOutcome,
  type StationOutcomeRecord
} from '../shared/station-outcome'
import type { CorePlatform } from './platform'

/** How many stations' reports one process keeps. Far past any canvas; evicts the oldest first. */
export const STATION_OUTCOME_MAX_RECORDS = 1000

/** The author of the board-log line — the app, like every other trace it writes. */
const OUTCOME_AUTHOR = { name: 'nodeterm', color: '#8b8b8b' } as const

export class StationOutcomeStore {
  // Insertion order IS recency: a record is deleted and re-set on every write, so the first key is
  // always the oldest and eviction is one `keys().next()`.
  private readonly byId = new Map<string, StationOutcomeRecord>()

  /** `publish` gets the FULL list after every change (never a delta), like station notices. */
  constructor(private readonly publish: (records: StationOutcomeRecord[]) => void = () => {}) {}

  record(rec: StationOutcomeRecord): void {
    this.byId.delete(rec.nodeId)
    this.byId.set(rec.nodeId, rec)
    while (this.byId.size > STATION_OUTCOME_MAX_RECORDS) {
      const oldest = this.byId.keys().next().value
      if (oldest === undefined) break
      this.byId.delete(oldest)
    }
    this.publish(this.list())
  }

  /** Withdraw a station's report. `true` when there was one. */
  clear(nodeId: string): boolean {
    if (!this.byId.delete(nodeId)) return false
    this.publish(this.list())
    return true
  }

  get(nodeId: string): StationOutcomeRecord | undefined {
    return this.byId.get(nodeId)
  }

  /** Every record, newest first. */
  list(): StationOutcomeRecord[] {
    return [...this.byId.values()].reverse()
  }
}

/**
 * Verbs that hand the node they name (`--node`) NEW WORK when they succeed, and so withdraw its
 * outcome report — see the header's "new task" rule. `notify` is not one: it raises an OS
 * notification and types nothing into the pane.
 */
export const OUTCOME_CLEARING_VERBS: ReadonlySet<string> = new Set(['send', 'reply', 'write', 'run'])

/**
 * Apply the "new task" rule to one finished control request. Run by each shell's control handler
 * AFTER the verb answered, and only on success: a refused or undelivered message handed nothing.
 * A caller naming ITSELF is not handed work by anyone (a station `write`-ing into its own pane is
 * still doing its own task).
 */
export function clearOutcomesAfterControl(
  store: Pick<StationOutcomeStore, 'clear'>,
  verb: string,
  args: Record<string, string | undefined>,
  result: { ok: boolean },
  callerNodeId: string
): void {
  if (!result.ok || !OUTCOME_CLEARING_VERBS.has(verb) || typeof args.node !== 'string') return
  for (const id of args.node.split(',').map((s) => s.trim())) {
    if (id && id !== callerNodeId && isSafeNodeId(id)) store.clear(id)
  }
}

export interface ReportOutcomeDeps {
  store: StationOutcomeStore
  now(): number
  /** The station's project, for the board-log line. `undefined` = not in a saved project yet: the
   *  report is still recorded (it is what the wait reads); only the durable line is skipped. */
  projectIdOfNode(nodeId: string): string | undefined
  appendBoardLog(projectId: string, entry: BoardLogEntry): Promise<boolean>
  newId?(): string
  /** After a record lands. The Server Edition re-evaluates its armed launches here; the desktop's
   *  renderer hears the store's push instead. */
  onRecorded?(record: StationOutcomeRecord): void
}

export interface ReportOutcomeReply {
  ok: boolean
  message?: string
  error?: string
  result?: unknown
}

const RELEASE_TEXT: Record<StationOutcome, string> = {
  succeeded:
    'Nodes opened with --after-success on you start once your turn ends (and their other waits are met).',
  failed:
    'Nodes opened with --after-success on you stay held — they will not start on this. If the task is ' +
    'retried, report again when it ends.'
}

/**
 * `report-outcome`, answered in the shell's control handler (main on the desktop, never forwarded to
 * the renderer). The caller is the VERIFIED node the request came from — the hook server refuses an
 * unverified one before any handler runs, and this is the belt — and it may report only about
 * itself (`parseReportOutcome`).
 */
export async function handleReportOutcome(
  req: { nodeId: string; args: Record<string, string>; verified: boolean },
  deps: ReportOutcomeDeps
): Promise<ReportOutcomeReply> {
  const refuse = (error: string): ReportOutcomeReply => ({ ok: false, error, message: error })
  if (!req.verified) return refuse(REPORT_OUTCOME_CONTROL_REFUSAL)
  if (!isSafeNodeId(req.nodeId)) return refuse(REPORT_OUTCOME_CONTROL_REFUSAL)
  const parsed = parseReportOutcome(req.args, req.nodeId)
  if (!parsed.ok) return refuse(parsed.error)
  const at = deps.now()
  const record: StationOutcomeRecord = {
    nodeId: req.nodeId,
    outcome: parsed.outcome,
    at,
    ...(parsed.note ? { note: parsed.note } : {})
  }
  deps.store.record(record)
  const projectId = deps.projectIdOfNode(req.nodeId)
  let logged = false
  if (projectId) {
    const entry: BoardLogEntry = {
      id: deps.newId?.() ?? `station-reported-${req.nodeId}-${at}`,
      ts: at,
      author: OUTCOME_AUTHOR,
      nodeId: req.nodeId,
      kind: 'event',
      event: {
        type: 'station-reported',
        from: req.nodeId,
        to: parsed.outcome,
        ...(parsed.note ? { title: parsed.note } : {})
      }
    }
    logged = await deps.appendBoardLog(projectId, entry).catch(() => false)
  }
  deps.onRecorded?.(record)
  const message = [
    `recorded: your task ${parsed.outcome}${parsed.note ? ` — "${parsed.note}"` : ''}.`,
    RELEASE_TEXT[parsed.outcome],
    'It stands until you report again, or until you are handed new work through canvas control ' +
      '(a send, reply, write or run aimed at you). A new turn does not change it.'
  ].join(' ')
  return {
    ok: true,
    message,
    result: { nodeId: req.nodeId, outcome: parsed.outcome, at, boardLog: logged }
  }
}

/** The read channel, registered by BOTH shells. `store` is a thunk for the same reason as the
 *  station-notice channels': a shell may build its store after the platform handlers. */
export function registerStationOutcomeIpc(
  platform: Pick<CorePlatform, 'handle'>,
  store: () => StationOutcomeStore | null
): void {
  platform.handle(IPC.stationOutcomeList, () => store()?.list() ?? [])
}
