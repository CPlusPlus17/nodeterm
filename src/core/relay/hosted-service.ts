// Hosted team relay: the Server Edition side of docs/hosted-team-relay.md.
// Composes the host key, team store, standing-listener scheduler and access policy around the core
// relay host. All relay-peer traffic crosses relay-host.ts's hooks; hosted RPCs (relay:hosted:*)
// are INTERCEPTED there and never registered on the platform, so a Server Edition browser client
// (whose gate is the server password, not a team role) cannot call them.
//
// Four rules the file rests on:
//  - The ROLE is read from the team store on every decision (access, sink filter, narrowing,
//    interceptors) and never cached on a session, so a removal or a promotion applies to the very
//    next message. Removal also cuts the live session (`killRelayHostsByPeerKey`).
//  - An interceptor bypasses `access` and the scope jails, so each one checks the CALLER's own
//    session key against the team store: `relay:hosted:self` is open to any approved peer, approve /
//    deny / invite-code to owners only.
//  - Pending requests are told to connected OWNERS only (never a broadcast: a viewer must not learn
//    who is knocking), and an owner who connects later is told the ones still open.
//  - The scheduler hears about EVERY session end. The core fires `onClose` only for ends the shell
//    did not ask for; every end this service causes (deny, expiry, removal, a listener the
//    scheduler closes) runs the same `ended` bookkeeping, at most once per session.
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '../../shared/ipc'
import { connectRelayHost, killRelayHostsByPeerKey, type PeerAttach, type RelayHostSession } from './relay-host'
import type { RelayTransport } from './relay-socket'
import type { TrustDeniedReason } from './relay-trust'
import { createHostKey, loadHostKey, rotateHostKey, hostAddress, HostKeyUnreadableError } from './host-key'
import { TeamStore, peerFor, upsertPeer, removePeer, setShared, TEAM_ROLES, type TeamRole } from './team-store'
import { decideAccess, wrapSinkForRole, narrowResponseForRole, type AccessContext } from './access-policy'
import { mintHostToken } from './host-token'
import { createHostedScheduler, type Listener, type SchedulerStatus } from './hosted-scheduler'
import { encodeJoinCode } from './join-code'
import type { KeyPair } from './e2ee'
import type { UiSink } from '../ui-sink-registry'

/** An unanswered join request is refused after ten minutes. */
export const PENDING_TTL_MS = 600_000

/** Every hosted channel starts with this. Anything under it that the interceptor does not answer
 *  (a CAST of a hosted verb, an unknown hosted verb) is refused by the access hook. */
const HOSTED_PREFIX = 'relay:hosted:'

/** The join code's own label cap (join-code.ts): a longer host name would make an undecodable code. */
const JOIN_LABEL_MAX = 60

export interface HostedPending { pendingId: string; sas: string; peerKeyB64: string; since: number }
/** Why a pending request stopped being pending, as told to owners on `relay:hosted:pending-closed`. */
export type PendingClosedReason = 'approved' | 'denied' | 'expired' | 'gone'
/** `stopped`: a `stop()` landed after this `start()` was called and before it finished; it wins. */
export type HostedStartResult = 'started' | 'no-team' | 'host-key-unreadable' | 'stopped'

export interface HostedServiceDeps {
  dataDir: string
  apiBase: string
  relayUrl: string
  deviceId: string
  hostLabel: string
  attach: PeerAttach
  projectOfNode(nodeId: string): string | undefined
  projectCwd(projectId: string): string | undefined
  /** TEST ONLY: an in-process transport per listener. Production opens a real WebSocket. */
  transport?: () => RelayTransport
  /** TEST ONLY: the host-token mint's fetch. */
  fetch?: typeof fetch
  /** Wall clock (ms): display only (`since`, `addedAt`) and the mint's clock-skew fallback. */
  now?: () => number
  /** MONOTONIC clock (ms) for the scheduler, whose hourly mint budget must not stretch or empty when
   *  the wall clock steps. Defaults to `performance.now`. */
  monotonicNow?: () => number
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
}

export interface HostedInfo { relayEndpoint: string; hostId: string; hostPublicKeyB64: string; hostDeviceId: string; label: string }

export interface HostedStatus {
  enabled: boolean
  scheduler: SchedulerStatus | null
  peers: Array<{ label: string; role: TeamRole; connected: boolean }>
  pending: HostedPending[]
}

