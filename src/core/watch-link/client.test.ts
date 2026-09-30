// The viewer client runs against the REAL host-role relay socket, not a fake. That is what pins the
// wire constants src/shared/watch-link/wire.ts restates (the seq header, TAG_*, ROLE_*, NONCE_BYTES):
// they are module-private in relay-socket.ts, so a drift there shows up here as a handshake that
// never completes or a frame the host never sees. It lives in core because it imports core modules
// the web tsconfig project that vendors src/shared/watch-link cannot see.
import { describe, it, expect, vi } from 'vitest'
import nacl from 'tweetnacl'
import { connectRelay } from '../relay/relay-socket'
import { transportPair } from '../relay/transport-pair'
import { publicKeyToB64 } from '../relay/e2ee'
import { encodePtyData } from '../../shared/rpc'
import { connectWatchClient, TRUST_CONFIRM_JSON } from '../../shared/watch-link/client'
import { deriveWatchLinkKeys } from '../../shared/watch-link/keys'

function hostWith(keys = deriveWatchLinkKeys(nacl.randomBytes(32))) {
  const { hostT, peerT } = transportPair()
  const tunnel: string[] = []
  let ready = false
  const host = connectRelay({
    url: 'wss://x', token: 't', role: 'host',
    ourKeys: { publicKey: keys.host.publicKey, secretKey: keys.host.secretKey },
    transport: hostT,
    onReady: () => { ready = true },
    onRpc: () => {}, onFrame: () => {}, onClose: () => {},
    onTunnel: (kind, payload) => { if (kind === 'text') tunnel.push(new TextDecoder().decode(payload)) }
  })
  return { keys, host, hostT, peerT, tunnel, isReady: () => ready }
}

function events() {
  const log = { open: 0, events: [] as [string, unknown[]][], pty: [] as [string, string][], denied: [] as string[], closed: 0 }
  return {
    log,
    ev: {
      onOpen: () => { log.open++ },
      onEvent: (c: string, a: unknown[]) => { log.events.push([c, a]) },
      onPtyData: (s: string, d: string) => { log.pty.push([s, d]) },
      onDenied: (r: string) => { log.denied.push(r) },
      onClose: () => { log.closed++ }
    }
  }
}

