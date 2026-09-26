package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.SeenLog
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Audit A48: each Inbox event is announced once — no hash-order eviction, no lost update. */
class SeenLogTest {
    private class MemStorage(var raw: String? = null, var legacy: Set<String>? = null) : SeenLog.Storage {
        var writes = 0
        override fun read(): String? = raw
        override fun readLegacy(): Set<String>? = legacy
        override fun write(encoded: String) {
            raw = encoded
            legacy = null
            writes++
        }
    }

    private class Clock(var now: Long) : () -> Long {
        override fun invoke(): Long = now
    }

    private val hour = 3_600_000L
    private val t0 = 1_800_000_000_000L

    private fun ev(id: String, ts: Long, resolved: Boolean = false, kind: InboxKind = InboxKind.APPROVAL) = InboxEvent(
        id = id, ts = ts, nodeId = "n1", agentId = "claude", sessionId = null, kind = kind, title = "t",
        detail = null, interrupted = false, resolved = resolved, options = emptyList(), multiSelect = false, pendingId = null
    )

    private fun stored(storage: MemStorage, now: Long): Map<String, Long> = SeenLog.decode(storage.raw ?: "{}", now)

    @Test
    fun `an event is claimed once, and a read one is never claimed`() {
        val clock = Clock(t0)
        val log = SeenLog(MemStorage(), clock)
        log.markSeen(listOf(ev("read", t0 - hour)))
        val feed = listOf(ev("read", t0 - hour), ev("a", t0 - hour), ev("b", t0))
        assertEquals(listOf("a", "b"), log.claimAnnounceable(feed).map { it.id })
        clock.now += 60_000
        assertEquals(emptyList(), log.claimAnnounceable(feed))
        assertTrue(log.isSeen("a") && log.isSeen("b") && log.isSeen("read"))
    }

    @Test
    fun `only unresolved events inside the announce window are claimed`() {
        val log = SeenLog(MemStorage(), Clock(t0))
        val feed = listOf(
            ev("old", t0 - SeenLog.ANNOUNCE_WINDOW_MS),
            ev("resolved", t0 - hour, resolved = true),
            ev("recent", t0 - SeenLog.ANNOUNCE_WINDOW_MS + 1),
            ev("ahead", t0 + 3 * hour),
            ev("ancient", Long.MIN_VALUE)
        )
        assertEquals(listOf("recent", "ahead"), log.claimAnnounceable(feed).map { it.id })
        assertFalse(log.isSeen("old"))
        assertFalse(log.isSeen("resolved"))
    }

    @Test
    fun `a busy phone never evicts an event that could still be announced`() {
        // The old trim kept `takeLast(500)` of a HashSet: the 501st id evicted an arbitrary one.
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        val first = ev("first", t0)
        assertEquals(1, log.claimAnnounceable(listOf(first)).size)
        for (i in 0 until 1_000) {
            clock.now = t0 + i * 1_000L
            log.markSeen(listOf(ev("e$i", clock.now)))
        }
        clock.now = t0 + 5 * hour
        assertEquals(emptyList(), log.claimAnnounceable(listOf(first)), "re-announced a still-eligible event")
        assertEquals(1_001, stored(storage, clock.now).size)
    }

    @Test
    fun `entries age out one retention period after their anchor`() {
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        log.markSeen(listOf(ev("a", t0 - hour)))
        clock.now = t0 + SeenLog.RETENTION_MS
        log.markSeen(listOf(ev("b", clock.now)))
        assertEquals(setOf("a", "b"), stored(storage, clock.now).keys, "pruned at the boundary")
        clock.now += 1
        log.markSeen(listOf(ev("c", clock.now)))
        assertEquals(setOf("b", "c"), stored(storage, clock.now).keys)
    }

    @Test
    fun `a desktop clock running ahead keeps its event until the event itself is too old`() {
        // Seen at t0, but the event is stamped 20 h ahead: it stays announceable until ts + 6 h,
        // i.e. t0 + 26 h, past t0 + RETENTION (24 h). The anchor must carry the event's ts.
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        val ahead = ev("ahead", t0 + 20 * hour)
        assertEquals(1, log.claimAnnounceable(listOf(ahead)).size)
        clock.now = t0 + 25 * hour
        log.markSeen(listOf(ev("other", clock.now)))
        assertTrue(SeenLog.announceable(ahead, clock.now))
        assertEquals(emptyList(), log.claimAnnounceable(listOf(ahead)))
    }

