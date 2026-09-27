// The production HostChatOps (host-chat.ts), over injected deps. What these pin:
//   - Every verb resolves the node HOST-side (`lookupNode`); nothing about the node comes from the
//     phone. A node the host does not know is refused (null / 'unknown-node' / false).
//   - `page` always reads PAGED (an absent page is the default tail, never the legacy 5 MB read),
//     stamps `version: 1`, and never lets a node with no session id fall back to the cwd's newest
//     transcript (a stranger's session).
//   - `status` / `send` ask the renderer and FAIL CLOSED: a renderer that does not answer within
//     the timeout is an error for status and a refusal for send — never a guessed state, never
//     "sent".
//   - `answer` runs `answerHeldPermission` with the node's I/O, and reports the answered
//     transition on success only.
import { describe, expect, it, vi } from 'vitest'
import { createHostChat, mirrorRefusesChatSend, type HostChatDeps } from './host-chat'
import type { ChatTranscriptResult } from '../../shared/types'
import type { HeldPermissionIo } from '../../core/agents/permission-decision'

const RESULT: ChatTranscriptResult = { messages: [], found: true, olderCursor: null, unmatchedResults: [], model: 'm' }
const RSTATUS = { state: 'done' as const, held: null, hibernated: false, paused: false, dropped: false, sessionEnded: false }

function deps(over: Partial<HostChatDeps> = {}): HostChatDeps {
  return {
    lookupNode: vi.fn((id: string) =>
      id === 'n1' ? { cwd: '/srv/app', accountId: 'acc', agentId: 'claude', sessionId: 'sid-1' } : null
    ),
    readTranscript: vi.fn(async () => RESULT),
    answerIo: vi.fn(() => ({ readPending: async () => null, write: async () => true }) as HeldPermissionIo),
    answerHeld: vi.fn(async () => ({ ok: true, decision: 'allow' as const })),
    onAnswered: vi.fn(),
    isStructuredTicket: vi.fn(() => false),
    renderer: {
      status: vi.fn(async () => RSTATUS),
      send: vi.fn(async () => 'sent' as const),
      session: vi.fn(async () => ({ sessionId: 'sid-1' }))
    },
    hostSendRefusal: vi.fn(() => false),
    knownTickets: vi.fn(() => ['p-1']),
    timeoutMs: 20,
    sendTimeoutMs: 40,
    now: () => 1000,
    ...over
  }
}

describe('host-chat page', () => {
  it('resolves the node host-side, reads paged and stamps version 1 (local node: no cwd)', async () => {
    const d = deps()
    const page = await createHostChat(d).page('n1', { before: 10, maxBytes: 65536 })
    expect(page).toEqual({ ...RESULT, version: 1 })
    // A LOCAL node reads by session id only: with a cwd, a known-but-dead id would fall back to the
    // newest transcript in that cwd — another node's session.
    expect(d.readTranscript).toHaveBeenCalledWith(
      { sessionId: 'sid-1', cwd: undefined, accountId: 'acc', nodeId: 'n1', agentId: 'claude' },
      { before: 10, maxBytes: 65536 }
    )
  })
  it('a REMOTE node keeps its cwd (the host-side locate is keyed on it)', async () => {
    const d = deps({ lookupNode: () => ({ cwd: '/srv/app', agentId: 'claude', sessionId: 'sid-1', remote: true }) })
    await createHostChat(d).page('n1', {})
    expect(d.readTranscript).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/srv/app', sessionId: 'sid-1' }), {})
  })
  it('an absent page is the default paged tail, not the legacy read', async () => {
    const d = deps()
    await createHostChat(d).page('n1', undefined)
    expect(d.readTranscript).toHaveBeenCalledWith(expect.anything(), {})
  })
  it('a node the host does not know is null (and nothing is read)', async () => {
    const d = deps()
    expect(await createHostChat(d).page('nope', {})).toBeNull()
    expect(d.readTranscript).not.toHaveBeenCalled()
  })
  it('the RENDERER\'s session id wins over the host records (what ⌘M shows)', async () => {
    const d = deps({
      lookupNode: () => ({ cwd: '/srv/app', agentId: 'claude', sessionId: 'stale-minted' }),
      renderer: { status: vi.fn(), send: vi.fn(), session: vi.fn(async () => ({ sessionId: 'hook-fed' })) }
    })
    await createHostChat(d).page('n1', {})
    expect(d.readTranscript).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'hook-fed' }), {})
    expect(d.renderer.session).toHaveBeenCalledWith({ nodeId: 'n1' })
  })
  it('falls back to the host records when the renderer does not answer in time, or knows none', async () => {
    for (const session of [() => new Promise<never>(() => {}), async () => null, async () => ({})]) {
      const d = deps({
        lookupNode: () => ({ agentId: 'claude', sessionId: 'mirror-id' }),
        renderer: { status: vi.fn(), send: vi.fn(), session: session as never }
      })
      await createHostChat(d).page('n1', {})
      expect(d.readTranscript).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'mirror-id' }), {})
    }
  })
  it('no known session id anywhere ⇒ no cwd either, so no cwd fallback onto a stranger\'s transcript', async () => {
    const d = deps({
      lookupNode: () => ({ cwd: '/srv/app', agentId: 'claude', remote: true }),
      renderer: { status: vi.fn(), send: vi.fn(), session: vi.fn(async () => ({})) }
    })
    await createHostChat(d).page('n1', {})
    expect(d.readTranscript).toHaveBeenCalledWith(
      { sessionId: undefined, cwd: undefined, accountId: undefined, nodeId: 'n1', agentId: 'claude' },
      {}
    )
  })
})

