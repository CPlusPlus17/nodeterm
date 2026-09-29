// Standing-host token mint for the Server Edition's hosted team relay. Mirrors the desktop's
// `mintHostToken` + `tokenTtlMs` in src/main/remote/standing-host.ts (see that file for the measured
// incidents: clock skew → 238 mints/hour, refused mints re-minted in a tight loop), minus Electron.
// It sends deviceId only, never an entitlement: relay access is free (CLAUDE.md, "Remote access …
// free, not Pro"), and the backend is the gate.
//
// Unlike the desktop copy, which collapses every failure to `null`, this one says WHICH failure it
// was, because the scheduler reacts differently to each: a 429 waits at least a minute, a 402/403
// stops minting, anything else backs off and retries.
export type MintResult =
  | { ok: true; pairingToken: string; hostId: string; ttlMs: number }
  | { ok: false; kind: 'network' | 'rate-limited' | 'refused' | 'bad-response'; retryAfterMs?: number; status?: number }

const DEFAULT_TTL_MS = 120_000
const MINT_TIMEOUT_MS = 8000

/**
 * How long a freshly minted token has left, in ms.
 *
 * `exp` is an absolute instant (seconds) on the SERVER's clock. Subtracting the LOCAL clock from it
 * folds this machine's clock error into the answer: a clock 75 s fast leaves 120 − 75 = 45 s, minus
 * the 30 s refresh lead = the 15 s floor, so the host re-mints four times per TTL (relay log,
 * 2026-09-27: 238 mints/hour against a free limit of 240). The response's own `Date` header is the
 * server's clock at the instant it computed `exp`, so the difference is clock-independent. The
 * local clock is the fallback only when the header is missing or unparseable (a proxy stripped it).
 */
export function tokenTtlMs(exp: number, serverDate: string | null, localNowMs: number): number {
  if (!(exp > 0)) return DEFAULT_TTL_MS
  const serverNowMs = serverDate ? Date.parse(serverDate) : NaN
  return exp * 1000 - (Number.isFinite(serverNowMs) ? serverNowMs : localNowMs)
}

export async function mintHostToken(deps: {
  apiBase: string
  deviceId: string
  hostPublicKeyB64: string
  fetch?: typeof fetch
  now?: () => number
}): Promise<MintResult> {
  const f = deps.fetch ?? fetch
  const ctrl = new AbortController()
  // The timeout covers the BODY read too, not just the headers: a response whose body stalls would
  // otherwise leave this mint pending forever, and the scheduler runs one mint at a time.
  const timer = setTimeout(() => ctrl.abort(), MINT_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await f(`${deps.apiBase.replace(/\/+$/, '')}/v1/relay/host-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // EXACTLY these two fields: the production endpoint was verified against this body.
        body: JSON.stringify({ deviceId: deps.deviceId, hostPublicKeyB64: deps.hostPublicKeyB64 }),
        signal: ctrl.signal
      })
    } catch {
      return { ok: false, kind: 'network' }
    }
    if (res.status === 429) {
      // Seconds only. An HTTP-date Retry-After (or none) falls to the scheduler's 60 s floor.
      const ra = Number(res.headers.get('retry-after'))
      return { ok: false, kind: 'rate-limited', status: 429, ...(ra > 0 ? { retryAfterMs: ra * 1000 } : {}) }
    }
    if (res.status === 402 || res.status === 403) return { ok: false, kind: 'refused', status: res.status }
    if (!res.ok) return { ok: false, kind: 'network', status: res.status }
    let json: { pairingToken?: unknown; hostId?: unknown; exp?: unknown } | null
    try {
      json = (await res.json()) as typeof json
    } catch {
      // Aborted mid-body is a timeout (network); a body that is not JSON is the server's fault.
      return ctrl.signal.aborted ? { ok: false, kind: 'network' } : { ok: false, kind: 'bad-response' }
    }
    if (!json || typeof json.pairingToken !== 'string' || !json.pairingToken) return { ok: false, kind: 'bad-response' }
    const exp = typeof json.exp === 'number' ? json.exp : 0
    return {
      ok: true,
      pairingToken: json.pairingToken,
      hostId: typeof json.hostId === 'string' ? json.hostId : '',
      ttlMs: tokenTtlMs(exp, res.headers.get('date'), (deps.now ?? Date.now)())
    }
  } finally {
    clearTimeout(timer)
  }
}
