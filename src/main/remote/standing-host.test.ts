// Standing-host presence wiring: a bridged relay client (a phone) is a `kind:'phone'` peer, and
// EVERY end path for that session — the relay socket dropping, the human rejecting the device, an
// idle-token teardown, the host being disabled / the app quitting — must reach presenceHub.leave()
// exactly once. A missed leave is a permanent ghost cursor in everyone's facepile.
//
// electron + the relay/license/disk modules are mocked; what's under test is the standing host's
// own bookkeeping.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../../core/platform'
import { fakePlatform } from '../../core/platform-fake'
import { presenceHub } from '../../core/presence/hub'
import type { ApprovedDevices } from './approved-devices-core'
import type { HostSession, HostSessionOptions } from './host-service'

const ipc: Record<string, (e: unknown, msg: unknown) => any> = {}
const errorBoxes: Array<{ title: string; body: string }> = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, msg: unknown) => unknown) => { ipc[ch] = fn },
    on: (ch: string, fn: (e: unknown, msg: unknown) => void) => {
      ipc[ch] = fn
    }
  },
  dialog: {
    showErrorBox: (title: string, body: string) => errorBoxes.push({ title, body })
  }
}))
vi.mock('../../core/pty-manager', () => ({ PtyManager: class {} }))
vi.mock('../../core/license', () => ({
  isPremium: () => true,
  getStoredEntitlement: () => 'entitlement'
}))
vi.mock('./host-canvas-hub', () => ({
  initHostCanvasHub: () => {},
  currentCanvas: () => null,
  subscribeCanvas: () => () => {}
}))
let disk: ApprovedDevices = { pubkeys: [] }
const persist = vi.fn(async (update: (s: ApprovedDevices) => ApprovedDevices) => { disk = update(disk) })
vi.mock('./relay-advertise', () => ({ writeRelayAdvertisement: async () => {}, removeRelayAdvertisement: async () => {} }))
vi.mock('./approved-devices', () => ({
  updateApprovedDevices: (update: (s: ApprovedDevices) => ApprovedDevices) => persist(update),
  loadApprovedDevices: async () => disk,
  saveApprovedDevices: async () => {}
}))
vi.mock('./e2ee', () => ({ publicKeyToB64: () => 'host-pub' }))

const sessions: Array<{
  opts: HostSessionOptions
  session: HostSession
  closed: number
  /** The bridged phone's box key (null before its handshake, as on a real idle listener). */
  peer: string | null
  /** Make close() throw, as a teardown failure would. */
  closeThrows?: boolean
}> = []

// Swappable: a locked OS keyring makes the host key unreadable, and loading it REJECTS rather than
// rotating the pinned identity (host-identity.ts). The standing host must handle that, loudly.
let keyError: Error | null = null

vi.mock('./host-service', () => ({
  API_BASE: 'https://api.test',
  RELAY_URL: 'wss://relay.test',
  relayAllowed: () => true,
  loadOrCreateKeyPair: async () => {
    if (keyError) throw keyError
    return { publicKey: new Uint8Array(), secretKey: new Uint8Array() }
  },
  connectHostSession: (opts: HostSessionOptions): HostSession => {
    const entry: (typeof sessions)[number] = { opts, closed: 0, peer: 'phone-pub', session: null as unknown as HostSession }
    entry.session = {
      approve: vi.fn(),
      isApproved: () => false,
      sas: () => '12345',
      // A real relay socket close() is "intentional" and does NOT fire onClose — modelled here.
      peerPublicKeyB64: () => entry.peer,
      close: () => {
        entry.closed += 1
        if (entry.closeThrows) throw new Error('teardown failed')
      }
    }
    sessions.push(entry)
    return entry.session
  }
}))

// The peer revoker also cuts relay-host (peer desktop) sessions; that host is not under test here.
const relayHostKills = vi.fn((_pub: string) => {})
vi.mock('./relay-host', () => ({ killRelayHostsByPeerKey: (pub: string) => relayHostKills(pub) }))

