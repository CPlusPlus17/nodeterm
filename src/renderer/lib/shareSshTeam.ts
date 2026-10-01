// "Share with team" for an SSH project: hand the project, and the agent sessions running in it, to
// a hosted team that nodeterm-server runs on the SSH host itself. This module only SEQUENCES the
// steps; every effect (the ssh verbs, the dialog, the project store) is an injected dep, so each
// ordering rule below is pinned by a test rather than by a reading of the UI code.
//
// Three ordering invariants, each guarding a specific loss:
// 1. Nothing is ended before `bootstrap` succeeded. Until the server has adopted and shared the
//    project, the SSH sessions are the only place the work lives; a failure before that point must
//    leave every terminal running.
// 2. Nothing is resumed on the server before its `nodeterm-rmt` session was VERIFIED gone, so there
//    are never two processes on one conversation (two CLIs appending to one transcript). A kill
//    that could not be verified resumes nothing and reports the node as still on SSH.
// 3. After a successful bootstrap the SSH project is never reopened: the server is now the only
//    writer of the project file, and a desktop mirror write would race it. Every failure before
//    that point leaves the project as it was: once the share has marked (or closed) it, the
//    failure clears the mark and reopens it before it is reported.
//
// The in-progress mark is set BEFORE the mirror is flushed, not with the close: a desktop save
// between the flush and the close could otherwise queue a throttled mirror write that lands on the
// host after the server adopted the file.
import type { AgentState } from '@shared/agents/normalize'
import { RESUMABLE_AGENTS, type AgentPermissionMode } from '@shared/agents/config'
import { isShellCommand } from '@shared/agents/pane'
import { peekJoinCode } from '@shared/relay-join-code'
import { SAFE_SESSION_ID } from '@shared/session-id'
import {
  SHARE_MAX_TERMINALS,
  SHARE_REFUSAL,
  type ResumeEntry,
  type ShareReply,
  type ShareTeamApi
} from '@shared/share-team'

/** One terminal node of the project being shared, with what the renderer knows about its agent. */
export interface ShareNode {
  nodeId: string
  title: string
  agentId?: string
  sessionId?: string
  accountId?: string
  state?: AgentState
}
export interface ShareInput {
  projectId: string
  projectName: string
  host: string
  user: string
  terminals: ShareNode[]
  permissionMode: AgentPermissionMode
}
export type SharePhase =
  | 'probing'
  | 'installing'
  | 'checking-install'
  | 'releasing'
  | 'bootstrapping'
  | 'handing-over'
  | 'joining'
/** Everything the user is asked to agree to before anything on the host changes. */
export interface ShareConfirmSummary {
  host: string
  user: string
  install: null | 'missing' | 'outdated' | 'not-running'
  /** The installer restarts a service that already runs a team (its members reconnect). */
  restartsService: boolean
  resumable: ShareNode[]
  manual: Array<{ node: ShareNode; reason: string }>
  /** Plain terminals running something other than a shell: the handover stops it. */
  stopping: Array<{ node: ShareNode; command: string }>
  security: string
}
export type ShareOutcome =
  | { kind: 'refused'; reason: string; busy?: ShareNode[] }
  | { kind: 'cancelled' }
  | { kind: 'failed'; step: SharePhase; error: string; reopened: boolean; log?: string }
  | {
      kind: 'shared'
      joinCode: string
      teamLabel: string
      projectName: string
      hosting: 'up' | 'starting'
      resumed: ShareNode[]
      notResumed: Array<{ node: ShareNode; reason: string }>
      stillOnSsh: ShareNode[]
    }
export interface ShareDeps {
  api: Pick<ShareTeamApi, 'probe' | 'install' | 'flushMirror' | 'bootstrap' | 'killSessions' | 'resume' | 'seedBookmark'>
  confirm(summary: ShareConfirmSummary): Promise<boolean>
  phase(p: SharePhase): void
  /** Commit the live canvas and save, so the latest nodes are on their way to the host. */
  prepare(): Promise<void>
  /** Mark the project handed off (in progress, `handedOffTo {at}`) and save, so no later save of
   *  this project mirrors to the host. */
  markPending(): Promise<void>
  /** Close the project non-destructively and save (the mark is already set). */
  release(): Promise<void>
  /** Undo `markPending` and `release`: clear the mark, reopen, save. */
  restore(): Promise<void>
  markHandedOff(to: { hostId: string; projectId: string }): Promise<void>
  join(joinCode: string, focusProjectId: string): void
}

