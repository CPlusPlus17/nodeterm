// src/core/relay/relay-host.core.test.ts
import { describe, it, expect, vi } from 'vitest'
import { connectRelayHost, killRelayHostsByPeerKey, type PeerAttach, type RelayHostSession } from './relay-host'
import { connectRelayClient } from './relay-client'
import { transportPair } from './transport-pair'
import { genKeyPair, publicKeyToB64 } from './e2ee'
import { connectRelay } from './relay-socket'
import { createTrustGate, deniedFrame, type TrustGate } from './relay-trust'
import type { RpcRequest } from '../../shared/rpc'

function fakeAttach() {
  const dispatched: RpcRequest[] = []
  const casts: Array<{ method: string; args: unknown[] }> = []
  const sinks = new Map<number, { sendText(j: string): void }>()
  let next = 1
  const attach: PeerAttach = {
    attach: (sink) => { const id = next++; sinks.set(id, sink); return id },
    detach: (id) => { sinks.delete(id) },
    dispatch: async (_id, req) => { dispatched.push(req); return { t: 'res', id: req.id, ok: true, result: 'ok' } },
    cast: (_id, method, args) => { casts.push({ method, args }) }
  }
  return { attach, dispatched, casts, sinks }
}

function open(opts: Partial<Parameters<typeof connectRelayHost>[0]> = {}, clientAuto = false) {
  const hostKeys = genKeyPair()
  const peerKeys = genKeyPair()
  const { hostT, peerT } = transportPair()
  const fa = fakeAttach()
  const frames: string[] = []
  let hostSession!: RelayHostSession
  const opened: string[] = []
  hostSession = connectRelayHost({
    url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
    onPeerPending: () => {}, onOpen: () => opened.push('host'), onClose: () => {}, ...opts
  })
  const client = connectRelayClient({
    url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: peerKeys,
    transport: peerT, autoApprove: clientAuto, onSas: () => {}, onApproved: () => opened.push('peer'),
    onFrame: (j) => frames.push(j), onPtyData: () => {}, onClose: () => {}
  })
  return { hostSession, client, fa, frames, opened, peerKeyB64: publicKeyToB64(peerKeys.publicKey) }
}

describe('core relay host', () => {
  it('pinned peer + auto-approving client open with no human', async () => {
    const t = open({ autoApprove: () => true }, true)
    await vi.waitFor(() => expect(t.opened.sort()).toEqual(['host', 'peer']))
    expect(t.fa.sinks.size).toBe(1)
  })

  it('autoApprove is asked with the handshake peer key', async () => {
    const seen: string[] = []
    const t = open({ autoApprove: (k) => { seen.push(k); return false } })
    await vi.waitFor(() => expect(seen).toEqual([t.peerKeyB64]))
    expect(t.opened).toEqual([])
  })

  it('interceptReq answers before dispatch and never reaches the platform', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: { interceptReq: (_s, m) => (m === 'relay:hosted:self' ? Promise.resolve({ role: 'viewer' }) : null) }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 7, method: 'relay:hosted:self', args: [] }))
    await vi.waitFor(() => expect(t.frames.some((f) => f.includes('"id":7') && f.includes('viewer'))).toBe(true))
    expect(t.fa.dispatched).toEqual([])
  })

  it('access refusal answers E_ROLE and does not dispatch; allow may rewrite args', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: {
        access: (_s, _k, method, args) =>
          method === 'fs:write' ? { allow: false, message: 'Viewers cannot edit files.' }
            : method === 'pty:resize' ? { allow: true, args: [args[0], null, null] } : { allow: true }
      }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 1, method: 'fs:write', args: ['/x', 'y'] }))
    t.client.send(JSON.stringify({ t: 'cast', method: 'pty:resize', args: ['s1', 200, 50] }))
    await vi.waitFor(() => expect(t.frames.some((f) => f.includes('E_ROLE'))).toBe(true))
    expect(t.fa.dispatched).toEqual([])
    expect(t.fa.casts).toEqual([{ method: 'pty:resize', args: ['s1', null, null] }])
  })

  it('deny() tells the client why before closing', async () => {
    const denied: string[] = []
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const s = connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fakeAttach().attach, transport: hostT,
      onPeerPending: (sess) => sess.deny('denied'), onOpen: () => {}, onClose: () => {}
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, onSas: () => {}, onApproved: () => {}, onFrame: () => {}, onPtyData: () => {},
      onClose: () => {}, onDenied: (r) => denied.push(r)
    })
    await vi.waitFor(() => expect(denied).toEqual(['denied']))
    expect(s.clientId()).toBeNull()
  })
})

