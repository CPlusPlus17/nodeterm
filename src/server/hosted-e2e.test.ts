// The hosted team relay, end to end, on a REAL `startServer` boot (headless, no hooks, temp data dir).
//
// Every piece below has its own unit suite; this one proves they COMPOSE: the admin socket's `team`
// verbs drive the same service the relay listeners belong to, the access policy sees the node and
// project ids the real workspace store answers, the relay peer's requests reach the real platform
// handlers, and a viewer's terminal is the owner's live one. The flow:
//   team init → add-owner → share → the owner joins (auto-approved) and opens a terminal → a guest
//   knocks and waits → the owner approves it as a viewer → the viewer joins the owner's live
//   session, cannot start one, cannot write a file, cannot read the enclosing repository through git
//   → `team status` lists it as a connected viewer → `team unshare` silences its terminal.
//
// What is real and what is not:
//  - REAL: startServer and every core service it boots, the admin unix socket and its client, the
//    hosted service, the relay E2EE handshake and trust gates on both ends (core `connectRelayClient`
//    is the desktop joiner's own connector), the access policy, WorkspaceStore, PtyManager.
//  - FAKE: the relay server (an in-process transport pair per listener, `relayTestTransport`), the
//    host-token API (`relayTestFetch`), and `node-pty` (a recording fake — no process is spawned).
//    The server's terminals are plain shells here (settings.json `tmuxEnabled: false`), so the test
//    runs the same with or without tmux on the machine and leaves NO tmux session anywhere: there is
//    nothing to kill afterwards, and it never touches a tmux server (the vitest sandbox re-points
//    TMUX_TMPDIR regardless). A viewer's join is the in-process co-attach either way — the branch a
//    tmux-backed session takes too once its owner is attached.
//
// No sleeps: every step waits on an event it is owed (a transport the scheduler opened, a frame, an
// approval, pty bytes). `step()` puts a deadline on each wait ONLY so that a hang fails with that
// step's name instead of the test timeout; nothing ever waits on the clock to succeed.
//
// ONE startServer per file (see hosted-boot.test.ts: some core paths are memoized per process).
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from './index'
import { callTeamAdmin, type AdminInitResult, type AdminReply, type AdminStatusResult } from '../core/relay/team-admin'
import { transportPair } from '../core/relay/transport-pair'
import { connectRelayClient, type RelayClientSession } from '../core/relay/relay-client'
import { decodeJoinCode, type JoinCode } from '../core/relay/join-code'
import { genKeyPair, publicKeyToB64, type KeyPair } from '../core/relay/e2ee'
import type { RelayTransport } from '../core/relay/relay-socket'
import { IPC } from '../shared/ipc'
import type { CanvasNodeState, Project, PtyCreateResult, Workspace } from '../shared/types'

// A broken seam must fail HERE, never reach production. index.ts reads NODETERM_RELAY_URL at module
// load (hoisted above the imports): if `relayTestTransport` ever stopped being plumbed through, the
// listeners would dial this dead loopback port instead of the real relay. The mint's twin is the
// global-fetch trap below.
const env = vi.hoisted(() => {
  const prev = process.env.NODETERM_RELAY_URL
  process.env.NODETERM_RELAY_URL = 'ws://127.0.0.1:9/hosted-e2e-seam-missing'
  return { prev }
})

/** One recorded fake pty per spawn (the pty-coattach.test.ts harness): "spawned nothing" is
 *  `spawned.length`, "the viewer never sized it" is `resizes`, and `onDataCb` pushes output. */