const BUSY_STATES = new Set<AgentState>(['working', 'blocked'])
const isAgentResumable = (id: string | undefined): boolean =>
  !!id && (RESUMABLE_AGENTS as readonly string[]).includes(id)

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** An IPC verb that throws (a dead bridge, a renderer-side bug) reads as an ordinary failed reply,
 *  so every step below handles exactly one failure shape. */
async function call<T>(fn: () => Promise<ShareReply<T>>): Promise<ShareReply<T>> {
  try {
    return await fn()
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

export function securityNote(user: string, host: string): string {
  return `Editors get a shell as ${user} on ${host} and can make themselves owners; Viewers cannot.`
}

/** Which agents the server can resume, which need the user (and why), and which plain terminals
 *  are running something the handover will stop. A plain terminal sitting at a shell prompt, or
 *  with no live pane, loses nothing and is not listed. */
export function classifyTerminals(
  terminals: ShareNode[],
  paneCommands: Record<string, string>
): Pick<ShareConfirmSummary, 'resumable' | 'manual' | 'stopping'> {
  const resumable: ShareNode[] = []
  const manual: Array<{ node: ShareNode; reason: string }> = []
  const stopping: Array<{ node: ShareNode; command: string }> = []
  for (const n of terminals) {
    if (n.agentId) {
      if (n.accountId) manual.push({ node: n, reason: 'runs under a managed account' })
      else if (!isAgentResumable(n.agentId)) manual.push({ node: n, reason: 'this agent cannot be resumed' })
      else if (!n.sessionId || !SAFE_SESSION_ID.test(n.sessionId)) manual.push({ node: n, reason: 'no conversation to resume yet' })
      else resumable.push(n)
      continue
    }
    const command = paneCommands[n.nodeId]
    if (command && !isShellCommand(command)) stopping.push({ node: n, command })
  }
  return { resumable, manual, stopping }
}

export async function runShare(deps: ShareDeps, input: ShareInput): Promise<ShareOutcome> {
  const { api } = deps
  const { projectId, terminals, host, user } = input
  const failed = (step: SharePhase, error: string, reopened: boolean): ShareOutcome => ({
    kind: 'failed',
    step,
    error,
    reopened
  })

  // Refusals that need no host: checked before anything is asked of it.
  const busy = terminals.filter((n) => n.agentId && n.state && BUSY_STATES.has(n.state))
  if (busy.length) {
    return { kind: 'refused', reason: 'Wait for these agents to finish (or stop them), then share again.', busy }
  }
  if (terminals.length > SHARE_MAX_TERMINALS) {
    return {
      kind: 'refused',
      reason: `This project has more than ${SHARE_MAX_TERMINALS} terminals; Share with team handles at most that many.`
    }
  }
  const ids = terminals.map((n) => n.nodeId)

  deps.phase('probing')
  let probed = await call(() => api.probe(projectId, ids))
  if (!probed.ok) return failed('probing', probed.error, false)
  const plan = probed.plan
  if (plan.kind === 'refuse') return { kind: 'refused', reason: plan.reason }

  const classified = classifyTerminals(terminals, probed.paneCommands)
  const agreed = await deps.confirm({
    host,
    user,
    install: plan.kind === 'install' ? plan.reason : null,
    restartsService: plan.kind === 'install' && probed.probe.teamExists,
    ...classified,
    security: securityNote(user, host)
  })
  if (!agreed) return { kind: 'cancelled' }

  if (plan.kind === 'install') {
    deps.phase('installing')
    const installed = await call(() => api.install(projectId))
    // Probe again whatever the install answered: only a ready server lets the share go on, and a
    // failed reply (a dropped stream, say) does not by itself mean the server is not ready.
    deps.phase('checking-install')
    const again = await call(() => api.probe(projectId, ids))
    if (!again.ok || again.plan.kind !== 'ready') {
      const base = installed.ok
        ? `The install finished (exit ${installed.exitCode}) but nodeterm-server is not ready on the host.`
        : installed.error
      const why = !again.ok ? ` ${again.error}` : again.plan.kind === 'refuse' ? ` ${again.plan.reason}` : ''
      return failed('checking-install', base + why, false)
    }
    probed = again
  }
  // The folder the server adopts comes from the LATEST probe. A ready plan implies it exists (the
  // plan refuses a missing folder); this only narrows the type.
  const adoptCwd = probed.probe.adoptCwd
  if (adoptCwd === null) return { kind: 'refused', reason: SHARE_REFUSAL.noFolder }

  deps.phase('releasing')
  try {
    await deps.prepare()
  } catch (e) {
    return failed('releasing', errorText(e), false)
  }
  // From the mark until a successful bootstrap, every failure clears the mark (and reopens the
  // project if it was closed) before it is reported. Restore's own failure is swallowed: the
  // original failure is the one the user must see.
  const undo = async (): Promise<void> => {
    try {
      await deps.restore()
    } catch {
      /* best effort */
    }
  }
  try {
    await deps.markPending()
  } catch (e) {
    await undo()
    return failed('releasing', errorText(e), false)
  }
  const flushed = await call(() => api.flushMirror(projectId))
  if (!flushed.ok) {
    await undo()
    return failed('releasing', flushed.error, false)
  }
  const onHost = new Set(flushed.nodeIds)
  const missing = terminals.filter((n) => !onHost.has(n.nodeId))
  if (missing.length) {
    await undo()
    return failed(
      'releasing',
      `The canvas on the host is not up to date (${missing.length} terminal${missing.length === 1 ? '' : 's'} missing). Nothing was changed; try again in a moment.`,
      false
    )
  }
  try {
    await deps.release()
  } catch (e) {
    // A close can throw part-way, so restore reopens it whatever state it was left in.
    await undo()
    return failed('releasing', errorText(e), true)
  }

  deps.phase('bootstrapping')
  const booted = await call(() => api.bootstrap(projectId, adoptCwd))
  if (!booted.ok) {
    await undo()
    const error = booted.code === 'E_HOSTING_OFF' ? `Hosting could not start on the host: ${booted.error}` : booted.error
    return failed('bootstrapping', error, true)
  }
  const result = booted.result

  // Best effort: the server already owns the project, and the in-progress mark keeps the desktop
  // from writing it even if this store write fails.
  try {
    await deps.markHandedOff({ hostId: result.hostId, projectId: result.projectId })
  } catch {
    /* best effort */
  }

  deps.phase('handing-over')
  const resumed: ShareNode[] = []
  const notResumed: Array<{ node: ShareNode; reason: string }> = []
  let stillOnSsh: ShareNode[]
  const killed = await call(() => api.killSessions(projectId, ids))
  if (!killed.ok) {
    stillOnSsh = terminals
    for (const n of classified.resumable) notResumed.push({ node: n, reason: 'its SSH session could not be stopped' })
  } else {
    const gone = new Set(killed.results.filter((r) => r.state === 'gone').map((r) => r.nodeId))
    stillOnSsh = terminals.filter((n) => !gone.has(n.nodeId))
    const toResume = classified.resumable.filter((n) => gone.has(n.nodeId))
    if (toResume.length) {
      // classifyTerminals puts a node in `resumable` only with both an agentId and a sessionId.
      const sessions: ResumeEntry[] = toResume.map((n) => ({
        nodeId: n.nodeId,
        agentId: n.agentId as string,
        sessionId: n.sessionId as string,
        permissionMode: input.permissionMode
      }))
      const r = await call(() => api.resume(projectId, result.projectId, sessions))
      if (!r.ok) {
        for (const n of toResume) notResumed.push({ node: n, reason: r.error })
      } else {
        const byId = new Map(r.results.map((e) => [e.nodeId, e]))
        for (const n of toResume) {
          const e = byId.get(n.nodeId)
          if (e && (e.status === 'resumed' || e.status === 'already-running')) resumed.push(n)
          else notResumed.push({ node: n, reason: e ? (e.reason ?? 'the server refused to resume it') : 'the server did not answer for it' })
        }
      }
    }
    for (const n of classified.resumable) {
      if (!gone.has(n.nodeId)) notResumed.push({ node: n, reason: 'still running on SSH' })
    }
  }
  notResumed.push(...classified.manual)

  deps.phase('joining')
  // A failed seed only means the join shows the verification code instead of a pinned bookmark.
  await call(() => api.seedBookmark(result.joinCode))
  deps.join(result.joinCode, result.projectId)

  return {
    kind: 'shared',
    joinCode: result.joinCode,
    teamLabel: peekJoinCode(result.joinCode)?.label || host,
    projectName: result.projectName,
    hosting: result.hosting,
    resumed,
    notResumed,
    stillOnSsh
  }
}
