// @vitest-environment jsdom
// Exercise the mounted view and its real LocalTransport/coordinator. Only terminal rendering
// and peripheral panels are fakes; PTY requests, subscriptions and viewer identities are observed.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeTerminalApi, PtyCreateOptions, PtyCreateResult, Project } from '@shared/types'
import { sshAttachmentId } from '@shared/ssh'
import { ModalTerminal, type ModalSpawn } from './ModalTerminal'
import { GlobalKanbanView } from './GlobalKanbanView'
import { useProjects } from '../../state/projects'
import { useSshConn } from '../../state/sshConn'
import { useSettings } from '../../state/settings'
import { useViewMode } from '../../state/viewMode'
import { resetHostAttachmentDials } from '../../lib/sshAttachments'
import { SshReconnector, RECONNECT_DELAYS_MS } from '../../lib/sshReconnect'
import { setSshDropHandler } from '../../nodes/TerminalNode'
import { resetDialogStack } from '../dialog-stack'

const boundary = vi.hoisted(() => {
  const terminals: FakeTerminal[] = []
  class FakeTerminal {
    cols = 80
    rows = 24
    options = {}
    unicode = { activeVersion: '6' }
    buffer = { active: { length: 0, getLine: () => undefined } }
    parser = { registerOscHandler: vi.fn() }
    write = vi.fn()
    resize = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    input: ((data: string) => void) | undefined
    constructor() { terminals.push(this) }
    open(): void {}
    loadAddon(): void {}
    registerLinkProvider(): void {}
    attachCustomKeyEventHandler(): void {}
    hasSelection(): boolean { return false }
    getSelection(): string { return '' }
    onData(listener: (data: string) => void): void { this.input = listener }
  }
  return { api: null as unknown, terminals, Terminal: FakeTerminal }
})
vi.mock('@xterm/xterm', () => ({ Terminal: boundary.Terminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {
  onDidChangeResults(): () => void { return () => {} }
  findNext(): void {}
  findPrevious(): void {}
  clearDecorations(): void {}
} }))
vi.mock('../../session/session', () => ({ useSession: () => ({ api: boundary.api, source: 'local' }) }))
vi.mock('../../terminal/useContextEnsure', () => ({ useContextEnsure: () => {} }))
vi.mock('../../terminal/useXtermVisualSettings', () => ({
  useXtermVisualSettings: () => ({ terminalTheme: 'nord', fontFamily: 'monospace', fontSize: 14 })
}))
vi.mock('../../lib/useTerminalGlass', () => ({ useTerminalGlass: () => ({ glass: false, vars: null }) }))
vi.mock('../../terminal/useCopyFeedback', () => ({ useCopyFeedback: () => ({ notifyCopy: () => {} }) }))
vi.mock('./BoardLogPanel', () => ({ BoardLogPanel: () => null }))
vi.mock('./CardMetaBar', async (importOriginal) => ({
  ...await importOriginal<typeof import('./CardMetaBar')>(), CardMetaBar: () => null
}))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))