// Ruling R9: an auto-approving gate must never send its confirm before the socket (and the gate) can
// carry it. Over an in-process transport the whole handshake runs synchronously inside the CLIENT's
// connectRelay call, so both of these fail when the confirm is sent at gate construction.
describe('core relay — auto-approve confirms are deferred until they can be delivered', () => {
  it('an auto-approving CLIENT still delivers its confirm to a host whose human confirms', async () => {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const opened: string[] = []
    let sasShown = 0
    const host = connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fakeAttach().attach, transport: hostT,
      onPeerPending: () => {}, onOpen: () => opened.push('host'), onClose: () => {}
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => sasShown++, onApproved: () => opened.push('peer'),
      onFrame: () => {}, onPtyData: () => {}, onClose: () => {}
    })
    host.confirm() // the host's human
    await vi.waitFor(() => expect(opened.sort()).toEqual(['host', 'peer']))
    expect(sasShown).toBe(0) // a pinned host raises no SAS dialog
  })

  it('an auto-approving HOST confirms after the current turn, so a peer that builds its gate after its socket hears it', async () => {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const opened: string[] = []
    let pending = 0
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fakeAttach().attach, transport: hostT,
      autoApprove: () => true, onPeerPending: () => pending++, onOpen: () => opened.push('host'), onClose: () => {}
    })
    // The shape the desktop tests use: the peer's gate exists only once connectRelay has returned.
    let peerGate: TrustGate | null = null
    const peerSocket = connectRelay({
      url: 'ws://127.0.0.1/x', token: 't', role: 'client', ourKeys: genKeyPair(),
      theirPubB64: publicKeyToB64(hostKeys.publicKey), transport: peerT,
      onReady: () => {}, onRpc: () => {}, onFrame: () => {}, onClose: () => {},
      onTunnel: (kind, payload) => {
        if (kind === 'text') peerGate?.onTunnelText(new TextDecoder().decode(payload))
      }
    })
    peerGate = createTrustGate({
      peerKeyB64: peerSocket.peerPublicKeyB64()!, sessionId: 'peer', sas: () => peerSocket.sas(),
      sendConfirm: (j) => peerSocket.sendTunnelText(j), onOpen: () => opened.push('peer')
    })
    peerGate.confirmHere() // the peer's human
    await vi.waitFor(() => expect(opened.sort()).toEqual(['host', 'peer']))
    expect(pending).toBe(0) // an auto-approved peer never raises the approve dialog
  })
})

