// Standing (always-on) phone host — the desktop side of the iOS relay-client "reach my Mac from
// anywhere" flow.
//
// When Settings → phoneAccessEnabled is on, this keeps a HOST relay
// connection registered under the host's stable id (base64url(sha256(hostPublicKey)).slice(0,22)),
// so a previously-paired phone can join over the relay at any time and attach to the host's tmux
// sessions after approval. Unlike the interactive host (a single-use offer you hand out), the
// standing host:
//   - mints its token from `POST /v1/relay/host-token` (role:'host', hostId as the broker room);
//   - AUTO-REFRESHES: relay tokens are short-lived (~120s TTL) and single-use, so we re-mint + a
//     reconnect before expiry, and reconnect with bounded backoff on socket close;
//   - uses PIN-ONCE approval: the first connect from a given phone (its box public key) prompts
//     the host human via the shared SAS dialog; on approval the pubkey is pinned, so later
//     connects auto-approve silently. A paired phone needs no dialog: its key is pinned at the scan
//     when the pairing minted a relay leg (audit A07), and otherwise on its first handshake here while
//     its pairing, which recorded the key, is still listed (`pinPairedPhone`, A07-late);
//   - is cut on REVOCATION: forgetting a phone unpins its key and then closes the sessions it has
//     open (`killStandingHostSessionsByPeerKey`, called by peer-revoker.ts). For the rest of the app
//     run the forgotten phone's reconnects are then refused the way a Deny refuses them, with no
//     dialog (`REVOKED_PHONE_DENY_MS`), unless pairing it again pinned or recorded its key.
//
// The heavy lifting (relay wiring, RPC/frame handlers, fs jail, canvas mirror, approval gate) is
// shared with the interactive host via `connectHostSession`. Pin/lookup logic is the pure,
// unit-tested `approved-devices-core`.

import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { CanvasMutation, Settings } from '../../shared/types'
import { PtyManager } from '../../core/pty-manager'
import { getStoredEntitlement } from '../../core/license'
import { getDeviceId } from '../../core/device-id'
import { createPhonePresence, type PhonePresence } from './phone-presence'
import { publicKeyToB64, type KeyPair } from './e2ee'
import {
  API_BASE,
  RELAY_URL,
  connectHostSession,
  loadOrCreateKeyPair,
  relayAllowed,
  type HostBridgeDeps,
  type HostSession
} from './host-service'
import { currentCanvas, initHostCanvasHub, subscribeCanvas } from './host-canvas-hub'
import { hostIdFromPublicKeyB64 } from './relay-id'
import { removeRelayAdvertisement, writeRelayAdvertisement } from './relay-advertise'
import { isPinned, pinDevice } from './approved-devices-core'
import { loadApprovedDevices, updateApprovedDevices } from './approved-devices'
import { createPhoneApprovals } from '../../core/phone-approval'

// Re-mint the token this long before its expiry (TTL is ~120s). Floored so a bogus/short exp can't
// spin us.
const REFRESH_LEAD_MS = 30_000
const MIN_REFRESH_MS = 15_000
const DEFAULT_TTL_MS = 120_000
// Bounded backoff for reconnect after a socket close / mint failure.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000]
/**
 * How long a phone revoked during this run is left unapproved before its session is closed (see
 * `revokedThisRun`). Until then every request it makes is answered "Awaiting host approval.", and
 * the close after that is what a human's Deny looks like to a phone: the Android client reads a
 * close after it was told it awaits approval as a refusal and stops dialing on its own
 * (RelayConnector → RelayApprovalGate). Closed at once, the phone may not have heard that yet and
 * would read an ordinary failure, which it retries every few seconds. Long enough for its first
 * request over a slow relay, short enough that the approval code it shows meanwhile is a flash.
 */
export const REVOKED_PHONE_DENY_MS = 3_000

interface HostTokenResponse {
  pairingToken: string
  hostId: string
  exp: number
}

/**
 * Mint a standing host token from the API. Pro proves entitlement; the free tier sends
 * its deviceId instead (backend admits it against the server-side free-tier policy —
 * until that ships, the mint fails and free hosting simply stays down, i.e. today's
 * behavior). Returns null on any failure.
 */
