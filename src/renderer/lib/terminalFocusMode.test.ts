import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/types'
import {
  focusLossOutcome,
  hoverTakesKeyboard,
  pointerLeaveReleases,
  resolveFocusFollowsPointer
} from './terminalFocusMode'

/**
 * Issue #757 — "option to disable X Window focus-follows-pointer (Mac-style click to select what
 * UI element has the input focus)". A terminal node's keyboard used to follow the POINTER: a hover
 * dwell took it, leaving the node took it away. `settings.terminalFocusFollowsPointer` keeps that
 * (the default) or switches to click-to-focus, where the pointer decides nothing and the clicked
 * terminal keeps the keyboard until the user clicks somewhere else.
 */
describe('terminal focus mode (#757)', () => {
  it('defaults to focus-follows-pointer, so nobody’s terminal changes behaviour on upgrade', () => {
    expect(DEFAULT_SETTINGS.terminalFocusFollowsPointer).toBe(true)
  })

  describe('resolveFocusFollowsPointer', () => {
    it('switches to click to focus only on a literal false', () => {
      expect(resolveFocusFollowsPointer(false)).toBe(false)
      expect(resolveFocusFollowsPointer(true)).toBe(true)
      // settings.json is hand-editable: a mangled value keeps the default, never flips the mode.
      expect(resolveFocusFollowsPointer(undefined)).toBe(true)
      expect(resolveFocusFollowsPointer('false')).toBe(true)
      expect(resolveFocusFollowsPointer(null)).toBe(true)
    })
  })

  describe('hoverTakesKeyboard', () => {
    it('lets a hover dwell take the keyboard only while focus follows the pointer', () => {
      expect(hoverTakesKeyboard(true)).toBe(true)
      expect(hoverTakesKeyboard(false)).toBe(false)
    })
  })

  describe('pointerLeaveReleases', () => {
    it('takes the keyboard away on mouseleave only while focus follows the pointer', () => {
      expect(pointerLeaveReleases(true)).toBe(true)
      // Click-to-focus: the pointer wandering to another card, the canvas or a second display
      // must leave the typed-into terminal exactly as it is.
      expect(pointerLeaveReleases(false)).toBe(false)
    })
  })

  describe('focusLossOutcome', () => {
    // Plain objects stand in for DOM nodes: all the helper asks of `nodeRoot` is `contains`.
    const lost = { id: 'xterm-textarea' }
    const header = { id: 'rename-input' }
    const elsewhere = { id: 'other-node-textarea' }
    const ownWrapper = { id: 'react-flow-node-wrapper' }
    const body = { id: 'body' }
    const nodeRoot = { contains: (n: unknown) => n === lost || n === header }
    const ev = (over: Partial<Parameters<typeof focusLossOutcome>[0]>) =>
      focusLossOutcome({
        nodeRoot,
        lost,
        gained: null,
        activeElement: body,
        windowFocused: true,
        pressedInOwnNode: false,
        ...over
      })

    it('releases when focus moved to something outside the node (another card, a field)', () => {
      expect(ev({ gained: elsewhere, activeElement: elsewhere })).toBe('release')
    })

    it('releases when a click sent focus nowhere (the empty canvas blurs the xterm, #86)', () => {
      expect(ev({ gained: null, activeElement: body })).toBe('release')
    })

    it('keeps it when focus only moved inside the same node (header field, ⌘M composer)', () => {
      expect(ev({ gained: header, activeElement: header })).toBe('keep')
      // …even when the press that moved it was on this node.
      expect(ev({ gained: header, activeElement: header, pressedInOwnNode: true })).toBe('keep')
    })

    it('reclaims the keyboard when the user pressed this node’s own chrome (header drag)', () => {
      // The wrapper is focusable in React Flow, so a header press moves focus to it — outside
      // `.term-node`, where the next Backspace would be the canvas's delete-selection.
      expect(ev({ gained: ownWrapper, activeElement: ownWrapper, pressedInOwnNode: true })).toBe('reclaim')
      // A non-focusable wrapper sends focus to <body> instead; same press, same answer.
      expect(ev({ gained: null, activeElement: body, pressedInOwnNode: true })).toBe('reclaim')
    })

    it('keeps it when the WINDOW lost focus (Cmd+Tab away): the terminal still owns the keyboard', () => {
      // Chromium fires blur/focusout on the focused element when the window deactivates, but the
      // element stays `document.activeElement` and gets focus back on return. Releasing here would
      // drop the node's active flag on every app switch.
      expect(ev({ activeElement: lost, windowFocused: false })).toBe('keep')
      expect(ev({ activeElement: lost, windowFocused: true })).toBe('keep')
      expect(ev({ activeElement: body, windowFocused: false })).toBe('keep')
    })

    it('answers keep without a node root (unmounted mid-event) rather than guessing', () => {
      expect(ev({ nodeRoot: null })).toBe('keep')
    })
  })

  // The decisions above are only worth something if the node and the settings page use them. A
  // source check, like `focusRestore.test.ts`: TerminalNode cannot be mounted without an xterm.
  describe('wiring', () => {
    const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

    it('TerminalNode reads the setting live and routes hover, leave and focus loss through it', () => {
      const src = read('src/renderer/nodes/TerminalNode.tsx')
      expect(src).toContain('useSettings((s) => s.settings.terminalFocusFollowsPointer)')
      expect(src).toContain('hoverTakesKeyboard(focusFollowsPointer)')
      expect(src).toContain('pointerLeaveReleases(focusFollowsPointer)')
      expect(src).toContain('focusLossOutcome(')
    })

    it('Settings → Behavior offers the toggle, findable by search', () => {
      const src = read('src/renderer/components/settings/sections/BehaviorSection.tsx')
      expect(src).toContain('update({ terminalFocusFollowsPointer: v })')
      for (const k of ['focus', 'hover', 'pointer', 'click', 'follows', 'x11']) {
        expect(src).toMatch(new RegExp(`focusFollowsPointer: \\{[^}]*'${k}'`))
      }
    })
  })
})
