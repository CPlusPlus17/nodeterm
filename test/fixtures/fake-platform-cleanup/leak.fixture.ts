// Run ONLY by src/core/platform-fake.test.ts, in a child vitest through ./vitest.config.ts. The
// `.fixture.ts` name keeps it out of the normal suite's `include`.
//
// Makes directories through `fakePlatform()`, writes their paths to $NT_FAKE_DIRS_OUT, and asserts
// they stay alive for as long as this file is running — later tests AND this file's own `afterAll`
// can still use them. The parent then checks they are gone once this file has finished.
import fs from 'fs'
import path from 'path'
import { afterAll, expect, it } from 'vitest'
import { fakePlatform } from '../../../src/core/platform-fake'

const out = process.env.NT_FAKE_DIRS_OUT
if (!out) throw new Error('NT_FAKE_DIRS_OUT is unset — this fixture is run by platform-fake.test.ts')

let dirs: string[] = []

it('creates directories through fakePlatform()', () => {
  dirs = [fakePlatform(), fakePlatform(), fakePlatform()].map((p) => p.userDataDir)
  for (const dir of dirs) expect(fs.statSync(dir).isDirectory()).toBe(true)
  fs.writeFileSync(out, JSON.stringify(dirs))
})

it('keeps them, writable, for a later test in the same file', () => {
  for (const dir of dirs) expect(fs.existsSync(dir)).toBe(true)
  // Non-empty on purpose: the sweep must remove a directory a test actually used.
  fs.mkdirSync(path.join(dirs[0], 'nested'))
  fs.writeFileSync(path.join(dirs[0], 'nested', 'state.json'), '{}')
})

afterAll(() => {
  // The file's own teardown runs BEFORE the sweep (setup-file hooks run last under 'stack').
  for (const dir of dirs) expect(fs.existsSync(dir)).toBe(true)
})
