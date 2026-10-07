// Explicit node-pty recorder boundary for socket/Android interop; no kernel/ConPTY claim.
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
export function spawn(_file: string, _args: string[], options: { env: Record<string, string> }) {
  let output: ((data: string) => void) | undefined
  let exit: ((event: { exitCode: number }) => void) | undefined
  return {
    pid: process.pid,
    onData(cb: (data: string) => void) { output = cb
      setTimeout(() => { cb('\x1b[?20'); cb(options.env.NT_COMPOSED_MODE === 'off' ? '04lfixture ready\r\n' : '04hfixture ready\r\n') }, 10) },
    onExit(cb: (event: { exitCode: number }) => void) { exit = cb },
    write(data: string) {
      fs.appendFileSync(options.env.NT_COMPOSED_WRITE_LOG, JSON.stringify({ data, at: performance.now() }) + '\n')
      if (data === 'mode-off') output?.('\x1b[?2004l')
    },
    resize() {}, pause() {}, resume() {},
    kill() { setTimeout(() => exit?.({ exitCode: 0 }), 0) }
  }
}
