// Every way this desktop (re)joins a hosted team, over ONE attempt owner per team (hostedAttempts.ts):
//  - boot: each APPROVED bookmark reconnects on its own, in the background;
//  - a drop: a live hosted tab whose connection dropped (no host reason) reconnects in place, in the
//    background, while its team is still bookmarked and approved and the tab is still open;
//  - a click on the greyed tab: reconnects in place now (no pairing-code prompt — the bookmark is the
//    credential);
//  - a pasted join code: joins now, and is told why if it cannot;
//  - forgetting a team: stops its loop and removes its bookmark (the host is not touched).
// And what the user is told for each: one sentence per stop, nothing for a retry in progress, a
// "remove and rejoin" offer after a revocation. Pure over injected deps (no React, no window).
// See docs/hosted-team-relay.md.
import type { RelayClosedReason, RelayHostedApi } from '@shared/types'
import { peekJoinCode } from '@shared/relay-join-code'
import { createHostedAttempts, type HostedAttemptRequest, type HostedMountResult } from './hostedAttempts'
import { closedReasonMessage, joinStopMessage, mountFailureMessage, mountFailureRetries, stripIpcPrefix } from './hostedTeam'

/** How a mount ended, as the canvas reports it: a live tab, or the error it failed with. `declined`
 *  = this user declined the SAS themselves (nothing to tell them). */
export type HostedMountOutcome = { projectId: string } | { error: unknown; declined: boolean }

export interface HostedNotice {
  kind: 'info' | 'error'
  text: string
  action?: { label: string; run: () => void }
}

