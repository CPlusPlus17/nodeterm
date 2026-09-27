// The phone's Chat screen (docs/mobile-chat-view.md): the wire shapes the relay verbs `chat.page`
// / `chat.status` / `chat.send` answer, and the one text rule `chat.send` applies. Shared because
// three places must agree on them: the relay handler (main), the renderer that answers the status
// and send queries, and — by hand, under golden fixtures — the iOS port.
import type { AgentState } from './agents/normalize'
import type { HeldPermission } from './agents/permission-answer'
import type { ChatTranscriptResult } from './types'

/** One page of a node's transcript as the phone receives it. `version` lets the phone refuse a
 *  newer shape honestly instead of misreading it. */
export type ChatPage = ChatTranscriptResult & { version: 1 }

/** What the phone needs to decide whether its composer and answer controls may act. */
export interface ChatStatus {
  /** The hook-reported state; `null` = no live hook state (unknown — the desktop's "Unknown"). */
  state: AgentState | null
  /** The request the node's hook is holding, if any (a plan, a question, a permission). */
  held: HeldPermission | null
  hibernated: boolean
  paused: boolean
  dropped: boolean
  sessionEnded: boolean
  /** The held request was posted by a hook script that understands structured answers
   *  (`isStructuredTicket`). False ⇒ the phone offers no answer controls, only "answer in the
   *  terminal". Always false with no `held`. */
  structuredAnswers: boolean
}

/** `refused` = never started (nothing was typed: no window, the gate refused, or it arrived too
 *  late to start). `unconfirmed` = the send WAS dispatched to the desktop but no result came back in
 *  time — the text may or may not have landed, so the phone must NOT resend it (that would type the
 *  prompt twice); it should re-read the page instead. */
export type ChatSendResult = 'sent' | 'refused' | 'pasted-not-submitted' | 'unconfirmed'

/** Longest text `chat.send` accepts, in UTF-16 code units (JS `.length`, Swift `utf16.count`),
 *  checked on the RAW text before stripping. */
export const CHAT_SEND_TEXT_MAX = 64000

/**
 * Text a phone asks to type into a pane: every C0/C1 control character is removed except `\n` and
 * `\t`. ESC is the one that matters most — a payload must never be able to become a terminal
 * control sequence (the paste-injection rule `node.rename` already applies) — and `\r` goes too,
 * since in a pane it is Enter. The paste path frames the text itself and adds the one Enter.
 */
export function sanitizeChatText(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

/** Main → renderer: answer a status or send query for a node (the renderer owns the agent-status
 *  store and the send gate). `agentId` is the host's own record of the node's agent. `startBy`
 *  (epoch ms, same machine): a send received after it is refused unsent — main has already told
 *  the phone "refused". */
export type HostChatQuery =
  | { requestId: string; kind: 'status'; nodeId: string; agentId?: string }
  | { requestId: string; kind: 'send'; nodeId: string; agentId?: string; text: string; startBy: number }
  | { requestId: string; kind: 'session'; nodeId: string }

/** Renderer → main. `status` omits `structuredAnswers`: main adds it (the ticket ledger is main's). */
export type HostChatReply =
  | { requestId: string; kind: 'status'; status: Omit<ChatStatus, 'structuredAnswers'> }
  | { requestId: string; kind: 'send'; result: ChatSendResult }
  /** The renderer's agent-status session id — the one the ⌘M view reads. Absent = it knows none. */
  | { requestId: string; kind: 'session'; sessionId?: string }
