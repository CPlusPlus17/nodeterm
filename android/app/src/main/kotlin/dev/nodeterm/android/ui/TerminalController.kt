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
import android.view.Choreographer
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
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
import dev.nodeterm.protocol.host.RendererRecovery
import dev.nodeterm.protocol.host.ResumeOffer
import dev.nodeterm.protocol.host.NewNode
import dev.nodeterm.protocol.host.NewSessionHint
import dev.nodeterm.protocol.host.PhoneLaunch
import dev.nodeterm.protocol.host.StreamLease
import dev.nodeterm.protocol.host.TerminalPage
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.host.TerminalStream
import dev.nodeterm.protocol.host.ViewerSlot
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.InputBar
import dev.nodeterm.protocol.model.Keys
import dev.nodeterm.protocol.model.Osc52
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
    /**
     * The terminal view's renderer crashed, or kept being killed (audit A45). A new view has been
     * built; "Reopen terminal" reattaches to it. Not automatic: see [RendererRecovery].
     */
    data class ViewLost(val message: String) : TermState
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

    /**
     * Input can reach the pane. Read [state], not [stream]: the two change together in one main-thread
     * post, and every caller of this is on the main thread (A41). Anything sent while it is false
     * reached a null stream and was dropped silently.
     */
    val attached: Boolean get() = state == TermState.Attached

    /**
     * Offered after an attach of an agent node: its resume line after a COLD attach (the desktop's
     * cold restore), or its wake line when the session is Sleeping over direct SSH (audit A76).
     * Typed only when the user taps it. See [ResumeOffer].
     *
     * It stays on screen while the stream is down: a reattach of this screen is warm (the cold attach
     * created the session), so an unanswered resume is handed back to [ResumeOffer.afterAttach] as
     * `carried` and kept while the computer still describes that conversation (the A41 review).
     */
    var resumeOffer by mutableStateOf<ResumeOffer?>(null)
        private set

    /**
     * [resumeOffer] was decided by the attach the screen shows now, so a tap may type it. False from
     * the start of every attach until its offer is settled: a carried offer is not typed on the strength
     * of the previous attach while the reattach is still checking it.
     */
    private var resumeSettled by mutableStateOf(false)

    /** The offer's button may be tapped: attached, and the offer settled by this attach. */
    val canResume: Boolean get() = attached && resumeSettled
    /** A desktop viewer sized the shared pty differently from this screen. */
    var sizedElsewhere by mutableStateOf<Pair<Int, Int>?>(null)
        private set
    var ctrlArmed by mutableStateOf(false)

    /** A one-line message over the terminal (dismissable), e.g. a session the desktop refused to add. */
    var notice by mutableStateOf<String?>(null)

    /**
     * Changes each time the WebView is lost with its renderer (audit A45). The screen keys its
     * AndroidView on it, so a change builds a new WebView ([createWebView]) in place of the dead one.
     */
    var webViewKey by mutableStateOf(0)
        private set

    private val main = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    /** The page in [webView], by generation, and the JavaScript waiting for it (A45). */
    private val page = TerminalPage()
    private val recovery = RendererRecovery()
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

    /**
     * The page's side of the bridge, one per page ([gen], from [TerminalPage.build]). A callback of a
     * page whose renderer is gone does nothing (A45): not even one posted just before the loss can
     * mark the replacement page ready, resize the pty from the dead page's size, or type into it.
     */
    inner class Bridge(private val gen: Int) {
        @JavascriptInterface
        fun onReady() {
            main.post {
                val queued = page.ready(gen) ?: return@post
                val wv = webView
                queued.forEach { wv?.evaluateJavascript(it, null) }
                // A replacement page after the renderer was lost (A45): reattach now that it is loaded,
                // unless its first resize below already did. Nothing to do on the first page, whose
                // attach started with the screen.
                attachIfWaiting()
            }
        }

        @JavascriptInterface
        fun onResize(c: Int, r: Int) {
            main.post {
                if (c <= 0 || r <= 0 || !page.isCurrent(gen)) return@post
                cols = c
                rows = r
                sizedElsewhere = null
                val s = stream
                if (s != null) s.resize(c, r) else attachIfWaiting()
            }
        }

        @JavascriptInterface
        fun onInput(data: String) {
            if (!page.isCurrent(gen)) return
            var out = data
            if (ctrlArmed && data.length == 1) {
                Keys.ctrl(data)?.let { out = it }
                main.post { ctrlArmed = false }
            }
            stream?.write(out)
        }

        @JavascriptInterface
        fun onScroll(up: Boolean, notches: Int) {
            if (!page.isCurrent(gen)) return
            val s = stream ?: return
            graph.scope.launch { runCatching { s.scroll(up, notches) } }
        }

        /** The OSC 52 base64 cap terminal.js applies before a copy crosses this bridge (A53). */
        @JavascriptInterface
        fun copyLimit(): Int = Osc52.MAX_BASE64

        /** An OSC 52 terminal.js refused as over [copyLimit]; the payload itself never crossed. */
        @JavascriptInterface
        fun onCopyTooLarge() {
            if (!page.isCurrent(gen)) return
            main.post { toast(COPY_TOO_LARGE, Toast.LENGTH_LONG) }
        }

        /** A whole OSC 52 sequence (`<selection>;<base64>`), parsed here on the bridge thread. */
        @JavascriptInterface
        fun onCopy(data: String) {
            if (!page.isCurrent(gen)) return
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
        val gen = page.build()
        setBackgroundColor(Color.BLACK)
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false // assets stay readable; nothing else on disk is
        settings.allowContentAccess = false
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        // While the screen is not visible (its stream is detached then anyway), Android may reclaim
        // this renderer before the app; onRenderProcessGone below brings the terminal back (A45).
        setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true)
        addJavascriptInterface(Bridge(gen), "NodetermBridge")
        webViewClient = object : WebViewClient() {
            // The page never navigates; a link the user taps opens in the browser, outside this bridge.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == "http" || url.scheme == "https") {
                    runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url.toString()))) }
                }
                return true
            }

            // The renderer was killed or crashed. The default (false) takes the whole app down with
            // it; true keeps the app, which must then stop using this WebView (A45).
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                rendererGone(view, detail.didCrash())
                return true
            }
        }
        loadUrl("file:///android_asset/terminal/index.html")
        // A replacement built while the screen is in the background (A45) is paused like the one it
        // replaces was on ON_STOP; onStart resumes it.
        if (stopped) onPause()
        webView = this
        js("nt.setFontSize(${graph.hosts.fontSize})")
    }

    private fun js(code: String) {
        if (disposed) return
        // Queued until the page is ready, also while there is no page at all: after the renderer was
        // lost, a reattach can paint before the replacement WebView is built (A45).
        if (page.offer(code)) webView?.evaluateJavascript(code, null)
    }

    /**
     * The renderer behind [view] is gone (audit A45): Android killed it to reclaim memory, or it
     * crashed. That WebView can never be used again. The stream is detached (it would paint into
     * nothing), the WebView leaves the view tree and is destroyed, and [webViewKey] changes so the
     * screen builds a new one. Then, per [RendererRecovery] and what the screen was showing: an answer
     * with its own button (ended, disconnected, relay offer, view lost) stays, and nothing reattaches
     * unasked; otherwise the screen reattaches by itself once the new page is ready (a kill), or offers
     * "Reopen terminal" (a crash, or kills in a loop).
     */
    private fun rendererGone(view: WebView, didCrash: Boolean) {
        // A view this screen already let go of (a repeated callback, or one after dispose).
        if (view !== webView) return
        // Read before anything below changes it.
        val showing = showing(state)
        webView = null
        page.lost()
        // Detached as on ON_STOP. A launch still holding the stream finishes first (A40), and the
        // stream's exit is not reported: its ticket is retired.
        attachJob?.cancel()
        attachJob = null
        slot.leave()
        main.removeCallbacks(flush)
        synchronized(outBuf) {
            outBuf.reset()
            flushScheduled = false
        }
        // The dead page's size. The new page reports its own before it reattaches.
        cols = 0
        rows = 0
        sizedElsewhere = null
        destroyWebView(view, rendererAlive = false)
        webViewKey++
        when (val outcome = recovery.onGone(didCrash, System.currentTimeMillis(), showing)) {
            // The screen keeps its answer, and its button reattaches once the new page is ready
            // (attachWhenPageReady). Moving it to Connecting would attach unasked: over the relay, to
            // a pane that exited, that creates a new, empty session.
            RendererRecovery.Outcome.Keep -> Unit
            // Reattached by attachIfWaiting once the new page reports in (or by onStart, when the
            // screen is in the background now).
            RendererRecovery.Outcome.Reattach -> state = TermState.Connecting
            is RendererRecovery.Outcome.Offer -> state = TermState.ViewLost(outcome.message)
        }
    }

    /**
     * What [st] tells [RendererRecovery] (A45). Exhaustive on purpose: a new state has to say whether
     * an attach is in flight behind it, and whether the screen knew the session was running.
     */
    private fun showing(st: TermState): RendererRecovery.Showing = when (st) {
        TermState.Attached -> RendererRecovery.Showing.ATTACHED
        // An attach in flight (the loss retires it), or waiting for a page or for onStart. The code of
        // a retired approval dial is not kept: nothing would be behind it, and it has no button.
        TermState.Connecting, is TermState.AwaitingApproval -> RendererRecovery.Showing.OPENING
        is TermState.Ended, is TermState.RelayOffer, is TermState.ViewLost -> RendererRecovery.Showing.SETTLED
    }

    /**
     * Take [view] out of the view tree, then destroy it: WebView.destroy() expects a view that is no
     * longer attached. A view whose renderer is gone is not used for anything else.
     */
    private fun destroyWebView(view: WebView, rendererAlive: Boolean) {
        (view.parent as? ViewGroup)?.removeView(view)
        if (rendererAlive) view.removeJavascriptInterface("NodetermBridge")
        view.destroy()
    }

    /**
     * Attach if the screen is waiting to: started, nothing attached or attaching, and "Opening
     * terminal…" showing. Run when the page reports its size or that it is ready, which is how a
     * replacement page after a renderer loss gets its terminal back (A45).
     */
    private fun attachIfWaiting() {
        if (!disposed && !stopped && stream == null && attachJob == null && state == TermState.Connecting) attach()
    }

    /**
     * Attach now or, while a replacement page is still loading after a renderer loss (A45), once it
     * has reported its size ([attachIfWaiting]): attaching before would claim the pty at 80×24.
     */
    private fun attachWhenPageReady() {
        if (page.isReplacing) state = TermState.Connecting else attach()
    }

    /** "Reopen terminal", after the view was lost with its renderer (A45). */
    fun reopenTerminal() {
        if (state is TermState.ViewLost) attachWhenPageReady()
    }

    /**
     * "Reattach", from an ended or disconnected session. Through [attachWhenPageReady]: the screen
     * keeps this answer over a page that is being replaced after a renderer loss (A45 review).
     */
    fun reattach() {
        if (state is TermState.Ended) attachWhenPageReady()
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
                main.post {
                    if (!disposed && stream == null && state !is TermState.ViewLost) state = TermState.Ended("The session ended (exit 0).")
                }
                return@launch
            }
            val up = if (useRelay) true else withTimeoutOrNull(120_000) { session.state.first { it is ConnState.Connected } } != null
            main.post {
                // The view was lost meanwhile and is waiting for the user's "Reopen terminal" (A45).
                if (disposed || stream != null || attachJob != null || state is TermState.ViewLost) return@post
                if (up) attachWhenPageReady() else state = TermState.Ended("Disconnected.")
            }
        }
        return true
    }

    /** Set once the user chose "Open through the relay": later reattaches stay on the relay. */
    private var useRelay = false

    fun openThroughRelay() {
        if (state !is TermState.RelayOffer) return
        useRelay = true
        // The offer can be on screen over a page being replaced (A45 review): wait for its size.
        attachWhenPageReady()
    }

    /** Attach now. The screen's buttons go through [attachWhenPageReady] ([reattach], [openThroughRelay]). */
    private fun attach() {
        if (disposed || stopped) return
        state = TermState.Connecting
        // The offer stays on screen (A41 review): this attach settles it, keeping an unanswered
        // resume or dropping it (afterAttach). Until then it cannot be typed.
        resumeSettled = false
        val ticket = slot.begin()
        val sink = sinkFor(ticket)
        attachJob = graph.scope.launch {
            val job = coroutineContext[Job]
            try {
                val conn = if (useRelay) {
                    session.viaRelay { st ->
                        // A superseded attach's dial must not put its code over the current screen.
                        if (st is RelayConnectStatus.AwaitingApproval) main.post { if (slot.isCurrent(ticket)) state = TermState.AwaitingApproval(st.sas) }
                    }
                } else {
                    session.ensureConnected()
                }
                val c = if (cols > 0) cols else 80
                val r = if (rows > 0) rows else 24
                // A session this phone is starting: let the host create it in its project, under
                // the chosen account (audit A33).
                val hint = PendingLaunches.peek(nodeId)?.let { NewSessionHint(it.projectId, it.accountId, it.agentId) }
                // ON_STOP cancels this job so nothing keeps connecting, or waiting for an approval,
                // behind a screen nobody sees. That stops here: a screen that left before the attach
                // went out sends nothing (a pending launch stays for its next attach). From the
                // request on, nothing is cancelled: the host may already be creating the session and
                // has reserved a viewer on it, and only a stream that arrives can be let go of (the
                // hand-off below) and hand its launch on. A cancelled attach dropped both (audit A40).
                ensureActive()
                val (s, launch) = withContext(NonCancellable) {
                    val s = conn.attach(nodeId, c, r, sink, hint)
                    val lease = StreamLease(s) { st -> graph.scope.launch { runCatching { st.detach() } } }
                    // The host created this session for the launch just now, and the request is
                    // consumed here: the launch holds the stream until it is done, whatever this
                    // screen does next (audit A40). Started BEFORE the hand-off, so a screen that
                    // already left cannot detach the stream under it.
                    val launch = if (hint != null) PendingLaunches.take(nodeId) else null
                    if (launch != null) startLaunch(launch, lease, conn)
                    // The hand-off re-checks the screen: it may have left, or started a newer attach,
                    // since this one began. Then the stream is let go of instead of installed (A40).
                    main.post {
                        if (!slot.accept(ticket, lease)) return@post
                        attachedAt = System.currentTimeMillis()
                        state = TermState.Attached
                        // A session started for a launch types its own line: nothing to offer.
                        if (launch != null) resumeOffer = null
                        if (cols > 0 && (cols != c || rows != r)) s.resize(cols, rows)
                    }
                    s to launch
                }
                if (launch == null && slot.isCurrent(ticket)) afterAttach(s, conn, ticket)
            } catch (e: NeedsRelayException) {
                val msg = e.message ?: "This session opens through the relay."
                main.post {
                    if (!slot.isCurrent(ticket)) return@post
                    state = if (session.hasRelay) TermState.RelayOffer(msg)
                    else TermState.Ended("$msg Remote access isn't set up for this computer, so open it in nodeterm on the computer.")
                }
            } catch (e: Exception) {
                // Includes our own cancel on ON_STOP (while connecting, or in afterAttach): the ticket
                // is stale by then, so nothing is shown.
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

    private suspend fun afterAttach(s: TerminalStream, conn: HostConnection, ticket: Long) {
        // A resume carried through a warm reattach is checked against what the computer says NOW:
        // the listing from before the drop cannot show a CLI started in the pane meanwhile. (Read
        // here only to decide on the re-list; the carry itself reads the offer again on main.)
        if (!s.fresh && resumeOffer?.kind == ResumeOffer.Kind.RESUME) session.refreshNow()
        val snap = session.snapshot.value
        val status = snap.statusOf(nodeId)
        // A cold pane (a reboot) gets the agent's own resume, built like the desktop's cold restore
        // (A15/A16); a Sleeping one over direct SSH gets the desktop's wake line, since nothing tells
        // the desktop about an SSH attach (A76). Over the relay the attach itself asks the desktop to
        // wake it, so nothing is offered there. Never typed unasked into a pane we cannot see.
        main.post {
            // Only for the attach the screen still shows: a newer one settles the offer itself.
            if (!slot.isCurrent(ticket)) return@post
            // The offer still on screen is carried: one the user answered or dismissed is not.
            resumeOffer = ResumeOffer.afterAttach(s.fresh, conn.kind, snap, nodeId, carried = resumeOffer)
            resumeSettled = true
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
        // Not attached (the stream dropped under the offer), or a reattach is still settling it: keep
        // it rather than spend it on nothing. The reattach keeps it or drops it (see [resumeOffer]).
        if (!canResume) return
        resumeOffer = null
        // Re-asked at the tap (A76): the desktop may have woken the session since the offer appeared,
        // and a wake line typed into that CLI would arrive as a prompt.
        if (!offer.stillOffered(session.snapshot.value, nodeId)) {
            notice = "This session is no longer sleeping on the computer, so nothing was typed."
            return
        }
        stream?.write(offer.keys)
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
     * Send the input bar's text, as [InputBar.plan] says. An armed Ctrl applies to it (audit A34): the
     * bar goes through xterm's bracketed paste, so the per-keystroke Ctrl in [Bridge.onInput] never saw
     * a single character — arming Ctrl and sending `z` used to submit a literal `z` plus Enter. One
     * character with a control byte is sent as that byte alone, with no Enter (^Z then Enter is not
     * ^Z); anything else just disarms the chip and is sent as typed.
     *
     * Returns whether the text went to the attached stream. False while nothing is attached: nothing
     * is sent, Ctrl stays armed, and the caller keeps its draft (A41 — it used to clear it).
     */
    fun submit(text: String, enter: Boolean): Boolean {
        when (val send = InputBar.plan(attached, ctrlArmed, text, enter)) {
            InputBar.Send.NotAttached -> return false
            is InputBar.Send.Control -> {
                ctrlArmed = false
                raw(send.bytes)
            }
            is InputBar.Send.Paste -> {
                ctrlArmed = false
                js("nt.submit('${b64(send.text.toByteArray(Charsets.UTF_8))}', ${send.enter})")
            }
        }
        return true
    }

    /** A key-row key. Nothing while not [attached]: the key row shows disabled then (A41). */
    fun key(name: String) {
        if (attached) js("nt.key('$name')")
    }

    /** Raw bytes (the ^C/^D/^R/^L chips). Nothing while not [attached] (A41). */
    fun raw(data: String) {
        if (attached) stream?.write(data)
    }

    /**
     * The ⌨ chip: bring up the soft keyboard to type straight into the terminal (audit A46). It used
     * to run only `term.focus()` in the page, which cannot do that: Blink ignores focus() on the
     * element that already has focus (the textarea, once the terminal was tapped), and the keyboard
     * attaches to the focused Android view, which is the input bar's text field or nothing. The
     * caller releases Compose's focus first, so that field lets go of the keyboard. Here, in order:
     * the WebView takes Android's focus, the page moves its focus onto xterm's textarea
     * (`nt.focusForKeyboard`, which blurs first), and the keyboard is asked for through
     * InputMethodManager, which does not depend on the page having seen a touch since it loaded.
     *
     * That request waits for the next frame and then one more main-thread turn. The input method
     * serves the newly focused view only once its focus change has been processed, and the text
     * field that lost focus can hide the keyboard from a frame callback rather than at once
     * (Compose's text input has queued its keyboard commands to the next frame): asked for before
     * either, the keyboard would not come up, or would be hidden again straight away. None of this
     * has run on a device.
     */
    fun showKeyboard() {
        val wv = webView ?: return
        wv.requestFocus()
        js("nt.focusForKeyboard()")
        Choreographer.getInstance().postFrameCallback {
            wv.post {
                // The view was replaced (renderer lost, A45) or the screen left meanwhile.
                if (webView !== wv) return@post
                val imm = wv.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                imm?.showSoftInput(wv, InputMethodManager.SHOW_IMPLICIT)
            }
        }
    }

    fun setFontSize(size: Int) {
        graph.hosts.fontSize = size
        js("nt.setFontSize(${graph.hosts.fontSize})")
    }

    /** The screen went to the background: detach (the session keeps running on the computer). */
    private var stopped = false

    fun onStop() {
        if (disposed || stopped) return
        stopped = true
        // Stops a connect or an approval wait; an attach already sent still lands, and is let go of
        // by the hand-off (see attach(), A40). onStart begins its own.
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
        // As from every other state, coming back reattaches, including after a view loss (A45).
        if (stream == null && attachJob == null) attachWhenPageReady()
    }

    fun dispose() {
        disposed = true
        // Detaches the stream (after a launch that still holds it, A40), and refuses every attach
        // still on its way. attachJob is deliberately not cancelled: an attach that lands now is
        // let go of by the hand-off, and a session it created still gets its launch.
        slot.close()
        main.removeCallbacks(flush)
        webView?.let { destroyWebView(it, rendererAlive = true) }
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