const conn = { host: 'qa-host', user: 'tester', port: 29451 }
const nodeId = 'term-qa-1'
const spawn: ModalSpawn = { shell: '/bin/bash', cwd: '/qa', ssh: conn, sshRemoteTmux: true }
let root: Root
let host: HTMLDivElement
let rec: SshReconnector
let drop: ReturnType<typeof vi.fn<(scope: string, node: string) => void>>
let create: ReturnType<typeof vi.fn<(options: PtyCreateOptions) => Promise<PtyCreateResult>>>
let kill: ReturnType<typeof vi.fn>
let write: ReturnType<typeof vi.fn>
let connect: ReturnType<typeof vi.fn>
let exits: Map<string, (code: number) => void>
let outputs: Map<string, (data: string) => void>
const result = (id: string): PtyCreateResult => ({ sessionId: id, fresh: false, screen: 'warm\n' })
const project = (id: string, nodes: Project['nodes'] = [], remote = false): Project => ({
  id, name: id, color: '#fff', nodes, viewport: { x: 0, y: 0, zoom: 1 },
  ...(remote ? { ssh: { server: conn, remoteCwd: '/qa' } } : {})
})
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function mount(props: { ownerProjectId?: string; spawn?: ModalSpawn } = {}): Promise<void> {
  await act(async () => root.render(<ModalTerminal nodeId={nodeId} ownerProjectId={props.ownerProjectId ?? 'owner'}
    spawn={props.spawn ?? spawn} searchOpen={false} onCloseSearch={() => {}} />))
  await settle()
}
async function reconnect(scope: string): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]) })
  await settle()
  expect(drop).toHaveBeenCalledWith(scope, nodeId)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  resetDialogStack()
  resetHostAttachmentDials()
  boundary.terminals.length = 0
  exits = new Map()
  outputs = new Map()
  kill = vi.fn()
  write = vi.fn()
  create = vi.fn(async () => result(`session-${create.mock.calls.length}`))
  connect = vi.fn(async () => ({ controlPath: '/private/cm' }))
  boundary.api = {
    pty: {
      create, kill, write, resize: vi.fn(), readScrollback: vi.fn(async () => ''), capture: vi.fn(async () => ''),
      remoteSessionConfirmed: vi.fn(async () => true),
      onData: (id: string, cb: (data: string) => void) => { outputs.set(id, cb); return () => { outputs.delete(id) } },
      onExit: (id: string, cb: (code: number) => void) => { exits.set(id, cb); return () => { exits.delete(id) } },
      onSize: () => () => {}
    },
    sshProject: { connect, disconnect: vi.fn(async () => {}) },
    shell: { openExternal: vi.fn() }, clipboard: { writeText: vi.fn() },
    settings: { save: vi.fn(async () => {}) }, boardLog: { list: async () => [], onChanged: () => () => {} }
  } as unknown as NodeTerminalApi
  window.nodeTerminal = boundary.api as NodeTerminalApi
  useProjects.setState({ projects: [project('owner', [], true), project('active')], activeProjectId: 'active' })
  useSshConn.setState({ byProject: { owner: { controlPath: '/private/cm' } }, earlyByProject: {}, attachments: {} })
  useViewMode.setState({ requestedCardNodeId: null, globalKanban: false })
  rec = new SshReconnector({ connect: async () => true, respawn: vi.fn() })
  drop = vi.fn((scope: string, node: string) => rec.reportDrop(scope, node))
  setSshDropHandler(drop)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  rec.dispose()
  setSshDropHandler(null)
  resetHostAttachmentDials()
  resetDialogStack()
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ModalTerminal SSH reconnect', () => {
  it('keeps the card view mounted while replacing only its lost viewer and using the new session', async () => {
    await mount({ spawn: { ...spawn, initialCommand: 'claude --resume held-intent' } })
    const first = create.mock.calls[0][0]
    const retiredExit = exits.get('session-1')!
    act(() => retiredExit(255))
    await reconnect('owner')
    expect(create).toHaveBeenCalledTimes(2)
    const second = create.mock.calls[1][0]
    expect(second.persistKey).toBe(nodeId)
    expect(second.requireRemote).toBe(true)
    expect(second.ownerProjectId).toBe('owner')
    expect(second.sshRemote?.controlPath).toBe('/private/cm')
    expect(second.viewerId).not.toBe(first.viewerId)
    expect(kill.mock.calls).toEqual([['session-1', first.viewerId]])
    expect(exits.has('session-1')).toBe(false)
    expect(outputs.has('session-1')).toBe(false)
    act(() => outputs.get('session-2')!('after-reconnect'))
    expect(boundary.terminals[1].write).toHaveBeenCalledWith('after-reconnect')
    boundary.terminals[1].input!('user-input\r')
    expect(write.mock.calls).toEqual([['session-2', 'user-input\r']])
    expect(second).not.toHaveProperty('initialCommand')
    act(() => retiredExit(255))
    expect(drop).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    expect(kill.mock.calls).toEqual([['session-1', first.viewerId], ['session-2', second.viewerId]])
  })

  it('ignores healthy, different-scope and different-node reconnects', async () => {
    await mount()
    rec.reportDrop('owner', nodeId)
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]) })
    expect(create).toHaveBeenCalledTimes(1)
    act(() => exits.get('session-1')!(255))
    rec.reportDrop('foreign', nodeId)
    rec.reportDrop('owner', 'other-node')
    act(() => { rec.onConnected('foreign'); rec.onConnected('owner') })
    // n1 was refused by the existing hot-loop guard; only the unrelated nodes were flushed.
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['local', { shell: '/bin/bash' }],
    ['ordinary ssh program', { shell: 'ssh', ssh: conn }]
  ])('does not turn %s exit255 into a ControlMaster reconnect', async (_name, localSpawn) => {
    await mount({ spawn: localSpawn })
    act(() => exits.get('session-1')!(255))
    expect(drop).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect a remote process that exits normally', async () => {
    await mount()
    act(() => exits.get('session-1')!(0))
    expect(drop).not.toHaveBeenCalled()
  })

  it('reattaches after a remote create refusal when the coordinator succeeds', async () => {
    create.mockResolvedValueOnce({ sessionId: '', fresh: false, unavailable: 'ssh' })
    await mount()
    await reconnect('owner')
    expect(create).toHaveBeenCalledTimes(2)
    expect(kill).not.toHaveBeenCalled()
  })

  it.each(['success', 'refusal'] as const)('retires an in-flight %s without reviving a closed card', async (kind) => {
    let finish!: (res: PtyCreateResult) => void
    create.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await mount()
    const viewer = create.mock.calls[0][0].viewerId
    await act(async () => root.unmount())
    finish(kind === 'success' ? result('late-session') : { sessionId: '', fresh: false, unavailable: 'ssh' })
    await settle()
    expect(drop).not.toHaveBeenCalled()
    expect(kill.mock.calls).toEqual(kind === 'success' ? [['late-session', viewer]] : [])
    expect(boundary.terminals[0].write).not.toHaveBeenCalled()
    rec.reportDrop('owner', nodeId)
    act(() => rec.onConnected('owner'))
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('routes an inactive global-board card through its own host attachment and keeps its modal open', async () => {
    useProjects.setState({
      projects: [project('owner', [{
        id: nodeId, kind: 'terminal', position: { x: 0, y: 0 },
        size: { width: 640, height: 480 }, color: '#fff', group: null,
        shell: '/bin/bash', cwd: '/qa', ssh: conn, sshRemoteTmux: true, title: 'QA terminal'
      }]), project('active')],
      activeProjectId: 'active'
    })
    useSshConn.setState({ byProject: {} })
    useSettings.setState((s) => ({ settings: { ...s.settings, omniKanbanEnabled: true } }))
    await act(async () => root.render(<GlobalKanbanView />))
    const card = document.querySelector<HTMLElement>('[title="Open card"]')!
    expect(card).toBeTruthy()
    act(() => card.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    const scope = sshAttachmentId('owner', conn)
    expect(connect).toHaveBeenCalledWith(scope, conn, '/qa')
    expect(useSshConn.getState().getAttachment(scope)?.ownerProjectId).toBe('owner')
    expect(create.mock.calls[0][0].ownerProjectId).toBe('owner')
    expect(create.mock.calls[0][0].sshRemote?.controlPath).toBe('/private/cm')
    const modal = document.querySelector('.kanban-modal')
    expect(modal).toBeTruthy()
    act(() => exits.get('session-1')!(255))
    await reconnect(scope)
    expect(document.querySelector('.kanban-modal')).toBe(modal)
    expect(create).toHaveBeenCalledTimes(2)
    expect(useProjects.getState().activeProjectId).toBe('active')
  })
})
