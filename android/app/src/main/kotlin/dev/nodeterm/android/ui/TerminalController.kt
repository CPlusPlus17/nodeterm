package dev.nodeterm.android.ui

import dev.nodeterm.android.conn.ConnState
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.first
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.TransactionTooLargeException
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.nodeterm.android.AppGraph
import dev.nodeterm.android.conn.HostSession
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.RelayConnectStatus
import dev.nodeterm.protocol.host.NewNode
import dev.nodeterm.protocol.host.NewSessionHint
import dev.nodeterm.protocol.host.PhoneLaunch
import dev.nodeterm.protocol.host.StreamLease
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.host.TerminalStream
import dev.nodeterm.protocol.host.ViewerSlot
import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.Keys
import dev.nodeterm.protocol.model.Launch
import dev.nodeterm.protocol.model.Osc52
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

sealed interface TermState {
    data object Connecting : TermState
    data object Attached : TermState
    data class Ended(val message: String) : TermState
    /** Direct SSH refused this session (not running, or on another host — audit A08/A09); the
     *  relay can open it. Shown with an "Open through the relay" button. */
    data class RelayOffer(val message: String) : TermState
    /** Opening through the relay for the first time: the computer shows this code to approve. */
    data class AwaitingApproval(val sas: String) : TermState
}

/**
 * One terminal screen's plumbing: the WebView running xterm.js on one side, a [TerminalStream] on
 * the other. Output is batched onto the main thread every frame (one `evaluateJavascript` per
 * frame, not per packet); input, resize and scroll go the other way from the JS bridge thread.
 */
