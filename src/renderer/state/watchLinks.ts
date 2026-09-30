// Live links, renderer side: a TRANSIENT mirror of the core registry's list (src/core/watch-link/
// service.ts), fed by `watchLink:state` / `watchLink:chat`, plus the owner's view of Commenter chat.
//
// Machine-local by construction: the list is per MACHINE (not per project), nothing here is ever
// serialized into a project, a canvas op or the board — link state is not canvas content, and a
// guard test (lib/live-link.guard.test.ts) keeps it out of every shared type. A reload rebuilds it
// from `list()`; chat history comes back from `chatHistory()` (core keeps it in memory only).
import { create } from 'zustand'
import type { NodeTerminalApi } from '@shared/types'
import type { WatchChatMessage, WatchLinkNotice, WatchLinkView } from '@shared/watch-link-types'
import { chipView } from '../lib/liveLink'

/** The shared empty list — a selector for a node with no link returns this exact array. Never mutate. */
export const EMPTY_LINKS: WatchLinkView[] = []
/** What core keeps per link (spec §Commenter chat), and so what the owner's thread can show. */
const CHAT_KEEP = 200

interface WatchLinksState {
  links: WatchLinkView[]
  /** The same links grouped by node, in list order. A node with no link has no key. */
  byNode: Record<string, WatchLinkView[]>
  chats: Record<string, WatchChatMessage[]>
  /** Viewer messages the owner has not seen in that link's popover yet. */
  unread: Record<string, number>
  setLinks(links: WatchLinkView[]): void
  addChat(linkId: string, msg: WatchChatMessage): void
  setChat(linkId: string, msgs: WatchChatMessage[]): void
  markRead(linkId: string): void
}

function sameLink(a: WatchLinkView, b: WatchLinkView): boolean {
  if (
    a.linkId !== b.linkId ||
    a.nodeId !== b.nodeId ||
    a.role !== b.role ||
    a.label !== b.label ||
    a.title !== b.title ||
    a.createdAt !== b.createdAt ||
    a.expiresAt !== b.expiresAt ||
    a.url !== b.url ||
    a.status !== b.status ||
    a.viewers.length !== b.viewers.length
  ) {
    return false
  }
  return a.viewers.every((v, i) => {
    const w = b.viewers[i]
    return v.viewerId === w.viewerId && v.name === w.name && v.joinedAt === w.joinedAt
  })
}

function sameItems<T>(a: readonly T[] | undefined, b: readonly T[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x === b[i])
}

/** `rec` without the keys `keep` rejects — the same object when there is nothing to drop. */
function pruned<V>(rec: Record<string, V>, keep: (id: string) => boolean): Record<string, V> {
  if (Object.keys(rec).every(keep)) return rec
  return Object.fromEntries(Object.entries(rec).filter(([id]) => keep(id)))
}

export const useWatchLinks = create<WatchLinksState>((set) => ({
  links: [],
  byNode: {},
  chats: {},
  unread: {},

  // Every push is the FULL list, freshly deserialized. Objects whose content did not change keep
  // their identity (and so does each node's array), so a push about one link re-renders only the
  // surfaces of that link's node — every node header on the canvas subscribes to this store.
  setLinks: (incoming) =>
    set((s) => {
      const prev = new Map(s.links.map((l) => [l.linkId, l]))
      const next = incoming.map((l) => {
        const p = prev.get(l.linkId)
        return p && sameLink(p, l) ? p : l
      })
      const links = sameItems(s.links, next) ? s.links : next
      let byNode = s.byNode
      if (links !== s.links) {
        const grouped: Record<string, WatchLinkView[]> = {}
        for (const l of links) (grouped[l.nodeId] ??= []).push(l)
        byNode = {}
        for (const [nodeId, list] of Object.entries(grouped)) {
          byNode[nodeId] = sameItems(s.byNode[nodeId], list) ? s.byNode[nodeId] : list
        }
      }
      // A link that is gone takes its thread and its unread count with it (H21).
      const live = new Set(links.map((l) => l.linkId))
      const chats = pruned(s.chats, (id) => live.has(id))
      const unread = pruned(s.unread, (id) => live.has(id))
      if (links === s.links && chats === s.chats && unread === s.unread) return s
      return { links, byNode, chats, unread }
    }),

  addChat: (linkId, msg) =>
    set((s) => {
      const chat = s.chats[linkId] ?? []
      // The same message can reach us twice: pushed, and inside a history answer that raced it.
      if (chat.some((m) => m.id === msg.id)) return s
      return {
        chats: { ...s.chats, [linkId]: [...chat, msg].slice(-CHAT_KEEP) },
        unread: msg.from === 'viewer' ? { ...s.unread, [linkId]: (s.unread[linkId] ?? 0) + 1 } : s.unread
      }
    }),

  // A history answer and the chat pushes travel on different channels, so a message pushed after
  // core took the snapshot can land BEFORE the answer. Merge by id instead of replacing: a replace
  // would drop it. Ordered by core's timestamp; the sort is stable, so equal times keep their order.
  setChat: (linkId, msgs) =>
    set((s) => {
      const ids = new Set(msgs.map((m) => m.id))
      const extra = (s.chats[linkId] ?? []).filter((m) => !ids.has(m.id))
      const merged = [...msgs, ...extra].sort((a, b) => a.at - b.at).slice(-CHAT_KEEP)
      return { chats: { ...s.chats, [linkId]: merged } }
    }),

  markRead: (linkId) => set((s) => (s.unread[linkId] ? { unread: { ...s.unread, [linkId]: 0 } } : s))
}))

/**
 * A PRIMITIVE signature of everything one node's chip shows (tone, label, title, unread count) —
 * '' when the node has no link. The chip subscribes to this, never to a map: a string compares by
 * value, so another node's push leaves this node's header alone (the `noticeSigFor` discipline).
 */
export function liveChipSig(s: Pick<WatchLinksState, 'byNode' | 'unread'>, nodeId: string): string {
  const links = s.byNode[nodeId]
  if (!links || links.length === 0) return ''
  const v = chipView(links)
  const unread = links.reduce((n, l) => n + (s.unread[l.linkId] ?? 0), 0)
  return `${v.tone}\u0001${v.label}\u0001${v.title}\u0001${unread}`
}

/**
 * Follow core: subscribe to the pushes FIRST, then ask for the current list. The two travel on
 * different channels, so a `list()` answer can arrive after a newer state push — it is ignored once
 * any push has landed (H20), and after `stop()`. Notices go to `onNotice` (Canvas's info strip).
 */
export function startWatchLinkSync(
  api: Pick<NodeTerminalApi, 'watchLink'>,
  onNotice: (n: WatchLinkNotice) => void
): () => void {
  let pushed = false
  let stopped = false
  const offState = api.watchLink.onState((links) => {
    pushed = true
    useWatchLinks.getState().setLinks(links)
  })
  const offChat = api.watchLink.onChat((linkId, msg) => useWatchLinks.getState().addChat(linkId, msg))
  const offNotice = api.watchLink.onNotice(onNotice)
  void api.watchLink.list().then(
    (links) => {
      if (!pushed && !stopped) useWatchLinks.getState().setLinks(links)
    },
    () => {}
  )
  return () => {
    stopped = true
    offState()
    offChat()
    offNotice()
  }
}
