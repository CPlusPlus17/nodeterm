// The canvas side of "Share with team": what `runShare` (shareSshTeam.ts) is handed about the
// project, the project-store steps it calls, and landing on the shared project afterwards. Pure
// over injected canvas operations, so each rule below is pinned by a test rather than by a reading
// of Canvas.tsx.
import type { AgentState } from '@shared/agents/normalize'
import type { CanvasNodeState, HandedOffTo } from '@shared/types'
import type { ShareDeps, ShareNode } from './shareSshTeam'

/** The project's terminal nodes as the share sees them. The hook-fed session id wins over the one
 *  persisted at launch: `/clear` and `--fork-session` mint a new one inside the CLI. */
export function shareTerminals(
  nodes: CanvasNodeState[],
  status: Record<string, { sessionId?: string; state?: AgentState } | undefined>
): ShareNode[] {
  return nodes
    .filter((n) => (n.kind ?? 'terminal') === 'terminal')
    .map((n) => {
      const live = status[n.id]
      const sessionId = live?.sessionId ?? n.agentSessionId
      return {
        nodeId: n.id,
        title: n.title || n.id,
        ...(n.agentId ? { agentId: n.agentId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(n.accountId ? { accountId: n.accountId } : {}),
        ...(live?.state ? { state: live.state } : {})
      }
    })
}

/** What the share needs from the canvas for ONE project. */
export interface ShareCanvasOps {
  /** Commit the live canvas into the store. */
  commit(): void
  /** Save the workspace (on an SSH project this awaits the mirror queue); false = it failed. */
  save(): Promise<boolean>
  setHandedOffTo(value: HandedOffTo | undefined): void
  isClosed(): boolean
  /** Close the project non-destructively: its sessions keep running, and no dialog is raised. */
  close(): void
  /** Reopen it without the handed-off warning: this is the share's own undo. */
  reopen(): void
  /** The joiner's answer, or null when there is no joiner to ask. */
  join(code: string, focusProjectId: string): 'started' | 'busy' | null
  /** Take the user to this project once its tab is open. */
  followTab(projectId: string): void
  now(): number
}

export const SHARE_SAVE_FAILED = 'The canvas could not be saved on this computer.'

/** The store steps of `runShare` for one project. Each one that saves fails when the save did not
 *  land: the orchestrator relies on "it resolved" meaning "it is on disk" (a mark that never reached
 *  the index does not stop the mirror). The orchestrator owns every undo; nothing here undoes. */
export function shareProjectDeps(
  ops: ShareCanvasOps
): Pick<ShareDeps, 'prepare' | 'markPending' | 'release' | 'restore' | 'markHandedOff' | 'join'> {
  const save = async (): Promise<void> => {
    if (!(await ops.save())) throw new Error(SHARE_SAVE_FAILED)
  }
  return {
    async prepare() {
      ops.commit()
      await save()
    },
    async markPending() {
      ops.setHandedOffTo({ at: ops.now() })
      await save()
    },
    async release() {
      ops.close()
      await save()
    },
    // Also called on a project that was never closed (a failure before `release`): reopening only
    // what is closed means the undo never moves the user to another project.
    async restore() {
      ops.setHandedOffTo(undefined)
      if (ops.isClosed()) ops.reopen()
      await save()
    },
    async markHandedOff(to) {
      ops.setHandedOffTo({ ...to, at: ops.now() })
      await save()
    },
    // A join that starts lands on the shared project itself. A busy one means this desktop is
    // already connected to the team: nothing mounts, and the project's tab arrives through the
    // team's share event, which opens it without taking the screen.
    join(code, focusProjectId) {
      if (ops.join(code, focusProjectId) === 'busy') ops.followTab(focusProjectId)
    }
  }
}

/** How long a share follows the shared project's tab before giving up on it. */
export const SHARE_FOCUS_WAIT_MS = 30_000

export interface ShareFocusView {
  activeId: string
  targetOpen: boolean
}

/** One look at the store: switch to the shared tab now that it is open, keep waiting, or stop
 *  (already there, or the user moved to another project themselves and must not be pulled back). */
export function shareFocusStep(targetId: string, startActiveId: string, now: ShareFocusView): 'switch' | 'wait' | 'stop' {
  if (now.activeId === targetId) return 'stop'
  if (now.targetOpen) return 'switch'
  if (now.activeId !== startActiveId) return 'stop'
  return 'wait'
}

/** Switch to `targetId` once its tab is open, at most `SHARE_FOCUS_WAIT_MS` from now. Returns a
 *  stop function (idempotent). */
export function followSharedProject(deps: {
  targetId: string
  read(): ShareFocusView
  subscribe(listener: () => void): () => void
  switchTo(id: string): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}): () => void {
  const startActiveId = deps.read().activeId
  let done = false
  let unsubscribe: () => void = () => {}
  let timer: unknown
  const stop = (): void => {
    if (done) return
    done = true
    unsubscribe()
    if (timer !== undefined) deps.clearTimer(timer)
  }
  const check = (): void => {
    if (done) return
    const step = shareFocusStep(deps.targetId, startActiveId, deps.read())
    if (step === 'wait') return
    stop()
    if (step === 'switch') deps.switchTo(deps.targetId)
  }
  check()
  if (done) return stop
  unsubscribe = deps.subscribe(check)
  timer = deps.setTimer(stop, SHARE_FOCUS_WAIT_MS)
  return stop
}