class TerminalController(
    private val graph: AppGraph,
    private val session: HostSession,
    private val nodeId: String
) {
    var state by mutableStateOf<TermState>(TermState.Connecting)
        private set
    /** Offered after a COLD attach of an agent node: its resume line (the desktop's cold restore). */
    var resumeOffer by mutableStateOf<Pair<String, String>?>(null)
        private set
    /** A desktop viewer sized the shared pty differently from this screen. */
    var sizedElsewhere by mutableStateOf<Pair<Int, Int>?>(null)
        private set
    var ctrlArmed by mutableStateOf(false)

    /** A one-line message over the terminal (dismissable), e.g. a session the desktop refused to add. */
    var notice by mutableStateOf<String?>(null)

    private val main = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var pageReady = false
    private val pendingJs = ArrayList<String>()
    /**
     * The attach hand-off (audit A40): which attach may still install its stream, and the stream this
     * screen shows. Thread-safe; [stream] is also read on the WebView's bridge thread.
     */
    private val slot = ViewerSlot()
    private val stream: TerminalStream? get() = slot.stream
    private var attachJob: Job? = null
    private var cols = 0
    private var rows = 0
    private var disposed = false

    private val outBuf = ByteArrayOutputStream()
    private var flushScheduled = false
    private val flush = Runnable {
        val data = synchronized(outBuf) {
            flushScheduled = false
            outBuf.toByteArray().also { outBuf.reset() }
        }
        var off = 0
        while (off < data.size) {
            val n = minOf(CHUNK, data.size - off)
            js("nt.write('${b64(data.copyOfRange(off, off + n))}')")
            off += n
        }
    }

    /**
     * One sink per attach, tied to its [ViewerSlot] ticket: a stream this screen no longer shows (a
     * superseded attach, or one a launch still holds after the screen left) must not paint into it,
     * and its exit is not this screen's to report.
     */
    private fun sinkFor(ticket: Long) = object : TerminalSink {
        override fun onPaint(text: String) {
            main.post { if (slot.isCurrent(ticket)) js("nt.paint('${b64(text.toByteArray(Charsets.UTF_8))}')") }
        }

        override fun onOutput(bytes: ByteArray) {
            if (!slot.isCurrent(ticket)) return
            synchronized(outBuf) {
                outBuf.write(bytes)
                if (!flushScheduled) {
                    flushScheduled = true
                    main.postDelayed(flush, 16)
                }
            }
        }

        override fun onResized(cols: Int, rows: Int) {
            main.post {
                if (!slot.isCurrent(ticket)) return@post
                sizedElsewhere = if (cols != this@TerminalController.cols || rows != this@TerminalController.rows) cols to rows else null
            }
        }

        override fun onExit(code: Int?) {
            main.post {
                // Not the stream this screen shows: our own detach on ON_STOP or on leaving (it ends the
                // stream too), or a stream a superseded attach or a launch held. Not a drop to recover from.
                if (!slot.ended(ticket)) return@post
                // exit 0 with the session still running = another client attached with -D and
                // detached us — audit A13. A current desktop no longer does this to a relay-attached
                // phone, but an older desktop does, and any desktop still does it to a phone attached
                // over direct SSH (its client is not one the desktop spawned, so it cannot see it).
                // It is checked, not assumed: a killed session also exits 0.
                if ((code == null || code == 0) && !disposed && autoReattach(requireLive = code == 0)) {
                    state = TermState.Ended(if (code == null) "Disconnected. Reconnecting…" else "Another screen took over this session. Reattaching…")
                } else {
                    state = TermState.Ended(if (code == null) "Disconnected." else "The session ended (exit $code).")
                }
            }
        }
    }

    inner class Bridge {
        @JavascriptInterface
        fun onReady() {
            main.post {
                pageReady = true
                pendingJs.forEach { webView?.evaluateJavascript(it, null) }
                pendingJs.clear()
            }
        }

        @JavascriptInterface
        fun onResize(c: Int, r: Int) {
            main.post {
                if (c <= 0 || r <= 0) return@post
                cols = c
                rows = r
                sizedElsewhere = null
                val s = stream
                if (s != null) s.resize(c, r) else if (!stopped && attachJob == null && state == TermState.Connecting) attach()
            }
        }

        @JavascriptInterface
        fun onInput(data: String) {
            var out = data
            if (ctrlArmed && data.length == 1) {
                Keys.ctrl(data)?.let { out = it }
                main.post { ctrlArmed = false }
            }
            stream?.write(out)
        }

        @JavascriptInterface
        fun onScroll(up: Boolean, notches: Int) {
            val s = stream ?: return
            graph.scope.launch { runCatching { s.scroll(up, notches) } }
        }

        /** The OSC 52 base64 cap terminal.js applies before a copy crosses this bridge (A53). */
        @JavascriptInterface
        fun copyLimit(): Int = Osc52.MAX_BASE64

        /** An OSC 52 terminal.js refused as over [copyLimit]; the payload itself never crossed. */
        @JavascriptInterface
        fun onCopyTooLarge() {
            main.post { toast(COPY_TOO_LARGE, Toast.LENGTH_LONG) }
        }

        /** A whole OSC 52 sequence (`<selection>;<base64>`), parsed here on the bridge thread. */
        @JavascriptInterface
        fun onCopy(data: String) {
            when (val r = Osc52.parse(data)) {
                is Osc52.Result.Copy -> main.post { writeClipboard(r.text) }
                Osc52.Result.TooLarge -> main.post { toast(COPY_TOO_LARGE, Toast.LENGTH_LONG) }
                // A read query, an empty write or a malformed one: the desktop ignores these too.
                Osc52.Result.Ignored, Osc52.Result.Invalid -> Unit
            }
        }
    }

    /**
     * The clipboard write is a binder call into the system server, and a failed one (too large for
     * the shared transaction buffer, or refused) is rethrown here as a RuntimeException. Uncaught,
     * pane output could crash the app (A53); caught, the user is told the copy did not happen.
     */
    private fun writeClipboard(text: String) {
        val ctx = webView?.context ?: return
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (cm == null) {
            toast(COPY_FAILED, Toast.LENGTH_LONG)
            return
        }
        try {
            cm.setPrimaryClip(ClipData.newPlainText("nodeterm", text))
        } catch (e: Exception) {
            val tooLarge = generateSequence<Throwable>(e) { it.cause }.take(8).any { it is TransactionTooLargeException }
            toast(if (tooLarge) COPY_REJECTED_SIZE else COPY_FAILED, Toast.LENGTH_LONG)
            return
        }
        val lines = text.count { it == '\n' } + 1
        toast("Copied $lines line${if (lines == 1) "" else "s"}", Toast.LENGTH_SHORT)
    }

    private fun toast(message: String, length: Int) {
        val ctx = webView?.context ?: return
        Toast.makeText(ctx, message, length).show()
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun createWebView(context: Context): WebView = WebView(context).apply {
        setBackgroundColor(Color.BLACK)
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false // assets stay readable; nothing else on disk is
        settings.allowContentAccess = false
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        addJavascriptInterface(Bridge(), "NodetermBridge")
        webViewClient = object : WebViewClient() {
            // The page never navigates; a link the user taps opens in the browser, outside this bridge.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == "http" || url.scheme == "https") {
                    runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url.toString()))) }
                }
                return true
            }
        }
        loadUrl("file:///android_asset/terminal/index.html")
        webView = this
        js("nt.setFontSize(${graph.hosts.fontSize})")
    }

    private fun js(code: String) {
        val wv = webView ?: return
        if (!pageReady) {
            pendingJs += code
            return
        }
        wv.evaluateJavascript(code, null)
    }

    private var attachedAt = 0L
    private var autoReattaches = 0

    /**
     * A null exit is the CONNECTION going away, not the pane ending. The host connection reconnects
     * on its own; this follows it back into the session instead of leaving "Disconnected" until the
     * user taps Reattach (audit A36). Bounded: three tries per stretch of flapping (a stream that
     * lived a minute resets the count), and only while this screen is showing. Returns false when
     * out of tries.
     */
    private fun autoReattach(requireLive: Boolean = false): Boolean {
        if (System.currentTimeMillis() - attachedAt > 60_000) autoReattaches = 0
        if (autoReattaches >= 3) return false
        autoReattaches++
        graph.scope.launch {
            delay(1_500L * autoReattaches)
            // A re-list notices a dead SSH transport (and drops it) before we ask for a connection,
            // so the attach below does not get the stale one back.
            if (!useRelay || requireLive) session.refreshNow()
            if (requireLive && !session.snapshot.value.isLive(nodeId)) {
                main.post { if (!disposed && stream == null) state = TermState.Ended("The session ended (exit 0).") }
                return@launch
            }
            val up = if (useRelay) true else withTimeoutOrNull(120_000) { session.state.first { it is ConnState.Connected } } != null
            main.post {
                if (disposed || stream != null || attachJob != null) return@post
                if (up) attach() else state = TermState.Ended("Disconnected.")
            }
        }
        return true
    }

    /** Set once the user chose "Open through the relay": later reattaches stay on the relay. */
    private var useRelay = false

    fun openThroughRelay() {
        useRelay = true
        attach()
    }

    fun attach() {
        if (disposed || stopped) return
        state = TermState.Connecting
        resumeOffer = null
        val ticket = slot.begin()
        val sink = sinkFor(ticket)
        attachJob = graph.scope.launch {
            val job = coroutineContext[Job]
            try {
                val conn = if (useRelay) {
                    session.viaRelay { st ->
                        if (st is RelayConnectStatus.AwaitingApproval) main.post { state = TermState.AwaitingApproval(st.sas) }
                    }
                } else {
                    session.ensureConnected()
                }
                val c = if (cols > 0) cols else 80
                val r = if (rows > 0) rows else 24
                // A session this phone is starting: let the host create it in its project, under
                // the chosen account (audit A33).
                val hint = PendingLaunches.peek(nodeId)?.let { NewSessionHint(it.projectId, it.accountId, it.agentId) }
                val s = conn.attach(nodeId, c, r, sink, hint)
                val lease = StreamLease(s) { st -> graph.scope.launch { runCatching { st.detach() } } }
                // The host created this session for the launch just now, and the request is consumed
                // here: the launch holds the stream until it is done, whatever this screen does next
                // (audit A40). Started BEFORE the hand-off, so a screen that already left cannot
                // detach the stream under it.
                val launch = if (hint != null) PendingLaunches.take(nodeId) else null
                if (launch != null) startLaunch(launch, lease, conn)
                // The hand-off re-checks the screen: it may have left, or started a newer attach,
                // since this one began. Then the stream is let go of instead of installed (A40).
                main.post {
                    if (!slot.accept(ticket, lease)) return@post
                    attachedAt = System.currentTimeMillis()
                    state = TermState.Attached
                    if (cols > 0 && (cols != c || rows != r)) s.resize(cols, rows)
                }
                if (launch == null && slot.isCurrent(ticket)) afterAttach(s, conn)
            } catch (e: NeedsRelayException) {
                val msg = e.message ?: "This session opens through the relay."
                main.post {
                    if (!slot.isCurrent(ticket)) return@post
                    state = if (session.hasRelay) TermState.RelayOffer(msg)
                    else TermState.Ended("$msg Remote access isn't set up for this computer, so open it in nodeterm on the computer.")
                }
            } catch (e: Exception) {
                // Includes our own cancel on ON_STOP: the ticket is stale by then, so nothing is shown.
                main.post { if (slot.isCurrent(ticket)) state = TermState.Ended(e.message ?: "Couldn't open the terminal.") }
            } finally {
                // Only this attach's own reference: a newer attach may have replaced it meanwhile.
                main.post { if (attachJob === job) attachJob = null }
            }
        }
    }

    /**
     * A session this phone just started: type its launch line once the shell has settled, THEN put
     * it on the canvas (registering first would let the desktop mount it cold and launch the agent
     * too). Runs in the app scope, not in [attachJob], so neither ON_STOP nor leaving the screen
     * drops it half-done (audit A40).
     */
    private fun startLaunch(launch: LaunchRequest, lease: StreamLease, conn: HostConnection) {
        val register: (suspend () -> Boolean)? = if (conn.capabilities.registerNode) {
            { conn.registerNode(launch.projectId, NewNode(nodeId, launch.title, launch.agentId, launch.accountId)) }
        } else null
        PhoneLaunch.start(graph.scope, lease, launch.command, register) { outcome ->
            // A refusal is an ANSWER (host-service: the session stays open, just unregistered): say
            // so, instead of leaving a session no canvas shows (audit A14).
            if (outcome == PhoneLaunch.Outcome.REFUSED) main.post { notice = UNREGISTERED_NOTICE }
            session.refreshNow()
        }
    }

    private suspend fun afterAttach(s: TerminalStream, conn: HostConnection) {
        val snap = session.snapshot.value
        val node = snap.findNode(nodeId)?.second
        val status = snap.statusOf(nodeId)
        if (s.fresh) {
            // The computer's tmux session was gone (a reboot): the conversation is on disk, not in the
            // pane. Offer the agent's own resume — never type it unasked into a pane we cannot see.
            // Built like the desktop's cold restore: the node's directory, its managed account, the
            // project's permission mode (audit A15/A16) — a relay-created pane starts in $HOME.
            val agent = Agent.of(node?.agentId ?: status?.agentId)
            val sid = status?.sessionId ?: node?.agentSessionId
            val project = snap.findNode(nodeId)?.first
            if (agent != null && sid != null) {
                Launch.resumeLine(agent, sid, snap.status?.settings, node?.accountId, project?.absoluteCwdOf(node), project?.defaultPermissionMode)
                    ?.let { cmd -> main.post { resumeOffer = agent.label to cmd } }
            }
        }
        // Reading a finished session on the phone is a READ: tell the computer (unread clears there,
        // other phones archive the card), exactly what the SSH read-ack file does.
        if (status?.state == AgentState.DONE) {
            val ev = snap.status?.inbox?.events?.lastOrNull { it.nodeId == nodeId && it.kind == InboxKind.DONE && !it.resolved }
            if (ev != null) {
                runCatching { conn.ackRead(nodeId, ev.id) }
                graph.hosts.markSeen(listOf(ev))
            }
        }
    }

    fun acceptResume() {
        val offer = resumeOffer ?: return
        resumeOffer = null
        stream?.write(offer.second + "\r")
    }

    fun dismissResume() {
        resumeOffer = null
    }

    fun fitHere() {
        val s = stream ?: return
        if (cols > 0) s.resize(cols, rows)
        sizedElsewhere = null
    }

    /**
     * Send the input bar's text. An armed Ctrl applies to it (audit A34): the bar goes through
     * xterm's bracketed paste, so the per-keystroke Ctrl in [Bridge.onInput] never saw a single
     * character — arming Ctrl and sending `z` used to submit a literal `z` plus Enter. One character
     * with a control byte is sent as that byte alone, with no Enter (^Z then Enter is not ^Z);
     * anything else just disarms the chip and is sent as typed.
     */
    fun submit(text: String, enter: Boolean) {
        if (ctrlArmed) {
            ctrlArmed = false
            Keys.ctrl(text)?.let {
                raw(it)
                return
            }
        }
        js("nt.submit('${b64(text.toByteArray(Charsets.UTF_8))}', $enter)")
    }

    fun key(name: String) = js("nt.key('$name')")

    fun raw(data: String) {
        stream?.write(data)
    }

    fun focusTerminal() = js("nt.focus()")

    fun setFontSize(size: Int) {
        graph.hosts.fontSize = size
        js("nt.setFontSize(${graph.hosts.fontSize})")
    }

    /** The screen went to the background: detach (the session keeps running on the computer). */
    private var stopped = false

    fun onStop() {
        if (disposed || stopped) return
        stopped = true
        attachJob?.cancel()
        attachJob = null
        // Detaches the stream, unless a launch still holds it: then once that launch is done (A40).
        slot.leave()
        webView?.onPause()
        state = TermState.Connecting
    }

    /** Back in the foreground: reattach where it left off (a first start is the normal attach). */
    fun onStart() {
        if (disposed || !stopped) return
        stopped = false
        webView?.onResume()
        if (stream == null && attachJob == null) attach()
    }

    fun dispose() {
        disposed = true
        // Detaches the stream (after a launch that still holds it, A40), and refuses every attach
        // still on its way. attachJob is deliberately not cancelled: an attach that lands now is
        // let go of by the hand-off, and a session it created still gets its launch.
        slot.close()
        main.removeCallbacks(flush)
        webView?.let {
            it.removeJavascriptInterface("NodetermBridge")
            it.destroy()
        }
        webView = null
    }

    companion object {
        const val UNREGISTERED_NOTICE =
            "The computer didn't add this session to the project, so it won't appear on the canvas. It keeps running; " +
                "end it here when you are done, or find it in nodeterm's session list (the RAM pill) on the computer."
        private const val CHUNK = 192 * 1024
        private val COPY_TOO_LARGE =
            "Too large to copy: nodeterm copies up to %,d characters to the clipboard.".format(Osc52.MAX_TEXT_CHARS)
        private const val COPY_REJECTED_SIZE = "Could not copy: too large for the clipboard."
        private const val COPY_FAILED = "Could not copy to the clipboard."
        private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
}
