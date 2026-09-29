import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the worktree create-and-bind wiring inside Canvas.tsx: the one create site
 * shared by the New worktree dialog, the `open-worktree` control verb and the issue card's "Start
 * with agent in a new worktree", and the two same-tick guarantees the issue action rests on. They
 * live inside a 16,000-line component with no unit seam, so — like `issue-binding.source.test.ts` —
 * the BEHAVIOUR is proven elsewhere against real code: the create/bind sequence in
 * `lib/worktreeCreate.test.ts`, the branch and reuse rules in `shared/issue-worktree.test.ts`
 * (including the real `git check-ref-format`), the refusals in `lib/issueWorktree.test.ts`.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function code(body: string): string {
  return body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

function between(start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return code(src.slice(a, b))
}

describe('one create-and-bind for every way the app makes a worktree', () => {
  it('git worktree add is reached from exactly one place: the shared deps builder', () => {
    const body = code(src)
    expect(body.match(/\.worktreeAdd\(/g) ?? []).toHaveLength(1)
    const deps = between('const worktreeCreateDeps = useCallback(', 'const createWorktreeAndGroup = useCallback(')
    expect(deps).toContain('api.git.worktreeAdd(repoPath, wtPath, branch, baseRef, isNew)')
  })

  it('the dialog creates through it WITH the project-changed refusal', () => {
    const body = between('const createWorktreeAndGroup = useCallback(', 'const bindExistingWorktree = useCallback(')
    expect(body).toContain('createBoundWorktree(worktreeCreateDeps(), v, {')
    expect(body).toContain('projectId: target.projectId')
    // A rejected call keeps its historical inline wording.
    expect(body).toContain('`Could not create the worktree: ${res.message}`')
  })

  it('open-worktree creates through it WITHOUT one, and replies as it always did', () => {
    const body = between("case 'open-worktree': {", "case 'close-worktree': {")
    const call = body.slice(body.indexOf('createBoundWorktree('), body.indexOf('if (!created.ok)'))
    expect(call).toContain('worktreeControlRef.current.worktreeCreateDeps()')
    expect(call).not.toContain('projectId')
    expect(body).toContain("`open-worktree: ${created.reason === 'git' ? created.message")
    // The frame's place is asked only after git succeeded (a thunk), against the canvas as it is then.
    expect(call).toContain('target: () => ({')
  })
})

describe('attachWorktree', () => {
  const body = between('const attachWorktree = useCallback(', 'const worktreeCreateDeps = useCallback(')

  it('puts the frame in nodesRef in the same tick, for a caller that opens a node into it at once', () => {
    const created = body.indexOf('nodesRef.current = [group, ...nodesRef.current]')
    expect(created).toBeGreaterThan(-1)
    expect(created).toBeLessThan(body.indexOf('setNodes((ns) => [group, ...(ns as CanvasNode[])])'))
    const bound = body.indexOf('nodesRef.current = bind(nodesRef.current)')
    expect(bound).toBeGreaterThan(-1)
    expect(bound).toBeLessThan(body.indexOf('setNodes((ns) => bind(ns as CanvasNode[]))'))
  })

  it('names a new frame from the target when asked (an issue frame is "Issue #N"), else the branch', () => {
    expect(body).toContain('title: target.title ?? wt.branch')
    expect(body).toContain('target.size ?? WORKTREE_GROUP_SIZE')
  })

  it('closes the setup gate from the bind, and releases its own count only after the run was asked for', () => {
    const mark = body.indexOf('useProjectSetup.getState().markGroupPending(setupGroupId)')
    const task = body.indexOf('void (async () => {')
    expect(mark).toBeGreaterThan(-1)
    expect(mark).toBeLessThan(task)
    const start = body.indexOf('startWorktreeSetup(setupGroupId, wt.path)')
    const fin = body.indexOf('} finally {', start)
    expect(start).toBeGreaterThan(task)
    expect(fin).toBeGreaterThan(start)
    expect(body.indexOf('useProjectSetup.getState().clearGroupPending(setupGroupId)', fin)).toBeGreaterThan(fin)
  })
})

describe('Start with agent in a new worktree', () => {
  const body = between('const startIssueAgentInWorktree = useCallback(', 'const issueWorktreeMenu = useCallback(')

  it('opens the agent INSIDE the attach, so no render can drop the fresh frame from nodesRef first', () => {
    expect(body).toMatch(
      /worktreeCreateDeps\(\(t, wt\) => \{\s*const groupId = attachWorktree\(t, wt\)\s*opened = openIssueAgentInFrame\(groupId,/
    )
    // Adopting an unbound worktree does the same, with nothing awaited in between.
    expect(body).toMatch(
      /const groupId = attachWorktree\(newFrame\(\), wt\)\s*openIssueAgentInFrame\(groupId, issue, start, agentId, accountId\)/
    )
  })

  it('refuses before anything else when the project cannot take a worktree, and never doubles a start', () => {
    const refusal = body.indexOf('const refusal = issueWorktreeUnavailable()')
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(body.indexOf('await '))
    expect(body).toContain('issueWorktreeInFlightRef.current.has(key)')
    expect(body).toContain('issueWorktreeInFlightRef.current.delete(key)')
  })

  it('re-checks the project after every await and again at the dialog click', () => {
    const checks = body.match(/useProjects\.getState\(\)\.activeProjectId !== projectId/g) ?? []
    expect(checks.length).toBeGreaterThanOrEqual(2)
    // …and the create itself passes the project, so git finishing after a tab switch binds nothing.
    expect(body).toContain('{ target: newFrame, projectId }')
  })

  it('uses the dialog\'s defaults: project override, else the repo default branch and the template', () => {
    expect(body).toContain('effectiveWorktreeBaseRef(defaults, entries)')
    expect(body).toContain('useSettings.getState().settings.worktreePathTemplate')
  })

  it('a reused frame is re-validated at the click (still there, still bound, not stale)', () => {
    expect(body).toContain('useWorktrees.getState().staleGroupIds.includes(existing.groupId)')
    expect(body).toContain('live.data.worktree?.path !== existing.path')
  })
})

describe('addAgentNode parents OUTSIDE the setNodes updater', () => {
  it('so a render flushed by a zustand write cannot parent the agent against a ref without its frame', () => {
    // The updater runs at render time. A SyncLane render (any zustand write) that skips this
    // DefaultLane update first mirrors `nodesRef` back to state, which does not yet hold a frame
    // `attachWorktree` created this tick — `parentInto` would then find no group and leave the
    // agent top-level, outside the worktree frame it was opened for.
    const add = between('const addAgentNode = useCallback(', 'return { node, projectId: targetProjectId }')
    const placed = add.indexOf('const placed = groupId ? parentInto(node, groupId) : node')
    expect(placed).toBeGreaterThan(-1)
    expect(placed).toBeLessThan(add.indexOf('setNodes((ns) => [...ns, placed])'))
    expect(add).not.toMatch(/setNodes\(\(ns\) => \[[^\]]*parentInto\(/)
  })
})

describe('the setup hold is one rule', () => {
  it('control opens and the issue action ask the same helper', () => {
    const arm = between('const armAfter = (', 'const addGrouped = (')
    expect(arm).toContain('const awaitSetupGroup = setupHoldGroup(intoGroup)')
    const open = between('const openIssueAgentInFrame = useCallback(', 'const startIssueAgentInWorktree = useCallback(')
    expect(open).toContain('awaitSetupGroup: setupHoldGroup(groupId)')
    const add = between('const addAgentNode = useCallback(', 'const issueRef = normalizeIssueRef(extra?.issueRef)')
    expect(add).toContain('awaitSetupGroup?: string')
    expect(code(src)).toContain(
      'const node = extra?.awaitSetupGroup ? queueControlLaunch(bound, [], extra.awaitSetupGroup) : bound'
    )
  })
})