describe('host-chat status', () => {
  it('asks the renderer with the host\'s agent id and adds structuredAnswers for a held ticket', async () => {
    const held = { pendingId: 'p-1', toolName: 'ExitPlanMode' }
    const d = deps({
      renderer: { status: vi.fn(async () => ({ ...RSTATUS, state: 'waiting' as const, held })), send: vi.fn(), session: vi.fn() },
      isStructuredTicket: vi.fn((id: string) => id === 'p-1')
    })
    const s = await createHostChat(d).status('n1')
    expect(s).toEqual({ ...RSTATUS, state: 'waiting', held, structuredAnswers: true })
    expect(d.renderer.status).toHaveBeenCalledWith({ nodeId: 'n1', agentId: 'claude' })
  })
  it('structuredAnswers is false with no held request', async () => {
    const d = deps({ isStructuredTicket: vi.fn(() => true) })
    expect((await createHostChat(d).status('n1'))?.structuredAnswers).toBe(false)
  })
  it('unknown node ⇒ null, renderer never asked', async () => {
    const d = deps()
    expect(await createHostChat(d).status('nope')).toBeNull()
    expect(d.renderer.status).not.toHaveBeenCalled()
  })
  it('a renderer that does not answer in time (or has no window) REJECTS — never a guessed state', async () => {
    const hang = deps({ renderer: { status: () => new Promise(() => {}), send: vi.fn(), session: vi.fn() } })
    await expect(createHostChat(hang).status('n1')).rejects.toThrow()
    const gone = deps({ renderer: { status: async () => null, send: vi.fn(), session: vi.fn() } })
    await expect(createHostChat(gone).status('n1')).rejects.toThrow()
  })
})

describe('host-chat send', () => {
  it('asks the renderer (which owns the send gate) and passes its answer through', async () => {
    const d = deps()
    expect(await createHostChat(d).send('n1', 'hello')).toBe('sent')
    // startBy = now + timeoutMs: the renderer refuses a send it receives after that.
    expect(d.renderer.send).toHaveBeenCalledWith({ nodeId: 'n1', agentId: 'claude', text: 'hello', startBy: 1020 })
  })
  it('unknown node ⇒ unknown-node, renderer never asked', async () => {
    const d = deps()
    expect(await createHostChat(d).send('nope', 'hi')).toBe('unknown-node')
    expect(d.renderer.send).not.toHaveBeenCalled()
  })
  it('never started (no window / a throw) ⇒ refused', async () => {
    for (const send of [async () => null, async () => { throw new Error('x') }]) {
      const d = deps({ renderer: { status: vi.fn(), send: send as never, session: vi.fn() } })
      expect(await createHostChat(d).send('n1', 'hi')).toBe('refused')
    }
  })
  it('dispatched but no answer in time ⇒ UNCONFIRMED, never refused (the phone must not resend)', async () => {
    const d = deps({ renderer: { status: vi.fn(), send: () => new Promise<never>(() => {}), session: vi.fn() } })
    expect(await createHostChat(d).send('n1', 'hi')).toBe('unconfirmed')
  })
  it('the host mirror says the agent is busy or asking ⇒ refused before the renderer is asked', async () => {
    const d = deps({ hostSendRefusal: vi.fn(() => true) })
    expect(await createHostChat(d).send('n1', 'hi')).toBe('refused')
    expect(d.hostSendRefusal).toHaveBeenCalledWith('n1')
    expect(d.renderer.send).not.toHaveBeenCalled()
  })
})

