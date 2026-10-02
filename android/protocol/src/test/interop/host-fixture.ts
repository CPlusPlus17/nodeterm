// Interop fixture for the Android protocol tests: runs the DESKTOP's real code on the other end of
// the wire, so the Kotlin client is checked against the implementation, not against a reading of it.
//
//   mode "relay": a tiny in-process relay broker (pairs a host and a client by room, forwards
//                 frames preserving text/binary — all the real relay does) plus the desktop's
//                 `connectHostSession` (src/main/remote/host-service.ts → relay-socket.ts host role)
//                 serving a FAKE pty/kanban/inbox bridge that records what the phone asked for.
//                 `projects.list` is NOT faked: the desktop's `buildProjectsListBlob` over a real
//                 `WorkspaceStore` and a mirror file the real agent-status mirror wrote, all under
//                 FIXTURE_USERDATA (see seedDesktopState; audit A64). Neither is `git.*`: the real
//                 `GitService` behind the real jail, over a repository in the project's folder (see
//                 seedGitRepo; audit A29).
//   mode "pair":  the desktop's real `createPairingService` (src/main/pairing-service.ts) with the
//                 home dir pointed at a temp dir by the caller (HOME, and USERPROFILE for Windows, see
//                 InteropHarness.scratchHomeEnv; refused unless `os.homedir()` is FIXTURE_HOME), and a
//                 fake `/v1/relay/device` API. It exercises the direct-SSH pairing path on every OS.
//   mode "never-ready": prints nothing and stays alive, so InteropHarnessTest can check that a
//                 harness whose ready wait fails still kills the process.
//
// Protocol with the Kotlin test: line 1 on stdout is a JSON "ready" object; every later line is a
// JSON event. Bundled by esbuild at test time (see InteropHarness.kt); `ws` stays external and
// resolves from the repo's node_modules, and `electron` is aliased to ./electron-stub.ts, so the
// real package (whose first `require` downloads the Electron binary) is never loaded (audit A60).
// esbuild only strips types, so this file is type-checked by `npm run typecheck` as part of
// tsconfig.node.json (audit A67): a desktop interface it implements cannot drift from it unseen.
// Do not cast what it hands to the desktop code (`as unknown as`, `as never`); a cast turns that
// check off for the value, and the drift then shows up only at run time.
import { execFileSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import { initPlatform, platform } from '../../../../../src/core/platform'
import { genKeyPair, publicKeyToB64 } from '../../../../../src/main/remote/e2ee'
import {
  connectHostSession,
  type HostPtyManager,
  type HostSession
} from '../../../../../src/main/remote/host-service'
import { createHostNewSessions } from '../../../../../src/main/remote/host-new-sessions'
import {
  flush as flushMirror,
  initAgentStatusMirror,
  mirrorClaudeAccount,
  recordAgentEvent,
  recordRawToolEvent,
  setMirrorSettingsProvider,
  setNodeSessionName
} from '../../../../../src/core/agent-status-mirror'
import {
  claudeAccountsSnapshot,
  claudeConfigDirFor,
  observedClaudeAccount,
  registerClaudeAccountsSource
} from '../../../../../src/core/claude-config-dir'
import { GitService } from '../../../../../src/core/git-service'
import { buildProjectsListBlob } from '../../../../../src/core/projects-list-blob'
import { WorkspaceStore } from '../../../../../src/core/workspace-store'
import { normalizeFor } from '../../../../../src/shared/agents/normalize'
import { createPairingService } from '../../../../../src/main/pairing-service'
import type { DetachedSinks } from '../../../../../src/core/pty-manager'
import { DEFAULT_SETTINGS, type ClaudeAccount, type Workspace } from '../../../../../src/shared/types'

const emit = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

initPlatform({
  userDataDir: process.env.FIXTURE_USERDATA ?? process.cwd(),
  appVersion: '0.0.0-interop',
  isPackaged: false,
  handle: () => {},
  on: () => {},
  handleWithSender: () => {},
  onWithSender: () => {},
  sendTo: () => {},
  broadcast: () => {},
  clientIds: () => [],
  openExternal: async () => {}
})

// ---- a relay broker: pair `?token=host-<room>` with `?token=client-<room>` ------------------------

function startBroker(): Promise<number> {
  const rooms = new Map<string, { host?: WebSocket; client?: WebSocket; queue: { to: 'host' | 'client'; data: unknown; binary: boolean }[] }>()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  wss.on('connection', (ws, req) => {
    const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? ''
    const m = /^(host|client)-(.+)$/.exec(token)
    if (!m) {
      ws.close(4001, 'bad token')
      return
    }
    const role = m[1] as 'host' | 'client'
    const room = rooms.get(m[2]) ?? { queue: [] }
    rooms.set(m[2], room)
    room[role] = ws
    emit({ event: 'broker-join', role })
    const peerOf = (r: 'host' | 'client'): 'host' | 'client' => (r === 'host' ? 'client' : 'host')
    const flush = (): void => {
      room.queue = room.queue.filter((q) => {
        const target = room[q.to]
        if (!target) return true
        target.send(q.data as Buffer, { binary: q.binary })
        return false
      })
    }
    flush()
    ws.on('message', (data, isBinary) => {
      room.queue.push({ to: peerOf(role), data: isBinary ? data : data.toString('utf-8'), binary: isBinary })
      flush()
    })
    ws.on('close', () => {
      emit({ event: 'broker-close', role })
      room[peerOf(role)]?.close()
      room[role] = undefined
    })
  })
  return new Promise((resolve) => wss.on('listening', () => resolve((wss.address() as { port: number }).port)))
}

// ---- mode "relay" ----------------------------------------------------------------------------------

/**
 * What the phone lists (`projects.list`), produced by the desktop's own code (audit A64), under the
 * caller's scratch userData (FIXTURE_USERDATA; the Kotlin test deletes it):
 *  - the workspace: the real `WorkspaceStore` writes it as the desktop does (a v3 index plus the
 *    folder's `.nodeterm/project.json`), and the blob serves the store's read-only `load()` of it;
 *  - `agent-status.json`: the real mirror, fed the hook POSTs a Claude session makes, as both shells
 *    feed it (the raw listener's `recordRawToolEvent`, then the normalized event with the hook
 *    server's account label into `recordAgentEvent`), and flushed by its own writer;
 *  - the mirror's settings block: the shells' provider body over one managed Claude account.
 * Hand-written here: the workspace the renderer would hand the store, the hook payloads (with the
 * `nodeterm_pending_id` the hook server merges in from its form field), the session name the
 * name sweep would publish, and the tmux session list (there is no tmux).
 */
async function seedDesktopState(): Promise<WorkspaceStore> {
  const userData = platform().userDataDir
  const workspace: Workspace = {
    version: 2,
    activeProjectId: 'p1',
    projects: [
      {
        id: 'p1',
        name: 'Demo',
        color: '#0a84ff',
        cwd: path.join(userData, 'demo'),
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          { id: 'term-abc-1', kind: 'terminal', title: 'Claude', color: '#d97757', agentId: 'claude', group: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
          { id: 'note-1', kind: 'sticky', title: 'Note', color: '#fff', group: null, text: 'hi', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }
        ],
        kanban: {
          columns: [{ id: 'c1', title: 'To Do', color: '#0a84ff' }],
          assignments: [{ nodeId: 'term-abc-1', columnId: 'c1' }],
          labels: [{ id: 'l1', name: 'bug', color: 'red' }],
          meta: [{ nodeId: 'term-abc-1', labels: ['l1'], priority: 'high' }]
        }
      }
    ]
  }
  const store = new WorkspaceStore()
  await store.save(workspace)

  // A39/A75: one managed Claude account, registered the way both shells register settings.
  const accounts: ClaudeAccount[] = [{ id: 'acct-1', label: 'Work', email: 'me@work.example', createdAt: 0 }]
  registerClaudeAccountsSource(() => accounts)
  setMirrorSettingsProvider(() => ({
    claudePermissionMode: 'manual',
    autoSupported: false,
    claudeAccounts: claudeAccountsSnapshot()
      .filter((a) => !a.host && !a.pending)
      .map((a) => mirrorClaudeAccount(a, claudeConfigDirFor(a.id)))
  }))

  // As both shells do at boot: the mirror's default file, `<userData>/agent-status.json`, which is
  // where `buildProjectsListBlob` reads it back.
  initAgentStatusMirror()
  const nodeId = 'term-abc-1'
  const session = {
    session_id: 's-1',
    // Under the account's config dir, so the hook server's label names acct-1.
    transcript_path: path.join(claudeConfigDirFor('acct-1'), 'projects', '-demo', 's-1.jsonl'),
    cwd: workspace.projects[0].cwd
  }
  const hook = (payload: Record<string, unknown>): void => {
    recordRawToolEvent(nodeId, payload)
    const ev = normalizeFor('claude', { nodeId, agentId: 'claude', payload })
    const account = observedClaudeAccount('claude', payload)
    if (ev) recordAgentEvent({ ...ev, ...(account ? { account } : {}) })
  }
  const bash = { tool_name: 'Bash', tool_input: { command: 'npm test' } }
  hook({ ...session, hook_event_name: 'PreToolUse', ...bash })
  // A held hook-reply approval: the managed hook's deterministic ticket.
  hook({ ...session, hook_event_name: 'PermissionRequest', ...bash, nodeterm_pending_id: 'term-abc-1-1700000000000-42' })
  setNodeSessionName(nodeId, 'fix bug')
  await flushMirror()
  return store
}

/**
 * The project's folder as a git repository the phone's source control works on (audit A29), made the
 * way a user would make one: an initial commit (the project's own `.nodeterm/project.json` included)
 * pushed to a bare `origin` beside the folder, then one change of each kind the status reports — a
 * staged new file, a modified tracked file and an untracked file. Repo-local identity, no signing and
 * no hooks, so a contributor's global git config cannot decide whether the phone's commit succeeds.
 */
function seedGitRepo(dir: string): void {
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'pipe' })
  }
  const origin = path.join(path.dirname(dir), 'origin.git')
  git(path.dirname(dir), 'init', '--bare', '--initial-branch=main', origin)
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.name', 'Interop')
  git(dir, 'config', 'user.email', 'interop@example.test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'))
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'initial')
  git(dir, 'remote', 'add', 'origin', origin)
  git(dir, 'push', '-u', 'origin', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello again\n')
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n')
  git(dir, 'add', 'staged.txt')
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new file\n')
}

