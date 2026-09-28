// What `open-agent --issue <owner/repo#N | #N>` resolves to, for the desktop control dispatch.
//
// Pure apart from the one injected question it cannot answer itself: which repository a project's
// kanban board syncs with. That is the GitHub host controller's answer (configured, else detected
// from the project's git remote — exactly what the issue lane uses), asked of the core that owns the
// project. `#N` means that repository and nothing else; with no GitHub board, or a board whose
// repository nobody can name, `#N` is refused and told the full form. The reference is re-parsed
// here with the one shared grammar even though main already refused a malformed shape — the
// renderer never trusts that the gate in front of it ran.

import { parseIssueArg, resolveIssueArg, type IssueRef } from '@shared/github-issue-ref'

export interface IssueFlagProject {
  id: string
  kanban?: { github?: { repository?: string } }
}

export type IssueFlagResult = { ok: true; ref?: IssueRef } | { ok: false; error: string }

export async function resolveIssueFlagFor(
  raw: string | undefined,
  verb: string,
  project: IssueFlagProject | undefined,
  boardRepository: (projectId: string) => Promise<string | null>
): Promise<IssueFlagResult> {
  if (raw === undefined) return { ok: true }
  // A full `owner/repo#N` needs no repository lookup — and asking anyway would put a host round trip
  // (git remote, `gh auth`) in front of every such open for nothing. Only `#N` asks.
  const parsed = parseIssueArg(raw)
  if (!parsed.ok) return { ok: false, error: `${verb}: ${parsed.error}` }
  if (parsed.kind === 'full') return { ok: true, ref: parsed.ref }
  let repository: string | null = null
  if (project?.kanban?.github) {
    // A session api without a GitHub controller (a relay tab's) may throw synchronously rather
    // than reject — either way the answer is "unknown", never a failed open.
    repository = await Promise.resolve()
      .then(() => boardRepository(project.id))
      .catch(() => null)
    repository ??= project.kanban.github.repository ?? null
  }
  const resolved = resolveIssueArg(raw, repository)
  return resolved.ok ? { ok: true, ref: resolved.ref } : { ok: false, error: `${verb}: ${resolved.error}` }
}
