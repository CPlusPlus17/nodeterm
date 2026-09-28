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

  it('resolves --issue ONCE, before any open path snapshots the projects store', () => {
    // `#N` may cost a host round trip. An await inside a path (after it captured the store) let a
    // tab switch in that window write the node into the wrong project — the #443 class.
    const body = code(src)
    const calls = body.match(/resolveIssueFlag\(/g) ?? []
    expect(calls, 'called exactly once').toHaveLength(1)
    const pre = body.indexOf('const issuePre: IssueFlagResult = issueOpen')
    expect(pre).toBeGreaterThan(-1)
    expect(pre).toBeLessThan(body.indexOf("args.project !== undefined\n      ) {"))
    expect(pre).toBeLessThan(body.indexOf('if (canColdOpen(verb)) {'))
    expect(pre).toBeLessThan(body.indexOf("case 'open-agent': {"))
    // …which also puts it before every path's `--dry-run` branch: a dry run refuses a bad `#N`.
    expect(pre).toBeLessThan(body.indexOf('if (dryRun) {'))
  })

  it('the live open path uses the pre-resolved reference and composes through issueLaunchPrompt', () => {
    const body = code(between("case 'open-agent': {", "case 'show-image': {"))
    expect(body).not.toContain('resolveIssueFlag(')
    expect(body).toContain('const issueRef = issueRefPre')
    expect(body).toContain('bound to GitHub issue ${formatIssueRef(issueRef)}')
    // The launch prompt is composed by the one function allowed to turn a reference into text.
    expect(body).toMatch(/issueRef \? issueLaunchPrompt\(issueRef, args\.prompt\) : args\.prompt/)
    expect(body).toContain('bindIssue(node, issueRef)')
    expect(body).toContain('logRunsStarted(ctlProject?.id, issueNodes, issueRef)')
  })

  it('the cold-open path uses the pre-resolved reference (resolved against the OWNING project)', () => {
    const body = code(between('if (canColdOpen(verb)) {', '// ── OFF CANVAS'))
    expect(body).not.toContain('resolveIssueFlag(')
    expect(body).toContain('const coldIssueRef = coldTerminal ? undefined : issueRefPre')
    expect(body).toContain('bound to GitHub issue ${formatIssueRef(coldIssueRef)}')
    expect(body).toMatch(/coldIssueRef \? issueLaunchPrompt\(coldIssueRef, args\.prompt\) : args\.prompt/)
    expect(body).toContain('logRunsStarted(owner.id, coldMade, coldIssueRef)')
  })

  it('the --project path uses the pre-resolved reference (resolved against the TARGET project)', () => {
    const body = code(between("args.project !== undefined\n      ) {", '// ── end of the early-handled'))
    expect(body).not.toContain('resolveIssueFlag(')
    expect(body).toContain('const tgIssueRef = tgIsTerminal ? undefined : issueRefPre')
    expect(body).toMatch(/tgIssueRef \? issueLaunchPrompt\(tgIssueRef, args\.prompt\) : args\.prompt/)
    expect(body).toContain('logRunsStarted(target.id, tgMade, tgIssueRef)')
    // The pre-resolution names the `--project` target first.
    expect(code(src)).toMatch(/await resolveIssueFlag\(\s*args\.project \?\?/)
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
