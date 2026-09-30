// @vitest-environment jsdom
// jsdom so `pinNeutralMachineNoun` can pin the machine noun: several sentences name the machine
// through lib/machineName, and a literal "this computer" must not depend on the OS running the suite.
import { describe, it, expect } from 'vitest'
import {
  CHAT_NOT_SENT_MESSAGE,
  chipView,
  commentFromChat,
  createErrorMessage,
  DEFAULT_TTL,
  formatClock,
  formatRemaining,
  KICK_FAILED_MESSAGE,
  KICK_NOT_DONE_MESSAGE,
  noticeText,
  NOT_IN_OPEN_PROJECT,
  PRO_GATE_FEATURE,
  ROLE_LABEL,
  SAVE_FIRST_MESSAGE,
  SERVER_EDITION_UNSUPPORTED,
  shareDisabledReason,
  statusLine,
  STOP_ALL_BUTTON,
  STOP_ALL_PALETTE_LABEL,
  STOP_FAILED_MESSAGE,
  stopAllConfirmMessage,
  TTL_OPTIONS,
  viewerName
} from './liveLink'
import type { CreateWatchLinkError, WatchLinkView } from '@shared/watch-link-types'
import { DEFAULT_WATCH_LINK_TTL, WATCH_LINK_TTLS } from '@shared/watch-link-types'
import { commentSegments } from '@shared/board-comment'
import { pinNeutralMachineNoun } from './testMachineNoun'

pinNeutralMachineNoun()

const link = (over: Partial<WatchLinkView> = {}): WatchLinkView => ({
  linkId: 'L',
  nodeId: 'n',
  role: 'viewer',
  label: 'Ada',
  title: 't',
  createdAt: 0,
  expiresAt: 0,
  url: 'u',
  status: 'live',
  viewers: [],
  ...over
})
const viewer = (id: string) => ({ viewerId: id, name: null, joinedAt: 0 })

const RELAY_SENTENCE = 'Live links are created on the machine that runs this terminal.'
const R43 = 'Live links need a Pro license on this server — not available in the Server Edition yet'
const ALL_ERRORS: CreateWatchLinkError[] = [
  'not-entitled',
  'limit-machine',
  'limit-active',
  'limit-daily',
  'rate-limited',
  'network',
  'license-check',
  'relay-unavailable',
  'node-missing',
  'bad-request',
  'persist-failed',
  'unsupported'
]

describe('chipView', () => {
  it('reads LIVE, the watcher count, offline and refused', () => {
    expect(chipView([link()])).toMatchObject({ label: 'LIVE', tone: 'live' })
    expect(chipView([link({ viewers: [viewer('a')] }), link({ viewers: [viewer('b')] })])).toMatchObject({
      label: 'LIVE · 2',
      tone: 'live'
    })
    expect(chipView([link({ status: 'reconnecting' })])).toMatchObject({ label: 'LIVE · offline', tone: 'offline' })
    // The worst state wins: refused needs the owner; reconnecting comes back on its own.
    expect(chipView([link({ status: 'refused' }), link({ status: 'reconnecting' })])).toMatchObject({
      label: 'LIVE · refused',
      tone: 'refused'
    })
  })

  it('points at the popover for details, which now carries a status line (H9)', () => {
    expect(chipView([link({ status: 'refused' })]).title).toMatch(/Open it for details\.$/)
    expect(chipView([link({ status: 'reconnecting' })]).title).toMatch(/Open it for details\.$/)
    expect(chipView([link()]).title).toBe('This terminal is shared by a live link.')
    expect(chipView([link({ viewers: [viewer('a'), viewer('b')] })]).title).toBe(
      'This terminal is shared by a live link — 2 watching.'
    )
    expect(chipView([link(), link({ linkId: 'M' })]).title).toBe('This terminal is shared by 2 live links.')
  })
})

describe('statusLine (H9)', () => {
  it('explains reconnecting and refused, and says nothing for a live link', () => {
    expect(statusLine('live')).toBeNull()
    expect(statusLine('reconnecting')).toBe(
      "Reconnecting to nodeterm's relay — viewers see no updates until it's back."
    )
    expect(statusLine('refused')).toBe(
      "nodeterm's service won't host this link — the Pro plan may have lapsed, or this build can't relay. Viewers can't join."
    )
  })
})