import {
  initStandingHost,
  killStandingHostSessionsByPeerKey,
  resetRevokedPhonesForTests,
  REVOKED_PHONE_DENY_MS,
  type StandingHostOptions
} from './standing-host'
import { createPeerRevoker } from './peer-revoker'
import { IPC } from '../../shared/ipc'

/** Let the async connectOne() chain (token mint, keypair) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function phones(): number {
  return presenceHub.peers().filter((p) => p.kind === 'phone').length
}

const sentToWin: Array<{ channel: string; args: unknown[] }> = []

let sender: unknown
// Every host a test made, stopped after it even when an assertion threw first: a running host stays
// registered for revocation, so one left running would answer a later test's revoke.
const hosts: Array<{ stop(): void }> = []
function makeHost(options: StandingHostOptions = {}) {
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, ...args: unknown[]) => sentToWin.push({ channel, args })
    }
  }
  sender = win.webContents
  const host = initStandingHost(win as never, {} as never, () => ({ phoneAccessEnabled: true }) as never, undefined, undefined, options)
  hosts.push(host)
  return host
}

/** The pending-approval id the host just surfaced to the human (SAS dialog). */
function pendingApprovalId(): string {
  const msg = sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending).at(-1)
  return (msg?.args[0] as { id: string }).id
}

beforeEach(() => {
  initPlatform(fakePlatform())
  sessions.length = 0
  sentToWin.length = 0
  errorBoxes.length = 0
  persist.mockReset()
  disk = { pubkeys: [] }
  persist.mockImplementation(async (update) => { disk = update(disk) })
  relayHostKills.mockReset()
  resetRevokedPhonesForTests()
  keyError = null
  for (const key of Object.keys(ipc)) delete ipc[key]
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ pairingToken: 'tok', hostId: 'host', exp: 0 })
    }))
  )
})

afterEach(() => {
  for (const host of hosts.splice(0)) host.stop()
  vi.useRealTimers()
  for (const p of presenceHub.peers()) presenceHub.leave(p.clientId)
  vi.unstubAllGlobals()
  resetPlatformForTests()
})

describe('standing host presence peers', () => {
  it('forwards the exact optional legacy pairing store into the real session factory', async () => {
    const pairings: NonNullable<StandingHostOptions['legacyRelayPairings']> = {
      inspect: vi.fn(async () => ({ status: 'unprovable' as const })),
      associate: vi.fn(async () => ({ status: 'associated' as const }))
    }
    const host = makeHost({ legacyRelayPairings: pairings })
    host.setEnabled(true); await settle()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].opts.legacyRelayPairings).toBe(pairings)
    expect(await sessions[0].opts.legacyRelayPairings!.inspect('fixture-id', 'fixture-peer')).toEqual({ status: 'unprovable' })
    expect(pairings.inspect).toHaveBeenCalledWith('fixture-id', 'fixture-peer')
  })
  it('a bridged relay client joins as a cursorless phone peer and leaves when the socket drops', async () => {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    expect(sessions).toHaveLength(1)
    expect(phones()).toBe(0) // an idle (un-bridged) listener is nobody

    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    const peer = presenceHub.peers().find((p) => p.kind === 'phone')
    expect(peer).toBeDefined()
    expect(peer?.cursor).toBeNull() // a phone has no mouse — never fabricate one
    expect(peer?.name).toBe('Phone')
    expect(peer!.clientId).toBeGreaterThanOrEqual(1_000_000) // relay id range

    // Clean disconnect (relay socket dropped) → the peer leaves.
    sessions[0].opts.onClose()
    expect(phones()).toBe(0)

    host.stop()
  })

  it('leaves the hub when the human rejects the device (close() never fires onClose)', async () => {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    expect(phones()).toBe(1)

    // Reject → removeFromPool → session.close(). A real relay socket treats an intentional close
    // as final and does NOT call onClose, so the leave has to happen on this path too.
    ipc[IPC.remoteHostReject]({ sender }, { id: pendingApprovalId(), pub: 'phone-pub' })
    expect(sessions[0].closed).toBe(1)
    expect(phones()).toBe(0)

    host.stop()
  })

  it('leaves the hub when the host is disabled / the app quits (stop() tears the pool down)', async () => {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    expect(phones()).toBe(1)

    host.stop()
    expect(phones()).toBe(0)
  })

  it('a bridged peer leaves exactly once even if close() and onClose() both fire', async () => {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    const id = presenceHub.peers().find((p) => p.kind === 'phone')!.clientId

    host.stop() // → removeFromPool → close() → leave
    sessions[0].opts.onClose() // a late transport close still arrives → must be a no-op
    expect(phones()).toBe(0)

    // The id must not be recycled onto some other peer by a double-leave.
    presenceHub.join(id, 'phone')
    expect(phones()).toBe(1)
    presenceHub.leave(id)
  })
})

