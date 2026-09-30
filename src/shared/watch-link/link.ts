// The viewer URL: https://nodeterm.dev/s/<linkId>#1.<S>. The id names a link and unlocks nothing;
// S is in the FRAGMENT so it never reaches an HTTP request, a server log or a referrer.
import { b64urlToBytes, bytesToB64url } from './bytes'
import { WATCH_LINK_SECRET_BYTES } from './keys'

export const WATCH_LINK_ORIGIN = 'https://nodeterm.dev'
export const WATCH_LINK_FRAGMENT_VERSION = '1'
export const LINK_ID_RE = /^[A-Za-z0-9_-]{22}$/

export function formatWatchLink(linkId: string, secret: Uint8Array, origin: string = WATCH_LINK_ORIGIN): string {
  return `${origin}/s/${linkId}#${WATCH_LINK_FRAGMENT_VERSION}.${bytesToB64url(secret)}`
}

export function parseWatchLinkLocation(pathname: string, hash: string): { linkId: string; secret: Uint8Array } | null {
  const m = /^\/s\/([^/]+)\/?$/.exec(pathname)
  if (!m || !LINK_ID_RE.test(m[1])) return null
  const frag = hash.startsWith('#') ? hash.slice(1) : hash
  const dot = frag.indexOf('.')
  if (dot < 0 || frag.slice(0, dot) !== WATCH_LINK_FRAGMENT_VERSION) return null
  const secret = b64urlToBytes(frag.slice(dot + 1))
  if (!secret || secret.length !== WATCH_LINK_SECRET_BYTES) return null
  return { linkId: m[1], secret }
}
