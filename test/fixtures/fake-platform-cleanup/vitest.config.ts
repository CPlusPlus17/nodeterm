// Child-run config for src/core/platform-fake.test.ts ONLY — not part of the normal suite.
//
// It IS the repo's real vitest config with one change: `include` names the fixture below instead
// of the real tests. Everything the regression test is about — `setupFiles` (the per-file
// fakePlatform sweep), `globalSetup`, the hook order — comes from the real config unchanged, so
// dropping the sweep from vitest.config.ts turns that test red.
import base from '../../../vitest.config'

export default {
  ...base,
  test: {
    ...base.test,
    include: ['test/fixtures/fake-platform-cleanup/*.fixture.ts'],
    maxWorkers: 1
  }
}
