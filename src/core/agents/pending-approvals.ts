// Deterministic hook-reply approvals — the answer-file side (docs/hook-reply-approvals.md).
//
// The managed permission hook (managed-script.ts) holds an incoming PermissionRequest open and
// polls `<home>/.nodeterm/pending/<pendingId>.answer` for a one-line `allow` | `deny`. This module
// writes that answer file (LOCAL fs — the host the agent runs on for a local project) and sweeps
// stale request files left by killed/timed-out sessions.
//
// Electron-free (fs/path/os only), so both shells boot it. Every function fails soft: an invalid
// pendingId or an fs error resolves false / logs, never throws.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeFileAtomic } from '../fs-atomic'
import { normalizeClaude, type NormalizedAgentEvent } from '../../shared/agents/normalize'

/** pendingId shape the script generates (`<node>-<ms>-<pid>`) and the ONLY thing we interpolate
 *  into a filename. Validated everywhere a pendingId becomes a path so a forged value can't
 *  traverse (`../`) or inject. Keep in sync with the managed script's `tr -c 'A-Za-z0-9_-'`. */
export const PENDING_ID_RE = /^[A-Za-z0-9_-]+$/

/** How old a request (`.json`) / answer (`.answer`) file may get before the sweeper removes it. */
export const PENDING_MAX_AGE_MS = 10 * 60_000
/** Sweep cadence (boot + this interval). */
export const PENDING_SWEEP_INTERVAL_MS = 60 * 60_000

export function isValidPendingId(pendingId: string): boolean {
  return typeof pendingId === 'string' && pendingId.length > 0 && pendingId.length <= 256 && PENDING_ID_RE.test(pendingId)
}

/** `<home>/.nodeterm/pending`. `homeDir` is injected so tests never touch the real home. */
export function pendingDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.nodeterm', 'pending')
}

/**
 * What writing an answer did. `gone` is the hook's hold having ENDED — it deletes
 * `<pendingId>.json` when it times out (managed-script.ts) or when another surface answered — so no
 * answer can reach it any more and the interactive prompt is (or was) on screen instead. `failed` is
 * a write that could not happen. The two are different facts for a caller: one says "go to the
 * session", the other "try again" (audit A06/A35).
 */
export type PendingAnswerResult = 'sent' | 'gone' | 'failed'

/**
 * Answer a held permission hook: check its request file still exists, then write the one-line answer
 * file atomically (tmp + rename, mode 0600). The `decision` is written verbatim as the hook script
 * compares it against the literals `allow` / `deny`. Never throws.
 *
 * The existence check is what stops a late answer (the phone's usual case: the hold is 45 s) from
 * being reported — and optimistically broadcast — as delivered. A hook that times out between the
 * check and the write leaves an orphan `.answer`, which the sweep removes; closing that window fully
 * would need the hook to announce its timeout.
 */
export async function answerPendingLocal(
  pendingId: string,
  decision: 'allow' | 'deny',
  homeDir: string = os.homedir()
): Promise<PendingAnswerResult> {
  if (!isValidPendingId(pendingId)) return 'failed'
  if (decision !== 'allow' && decision !== 'deny') return 'failed'
  const dir = pendingDir(homeDir)
  try {
    await fs.promises.access(path.join(dir, `${pendingId}.json`))
  } catch (e) {
    // Only a definite ENOENT is evidence the hold ended; anything else is a failed read.
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'gone' : 'failed'
  }
  const file = path.join(dir, `${pendingId}.answer`)
  try {
    // writeFileAtomic: unique tmp + retrying rename (core/fs-atomic.ts); removes its temp on failure.
    await writeFileAtomic(file, decision, { mode: 0o600 })
    return 'sent'
  } catch {
    return 'failed'
  }
}

/**
 * Boolean form of [answerPendingLocal] for callers that only report success: true ONLY when the
 * answer reached a hold that still exists.
 */
export async function writePendingAnswerLocal(
  pendingId: string,
  decision: 'allow' | 'deny',
  homeDir: string = os.homedir()
): Promise<boolean> {
  return (await answerPendingLocal(pendingId, decision, homeDir)) === 'sent'
}

/**
 * Build the synthetic "answered" agent event the managed hook's second POST would produce, so a
 * caller that just wrote the answer file (the desktop Approve/Deny handler) can OPTIMISTICALLY flip
 * the badge to working before that POST round-trips. Goes through the same `normalizeClaude` path the
 * hook server uses, so its shape is identical — the later hook POST is an idempotent duplicate
 * (a same-state working re-assert is a no-op in the mirror + renderer store). Threads the pendingId
 * so the open approval resolves. Claude-only (PermissionRequest is a Claude concept). Returns null on
 * an invalid decision. See docs/hook-reply-approvals.md.
 */
export function syntheticAnsweredEvent(
  nodeId: string,
  pendingId: string,
  decision: 'allow' | 'deny'
): NormalizedAgentEvent | null {
  if (decision !== 'allow' && decision !== 'deny') return null
  return normalizeClaude({
    nodeId,
    agentId: 'claude',
    payload: { nodeterm_answered: decision, nodeterm_pending_id: pendingId }
  })
}

/**
 * Remove `.json` / `.answer` files under the pending dir older than `maxAgeMs` (orphans from killed
 * or timed-out sessions). Returns the count removed. Best-effort — a missing dir or unreadable
 * entry is silently skipped. Pure w.r.t. its `now`/`homeDir` inputs for testing.
 */
export async function sweepPendingDir(
  now: number = Date.now(),
  maxAgeMs: number = PENDING_MAX_AGE_MS,
  homeDir: string = os.homedir()
): Promise<number> {
  const dir = pendingDir(homeDir)
  let removed = 0
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return 0 // no dir yet / unreadable
  }
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.answer')) continue
    const p = path.join(dir, name)
    try {
      const st = await fs.promises.stat(p)
      if (now - st.mtimeMs > maxAgeMs) {
        await fs.promises.rm(p, { force: true })
        removed++
      }
    } catch {
      // Raced deletion / stat error: skip.
    }
  }
  return removed
}

export interface PendingSweeperHandle {
  stop(): void
}

/**
 * Start the pending-dir sweeper: one sweep now, then every `intervalMs`. The interval is unref'd so
 * it never keeps the process alive. Wired once per shell on boot.
 */
export function startPendingSweep(
  homeDir: string = os.homedir(),
  intervalMs: number = PENDING_SWEEP_INTERVAL_MS
): PendingSweeperHandle {
  void sweepPendingDir(Date.now(), PENDING_MAX_AGE_MS, homeDir).catch(() => {})
  const timer = setInterval(() => {
    void sweepPendingDir(Date.now(), PENDING_MAX_AGE_MS, homeDir).catch(() => {})
  }, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