interface FakePty {
  file: string
  args: string[]
  onDataCb?: (d: string) => void
  resizes: Array<{ cols: number; rows: number }>
}
const spawned = vi.hoisted(() => [] as FakePty[])

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    const p: FakePty = { file, args: [...(args ?? [])], resizes: [] }
    spawned.push(p)
    return {
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb
      },
      onExit: () => {},
      write: () => {},
      resize: (cols: number, rows: number) => p.resizes.push({ cols, rows }),
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 4242
    }
  }
}))
// Pin the plain-shell backend: a checkout that ran `npm run build` has the session-host bundle on
// disk (src/core/__fixtures__/no-session-host.ts says why a suite must SAY which backend it runs).
vi.mock('../core/session-host-backend', async () =>
  (await import('../core/__fixtures__/no-session-host')).noSessionHost()
)
// A machine with pty devices to spare, always: the spawn preflight reads the HOST's device count,
// and a busy host must not refuse the owner's terminal before our fake spawn is ever reached.
vi.mock('../core/pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

// A unix socket path is ~107 bytes at most: boot under a SHORT base so the admin socket fits.
const SHORT_BASE = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir()
const STEP_MS = 20_000

const SHARED = 'p-team'
const PRIVATE = 'p-private'
const LIVE = 'term-e2e-live' // the owner opens it
const IDLE = 'term-e2e-idle' // shared, but nobody runs it
const SECRET = 'term-e2e-secret' // in a project that is not shared

const pub = (k: KeyPair): string => publicKeyToB64(k.publicKey)

/** Fail with the step's NAME if its event never comes. A bound on a hang, never a success condition. */
function step<T>(name: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`step "${name}" never completed`)), STEP_MS)
  })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}

/** FIFO whose `next()` resolves as soon as an item is (or already was) pushed. */
function fifo<T>() {
  const items: T[] = []
  const waiters: Array<(v: T) => void> = []
  return {
    push(v: T): void {
      const w = waiters.shift()
      if (w) w(v)
      else items.push(v)
    },
    next(): Promise<T> {
      return items.length > 0 ? Promise.resolve(items.shift() as T) : new Promise<T>((r) => waiters.push(r))
    }
  }
}

type Frame = { t: string; id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string }; channel?: string; args?: unknown[] }

/** A teammate's desktop, as far as the host can tell: core `connectRelayClient` (what the desktop
 *  joiner runs) over one of the host's listeners. `pinned` = a bookmarked, already-approved host
 *  (auto-confirm); otherwise the human compares the SAS and confirms at once. */
function teammate(code: JoinCode, transport: RelayTransport, keys: KeyPair, pinned: boolean) {
  const frames: Frame[] = []
  const frameWaiters: Array<{ test: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []
  const byteWaiters: Array<{ sessionId: string; resolve: (d: string) => void }> = []
  /** Every terminal chunk received, in order: "received nothing" is as much a result as a chunk. */
  const received: Array<[string, string]> = []
  const denied: string[] = []
  let approve!: () => void
  const approved = new Promise<void>((r) => {
    approve = r
  })
  const waitFrame = (test: (f: Frame) => boolean): Promise<Frame> => {
    const seen = frames.find(test)
    return seen ? Promise.resolve(seen) : new Promise((resolve) => frameWaiters.push({ test, resolve }))
  }
  const c: RelayClientSession = connectRelayClient({
    url: code.relayEndpoint,
    token: 'relay-token',
    hostKeyB64: code.hostPublicKeyB64,
    ourKeys: keys,
    transport,
    autoApprove: pinned,
    onSas: (s) => {
      if (!pinned) s.confirm()
    },
    onApproved: () => approve(),
    onFrame: (json) => {
      const f = JSON.parse(json) as Frame
      frames.push(f)
      for (const w of [...frameWaiters]) {
        if (!w.test(f)) continue
        frameWaiters.splice(frameWaiters.indexOf(w), 1)
        w.resolve(f)
      }
    },
    onPtyData: (sessionId, data) => {
      received.push([sessionId, data])
      for (const w of [...byteWaiters]) {
        if (w.sessionId !== sessionId) continue
        byteWaiters.splice(byteWaiters.indexOf(w), 1)
        w.resolve(data)
      }
    },
    onClose: () => {},
    onDenied: (r) => denied.push(r)
  })
  let nextId = 1
  return {
    c,
    approved,
    denied,
    received,
    /** One RPC round trip over the E2EE tunnel. */
    call(method: string, args: unknown[] = []): Promise<Frame> {
      const id = nextId++
      const res = waitFrame((f) => f.t === 'res' && f.id === id)
      expect(c.send(JSON.stringify({ t: 'req', id, method, args })), `${method} sent`).toBe(true)
      return step(`${method} answered`, res)
    },
    /** The first event on `channel` whose payload passes `match` (one already received counts). */
    event(channel: string, match: (payload: Record<string, unknown>) => boolean = () => true): Promise<Frame> {
      return waitFrame((f) => f.t === 'ev' && f.channel === channel && match((f.args?.[0] ?? {}) as Record<string, unknown>))
    },
    /** The next terminal output for `sessionId`. */
    bytes(sessionId: string): Promise<string> {
      return new Promise((resolve) => byteWaiters.push({ sessionId, resolve }))
    }
  }
}

const terminalNode = (id: string, x: number): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x, y: 0 },
  size: { width: 600, height: 400 },
  title: id,
  color: '#0a84ff',
  group: null
})
const project = (id: string, nodes: CanvasNodeState[]): Project => ({
  id,
  name: id,
  color: '#0a84ff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes
})
/** The shared project is a FOLDER project: `cwd` is a subfolder of a real git repository (C1). */
const workspaceWith = (sharedCwd: string): Workspace => ({
  version: 2,
  activeProjectId: SHARED,
  projects: [
    { ...project(SHARED, [terminalNode(LIVE, 0), terminalNode(IDLE, 700)]), cwd: sharedCwd },
    project(PRIVATE, [terminalNode(SECRET, 0)])
  ]
})

