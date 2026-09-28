// What the board header and Settings → GitHub Issues say about the state of GitHub sync — decided
// in one pure place so the two surfaces cannot describe the same condition in two ways. Each
// sentence names only what was measured: the throttle and budget come from GitHub's own
// `x-ratelimit-*` headers (or its refusal), never from a guess about why a request failed.
import type { GitHubRateStatus, GitHubThrottle } from '@shared/github-issues'

/** Local wall-clock time, hours and minutes. */
export function githubClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function githubThrottleSentence(
  throttle: GitHubThrottle | undefined,
  clock: (ms: number) => string = githubClock
): string | null {
  if (!throttle) return null
  return throttle.kind === 'rate-limited'
    ? `GitHub rate limit reached. Sync resumes at ${clock(throttle.until)}.`
    : `Background sync paused until ${clock(throttle.until)} to leave the rest of this hour’s GitHub requests to you.`
}

export function githubRateSentence(
  rate: GitHubRateStatus,
  clock: (ms: number) => string = githubClock
): string {
  return `${rate.remaining.toLocaleString('en-US')} of ${rate.limit.toLocaleString('en-US')} GitHub requests left until ${clock(rate.resetAt)}.`
}
