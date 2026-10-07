// Real backend/emulator/client code; only the native process is an explicit byte recorder.
// This does not claim Windows ConPTY or kernel PTY acceptance (the native proof is separate).
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { NativeWindowsPane } from '../../../../../src/core/native-windows-pane'
import { SessionHostClient } from '../../../../../src/core/session-host-client'
import { SessionHostPty } from '../../../../../src/core/session-host-pty'
import { bootComposedHost } from '../../../../../src/session-host/__fixtures__/composed-host'
import type { ComposedInput, ComposedInputResult } from '../../../../../src/shared/composed-input'

export async function composedBackendFixture(root: string, kind: string, emit: (event: object) => void) {
  const mode = process.env.FIXTURE_COMPOSED_MODE ?? 'on'
  const emitWrites = (writes: Array<{ data: string; at: number }>): void => {
    for (const write of writes) emit({ event: 'composed-native-write', backend: kind, ...write })
  }
  let submit: (input: ComposedInput, current: () => boolean) => Promise<ComposedInputResult>
  let close: () => void
  if (kind === 'native-windows') {
    const writes: Array<{ data: string; at: number }> = []
    const pane = new NativeWindowsPane({ pid: 123, write: data => writes.push({ data, at: performance.now() }) },
      { cols: 80, rows: 24, scrollback: 100 })
    pane.recordOutput('\x1b[?20'); pane.recordOutput(mode === 'off' ? '04lfixture ready\r\n' : '04hfixture ready\r\n')
    submit = async (input, current) => { const start = writes.length
      const result = await pane.submitComposed(input, current); emitWrites(writes.slice(start)); return result }
    close = () => pane.dispose()
  } else if (kind === 'session-host') {
    fs.mkdirSync(root, { recursive: true })
    const host = await bootComposedHost(root, process.argv[1] + '-composed-host.cjs', mode)
    const client = new SessionHostClient({ userDataDir: host.dataDir })
    const painter = new SessionHostPty(client, 'android-owned', host.spawnOptions, 100)
    let output = ''
    const modeObserved = new Promise<void>((resolve) => painter.onData(data => { output += data; if (output.includes('fixture ready')) resolve() }))
    await painter.ready; await modeObserved
    submit = async (input, current) => { const start = host.writes().length
      const result = await painter.submitComposed(input, current); emitWrites(host.writes().slice(start)); return result }
    close = () => { painter.destroy(); void host.close() }
    // Own child only. The JVM harness also captures descendants before destroying this fixture.
    process.once('SIGTERM', () => { close(); process.exit(0) })
  } else throw new Error('Unknown explicit composed backend fixture')
  emit({ event: 'composed-backend-ready', backend: kind, nativeBoundary: 'byte-recorder', actualBackend: true })
  return { submit, close }
}
