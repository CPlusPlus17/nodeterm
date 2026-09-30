import { describe, expect, it, vi } from 'vitest'
import type { TmuxStatus } from '@shared/types'
vi.mock('../session/localSession', () => ({ localSession: { api: { pty: {} } } }))
vi.mock('../state/settings', () => ({ useSettings: () => undefined }))
import { persistenceDescription, sessionBackendNote } from './usePersistenceStatus'

describe('Session backend row — the sentence says what a NEW terminal gets', () => {
  it('selected but not installed must not read as applied', () => {
    expect(sessionBackendNote({ selected: true, available: false })).toMatch(/not found.*use tmux/)
  })
  it('selected and installed names Zellij and how to attach', () => {
    expect(sessionBackendNote({ selected: true, available: true })).toMatch(/Zellij session.*zellij attach nt-/)
  })
  it('tmux selected says tmux, and whether Zellij could be chosen', () => {
    expect(sessionBackendNote({ selected: false, available: true })).toMatch(/open in tmux\. Zellij is also available/)
    expect(sessionBackendNote({ selected: false, available: false })).toMatch(/Install Zellij/)
  })
  it('persistence names Zellij when the core reports it as the backend (no tmux-install nag)', () => {
    const status: TmuxStatus = {
      available: false,
      platform: 'darwin',
      installCommand: 'brew install tmux',
      installLabel: null,
      persistence: { enabled: true, backend: 'zellij' },
      zellij: { available: true, selected: true }
    }
    expect(persistenceDescription(status)).toMatch(/^Zellij is available/)
  })
})
