import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  decideAccess,
  filterOutboundEvent,
  narrowResponseForRole,
  wrapSinkForRole,
  type AccessContext
} from './access-policy'
import { IPC } from '../../shared/ipc'
import type { UiSink } from '../ui-sink-registry'

const ctx = (role: AccessContext['role']): AccessContext => ({
  role,
  sharedProjects: new Set(['P']),
  projectOfNode: (id) => (id === 'n1' ? 'P' : id === 'n2' ? 'Q' : undefined),
  projectCwds: () => ['/srv/app'],
  realpath: (p) => (p.startsWith('/srv/app/link') ? '/etc/passwd' : p)
})

describe('access policy', () => {
  it('editors and owners pass everything untouched', () => {
    expect(decideAccess('req', IPC.fsWrite, ['/x', 'y'], ctx('editor'))).toEqual({ allow: true })
    expect(decideAccess('req', IPC.ptyCreate, [{ persistKey: 'n2' }], ctx('owner'))).toEqual({ allow: true })
  })
  it('a viewer may not write, destroy, send text or mutate the canvas', () => {
    for (const m of [IPC.fsWrite, IPC.ptyDestroy, IPC.ptySendText, IPC.gitCommit, IPC.settingsLoad]) {
      expect(decideAccess('req', m, [], ctx('viewer')).allow).toBe(false)
    }
    expect(decideAccess('cast', IPC.ptyWrite, ['s', 'ls\r'], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('cast', IPC.canvasMut, ['P', {}], ctx('viewer')).allow).toBe(false)
  })
  it('viewer pty:create joins only, never votes size, and only in shared projects', () => {
    expect(decideAccess('req', IPC.ptyCreate, [{ persistKey: 'n1', cols: 80, rows: 24 }], ctx('viewer')))
      .toEqual({ allow: true, args: [{ persistKey: 'n1', cols: 80, rows: 24, joinOnly: true, sizeVote: false }] })
    expect(decideAccess('req', IPC.ptyCreate, [{ persistKey: 'n2' }], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.ptyCreate, [{ persistKey: 'unknown' }], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.ptyCreate, [{}], ctx('viewer')).allow).toBe(false)
  })
  it('viewer resize is rewritten to "not looking"', () => {
    expect(decideAccess('cast', IPC.ptyResize, ['s', 40, 10, 'v'], ctx('viewer')))
      .toEqual({ allow: true, args: ['s', null, null, 'v'] })
  })
  it('fs reads are jailed to shared project cwds, symlinks included', () => {
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], ctx('viewer')).allow).toBe(true)
    expect(decideAccess('req', IPC.fsRead, ['/root/.ssh/id_rsa'], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/link'], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/../../etc/passwd'], ctx('viewer')).allow).toBe(false)
  })
  it('commenter may chat and append to a shared board, viewer may not', () => {
    expect(decideAccess('cast', IPC.presenceChat, ['hi'], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('cast', IPC.presenceChat, ['hi'], ctx('commenter')).allow).toBe(true)
    expect(decideAccess('req', IPC.boardLogAppend, ['P', {}], ctx('commenter')).allow).toBe(true)
    expect(decideAccess('req', IPC.boardLogAppend, ['Q', {}], ctx('commenter')).allow).toBe(false)
  })
  it('outbound: non-shared canvas and agent events are dropped for non-editors only', () => {
    const mutQ = JSON.stringify({ t: 'ev', channel: IPC.canvasMut, args: ['Q', {}] })
    const statusN2 = JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'n2' }] })
    const statusN1 = JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'n1' }] })
    expect(filterOutboundEvent(mutQ, ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(statusN2, ctx('commenter'))).toBe(false)
    expect(filterOutboundEvent(statusN1, ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(mutQ, ctx('editor'))).toBe(true)
  })
})

