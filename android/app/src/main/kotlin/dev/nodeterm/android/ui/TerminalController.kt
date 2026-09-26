package dev.nodeterm.android.ui

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
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
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.host.TerminalStream
import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.Launch
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

    private val main = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var pageReady = false
    private val pendingJs = ArrayList<String>()
    private var stream: TerminalStream? = null
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

    private val sink = object : TerminalSink {
        override fun onPaint(text: String) {
            main.post { js("nt.paint('${b64(text.toByteArray(Charsets.UTF_8))}')") }
        }

        override fun onOutput(bytes: ByteArray) {
            synchronized(outBuf) {
                outBuf.write(bytes)
                if (!flushScheduled) {
                    flushScheduled = true
                    main.postDelayed(flush, 16)
                }
            }
        }

        override fun onResized(cols: Int, rows: Int) {
            main.post { sizedElsewhere = if (cols != this@TerminalController.cols || rows != this@TerminalController.rows) cols to rows else null }
        }

        override fun onExit(code: Int?) {
            main.post {
                stream = null
                state = TermState.Ended(if (code == null) "Disconnected." else "The session ended (exit $code).")
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
                if (s != null) s.resize(c, r) else if (attachJob == null && state == TermState.Connecting) attach()
            }
        }

        @JavascriptInterface
        fun onInput(data: String) {
            var out = data
            if (ctrlArmed && data.length == 1) {
                val ch = data[0].uppercaseChar()
                if (ch in '@'..'_') out = (ch.code - 64).toChar().toString()
                main.post { ctrlArmed = false }
            }
            stream?.write(out)
        }

        @JavascriptInterface
        fun onScroll(up: Boolean, notches: Int) {
            val s = stream ?: return
            graph.scope.launch { runCatching { s.scroll(up, notches) } }
        }

        @JavascriptInterface
        fun onCopy(b64: String) {
            val text = runCatching { String(Base64.decode(b64, Base64.DEFAULT), Charsets.UTF_8) }.getOrNull() ?: return
            main.post {
                val ctx = webView?.context ?: return@post
                val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("nodeterm", text))
                val lines = text.count { it == '\n' } + 1
                Toast.makeText(ctx, "Copied $lines line${if (lines == 1) "" else "s"}", Toast.LENGTH_SHORT).show()
            }
        }
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

    /** Set once the user chose "Open through the relay": later reattaches stay on the relay. */
    private var useRelay = false

    fun openThroughRelay() {
        useRelay = true
        attach()
    }

    fun attach() {
        if (disposed) return
        state = TermState.Connecting
        resumeOffer = null
        attachJob = graph.scope.launch {
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
                val s = conn.attach(nodeId, c, r, sink)
                if (disposed) {
                    s.detach()
                    return@launch
                }
                main.post {
                    stream = s
                    state = TermState.Attached
                    if (cols > 0 && (cols != c || rows != r)) s.resize(cols, rows)
                }
                afterAttach(s, conn)
            } catch (e: NeedsRelayException) {
                val msg = e.message ?: "This session opens through the relay."
                main.post {
                    state = if (session.hasRelay) TermState.RelayOffer(msg)
                    else TermState.Ended("$msg Remote access isn't set up for this computer, so open it in nodeterm on the computer.")
                }
            } catch (e: Exception) {
                main.post { state = TermState.Ended(e.message ?: "Couldn't open the terminal.") }
            } finally {
                main.post { attachJob = null }
            }
        }
    }

    private suspend fun afterAttach(s: TerminalStream, conn: HostConnection) {
        val launch = PendingLaunches.take(nodeId)
        if (launch != null) {
            // A session this phone just started: type its launch line once the shell has settled
            // (a line delivered across the rc-file tty flush comes out mangled), THEN put it on the
            // canvas — registering first would let the desktop mount it cold and launch the agent too.
            delay(900)
            launch.command?.let { s.write(it + "\r") }
            if (conn.capabilities.registerNode) {
                runCatching {
                    conn.registerNode(launch.projectId, NewNode(nodeId, launch.title, launch.agentId, launch.accountId))
                }
            }
            session.refreshNow()
            return
        }
        val snap = session.snapshot.value
        val node = snap.findNode(nodeId)?.second
        val status = snap.statusOf(nodeId)
        if (s.fresh) {
            // The computer's tmux session was gone (a reboot): the conversation is on disk, not in the
            // pane. Offer the agent's own resume — never type it unasked into a pane we cannot see.
            val agent = Agent.of(node?.agentId ?: status?.agentId)
            val sid = status?.sessionId ?: node?.agentSessionId
            if (agent != null && sid != null) {
                Launch.resumeCommand(agent, sid)?.let { cmd -> main.post { resumeOffer = agent.label to cmd } }
            }
        }
        // Reading a finished session on the phone is a READ: tell the computer (unread clears there,
        // other phones archive the card), exactly what the SSH read-ack file does.
        if (status?.state == AgentState.DONE) {
            val ev = snap.status?.inbox?.events?.lastOrNull { it.nodeId == nodeId && it.kind == InboxKind.DONE && !it.resolved }
            if (ev != null) {
                runCatching { conn.ackRead(nodeId, ev.id) }
                graph.hosts.markSeen(listOf(ev.id))
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

    fun submit(text: String, enter: Boolean) {
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

    fun dispose() {
        disposed = true
        val s = stream
        stream = null
        if (s != null) graph.scope.launch { runCatching { s.detach() } }
        main.removeCallbacks(flush)
        webView?.let {
            it.removeJavascriptInterface("NodetermBridge")
            it.destroy()
        }
        webView = null
    }

    companion object {
        private const val CHUNK = 192 * 1024
        private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
}
