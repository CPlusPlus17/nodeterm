// The phone's terminal: xterm.js (the desktop's emulator) as a RENDERER for a tmux client that
// lives on the computer. Android talks to it through two narrow channels:
//   Android → page: window.nt.* functions, called with base64 so no byte ever needs JS escaping;
//   page → Android: window.NodetermBridge (addJavascriptInterface), strings only.
// tmux owns scrolling (its mouse is on and the pane is on the alternate screen), so a vertical
// swipe becomes wheel notches the HOST writes into the pane — exactly what the relay's
// `pty.scroll` does — and xterm keeps no scrollback of its own worth scrolling.
(function () {
  'use strict'
  var bridge = window.NodetermBridge
  var fontSize = 13
  var term = new Terminal({
    fontSize: fontSize,
    fontFamily: 'monospace',
    cursorBlink: true,
    scrollback: 1000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: { background: '#000000', foreground: '#e6e6e6', cursor: '#e6e6e6' }
  })
  var fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  var host = document.getElementById('term')
  term.open(host)

  var lastCols = 0
  var lastRows = 0
  function doFit(force) {
    try { fit.fit() } catch (e) { /* not laid out yet */ }
    if (force || term.cols !== lastCols || term.rows !== lastRows) {
      lastCols = term.cols
      lastRows = term.rows
      bridge.onResize(term.cols, term.rows)
    }
  }
  window.addEventListener('resize', function () { doFit(false) })

  function b64ToBytes(b64) {
    var bin = atob(b64)
    var out = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  function b64ToText(b64) {
    return new TextDecoder('utf-8').decode(b64ToBytes(b64))
  }

  // Keystrokes typed INTO the terminal (a hardware keyboard, or the soft keyboard when the user
  // taps the terminal itself) go straight to the pane.
  term.onData(function (d) { bridge.onInput(d) })
  term.onBinary(function (d) { bridge.onInput(d) })

  // Copy: tmux's copy-mode emits OSC 52 (set-clipboard on). The whole sequence goes to Kotlin's
  // Osc52.parse, which mirrors the desktop's parseOsc52: the ';' is required, a read query ('?') is
  // refused (write-only), and base64 and UTF-8 are decoded strictly. The one check made here is the
  // size cap (audit A53): xterm accepts OSC payloads up to 10,000,000 characters, and a copy that
  // big must neither cross the bridge nor reach the clipboard's binder call. The cap is Kotlin's
  // own constant, read once over the bridge so there is one definition; Kotlin checks it again.
  var copyLimit = bridge.copyLimit()
  term.parser.registerOscHandler(52, function (data) {
    var idx = data.indexOf(';')
    if (idx < 0) return true
    // The selection field before the ';' is a few letters ('c', 'p', 's0'…); a long one is not a
    // clipboard write we understand, and it must not carry megabytes across the bridge either.
    if (idx > 16) return true // = Osc52.MAX_SELECTION
    if (data.length - idx - 1 > copyLimit) bridge.onCopyTooLarge()
    else bridge.onCopy(data)
    return true
  })

  // Vertical swipe → tmux history scroll.
  var startY = null
  var acc = 0
  host.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) { startY = e.touches[0].clientY; acc = 0 }
  }, { passive: true })
  host.addEventListener('touchmove', function (e) {
    if (startY === null || e.touches.length !== 1) return
    var y = e.touches[0].clientY
    acc += y - startY
    startY = y
    var step = fontSize * 1.4
    var up = 0
    var down = 0
    while (acc > step) { acc -= step; up++ }
    while (acc < -step) { acc += step; down++ }
    if (up) bridge.onScroll(true, up)
    if (down) bridge.onScroll(false, down)
    e.preventDefault()
  }, { passive: false })
  host.addEventListener('touchend', function () { startY = null })

  window.nt = {
    write: function (b64) { term.write(b64ToBytes(b64)) },
    // The attach snapshot: the current screen, painted before live output.
    paint: function (b64) { term.reset(); term.write(b64ToText(b64).replace(/\r?\n/g, '\r\n')) },
    reset: function () { term.reset() },
    focus: function () { term.focus() },
    blur: function () { term.blur() },
    setFontSize: function (n) { fontSize = n; term.options.fontSize = n; doFit(true) },
    refit: function () { doFit(true) },
    // A composed line from the native input bar. `term.paste` frames it as a bracketed paste when
    // the client side asked for one, so a multi-line prompt reaches an agent CLI as ONE paste; the
    // Enter is a separate, slightly later write (an Enter inside the paste write is what left
    // Codex holding a rendered-but-unsubmitted envelope — see CLAUDE.md, settled submit).
    // Special keys from the native key row. Arrows follow the pane's DECCKM state, which this
    // emulator tracks because it parses the very stream the pane writes.
    key: function (name) {
      var app = term.modes.applicationCursorKeysMode
      var csi = app ? '\x1bO' : '\x1b['
      var map = {
        up: csi + 'A', down: csi + 'B', right: csi + 'C', left: csi + 'D',
        home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~',
        esc: '\x1b', tab: '\t', stab: '\x1b[Z', enter: '\r', nl: '\x1b\r'
      }
      var seq = map[name]
      if (seq) bridge.onInput(seq)
    },
    submit: function (b64, enter) {
      var text = b64ToText(b64)
      if (text) term.paste(text)
      if (enter) setTimeout(function () { bridge.onInput('\r') }, text ? 150 : 0)
    }
  }

  setTimeout(function () {
    doFit(true)
    bridge.onReady()
  }, 30)
})()
