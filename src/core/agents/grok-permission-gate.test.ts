// Driven by REAL captures: `__fixtures__/grok/permission-events.json` holds the hook payloads and the
// `events.jsonl` lines grok 1.0.13 wrote for four answered permission dialogs (allow, deny, cancel,
// and a subagent's prompt). The file content each test serves is exactly what grok had written at
// the moment in question — sliced by the record timestamps, never hand-written.
import { describe, expect, it } from 'vitest'
import path from 'path'
import fixture from '../../shared/agents/__fixtures__/grok/permission-events.json'
import { normalizeGrok, type NormalizedAgentEvent } from '../../shared/agents/normalize'
import {
  createGrokPermissionGate,
  parseGrokEvents,
  permissionVerdict,
  requestNear,
  type GrokPermissionGateDeps
} from './grok-permission-gate'
import { grokSessionDir } from './grok-paths'

type Hook = Record<string, unknown> & { hookEventName: string; sessionId: string; timestamp?: string; cwd: string }
type Scenario = { hooks: Hook[]; sessions: Record<string, string[]> }
const S = fixture.scenarios as unknown as Record<'allow' | 'deny' | 'cancel' | 'subagent', Scenario>
const SESSIONS_DIR = '/home/user/.grok/sessions'
const tsOf = (line: string): number => Date.parse((JSON.parse(line) as { ts: string }).ts)
const hookAt = (h: Hook): number => Date.parse(h.timestamp as string)
/** The file as grok had written it at time `t`. */
const fileAt = (lines: string[], t: number): string =>
  lines.filter((l) => tsOf(l) <= t).map((l) => l + '\n').join('')

function harness(sc: Scenario) {
  let clock = 0
  const timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 1
  const out: NormalizedAgentEvent[] = []
  const fileFor = new Map<string, string>()
  for (const id of Object.keys(sc.sessions)) {
    const dir = grokSessionDir({ sessionsDir: SESSIONS_DIR, cwd: '/work/project', sessionId: id })
    fileFor.set(path.join(dir as string, 'events.jsonl'), id)
  }
  const content = (file: string): string | null => {
    const id = fileFor.get(file)
    return id ? fileAt(sc.sessions[id], clock) : null
  }
  const deps: GrokPermissionGateDeps = {
    sessionsDir: () => SESSIONS_DIR,
    readFile: async (f) => content(f),
    stat: async (f) => {
      const c = content(f)
      return c === null ? null : { size: c.length, mtimeMs: 0 }
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++
      timers.push({ at: clock + ms, fn, id })
      return id
    },
    clearTimer: (t) => {
      const i = timers.findIndex((x) => x.id === t)
      if (i >= 0) timers.splice(i, 1)
    },
    pollMs: 1000,
    pendingMaxMs: 60 * 60 * 1000,
    afterResolutionMaxMs: 60_000,
    confirmTimeoutMs: 500
  }
  const gate = createGrokPermissionGate((e) => out.push(e), deps)
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  const advanceTo = async (t: number): Promise<void> => {
    for (;;) {
      await flush()
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > t) break
      timers.shift()
      clock = next.at
      next.fn()
      await flush()
    }
    clock = t
    await flush()
  }
  const post = async (h: Hook): Promise<void> => {
    await advanceTo(hookAt(h))
    const e = normalizeGrok({ nodeId: 'n1', agentId: 'grok', payload: h })
    gate.handle('n1', h, e ? { ...e, verified: true } : null)
    await flush()
  }
  return { out, post, advanceTo, states: () => out.map((e) => e.state + (e.interrupted ? '*' : '')) }
}

const firstTs = (sc: Scenario, type: string): number => {
  for (const lines of Object.values(sc.sessions))
    for (const l of lines) if ((JSON.parse(l) as { type: string }).type === type) return tsOf(l)
  throw new Error(type)
}

