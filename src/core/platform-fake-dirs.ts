// TEST-ONLY: the registry of temp directories `fakePlatform()` creates, and the sweep that removes
// them once a test file has finished.
//
// Why it exists: `fakePlatform()` mkdtemp'd a fresh `nodeterm-fake-*` directory on EVERY call and
// nothing ever removed one. On a shared host where many sessions run `npm test`, those empty
// directories reached ~395,000 entries and took `/tmp` to 100% inode use (655,181 of 655,360) —
// at which point every program on the machine that needed a temp file failed.
//
// How it is wired: `fakePlatform()` records each directory it creates here, and
// `test/setup/fake-platform-cleanup.ts` (a vitest `setupFiles` entry) registers an `afterAll` that
// calls `removeFakePlatformDirs()`. A setup file's hooks attach to every test file, and with the
// default `sequence.hooks: 'stack'` its `afterAll` runs LAST, after the test file's own teardown —
// so no directory is removed while any test in the file (or its own `afterAll`) can still use it,
// and a test that inspects the directory mid-file keeps working.
//
// Why a module of its own, rather than living in platform-fake.ts: setup files are evaluated in the
// SAME module graph as the test file, BEFORE the test file's hoisted `vi.mock(...)` calls apply.
// Importing platform-fake.ts from the setup file would pre-load it with the real `fs`/`os`, silently
// changing what a test that mocks either module gets back from `fakePlatform()`. This module holds
// nothing a test would want to mock — and it is exactly right that its `rmSync` is the real one.
//
// Why `globalThis` instead of a module-level Set: `vi.resetModules()` re-evaluates modules, so a
// test that resets and re-imports platform-fake would record into a second Set the sweep never sees.
import { rmSync } from 'fs'

const REGISTRY = Symbol.for('nodeterm.test.fakePlatformDirs')

/** The live set of directories `fakePlatform()` created in this worker and has not yet removed. */
export function fakePlatformDirs(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>
  let dirs = g[REGISTRY]
  if (!dirs) {
    dirs = new Set()
    g[REGISTRY] = dirs
  }
  return dirs
}

/** Record a directory `fakePlatform()` created, so the per-file sweep removes it. Returns `dir`. */
export function trackFakePlatformDir(dir: string): string {
  fakePlatformDirs().add(dir)
  return dir
}

export interface FakeDirSweep {
  removed: string[]
  failed: Array<{ dir: string; error: unknown }>
}

/**
 * Remove every tracked directory and empty the registry.
 *
 * Best effort by design: one directory that cannot be removed (a test left something locked on
 * Windows, say) must not stop the rest from going, and must not fail a test file whose tests all
 * passed. Failures are returned so the caller can say so. A directory a test already removed
 * itself is fine (`force`).
 */
export function removeFakePlatformDirs(): FakeDirSweep {
  const dirs = fakePlatformDirs()
  const sweep: FakeDirSweep = { removed: [], failed: [] }
  for (const dir of [...dirs]) {
    dirs.delete(dir)
    try {
      // maxRetries covers a handle that is still closing on Windows (EBUSY/EPERM/ENOTEMPTY).
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
      sweep.removed.push(dir)
    } catch (error) {
      sweep.failed.push({ dir, error })
    }
  }
  return sweep
}
