// Stable codes for a hosted-team join that failed before it reached the relay.
//
// The main process throws with a message that starts with `[E_JOIN_…]`; that code is the only part
// of the failure that survives Electron IPC (an `ipcMain.handle` rejection reaches the renderer as
// its message, wrapped in Electron's own prefix). A renderer that reconnects on its own reads the
// code with `joinErrorCode` and decides whether trying again can help: only a network failure can.
// Every other code needs a human (a new code, an unlocked keyring, an owner) or a new day, and
// retrying it would at best repeat the refusal and at worst spend damped device-token mints.

export const JOIN_ERROR_CODES = [
  'E_JOIN_REVOKED',
  'E_JOIN_REFUSED',
  'E_JOIN_RATE',
  'E_JOIN_BAD_CODE',
  'E_JOIN_NETWORK',
  'E_JOIN_KEY_LOCKED'
] as const

export type JoinErrorCode = (typeof JOIN_ERROR_CODES)[number]

const CODE_RE = /\[(E_JOIN_[A-Z_]+)\]/

/** The join error code in `message` (anywhere: Electron prefixes it), or null when there is none. */
export function joinErrorCode(message: string): JoinErrorCode | null {
  if (typeof message !== 'string') return null
  const m = CODE_RE.exec(message)
  const code = m?.[1]
  return code && (JOIN_ERROR_CODES as readonly string[]).includes(code) ? (code as JoinErrorCode) : null
}

/** Whether a failed join is worth retrying unattended. */
export function joinErrorRetries(code: JoinErrorCode | null): boolean {
  return code === 'E_JOIN_NETWORK'
}
