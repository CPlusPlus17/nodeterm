// src/core/relay/hosted-scheduler.test.ts
import { describe, it, expect } from 'vitest'
import { createHostedScheduler, type MintResult, type SchedulerStatus } from './hosted-scheduler'

// Flush with macrotask turns, not a fixed count of microtasks: how many awaits an async mint takes
// is an implementation detail the tests must not pin.
const flush = async (turns = 5) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r))
}

type Opened = { bridged: boolean; closed: boolean; token: string; ev: { onBridged(): void; onClose(): void }; close(): void }

function harness(mints: Array<MintResult | (() => Promise<MintResult>)>, opts: {
  open?: (tok: string, ev: { onBridged(): void; onClose(): void }) => Opened
  onStatus?: (s: SchedulerStatus) => void
  firstTimerId?: number
} = {}) {
  let t = 0
  const timers: Array<{ at: number; fn: () => void; id: number; ms: number }> = []
  const delays: number[] = []
  let seq = (opts.firstTimerId ?? 1) - 1
  let mintCalls = 0
  const opened: Opened[] = []
  const s = createHostedScheduler({
    mint: async () => {
      mintCalls++
      const next = mints.shift()
      if (typeof next === 'function') return next()
      return next ?? { ok: false, kind: 'network' }
    },
    open: (tok, ev) => {
      if (opts.open) return opts.open(tok, ev)
      const l: Opened = { bridged: false, closed: false, token: tok, ev, close() { l.closed = true } }
      opened.push(l)
      return l
    },
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ at: t + ms, fn, id, ms }); delays.push(ms); return id },
    clearTimeout: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1) },
    onStatus: opts.onStatus
  }, () => t)
  const advance = async (ms: number) => {
    const target = t + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const due = timers[0]
      if (!due || due.at > target) break
      timers.shift()
      t = due.at
      due.fn()
      await flush()
    }
    t = target
  }
  return { s, opened, advance, timers, delays, mintCalls: () => mintCalls }
}
const ok = (ttlMs = 120_000): MintResult => ({ ok: true, pairingToken: 'T', hostId: 'H', ttlMs })

