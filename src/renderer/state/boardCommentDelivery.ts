import { create } from 'zustand'

/**
 * What THIS app run knows about the deliveries of the board comments the local user posted:
 * `byComment[commentId][targetNodeId]`. Transient on purpose — the durable record is the delivery
 * trace in the board log itself (one `agent-message` line per outcome, `from: board-comment:<id>`),
 * which a reloaded comment row reads. This store only covers what the log cannot: "sending…" before
 * any outcome exists, and a failure that never reached the core (no canvas to deliver through, a
 * canvas that could not publish its edits, a node mid-restart, an IPC that threw).
 */
export type MentionDelivery =
  | { at: number; state: 'sending' }
  | { at: number; state: 'done'; kind: string; reason?: string; error?: string }

/** Comments whose deliveries are remembered. Oldest forgotten first; a forgotten one falls back to
 *  its log lines, which is exactly the post-reload behaviour. */
const MAX_COMMENTS = 200

interface BoardCommentDeliveryState {
  byComment: Record<string, Record<string, MentionDelivery>>
  set(commentId: string, targetNodeId: string, d: MentionDelivery): void
  reset(): void
}

export const useBoardCommentDelivery = create<BoardCommentDeliveryState>((set) => ({
  byComment: {},
  set: (commentId, targetNodeId, d) =>
    set((s) => {
      const next = { ...s.byComment, [commentId]: { ...s.byComment[commentId], [targetNodeId]: d } }
      const ids = Object.keys(next)
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_COMMENTS))) delete next[id]
      return { byComment: next }
    }),
  reset: () => set({ byComment: {} })
}))
