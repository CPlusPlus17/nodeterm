// Create a live link to one terminal. Opened only through `openLiveLink` (lib/liveLinkEntry): the
// availability rule and the Pro gate have already run by the time this mounts.
//
// The warning is always visible (not a checkbox): the owner must read what a link exposes every
// time, because "the screen" includes whatever is printed next.
//
// The URL carries the link's secret. It is shown HERE, once created, and in the chip's popover —
// never in a notice, a log line or the Settings list (which only copies it).
//
// A Control link's PASSWORD is plaintext only in this component's state: typed or generated in the
// form, shown once in the done step, and dropped on every close (`dismiss`) and with the component.
// It is never written to localStorage, settings, a log or a notice; core keeps only its hash.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import {
  capUnits,
  CONTROL_UNSUPPORTED_REASON,
  CONTROL_WARNING,
  createErrorMessage,
  DEFAULT_TTL,
  formatUntil,
  LIVE_LINK_WARNING,
  PASSWORD_SEPARATE_NOTE,
  PASSWORD_SHOWN_ONCE,
  passwordProblemText,
  ROLE_LABEL,
  ROLE_NAME,
  SAVE_FIRST_MESSAGE,
  TTL_OPTIONS,
  UNLIMITED_NOTE,
  watchableOnlyWhileOpen,
  watchWhileOpenNote,
  type LiveLinkSurface
} from '../lib/liveLink'
import { stopLiveLinks } from '../lib/liveLinkEntry'
import { loadIdentity } from '../state/presence'
import {
  LABEL_MAX,
  stripBidiControls,
  UNLIMITED_TTL,
  type CreateWatchLinkRequest,
  type WatchLinkRole,
  type WatchLinkTtl
} from '@shared/watch-link-types'
import { PASSWORD_MAX } from '@shared/watch-link/protocol'
import { generateControlPassword } from '@shared/watch-link-password'

/** Generate: 16 symbols from the platform CSPRNG (spec §2.2). */
export function newControlPassword(): string {
  return generateControlPassword((n) => crypto.getRandomValues(new Uint8Array(n)))
}

/** The password field shared by the form and the done step (and, read-only, the popover's change). */
export function PasswordField(p: {
  value: string
  readOnly?: boolean
  disabled?: boolean
  onChange?: (v: string) => void
  label?: string
}): React.JSX.Element {
  return (
    <input
      className="confirm__input"
      type="text"
      autoComplete="off"
      spellCheck={false}
      maxLength={PASSWORD_MAX}
      aria-label={p.label ?? 'Password'}
      value={p.value}
      readOnly={p.readOnly}
      disabled={p.disabled}
      onFocus={p.readOnly ? (e) => e.currentTarget.select() : undefined}
      onChange={p.onChange ? (e) => p.onChange?.(e.target.value) : undefined}
    />
  )
}

export type DialogState =
  | {
      phase: 'form'
      role: WatchLinkRole
      ttl: WatchLinkTtl
      label: string
      /** A Control link's password, as typed or generated. Kept while the owner switches roles (they
       *  may switch back); sent only for Control. */
      password: string
      /** A prepare or a create is in flight: the dialog cannot be dismissed (H24) — a link created
       *  behind a closed dialog would be broadcasting with a URL its owner never saw. */
      busy: boolean
      error: string | null
      /** The error is `not-entitled`: offer Upgrade (when the caller can — never on the Server
       *  Edition, which passes no `onUpgrade`). */
      offerUpgrade?: boolean
    }
  | {
      phase: 'done'
      url: string
      linkId: string
      /** null: an Unlimited link. */
      expiresAt: number | null
      /** A Control link's password, shown this once (core keeps only its hash). Absent otherwise. */
      password?: string
      copied?: boolean
      passwordCopied?: boolean
      stopping?: boolean
      error?: string | null
    }