async function runRelay(): Promise<void> {
  // Relay mode writes a workspace and the agent-status mirror under userData: never into the
  // checkout the fixture runs from.
  if (!process.env.FIXTURE_USERDATA) throw new Error('relay mode needs FIXTURE_USERDATA (a scratch dir)')
  const port = await startBroker()
  const keys = genKeyPair()
  const approveAfter = Number(process.env.FIXTURE_APPROVE_AFTER_MS ?? '0')
  // "Deny" on the desktop: standing-host.ts removes the pooled session, which closes it.
  const rejectAfter = Number(process.env.FIXTURE_REJECT_AFTER_MS ?? '-1')
  // A snapshot over the 256 KB chunk size, made of 3-byte code points so a chunk boundary splits
  // one: the reassembler must join BYTES before decoding.
  const bigSnapshot = 'SNAP-' + '€'.repeat(100_000) + '-END'
  let sinks: DetachedSinks | null = null
  let sessionCounter = 0

  const pty: HostPtyManager = {
    createDetached() {
      throw new Error('not used')
    },
    attachDetached(persistKey, s, options) {
      sinks = s
      const id = `sess-${++sessionCounter}`
      emit({ event: 'attach', persistKey, cols: options?.cols, rows: options?.rows, adaptsToSize: s.adaptsToSize, cwd: options?.cwd, accountId: options?.accountId, agentId: options?.agentId, ownerProjectId: options?.ownerProjectId })
      setTimeout(() => s.onData(`hello ${persistKey}\r\n`), 20)
      return id
    },
    async captureSnapshot(persistKey) {
      return persistKey === 'term-big-1' ? bigSnapshot : `screen of ${persistKey}`
    },
    async sessionExists(persistKey) {
      // `term-slow-*`: the host is still deciding when the phone gives up on the attach (A40). The
      // request has arrived (and the host has reserved the stream) once `probe` is emitted.
      if (persistKey.startsWith('term-slow-')) {
        emit({ event: 'probe', persistKey })
        await new Promise((r) => setTimeout(r, 300))
      }
      return !persistKey.startsWith('term-new-')
    },
    write(clientId, sessionId, data) {
      emit({ event: 'write', sessionId, data })
      if (data === 'exit\r') sinks?.onExit(7)
      else sinks?.onData(`echo:${data}`)
    },
    resize(clientId, sessionId, cols, rows) {
      emit({ event: 'resize', sessionId, cols, rows })
      if (cols === 100) sinks?.onSize?.({ cols: 132, rows: 43 })
    },
    setFlow() {},
    kill(clientId, sessionId) {
      emit({ event: 'kill', sessionId })
    }
  }

  const store = await seedDesktopState()
  // The folder the WorkspaceStore just wrote the project file into (`project.cwd` in projects.list).
  const [projectDir] = store.localProjectCwds()
  if (!projectDir) throw new Error('the seeded workspace has no local project folder')
  seedGitRepo(projectDir)

  let session: HostSession | null = null
  const approveNow = (): void => {
    if (session && !session.isApproved()) {
      session.approve()
      emit({ event: 'approved' })
    }
  }
  session = connectHostSession({
    url: `ws://127.0.0.1:${port}`,
    token: 'host-room',
    ourKeys: keys,
    pty,
    getLatestCanvas: () => null,
    subscribeCanvas: () => () => {},
    applyMutation: () => {},
    // The desktop's own assembly (listProjectsOutput in src/main/index.ts calls the same function):
    // the store's read-only load, the mirror file, and the session names, between the markers.
    listProjects: () =>
      buildProjectsListBlob({ workspace: store, userDataDir: platform().userDataDir, listSessions: async () => ['nt-term-abc-1'] }),
    // A viewer on a node is an Eco shield and a size ceiling on the desktop (A18): the phone must
    // never leave one behind.
    remoteViewer: {
      attached: (nodeId) => emit({ event: 'viewer-attached', nodeId }),
      detached: (nodeId) => emit({ event: 'viewer-detached', nodeId })
    },
    // A29: the git bridge both phone hosts serve (`hostBridge.git` in src/main/index.ts is this same
    // class), jailed like production's: the canvas cwds (none here) plus every local project folder,
    // read from the store exactly as `workspaceRoots` reads it. `FIXTURE_NO_GIT=1` stands for a
    // desktop that serves no git bridge.
    ...(process.env.FIXTURE_NO_GIT === '1' ? {} : { git: new GitService() }),
    extraRoots: () => store.localProjectCwds(),
    registerNode: async (projectId, node) => {
      emit({ event: 'registerNode', projectId, node })
      return true
    },
    destroyNode: async (nodeId) => {
      emit({ event: 'destroyNode', nodeId })
    },
    nodeActions: {
      wake: (nodeId) => (emit({ event: 'wake', nodeId }), true),
      refresh: (nodeId) => (emit({ event: 'refresh', nodeId }), true),
      rename: (nodeId, title) => (emit({ event: 'rename', nodeId, title }), true),
      // A12. `FIXTURE_NO_SENDKEYS=1` stands for a desktop that predates the verb; a node id
      // containing `gone` stands for a session the background write could not reach.
      ...(process.env.FIXTURE_NO_SENDKEYS === '1'
        ? {}
        : { sendKeys: async (nodeId: string, keys: string) => (emit({ event: 'sendKeys', nodeId, keys }), !nodeId.includes('gone')) })
    },
    kanban: {
      ensureBoard: async (projectId) => (emit({ event: 'ensureBoard', projectId }), [{ id: 'c1', title: 'To Do', color: '#0a84ff' }]),
      setCardColumn: async (projectId, nodeId, columnId) => (emit({ event: 'setCardColumn', projectId, nodeId, columnId }), true),
      editCardLabels: async (projectId, nodeId, edit) => (
        emit({ event: 'editCardLabels', projectId, nodeId, edit }),
        { edited: true, labels: [{ id: 'l1', name: 'bug', color: 'red' as const }], cardLabelIds: ['l1'] }
      )
    },
    inbox: {
      // A pendingId ending in `-expired` stands for a hold that already ended (the real writer finds
      // no request file and answers `gone`, audit A06).
      answerPermission: async (nodeId, pendingId, decision) => (
        emit({ event: 'answer', nodeId, pendingId, decision }), pendingId.endsWith('-expired') ? 'gone' : 'sent'
      ),
      ackRead: (nodeId) => emit({ event: 'ack', nodeId })
    },
    // A33/A72: the desktop's REAL resolver decides what a phone-started session is created with —
    // folder, account, agent and pane owner — over a fake index (local folder project p1) and one
    // logged-in managed Claude account. Kept apart from the store behind `projects.list` on purpose:
    // the fixed `/repo` lets RelayInteropTest assert the folder without knowing the scratch dir.
    newSessions: createHostNewSessions({
      projectTargetInfo: (projectId) => (projectId === 'p1' ? { cwd: '/repo' } : null),
      claudeAccounts: () => [{ id: 'acct-1' }]
    }),
    onPeerReady: (s) => {
      emit({ event: 'peer-ready', sas: s.sas(), pub: s.peerPublicKeyB64() })
      if (approveAfter >= 0) setTimeout(approveNow, approveAfter)
      if (rejectAfter >= 0) setTimeout(() => (emit({ event: 'rejected' }), session?.close()), rejectAfter)
    },
    onClose: () => emit({ event: 'host-close' })
  })

  emit({ ready: true, relayUrl: `ws://127.0.0.1:${port}`, clientToken: 'client-room', hostPublicKeyB64: publicKeyToB64(keys.publicKey) })
}

