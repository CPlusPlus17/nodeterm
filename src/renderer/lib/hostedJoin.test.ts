import { describe, it, expect, vi } from 'vitest'
import type { RelayClosedReason } from '@shared/types'
import { JOIN_CODE_PREFIX } from '@shared/relay-join-code'
import { createHostedJoiner, type HostedJoinerDeps, type HostedMountOutcome, type HostedNotice } from './hostedJoin'
import type { HostedAttemptRequest } from './hostedAttempts'
import { RelayApprovalError } from './hostedTeam'

const wrap = (m: string) => new Error(`Error invoking remote method 'relay:client:connect': Error: ${m}`)
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}
const codeFor = (hostId: string, label = 'box') => JOIN_CODE_PREFIX + Buffer.from(JSON.stringify({ v: 1, hostId, label })).toString('base64url')

type Bookmark = { hostId: string; label: string; approved: boolean; code: string }

function harness(bookmarks: Bookmark[] = []) {
  const connects: Array<{ code: string; resolve: (id: string) => void; reject: (e: Error) => void }> = []
  const mounts: Array<{ id: string; req: HostedAttemptRequest; resolve: (o: HostedMountOutcome) => void }> = []
  const closeCbs = new Map<string, (reason?: RelayClosedReason) => void>()
  const notices: HostedNotice[] = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const open = new Set<string>()
  let list = [...bookmarks]
  const deps: HostedJoinerDeps = {
    connect: (code) => new Promise((resolve, reject) => connects.push({ code, resolve, reject })),
    onClosed: (id, cb) => {
      closeCbs.set(id, cb)
      return () => closeCbs.delete(id)
    },
    disconnect: vi.fn(),
    bookmarks: vi.fn(async () => list),
    removeBookmark: vi.fn(async (hostId: string) => {
      list = list.filter((b) => b.hostId !== hostId)
    }),
    mount: (id, req) => new Promise((resolve) => mounts.push({ id, req, resolve })),
    tabOpen: (projectId) => open.has(projectId),
    notify: (n) => notices.push(n),
    promptForCode: vi.fn(async () => null as string | null),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      ;(t as { cleared: boolean }).cleared = true
    }
  }
  return { deps, connects, mounts, closeCbs, notices, timers, open, setList: (l: Bookmark[]) => { list = l } }
}

/** Connect + mount one attempt to a live tab. */
async function goLive(h: ReturnType<typeof harness>, i: number, projectId: string) {
  h.connects[i].resolve(`c${i}`)
  await flush()
  h.open.add(projectId)
  h.mounts[h.mounts.length - 1].resolve({ projectId })
  await flush()
}

