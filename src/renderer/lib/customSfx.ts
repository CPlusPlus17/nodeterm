// Custom alert sounds (issue #289), renderer half: WHICH sound an alert plays, and the guarantee
// that choosing one can never cost the user the alert — or break the agent-status path that fires
// it. Pure over injected deps (no WebAudio, no IPC) so the fallback rules are unit-tested; sfx.ts
// wires the real ones.
//
// Rules:
//   • No custom sound for the kind (or a malformed settings entry) ⇒ the built-in chime, played
//     synchronously exactly as before this feature.
//   • A custom sound is loaded by KIND from the core (never by path), decoded once per `stamp`,
//     and played at the user's volume. Anything that goes wrong — missing file, a read the bridge
//     refuses, a decode error, a playback error — answers `false`, and the caller plays the chime.
//   • A failure is NOT cached: the next alert retries, so a transiently dropped Server Edition
//     socket does not pin the chime for the rest of the run.
//   • Nothing here throws into the caller, synchronously or as an unhandled rejection.

import { customAlertSoundFor, type AlertSoundKind } from '@shared/alert-sound'

export interface CustomSfxDeps<B> {
  /** The stored sound's bytes (base64), or null when there is none. May reject. */
  read(kind: AlertSoundKind): Promise<string | null>
  /** Decode base64 audio into something `play` accepts. Rejects on a corrupt file. */
  decode(dataBase64: string): Promise<B>
  /** Start playback at `gain` (0..1, the user's volume). May throw. */
  play(buf: B, gain: number): void
}

export interface CustomSfxPlayer {
  /** Play the custom sound for `kind` at `stamp`. True when it started; false on ANY failure. */
  play(kind: AlertSoundKind, stamp: number, gain: number): Promise<boolean>
  /** Load + decode without playing (the Settings check after a pick). True when it decodes. */
  preload(kind: AlertSoundKind, stamp: number): Promise<boolean>
}

export function createCustomSfxPlayer<B>(deps: CustomSfxDeps<B>): CustomSfxPlayer {
  const cache = new Map<AlertSoundKind, { stamp: number; buf: Promise<B | null> }>()

  const load = (kind: AlertSoundKind, stamp: number): Promise<B | null> => {
    const hit = cache.get(kind)
    if (hit && hit.stamp === stamp) return hit.buf
    const buf = (async (): Promise<B | null> => {
      try {
        const b64 = await deps.read(kind)
        if (!b64) return null
        return await deps.decode(b64)
      } catch {
        return null
      }
    })()
    const entry = { stamp, buf }
    cache.set(kind, entry)
    // Only a success stays cached; a failure is forgotten so the next alert asks again.
    void buf.then((b) => {
      if (b === null && cache.get(kind) === entry) cache.delete(kind)
    })
    return buf
  }

  return {
    async play(kind, stamp, gain) {
      const buf = await load(kind, stamp)
      if (buf === null) return false
      try {
        deps.play(buf, gain)
        return true
      } catch {
        return false
      }
    },
    async preload(kind, stamp) {
      return (await load(kind, stamp)) !== null
    }
  }
}

export interface PlayAlertDeps {
  /** The built-in synthesized chime. */
  chime(kind: AlertSoundKind, volume: number): void
  custom: CustomSfxPlayer
}

const safeChime = (deps: PlayAlertDeps, kind: AlertSoundKind, volume: number): void => {
  try {
    deps.chime(kind, volume)
  } catch {
    // Losing a chirp is never worth surfacing.
  }
}

/**
 * Play the alert for `kind`: the user's custom sound when one is set and loads, else the built-in
 * chime. `custom` is `settings.customAlertSounds` as read (validated here, not trusted). Never
 * throws and never blocks.
 */
export function playAlert(
  kind: AlertSoundKind,
  volume: number,
  custom: unknown,
  deps: PlayAlertDeps
): void {
  const vol = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0
  if (vol <= 0) return
  const ref = customAlertSoundFor(custom, kind)
  if (!ref) {
    safeChime(deps, kind, vol)
    return
  }
  let started: Promise<boolean>
  try {
    started = deps.custom.play(kind, ref.stamp, vol)
  } catch {
    started = Promise.resolve(false)
  }
  void started.then(
    (ok) => {
      if (!ok) safeChime(deps, kind, vol)
    },
    () => safeChime(deps, kind, vol)
  )
}