// ---- mode "pair" -----------------------------------------------------------------------------------

async function runPair(): Promise<void> {
  // Test seam: the OS as the fixture and the pairing service see it. Both read `process.platform` at
  // call time; node's own modules captured the real one at startup and are unaffected. Lets a Linux
  // run check what a Windows run of this mode does (PairingInteropTest, audit A70).
  const asPlatform = process.env.FIXTURE_PROCESS_PLATFORM
  if (asPlatform) Object.defineProperty(process, 'platform', { value: asPlatform })
  // The service writes `.nodeterm/agent.json` (a device entry carrying a live bearer token) and
  // `.ssh/authorized_keys` under `os.homedir()`, which reads HOME on POSIX and USERPROFILE on Windows.
  // Refuse to start unless the caller named that dir as its scratch home, so a caller that set the
  // wrong variable fails here instead of pairing a test device into a real profile (audit A70).
  const scratch = process.env.FIXTURE_HOME
  if (!scratch || path.resolve(os.homedir()) !== path.resolve(scratch)) {
    throw new Error(`pair mode needs os.homedir() to be FIXTURE_HOME; it is ${os.homedir()}, FIXTURE_HOME is ${scratch ?? 'unset'}`)
  }
  const keys = genKeyPair()
  const api = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      emit({ event: 'api', path: req.url, body: JSON.parse(body || '{}') })
      if (req.url === '/v1/relay/device') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ deviceToken: 'device-token-xyz', hostId: 'minted-host-id', exp: 123 }))
      } else {
        res.writeHead(404).end()
      }
    })
  })
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  const apiPort = (api.address() as { port: number }).port
  const withRelay = process.env.FIXTURE_RELAY === '1'
  const service = createPairingService(
    {
      getSettings: () => ({ ...DEFAULT_SETTINGS, phoneAccessEnabled: withRelay }),
      getEntitlement: () => null,
      loadHostKeyPair: async () => keys,
      relayEndpoint: 'wss://relay.example.test',
      apiBase: `http://127.0.0.1:${apiPort}`,
      relayAllowed: () => withRelay,
      pinRelayKey: async (pub) => emit({ event: 'pin', pub }),
      unpinRelayKey: async (pub) => emit({ event: 'unpin', pub })
    },
    // The direct-SSH path on every OS (audit A70): on win32 the service pairs relay-only (no key, the
    // QR says `ssh:false`), which pairing-service.windows.test.ts covers. `platform` only separates
    // win32 from the rest, so Linux and macOS run exactly what they always did.
    { timeoutMs: 60_000, platform: process.platform === 'win32' ? 'linux' : process.platform }
  )
  const started = await service.start((done) => emit({ event: 'done', ...done }))
  emit({ ready: true, payload: started.payload, hostPublicKeyB64: publicKeyToB64(keys.publicKey), relayPlan: started.relayPlan })
}

const mode = process.argv[2]
if (mode === 'never-ready') {
  setInterval(() => {}, 60_000)
} else {
  ;(mode === 'pair' ? runPair() : runRelay()).catch((err) => {
    emit({ event: 'fatal', message: String((err as Error)?.stack ?? err) })
    process.exit(1)
  })
}
