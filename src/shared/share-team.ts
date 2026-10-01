// Wire shapes shared by the desktop's "Share with team" flow and the Server Edition's `team` admin
// verbs. Everything here crosses an ssh exec channel as JSON, so every reader is strict.

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
