package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.OnScreen
import dev.nodeterm.protocol.model.OnScreenTracker
import dev.nodeterm.protocol.model.SeenLog
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * A73: notifications were documented as live every 8 s while a computer is open, but only the
 * 15-minute background check ever posted one; the in-app refresh only updated the listing. Now every
 * fresh listing of a computer runs the one announce path, so notifications are live for the computer
 * whose screen is open, minus what the user is looking at: every event while that computer's Inbox
 * tab is on screen, and the events of the session open in a terminal. Those are recorded as seen, so
 * no later check announces them. Other computers are not polled, and the copy now says so.
 *
 * The decision ([OnScreen], [SeenLog.claimLive]) and the screen bookkeeping ([OnScreenTracker]) are
 * pure and tested here. The wiring (the listing announces, the screens register while started, the
 * copy) cannot run on a JVM, so it is pinned in the app's source ([AppSourcePins]); whether a
 * notification appears on a phone is a device check.
 */
class LiveNotificationsTest {
    private class MemStorage : SeenLog.Storage {
        var raw: String? = null
        var reads = 0
        var writes = 0
        override fun read(): String? = raw.also { reads++ }
        override fun readLegacy(): Set<String>? = null
        override fun write(encoded: String) {
            raw = encoded
            writes++
        }
    }

    private class Clock(var now: Long) : () -> Long {
        override fun invoke(): Long = now
    }

    private val hour = 3_600_000L
    private val t0 = 1_800_000_000_000L

    private fun ev(
        id: String,
        nodeId: String = "n1",
        ts: Long = t0,
        kind: InboxKind = InboxKind.APPROVAL,
        resolved: Boolean = false
    ) = InboxEvent(
        id = id, ts = ts, nodeId = nodeId, agentId = "claude", sessionId = null, kind = kind, title = "t",
        detail = null, interrupted = false, resolved = resolved, options = emptyList(), multiSelect = false, pendingId = null
    )

    private fun ids(events: List<InboxEvent>) = events.map { it.id }

    // --- What is on screen ---------------------------------------------------------------------

    @Test
    fun `with nothing on screen the whole feed may be announced`() {
        val feed = listOf(ev("a", "n1"), ev("b", "n2", kind = InboxKind.DONE))
        val split = OnScreen.NOTHING.split(feed)
        assertEquals(emptyList(), split.shown)
        assertEquals(listOf("a", "b"), ids(split.offScreen))
    }

    @Test
    fun `while the Inbox tab shows, every event of that computer is on screen`() {
        // Questions and approvals are its cards; a finish is in its archive. None is announced.
        val feed = listOf(ev("a", "n1"), ev("q", "n2", kind = InboxKind.QUESTION), ev("d", "n3", kind = InboxKind.DONE))
        val split = OnScreen(inbox = true).split(feed)
        assertEquals(listOf("a", "q", "d"), ids(split.shown))
        assertEquals(emptyList(), split.offScreen)
    }

    @Test
    fun `a session open in a terminal hides only its own events, in feed order`() {
        val feed = listOf(ev("a", "open"), ev("b", "other"), ev("c", "open", kind = InboxKind.DONE), ev("d", "other"))
        val split = OnScreen(nodes = setOf("open")).split(feed)
        assertEquals(listOf("a", "c"), ids(split.shown))
        assertEquals(listOf("b", "d"), ids(split.offScreen))
        assertTrue(OnScreen(nodes = setOf("open")).shows(ev("x", "open")))
        assertFalse(OnScreen(nodes = setOf("open")).shows(ev("x", "other")))
    }

    // --- One check of a fresh listing -----------------------------------------------------------

    @Test
    fun `nothing on screen claims exactly what the background check claims`() {
        val feed = listOf(
            ev("a", ts = t0 - hour),
            ev("old", ts = t0 - SeenLog.ANNOUNCE_WINDOW_MS),
            ev("resolved", resolved = true),
            ev("b", "n2")
        )
        val live = SeenLog(MemStorage(), Clock(t0))
        val background = SeenLog(MemStorage(), Clock(t0))
        assertEquals(ids(background.claimAnnounceable(feed)), ids(live.claimLive(feed, OnScreen.NOTHING, notify = true)))
        assertEquals(listOf("a", "b"), ids(SeenLog(MemStorage(), Clock(t0)).claimLive(feed, OnScreen.NOTHING, notify = true)))
    }

