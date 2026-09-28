// src/main/remote/hosted-join.test.ts
// The desktop joiner's whole sequence (join code → device token → client token → connect) as a pure
// function: mint discipline, the joiner-side pin, auto-confirm, and the denial reason. The first
// block drives a fake connect so every option handed to the relay client is observable; the second
// runs the real core client against the real hosted service over an in-process transport.
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { joinHostedTeam, connectHostedTeam, HostedJoinError, type HostedJoinDeps, type HostedJoinEvents, type HostedConnectOptions, type HostedJoinFailure } from './hosted-join'
import { joinErrorCode } from '../../shared/relay-join-errors'
import { BookmarkStore, type RelayBookmark } from './relay-bookmarks'
import { encodeJoinCode, type JoinCode } from '../../core/relay/join-code'
import { hostIdFromPublicKeyB64 } from '../../core/relay/relay-id'
import { genKeyPair, publicKeyToB64, type KeyPair } from '../../core/relay/e2ee'
import { connectRelayClient, type RelayClientSession } from '../../core/relay/relay-client'
import { createHostedService, type HostedService } from '../../core/relay/hosted-service'
import { transportPair } from '../../core/relay/transport-pair'
import type { PeerAttach } from '../../core/relay/relay-host'
import type { RelayTransport } from '../../core/relay/relay-socket'
import { IPC } from '../../shared/ipc'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-join-'))
const pub = (k: KeyPair) => publicKeyToB64(k.publicKey)

function codeFor(hostKeys: KeyPair, over: Partial<JoinCode> = {}): JoinCode {
  const k = pub(hostKeys)
  return { v: 1, relayEndpoint: 'wss://relay.example', hostId: hostIdFromPublicKeyB64(k), hostPublicKeyB64: k, hostDeviceId: 'host-dev', label: 'box', ...over }
}

