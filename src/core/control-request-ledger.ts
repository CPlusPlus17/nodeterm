// A retried canvas-control call must not open a second node.
//
// WHY THIS EXISTS. An orchestrating agent opens stations with the control shim, and the reply to
// that call can be lost while the call itself went through: the agent's own tool call is killed
// (a Bash tool call dies at about two minutes while a slow host or a confirm holds the POST), the
// ssh tunnel drops mid-reply, or the shim's endpoint walk re-posts to another candidate after a
// transport that failed AFTER the request was read. The agent reasonably runs the same command
// again, and before this module a second agent, a second worktree, a second team was the answer.
//
// THE RULES, each for a reason:
//   - A call may carry an operation id (`--request-id`, or the one the shim generates per RUN so
//     its own re-posts are covered for an agent that never read the docs). Rows are keyed
//     (caller node, id), and the caller is the VERIFIED node only: an unverified caller gets no
//     dedupe rather than a shared bucket, where two nodes could collide on each other's ids.
//   - A fingerprint of what the call DOES (verb + args, minus the id itself) is stored with the
//     row. The same id with a different fingerprint is a conflict, refused: reusing an id for a
//     different call is a bug in the caller, and silently answering with the first call's reply
//     would hide it.
//   - The row is CLAIMED before the handler runs, because from that instant the truthful answer
//     to "did this happen?" is "it may have". A retry of a claimed row is refused, never run.
//   - A row settles with the WHOLE reply the handler gave, and a replay returns that reply, not
//     what the same call would do now. A refusal is a reply too: the same id never runs twice.
//   - A handler that could not tell whether its effect happened (desktop main gave up waiting on
//     the renderer; the handler threw) settles the row as UNKNOWN. That is still refused, and
//     settlement only ever moves UP: a late answer may replace unknown, nothing replaces a reply.
//   - Retention is bounded: 24 h, and a cap per caller and in total. An in-flight row is never
//     evicted by a cap (evicting it would let its own retry run a second time).
//
// PROCESS MEMORY, deliberately. The ledger lives in the one process that executes the call (the
// hook server's `/control/` route, which BOTH shells pass through). An app restart between the
// effect and the retry empties it, and that retry runs again. That is the case that matters least:
// a restart inside the seconds-to-minutes between a lost reply and its retry is rare, and it also
// rotates the endpoint the shim posts to, so the shim's own re-post never reaches the new process
// with the old id anyway. Persisting it would mean a store, a schema and atomic writes on every
// control call for that corner.
//
// Pure: no clock, no I/O, no network. The route wires it (src/core/agents/hook-server.ts).
import { createHash } from 'node:crypto'

/**
 * The verbs that CREATE something — a node, a team, a worktree, a frame. The ones this module
 * exists for. The others are left out on purpose, each for its own reason:
 *   - reads (`list`, `board`, `settings --get`, `browser --read`): nothing to protect, and a
 *     replay would serve a stale snapshot — and, for `browser --cookies`, keep a page's cookies in
 *     memory for a day;
 *   - verbs that are idempotent by nature (`close`, `rename`, `color`, `assign`, `move`,
 *     `open-project`) — running one twice lands where running it once did;
 *   - the human-confirmed and rate-limited ones (`write`, `send`/`reply`/`notify`, `settings`,
 *     `report-issue`), which already carry their own brake; widening the set to them is a
 *     separate decision.
 * An explicit `--request-id` on a verb outside the set is REFUSED rather than ignored: an agent
 * that believes its `write` is protected when it is not is the failure this flag exists to end.
 */
export const REQUEST_ID_VERBS: ReadonlySet<string> = new Set([
  'open-terminal',
  'open-claude',
  'open-agent',
  'spawn-team',
  'verify',
  'open-worktree',
  'branch',
  'show-image',
  'show-video',
  'show-web',
  'open-browser',
  'group'
])

export const REQUEST_ID_MAX_LENGTH = 64
// A leading letter or digit keeps an id from ever reading as a flag (`-x`) or a path (`.x`); the
// charset is what a uuid, a hex token or a hand-written slug (`wave2.reviewer:3`) needs and nothing
// that could mean something to a shell, a URL or a log line.
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

export function isValidRequestId(raw: string): boolean {
  return raw.length > 0 && raw.length <= REQUEST_ID_MAX_LENGTH && REQUEST_ID_RE.test(raw)
}

