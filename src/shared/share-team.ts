// Wire shapes shared by the desktop's "Share with team" flow and the Server Edition's `team` admin
// verbs. Everything here crosses an ssh exec channel as JSON, so every reader is strict.
import { NODE_ID_MAX } from './safe-id'
import { SESSION_ID_MAX } from './session-id'

/** `team bootstrap --json`'s answer: the team's address, the project it adopted and shared, the
 *  join code, and what this call changed (every `created` flag false on a re-run). */
export interface BootstrapResult {
  hostId: string
  projectId: string
  projectName: string
  joinCode: string
  /** `starting` is still a success: no relay verdict arrived within the wait, and a join retries. */
  hosting: 'up' | 'starting'
  created: { team: boolean; owner: boolean; project: boolean; share: boolean }
}

/** One agent session `team resume` restarts: the node it belongs to, the agent it runs, and the
 *  conversation to resume. `permissionMode` is a request only; the server re-validates it. */
export interface ResumeEntry {
  nodeId: string
  agentId: string
  sessionId: string
  permissionMode?: string
}
/** `already-running` is a success: the node's session exists, so nothing was started twice. */
export type ResumeStatus = 'resumed' | 'already-running' | 'refused'
export interface ResumeResultEntry {
  nodeId: string
  status: ResumeStatus
  reason?: string
}
/** `team resume --json`'s answer: one result per requested session, in request order. */
export interface ResumeResult {
  results: ResumeResultEntry[]
}
/** The most sessions one resume request takes (a share handles at most this many terminals). */
export const RESUME_MAX_SESSIONS = 200

const boundedString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max

/** Shape check for a resume list arriving from the wire or stdin. Returns the list, or why not.
 *  Only the known fields survive; every value is checked again where it is used. */
export function parseResumeSessions(raw: unknown): ResumeEntry[] | string {
  if (!Array.isArray(raw)) return 'The resume input must be a JSON list of sessions.'
  if (raw.length > RESUME_MAX_SESSIONS) return `A resume request takes at most ${RESUME_MAX_SESSIONS} sessions.`
  const out: ResumeEntry[] = []
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Record<string, unknown> | null
    if (
      !e ||
      typeof e !== 'object' ||
      !boundedString(e.nodeId, NODE_ID_MAX) ||
      !boundedString(e.agentId, 64) ||
      !boundedString(e.sessionId, SESSION_ID_MAX)
    ) {
      return `Resume entry ${i} needs nodeId, agentId and sessionId strings.`
    }
    if (e.permissionMode !== undefined && !boundedString(e.permissionMode, 32)) {
      return `Resume entry ${i} has a bad permissionMode.`
    }
    out.push({
      nodeId: e.nodeId,
      agentId: e.agentId,
      sessionId: e.sessionId,
      ...(typeof e.permissionMode === 'string' ? { permissionMode: e.permissionMode } : {})
    })
  }
  return out
}
