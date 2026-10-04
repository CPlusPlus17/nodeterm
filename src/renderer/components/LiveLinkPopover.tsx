import { createContext, memo, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { NodeTerminalApi } from '@shared/types'
import type { WatchLinkControlView, WatchLinkRole, WatchLinkView } from '@shared/watch-link-types'
import { stripBidiControls } from '@shared/watch-link-types'
import { CHAT_TEXT_MAX, type WatchChatMessage } from '@shared/watch-link/protocol'
import { useDialogStack } from './dialog-stack'
import { newControlPassword, PasswordField, useCopied } from './LiveLinkPassword'
import { useMenuFlip } from '../ui/useMenuFlip'
import { Switch } from '../ui/Switch'
import {
  CHAT_NOT_SENT_MESSAGE,
  commentFromChat,
  CONTROL_CHANGE_FAILED_MESSAGE,
  CONTROL_LOCKED_TEXT,
  formatClock,
  formatRemaining,
  KICK_FAILED_MESSAGE,
  KICK_NOT_DONE_MESSAGE,
  KICK_NOTE,
  PASSWORD_CHANGE_FAILED_MESSAGE,
  PASSWORD_CHANGE_NOTE,
  PASSWORD_SAVE_TIMEOUT_MS,
  PASSWORD_UNCONFIRMED_MESSAGE,
  PASSWORD_SEPARATE_NOTE,
  PASSWORD_SHOWN_ONCE,
  passwordProblemText,
  ROLE_LABEL,
  ROLE_NAME,
  statusLine,
  STOP_FAILED_MESSAGE,
  viewerName,
  waitingViewers
} from '../lib/liveLink'
import { thisMachine } from '../lib/machineName'
import { EMPTY_LINKS, useWatchLinks, viewLinkThread } from '../state/watchLinks'
import { useBoardLog } from '../state/boardLog'
import { useProjects } from '../state/projects'
import { sessionForProject } from '../session/session'

/** Where the chip was when it was clicked (screen coordinates). */
export interface PopoverAnchor {
  top: number
  bottom: number
  left: number
}

const EMPTY_CHAT: WatchChatMessage[] = []

const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
/**
 * The popover is a body portal, but its React events still bubble through the REACT tree — into the
 * chip's surface: a card that opens on click and drags, a node header, a sessions row that ends the
 * session on a middle click, the canvas's own window listeners (React stops a synthetic event at the
 * portal's container, before the window). So every event is stopped at the portal's two roots, the
 * scrim and the panel — and only there: the chip itself lets keys and drags through (LiveLinkChip).
 */
const ISOLATE = {
  onClick: stop,
  onDoubleClick: stop,
  onMouseDown: stop,
  onMouseUp: stop,
  onPointerDown: stop,
  onPointerUp: stop,
  onContextMenu: stop,
  onKeyDown: stop,
  onKeyUp: stop,
  onDragStart: stop,
  onDragOver: stop,
  onDrop: stop,
  onWheel: stop,
  onFocus: stop,
  onBlur: stop,
  onChange: stop,
  onInput: stop,
  onSubmit: stop
} as const

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/**
 * The board a copied chat line goes to: the first project on THIS machine that holds the node. A
 * relay tab's project can carry the same node id (a git-shared canvas opened here and over the
 * relay), and its board belongs to the other machine, so it is skipped.
 */
function commentTarget(nodeId: string): { projectId: string; api: NodeTerminalApi } | null {
  for (const p of useProjects.getState().projects) {
    if (!p.nodes.some((n) => n.id === nodeId)) continue
    const session = sessionForProject(p.id)
    if (session.source === 'relay') continue
    return { projectId: p.id, api: session.api }
  }
  return null
}

/**
 * Something inside the popover the owner must still be shown — a new Control password whose save is
 * in flight: once core takes it, its plaintext exists nowhere else, so a popover closed under it
 * would lose a password that was changed. `hold()` keeps the popover from closing on an outside
 * click, Escape or Open chat until the returned release runs. The link going away still closes it
 * (nothing is owed for a link that no longer exists). Absent (the drawer): nothing to hold.
 */
const PopoverHold = createContext<(() => () => void) | null>(null)

/** The roles whose viewers can chat: a Control link is a Commenter link plus typing (spec §2.1). */
export function hasChat(role: WatchLinkRole): boolean {
  return role === 'commenter' || role === 'controller'
}

/**
 * Per-link controls for one node: copy, stop, the viewer list with Kick, and — for a Commenter or
 * Control link — the thread with a reply box and "Copy to card comments" (the owner's explicit act;
 * nothing a viewer writes is ever stored automatically, spec D2) plus Open chat. A Control link adds
 * its owner controls (`ControlSection`). Every string someone else wrote (label, title, viewer names
 * and chat) is rendered as React TEXT, bidi-stripped — never as HTML.
 *
 * It is a modal in the dialog stack, so Escape (and the board's keys) belong to it while it is
 * up — the card modal it can open over stands aside (`isTopDialog`).
 */
export function LiveLinkPopover({
  nodeId,
  anchor,
  onClose
}: {
  nodeId: string
  anchor: PopoverAnchor
  onClose: () => void
}): React.JSX.Element {
  const links = useWatchLinks((s) => s.byNode[nodeId] ?? EMPTY_LINKS)
  const isTop = useDialogStack()
  const now = useNow(30_000)
  // Below the chip; above it when there is no room below (the dropdown case of useMenuFlip).
  const flip = useMenuFlip(anchor.bottom + 6, anchor.left, anchor.top - 6)
  // Holds (see `PopoverHold`): a counter, not state — nothing renders from it.
  const holds = useRef(0)
  const hold = useCallback((): (() => void) => {
    holds.current++
    let released = false
    return () => {
      if (released) return
      released = true
      holds.current--
    }
  }, [])
  /** Close unless something is held; says whether it closed. Every owner gesture comes here. */
  const requestClose = useCallback((): boolean => {
    if (holds.current > 0) return false
    onClose()
    return true
  }, [onClose])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTop()) return
      // Swallowed even while held: the Escape was meant for the popover, not what is behind it.
      e.preventDefault()
      e.stopPropagation()
      requestClose()
    }
    // Capture phase: beat the canvas/global keydown listeners (and xterm) to the Escape.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isTop, requestClose])
  useEffect(() => {
    if (links.length === 0) onClose()
  }, [links.length, onClose])
  // Keyboard users land IN the popover (a body portal, so Tab from the chip would never reach it),
  // and go back to the chip when it closes.
  const popRef = flip.ref
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    popRef.current?.focus({ preventScroll: true })
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [popRef])
  return createPortal(
    <>
      <div
        {...ISOLATE}
        className="live-pop__scrim"
        onClick={(e) => {
          e.stopPropagation()
          requestClose()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          requestClose()
        }}
      />
      <div
        {...ISOLATE}
        ref={flip.ref}
        className="live-pop nodrag nowheel"
        style={{ top: flip.top, left: flip.left }}
        role="dialog"
        aria-label="Live links"
        tabIndex={-1}
      >
        <PopoverHold.Provider value={hold}>
          {links.map((l) => (
            <LinkBlock key={l.linkId} link={l} now={now} nodeId={nodeId} requestClose={requestClose} />
          ))}
        </PopoverHold.Provider>
      </div>
    </>,
    document.body
  )
}

