// Board dispatch: a GitHub issue card that THIS person drags into a chosen column starts its own
// agent run ("Start with agent", without the click). This module is the machine-local consent — the
// switch, the column, the agent and the cap — and the one reader of it.
//
// MACHINE-LOCAL BY CONSTRUCTION, the same tier as the trigger arm store and
// `kanbanPullAutoMove`: it lives in settings.json, never in `.nodeterm/project.json`. The project
// file is written by anyone who can commit to the repository; a dispatch switch there would let a
// pull request make every clone start agents. The column id it names is a board column (shared
// content), but WHETHER dropping a card on it runs an agent here is this machine's decision.
//
// settings.json is hand-editable, so everything goes through `sanitizeBoardDispatch`. Every
// failure direction is "fewer runs": an unreadable entry is OFF and an unreadable cap is 1. The
// kill switch is on only for a literal `true`; an absent or unreadable block already dispatches
// nothing, because no project is switched on.

export const BOARD_DISPATCH_MAX_CONCURRENT = 8
export const BOARD_DISPATCH_DEFAULT_CONCURRENT = 2

export interface BoardDispatchProject {
  /** The column a card must be dragged INTO. A column deleted since then dispatches nothing. */
  columnId: string
  /** Which agent a dispatched run opens (a builtin id or `custom:<uuid>`). */
  agentId: string
  /** The account the run opens under; absent = the project default (the "New <agent>" funnel). */
  accountId?: string
  /** Live runs this project may have at once; further dispatches queue. 1..8. */
  maxConcurrent: number
}

export interface BoardDispatch {
  /** The kill switch: nothing dispatches and the queue is dropped while it is on. */
  paused: boolean
  projects: Record<string, BoardDispatchProject>
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function projectKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

/** Out-of-range or unreadable caps clamp DOWN: a guessed higher cap is more runs than consented. */
export function clampConcurrent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  const n = Math.floor(value)
  if (n < 1) return 1
  return Math.min(n, BOARD_DISPATCH_MAX_CONCURRENT)
}

export function sanitizeBoardDispatch(raw: unknown): BoardDispatch {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const projectsRaw =
    value.projects && typeof value.projects === 'object' && !Array.isArray(value.projects)
      ? (value.projects as Record<string, unknown>)
      : {}
  const projects: Record<string, BoardDispatchProject> = {}
  for (const [projectId, entryRaw] of Object.entries(projectsRaw).slice(0, 500)) {
    const entry = entryRaw && typeof entryRaw === 'object' && !Array.isArray(entryRaw)
      ? (entryRaw as Record<string, unknown>)
      : null
    if (!projectKey(projectId) || !entry) continue
    if (!projectKey(entry.columnId) || !safeId(entry.agentId)) continue
    projects[projectId] = {
      columnId: entry.columnId,
      agentId: entry.agentId,
      ...(safeId(entry.accountId) ? { accountId: entry.accountId } : {}),
      maxConcurrent: clampConcurrent(entry.maxConcurrent)
    }
  }
  return { paused: value.paused === true, projects }
}

/** Drops projects this machine no longer has (closed ones are kept — closing parks). */
export function pruneBoardDispatch(value: BoardDispatch, liveProjectIds: ReadonlySet<string>): BoardDispatch {
  return {
    paused: value.paused,
    projects: Object.fromEntries(Object.entries(value.projects).filter(([id]) => liveProjectIds.has(id)))
  }
}
