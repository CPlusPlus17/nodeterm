// Joining a hosted team (a Server Edition hosting over the E2EE relay) from the desktop, as one pure
// sequence the `relay:client:connect` handler calls for a `nodeterm://join?code=…` code:
//   1. decode the code (public: the relay, the host key, the host's device id);
//   2. a device token for this device and that host — the bookmarked one, else ONE fresh mint;
//   3. trade it for a short-lived client token (`/v1/relay/join`);
//   4. connect with the host key from the code pinned.
//
// Rules this file exists to keep:
//  - The CORE relay client, with NO pin store. The desktop wrapper pins every mutual approval into
//    approved-devices, which the desktop counts as paired phones; a hosted host key has no business
//    there. The joiner-side pin is the bookmark's `approvedAt` instead.
//  - Auto-confirm only when the bookmark was approved AND was approved for exactly the key this code
//    carries. Anything else shows this human the SAS again. A host that refuses us (denied, removed,
//    expired) withdraws the pin, so the next attempt asks again rather than confirming blind.
//  - Free-tier device mints are damped server-side, so at most ONE device mint per attempt: a fresh
//    token is persisted the moment it is minted (a join that then fails does not throw it away), a
//    bookmarked token earns one re-mint on `bad-token` and nothing more, and `revoked` earns none.
//  - The keys are loaded before anything is minted: a locked keyring must not cost a mint.
import { decodeJoinCode, encodeJoinCode } from '../../core/relay/join-code'
import { mintDeviceToken, mintJoinToken, type DeviceMintResult, type JoinMintResult } from '../../core/relay/join-token'
import {
  connectRelayClient,
  type ConnectRelayClientOptions,
  type RelayClientSession
} from '../../core/relay/relay-client'
import type { TrustDeniedReason } from '../../core/relay/relay-trust'
import type { KeyPair } from '../../core/relay/e2ee'
import type { BookmarkStore, RelayBookmark } from './relay-bookmarks'
import { IPC } from '../../shared/ipc'
import type { RelayClosedReason } from '../../shared/types'

/** What a hosted join hands the relay client: never a pin store. */
export type HostedConnectOptions = Omit<ConnectRelayClientOptions, 'pins' | 'transport'>

export type HostedJoinFailure = 'invalid-code' | 'rate-limited' | 'refused' | 'network' | 'bad-token' | 'revoked'

const MESSAGES: Record<HostedJoinFailure, string> = {
  'invalid-code': 'That team code is invalid.',
  'rate-limited': 'Too many join attempts for this team today. Try again tomorrow.',
  refused: 'The nodeterm service refused to register this device for that team.',
  network: 'Could not reach the nodeterm service. Check the connection and try again.',
  'bad-token': "The nodeterm service did not accept this device's token for that team.",
  revoked: "This device's relay access was revoked."
}

/** A join that did not reach the relay. `kind` says why; the message is for the human. */
export class HostedJoinError extends Error {
  constructor(readonly kind: HostedJoinFailure) {
    super(MESSAGES[kind])
    this.name = 'HostedJoinError'
  }
}

export interface HostedJoinDeps {
  apiBase: string
  /** This machine's stable device id. */
  deviceId(): string
  /** This device's name as the host will see it next to the request. */
  label: string
  bookmarks: Pick<BookmarkStore, 'list' | 'upsert' | 'update'>
  /** Our long-lived peer identity (the key the team pins). May reject (a locked keyring). */
  loadKeys(): Promise<KeyPair>
  /** Defaults to the core relay client. Tests pass their own. */
  connect?(opts: HostedConnectOptions): RelayClientSession
  fetch?: typeof fetch
  now?(): number
}

export interface HostedJoinEvents {
  /** The SAS this human compares (a first join, or one whose pin was withdrawn). */
  onSas(sas: string | null): void
  onApproved(): void
  onFrame(json: string): void
  onPtyData(sessionId: string, data: string): void
  /** The connection ended; `reason` is set only when the host refused us over the tunnel. Typed with
   *  the renderer's union, so a denial reason the core gains without it fails to compile here. */
  onClosed(reason?: RelayClosedReason): void
}

/** The host key a bookmark was recorded for, read back out of its own code. */
function bookmarkedKey(b: RelayBookmark): string | null {
  return decodeJoinCode(b.code)?.hostPublicKeyB64 ?? null
}