export type RequestIdOutcome =
  | 'request-in-flight'
  | 'request-outcome-unknown'
  | 'request-id-conflict'
  | 'request-id-invalid'
  | 'request-id-unsupported'

/**
 * Whether retrying the SAME command with the SAME id can change the answer. Data, not prose: the
 * agent-facing text is RENDERED from this table (`requestIdDocLines`), the same rule the messaging
 * outcomes follow, so a new outcome lands in the docs the day it is added.
 *   - in flight: the first call's reply is still coming, so a later retry gets it;
 *   - unknown: a late answer may still arrive (desktop main hands one back after its own timeout),
 *     so a later retry can get it — and when it never does, the answer tells the caller to `list`;
 *   - the rest are the caller's mistake and never clear on their own.
 */
export const REQUEST_ID_RETRYABLE: Record<RequestIdOutcome, boolean> = {
  'request-in-flight': true,
  'request-outcome-unknown': true,
  'request-id-conflict': false,
  'request-id-invalid': false,
  'request-id-unsupported': false
}

/** What each outcome means, in the words the agent-facing docs render (never re-typed there). */
export const REQUEST_ID_OUTCOME_GLOSS: Record<RequestIdOutcome, string> = {
  'request-in-flight': 'the first call with that id is still running',
  'request-outcome-unknown':
    'the first call ended without a confirmed answer, so it may have taken effect — if it keeps ' +
    'saying this, run `list` before opening anything again',
  'request-id-conflict': 'the id was already used for a different call',
  'request-id-invalid': `the id is not 1-${REQUEST_ID_MAX_LENGTH} letters, digits, \`.\`, \`_\`, \`:\` or \`-\``,
  'request-id-unsupported': 'the verb creates nothing and takes no id'
}

/** How long ago, in the unit a reader would use. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 120) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 120) return `${m}m`
  return `${Math.round(m / 60)}h`
}

/** The first line of a replayed reply. Exported so tests (and the docs) quote it, never re-type it. */
export const REQUEST_ID_REPLAYED_LEAD = 'replayed:'

export function requestIdReplayLine(requestId: string, ageMs: number): string {
  return (
    `${REQUEST_ID_REPLAYED_LEAD} this is the reply to request ${requestId}, first run ${ago(ageMs)} ago — ` +
    'nothing new was run.'
  )
}

/** The line that names the id a call may still complete under. Exported so tests quote it. */
export const REQUEST_ID_HINT_LEAD = 'request id:'

/**
 * Added to a reply that could not say whether its call took effect, when the route holds a row for
 * it. It must carry the id ITSELF: the shim's per-run id is otherwise never seen, so "retry with the
 * same --request-id" sent the agent to re-run the bare command — a fresh id, and a second open.
 */
export function requestIdRetryHint(requestId: string): string {
  return (
    `${REQUEST_ID_HINT_LEAD} ${requestId} — to retry, run the same command with ` +
    `\`--request-id ${requestId}\` added: you get this call's answer (or its refusal), never a ` +
    'second one. Running it without that flag may open it twice.'
  )
}

/** Appended when the caller passed `--request-id` but its node identity is not verified. */
export const REQUEST_ID_UNVERIFIED_NOTE =
  'request id ignored: this session\'s node identity is not verified, so a retry cannot be matched ' +
  'to this call — run `list` before repeating it.'

/**
 * One line per outcome, the machine name first so the text dialect (which carries no `error`
 * field) still names it. Every one says what did NOT happen, because the question the caller is
 * asking after a lost reply is "did I just open a second one?".
 */
