// Runs the actual Android xterm/Fit/page bundles in jsdom. Only browser layout/canvas facilities
// and the Android bridge are supplied; keyboard, IME, focus, mouse encoding and parser replies
// execute xterm's real implementation. This checks the interactions a stub onData cannot model.
// Usage: node terminal-xterm-interaction-driver.cjs <terminal.js>; stdout is one JSON reply.
'use strict'
const { JSDOM } = require('jsdom')
const fs = require('node:fs')
const path = require('node:path')
const scriptPath = process.argv[2]
const dom = new JSDOM('<!doctype html><style>* { padding: 0; }</style><div id="term"></div>', {
  url: 'https://terminal.test/', runScripts: 'outside-only', pretendToBeVisual: true
})
const win = dom.window
win.TextDecoder = TextDecoder
win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} })
win.HTMLCanvasElement.prototype.getContext = () => ({
  measureText: () => ({ width: 10, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 }),
  fillRect() {}, clearRect() {}, getImageData: () => ({ data: new Uint8Array([0, 0, 0, 255]) }),
  createLinearGradient: () => ({ addColorStop() {} })
})
Object.defineProperties(win.HTMLElement.prototype, {
  clientWidth: { get() { return 526 } }, clientHeight: { get() { return 906 } },
  offsetWidth: { get() { return (this.textContent || '').length * 10 } },
  offsetHeight: { get() { return 20 } }
})
win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 4, top: 2, width: 520, height: 900, right: 524, bottom: 902 })
let now = 0
let nextFrame = 1
const frames = new Map()
win.performance.now = () => now
win.requestAnimationFrame = fn => { const id = nextFrame++; frames.set(id, fn); return id }
win.cancelAnimationFrame = id => frames.delete(id)
let terminal
let ready = false
let events = []
win.NodetermBridge = {
  copyLimit: () => 400000, onResize() {}, onInput: data => events.push({ input: data }),
  onReport: data => events.push({ report: data }), onScroll: (up, notches) => events.push({ scroll: { up, notches } }),
  onCopy() {}, onCopyTooLarge() {}, onCopySheet() {}, openUrl() {}, onReady() { ready = true }
}
const assets = process.argv[3] || path.dirname(scriptPath)
win.eval(fs.readFileSync(path.join(assets, 'xterm.js'), 'utf8'))
const Original = win.Terminal
win.Terminal = class extends Original {
  constructor(options) { super(options); terminal = this }
}
win.eval(fs.readFileSync(path.join(assets, 'addon-fit.js'), 'utf8'))
win.eval(fs.readFileSync(scriptPath, 'utf8'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function drainFrames() {
  let count = 0
  while (frames.size) {
    if (++count > 100) throw new Error('animation frames did not drain')
    now += 16
    const batch = [...frames.values()]
    frames.clear()
    for (const fn of batch) fn(now)
  }
}
const write = data => new Promise(resolve => terminal.write(data, resolve))
async function main() {
  try {
    for (let n = 0; !ready && n < 100; n++) await pause(5)
    if (!ready) throw new Error('actual page never became ready')
    terminal.resize(52, 45)
    await write('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h')
    terminal._core.coreService.onUserInput(() => events.push({ userOrigin: true }))
    const target = terminal.element.querySelector('.xterm-screen')
    function touch(type, y) {
      const t = { identifier: 1, target, clientX: 30, clientY: y, pageX: 30, pageY: y }
      target.dispatchEvent(new win.TouchEvent(type, { bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [t], changedTouches: [t] }))
    }
    const actions = {
      'touch-only': async () => {},
      'focus-report': async () => terminal.blur(),
      'mouse-motion-report': async () => target.dispatchEvent(new win.MouseEvent('mousemove', {
        bubbles: true, clientX: 31, clientY: 301, buttons: 0 })),
      'cursor-query-reply': async () => write('\x1b[6n'),
      'device-attributes-reply': async () => write('\x1b[c'),
      'legacy-mouse-report': async () => {
        await write('\x1b[?1006l')
        target.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 51, clientY: 341, buttons: 0 }))
        await write('\x1b[?1006h')
      },
      'keyboard-escape': async () => terminal.textarea.dispatchEvent(new win.KeyboardEvent('keydown', {
        bubbles: true, key: 'Escape', code: 'Escape', keyCode: 27, which: 27 })),
      'bracketed-paste': async () => terminal.paste('pasted text'),
      'ime-input': async () => terminal.textarea.dispatchEvent(new win.InputEvent('input', {
        bubbles: true, data: '\u65e5', inputType: 'insertText' })),
      'ime-composition': async () => {
        terminal.textarea.dispatchEvent(new win.CompositionEvent('compositionstart', { bubbles: true }))
        terminal.textarea.value = '\u672c'
        terminal.textarea.dispatchEvent(new win.CompositionEvent('compositionupdate', { bubbles: true, data: '\u672c' }))
        await pause(1)
        terminal.textarea.dispatchEvent(new win.CompositionEvent('compositionend', { bubbles: true, data: '\u672c' }))
        await pause(1)
      }
    }
    const results = []
    for (const [name, action] of Object.entries(actions)) {
      win.nt.cancelScroll()
      terminal.focus()
      drainFrames()
      events = []
      touch('touchstart', 500)
      touch('touchmove', 300)
      await action()
      touch('touchmove', 100)
      touch('touchend', 100)
      drainFrames()
      results.push({ name, events, notches: events.reduce((sum, event) => sum + (event.scroll?.notches || 0), 0) })
    }
    process.stdout.write(JSON.stringify({ rows: terminal.rows, cols: terminal.cols,
      mouseMode: terminal.modes.mouseTrackingMode, results }) + '\n')
  } finally {
    terminal.dispose()
    dom.window.close()
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