describe('host-chat answer', () => {
  it('runs answerHeldPermission with the node\'s I/O and reports the answered transition', async () => {
    const d = deps()
    const answer = { kind: 'plan', mode: 'restore' }
    expect(await createHostChat(d).answer('n1', 'p-1', answer)).toBe(true)
    expect(d.answerIo).toHaveBeenCalledWith('n1', 'p-1')
    const io = (d.answerIo as ReturnType<typeof vi.fn>).mock.results[0].value
    expect(d.answerHeld).toHaveBeenCalledWith('p-1', { answer }, io)
    expect(d.onAnswered).toHaveBeenCalledWith('n1', 'p-1', 'allow')
  })
  it('a refused answer is false and reports nothing', async () => {
    const d = deps({ answerHeld: vi.fn(async () => ({ ok: false })) })
    expect(await createHostChat(d).answer('n1', 'p-1', { kind: 'deny' })).toBe(false)
    expect(d.onAnswered).not.toHaveBeenCalled()
  })
  it('a pendingId that is not this node\'s ticket is refused: no I/O, no answered event', async () => {
    const d = deps({
      knownTickets: vi.fn(() => ['other-ticket']),
      renderer: { status: vi.fn(async () => ({ ...RSTATUS, held: { pendingId: 'mine', toolName: 'ExitPlanMode' } })), send: vi.fn(), session: vi.fn() }
    })
    expect(await createHostChat(d).answer('n1', 'not-mine', { kind: 'deny' })).toBe(false)
    expect(d.answerIo).not.toHaveBeenCalled()
    expect(d.answerHeld).not.toHaveBeenCalled()
    expect(d.onAnswered).not.toHaveBeenCalled()
  })
  it('binds through the renderer\'s held ticket OR the mirror\'s tickets for the node', async () => {
    const viaHeld = deps({
      knownTickets: vi.fn(() => []),
      renderer: { status: vi.fn(async () => ({ ...RSTATUS, held: { pendingId: 'h-1', toolName: 'AskUserQuestion' } })), send: vi.fn(), session: vi.fn() }
    })
    expect(await createHostChat(viaHeld).answer('n1', 'h-1', { kind: 'deny' })).toBe(true)
    const viaMirror = deps({
      knownTickets: vi.fn(() => ['m-1']),
      renderer: { status: () => new Promise<never>(() => {}), send: vi.fn(), session: vi.fn() }
    })
    expect(await createHostChat(viaMirror).answer('n1', 'm-1', { kind: 'deny' })).toBe(true)
    expect(viaMirror.knownTickets).toHaveBeenCalledWith('n1')
  })
  it('an unknown node is false and touches no I/O', async () => {
    const d = deps()
    expect(await createHostChat(d).answer('nope', 'p-1', { kind: 'deny' })).toBe(false)
    expect(d.answerIo).not.toHaveBeenCalled()
    expect(d.answerHeld).not.toHaveBeenCalled()
  })
  it('the real answerHeldPermission refuses a structured answer on a non-capable ticket (no write)', async () => {
    const write = vi.fn(async () => true)
    const d = deps({
      answerHeld: undefined,
      knownTickets: () => ['never-seen-ticket'],
      answerIo: () => ({ readPending: async () => null, write })
    })
    expect(await createHostChat(d).answer('n1', 'never-seen-ticket', { kind: 'plan', mode: 'restore' })).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('mirrorRefusesChatSend (the host half of the send gate)', () => {
  it('refuses a busy / asking agent and any held question or approval; passes done and unknown', () => {
    for (const state of ['working', 'waiting', 'blocked']) expect(mirrorRefusesChatSend({ state })).toBe(true)
    expect(mirrorRefusesChatSend({ state: 'done', pendingQuestion: { sessionId: 's', toolUseId: 't' } })).toBe(true)
    expect(mirrorRefusesChatSend({ state: 'done', concurrentApprovalIds: ['p'] })).toBe(true)
    expect(mirrorRefusesChatSend({ state: 'done' })).toBe(false)
    expect(mirrorRefusesChatSend({ state: 'done', concurrentApprovalIds: [] })).toBe(false)
    expect(mirrorRefusesChatSend(undefined)).toBe(false)
  })
})
