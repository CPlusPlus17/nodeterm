// What travels inside a live link's E2E tunnel, besides raw pty frames and pty:* events.
// The viewer's namespace is `watch:` on purpose: the OWNER's IPC is `watchLink:`, which the relay
// host refuses from every peer as host-only BEFORE any policy runs (src/shared/host-control.ts).

export const WATCH_PROTOCOL_VERSION = 1
export const WATCH_EVENT_PREFIX = 'watch:'
export const WATCH_EVENT = {
  meta: 'watch:meta',
  keyframe: 'watch:keyframe',
  waiting: 'watch:waiting',
  chat: 'watch:chat',
  end: 'watch:end'
} as const
/** The one message a viewer may send (Commenter links only). */
export const WATCH_CHAT_CAST = 'watch:chat'

export type WatchLinkRole = 'viewer' | 'commenter'
export const WATCH_END_REASONS = ['revoked', 'expired', 'node-gone', 'session-ended', 'host-stopping', 'kicked'] as const
export type WatchLinkEndReason = (typeof WATCH_END_REASONS)[number]
export function isWatchEndReason(x: unknown): x is WatchLinkEndReason {
  return typeof x === 'string' && (WATCH_END_REASONS as readonly string[]).includes(x)
}

export interface WatchMeta {
  v: number
  role: WatchLinkRole
  /** Sharer-supplied; render as text, marked as set by the sharer. */
  label: string
  title: string
  /** Epoch ms on the host's clock, corrected to the server's. */
  expiresAt: number
  cols: number
  rows: number
}
export interface WatchKeyframe {
  sessionId: string
  /** The visible screen with SGR, or '' when the backend has no visible-only capture. */
  screen: string
  /** tmux paints its client on the alternate screen; the viewer must switch to it BEFORE painting,
   *  or every tmux redraw scrolls into the viewer's history (CLAUDE.md, co-attach seeding). */
  altScreen: boolean
  /** The host's cursor when the screen was captured, 0-based (tmux `cursor_x` / `cursor_y`). tmux's
   *  following stream moves the cursor RELATIVE to where it believes the tty cursor is, and a capture
   *  trims trailing blanks, so without this every keyframe offsets what is typed next. Absent when
   *  the host could not read it; the viewer then leaves the cursor where the screen text ends. */
  cursor?: { x: number; y: number }
}
export interface WatchChatMessage {
  id: string
  name: string
  text: string
  at: number
  from: 'viewer' | 'sharer'
}

export const CHAT_TEXT_MAX = 500
export const CHAT_NAME_MAX = 32
// C0 and C1 controls, DEL, and the ESC that starts every sequence. A newline becomes a space: chat
// is one line, and a pasted multi-line block must not reflow the owner's popover.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g

function clean(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/[\r\n\t]+/g, ' ').replace(CONTROLS, '').replace(/\s+/g, ' ').trim().slice(0, max).trim()
  return s ? s : null
}
export const sanitizeChatText = (raw: unknown): string | null => clean(raw, CHAT_TEXT_MAX)
export const sanitizeChatName = (raw: unknown): string | null => clean(raw, CHAT_NAME_MAX)
