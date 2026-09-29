// Pure logic for ARMED terminal nodes — the canvas-control `--after` dependency edge. A node
// opened with `--after <ids>` holds its launch command (see PendingLaunch in @shared/types)
// until every station it waits on has gone idle; this module decides when that is, and which
// dependency edges to draw meanwhile. Kept free of React/store imports so the satisfaction
// matrix is unit-testable — Canvas.tsx only wraps these in an effect and a setState.
import type { AgentState } from '@shared/agents/normalize'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import type { PrWaitHold } from '@shared/pr-wait'
import type { PendingLaunch } from '@shared/types'
import { prHoldSatisfied } from './prWait'

/** The subset of a canvas node this module reads. */
export interface ArmedNode {
  id: string
  data: { pendingLaunch?: PendingLaunch }
}

/** The subset of the agentStatus store this module reads. */
export type StatusById = Record<
  string,
  { state?: AgentState; lastTurnError?: { at: number } } | undefined
>

export interface LaunchToFire {
  id: string
  command: string
}

/** What `launchesToFire` needs to judge a `--after-pr` wait: the ACTIVE project's pull request
 *  status (#1008's board, absent until the watch has read it) and the clock deadlines are on. */
export interface PrGateContext {
  board?: GitHubPullBoard
  now: number
}

/** Control opens reply before the PTY exists. Keep their command durable until delivery lands,
 * even with no dependencies (or dependencies that are already done). */
export function queueControlLaunch<T extends { data: { initialCommand?: string; pendingLaunch?: PendingLaunch } }>(
  node: T,
  after: string[] = [],
  awaitSetupGroup?: string
): T & { data: { pendingLaunch?: PendingLaunch } } {
  const command = node.data.initialCommand
  if (!command) return node
  return {
    ...node,
    data: {
      ...node.data,
      initialCommand: undefined,
      pendingLaunch: { after, command, attempted: false, ...(awaitSetupGroup ? { awaitSetupGroup } : {}) }
    }
  }
}

/**
 * Attach a `--after-pr` wait to a node whose launch is already held (by `queueControlLaunch`,
 * `armForColdOpen`, or `--after`). ONE helper for every open path — live, cold and `--project` —
 * so no path can arm a node that forgets the wait it was asked for. A node with nothing held has
 * nothing to wait with (the flag gate already refused `open-terminal` without `--cmd`).
 */
export function withPrHold<T extends { data: { pendingLaunch?: PendingLaunch } }>(
  node: T,
  hold: PrWaitHold | undefined
): T {
  const p = node.data.pendingLaunch
  if (!hold || !p) return node
  return { ...node, data: { ...node.data, pendingLaunch: { ...p, afterPr: hold } } }
}

/** A list row states only observed facts; absence of a launch error is not proof of a live CLI. */
export function controlLaunchState(
  pending: boolean,
  delivery: LaunchDelivery | undefined,
  status?: { dropped?: boolean; state?: AgentState },
  /** The node's `--after-pr` wait has passed its deadline: it will not start on its own. */
  prExpired = false
): 'queued' | 'stalled' | 'failed' | 'starting' | 'dropped' | 'working' | 'expired' | undefined {
  if (pending) return delivery?.kind ?? (prExpired ? 'expired' : 'queued')
  if (status?.dropped) return 'dropped'
  if (status?.state === 'working') return 'working'
  return undefined
}

/**
 * Is one dependency satisfied?
 *
 * `done` is the agent's busy→idle edge — the same signal that drives the completion badge and
 * notification. It means "this station has produced something and stopped", which is exactly
 * when a downstream station should start reading it. It does NOT mean "this station will never
 * run again": an agent that finishes turn 1 and awaits more input is also `done`. That is the
 * intended semantics for a station given one self-contained prompt, and it is documented as
 * such rather than being papered over with a turn counter that would guess differently.
 *
 * A dep that is no longer on the canvas counts as satisfied — a deleted node can never report,
 * so treating it as pending would strand the dependent forever. An UNKNOWN state (the dep
 * exists but has reported nothing yet) is deliberately NOT satisfied: right after a fan-out the
 * upstream stations have not emitted a hook event yet, and reading "no news" as "finished"
 * would fire every dependent immediately — the exact bug that makes a dependency edge useless.
 *
 * A dep that is `done` **with a live `lastTurnError`** is refused (issue #521). An errored station
 * reaches idle IMMEDIATELY and looked healthy from every surface an orchestrator can read, so a
 * whole dependency chain launched against an upstream that had produced nothing. Firing with a
 * warning instead was considered and dropped: a dependent that has already launched cannot
 * un-launch, so the warning would arrive after the damage. The armed node keeps its manual ▶
 * run-now escape, so the human — or the orchestrator, after a retry — is never stuck.
 *
 * The refusal ends by itself: `lastTurnError` is cleared by the upstream's next genuine new turn,
 * so a station that is nudged and answers successfully satisfies its dependents on that turn.
 */