/** A real repository with a committed secret OUTSIDE the shared subfolder: `repo/shared/` is what
 *  the team sees, `repo/secret/key.txt` is not. Outside the server's data dir on purpose (M7 would
 *  refuse a viewer anything in there for another reason). */
function repoWithSecret(base: string): { repo: string; shared: string } {
  const repo = path.join(base, 'repo')
  fs.mkdirSync(path.join(repo, 'shared'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'secret'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'shared', 'a.txt'), 'shared file\n')
  fs.writeFileSync(path.join(repo, 'secret', 'key.txt'), 'TOPSECRET\n')
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      stdio: 'ignore'
    })
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { repo, shared: path.join(repo, 'shared') }
}

async function admin<T>(dataDir: string, req: Parameters<typeof callTeamAdmin>[1]): Promise<T> {
  const r: AdminReply = await step(`team ${req.cmd}`, callTeamAdmin(dataDir, req))
  if (!r.ok) throw new Error(`team ${req.cmd} failed: ${r.error}`)
  return r.result as T
}

// Torn down whatever happened, a hang included: a test that times out never reaches its own finally.
const teardown: Array<() => void | Promise<void>> = []
// The hook outlives one step deadline, so a teardown that runs into it still lets the rest run.
afterEach(async () => {
  for (const f of teardown.splice(0).reverse()) {
    try {
      await f()
    } catch (err) {
      console.warn('[hosted-e2e] teardown step failed', err)
    }
  }
}, 2 * STEP_MS)
afterAll(() => {
  vi.unstubAllGlobals()
  if (env.prev === undefined) delete process.env.NODETERM_RELAY_URL
  else process.env.NODETERM_RELAY_URL = env.prev
})