const LinkBlock = memo(function LinkBlock({
  link,
  now,
  nodeId,
  requestClose
}: {
  link: WatchLinkView
  now: number
  nodeId: string
  /** Close the popover unless something in it is held; true when it closed. */
  requestClose: () => boolean
}): React.JSX.Element {
  const api = window.nodeTerminal.watchLink
  const [copied, copy] = useCopied()
  const [error, setError] = useState<string | null>(null)
  const status = statusLine(link)
  const waiting = waitingViewers([link]) > 0
  return (
    <section className="live-pop__link" data-link-id={link.linkId}>
      <header className="live-pop__head">
        <span>
          <span className="live-pop__role">{ROLE_NAME[link.role]}</span>{' '}
          <span className="live-pop__muted">{ROLE_LABEL[link.role]}</span>
        </span>
        <span className="live-pop__time">{formatRemaining(link.expiresAt, now)}</span>
      </header>
      <p className="live-pop__muted live-pop__label">
        Shown to viewers as {stripBidiControls(link.label)}
      </p>
      {status && (
        <p className={`live-pop__status live-pop__status--${link.status === 'live' && waiting ? 'waiting' : link.status}`} role="status">
          {status}
        </p>
      )}
      <div className="live-pop__actions">
        <button
          type="button"
          className="confirm__btn live-pop__btn"
          onClick={() => copy(link.url)}
        >
          {copied ? 'Copied!' : 'Copy link'}
        </button>
        {hasChat(link.role) && (
          <button
            type="button"
            className="confirm__btn live-pop__btn"
            onClick={() => {
              // The Live chat drawer (Task 8) listens; the popover gives way to it — unless a new
              // password is still on its way to being shown here.
              if (!requestClose()) return
              window.dispatchEvent(new CustomEvent('nodeterm:live-chat', { detail: { linkId: link.linkId } }))
            }}
          >
            Open chat
          </button>
        )}
        <button
          type="button"
          className="confirm__btn danger live-pop__btn"
          onClick={() => {
            setError(null)
            // Desktop: the local stop is immediate and the state push removes this block. The
            // Server Edition rejects when its socket is down — say so instead of looking stopped.
            api.revoke(link.linkId).catch(() => setError(STOP_FAILED_MESSAGE))
          }}
        >
          Stop sharing
        </button>
      </div>
      {error && (
        <p className="live-pop__error" role="alert">
          {error}
        </p>
      )}
      {link.control && <ControlSection linkId={link.linkId} control={link.control} />}
      <div className="live-pop__viewers">
        {link.viewers.length === 0 ? (
          <p className="live-pop__muted">Nobody is watching right now.</p>
        ) : (
          <>
            <ul>
              {link.viewers.map((v, i) => (
                <li key={v.viewerId}>
                  {v.typing && <span className="live-pop__typing" role="img" aria-label="Typing now" title="Typing now" />}
                  <span className="live-pop__who">{viewerName(v, i)}</span>
                  <span className="live-pop__muted">
                    since {formatClock(v.joinedAt)}
                    {v.controlling ? ' · can type' : ''}
                    {v.waiting ? ' · waiting for the terminal' : ''}
                  </span>
                  <button
                    type="button"
                    className="confirm__btn live-pop__btn live-pop__kick"
                    title={KICK_NOTE}
                    onClick={() => {
                      setError(null)
                      api.kick(link.linkId, v.viewerId).then(
                        (ok) => {
                          if (!ok) setError(KICK_NOT_DONE_MESSAGE)
                        },
                        () => setError(KICK_FAILED_MESSAGE)
                      )
                    }}
                  >
                    Kick
                  </button>
                </li>
              ))}
            </ul>
            <p className="live-pop__muted live-pop__note">{KICK_NOTE}</p>
          </>
        )}
      </div>
      {hasChat(link.role) && <ChatThread linkId={link.linkId} nodeId={nodeId} />}
    </section>
  )
})

