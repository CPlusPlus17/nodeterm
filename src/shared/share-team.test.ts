import { describe, it, expect } from 'vitest'
import { parseResumeSessions, RESUME_MAX_SESSIONS } from './share-team'

describe('parseResumeSessions', () => {
  it('accepts a list of entries and keeps only the known string fields', () => {
    expect(parseResumeSessions([{ nodeId: 'term-1', agentId: 'claude', sessionId: 's-1', permissionMode: 'auto', extra: 1 }])).toEqual([
      { nodeId: 'term-1', agentId: 'claude', sessionId: 's-1', permissionMode: 'auto' }
    ])
  })
  it('refuses a non-array, a malformed entry, oversize fields and too many entries', () => {
    expect(parseResumeSessions({})).toMatch(/list/)
    expect(parseResumeSessions([{ nodeId: 'a' }])).toMatch(/entry 0/)
    expect(parseResumeSessions([{ nodeId: 'a'.repeat(129), agentId: 'claude', sessionId: 's' }])).toMatch(/entry 0/)
    expect(parseResumeSessions([{ nodeId: 'a', agentId: 'claude', sessionId: 's', permissionMode: 7 }])).toMatch(/entry 0/)
    const many = Array.from({ length: RESUME_MAX_SESSIONS + 1 }, (_, i) => ({ nodeId: `n${i}`, agentId: 'claude', sessionId: 's' }))
    expect(parseResumeSessions(many)).toMatch(/at most/)
  })
})