export interface HostedService {
  /** Create the host key (once) and the team file. `created` is false when a key already existed —
   *  including when a concurrent init won the race. An unreadable key throws; it is never replaced. */
  init(): Promise<{ created: boolean }>
  /** Idempotent: a running (or concurrently starting) service answers 'started' with no second scheduler. */
  start(): Promise<HostedStartResult>
  /** Stop hosting: every listener, session and pending request ends. A start still loading loses. */
  stop(): void
  addOwner(pubkeyB64: string, label: string): Promise<void>
  remove(pubkeyB64: string, force: boolean): Promise<'removed' | 'last-owner' | 'unknown'>
  share(projectId: string, on: boolean): Promise<void>
  info(): HostedInfo | null
  joinCode(): string | null
  status(): HostedStatus
  /** Replace the host key and keep hosting. Every teammate needs a new join code. */
  rotateKey(): Promise<void>
}

/** One relay listener and, once a peer bridges, its session. */
interface Conn {
  session: RelayHostSession | null
  /** The scheduler's events for this listener. */
  ev: { onBridged(): void; onClose(): void }
  /** The peer's role-filtered sink, set when the core opens the session. */
  sink: UiSink | null
  /** Set while this session is a pending join request. */
  pendingId: string | null
  /** The owner decision awaiting the peer's own confirm; what `pins.record` writes. */
  approval: { role: TeamRole; by: string } | null
  open: boolean
  ended: boolean
}

interface PendingEntry { info: HostedPending; conn: Conn; timer: unknown }

const OWNER_ONLY: Readonly<Record<string, string>> = Object.freeze({
  [IPC.relayHostedApprove]: 'Only an owner can approve.',
  [IPC.relayHostedDeny]: 'Only an owner can deny.',
  [IPC.relayHostedInviteCode]: 'Only an owner can invite.'
})

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const realpath = (p: string): string | null => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

const idOf = (p: unknown): unknown =>
  p !== null && typeof p === 'object' ? (p as Record<string, unknown>).id : undefined

/** `workspace:load` holds every project on this core; a hosted peer sees the shared ones only. Fails
 *  closed: a result that does not look like a workspace keeps no projects. */
function narrowWorkspace(result: unknown, shared: ReadonlySet<string>): unknown {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result
  const ws = result as Record<string, unknown>
  const projects = Array.isArray(ws.projects)
    ? ws.projects.filter((p) => { const id = idOf(p); return typeof id === 'string' && shared.has(id) })
    : []
  const active = projects.some((p) => idOf(p) === ws.activeProjectId) ? ws.activeProjectId : (idOf(projects[0]) ?? '')
  return { ...ws, projects, activeProjectId: active }
}