describe('standing host: the host key cannot be read (locked keyring)', () => {
  it('stops loudly instead of retrying into a dead listener', async () => {
    keyError = Object.assign(new Error('the OS keyring is locked'), {
      code: 'E_HOST_KEY_LOCKED'
    })
    const host = makeHost()
    host.setEnabled(true)
    await settle()

    // Nothing was registered at the relay (no key ⇒ no identity to advertise) and, crucially,
    // the failure is not swallowed: the user is told, once, what happened and how to recover.
    expect(sessions).toHaveLength(0)
    expect(errorBoxes).toHaveLength(1)
    expect(errorBoxes[0].body).toMatch(/keyring/i)

    // Bounded: no reconnect storm re-raising the dialog every second.
    await settle()
    expect(errorBoxes).toHaveLength(1)
    expect(sessions).toHaveLength(0)

    host.stop()
  })
})


describe('standing phone approval lifecycle (#819)', () => {
  async function pending() {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    return { host, msg: { id: pendingApprovalId(), pub: 'phone-pub' } }
  }
  it('pins the displayed handshake after its browse socket closes, without approving a dead session', async () => {
    const { host, msg } = await pending()
    sessions[0].opts.onClose()
    expect(await ipc[IPC.remotePhoneApprove]({ sender }, msg)).toEqual({ status: 'saved-disconnected' })
    expect(persist).toHaveBeenCalledOnce()
    expect(sessions[0].session.approve).not.toHaveBeenCalled()
    expect(disk.pubkeys).toEqual(['phone-pub'])
    const count = sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending).length
    sessions[1].opts.onPeerReady(sessions[1].session)
    await settle()
    expect(sessions[1].session.approve).toHaveBeenCalledOnce()
    expect(sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending)).toHaveLength(count)
    host.stop()
  })
  it('waits for persistence before granting access', async () => {
    const { host, msg } = await pending()
    let release!: () => void
    persist.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const approval = ipc[IPC.remotePhoneApprove]({ sender }, msg)
    expect(sessions[0].session.approve).not.toHaveBeenCalled()
    release()
    expect(await approval).toEqual({ status: 'approved' })
    expect(sessions[0].session.approve).toHaveBeenCalledOnce()
    host.stop()
  })
  it('reports a failed write and grants no access', async () => {
    const { host, msg } = await pending()
    persist.mockRejectedValueOnce(Object.assign(new Error('fixture'), { code: 'EACCES' }))
    expect(await ipc[IPC.remotePhoneApprove]({ sender }, msg)).toEqual({ status: 'persistence-failed' })
    expect(sessions[0].session.approve).not.toHaveBeenCalled()
    host.stop()
  })
  it('rejects stale, mismatched and non-owner requests without writing', async () => {
    const { host, msg } = await pending()
    for (const [owner, request] of [[{}, msg], [sender, { ...msg, pub: 'other' }], [sender, { ...msg, id: 'stale' }]]) {
      expect(await ipc[IPC.remotePhoneApprove]({ sender: owner }, request)).toEqual({ status: 'stale' })
    }
    expect(persist).not.toHaveBeenCalled()
    host.stop()
    expect(await ipc[IPC.remotePhoneApprove]({ sender }, msg)).toEqual({ status: 'stale' })
  })
  it('host stop during a save never grants a closed session access', async () => {
    const { host, msg } = await pending()
    let release!: () => void
    persist.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const approval = ipc[IPC.remotePhoneApprove]({ sender }, msg)
    host.stop()
    release()
    expect(await approval).toEqual({ status: 'saved-disconnected' })
    expect(sessions[0].session.approve).not.toHaveBeenCalled()
  })
})