describe('hosted scheduler', () => {
  it('keeps one idle listener and replaces it before the token expires', async () => {
    const h = harness([ok(), ok()])
    h.s.start(); await flush()
    expect(h.opened).toHaveLength(1)
    await h.advance(90_000) // 120 s TTL − 30 s lead
    expect(h.opened[0].closed).toBe(true)
    expect(h.opened).toHaveLength(2)
  })
  it('a bridged listener is never cut for a refresh, and a new idle one is opened', async () => {
    const h = harness([ok(), ok()])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush()
    expect(h.opened).toHaveLength(2)
    await h.advance(90_000)
    expect(h.opened[0].closed).toBe(false)
  })
  it('a mint success does NOT reset the backoff when sockets keep dying (relay down, API up)', async () => {
    const h = harness([ok(), ok(), ok(), ok()])
    h.s.start(); await flush()
    h.opened[0].ev.onClose(); await flush()
    await h.advance(1000); h.opened[1].ev.onClose(); await flush()
    await h.advance(1999)
    expect(h.opened).toHaveLength(2) // second retry waits the full 2 s
    await h.advance(1); expect(h.opened).toHaveLength(3)
  })
  it('429 waits max(60 s, Retry-After); 402 stops with backend-refused', async () => {
    const h = harness([{ ok: false, kind: 'rate-limited', retryAfterMs: 90_000 }, ok()])
    h.s.start(); await flush()
    await h.advance(89_999); expect(h.opened).toHaveLength(0)
    await h.advance(1); await flush(); expect(h.opened).toHaveLength(1)
    const r = harness([{ ok: false, kind: 'refused', status: 402 }])
    r.s.start(); await flush()
    expect(r.s.status().state).toBe('backend-refused')
    expect(r.timers).toHaveLength(0)
  })
  it('counts mints in the last hour', async () => {
    const h = harness([ok(), ok()])
    h.s.start(); await flush()
    expect(h.s.status().mintsLastHour).toBe(1)
  })

  // --- beyond the brief: the rest of the ported rules and the failure modes that would wedge it ---

  it('a 429 without Retry-After still waits the 60 s floor', async () => {
    const h = harness([{ ok: false, kind: 'rate-limited', status: 429 }, ok()])
    h.s.start(); await flush()
    await h.advance(59_999); expect(h.opened).toHaveLength(0)
    await h.advance(1); expect(h.opened).toHaveLength(1)
  })

  it('a Retry-After beyond the timer range is clamped, never overflowing into a ~1 ms re-mint loop', async () => {
    // Node's setTimeout fires after 1 ms for any delay above 2^31-1: an unclamped 30-day wait is
    // a tight loop against the very API that asked us to back off.
    const h = harness([{ ok: false, kind: 'rate-limited', status: 429, retryAfterMs: 30 * 24 * 3_600_000 }])
    h.s.start(); await flush()
    expect(h.delays).toHaveLength(1)
    expect(h.delays[0]).toBeGreaterThanOrEqual(60_000)
    expect(h.delays[0]).toBeLessThanOrEqual(3_600_000)
  })

  it('a missing, NaN or absurd ttl never arms a refresh below 15 s or beyond the timer range', async () => {
    const h = harness([ok(Number.NaN), ok(-5_000), ok(1e15)])
    h.s.start(); await flush()
    expect(h.delays.at(-1)).toBe(90_000) // NaN → the default 120 s TTL − 30 s lead
    h.opened[0].ev.onBridged(); await flush()
    expect(h.delays.at(-1)).toBe(15_000) // already expired → the 15 s floor
    h.opened[1].ev.onBridged(); await flush()
    expect(h.delays.at(-1)).toBeLessThanOrEqual(3_600_000)
  })

  it('a bridged session ending does not advance the backoff (only a relay failure does)', async () => {
    const h = harness([ok(), ok(), ok()])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush()
    expect(h.opened).toHaveLength(2)
    h.opened[0].ev.onClose(); await flush() // the teammate left: not a relay failure
    expect(h.opened).toHaveLength(2) // the idle replacement already exists
    expect(h.timers.filter((x) => x.ms === 1000 || x.ms === 2000)).toHaveLength(0)
    h.opened[1].ev.onClose(); await flush() // the idle one dies on its own: the FIRST backoff step
    await h.advance(1000)
    expect(h.opened).toHaveLength(3)
  })

  it('a bridged session ending never mints over a pending backoff (a 429 wait stays a wait)', async () => {
    const h = harness([ok(), { ok: false, kind: 'rate-limited', status: 429, retryAfterMs: 60_000 }, ok()])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush() // the replacement mint is answered 429
    expect(h.mintCalls()).toBe(2)
    h.opened[0].ev.onClose(); await flush() // the teammate leaves while the 429 wait is armed
    await h.advance(59_999)
    expect(h.mintCalls()).toBe(2)
    await h.advance(1)
    expect(h.mintCalls()).toBe(3)
    expect(h.opened).toHaveLength(2)
  })

  it('never runs two mints at once', async () => {
    const h = harness([ok(), () => new Promise<MintResult>(() => {}) /* replacement mint hangs */])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush()
    expect(h.mintCalls()).toBe(2) // the replacement mint is in flight
    h.opened[0].ev.onBridged(); await flush()
    h.opened[0].ev.onClose(); await flush()
    expect(h.mintCalls()).toBe(2)
  })

  it('onBridged twice (pending, then approved) is one bridge: one replacement, no second proof', async () => {
    // The hosted service reports a peer on the pending handshake AND again on approval. The second
    // report is the same peer, not new evidence: it must not open a second replacement, nor wipe a
    // failure that happened in between (here the replacement mint was answered 503).
    const h = harness([ok(), { ok: false, kind: 'network', status: 503 }, ok()])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush()
    expect(h.s.status().lastError).toBe('network (503)')
    h.opened[0].ev.onBridged(); await flush()
    expect(h.s.status().lastError).toBe('network (503)')
    expect(h.mintCalls()).toBe(2)
    await h.advance(1000) // the backoff, not the second report, owns the next mint
    expect(h.opened).toHaveLength(2)
    expect(h.s.status()).toMatchObject({ idle: 1, bridged: 1 })
    expect(h.opened[0].bridged).toBe(true)
  })

  it('an intentional close (refresh / stop) never counts as a relay failure, even if it fires onClose', async () => {
    const h = harness([ok(), ok(), ok()], {
      open: (tok, ev) => {
        const l: Opened = { bridged: false, closed: false, token: tok, ev, close() { l.closed = true; ev.onClose() } }
        h.opened.push(l)
        return l
      }
    })
    h.s.start(); await flush()
    await h.advance(90_000) // refresh: close() fires onClose synchronously
    expect(h.opened).toHaveLength(2)
    expect(h.timers.map((x) => x.ms)).toEqual([90_000]) // only the new refresh, no backoff armed
  })

  it('a mint that THROWS backs off and retries instead of wedging the scheduler', async () => {
    const h = harness([() => Promise.reject(new Error('host key unreadable')), ok()])
    h.s.start(); await flush()
    expect(h.s.status()).toMatchObject({ state: 'running', idle: 0 })
    expect(h.s.status().lastError).toMatch(/mint/)
    await h.advance(1000)
    expect(h.opened).toHaveLength(1)
  })

  it('an open() that THROWS (bad relay URL) backs off and retries instead of wedging', async () => {
    let fail = true
    const h = harness([ok(), ok()], {
      open: (tok, ev) => {
        if (fail) { fail = false; throw new SyntaxError('Invalid URL') }
        const l: Opened = { bridged: false, closed: false, token: tok, ev, close() { l.closed = true } }
        h.opened.push(l)
        return l
      }
    })
    h.s.start(); await flush()
    expect(h.opened).toHaveLength(0)
    expect(h.s.status().lastError).toMatch(/open/)
    await h.advance(1000)
    expect(h.opened).toHaveLength(1)
  })

  it('an onStatus observer that throws never wedges the lifecycle', async () => {
    const h = harness([ok(), ok()], { onStatus: () => { throw new Error('observer bug') } })
    h.s.start(); await flush()
    expect(h.opened).toHaveLength(1)
    await h.advance(90_000)
    expect(h.opened).toHaveLength(2)
  })

  it('lastError reports a relay that drops idle listeners, and clears only on proof the relay works', async () => {
    const h = harness([ok(), ok(), ok()]) // the third is the replacement minted after the bridge
    h.s.start(); await flush()
    expect(h.s.status().lastError).toBeNull()
    h.opened[0].ev.onClose(); await flush()
    expect(h.s.status().lastError).toMatch(/relay/)
    await h.advance(1000) // a fresh mint succeeds — still not proof the relay leg works
    expect(h.opened).toHaveLength(2)
    expect(h.s.status().lastError).toMatch(/relay/)
    h.opened[1].ev.onBridged(); await flush() // a peer bridged: that IS proof
    expect(h.s.status().lastError).toBeNull()
  })

  it('stop() closes every listener, cancels timers, and a mint landing afterwards opens nothing', async () => {
    let release!: (r: MintResult) => void
    const h = harness([ok(), () => new Promise<MintResult>((r) => { release = r })])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush() // replacement mint now in flight
    h.s.stop()
    expect(h.opened[0].closed).toBe(true)
    expect(h.timers).toHaveLength(0)
    expect(h.s.status()).toMatchObject({ state: 'stopped', idle: 0, bridged: 0 })
    release(ok()); await flush()
    expect(h.opened).toHaveLength(1)
    expect(h.timers).toHaveLength(0)
  })

  it('stop() then start() while a mint is in flight still ends with one idle listener', async () => {
    let release!: (r: MintResult) => void
    const h = harness([() => new Promise<MintResult>((r) => { release = r })])
    h.s.start(); await flush()
    h.s.stop()
    h.s.start(); await flush()
    release(ok()); await flush()
    expect(h.opened).toHaveLength(1)
    expect(h.s.status()).toMatchObject({ state: 'running', idle: 1 })
  })

  it('a timer handle of 0 is still a timer (stop() clears it, and it still owns the next mint)', async () => {
    // Browsers number timers from 1, but an injected setTimeout may legitimately hand back 0.
    const h = harness([{ ok: false, kind: 'network', status: 503 }], { firstTimerId: 0 })
    h.s.start(); await flush()
    expect(h.timers.map((x) => x.id)).toEqual([0])
    h.s.stop()
    expect(h.timers).toHaveLength(0)
  })

  it('start() after backend-refused mints again', async () => {
    const h = harness([{ ok: false, kind: 'refused', status: 402 }, ok()])
    h.s.start(); await flush()
    expect(h.s.status().state).toBe('backend-refused')
    h.s.start(); await flush()
    expect(h.s.status()).toMatchObject({ state: 'running', idle: 1, lastError: expect.stringContaining('402') })
  })

  it('mintsLastHour forgets mints older than an hour', async () => {
    // An idle listener is re-minted every 90 s: mints land at 0, 90 s, …, 3600 s (41 of them).
    const h = harness(Array.from({ length: 60 }, () => ok()))
    h.s.start(); await flush()
    await h.advance(3_600_000)
    expect(h.s.status().mintsLastHour).toBe(41)
    await h.advance(1) // the mint at t=0 is now more than an hour old
    expect(h.s.status().mintsLastHour).toBe(40)
  })
})