async function mintHostToken(
  entitlement: string | null,
  hostPublicKeyB64: string
): Promise<HostTokenResponse | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(`${API_BASE}/v1/relay/host-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        entitlement ? { entitlement, hostPublicKeyB64 } : { deviceId: getDeviceId(), hostPublicKeyB64 }
      ),
      signal: ctrl.signal
    })
    if (!res.ok) return null
    const json = (await res.json().catch(() => ({}))) as Partial<HostTokenResponse>
    if (!json.pairingToken) return null
    return { pairingToken: json.pairingToken, hostId: json.hostId ?? '', exp: json.exp ?? 0 }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The stored host identity is encrypted and the keyring is locked/unavailable right now (see
 * host-identity.ts). Matched by `code`, not `instanceof`: the error crosses a module re-export and
 * the code is the stable contract.
 */
function isHostKeyLocked(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'E_HOST_KEY_LOCKED'
}

/**
 * A locked keyring is a LOUD, recoverable failure: the key on disk is intact, hosting simply
 * cannot start until the OS can decrypt it. The standing host runs with no UI of its own, so
 * without this the user would just find phone access mysteriously dead.
 */
function reportKeyLocked(err: Error): void {
  try {
    dialog.showErrorBox(
      'Remote access could not start',
      `${err.message}\n\nPhone access is off until then. Turn it back on in Settings → Phone once your keyring is unlocked.`
    )
  } catch {
    // No dialog available (headless / very early boot): the console line is the fallback.
  }
  console.error('[standing-host] host identity is locked:', err.message)
}

export interface StandingHost {
  /** Explicit toggle (from the Settings switch). Reconciles the connection immediately. */
  setEnabled(enabled: boolean): void
  /** Read the desired state from settings (launch / external change) and reconcile. */
  syncFromSettings(): void
  /** Tear everything down (e.g. app quit). */
  stop(): void
}

// The revoke hook of every RUNNING standing host (in production there is one). Module-level, like
// relay-host.ts's `live` set, so the peer revoker (peer-revoker.ts) reaches it without depending on
// the order index.ts constructs the two in.
const runningHosts = new Set<(peerKeyB64: string) => number>()

// The phone keys revoked during this app run (review of A07-revoke). Cutting a phone's session makes
// it redial (the Android client does so about 1.5 s after a drop while its screen is open), and with
// its key unpinned and its pairing gone, that handshake used to raise the SAS dialog for the phone
// the user had just removed, where approving it would pin the key again. Such a handshake is now
// refused without a dialog (`REVOKED_PHONE_DENY_MS`). Module-level, so a revoke while remote access
// is off counts too. Checked only after the pin and the paired-phone check, so pairing the phone
// again (which pins or records its key) lets it in. In memory on purpose: after a restart the phone
// gets the dialog again, as any unpinned phone does, and a desktop that cannot write the unpin keeps
// the device listed instead (pairing-service.ts `revokeDevice`).
const revokedThisRun = new Set<string>()

/**
 * Close every standing-host relay session whose phone is `peerKeyB64`, and withdraw any approval
 * dialog still pending for it. The kill half of revoking a phone: unpinning its key only refuses
 * the NEXT handshake, while a session already open keeps serving terminals, files and the canvas
 * (see revocation.ts). Sessions of every other key are untouched. Returns how many were closed.
 * The key is remembered for the rest of the run (`revokedThisRun`), whether or not a host runs now.
 */
export function killStandingHostSessionsByPeerKey(peerKeyB64: string): number {
  if (peerKeyB64) revokedThisRun.add(peerKeyB64)
  let closed = 0
  for (const revokePeer of [...runningHosts]) closed += revokePeer(peerKeyB64)
  return closed
}

/** Test seam: forget every key revoked so far (the set otherwise lives as long as the process). */
export function resetRevokedPhonesForTests(): void {
  revokedThisRun.clear()
}

export interface StandingHostOptions {
  /**
   * An unpinned phone completed the handshake: pin its key and answer true when a listed pairing
   * recorded it (pairing-service.ts `approvePairedRelayKey`, A07-late), so the handshake is approved
   * without the SAS dialog. False or a rejection ⇒ the dialog, as before. Absent ⇒ always the dialog.
   */
  pinPairedPhone?(boxPublicKeyB64: string): Promise<boolean>
}

/**
 * Wire the standing phone host. Idempotent to construct once; `setEnabled` / `syncFromSettings`
 * reconcile the live connection against (enabled && relay-allowed).
 */
export function initStandingHost(
  win: BrowserWindow,
  ptyManager: PtyManager,
  getSettings: () => Settings,
  listProjects: () => Promise<string> = async () => '',
  bridge: HostBridgeDeps = {},
  options: StandingHostOptions = {}
): StandingHost {
  initHostCanvasHub()

  // Warm-standby POOL: keep this many un-bridged listener sockets registered at the relay, so a
  // client (browse OR session) always finds a host waiting and multiple clients can connect
  // concurrently — no churn gap. When a client bridges to a listener, that listener becomes
  // "bridged" and we open a replacement to keep the pool full.
  const TARGET_PENDING = 1

  interface Pooled {
    session: HostSession
    /** True once a client completed the handshake on this listener (it now serves that client). */
    bridged: boolean
    /** This session's presence slot: joined when a phone bridges, left on EVERY end path. */
    presence: PhonePresence
    /** Per-session pending approval (unknown device awaiting the human's SAS decision). */
    approvalPub: string | null
    approvalId: string | null
    refreshTimer: ReturnType<typeof setTimeout> | null
    /** A phone revoked during this run: the close that refuses it (see `REVOKED_PHONE_DENY_MS`). */
    denyTimer: ReturnType<typeof setTimeout> | null
  }

  let enabled = false
  let running = false
  let opening = false // guards against overlapping connectOne() calls
  const pool = new Set<Pooled>()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  function send(channel: string, ...args: unknown[]): void {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  function pendingCount(): number {
    let n = 0
    for (const p of pool) if (!p.bridged) n++
    return n
  }

  // Presence is dropped from BOTH end paths, because they are genuinely different: `onClose` fires
  // when the relay socket drops on its own (client gone, relay dropped us), while an INTENTIONAL
  // `session.close()` (reject / idle-token refresh / stop()) is final in relay-socket and
  // deliberately does NOT fire onClose. `PhonePresence.leave()` (shared with the interactive host)
  // is exactly-once, so a peer never leaves twice (its color is never freed for someone else).

  const approvals = createPhoneApprovals({
    persist: (pub) => updateApprovedDevices((store) => pinDevice(store, pub)),
    cleared: (id) => send(IPC.remoteHostPeerPendingCleared, { id })
  })

  function clearDenyTimer(p: Pooled): void {
    if (p.denyTimer) {
      clearTimeout(p.denyTimer)
      p.denyTimer = null
    }
  }

  function removeFromPool(p: Pooled): void {
    if (p.approvalId) approvals.clear(p.approvalId)
    p.presence.leave()
    if (p.refreshTimer) {
      clearTimeout(p.refreshTimer)
      p.refreshTimer = null
    }
    clearDenyTimer(p)
    pool.delete(p)
    p.session.close()
  }

  // A paired phone was revoked on this desktop (audit A07-revoke). Every pooled session with its
  // key ends through removeFromPool, the path the human's "Deny" takes: presence leaves, the pending
  // dialog clears, the served PTYs are killed and the socket closes. A session that bridged before
  // the unpin landed is still waiting on its disk read or serving the phone, and either way it must
  // go. A consent record that outlived its browse socket (#819) is withdrawn too.
  function revokePeer(peerKeyB64: string): number {
    if (!peerKeyB64) return 0
    approvals.forget(peerKeyB64)
    let closed = 0
    let failure: unknown = null
    for (const p of [...pool]) {
      if (p.session.peerPublicKeyB64() !== peerKeyB64 && p.approvalPub !== peerKeyB64) continue
      closed++
      try {
        removeFromPool(p) // leaves the pool before the close, so a throwing close strands nothing
      } catch (err) {
        failure ??= err // keep cutting the phone's other sessions; report the failure after
      }
    }
    if (closed) ensurePool()
    if (failure) throw failure
    return closed
  }

  /** Keep the pool topped up with TARGET_PENDING un-bridged listeners. */
  function ensurePool(): void {
    if (running && pendingCount() < TARGET_PENDING) void connectOne()
  }

  function scheduleReconnect(): void {
    if (!running || reconnectTimer) return
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      ensurePool()
    }, delay)
    reconnectTimer.unref?.()
  }

  function scheduleRefreshFor(p: Pooled, exp: number): void {
    if (p.refreshTimer) clearTimeout(p.refreshTimer)
    const untilExpMs = exp > 0 ? exp * 1000 - Date.now() : DEFAULT_TTL_MS
    const delay = Math.max(MIN_REFRESH_MS, untilExpMs - REFRESH_LEAD_MS)
    p.refreshTimer = setTimeout(() => {
      p.refreshTimer = null
      if (!running || !pool.has(p)) return
      // A listener serving a client (bridged) is left alone — never cut an active session for a
      // token refresh; the relay drops it at TTL and onClose replaces it. Only an IDLE listener is
      // re-minted with a fresh token by dropping it and topping the pool back up.
      if (p.bridged) {
        scheduleRefreshFor(p, 0)
        return
      }
      removeFromPool(p)
      ensurePool()
    }, delay)
    p.refreshTimer.unref?.()
  }

  // A phone completed the E2EE handshake on `pooled`'s listener. Mark it bridged (→ open a
  // replacement listener), then approve: pinned device → silent; unknown → prompt the human.
  // Settles once that is decided (approved, handed to the human, refused, or torn down), which is
  // when connectHostSession answers the requests the phone sent meanwhile.
  async function onPeerReady(pooled: Pooled): Promise<void> {
    if (!pooled.bridged) {
      pooled.bridged = true
      // Team presence: a bridged relay client is a peer. It has no mouse, so it stays cursorless
      // and appears in the facepile only — see docs/team-presence.md ("Peers may have no cursor").
      pooled.presence.join()
      ensurePool() // this listener now serves a client → restore a warm one
    }
    const s = pooled.session
    const pub = s.peerPublicKeyB64()
    let store
    try {
      store = await loadApprovedDevices()
    } catch {
      store = { pubkeys: [] as string[] }
    }
    if (!pool.has(pooled)) return // torn down while the disk read was in flight
    if (pub && isPinned(store, pub)) {
      s.approve() // pinned device → auto-approve silently
      return
    }
    if (!pub || !s.sas()) return // never offer consent without a verified handshake identity
    // A paired phone whose key its pairing recorded but did not pin (remote access was off at the
    // scan and the phone adopted the relay later over SSH, or the pin at the scan failed): the scan
    // was the approval, so pin it now instead of asking a desk that is usually empty (A07-late).
    // The check runs inside the pin store's queue, so a revoke racing it cannot be undone by it.
    if (options.pinPairedPhone) {
      const pinned = await options.pinPairedPhone(pub).catch((err) => {
        console.warn('[standing-host] could not check the paired phone keys:', err)
        return false
      })
      if (!pool.has(pooled)) return // torn down (revoked, stopped) while that was in flight
      if (pinned) {
        s.approve()
        return
      }
    }
    // The user forgot this phone during this run, and this is it redialing (its session was cut by
    // the revoke). No dialog for it: leave it unapproved, so it hears "Awaiting host approval.", and
    // then close it as a Deny would, which the phone reads as a refusal (review of A07-revoke).
    if (revokedThisRun.has(pub)) {
      console.info('[standing-host] refused a phone revoked during this run')
      clearDenyTimer(pooled)
      pooled.denyTimer = setTimeout(() => {
        pooled.denyTimer = null
        if (!pool.has(pooled)) return
        removeFromPool(pooled)
        ensurePool()
      }, REVOKED_PHONE_DENY_MS)
      pooled.denyTimer.unref?.()
      return
    }
    // Keep the handshake-bound consent record after a browse socket closes (#819). The
    // human may still compare its SAS and pin this exact identity until the bounded deadline.
    pooled.approvalPub = pub
    pooled.approvalId = approvals.add(pub)
    send(IPC.remoteHostPeerPending, {
      sas: s.sas(), id: pooled.approvalId, pub, standing: true
    })
  }

  async function connectOne(): Promise<void> {
    if (!running || opening || pendingCount() >= TARGET_PENDING) return
    opening = true
    try {
      const entitlement = getStoredEntitlement() // null on free tier → mint by deviceId
      // The host key is the identity every paired phone PINNED. If the OS keyring is locked we
      // cannot READ it (host-identity refuses to regenerate over it — that would rotate the
      // identity and force every phone to re-approve). There is nothing to advertise, so stop:
      // retrying would spin a dead listener and swallow the reason. Tell the human instead.
      let keys: KeyPair
      try {
        keys = await loadOrCreateKeyPair()
      } catch (err) {
        if (isHostKeyLocked(err)) {
          stop()
          reportKeyLocked(err as Error)
          return
        }
        scheduleReconnect() // transient disk error: back off and try again
        return
      }
      const token = await mintHostToken(entitlement, publicKeyToB64(keys.publicKey))
      if (!running) return
      if (!token) {
        scheduleReconnect()
        return
      }
      reconnectAttempt = 0
      const pooled: Pooled = {
        session: null as unknown as HostSession,
        bridged: false,
        presence: createPhonePresence(),
        approvalPub: null,
        approvalId: null,
        refreshTimer: null,
        denyTimer: null
      }
      pooled.session = connectHostSession({
        url: RELAY_URL,
        token: token.pairingToken,
        ourKeys: keys,
        pty: ptyManager,
        getLatestCanvas: currentCanvas,
        subscribeCanvas,
        applyMutation: (mutation: CanvasMutation) => send(IPC.remoteHostApplyMutation, mutation),
        listProjects,
        git: bridge.git,
        registerNode: bridge.registerNode,
        destroyNode: bridge.destroyNode,
        remoteViewer: bridge.remoteViewer,
        nodeActions: bridge.nodeActions,
        kanban: bridge.kanban,
        inbox: bridge.inbox,
        remoteNodes: bridge.remoteNodes,
        newSessions: bridge.newSessions,
        extraRoots: bridge.workspaceRoots,
        lanReport: bridge.lanReport,
        // Typing attribution: this pooled session's input frames are ITS phone's keystrokes.
        getClientId: () => pooled.presence.id(),
        // Returned, not voided: connectHostSession holds the phone's requests until this settles,
        // so a phone this host approves without the human is never told it is awaiting approval
        // while the disk reads and the late pin are still running (review of A07-late).
        onPeerReady: () =>
          onPeerReady(pooled).catch((err) => {
            console.warn('[standing-host] the approval decision failed:', err)
          }),
        onClose: () => {
          console.info('[phone-approval] socket-closed', { pending: !!pooled.approvalId })
          pooled.presence.leave()
          if (pooled.refreshTimer) {
            clearTimeout(pooled.refreshTimer)
            pooled.refreshTimer = null
          }
          clearDenyTimer(pooled)
          pool.delete(pooled)
          ensurePool() // a listener/session dropped → top the pool back up
        }
      })
      pool.add(pooled)
      scheduleRefreshFor(pooled, token.exp)
      // A listener is registered at the relay → advertise the identity for LATE ADOPTION
      // (~/.nodeterm/relay.json — see relay-advertise.ts): a phone whose pairing predates the
      // toggle reads it over its SSH bootstrap and gains a relay leg without re-pairing.
      // Written here (not in start()) so it only exists while the host is genuinely reachable.
      const pub = publicKeyToB64(keys.publicKey)
      void writeRelayAdvertisement({
        v: 1,
        hostId: hostIdFromPublicKeyB64(pub),
        hostPublicKeyB64: pub,
        relayEndpoint: RELAY_URL,
        hostDeviceId: getDeviceId()
      })
    } finally {
      opening = false
      // If we're still short (e.g. TARGET_PENDING > 1, or one was consumed while minting), continue.
      if (running && pendingCount() < TARGET_PENDING) queueMicrotask(() => void connectOne())
    }
  }

  function start(): void {
    if (running) return
    running = true
    runningHosts.add(revokePeer)
    reconnectAttempt = 0
    ensurePool()
  }

  function stop(): void {
    running = false
    runningHosts.delete(revokePeer)
    approvals.stop()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    for (const p of [...pool]) removeFromPool(p)
    // Host gone from the relay → stop advertising, so phones don't mint tokens against a
    // host that will never answer.
    void removeRelayAdvertisement()
  }

  function reconcile(): void {
    const want = enabled && relayAllowed()
    if (want && !running) start()
    else if (!want && running) stop()
  }

  // Dedicated request/reply channel: a missing IPC handler rejects instead of silently
  // discarding consent. Never expose this host-security operation through the relay RPC bridge.
  ipcMain.handle(IPC.remotePhoneApprove, async (event, msg: { id?: string; pub?: string }) => {
    if (event.sender !== win.webContents) return { status: 'stale' as const }
    console.info('[phone-approval] received')
    const result = await approvals.approve(msg)
    console.info('[phone-approval] result', result.status)
    if (result.status !== 'persisted') return result
    let connected = false
    for (const p of pool) {
      if (p.bridged && p.session.peerPublicKeyB64() === msg.pub) {
        if (p.approvalId) approvals.clear(p.approvalId)
        p.approvalId = null
        p.approvalPub = null
        p.session.approve()
        connected = true
      }
    }
    return { status: connected ? 'approved' as const : 'saved-disconnected' as const }
  })
  ipcMain.on(IPC.remoteHostReject, (event, msg: { id?: string; pub?: string } = {}) => {
    if (event.sender !== win.webContents || !approvals.reject(msg)) return
    for (const p of [...pool]) {
      if (p.approvalPub === msg.pub) removeFromPool(p)
    }
    ensurePool()
  })

  return {
    setEnabled(next) {
      enabled = next
      reconcile()
    },
    syncFromSettings() {
      enabled = !!getSettings().phoneAccessEnabled
      reconcile()
    },
    stop
  }
}

// ---------------------------------------------------------------------------------------------
// MANUAL SMOKE TEST (documented here, NOT automated — the live round-trip needs the deployed or a
// local relay + the iOS client, like test/remote/relay-e2e.test.ts's block):
//
//   Prereqs: a Pro-entitled desktop build (or NODETERM_RELAY_URL + NODETERM_API_BASE pointing at a
//   local relay/API), the nodeterm iOS app, and a phone already paired over the LAN.
//     1. Desktop: Settings → Phone → toggle "Remote access from your phone" ON. Main mints a
//        host-token (POST /v1/relay/host-token) and registers as role:'host' under hostId =
//        base64url(sha256(hostPublicKey)).slice(0,22).
//     2. Re-pair (or pair) the phone: the /pair response + QR now carry `relay {hostId,
//        hostPublicKeyB64, relayEndpoint}` + `relayDeviceToken`. Confirm the phone stored them.
//     3. Put the phone on cellular (OFF the LAN). It joins the relay (POST /v1/relay/join →
//        role:'client' under the same hostId) and bridges to the standing host.
//     4. FIRST connect: the desktop shows the SAS approval dialog. Approve → the phone attaches to
//        a tmux session (pty.attach) and the terminal streams. The device pubkey is pinned.
//     5. Disconnect + reconnect the phone: it now auto-approves (no dialog) — pin-once verified.
//     6. Leave it idle ~2 min: the host re-mints its token + reconnects (watch it stay reachable).
//     7. Toggle the setting OFF (or deactivate Pro): the standing host tears down; the phone can
//        no longer reach the Mac over the relay (LAN pairing still works).
//   Throughout, the relay only forwards opaque E2EE boxes — it never sees plaintext.
// ---------------------------------------------------------------------------------------------
