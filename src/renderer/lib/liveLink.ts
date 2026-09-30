// Live links, renderer side: every sentence the OWNER reads, and the pure decisions behind them —
// one place, so the chip, the popover, the create dialog, the menus and Settings cannot word the
// same fact two ways. No React, no store, no `window`: the surface facts (Server Edition, relay tab)
// are read by the CALLER and passed in (task-14-17-reconcile H1).
//
// Every string here that someone else wrote — a link label, a node title, a viewer's name or chat —
// is bidi-stripped again before it is composed into a sentence (core strips on receipt; this is the
// display side's own belt), and every caller renders the result as TEXT, never as HTML.
import type {
  CreateWatchLinkError,
  WatchChatMessage,
  WatchLinkNotice,
  WatchLinkRole,
  WatchLinkTtl,
  WatchLinkView,
  WatchLinkViewerView
} from '@shared/watch-link-types'
import {
  DEFAULT_WATCH_LINK_TTL,
  MAX_LINKS_PER_MACHINE,
  stripBidiControls,
  WATCH_LINK_TTLS
} from '@shared/watch-link-types'
import { otherMachines, thisMachine } from './machineName'

export const ROLE_LABEL: Record<WatchLinkRole, string> = { viewer: 'Can watch', commenter: 'Can watch and chat' }

/** A `Record` over the shared TTL list, so a TTL added there fails to compile here until it is named. */
const TTL_LABEL: Record<WatchLinkTtl, string> = {
  900: '15 min',
  3600: '1 hour',
  28800: '8 hours',
  86400: '24 hours'
}
/** The create dialog's expiry choices — derived from the list core validates against (H19). */
export const TTL_OPTIONS: { value: WatchLinkTtl; label: string }[] = WATCH_LINK_TTLS.map((value) => ({
  value,
  label: TTL_LABEL[value]
}))
export const DEFAULT_TTL: WatchLinkTtl = DEFAULT_WATCH_LINK_TTL

export const LIVE_LINK_WARNING =
  "Anyone with the link sees everything this terminal shows: what's on screen now, anything printed later (tokens, env dumps), and anything you scroll back to. They can't type or resize it."
export const KICK_NOTE =
  'Kick ends this connection; anyone with the link can rejoin. Stop sharing to end it for everyone.'

/** The R43 sentence — the Server Edition has no license layer yet. Never paired with an Upgrade button. */
export const SERVER_EDITION_UNSUPPORTED =
  'Live links need a Pro license on this server — not available in the Server Edition yet'
const RELAY_TAB_UNSUPPORTED = 'Live links are created on the machine that runs this terminal.'
const LIMIT_MACHINE = `Stop a live link first — ${MAX_LINKS_PER_MACHINE} can be active at once.`

/** `requireProOr`'s feature argument: UpgradeDialog renders "<feature> is a Pro feature" (R52). */
export const PRO_GATE_FEATURE = 'Sharing a live link'
/** R47: the create dialog's flush before create failed (or the canvas is under a conflict). */
export const SAVE_FIRST_MESSAGE = "Save the canvas first — this terminal isn't saved yet. Nothing was shared."
/** H23: `revoke`/`revokeAll` rejected (the Server Edition's socket was down). */
export const STOP_FAILED_MESSAGE = "The stop didn't reach nodeterm — try again."
/** Kick rejected (the same dropped socket). */
export const KICK_FAILED_MESSAGE = "The kick didn't reach nodeterm — try again."
/** Kick answered false: core found no connected viewer by that id (or its host could not end it). */
export const KICK_NOT_DONE_MESSAGE = 'That viewer was not disconnected — they may already have left.'
/** `sendChat` answered null or rejected: nothing reached the viewers; the draft is kept. */
export const CHAT_NOT_SENT_MESSAGE = "Your reply wasn't sent — viewers didn't see it."
/** R48: Stop all revokes every link of the LICENSE, other machines included — both entry points confirm. */
export const STOP_ALL_PALETTE_LABEL = 'Stop all live links (every machine on this license)'
export const STOP_ALL_BUTTON = 'Stop all'
export function stopAllConfirmMessage(): string {
  return `Stop every live link on your license? This also ends links shared from ${otherMachines()}. Viewers are disconnected at once.`
}
/** H11: a Settings row whose node no open project holds. */
export const NOT_IN_OPEN_PROJECT = 'not in an open project'

export type LiveLinkTone = 'live' | 'offline' | 'refused'

/**
 * What the chip says for one node's links. The WORST state wins: `refused` will not come back on
 * its own and needs the owner; `reconnecting` will. The titles send the owner to the popover, which
 * carries the status line that explains it (H9).
 */
export function chipView(links: readonly WatchLinkView[]): { label: string; tone: LiveLinkTone; title: string } {
  const viewers = links.reduce((n, l) => n + l.viewers.length, 0)
  if (links.some((l) => l.status === 'refused')) {
    return {
      label: 'LIVE · refused',
      tone: 'refused',
      title: "nodeterm's service won't host a live link on this terminal. Open it for details."
    }
  }
  if (links.some((l) => l.status === 'reconnecting')) {
    return {
      label: 'LIVE · offline',
      tone: 'offline',
      title: "A live link on this terminal is reconnecting to nodeterm's relay. Open it for details."
    }
  }
  const shared = links.length > 1 ? `This terminal is shared by ${links.length} live links` : 'This terminal is shared by a live link'
  return {
    label: viewers > 0 ? `LIVE · ${viewers}` : 'LIVE',
    tone: 'live',
    title: viewers > 0 ? `${shared} — ${viewers} watching.` : `${shared}.`
  }
}

