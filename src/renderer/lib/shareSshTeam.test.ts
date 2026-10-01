import { describe, it, expect } from 'vitest'
import { runShare, classifyTerminals, securityNote, type ShareDeps, type ShareInput } from './shareSshTeam'

const READY = { ok: true, probe: { adoptCwd: '/home/alice/proj', teamExists: false } as never, plan: { kind: 'ready' }, paneCommands: { 'term-p': 'npm' } } as const
const BOOT = { ok: true, result: { hostId: 'H', projectId: 'project-9', projectName: 'proj', joinCode: 'nodeterm://join/CODE', hosting: 'up', created: { team: true, owner: true, project: true, share: true } } } as const

function setup(o: Partial<Record<'probe' | 'flush' | 'bootstrap' | 'kill' | 'resume', unknown>> & { confirm?: boolean; install?: boolean } = {}) {
  const log: string[] = []
  const deps: ShareDeps = {
    api: {
      probe: async () => (log.push('probe'), (o.probe ?? READY) as never),
      install: async () => (log.push('install'), { ok: true, exitCode: 0 }),
      flushMirror: async () => (log.push('flush'), (o.flush ?? { ok: true, nodeIds: ['term-a', 'term-p', 'term-x'] }) as never),
      bootstrap: async () => (log.push('bootstrap'), (o.bootstrap ?? BOOT) as never),
      killSessions: async (_p, ids) => (log.push(`kill:${ids.join(',')}`), (o.kill ?? { ok: true, results: ids.map((nodeId) => ({ nodeId, state: 'gone' })) }) as never),
      resume: async (_p, sid, s) => (log.push(`resume:${sid}:${s.map((e) => e.nodeId).join(',')}`), (o.resume ?? { ok: true, results: s.map((e) => ({ nodeId: e.nodeId, status: 'resumed' })) }) as never),
      seedBookmark: async () => (log.push('seed'), { ok: true, hostId: 'H', label: 'box' })
    },
    confirm: async () => (log.push('confirm'), o.confirm ?? true),
    phase: (p) => log.push(`phase:${p}`),
    prepare: async () => void log.push('prepare'),
    markPending: async () => void log.push('mark'),
    release: async () => void log.push('release'),
    restore: async () => void log.push('restore'),
    markHandedOff: async (to) => void log.push(`handed:${to.hostId}:${to.projectId}`),
    join: (code, focus) => void log.push(`join:${focus}`)
  }
  return { deps, log }
}
const INPUT: ShareInput = {
  projectId: 'ssh-1', projectName: 'proj', host: 'box', user: 'alice', permissionMode: 'auto',
  terminals: [
    { nodeId: 'term-a', title: 'Claude', agentId: 'claude', sessionId: 's-1', state: 'done' },
    { nodeId: 'term-p', title: 'dev server' },
    { nodeId: 'term-x', title: 'Work account', agentId: 'claude', sessionId: 's-2', accountId: 'acct' }
  ]
}

