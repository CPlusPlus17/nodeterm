// fakePlatform()'s temp directories must not outlive the test file that made them.
//
// They used to: every call mkdtemp'd a `nodeterm-fake-*` directory and nothing removed it, until a
// shared host's /tmp hit 100% inode use (~395,000 of them). The mechanism is platform-fake-dirs.ts
// (the registry + sweep) and test/setup/fake-platform-cleanup.ts (the per-file `afterAll`).
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { fakePlatform } from './platform-fake'
import { fakePlatformDirs, removeFakePlatformDirs } from './platform-fake-dirs'

const repoRoot = path.resolve(__dirname, '../..')

describe('fakePlatform temp directories', () => {
  it('records every directory it creates', () => {
    const a = fakePlatform()
    const b = fakePlatform()
    expect(a.userDataDir).not.toBe(b.userDataDir)
    for (const dir of [a.userDataDir, b.userDataDir]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true)
      expect(fakePlatformDirs().has(dir)).toBe(true)
    }
  })

  it('makes and records nothing when the caller brings its own userDataDir', () => {
    const before = [...fakePlatformDirs()]
    const p = fakePlatform({ userDataDir: '/fixture-data' })
    expect(p.userDataDir).toBe('/fixture-data')
    expect([...fakePlatformDirs()]).toEqual(before)
  })

  it('records into the same registry after vi.resetModules (it lives on globalThis)', async () => {
    vi.resetModules()
    const fresh = await import('./platform-fake')
    const dir = fresh.fakePlatform().userDataDir
    expect(fakePlatformDirs().has(dir)).toBe(true)
  })

  it('the sweep removes every recorded directory, contents included, and empties the registry', () => {
    const used = fakePlatform().userDataDir
    const alreadyGone = fakePlatform().userDataDir
    fs.mkdirSync(path.join(used, 'nested'))
    fs.writeFileSync(path.join(used, 'nested', 'state.json'), '{}')
    fs.rmSync(alreadyGone, { recursive: true }) // a test that cleaned up after itself
    const { removed, failed } = removeFakePlatformDirs()
    expect(failed).toEqual([])
    expect(removed).toEqual(expect.arrayContaining([used, alreadyGone]))
    expect(fs.existsSync(used)).toBe(false)
    expect(fakePlatformDirs().size).toBe(0)
  })

  // The end-to-end check: a real child vitest, on the repo's real config (only `include` swapped),
  // runs a file that makes directories through fakePlatform(). They must exist throughout that file
  // (the fixture asserts it, in a later test and in its own afterAll) and be gone once it has ended.
  // This is what fails if the setup file is dropped from vitest.config.ts, if it stops registering
  // the sweep, or if fakePlatform() stops recording what it makes.
  it('removes them once the test file that made them has finished (real vitest run)', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-fake-cleanup-'))
    try {
      const out = path.join(scratch, 'dirs.json')
      // Strip the parent run's worker identity so the child is a vitest run of its own.
      const env: NodeJS.ProcessEnv = { NT_FAKE_DIRS_OUT: out }
      for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VITEST')) env[k] ??= v
      const result = await new Promise<{ code: number; output: string }>((resolve) => {
        execFile(
          process.execPath,
          [
            path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
            'run',
            '--config',
            'test/fixtures/fake-platform-cleanup/vitest.config.ts'
          ],
          { cwd: repoRoot, env, timeout: 90_000 },
          (err, stdout, stderr) => {
            const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
            resolve({ code, output: `${stdout}\n${stderr}` })
          }
        )
      })
      expect(result.code, result.output).toBe(0)
      const dirs = JSON.parse(fs.readFileSync(out, 'utf8')) as string[]
      expect(dirs).toHaveLength(3)
      for (const dir of dirs) {
        expect(path.basename(dir)).toMatch(/^nodeterm-fake-/)
        expect(fs.existsSync(dir), `${dir} outlived its test file`).toBe(false)
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  }, 100_000)
})
