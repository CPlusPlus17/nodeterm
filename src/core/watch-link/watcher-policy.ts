// The `watcher` relay role, as two RelayHostHooks pieces. It deliberately does NOT go through
// access-policy.ts's `decideAccess`: that function evaluates any non-editor role against the whole
// VIEW table (files, git, presence, board log), and a live link may reach none of it.
//  - Inbound: every request and cast is refused, except a Commenter link's chat cast.
//  - Outbound: only `watch:*` events and this viewer's own pty session; every broadcast is dropped
//    (a second layer: the watcher is also a QUIET client, absent from broadcast() and clientIds()).
import { IPC } from '../../shared/ipc'
import { decodePtyData, encodePtyData } from '../../shared/rpc'
import { WATCH_CHAT_CAST, WATCH_EVENT_PREFIX, type WatchLinkRole } from '../../shared/watch-link/protocol'
import type { AccessDecision } from '../relay/relay-host'
import type { UiSink } from '../ui-sink-registry'
import type { StreamFilter } from './stream-filter'
import type { TokenBucket } from './token-bucket'

export const WATCHER_REFUSAL = 'A live link can only watch this terminal.'
export const WATCHER_BUFFER_LIMIT = 512 * 1024
export const WATCHER_RESUME_BELOW = 256 * 1024

export function watcherAccess(kind: 'req' | 'cast', method: string, role: WatchLinkRole): AccessDecision {
  if (kind === 'cast' && method === WATCH_CHAT_CAST && role === 'commenter') return { allow: true }
  return { allow: false, message: WATCHER_REFUSAL }
}

export function watcherEventAllowed(channel: string, sessionId: string | null): boolean {
  if (channel.startsWith(WATCH_EVENT_PREFIX)) return true
  if (!sessionId) return false
  return (
    channel === IPC.ptySize(sessionId) ||
    channel === IPC.ptyExit(sessionId) ||
    channel === IPC.ptyClosed(sessionId) ||
    channel === IPC.ptyRecycled(sessionId) ||
    channel === IPC.ptyResync(sessionId)
  )
}

export type PtyLifecycle = 'exit' | 'closed' | 'recycled'

export interface WatcherSinkDeps {
  sessionId(): string | null
  /** False until the keyframe for the current session was sent, and while throttled. */
  streaming(): boolean
  /** Per viewer, created by the link host: `{ midStream: true }` for a join to a running session. */
  filter: StreamFilter
  /** Counts encoded BYTES (the frame as it goes on the wire), not characters. */
  bucket: TokenBucket
  onOverBudget(): void
  onLifecycle(kind: PtyLifecycle): void
}

function channelOf(json: string): string | null {
  try {
    const m = JSON.parse(json) as { t?: unknown; channel?: unknown }
    return m && m.t === 'ev' && typeof m.channel === 'string' ? m.channel : null
  } catch {
    return null
  }
}

export function wrapWatcherSink(base: UiSink, d: WatcherSinkDeps): UiSink {
  return {
    sendText: (json) => {
      const channel = channelOf(json)
      const sid = d.sessionId()
      if (channel === null || !watcherEventAllowed(channel, sid)) return
      if (sid && channel === IPC.ptyExit(sid)) d.onLifecycle('exit')
      else if (sid && channel === IPC.ptyClosed(sid)) d.onLifecycle('closed')
      else if (sid && channel === IPC.ptyRecycled(sid)) d.onLifecycle('recycled')
      base.sendText(json)
    },
    sendBinary: (buf) => {
      const frame = decodePtyData(buf)
      const sid = d.sessionId()
      if (!frame || !sid || frame.sessionId !== sid) return
      // Always parse, even when nothing is forwarded (see stream-filter.ts).
      const text = d.filter.push(frame.data)
      if (!d.streaming() || !text) return
      if ((base.bufferedAmount?.() ?? 0) > WATCHER_BUFFER_LIMIT) {
        d.onOverBudget()
        return
      }
      const out = encodePtyData(sid, text)
      // `out.length` is encoded BYTES. A pty frame is coalesced up to MAX_BUF_BYTES (256 K UTF-16
      // units, pty-manager.ts) plus one read chunk, so it can exceed the bucket's burst, and such a
      // take can never succeed: it goes over budget like any other refusal (the link host repaints
      // with a keyframe), and a refused take drains nothing.
      if (!d.bucket.take(out.length)) {
        d.onOverBudget()
        return
      }
      base.sendBinary(out)
    },
    bufferedAmount: () => base.bufferedAmount?.() ?? 0
  }
}
