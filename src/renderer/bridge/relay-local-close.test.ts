import { describe, it, expect, vi } from 'vitest'
import { emitLocalRelayClose, onLocalRelayClose } from './relay-local-close'

describe('local relay close', () => {
  it('tells the listeners of THAT connection, once each emit, and unsubscribes', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unA = onLocalRelayClose('c1', a)
    onLocalRelayClose('c2', b)
    emitLocalRelayClose('c1')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    unA()
    emitLocalRelayClose('c1')
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('a listener that throws does not stop the others', () => {
    const ok = vi.fn()
    onLocalRelayClose('c3', () => { throw new Error('boom') })
    onLocalRelayClose('c3', ok)
    expect(() => emitLocalRelayClose('c3')).not.toThrow()
    expect(ok).toHaveBeenCalled()
  })
})