describe('revoking a phone cuts its live relay session (audit A07-revoke)', () => {
  // Unpinning a key only refuses its NEXT handshake: a phone that is connected while it is forgotten
  // would keep serving terminals, files and the canvas until its socket dropped on its own. The
  // revoke (Settings → Phone → Revoke, through pairing-service's revokeRelayKey, or
  // `remote:revoke-peer`) goes through the peer revoker, which unpins and then closes it.

  /** Bridge the newest idle listener to `peer`, as a phone completing its handshake does. */
  async function bridge(peer: string) {
    const entry = sessions.at(-1)!
    entry.peer = peer
    entry.opts.onPeerReady(entry.session)
    await settle()
    const replacement = sessions.at(-1)!
    expect(replacement).not.toBe(entry) // the pool opened a fresh listener for the next phone…
    replacement.peer = null // …which has no phone yet
    return entry
  }
  function pendingFor(pub: string) {
    return sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending).map((s) => s.args[0] as { id: string; pub: string })
      .filter((m) => m.pub === pub)
  }

  it('closes every session of the revoked phone, unpins it, and leaves other phones alone', async () => {
    disk = { pubkeys: ['phone-A', 'phone-B'] }
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const a1 = await bridge('phone-A')
    const b = await bridge('phone-B')
    const a2 = await bridge('phone-A') // the same phone, a second concurrent session
    const idle = sessions.at(-1)!
    expect([a1, b, a2].map((e) => (e.session.approve as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1, 1])
    expect(phones()).toBe(3)

    expect(await createPeerRevoker().revoke('phone-A')).toEqual({ persisted: true, killed: true })

    expect(disk.pubkeys).toEqual(['phone-B'])
    expect([a1.closed, a2.closed]).toEqual([1, 1])
    expect([b.closed, idle.closed]).toEqual([0, 0])
    expect(phones()).toBe(1) // the revoked phone left the facepile; the other is still there
    expect(relayHostKills).toHaveBeenCalledWith('phone-A') // and any peer-desktop session of that key

    // A reconnect from the revoked phone is no longer auto-approved (the review of A07-revoke covers
    // what it gets instead, below).
    const again = await bridge('phone-A')
    expect(again.session.approve).not.toHaveBeenCalled()
    host.stop()
  })

  it('withdraws a pending approval, including one that outlived its socket (#819)', async () => {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const live = await bridge('phone-A')
    const liveMsg = pendingFor('phone-A')[0]
    expect(killStandingHostSessionsByPeerKey('phone-A')).toBe(1)
    expect(live.closed).toBe(1)
    expect(await ipc[IPC.remotePhoneApprove]({ sender }, liveMsg)).toEqual({ status: 'stale' })

    const gone = await bridge('phone-C')
    const goneMsg = pendingFor('phone-C')[0]
    gone.opts.onClose() // the browse socket closed; its consent record is kept for the human
    expect(killStandingHostSessionsByPeerKey('phone-C')).toBe(0) // no session left to close…
    expect(await ipc[IPC.remotePhoneApprove]({ sender }, goneMsg)).toEqual({ status: 'stale' }) // …but no re-pin either
    const cleared = sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPendingCleared).map((s) => (s.args[0] as { id: string }).id)
    expect(cleared).toEqual(expect.arrayContaining([liveMsg.id, goneMsg.id]))
    expect(persist).not.toHaveBeenCalled()
    host.stop()
  })

  it('keeps cutting when one teardown throws, and the revoke reports the cut as unconfirmed', async () => {
    disk = { pubkeys: ['phone-A'] }
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const first = await bridge('phone-A')
    const second = await bridge('phone-A')
    first.closeThrows = true
    expect(await createPeerRevoker().revoke('phone-A')).toEqual({ persisted: true, killed: false })
    expect([first.closed, second.closed]).toEqual([1, 1])
    expect(phones()).toBe(0)
    host.stop()
  })

  it('a stopped host has nothing to cut', async () => {
    disk = { pubkeys: ['phone-A'] }
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const a = await bridge('phone-A')
    host.stop()
    expect(a.closed).toBe(1)
    expect(killStandingHostSessionsByPeerKey('phone-A')).toBe(0)
    expect(a.closed).toBe(1)
  })
})

