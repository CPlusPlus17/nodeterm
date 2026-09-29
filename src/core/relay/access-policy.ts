// Hosted-relay roles are a SECURITY BOUNDARY, enforced here, at the one choke point every relay
// peer message crosses (relay-host.ts hooks). The UI only mirrors it.
//
// Two rules the whole file rests on:
//  - DENY BY DEFAULT for non-editors, in BOTH directions. Inbound, a method is reachable by a
//    Viewer/Commenter only if it is in VIEW/COMMENT below. Outbound, an event reaches them only if
//    it is in VIEW_EVENTS / VIEW_EVENT_PREFIXES: the core BROADCASTS to every attached client (the
//    debug log stream, whole project documents, account usage…), so an allow-by-default filter
//    would hand a viewer everything nobody remembered to list. A channel added tomorrow is
//    Editor-only, in and out, until someone decides otherwise.
//  - "READ" IS NOT "SAFE": relay peers were fully trusted, so fs:read is not jailed, pty:create on
//    any persistKey joins OR SPAWNS (and its options can name an ssh route), and two git "reads"
//    are not reads at all — `git diff --no-index` diffs any file on the host, and a `git show` ref
//    that starts with `-` is parsed as an option (`--output=<file>` WRITES a file). Every VIEW entry
//    therefore carries its own argument check.
//
// Editors and owners pass untouched: Editor is shell access by definition, so gating them would be
// theatre.
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import { decodePtyDataSessionId } from '../../shared/rpc'
import type { TeamRole } from './team-store'
import type { AccessDecision } from './relay-host'
import type { UiSink } from '../ui-sink-registry'

export interface AccessContext {
  role: TeamRole
  sharedProjects: ReadonlySet<string>
  /** The project a node belongs to, from the persisted canvases. */
  projectOfNode(nodeId: string): string | undefined
  /** The node (canvas node id) a live terminal session runs, from the pty manager; undefined when
   *  the session is unknown (never existed, or already ended). */
  nodeOfSession(sessionId: string): string | undefined
  /** The LOCAL cwds of the shared projects. */
  projectCwds(): string[]
  /** `fs.realpath`; null = the path does not resolve. */
  realpath(p: string): string | null
}

type Check = (args: unknown[], ctx: AccessContext) => AccessDecision
const OK: AccessDecision = { allow: true }
const no = (message: string): AccessDecision => ({ allow: false, message })
const pass: Check = () => OK

const isEditor = (role: unknown): boolean => role === 'owner' || role === 'editor'

const sharedProject = (id: unknown, ctx: AccessContext): boolean =>
  typeof id === 'string' && ctx.sharedProjects.has(id)

const sharedNode = (id: unknown, ctx: AccessContext): boolean => {
  if (typeof id !== 'string') return false
  const project = ctx.projectOfNode(id)
  return project !== undefined && ctx.sharedProjects.has(project)
}

/** One property of an object payload (our own fixed key names only), else undefined. */
const field = (v: unknown, key: string): unknown =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined

/**
 * The shared project roots as REAL paths. A project opened through a symlinked folder has a cwd that
 * never equals its files' realpaths, so the cwd is realpathed too (and kept as written when it does
 * not resolve). A relative or empty cwd is never a root: `'' + sep` is a prefix of every path.
 */
function sharedRoots(ctx: AccessContext): string[] {
  const roots: string[] = []
  for (const cwd of ctx.projectCwds()) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue
    roots.push(ctx.realpath(cwd) ?? cwd)
  }
  return roots
}

/** `p` is `root` or below it. Relative-path based, so a sibling like `/srv/app2` is not inside
 *  `/srv/app`, a root of `/` contains everything, and a path on another Windows drive is outside. */