/** An API that answers each route from its own queue (last answer repeats) and records every call. */
function api(routes: { device?: Array<[number, unknown]>; join?: Array<[number, unknown]> }) {
  const calls: Array<{ route: 'device' | 'join'; body: Record<string, unknown> }> = []
  const queues = { device: [...(routes.device ?? [])], join: [...(routes.join ?? [])] }
  const f = (async (url: string, init: RequestInit) => {
    const route = url.endsWith('/v1/relay/device') ? 'device' : url.endsWith('/v1/relay/join') ? 'join' : null
    if (!route) throw new Error(`unexpected ${url}`)
    calls.push({ route, body: JSON.parse(String(init.body)) })
    const q = queues[route]
    const [status, body] = (q.length > 1 ? q.shift() : q[0]) ?? [500, {}]
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { f, calls, count: (r: 'device' | 'join') => calls.filter((c) => c.route === r).length }
}
const DEVICE_OK = (t = 'DT'): [number, unknown] => [200, { deviceToken: t, hostId: 'H', exp: 1 }]
const JOIN_OK: [number, unknown] = [200, { pairingToken: 'PT', hostId: 'H', relayEndpoint: 'wss://relay.from-api', exp: 1 }]

/** A connect that records what it was given and hands back a session the test can inspect. */
function fakeConnect() {
  const opened: HostedConnectOptions[] = []
  const sessions: Array<RelayClientSession & { closed: boolean }> = []
  const connect = (o: HostedConnectOptions): RelayClientSession => {
    opened.push(o)
    const s = { closed: false, sas: () => '123 456', peerKeyB64: () => o.hostKeyB64, confirm: () => {}, send: () => true, isOpen: () => false, close() { this.closed = true } }
    sessions.push(s)
    return s
  }
  return { connect, opened, sessions, last: () => opened[opened.length - 1] }
}

function events() {
  const log: string[] = []
  const closed: Array<string | undefined> = []
  const ev: HostedJoinEvents = {
    onSas: (s) => log.push(`sas:${s}`),
    onApproved: () => log.push('approved'),
    onFrame: (j) => log.push(`frame:${j}`),
    onPtyData: (id, d) => log.push(`pty:${id}:${d}`),
    onClosed: (r) => closed.push(r)
  }
  return { ev, log, closed }
}

function setup(opts: { routes?: Parameters<typeof api>[0]; bookmarks?: RelayBookmark[]; loadKeys?: () => Promise<KeyPair> } = {}) {
  const dir = tmpDir()
  const store = new BookmarkStore(path.join(dir, 'relay-bookmarks.json'))
  if (opts.bookmarks) fs.writeFileSync(path.join(dir, 'relay-bookmarks.json'), JSON.stringify(opts.bookmarks))
  const a = api(opts.routes ?? { device: [DEVICE_OK()], join: [JOIN_OK] })
  const c = fakeConnect()
  const ourKeys = genKeyPair()
  const deps: HostedJoinDeps = {
    apiBase: 'https://api', deviceId: () => 'my-device', label: 'laptop',
    bookmarks: store, loadKeys: opts.loadKeys ?? (async () => ourKeys), connect: c.connect, fetch: a.f,
    now: () => Date.parse('2026-09-29T10:00:00Z')
  }
  return { store, file: path.join(dir, 'relay-bookmarks.json'), api: a, c, deps, ourKeys }
}

const hostKeys = genKeyPair()
const code = codeFor(hostKeys)
const codeText = encodeJoinCode(code)
const bookmark = (over: Partial<RelayBookmark> = {}): RelayBookmark =>
  ({ hostId: code.hostId, code: codeText, label: 'box', deviceToken: 'OLD', approvedAt: null, source: 'code', ...over })

describe('joinHostedTeam', () => {
  it('refuses an invalid code before touching the network or the keys', async () => {
    const loadKeys = vi.fn(async () => genKeyPair())
    const s = setup({ loadKeys })
    const tampered = encodeJoinCode({ ...code, hostId: 'x'.repeat(22) })
    await expect(joinHostedTeam(tampered, s.deps, events().ev)).rejects.toMatchObject({ kind: 'invalid-code', message: '[E_JOIN_BAD_CODE] That team code is invalid.' })
    expect(s.api.calls).toEqual([])
    expect(loadKeys).not.toHaveBeenCalled()
    expect(s.c.opened).toEqual([])
  })

  it('first join: mints once with the free-tier body, connects with the host key pinned and NO pin store', async () => {
    const s = setup()
    const e = events()
    const session = await joinHostedTeam(codeText, s.deps, e.ev)
    expect(s.api.calls).toEqual([
      // R34: one device id PER TEAM, so joining a second team never re-registers the first's row.
      { route: 'device', body: { deviceId: `my-device:${code.hostId}`, hostDeviceId: 'host-dev', hostPublicKeyB64: code.hostPublicKeyB64, label: 'laptop' } },
      { route: 'join', body: { deviceToken: 'DT' } }
    ])
    const o = s.c.last()
    expect(o.url).toBe('wss://relay.from-api')
    expect(o.token).toBe('PT')
    expect(o.hostKeyB64).toBe(code.hostPublicKeyB64)
    expect(o.ourKeys).toBe(s.ourKeys)
    expect(o.autoApprove).toBe(false)
    // R33: a hosted host key never reaches the desktop's approved-devices store.
    expect('pins' in o).toBe(false)
    expect(session).toBe(s.c.sessions[0])
    // The bookmark keeps the token (so the next connect spends no mint) and is not yet approved.
    expect(await s.store.list()).toEqual([{ hostId: code.hostId, code: codeText, label: 'box', deviceToken: 'DT', approvedAt: null, source: 'code' }])
  })

  it('forwards the SAS, frames, pty data and a plain close (no reason)', async () => {
    const s = setup()
    const e = events()
    await joinHostedTeam(codeText, s.deps, e.ev)
    const o = s.c.last()
    o.onSas(s.c.sessions[0])
    o.onFrame('{"t":"ev"}')
    o.onPtyData('p1', 'hi')
    o.onClose()
    expect(e.log).toEqual(['sas:123 456', 'frame:{"t":"ev"}', 'pty:p1:hi'])
    expect(e.closed).toEqual([undefined])
  })

  it('records the approval as the joiner-side pin, once', async () => {
    const s = setup()
    const e = events()
    await joinHostedTeam(codeText, s.deps, e.ev)
    s.c.last().onApproved(s.c.sessions[0])
    await vi.waitFor(async () => expect((await s.store.list())[0]?.approvedAt).toBe('2026-09-29T10:00:00.000Z'))
    expect(e.log).toEqual(['approved'])
  })

  it('reuses a bookmarked device token: no device mint', async () => {
    const s = setup({ bookmarks: [bookmark()] })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.api.calls).toEqual([{ route: 'join', body: { deviceToken: 'OLD' } }])
    expect(s.c.last().autoApprove).toBe(false)
  })

  it('auto-confirms only when the bookmark is approved AND carries the same host key', async () => {
    const s = setup({ bookmarks: [bookmark({ approvedAt: '2026-09-01T00:00:00Z' })] })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.c.last().autoApprove).toBe(true)
    // The recorded approval is kept, not rewritten, on a pinned reconnect.
    s.c.last().onApproved(s.c.sessions[0])
    await new Promise((r) => setTimeout(r, 20))
    expect((await s.store.list())[0].approvedAt).toBe('2026-09-01T00:00:00Z')
  })

  it('a known hostId whose code now carries a different key string never auto-approves, and its token is not reused', async () => {
    // A non-canonical base64 spelling of the same 32 bytes: same hostId, different key string. The
    // rule compares the key the code carries with the key the bookmark was approved for, exactly.
    // 32 bytes encode as 43 characters + '=', and the last of those carries 2 unused low bits.
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const k = code.hostPublicKeyB64
    const alt = k.slice(0, -2) + B64[B64.indexOf(k[k.length - 2]) ^ 1] + k.slice(-1)
    expect(hostIdFromPublicKeyB64(alt)).toBe(code.hostId)
    expect(alt).not.toBe(k)
    const s = setup({ bookmarks: [bookmark({ approvedAt: '2026-09-01T00:00:00Z' })] })
    await joinHostedTeam(encodeJoinCode({ ...code, hostPublicKeyB64: alt }), s.deps, events().ev)
    expect(s.c.last().autoApprove).toBe(false)
    expect(s.api.count('device')).toBe(1)
    expect((await s.store.list())[0]).toMatchObject({ deviceToken: 'DT', approvedAt: null })
  })

  it('a bookmark whose stored code no longer decodes is not trusted either', async () => {
    const s = setup({ bookmarks: [bookmark({ code: 'nodeterm://join?code=junk', approvedAt: '2026-09-01T00:00:00Z' })] })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.c.last().autoApprove).toBe(false)
  })

  it('bad-token on a bookmarked token: re-mints ONCE, persists it, and joins with it', async () => {
    const s = setup({ bookmarks: [bookmark()], routes: { device: [DEVICE_OK('NEW')], join: [[401, {}], JOIN_OK] } })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.api.calls.map((c) => `${c.route}:${c.body.deviceToken ?? ''}`)).toEqual(['join:OLD', 'device:', 'join:NEW'])
    expect((await s.store.list())[0].deviceToken).toBe('NEW')
  })

  it('bad-token again after the re-mint: gives up with no second re-mint', async () => {
    const s = setup({ bookmarks: [bookmark()], routes: { device: [DEVICE_OK('NEW')], join: [[401, {}]] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'bad-token' })
    expect(s.api.count('device')).toBe(1)
    expect(s.api.count('join')).toBe(2)
    expect(s.c.opened).toEqual([])
    // The fresh token is kept: a later attempt starts from it rather than minting again first.
    expect((await s.store.list())[0].deviceToken).toBe('NEW')
  })

  it('bad-token on a token minted in THIS attempt: no re-mint at all (at most one mint per attempt)', async () => {
    const s = setup({ routes: { device: [DEVICE_OK()], join: [[401, {}]] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'bad-token' })
    expect(s.api.count('device')).toBe(1)
    expect(s.api.count('join')).toBe(1)
  })

  it('revoked: the honest message, and no re-mint', async () => {
    const s = setup({ bookmarks: [bookmark()], routes: { join: [[403, { error: 'revoked' }]] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'revoked', message: "[E_JOIN_REVOKED] This device's relay access was revoked." })
    expect(s.api.count('device')).toBe(0)
  })

  it('device mint failures each say what happened and connect nothing', async () => {
    for (const [status, kind] of [[429, 'rate-limited'], [403, 'refused'], [502, 'network']] as const) {
      const s = setup({ routes: { device: [[status, {}]] } })
      const err = await joinHostedTeam(codeText, s.deps, events().ev).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostedJoinError)
      expect(err).toMatchObject({ kind })
      expect(s.api.count('join')).toBe(0)
      expect(s.c.opened).toEqual([])
      expect(await s.store.list()).toEqual([])
    }
  })

  it('a join that fails after a fresh mint keeps the minted token, so the retry spends no second mint', async () => {
    const s = setup({ routes: { device: [DEVICE_OK()], join: [[503, {}]] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'network' })
    expect((await s.store.list())[0].deviceToken).toBe('DT')
    const retry = setup({ bookmarks: await s.store.list() })
    await joinHostedTeam(codeText, retry.deps, events().ev)
    expect(retry.api.count('device')).toBe(0)
  })

  it('a locked keyring rejects before any mint is spent', async () => {
    const s = setup({ loadKeys: async () => { throw Object.assign(new Error('keyring locked'), { code: 'E_PEER_KEY_LOCKED' }) } })
    const err = await joinHostedTeam(codeText, s.deps, events().ev).catch((e: Error) => e)
    // The loader's own sentence is kept (it tells the human to unlock and reconnect), behind the code.
    expect((err as Error).message).toBe('[E_JOIN_KEY_LOCKED] keyring locked')
    expect(s.api.calls).toEqual([])
  })

  it('R34: two teams get two device ids, both derived from this machine\'s', async () => {
    const other = codeFor(genKeyPair(), { hostDeviceId: 'other-host-dev' })
    const s = setup()
    await joinHostedTeam(codeText, s.deps, events().ev)
    await joinHostedTeam(encodeJoinCode(other), s.deps, events().ev)
    const ids = s.api.calls.filter((c) => c.route === 'device').map((c) => c.body.deviceId)
    expect(ids).toEqual([`my-device:${code.hostId}`, `my-device:${other.hostId}`])
    expect(ids[0]).not.toBe(ids[1])
    expect(String(ids[0]).length).toBeLessThanOrEqual(200) // the backend's deviceId limit
  })

  it('R35: every failure kind carries its stable code, readable through Electron\'s wrapper', () => {
    const expected: Record<HostedJoinFailure, string> = {
      'invalid-code': 'E_JOIN_BAD_CODE',
      'rate-limited': 'E_JOIN_RATE',
      refused: 'E_JOIN_REFUSED',
      // A token the service will not accept even fresh: retrying only spends mints, so it stops.
      'bad-token': 'E_JOIN_REFUSED',
      network: 'E_JOIN_NETWORK',
      revoked: 'E_JOIN_REVOKED',
      'key-locked': 'E_JOIN_KEY_LOCKED'
    }
    for (const [kind, codeName] of Object.entries(expected) as Array<[HostedJoinFailure, string]>) {
      const e = new HostedJoinError(kind)
      expect(e.message.startsWith(`[${codeName}] `)).toBe(true)
      expect(e.code).toBe(codeName)
      expect(joinErrorCode(`Error invoking remote method 'relay:client:connect': Error: ${e.message}`)).toBe(codeName)
    }
  })

  it('R35: a connect that throws synchronously is a network failure', async () => {
    const s = setup()
    const connect = () => { throw new Error('Invalid URL') }
    await expect(joinHostedTeam(codeText, { ...s.deps, connect }, events().ev)).rejects.toMatchObject({ message: '[E_JOIN_NETWORK] Invalid URL' })
  })

  it('R36(4): a relay endpoint from the API that is not wss (or loopback ws) is never dialed', async () => {
    const s = setup({ routes: { device: [DEVICE_OK()], join: [[200, { pairingToken: 'PT', hostId: 'H', relayEndpoint: 'ws://evil.example', exp: 1 }]] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'network', message: expect.stringMatching(/^\[E_JOIN_NETWORK\] /) })
    expect(s.c.opened).toEqual([])
  })

  it('R36(3): an approval never overwrites a token a concurrent attempt re-minted meanwhile', async () => {
    const s = setup({ bookmarks: [bookmark()] })
    await joinHostedTeam(codeText, s.deps, events().ev) // this session uses 'OLD'
    await s.store.upsert(bookmark({ deviceToken: 'REMINTED' })) // another attempt's fresh token
    s.c.last().onApproved(s.c.sessions[0])
    await vi.waitFor(async () => expect((await s.store.list())[0].approvedAt).toBe('2026-09-29T10:00:00.000Z'))
    expect((await s.store.list())[0].deviceToken).toBe('REMINTED')
  })

  it('R36(2): a bookmark write that fails is logged once, naming the host and never a token or the code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const s = setup({ routes: { device: [DEVICE_OK('MINTED-TOKEN-XYZ')], join: [JOIN_OK] } })
      // A corrupt file holding a token: writes refuse it (its trust state is unknown).
      // Shaped so that V8's JSON.parse error would quote the token, were it ever passed through.
      fs.writeFileSync(s.file, '[{"deviceToken": SECRET-TOKEN}]')
      await joinHostedTeam(codeText, s.deps, events().ev)
      s.c.last().onApproved(s.c.sessions[0])
      s.c.last().onDenied?.('removed')
      await vi.waitFor(() => expect(warn.mock.calls.length).toBeGreaterThanOrEqual(3))
      for (const call of warn.mock.calls) {
        const line = call.map(String).join(' ')
        expect(line).toContain(code.hostId)
        expect(line).not.toContain('SECRET')
        expect(line).not.toContain('MINTED-TOKEN') // the device token minted in this attempt
        expect(line).not.toContain('nodeterm://join')
        expect(line).not.toContain(codeText.slice('nodeterm://join?code='.length, 40))
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('a denial is passed to onClosed and withdraws the joiner-side pin', async () => {
    for (const reason of ['denied', 'removed', 'expired'] as const) {
      const s = setup({ bookmarks: [bookmark({ approvedAt: '2026-09-01T00:00:00Z' })] })
      const e = events()
      await joinHostedTeam(codeText, s.deps, e.ev)
      const o = s.c.last()
      o.onDenied?.(reason)
      o.onClose()
      expect(e.closed).toEqual([reason])
      await vi.waitFor(async () => expect((await s.store.list())[0].approvedAt).toBeNull())
      // The device token survives: a denial is about this approval, not the relay credential.
      expect((await s.store.list())[0].deviceToken).toBe('OLD')
    }
  })

  it('an approval or denial never brings back a bookmark the user removed meanwhile', async () => {
    const s = setup()
    await joinHostedTeam(codeText, s.deps, events().ev)
    await s.store.remove(code.hostId)
    s.c.last().onApproved(s.c.sessions[0])
    s.c.last().onDenied?.('removed')
    await new Promise((r) => setTimeout(r, 20))
    expect(await s.store.list()).toEqual([])
  })
})

describe('connectHostedTeam (the relay:client:connect leg for a join code)', () => {
  function io() {
    const sent: Array<[string, ...unknown[]]> = []
    const sessions = new Map<string, RelayClientSession>()
    return { sent, sessions, io: { newId: () => 'c1', send: (ch: string, ...args: unknown[]) => { sent.push([ch, ...args]) }, sessions } }
  }

  it('routes every event to the connection\'s channels and registers the session', async () => {
    const s = setup()
    const x = io()
    expect(await connectHostedTeam(codeText, s.deps, x.io)).toBe('c1')
    expect(x.sessions.get('c1')).toBe(s.c.sessions[0])
    const o = s.c.last()
    o.onSas(s.c.sessions[0])
    o.onApproved(s.c.sessions[0])
    o.onFrame('{"t":"res"}')
    o.onPtyData('p1', 'out')
    expect(x.sent).toEqual([
      [IPC.relayClientSas('c1'), '123 456'],
      [IPC.relayClientApproved('c1')],
      [IPC.relayClientFrame('c1'), '{"t":"res"}'],
      [IPC.ptyData('p1'), 'out']
    ])
  })

  it('a close carries the host\'s refusal reason and unregisters the session', async () => {
    const s = setup()
    const x = io()
    await connectHostedTeam(codeText, s.deps, x.io)
    s.c.last().onDenied?.('expired')
    s.c.last().onClose()
    expect(x.sent).toEqual([[IPC.relayClientClosed('c1'), 'expired']])
    expect(x.sessions.has('c1')).toBe(false)
  })

  it('a plain close sends no reason', async () => {
    const s = setup()
    const x = io()
    await connectHostedTeam(codeText, s.deps, x.io)
    s.c.last().onClose()
    expect(x.sent).toEqual([[IPC.relayClientClosed('c1'), undefined]])
  })

  it('a session that closed before the join returned is never registered', async () => {
    const s = setup()
    const x = io()
    const connect = (o: HostedConnectOptions): RelayClientSession => {
      const session = s.c.connect(o)
      o.onClose()
      return session
    }
    await connectHostedTeam(codeText, { ...s.deps, connect }, x.io)
    expect(x.sessions.size).toBe(0)
    expect(x.sent).toEqual([[IPC.relayClientClosed('c1'), undefined]])
  })

  it('R35: a failure that is not ours still leaves with a stable code', async () => {
    const s = setup()
    const x = io()
    const deviceId = () => { throw new Error('platform not initialised') }
    await expect(connectHostedTeam(codeText, { ...s.deps, deviceId }, x.io)).rejects.toThrow(/^\[E_JOIN_NETWORK\] platform not initialised$/)
    expect(x.sessions.size).toBe(0)
  })

  it('a failed join registers nothing and rejects with the human message', async () => {
    const s = setup({ routes: { device: [[429, {}]] } })
    const x = io()
    await expect(connectHostedTeam(codeText, s.deps, x.io)).rejects.toThrow('[E_JOIN_RATE] Too many join attempts for this team today. Try again tomorrow.')
    expect(x.sessions.size).toBe(0)
    expect(x.sent).toEqual([])
  })
})

// ── End to end: the real core relay client against the real hosted service. ──────────────────────

const live: Array<{ svc: HostedService; dir: string }> = []
afterEach(() => {
  for (const w of live.splice(0)) {
    w.svc.stop()
    fs.rmSync(w.dir, { recursive: true, force: true })
  }
})

function hostedWorld() {
  const dir = tmpDir()
  const peersT: RelayTransport[] = []
  let next = 1
  const attach: PeerAttach = {
    attach: () => next++,
    detach: () => {},
    dispatch: async (_id, req) => ({ t: 'res', id: req.id, ok: true, result: null }),
    cast: () => {}
  }
  const svc = createHostedService({
    dataDir: dir, apiBase: 'https://api', relayUrl: 'ws://127.0.0.1/r', deviceId: 'host-dev', hostLabel: 'box',
    attach, projectOfNode: () => 'P', projectCwd: () => '/srv/app',
    fetch: (async () => new Response(JSON.stringify({ pairingToken: 'T', hostId: 'H', exp: 0 }), { status: 200 })) as typeof fetch,
    transport: () => { const { hostT, peerT } = transportPair(); peersT.push(peerT); return hostT }
  })
  live.push({ svc, dir })
  // The real core client, over the next listener's in-process transport.
  const connect = (o: HostedConnectOptions) => connectRelayClient({ ...o, transport: peersT.shift()! })
  return { svc, dir, connect }
}

describe('joinHostedTeam against the hosted service', () => {
  it('first join asks both humans; the reconnect confirms itself; a removal reaches onClosed and drops the pin', async () => {
    const w = hostedWorld()
    const ownerKeys = genKeyPair()
    await w.svc.init()
    await w.svc.addOwner(pub(ownerKeys), 'Enes')
    await w.svc.share('P', true)
    expect(await w.svc.start()).toBe('started')
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))

    const ownerFrames: string[] = []
    let ownerOpen = false
    const owner = w.connect({
      url: 'ws://127.0.0.1/r', token: 'T', hostKeyB64: w.svc.info()!.hostPublicKeyB64, ourKeys: ownerKeys, autoApprove: true,
      onSas: () => {}, onApproved: () => { ownerOpen = true }, onFrame: (j) => ownerFrames.push(j), onPtyData: () => {}, onClose: () => {}
    })
    await vi.waitFor(() => expect(ownerOpen).toBe(true))

    const joinerKeys = genKeyPair()
    const store = new BookmarkStore(path.join(w.dir, 'relay-bookmarks.json'))
    const a = api({ device: [DEVICE_OK()], join: [[200, { pairingToken: 'T', hostId: 'H', relayEndpoint: 'ws://127.0.0.1/r', exp: 1 }]] })
    const deps: HostedJoinDeps = { apiBase: 'https://api', deviceId: () => 'joiner-dev', label: 'laptop', bookmarks: store, loadKeys: async () => joinerKeys, connect: w.connect, fetch: a.f }
    const joinCode = w.svc.joinCode()!

    // 1. First join: the SAS is shown, the human confirms, an owner approves.
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const e1 = events()
    const s1 = await joinHostedTeam(joinCode, deps, e1.ev)
    expect(e1.log.some((l) => l.startsWith('sas:'))).toBe(true)
    s1.confirm()
    await vi.waitFor(() => expect(w.svc.status().pending.some((p) => p.peerKeyB64 === pub(joinerKeys))).toBe(true))
    const pendingId = w.svc.status().pending.find((p) => p.peerKeyB64 === pub(joinerKeys))!.pendingId
    owner.send(JSON.stringify({ t: 'req', id: 1, method: IPC.relayHostedApprove, args: [pendingId, 'viewer'] }))
    await vi.waitFor(() => expect(e1.log).toContain('approved'))
    await vi.waitFor(async () => expect((await store.list())[0]?.approvedAt).not.toBeNull())
    s1.close()

    // 2. Reconnect: no SAS for this human, no device mint, and it opens on the host's pin alone.
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const e2 = events()
    await joinHostedTeam(joinCode, deps, e2.ev)
    await vi.waitFor(() => expect(e2.log).toContain('approved'))
    expect(e2.log.some((l) => l.startsWith('sas:'))).toBe(false)
    expect(a.count('device')).toBe(1)

    // 3. An owner removes this device: the reason reaches onClosed, and the pin is withdrawn.
    expect(await w.svc.remove(pub(joinerKeys), false)).toBe('removed')
    await vi.waitFor(() => expect(e2.closed).toEqual(['removed']))
    await vi.waitFor(async () => expect((await store.list())[0].approvedAt).toBeNull())
  })
})
