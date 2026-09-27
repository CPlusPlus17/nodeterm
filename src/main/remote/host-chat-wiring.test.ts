// The phone Chat verbs' `chat` dependency is OPTIONAL at every hop (host-service's handler
// parameter, HostSessionOptions, HostBridgeDeps), so dropping it anywhere compiles and passes every
// unit test while every phone gets "chat.page is not served on this host." — the verbs shipped
// inert. Pinned at source level, the remedy this repo uses for exactly that class of hole
// (hook-verified-parity.test.ts, codex-identity-record-wiring.test.ts).
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('phone chat verbs are wired end to end', () => {
  it('main builds the ops and puts them on the shared host bridge', () => {
    const src = read('main/index.ts')
    expect(src).toMatch(/\n\s{4}chat: createHostChat\(\{/)
    // Both phone hosts receive that one bridge.
    expect(src).toMatch(/initRemoteHost\(win, ptyManager, listProjectsOutput, hostBridge\)/)
    expect(src).toMatch(/initStandingHost\(.*, hostBridge\)/)
  })
  it('both phone hosts forward bridge.chat into the session, and the session into the handlers', () => {
    expect(read('main/remote/host-service.ts')).toMatch(/chat: bridge\.chat,/)
    expect(read('main/remote/standing-host.ts')).toMatch(/chat: bridge\.chat,/)
    expect(read('main/remote/host-service.ts')).toMatch(/opts\.kanban,\n\s*opts\.chat\n\s*\)/)
  })
  it('the renderer answers the round-trip', () => {
    const canvas = read('renderer/canvas/Canvas.tsx')
    expect(canvas).toMatch(/api\.onHostChatQuery\(/)
    expect(canvas).toMatch(/api\.sendHostChatReply\(/)
  })
})