export function requestIdOutcomeMessage(
  outcome: RequestIdOutcome,
  ctx: { requestId?: string; verb: string; ageMs?: number }
): string {
  const id = ctx.requestId ?? ''
  const since = ctx.ageMs === undefined ? '' : ` (first run ${ago(ctx.ageMs)} ago)`
  switch (outcome) {
    case 'request-in-flight':
      return (
        `request-in-flight: request ${id} is still running${since} — nothing new was started. ` +
        `Run the same command with \`--request-id ${id}\` in a few seconds to get its reply.`
      )
    case 'request-outcome-unknown':
      return (
        `request-outcome-unknown: request ${id} ended without a confirmed answer${since}, so it MAY ` +
        'have taken effect — nothing new was started. Retry the same command with ' +
        `\`--request-id ${id}\` in a minute: an answer that arrives late is returned then. If it ` +
        'keeps saying this, run `list` before opening anything again, and use a new --request-id ' +
        'only for something that is not there.'
      )
    case 'request-id-conflict':
      return (
        `request-id-conflict: request id ${id} was already used for a different call${since} — ` +
        'nothing was done. Use a new --request-id for a new call; reuse an id only to retry the ' +
        'exact same command.'
      )
    case 'request-id-invalid':
      return (
        `request-id-invalid: --request-id must be 1-${REQUEST_ID_MAX_LENGTH} letters, digits, '.', ` +
        "'_', ':' or '-', starting with a letter or digit — nothing was done."
      )
    case 'request-id-unsupported':
      return (
        `request-id-unsupported: --request-id applies only to the verbs that create something ` +
        `(${[...REQUEST_ID_VERBS].join(', ')}); ${ctx.verb} does not take it — nothing was done.`
      )
  }
}

/** A handler reply, as stored and replayed. `indeterminate` marks one that could not say whether
 *  the effect happened; it settles the row as unknown and is never replayed as an answer. */
export interface ControlReply {
  ok: boolean
  message?: string
  result?: unknown
  error?: string
  indeterminate?: boolean
}

/**
 * What the call DOES: the verb plus every arg except the id itself, in a canonical order. Values
 * are compared literally — `--count 1` and no `--count` are different calls, because deciding they
 * are the same would mean re-implementing every verb's defaults here. JSON of an array of pairs,
 * so no value can forge a boundary between two keys.
 */
export function controlCallFingerprint(verb: string, args: Record<string, string>): string {
  const entries = Object.entries(args)
    .filter(([k]) => k !== 'request-id')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(JSON.stringify([verb, entries])).digest('hex')
}

export type RequestIdGate =
  | { kind: 'pass'; args: Record<string, string>; requestId?: string; explicit: boolean }
  | { kind: 'refuse'; outcome: 'request-id-invalid' | 'request-id-unsupported' }

/**
 * Decide which id (if any) a control call carries. `args['request-id']` is the caller's explicit
 * `--request-id`; `cliRequestId` is the one the shim generated for this run. The explicit id wins.
 * The id is always stripped from the args a handler sees: no verb reads it, and a parser that
 * refuses flags it does not know must never meet it.
 *
 * Asymmetric on purpose: a bad EXPLICIT id is refused (the caller asked for protection it would
 * not get), a bad CLI-generated one is ignored (a shim whose random source failed must not make
 * every open fail).
 */
export function requestIdGate(
  verb: string,
  args: Record<string, string>,
  cliRequestId: string | undefined
): RequestIdGate {
  const { 'request-id': explicitId, ...rest } = args
  if (explicitId !== undefined) {
    if (!isValidRequestId(explicitId)) return { kind: 'refuse', outcome: 'request-id-invalid' }
    if (!REQUEST_ID_VERBS.has(verb)) return { kind: 'refuse', outcome: 'request-id-unsupported' }
    return { kind: 'pass', args: rest, requestId: explicitId, explicit: true }
  }
  if (cliRequestId !== undefined && isValidRequestId(cliRequestId) && REQUEST_ID_VERBS.has(verb)) {
    return { kind: 'pass', args: rest, requestId: cliRequestId, explicit: false }
  }
  return { kind: 'pass', args: rest, explicit: false }
}

/** Settles the row a `begin` claimed — and only that row (see `ControlRequestLedger.begin`). */
export interface LedgerClaim {
  /** The handler answered. An `indeterminate` answer settles the row as unknown. */
  settle(reply: ControlReply): void
  /** The handler threw: nobody knows what happened. */
  settleUnknown(): void
  /** An answer that arrived after the row was already settled as unknown. */
  settleLate(reply: ControlReply): void
}

export type LedgerDecision =
  | { kind: 'run'; claim: LedgerClaim }
  | { kind: 'replay'; reply: ControlReply; firstRunAt: number }
  | {
      kind: 'refuse'
      outcome: 'request-in-flight' | 'request-outcome-unknown' | 'request-id-conflict'
      firstRunAt: number
    }

interface Row {
  caller: string
  fingerprint: string
  claimedAt: number
  touchedAt: number
  state: 'in-flight' | 'settled' | 'unknown'
  reply?: ControlReply
}

export const REQUEST_LEDGER_TTL_MS = 24 * 60 * 60 * 1000
export const REQUEST_LEDGER_PER_CALLER_MAX = 256
export const REQUEST_LEDGER_GLOBAL_MAX = 4096