function depSatisfied(depId: string, status: StatusById, live: ReadonlySet<string>): boolean {
  if (!live.has(depId)) return true
  const st = status[depId]
  return st?.state === 'done' && !st.lastTurnError
}

/** Of the deps this node is still waiting on, which are held because they ERRORED rather than
 *  because they have not finished? What the QUEUED tooltip names (issue #521). */
export function erroredDeps(
  node: ArmedNode,
  status: StatusById,
  live: ReadonlySet<string>
): string[] {
  return (node.data.pendingLaunch?.after ?? []).filter(
    (d) => live.has(d) && status[d]?.state === 'done' && !!status[d]?.lastTurnError
  )
}

/**
 * Which armed nodes are ready to launch, given the live canvas and the current agent states.
 * `live` is passed in (rather than derived from `nodes`) because the caller already holds the
 * full node list while `nodes` here may be pre-filtered.
 *
 * `setupDone` is the SECOND gate, for a node opened into a worktree frame whose project runs a
 * setup script with `waitForSetup`: the node's command must not race an `npm ci` that is still
 * writing node_modules underneath it. It answers per group id, and the two gates are ANDed —
 * a node can be waiting on both its upstream stations and its checkout being ready.
 *
 * An ABSENT probe (`setupDone` not passed) means the gate is open. That is the honest default,
 * not laxness: the run store is rebuilt from live events, so after an app restart a node armed
 * with `awaitSetupGroup` has no run to hear from ever again, and reading "nothing known" as
 * "still running" would strand it forever — the same reasoning as a deleted dependency counting
 * as satisfied. (The caller's probe applies the same rule to a group with no entry.)
 */
export function launchesToFire(
  nodes: readonly ArmedNode[],
  status: StatusById,
  live: ReadonlySet<string>,
  setupDone?: (groupId: string) => boolean,
  deliveries?: Record<string, LaunchDelivery | undefined>,
  pr?: PrGateContext
): LaunchToFire[] {
  const out: LaunchToFire[] = []
  for (const n of nodes) {
    const p = n.data.pendingLaunch
    if (!p || !p.command || p.manualOnly || p.executor === 'server') continue
    if (deliveries?.[n.id]?.kind === 'failed') continue
    // A headless start (#925) owns this pane and is typing the launch into it. Its claim makes the
    // node manualOnly, which the guard above already skips; this covers a live copy that has not
    // caught up with the claim yet while the store already says so.
    if (deliveries?.[n.id]?.kind === 'starting') continue
    if (p.awaitSetupGroup && !(setupDone?.(p.awaitSetupGroup) ?? true)) continue
    // The THIRD gate (`--after-pr`). Unlike the setup gate, an absent context is CLOSED: a caller
    // that did not say what the pull requests look like has told us nothing, and "no news" is
    // exactly what must never release a launch (the same rule as an unknown agent state).
    if (p.afterPr && !(pr && prHoldSatisfied(p.afterPr, pr.board, pr.now))) continue
    if (p.after.every((d) => depSatisfied(d, status, live))) out.push({ id: n.id, command: p.command })
  }
  return out
}

/** The deps an armed node is still waiting on — what the node badge and tooltip report. */
export function unmetDeps(
  node: ArmedNode,
  status: StatusById,
  live: ReadonlySet<string>
): string[] {
  const p = node.data.pendingLaunch
  if (!p) return []
  return p.after.filter((d) => !depSatisfied(d, status, live))
}

/**
 * How long an armed node whose gate is OPEN may sit with no terminal to deliver into before the
 * badge says so. It is a WARNING, not a deadline: the launch is still held and still fires the
 * moment the session comes up (an SSH host that reconnects, a spawn behind a slow `npm ci`).
 *
 * Chosen well past a cold project switch on a loaded canvas, so an ordinary open never trips it.
 */
export const LAUNCH_STALL_MS = 45_000