/**
 * A Control link's owner controls (spec §2.6): the Typing switch, Change password (a new one is shown
 * ONCE, then only its hash exists — core keeps no plaintext), and Allow control again while the link
 * is locked by wrong passwords. Exported for the Live chat drawer.
 *
 * The switch shows core's state (the next push), never an optimistic one: a change core refused must
 * not look applied. A typed or new password lives only in this component's state and goes with it.
 */
export function ControlSection({ linkId, control }: { linkId: string; control: WatchLinkControlView }): React.JSX.Element {
  const api = window.nodeTerminal.watchLink
  const hold = useContext(PopoverHold)
  const invalidId = useId()
  const [busy, setBusy] = useState(false)
  /** A password save is in flight: the popover holds open, Save reads "Saving…". */
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  const [copied, copy] = useCopied()
  // Keyboard focus follows the flow: the new field on entering it, Copy password once a new one is
  // shown, "Change password…" again on Cancel or Done (whose button would otherwise take the focus
  // with it as it unmounts). Applied after the render that mounts the target.
  const [focusTo, setFocusTo] = useState<'field' | 'copy' | 'change' | null>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const changeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!focusTo) return
    const el = focusTo === 'field' ? fieldRef.current : focusTo === 'copy' ? copyRef.current : changeRef.current
    el?.focus({ preventScroll: true })
    setFocusTo(null)
  }, [focusTo])
  // A hold and a deadline this section took and has not given back — both go on unmount too (the
  // link went away: nothing is owed for it).
  const releaseRef = useRef<(() => void) | null>(null)
  const deadlineRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(
    () => () => {
      releaseRef.current?.()
      clearTimeout(deadlineRef.current)
    },
    []
  )
  /** Which save is current: a late answer to an older one is not shown. */
  const saveGen = useRef(0)
  const run = (call: () => Promise<boolean>, failed: string): void => {
    setBusy(true)
    setError(null)
    void Promise.resolve()
      .then(call)
      .then(
        (ok) => !ok && setError(failed),
        () => setError(failed)
      )
      .finally(() => setBusy(false))
  }
  /**
   * Save a new password, holding the popover open until the answer is in and, on success, shown —
   * its plaintext exists nowhere else. Bounded: with no answer after `PASSWORD_SAVE_TIMEOUT_MS` the
   * hold is released and the owner is told the outcome is unknown. An answer that lands later still
   * counts: a new password that did take is shown, one refused says so.
   */
  const save = (): void => {
    const next = draft
    const gen = ++saveGen.current
    const release = hold?.() ?? null
    releaseRef.current = release
    let open = true
    const settle = (): void => {
      if (!open) return
      open = false
      clearTimeout(deadlineRef.current)
      setSaving(false)
      setBusy(false)
      release?.()
      if (releaseRef.current === release) releaseRef.current = null
    }
    setSaving(true)
    setBusy(true)
    setError(null)
    deadlineRef.current = setTimeout(() => {
      if (!open) return
      settle()
      setError(PASSWORD_UNCONFIRMED_MESSAGE)
    }, PASSWORD_SAVE_TIMEOUT_MS)
    void Promise.resolve()
      .then(() => api.setPassword(linkId, next))
      .then(
        (ok) => {
          settle()
          if (gen !== saveGen.current) return
          if (ok) {
            setError(null)
            setShown(next)
            setDraft('')
            setEditing(false)
            setFocusTo('copy')
          } else setError(PASSWORD_CHANGE_FAILED_MESSAGE)
        },
        () => {
          settle()
          if (gen === saveGen.current) setError(PASSWORD_CHANGE_FAILED_MESSAGE)
        }
      )
  }
  const problem = passwordProblemText(draft)
  const showProblem = draft !== '' && problem !== null
  return (
    <div className="live-pop__control">
      {control.locked && (
        <div className="live-pop__locked">
          <p className="live-pop__status" role="status">
            {CONTROL_LOCKED_TEXT}
          </p>
          <button
            type="button"
            className="confirm__btn live-pop__btn"
            disabled={busy}
            onClick={() => run(() => api.allowControl(linkId), CONTROL_CHANGE_FAILED_MESSAGE)}
          >
            Allow control again
          </button>
        </div>
      )}
      <div className="live-pop__toggle">
        <span>
          <span className="live-pop__who">Typing</span>{' '}
          <span className="live-pop__muted">
            {control.enabled ? 'Anyone with the password can type.' : 'Off: viewers can watch and chat.'}
          </span>
        </span>
        {/* `pending`, not `disabled`: a switch the owner just toggled from the keyboard keeps the focus. */}
        <Switch
          checked={control.enabled}
          ariaLabel="Typing"
          pending={busy}
          onChange={(on) => run(() => api.setControl(linkId, on), CONTROL_CHANGE_FAILED_MESSAGE)}
        />
      </div>
      {shown !== null ? (
        <>
          <div className="live-pop__password">
            <PasswordField value={shown} readOnly label="New password" />
            <button type="button" ref={copyRef} className="confirm__btn live-pop__btn" onClick={() => copy(shown)}>
              {copied ? 'Copied!' : 'Copy password'}
            </button>
          </div>
          <p className="live-pop__muted live-pop__note">{PASSWORD_SHOWN_ONCE}</p>
          <p className="live-pop__muted live-pop__note">{PASSWORD_SEPARATE_NOTE}</p>
          <div className="live-pop__actions">
            <button
              type="button"
              className="confirm__btn live-pop__btn"
              onClick={() => {
                setShown(null)
                setFocusTo('change')
              }}
            >
              Done
            </button>
          </div>
        </>
      ) : editing ? (
        <>
          <div className="live-pop__password">
            <PasswordField
              inputRef={fieldRef}
              value={draft}
              disabled={busy}
              onChange={setDraft}
              label="New password"
              describedBy={showProblem ? invalidId : undefined}
            />
            <button type="button" className="confirm__btn live-pop__btn" disabled={busy} onClick={() => setDraft(newControlPassword())}>
              Generate
            </button>
          </div>
          {showProblem && (
            <p className="live-pop__invalid" id={invalidId}>
              {problem}
            </p>
          )}
          <p className="live-pop__muted live-pop__note">{PASSWORD_CHANGE_NOTE}</p>
          <div className="live-pop__actions">
            <button
              type="button"
              className="confirm__btn live-pop__btn"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setDraft('')
                setError(null)
                setFocusTo('change')
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="confirm__btn primary live-pop__btn"
              disabled={busy || problem !== null}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      ) : (
        <div className="live-pop__actions">
          <button
            type="button"
            ref={changeRef}
            className="confirm__btn live-pop__btn"
            onClick={() => {
              setEditing(true)
              setFocusTo('field')
            }}
          >
            Change password…
          </button>
        </div>
      )}
      {error && (
        <p className="live-pop__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** A Commenter or Control link's thread with the owner's reply box. Exported for the Live chat drawer. */
export function ChatThread({ linkId, nodeId }: { linkId: string; nodeId: string }): React.JSX.Element {
  const api = window.nodeTerminal.watchLink
  const chat = useWatchLinks((s) => s.chats[linkId] ?? EMPTY_CHAT)
  const onBoard = useProjects((s) => s.projects.some((p) => p.nodes.some((n) => n.id === nodeId)))
  const [draft, setDraft] = useState('')
  const [copiedIds, setCopiedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [copyError, setCopyError] = useState(false)
  const [sendError, setSendError] = useState(false)
  const threadRef = useRef<HTMLOListElement>(null)
  // While this thread is on screen, what lands in it is read as it arrives (N2).
  useEffect(() => viewLinkThread(linkId), [linkId])
  // Core keeps the thread in memory; ask for it once when the thread opens (a reload, or messages
  // that arrived before this renderer subscribed). The store merges it with what was pushed.
  useEffect(() => {
    void api.chatHistory(linkId).then(
      (m) => useWatchLinks.getState().setChat(linkId, m),
      () => {}
    )
  }, [api, linkId])
  // Open = read (H21): what arrived before the thread opened is read on open; what lands while it
  // is open never counts (`viewLinkThread` above).
  useEffect(() => {
    useWatchLinks.getState().markRead(linkId)
  }, [linkId])
  // Follow the newest message. Keyed on the LAST message's id, not the length — at the 200-message
  // cap the length stops changing.
  const lastId = chat.length > 0 ? chat[chat.length - 1].id : ''
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId])
  return (
    <div className="live-pop__chat">
      {chat.length === 0 ? (
        <p className="live-pop__muted">No messages yet. Viewers of this link can chat with you here.</p>
      ) : (
        <ol className="live-pop__thread" ref={threadRef}>
          {chat.map((m) => (
            <li key={m.id} className={`live-pop__msg${m.from === 'sharer' ? ' live-pop__mine' : ''}`}>
              <span className="live-pop__who">{stripBidiControls(m.name)}</span>{' '}
              <span className="live-pop__muted">({m.from === 'sharer' ? 'sharer' : 'link viewer'})</span>
              <span className="live-pop__text">{stripBidiControls(m.text)}</span>
              {onBoard && m.from === 'viewer' && (
                <button
                  type="button"
                  className="live-pop__copy"
                  disabled={copiedIds.has(m.id)}
                  onClick={() => {
                    const target = commentTarget(nodeId)
                    if (!target) {
                      setCopyError(true)
                      return
                    }
                    setCopyError(false)
                    useBoardLog.getState().append(target.api, target.projectId, {
                      kind: 'comment',
                      nodeId,
                      text: commentFromChat(m)
                    })
                    setCopiedIds((s) => new Set(s).add(m.id))
                  }}
                >
                  {copiedIds.has(m.id) ? 'Copied to card comments' : 'Copy to card comments'}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {copyError && (
        <p className="live-pop__error" role="alert">
          No project on {thisMachine()} holds this terminal, so there is no card to comment on.
        </p>
      )}
      {sendError && (
        <p className="live-pop__error" role="alert">
          {CHAT_NOT_SENT_MESSAGE}
        </p>
      )}
      <form
        className="live-pop__reply"
        onSubmit={(e) => {
          e.preventDefault()
          const text = draft.trim()
          if (!text) return
          setSendError(false)
          // The reply comes back through the chat push (core echoes the owner's own message), so
          // nothing is added here. The box is cleared only once core took it (unless the owner has
          // typed on since); a null answer (no host for the link, or nothing left after cleaning) or
          // a rejection keeps the draft and says so.
          api.sendChat(linkId, text).then(
            (sent) => {
              if (sent) setDraft((d) => (d.trim() === text ? '' : d))
              else setSendError(true)
            },
            () => setSendError(true)
          )
        }}
      >
        <input
          className="confirm__input live-pop__input"
          value={draft}
          maxLength={CHAT_TEXT_MAX}
          placeholder="Reply to viewers…"
          aria-label="Reply to viewers"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="confirm__btn live-pop__btn" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
