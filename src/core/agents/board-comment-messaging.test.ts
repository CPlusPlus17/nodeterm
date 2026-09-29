/**
 * A board comment that @mentions a session is delivered through the SAME messaging gates an
 * agent-to-agent `send` takes: scope off main's store, runtime pane ownership, the per-project
 * switch, flow control, the pane probes, the nonce envelope, the receipt, the trace and the
 * deliver-on-idle queue. Every assertion here runs the service; none reads its source.
 *
 * What this file adds over `src/main/agent-messaging.test.ts`: the HUMAN source. There is no
 * sender node, so the scope is "is the target on the comment's board", the flow budget belongs to
 * the board, and the envelope names the person who wrote the comment.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createDeliveryQueue,
  deliverBoardCommentFromUi,
  isDeliverRequest,
  onMessagingAgentEvent,
  type AgentMessagingDeps
} from './agent-messaging'
import { resetMessageFlow } from './agent-message-flow'
import { resetAgentMessageTraceForTests } from './agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import { RETRYABLE } from './agent-message-decide'
import type { MirrorEntry } from '../agent-status-mirror'
import type { BoardLogEntry } from '../../shared/types'
import {
  BOARD_COMMENT_MENTION_MAX,
  BOARD_COMMENT_REPLY_TO,
  boardCommentOutcomeText,
  boardCommentSourceId,
  mentionToken
} from '../../shared/board-comment'
import { FANOUT_PER_TURN } from './agent-message-flow'

const idle: MirrorEntry = {
  state: 'done',
  updatedAt: 1,
  stateVerified: true,
  clientRevision: MANAGED_SCRIPT_REVISION
}
const busy: MirrorEntry = { ...idle, state: 'working' }

interface Rec {
  paneOwnerCalls: string[]
  sent: { nodeId: string; payload: string }[]
  log: { projectId: string; entry: BoardLogEntry }[]
}

function fakeDeps(over: Partial<AgentMessagingDeps> = {}): AgentMessagingDeps & { rec: Rec } {
  const rec: Rec = { paneOwnerCalls: [], sent: [], log: [] }
  const projectsFn =
    over.projects ??
    (() => [
      {
        id: 'p1',
        nodes: [
          { id: 'a1', title: 'Alpha', agentId: 'claude' },
          { id: 'b1', title: 'Beta', agentId: 'claude' },
          { id: 'b2', title: 'Beta two', agentId: 'claude' },
          { id: 'b3', title: 'Beta three', agentId: 'claude' },
          { id: 'b4', title: 'Beta four', agentId: 'claude' },
          { id: 'b5', title: 'Beta five', agentId: 'claude' }
        ]
      },
      { id: 'p2', nodes: [{ id: 'c2', title: 'Gamma', agentId: 'claude' }] }
    ])
  return {
    rec,
    paneOwner: async (nodeId) => {
      rec.paneOwnerCalls.push(nodeId)
      return { tty: '/dev/pts/9', panePid: 100, paneId: '%1', command: 'claude', argv: ['claude'], pids: [200] }
    },
    sendEnvelope: async (nodeId, payload) => {
      rec.sent.push({ nodeId, payload })
      return true
    },
    hasLiveSession: () => true,
    mirrorEntry: () => idle,
    projects: projectsFn,
    isRemoteNode: () => false,
    messagingEnabled: () => true,
    paneOwnerProject: (id) => projectsFn().find((p) => p.nodes.some((n) => n.id === id))?.id,
    customAgents: () => undefined,
    appendBoardLog: async (projectId, entry) => {
      rec.log.push({ projectId, entry })
      return true
    },
    subscribeReceipts: (cb) => {
      const t = setTimeout(() => {
        for (const id of ['b1', 'b2', 'b3', 'b4', 'b5']) cb({ nodeId: id, newTurn: true, verified: true })
      }, 5)
      return () => clearTimeout(t)
    },
    now: () => 1_000_000,
    ...over
  }
}

let seq = 0
const comment = (targetNodeId: string, text?: string, over: Record<string, unknown> = {}) => ({
  projectId: 'p1',
  commentId: `c-${++seq}`,
  author: 'Enes',
  text: text ?? `${mentionToken(targetNodeId, 'Beta')} please rebase`,
  targetNodeId,
  ...over
})

beforeEach(() => {
  resetMessageFlow()
  resetAgentMessageTraceForTests()
})

describe('a board comment that mentions a session', () => {
  it('is delivered through the gate, framed as a board comment by the person who wrote it', async () => {
    const deps = fakeDeps()
    const reply = await deliverBoardCommentFromUi(comment('b1'), deps)
    expect(reply.ok).toBe(true)
    expect((reply.result as { kind: string }).kind).toBe('delivered')
    // The gate ran: the pane was probed before (and after) the write.
    expect(deps.rec.paneOwnerCalls).toContain('b1')
    expect(deps.rec.sent).toHaveLength(1)
    const payload = deps.rec.sent[0].payload
    expect(payload).toMatch(/^--- NODETERM MESSAGE \S+ ---\n/)
    expect(payload).toContain('from: board comment by Enes\n')
    expect(payload).toContain(`reply-to: ${BOARD_COMMENT_REPLY_TO}\n`)
    // The token reached the agent as a readable @name — the store's title, not the token's label.
    expect(payload).toContain('@Beta please rebase')
    expect(payload).not.toContain('(node:')
  })

  it('switch off ⇒ refused with the reason, before any pane is touched, and the reason is traced', async () => {
    const deps = fakeDeps({ messagingEnabled: () => false })
    const c = comment('b1')
    const reply = await deliverBoardCommentFromUi(c, deps)
    expect(reply.ok).toBe(false)
    expect(reply.result).toEqual({ kind: 'notPermitted', reason: 'switch-off' })
    expect(deps.rec.paneOwnerCalls).toEqual([])
    expect(deps.rec.sent).toEqual([])
    // The durable trace carries the comment's provenance AND the reason, so the comment row can
    // still say WHY after a reload.
    const line = deps.rec.log.find((l) => l.entry.event?.from === boardCommentSourceId(c.commentId))
    expect(line?.projectId).toBe('p1')
    expect(line?.entry.event).toMatchObject({
      type: 'agent-message',
      to: 'b1',
      title: 'notPermitted',
      reason: 'switch-off'
    })
  })

  it('a session that was not proven spawned by this project is refused', async () => {
    const deps = fakeDeps({ paneOwnerProject: () => undefined })
    const reply = await deliverBoardCommentFromUi(comment('b1'), deps)
    expect(reply.result).toEqual({ kind: 'notPermitted', reason: 'unproven-target-owner' })
    expect(deps.rec.sent).toEqual([])
  })

  it('a session on ANOTHER board is refused — the comment\'s project is the scope', async () => {
    const deps = fakeDeps()
    const other = await deliverBoardCommentFromUi(comment('c2'), deps)
    expect(other.result).toEqual({ kind: 'notPermitted', reason: 'cross-project' })
    const nowhere = await deliverBoardCommentFromUi(comment('zz'), deps)
    expect(nowhere.result).toEqual({ kind: 'notPermitted', reason: 'cross-project' })
    expect(deps.rec.sent).toEqual([])
  })

  it('a node id listed by two projects is refused as ambiguous', async () => {
    const deps = fakeDeps({
      projects: () => [
        { id: 'p1', nodes: [{ id: 'b1', title: 'Beta', agentId: 'claude' }] },
        { id: 'p9', nodes: [{ id: 'b1', title: 'Clone', agentId: 'claude' }] }
      ]
    })
    const reply = await deliverBoardCommentFromUi(comment('b1'), deps)
    expect(reply.result).toEqual({ kind: 'notPermitted', reason: 'ambiguous-target-node-id' })
  })

  it('strips ESC and every other control character before the envelope', async () => {
    const deps = fakeDeps()
    const text = `${mentionToken('b1', 'B')} x\x1b[201~\x03\x15\x0b\r y\nsecond line`
    await deliverBoardCommentFromUi(comment('b1', text), deps)
    const payload = deps.rec.sent[0].payload
    expect(payload).not.toContain('\x1b')
    expect(payload).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
    expect(payload).toContain('@Beta x[201~ y\nsecond line')
  })

  it('a malformed request is refused before anything runs — including a target the text does not mention', async () => {
    const deps = fakeDeps()
    for (const bad of [
      null,
      comment('b1', 'no mention at all'),
      comment('b1', `${mentionToken('b2', 'B2')} go`),
      comment('b1', undefined, { commentId: 'has space' })
    ]) {
      const reply = await deliverBoardCommentFromUi(bad, deps)
      expect(reply.ok).toBe(false)
      expect(reply.error).toMatch(/malformed/)
    }
    expect(deps.rec.paneOwnerCalls).toEqual([])
    expect(deps.rec.log).toEqual([])
  })

  it('an agent cannot dress a send up as a board comment on the agent channel', () => {
    expect(
      isDeliverRequest({ verb: 'board-comment', sourceNodeId: 'a1', targetNodeId: 'b1', body: 'x' })
    ).toBe(false)
  })

  it('the Server Edition (a creator-ledger shell) refuses board comments by edition', async () => {
    const deps = fakeDeps({ callerOwnsTarget: () => true })
    const reply = await deliverBoardCommentFromUi(comment('b1'), deps)
    expect(reply.result).toEqual({ kind: 'notPermitted', reason: 'unsupported-edition' })
    expect(deps.rec.sent).toEqual([])
  })
})

describe('flow control for a person', () => {
  it('two comments to the same session inside the pair window: the second is rateLimited', async () => {
    const deps = fakeDeps()
    expect((await deliverBoardCommentFromUi(comment('b1'), deps)).ok).toBe(true)
    const second = await deliverBoardCommentFromUi(comment('b1'), deps)
    expect((second.result as { kind: string }).kind).toBe('rateLimited')
    expect(deps.rec.sent).toHaveLength(1)
  })

  it('each comment is its own turn: a new comment has a fresh fan-out budget', async () => {
    expect(BOARD_COMMENT_MENTION_MAX).toBe(FANOUT_PER_TURN)
    const deps = fakeDeps()
    const targets = ['b1', 'b2', 'b3', 'b4']
    const text = targets.map((t) => mentionToken(t, t)).join(' ')
    const first = { ...comment('b1', text) }
    for (const t of targets) {
      const r = await deliverBoardCommentFromUi({ ...first, targetNodeId: t }, deps)
      expect((r.result as { kind: string }).kind, t).toBe('delivered')
    }
    // A fifth, different session in a NEW comment is not refused by the previous comment's budget.
    const next = await deliverBoardCommentFromUi(comment('b5'), deps)
    expect((next.result as { kind: string }).kind).toBe('delivered')
  })
})

describe('deliver-on-idle for a board comment', () => {
  it('a busy session queues the comment; the idle flush re-runs the BOARD gate and delivers', async () => {
    let entry: MirrorEntry = busy
    const deps = fakeDeps({ mirrorEntry: () => entry })
    deps.queue = createDeliveryQueue(deps, { schedule: () => () => {} })
    const c = comment('b1')
    const reply = await deliverBoardCommentFromUi(c, deps)
    expect((reply.result as { kind: string }).kind).toBe('queued')
    expect(deps.rec.sent).toEqual([])
    // The queued trace lands in the comment's board, carrying the comment's provenance.
    expect(
      deps.rec.log.some(
        (l) => l.projectId === 'p1' && l.entry.event?.title === 'queued' &&
          l.entry.event.from === boardCommentSourceId(c.commentId)
      )
    ).toBe(true)

    entry = idle
    onMessagingAgentEvent({ nodeId: 'b1', state: 'done', verified: true, newTurn: false }, deps.queue)
    await vi.waitFor(() => expect(deps.rec.sent).toHaveLength(1))
    expect(deps.rec.sent[0].payload).toContain('from: board comment by Enes')
    await vi.waitFor(() =>
      expect(
        deps.rec.log.filter(
          (l) => l.entry.event?.from === boardCommentSourceId(c.commentId) &&
            l.entry.event.title === 'delivered'
        )
      ).toHaveLength(1)
    )
  })

  it('a switch turned off while queued drops it at flush — the flush re-validates', async () => {
    let entry: MirrorEntry = busy
    let enabled = true
    const deps = fakeDeps({ mirrorEntry: () => entry, messagingEnabled: () => enabled })
    deps.queue = createDeliveryQueue(deps, { schedule: () => () => {} })
    const c = comment('b1')
    expect(((await deliverBoardCommentFromUi(c, deps)).result as { kind: string }).kind).toBe('queued')
    enabled = false
    entry = idle
    onMessagingAgentEvent({ nodeId: 'b1', state: 'done', verified: true, newTurn: false }, deps.queue)
    await vi.waitFor(() => expect(deps.queue!.depth('b1')).toBe(0))
    expect(deps.rec.sent).toEqual([])
    await vi.waitFor(() =>
      expect(
        deps.rec.log.some(
          (l) => l.entry.event?.from === boardCommentSourceId(c.commentId) &&
            l.entry.event.reason === 'switch-off'
        )
      ).toBe(true)
    )
  })

  it('an expiry is recorded in the comment\'s board even when the pane owner is no longer proven', async () => {
    let fire: (() => void) | null = null
    let owner: string | undefined = 'p1'
    const deps = fakeDeps({ mirrorEntry: () => busy, paneOwnerProject: () => owner })
    deps.queue = createDeliveryQueue(deps, {
      schedule: (_ms, fn) => {
        fire = fn
        return () => {
          fire = null
        }
      }
    })
    const c = comment('b1')
    expect(((await deliverBoardCommentFromUi(c, deps)).result as { kind: string }).kind).toBe('queued')
    owner = undefined
    fire!()
    await vi.waitFor(() =>
      expect(
        deps.rec.log.filter(
          (l) => l.projectId === 'p1' && l.entry.event?.from === boardCommentSourceId(c.commentId) &&
            l.entry.event.title === 'expired'
        )
      ).toHaveLength(1)
    )
  })
})

describe('the row text', () => {
  it('names every outcome the core can produce — no kind falls through to silence', () => {
    for (const kind of Object.keys(RETRYABLE)) {
      const t = boardCommentOutcomeText(kind)
      expect(t.text.length, kind).toBeGreaterThan(0)
      expect(t.text, kind).not.toMatch(/undefined/)
    }
    expect(boardCommentOutcomeText('delivered').tone).toBe('ok')
    expect(boardCommentOutcomeText('queued').tone).toBe('pending')
    expect(boardCommentOutcomeText('notPermitted', 'switch-off').text).toMatch(/off for this project/)
  })
})
