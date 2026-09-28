import { describe, expect, it } from 'vitest'
import { ptyRefusal } from './pty-refusal'

describe('PTY refusal presentation', () => {
  it('does not disconnect a healthy SSH project for an account refusal', () => {
    expect(ptyRefusal('codex-account')).toMatchObject({ connectionLost: false })
    expect(ptyRefusal('codex-account').message).toContain('SSH managed accounts are not supported yet')
  })
  it('retains reconnect behavior for an SSH refusal', () => {
    expect(ptyRefusal('ssh')).toEqual({ connectionLost: true, message: 'not connected — nothing was started locally' })
  })
  // A hosted-relay viewer asked to watch a terminal nobody has open. Nothing is disconnected: read
  // as `connectionLost`, the card modal would report an SSH drop and kick the reconnector for it.
  it('a join-only refusal is not a lost connection, and says why nothing is shown', () => {
    expect(ptyRefusal('join-only')).toEqual({
      connectionLost: false,
      message: 'this terminal is not running — a viewer can only watch terminals that are already open'
    })
  })
})