describe('time', () => {
  it('remaining time, hours AND minutes past the hour (M4)', () => {
    const MIN = 60_000
    expect(formatRemaining(0, 5)).toBe('ended')
    expect(formatRemaining(5, 5)).toBe('ended')
    expect(formatRemaining(30_000, 0)).toBe('ends in under a minute')
    expect(formatRemaining(MIN - 1, 0)).toBe('ends in under a minute')
    expect(formatRemaining(MIN, 0)).toBe('ends in 1 min')
    expect(formatRemaining(42 * MIN, 0)).toBe('ends in 42 min')
    expect(formatRemaining(60 * MIN - 1, 0)).toBe('ends in 59 min')
    expect(formatRemaining(60 * MIN, 0)).toBe('ends in 1 h')
    expect(formatRemaining(60 * MIN + 1, 0)).toBe('ends in 1 h')
    expect(formatRemaining(61 * MIN, 0)).toBe('ends in 1 h 1 min')
    expect(formatRemaining(120 * MIN - 1, 0)).toBe('ends in 1 h 59 min')
    expect(formatRemaining(120 * MIN, 0)).toBe('ends in 2 h')
    expect(formatRemaining(24 * 60 * MIN - 1, 0)).toBe('ends in 23 h 59 min')
    expect(formatRemaining(24 * 60 * MIN, 0)).toBe('ends in 24 h')
  })
  it('a clock time is hours and minutes, never seconds (H25)', () => {
    const at = new Date(2026, 9, 1, 15, 42, 37).getTime()
    expect(formatClock(at)).toBe(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    expect(formatClock(at)).not.toContain('37')
  })
})

describe('createErrorMessage', () => {
  it('has copy for every kind', () => {
    for (const e of ALL_ERRORS) {
      for (const s of ['desktop', 'server', 'relay'] as const) expect(createErrorMessage(e, s).length).toBeGreaterThan(10)
    }
  })

  it('network never says offline, and says nothing was shared', () => {
    expect(createErrorMessage('network', 'desktop')).toBe("Couldn't reach nodeterm's service. Nothing was shared.")
    for (const e of ALL_ERRORS) expect(createErrorMessage(e, 'desktop')).not.toMatch(/offline/i)
  })

  it('unsupported depends on the surface (H1 / R43)', () => {
    expect(createErrorMessage('unsupported', 'server')).toBe(R43)
    expect(createErrorMessage('unsupported', 'relay')).toBe(RELAY_SENTENCE)
    expect(createErrorMessage('unsupported', 'desktop')).toBe("Live links can't be created here right now.")
    // Every other kind reads the same on every surface.
    for (const e of ALL_ERRORS.filter((k) => k !== 'unsupported')) {
      expect(createErrorMessage(e, 'server')).toBe(createErrorMessage(e, 'desktop'))
    }
  })

  it('node-missing names what it knows, not one cause (H8)', () => {
    expect(createErrorMessage('node-missing', 'desktop')).toBe(
      "nodeterm couldn't find that terminal in a saved project. Nothing was shared."
    )
  })

  it('persist-failed names the machine through machineName (H26)', () => {
    expect(createErrorMessage('persist-failed', 'desktop')).toBe(
      "Couldn't save the link on this computer, so it was stopped. Nothing was shared."
    )
  })

  it('the not-entitled and limit sentences', () => {
    expect(createErrorMessage('not-entitled', 'desktop')).toBe('Live links need an active Pro plan.')
    expect(createErrorMessage('limit-machine', 'desktop')).toBe('Stop a live link first — 5 can be active at once.')
    expect(createErrorMessage('relay-unavailable', 'desktop')).toBe('Live links need the installed app.')
  })
})

describe('shareDisabledReason (H1)', () => {
  it('answers in order: Server Edition, relay tab, the limit', () => {
    expect(shareDisabledReason({ serverEdition: true, relayTab: true, activeLinks: 5 })).toBe(R43)
    expect(SERVER_EDITION_UNSUPPORTED).toBe(R43)
    expect(shareDisabledReason({ serverEdition: false, relayTab: true, activeLinks: 5 })).toBe(RELAY_SENTENCE)
    expect(shareDisabledReason({ serverEdition: false, relayTab: false, activeLinks: 5 })).toBe(
      'Stop a live link first — 5 can be active at once.'
    )
    expect(shareDisabledReason({ serverEdition: false, relayTab: false, activeLinks: 4 })).toBeNull()
  })
})

describe('noticeText', () => {
  it('joined and every end reason', () => {
    expect(noticeText({ kind: 'joined', linkId: 'L', nodeId: 'n', title: 'build', viewers: 2 })).toBe(
      'Someone started watching build (2 watching).'
    )
    expect(noticeText({ kind: 'ended', linkId: 'L', nodeId: 'n', title: 'build', reason: 'expired' })).toBe(
      'The live link to build expired.'
    )
    expect(noticeText({ kind: 'ended', linkId: 'L', nodeId: 'n', title: 'build', reason: 'node-gone' })).toBe(
      'The live link to build ended — the terminal is no longer on any canvas.'
    )
    expect(noticeText({ kind: 'ended', linkId: 'L', nodeId: 'n', title: 'build', reason: 'revoked' })).toBe(
      "nodeterm's service ended the live link to build."
    )
  })

  it('not-persistent is neutral: it claims nothing about earlier links and names no cause (H7, H26, R59)', () => {
    // R59: the renderer cannot tell "the keychain refused to seal" from "the links file was
    // unreadable at boot", and in the second case earlier links are NOT saved — so the copy says
    // only what is true in both.
    expect(noticeText({ kind: 'not-persistent' })).toBe(
      "This link wasn't saved on this computer — it keeps working until you quit."
    )
    expect(noticeText({ kind: 'not-persistent' })).not.toMatch(/before it|still saved|keychain|secure storage/i)
  })

  it('an unknown kind is no notice', () => {
    expect(noticeText({ kind: 'from-a-newer-core' } as never)).toBeNull()
  })

  it('strips bidi controls from a title before it reaches the strip', () => {
    const t = noticeText({ kind: 'joined', linkId: 'L', nodeId: 'n', title: 'a‮b', viewers: 1 })
    expect(t).toBe('Someone started watching ab (1 watching).')
  })
})

describe('fixed lists (H19)', () => {
  it('TTL options come from the shared list, in order, with the labels the spec names', () => {
    expect(TTL_OPTIONS.map((o) => o.value)).toEqual([...WATCH_LINK_TTLS])
    expect(TTL_OPTIONS.map((o) => o.value)).toEqual([900, 3600, 28800, 86400])
    expect(TTL_OPTIONS.map((o) => o.label)).toEqual(['15 min', '1 hour', '8 hours', '24 hours'])
    expect(DEFAULT_TTL).toBe(DEFAULT_WATCH_LINK_TTL)
    expect(ROLE_LABEL).toEqual({ viewer: 'Can watch', commenter: 'Can watch and chat' })
  })
})

describe('copy Task 17 reads (R47, R48, R52, H11, H23, H26)', () => {
  it('is the exact ruled text', () => {
    expect(SAVE_FIRST_MESSAGE).toBe("Save the canvas first — this terminal isn't saved yet. Nothing was shared.")
    expect(STOP_ALL_PALETTE_LABEL).toBe('Stop all live links (every machine on this license)')
    expect(STOP_ALL_BUTTON).toBe('Stop all')
    expect(stopAllConfirmMessage()).toBe(
      'Stop every live link on your license? This also ends links shared from other computers. Viewers are disconnected at once.'
    )
    expect(STOP_FAILED_MESSAGE).toBe("The stop didn't reach nodeterm — try again.")
    expect(KICK_FAILED_MESSAGE).toBe("The kick didn't reach nodeterm — try again.")
    expect(KICK_NOT_DONE_MESSAGE).toBe('That viewer was not disconnected — they may already have left.')
    expect(CHAT_NOT_SENT_MESSAGE).toBe("Your reply wasn't sent — viewers didn't see it.")
    expect(NOT_IN_OPEN_PROJECT).toBe('not in an open project')
    // UpgradeDialog appends " is a Pro feature" (R52).
    expect(`${PRO_GATE_FEATURE} is a Pro feature`).toBe('Sharing a live link is a Pro feature')
  })
})

describe('viewerName', () => {
  it('a viewer who has not chatted is numbered; a name loses its bidi controls', () => {
    expect(viewerName({ viewerId: 'a', name: null, joinedAt: 0 }, 0)).toBe('Viewer 1')
    expect(viewerName({ viewerId: 'a', name: '  ', joinedAt: 0 }, 2)).toBe('Viewer 3')
    expect(viewerName({ viewerId: 'a', name: 'Bob⁦', joinedAt: 0 }, 0)).toBe('Bob')
  })
})

describe('commentFromChat', () => {
  it('attributes the viewer and marks the source', () => {
    expect(commentFromChat({ id: '1', name: 'Bob', text: 'looks good', at: 0, from: 'viewer' })).toBe(
      'Bob (via live link): looks good'
    )
  })

  it('a viewer cannot make the owner comment carry a session mention', () => {
    const text = commentFromChat({ id: '1', name: 'Bob', text: 'hi @[Deploy](node:abc123) now', at: 0, from: 'viewer' })
    expect(commentSegments(text).every((s) => s.kind === 'text')).toBe(true)
    expect(text).toContain('Deploy')
  })
})