/**
 * What the delivery loop has to say about ONE armed node's held launch — the visible half of the
 * two failure modes that used to be a `console.warn` nobody reads. Declared here rather than in
 * the store so the rendering below stays pure and testable; the store only holds it.
 */
export type LaunchDelivery =
  | { kind: 'stalled'; since: number }
  | { kind: 'failed'; attempts: number; at: number }
  /** A headless start (#925) is in flight: core owns the pane, so ▶ must not type into it. */
  | { kind: 'starting'; since: number }

/**
 * Which delivery records the Canvas sweep retires: every record whose node is no longer an armed
 * node on the ACTIVE canvas (delivered, run by hand with ▶, deleted, or in another project) —
 * EXCEPT a `starting` one. A headless start (#925) runs precisely for a node that is not on the
 * active canvas, and its orchestrator owns the record end to end (`clear` on success or
 * not-persistent, `markFailed` otherwise). Retiring it here would re-enable ▶ the moment the user
 * switched to that project mid-start — the manualOnly claim alone reads as a failed launch — and ▶
 * would then type into a pane core is still typing into.
 */
export function deliveriesToRetire(
  byId: Record<string, LaunchDelivery | undefined>,
  isArmedOnCanvas: (nodeId: string) => boolean
): string[] {
  return Object.keys(byId).filter((id) => byId[id]?.kind !== 'starting' && !isArmedOnCanvas(id))
}

/**
 * The QUEUED badge's tooltip. One function for every case so the sentences cannot drift, and
 * so the two warnings are held to the same standard as the ordinary one: say what is true, name
 * what would fix it, and never claim a cause that was not measured.
 *
 * `stalled` is careful about that last point. We know the terminal has not come up; we do NOT know
 * why (a host that is down, a spawn that failed, a machine under load all look identical from
 * here), so the text says what we observed and leaves the diagnosis to the node's own overlay,
 * which does know.
 *
 * `starting` comes first, ahead even of the relay sentence: while core is typing the launch, no
 * sentence may offer ▶, and "waiting for X" would describe a wait that is already over.
 */
export function launchTooltip(
  delivery: LaunchDelivery | undefined,
  waitingOn: string,
  command: string,
  erroredOn?: string,
  relay = false,
  /** The node's `--after-pr` wait: what is still unmet (`prHoldSummary`), whether it has passed
   *  its deadline, and that deadline as the caller formats it (a locale string is not pure). */
  pr?: { expired: boolean; summary: string; deadline: string }
): string {
  if (delivery?.kind === 'starting') return 'Starting in the background — an agent asked for this session to run now.'
  const runs = `Runs:\n${command}`
  if (relay) return `Launch delivery from a relay tab is unavailable. Open the host to run this command.\n${runs}`
  if (delivery?.kind === 'failed')
    return (
      'Launch delivery is unconfirmed; automatic retry is stopped.\n' +
      `Inspect the terminal, then press \u25b6 to retry at a shell prompt.\n${runs}`
    )
  // Issue #521: an errored upstream is idle, so without this the tooltip would say "waiting for X
  // to finish" about a station that finished twenty minutes ago. Named first, because it is the
  // one case where waiting will not end on its own.
  if (erroredOn)
    return (
      `${erroredOn} ended its last turn on an error, so this is held rather than started on ` +
      'what it did not produce.\n' +
      `Retry or nudge it — a successful turn releases this — or press ▶ to run it now.\n${runs}`
    )
  // A wait that passed its deadline will not end on its own either — the one other case where
  // "waiting for" would be a promise nobody keeps.
  if (pr?.expired)
    return (
      `The wait on pull requests passed its deadline (${pr.deadline}), so this will not start on ` +
      'its own.\n' +
      `Press \u25b6 to run it now.\n${runs}`
    )
  if (delivery?.kind === 'stalled')
    return (
      'Ready to run, but this terminal has not started yet — the launch is still held and ' +
      'fires as soon as it does.\n' +
      `Press \u25b6 to try it now.\n${runs}`
    )
  if (pr?.summary) {
    const stations = waitingOn ? `${waitingOn} to finish and for ` : ''
    return `Waiting for ${stations}${pr.summary}, until ${pr.deadline}, then runs:\n${command}`
  }
  return waitingOn
    ? `Waiting for ${waitingOn} to finish, then runs:\n${command}`
    : `Queued; waiting for launch delivery.\n${runs}`
}