describe('a phone revoked during this run is refused without a dialog (review of A07-revoke)', () => {
  // Cutting the session makes the phone redial (the Android client does so 1.5 s after a drop). With
  // its key unpinned and its pairing gone, that handshake used to raise the SAS dialog for the phone
  // the user had just removed, and approving it pinned the key again. It is now left unapproved, so
  // every request it makes hears "Awaiting host approval.", and closed after REVOKED_PHONE_DENY_MS:
  // what a human's Deny looks like to the phone, which then stops dialing on its own.

  async function bridge(peer: string) {
    const entry = sessions.at(-1)!
    entry.peer = peer
    entry.opts.onPeerReady(entry.session)
    await settle()
    sessions.at(-1)!.peer = null // the replacement listener has no phone yet
    return entry
  }
  const dialogsFor = (pub: string) =>
    sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending && (s.args[0] as { pub: string }).pub === pub)

  it('a redial after the revoke raises no dialog, stays unapproved, and is closed like a Deny', async () => {
    vi.useFakeTimers()
    disk = { pubkeys: ['phone-A'] }
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const live = await bridge('phone-A')
    expect(await createPeerRevoker().revoke('phone-A')).toEqual({ persisted: true, killed: true })
    expect(live.closed).toBe(1)

    const again = await bridge('phone-A')
    expect(dialogsFor('phone-A')).toEqual([]) // nothing on the desk to approve by mistake
    expect(again.session.approve).not.toHaveBeenCalled()
    expect(phones()).toBe(1)
    // Not at once: the phone must first hear that it awaits approval, or it reads a plain failure.
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS - 1)
    expect(again.closed).toBe(0)
    vi.advanceTimersByTime(1)
    expect(again.closed).toBe(1)
    expect(phones()).toBe(0)
    expect(disk.pubkeys).toEqual([]) // and nothing pinned it again
    await settle()
    expect(sessions.filter((e) => e.closed === 0)).toHaveLength(1) // the pool is topped back up
    host.stop()
  })

  it('a revoke while remote access is off counts too', async () => {
    vi.useFakeTimers()
    expect(killStandingHostSessionsByPeerKey('phone-Z')).toBe(0) // no host runs
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const later = await bridge('phone-Z')
    expect(dialogsFor('phone-Z')).toEqual([])
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS)
    expect(later.closed).toBe(1)
    host.stop()
  })

  it('pairing the phone again lets it in, and another phone still gets the dialog', async () => {
    vi.useFakeTimers()
    let paired = false
    const host = makeHost({ pinPairedPhone: async () => paired })
    host.setEnabled(true)
    await settle()
    killStandingHostSessionsByPeerKey('phone-A')

    const stranger = await bridge('phone-B')
    expect(dialogsFor('phone-B')).toHaveLength(1)
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS)
    expect(stranger.closed).toBe(0) // only the revoked key is refused

    paired = true // re-paired with remote access off: the pairing recorded its key (A07-late)
    const repaired = await bridge('phone-A')
    expect(repaired.session.approve).toHaveBeenCalledOnce()
    disk = { pubkeys: ['phone-A'] } // or re-paired with it on: the scan pinned it (A07)
    paired = false
    const pinned = await bridge('phone-A')
    expect(pinned.session.approve).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS)
    expect([repaired.closed, pinned.closed]).toEqual([0, 0])
    expect(dialogsFor('phone-A')).toEqual([])
    host.stop()
  })

  it('a refused session that drops or is stopped first is not closed twice', async () => {
    vi.useFakeTimers()
    killStandingHostSessionsByPeerKey('phone-A')
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const dropped = await bridge('phone-A')
    dropped.opts.onClose() // the phone hung up on its own
    const stopped = await bridge('phone-A')
    host.stop()
    expect(stopped.closed).toBe(1)
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS)
    expect([dropped.closed, stopped.closed]).toEqual([0, 1])
    expect(phones()).toBe(0)
  })
})