    @Test
    fun `an event shown on the Inbox tab is never announced, by this check or a later one`() {
        val clock = Clock(t0)
        val log = SeenLog(MemStorage(), clock)
        val feed = listOf(ev("a", "n1"), ev("d", "n2", kind = InboxKind.DONE))
        assertEquals(emptyList(), log.claimLive(feed, OnScreen(inbox = true), notify = true))
        // The user left the tab (or the app): the next refresh and the background check stay quiet.
        clock.now += 60_000
        assertEquals(emptyList(), log.claimLive(feed, OnScreen.NOTHING, notify = true))
        assertEquals(emptyList(), log.claimAnnounceable(feed))
        // Something new after that is announced, once.
        val next = feed + ev("b", "n1", ts = clock.now)
        assertEquals(listOf("b"), ids(log.claimLive(next, OnScreen.NOTHING, notify = true)))
        assertEquals(emptyList(), log.claimLive(next, OnScreen.NOTHING, notify = true))
    }

    @Test
    fun `with a terminal open, its session is recorded and another session is announced once`() {
        val clock = Clock(t0)
        val log = SeenLog(MemStorage(), clock)
        val onScreen = OnScreen(nodes = setOf("open"))
        val feed = listOf(ev("mine", "open"), ev("theirs", "other"))
        assertEquals(listOf("theirs"), ids(log.claimLive(feed, onScreen, notify = true)))
        clock.now += 8_000
        assertEquals(emptyList(), log.claimLive(feed, onScreen, notify = true))
        // Back from the terminal: what it showed was seen there.
        assertEquals(emptyList(), log.claimAnnounceable(feed))
        assertTrue(log.isSeen("mine"))
    }

    @Test
    fun `with notifications off nothing is claimed, but what is on screen is still recorded`() {
        val log = SeenLog(MemStorage(), Clock(t0))
        val feed = listOf(ev("shown", "open"), ev("offscreen", "other"))
        assertEquals(emptyList(), log.claimLive(feed, OnScreen(nodes = setOf("open")), notify = false))
        assertTrue(log.isSeen("shown"))
        assertFalse(log.isSeen("offscreen"), "an event nobody saw was spent while notifications were off")
        // Turned on later: only what the user never looked at is announced.
        assertEquals(listOf("offscreen"), ids(log.claimLive(feed, OnScreen.NOTHING, notify = true)))
    }

    @Test
    fun `the 8 s check writes only what is new and could still be announced`() {
        val storage = MemStorage()
        val clock = Clock(t0)
        val log = SeenLog(storage, clock)
        val feed = listOf(
            ev("a", "n1"),
            ev("resolved", "n1", resolved = true),
            ev("old", "n1", ts = t0 - SeenLog.ANNOUNCE_WINDOW_MS)
        )
        assertEquals(emptyList(), log.claimLive(feed, OnScreen(inbox = true), notify = true))
        assertEquals(1, storage.writes)
        assertEquals(setOf("a"), SeenLog.decode(storage.raw!!, clock.now).keys)
        // The same tab, ten refreshes later: nothing new, nothing written, the anchor unmoved.
        repeat(10) {
            clock.now += 8_000
            log.claimLive(feed, OnScreen(inbox = true), notify = true)
        }
        assertEquals(1, storage.writes)
        assertEquals(t0, SeenLog.decode(storage.raw!!, clock.now)["a"])
        // A feed with nothing announceable in it is not even read back.
        val reads = storage.reads
        assertEquals(emptyList(), log.claimLive(listOf(feed[1], feed[2]), OnScreen.NOTHING, notify = true))
        assertEquals(reads, storage.reads)
        assertEquals(1, storage.writes)
    }

    // --- Which screens are showing ----------------------------------------------------------------

    @Test
    fun `screens are counted, so an overlapping start and stop keeps what is still showing`() {
        val tracker = OnScreenTracker()
        assertSame(OnScreen.NOTHING, tracker.now())
        val first = tracker.showInbox()
        val second = tracker.showInbox() // the next screen started before the last one stopped
        first.close()
        assertEquals(OnScreen(inbox = true), tracker.now())
        second.close()
        assertEquals(OnScreen.NOTHING, tracker.now())
    }

    @Test
    fun `a terminal's session is on screen until its last handle closes, and a handle closes once`() {
        val tracker = OnScreenTracker()
        val a = tracker.showNode("n1")
        val b = tracker.showNode("n1")
        val c = tracker.showNode("n2")
        assertEquals(OnScreen(nodes = setOf("n1", "n2")), tracker.now())
        a.close()
        a.close() // twice counts once: n1 is still open through b
        assertEquals(OnScreen(nodes = setOf("n1", "n2")), tracker.now())
        b.close()
        assertEquals(OnScreen(nodes = setOf("n2")), tracker.now())
        c.close()
        assertEquals(OnScreen.NOTHING, tracker.now())
    }

