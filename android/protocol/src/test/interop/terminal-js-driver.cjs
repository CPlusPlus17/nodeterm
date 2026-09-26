// Runs the Android app's REAL terminal page script (android/app/src/main/assets/terminal/terminal.js)
// in node, against stubs of xterm.js, the DOM and the WebView bridge, so a JVM test can check what
// the page does. Driven today: the OSC 52 handler (audit A53) and the page's focus for the ⌨ chip
// (audit A46).
//
// Usage: node terminal-js-driver.cjs <path to terminal.js>
// stdin:  {"copyLimit": <number the stub bridge answers>, "osc52": ["<OSC 52 data>", ...],
//          "textareaFocused": <bool, the textarea's focus before the calls>, "nt": ["<window.nt fn>", ...]}
//          (every field but copyLimit is optional)
// stdout: one JSON object:
//   {"copyLimitCalls": n, "osc52": [{"returned": <handler result>, "calls": [[name, arg?], ...]}],
//    "nt": [{"fn": name, "focusChanges": ["blur" | "focus", ...], "focusedAfter": bool}]}
// where an onCopy call's argument is reported as {"length": n, "sameAsInput": bool}, so a payload of
// several hundred thousand characters never has to be echoed back. The stub textarea follows Blink's
// rule for focus(): on the element that already has focus it returns early, changing nothing, and so
// does blur() on one that has not. focusChanges lists only the changes that took effect.
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
let textareaFocused = !!input.textareaFocused
let focusChanges = null
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
  focus() {
    if (textareaFocused) return
    textareaFocused = true
    if (focusChanges) focusChanges.push('focus')
  }
  blur() {
    if (!textareaFocused) return
    textareaFocused = false
    if (focusChanges) focusChanges.push('blur')
  }
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

function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }) + '\n')
  process.exit(0)
}

const handler = oscHandlers[52]
if (typeof handler !== 'function') fail('terminal.js registered no OSC 52 handler')
const results = []
for (const data of input.osc52 || []) {
  current = { input: data, calls: [] }
  const returned = handler(data)
  results.push({ returned, calls: current.calls })
}

const nt = sandbox.window.nt
const ntResults = []
for (const fn of input.nt || []) {
  if (!nt || typeof nt[fn] !== 'function') fail('terminal.js has no window.nt.' + fn)
  focusChanges = []
  nt[fn]()
  ntResults.push({ fn, focusChanges, focusedAfter: textareaFocused })
  focusChanges = null
}
process.stdout.write(JSON.stringify({ copyLimitCalls, osc52: results, nt: ntResults }) + '\n')