/** One line per link in the popover explaining a state that is not `live` (H9); null when live. */
export function statusLine(status: WatchLinkView['status']): string | null {
  if (status === 'reconnecting') return "Reconnecting to nodeterm's relay — viewers see no updates until it's back."
  if (status === 'refused') {
    return "nodeterm's service won't host this link — the Pro plan may have lapsed, or this build can't relay. Viewers can't join."
  }
  return null
}

/** How long a link still runs. Hours AND minutes past the hour: a floored "1 h" for 1 h 59 min
 *  understated by up to an hour the one figure that says how long a broadcast goes on. */
export function formatRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  if (ms <= 0) return 'ended'
  if (ms < 60_000) return 'ends in under a minute'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `ends in ${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `ends in ${h} h` : `ends in ${h} h ${m} min`
}

/** A wall-clock time for "until 15:42" / "since 14:05" — hours and minutes, in the user's locale (H25). */
export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Which surface a create or a share affordance is on — read by the caller, never by this module. */
export type LiveLinkSurface = 'desktop' | 'server' | 'relay'

/** The create dialog's error line. `unsupported` depends on the surface (H1, R43). */
export function createErrorMessage(e: CreateWatchLinkError, surface: LiveLinkSurface): string {
  switch (e) {
    case 'not-entitled':
      return 'Live links need an active Pro plan.'
    case 'limit-machine':
      return LIMIT_MACHINE
    // The API's 429 by scope — per license ≤ 15 active, ≤ 50 created per 24 h, per IP 30/min
    // (spec §Routes, POST /v1/watch-links).
    case 'limit-active':
      return 'Your license already has 15 active live links. Stop one first.'
    case 'limit-daily':
      return 'Your license created 50 live links in the last day. Try again later.'
    case 'rate-limited':
      return "nodeterm's service is limiting requests from this network. Try again in a minute."
    // A timeout, a thrown fetch, a 5xx, a malformed reply or a dropped socket — never "offline".
    case 'network':
      return "Couldn't reach nodeterm's service. Nothing was shared."
    case 'license-check':
      return "nodeterm's service couldn't confirm your license right now. Nothing was shared; try again shortly."
    case 'relay-unavailable':
      return 'Live links need the installed app.'
    // Absent AND unknown both answer node-missing, so the copy names neither (H8).
    case 'node-missing':
      return "nodeterm couldn't find that terminal in a saved project. Nothing was shared."
    case 'bad-request':
      return 'That live link request was not valid. Nothing was shared.'
    case 'persist-failed':
      return `Couldn't save the link on ${thisMachine()}, so it was stopped. Nothing was shared.`
    case 'unsupported':
      if (surface === 'server') return SERVER_EDITION_UNSUPPORTED
      if (surface === 'relay') return RELAY_TAB_UNSUPPORTED
      return "Live links can't be created here right now."
  }
}

/**
 * Why "Share live link…" is disabled, or null. ONE availability rule for every opener, checked
 * BEFORE the Pro gate so a Server Edition or relay tab never sees an Upgrade dialog (H1).
 * `serverEdition` is `isBrowserRuntime()`, `relayTab` the node's project session — both read by the
 * caller.
 */
export function shareDisabledReason(o: { serverEdition: boolean; relayTab: boolean; activeLinks: number }): string | null {
  if (o.serverEdition) return SERVER_EDITION_UNSUPPORTED
  if (o.relayTab) return RELAY_TAB_UNSUPPORTED
  if (o.activeLinks >= MAX_LINKS_PER_MACHINE) return LIMIT_MACHINE
  return null
}

/** The info strip for a notice from core; null for a kind this build does not know. */
export function noticeText(n: WatchLinkNotice): string | null {
  switch (n.kind) {
    case 'joined':
      return `Someone started watching ${stripBidiControls(n.title)} (${n.viewers} watching).`
    // Two causes, no reason carried (H7, R55): the keychain refused to seal — only the link just
    // created is lost at a restart, links read at boot or sealed earlier stay saved — or the links
    // file could not be read. The renderer cannot tell them apart, so it says what the shared type
    // documents as the default: only the new link.
    case 'not-persistent':
      return `The live link you just created isn't saved on ${thisMachine()}: it works until you quit. Links created before it are still saved.`
    case 'ended': {
      const title = stripBidiControls(n.title)
      if (n.reason === 'expired') return `The live link to ${title} expired.`
      // Core ends a link for node-gone only on a DEFINITE absence (no project in the index holds it).
      if (n.reason === 'node-gone') return `The live link to ${title} ended — the terminal is no longer on any canvas.`
      // A server-side revoke: the service ended it. Which person or machine asked is not known here.
      return `nodeterm's service ended the live link to ${title}.`
    }
    default:
      return null
  }
}

/** A viewer as the popover lists them: the name they chatted under, else "Viewer N" (1-based). */
export function viewerName(v: WatchLinkViewerView, index: number): string {
  const name = v.name === null ? '' : stripBidiControls(v.name).trim()
  return name || `Viewer ${index + 1}`
}

/**
 * "Copy to card comments": the owner's explicit act of keeping a viewer's message (spec D2 —
 * nothing a viewer writes is stored automatically). The comment is the OWNER's, so a viewer's text
 * must not carry a board-comment mention token into it: `@[`…`](node:…)` would render as the owner
 * mentioning a session. Breaking the `@[` adjacency keeps every character and defuses the token.
 */
export function commentFromChat(m: WatchChatMessage): string {
  const text = `${stripBidiControls(m.name)} (via live link): ${stripBidiControls(m.text)}`
  return text.replace(/@\[/g, '@ [')
}