    @Test
    fun `what is reported is a copy, not a live view`() {
        val tracker = OnScreenTracker()
        val h = tracker.showNode("n1")
        val seen = tracker.now()
        h.close()
        assertEquals(setOf("n1"), seen.nodes)
    }

    // --- The wiring, pinned in the app's source -----------------------------------------------------

    private val connections get() = AppSourcePins.app("conn/ConnectionManager.kt")
    private val notifier get() = AppSourcePins.app("notify/InboxNotifier.kt")

    @Test
    fun `every listing that arrives announces, outside the listing's own failure handling`() {
        val refresh = AppSourcePins.blockAfter(connections, "suspend fun refreshNow(")
        // A notification the system refused must not read as a transport failure (that disconnects).
        AppSourcePins.assertInOrder(
            refresh,
            "val listed = try {",
            "c.listProjects().also {",
            "_snapshot.value = it",
            "} catch (e: Exception) {",
            "if (e !is HostException) disconnect()",
            "return",
            "runCatching { graph.announce(hostId, listed, onScreen.now()) }"
        )
        // The 8 s poll re-lists through it.
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(connections, "fun startWatching()"), "refreshNow(trigger)", "delay(POLL_MS)")
        val graph = AppSourcePins.app("NodetermApp.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(graph, "fun announce(hostId: String, snapshot: ProjectsSnapshot, onScreen: OnScreen)"),
            "InboxNotifier.announce(appContext, host, snapshot, onScreen)"
        )
    }

    @Test
    fun `announce decides with what is on screen, and gates only the claim on the switch and permission`() {
        val announce = AppSourcePins.blockAfter(notifier, "fun announce(")
        AppSourcePins.assertInOrder(
            announce,
            "val notify = graph.hosts.notificationsEnabled && canPost(context) && permitted",
            "graph.hosts.claimLive(snapshot.status?.inbox?.events.orEmpty(), onScreen, notify)",
            "nm.notify("
        )
        // An early return on the switch would skip recording what is on screen.
        assertFalse(announce.contains("if (!graph.hosts.notificationsEnabled"), "announce returns before recording what is on screen:\n$announce")
        assertFalse(announce.contains("claimAnnounceable"), "announce ignores what is on screen:\n$announce")
    }

    @Test
    fun `the background check announces through the listing, not from a stale snapshot`() {
        val work = AppSourcePins.blockAfter(notifier, "override suspend fun doWork()")
        assertTrue(work.contains("session.refreshNow(RelayApprovalGate.Trigger.BACKGROUND)"))
        assertFalse(work.contains("InboxNotifier.announce("), "the worker announces a second time, without what is on screen:\n$work")
    }

    @Test
    fun `the Inbox tab and the terminal say what they show while they are started`() {
        val inbox = AppSourcePins.ui("InboxTab.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(inbox, "LifecycleStartEffect(hostId)"),
            "val showing = session.onScreen.showInbox()",
            "onStopOrDispose { showing.close() }"
        )
        // Registered before the watch starts, so the first listing already knows; closed after it stops.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(AppSourcePins.ui("TerminalScreen.kt"), "LifecycleStartEffect(controller)"),
            "val showing = session.onScreen.showNode(nodeId)",
            "session.startWatching()",
            "onStopOrDispose {",
            "session.stopWatching()",
            "showing.close()"
        )
    }

    @Test
    fun `the copy promises live notifications only for the computer on screen`() {
        val promise = "Checked about every 15 minutes in the background, and live for the computer whose screen is open"
        val settings = AppSourcePins.ui("SettingsScreen.kt")
        assertTrue(settings.contains("\"$promise.\""), "Settings does not say what is live")
        assertFalse(settings.contains("live while a computer is open"))
        val kdoc = notifier.replace(Regex("\\s*\\n\\s*\\*\\s*"), " ")
        assertTrue(kdoc.contains("checked about every 15 minutes in the background, and live for the computer whose screen is open"))
        val readme = File(InteropHarness.repoRoot, "android/README.md").readText().replace(Regex("\\s+"), " ")
        assertTrue(readme.contains("checked about every 15 minutes in the background (WorkManager's floor), and live for the computer whose screen is open"))
        assertFalse(readme.contains("live every 8 seconds while a computer is open"))
        assertTrue(readme.contains("Other paired computers are not polled"))
    }
}
