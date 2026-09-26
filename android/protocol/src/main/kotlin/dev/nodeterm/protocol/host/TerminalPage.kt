package dev.nodeterm.protocol.host

/**
 * The terminal screen's page (the WebView running xterm.js), by generation (audit A45).
 *
 * The renderer process behind a WebView can go away on its own: Android kills it to reclaim memory,
 * or it crashes. That WebView can never be used again, so the screen destroys it and builds a new
 * one, which loads a new page. Every page gets a generation from [build], and its bridge callbacks
 * carry it. A callback of a page that is gone (posted to the main thread before the loss, run after
 * it) therefore cannot mark the NEXT page ready ([ready] answers null), and the JavaScript queued for
 * a page that never became ready is dropped with it ([lost]) instead of being replayed into the next.
 *
 * JavaScript for the page goes through [offer]: run it now when the current page is ready, otherwise
 * it waits until that page is. What is offered while there is no page at all (after [lost], before
 * the next [build]) is kept for the next page: a reattach may paint before the replacement exists.
 *
 * Thread-safe. The screen calls it on the main thread; [isCurrent] also from the bridge thread.
 */
class TerminalPage {
    private var generation = 0
    private var ready = false
    private var replacing = false
    private val pending = ArrayList<String>()

    /** The current page has loaded and runs JavaScript as it is offered. */
    val isReady: Boolean
        @Synchronized get() = ready

    /**
     * A page was lost and its replacement has not loaded yet. An attach started now would size the
     * pty from defaults (80×24) instead of from the new page, so the screen waits for [ready].
     */
    val isReplacing: Boolean
        @Synchronized get() = replacing

    /** A new page starts loading (a new WebView). Returns its generation, for its bridge. */
    @Synchronized
    fun build(): Int {
        generation++
        ready = false
        return generation
    }

    /** True while [gen] is the page being shown (or loading): its callbacks count. */
    @Synchronized
    fun isCurrent(gen: Int): Boolean = gen == generation

    /**
     * Page [gen] finished loading. Returns the JavaScript queued for it, in order, to run now (empty
     * when nothing was queued, or when it had already said so), or null when [gen] is a page that is
     * gone: it is not ready, and nothing is handed over.
     */
    @Synchronized
    fun ready(gen: Int): List<String>? {
        if (gen != generation) return null
        if (ready) return emptyList()
        ready = true
        replacing = false
        return pending.toList().also { pending.clear() }
    }

    /** JavaScript for the page: true = run it now; false = queued until the page is ready. */
    @Synchronized
    fun offer(code: String): Boolean {
        if (ready) return true
        pending += code
        return false
    }

    /**
     * The current page's renderer is gone. Its generation is retired (its late callbacks are
     * refused), and what was queued for it is dropped: it was meant for a screen that no longer
     * exists, and the reattach that follows paints the whole screen again.
     */
    @Synchronized
    fun lost() {
        generation++
        ready = false
        replacing = true
        pending.clear()
    }
}

/**
 * What the terminal screen does once its page's renderer is gone (audit A45). Either way a new page
 * is built; the question is only who reattaches the terminal to it.
 *
 * - The system KILLED the renderer (`didCrash` false): nothing is wrong with what the page showed, so
 *   the screen reattaches by itself once the new page is ready. With the renderer's priority waived
 *   while the screen is not visible, this is the normal way a backgrounded terminal loses its page.
 * - The renderer CRASHED: the cause may be what the pane printed, and a reattach paints the same
 *   screen again, so reattaching unasked could crash it over and over. The screen offers "Reopen
 *   terminal" and the user decides.
 * - A kill also falls back to the offer after [maxAutomatic] automatic reattaches within [windowMs]:
 *   a device that keeps killing a visible renderer should not have the app fight it in a loop.
 *
 * Thread-safe; [now] is a millisecond clock supplied by the caller.
 */
class RendererRecovery(private val windowMs: Long = 60_000L, private val maxAutomatic: Int = 2) {
    enum class Action {
        /** Reattach by itself once the new page is ready. */
        REATTACH,

        /** Offer "Reopen terminal"; the user decides when to reattach. */
        OFFER
    }

    private val automatic = ArrayDeque<Long>()

    @Synchronized
    fun onGone(didCrash: Boolean, now: Long): Action {
        if (didCrash) return Action.OFFER
        while (automatic.isNotEmpty() && now - automatic.first() >= windowMs) automatic.removeFirst()
        if (automatic.size >= maxAutomatic) return Action.OFFER
        automatic.addLast(now)
        return Action.REATTACH
    }
}
