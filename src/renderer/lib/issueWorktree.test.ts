import { describe, expect, it } from 'vitest'
import {
  ISSUE_WORKTREE_LABEL,
  ISSUE_WORKTREE_NO_REPO_HINT,
  ISSUE_WORKTREE_RELAY_HINT,
  issueWorktreeChoiceCopy,
  issueWorktreeMenuRow,
  issueWorktreeRefusal,
  issueWorktreeRenamedNotice
} from './issueWorktree'
import { WORKTREE_NO_CWD_HINT, WORKTREE_SSH_HINT } from './addMenuSpec'
import type { MenuItem } from '../components/ContextMenu'

const OK = { relay: false, ssh: false, cwd: '/work/repo', repoRoot: '/work/repo' }

describe('issueWorktreeRefusal', () => {
  it('lets a local project with a repository through', () => {
    expect(issueWorktreeRefusal(OK)).toBeNull()
  })

  it('refuses the surfaces worktrees do not reach in v1, each with its own reason', () => {
    expect(issueWorktreeRefusal({ ...OK, relay: true })).toBe(ISSUE_WORKTREE_RELAY_HINT)
    expect(issueWorktreeRefusal({ ...OK, ssh: true })).toBe(WORKTREE_SSH_HINT)
    expect(issueWorktreeRefusal({ ...OK, cwd: undefined })).toBe(WORKTREE_NO_CWD_HINT)
    expect(issueWorktreeRefusal({ ...OK, cwd: '  ' })).toBe(WORKTREE_NO_CWD_HINT)
    expect(issueWorktreeRefusal({ ...OK, repoRoot: null })).toBe(ISSUE_WORKTREE_NO_REPO_HINT)
  })

  it('names the tab kind before anything about its project (a shared tab is refused as such)', () => {
    expect(issueWorktreeRefusal({ relay: true, ssh: true, cwd: undefined, repoRoot: null })).toBe(
      ISSUE_WORKTREE_RELAY_HINT
    )
    // An SSH project has no LOCAL folder or repository to speak of — say SSH, not "no folder".
    expect(issueWorktreeRefusal({ relay: false, ssh: true, cwd: undefined, repoRoot: null })).toBe(
      WORKTREE_SSH_HINT
    )
  })
})

describe('issueWorktreeMenuRow', () => {
  it('is a submenu of the agent rows when the action can run', () => {
    const items: MenuItem[] = [{ label: 'Claude', onClick: () => {} }]
    expect(issueWorktreeMenuRow({ items })).toEqual({
      type: 'submenu',
      label: ISSUE_WORKTREE_LABEL,
      icon: undefined,
      children: items
    })
  })

  it('is the same label DISABLED with the reason when it cannot — never a missing row', () => {
    const row = issueWorktreeMenuRow({ refusal: WORKTREE_SSH_HINT })
    expect(row).toMatchObject({ label: ISSUE_WORKTREE_LABEL, disabled: true, hint: WORKTREE_SSH_HINT })
  })
})

describe('issueWorktreeChoiceCopy', () => {
  const alt = { branch: 'issue-12-fix-2', path: '/w/issue-12-fix-2' }

  it('offers reuse (preselected) and a DIFFERENT new branch, and promises nothing is overwritten', () => {
    const copy = issueWorktreeChoiceCopy(
      12,
      { kind: 'bound', groupId: 'g', branch: 'issue-12-fix', path: '/w/issue-12-fix' },
      alt,
      'main'
    )
    expect(copy.value).toBe('reuse')
    expect(copy.options.map((o) => o.value)).toEqual(['reuse', 'new'])
    expect(copy.message).toContain('issue-12-fix')
    expect(copy.message).toContain('Nothing will be overwritten')
    expect(copy.options[1].label).toContain('issue-12-fix-2 off main')
  })

  it('says an adopted worktree is not the app\'s to delete', () => {
    const copy = issueWorktreeChoiceCopy(
      12,
      {
        kind: 'orphan',
        branch: 'issue-12-fix',
        path: '/w/issue-12-fix',
        entry: { path: '/w/issue-12-fix', branch: 'issue-12-fix', head: 'a', isBare: false }
      },
      alt,
      'main'
    )
    expect(copy.options[0].label).toContain('Remove will not delete')
  })

  it('offers to check out an existing branch, and only reuse when no free name is left', () => {
    const copy = issueWorktreeChoiceCopy(
      12,
      { kind: 'branch', branch: 'issue-12-fix', path: '/w/issue-12-fix' },
      null,
      'main'
    )
    expect(copy.options).toHaveLength(1)
    expect(copy.options[0].label).toBe('Check out issue-12-fix in a new worktree at /w/issue-12-fix')
    expect(copy.message).toContain('only reuse is offered')
  })
})

describe('issueWorktreeRenamedNotice', () => {
  it('says why the new worktree has a suffix', () => {
    expect(issueWorktreeRenamedNotice('issue-12-fix', 'issue-12-fix-2')).toBe(
      'issue-12-fix was already taken (a branch or folder of that name exists), so the new worktree is issue-12-fix-2.'
    )
  })
})
