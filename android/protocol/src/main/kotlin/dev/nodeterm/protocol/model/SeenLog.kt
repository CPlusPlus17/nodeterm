package dev.nodeterm.protocol.model

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Which Inbox events this phone has already announced or read (phone-local, like iOS), so the
 * background check notifies each event once (audit A48).
 *
 * The first version kept a bare id set and trimmed it with `(set + ids).toList().takeLast(500)`.
 * The set came back from SharedPreferences as a `HashSet`, whose order is hash order, so past 500
 * entries every new id evicted an ARBITRARY old one — and an evicted id whose event was still
 * unresolved and inside the announce window was announced again. Its read-modify-write was also
 * unlocked while the worker, the terminal screen and the Inbox tab all called it.
 *
 * What is kept instead: id → an ANCHOR time, the latest of when the phone saw the event and the
 * event's own `ts`. An entry is pruned only when its anchor is more than [RETENTION_MS] old — the
 * announce window plus a margin — and an event stops being announceable [ANNOUNCE_WINDOW_MS] after
 * its `ts` on the same (phone) clock. Since the anchor is never earlier than `ts`, an entry cannot
 * be pruned while its event could still be announced, whatever the desktop's clock says; the `ts`
 * is in the anchor precisely for a desktop clock running ahead of the phone's. So nothing is
 * evicted by COUNT on the way to a notification: [maxEntries] is only a memory backstop (for a
 * desktop that keeps minting future-dated events), sized far beyond what a real Inbox reaches —
 * the desktop caps its feed at 50 events — and it drops the OLDEST anchors first.
 *
 * Ids written by the pre-A48 build (the bare set, no times) are migrated on first use as "seen
 * now", so the upgrade announces nothing again and they age out one retention period later.
 *
 * Every entry point holds this object's lock across the whole read-modify-write, and
 * [claimAnnounceable] decides and records in one step, so two callers cannot both announce an event.
 */
class SeenLog(
    private val storage: Storage,
    private val clock: () -> Long = System::currentTimeMillis,
    private val maxEntries: Int = MAX_ENTRIES
) {
    /** Where the log is kept (one string in the app's preferences on Android). */
    interface Storage {
        /** The log as [encode] wrote it, or null when it has never been written. */
        fun read(): String?

        /** The pre-A48 format: a bare set of ids with no times. Null when there is none. */
        fun readLegacy(): Set<String>?

        /** Store [encoded] and drop the legacy set, in one edit. */
        fun write(encoded: String)
    }

    /** Whether [id] is recorded as announced or read. */
    @Synchronized
    fun isSeen(id: String): Boolean = id in load(clock())

    /** The phone has seen [events] (the user read them, or they were announced). */
    @Synchronized
    fun markSeen(events: Collection<InboxEvent>) {
        if (events.isEmpty()) return
        val now = clock()
        val entries = load(now)
        for (ev in events) record(entries, ev, now)
        save(entries, now)
    }

    /**
     * The events of [events] (a host's feed, oldest → newest) that should raise a notification now —
     * unresolved, inside the announce window and never announced or read — recorded as announced in
     * the same step. Order is kept.
     */
    @Synchronized
    fun claimAnnounceable(events: List<InboxEvent>): List<InboxEvent> {
        val now = clock()
        val entries = load(now)
        val fresh = ArrayList<InboxEvent>()
        for (ev in events) {
            if (!announceable(ev, now) || ev.id in entries) continue
            record(entries, ev, now)
            fresh += ev
        }
        if (fresh.isNotEmpty()) save(entries, now)
        return fresh
    }

    private fun record(entries: MutableMap<String, Long>, ev: InboxEvent, now: Long) {
        entries[ev.id] = maxOf(entries[ev.id] ?: Long.MIN_VALUE, now, ev.ts)
    }

    /** The stored entries; migrates the legacy set (and persists that) the first time. */
    private fun load(now: Long): LinkedHashMap<String, Long> {
        storage.read()?.let { return decode(it, now) }
        val legacy = storage.readLegacy() ?: return LinkedHashMap()
        val migrated = LinkedHashMap<String, Long>()
        for (id in legacy) migrated[id] = now
        save(migrated, now)
        return migrated
    }

    private fun save(entries: Map<String, Long>, now: Long) {
        storage.write(encode(prune(entries, now, maxEntries)))
    }

    companion object {
        /** The background check announces only events younger than this (by the phone's clock). */
        const val ANNOUNCE_WINDOW_MS: Long = 6 * 3_600_000L

        /** How long past the window an entry is kept: slack for a desktop clock that runs ahead. */
        const val RETENTION_MARGIN_MS: Long = 18 * 3_600_000L

        /** An entry whose anchor is older than this is dropped. */
        const val RETENTION_MS: Long = ANNOUNCE_WINDOW_MS + RETENTION_MARGIN_MS

        /** Memory backstop only (see the class comment); never reached by a real Inbox. */
        const val MAX_ENTRIES: Int = 5_000

        /** Unresolved and inside the announce window. Written without `now - ts`, which overflows. */
        fun announceable(ev: InboxEvent, now: Long): Boolean = !ev.resolved && ev.ts > now - ANNOUNCE_WINDOW_MS

        fun encode(entries: Map<String, Long>): String =
            JsonObject(entries.mapValues { JsonPrimitive(it.value) }).toString()

        /**
         * Tolerant: an unreadable log is empty; an entry whose time is unreadable counts as seen
         * [now] — an id we once recorded stays recorded rather than being announced again.
         */
        fun decode(raw: String, now: Long): LinkedHashMap<String, Long> {
            val obj = J.obj(J.parse(raw)) ?: return LinkedHashMap()
            val out = LinkedHashMap<String, Long>()
            for ((id, v) in obj) out[id] = J.long(v) ?: now
            return out
        }

        /** Drops entries past [RETENTION_MS]; above [maxEntries], keeps the newest anchors. */
        fun prune(entries: Map<String, Long>, now: Long, maxEntries: Int = MAX_ENTRIES): LinkedHashMap<String, Long> {
            val cutoff = now - RETENTION_MS
            val kept = entries.filterValues { it >= cutoff }
            if (kept.size <= maxEntries) return LinkedHashMap(kept)
            val newest = kept.entries.sortedByDescending { it.value }.take(maxEntries).map { it.key }.toHashSet()
            return LinkedHashMap(kept.filterKeys { it in newest })
        }
    }
}