describe('core relay host — hooks and refusals', () => {
  it('the attached sink reports the relay socket’s REAL buffered bytes (obligation 2)', async () => {
    const hostKeys = genKeyPair()
    const buffered = { n: 0 }
    const { hostT, peerT } = transportPair({ hostBuffered: () => buffered.n })
    const sinks: Array<{ bufferedAmount?(): number }> = []
    const opened: string[] = []
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, transport: hostT,
      attach: { ...fakeAttach().attach, attach: (sink) => { sinks.push(sink); return 1 } },
      autoApprove: () => true, onPeerPending: () => {}, onOpen: () => opened.push('host'), onClose: () => {}
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {}, onFrame: () => {},
      onPtyData: () => {}, onClose: () => {}
    })
    await vi.waitFor(() => expect(opened).toEqual(['host']))
    buffered.n = 9_000_000
    expect(sinks[0].bufferedAmount?.()).toBe(9_000_000)
  })

  it('wrapSink decides what is attached, and still sees the honest base sink', async () => {
    const hostKeys = genKeyPair()
    const buffered = { n: 42 }
    const { hostT, peerT } = transportPair({ hostBuffered: () => buffered.n })
    const fa = fakeAttach()
    const wrapped: string[] = []
    const frames: string[] = []
    const opened: string[] = []
    let baseBuffered = -1
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
      autoApprove: () => true,
      hooks: {
        wrapSink: (_s, base) => {
          baseBuffered = base.bufferedAmount?.() ?? -1
          return { ...base, sendText: (j) => { wrapped.push(j); base.sendText(j) } }
        }
      },
      onPeerPending: () => {}, onOpen: () => opened.push('host'), onClose: () => {}
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {}, onFrame: (j) => frames.push(j),
      onPtyData: () => {}, onClose: () => {}
    })
    await vi.waitFor(() => expect(opened).toEqual(['host']))
    expect(baseBuffered).toBe(42)
    const ev = JSON.stringify({ t: 'ev', channel: 'x', args: [] })
    fa.sinks.get(1)!.sendText(ev)
    expect(wrapped).toEqual([ev])
    await vi.waitFor(() => expect(frames).toContain(ev))
  })

  it('narrowResponse rewrites a successful result and never touches an error', async () => {
    const narrowed: string[] = []
    const fa = fakeAttach()
    const t = open({
      autoApprove: () => true,
      attach: {
        ...fa.attach,
        dispatch: async (_id, req) => req.method === 'bad'
          ? { t: 'res', id: req.id, ok: false, error: { code: 'E_HANDLER', message: 'no' } }
          : { t: 'res', id: req.id, ok: true, result: 'full' }
      },
      hooks: { narrowResponse: (_s, method, result) => { narrowed.push(method); return `${String(result)}-narrowed` } }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 1, method: 'good', args: [] }))
    t.client.send(JSON.stringify({ t: 'req', id: 2, method: 'bad', args: [] }))
    await vi.waitFor(() => expect(t.frames.length).toBe(2))
    const res = t.frames.map((f) => JSON.parse(f))
    expect(res.find((r) => r.id === 1)).toMatchObject({ ok: true, result: 'full-narrowed' })
    expect(res.find((r) => r.id === 2)).toMatchObject({ ok: false, error: { code: 'E_HANDLER' } })
    expect(narrowed).toEqual(['good'])
  })

  it('a denial frame a PEER sends is consumed, never forwarded to the core', async () => {
    const t = open({ autoApprove: () => true }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(deniedFrame('removed'))
    // Positive control, sent AFTER: once it has arrived, the denial had its turn.
    t.client.send(JSON.stringify({ t: 'cast', method: 'pty:write', args: ['s1', 'x'] }))
    await vi.waitFor(() => expect(t.fa.casts.length).toBe(1))
    expect(t.fa.casts).toEqual([{ method: 'pty:write', args: ['s1', 'x'] }])
  })

  it('killRelayHostsByPeerKey with a reason tells the peer why; without one it only closes', async () => {
    const hostKeys = genKeyPair()
    const peerKeys = genKeyPair()
    const fa = fakeAttach()
    const events: string[] = []
    const run = (): RelayHostSession => {
      const { hostT, peerT } = transportPair()
      const host = connectRelayHost({
        url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
        autoApprove: () => true, onPeerPending: () => {}, onOpen: () => events.push('open'), onClose: () => {}
      })
      connectRelayClient({
        url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: peerKeys,
        transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {}, onFrame: () => {},
        onPtyData: () => {}, onClose: () => events.push('close'), onDenied: (r) => events.push(`denied:${r}`)
      })
      return host
    }
    const peerKeyB64 = publicKeyToB64(peerKeys.publicKey)

    const first = run()
    await vi.waitFor(() => expect(events).toEqual(['open']))
    killRelayHostsByPeerKey(peerKeyB64, 'removed')
    expect(events).toEqual(['open', 'denied:removed', 'close']) // the reason lands BEFORE the close
    expect(first.clientId()).toBeNull()
    expect(fa.sinks.size).toBe(0)

    events.length = 0
    const second = run()
    await vi.waitFor(() => expect(events).toEqual(['open']))
    killRelayHostsByPeerKey(peerKeyB64)
    expect(events).toEqual(['open', 'close'])
    expect(second.clientId()).toBeNull()
  })

  it('a denial sent during the in-process handshake still reaches the client before its close', async () => {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const events: string[] = []
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fakeAttach().attach, transport: hostT,
      onPeerPending: (sess) => sess.deny('expired'), onOpen: () => {}, onClose: () => {}
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, onSas: () => {}, onApproved: () => {}, onFrame: () => {}, onPtyData: () => {},
      onClose: () => events.push('close'), onDenied: (r) => events.push(`denied:${r}`)
    })
    expect(events).toEqual(['denied:expired', 'close'])
  })
})