describe('a paired phone adopting the relay late is approved by its pairing, not a dialog (audit A07-late)', () => {
  // Pairing recorded the phone's relay key but did not pin it (no relay leg at the scan). The phone
  // adopts the relay over SSH later, and its first handshake here is usually made away from the desk.
  function pending(): Array<{ pub: string }> {
    return sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending).map((s) => s.args[0] as { pub: string })
  }

  it('approves the handshake silently when the pairing record pins the key', async () => {
    const asked: string[] = []
    const host = makeHost({ pinPairedPhone: async (pub) => (asked.push(pub), true) })
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    expect(asked).toEqual(['phone-pub'])
    expect(sessions[0].session.approve).toHaveBeenCalledOnce()
    expect(pending()).toEqual([])
    host.stop()
  })

  it('a key no pairing recorded, or a check that fails, gets the dialog as before', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const pinPairedPhone of [
      async () => false,
      async (): Promise<boolean> => {
        throw new Error('fixture')
      }
    ]) {
      sentToWin.length = 0
      sessions.length = 0
      const host = makeHost({ pinPairedPhone })
      host.setEnabled(true)
      await settle()
      sessions[0].opts.onPeerReady(sessions[0].session)
      await settle()
      expect(sessions[0].session.approve).not.toHaveBeenCalled()
      expect(pending().map((m) => m.pub)).toEqual(['phone-pub'])
      host.stop()
    }
    warn.mockRestore()
  })

  it('an already pinned phone never reaches the check, and an unverified handshake never does', async () => {
    const asked = vi.fn(async () => true)
    disk = { pubkeys: ['phone-pub'] }
    const host = makeHost({ pinPairedPhone: asked })
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    expect(sessions[0].session.approve).toHaveBeenCalledOnce()
    disk = { pubkeys: [] }
    const unverified = sessions.at(-1)!
    unverified.session.sas = () => null as unknown as string
    unverified.opts.onPeerReady(unverified.session)
    await settle()
    expect(unverified.session.approve).not.toHaveBeenCalled()
    expect(asked).not.toHaveBeenCalled()
    host.stop()
  })

  it('hands connectHostSession a decision that settles only once it has approved or asked the human', async () => {
    // connectHostSession holds the phone's requests until this settles (review of A07-late): a
    // phone told "Awaiting host approval." while the late pin is still on disk gives up when it is
    // a background check, and forgets that this computer approves it.
    for (const paired of [true, false]) {
      sentToWin.length = 0
      sessions.length = 0
      let answer!: (v: boolean) => void
      const host = makeHost({ pinPairedPhone: () => new Promise<boolean>((r) => (answer = r)) })
      host.setEnabled(true)
      await settle()
      const decision = sessions[0].opts.onPeerReady(sessions[0].session)
      expect(decision).toBeInstanceOf(Promise)
      let settled = false
      void (decision as Promise<void>).then(() => (settled = true))
      await settle()
      expect(settled).toBe(false) // the late pin has not answered yet: still deciding
      answer(paired)
      await decision
      if (paired) {
        expect(sessions[0].session.approve).toHaveBeenCalledOnce()
        expect(pending()).toEqual([])
      } else {
        expect(sessions[0].session.approve).not.toHaveBeenCalled()
        expect(pending().map((m) => m.pub)).toEqual(['phone-pub']) // the dialog is up before it settles
      }
      host.stop()
    }
  })

  it('a phone revoked while the check is in flight is not approved', async () => {
    let answer!: (v: boolean) => void
    const host = makeHost({ pinPairedPhone: () => new Promise<boolean>((r) => (answer = r)) })
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    sessions.at(-1)!.peer = null // the replacement listener has no phone yet
    expect(killStandingHostSessionsByPeerKey('phone-pub')).toBe(1)
    answer(true)
    await settle()
    expect(sessions[0].session.approve).not.toHaveBeenCalled()
    expect(sessions[0].closed).toBe(1)
    host.stop()
  })
})
