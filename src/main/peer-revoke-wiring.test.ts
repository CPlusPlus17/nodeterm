// Forgetting a paired phone must reach the revoker that CUTS its live relay session (audit
// A07-revoke), and nothing but this file's shell can make that true.
//
// `PairingRelayDeps.revokeRelayKey` is optional and typed as "a key in, a result out", so wiring it
// to a bare unpin (what it was before: `updateApprovedDevices(unpinDevice)`) is well-typed, passes
// every unit test, and ships the hole again: the pin goes, the phone that is connected right then
// keeps its terminals. standing-host.test.ts proves the revoker cuts; this pins that main hands the
// pairing service THAT revoker. Same remedy as remote-end-wiring.test.ts: pinned at source level.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const SRC = readFileSync(path.join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The text of the `createPairingService({ … })` call: up to its closing `})` at that indentation. */
function pairingServiceCall(): string {
  const start = SRC.indexOf('createPairingService({')
  expect(start, 'createPairingService is not called — this guard is looking at the wrong file').toBeGreaterThan(-1)
  const end = SRC.indexOf('\n  })', start)
  expect(end).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe('main hands the phone revoke the session-cutting revoker', () => {
  it('builds ONE peer revoker, before the pairing service that uses it', () => {
    const at = SRC.indexOf('const peerRevoker = createPeerRevoker()')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(SRC.indexOf('createPairingService({'))
    // A second, hand-assembled revoker is how one revoke path ends up cutting less than the other.
    expect(SRC).not.toContain('createRevoker(')
  })

  it('the pairing service revokes a phone relay key through it', () => {
    expect(pairingServiceCall()).toContain('revokeRelayKey: (pub) => peerRevoker.revoke(pub)')
  })

  it('`remote:revoke-peer` goes through the same revoker', () => {
    const handler = SRC.indexOf('ipcMain.handle(IPC.remoteRevokePeer')
    expect(handler).toBeGreaterThan(-1)
    expect(SRC.slice(handler, handler + 200)).toContain('peerRevoker.revoke(')
  })
})
