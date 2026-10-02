// Runs the Android app's REAL terminal page script (android/app/src/main/assets/terminal/terminal.js)
// in node, against stubs of xterm.js, the DOM and the WebView bridge, so a JVM test can check what
// the page does. Driven today: the OSC 52 handler (audit A53), the page's focus for the ⌨ chip
// (audit A46), and links and the Copy sheet (audit A32).
//
// Usage: node terminal-js-driver.cjs <path to terminal.js>
// stdin:  {"copyLimit": <number the stub bridge answers>, "osc52": ["<OSC 52 data>", ...],
//          "textareaFocused": <bool, the textarea's focus before the calls>, "nt": ["<window.nt fn>", ...],
//          "screen": {"cols": n, "rows": n, "viewportY": n,
//                     "lines": [{"text": "...", "wrapped": <bool>, "links": [{"from": col, "to": col, "uri": "..."}]}]},
//          "provideLinks": [<1-based buffer line>, ...],
//          "linkHandler": ["<OSC 8 URI>", ...],
//          "taps": [{"col": c, "row": <viewport row>, "move": [dx, dy], "fingers": n}],
//          "copySheet": <bool>}
//         (every field but copyLimit is optional; with no "screen" the buffer is 80×24 and empty)
// stdout: one JSON object:
//   {"copyLimitCalls": n, "osc52": [{"returned": <handler result>, "calls": [[name, arg?], ...]}],
//    "nt": [{"fn": name, "focusChanges": ["blur" | "focus", ...], "focusedAfter": bool}],
//    "provideLinks": [{"links": null | [{"text", "range", "opened": [url, ...]}]}],
//    "linkHandler": [{"opened": [url, ...]}],
//    "taps": [{"prevented": bool, "opened": [url, ...]}],
//    "copySheet": {"raw": "<the JSON string the page handed onCopySheet>", "calls": n},
//    "confirmCalls": n}
// where an onCopy call's argument is reported as {"length": n, "sameAsInput": bool}, so a payload of
// several hundred thousand characters never has to be echoed back. The stub textarea follows Blink's
// rule for focus(): on the element that already has focus it returns early, changing nothing, and so
// does blur() on one that has not. focusChanges lists only the changes that took effect.
//
// The stub buffer answers what terminal.js reads of xterm's: getLine(row).isWrapped,
// translateToString(trim) (a row's text padded to `cols` untrimmed, right-trimmed otherwise), and
// getCell(col).extended.urlId for the cells of an OSC 8 link, whose URI `_core._oscLinkService` holds.
// The screen element sits at (4, 2) with 10×20 px cells; a tap is a touchstart at the cell's centre,
// a touchmove by `move` when given, and a touchend at the end point. `fingers` > 1 starts with that many
// touches. "opened" lists the URLs the page handed bridge.openUrl.
'use strict'
const fs = require('fs')
const vm = require('vm')

const scriptPath = process.argv[2]
const input = JSON.parse(fs.readFileSync(0, 'utf8'))

let current = null
let copyLimitCalls = 0
let opened = []
let copySheetRaw = null
let copySheetCalls = 0
let confirmCalls = 0
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
  openUrl(url) {
    if (typeof url !== 'string') throw new Error('openUrl takes a string')
    opened.push(url)
  },
  onCopySheet(json) {
    if (typeof json !== 'string') throw new Error('onCopySheet takes a string')
    copySheetCalls++
    copySheetRaw = json
  },
  onResize() {},
  onReady() {},
  onInput() {},
  onScroll() {}
}

const screenIn = input.screen || { cols: 80, rows: 24, lines: [] }
const COLS = screenIn.cols
const ROWS = screenIn.rows
const CELL_W = 10
const CELL_H = 20
const SCREEN_LEFT = 4
const SCREEN_TOP = 2
const linkUris = []
const rowsData = (screenIn.lines || []).map((l) => {
  const text = (l.text || '').slice(0, COLS)
  const cellLinks = new Array(COLS).fill(0)
  for (const link of l.links || []) {
    linkUris.push(link.uri)
    const id = linkUris.length
    for (let x = link.from; x <= link.to && x < COLS; x++) cellLinks[x] = id
  }
  return { text, wrapped: !!l.wrapped, cellLinks }
})
// At least a screenful: rows below the given lines are blank, as in a real buffer.
while (rowsData.length < ROWS) rowsData.push({ text: '', wrapped: false, cellLinks: new Array(COLS).fill(0) })
const viewportY = screenIn.viewportY === undefined ? Math.max(0, rowsData.length - ROWS) : screenIn.viewportY

function bufferLine(row) {
  const d = rowsData[row]
  if (!d) return undefined
  return {
    isWrapped: d.wrapped,
    length: COLS,
    translateToString(trim) {
      return trim ? d.text.replace(/\s+$/, '') : d.text.padEnd(COLS)
    },
    getCell(x) {
      if (x < 0 || x >= COLS) return undefined
      // A fresh object per read, as xterm's getCell(x) without a cell to reuse.
      return { extended: { urlId: d.cellLinks[x] } }
    }
  }
}

