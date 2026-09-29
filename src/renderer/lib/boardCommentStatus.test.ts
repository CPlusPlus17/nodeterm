import { describe, it, expect } from 'vitest'
import type { BoardLogEntry } from '@shared/types'
import { boardCommentSourceId, mentionToken } from '@shared/board-comment'
import { boardCommentTraces, isBoardCommentTrace, mentionStatuses } from './boardCommentStatus'

const comment = (id: string, text: string, ts = 100): BoardLogEntry => ({
  id,
  ts,
  author: { name: 'Enes', color: '#fff' },
  kind: 'comment',
  nodeId: 'card-a',
  text
})

const trace = (commentId: string, to: string, title: string, ts: number, reason?: string): BoardLogEntry => ({
  id: `t-${commentId}-${to}-${ts}`,
  ts,
  author: { name: 'nodeterm', color: '#8b8b8b' },
  kind: 'event',
  nodeId: to,
  event: { type: 'agent-message', from: boardCommentSourceId(commentId), to, title, ...(reason ? { reason } : {}) }
})

const text = `${mentionToken('b1', 'Beta')} and ${mentionToken('b2', 'Two')} go`

describe('mentionStatuses', () => {
  it('reads each mention\'s LATEST recorded outcome from the log, in mention order', () => {
    const entries = [
      trace('c1', 'b1', 'delivered', 300),
      trace('c1', 'b2', 'notPermitted', 250, 'switch-off'),
      trace('c1', 'b1', 'queued', 200),
      comment('c1', text)
    ]
    const s = mentionStatuses(comment('c1', text), boardCommentTraces(entries))
    expect(s.map((m) => m.nodeId)).toEqual(['b1', 'b2'])
    expect(s[0].view).toEqual({ tone: 'ok', text: 'delivered' })
    expect(s[1].view.text).toMatch(/agent messaging is off for this project/)
  })

  it('a newer reply from THIS app run wins over an older log line, and "sending" shows until one lands', () => {
    const traces = boardCommentTraces([trace('c1', 'b1', 'queued', 200)])
    const s = mentionStatuses(comment('c1', text), traces, {
      b1: { at: 250, state: 'done', kind: 'rateLimited' },
      b2: { at: 150, state: 'sending' }
    })
    expect(s[0].view.text).toMatch(/moments ago/)
    expect(s[1].view).toEqual({ tone: 'pending', text: 'sending…' })
  })

  it('a failure with no typed outcome still says it was not delivered', () => {
    const s = mentionStatuses(comment('c1', text), new Map(), {
      b1: { at: 1, state: 'done', kind: 'error', error: 'Message not sent: resolve the conflict.' }
    })
    expect(s).toEqual([
      { nodeId: 'b1', view: { tone: 'error', text: 'not delivered — Message not sent: resolve the conflict.' } }
    ])
  })

  it('a mention with no record at all shows nothing — a pulled comment is not claimed delivered', () => {
    expect(mentionStatuses(comment('c9', text), new Map())).toEqual([])
  })

  it('another comment\'s lines never attach, and a forged `from` that is not a comment id is ignored', () => {
    const entries = [
      trace('c2', 'b1', 'delivered', 300),
      { ...trace('c1', 'b1', 'delivered', 300), event: { type: 'agent-message' as const, from: 'a1', to: 'b1', title: 'delivered' } }
    ]
    expect(mentionStatuses(comment('c1', text), boardCommentTraces(entries))).toEqual([])
  })
})

describe('isBoardCommentTrace', () => {
  it('names only the delivery lines a board comment produced', () => {
    expect(isBoardCommentTrace(trace('c1', 'b1', 'delivered', 1))).toBe(true)
    expect(
      isBoardCommentTrace({
        ...trace('c1', 'b1', 'delivered', 1),
        event: { type: 'agent-message', from: 'a1', to: 'b1', title: 'delivered' }
      })
    ).toBe(false)
    expect(isBoardCommentTrace(comment('c1', text))).toBe(false)
  })
})
