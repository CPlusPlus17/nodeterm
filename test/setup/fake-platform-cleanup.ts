// TEST-ONLY — the per-file sweep of the temp directories `fakePlatform()` creates. See
// `src/core/platform-fake-dirs.ts` for why (a shared host's `/tmp` ran out of inodes) and why the
// registry lives in a module of its own (this file must not pre-load platform-fake.ts with the real
// `fs`/`os` ahead of a test file's `vi.mock`).
//
// A `setupFiles` entry runs before EVERY test file, and a hook registered here attaches to that
// file. With vitest's default `sequence.hooks: 'stack'`, this `afterAll` — registered before any of
// the test file's own hooks — runs after all of them: every test has finished and the file's own
// teardown has closed whatever it had open inside the directory.
//
// Not a `process.on('exit')` sweep: vitest stops a forks-pool worker with SIGTERM, which ends the
// process without running `exit` listeners, so that sweep would almost never run.
import { afterAll } from 'vitest'
import { removeFakePlatformDirs } from '../../src/core/platform-fake-dirs'

afterAll(() => {
  const { failed } = removeFakePlatformDirs()
  for (const { dir, error } of failed) {
    console.warn(`fakePlatform: could not remove ${dir}: ${String(error)}`)
  }
})
