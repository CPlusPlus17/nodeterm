// TEST-ONLY. The run-scoped parent directory for `fakePlatform()`'s `userDataDir`s.
//
// `fakePlatform()` (src/core/platform-fake.ts) gives each call a fresh `mkdtemp` directory, and
// nothing ever removed them: a development server running the suite over and over collected
// ~395,000 `nodeterm-fake-*` directories until `/tmp` ran out of inodes and whole runs failed with
// ENOSPC. Every one of them is now made under this directory, which lives exactly as long as the run.
//
// Per RUN, not per file, for the same reason as the tmux sandbox beside it: `setup` runs in the main
// process, so the workers inherit the variable, and `teardown` runs after every worker is gone. A
// per-file `afterAll` would sweep a directory while a store's debounced write could still be on its
// way into it, and turn a leak into an ENOENT thrown from a timer. A run that is killed before its
// teardown leaves ONE directory behind, not thousands.
import { enterFakePlatformRoot, leaveFakePlatformRoot } from '../../src/core/platform-fake'

let dir: string | null = null

export async function setup(): Promise<void> {
  dir = enterFakePlatformRoot()
}

export async function teardown(): Promise<void> {
  if (!dir) return
  leaveFakePlatformRoot(dir)
  dir = null
}
