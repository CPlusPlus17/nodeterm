// Disk read/write for the standing (phone) host's pinned-device list. The pure pin/lookup logic
// lives in `approved-devices-core.ts`; this only touches the filesystem.
//
// Stored at <userData>/remote-approved-devices.json. The contents are PUBLIC keys (device box
// public keys the host has approved once), never credentials.

import { promises as fs } from 'fs'
import path from 'path'
import { app } from 'electron'
import { writeFileAtomic } from '../../core/fs-atomic'
import {
  emptyApprovedDevices,
  isPinned,
  parseApprovedDevices,
  pinDevice,
  type ApprovedDevices
} from './approved-devices-core'

function file(): string {
  return path.join(app.getPath('userData'), 'remote-approved-devices.json')
}

/** Load the pinned-device list; returns an empty list when the file is absent; other read/parse failures reject. */
export async function loadApprovedDevices(): Promise<ApprovedDevices> {
  try {
    return parseApprovedDevices(JSON.parse(await fs.readFile(file(), 'utf-8')))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return emptyApprovedDevices()
  }
}

/**
 * Persist the pinned-device list atomically (unique temp + retrying rename, 0600) via
 * `writeFileAtomic`.
 *
 * Production mutations use updateApprovedDevices to serialize read/modify/write. Unique temps
 * still protect atomic publication, including explicit snapshot saves and separate processes.
 * This is an in-process queue, not a cross-process trust-store lock.
 *
 * A failed write removes its own temp and rethrows, and the OLD file is left byte-for-byte
 * intact — revocation.ts's `persisted:false` contract depends on both halves.
 *
 * No orphan sweep here, unlike the PAT stores (src/main/github-control.ts, src/server/github-control.ts)
 * or agent.json (src/main/pairing-service.ts): those orphan temps hold live credentials, but these are
 * PUBLIC keys, so a stray temp is litter rather than a leak.
 */
export async function saveApprovedDevices(store: ApprovedDevices): Promise<void> {
  await writeFileAtomic(file(), JSON.stringify(store), { mode: 0o600 })
}

// Queue the WHOLE read/modify/write, not just rename: otherwise concurrent approvals lose pins,
// and an approval racing a revoke can resurrect the removed key from an obsolete snapshot.
// The update may be async (pinApprovedDeviceIf): the queue holds until it settles.
// An update that hands back the very store it was given changed nothing (pinDevice and unpinDevice
// do that for a key already pinned / not pinned), so nothing is written: the list on disk already
// says what it would say, and a write there would only add a failure that is not about this change.
let updateTail: Promise<void> = Promise.resolve()
export function updateApprovedDevices(
  update: (store: ApprovedDevices) => ApprovedDevices | Promise<ApprovedDevices>
): Promise<void> {
  const next = updateTail.then(async () => {
    const store = await loadApprovedDevices()
    const updated = await update(store)
    if (updated !== store) await saveApprovedDevices(updated)
  })
  updateTail = next.catch(() => {}) // one failed save must not poison later attempts
  return next
}

/**
 * Pin `pubkeyB64` only if `allowed()` still answers true, asked INSIDE the queue, and say whether it
 * is pinned afterwards (A07-late: the standing host pinning a paired phone's recorded relay key).
 *
 * The question is asked in the queue, not before it, because the answer can be withdrawn: revoking
 * a paired phone removes its agent.json entry and only THEN queues its unpin. Asked before queueing,
 * a "still paired" read could land just before that removal while its pin landed just after the
 * unpin, resurrecting the key the revoke had just removed. Asked inside, it runs either before the
 * unpin (which then removes the pin) or after the removal (which it then sees). Already pinned ⇒
 * true without asking. A rejected `allowed()` or save rejects; the caller falls back to the dialog.
 */
export async function pinApprovedDeviceIf(pubkeyB64: string, allowed: () => Promise<boolean>): Promise<boolean> {
  let pinned = false
  await updateApprovedDevices(async (store) => {
    if (isPinned(store, pubkeyB64)) {
      pinned = true
      return store
    }
    if (!pubkeyB64 || !(await allowed())) return store
    pinned = true
    return pinDevice(store, pubkeyB64)
  })
  return pinned
}
