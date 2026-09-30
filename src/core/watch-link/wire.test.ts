import { describe, it, expect } from 'vitest'
import { hkdfSync } from 'node:crypto'
import nacl from 'tweetnacl'
import { encodePtyData, encodeArgs, parseRpcMessage } from '../../shared/rpc'
import { decrypt, deriveSessionKey, encrypt, randomSessionNonce } from '../relay/e2ee'
import { hkdfSha256 } from '../../shared/watch-link/hkdf'
import { sealBox, openBox, withHeader, readHeader, encodePtyFrame, decodePtyFrame, parseTunnelJson, NONCE_BYTES, RELAY_SESSION_INFO } from '../../shared/watch-link/wire'
import { sanitizeChatText, sanitizeChatName, isWatchEndReason, WATCH_CHAT_CAST, WATCH_EVENT_PREFIX } from '../../shared/watch-link/protocol'
import { concatBytes, utf8 } from '../../shared/watch-link/bytes'

describe('the wire rules match the relay they were copied from', () => {
  it('HKDF equals node:crypto', async () => {
    const ikm = nacl.randomBytes(32), salt = nacl.randomBytes(32)
    const ours = await hkdfSha256(ikm, salt, utf8(RELAY_SESSION_INFO), 32)
    expect(ours).toEqual(new Uint8Array(hkdfSync('sha256', ikm, salt, utf8(RELAY_SESSION_INFO), 32)))
  })
  it("HKDF info and salt order equal the relay's deriveSessionKey", async () => {
    // The test above feeds OUR info string to both sides, so it cannot see the relay's change.
    // This one derives the relay's session key from its own code: salt = hostNonce ‖ clientNonce.
    const base = nacl.randomBytes(32), hn = randomSessionNonce(), cn = randomSessionNonce()
    expect(await hkdfSha256(base, concatBytes(hn, cn), utf8(RELAY_SESSION_INFO), 32)).toEqual(deriveSessionKey(base, hn, cn))
  })
  it("the session nonce is as long as e2ee's randomSessionNonce", () => {
    expect(randomSessionNonce()).toHaveLength(NONCE_BYTES)
  })
  it('a box sealed here opens with e2ee.decrypt and vice versa', () => {
    const key = nacl.randomBytes(32), plain = utf8('hello')
    expect(decrypt(sealBox(plain, key), key)).toEqual(plain)
    expect(openBox(encrypt(plain, key), key)).toEqual(plain)
    expect(openBox(Uint8Array.of(1, 2, 3), key)).toBeNull()
  })
  it('the header is role, seq high word LE, seq low word LE', () => {
    const h = withHeader(2, 2 ** 32 + 7, utf8('x'))
    expect(Array.from(h.slice(0, 9))).toEqual([2, 1, 0, 0, 0, 7, 0, 0, 0])
    expect(readHeader(h)).toEqual({ role: 2, seq: 2 ** 32 + 7, body: utf8('x') })
    expect(readHeader(Uint8Array.of(1, 2))).toBeNull()
  })
  it('pty frames equal rpc.ts', () => {
    const sid = 'sess-é', data = 'a\u001b[31mbé'
    expect(encodePtyFrame(sid, data)).toEqual(encodePtyData(sid, data))
    expect(decodePtyFrame(encodePtyData(sid, data))).toEqual({ sessionId: sid, data })
    expect(decodePtyFrame(Uint8Array.of(9))).toBeNull()
  })
  it('tunnel JSON parses like parseRpcMessage, undefined slots included', () => {
    const ev = JSON.stringify({ t: 'ev', channel: 'watch:meta', ...encodeArgs([{ a: 1 }, undefined]) })
    expect(parseTunnelJson(ev)).toEqual(parseRpcMessage(ev))
    const cast = JSON.stringify({ t: 'cast', method: 'trust:confirm', args: [] })
    expect(parseTunnelJson(cast)).toEqual({ t: 'cast', method: 'trust:confirm', args: [] })
    expect(parseTunnelJson('{"t":"res","id":1,"ok":true,"result":1}')).toBeNull()
    expect(parseTunnelJson('nope')).toBeNull()
  })
})

describe('protocol', () => {
  it('the viewer cast is not in the host-only owner namespace', () => {
    expect(WATCH_CHAT_CAST.startsWith('watchLink:')).toBe(false)
    expect(WATCH_EVENT_PREFIX).toBe('watch:')
  })
  it('sanitizes chat text and names', () => {
    expect(sanitizeChatText('  hi\u0007 there\nfriend \u009b ')).toBe('hi there friend')
    expect(sanitizeChatText('x'.repeat(600))).toHaveLength(500)
    expect(sanitizeChatText('   ')).toBeNull()
    expect(sanitizeChatText(42)).toBeNull()
    expect(sanitizeChatName('\u001b[31mAda')).toBe('[31mAda')
    expect(sanitizeChatName('n'.repeat(40))).toHaveLength(32)
    expect(isWatchEndReason('kicked')).toBe(true)
    expect(isWatchEndReason('nope')).toBe(false)
  })
})