export interface HostedJoinerDeps {
  /** `relayClient.connect` — a join code in, a connection id out (or main's `[E_JOIN_…]` refusal). */
  connect(code: string): Promise<string>
  onClosed(connectionId: string, listener: (reason?: RelayClosedReason) => void): () => void
  disconnect(connectionId: string): void
  bookmarks: RelayHostedApi['bookmarks']
  removeBookmark: RelayHostedApi['removeBookmark']
  /** The SAS (a first join), the owner's approval, the tab. Never rejects on purpose; a rejection
   *  is read as a failure with that error. */
  mount(connectionId: string, req: HostedAttemptRequest): Promise<HostedMountOutcome>
  /** Is this project still an open tab (not closed, not deleted)? */
  tabOpen(projectId: string): boolean
  notify(notice: HostedNotice): void
  /** Ask the user for a fresh invite code for `teamLabel`; null = cancelled. */
  promptForCode(teamLabel: string): Promise<string | null>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface HostedJoiner {
  /** A join code the user pasted: joins now, never loops. `reconnectProjectId` = it was pasted
   *  into a greyed tab's reconnect prompt, so that tab is the one it reconnects. */
  joinWithCode(code: string, reconnectProjectId?: string): void
  /** A greyed tab was clicked. False when it is not a hosted tab this joiner opened (the caller
   *  takes its pairing-code path). */
  reconnectTab(projectId: string): boolean
  isHostedTab(projectId: string): boolean
  /** Reconnect every approved bookmark (once, at boot). */
  bootReconnect(): Promise<void>
  /** Forget a team: its loop stops and its bookmark goes. Refused while it is connecting. */
  forget(hostId: string, label: string): Promise<void>
  /** Is this team connecting or waiting for the host right now? */
  connecting(hostId: string): boolean
  dispose(): void
}

const team = (label: string): string => label.trim() || 'the team'

export function createHostedJoiner(deps: HostedJoinerDeps): HostedJoiner {
  /** The team each hosted tab this joiner opened belongs to, by project id. */
  const tabs = new Map<string, { hostId: string; code: string; label: string }>()
  let run: (req: HostedAttemptRequest) => 'started' | 'busy' = () => 'busy'

  const attempts = createHostedAttempts({
    connect: deps.connect,
    onClosed: deps.onClosed,
    disconnect: deps.disconnect,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    async mount(connectionId, req): Promise<HostedMountResult> {
      let outcome: HostedMountOutcome
      try {
        outcome = await deps.mount(connectionId, req)
      } catch (error) {
        outcome = { error, declined: false }
      }
      if ('projectId' in outcome) {
        tabs.set(outcome.projectId, { hostId: req.hostId, code: req.code, label: req.label })
        return { projectId: outcome.projectId }
      }
      if (outcome.declined) return { retry: false }
      const retry = mountFailureRetries(outcome.error)
      // An unattended attempt that will try again says nothing; the next one may well work.
      if (retry && req.retry) return { retry: true }
      deps.notify({ kind: 'error', text: mountFailureMessage(outcome.error, req.label) })
      return { retry: false }
    },
    stopped(req, failure) {
      const text = joinStopMessage(failure, req.label)
      if (!text) return
      if (failure.code === 'E_JOIN_REVOKED') {
        deps.notify({ kind: 'error', text, action: { label: 'Remove and rejoin', run: () => void removeAndRejoin(req) } })
        return
      }
      deps.notify({ kind: 'error', text })
    },
    ended(req, projectId, reason) {
      const said = closedReasonMessage(reason)
      if (said) {
        deps.notify({ kind: 'error', text: `${team(req.label)}: ${said}` })
        return
      }
      // A drop. Come back in place, unattended — but only for a tab still open, on a team still
      // bookmarked and approved (a forgotten team, or one whose approval was withdrawn, waits for
      // the user; an approved bookmark reconnects with no SAS on this side).
      if (!deps.tabOpen(projectId)) return
      void deps.bookmarks().then(
        (list) => {
          const b = list.find((x) => x.hostId === req.hostId)
          if (!b?.approved || !deps.tabOpen(projectId)) return
          run({ hostId: b.hostId, code: b.code, label: b.label, manual: false, retry: true, reconnectProjectId: projectId })
        },
        () => {}
      )
    }
  })
  run = (req) => attempts.run(req)

  const busyText = (hostId: string, label: string): string =>
    attempts.phase(hostId) === 'live' ? `You're already connected to ${team(label)}.` : `Already connecting to ${team(label)}…`

  async function removeAndRejoin(req: HostedAttemptRequest): Promise<void> {
    // The bookmark still holds the revoked token: offering it again would only be refused again.
    try {
      await deps.removeBookmark(req.hostId)
    } catch (err) {
      deps.notify({ kind: 'error', text: `Could not forget ${team(req.label)}: ${stripIpcPrefix(err instanceof Error ? err.message : String(err))}` })
      return
    }
    const code = (await deps.promptForCode(req.label))?.trim()
    if (code) joiner.joinWithCode(code)
  }

  const joiner: HostedJoiner = {
    joinWithCode(raw, reconnectProjectId) {
      const code = raw.trim()
      const peek = peekJoinCode(code)
      // A code the renderer cannot read still goes to main, which verifies codes and answers for
      // this one; its key is the text itself, so a double paste of it is still one attempt.
      const hostId = peek?.hostId ?? `unreadable:${code}`
      const label = peek?.label ?? ''
      const req: HostedAttemptRequest = { hostId, code, label, manual: true, retry: false, ...(reconnectProjectId ? { reconnectProjectId } : {}) }
      if (run(req) === 'busy') {
        deps.notify({ kind: 'info', text: busyText(hostId, label) })
      }
    },
    reconnectTab(projectId) {
      const t = tabs.get(projectId)
      if (!t) return false
      if (run({ ...t, manual: true, retry: true, reconnectProjectId: projectId }) === 'busy') {
        deps.notify({ kind: 'info', text: `Already reconnecting to ${team(t.label)}…` })
      }
      return true
    },
    isHostedTab(projectId) {
      return tabs.has(projectId)
    },
    async bootReconnect() {
      const list = await deps.bookmarks().catch(() => [])
      for (const b of list) {
        if (b.approved) run({ hostId: b.hostId, code: b.code, label: b.label, manual: false, retry: true })
      }
    },
    async forget(hostId, label) {
      if (joiner.connecting(hostId)) {
        deps.notify({ kind: 'info', text: `Still connecting to ${team(label)}; forget it once that finishes.` })
        return
      }
      attempts.cancel(hostId)
      try {
        await deps.removeBookmark(hostId)
      } catch (err) {
        deps.notify({ kind: 'error', text: `Could not forget ${team(label)}: ${stripIpcPrefix(err instanceof Error ? err.message : String(err))}` })
        return
      }
      deps.notify({ kind: 'info', text: `Forgot ${team(label)}. This device will not reconnect to it.` })
    },
    connecting(hostId) {
      const phase = attempts.phase(hostId)
      return phase === 'connecting' || phase === 'mounting'
    },
    dispose() {
      attempts.dispose()
    }
  }
  return joiner
}