describe('hosted joiner', () => {
  it('boot reconnects only APPROVED bookmarks, each as an unattended, retrying, background attempt', async () => {
    const h = harness([
      { hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') },
      { hostId: 'H2', label: 'lab', approved: false, code: codeFor('H2') }
    ])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    expect(h.connects.map((c) => c.code)).toEqual([codeFor('H1')])
    await goLive(h, 0, 'proj-1')
    expect(h.mounts[0].req).toMatchObject({ hostId: 'H1', label: 'box', manual: false, retry: true })
  })

  it('a pasted code runs NOW, does not loop, and a second paste for the same team is refused politely', async () => {
    const h = harness()
    const j = createHostedJoiner(h.deps)
    j.joinWithCode(`  ${codeFor('H1', 'box')} `)
    expect(h.connects).toHaveLength(1)
    j.joinWithCode(codeFor('H1', 'box'))
    expect(h.connects).toHaveLength(1)
    expect(h.notices.at(-1)).toMatchObject({ kind: 'info', text: 'Already connecting to box…' })
    await goLive(h, 0, 'proj-1')
    expect(h.mounts[0].req).toMatchObject({ manual: true, retry: false })
    j.joinWithCode(codeFor('H1', 'box'))
    expect(h.notices.at(-1)).toMatchObject({ kind: 'info', text: "You're already connected to box." })
    expect(h.connects).toHaveLength(1)
  })

  it('a code pasted into a greyed tab\'s prompt reconnects THAT tab (never a second one)', async () => {
    const h = harness()
    const j = createHostedJoiner(h.deps)
    j.joinWithCode(codeFor('H1'), 'proj-7')
    h.connects[0].resolve('c0')
    await flush()
    expect(h.mounts[0].req).toMatchObject({ hostId: 'H1', reconnectProjectId: 'proj-7', manual: true, retry: false })
  })

  it('a pasted code the renderer cannot read is still handed to main, which answers for it', async () => {
    const h = harness()
    const j = createHostedJoiner(h.deps)
    j.joinWithCode(`${JOIN_CODE_PREFIX}%%%`)
    h.connects[0].reject(wrap('[E_JOIN_BAD_CODE] That team code is invalid.'))
    await flush()
    expect(h.notices.at(-1)).toMatchObject({ kind: 'error', text: 'The invite code for the team is not valid. Ask an owner for a fresh code.' })
  })

  it('a dropped tab reconnects in place, in the background, while its team is still bookmarked and approved', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.closeCbs.get('c0')!(undefined)
    await flush()
    expect(h.connects).toHaveLength(2)
    await goLive(h, 1, 'proj-1')
    expect(h.mounts[1].req).toMatchObject({ reconnectProjectId: 'proj-1', manual: false, retry: true })
    expect(h.notices).toEqual([])
  })

  it('a drop does NOT reconnect a tab the user closed, a team they forgot, or one no longer approved', async () => {
    for (const setup of ['closed', 'forgotten', 'unapproved'] as const) {
      const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
      const j = createHostedJoiner(h.deps)
      await j.bootReconnect()
      await goLive(h, 0, 'proj-1')
      if (setup === 'closed') h.open.delete('proj-1')
      if (setup === 'forgotten') h.setList([])
      if (setup === 'unapproved') h.setList([{ hostId: 'H1', label: 'box', approved: false, code: codeFor('H1') }])
      h.closeCbs.get('c0')!(undefined)
      await flush()
      expect(h.connects, setup).toHaveLength(1)
    }
  })

  it('a close the host explained is told once and never reconnects', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.closeCbs.get('c0')!('removed')
    await flush()
    expect(h.connects).toHaveLength(1)
    expect(h.notices).toEqual([{ kind: 'error', text: 'box: Your access to this team was removed by an owner.' }])
  })

  it('clicking a greyed hosted tab reconnects it in place now; a tab it never opened is not its business', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    expect(j.reconnectTab('proj-1')).toBe(false)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.setList([]) // forgotten: the automatic reconnect stays off…
    h.closeCbs.get('c0')!(undefined)
    await flush()
    expect(j.isHostedTab('proj-1')).toBe(true)
    expect(j.reconnectTab('proj-1')).toBe(true) // …but the user asked
    expect(h.connects).toHaveLength(2)
    h.connects[1].resolve('c1')
    await flush()
    expect(h.mounts[1].req).toMatchObject({ reconnectProjectId: 'proj-1', manual: true, retry: true })
  })

  it('REVOKED stops and offers "remove and rejoin": forget the bookmark, ask for a fresh code, join with it', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    ;(h.deps.promptForCode as ReturnType<typeof vi.fn>).mockResolvedValue(codeFor('H9', 'box'))
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    h.connects[0].reject(wrap("[E_JOIN_REVOKED] This device's relay access was revoked."))
    await flush()
    const n = h.notices.at(-1)!
    expect(n.kind).toBe('error')
    expect(n.text).toMatch(/revoked/)
    expect(n.action?.label).toBe('Remove and rejoin')
    n.action!.run()
    await flush()
    expect(h.deps.removeBookmark).toHaveBeenCalledWith('H1')
    expect(h.deps.promptForCode).toHaveBeenCalledWith('box')
    expect(h.connects.at(-1)!.code).toBe(codeFor('H9', 'box'))
  })

  it('a stop is told in one sentence; BUSY is never told', async () => {
    const h = harness()
    const j = createHostedJoiner(h.deps)
    j.joinWithCode(codeFor('H1'))
    h.connects[0].reject(wrap('[E_JOIN_BUSY] Already joining this team.'))
    await flush()
    expect(h.notices).toEqual([])
    j.joinWithCode(codeFor('H1'))
    h.connects[1].reject(wrap('[E_JOIN_REFUSED] The hosted-team bookmarks file /u/relay-bookmarks.json cannot be read or safely rewritten; fix or remove it, then join again.'))
    await flush()
    expect(h.notices).toEqual([
      { kind: 'error', text: 'Could not join box: The hosted-team bookmarks file /u/relay-bookmarks.json cannot be read or safely rewritten; fix or remove it, then join again.' }
    ])
  })

  it('a tab that never opened: an unattended attempt retries silently; a pasted code is told why', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    h.connects[0].resolve('c0')
    await flush()
    h.mounts[0].resolve({ error: new RelayApprovalError('The relay connection closed before it was approved.'), declined: false })
    await flush()
    expect(h.notices).toEqual([])
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(1)

    const p = harness()
    const jp = createHostedJoiner(p.deps)
    jp.joinWithCode(codeFor('H2', 'lab'))
    p.connects[0].resolve('c0')
    await flush()
    p.mounts[0].resolve({ error: new RelayApprovalError('An owner declined the request.', 'denied'), declined: false })
    await flush()
    expect(p.notices).toEqual([{ kind: 'error', text: 'Could not open lab: An owner declined the request.' }])
    // A SAS the user declined is their own answer: nothing to tell.
    jp.joinWithCode(codeFor('H2', 'lab'))
    p.connects[1].resolve('c1')
    await flush()
    p.mounts[1].resolve({ error: new Error('closed'), declined: true })
    await flush()
    expect(p.notices).toHaveLength(1)
  })

  it('forgetting a team stops its reconnect loop and removes the bookmark; it is refused while connecting', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await j.forget('H1', 'box')
    expect(h.deps.removeBookmark).not.toHaveBeenCalled()
    expect(h.notices.at(-1)).toMatchObject({ kind: 'info', text: 'Still connecting to box; forget it once that finishes.' })
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(1) // backing off
    await j.forget('H1', 'box')
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(0) // the loop is gone
    expect(h.deps.removeBookmark).toHaveBeenCalledWith('H1')
    expect(h.notices.at(-1)).toMatchObject({ kind: 'info', text: 'Forgot box. This device will not reconnect to it.' })
  })

  it('main\'s refusal to forget (a join still in flight there) is shown in its own words', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    ;(h.deps.removeBookmark as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Error invoking remote method 'relay:hosted:bookmark-remove': Error: Still joining this team; forget it once that attempt finishes.")
    )
    const j = createHostedJoiner(h.deps)
    await j.forget('H1', 'box')
    expect(h.notices.at(-1)).toEqual({ kind: 'error', text: 'Could not forget box: Still joining this team; forget it once that attempt finishes.' })
  })

  it('dispose stops every loop', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    j.dispose()
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(0)
  })
})
