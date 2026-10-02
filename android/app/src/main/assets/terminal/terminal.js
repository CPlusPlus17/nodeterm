// The phone's terminal: xterm.js (the desktop's emulator) as a RENDERER for a tmux client that
// lives on the computer. Android talks to it through two narrow channels:
//   Android → page: window.nt.* functions, called with base64 so no byte ever needs JS escaping;
//   page → Android: window.NodetermBridge (addJavascriptInterface), strings only.
// tmux owns scrolling (its mouse is on and the pane is on the alternate screen), so a vertical
// swipe becomes wheel notches the HOST writes into the pane — exactly what the relay's
// `pty.scroll` does — and xterm keeps no scrollback of its own worth scrolling.
// tmux's mouse also means xterm's own selection never runs (it is off while the pane reports the
// mouse), so links and copying are this page's job (audit A32): a tap on a URL offers to open it,
// and the Copy sheet (`nt.copySheet`) hands the buffer's lines and links to the app.
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
  term.onData(function (d) { cancelScroll(); bridge.onInput(d) })
  term.onBinary(function (d) { cancelScroll(); bridge.onInput(d) })

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

  // Links (audit A32). A URL in the pane's output is matched across the rows it wraps over, the
  // desktop's way: the functions from matchUrlTokens to tokenRange are ported from
  // src/renderer/terminal/file-links.ts and keep its names. tmux repaints, and an agent's fullscreen
  // TUI paints, a long line as separate full-width rows with no wrap flag, so a long OAuth URL matched
  // row by row would open only its first row's fragment. That is why @xterm/addon-web-links is not
  // used: it joins only xterm's own soft wraps. OSC 8 links (a label with the URL hidden in the escape
  // sequence; tmux passes them on because the desktop declares `hyperlinks`) go through
  // term.options.linkHandler. Without one, xterm asks with confirm(), which a WebView without a
  // WebChromeClient never shows, so the link did nothing.
  //
  // Every way in ends at openUrl, which hands the bridge only an http(s) URL, as the URL parser
  // normalizes it. The app asks before it leaves for the browser ("Open <host>?") and checks again.
  var URL_RE = /\bhttps?:\/\/[^\s"'`<>()[\]{}|\\^]+/gi
  var TRAILING_PUNCT = /[.,;:!?'")\]}>]+$/
  /** Rows joined in each direction at most; a wrapped OAuth URL is about 7 rows at 80 columns. */
  var MAX_JOIN_ROWS = 32

  /** The URL as the URL parser writes it, when it is http(s); null for anything else. */
  function httpHref(text) {
    try {
      var u = new URL(text)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
    } catch (e) {
      return null
    }
  }
  function openUrl(raw) {
    var href = httpHref(raw)
    if (href) bridge.openUrl(href)
  }

  function matchUrlTokens(lineText) {
    var out = []
    var re = new RegExp(URL_RE.source, 'gi')
    var m
    while ((m = re.exec(lineText)) !== null) {
      var text = m[0].replace(TRAILING_PUNCT, '')
      if (text.length < 8) continue // "http://x" is the shortest sane URL
      if (!httpHref(text)) continue
      out.push({ text: text, startIndex: m.index, url: text })
    }
    return out
  }

  function bufferView() {
    var buf = term.buffer.active
    return {
      cols: term.cols,
      length: buf.length,
      line: function (row) {
        var l = buf.getLine(row)
        return l ? { isWrapped: l.isWrapped, text: function (trim) { return l.translateToString(trim) } } : undefined
      }
    }
  }

  // Whether `row` runs into `row + 1`: the next row carries xterm's soft-wrap flag, or `row` is full
  // to its last column and the next row starts at column 0 with a non-space (a repainted wrap). A
  // heuristic: the buffer cannot tell a repainted wrap from text that exactly fills the row.
  function continuesOnNextRow(view, row) {
    var next = view.line(row + 1)
    if (!next) return false
    if (next.isWrapped) return true
    var cur = view.line(row)
    if (!cur) return false
    var raw = cur.text(false)
    if (raw.length < view.cols || raw[view.cols - 1] === ' ') return false
    var nextRaw = next.text(false)
    return nextRaw.length > 0 && nextRaw[0] !== ' '
  }

  // The logical paragraph containing `row` (0-based). Every row that continues contributes exactly
  // `cols` characters, so an index into `text` is the cell (startRow + idx / cols, idx % cols); the
  // last row is right-trimmed. One departure from the desktop's: the walk up stops a row earlier, so
  // the MAX_JOIN_ROWS rows joined downward always reach `row`. The desktop's could walk up all 32 and
  // then join only the 32 above `row` (a tap there missed its link), and the Copy sheet's scan below
  // would make no progress through such a wall of full-width rows (a TUI's bordered box draws one).
  function paragraphContaining(view, row) {
    if (!view.line(row)) return null
    var start = row
    while (start > 0 && row - start < MAX_JOIN_ROWS - 1 && continuesOnNextRow(view, start - 1)) start--
    var text = ''
    var r = start
    for (;;) {
      var joins = r - start + 1 < MAX_JOIN_ROWS && continuesOnNextRow(view, r)
      var lineText = view.line(r).text(!joins)
      text += joins ? lineText.padEnd(view.cols).slice(0, view.cols) : lineText
      if (!joins) break
      r++
    }
    return { text: text, startRow: start, rows: r - start + 1 }
  }

  /** An ILink range (1-based, inclusive) for a token at `startIndex..+len` of a paragraph. */
  function tokenRange(startRow, cols, startIndex, len) {
    var endIndex = startIndex + len - 1
    return {
      start: { x: (startIndex % cols) + 1, y: startRow + Math.floor(startIndex / cols) + 1 },
      end: { x: (endIndex % cols) + 1, y: startRow + Math.floor(endIndex / cols) + 1 }
    }
  }

  /**
   * The http(s) URI of the OSC 8 link at a cell, or null. Read through xterm's private
   * `extended.urlId` and `_core._oscLinkService`, as the desktop's osc8UrlAt does: the public buffer
   * API has no hyperlink data. A fresh cell per read: a reused one keeps the previous cell's `extended`.
   */
  function oscLinkUri(urlId) {
    var core = term._core
    var service = core && core._oscLinkService
    var data = urlId && service ? service.getLinkData(urlId) : null
    return data && data.uri && httpHref(data.uri) ? data.uri : null
  }
  function osc8UrlAt(row, col) {
    var line = term.buffer.active.getLine(row)
    var cell = line && line.getCell(col)
    return oscLinkUri(cell && cell.extended ? cell.extended.urlId : 0)
  }

  /** The URL at a buffer cell: an OSC 8 link's, else a URL in the text's paragraph. */
  function linkAt(row, col) {
    var osc8 = osc8UrlAt(row, col)
    if (osc8) return osc8
    var p = paragraphContaining(bufferView(), row)
    if (!p) return null
    var idx = (row - p.startRow) * term.cols + col
    var tokens = matchUrlTokens(p.text)
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i]
      if (idx >= t.startIndex && idx < t.startIndex + t.text.length) return t.url
    }
    return null
  }

  /** The cell (0-based column, 0-based buffer row) under a point in the page, or null. */
  function cellAt(x, y) {
    var screen = term.element && term.element.querySelector('.xterm-screen')
    if (!screen || term.cols <= 0 || term.rows <= 0) return null
    var rect = screen.getBoundingClientRect()
    var dx = x - rect.left
    var dy = y - rect.top
    if (dx < 0 || dy < 0 || dx >= rect.width || dy >= rect.height) return null
    var cw = rect.width / term.cols
    var ch = rect.height / term.rows
    if (cw <= 0 || ch <= 0) return null
    return { col: Math.floor(dx / cw), row: Math.floor(dy / ch) + term.buffer.active.viewportY }
  }

  // A mouse click on a link (a phone with a mouse, while the pane does not report the mouse; xterm's
  // own link handling stands aside when it does). On a touch screen the tap handler below runs first.
  term.registerLinkProvider({
    provideLinks: function (y, callback) {
      var p = paragraphContaining(bufferView(), y - 1)
      if (!p) {
        callback(undefined)
        return
      }
      var links = matchUrlTokens(p.text).map(function (u) {
        return {
          text: u.text,
          range: tokenRange(p.startRow, term.cols, u.startIndex, u.text.length),
          activate: function () { openUrl(u.url) }
        }
      })
      callback(links.length ? links : undefined)
    }
  })
  term.options.linkHandler = {
    activate: function (event, uri) { openUrl(uri) },
    allowNonHttpProtocols: false
  }

  // The Copy sheet (audit A32): the buffer's last SNAPSHOT_ROWS rows (under tmux, the alternate screen
  // has no scrollback, so that is the visible screen), soft wraps joined into one line each, and the
  // http(s) links in them (text URLs joined across wraps as above, and OSC 8 links). The app shows the
  // lines to select, copies or shares them under its clipboard cap, and offers the links.
  var SNAPSHOT_ROWS = 500
  var SNAPSHOT_LINKS = 50
  function snapshot() {
    var buf = term.buffer.active
    var view = bufferView()
    var end = buf.length
    var start = Math.max(0, end - SNAPSHOT_ROWS)
    // A line cut off at the top would start part-way through.
    while (start < end && view.line(start) && view.line(start).isWrapped) start++
    var lines = []
    var firstVisible = 0
    for (var r = start; r < end; r++) {
      var l = view.line(r)
      if (!l) break
      var next = view.line(r + 1)
      var continues = !!(next && next.isWrapped)
      var text = l.text(!continues)
      if (l.isWrapped && lines.length) lines[lines.length - 1] += text
      else lines.push(text)
      if (r === buf.viewportY) firstVisible = lines.length - 1
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    if (firstVisible > lines.length - 1) firstVisible = Math.max(0, lines.length - 1)

    var links = []
    var seen = {}
    for (var row = start; row < end;) {
      var p = paragraphContaining(view, row)
      if (!p) break
      var found = matchUrlTokens(p.text).map(function (t) { return { at: t.startIndex, url: t.url } })
      for (var pr = Math.max(p.startRow, start); pr < p.startRow + p.rows && pr < end; pr++) {
        var line = buf.getLine(pr)
        var last = 0
        for (var x = 0; line && x < term.cols; x++) {
          var cell = line.getCell(x)
          var id = cell && cell.extended ? cell.extended.urlId : 0
          if (id && id !== last) {
            var uri = oscLinkUri(id)
            if (uri) found.push({ at: (pr - p.startRow) * term.cols + x, url: uri })
          }
          last = id
        }
      }
      found.sort(function (a, b) { return a.at - b.at })
      for (var i = 0; i < found.length; i++) {
        var href = httpHref(found[i].url)
        if (href && !Object.prototype.hasOwnProperty.call(seen, href)) {
          seen[href] = true
          links.push(href)
        }
      }
      row = Math.max(row + 1, p.startRow + p.rows)
    }
    if (links.length > SNAPSHOT_LINKS) links = links.slice(links.length - SNAPSHOT_LINKS)
    return { lines: lines, links: links, firstVisible: firstVisible }
  }

  // Vertical swipe → tmux history scroll. A tap (one finger, moved at most TAP_SLOP px) on a link hands
  // it to the app, which offers to open it (audit A32). tmux runs `mouse on`, so the mouse events a tap
  // produces would also reach the pane as a click. On a link the touchend is cancelled, which suppresses them: the click reaches
  // neither tmux nor the app in the pane, and the soft keyboard does not come up. A tap anywhere else
  // is left alone.
  var TAP_SLOP = 10
  var startY = null
  var acc = 0
  var tapX = null
  var tapY = null
  // Stock tmux advances five history rows per wheel notch (measured with the beta's real SSH
  // client). Match the finger's distance to those rows instead of moving five rows for one row
  // of touch movement. A host with custom wheel bindings can have a different scroll distance.
  var WHEEL_ROWS = 5
  var scrollStep = fontSize * 1.4 * WHEEL_ROWS
  var pendingScroll = []
  var scrollFrame = null
  var scrollRequestedAt = 0
  var scrollActive = true
  function cancelScroll() {
    if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame)
    scrollFrame = null
    pendingScroll = []
    acc = 0
    startY = null
    tapX = null
  }
  function scheduleScroll() {
    if (scrollFrame !== null || !pendingScroll.length || !scrollActive) return
    scrollRequestedAt = performance.now()
    scrollFrame = window.requestAnimationFrame(function (time) {
      scrollFrame = null
      // A suspended page must not replay an old swipe after returning or after an input/reset.
      if (time - scrollRequestedAt > 250) { cancelScroll(); return }
      var next = pendingScroll[0]
      if (!next || !scrollActive) return
      // Both transports clamp to 20. Retain the rest and drain one ordered request per frame,
      // including after touchend, rather than silently losing a fast swipe's distance.
      var notches = Math.min(20, next.notches)
      next.notches -= notches
      if (!next.notches) pendingScroll.shift()
      bridge.onScroll(next.up, notches)
      scheduleScroll()
    })
  }
  function queueScroll(up, notches) {
    if (!notches || !scrollActive) return
    var last = pendingScroll[pendingScroll.length - 1]
    if (last && last.up === up) last.notches += notches
    else pendingScroll.push({ up: up, notches: notches })
    scheduleScroll()
  }
  function measuredScrollStep() {
    var screen = term.element && term.element.querySelector('.xterm-screen')
    var rowHeight = screen && term.rows > 0 ? screen.getBoundingClientRect().height / term.rows : 0
    return (rowHeight > 0 && isFinite(rowHeight) ? rowHeight : fontSize * 1.4) * WHEEL_ROWS
  }
  window.addEventListener('pagehide', cancelScroll)
  window.addEventListener('blur', cancelScroll)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') cancelScroll()
  })
  host.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) {
      startY = e.touches[0].clientY
      acc = 0
      // Measure once per gesture; querying layout on every touchmove would force repeated work.
      scrollStep = measuredScrollStep()
      tapX = e.touches[0].clientX
      tapY = e.touches[0].clientY
    } else {
      cancelScroll()
    }
  }, { passive: true })
  host.addEventListener('touchmove', function (e) {
    if (startY === null || e.touches.length !== 1) return
    var y = e.touches[0].clientY
    if (tapX !== null && (Math.abs(e.touches[0].clientX - tapX) > TAP_SLOP || Math.abs(y - tapY) > TAP_SLOP)) tapX = null
    acc += y - startY
    startY = y
    var notches = Math.floor(Math.abs(acc) / scrollStep)
    if (notches) {
      var up = acc > 0
      acc -= (up ? 1 : -1) * notches * scrollStep
      queueScroll(up, notches)
    }
    e.preventDefault()
  }, { passive: false })
  host.addEventListener('touchend', function (e) {
    startY = null
    var x = tapX
    var y = tapY
    tapX = null
    if (x === null || e.touches.length > 0) return
    var cell = cellAt(x, y)
    var url = cell ? linkAt(cell.row, cell.col) : null
    if (!url) return
    e.preventDefault()
    openUrl(url)
  }, { passive: false })
  host.addEventListener('touchcancel', cancelScroll, { passive: true })

  window.nt = {
    write: function (b64) { term.write(b64ToBytes(b64)) },
    // The attach snapshot: the current screen, painted before live output.
    paint: function (b64) { cancelScroll(); term.reset(); term.write(b64ToText(b64).replace(/\r?\n/g, '\r\n')) },
    reset: function () { cancelScroll(); term.reset() },
    cancelScroll: cancelScroll,
    suspendScroll: function () { scrollActive = false; cancelScroll() },
    resumeScroll: function () { scrollActive = true },
    // Native raw chips cancel on this JS thread before their input reaches the host.
    raw: function (b64) { cancelScroll(); bridge.onInput(b64ToText(b64)) },
    focus: function () { term.focus() },
    blur: function () { term.blur() },
    // The ⌨ chip (audit A46): the Kotlin side has just given the WebView Android's focus and asks
    // the system for the soft keyboard; this puts the page's focus on xterm's textarea for it.
    // Blur first: Blink's focus() on the element that already has focus returns early and does
    // nothing, and that is the normal state once the terminal has been tapped. (With focus
    // reporting on, xterm reports a focus-out and a focus-in to the pane for this.)
    focusForKeyboard: function () { term.blur(); term.focus() },
    // The Copy sheet (audit A32): what the buffer holds, as JSON, for the app to show.
    copySheet: function () { bridge.onCopySheet(JSON.stringify(snapshot())) },
    setFontSize: function (n) { cancelScroll(); fontSize = n; term.options.fontSize = n; doFit(true) },
    refit: function () { doFit(true) },
    // A composed line from the native input bar. `term.paste` frames it as a bracketed paste when
    // the client side asked for one, so a multi-line prompt reaches an agent CLI as ONE paste; the
    // Enter is a separate, slightly later write (an Enter inside the paste write is what left
    // Codex holding a rendered-but-unsubmitted envelope — see CLAUDE.md, settled submit).
    // Special keys from the native key row. Arrows follow the pane's DECCKM state, which this
    // emulator tracks because it parses the very stream the pane writes.
    key: function (name) {
      cancelScroll()
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
      cancelScroll()
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