describe('access policy: the fs jail', () => {
  const made: string[] = []
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('a project reached through a symlinked cwd is readable (the cwd is realpathed too)', () => {
    // /work/app is a symlink to /data/app: the file realpaths under /data/app, the cwd must as well.
    const c: AccessContext = {
      ...ctx('viewer'),
      projectCwds: () => ['/work/app'],
      realpath: (p) => (p.startsWith('/work/app') ? '/data/app' + p.slice('/work/app'.length) : p)
    }
    expect(decideAccess('req', IPC.fsRead, ['/work/app/README.md'], c).allow).toBe(true)
    expect(decideAccess('req', IPC.fsList, ['/work/app'], c).allow).toBe(true)
    expect(decideAccess('req', IPC.fsRead, ['/data/app/README.md'], c).allow).toBe(true)
    expect(decideAccess('req', IPC.fsRead, ['/data/other/x'], c).allow).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'a real symlinked project dir on disk (symlink creation needs privileges on Windows)',
    () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'access-')))
      made.push(root)
      fs.mkdirSync(path.join(root, 'real', 'app'), { recursive: true })
      fs.writeFileSync(path.join(root, 'real', 'app', 'README.md'), 'hi')
      fs.writeFileSync(path.join(root, 'secret.txt'), 'nope')
      fs.symlinkSync(path.join(root, 'real', 'app'), path.join(root, 'link'))
      // An escape planted INSIDE the project: a symlink to a file outside it.
      fs.symlinkSync(path.join(root, 'secret.txt'), path.join(root, 'real', 'app', 'escape'))
      const c: AccessContext = {
        role: 'viewer',
        sharedProjects: new Set(['P']),
        projectOfNode: () => undefined,
        projectCwds: () => [path.join(root, 'link')],
        realpath: (p) => {
          try {
            return fs.realpathSync(p)
          } catch {
            return null
          }
        }
      }
      expect(decideAccess('req', IPC.fsRead, [path.join(root, 'link', 'README.md')], c).allow).toBe(true)
      expect(decideAccess('req', IPC.fsRead, [path.join(root, 'real', 'app', 'README.md')], c).allow).toBe(true)
      expect(decideAccess('req', IPC.fsList, [path.join(root, 'link')], c).allow).toBe(true)
      expect(decideAccess('req', IPC.fsRead, [path.join(root, 'link', 'escape')], c).allow).toBe(false)
      expect(decideAccess('req', IPC.fsRead, [path.join(root, 'secret.txt')], c).allow).toBe(false)
      expect(decideAccess('req', IPC.fsRead, [path.join(root, 'link', 'missing')], c).allow).toBe(false)
    }
  )

  it('refuses relative and ~ paths, sibling-prefix dirs, and non-strings', () => {
    const v = ctx('viewer')
    expect(decideAccess('req', IPC.fsRead, ['README.md'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['~/.ssh/id_rsa'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/srv/app2/secret'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/srv/ap'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, [42], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, [], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsList, ['/srv/app'], v).allow).toBe(true)
    expect(decideAccess('req', IPC.fsExists, ['/srv/app/x'], v).allow).toBe(true)
    expect(decideAccess('req', IPC.fsReadBinary, ['/srv/app/logo.png'], v).allow).toBe(true)
  })

  it('a project whose cwd is the filesystem root still contains its files', () => {
    const c: AccessContext = { ...ctx('viewer'), projectCwds: () => ['/'] }
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], c).allow).toBe(true)
  })

  it('a cwd that is not absolute is never a root', () => {
    const c: AccessContext = { ...ctx('viewer'), projectCwds: () => ['', 'srv'] }
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], c).allow).toBe(false)
  })

  it('no shared project cwd means nothing is readable', () => {
    const c: AccessContext = { ...ctx('viewer'), projectCwds: () => [] }
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], c).allow).toBe(false)
  })
})

