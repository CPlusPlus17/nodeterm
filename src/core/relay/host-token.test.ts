// src/core/relay/host-token.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mintHostToken, tokenTtlMs } from './host-token'

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body, text: async () => JSON.stringify(body) }) as Response

afterEach(() => {
  vi.useRealTimers()
})

describe('host token', () => {
  it('sends deviceId + host key and measures TTL on the server clock', async () => {
    let sent: unknown
    const r = await mintHostToken({
      apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: 'K',
      fetch: (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return res(200, { pairingToken: 'T', hostId: 'H', exp: 1_000_120 }, { date: new Date(1_000_000_000).toUTCString() }) }) as typeof fetch,
      now: () => 999_000_000 // local clock 1000 s behind: must not matter
    })
    expect(sent).toEqual({ deviceId: 'd', hostPublicKeyB64: 'K' })
    expect(r).toEqual({ ok: true, pairingToken: 'T', hostId: 'H', ttlMs: 120_000 })
  })
  it('429 carries Retry-After; 402 is refused; network throws are network', async () => {
    const f = (r: Response) => (async () => r) as unknown as typeof fetch
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(429, {}, { 'retry-after': '90' })) }))
      .toMatchObject({ ok: false, kind: 'rate-limited', retryAfterMs: 90_000 })
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(402, { error: 'not_entitled' })) }))
      .toMatchObject({ ok: false, kind: 'refused', status: 402 })
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: (async () => { throw new Error('x') }) as unknown as typeof fetch }))
      .toMatchObject({ ok: false, kind: 'network' })
  })
  it('tokenTtlMs falls back to the local clock without a Date header', () => {
    expect(tokenTtlMs(100, null, 40_000)).toBe(60_000)
    expect(tokenTtlMs(0, null, 0)).toBe(120_000)
  })

  it('posts to <apiBase>/v1/relay/host-token, tolerating a trailing slash on the base', async () => {
    const urls: string[] = []
    const methods: Array<string | undefined> = []
    const f = (async (u: string, init: RequestInit) => {
      urls.push(u)
      methods.push(init.method)
      return res(200, { pairingToken: 'T', hostId: 'H', exp: 0 })
    }) as unknown as typeof fetch
    await mintHostToken({ apiBase: 'https://api.example/', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f })
    await mintHostToken({ apiBase: 'https://api.example', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f })
    expect(urls).toEqual(['https://api.example/v1/relay/host-token', 'https://api.example/v1/relay/host-token'])
    expect(methods).toEqual(['POST', 'POST'])
  })

  it('403 is refused; any other non-2xx is network with its status; a 429 without Retry-After has no retryAfterMs', async () => {
    const f = (r: Response) => (async () => r) as unknown as typeof fetch
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(403, {})) }))
      .toMatchObject({ ok: false, kind: 'refused', status: 403 })
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(503, {})) }))
      .toEqual({ ok: false, kind: 'network', status: 503 })
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(429, {})) }))
      .toEqual({ ok: false, kind: 'rate-limited', status: 429 })
  })

  it('a 200 without a usable token or with an unparseable body is bad-response', async () => {
    const f = (r: Response) => (async () => r) as unknown as typeof fetch
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(200, { hostId: 'H', exp: 1 })) }))
      .toEqual({ ok: false, kind: 'bad-response' })
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(200, { pairingToken: '' })) }))
      .toEqual({ ok: false, kind: 'bad-response' })
    const broken = { ...res(200, null), json: async () => { throw new SyntaxError('Unexpected token <') } } as Response
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(broken) }))
      .toEqual({ ok: false, kind: 'bad-response' })
  })

  it('the 8 s timeout also covers a body that stalls after the headers arrived', async () => {
    // A body read outside the abort window would leave the mint pending forever, and the scheduler
    // (which runs one mint at a time) would never mint again.
    vi.useFakeTimers()
    const f = (async (_u: string, init: RequestInit) => ({
      ...res(200, null),
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as Response) as unknown as typeof fetch
    const p = mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f })
    let settled: unknown = 'pending'
    void p.then((r) => { settled = r })
    await vi.advanceTimersByTimeAsync(7_999)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toEqual({ ok: false, kind: 'network' })
  })
})
