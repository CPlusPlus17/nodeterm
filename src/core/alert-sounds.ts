// Custom alert sounds (issue #289), core side — registered by BOTH shells through
// `registerFsHandlers`, so desktop and the Server Edition store and serve the file the same way.
//
// The renderer hands over BYTES (base64) plus the picked file's name, never a path: on desktop
// that keeps path handling out of the renderer entirely, and in the Server Edition the file sits
// on the BROWSER's machine, so bytes are the only thing that can reach this core at all (the same
// reasoning as core/uploads.ts). Everything is validated here, before anything is written:
//   • `kind` against the allow-list — it names the file, so it must never be free text;
//   • the extension against the audio allow-list;
//   • the size (encoded length first, then decoded) against ALERT_SOUND_MAX_BYTES;
//   • the magic bytes against the claimed extension, so a renamed image/executable is refused.
// The file is written under a FIXED name, `<userData>/sounds/<kind>.<ext>`. The user's name is
// only echoed back for display; it never becomes part of a path.
//
// Reading back takes only a `kind`, so no caller can aim it at another file, and a symlink planted
// at the fixed name is refused (lstat) rather than followed. Every function resolves — none
// throws — because a broken custom sound must degrade to the built-in chime, never to an error in
// the agent-status path that plays it.

import { promises as fs } from 'fs'
import { basename, join } from 'path'
import { renameAtomic, tempNameFor } from './fs-atomic'
import {
  ALERT_SOUND_EXTENSIONS,
  ALERT_SOUND_MAX_BYTES,
  alertSoundExtension,
  isAlertSoundKind,
  type AlertSoundExtension,
  type AlertSoundKind,
  type AlertSoundSaveResult
} from '../shared/alert-sound'

/** `<userData>/sounds` — exported so tests (and messages) can name it. */
export const alertSoundsDir = (userDataDir: string): string => join(userDataDir, 'sounds')

const startsWith = (buf: Buffer, sig: string, at = 0): boolean =>
  buf.length >= at + sig.length && buf.toString('latin1', at, at + sig.length) === sig

/** MPEG audio frame sync (11 set bits) — a bare mp3 / ADTS aac without an ID3 header. */
const frameSync = (buf: Buffer): boolean => buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0

/**
 * Do `buf`'s leading bytes look like the format its extension claims? Deliberately a sniff, not a
 * decode (core has no audio decoder): it stops a renamed non-audio file at the door, and anything
 * that passes but still does not decode falls back to the chime at playback.
 */
export function sniffAlertSound(buf: Buffer, ext: AlertSoundExtension): boolean {
  switch (ext) {
    case 'wav':
      return startsWith(buf, 'RIFF') && startsWith(buf, 'WAVE', 8)
    case 'mp3':
    case 'aac':
      return startsWith(buf, 'ID3') || frameSync(buf)
    case 'ogg':
    case 'oga':
    case 'opus':
      return startsWith(buf, 'OggS')
    case 'flac':
      return startsWith(buf, 'fLaC')
    case 'm4a':
      return startsWith(buf, 'ftyp', 4)
    case 'webm':
      return buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3
  }
}

/** Remove every stored variant of `kind` except `keep` (a pick of another format replaces it). */
async function removeVariants(dir: string, kind: AlertSoundKind, keep?: string): Promise<void> {
  for (const ext of ALERT_SOUND_EXTENSIONS) {
    const name = `${kind}.${ext}`
    if (name !== keep) await fs.rm(join(dir, name), { force: true })
  }
}

/** Validate and store a custom sound for `kind`. Never throws. */
export async function saveAlertSound(
  userDataDir: string,
  kind: AlertSoundKind,
  name: string,
  dataBase64: string
): Promise<AlertSoundSaveResult> {
  if (!isAlertSoundKind(kind)) return { ok: false, error: 'Unknown alert sound.' }
  const displayName = basename(String(name ?? '').replace(/\\/g, '/')).trim()
  const ext = alertSoundExtension(displayName)
  if (!ext) {
    return { ok: false, error: `Use an audio file: ${ALERT_SOUND_EXTENSIONS.join(', ')}.` }
  }
  const tooLarge = `That file is too large — the limit is ${ALERT_SOUND_MAX_BYTES / (1024 * 1024)} MB.`
  // Guard on the ENCODED length first: decoding a hostile huge string to measure it is the
  // allocation this limit exists to prevent.
  if (typeof dataBase64 !== 'string') return { ok: false, error: 'That file could not be read.' }
  if (dataBase64.length > Math.ceil(ALERT_SOUND_MAX_BYTES * 1.4)) return { ok: false, error: tooLarge }
  const buf = Buffer.from(dataBase64, 'base64')
  if (!buf.length) return { ok: false, error: 'That file is empty.' }
  if (buf.length > ALERT_SOUND_MAX_BYTES) return { ok: false, error: tooLarge }
  if (!sniffAlertSound(buf, ext)) {
    return { ok: false, error: `That file does not look like ${ext.toUpperCase()} audio.` }
  }
  const dir = alertSoundsDir(userDataDir)
  const target = `${kind}.${ext}`
  const tmp = tempNameFor(join(dir, target))
  try {
    await fs.mkdir(dir, { recursive: true })
    // `wx` refuses a pre-planted temp (symlink) instead of writing through it; the rename then
    // swaps the file in whole, so a concurrent read never sees half a sound.
    await fs.writeFile(tmp, buf, { flag: 'wx' })
    await renameAtomic(tmp, join(dir, target))
    await removeVariants(dir, kind, target)
    return { ok: true, name: displayName }
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: 'Could not save the sound — is the data folder writable?' }
  }
}

/** The stored custom sound for `kind` as base64, or null (none, unreadable, refused). Never throws. */
export async function readAlertSound(userDataDir: string, kind: AlertSoundKind): Promise<string | null> {
  if (!isAlertSoundKind(kind)) return null
  const dir = alertSoundsDir(userDataDir)
  for (const ext of ALERT_SOUND_EXTENSIONS) {
    const file = join(dir, `${kind}.${ext}`)
    try {
      const st = await fs.lstat(file)
      if (!st.isFile() || st.size === 0 || st.size > ALERT_SOUND_MAX_BYTES) return null
      return (await fs.readFile(file)).toString('base64')
    } catch {
      /* not this extension — try the next */
    }
  }
  return null
}

/** Delete the custom sound for `kind` (Reset to default). True unless the kind is unknown or the
 *  delete failed. Never throws. */
export async function clearAlertSound(userDataDir: string, kind: AlertSoundKind): Promise<boolean> {
  if (!isAlertSoundKind(kind)) return false
  try {
    await removeVariants(alertSoundsDir(userDataDir), kind)
    return true
  } catch {
    return false
  }
}