describe('access policy: argument checks that "read" alone would not make safe', () => {
  it('viewer pty:create keeps ONLY the join fields — no ssh route, shell, account or env', () => {
    const d = decideAccess(
      'req',
      IPC.ptyCreate,
      [{
        persistKey: 'n1', cols: 80, rows: 24, viewerId: 'modal',
        shell: '/bin/sh', shellArgs: ['-c', 'touch /tmp/x'], cwd: '/', agentId: 'claude', accountId: 'a1',
        ownerProjectId: 'P', clearEnv: true, requireRemote: false, agentModel: 'm',
        sshRemote: { controlPath: '/tmp/cp', remoteCwd: '/', conn: { host: 'h', user: 'u', extraArgs: '-oProxyCommand=touch /tmp/pwn', execTrusted: true } },
        joinOnly: false, sizeVote: true
      }],
      ctx('viewer')
    )
    expect(d).toEqual({
      allow: true,
      args: [{ persistKey: 'n1', cols: 80, rows: 24, viewerId: 'modal', joinOnly: true, sizeVote: false }]
    })
  })

  it('viewer pty:create refuses a non-object or array options argument', () => {
    expect(decideAccess('req', IPC.ptyCreate, [], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.ptyCreate, [null], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.ptyCreate, ['n1'], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.ptyCreate, [['n1']], ctx('viewer')).allow).toBe(false)
  })

  it('viewer pty:create drops a non-numeric size and a non-string viewerId', () => {
    expect(decideAccess('req', IPC.ptyCreate, [{ persistKey: 'n1', cols: '80', rows: null, viewerId: 7 }], ctx('viewer')))
      .toEqual({ allow: true, args: [{ persistKey: 'n1', joinOnly: true, sizeVote: false }] })
  })

  it('a viewer may resume its own flow but never pause the shared pty', () => {
    expect(decideAccess('cast', IPC.ptyFlow, ['s', true], ctx('viewer'))).toEqual({ allow: true })
    expect(decideAccess('cast', IPC.ptyFlow, ['s', true, 'modal'], ctx('viewer'))).toEqual({ allow: true })
    expect(decideAccess('cast', IPC.ptyFlow, ['s', false], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('cast', IPC.ptyFlow, ['s', 0], ctx('commenter')).allow).toBe(false)
    expect(decideAccess('cast', IPC.ptyFlow, ['s', false], ctx('editor')).allow).toBe(true)
    expect(decideAccess('cast', IPC.ptyKill, ['s'], ctx('viewer')).allow).toBe(true)
  })

  it('viewer resize without a viewerId stays three arguments', () => {
    expect(decideAccess('cast', IPC.ptyResize, ['s', 40, 10], ctx('viewer')))
      .toEqual({ allow: true, args: ['s', null, null] })
  })

  it('terminal reads are limited to nodes of shared projects', () => {
    for (const m of [IPC.ptyCapture, IPC.ptyReadScrollback, IPC.ptyPaneCommand]) {
      expect(decideAccess('req', m, ['n1'], ctx('viewer')).allow).toBe(true)
      expect(decideAccess('req', m, ['n2'], ctx('viewer')).allow).toBe(false)
      expect(decideAccess('req', m, ['nope'], ctx('viewer')).allow).toBe(false)
      expect(decideAccess('req', m, [], ctx('viewer')).allow).toBe(false)
    }
    expect(decideAccess('req', IPC.ptyTmuxStatus, [], ctx('viewer')).allow).toBe(true)
  })

  it('git reads are jailed by their cwd', () => {
    for (const m of [IPC.gitStatus, IPC.gitRepoRoot, IPC.gitHistory]) {
      expect(decideAccess('req', m, ['/srv/app'], ctx('viewer')).allow).toBe(true)
      expect(decideAccess('req', m, ['/root'], ctx('viewer')).allow).toBe(false)
    }
  })

  it('git:diff jails the FILE too — an untracked diff is `git diff --no-index`, which reads any path', () => {
    const v = ctx('viewer')
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', 'src/a.ts', false, false], v).allow).toBe(true)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', 'new.ts', false, true], v).allow).toBe(true)
    // The measured escape: `git diff --no-index -- /dev/null /root/.ssh/id_rsa` prints the key.
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', '/root/.ssh/id_rsa', false, true], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', '../../root/.ssh/id_rsa', false, true], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', 'link', false, true], v).allow).toBe(false)
    // `untracked` is read truthily by the handler, so a truthy non-boolean is the untracked branch.
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', '/root/.ssh/id_rsa', false, 1], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', '../outside', false, false], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', ':(top)x', false, false], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', 42, false, false], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/root', 'x', false, false], v).allow).toBe(false)
  })

  it('git:show-file refuses a ref that git would parse as an option (`--output=` WRITES a file)', () => {
    const v = ctx('viewer')
    expect(decideAccess('req', IPC.gitShowFile, ['/srv/app', 'HEAD', 'src/a.ts'], v).allow).toBe(true)
    expect(decideAccess('req', IPC.gitShowFile, ['/srv/app', '', 'src/a.ts'], v).allow).toBe(true)
    expect(decideAccess('req', IPC.gitShowFile, ['/srv/app', '--output=/tmp/pwned', 'a'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitShowFile, ['/srv/app', '-p', 'a'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitShowFile, ['/srv/app', { toString: () => '--output=x' }, 'a'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitShowFile, ['/root', 'HEAD', 'a'], v).allow).toBe(false)
  })

  it('board-log reads and subscriptions name a shared project', () => {
    for (const m of [IPC.boardLogRead, IPC.boardLogSubscribe, IPC.boardLogUnsubscribe]) {
      expect(decideAccess('req', m, ['P'], ctx('viewer')).allow).toBe(true)
      expect(decideAccess('req', m, ['Q'], ctx('viewer')).allow).toBe(false)
      expect(decideAccess('req', m, [], ctx('viewer')).allow).toBe(false)
    }
  })

  it('a commenter has every viewer right; an unknown role is treated as the lowest', () => {
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], ctx('commenter')).allow).toBe(true)
    expect(decideAccess('req', IPC.fsWrite, ['/srv/app/README.md', 'x'], ctx('commenter')).allow).toBe(false)
    const odd = ctx('admin' as AccessContext['role'])
    expect(decideAccess('cast', IPC.presenceChat, ['hi'], odd).allow).toBe(false)
    expect(decideAccess('req', IPC.fsWrite, ['/srv/app/x', 'y'], odd)).toEqual({
      allow: false,
      message: "Viewers can't do that here. Ask an owner for Editor access."
    })
    expect(decideAccess('req', IPC.fsWrite, ['/srv/app/x', 'y'], ctx('toString' as AccessContext['role']))).toEqual({
      allow: false,
      message: "Viewers can't do that here. Ask an owner for Editor access."
    })
    expect(filterOutboundEvent(JSON.stringify({ t: 'ev', channel: IPC.logBatch, args: [[]] }), odd)).toBe(false)
  })

  it('a method named like an Object.prototype member is not a table entry', () => {
    for (const m of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const d = decideAccess('req', m, [], ctx('commenter'))
      expect(d.allow, m).toBe(false)
      expect(typeof (d as { message?: unknown }).message, m).toBe('string')
    }
    expect(decideAccess('req', 42 as unknown as string, [], ctx('viewer')).allow).toBe(false)
  })

  it('a refusal names the role and never echoes the method', () => {
    expect(decideAccess('req', IPC.gitCommit, ['/srv/app', 'm'], ctx('commenter'))).toEqual({
      allow: false,
      message: "Commenters can't do that here. Ask an owner for Editor access."
    })
  })
})

