import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveWatchLinkKeys, sha256Hex } from './keys'
import { bytesToHex } from './bytes'
import { formatWatchLink } from './link'
import { encodePtyFrame } from './wire'

// vectors.json is what nodeterm-web's copy is tested against. It is the fixture; this test proves
// the code still produces it. Regenerate ONLY for a deliberate protocol change (bump the version).
const vectors = JSON.parse(readFileSync(join(__dirname, 'vectors.json'), 'utf8').replace(/\r\n/g, '\n'))

describe('watch-link vectors', () => {
  it('the code reproduces every vector', async () => {
    for (const v of vectors.keys) {
      const secret = Uint8Array.from(Buffer.from(v.secretHex, 'hex'))
      const k = deriveWatchLinkKeys(secret)
      expect(bytesToHex(k.host.publicKey)).toBe(v.hostPublicHex)
      expect(bytesToHex(k.viewer.publicKey)).toBe(v.viewerPublicHex)
      expect(bytesToHex(k.joinKey)).toBe(v.joinKeyHex)
      expect(await sha256Hex(k.joinKey)).toBe(v.joinKeyHashHex)
      expect(formatWatchLink(v.linkId, secret)).toBe(v.url)
    }
    for (const f of vectors.ptyFrames) expect(bytesToHex(encodePtyFrame(f.sessionId, f.data))).toBe(f.hex)
  })
})
