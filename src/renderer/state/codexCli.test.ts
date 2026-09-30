import { describe, it, expect, beforeEach } from 'vitest'
import { codexApprovalCaps, resetCodexCliCapsForTests } from './codexCli'
import { useSshConn } from './sshConn'

const server = { host: 'box.example', user: 'dev', port: 22 }

beforeEach(() => {
  resetCodexCliCapsForTests()
  useSshConn.setState({ codexNoDaemonByHost: {} })
})

describe('codexApprovalCaps — --no-daemon', () => {
  it('a LOCAL session uses this machine\'s probe', () => {
    resetCodexCliCapsForTests({ approvalValues: null, noDaemon: true })
    expect(codexApprovalCaps().codexNoDaemon).toBe(true)
    resetCodexCliCapsForTests({ approvalValues: null, noDaemon: false })
    expect(codexApprovalCaps().codexNoDaemon).toBe(false)
  })

  it('a REMOTE session never borrows the local answer', () => {
    resetCodexCliCapsForTests({ approvalValues: null, noDaemon: true })
    expect(codexApprovalCaps(server).codexNoDaemon).toBeNull()
    expect(codexApprovalCaps(true).codexNoDaemon).toBeNull()
  })

  it('a REMOTE session uses ITS host\'s probe, from a node connection or a project binding', () => {
    useSshConn.getState().setRemoteCodexNoDaemon({ hostKey: 'dev@box.example', supported: true })
    expect(codexApprovalCaps(server).codexNoDaemon).toBe(true)
    expect(codexApprovalCaps({ server, remoteCwd: '~' }).codexNoDaemon).toBe(true)
    // Another host (or another user on the same host) is another binary.
    expect(codexApprovalCaps({ ...server, user: 'ops' }).codexNoDaemon).toBeNull()
  })

  it('a host that answered no stays flagless', () => {
    useSshConn.getState().setRemoteCodexNoDaemon({ hostKey: 'dev@box.example', supported: false })
    expect(codexApprovalCaps(server).codexNoDaemon).toBeNull()
  })

  it('a reused connection carries the answer in its connect result', () => {
    useSshConn.getState().setConn('p1', {
      controlPath: '/tmp/cm',
      remoteCodexNoDaemon: { hostKey: 'dev@box.example', supported: true }
    })
    expect(codexApprovalCaps(server).codexNoDaemon).toBe(true)
  })
})
