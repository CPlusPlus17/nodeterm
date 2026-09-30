import { describe, it, expect } from 'vitest'
import { createWatchLinkApi } from './api'

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
function api(reply: (url: string, init: RequestInit) => Response | Promise<Response>, now = 1_000_000) {
  const calls: { url: string; body: unknown }[] = []
  const a = createWatchLinkApi({
    apiBase: 'https://api.test/',
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return reply(url, init) }) as typeof fetch
  })
  return { a, calls }
}

/** A fetch that never answers on its own: it settles only when the caller's AbortSignal fires. */
function hungFetch() {
  const signals: AbortSignal[] = []
  const f = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      signals.push(signal)
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as unknown as typeof fetch
  return { f, signals }
}

describe('createWatchLinkApi', () => {
  it('create posts the hash and corrects expiry to the local clock', async () => {
    const serverNow = Date.parse('Tue, 29 Sep 2026 10:00:00 GMT')
    const { a, calls } = api(() => res(200, { linkId: 'L', expiresAt: serverNow / 1000 + 3600 }, { date: new Date(serverNow).toUTCString() }), 5_000)
    const r = await a.create('ent', 'ab'.repeat(32), 3600)
    expect(calls[0]).toEqual({ url: 'https://api.test/v1/watch-links', body: { entitlement: 'ent', joinKeyHash: 'ab'.repeat(32), ttlSeconds: 3600 } })
    expect(r).toEqual({ ok: true, linkId: 'L', expiresAt: 5_000 + 3_600_000 })
  })

  it('maps create errors', async () => {
    const cases: [Response, string][] = [
      [res(402, { error: 'not_entitled' }), 'not-entitled'],
      [res(403, { error: 'companion_device' }), 'not-entitled'],
      [res(429, { error: 'rate_limited', scope: 'active_links' }), 'limit-active'],
      [res(429, { error: 'rate_limited', scope: 'license' }), 'limit-daily'],
      [res(429, { error: 'rate_limited', scope: 'ip' }), 'rate-limited'],
      [res(503, { error: 'license_check_unavailable' }), 'license-check'],
      [res(400, { error: 'bad_ttl' }), 'bad-request'],
      [res(500, null), 'network']
    ]
    for (const [r, want] of cases) expect(await api(() => r.clone()).a.create('e', 'h', 3600)).toEqual({ ok: false, error: want })
    expect(await api(() => { throw new Error('offline') }).a.create('e', 'h', 3600)).toEqual({ ok: false, error: 'network' })
  })

  it('hostToken maps 410 to gone and other refusals to the scheduler kinds', async () => {
    expect(await api(() => res(410, { error: 'gone', reason: 'revoked' })).a.hostToken('L', 'e')).toEqual({ ok: false, kind: 'gone', reason: 'revoked' })
    expect(await api(() => res(404, { error: 'not_found' })).a.hostToken('L', 'e')).toMatchObject({ ok: false, kind: 'refused' })
    expect(await api(() => res(429, {}, { 'retry-after': '60' })).a.hostToken('L', 'e')).toEqual({ ok: false, kind: 'rate-limited', status: 429, retryAfterMs: 60_000 })
    const ok = await api(() => res(200, { pairingToken: 'P', exp: 1_000 + 120 }, { date: new Date(1_000_000).toUTCString() })).a.hostToken('L', 'e')
    expect(ok).toMatchObject({ ok: true, pairingToken: 'P' })
  })

  it('hostToken maps a 410 expired, and the owner-check refusals 402/403', async () => {
    expect(await api(() => res(410, { error: 'gone', reason: 'expired' })).a.hostToken('L', 'e')).toEqual({ ok: false, kind: 'gone', reason: 'expired' })
    expect(await api(() => res(402, { error: 'not_entitled' })).a.hostToken('L', 'e')).toEqual({ ok: false, kind: 'refused', status: 402 })
    expect(await api(() => res(403, { error: 'companion_device' })).a.hostToken('L', 'e')).toEqual({ ok: false, kind: 'refused', status: 403 })
  })

  it('hostToken takes the token lifetime from the Date header, not the local clock', async () => {
    // The server says it is 10:00:00 and the token ends at 10:02:00. This machine's clock reads
    // something else entirely; the lifetime must still be two minutes.
    const serverNow = Date.parse('Tue, 29 Sep 2026 10:00:00 GMT')
    const reply = () => res(200, { pairingToken: 'P', exp: serverNow / 1000 + 120 }, { date: new Date(serverNow).toUTCString() })
    expect(await api(reply, 5_000).a.hostToken('L', 'e')).toEqual({ ok: true, pairingToken: 'P', hostId: '', ttlMs: 120_000 })
  })

  it('hostToken: a 200 without a usable pairingToken is a bad response, not a network failure', async () => {
    for (const body of [{ exp: 1_120 }, { pairingToken: 42, exp: 1_120 }, { pairingToken: '', exp: 1_120 }, null]) {
      expect(await api(() => res(200, body)).a.hostToken('L', 'e')).toEqual({ ok: false, kind: 'bad-response', status: 200 })
    }
    // A body that is not JSON at all is the server's fault too.
    expect(await api(() => new Response('<html>', { status: 200 })).a.hostToken('L', 'e')).toEqual({ ok: false, kind: 'bad-response', status: 200 })
  })

  it('hostToken: a body that stalls until the timeout is a network failure, not a bad response', async () => {
    const a = createWatchLinkApi({
      apiBase: 'https://api.test',
      timeoutMs: 20,
      fetch: (async (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
          }
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
    })
    expect(await a.hostToken('L', 'e')).toEqual({ ok: false, kind: 'network' })
  })

  it('status, revoke and revokeAll', async () => {
    expect(await api(() => res(200, { state: 'revoked' })).a.status('L', 'e')).toBe('revoked')
    expect(await api(() => res(500, null)).a.status('L', 'e')).toBe('unknown')
    const r = api(() => res(204, null))
    expect(await r.a.revoke('L', 'e')).toBe(true)
    expect(r.calls[0].url).toBe('https://api.test/v1/watch-links/L/revoke')
    expect(await api(() => res(204, null)).a.revokeAll('e')).toBe(true)
  })

  it('status reads only the three known states; revoke answers false on anything but 204', async () => {
    expect(await api(() => res(200, { state: 'live' })).a.status('L', 'e')).toBe('live')
    expect(await api(() => res(200, { state: 'expired' })).a.status('L', 'e')).toBe('expired')
    expect(await api(() => res(200, { state: 'paused' })).a.status('L', 'e')).toBe('unknown')
    expect(await api(() => res(404, { error: 'not_found' })).a.status('L', 'e')).toBe('unknown')
    expect(await api(() => res(404, { error: 'not_found' })).a.revoke('L', 'e')).toBe(false)
    expect(await api(() => res(200, {})).a.revokeAll('e')).toBe(false)
    const all = api(() => res(204, null))
    await all.a.revokeAll('e')
    expect(all.calls[0]).toEqual({ url: 'https://api.test/v1/watch-links/revoke-all', body: { entitlement: 'e' } })
  })

  it('the timeout ends a fetch that never answers', async () => {
    const timeoutMs = 20
    const { f, signals } = hungFetch()
    const a = createWatchLinkApi({ apiBase: 'https://api.test', fetch: f, timeoutMs })
    const started = Date.now()
    const [created, token, state, revoked, revokedAll] = await Promise.all([
      a.create('e', 'h', 3600),
      a.hostToken('L', 'e'),
      a.status('L', 'e'),
      a.revoke('L', 'e'),
      a.revokeAll('e')
    ])
    expect(created).toEqual({ ok: false, error: 'network' })
    expect(token).toEqual({ ok: false, kind: 'network' })
    expect(state).toBe('unknown')
    expect(revoked).toBe(false)
    expect(revokedAll).toBe(false)
    expect(signals).toHaveLength(5)
    expect(signals.every((s) => s.aborted)).toBe(true)
    // Generous bound: the point is that it ended on the timeout, not on vitest's own 5 s limit.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('the entitlement rides only the JSON body, never the URL or a header', async () => {
    const ENT = 'ENT-SECRET-7f3a'
    const seen: { url: string; init: RequestInit }[] = []
    const a = createWatchLinkApi({
      apiBase: 'https://api.test',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init })
        return res(204, null)
      }) as typeof fetch
    })
    await a.create(ENT, 'h', 3600)
    await a.hostToken('L', ENT)
    await a.status('L', ENT)
    await a.revoke('L', ENT)
    await a.revokeAll(ENT)
    expect(seen).toHaveLength(5)
    for (const { url, init } of seen) {
      expect(url).not.toContain(ENT)
      expect(JSON.stringify(Object.entries(new Headers(init.headers)))).not.toContain(ENT)
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body)).entitlement).toBe(ENT)
    }
  })

  it('url-encodes the link id in the path', async () => {
    const id = 'a/b?c#d %'
    const enc = 'a%2Fb%3Fc%23d%20%25'
    const r = api(() => res(204, null))
    await r.a.hostToken(id, 'e')
    await r.a.status(id, 'e')
    await r.a.revoke(id, 'e')
    expect(r.calls.map((c) => c.url)).toEqual([
      `https://api.test/v1/watch-links/${enc}/host-token`,
      `https://api.test/v1/watch-links/${enc}/status`,
      `https://api.test/v1/watch-links/${enc}/revoke`
    ])
  })
})