describe('connectWatchClient against the real relay socket', () => {
  it('completes the handshake, confirms trust, and opens once the host confirms', async () => {
    const h = hostWith()
    const { log, ev } = events()
    const c = connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
    await vi.waitFor(() => expect(h.isReady()).toBe(true))
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    expect(h.host.peerPublicKeyB64()).toBe(publicKeyToB64(h.keys.viewer.publicKey))
    expect(c.isOpen()).toBe(false)
    h.host.sendTunnelText(TRUST_CONFIRM_JSON)
    expect(log.open).toBe(1)
    expect(c.isOpen()).toBe(true)
  })

  it('delivers ev frames and pty data only after it is open', async () => {
    const h = hostWith()
    const { log, ev } = events()
    connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.host.sendTunnelText(JSON.stringify({ t: 'ev', channel: 'watch:meta', args: [{ v: 1 }] }))
    h.host.sendTunnelBinary(encodePtyData('s1', 'early'))
    expect(log.events).toEqual([])
    expect(log.pty).toEqual([])
    h.host.sendTunnelText(TRUST_CONFIRM_JSON)
    h.host.sendTunnelText(JSON.stringify({ t: 'ev', channel: 'watch:meta', args: [{ v: 1 }] }))
    h.host.sendTunnelBinary(encodePtyData('s1', 'late'))
    expect(log.events).toEqual([['watch:meta', [{ v: 1 }]]])
    expect(log.pty).toEqual([['s1', 'late']])
  })

  it('reports a denial and never opens', async () => {
    const h = hostWith()
    const { log, ev } = events()
    connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.host.sendTunnelText(JSON.stringify({ t: 'cast', method: 'trust:denied', args: ['denied'] }))
    expect(log.denied).toEqual(['denied'])
    expect(log.open).toBe(0)
  })

  it('cannot talk to a host whose key is not the link one', async () => {
    const real = deriveWatchLinkKeys(nacl.randomBytes(32))
    const impostor = hostWith(deriveWatchLinkKeys(nacl.randomBytes(32)))
    connectWatchClient({ socket: impostor.peerT, keys: real, events: events().ev })
    await new Promise((r) => setTimeout(r, 20))
    expect(impostor.isReady()).toBe(false)
  })

  it('sends a chat cast only while open', async () => {
    const h = hostWith()
    const c = connectWatchClient({ socket: h.peerT, keys: h.keys, events: events().ev })
    expect(c.sendChat('Ada', 'hi')).toBe(false)
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.host.sendTunnelText(TRUST_CONFIRM_JSON)
    expect(c.sendChat('Ada', 'hi')).toBe(true)
    expect(h.tunnel.at(-1)).toBe(JSON.stringify({ t: 'cast', method: 'watch:chat', args: [{ name: 'Ada', text: 'hi' }] }))
  })

  it('keeps both directions flowing past seq 255', async () => {
    // A strictly increasing counter stays increasing under most encodings, so a short exchange
    // cannot tell the relay's little-endian seq from a byte-swapped copy. Past one byte it can:
    // a swapped 256 decodes below a swapped 255 and the receiver drops it as a replay.
    const h = hostWith()
    const { log, ev } = events()
    const c = connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.host.sendTunnelText(TRUST_CONFIRM_JSON)
    for (let i = 0; i < 300; i++) h.host.sendTunnelBinary(encodePtyData('s1', String(i)))
    expect(log.pty).toHaveLength(300)
    expect(log.pty.at(-1)).toEqual(['s1', '299'])
    for (let i = 0; i < 300; i++) expect(c.sendChat('Ada', String(i))).toBe(true)
    expect(h.tunnel.at(-1)).toBe(JSON.stringify({ t: 'cast', method: 'watch:chat', args: [{ name: 'Ada', text: '299' }] }))
    expect(h.tunnel.filter((m) => m.includes('watch:chat'))).toHaveLength(300)
  })

  it('keeps the sealed stream in order across keepalives, and stops them when the socket closes', async () => {
    const h = hostWith()
    const { log, ev } = events()
    const timer: { tick?: () => void; ms?: number } = {}
    const stopped: unknown[] = []
    let sent = 0
    const c = connectWatchClient({
      socket: { ...h.peerT, send: (d) => { sent++; h.peerT.send(d) } }, keys: h.keys, events: ev,
      setInterval: (fn, ms) => { timer.tick = fn; timer.ms = ms; return 'handle' },
      clearInterval: (handle) => { stopped.push(handle) }
    })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.host.sendTunnelText(TRUST_CONFIRM_JSON)
    expect(timer.ms).toBe(25_000)
    // A keepalive is a real sealed frame and spends a seq number; the host must still accept what
    // follows it.
    const before = sent
    timer.tick?.()
    timer.tick?.()
    expect(sent - before).toBe(2)
    expect(c.sendChat('Ada', 'after keepalives')).toBe(true)
    expect(h.tunnel.at(-1)).toBe(JSON.stringify({ t: 'cast', method: 'watch:chat', args: [{ name: 'Ada', text: 'after keepalives' }] }))
    // The far side hangs up: the client reports it once, stops its keepalive, and stops sending.
    h.hostT.close()
    expect(log.closed).toBe(1)
    expect(stopped).toEqual(['handle'])
    expect(c.isOpen()).toBe(false)
    expect(c.sendChat('Ada', 'too late')).toBe(false)
  })

  it('does not report a close the caller asked for, and still stops its keepalive', async () => {
    const h = hostWith()
    const { log, ev } = events()
    const stopped: unknown[] = []
    const c = connectWatchClient({
      socket: h.peerT, keys: h.keys, events: ev,
      setInterval: () => 'handle',
      clearInterval: (handle) => { stopped.push(handle) }
    })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.host.sendTunnelText(TRUST_CONFIRM_JSON)
    c.close()
    expect(log.closed).toBe(0)
    expect(stopped).toEqual(['handle'])
    expect(c.isOpen()).toBe(false)
  })
})
