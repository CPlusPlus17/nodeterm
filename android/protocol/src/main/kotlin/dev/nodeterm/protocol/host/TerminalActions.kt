package dev.nodeterm.protocol.host

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext

/**
 * The input order for one installed viewer. Relay scrolls await an RPC, so launching one coroutine
 * per gesture can reorder a reversal or let Esc overtake a scroll that later re-enters copy mode.
 * There is one drain, and its lifetime belongs to this stream, never a replacement viewer.
 */
class TerminalActions(
    scope: CoroutineScope,
    private val stream: TerminalStream,
    private val isCurrent: () -> Boolean,
) {
    private sealed interface Action {
        class Scroll(val up: Boolean, var notches: Int) : Action
        class Input(val data: String) : Action
    }

    private val lock = Any()
    private val pending = ArrayDeque<Action>()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var closed = false
    // Include the currently awaited scroll / write in the budgets.
    private var scrollNotches = 0
    private var inputChars = 0

    private val drain = scope.launch {
        try {
            for (signal in wake) {
                while (true) {
                    coroutineContext.ensureActive()
                    val action = synchronized(lock) {
                        if (closed || !isCurrent()) {
                            retireLocked()
                            null
                        } else when (val head = pending.firstOrNull()) {
                            is Action.Scroll -> {
                                // Leave unsent distance at the front: write() can cancel it even
                                // while this chunk's RPC is suspended. No host receives >20.
                                val chunk = minOf(head.notches, MAX_SCROLL_CALL)
                                head.notches -= chunk
                                if (head.notches == 0) pending.removeFirst()
                                Action.Scroll(head.up, chunk)
                            }
                            is Action.Input -> pending.removeFirst()
                            null -> null
                        }
                    } ?: break
                    coroutineContext.ensureActive()
                    if (!isCurrent()) break
                    try {
                        when (action) {
                            is Action.Scroll -> stream.scroll(action.up, action.notches)
                            is Action.Input -> stream.write(action.data)
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        // A timed-out/refused relay RPC need not disconnect the transport. Do
                        // not retry uncertain movement, but keep explicit input usable (Esc).
                        synchronized(lock) { if (!closed && action is Action.Scroll) discardScrollLocked() }
                    }
                    synchronized(lock) {
                        if (!closed) when (action) {
                            is Action.Scroll -> scrollNotches -= action.notches
                            is Action.Input -> inputChars -= action.data.length
                        }
                    }
                }
                if (synchronized(lock) { closed || !isCurrent() }) break
            }
        } finally {
            synchronized(lock) { retireLocked() }
        }
    }

    /** False means the caller must report busy rather than silently discard a gesture. */
    fun scroll(up: Boolean, notches: Int): Boolean = synchronized(lock) {
        if (closed || !drain.isActive || !isCurrent()) return false
        if (notches <= 0) return false
        if (notches > MAX_SCROLL_NOTCHES - scrollNotches) return false
        val tail = pending.lastOrNull()
        if (tail is Action.Scroll && tail.up == up) {
            tail.notches += notches
        } else {
            if (pending.size >= MAX_PENDING_RUNS) return false
            pending.addLast(Action.Scroll(up, notches))
        }
        scrollNotches += notches
        wake.trySend(Unit)
        true
    }

    /**
     * Input is a scroll barrier: discard unsent gestures, preserving already accepted input and
     * the single in-flight RPC. Esc is then the next operation after that RPC, with no late scroll
     * from this gesture left to put tmux back into copy mode.
     */
    fun write(data: String): Boolean = addInput(data, cancelScroll = true)

    /** Automatic emulator replies (DSR/DA etc.) are ordered writes, never gesture barriers. */
    fun report(data: String): Boolean = addInput(data, cancelScroll = false)

    private fun addInput(data: String, cancelScroll: Boolean): Boolean = synchronized(lock) {
        if (closed || !drain.isActive || !isCurrent()) return false
        if (data.isEmpty()) return true
        val retainedRuns = if (cancelScroll) pending.count { it is Action.Input } else pending.size
        if (retainedRuns >= MAX_PENDING_RUNS || data.length > MAX_INPUT_CHARS - inputChars) return false
        if (cancelScroll) discardScrollLocked()
        pending.addLast(Action.Input(data))
        inputChars += data.length
        wake.trySend(Unit)
        true
    }

    /** Retire before leaving, replacing, or destroying the viewer. Idempotent. */
    fun close() {
        synchronized(lock) { retireLocked() }
        drain.cancel()
    }

    private fun retireLocked() {
        closed = true
        pending.clear()
        scrollNotches = 0
        inputChars = 0
        wake.close()
    }

    private fun discardScrollLocked() {
        val iterator = pending.iterator()
        while (iterator.hasNext()) {
            val action = iterator.next()
            if (action is Action.Scroll) {
                scrollNotches -= action.notches
                iterator.remove()
            }
        }
    }

    companion object {
        private const val MAX_PENDING_RUNS = 64
        private const val MAX_SCROLL_NOTCHES = 320
        private const val MAX_INPUT_CHARS = 1024 * 1024
        private const val MAX_SCROLL_CALL = 20
    }
}