// Ruling R11: a hook (or the shell's dispatch) that throws must never escape into the socket's
// message handler — over a real ws that emit is synchronous, so the throw kills the stream: no later
// frame, no `close`, no teardown, the request never answered. Every guard below answers or drops
// instead, and the session keeps serving.
describe('core relay host — a throwing hook or dispatch never wedges the session', () => {
  const errorOf = (frames: string[], id: number) =>
    frames.map((f) => JSON.parse(f)).find((m) => m.t === 'res' && m.id === id)

  it('a throwing access hook answers E_HANDLER, and a later frame on the same session still dispatches', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: {
        access: (_s, _k, method) => {
          if (method === 'boom') throw new Error('access exploded')
          return { allow: true }
        }
      }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 1, method: 'boom', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 1)).toMatchObject({
      ok: false, error: { code: 'E_HANDLER', message: 'access exploded' }
    }))
    t.client.send(JSON.stringify({ t: 'req', id: 2, method: 'fine', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 2)).toMatchObject({ ok: true, result: 'ok' }))
    expect(t.fa.dispatched.map((r) => r.method)).toEqual(['fine'])
  })

  it('a throwing access hook on a cast drops that cast, and a later cast still arrives', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: {
        access: (_s, kind, method) => {
          if (kind === 'cast' && method === 'boom') throw new Error('nope')
          return { allow: true }
        }
      }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'cast', method: 'boom', args: [] }))
    t.client.send(JSON.stringify({ t: 'cast', method: 'pty:write', args: ['s1', 'x'] }))
    await vi.waitFor(() => expect(t.fa.casts.length).toBe(1))
    expect(t.fa.casts).toEqual([{ method: 'pty:write', args: ['s1', 'x'] }])
  })

  it('a throwing interceptReq answers E_HANDLER and never dispatches', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: {
        interceptReq: (_s, m) => {
          if (m === 'relay:hosted:self') throw new Error('intercept exploded')
          return null
        }
      }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 3, method: 'relay:hosted:self', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 3)).toMatchObject({
      ok: false, error: { code: 'E_HANDLER', message: 'intercept exploded' }
    }))
    expect(t.fa.dispatched).toEqual([])
  })

  it('a rejecting attach.dispatch answers E_HANDLER', async () => {
    const fa = fakeAttach()
    const t = open({
      autoApprove: () => true,
      attach: { ...fa.attach, dispatch: async () => { throw new Error('dispatch exploded') } }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 4, method: 'fs:list', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 4)).toMatchObject({
      ok: false, error: { code: 'E_HANDLER', message: 'dispatch exploded' }
    }))
  })

  it('a dispatch that throws synchronously answers E_HANDLER', async () => {
    const fa = fakeAttach()
    const t = open({
      autoApprove: () => true,
      attach: { ...fa.attach, dispatch: () => { throw new Error('sync dispatch') } }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 5, method: 'fs:list', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 5)).toMatchObject({
      ok: false, error: { code: 'E_HANDLER', message: 'sync dispatch' }
    }))
  })

  it('a throwing narrowResponse answers E_HANDLER, never the unnarrowed result', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: { narrowResponse: () => { throw new Error('narrow exploded') } }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 6, method: 'fs:list', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 6)).toMatchObject({
      ok: false, error: { code: 'E_HANDLER', message: 'narrow exploded' }
    }))
    expect(t.frames.some((f) => f.includes('"result":"ok"'))).toBe(false)
  })

  it('a throwing autoApprove reads as false: the human is asked instead', async () => {
    let pending = 0
    const t = open({
      autoApprove: () => { throw new Error('pin store exploded') },
      onPeerPending: () => pending++
    }, true)
    expect(pending).toBe(1)
    t.hostSession.confirm() // the human
    await vi.waitFor(() => expect(t.opened.sort()).toEqual(['host', 'peer']))
  })

  it('a throwing wrapSink FAILS CLOSED: nothing is attached, the session closes, the shell hears it', async () => {
    let hostClosed = 0
    let clientClosed = 0
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const fa = fakeAttach()
    const s = connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
      autoApprove: () => true,
      hooks: { wrapSink: () => { throw new Error('filter exploded') } },
      onPeerPending: () => {}, onOpen: () => { throw new Error('must not open') }, onClose: () => hostClosed++
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {}, onFrame: () => {},
      onPtyData: () => {}, onClose: () => clientClosed++
    })
    await vi.waitFor(() => expect(hostClosed).toBe(1))
    expect(clientClosed).toBe(1)
    expect(fa.sinks.size).toBe(0) // an unfiltered sink was never handed to the core
    expect(s.clientId()).toBeNull()
  })
})
