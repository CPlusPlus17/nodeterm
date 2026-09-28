// src/shared/relay-join-errors.test.ts
import { describe, it, expect } from 'vitest'
import { JOIN_ERROR_CODES, joinErrorCode, joinErrorRetries } from './relay-join-errors'

describe('hosted join error codes', () => {
  it('reads each code off the message main threw, and off the one Electron hands the renderer', () => {
    for (const code of JOIN_ERROR_CODES) {
      expect(joinErrorCode(`[${code}] something happened`)).toBe(code)
      // ipcRenderer.invoke rejects with main's message wrapped in its own prefix.
      expect(joinErrorCode(`Error invoking remote method 'relay:client:connect': Error: [${code}] something happened`)).toBe(code)
    }
  })

  it('answers null for anything that is not one of ours', () => {
    expect(joinErrorCode('That pairing code is invalid or incomplete.')).toBeNull()
    expect(joinErrorCode('[E_JOIN_SOMETHING_NEW] x')).toBeNull()
    expect(joinErrorCode('[e_join_network] x')).toBeNull()
    expect(joinErrorCode('')).toBeNull()
    expect(joinErrorCode(undefined as unknown as string)).toBeNull()
  })

  it('only a network failure is worth retrying', () => {
    expect(JOIN_ERROR_CODES.filter(joinErrorRetries)).toEqual(['E_JOIN_NETWORK'])
    expect(joinErrorRetries(null)).toBe(false)
  })
})
