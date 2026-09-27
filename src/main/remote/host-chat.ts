// The production `HostChatOps` behind the phone's Chat screen verbs (docs/mobile-chat-view.md
// §3.2). Electron-free and dependency-injected so every rule is testable without a window: main
// wires the real node lookup, transcript reader, answer I/O and renderer bridge.
//
// Three rules the shape exists to hold:
//   - The node is resolved HERE, from the host's own registry — never from anything the phone
//     sends. A node the host does not know is refused, not answered with an empty page.
//   - The send gate is the RENDERER's (it owns the agent-status store and `chatSendRefusal`, the
//     same one the ⌘M composer runs), asked at send time. A renderer that does not answer fails
//     CLOSED: status is an error, send is a refusal. A guessed state would let a message be typed
//     into a permission dialog, whose Enter answers it.
//   - An answer goes through `answerHeldPermission` — the one body both shells share — so it is
//     validated against the pending request file on the agent's host and gated on the structured
//     ticket ledger, exactly like the desktop's own answer controls.
import type { ChatTranscriptResult } from '../../shared/types'
import type { ChatSendResult, ChatStatus } from '../../shared/mobile-chat'
import type { ChatReadQuery } from '../../core/transcript-ipc'
import {
  answerHeldPermission,
  type HeldPermissionIo
} from '../../core/agents/permission-decision'
import type { HostChatOps } from './host-service'

/** What the host knows about a node, from its own records. */
export interface HostChatNode {
  cwd?: string
  accountId?: string
  agentId?: string
  sessionId?: string
}

export interface HostChatDeps {
  /** The node from the host's own registry, or null when it has no such node. */
  lookupNode(nodeId: string): HostChatNode | null
  /** `readChatTranscript` (core/transcript-ipc.ts) with the shell's deps bound. */
  readTranscript(q: ChatReadQuery, rawPage: unknown): Promise<ChatTranscriptResult>
  /** The held-request I/O for this node: local fs, or the SSH project's ControlMaster. */
  answerIo(nodeId: string, pendingId: string): HeldPermissionIo
  /** Test seam; defaults to the real `answerHeldPermission`. */
  answerHeld?: typeof answerHeldPermission
  /** A successful answer — main emits the same optimistic "answered" transition the desktop's
   *  own answer path does, so every surface's NEEDS YOU clears at once. */
  onAnswered?(nodeId: string, pendingId: string, decision: 'allow' | 'deny'): void
  /** The in-process structured-ticket ledger (`isStructuredTicket`). */
  isStructuredTicket(pendingId: string): boolean
  /** The renderer query bridge. `null` = no window to ask. */
  renderer: {
    status(q: { nodeId: string; agentId?: string }): Promise<Omit<ChatStatus, 'structuredAnswers'> | null>
    send(q: { nodeId: string; agentId?: string; text: string; startBy: number }): Promise<ChatSendResult | null>
  }
  /** How long a status query may take, and how long a send has to START (the renderer refuses a
   *  send it receives after `startBy`), before failing closed. Default 3 s. */
  timeoutMs?: number
  /** How long a started send may take to report (a paste over SSH plus the settled-submit wait).
   *  Default 15 s. */
  sendTimeoutMs?: number
  /** Clock seam for `startBy`. */
  now?: () => number
}

export const HOST_CHAT_RENDERER_TIMEOUT_MS = 3000
export const HOST_CHAT_SEND_TIMEOUT_MS = 15_000

const TIMED_OUT = Symbol('timed-out')

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export function createHostChat(deps: HostChatDeps): HostChatOps {
  const timeoutMs = deps.timeoutMs ?? HOST_CHAT_RENDERER_TIMEOUT_MS
  const sendTimeoutMs = deps.sendTimeoutMs ?? HOST_CHAT_SEND_TIMEOUT_MS
  const now = deps.now ?? Date.now
  const answerHeld = deps.answerHeld ?? answerHeldPermission
  return {
    async page(nodeId, rawPage) {
      const node = deps.lookupNode(nodeId)
      if (!node) return null
      // No known session id ⇒ no cwd either: claude's resolver would otherwise fall back to the
      // NEWEST transcript in the cwd, which may be another node's session. Not found is the honest
      // answer (the ⌘M panel likewise shows the chat only once the session id is known).
      const q: ChatReadQuery = {
        sessionId: node.sessionId,
        cwd: node.sessionId ? node.cwd : undefined,
        accountId: node.accountId,
        nodeId,
        agentId: node.agentId
      }
      // Always PAGED: an absent page is the default tail, never the legacy 5 MB read.
      const result = await deps.readTranscript(q, rawPage ?? {})
      return { ...result, version: 1 }
    },

    async status(nodeId) {
      const node = deps.lookupNode(nodeId)
      if (!node) return null
      const answered = await withTimeout(deps.renderer.status({ nodeId, agentId: node.agentId }), timeoutMs)
      if (answered === TIMED_OUT || answered === null) {
        throw new Error('The desktop window is not available.')
      }
      const structuredAnswers = answered.held ? deps.isStructuredTicket(answered.held.pendingId) : false
      return { ...answered, structuredAnswers }
    },

    async send(nodeId, text) {
      const node = deps.lookupNode(nodeId)
      if (!node) return 'unknown-node'
      try {
        // `startBy`: a renderer that receives this late (a stalled window) refuses rather than
        // typing a message the phone has already been told was not sent. A send that STARTED in
        // time gets the longer budget to finish; past it the answer is 'refused' although the text
        // may still land — the one residual race, bounded by how long a paste can take.
        const startBy = now() + timeoutMs
        const result = await withTimeout(
          deps.renderer.send({ nodeId, agentId: node.agentId, text, startBy }),
          sendTimeoutMs
        )
        return result === TIMED_OUT || result === null ? 'refused' : result
      } catch {
        return 'refused'
      }
    },

    async answer(nodeId, pendingId, answer) {
      if (!deps.lookupNode(nodeId)) return false
      const res = await answerHeld(pendingId, { answer }, deps.answerIo(nodeId, pendingId))
      if (res.ok && res.decision) deps.onAnswered?.(nodeId, pendingId, res.decision)
      return res.ok
    }
  }
}