    @Test
    fun `seeing an event again moves its anchor forward, never back`() {
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        log.markSeen(listOf(ev("a", t0 + 10 * hour)))
        clock.now = t0 + hour
        log.markSeen(listOf(ev("a", t0 + 10 * hour)))
        assertEquals(t0 + 10 * hour, stored(storage, clock.now)["a"])
        clock.now = t0 + 12 * hour
        log.markSeen(listOf(ev("a", t0 + 10 * hour)))
        assertEquals(t0 + 12 * hour, stored(storage, clock.now)["a"])
    }

    @Test
    fun `the pre-A48 id set migrates as seen now, announces nothing, then ages out`() {
        val clock = Clock(t0)
        val storage = MemStorage(legacy = setOf("a", "b"))
        val log = SeenLog(storage, clock)
        val feed = listOf(ev("a", t0 - hour), ev("b", t0 - 2 * hour), ev("c", t0))
        assertEquals(listOf("c"), log.claimAnnounceable(feed).map { it.id })
        assertNull(storage.legacy, "the legacy set is dropped in the same write")
        assertEquals(mapOf("a" to t0, "b" to t0, "c" to t0), stored(storage, t0))
        clock.now = t0 + SeenLog.RETENTION_MS + 1
        log.markSeen(listOf(ev("d", clock.now)))
        assertEquals(setOf("d"), stored(storage, clock.now).keys)
    }

    @Test
    fun `a legacy set is migrated by a read too, once`() {
        val storage = MemStorage(legacy = setOf("a"))
        val log = SeenLog(storage, Clock(t0))
        assertTrue(log.isSeen("a"))
        assertTrue(log.isSeen("a"))
        assertEquals(1, storage.writes)
        assertNull(storage.legacy)
    }

    @Test
    fun `an unreadable log is empty and an unreadable time counts as seen now`() {
        assertEquals(emptyMap(), SeenLog.decode("not json", t0))
        assertEquals(emptyMap(), SeenLog.decode("[1,2]", t0))
        assertEquals(mapOf("a" to 5L, "b" to t0), SeenLog.decode("""{"a":5,"b":"x"}""", t0))
        assertEquals(mapOf("a" to 5L, "b" to t0), SeenLog.decode(SeenLog.encode(mapOf("a" to 5L, "b" to t0)), t0))
    }

    @Test
    fun `the memory backstop drops the oldest anchors, not arbitrary ones`() {
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock, maxEntries = 3)
        for (i in 0 until 5) {
            clock.now = t0 + i * 1_000L
            log.markSeen(listOf(ev("e$i", clock.now)))
        }
        assertEquals(setOf("e2", "e3", "e4"), stored(storage, clock.now).keys)
    }

    @Test
    fun `concurrent callers do not lose each other's writes`() {
        // Deterministic: the first read waits (briefly) for a second reader. Without the lock the
        // second caller reads the same state and one write overwrites the other; with it the second
        // caller is still waiting for the lock, so the first times out, writes, and the second
        // reads that write.
        val storage = object : SeenLog.Storage {
            @Volatile var raw: String? = null
            val readers = CountDownLatch(2)
            val reads = AtomicInteger()
            override fun read(): String? {
                if (reads.incrementAndGet() <= 2) {
                    readers.countDown()
                    readers.await(500, TimeUnit.MILLISECONDS)
                }
                return raw
            }
            override fun readLegacy(): Set<String>? = null
            override fun write(encoded: String) {
                raw = encoded
            }
        }
        val log = SeenLog(storage, { t0 })
        val a = thread { log.markSeen(listOf(ev("a", t0))) }
        val b = thread { log.markSeen(listOf(ev("b", t0))) }
        a.join()
        b.join()
        assertEquals(setOf("a", "b"), SeenLog.decode(storage.raw!!, t0).keys)
    }
}