export interface ControlRequestLedgerOptions {
  now?: () => number
  ttlMs?: number
  perCallerMax?: number
  globalMax?: number
  /** An in-flight row older than this answers as unknown (still refused). The route passes the
   *  socket ceiling, past which the caller's own request has already been cut off. */
  inFlightStaleMs?: number
}

export class ControlRequestLedger {
  // Insertion order = claim order, which is what the caps evict by.
  private rows = new Map<string, Row>()
  private perCaller = new Map<string, number>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly perCallerMax: number
  private readonly globalMax: number
  private readonly inFlightStaleMs: number

  constructor(opts: ControlRequestLedgerOptions = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? REQUEST_LEDGER_TTL_MS
    this.perCallerMax = opts.perCallerMax ?? REQUEST_LEDGER_PER_CALLER_MAX
    this.globalMax = opts.globalMax ?? REQUEST_LEDGER_GLOBAL_MAX
    this.inFlightStaleMs = opts.inFlightStaleMs ?? 10 * 60 * 1000
  }

  /**
   * Look the (caller, id) pair up and either CLAIM it for this call or answer from the row.
   * Synchronous on purpose: the look-up and the claim happen with no await between them, so two
   * requests arriving together cannot both be told to run.
   */
  begin(caller: string, requestId: string, fingerprint: string): LedgerDecision {
    const now = this.now()
    this.prune(now)
    const key = `${caller}\u0000${requestId}`
    const found = this.rows.get(key)
    if (found) {
      const firstRunAt = found.claimedAt
      if (found.fingerprint !== fingerprint) return { kind: 'refuse', outcome: 'request-id-conflict', firstRunAt }
      if (found.state === 'settled' && found.reply) return { kind: 'replay', reply: found.reply, firstRunAt }
      if (found.state === 'in-flight' && now - found.claimedAt <= this.inFlightStaleMs) {
        return { kind: 'refuse', outcome: 'request-in-flight', firstRunAt }
      }
      return { kind: 'refuse', outcome: 'request-outcome-unknown', firstRunAt }
    }
    const row: Row = { caller, fingerprint, claimedAt: now, touchedAt: now, state: 'in-flight' }
    this.rows.set(key, row)
    this.perCaller.set(caller, (this.perCaller.get(caller) ?? 0) + 1)
    this.enforceCaps(caller)
    // The claim closes over THIS row object, never the key: a row forgotten by retention or a cap
    // and then re-claimed under the same key is a different object, so a late answer from the
    // forgotten call can only ever write to the detached row nobody reads.
    const store = (reply: ControlReply): void => {
      const { indeterminate: _drop, ...kept } = reply
      row.reply = kept
      row.state = 'settled'
      row.touchedAt = this.now()
    }
    return {
      kind: 'run',
      claim: {
        settle: (reply) => {
          if (row.state !== 'in-flight') return
          if (reply.indeterminate) {
            row.state = 'unknown'
            row.touchedAt = this.now()
            return
          }
          store(reply)
        },
        settleUnknown: () => {
          if (row.state !== 'in-flight') return
          row.state = 'unknown'
          row.touchedAt = this.now()
        },
        settleLate: (reply) => {
          if (row.state !== 'unknown' || reply.indeterminate) return
          store(reply)
        }
      }
    }
  }

  /** Test seam: how many rows are held. */
  sizeForTests(): number {
    return this.rows.size
  }

  private prune(now: number): void {
    for (const [key, row] of this.rows) {
      if (now - row.touchedAt > this.ttlMs) this.drop(key, row)
    }
  }

  private enforceCaps(caller: string): void {
    if ((this.perCaller.get(caller) ?? 0) > this.perCallerMax) this.evictOldest((row) => row.caller === caller)
    if (this.rows.size > this.globalMax) this.evictOldest(() => true)
  }

  private evictOldest(match: (row: Row) => boolean): void {
    for (const [key, row] of this.rows) {
      if (row.state !== 'in-flight' && match(row)) {
        this.drop(key, row)
        return
      }
    }
  }

  private drop(key: string, row: Row): void {
    this.rows.delete(key)
    const n = (this.perCaller.get(row.caller) ?? 1) - 1
    if (n > 0) this.perCaller.set(row.caller, n)
    else this.perCaller.delete(row.caller)
  }
}