export async function joinHostedTeam(codeText: string, deps: HostedJoinDeps, ev: HostedJoinEvents): Promise<RelayClientSession> {
  const code = decodeJoinCode(codeText)
  if (!code) throw new HostedJoinError('invalid-code')
  const keys = await deps.loadKeys()
  const found = (await deps.bookmarks.list()).find((b) => b.hostId === code.hostId)
  // A bookmark is trusted only for the exact key it was made with; otherwise this is a new host.
  const existing = found && bookmarkedKey(found) === code.hostPublicKeyB64 ? found : undefined

  let deviceToken = existing?.deviceToken ?? null
  let approvedAt = existing?.approvedAt ?? null
  const record = (): RelayBookmark => ({
    hostId: code.hostId,
    code: encodeJoinCode(code),
    label: code.label,
    deviceToken,
    approvedAt,
    source: existing?.source ?? 'code'
  })
  // A bookmark that could not be written costs a mint and a SAS dialog next time, never access, so a
  // failed write does not fail the join.
  const persist = (): Promise<void> => deps.bookmarks.upsert(record()).catch(() => {})
  const mintDevice = async (): Promise<string> => {
    const d: DeviceMintResult = await mintDeviceToken({ apiBase: deps.apiBase, deviceId: deps.deviceId(), code, label: deps.label, fetch: deps.fetch })
    if (!d.ok) throw new HostedJoinError(d.kind)
    deviceToken = d.deviceToken
    await persist()
    return d.deviceToken
  }

  let mintedNow = false
  if (!deviceToken) {
    await mintDevice()
    mintedNow = true
  }
  let j: JoinMintResult = await mintJoinToken({ apiBase: deps.apiBase, deviceToken: deviceToken!, fetch: deps.fetch })
  if (!j.ok && j.kind === 'bad-token' && !mintedNow) {
    // The bookmarked token no longer verifies (it expired, or the service forgot it): one fresh mint.
    j = await mintJoinToken({ apiBase: deps.apiBase, deviceToken: await mintDevice(), fetch: deps.fetch })
  }
  if (!j.ok) throw new HostedJoinError(j.kind)
  if (JSON.stringify(record()) !== JSON.stringify(found ?? null)) await persist()

  let deniedReason: TrustDeniedReason | undefined
  const connect = deps.connect ?? connectRelayClient
  const now = deps.now ?? Date.now
  return connect({
    url: j.relayEndpoint,
    token: j.pairingToken,
    hostKeyB64: code.hostPublicKeyB64,
    ourKeys: keys,
    autoApprove: approvedAt !== null,
    onSas: (s) => ev.onSas(s.sas()),
    onApproved: () => {
      if (approvedAt === null) {
        approvedAt = new Date(now()).toISOString()
        void deps.bookmarks.update(code.hostId, { approvedAt, deviceToken }).catch(() => {})
      }
      ev.onApproved()
    },
    onFrame: (json) => ev.onFrame(json),
    onPtyData: (sessionId, data) => ev.onPtyData(sessionId, data),
    onDenied: (reason) => {
      deniedReason = reason
      // The host no longer counts this device as approved: the next attempt shows the SAS again.
      if (approvedAt !== null) {
        approvedAt = null
        void deps.bookmarks.update(code.hostId, { approvedAt: null }).catch(() => {})
      }
    },
    onClose: () => ev.onClosed(deniedReason)
  })
}

/** How `connectHostedTeam` reaches the renderer and the handler's connection registry. */
export interface HostedConnectIo {
  newId(): string
  /** Send to the renderer (the main window). */
  send(channel: string, ...args: unknown[]): void
  /** The handler's live relay client sessions, by connection id. */
  sessions: Map<string, RelayClientSession>
}

/**
 * The `relay:client:connect` leg for a join code: run the join, route its events to the same
 * per-connection channels a pairing offer uses, and register the session. Resolves with the
 * connection id; rejects (with the human message) when the join never reached the relay.
 */
export async function connectHostedTeam(codeText: string, deps: HostedJoinDeps, io: HostedConnectIo): Promise<string> {
  const connectionId = io.newId()
  let ended = false
  const session = await joinHostedTeam(codeText, deps, {
    onSas: (sas) => io.send(IPC.relayClientSas(connectionId), sas),
    onApproved: () => io.send(IPC.relayClientApproved(connectionId)),
    onFrame: (json) => io.send(IPC.relayClientFrame(connectionId), json),
    // pty output arrives on the SAME per-session channel a local pty uses.
    onPtyData: (sessionId, data) => io.send(IPC.ptyData(sessionId), data),
    onClosed: (reason) => {
      ended = true
      io.sessions.delete(connectionId)
      io.send(IPC.relayClientClosed(connectionId), reason)
    }
  })
  // A socket that already closed must not leave a dead session behind in the registry.
  if (!ended) io.sessions.set(connectionId, session)
  return connectionId
}
