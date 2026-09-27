// The production `HostChatOps` behind the phone's Chat screen verbs (docs/mobile-chat-view.md
// §3.2). Electron-free and dependency-injected so every rule is testable without a window: main
// wires the real node lookup, transcript reader, answer I/O and renderer bridge.
//
// Three rules the shape exists to hold:
//   - The node is resolved HERE, from the host's own registry — never from anything the phone
//     sends. A node the host does not know is refused, not answered with an empty page.
//   - The send gate is the RENDERER's (it owns the agent-status store and `chatSendRefusal`, the
//     same one the ⌘M composer runs), asked at send time, after the host mirror's own refusal. A
//     renderer that does not answer fails CLOSED: status is an error; a send with no window is
//     'refused', and one dispatched but unanswered is 'unconfirmed' (never 'refused', which invites
//     a resend and a duplicate prompt). A guessed state would let a message be typed into a
//     permission dialog, whose Enter answers it.
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
  /** An SSH-project node: its transcript is located ON the host, keyed on cwd. */
  remote?: boolean
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
    /** The store's session id for the node (what ⌘M reads). `null` = no window. */
    session(q: { nodeId: string }): Promise<{ sessionId?: string } | null>
  }
  /** The HOST's own view of the node, asked before the renderer on a send: true when the mirror says
   *  the agent is working / waiting / blocked or holds a question. Renderer state is transient (a
   *  reload wipes it), the mirror is not — defense in depth, never the only gate. */
  hostSendRefusal(nodeId: string): boolean
  /** The approval tickets the host's mirror holds for this node (`pendingTicketsFor`). */
  knownTickets(nodeId: string): string[]
  /** How long a status query may take, and how long a send has to START (the renderer refuses a
   *  send it receives after `startBy`), before failing closed. Default 3 s. */
  timeoutMs?: number
  /** How long a started send may take to report (a paste over SSH plus the settled-submit wait).
   *  Default 15 s. */
  sendTimeoutMs?: number
  /** Clock seam for `startBy`. */
  now?: () => number
}

/** The host mirror's half of the send gate (`hostSendRefusal`): refuse while the agent is working,
 *  waiting or blocked, or holds a question / approval ticket. `done` and an unknown state pass on to
 *  the renderer's own gate, which still has the final say. */
export function mirrorRefusesChatSend(
  entry: { state?: string | null; pendingQuestion?: unknown; concurrentApprovalIds?: readonly string[] } | undefined
): boolean {
  if (!entry) return false
  if (entry.state === 'working' || entry.state === 'waiting' || entry.state === 'blocked') return true
  return !!entry.pendingQuestion || (entry.concurrentApprovalIds?.length ?? 0) > 0
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
  async function ticketBelongsTo(nodeId: string, agentId: string | undefined, pendingId: string): Promise<boolean> {
    if (deps.knownTickets(nodeId).includes(pendingId)) return true
    try {
      const st = await withTimeout(deps.renderer.status({ nodeId, agentId }), timeoutMs)
      return st !== TIMED_OUT && st !== null && st.held?.pendingId === pendingId
    } catch {
      return false
    }
  }

  return {
    async page(nodeId, rawPage) {
      const node = deps.lookupNode(nodeId)
      if (!node) return null
      // The renderer's agent-status id first: it is what ⌘M reads, and after a desktop restart a
      // hook-fed id lives there while the mirror is empty and the node carries a stale minted id.
      // The host records are the fallback only when the renderer does not answer in time.
      let sessionId = node.sessionId
      try {
        const fromRenderer = await withTimeout(deps.renderer.session({ nodeId }), timeoutMs)
        if (fromRenderer !== TIMED_OUT && fromRenderer && typeof fromRenderer.sessionId === 'string' && fromRenderer.sessionId) {
          sessionId = fromRenderer.sessionId
        }
      } catch {
        // fall back to the host records
      }
      // A cwd rides only for a REMOTE node with a known session id — the host-side locate is keyed
      // on it. Locally the id alone resolves the file, and a cwd would let a known-but-dead id fall
      // back to the NEWEST transcript in that cwd: another node's session. With no id at all, not
      // found is the honest answer.
      const q: ChatReadQuery = {
        sessionId,
        cwd: sessionId && node.remote ? node.cwd : undefined,
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
      if (deps.hostSendRefusal(nodeId)) return 'refused'
      try {
        // `startBy`: a renderer that receives this late (a stalled window) refuses rather than
        // typing a message the phone has already been told was not sent. A send that STARTED in
        // time gets the longer budget to finish; past it the answer is 'unconfirmed' — the text may
        // still land, so the phone must not resend it (a duplicate prompt), only re-read.
        const startBy = now() + timeoutMs
        const result = await withTimeout(
          deps.renderer.send({ nodeId, agentId: node.agentId, text, startBy }),
          sendTimeoutMs
        )
        if (result === TIMED_OUT) return 'unconfirmed'
        return result === null ? 'refused' : result
      } catch {
        return 'refused'
      }
    },

    async answer(nodeId, pendingId, answer) {
      const node = deps.lookupNode(nodeId)
      if (!node) return false
      // The ticket must be THIS node's: the mirror's approval tickets, or the renderer's held request
      // (plans / questions — the mirror strips a question's id). A mismatched pair touches no I/O and
      // emits no answered event onto the wrong node.
      if (!(await ticketBelongsTo(nodeId, node.agentId, pendingId))) return false
      const res = await answerHeld(pendingId, { answer }, deps.answerIo(nodeId, pendingId))
      if (res.ok && res.decision) deps.onAnswered?.(nodeId, pendingId, res.decision)
      return res.ok
    }
  }
}
