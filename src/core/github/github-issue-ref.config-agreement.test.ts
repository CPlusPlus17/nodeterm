import { describe, expect, it } from 'vitest'
import { parseGitHubRepository } from './config'
import { resolveIssueArg } from '../../shared/github-issue-ref'

// Two parsers read an `owner/repo` slug: the board's repository config (core) and the issue
// reference grammar (shared, used by the renderer and both shells). They are separate files so
// each side can be read on its own, which makes agreement a property to PIN rather than assume —
// a `#N` resolved against a repository the board accepts must never be refused, and a slug the
// board refuses must never become a launch-line reference.
const CORPUS = [
  'eneskirca/nodeterm',
  'a/b',
  'A1-b2/x_y.z-w',
  'a-b/.github',
  'o/..',
  'o/.',
  'o/-r',
  '-o/r',
  'o-/r',
  'a--b/r',
  'a-b-c/r',
  'o/r;rm',
  'o/r`id`',
  'o/r$(id)',
  'o /r',
  'o/r/x',
  'o',
  '',
  `${'x'.repeat(39)}/r`,
  `${'x'.repeat(40)}/r`,
  `o/${'r'.repeat(100)}`
]

describe('issue-reference grammar agrees with the board repository parser', () => {
  it('both refuse an owner with consecutive hyphens (GitHub allows only single inner ones)', () => {
    expect(parseGitHubRepository('a--b/r')).toBeNull()
    expect(parseGitHubRepository('https://github.com/a--b/r.git')).toBeNull()
    expect(parseGitHubRepository('a-b-c/r')).toBe('a-b-c/r')
  })

  it.each(CORPUS)('%j', (slug) => {
    // `parseGitHubRepository` also accepts URLs and strips `.git`; compare only on the canonical
    // `owner/repo` form it returns, which is what the renderer is handed as the project repository.
    const board = parseGitHubRepository(slug)
    const issue = resolveIssueArg('#1', slug)
    if (board === slug) {
      expect(issue.ok).toBe(true)
    } else {
      expect(issue.ok).toBe(false)
    }
  })
})