const oscHandlers = {}
const linkProviders = []
let textareaFocused = !!input.textareaFocused
let focusChanges = null
const screenElement = {
  getBoundingClientRect() {
    return { left: SCREEN_LEFT, top: SCREEN_TOP, width: COLS * CELL_W, height: ROWS * CELL_H }
  }
}
let createdTerm = null
class Terminal {
  constructor() {
    createdTerm = this
    this.cols = COLS
    this.rows = ROWS
    this.modes = {}
    this.options = {}
    this.element = undefined
    this.buffer = {
      active: { length: rowsData.length, viewportY, baseY: viewportY, getLine: bufferLine }
    }
    this._core = {
      _oscLinkService: {
        getLinkData(id) {
          return id > 0 && id <= linkUris.length ? { id: String(id), uri: linkUris[id - 1] } : undefined
        }
      }
    }
    this.parser = {
      registerOscHandler(ident, fn) {
        oscHandlers[ident] = fn
      }
    }
  }
  loadAddon() {}
  open() {
    this.element = {
      querySelector(sel) {
        return sel === '.xterm-screen' ? screenElement : null
      }
    }
  }
  registerLinkProvider(provider) {
    linkProviders.push(provider)
    return { dispose() {} }
  }
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
const hostListeners = {}
const element = {
  addEventListener(type, fn) {
    ;(hostListeners[type] = hostListeners[type] || []).push(fn)
  }
}

const sandbox = {
  Terminal,
  FitAddon: { FitAddon: FitAddonStub },
  document: { getElementById: () => element },
  window: { NodetermBridge: bridge, addEventListener() {} },
  setTimeout: () => 0,
  // xterm's default OSC 8 activation asks with confirm(); the page must never get there.
  confirm() {
    confirmCalls++
    return false
  },
  TextDecoder,
  URL,
  JSON,
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

const provided = []
for (const y of input.provideLinks || []) {
  if (linkProviders.length !== 1) fail('terminal.js registered ' + linkProviders.length + ' link providers, not 1')
  let reply = 'no callback'
  linkProviders[0].provideLinks(y, (links) => {
    reply = links
  })
  if (reply === 'no callback') fail('the link provider did not answer for line ' + y)
  provided.push({
    links: reply
      ? reply.map((l) => {
          opened = []
          l.activate({ type: 'mouseup' }, l.text)
          return { text: l.text, range: l.range, opened }
        })
      : null
  })
}

const handled = []
for (const uri of input.linkHandler || []) {
  opened = []
  const linkHandler = optionsOfTerm().linkHandler
  if (!linkHandler || typeof linkHandler.activate !== 'function') fail('terminal.js set no options.linkHandler')
  if (linkHandler.allowNonHttpProtocols) fail('options.linkHandler.allowNonHttpProtocols is on')
  linkHandler.activate({ type: 'mouseup' }, uri, { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } })
  handled.push({ opened })
}

function touchAt(x, y) {
  return { clientX: x, clientY: y, identifier: 0 }
}
function dispatch(type, event) {
  for (const fn of hostListeners[type] || []) fn(event)
}
const tapped = []
for (const tap of input.taps || []) {
  opened = []
  let prevented = false
  const x = SCREEN_LEFT + tap.col * CELL_W + CELL_W / 2
  const y = SCREEN_TOP + tap.row * CELL_H + CELL_H / 2
  const fingers = tap.fingers || 1
  const start = []
  for (let i = 0; i < fingers; i++) start.push(touchAt(x + i * 50, y))
  dispatch('touchstart', { touches: start, changedTouches: start, preventDefault() {} })
  let ex = x
  let ey = y
  if (tap.move) {
    ex = x + tap.move[0]
    ey = y + tap.move[1]
    const moved = [touchAt(ex, ey)]
    dispatch('touchmove', { touches: moved, changedTouches: moved, preventDefault() {} })
  }
  dispatch('touchend', {
    touches: [],
    changedTouches: [touchAt(ex, ey)],
    preventDefault() {
      prevented = true
    }
  })
  tapped.push({ prevented, opened })
}

let copySheet = null
if (input.copySheet) {
  if (!nt || typeof nt.copySheet !== 'function') fail('terminal.js has no window.nt.copySheet')
  nt.copySheet()
  copySheet = { raw: copySheetRaw, calls: copySheetCalls }
}

function optionsOfTerm() {
  if (!createdTerm) fail('terminal.js created no Terminal')
  return createdTerm.options
}

process.stdout.write(
  JSON.stringify({
    copyLimitCalls,
    osc52: results,
    nt: ntResults,
    provideLinks: provided,
    linkHandler: handled,
    taps: tapped,
    copySheet,
    confirmCalls
  }) + '\n'
)
