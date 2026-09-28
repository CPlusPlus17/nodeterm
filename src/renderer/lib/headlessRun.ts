// Canvas-control headless start (#925): `open-* --run-now` and `run --node`. Pure planners plus
// one orchestrator with injected effects, so Canvas.tsx only wires. See the spec (§4) for the flow:
// write-ahead claim → launch through main → patch the node wherever it lives NOW.
import type { CanvasNodeState, PendingLaunch, Project, PtyCreateOptions } from '@shared/types'
import type { HeadlessLaunchFailure, HeadlessLaunchResult } from '@shared/headless-launch'
import { HEADLESS_COLS, HEADLESS_ROWS, localNodePtyOptions } from '@shared/node-pty-options'

export const RUN_NOW_AFTER_REFUSAL =
  'run-now-after-unsupported: --run-now cannot be combined with --after'

export type RunVerbPlan = 'nothing-queued' | 'already-starting' | 'mounted' | 'wait-for-mount' | 'headless'

/** What `run --node` does. A project on screen never starts headless: its node either has a
 *  mounted writer (the ▶ path) or starts through the ordinary path when its terminal next mounts. */
export function planRunVerb(input: {
  pending?: PendingLaunch
  inFlight: boolean
  projectActive: boolean
  hasWriter: boolean
}): RunVerbPlan {
  if (!input.pending?.command) return 'nothing-queued'
  if (input.inFlight) return 'already-starting'
  if (input.projectActive) return input.hasWriter ? 'mounted' : 'wait-for-mount'
  return 'headless'
}

/** The write-ahead claim, saved before any spawn: a crash mid-start can never auto-start twice
 *  (`launchesToFire` skips manualOnly, on every build). */
export function claimForHeadless(p: PendingLaunch): PendingLaunch {
  return { ...p, executor: 'core', attempted: true, manualOnly: true }
}

export function headlessStartNoticeText(projectName: string, count: number): string {
  const what = count === 1 ? 'a session' : `${count} sessions`
  return `An agent started ${what} in "${projectName}". That project is not on screen.`
}

export type HeadlessStartOutcome =
  | { id: string; started: true }
  | {
      id: string
      started: false
      reason: HeadlessLaunchFailure | 'already-starting' | 'claim-not-saved' | 'nothing-queued'
    }

export interface HeadlessStartDeps {
  launch(req: { ptyOptions: PtyCreateOptions; command: string }): Promise<HeadlessLaunchResult>
  /** Persist `pending` (undefined = cleared) on the node wherever it lives NOW; true = on disk. */
  savePending(nodeId: string, pending: PendingLaunch | undefined): Promise<boolean>
  markStarting(nodeId: string): void
  markFailed(nodeId: string): void
  clearDelivery(nodeId: string): void
  /** Shared across calls: one start per node at a time. */
  inFlight: Set<string>
}

export async function startHeadless(
  deps: HeadlessStartDeps,
  input: { project: Pick<Project, 'id' | 'cwd'>; node: CanvasNodeState }
): Promise<HeadlessStartOutcome> {
  const { node, project } = input
  const id = node.id
  const original = node.pendingLaunch
  if (!original?.command) return { id, started: false, reason: 'nothing-queued' }
  if (deps.inFlight.has(id)) return { id, started: false, reason: 'already-starting' }
  deps.inFlight.add(id)
  try {
    if (!(await deps.savePending(id, claimForHeadless(original)))) {
      // Never spawn on an unsaved claim: a crash would re-deliver on the next view.
      await deps.savePending(id, original)
      return { id, started: false, reason: 'claim-not-saved' }
    }
    deps.markStarting(id)
    let result: HeadlessLaunchResult
    try {
      result = await deps.launch({
        ptyOptions: localNodePtyOptions(project, node, { cols: HEADLESS_COLS, rows: HEADLESS_ROWS }),
        command: original.command
      })
    } catch {
      result = { outcome: 'failed', reason: 'spawn-failed' }
    }
    if (result.outcome === 'delivered') {
      deps.clearDelivery(id)
      await deps.savePending(id, undefined)
      return { id, started: true }
    }
    if (result.reason === 'not-persistent') {
      // Nothing was spawned. Hand the node back exactly as it was, so a cold open starts on view
      // and an already-attempted node keeps its manual Run now.
      deps.clearDelivery(id)
      await deps.savePending(id, original)
    } else {
      deps.markFailed(id)
    }
    return { id, started: false, reason: result.reason }
  } finally {
    deps.inFlight.delete(id)
  }
}

export interface PendingStoreEnv {
  activeProjectId(): string
  patchLive(nodeId: string, pending: PendingLaunch | undefined): boolean
  patchStored(projectId: string, nodeId: string, pending: PendingLaunch | undefined): boolean
  writeDisk(): Promise<boolean>
  markDirty(): void
}

/** React Flow is the truth for the ACTIVE project, the store for every other one. Decided at the
 *  moment of each write, because the user may switch projects while a start is in flight. */
export async function savePendingAnywhere(
  env: PendingStoreEnv,
  projectId: string,
  nodeId: string,
  pending: PendingLaunch | undefined
): Promise<boolean> {
  if (env.activeProjectId() === projectId) {
    if (!env.patchLive(nodeId, pending)) return false
    env.markDirty()
    return true
  }
  if (!env.patchStored(projectId, nodeId, pending)) return false
  return env.writeDisk()
}

const STARTS_ON_VIEW = / — queued; starts when that project is next viewed/
const CLOSED_HINT = / \(that project is closed — reopen it from the welcome screen\)/

/** Turn a cold-open reply (`coldOpenMessage` + result) into the `--run-now` reply. */
export function mergeRunNow<T extends { ok: true; message: string; result: Record<string, unknown> }>(
  base: T,
  outcomes: HeadlessStartOutcome[]
): T {
  const startedIds = outcomes.filter((o) => o.started).map((o) => o.id)
  const failed = outcomes.filter(
    (o): o is Extract<HeadlessStartOutcome, { started: false }> => !o.started
  )
  const queuedIds = failed.map((o) => o.id)
  const reason = failed[0]?.reason
  const message =
    base.message.replace(STARTS_ON_VIEW, '').replace(CLOSED_HINT, '') +
    (startedIds.length ? ` — started: ${startedIds.join(', ')}` : '') +
    (queuedIds.length ? ` — queued (${reason}): ${queuedIds.join(', ')}` : '')
  return {
    ...base,
    message,
    result: {
      ...base.result,
      started: startedIds.length > 0,
      startedIds,
      queued: queuedIds.length > 0,
      queuedIds,
      ...(reason ? { reason } : {})
    }
  }
}
