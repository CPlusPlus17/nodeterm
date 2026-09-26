// Interop fixture for the Android protocol tests: runs the DESKTOP's real code on the other end of
// the wire, so the Kotlin client is checked against the implementation, not against a reading of it.
//
//   mode "relay": a tiny in-process relay broker (pairs a host and a client by room, forwards
//                 frames preserving text/binary — all the real relay does) plus the desktop's
//                 `connectHostSession` (src/main/remote/host-service.ts → relay-socket.ts host role)
//                 serving a FAKE pty/kanban/inbox bridge that records what the phone asked for.
//   mode "pair":  the desktop's real `createPairingService` (src/main/pairing-service.ts) with HOME
//                 pointed at a temp dir by the caller, and a fake `/v1/relay/device` API.
//
// Protocol with the Kotlin test: line 1 on stdout is a JSON "ready" object; every later line is a
// JSON event. Bundled by esbuild at test time (see InteropHarness.kt); `electron` and `ws` stay
// external and resolve from the repo's node_modules.
import http from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import { initPlatform } from '../../../../../src/core/platform'
import { genKeyPair, publicKeyToB64 } from '../../../../../src/main/remote/e2ee'
import {
  connectHostSession,
  type HostPtyManager,
  type HostSession
} from '../../../../../src/main/remote/host-service'
import { createPairingService } from '../../../../../src/main/pairing-service'
import type { DetachedSinks } from '../../../../../src/core/pty-manager'
import type { PtyManager } from '../../../../../src/core/pty-manager'

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

async function runRelay(): Promise<void> {
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
      emit({ event: 'attach', persistKey, cols: options?.cols, rows: options?.rows, adaptsToSize: s.adaptsToSize, cwd: options?.cwd, accountId: options?.accountId })
      setTimeout(() => s.onData(`hello ${persistKey}\r\n`), 20)
      return id
    },
    async captureSnapshot(persistKey) {
      return persistKey === 'term-big-1' ? bigSnapshot : `screen of ${persistKey}`
    },
    async sessionExists(persistKey) {
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

  const blob = [
    JSON.stringify({
      version: 2,
      activeProjectId: 'p1',
      projects: [
        {
          id: 'p1',
          name: 'Demo',
          color: '#0a84ff',
          cwd: '/work/demo',
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
    }),
    '--NT-PROJECTS-SPLIT--',
    'nt-term-abc-1',
    '--NT-STATUS-SPLIT--',
    JSON.stringify({
      v: 1,
      updatedAt: 1,
      nodes: { 'term-abc-1': { state: 'blocked', agentId: 'claude', sessionId: 's-1', name: 'fix bug', updatedAt: 2 } },
      inbox: {
        events: [{ id: 'e1', ts: 3, nodeId: 'term-abc-1', kind: 'approval', title: 'Approve Bash', pendingId: 'term-abc-1-1700000000000-42' }],
        nodes: { 'term-abc-1': { activity: 'Running npm test', updatedAt: 4 } }
      }
    })
  ].join('\n')

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
    pty: pty as unknown as PtyManager,
    getLatestCanvas: () => null,
    subscribeCanvas: () => () => {},
    applyMutation: () => {},
    listProjects: async () => blob,
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
    // A33: the host resolves where a phone-started session is created (fake registry: project p1).
    newSessions: {
      resolve: ({ projectId, accountId }) => (projectId === 'p1' ? { cwd: '/repo', ...(accountId ? { accountId } : {}) } : null)
    },
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
      getSettings: () => ({ phoneAccessEnabled: withRelay }) as never,
      getEntitlement: () => null,
      loadHostKeyPair: async () => keys,
      relayEndpoint: 'wss://relay.example.test',
      apiBase: `http://127.0.0.1:${apiPort}`,
      relayAllowed: () => withRelay,
      pinRelayKey: async (pub) => emit({ event: 'pin', pub }),
      unpinRelayKey: async (pub) => emit({ event: 'unpin', pub })
    },
    { timeoutMs: 60_000 }
  )
  const started = await service.start((done) => emit({ event: 'done', ...done }))
  emit({ ready: true, payload: started.payload, hostPublicKeyB64: publicKeyToB64(keys.publicKey), relayPlan: started.relayPlan })
}

const mode = process.argv[2]
;(mode === 'pair' ? runPair() : runRelay()).catch((err) => {
  emit({ event: 'fatal', message: String((err as Error)?.stack ?? err) })
  process.exit(1)
})