// The admin channel is a unix socket, which Windows does not have (team-admin.ts refuses it by
// name there), so no hosted team can be set up on that platform. Linux and macOS run it.
describe.skipIf(process.platform === 'win32')('hosted team relay, end to end on a headless server', () => {
  it('admin setup → owner auto-approved → guest waits → approved as viewer → watches the owner’s terminal, starts none, writes nothing', async () => {
    spawned.length = 0
    const dataDir = fs.mkdtempSync(path.join(SHORT_BASE, 'nthe-'))
    teardown.push(() => fs.rmSync(dataDir, { recursive: true, force: true }))
    // Plain-shell terminals (see the header), from the server's own settings file.
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ tmuxEnabled: false }))

    // The relay: each listener the scheduler opens is one in-process transport pair, and its peer end
    // is handed to whichever teammate connects next — the relay's pairing, minus the network.
    const listeners = fifo<RelayTransport>()
    const relayTestTransport = (): RelayTransport => {
      const { hostT, peerT } = transportPair()
      listeners.push(peerT)
      return hostT
    }
    // The host-token API. A token good for an hour, so no listener refresh lands mid-test.
    const mints: Array<{ url: string; body: { deviceId?: string; hostPublicKeyB64?: string } }> = []
    const relayTestFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      mints.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(
        JSON.stringify({ pairingToken: 'relay-token', hostId: 'H', exp: Math.floor(Date.now() / 1000) + 3600 }),
        { status: 200, headers: { date: new Date().toUTCString() } }
      )
    }) as typeof fetch
    // The mint's production twin of the relay trap above: if `relayTestFetch` stopped being plumbed
    // through, the mint would fall back to the global fetch — which refuses here instead of minting
    // a host token against the real API.
    const globalHostTokenCalls: string[] = []
    vi.stubGlobal('fetch', (async (url: string | URL | Request) => {
      if (String(url).includes('/v1/relay/')) globalHostTokenCalls.push(String(url))
      throw new Error('hosted-e2e: the global fetch is not used in this test')
    }) as typeof fetch)

    // The shared project's folder: a subfolder of a real repository, in its own temp dir.
    const repoBase = fs.mkdtempSync(path.join(SHORT_BASE, 'nther-'))
    teardown.push(() => fs.rmSync(repoBase, { recursive: true, force: true }))
    const { shared: sharedCwd } = repoWithSecret(repoBase)

    const booting = startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      headless: true,
      // Never touch the developer's real agent configs (see ServerConfig.installHooks).
      installHooks: false,
      relayTestTransport,
      relayTestFetch
    })
    // Registered BEFORE the boot is awaited: a boot that outlives its step deadline is still closed
    // once it lands, instead of leaking a server (and its admin socket) into the next test. The wait
    // is itself a step: a boot that never settles must not hang afterEach, or the teardowns
    // registered before this one (the repository and data dirs) would never run.
    teardown.push(() => step('server teardown', booting.catch(() => null).then((s) => s?.close())))
    const srv = await step('server boot', booting)
    // After the boot, so the log sink the server installs is what this spy calls through to.
    const warn = vi.spyOn(console, 'warn')
    teardown.push(() => warn.mockRestore())

    // ---- 1. The admin socket sets the team up, and hosting starts.
    const init = await admin<AdminInitResult>(dataDir, { cmd: 'init' })
    expect(init).toMatchObject({ created: true, start: 'started' })
    // What a teammate is given: a code that decodes, whose host id derives from its host key.
    const code = decodeJoinCode(init.joinCode ?? '')
    expect(code).not.toBeNull()
    if (!code) return
    expect(code.hostPublicKeyB64).toBe(init.info?.hostPublicKeyB64)

    const ownerKeys = genKeyPair()
    await admin(dataDir, { cmd: 'add-owner', pubkey: pub(ownerKeys), label: 'Owner' })
    await admin(dataDir, { cmd: 'share', projectId: SHARED, on: true })

    // ---- 2. The owner connects: a team member, so the host approves it without a human.
    const owner = teammate(code, await step('first listener', listeners.next()), ownerKeys, true)
    teardown.push(() => owner.c.close())
    await step('owner approved', owner.approved)
    // The host minted that listener's token for THIS host key, through the seam.
    expect(mints[0]).toMatchObject({
      url: expect.stringMatching(/\/v1\/relay\/host-token$/),
      body: { hostPublicKeyB64: code.hostPublicKeyB64, deviceId: code.hostDeviceId }
    })

    // The owner puts the canvas on this core and opens one terminal: that session is now live.
    expect(await owner.call(IPC.workspaceSave, [workspaceWith(sharedCwd)])).toMatchObject({ ok: true })
    const opened = await owner.call(IPC.ptyCreate, [{ cols: 120, rows: 40, persistKey: LIVE }])
    expect(opened).toMatchObject({ ok: true, result: { fresh: true } })
    const ownerSessionId = (opened.result as PtyCreateResult).sessionId
    expect(ownerSessionId).not.toBe('')
    expect(spawned).toHaveLength(1)
    // A plain shell, never a tmux client: there is no tmux session to clean up after this test.
    expect(path.basename(spawned[0].file)).not.toBe('tmux')
    expect(spawned[0].args).not.toContain('new-session')

    // ---- 3. A guest knocks. It waits; only the owner hears of it, with the SAS the guest sees.
    const guestKeys = genKeyPair()
    const knock = owner.event(IPC.relayHostedPeerPending)
    const guest = teammate(code, await step('second listener', listeners.next()), guestKeys, false)
    teardown.push(() => guest.c.close())
    const pending = (await step('owner told of the guest', knock)).args?.[0] as { pendingId: string; sas: string; peerKeyB64: string }
    expect(pending.peerKeyB64).toBe(pub(guestKeys))
    expect(pending.sas).toBe(guest.c.sas())
    expect(guest.c.isOpen()).toBe(false)
    const waiting = await admin<AdminStatusResult>(dataDir, { cmd: 'status' })
    expect(waiting.pending.map((p) => p.pendingId)).toEqual([pending.pendingId])
    expect(waiting.peers).toEqual([{ label: 'Owner', role: 'owner', connected: true }])

    // ---- 4. The owner approves the guest as a VIEWER.
    expect(await owner.call(IPC.relayHostedApprove, [pending.pendingId, 'viewer'])).toMatchObject({ ok: true, result: true })
    await step('guest approved', guest.approved)

    // ---- 5. The viewer watches the owner's live terminal: the same session, not a new one.
    const joined = await guest.call(IPC.ptyCreate, [{ cols: 80, rows: 24, persistKey: LIVE }])
    expect(joined).toMatchObject({ ok: true, result: { sessionId: ownerSessionId, fresh: false } })
    expect((joined.result as PtyCreateResult).unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    // Joined as a non-voting view: the viewer's smaller window never resized the shared pty.
    expect(spawned[0].resizes).toEqual([])
    // …and the owner's session output reaches it.
    const out = guest.bytes(ownerSessionId)
    spawned[0].onDataCb?.('hello from the owner\r\n')
    expect(await step('viewer receives the owner’s output', out)).toContain('hello from the owner')

    // It can watch a running terminal but never start one: the idle node is refused, nothing spawns.
    expect(await guest.call(IPC.ptyCreate, [{ cols: 80, rows: 24, persistKey: IDLE }])).toMatchObject({
      ok: true,
      result: { sessionId: '', unavailable: 'join-only' }
    })
    expect(spawned).toHaveLength(1)
    // A terminal in a project nobody shared is not reachable at all, and the refusal is the access
    // policy's own sentence (not some other E_ROLE).
    expect(await guest.call(IPC.ptyCreate, [{ cols: 80, rows: 24, persistKey: SECRET }])).toMatchObject({
      ok: false,
      error: { code: 'E_ROLE', message: 'Viewers can only watch terminals in a shared project that are already running.' }
    })
    expect(spawned).toHaveLength(1)
    // Its workspace is the shared project only.
    const ws = await guest.call(IPC.workspaceLoad)
    expect(ws).toMatchObject({ ok: true, result: { activeProjectId: SHARED } })
    expect((ws.result as Workspace).projects.map((p) => p.id)).toEqual([SHARED])

    // ---- 6. A viewer cannot write a file.
    const target = path.join(dataDir, 'written-by-a-viewer.txt')
    expect(await guest.call(IPC.fsWrite, [target, 'x'])).toMatchObject({
      ok: false,
      error: { code: 'E_ROLE', message: "Viewers can't do that here. Ask an owner for Editor access." }
    })
    expect(fs.existsSync(target)).toBe(false)

    // ---- 6b. Git (C1): the shared folder is a SUBFOLDER of a repository. `git show HEAD:<path>`
    // resolves the path against the repository's top level, so the real handler hands the owner the
    // secret outside the shared folder — which is exactly why a viewer is refused git there. Its
    // files are still readable.
    const showSecret = [sharedCwd, 'HEAD', 'secret/key.txt']
    expect(await owner.call(IPC.gitShowFile, showSecret)).toMatchObject({ ok: true, result: 'TOPSECRET' })
    const gitRefusal =
      'Git is available to viewers only in a project that is the top folder of its own repository, never in a subfolder of a larger one.'
    expect(await guest.call(IPC.gitShowFile, showSecret)).toMatchObject({ ok: false, error: { code: 'E_ROLE', message: gitRefusal } })
    expect(await guest.call(IPC.gitStatus, [sharedCwd])).toMatchObject({ ok: false, error: { code: 'E_ROLE', message: gitRefusal } })
    expect(await guest.call(IPC.fsRead, [path.join(sharedCwd, 'a.txt')])).toMatchObject({ ok: true })
    // Its own view of itself says so.
    expect(await guest.call(IPC.relayHostedSelf)).toMatchObject({ ok: true, result: { role: 'viewer' } })

    // ---- 7. `team status`: the guest is a connected viewer; nothing is waiting.
    const status = await admin<AdminStatusResult>(dataDir, { cmd: 'status' })
    expect(status).toMatchObject({ enabled: true, off: null, pending: [] })
    expect(status.peers).toEqual([
      { label: 'Owner', role: 'owner', connected: true },
      { label: '', role: 'viewer', connected: true }
    ])
    expect(owner.denied).toEqual([])
    expect(guest.denied).toEqual([])

    // ---- 7b. `team unshare`: the viewer stays connected, but the terminal it is already watching
    // goes quiet for it at once (R45); its owner keeps the output. The session's node is looked up
    // through the real PtyManager on every frame.
    await admin(dataDir, { cmd: 'share', projectId: SHARED, on: false })
    const ownerAfterUnshare = owner.bytes(ownerSessionId)
    spawned[0].onDataCb?.('after the unshare\r\n')
    expect(await step('owner receives output after the unshare', ownerAfterUnshare)).toContain('after the unshare')
    // One round trip on the viewer's own tunnel: anything sent to it before this answer has arrived.
    expect(await guest.call(IPC.relayHostedSelf)).toMatchObject({ ok: true, result: { role: 'viewer' } })
    expect(guest.received.map(([, d]) => d).join('')).toContain('hello from the owner')
    expect(guest.received.map(([, d]) => d).join('')).not.toContain('after the unshare')

    // ---- 8. The viewer's desktop goes away: its membership stays, its connection does not, and the
    // owner's terminal keeps running for the owner.
    const left = owner.event(IPC.presencePeer, (d) => d.op === 'leave')
    guest.c.close()
    await step('owner told the viewer left', left)
    const after = await admin<AdminStatusResult>(dataDir, { cmd: 'status' })
    expect(after.peers).toEqual([
      { label: 'Owner', role: 'owner', connected: true },
      { label: '', role: 'viewer', connected: false }
    ])
    // An ordinary disconnect is not a dead socket: no send to the leaver was counted as a failure.
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[ui-sink]'))).toEqual([])
    const stillThere = owner.bytes(ownerSessionId)
    spawned[0].onDataCb?.('still running\r\n')
    expect(await step('owner still receives output', stillThere)).toContain('still running')

    // Nothing ever went around the seams.
    expect(globalHostTokenCalls).toEqual([])
  }, 90_000)
})