export function createHostedService(deps: HostedServiceDeps): HostedService {
  const dir = path.join(deps.dataDir, 'relay')
  const team = new TeamStore(dir)
  // Looked up at call time (not captured), so a test's fake timers and fake Date apply.
  const wallNow = (): number => (deps.now ? deps.now() : Date.now())
  const monoNow = (): number => (deps.monotonicNow ? deps.monotonicNow() : performance.now())
  const setT = (fn: () => void, ms: number): unknown => (deps.setTimeout ? deps.setTimeout(fn, ms) : setTimeout(fn, ms))
  const clearT = (h: unknown): void => {
    if (h === null || h === undefined) return
    if (deps.clearTimeout) deps.clearTimeout(h)
    else clearTimeout(h as ReturnType<typeof setTimeout>)
  }

  let keys: KeyPair | null = null
  let scheduler: ReturnType<typeof createHostedScheduler> | null = null
  /** Bumped by every stop. A start that began in an older epoch never creates a scheduler. */
  let epoch = 0
  /** start / rotateKey run one at a time, so two admin commands can never race a scheduler into
   *  existence (R2) or start one with the key a rotation is replacing. */
  let lifecycle: Promise<unknown> = Promise.resolve()
  const conns = new Set<Conn>() // every listener whose session has not ended
  const pending = new Map<string, PendingEntry>()

  const onLifecycle = <T>(op: () => Promise<T>): Promise<T> => {
    const run = lifecycle.then(op)
    lifecycle = run.catch(() => {})
    return run
  }

  const keyOf = (c: Conn): string | null => c.session?.peerKeyB64() ?? null
  /** The team's word on this session's key, NOW. Never cached (see the header). */
  const roleOf = (c: Conn): TeamRole | undefined => {
    const k = keyOf(c)
    return k ? peerFor(team.current(), k)?.role : undefined
  }
  const ctxFor = (c: Conn): AccessContext => {
    const shared = new Set(team.current().sharedProjects)
    return {
      // An open session with no team entry can only be one whose pin write failed (or one a removal
      // is about to cut): it gets the lowest role, never a guess upward.
      role: roleOf(c) ?? 'viewer',
      sharedProjects: shared,
      projectOfNode: (nodeId) => deps.projectOfNode(nodeId),
      projectCwds: () =>
        [...shared].map((p) => deps.projectCwd(p)).filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0),
      realpath
    }
  }

  const send = (c: Conn, channel: string, payload: unknown): void => {
    if (!c.sink) return
    try {
      c.sink.sendText(JSON.stringify({ t: 'ev', channel, args: [payload] }))
    } catch {
      // Its socket is gone; the session's own close is already on its way.
    }
  }
  /** Connected owners ONLY, judged per send. Never a broadcast. */
  const tellOwners = (channel: string, payload: unknown): void => {
    for (const c of conns) if (c.open && roleOf(c) === 'owner') send(c, channel, payload)
  }

  const closePending = (id: string, reason: PendingClosedReason): void => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearT(p.timer)
    if (p.conn.pendingId === id) p.conn.pendingId = null
    tellOwners(IPC.relayHostedPendingClosed, { pendingId: id, reason })
  }

  /** Everything owed to a session that ended, however it ended: drop it, close its request, and tell
   *  the scheduler (which no longer counts it as bridged). At most once per session. */
  const ended = (c: Conn, reason: PendingClosedReason): void => {
    if (c.ended) return
    c.ended = true
    c.open = false
    conns.delete(c)
    if (c.pendingId) closePending(c.pendingId, reason)
    try {
      c.ev.onClose()
    } catch {
      // The scheduler never throws here; a throw must not undo the bookkeeping above.
    }
  }

  /** End a session on this service's own decision. `deny` is a no-op on a session that already
   *  closed (a drop, a key swap, a kill from elsewhere), so this tolerates every such state. */
  const endSession = (c: Conn, why: TrustDeniedReason, reason: PendingClosedReason): void => {
    c.session?.deny(why)
    ended(c, reason)
  }

  const expire = (c: Conn, pendingId: string): void => {
    // Answered or gone already: its timer was cleared, but a clear can lose a race with the fire.
    if (c.pendingId !== pendingId) return
    endSession(c, 'expired', 'expired')
  }

  /** Pin an OWNER-approved peer into the team. The trust gate calls this only after both ends
   *  confirmed, with the key bound into the gate. An auto-approved peer is already a member. */
  const recordApproval = async (c: Conn, peerKeyB64: string): Promise<void> => {
    const a = c.approval
    if (!a) return
    try {
      await team.update((d) =>
        upsertPeer(d, { pubkeyB64: peerKeyB64, label: '', role: a.role, addedAt: new Date(wallNow()).toISOString(), addedBy: a.by })
      )
    } catch (err) {
      // The gate still opens (consent for THIS session is mutual); the next connect asks again.
      console.warn(`[hosted-team] could not record an approved teammate: ${errorMessage(err)}`)
    }
  }

  const self = (c: Conn): { role: TeamRole; label: string; hostLabel: string } => {
    const k = keyOf(c)
    const p = k ? peerFor(team.current(), k) : undefined
    return { role: p?.role ?? 'viewer', label: p?.label ?? '', hostLabel: deps.hostLabel }
  }

  /** approve / deny / invite-code. Owner-only, judged from the CALLER's session key. Synchronous on
   *  purpose: two approves of one request are decided in arrival order, and the second answers false. */
  const ownerVerb = (c: Conn, method: string, args: unknown[]): unknown => {
    if (roleOf(c) !== 'owner') throw new Error(OWNER_ONLY[method])
    if (method === IPC.relayHostedInviteCode) return api.joinCode()
    const [pendingId, role] = args
    const p = typeof pendingId === 'string' ? pending.get(pendingId) : undefined
    if (method === IPC.relayHostedDeny) {
      if (!p) return false
      endSession(p.conn, 'denied', 'denied')
      return true
    }
    if (typeof role !== 'string' || !(TEAM_ROLES as readonly string[]).includes(role)) throw new Error('Unknown role.')
    if (!p || p.conn.approval) return false // gone, or another owner got there first
    const by = keyOf(c)
    if (!by) throw new Error('Only an owner can approve.')
    p.conn.approval = { role: role as TeamRole, by }
    // This end's confirm. The request stays pending until the peer's own confirm opens it.
    p.conn.session?.confirm()
    return true
  }

  function openListener(hostKeys: KeyPair, token: string, ev: Conn['ev']): Listener {
    const c: Conn = { session: null, ev, sink: null, pendingId: null, approval: null, open: false, ended: false }
    const bridged = (): void => {
      try {
        ev.onBridged()
      } catch {
        // Never let the scheduler's bookkeeping break a handshake.
      }
    }
    conns.add(c)
    try {
      c.session = connectRelayHost({
        url: deps.relayUrl,
        token,
        ourKeys: hostKeys,
        attach: deps.attach,
        transport: deps.transport ? deps.transport() : undefined,
        // Asked once, at the end of the handshake, on BOTH paths (pinned or not) — which makes it the
        // moment this listener stops being available to anyone else: a pinned peer that never
        // confirms must not hold the room's only idle listener until its refresh.
        autoApprove: (peerKeyB64) => {
          bridged()
          return peerFor(team.current(), peerKeyB64) !== undefined
        },
        pins: { record: (state) => recordApproval(c, state.peerKeyB64) },
        hooks: {
          interceptReq: (_s, method, args) => {
            if (method === IPC.relayHostedSelf) return Promise.resolve(self(c))
            if (!Object.hasOwn(OWNER_ONLY, method)) return null
            try {
              return Promise.resolve(ownerVerb(c, method, args))
            } catch (err) {
              return Promise.reject(err)
            }
          },
          access: (_s, kind, method, args) => {
            // Intercepted requests never get here, so a hosted verb that did is a cast or unknown.
            if (typeof method === 'string' && method.startsWith(HOSTED_PREFIX)) {
              return { allow: false, message: 'That is answered by the hosted team service only.' }
            }
            return decideAccess(kind, method, args, ctxFor(c))
          },
          wrapSink: (_s, sink) => {
            const wrapped = wrapSinkForRole(sink, () => ctxFor(c))
            c.sink = wrapped
            return wrapped
          },
          // RPC responses bypass the outbound sink filter, so the role narrowing runs here too — after
          // the shared-project narrowing of the workspace (the subagent snapshot is the case today).
          narrowResponse: (_s, method, result) => {
            const ctx = ctxFor(c)
            const scoped = method === IPC.workspaceLoad ? narrowWorkspace(result, ctx.sharedProjects) : result
            return narrowResponseForRole(method, scoped, ctx)
          }
        },
        onPeerPending: (s) => {
          bridged()
          if (c.ended) return
          const info: HostedPending = { pendingId: randomUUID(), sas: s.sas() ?? '', peerKeyB64: s.peerKeyB64() ?? '', since: wallNow() }
          const timer = setT(() => expire(c, info.pendingId), PENDING_TTL_MS)
          pending.set(info.pendingId, { info, conn: c, timer })
          c.pendingId = info.pendingId
          tellOwners(IPC.relayHostedPeerPending, info)
        },
        onOpen: () => {
          bridged()
          if (c.ended) return
          c.open = true
          if (c.pendingId) closePending(c.pendingId, 'approved')
          if (roleOf(c) === undefined) {
            console.warn('[hosted-team] a session opened with no team entry (its pin was not recorded); it is served as a viewer')
          }
          // An owner who was offline when a request arrived is told the ones still open.
          if (roleOf(c) === 'owner') for (const p of pending.values()) send(c, IPC.relayHostedPeerPending, p.info)
        },
        onClose: () => ended(c, 'gone')
      })
    } catch (err) {
      conns.delete(c)
      throw err
    }
    return {
      bridged: false,
      close: () => {
        c.session?.close()
        ended(c, 'gone')
      }
    }
  }

  const stopNow = (): void => {
    epoch++
    const s = scheduler
    scheduler = null
    s?.stop() // closes every listener it holds, bridged ones included
    for (const c of [...conns]) {
      c.session?.close()
      ended(c, 'gone')
    }
    for (const id of [...pending.keys()]) closePending(id, 'gone')
  }

  async function startNow(my: number): Promise<HostedStartResult> {
    if (my !== epoch) return 'stopped'
    if (scheduler) return 'started'
    if (!team.exists()) return 'no-team'
    let k: KeyPair | null
    try {
      k = await loadHostKey(dir)
    } catch (err) {
      if (err instanceof HostKeyUnreadableError) {
        console.error('[hosted-team]', err.message)
        return 'host-key-unreadable'
      }
      throw err
    }
    if (!k) return 'no-team'
    await team.load()
    if (my !== epoch) return 'stopped'
    keys = k
    const hostKeys = k
    const addr = hostAddress(k)
    const s = createHostedScheduler(
      {
        mint: () =>
          mintHostToken({ apiBase: deps.apiBase, deviceId: deps.deviceId, hostPublicKeyB64: addr.hostPublicKeyB64, fetch: deps.fetch, now: wallNow }),
        open: (token, ev) => openListener(hostKeys, token, ev),
        setTimeout: (fn, ms) => setT(fn, ms),
        clearTimeout: (h) => clearT(h)
      },
      monoNow
    )
    scheduler = s
    s.start()
    return 'started'
  }

  const api: HostedService = {
    async init() {
      let created = false
      try {
        await createHostKey(dir)
        created = true
      } catch (err) {
        // A key already there (a second init, or one that won a concurrent race) is not an error.
        if ((err as { code?: unknown } | null)?.code !== 'E_HOST_KEY_EXISTS') throw err
      }
      if (!team.exists()) await team.update((d) => d)
      return { created }
    },
    start() {
      const my = epoch
      return onLifecycle(() => startNow(my))
    },
    stop() {
      stopNow()
    },
    async addOwner(pubkeyB64, label) {
      await team.update((d) =>
        upsertPeer(d, { pubkeyB64, label, role: 'owner', addedAt: new Date(wallNow()).toISOString(), addedBy: 'cli' })
      )
    },
    async remove(pubkeyB64, force) {
      let known = false
      // Decided inside the store's chain, so it reads the file even before start() loaded it.
      const r = await team.update((d) => {
        known = peerFor(d, pubkeyB64) !== undefined
        // Nothing to remove: 'last-owner' is the store's "write nothing"; `known` says which it was.
        return known ? removePeer(d, pubkeyB64, force) : 'last-owner'
      })
      if (!known) return 'unknown'
      if (r === 'last-owner') return 'last-owner'
      killRelayHostsByPeerKey(pubkeyB64, 'removed')
      // The kill ends them without the core's onClose; the bookkeeping is ours.
      for (const c of [...conns]) if (keyOf(c) === pubkeyB64) ended(c, 'gone')
      return 'removed'
    },
    async share(projectId, on) {
      await team.update((d) => setShared(d, projectId, on))
    },
    info() {
      if (!keys) return null
      const a = hostAddress(keys)
      return { relayEndpoint: deps.relayUrl, hostId: a.hostId, hostPublicKeyB64: a.hostPublicKeyB64, hostDeviceId: deps.deviceId, label: deps.hostLabel }
    },
    joinCode() {
      const i = api.info()
      return i ? encodeJoinCode({ v: 1, ...i, label: i.label.slice(0, JOIN_LABEL_MAX) }) : null
    },
    status() {
      const connected = new Set<string>()
      for (const c of conns) {
        const k = c.open ? keyOf(c) : null
        if (k) connected.add(k)
      }
      return {
        enabled: scheduler !== null,
        scheduler: scheduler?.status() ?? null,
        peers: team.current().peers.map((p) => ({ label: p.label, role: p.role, connected: connected.has(p.pubkeyB64) })),
        pending: [...pending.values()].map((p) => ({ ...p.info }))
      }
    },
    rotateKey() {
      return onLifecycle(async () => {
        stopNow()
        const my = epoch
        keys = await rotateHostKey(dir)
        await startNow(my)
      })
    }
  }
  return api
}
