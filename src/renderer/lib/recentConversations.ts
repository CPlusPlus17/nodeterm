// "Open recent" — the pure half: where a past conversation should be resumed, and how the list is
// grouped. Canvas executes the plan; nothing here touches a store or the disk.
//
// The rules, each a refusal or a dedupe the feature would be wrong without:
//  - A conversation already held by a node (the node's live hook-fed id, else the id it persisted)
//    is FOCUSED, never resumed twice — two CLIs writing one transcript interleave it.
//  - The session id is re-validated (`canResumeWith` = SAFE_SESSION_ID) before anything is planned:
//    it came off disk, and the plan ends with it on a typed command line.
//  - Resume happens only in a LOCAL folder project whose cwd is exactly the conversation's. The
//    history is this machine's, so an SSH project (its cwd is on the host) and a relay tab (another
//    machine's project) never match. No project → offer to open the folder as one.
//  - The conversation must run under the account whose config dir holds it: a managed/linked
//    account that is gone (or pending, or pinned to a host) refuses rather than resuming under the
//    system login, where the CLI would answer "No conversation found".
import type { ClaudeAccount, Project } from '@shared/types'
import type { CodexAccount } from '@shared/codex-account'
import { canResumeWith } from '@shared/agents/config'
import type { RecentConversation } from '@shared/recent-conversations'

export type ResumePlan =
  | { kind: 'focus'; nodeId: string; projectId: string }
  | { kind: 'resume'; projectId: string; reopen: boolean }
  | { kind: 'open-folder'; folder: string }
  | { kind: 'refuse'; reason: string }

export const RESUME_REFUSALS = {
  unsafeId: 'This conversation’s id cannot be put on a command line safely.',
  noCwd: 'The history does not say which folder this conversation ran in.',
  accountGone: 'The account this conversation belongs to is no longer set up on this machine.'
} as const

/** A node's session as the planner needs it: its id, its project, the ids it could be holding. */
export interface HeldSession {
  nodeId: string
  projectId: string
  /** The live hook-fed id (wins), and the persisted `agentSessionId`. */
  sessionIds: Array<string | undefined>
}

export interface ResumeContext {
  projects: readonly Pick<Project, 'id' | 'cwd' | 'ssh' | 'closed' | 'unavailable' | 'remote'>[]
  activeProjectId: string
  held: readonly HeldSession[]
  claudeAccounts: readonly Pick<ClaudeAccount, 'id' | 'host' | 'pending'>[]
  codexAccounts: readonly Pick<CodexAccount, 'id' | 'host' | 'pending'>[]
}

/** Every node holding a session, from the live canvas (active project) and the stored projects.
 *  The live copy of the active project wins: the store lags it by an autosave. */
export function heldSessions(
  projects: readonly Pick<Project, 'id' | 'nodes'>[],
  activeProjectId: string,
  liveNodes: ReadonlyArray<{ id: string; data?: { agentSessionId?: unknown } }>,
  liveSessionId: (nodeId: string) => string | undefined
): HeldSession[] {
  const out: HeldSession[] = []
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  for (const n of liveNodes) {
    out.push({
      nodeId: n.id,
      projectId: activeProjectId,
      sessionIds: [liveSessionId(n.id), str(n.data?.agentSessionId)]
    })
  }
  for (const p of projects) {
    if (p.id === activeProjectId && liveNodes.length) continue
    for (const n of p.nodes ?? []) {
      out.push({
        nodeId: n.id,
        projectId: p.id,
        sessionIds: [liveSessionId(n.id), str((n as { agentSessionId?: unknown }).agentSessionId)]
      })
    }
  }
  return out
}

export function findHolder(conv: RecentConversation, held: readonly HeldSession[]): HeldSession | undefined {
  return held.find((h) => h.sessionIds.some((id) => id === conv.sessionId))
}

function accountUsable(conv: RecentConversation, ctx: ResumeContext): boolean {
  if (!conv.accountId) return true
  if (conv.agentId === 'claude') {
    return ctx.claudeAccounts.some((a) => a.id === conv.accountId && !a.host && !a.pending)
  }
  if (conv.agentId === 'codex') {
    return ctx.codexAccounts.some((a) => a.id === conv.accountId && !a.host && !a.pending)
  }
  // Only claude and codex have managed accounts; anything else naming one is not ours to trust.
  return false
}

/** Normalize a folder for comparison: trailing separators do not make a different directory. */
function sameDir(a: string | undefined, b: string): boolean {
  if (!a) return false
  const trim = (s: string): string => (s.length > 1 ? s.replace(/[/\\]+$/, '') : s)
  return trim(a) === trim(b)
}

export function planResume(conv: RecentConversation, ctx: ResumeContext): ResumePlan {
  // A conversation that is already open is where the user is going, whatever else is true.
  const holder = findHolder(conv, ctx.held)
  if (holder) return { kind: 'focus', nodeId: holder.nodeId, projectId: holder.projectId }
  if (!canResumeWith(conv.agentId, conv.sessionId)) return { kind: 'refuse', reason: RESUME_REFUSALS.unsafeId }
  if (!accountUsable(conv, ctx)) return { kind: 'refuse', reason: RESUME_REFUSALS.accountGone }
  if (!conv.cwd) return { kind: 'refuse', reason: RESUME_REFUSALS.noCwd }
  const local = ctx.projects.filter(
    (p) => !p.ssh && !p.remote && !p.unavailable && sameDir(p.cwd, conv.cwd!)
  )
  const pick =
    local.find((p) => p.id === ctx.activeProjectId) ?? local.find((p) => !p.closed) ?? local[0]
  if (pick) return { kind: 'resume', projectId: pick.id, reopen: !!pick.closed }
  return { kind: 'open-folder', folder: conv.cwd }
}

/** The action a row offers, in words. */
export function resumeActionLabel(plan: ResumePlan, projectName: (id: string) => string): string {
  switch (plan.kind) {
    case 'focus':
      return 'Go to node'
    case 'resume':
      return `Resume in ${projectName(plan.projectId)}`
    case 'open-folder':
      return 'Open folder & resume'
    case 'refuse':
      return 'Cannot resume'
  }
}

export interface RecentFolderGroup {
  /** null = the conversations whose history does not name a folder. */
  cwd: string | null
  items: RecentConversation[]
}

/** Group by folder, groups ordered by their newest conversation, rows newest-first within. */
export function groupRecentByFolder(items: readonly RecentConversation[]): RecentFolderGroup[] {
  const groups = new Map<string, RecentFolderGroup>()
  const sorted = [...items].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  for (const it of sorted) {
    const key = it.cwd ?? '\0'
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { cwd: it.cwd, items: [] }))
    g.items.push(it)
  }
  return [...groups.values()]
}

/** The last path segment, for a compact folder label. */
export function folderLabel(cwd: string | null): string {
  if (!cwd) return 'Unknown folder'
  const segs = cwd.split(/[/\\]+/).filter(Boolean)
  return segs[segs.length - 1] ?? cwd
}

/** The display title, never empty. */
export function recentTitle(conv: RecentConversation): string {
  return conv.title || `Untitled ${conv.agentId} conversation`
}

/** The managed Codex homes this machine may read: local, settled accounts only (a host-pinned
 *  account's home is on that host; a pending one has never logged in). */
export function localCodexAccountIds(accounts: readonly Pick<CodexAccount, 'id' | 'host' | 'pending'>[]): string[] {
  return accounts.filter((a) => a && typeof a.id === 'string' && !a.host && !a.pending).map((a) => a.id)
}