describe('runShare', () => {
  it('the whole flow, in order: no kill before bootstrap, no resume before the kill', async () => {
    const { deps, log } = setup()
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({ kind: 'shared', joinCode: 'nodeterm://join/CODE', resumed: [{ nodeId: 'term-a' }] })
    const at = (s: string) => log.findIndex((l) => l.startsWith(s))
    expect(at('bootstrap')).toBeLessThan(at('kill:'))
    expect(at('kill:')).toBeLessThan(at('resume:'))
    expect(at('prepare')).toBeLessThan(at('mark'))
    expect(at('mark')).toBeLessThan(at('flush'))
    expect(at('flush')).toBeLessThan(at('release'))
    expect(at('release')).toBeLessThan(at('bootstrap'))
    expect(log).toContain('handed:H:project-9')
    expect(log).toContain('resume:project-9:term-a') // only the resumable agent; never the managed-account one
    expect(log).toContain('join:project-9')
    expect(log).not.toContain('restore')
  })
  it('refuses while an agent is working or blocked, before touching the host', async () => {
    const { deps, log } = setup()
    const out = await runShare(deps, { ...INPUT, terminals: [{ ...INPUT.terminals[0], state: 'working' }] })
    expect(out).toMatchObject({ kind: 'refused', busy: [{ nodeId: 'term-a' }] })
    expect(log).toEqual([])
  })
  it('refuses more terminals than one share handles, before touching the host', async () => {
    const { deps, log } = setup()
    const terminals = Array.from({ length: 201 }, (_, i) => ({ nodeId: `t-${i}`, title: `T${i}` }))
    expect(await runShare(deps, { ...INPUT, terminals })).toMatchObject({ kind: 'refused', reason: expect.stringContaining('more than 200') })
    expect(log).toEqual([])
  })
  it('a probe failure fails at probing, and a refusing plan is a refusal; neither asks to confirm', async () => {
    const failed = setup({ probe: { ok: false, error: 'not connected' } })
    expect(await runShare(failed.deps, INPUT)).toEqual({ kind: 'failed', step: 'probing', error: 'not connected', reopened: false })
    const refused = setup({ probe: { ...READY, plan: { kind: 'refuse', reason: 'Linux only' } } })
    expect(await runShare(refused.deps, INPUT)).toEqual({ kind: 'refused', reason: 'Linux only' })
    expect([...failed.log, ...refused.log]).not.toContain('confirm')
  })
  it('cancel at the confirm changes nothing', async () => {
    const { deps, log } = setup({ confirm: false })
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'cancelled' })
    expect(log.some((l) => /^(prepare|mark|release|bootstrap|kill)/.test(l))).toBe(false)
  })
  it('a canvas missing on the host stops BEFORE release and clears the pending mark', async () => {
    const { deps, log } = setup({ flush: { ok: true, nodeIds: ['term-a'] } })
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({ kind: 'failed', step: 'releasing', reopened: false, error: expect.stringContaining('2 terminals missing') })
    expect(log).not.toContain('release')
    expect(log).not.toContain('bootstrap')
    expect(log.indexOf('restore')).toBeGreaterThan(log.indexOf('mark'))
  })
  it('a failed flush stops BEFORE release and clears the pending mark', async () => {
    const { deps, log } = setup({ flush: { ok: false, error: 'ssh died' } })
    const out = await runShare(deps, INPUT)
    expect(out).toEqual({ kind: 'failed', step: 'releasing', error: 'ssh died', reopened: false })
    expect(log).not.toContain('release')
    expect(log).not.toContain('bootstrap')
    expect(log.indexOf('restore')).toBeGreaterThan(log.indexOf('flush'))
  })
  it('a failed save in prepare stops before anything is marked', async () => {
    const { deps, log } = setup()
    deps.prepare = async () => {
      throw new Error('save failed')
    }
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'releasing', error: 'save failed', reopened: false })
    expect(log.some((l) => /^(mark|flush|restore|release)/.test(l))).toBe(false)
  })
  it('a failed pending mark still clears itself, and nothing is flushed or released', async () => {
    const { deps, log } = setup()
    deps.markPending = async () => {
      throw new Error('disk full')
    }
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'releasing', error: 'disk full', reopened: false })
    expect(log).toContain('restore')
    expect(log.some((l) => /^(flush|release|bootstrap)/.test(l))).toBe(false)
  })
  it('a release that throws reopens the project and never bootstraps', async () => {
    const { deps, log } = setup()
    deps.release = async () => {
      throw new Error('close failed')
    }
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'releasing', error: 'close failed', reopened: true })
    expect(log).toContain('restore')
    expect(log).not.toContain('bootstrap')
  })
  it('a bootstrap failure reopens the SSH project and kills nothing', async () => {
    const { deps, log } = setup({ bootstrap: { ok: false, code: 'E_HOSTING_OFF', error: 'refused (403)' } })
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({ kind: 'failed', step: 'bootstrapping', reopened: true, error: expect.stringContaining('refused (403)') })
    expect(log).toContain('restore')
    expect(log.some((l) => l.startsWith('kill:'))).toBe(false)
  })
  it('a bootstrap failure still reports the failure when restore itself throws', async () => {
    const { deps, log } = setup({ bootstrap: { ok: false, error: 'boom' } })
    deps.restore = async () => {
      throw new Error('restore failed')
    }
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'bootstrapping', error: 'boom', reopened: true })
    expect(log.some((l) => l.startsWith('kill:'))).toBe(false)
  })
  it('after a successful bootstrap nothing ever reopens: a failed kill resumes nothing and reports every node still on SSH', async () => {
    const { deps, log } = setup({ kill: { ok: false, error: 'ssh died' } })
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({ kind: 'shared', resumed: [] })
    expect((out as { stillOnSsh: unknown[] }).stillOnSsh).toHaveLength(3)
    expect(log).not.toContain('restore')
    expect(log.some((l) => l.startsWith('resume:'))).toBe(false)
  })
  it('only verified-gone agents are resumed; an alive one is reported, not resumed', async () => {
    const { deps, log } = setup({ kill: { ok: true, results: [{ nodeId: 'term-a', state: 'alive' }, { nodeId: 'term-p', state: 'gone' }, { nodeId: 'term-x', state: 'gone' }] } })
    const out = await runShare(deps, INPUT)
    expect(log.some((l) => l.startsWith('resume:'))).toBe(false)
    expect(out).toMatchObject({ kind: 'shared', stillOnSsh: [{ nodeId: 'term-a' }] })
  })
  it('a refused resume is reported with its reason, beside the manual agents', async () => {
    const { deps } = setup({ resume: { ok: true, results: [{ nodeId: 'term-a', status: 'refused', reason: 'unknown agent' }] } })
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({
      kind: 'shared',
      resumed: [],
      notResumed: [
        { node: { nodeId: 'term-a' }, reason: 'unknown agent' },
        { node: { nodeId: 'term-x' }, reason: 'runs under a managed account' }
      ],
      stillOnSsh: []
    })
  })
  it('install path: install, then re-probe must be ready, before anything is released', async () => {
    let n = 0
    const { deps, log } = setup()
    deps.api.probe = async () => (log.push('probe'), (n++ === 0 ? { ...READY, plan: { kind: 'install', reason: 'missing' } } : READY) as never)
    await runShare(deps, INPUT)
    expect(log.indexOf('install')).toBeGreaterThan(log.indexOf('confirm'))
    expect(log.lastIndexOf('probe')).toBeGreaterThan(log.indexOf('install'))
    expect(log.indexOf('release')).toBeGreaterThan(log.lastIndexOf('probe'))
  })
  it('bootstraps with the folder the re-probe after an install resolved', async () => {
    let n = 0
    const { deps } = setup()
    const seen: string[] = []
    deps.api.probe = async () =>
      (n++ === 0
        ? { ...READY, plan: { kind: 'install', reason: 'missing' } }
        : { ...READY, probe: { adoptCwd: '/srv/proj', teamExists: false } }) as never
    deps.api.bootstrap = async (_p, cwd) => (seen.push(cwd), BOOT as never)
    await runShare(deps, INPUT)
    expect(seen).toEqual(['/srv/proj'])
  })
  it('an install that does not leave a ready server fails without releasing anything', async () => {
    const { deps, log } = setup()
    deps.api.probe = async () => ({ ...READY, plan: { kind: 'install', reason: 'missing' } }) as never
    expect(await runShare(deps, INPUT)).toMatchObject({ kind: 'failed', step: 'checking-install', reopened: false })
    expect(log).not.toContain('release')
    expect(log).not.toContain('mark')
  })
})

describe('classifyTerminals', () => {
  it('sorts agents into resumable / manual and plain terminals into stopping (only a non-shell command)', () => {
    const r = classifyTerminals(
      [
        { nodeId: 'a', title: 'A', agentId: 'claude', sessionId: 's1' },
        { nodeId: 'b', title: 'B', agentId: 'claude' },
        { nodeId: 'c', title: 'C', agentId: 'claude', sessionId: 's3', accountId: 'x' },
        { nodeId: 'd', title: 'D', agentId: 'my-custom', sessionId: 's4' },
        { nodeId: 'e', title: 'E' },
        { nodeId: 'f', title: 'F' }
      ],
      { e: 'npm', f: 'zsh' }
    )
    expect(r.resumable.map((n) => n.nodeId)).toEqual(['a'])
    expect(r.manual.map((m) => m.node.nodeId)).toEqual(['b', 'c', 'd'])
    expect(r.stopping).toEqual([{ node: { nodeId: 'e', title: 'E' }, command: 'npm' }])
  })
})

it('securityNote is the exact sentence', () => {
  expect(securityNote('alice', 'box')).toBe('Editors get a shell as alice on box and can make themselves owners; Viewers cannot.')
})
