// This computer's own SSH host keys, as the fingerprints a paired phone checks its first SSH connect
// against (audit A49-anchor).
//
// Without them the phone's first connect is trust on first use: it pins whichever key answers at the
// paired address, once that server has accepted the phone's key. The pairing already crosses a channel
// that proves which computer is on the other end (the `/pair` body is sealed to the host key the QR on
// this screen carries), so the desktop hands the phone its host key fingerprints inside that sealed
// answer, and the first connect must present one of them.
//
// Read-only and never fatal: an unreadable directory, file or config yields nothing for it, and a
// pairing whose answer carries no fingerprints leaves the phone on its trust-on-first-use pin, exactly
// as before. The fingerprint is OpenSSH's (`ssh-keygen -l -E sha256`), which is also what sshj reports
// on the phone: `SHA256:` + the unpadded standard base64 of the SHA-256 of the key blob.

import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'

/**
 * Where sshd keeps its host keys and its config. `/etc/ssh` on Linux and on macOS 10.11 and later;
 * macOS 10.10 and older kept `ssh_host_*_key` and `sshd_config` directly in `/etc` (`/private/etc`).
 */
export const SSH_HOST_KEY_DIRS: readonly string[] = ['/etc/ssh', '/etc']

/** The most fingerprints a pairing answer carries. sshd serves three or four; the phone keeps as many. */
export const MAX_SSH_HOST_KEYS = 16

/** A `.pub` larger than this is not a host public key (an RSA-16384 line is under 3 KiB). */
const MAX_PUB_BYTES = 16 * 1024
/** sshd_config files larger than this are not read. */
const MAX_CONFIG_BYTES = 256 * 1024

/** The default host key names sshd generates: `ssh_host_ed25519_key.pub` and the like. */
const HOST_KEY_PUB = /^ssh_host_[A-Za-z0-9_]+_key\.pub$/
/** An SSH public key algorithm name (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `sk-ssh-ed25519@openssh.com`). */
const KEY_TYPE = /^[a-z0-9][a-z0-9.@-]*$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * OpenSSH's `SHA256:<unpadded base64>` fingerprint of the first key line in [text] (a `.pub` file), or
 * null when that line is not a plain public key: a certificate, a blob that does not name its own
 * type, or anything that is not base64. Comment and blank lines before it are skipped.
 */
export function sshFingerprintOfPublicKeyLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [type, b64] = line.split(/\s+/)
    if (!type || !b64 || !KEY_TYPE.test(type) || type.includes('-cert-') || !BASE64.test(b64)) return null
    const blob = Buffer.from(b64, 'base64')
    // The blob opens with its own key type as an SSH string (RFC 4253 §6.6). One that does not is not
    // the key its line names, and its fingerprint would match nothing a server presents.
    if (blob.length < 4) return null
    const n = blob.readUInt32BE(0)
    if (n !== Buffer.byteLength(type) || blob.length <= 4 + n) return null
    if (blob.subarray(4, 4 + n).toString('latin1') !== type) return null
    return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  }
  return null
}

/** The fingerprint of one `.pub` file, or null when it cannot be read or is not a key. */
async function fingerprintOfFile(file: string): Promise<string | null> {
  try {
    const st = await fs.stat(file)
    if (!st.isFile() || st.size > MAX_PUB_BYTES) return null
    return sshFingerprintOfPublicKeyLine(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** A text file's contents when it is a readable regular file of a sane size, else null. */
async function readSmallText(file: string): Promise<string | null> {
  try {
    const st = await fs.stat(file)
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * The absolute `HostKey` paths an sshd config text names. sshd takes `Keyword value` or
 * `Keyword=value`, keywords case-insensitively, and a value in double quotes. A relative or
 * token-bearing path is skipped: there is no telling here what sshd would resolve it to.
 */
export function hostKeyPathsInSshdConfig(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*hostkey(?:\s*=\s*|\s+)(.*)$/i.exec(raw)
    if (!m) continue
    let value = m[1].trim()
    const quoted = /^"([^"]*)"/.exec(value)
    value = quoted ? quoted[1] : value.split(/\s+/)[0]
    if (path.posix.isAbsolute(value) && !value.includes('%')) out.push(value)
  }
  return out
}

/**
 * The host key paths `<dir>/sshd_config` and every file in its `sshd_config.d/` configure. Every file,
 * not only `*.conf`: which drop-ins sshd reads is its `Include` glob's call (`*.conf` on Debian and
 * Fedora; a config may as well include the whole directory), and a key read from a drop-in sshd skips costs
 * nothing (the list is a superset), while a key sshd serves from one this skipped makes the phone
 * refuse SSH to its own computer, and pairing again would only read the same files (review of
 * A49-anchor).
 */
async function configuredHostKeys(dir: string): Promise<string[]> {
  const files = [path.join(dir, 'sshd_config')]
  const dropIns = path.join(dir, 'sshd_config.d')
  const names = await fs.readdir(dropIns).catch(() => [] as string[])
  for (const name of [...names].sort()) files.push(path.join(dropIns, name))
  const out: string[] = []
  for (const file of files) {
    const text = await readSmallText(file)
    if (text) out.push(...hostKeyPathsInSshdConfig(text))
  }
  return out
}

/**
 * The fingerprints of this computer's SSH host keys: every `ssh_host_*_key.pub` in [dirs], then the
 * `.pub` beside every key a `HostKey` line in `<dir>/sshd_config` (or a file in `sshd_config.d/`)
 * names (or that file itself when it is already a `.pub`, which sshd accepts when the private
 * key lives in an agent), in that order, without duplicates and at most [MAX_SSH_HOST_KEYS]. sshd serves one
 * of its keys per connection, so the list is a superset rather than a guess: a key here that sshd
 * does not serve costs nothing, a key sshd serves that is missing here makes the phone refuse SSH.
 * Never throws; what cannot be read is left out, and nothing readable gives an empty list.
 */
export async function readSshHostKeyFingerprints(dirs: readonly string[] = SSH_HOST_KEY_DIRS): Promise<string[]> {
  const files: string[] = []
  for (const dir of dirs) {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    for (const name of names.filter((n) => HOST_KEY_PUB.test(n)).sort()) files.push(path.join(dir, name))
    for (const key of await configuredHostKeys(dir)) files.push(key.endsWith('.pub') ? key : `${key}.pub`)
  }
  const out: string[] = []
  for (const file of files) {
    if (out.length >= MAX_SSH_HOST_KEYS) break
    const fp = await fingerprintOfFile(file)
    if (fp && !out.includes(fp)) out.push(fp)
  }
  return out
}
