// Runs the Android app's REAL terminal page script (android/app/src/main/assets/terminal/terminal.js)
// in node, against stubs of xterm.js, the DOM and the WebView bridge, so a JVM test can check what
// the page hands the Kotlin side. Only the OSC 52 handler is driven today (audit A53).
//
// Usage: node terminal-js-driver.cjs <path to terminal.js>
// stdin:  {"copyLimit": <number the stub bridge answers>, "osc52": ["<OSC 52 data>", ...]}
// stdout: one JSON object:
//   {"copyLimitCalls": n, "osc52": [{"returned": <handler result>, "calls": [[name, arg?], ...]}]}
// where an onCopy call's argument is reported as {"length": n, "sameAsInput": bool}, so a payload of
// several hundred thousand characters never has to be echoed back.
'use strict'
const fs = require('fs')
const vm = require('vm')

const scriptPath = process.argv[2]
const input = JSON.parse(fs.readFileSync(0, 'utf8'))

let current = null
let copyLimitCalls = 0
const bridge = {
  copyLimit() {
    copyLimitCalls++
    return input.copyLimit
  },
  onCopy(data) {
    current.calls.push(['onCopy', { length: data.length, sameAsInput: data === current.input }])
  },
  onCopyTooLarge() {
    current.calls.push(['onCopyTooLarge'])
  },
  onResize() {},
  onReady() {},
  onInput() {},
  onScroll() {}
}

const oscHandlers = {}
class Terminal {
  constructor() {
    this.cols = 80
    this.rows = 24
    this.modes = {}
    this.options = {}
    this.parser = {
      registerOscHandler(ident, fn) {
        oscHandlers[ident] = fn
      }
    }
  }
  loadAddon() {}
  open() {}
  onData() {}
  onBinary() {}
  write() {}
  reset() {}
  focus() {}
  blur() {}
  paste() {}
}
class FitAddonStub {
  fit() {}
}
const element = { addEventListener() {} }

const sandbox = {
  Terminal,
  FitAddon: { FitAddon: FitAddonStub },
  document: { getElementById: () => element },
  window: { NodetermBridge: bridge, addEventListener() {} },
  setTimeout: () => 0,
  TextDecoder,
  atob
}
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sandbox, { filename: scriptPath })

const handler = oscHandlers[52]
if (typeof handler !== 'function') {
  process.stdout.write(JSON.stringify({ error: 'terminal.js registered no OSC 52 handler' }) + '\n')
  process.exit(0)
}
const results = []
for (const data of input.osc52) {
  current = { input: data, calls: [] }
  const returned = handler(data)
  results.push({ returned, calls: current.calls })
}
process.stdout.write(JSON.stringify({ copyLimitCalls, osc52: results }) + '\n')
