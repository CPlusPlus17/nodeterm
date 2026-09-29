import { describe, it, expect, beforeEach } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import {
  createSession,
  setActiveSession,
  bindProjectToSession,
  sessionForProject,
  resetSessionsForTest,
} from '../session/session'
import { canvasSyncTarget, followGoverned, shouldPublish } from './collab-sync'

const localApi = { marker: 'local' } as unknown as NodeTerminalApi
const relayApi = { marker: 'relay' } as unknown as NodeTerminalApi

describe('canvasSyncTarget (Task 4 — publisher/onMutation follow the ACTIVE session)', () => {
  beforeEach(() => resetSessionsForTest())

  it('relay tab: the mutate/subscribe target is the RELAY api, and the gate arms when the relay presence has a peer', () => {
    const local = createSession('local', localApi, 'This Mac')
    setActiveSession(local.id)
    const relay = createSession('relay', relayApi, "Ayşe's Mac")
    bindProjectToSession('remote-tab', relay.id)

    // The active tab is the relay one → publisher/onMutation must hit the RELAY core, not local.
    const active = sessionForProject('remote-tab')

    // A teammate is attached on the relay presence (peers includes me + Ayşe) → publish.
    const withPeer = canvasSyncTarget(active, { peers: { me: {}, ayse: {} } })
    expect(withPeer.api).toBe(relayApi)
    expect(withPeer.api).not.toBe(localApi)
    expect(withPeer.hasPeers).toBe(true)

    // Solo on the relay (only my own row) → no publish, but the target api is unchanged.
    const solo = canvasSyncTarget(active, { peers: { me: {} } })
    expect(solo.api).toBe(relayApi)
    expect(solo.hasPeers).toBe(false)
  })

  it('local tab: the target is window.nodeTerminal (the local api) — byte-identical to today', () => {
    const local = createSession('local', localApi, 'This Mac')
    setActiveSession(local.id)
    createSession('relay', relayApi, "Ayşe's Mac") // registered but not the active tab's binding

    const active = sessionForProject('some-local-tab') // unbound → resolves local
    expect(canvasSyncTarget(active, { peers: { me: {} } }).api).toBe(localApi)
    expect(canvasSyncTarget(active, { peers: { me: {}, other: {} } }).hasPeers).toBe(true)
  })

  it('empty peer table → no peers (nothing published on a fresh, still-connecting session)', () => {
    const local = createSession('local', localApi, 'This Mac')
    setActiveSession(local.id)
    expect(canvasSyncTarget(local, { peers: {} }).hasPeers).toBe(false)
  })
})

describe('shouldPublish (the solo gate, and the canvas authority that overrides it)', () => {
  it('a governed project publishes even when nobody else is attached; neither = nothing is cast', () => {
    expect(shouldPublish({ hasPeers: false, governed: true })).toBe(true)
    expect(shouldPublish({ hasPeers: true, governed: false })).toBe(true)
    expect(shouldPublish({ hasPeers: true, governed: true })).toBe(true)
    expect(shouldPublish({ hasPeers: false, governed: false })).toBe(false)
  })

  it('canvasSyncTarget carries the governed input into its verdict', () => {
    const local = createSession('local', localApi, 'This Mac')
    setActiveSession(local.id)
    expect(canvasSyncTarget(local, { peers: { me: {} } }, true).shouldPublish).toBe(true)
    expect(canvasSyncTarget(local, { peers: { me: {} } }, false).shouldPublish).toBe(false)
    expect(canvasSyncTarget(local, { peers: { me: {} } }).shouldPublish).toBe(false)
    expect(canvasSyncTarget(local, { peers: { me: {}, other: {} } }).shouldPublish).toBe(true)
  })
})

describe('followGoverned (the governed set Canvas gates on, per core)', () => {
  const authority = () => {
    let answer!: (ids: string[]) => void
    let listener: ((ids: string[]) => void) | null = null
    return {
      api: {
        canvasAuthority: {
          governed: () => new Promise<string[]>((r) => (answer = r)),
          onChanged: (l: (ids: string[]) => void) => {
            listener = l
            return () => (listener = null)
          }
        }
      } as unknown as Pick<NodeTerminalApi, 'canvasAuthority'>,
      answer: (ids: string[]) => answer(ids),
      change: (ids: string[]) => listener?.(ids),
      subscribed: () => listener !== null
    }
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('takes the core\'s answer, then every change', async () => {
    const a = authority()
    const seen: string[][] = []
    followGoverned(a.api, (ids) => seen.push([...ids]))
    a.answer(['p1'])
    await flush()
    a.change(['p1', 'p2'])
    expect(seen).toEqual([['p1'], ['p1', 'p2']])
  })

  it('a change that lands before the first answer wins over that (older) answer', async () => {
    const a = authority()
    const seen: string[][] = []
    followGoverned(a.api, (ids) => seen.push([...ids]))
    a.change(['p2'])
    a.answer(['p1'])
    await flush()
    expect(seen).toEqual([['p2']])
  })

  it('after release nothing more is applied, and the subscription is gone', async () => {
    const a = authority()
    const seen: string[][] = []
    const off = followGoverned(a.api, (ids) => seen.push([...ids]))
    off()
    a.answer(['p1'])
    await flush()
    expect(seen).toEqual([])
    expect(a.subscribed()).toBe(false)
  })

  it('a failed answer changes nothing (the solo gate stays as it was)', async () => {
    const seen: string[][] = []
    followGoverned(
      { canvasAuthority: { governed: () => Promise.reject(new Error('x')), onChanged: () => () => {} } } as unknown as Pick<NodeTerminalApi, 'canvasAuthority'>,
      (ids) => seen.push([...ids])
    )
    await flush()
    expect(seen).toEqual([])
  })
})