describe('outbound filter: deny by default for non-editors', () => {
  const ev = (channel: string, ...args: unknown[]) => JSON.stringify({ t: 'ev', channel, args })

  it('host-private broadcasts never reach a viewer, and do reach an editor', () => {
    for (const ch of [IPC.logBatch, IPC.usageUpdate, IPC.licenseChanged, IPC.gitCloneProgress, IPC.workspaceCorruptRecovered]) {
      expect(filterOutboundEvent(ev(ch, { x: 1 }), ctx('viewer')), ch).toBe(false)
      expect(filterOutboundEvent(ev(ch, { x: 1 }), ctx('editor')), ch).toBe(true)
    }
  })

  it('a whole project pushed by the core is delivered only when it is shared', () => {
    for (const ch of [IPC.workspaceExternalChange, IPC.workspaceServerChange]) {
      expect(filterOutboundEvent(ev(ch, { id: 'P', nodes: [] }), ctx('viewer'))).toBe(true)
      expect(filterOutboundEvent(ev(ch, { id: 'Q', nodes: [] }), ctx('viewer'))).toBe(false)
      expect(filterOutboundEvent(ev(ch, null), ctx('viewer'))).toBe(false)
    }
    expect(filterOutboundEvent(ev(IPC.projectTrustChanged, { projectId: 'P' }), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.projectTrustChanged, { projectId: 'Q' }), ctx('viewer'))).toBe(false)
  })

  it('per-project channels are filtered by the project in their name', () => {
    expect(filterOutboundEvent(ev(IPC.boardLogChanged('P'), 'P'), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.boardLogChanged('Q'), 'Q'), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(ev(IPC.projectSetupEvent('P'), {}), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.projectSetupEvent('Q'), {}), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(ev(IPC.githubIssuesChanged('P'), [1]), ctx('viewer'))).toBe(false)
  })

  it('per-session terminal events and presence are delivered', () => {
    for (const ch of [IPC.ptyExit('s'), IPC.ptySize('s'), IPC.ptyClosed('s'), IPC.ptyRecycled('s'), IPC.ptyResync('s')]) {
      expect(filterOutboundEvent(ev(ch, 0), ctx('viewer')), ch).toBe(true)
    }
    expect(filterOutboundEvent(JSON.stringify({ t: 'ev', channel: IPC.ptyRecycled('s'), args: [] }), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.presenceSync, []), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.presencePeer, {}), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.contextUpdate, { sessionId: 'x', usedPercent: 3 }), ctx('viewer'))).toBe(true)
  })

  it('an unread clear names a node', () => {
    expect(filterOutboundEvent(ev(IPC.agentUnreadClear, 'n1'), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.agentUnreadClear, 'n2'), ctx('viewer'))).toBe(false)
  })

  it('an unattributable message is dropped for a non-editor, never guessed', () => {
    expect(filterOutboundEvent('not json', ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(JSON.stringify({ t: 'ev', args: [] }), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(JSON.stringify({ t: 'ev', channel: IPC.agentStatus }), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent('not json', ctx('owner'))).toBe(true)
  })

  it('subagent live output has no node id: it is delivered only for a subagent a shared node started', () => {
    const owners = new Map<string, string>()
    const v = ctx('viewer')
    const chunk = (toolUseId: string) => ev(IPC.agentSubagentActivity, { toolUseId, chunk: 'secret' })
    // Nothing learned yet: dropped.
    expect(filterOutboundEvent(chunk('t1'), v, owners)).toBe(false)
    expect(filterOutboundEvent(chunk('t1'), v)).toBe(false)
    // A start on a SHARED node teaches t1 → n1; one on a non-shared node teaches t2 → n2.
    expect(filterOutboundEvent(ev(IPC.agentStatus, { nodeId: 'n1', kind: 'subagent-start', toolUseId: 't1' }), v, owners)).toBe(true)
    expect(filterOutboundEvent(ev(IPC.agentStatus, { nodeId: 'n2', kind: 'subagent-start', toolUseId: 't2' }), v, owners)).toBe(false)
    expect(filterOutboundEvent(chunk('t1'), v, owners)).toBe(true)
    expect(filterOutboundEvent(chunk('t2'), v, owners)).toBe(false)
    // The owner is re-checked at delivery: unsharing the project stops the stream.
    expect(filterOutboundEvent(chunk('t1'), { ...v, sharedProjects: new Set() }, owners)).toBe(false)
  })

  it('the subagent owner map is bounded', () => {
    const owners = new Map<string, string>()
    const v = ctx('viewer')
    for (let i = 0; i < 2000; i++) {
      filterOutboundEvent(ev(IPC.agentStatus, { nodeId: 'n1', kind: 'subagent-start', toolUseId: `t${i}` }), v, owners)
    }
    expect(owners.size).toBeLessThanOrEqual(512)
    expect(owners.has('t1999')).toBe(true)
    expect(owners.has('t0')).toBe(false)
  })
})

describe('wrapSinkForRole', () => {
  const sinkWith = (buffered: () => number) => {
    const text: string[] = []
    const bin: Uint8Array[] = []
    const sink: UiSink = { sendText: (j) => text.push(j), sendBinary: (b) => bin.push(b), bufferedAmount: buffered }
    return { sink, text, bin }
  }

  it('keeps reporting the UNDERLYING socket backlog, never a constant', () => {
    let n = 5
    const { sink } = sinkWith(() => n)
    const w = wrapSinkForRole(sink, () => ctx('viewer'))
    expect(w.bufferedAmount?.()).toBe(5)
    n = 9_000_000
    expect(w.bufferedAmount?.()).toBe(9_000_000)
  })

  it('filters text per the CURRENT context and passes terminal bytes through', () => {
    let role: AccessContext['role'] = 'viewer'
    const { sink, text, bin } = sinkWith(() => 0)
    const w = wrapSinkForRole(sink, () => ctx(role))
    const mutQ = JSON.stringify({ t: 'ev', channel: IPC.canvasMut, args: ['Q', {}] })
    w.sendText(mutQ)
    expect(text).toEqual([])
    role = 'editor'
    w.sendText(mutQ)
    expect(text).toEqual([mutQ])
    w.sendBinary(new Uint8Array([1, 2]))
    expect(bin).toHaveLength(1)
  })

  it('carries the subagent owner map across messages', () => {
    const { sink, text } = sinkWith(() => 0)
    const w = wrapSinkForRole(sink, () => ctx('viewer'))
    const start = JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'n1', kind: 'subagent-start', toolUseId: 't1' }] })
    const chunk = JSON.stringify({ t: 'ev', channel: IPC.agentSubagentActivity, args: [{ toolUseId: 't1', chunk: 'x' }] })
    w.sendText(start)
    w.sendText(chunk)
    expect(text).toEqual([start, chunk])
  })

  it('a context that cannot be built drops the message instead of throwing into the registry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { sink, text } = sinkWith(() => 0)
      const w = wrapSinkForRole(sink, () => {
        throw new Error('team store unreadable')
      })
      expect(() => w.sendText(JSON.stringify({ t: 'ev', channel: IPC.presencePeer, args: [{}] }))).not.toThrow()
      expect(() => w.sendText(JSON.stringify({ t: 'ev', channel: IPC.presencePeer, args: [{}] }))).not.toThrow()
      expect(text).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('narrowResponseForRole', () => {
  const snapshot = [
    { kind: 'subagent-start', nodeId: 'n1', toolUseId: 't1', taskLabel: 'shared task' },
    { kind: 'subagent-start', nodeId: 'n2', toolUseId: 't2', taskLabel: 'private task' }
  ]
  it('trims the subagent snapshot to shared nodes for a non-editor', () => {
    expect(narrowResponseForRole(IPC.agentSubagentSnapshot, snapshot, ctx('viewer'))).toEqual([snapshot[0]])
    expect(narrowResponseForRole(IPC.agentSubagentSnapshot, 'garbage', ctx('viewer'))).toEqual([])
  })
  it('leaves an editor, and every other method, untouched', () => {
    expect(narrowResponseForRole(IPC.agentSubagentSnapshot, snapshot, ctx('editor'))).toBe(snapshot)
    const r = { anything: 1 }
    expect(narrowResponseForRole(IPC.fsRead, r, ctx('viewer'))).toBe(r)
  })
})