export function LiveLinkDialogBody(p: {
  title: string
  state: DialogState
  onChange: (s: DialogState) => void
  onSubmit: () => void
  onClose: () => void
  onStop: (linkId: string) => void
  onCopy?: (url: string) => void
  onCopyPassword?: (password: string) => void
  onUpgrade?: () => void
  /** `watchLink.controlSupport` said this node's terminal cannot take typed input (a Zellij session):
   *  Control is shown disabled, with its reason. Absent / false: offered (unknown is offered too). */
  controlUnsupported?: boolean
  /** R63: on a machine with no watcher client for this node, the link works only while the terminal
   *  is open in this app — said before the owner creates it. Absent: nothing to say (or not known). */
  whileOpenNote?: string | null
  /** "now" for the end's day (tomorrow, a weekday): the caller's clock. */
  now?: number
}): React.JSX.Element {
  const s = p.state
  // The title is the node's own (git-shared, hand-editable): shown as TEXT, bidi controls stripped.
  const title = stripBidiControls(p.title)
  if (s.phase === 'done') {
    return (
      <div className="confirm live-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg live-dialog__title">Live link to {title}</p>
        <div className="live-dialog__url">
          <input
            className="confirm__input"
            readOnly
            aria-label="Live link"
            value={s.url}
            onFocus={(e) => e.currentTarget.select()}
          />
          {/* Keyboard focus lands here once the link exists (D2/M3): Enter copies it. */}
          <button className="confirm__btn primary" data-autofocus="" onClick={() => p.onCopy?.(s.url)}>
            {s.copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        {s.password !== undefined && (
          <>
            <div className="live-dialog__url live-dialog__password">
              <PasswordField value={s.password} readOnly />
              <button className="confirm__btn" onClick={() => p.onCopyPassword?.(s.password ?? '')}>
                {s.passwordCopied ? 'Copied!' : 'Copy password'}
              </button>
            </div>
            <p className="live-dialog__note live-dialog__note--tight">{PASSWORD_SHOWN_ONCE}</p>
            <p className="live-dialog__note live-dialog__note--tight">{PASSWORD_SEPARATE_NOTE}</p>
          </>
        )}
        <p className="live-dialog__note">
          {s.password !== undefined
            ? `Anyone with this link and the password can type until ${formatUntil(s.expiresAt, p.now ?? Date.now())}.`
            : `Anyone with this link can watch until ${formatUntil(s.expiresAt, p.now ?? Date.now())}.`}
        </p>
        {s.error && (
          <p className="live-dialog__error" role="alert">
            {s.error}
          </p>
        )}
        <div className="confirm__actions">
          <button className="confirm__btn danger" disabled={!!s.stopping} onClick={() => p.onStop(s.linkId)}>
            Stop sharing
          </button>
          <button className="confirm__btn" onClick={p.onClose}>
            Done
          </button>
        </div>
      </div>
    )
  }
  const control = s.role === 'controller'
  const problem = control ? passwordProblemText(s.password) : null
  return (
    <div className="confirm live-dialog" onClick={(e) => e.stopPropagation()}>
      <p className="confirm__msg live-dialog__title">Share a live link to {title}</p>
      <fieldset className="live-dialog__group" disabled={s.busy}>
        <legend>Viewers</legend>
        {(['viewer', 'commenter', 'controller'] as const).map((r) => {
          const off = r === 'controller' && !!p.controlUnsupported
          return (
            <label key={r} className={off ? 'live-dialog__off' : undefined} title={off ? CONTROL_UNSUPPORTED_REASON : undefined}>
              <input
                type="radio"
                name="live-role"
                checked={s.role === r}
                disabled={off}
                onChange={() => p.onChange({ ...s, role: r })}
              />{' '}
              {ROLE_NAME[r]} <span className="live-dialog__hint">· {ROLE_LABEL[r]}</span>
            </label>
          )
        })}
        {p.controlUnsupported && <p className="live-dialog__reason">{CONTROL_UNSUPPORTED_REASON}</p>}
      </fieldset>
      {control && (
        <div className="live-dialog__pw">
          Password
          <div className="live-dialog__url live-dialog__password">
            <PasswordField value={s.password} disabled={s.busy} onChange={(v) => p.onChange({ ...s, password: v })} />
            <button className="confirm__btn" disabled={s.busy} onClick={() => p.onChange({ ...s, password: newControlPassword() })}>
              Generate
            </button>
          </div>
          {s.password !== '' && problem && <p className="live-dialog__invalid">{problem}</p>}
        </div>
      )}
      <fieldset className="live-dialog__group" disabled={s.busy}>
        <legend>Ends after</legend>
        {TTL_OPTIONS.map((o) => (
          <label key={o.value}>
            <input type="radio" name="live-ttl" checked={s.ttl === o.value} onChange={() => p.onChange({ ...s, ttl: o.value })} />{' '}
            {o.label}
          </label>
        ))}
      </fieldset>
      {s.ttl === UNLIMITED_TTL && <p className="live-dialog__note live-dialog__note--tight">{UNLIMITED_NOTE}</p>}
      <label className="live-dialog__label">
        Shown to viewers as
        {/* Keyboard focus lands here when the dialog opens (D2/M3): keys stay inside the dialog
            instead of reaching the canvas behind it. */}
        <input
          className="confirm__input"
          data-autofocus=""
          maxLength={LABEL_MAX}
          value={s.label}
          disabled={s.busy}
          onChange={(e) => p.onChange({ ...s, label: e.target.value })}
        />
      </label>
      <p className="live-dialog__warning">{control ? CONTROL_WARNING : LIVE_LINK_WARNING}</p>
      {p.whileOpenNote && <p className="live-dialog__note">{p.whileOpenNote}</p>}
      {s.error && (
        <p className="live-dialog__error" role="alert">
          {s.error}
        </p>
      )}
      <div className="confirm__actions">
        {s.error && s.offerUpgrade && p.onUpgrade && (
          <button className="confirm__btn" onClick={p.onUpgrade}>
            Upgrade to Pro
          </button>
        )}
        <button className="confirm__btn" disabled={s.busy} onClick={p.onClose}>
          Cancel
        </button>
        <button
          className="confirm__btn primary"
          disabled={s.busy || !s.label.trim() || (control && (problem !== null || !!p.controlUnsupported))}
          onClick={p.onSubmit}
        >
          {s.busy ? 'Creating…' : 'Create live link'}
        </button>
      </div>
    </div>
  )
}

export function LiveLinkDialog({
  nodeId,
  title,
  surface,
  remoteNode = false,
  readPersistence,
  prepare,
  onUpgrade,
  onClose
}: {
  nodeId: string
  title: string
  /** Where it was opened — decides how `unsupported` reads (H1). */
  surface: LiveLinkSurface
  /** The node runs on an SSH project's host, whose own tmux gives a viewer a client of its own (R63). */
  remoteNode?: boolean
  /** R63: the LOCAL core's session-protection status (`localSession.api.pty.tmuxStatus` — the core that
   *  creates the link, never a relay peer's). Absent, rejected or unreadable: no note (unknown claims
   *  nothing). */
  readPersistence?: () => Promise<{ persistence?: { enabled: boolean; backend: string | null } | null } | null>
  /** R47: publish pending canvas edits before core looks the node up. A sentence = do NOT create. */
  prepare: () => Promise<string | null>
  /** Absent on the Server Edition (R43): no Upgrade button there. */
  onUpgrade?: () => void
  onClose: () => void
}): React.JSX.Element {
  const [state, setState] = useState<DialogState>(() => ({
    phase: 'form',
    role: 'viewer',
    ttl: DEFAULT_TTL,
    label: capUnits(loadIdentity()?.name ?? '', LABEL_MAX),
    password: '',
    busy: false,
    error: null
  }))
  // The latest state for the async steps (a closure would see the render that started them).
  const stateRef = useRef(state)
  stateRef.current = state
  const isTop = useDialogStack()
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  // R63: does THIS machine have a watcher client for this node? Read once from the local core (the
  // core that creates the link). Unknown — not read yet, or unreadable — says nothing.
  const [whileOpenOnly, setWhileOpenOnly] = useState(false)
  useEffect(() => {
    if (!readPersistence) return
    let live = true
    Promise.resolve()
      .then(() => readPersistence())
      .then(
        (st) => {
          if (live) setWhileOpenOnly(watchableOnlyWhileOpen({ persistence: st?.persistence, remoteNode }))
        },
        () => {}
      )
    return () => {
      live = false
    }
  }, [remoteNode, readPersistence])
  // Can this node's terminal take a Control link's input? Asked ONCE, on open. Only a definite
  // 'unsupported' (a Zellij session) disables Control; 'unknown', a rejection or an api without the
  // call keep it offered — the create decides, and says why if it refuses.
  const [controlUnsupported, setControlUnsupported] = useState(false)
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => window.nodeTerminal.watchLink.controlSupport(nodeId))
      .then(
        (answer) => {
          if (!live || answer !== 'unsupported') return
          setControlUnsupported(true)
          // Picked before the answer landed: move off it (and drop the password with it).
          setState((s) => (s.phase === 'form' && !s.busy && s.role === 'controller' ? { ...s, role: 'viewer', password: '' } : s))
        },
        () => {}
      )
    return () => {
      live = false
    }
  }, [nodeId])
  // D2/M3: focus lands in the dialog — the label on open, Copy once created — so keys stay inside
  // it (a bare-key canvas command could otherwise fire behind the overlay).
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
  }, [state.phase])

  const busy = state.phase === 'form' && state.busy
  // Every dismissal goes through here: a create in flight cannot be walked away from (H24). The
  // password goes with it, before the owner hands the dialog back — never left in state behind it.
  const dismiss = useCallback(() => {
    const s = stateRef.current
    if (s.phase === 'form' && s.busy) return
    const dropped: DialogState = s.phase === 'form' ? { ...s, password: '' } : { ...s, password: undefined }
    stateRef.current = dropped
    setState(dropped)
    onClose()
  }, [onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTop()) dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, dismiss])

  const submit = async (): Promise<void> => {
    const s = stateRef.current
    if (s.phase !== 'form' || s.busy) return
    const form = { ...s, busy: true, error: null, offerUpgrade: false }
    setState(form)
    const fail = (error: string, offerUpgrade = false): void =>
      setState({ ...form, busy: false, error, offerUpgrade })
    let refused: string | null
    try {
      refused = await prepare()
    } catch {
      // `liveLinkPrepare` answers instead of throwing; a throw is still "the save did not land".
      refused = SAVE_FIRST_MESSAGE
    }
    if (refused) return fail(refused)
    const control = form.role === 'controller'
    const req: CreateWatchLinkRequest = {
      nodeId,
      role: form.role,
      ttlSeconds: form.ttl,
      label: form.label.trim(),
      title,
      // Only a Control link carries a password: a viewer or commenter request never holds one.
      ...(control ? { password: form.password } : {})
    }
    try {
      const r = await window.nodeTerminal.watchLink.create(req)
      if (r.ok) {
        setState({
          phase: 'done',
          url: r.link.url,
          linkId: r.link.linkId,
          expiresAt: r.link.expiresAt,
          ...(control ? { password: form.password } : {})
        })
      } else fail(createErrorMessage(r.error, surface), r.error === 'not-entitled')
    } catch {
      // Desktop IPC and the ws-bridge both answer instead of rejecting; this is the belt.
      fail(createErrorMessage('network', surface))
    }
  }

  const stop = async (linkId: string): Promise<void> => {
    const s = stateRef.current
    if (s.phase !== 'done' || s.stopping) return
    setState({ ...s, stopping: true, error: null })
    const ok = await stopLiveLinks(
      () => window.nodeTerminal.watchLink.revoke(linkId),
      (error) => setState({ ...s, stopping: false, error })
    )
    if (ok) onClose()
  }

  const copy = (url: string): void => {
    window.nodeTerminal.clipboard.writeText(url)
    setState((s) => (s.phase === 'done' ? { ...s, copied: true } : s))
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setState((s) => (s.phase === 'done' ? { ...s, copied: false } : s)), 1500)
  }
  const passwordCopiedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(passwordCopiedTimer.current), [])
  const copyPassword = (password: string): void => {
    window.nodeTerminal.clipboard.writeText(password)
    setState((s) => (s.phase === 'done' ? { ...s, passwordCopied: true } : s))
    clearTimeout(passwordCopiedTimer.current)
    passwordCopiedTimer.current = setTimeout(
      () => setState((s) => (s.phase === 'done' ? { ...s, passwordCopied: false } : s)),
      1500
    )
  }

  return createPortal(
    <div className="confirm-overlay" ref={panelRef} onClick={dismiss}>
      <LiveLinkDialogBody
        title={title}
        whileOpenNote={whileOpenOnly ? watchWhileOpenNote() : null}
        state={state}
        onChange={(next) => {
          if (!busy) setState(next)
        }}
        onSubmit={() => void submit()}
        onClose={dismiss}
        onStop={(id) => void stop(id)}
        onCopy={copy}
        onCopyPassword={copyPassword}
        onUpgrade={onUpgrade}
        controlUnsupported={controlUnsupported}
      />
    </div>,
    document.body
  )
}
