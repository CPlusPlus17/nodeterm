// HTTP client for the live-link routes (nodeterm-server, Plan 1). Credentials ride the JSON body
// over TLS, never argv. Every call is bounded by a timeout that also covers the body read.
import { tokenTtlMs, type MintResult } from '../relay/host-token'

export type CreateError = 'not-entitled' | 'limit-active' | 'limit-daily' | 'rate-limited' | 'license-check' | 'bad-request' | 'network'
export type HostTokenResult = MintResult | { ok: false; kind: 'gone'; reason: 'revoked' | 'expired' }
export interface WatchLinkApi {
  create(entitlement: string, joinKeyHash: string, ttlSeconds: number): Promise<{ ok: true; linkId: string; expiresAt: number } | { ok: false; error: CreateError }>
  hostToken(linkId: string, entitlement: string): Promise<HostTokenResult>
  status(linkId: string, entitlement: string): Promise<'live' | 'revoked' | 'expired' | 'unknown'>
  revoke(linkId: string, entitlement: string): Promise<boolean>
  revokeAll(entitlement: string): Promise<boolean>
}

interface Reply {
  status: number
  /** The parsed body when it is a JSON object; null for 204, an empty or non-JSON body, or any other JSON value. */
  json: Record<string, unknown> | null
  date: string | null
  retryAfter: string | null
}

export function createWatchLinkApi(o: { apiBase: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }): WatchLinkApi {
  const base = o.apiBase.replace(/\/+$/, '')
  const now = o.now ?? Date.now
  const f = o.fetch ?? fetch

  /** One POST. null = no answer (the request failed, or the timeout fired before the whole body arrived). */
  async function post(path: string, body: unknown): Promise<Reply | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 8000)
    try {
      const r = await f(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
      let json: Record<string, unknown> | null = null
      if (r.status !== 204) {
        try {
          const v: unknown = await r.json()
          json = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
        } catch {
          // Aborted mid-body is the timeout (no answer); a body that is not JSON is the server's.
          if (ctrl.signal.aborted) return null
          json = null
        }
      }
      return { status: r.status, json, date: r.headers.get('date'), retryAfter: r.headers.get('retry-after') }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  const path = (id: string, verb: string) => `/v1/watch-links/${encodeURIComponent(id)}/${verb}`

  return {
    async create(entitlement, joinKeyHash, ttlSeconds) {
      const r = await post('/v1/watch-links', { entitlement, joinKeyHash, ttlSeconds })
      if (!r) return { ok: false, error: 'network' }
      if (r.status === 200 && typeof r.json?.linkId === 'string' && typeof r.json.expiresAt === 'number') {
        // `expiresAt` is an instant on the SERVER's clock; the Date header turns it into time left,
        // which is then anchored on this machine's clock (see tokenTtlMs).
        const t = now()
        return { ok: true, linkId: r.json.linkId, expiresAt: t + tokenTtlMs(r.json.expiresAt, r.date, t) }
      }
      if (r.status === 402 || r.status === 403) return { ok: false, error: 'not-entitled' }
      if (r.status === 429) {
        const scope = r.json?.scope
        return { ok: false, error: scope === 'active_links' ? 'limit-active' : scope === 'license' ? 'limit-daily' : 'rate-limited' }
      }
      if (r.status === 503) return { ok: false, error: 'license-check' }
      if (r.status === 400) return { ok: false, error: 'bad-request' }
      return { ok: false, error: 'network' }
    },
    async hostToken(linkId, entitlement) {
      const r = await post(path(linkId, 'host-token'), { entitlement })
      if (!r) return { ok: false, kind: 'network' }
      if (r.status === 200) {
        // A 200 without a token is the server's fault, not the network's (same rule as mintHostToken).
        if (typeof r.json?.pairingToken !== 'string' || !r.json.pairingToken) return { ok: false, kind: 'bad-response', status: 200 }
        const exp = typeof r.json.exp === 'number' ? r.json.exp : 0
        return { ok: true, pairingToken: r.json.pairingToken, hostId: '', ttlMs: tokenTtlMs(exp, r.date, now()) }
      }
      if (r.status === 410) return { ok: false, kind: 'gone', reason: r.json?.reason === 'expired' ? 'expired' : 'revoked' }
      if (r.status === 429) {
        // Seconds only. An HTTP-date Retry-After (or none) falls to the scheduler's own floor.
        const ra = Number(r.retryAfter)
        return { ok: false, kind: 'rate-limited', status: 429, ...(ra > 0 ? { retryAfterMs: ra * 1000 } : {}) }
      }
      if (r.status === 402 || r.status === 403 || r.status === 404) return { ok: false, kind: 'refused', status: r.status }
      return { ok: false, kind: 'network', status: r.status }
    },
    async status(linkId, entitlement) {
      const r = await post(path(linkId, 'status'), { entitlement })
      const s = r?.status === 200 ? r.json?.state : null
      return s === 'live' || s === 'revoked' || s === 'expired' ? s : 'unknown'
    },
    async revoke(linkId, entitlement) {
      return (await post(path(linkId, 'revoke'), { entitlement }))?.status === 204
    },
    async revokeAll(entitlement) {
      return (await post('/v1/watch-links/revoke-all', { entitlement }))?.status === 204
    }
  }
}
