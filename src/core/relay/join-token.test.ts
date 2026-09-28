// src/core/relay/join-token.test.ts
import { describe, it, expect } from 'vitest'
import { mintDeviceToken, mintJoinToken } from './join-token'

const code = { v: 1 as const, relayEndpoint: 'wss://r', hostId: 'H', hostPublicKeyB64: 'K', hostDeviceId: 'HD', label: 'box' }

/** A fetch that answers `status` + `body` and records what it was asked. */
function fake(status: number, body: unknown) {
  const calls: Array<{ url: string; method?: string; body: unknown }> = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method, body: JSON.parse(String(init.body)) })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { f, calls }
}
const throwing = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch

describe('joiner tokens', () => {
  it('device mint sends exactly the free-tier body to <apiBase>/v1/relay/device', async () => {
    const { f, calls } = fake(200, { deviceToken: 'DT', hostId: 'H', exp: 1 })
    expect(await mintDeviceToken({ apiBase: 'https://api/', deviceId: 'me', code, label: 'laptop', fetch: f }))
      .toEqual({ ok: true, deviceToken: 'DT' })
    expect(calls).toEqual([{
      url: 'https://api/v1/relay/device',
      method: 'POST',
      body: { deviceId: 'me', hostDeviceId: 'HD', hostPublicKeyB64: 'K', label: 'laptop' }
    }])
  })

  it('device mint: 429 is rate-limited, a 4xx is refused, 5xx and a throw are network, a bad body is refused', async () => {
    const mint = (f: typeof fetch) => mintDeviceToken({ apiBase: 'a', deviceId: 'me', code, label: 'l', fetch: f })
    expect(await mint(fake(429, { error: 'rate_limited' }).f)).toEqual({ ok: false, kind: 'rate-limited' })
    expect(await mint(fake(403, { error: 'reauth_required' }).f)).toEqual({ ok: false, kind: 'refused' })
    expect(await mint(fake(402, { error: 'not_entitled' }).f)).toEqual({ ok: false, kind: 'refused' })
    expect(await mint(fake(503, 'bad gateway').f)).toEqual({ ok: false, kind: 'network' })
    expect(await mint(throwing)).toEqual({ ok: false, kind: 'network' })
    expect(await mint(fake(200, 'not json').f)).toEqual({ ok: false, kind: 'refused' })
    expect(await mint(fake(200, { deviceToken: '' }).f)).toEqual({ ok: false, kind: 'refused' })
  })

  it('join posts {deviceToken} and maps 401 → bad-token and 403 → revoked', async () => {
    const ok = fake(200, { pairingToken: 'P', hostId: 'H', relayEndpoint: 'wss://r', exp: 1 })
    expect(await mintJoinToken({ apiBase: 'https://api', deviceToken: 'x', fetch: ok.f }))
      .toEqual({ ok: true, pairingToken: 'P', relayEndpoint: 'wss://r' })
    expect(ok.calls).toEqual([{ url: 'https://api/v1/relay/join', method: 'POST', body: { deviceToken: 'x' } }])
    expect(await mintJoinToken({ apiBase: 'a', deviceToken: 'x', fetch: fake(401, {}).f })).toEqual({ ok: false, kind: 'bad-token' })
    expect(await mintJoinToken({ apiBase: 'a', deviceToken: 'x', fetch: fake(403, {}).f })).toEqual({ ok: false, kind: 'revoked' })
  })

  it('join: any other failure is network, never a token verdict', async () => {
    const join = (f: typeof fetch) => mintJoinToken({ apiBase: 'a', deviceToken: 'x', fetch: f })
    expect(await join(fake(500, {}).f)).toEqual({ ok: false, kind: 'network' })
    expect(await join(fake(429, {}).f)).toEqual({ ok: false, kind: 'network' })
    expect(await join(throwing)).toEqual({ ok: false, kind: 'network' })
    expect(await join(fake(200, 'nope').f)).toEqual({ ok: false, kind: 'network' })
    expect(await join(fake(200, { pairingToken: 'P' }).f)).toEqual({ ok: false, kind: 'network' })
    expect(await join(fake(200, { pairingToken: '', relayEndpoint: 'wss://r' }).f)).toEqual({ ok: false, kind: 'network' })
  })

  it('the timeout covers a body that never finishes', async () => {
    const stalled = (async (_u: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })) as unknown as typeof fetch
    expect(await mintJoinToken({ apiBase: 'a', deviceToken: 'x', fetch: stalled, timeoutMs: 20 })).toEqual({ ok: false, kind: 'network' })
    expect(await mintDeviceToken({ apiBase: 'a', deviceId: 'me', code, label: 'l', fetch: stalled, timeoutMs: 20 }))
      .toEqual({ ok: false, kind: 'network' })
  })
})
