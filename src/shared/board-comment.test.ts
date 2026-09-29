import { describe, it, expect } from 'vitest'
import {
  BOARD_COMMENT_BODY_MAX,
  BOARD_COMMENT_MENTION_MAX,
  boardCommentBody,
  boardCommentFrom,
  boardCommentSourceId,
  commentIdOfSource,
  commentSegments,
  commentTextForAgent,
  isBoardCommentDeliverRequest,
  mentionLabel,
  mentionToken,
  parseMentions
} from './board-comment'

describe('mention tokens', () => {
  it('round-trips: the token a picker inserts is the id the parser finds', () => {
    const text = `hey ${mentionToken('term-1a2b', 'Claude fix')} please look`
    expect(parseMentions(text)).toEqual(['term-1a2b'])
    expect(commentSegments(text)).toEqual([
      { kind: 'text', text: 'hey ' },
      { kind: 'mention', nodeId: 'term-1a2b', label: 'Claude fix' },
      { kind: 'text', text: ' please look' }
    ])
  })

  it('is id-based: the label cannot smuggle a second token or break the frame', () => {
    // A title can hold brackets, parens, newlines, ESC — none of them may survive into the token's
    // label, or a title could close the label early and name a different node id.
    const token = mentionToken('a1', 'x](node:evil) \n\x1b[31mred')
    expect(parseMentions(`${token}`)).toEqual(['a1'])
    expect(token).not.toContain('\n')
    expect(token).not.toContain('\x1b')
  })

  it('finds each node once, in order, and ignores an id that is not addressable', () => {
    const t = `${mentionToken('b', 'B')} ${mentionToken('a', 'A')} ${mentionToken('b', 'B again')} @[x](node:../etc)`
    expect(parseMentions(t)).toEqual(['b', 'a'])
  })

  it('plain @words and look-alikes are not mentions', () => {
    expect(parseMentions('mail @enes or @[x](nodes:a) or @[x](node:)')).toEqual([])
  })

  it('caps a label', () => {
    expect(mentionLabel('x'.repeat(500)).length).toBeLessThanOrEqual(60)
    expect(mentionLabel('  a \t b  ')).toBe('a b')
  })
})

describe('the delivered body', () => {
  it('turns tokens into @names, preferring the current title', () => {
    const text = `${mentionToken('a1', 'Old')} and ${mentionToken('b1', 'Bee')}: go`
    expect(commentTextForAgent(text, (id) => (id === 'a1' ? 'Alpha' : undefined))).toBe(
      '@Alpha and @Bee: go'
    )
  })

  it('a title that reaches the body through the store cannot carry a newline', () => {
    const text = `${mentionToken('a1', 'A')} go`
    expect(commentTextForAgent(text, () => 'evil\n/exit')).toBe('@evil /exit go')
  })

  it('strips ESC and every other control character but keeps newlines and tabs', () => {
    const raw = 'line1\n\tline2\x1b[201~\x03\x15\x0b\r\u009b end'
    const out = boardCommentBody(raw)
    expect(out).toBe('line1\n\tline2[201~ end')
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
  })

  it('caps the body', () => {
    const out = boardCommentBody('y'.repeat(BOARD_COMMENT_BODY_MAX + 50))
    expect(out.length).toBeLessThanOrEqual(BOARD_COMMENT_BODY_MAX + 1)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('provenance', () => {
  it('a board-comment source id carries the comment id and is never a node id', () => {
    const src = boardCommentSourceId('c-123')
    expect(commentIdOfSource(src)).toBe('c-123')
    expect(src).toContain(':') // node ids are [A-Za-z0-9._-] — a ':' can never be one
    expect(commentIdOfSource('a1')).toBeNull()
    expect(commentIdOfSource(42)).toBeNull()
  })

  it('names the person, one line, capped', () => {
    expect(boardCommentFrom('Enes')).toBe('board comment by Enes')
    expect(boardCommentFrom('a\nb')).toBe('board comment by a b')
    expect(boardCommentFrom('').startsWith('board comment by ')).toBe(true)
    expect(boardCommentFrom('z'.repeat(400)).length).toBeLessThan(100)
  })
})

describe('isBoardCommentDeliverRequest', () => {
  const ok = {
    projectId: 'p1',
    commentId: '7f1e2a4c-9d0b-4c3e-8a11-0b1c2d3e4f50',
    author: 'Enes',
    text: `${mentionToken('b1', 'B')} go`,
    targetNodeId: 'b1'
  }
  it('accepts the shape the panel sends', () => {
    expect(isBoardCommentDeliverRequest(ok)).toBe(true)
  })
  it('refuses a target the text does not mention — the text is the only authority', () => {
    expect(isBoardCommentDeliverRequest({ ...ok, targetNodeId: 'c2' })).toBe(false)
  })
  it(`refuses a comment that mentions more than ${BOARD_COMMENT_MENTION_MAX} sessions`, () => {
    const many = Array.from({ length: BOARD_COMMENT_MENTION_MAX + 1 }, (_, i) =>
      mentionToken(`n${i}`, `N${i}`)
    ).join(' ')
    expect(isBoardCommentDeliverRequest({ ...ok, text: many, targetNodeId: 'n0' })).toBe(false)
  })
  it('refuses malformed fields', () => {
    for (const bad of [
      null,
      { ...ok, projectId: 'p\u00001' },
      { ...ok, projectId: '' },
      { ...ok, commentId: 'no spaces' },
      { ...ok, author: 5 },
      { ...ok, text: 5 }
    ])
      expect(isBoardCommentDeliverRequest(bad), JSON.stringify(bad)).toBe(false)
  })
})