describe('parse + verdict over the captured files', () => {
  it('reads the request, its resolution and the decision grok recorded', () => {
    for (const [name, decision] of [
      ['allow', 'allow'],
      ['deny', 'deny'],
      ['cancel', 'cancelled']
    ] as const) {
      const lines = Object.values(S[name].sessions)[0]
      const recs = parseGrokEvents(lines.join('\n'))
      const req = recs.find((r) => r.type === 'permission_requested')!
      const v = permissionVerdict(recs, req.ts, 'run_terminal_command')
      expect(v).toMatchObject({ phase: 'resolved', decision })
      // Measured: deny and cancel both end the turn as cancelled; allow ends it normally.
      expect(v).toMatchObject({ turnEnded: name === 'allow' ? 'other' : 'cancelled' })
    }
  })

  it('is pending while only the request is on disk', () => {
    const lines = Object.values(S.allow.sessions)[0]
    const t = firstTs(S.allow, 'permission_requested')
    const recs = parseGrokEvents(fileAt(lines, t))
    expect(permissionVerdict(recs, t, 'run_terminal_command')).toEqual({ phase: 'pending' })
  })

  it('an unknown decision is unknown, never a resolution', () => {
    const lines = Object.values(S.allow.sessions)[0].map((l) => l.replace('"decision":"allow"', '"decision":"later"'))
    const recs = parseGrokEvents(lines.join('\n'))
    const req = recs.find((r) => r.type === 'permission_requested')!
    expect(permissionVerdict(recs, req.ts, req.type === 'permission_requested' ? req.toolName : '')).toEqual({ phase: 'unknown' })
  })

  it('the request window ties a notification only to a request written just before it', () => {
    const lines = Object.values(S.allow.sessions)[0]
    const recs = parseGrokEvents(lines.join('\n'))
    const t = firstTs(S.allow, 'permission_requested')
    expect(requestNear(recs, t + 5)).not.toBeNull()
    expect(requestNear(recs, t + 30_000)).toBeNull()
  })
})

describe('the gate, replaying each captured scenario', () => {
  it('allow: NEEDS YOU while the dialog is open, working the moment grok records the approval', async () => {
    const h = harness(S.allow)
    const hooks = S.allow.hooks
    const iNotif = hooks.findIndex((x) => x.hookEventName === 'notification')
    for (const x of hooks.slice(0, iNotif + 1)) await h.post(x)
    expect(h.states().at(-1)).toBe('blocked')
    // Grok writes permission_resolved at the click; the next hook is PostToolUse 10 s later.
    const resolvedAt = firstTs(S.allow, 'permission_resolved')
    const post = hooks[iNotif + 1]
    expect(hookAt(post) - resolvedAt).toBeGreaterThan(9_000)
    await h.advanceTo(resolvedAt + 1500)
    expect(h.out.at(-1)).toMatchObject({ state: 'working', verified: false, sessionId: post.sessionId })
    for (const x of hooks.slice(iNotif + 1)) await h.post(x)
    expect(h.states().at(-1)).toBe('done')
  })

  it('cancel (Ctrl+C): the badge clears to an interrupted done — grok sends no hook at all', async () => {
    const h = harness(S.cancel)
    for (const x of S.cancel.hooks) await h.post(x)
    expect(h.states().at(-1)).toBe('blocked')
    await h.advanceTo(firstTs(S.cancel, 'turn_ended') + 1500)
    expect(h.states().at(-1)).toBe('done*')
  })

  it('deny: the permission_denied hook reads working, then the cancelled turn ends it', async () => {
    const h = harness(S.deny)
    for (const x of S.deny.hooks) await h.post(x)
    await h.advanceTo(firstTs(S.deny, 'turn_ended') + 3000)
    expect(h.states()).toContain('blocked')
    expect(h.states().at(-1)).toBe('done*')
  })

  it("subagent: the child's prompt (parent sessionId) is tied to the CHILD's file, never the parent's old answer", async () => {
    const h = harness(S.subagent)
    const hooks = S.subagent.hooks
    const notifs = hooks.filter((x) => x.hookEventName === 'notification')
    expect(notifs).toHaveLength(2)
    // Both notifications name the parent session — the trap.
    expect(new Set(notifs.map((n) => n.sessionId)).size).toBe(1)
    const second = hooks.indexOf(notifs[1])
    for (const x of hooks.slice(0, second + 1)) await h.post(x)
    // The parent's own request was resolved 90 ms before the child's notification. A parent-only
    // read would have published that resolution over the child's open dialog.
    expect(h.states().at(-1)).toBe('blocked')
  })

  it("subagent, child never seen: the parent's old, resolved request is NOT taken for the child's prompt", async () => {
    const h = harness(S.subagent)
    const parent = S.subagent.hooks.find((x) => x.hookEventName === 'session_start')!.sessionId
    const hooks = S.subagent.hooks.filter((x) => x.sessionId === parent)
    const second = hooks.filter((x) => x.hookEventName === 'notification')[1]
    for (const x of hooks.slice(0, hooks.indexOf(second) + 1)) await h.post(x)
    expect(h.states().at(-1)).toBe('blocked')
    await h.advanceTo(hookAt(second) + 5_000)
    expect(h.states().at(-1)).toBe('blocked')
  })

  it('a notification no request can be tied to is published exactly as before, and not watched', async () => {
    const h = harness({ hooks: S.cancel.hooks, sessions: {} })
    for (const x of S.cancel.hooks) await h.post(x)
    await h.advanceTo(hookAt(S.cancel.hooks.at(-1)!) + 120_000)
    expect(h.states().at(-1)).toBe('blocked')
  })
})
