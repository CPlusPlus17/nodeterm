// Casts the node and edge writes THIS renderer makes into a project's STORED copy — the projects
// store's `applyOwnNodeMutation` / `appendCanvasLinks`, which call the store's publish hook
// (`setStoredCanvasPublishHook`). The node publisher cannot: it diffs React Flow, and a stored
// project's nodes enter React Flow only through a load, which it adopts as its baseline. So a ⌘⇧T
// reopen, a cold open, an off-canvas display node or a headless start's launch patch into a project
// that is not on screen was never cast, and on a project a Server Edition canvas authority governs
// the next save overlay dropped it from disk (docs/hosted-team-relay.md).
//
// The rule lives here rather than in Canvas so it is tested without a canvas:
//  - ONLY A GOVERNED PROJECT. The authority is what drops an un-cast write; an ungoverned project's
//    stored write keeps riding the whole-file save exactly as before, so the desktop and every
//    unshared project cast nothing new, even with a teammate attached.
//  - NEVER THE PROJECT REACT FLOW HOLDS. That canvas is the node publisher's; a store write there is
//    a stale copy the next commit overwrites, and casting it would put a value on the wire this canvas
//    does not show. A project mid-switch (active, not yet installed) is still the store's, and its
//    load adopts what was cast here, so nothing is cast twice.
//  - THE SAME GATE AND THE SAME CAST as every other family (`shouldPublishFor`, `castFor`): the same
//    core, a role that may publish, the order's pending entry and the size guard. A held launch rides
//    the owner leg as usual.
import type { StoredCanvasPublishHook } from '../state/projects'
import type { CanvasMutation } from '@shared/types'

export interface StoredCanvasPublisherDeps {
  /** The project React Flow holds right now (the epoch tag), or null. */
  renderedProjectId(): string | null
  /** Is `projectId` governed by a canvas authority (Canvas's followed governed set)? */
  isGoverned(projectId: string): boolean
  /** Canvas's one publish gate for `projectId`. */
  shouldPublish(projectId: string): boolean
  /** Canvas's one cast. `false` = not cast. */
  send(projectId: string, m: CanvasMutation): boolean
}

export function createStoredCanvasPublisher(deps: StoredCanvasPublisherDeps): StoredCanvasPublishHook {
  return (projectId, m) => {
    if (deps.renderedProjectId() === projectId) return
    if (!deps.isGoverned(projectId) || !deps.shouldPublish(projectId)) return
    deps.send(projectId, m)
  }
}
