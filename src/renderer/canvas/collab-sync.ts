import type { NodeTerminalApi } from '@shared/types'
import { shouldPublishCanvas } from '@shared/canvas-publish'
import type { WorkspaceSession } from '../session/session'

/**
 * Task 4's whole fix in one pure place: the canvas-sync PUBLISHER + the onMutation SUBSCRIBER must
 * hit the ACTIVE session's core, and the solo publish gate must count the ACTIVE session's presence
 * peers — NOT the LOCAL session's. The bug this replaces: on a relay tab the publisher mutated B's
 * OWN local core (never the relay host) and gated on the empty local presence, so `hasPeers` was
 * false and a node B opened never reached A.
 *
 * The `peers` table includes ourselves, so `> 1` means a teammate is attached (the same predicate
 * the presence session's own solo gate uses). Kept a pure `(session, presenceState) → target` so it
 * is unit-testable without rendering Canvas: a relay session yields the relay api + its peer count,
 * a local session yields `window.nodeTerminal` + the local peer count — byte-identical to today.
 */
export function canvasSyncTarget(
  session: WorkspaceSession,
  presenceState: { peers: Record<string, unknown> },
  governed = false
): { api: NodeTerminalApi; hasPeers: boolean; shouldPublish: boolean } {
  const hasPeers = Object.keys(presenceState.peers).length > 1
  return { api: session.api, hasPeers, shouldPublish: shouldPublish({ hasPeers, governed }) }
}

/**
 * The publish rule (Canvas's `shouldPublishFor` applies it inline, beside the same-core and role
 * checks): publish when a teammate is attached, OR when the project is governed by a canvas
 * authority. A governed project's content is written only from the ops the authority hears
 * (docs/hosted-team-relay.md), so a solo edit that is not published is never saved. One definition,
 * in shared, so the core's end-to-end test drives the same rule.
 */
export const shouldPublish = shouldPublishCanvas

/**
 * Follow which projects a core's canvas authority governs: ask once, then take every change.
 * `apply` gets the new set each time. A change that lands before the first answer wins over that
 * answer, which it may postdate; a failed answer changes nothing. Returns the release: after it,
 * nothing more is applied and the change subscription is gone.
 */
export function followGoverned(
  api: Pick<NodeTerminalApi, 'canvasAuthority'>,
  apply: (ids: ReadonlySet<string>) => void
): () => void {
  let live = true
  let changed = false
  void api.canvasAuthority.governed().then(
    (ids) => {
      if (live && !changed) apply(new Set(ids))
    },
    () => {}
  )
  const off = api.canvasAuthority.onChanged((ids) => {
    changed = true
    if (live) apply(new Set(ids))
  })
  return () => {
    live = false
    off()
  }
}
