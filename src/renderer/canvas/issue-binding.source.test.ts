import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the GitHub-issue binding inside Canvas.tsx — the `--issue` handling in the
 * three agent-open paths of the control dispatch, and the run-history writes in the node-removal
 * funnels. Same reason as `control-off-canvas.source.test.ts`: these live inside a 15,000-line
 * component's IPC listener with no unit seam. Every BEHAVIOURAL half is proven against real code
 * elsewhere: the grammar and the prompt in `shared/github-issue-ref.test.ts`, the flag resolution in
 * `lib/issueFlag.test.ts`, the run entries in `lib/issueRuns.test.ts`, the Server Edition end to end
 * in `server/headless-node-factory.issue.test.ts`.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mainSrc = readFileSync(new URL('../../main/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function code(body: string): string {
  return body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

function between(start: string, end: string, from = 0): string {
  const a = src.indexOf(start, from)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('--issue in the desktop control dispatch', () => {
  it('main refuses a malformed --issue before the renderer ever sees it', () => {
    const handler = mainSrc.slice(mainSrc.indexOf('hookServer.setControlHandler('))
    const gate = handler.indexOf('issueFlagRefusal(verb, args)')
    expect(gate).toBeGreaterThan(-1)
    // …and it runs before the forward to the renderer.
    expect(gate).toBeLessThan(handler.indexOf("'window unavailable'"))
  })

  it('the live open path resolves the issue BEFORE its dry-run branch and before building nodes', () => {
    const body = code(between("case 'open-agent': {", "case 'show-image': {"))
    const resolve = body.indexOf('await resolveIssueFlag(ctlProject?.id)')
    expect(resolve).toBeGreaterThan(-1)
    // A dry run runs the SAME validation as a real call (#532): a bad `#N` must be refused there too.
    expect(resolve).toBeLessThan(body.indexOf('if (dryRun) {'))
    expect(body).toContain('bound to GitHub issue ${formatIssueRef(issueRef)}')
    // The launch prompt is composed by the one function allowed to turn a reference into text.
    expect(body).toMatch(/issueRef \? issueLaunchPrompt\(issueRef, args\.prompt\) : args\.prompt/)
    expect(body).toContain('bindIssue(node, issueRef)')
    expect(body).toContain('logRunsStarted(ctlProject?.id, issueNodes, issueRef)')
  })

  it('the cold-open path resolves against the OWNING project, before its dry run', () => {
    const body = code(between('if (canColdOpen(verb)) {', '// ── OFF CANVAS'))
    const resolve = body.indexOf('await resolveIssueFlag(coldTerminal ? undefined : owner.id)')
    expect(resolve).toBeGreaterThan(-1)
    expect(resolve).toBeLessThan(body.indexOf('if (dryRun) {'))
    expect(body).toContain('bound to GitHub issue ${formatIssueRef(coldIssueRef)}')
    expect(body).toMatch(/coldIssueRef \? issueLaunchPrompt\(coldIssueRef, args\.prompt\) : args\.prompt/)
    expect(body).toContain('logRunsStarted(owner.id, coldMade, coldIssueRef)')
  })

  it('the --project path resolves against the TARGET project', () => {
    const body = code(between("args.project !== undefined\n      ) {", '// ── end of the early-handled'))
    expect(body).toContain('await resolveIssueFlag(target.id)')
    expect(body).toMatch(/tgIssue\.ref \? issueLaunchPrompt\(tgIssue\.ref, args\.prompt\) : args\.prompt/)
    expect(body).toContain('logRunsStarted(target.id, tgMade, tgIssue.ref)')
  })

  it('no path splices the raw --issue value into a prompt or a launch line', () => {
    expect(code(src)).not.toMatch(/args\.issue[^\n]*(prompt|initialCommand|createAgentNode)/)
    // The only reader of the raw flag is the resolver.
    const reads = code(src).match(/args\.issue\b/g) ?? []
    expect(reads).toHaveLength(1)
  })
})

describe('run history in the node-removal funnels', () => {
  it('deleteNodes files run-ended BEFORE it drops the node agent status', () => {
    const body = code(between('const deleteNodes = useCallback(', 'const deleteSelectionCommand'))
    const log = body.indexOf('logIssueRunEnded(')
    expect(log).toBeGreaterThan(-1)
    expect(log).toBeLessThan(body.indexOf('useAgentStatus.getState().remove(n.id)'))
  })

  it('the cross-project close files run-ended BEFORE it drops the node agent status', () => {
    const body = code(between('const closeStoredNodes = useCallback(', '// Close (end) a session.'))
    const log = body.indexOf('logIssueRunEnded(projectId, stored)')
    expect(log).toBeGreaterThan(-1)
    expect(log).toBeLessThan(body.indexOf('useAgentStatus.getState().remove(id)'))
  })

  it('the Omni board delete files run-ended too', () => {
    const body = code(between('const onGlobalDelete = ', 'const onGlobalSetIcon = '))
    const log = body.indexOf('logIssueRunEnded(projectId, doomed)')
    expect(log).toBeGreaterThan(-1)
    expect(log).toBeLessThan(body.indexOf('useAgentStatus.getState().remove(nodeId)'))
  })
})

describe('Start with agent (issue card)', () => {
  it('launches with the reference prompt and binds the node — never the issue title or body', () => {
    const body = code(between('const startIssueAgent = useCallback(', 'const issueAgentMenu = useCallback('))
    expect(body).toContain('issueRefFromHtmlUrl(issue.htmlUrl, issue.number)')
    expect(body).toContain('issueLaunchPrompt(ref)')
    expect(body).toContain('{ issueRef: ref }')
    // The attacker-writable fields of the issue never reach this function's launch.
    expect(body).not.toMatch(/issue\.title|issue\.body/)
  })

  it('the menu reuses the canvas agent + account picker instead of a fourth copy', () => {
    const body = code(between('const issueAgentMenu = useCallback(', '// Global kanban swimlane'))
    expect(body).toContain('agentCreationEntries(undefined, undefined, {')
    expect(body).toContain('startIssueAgent(issue, aid, acct)')
  })
})