function within(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

/** The REAL path of `p` when it is an absolute path inside a shared project root, else null. The
 *  file is realpathed, so a symlink planted inside the project that points out of it is outside. */
function realInSharedCwd(p: unknown, ctx: AccessContext): string | null {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null
  const resolved = ctx.realpath(path.resolve(p))
  if (!resolved) return null
  return sharedRoots(ctx).some((root) => within(root, resolved)) ? resolved : null
}

const READ_JAIL = 'Viewers can only read files inside a shared project.'

const NOT_OWN_REPO =
  'Git is available to viewers only in a project that is the top folder of its own repository, never in a subfolder of a larger one.'

/**
 * Is `real` (a realpath inside a shared root) under a shared root that holds its OWN `.git` — a
 * directory, or a worktree's `.git` file? The cwd jail alone does not bound git: `git show <ref>:<p>`
 * resolves a bare `<p>` against the repository's TOP LEVEL, and `git status` / `git log` report the
 * whole repository, so from `repo/shared/` a viewer could read `repo/secret/key.txt` (measured with
 * real git). A root with its own `.git` stops git's upward discovery at or below it, so every
 * repository reachable from `real` is inside something that is shared anyway. Any containing root
 * counts: a nested shared root that is its own repository is fine even when the outer one is not.
 * Planting a `.git` (or a `gitdir:` file pointing elsewhere) takes write access to the shared root,
 * which only an editor has.
 */
function underOwnRepoRoot(real: string, ctx: AccessContext): boolean {
  return sharedRoots(ctx).some((root) => within(root, real) && ctx.realpath(path.join(root, '.git')) !== null)
}

/** Every git VIEW check: the cwd jailed like a file read, then the repository rule above. */
const gitView =
  (rest: Check = pass): Check =>
  (a, ctx) => {
    const cwd = realInSharedCwd(a[0], ctx)
    if (!cwd) return no(READ_JAIL)
    if (!underOwnRepoRoot(cwd, ctx)) return no(NOT_OWN_REPO)
    return rest(a, ctx)
  }

const nodeArg0: Check = (a, ctx) => (sharedNode(a[0], ctx) ? OK : no('That terminal is not in a shared project.'))
const pathArg0: Check = (a, ctx) => (realInSharedCwd(a[0], ctx) ? OK : no(READ_JAIL))
const projectArg0: Check = (a, ctx) => (sharedProject(a[0], ctx) ? OK : no('That project is not shared.'))

/** The ONLY create fields a watch-only join keeps. Everything else on `PtyCreateOptions` either
 *  shapes a spawn (shell, cwd, account, env) or routes one: `sshRemote.conn` carries `extraArgs`
 *  and `execTrusted`, and the join's existence probe runs `ssh` with them BEFORE `joinOnly` refuses
 *  anything — an `-oProxyCommand=` there is a command run on this host. */
function viewerCreateOptions(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { persistKey: o.persistKey }
  if (typeof o.cols === 'number') out.cols = o.cols
  if (typeof o.rows === 'number') out.rows = o.rows
  if (typeof o.viewerId === 'string') out.viewerId = o.viewerId
  return { ...out, joinOnly: true, sizeVote: false }
}

/** `git diff` (handler args: cwd, file, staged, untracked). The FILE is jailed as well as the cwd.
 *  Its pathspec is cwd-relative, not top-level-relative (measured: from `repo/shared/`,
 *  `git diff -- secret/key.txt` matches nothing), so the lexical file jail below holds; the
 *  repository rule (`gitView`) runs first all the same, like for every git VIEW method. */
const gitDiff: Check = (a, ctx) => {
  const cwd = realInSharedCwd(a[0], ctx)
  if (!cwd) return no(READ_JAIL)
  const file = a[1]
  // Pathspec magic (`:(top)…`) re-roots the path at the repository, which can sit above the project.
  if (typeof file !== 'string' || file.startsWith(':')) return no(READ_JAIL)
  const target = path.resolve(cwd, file)
  // The handler reads `untracked` truthily, and then runs `git diff --no-index -- /dev/null <file>`,
  // which compares FILES, not a repository: any path on the host. Only a real path inside passes.
  if (a[3]) return realInSharedCwd(target, ctx) ? OK : no(READ_JAIL)
  // A tracked diff: git refuses a pathspec outside the repository and does not follow a symlink in
  // one, so a lexical check is enough — and a deleted file, which has no realpath, stays viewable.
  return sharedRoots(ctx).some((root) => within(root, target)) ? OK : no(READ_JAIL)
}

/** `git show <ref>:<file>` (handler args: cwd, ref, file). A ref starting with `-` becomes an
 *  OPTION of `git show`; measured: `--output=<path>` writes the command's output to that path. The
 *  file is relative to the repository's top level, which is why `gitView` runs first. */
const gitShowFile: Check = (a) => {
  const ref = a[1]
  if (ref !== undefined && ref !== null && (typeof ref !== 'string' || ref.startsWith('-'))) {
    return no('That is not a revision name.')
  }
  return typeof a[2] === 'string' ? OK : no(READ_JAIL)
}

export const VIEW: Readonly<Record<string, Check>> = Object.freeze({
  // Narrowed to the shared projects by the host's narrowResponse hook.
  [IPC.workspaceLoad]: pass,
  [IPC.ptyCreate]: (a, ctx) => {
    const o = a[0]
    if (!o || typeof o !== 'object' || Array.isArray(o) || !sharedNode((o as Record<string, unknown>).persistKey, ctx)) {
      return no('Viewers can only watch terminals in a shared project that are already running.')
    }
    return { allow: true, args: [viewerCreateOptions(o as Record<string, unknown>)] }
  },
  // Rewritten to "not looking": a viewer's window never sizes the shared terminal.
  [IPC.ptyResize]: (a) => ({ allow: true, args: [a[0], null, null, ...(a.length > 3 ? [a[3]] : [])] }),
  // Handler args: sessionId, resume, viewerId. A PAUSE is not the sender's own business: it pauses
  // the shared pty process (`PtyManager.setFlow` → `proc.pause()`) for every subscriber until the
  // pausing view resumes or leaves, so a viewer that never resumes freezes the editor's terminal.
  // A viewer may only resume (a no-op for a view that owes no pause). That closes the EXPLICIT
  // pause, not every pause: a relay peer whose socket backlog passes WS_HIGH_WATER (1 MB) still
  // takes that connection's `socket` backpressure ticket (ui-sink-registry.ts `sendTo`), which pauses
  // the shared pty for every subscriber until the backlog drains below WS_LOW_WATER or the peer
  // leaves. Only past the 8 MB drop-and-redraw ceiling is its output dropped and the pause handed
  // back. A known residual: docs/hosted-team-relay.md, "Limitations (v1)".
  [IPC.ptyFlow]: (a) => (a[1] === true ? OK : no('Viewers never pause a shared terminal.')),
  // Detaches the sender's OWN view only (the core checks `subscribes`); the session keeps running.
  [IPC.ptyKill]: pass,
  [IPC.ptyCapture]: nodeArg0,
  [IPC.ptyReadScrollback]: nodeArg0,
  [IPC.ptyPaneCommand]: nodeArg0,
  [IPC.ptyTmuxStatus]: pass,
  [IPC.fsList]: pathArg0,
  [IPC.fsRead]: pathArg0,
  [IPC.fsReadBinary]: pathArg0,
  [IPC.fsExists]: pathArg0,
  // Every git VIEW method: the cwd jail, then the shared root must be its own repository (C1).
  [IPC.gitStatus]: gitView(),
  [IPC.gitRepoRoot]: gitView(),
  [IPC.gitDiff]: gitView(gitDiff),
  [IPC.gitShowFile]: gitView(gitShowFile),
  // Its only other argument's ref (`baseRef`) is refused by the core when it starts with `-`.
  [IPC.gitHistory]: gitView(),
  // The RESPONSE is trimmed by narrowResponseForRole (it is a response, not an event).
  [IPC.agentSubagentSnapshot]: pass,
  [IPC.presenceHello]: pass,
  [IPC.presenceCursor]: pass,
  [IPC.presenceFocus]: pass,
  [IPC.presenceProject]: pass,
  [IPC.boardLogRead]: projectArg0,
  [IPC.boardLogSubscribe]: projectArg0,
  [IPC.boardLogUnsubscribe]: projectArg0
})

export const COMMENT: Readonly<Record<string, Check>> = Object.freeze({
  [IPC.presenceChat]: pass,
  [IPC.boardLogAppend]: projectArg0
})

/**
 * Relay-reachable channels reviewed and deliberately left Editor-only: every `IPC.*` the relay tab's
 * API builders reference that is not in VIEW/COMMENT (the guard test lists them). Listing a channel
 * here changes nothing at runtime — non-editors are denied anything not allowlisted — it records
 * that someone DECIDED. This is about what a peer may SEND; what it may RECEIVE is VIEW_EVENTS, so
 * server→client event channels are listed here too (a client cannot invoke them).
 */
export const EDITOR_ONLY: ReadonlySet<string> = new Set<string>([
  // Terminals: typing, ending, restarting and signalling a session; host-side probes.
  IPC.ptyWrite,
  IPC.ptyDestroy,
  IPC.ptyRecycle,
  IPC.ptySessionAge,
  IPC.ptySendText,
  IPC.ptyPaneOwner,
  IPC.ptyTerminateForeground,
  IPC.ptyReadSessionName,
  // Workspace, project settings and setup: writes, probes of arbitrary folders, trust, scripts.
  IPC.workspaceSave,
  IPC.workspaceProbeFolder,
  IPC.workspaceProjectFileState,
  IPC.projectSettingsRead,
  IPC.projectSettingsWriteShared,
  IPC.projectSettingsUpdateLocal,
  IPC.projectSettingsLaunchInfo,
  IPC.projectSetupRun,
  IPC.projectSetupCancel,
  IPC.projectSetupConsentSubmit,
  IPC.projectSetupRequestTrust,
  IPC.projectSetupSubscribe,
  IPC.projectSetupUnsubscribe,
  IPC.worktreeMaterializeShared,
  // Host settings, credentials and paths.
  IPC.settingsLoad,
  IPC.settingsSave,
  IPC.agentDiscoverModels,
  IPC.agentGatewayCredentialStatus,
  IPC.agentGatewayCredentialSave,
  IPC.agentGatewayCredentialClear,
  IPC.appUserDataDir,
  IPC.claudeCliCaps,
  // Files: writes, uploads, and unjailed listings / downloads.
  IPC.fsWrite,
  IPC.fsMkdir,
  IPC.filesQuickOpen,
  IPC.filesDownloadTicket,
  IPC.filesSaveUpload,
  IPC.filesSaveCanvasImage,
  // Git: every mutation, plus network, worktree and commit-message (runs an agent CLI) operations.
  IPC.gitInit,
  IPC.gitClone,
  IPC.gitCloneAbort,
  IPC.gitCloneDefaultParent,
  IPC.gitCommit,
  IPC.gitPush,
  IPC.gitPull,
  IPC.gitSync,
  IPC.gitPublish,
  IPC.gitStage,
  IPC.gitUnstage,
  IPC.gitStageAll,
  IPC.gitUnstageAll,
  IPC.gitDiscard,
  IPC.gitSwitchBranch,
  IPC.gitCreateBranch,
  IPC.commitGenerate,
  IPC.gitCommitFiles,
  IPC.gitRemoteCommitUrl,
  IPC.gitMerge,
  IPC.gitRebase,
  IPC.gitDeleteBranch,
  IPC.gitRenameBranch,
  IPC.gitFetch,
  IPC.gitForcePush,
  IPC.gitStashPush,
  IPC.gitStashPop,
  IPC.gitRevert,
  IPC.gitBranchAt,
  IPC.gitCheckoutCommit,
  IPC.gitWorktreeList,
  IPC.gitWorktreeAdd,
  IPC.gitWorktreeMerge,
  IPC.gitWorktreeRemove,
  IPC.gitSetActiveRemote,
  // Agent context, the host debug log, GitHub (host token) and agent control.
  IPC.contextEnsure,
  IPC.logSnapshot,
  IPC.logClear,
  IPC.logSubscribe,
  IPC.logUnsubscribe,
  IPC.githubIssuesSubscribe,
  IPC.githubIssuesUnsubscribe,
  IPC.githubIssuesQuery,
  IPC.githubIssuesRefresh,
  IPC.githubIssuesMove,
  IPC.githubIssuesCreateLabels,
  IPC.githubIssuesClearCache,
  // Pull request CI / mergeability (landed on main alongside this branch). Reads and writes alike
  // run on the HOST's GitHub token, like the issue verbs above, so non-editors get none of them.
  IPC.githubIssuesPullStatus,
  IPC.githubIssuesChasePulls,
  IPC.githubIssuesPullChecks,
  IPC.githubIssuesClaimPullAutoMove,
  IPC.githubIssuesNotePullWaits,
  IPC.githubProjectAvatar,
  IPC.githubControlStatus,
  IPC.githubControlApprove,
  IPC.githubControlRevoke,
  IPC.githubControlSelectProvider,
  IPC.githubControlSaveToken,
  IPC.githubControlClearToken,
  IPC.agentHibernated,
  IPC.agentAnswerPermission,
  IPC.agentAckDone,
  // A relay tab's `seedAgentIdentity` is a local no-op (relay-api.ts), so this never crosses the
  // tunnel today; it WRITES the mirror's session identities, so a peer that sent it is an editor.
  IPC.agentSeedIdentity,
  // Canvas edits and the one presence cast VIEW does not list.
  IPC.canvasMut,
  IPC.presenceDino,
  // The hosted team verbs (renderer `buildHostedApi`). INTERCEPTED by hosted-service.ts before this
  // table is ever consulted, which judges each caller itself (`self`: any member; the rest: owners
  // only) — so this table never decides them. Listed so the guard sees a decision, not a gap. Their
  // events reach owners only (hosted-service `tellOwners`), never through VIEW_EVENTS.
  IPC.relayHostedSelf,
  IPC.relayHostedPending,
  IPC.relayHostedInviteCode,
  IPC.relayHostedApprove,
  IPC.relayHostedDeny,
  IPC.relayHostedPeerPending,
  IPC.relayHostedPendingClosed,
  // Server→client events (see the doc comment): what a non-editor receives is VIEW_EVENTS.
  IPC.workspaceMigrated,
  IPC.workspaceCorruptRecovered,
  IPC.workspaceExternalChange,
  IPC.workspaceServerChange,
  IPC.projectTrustChanged,
  IPC.projectSetupConsentRequest,
  IPC.projectSetupConsentDismiss,
  IPC.gitCloneProgress,
  IPC.contextUpdate,
  IPC.logBatch,
  IPC.agentStatus,
  IPC.agentUnreadClear,
  IPC.agentSubagentActivity,
  IPC.presenceSync,
  IPC.presencePeer
])

const ROLE_NAME: Readonly<Record<string, string>> = { owner: 'Owners', editor: 'Editors', commenter: 'Commenters', viewer: 'Viewers' }

export function decideAccess(_kind: 'req' | 'cast', method: string, args: unknown[], ctx: AccessContext): AccessDecision {
  if (isEditor(ctx.role)) return OK
  // Own keys only: a method named `constructor` must not find Object.prototype's.
  const check =
    typeof method !== 'string'
      ? undefined
      : Object.hasOwn(VIEW, method)
        ? VIEW[method]
        : ctx.role === 'commenter' && Object.hasOwn(COMMENT, method)
          ? COMMENT[method]
          : undefined
  if (!check) {
    // An unrecognised role is the lowest one, never a new name in the sentence.
    const name = Object.hasOwn(ROLE_NAME, ctx.role) ? ROLE_NAME[ctx.role] : ROLE_NAME.viewer
    return no(`${name} can't do that here. Ask an owner for Editor access.`)
  }
  return check(Array.isArray(args) ? args : [], ctx)
}

/**
 * Which node started each subagent (toolUseId → nodeId), learned from the `subagent-start` events
 * this sink saw. `agent:subagent-activity` carries only `{ toolUseId, chunk }` — no node id — so this
 * is the one way to tell a shared node's subagent transcript from anyone else's. Per sink, bounded.
 */
export type SubagentOwners = Map<string, string>
const SUBAGENT_OWNERS_MAX = 512

function learnSubagentOwner(payload: unknown, owners: SubagentOwners): void {
  if (field(payload, 'kind') !== 'subagent-start') return
  const toolUseId = field(payload, 'toolUseId')
  const nodeId = field(payload, 'nodeId')
  if (typeof toolUseId !== 'string' || typeof nodeId !== 'string') return
  // No delete on subagent-end: the tail flushes its last chunk AFTER the end event.
  const prev = owners.get(toolUseId)
  owners.delete(toolUseId)
  // Two nodes claiming one id: attributable to neither (fails closed; '' is never a shared node).
  owners.set(toolUseId, prev === undefined || prev === nodeId ? nodeId : '')
  while (owners.size > SUBAGENT_OWNERS_MAX) owners.delete(owners.keys().next().value as string)
}

type EventCheck = (args: unknown[], ctx: AccessContext, owners: SubagentOwners | undefined) => boolean
const always: EventCheck = () => true

/** Exact event channels a Viewer/Commenter may RECEIVE. Anything else is dropped for them. */
export const VIEW_EVENTS: Readonly<Record<string, EventCheck>> = Object.freeze({
  [IPC.canvasMut]: (a, ctx) => sharedProject(a[0], ctx),
  [IPC.agentStatus]: (a, ctx) => sharedNode(field(a[0], 'nodeId'), ctx),
  [IPC.agentSubagentActivity]: (a, ctx, owners) => {
    const toolUseId = field(a[0], 'toolUseId')
    return typeof toolUseId === 'string' && sharedNode(owners?.get(toolUseId), ctx)
  },
  [IPC.agentUnreadClear]: (a, ctx) => sharedNode(a[0], ctx),
  // Both carry a whole Project document.
  [IPC.workspaceExternalChange]: (a, ctx) => sharedProject(field(a[0], 'id'), ctx),
  [IPC.workspaceServerChange]: (a, ctx) => sharedProject(field(a[0], 'id'), ctx),
  [IPC.projectTrustChanged]: (a, ctx) => sharedProject(field(a[0], 'projectId'), ctx),
  // Token counts + model for an opaque agent session id: no project, node, path or text.
  [IPC.contextUpdate]: always,
  [IPC.presenceSync]: always,
  [IPC.presencePeer]: always
})

/**
 * Is this terminal session's node (still) in a shared project? `undefined` = the session is not
 * known to the pty manager (never existed, or already ended). A viewer subscribes to a session only
 * through the jailed pty:create above, but `team unshare` does not end that subscription (R45), so
 * every frame of it is judged again here.
 */
function sessionShared(sessionId: string, ctx: AccessContext): boolean | undefined {
  const nodeId = ctx.nodeOfSession(sessionId)
  return nodeId === undefined ? undefined : sharedNode(nodeId, ctx)
}

/** A frame that carries the terminal's CONTENT (bytes, a repaint): only for a known, shared session. */
const sessionContent = (sessionId: string, ctx: AccessContext): boolean => sessionShared(sessionId, ctx) === true

/** A lifecycle frame (size, exit, closed, recycled) holds no content, only a fact about the session:
 *  refused once the session's node is known to be outside the shared projects. A session the manager
 *  no longer knows still tells its subscribers it ended (a recycle is announced after the old
 *  session left the manager). */
const sessionLifecycle = (sessionId: string, ctx: AccessContext): boolean => sessionShared(sessionId, ctx) !== false

/** Per-name event channels. The pty ones are sent only to a session's SUBSCRIBERS, and are judged by
 *  the session's node (see `sessionShared`). */
const VIEW_EVENT_PREFIXES: ReadonlyArray<readonly [string, (suffix: string, ctx: AccessContext) => boolean]> = [
  [IPC.ptyExit(''), sessionLifecycle],
  [IPC.ptySize(''), sessionLifecycle],
  [IPC.ptyClosed(''), sessionLifecycle],
  [IPC.ptyRecycled(''), sessionLifecycle],
  [IPC.ptyResync(''), sessionContent],
  [IPC.boardLogChanged(''), (projectId, ctx) => sharedProject(projectId, ctx)],
  [IPC.projectSetupEvent(''), (projectId, ctx) => sharedProject(projectId, ctx)]
]

/**
 * true = deliver this sink message to the peer. Editors and owners get everything. For anyone else a
 * message is delivered only if it is an event on an allowlisted channel whose check passes; a
 * message that cannot be attributed (not JSON, not an event, no channel) is dropped, never guessed.
 * `subagentOwners` is the sink's memory of who started which subagent (see wrapSinkForRole);
 * without it, subagent output is never delivered to a non-editor.
 */
export function filterOutboundEvent(json: string, ctx: AccessContext, subagentOwners?: SubagentOwners): boolean {
  if (isEditor(ctx.role)) return true
  let m: unknown
  try {
    m = JSON.parse(json)
  } catch {
    return false
  }
  if (field(m, 't') !== 'ev') return false
  const channel = field(m, 'channel')
  if (typeof channel !== 'string') return false
  const rawArgs = field(m, 'args')
  const args = Array.isArray(rawArgs) ? rawArgs : []
  // Learn BEFORE deciding: a start on a node that is not shared today still names its owner.
  if (channel === IPC.agentStatus && subagentOwners) learnSubagentOwner(args[0], subagentOwners)
  if (Object.hasOwn(VIEW_EVENTS, channel)) return VIEW_EVENTS[channel](args, ctx, subagentOwners)
  for (const [prefix, check] of VIEW_EVENT_PREFIXES) {
    if (channel.startsWith(prefix)) return check(channel.slice(prefix.length), ctx)
  }
  return false
}

/**
 * A response the peer asked for that no argument check can narrow. Only the subagent snapshot today:
 * it holds every running subagent's task text, keyed by node. Editors and every other method pass
 * through unchanged. Wire it into the host's `narrowResponse` hook.
 */
export function narrowResponseForRole(method: string, result: unknown, ctx: AccessContext): unknown {
  if (isEditor(ctx.role) || method !== IPC.agentSubagentSnapshot) return result
  return Array.isArray(result) ? result.filter((e) => sharedNode(field(e, 'nodeId'), ctx)) : []
}

/**
 * true = deliver this binary frame to the peer. Editors and owners get every frame. For anyone else
 * only a pty data frame of a session whose node is in a shared project NOW: a subscription outlives
 * `team unshare` (R45), and a frame that cannot be attributed is dropped, never guessed.
 */
export function filterOutboundBinary(buf: Uint8Array, ctx: AccessContext): boolean {
  if (isEditor(ctx.role)) return true
  const sessionId = decodePtyDataSessionId(buf)
  return sessionId !== null && sessionContent(sessionId, ctx)
}

/**
 * The peer's sink, filtered for its role. `ctxFor` is asked per message, so a role or share change
 * applies to the next event or terminal frame. `bufferedAmount` stays the underlying socket's —
 * Stage 2 backpressure and the 8 MB drop ceiling key on it (see relay-host.ts `open`).
 */
export function wrapSinkForRole(sink: UiSink, ctxFor: () => AccessContext): UiSink {
  const owners: SubagentOwners = new Map()
  let warned = false
  /** Run a delivery decision. Fail closed WITHOUT throwing: the registry reads a throwing sink as a
   *  dead socket and would tear the peer down while its relay socket stays open. The socket's own
   *  throws (the send itself) must still propagate, so only the decision is guarded. */
  const decide = (judge: () => boolean): boolean => {
    try {
      return judge()
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn(`[access-policy] could not build the access context; dropping events: ${err instanceof Error ? err.message : String(err)}`)
      }
      return false
    }
  }
  return {
    sendText: (json) => {
      if (decide(() => filterOutboundEvent(json, ctxFor(), owners))) sink.sendText(json)
    },
    sendBinary: (buf) => {
      if (decide(() => filterOutboundBinary(buf, ctxFor()))) sink.sendBinary(buf)
    },
    bufferedAmount: () => sink.bufferedAmount?.() ?? 0
  }
}
