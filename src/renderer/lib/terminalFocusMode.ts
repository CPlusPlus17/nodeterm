/**
 * Who decides which terminal node holds the keyboard: the POINTER, or a CLICK.
 *
 * Issue #757 — "option to disable X Window focus-follows-pointer (Mac-style click to select what
 * UI element has the input focus)". `TerminalNode`'s hover guard has always tied the keyboard to
 * the pointer: dwelling `settings.panHoverDelay` over a terminal focuses its xterm, and
 * `mouseleave` blurs it again and drops the node's agent-status active flag and presence focus. On
 * a crowded canvas that is the X11 "focus follows mouse" model, and a user who reaches for another
 * card, a second display or the sidebar while an agent is mid-prompt loses the keyboard every time.
 *
 * `settings.terminalFocusFollowsPointer` (default ON — the long-standing behaviour) picks the model:
 *
 * - **ON — focus follows the pointer.** Unchanged: hover dwell takes the keyboard, leaving the
 *   node gives it back.
 * - **OFF — click to focus.** The pointer decides nothing. A click on the terminal (the guard's
 *   `onGuardUp` → `enterNow`, issue #87) or a "go to node" request takes the keyboard, and the
 *   terminal KEEPS it until focus really goes somewhere else: another node, the empty canvas
 *   (whose `onPaneClick` blurs the xterm textarea, issue #86), a text field. The node's active
 *   flag, presence focus and hover guard then follow that DOM focus instead of the pointer — see
 *   `focusLossOutcome`.
 *
 * Pure so the decisions are testable without a mounted xterm; `TerminalNode` owns the effects.
 */

/**
 * The setting as read from a hand-editable settings.json: only a literal `false` switches to click
 * to focus. Anything else (absent, a string, null) keeps the long-standing default, so a mangled
 * file can never silently change how every terminal takes the keyboard.
 */
export function resolveFocusFollowsPointer(value: unknown): boolean {
  return value !== false
}

/** Does a hover dwell over the body hand the keyboard to the terminal? */
export function hoverTakesKeyboard(focusFollowsPointer: boolean): boolean {
  return focusFollowsPointer
}

/**
 * Does the pointer leaving the body take the keyboard away (blur the xterm, re-arm the guard,
 * drop the active flag and presence focus)? Click-to-focus leaves all of that to `focusLossOutcome`.
 */
export function pointerLeaveReleases(focusFollowsPointer: boolean): boolean {
  return focusFollowsPointer
}

/** The slice of a node's root element this module reads. */
export interface NodeRootLike {
  contains(other: unknown): boolean
}

export interface FocusLossEvent {
  /** The node's root (`.term-node`), or null if it is gone. */
  nodeRoot: NodeRootLike | null
  /** The element that lost focus (`focusout`'s target). */
  lost: unknown
  /** Where focus went (`focusout`'s `relatedTarget`); null for "nowhere" AND for a window blur. */
  gained: unknown
  /** `document.activeElement` at the time of the event. */
  activeElement: unknown
  /** `document.hasFocus()` at the time of the event. */
  windowFocused: boolean
  /** A press landed on THIS node (its React Flow wrapper, header included) in the same task — the
   *  focus change is that press's default action, not a click somewhere else. */
  pressedInOwnNode: boolean
}

/** What a `focusout` inside the node means in click-to-focus mode. */
export type FocusLossOutcome =
  /** Nothing changed that the node must act on. */
  | 'keep'
  /** The user clicked this node's own chrome: hand the keyboard straight back to its terminal. */
  | 'reclaim'
  /** The keyboard really went somewhere else: release the node. */
  | 'release'

/**
 * Click to focus: what did a `focusout` inside this node mean?
 *
 * The one place the node's "I hold the keyboard" state is released in that mode, so it must tell
 * a real move from its look-alikes:
 *
 * - **Focus stayed inside the node** (the header's rename field, a header button, the ⌘M view's
 *   composer). The user is still working HERE → `keep`.
 * - **The window lost focus** (Cmd+Tab, a click on another app). Chromium fires `blur`/`focusout`
 *   on the focused element, but that element remains `document.activeElement` and is focused
 *   again on return — the terminal never stopped owning the keyboard → `keep`.
 * - **A press on this node's own chrome** (dragging it by the header, clicking its border). The
 *   browser moves focus to the React Flow wrapper (it is focusable) or to `<body>`, and either
 *   way the keystroke after it would land on the canvas — where a bare Backspace is
 *   `canvas.deleteSelection`. #757 asks that the terminal keep the keyboard until the user clicks a
 *   DIFFERENT card, so this hands it back → `reclaim`.
 *
 * Everything else — focus on another node's xterm or a text field, or on `<body>` because a click
 * landed on the empty canvas — is the user clicking elsewhere, which is exactly what #757 wants to
 * be the ONLY way to leave → `release`. A node that is gone answers `keep` rather than guessing.
 */
export function focusLossOutcome(e: FocusLossEvent): FocusLossOutcome {
  if (!e.nodeRoot) return 'keep'
  if (!e.windowFocused) return 'keep'
  if (e.activeElement === e.lost) return 'keep'
  if (e.gained && e.nodeRoot.contains(e.gained)) return 'keep'
  if (e.pressedInOwnNode) return 'reclaim'
  return 'release'
}
