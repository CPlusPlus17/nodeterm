package dev.nodeterm.protocol.model

import java.util.concurrent.atomic.AtomicBoolean

/**
 * What of one paired computer the phone is showing right now, for the live notifications (audit A73).
 *
 * The app re-lists the computer whose screen is open every 8 s, and every fresh listing runs the same
 * announce path as the 15-minute background check, except for what the user is looking at:
 *
 * - every event while that computer's Inbox tab is on screen (the tab is where they are listed);
 * - the events of a session open in a terminal (its prompt or its finish is in front of the user).
 *
 * Those are recorded as seen instead of announced ([SeenLog.claimLive]), so no later check (the next
 * refresh, or the background one) announces what the user already saw. Other computers are not
 * polled at all, so nothing here makes their notifications live: theirs still come from the
 * background check only.
 */
data class OnScreen(val inbox: Boolean = false, val nodes: Set<String> = emptySet()) {
    /** The user is looking at [ev]. */
    fun shows(ev: InboxEvent): Boolean = inbox || ev.nodeId in nodes

    /** [events] (a computer's feed) split into what is on screen and what is not; each keeps the feed's order. */
    fun split(events: List<InboxEvent>): Split {
        val (shown, offScreen) = events.partition(::shows)
        return Split(shown, offScreen)
    }

    data class Split(
        /** On screen: recorded as seen, never announced. */
        val shown: List<InboxEvent>,
        /** Not on screen: announced when new ([SeenLog.claimLive] decides). */
        val offScreen: List<InboxEvent>
    )

    companion object {
        /** Nothing of this computer on screen: the app is in the background, or shows something else. */
        val NOTHING = OnScreen()
    }
}

/**
 * The screens showing a computer's Inbox tab or one of its sessions right now. A screen takes a
 * handle when it starts and closes it when it stops. Screens are counted, not flagged, because the
 * next screen can start before the last one stops; closing a handle twice counts once. Thread-safe:
 * the screens register on the main thread and a refresh reads [now] from a background thread.
 */
class OnScreenTracker {
    private var inboxes = 0
    private val nodes = HashMap<String, Int>()

    /** What is on screen at this moment. */
    @Synchronized
    fun now(): OnScreen = if (inboxes == 0 && nodes.isEmpty()) OnScreen.NOTHING else OnScreen(inboxes > 0, nodes.keys.toSet())

    /** The computer's Inbox tab is on screen until the handle is closed. */
    fun showInbox(): AutoCloseable {
        synchronized(this) { inboxes++ }
        return handle { inboxes-- }
    }

    /** The session [nodeId] is open in a terminal until the handle is closed. */
    fun showNode(nodeId: String): AutoCloseable {
        synchronized(this) { nodes[nodeId] = (nodes[nodeId] ?: 0) + 1 }
        return handle {
            val left = (nodes[nodeId] ?: 0) - 1
            if (left > 0) nodes[nodeId] = left else nodes.remove(nodeId)
        }
    }

    private fun handle(release: () -> Unit): AutoCloseable {
        val closed = AtomicBoolean(false)
        return AutoCloseable {
            if (closed.compareAndSet(false, true)) synchronized(this@OnScreenTracker) { release() }
        }
    }
}
