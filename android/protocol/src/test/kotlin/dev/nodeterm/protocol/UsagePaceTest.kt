package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.ContextFill
import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.UsageLimit
import dev.nodeterm.protocol.model.UsagePace
import dev.nodeterm.protocol.model.UsagePace.Pace
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/** The Usages tab's pace line and the cards' context fill (audit A58, docs/mobile-usage-inbox.md). */
class UsagePaceTest {
    private val now = 1_800_000_000_000L
    private val minute = 60_000L

    private fun limit(
        kind: String = "session",
        used: Double = 50.0,
        resetsAt: Long? = now + 150 * minute,
        windowMinutes: Long? = null,
        group: String? = null
    ) = UsageLimit(kind, group, used, null, resetsAt, windowMinutes, null, false)

    @Test
    fun `no reset time means no pace line`() {
        assertNull(UsagePace.of(limit(resetsAt = null), now))
    }

    @Test
    fun `claude reports no window length, so session and weekly kinds default to 5h and 7d`() {
        // Halfway through a 5h window (150 of 300 minutes left) with half of it used.
        val session = assertNotNull(UsagePace.of(limit(kind = "session", used = 50.0, resetsAt = now + 150 * minute), now))
        assertEquals(300L, session.windowMinutes)
        assertEquals(50.0, session.elapsedPercent, 1e-9)
        assertEquals(Pace.ON_PACE, session.pace)
        assertEquals("5h usage on pace", session.line)

        // One day into a week: 1/7 elapsed; 60% used is far ahead of that.
        for (kind in listOf("weekly_all", "weekly_scoped")) {
            val weekly = assertNotNull(UsagePace.of(limit(kind = kind, used = 60.0, resetsAt = now + 6 * 1_440 * minute), now), kind)
            assertEquals(10_080L, weekly.windowMinutes, kind)
            assertEquals(100.0 / 7, weekly.elapsedPercent, 1e-9, kind)
            assertEquals(Pace.FASTER, weekly.pace, kind)
            assertEquals("7d usage pace faster", weekly.line, kind)
        }
    }

    @Test
    fun `a reported window length wins over the kind's default and names the line`() {
        // Codex reports a 7h session window: 210 of 420 minutes left = 50% elapsed. Against the
        // 5h default the same resetsAt would be 30% elapsed and 50% used would read "faster".
        val r = assertNotNull(UsagePace.of(limit(kind = "session", used = 50.0, resetsAt = now + 210 * minute, windowMinutes = 420), now))
        assertEquals(420L, r.windowMinutes)
        assertEquals(Pace.ON_PACE, r.pace)
        assertEquals("7h usage on pace", r.line)
    }

    @Test
    fun `an unknown kind gets no guessed window, but its group or a reported length is used`() {
        assertNull(UsagePace.windowMinutes(limit(kind = "monthly_credits")))
        assertNull(UsagePace.of(limit(kind = "monthly_credits", resetsAt = now + minute), now))
        assertEquals(300L, UsagePace.windowMinutes(limit(kind = "session_opus", group = "session")))
        assertEquals(10_080L, UsagePace.windowMinutes(limit(kind = "opus_week", group = "weekly")))
        assertEquals(43_200L, UsagePace.windowMinutes(limit(kind = "monthly_credits", windowMinutes = 43_200)))
        // A hand-edited non-positive length is ignored rather than dividing by it.
        assertEquals(300L, UsagePace.windowMinutes(limit(kind = "session", windowMinutes = 0)))
        assertEquals(300L, UsagePace.windowMinutes(limit(kind = "session", windowMinutes = -5)))
    }

    @Test
    fun `slower and faster are decided outside the on-pace band, inclusive at its edge`() {
        // 150 of 300 minutes left: 50% elapsed.
        fun paceAt(used: Double) = UsagePace.of(limit(used = used), now)!!.pace
        assertEquals(Pace.ON_PACE, paceAt(55.0), "exactly +band is still on pace")
        assertEquals(Pace.ON_PACE, paceAt(45.0), "exactly -band is still on pace")
        assertEquals(Pace.FASTER, paceAt(55.1))
        assertEquals(Pace.SLOWER, paceAt(44.9))
        assertEquals("5h usage pace slower", UsagePace.of(limit(used = 10.0), now)!!.line)
    }

    @Test
    fun `a window that has reset, or is longer than the length we assumed, gets no verdict`() {
        assertNull(UsagePace.of(limit(resetsAt = now), now), "resets now: the percentage is the old window's")
        assertNull(UsagePace.of(limit(resetsAt = now - minute), now), "already reset")
        // 301 minutes left of a "5h" window: the window is not five hours, so the verdict would be wrong.
        assertNull(UsagePace.of(limit(resetsAt = now + 301 * minute), now))
        // Exactly the whole window left is the window's first instant: valid, 0% elapsed.
        val start = assertNotNull(UsagePace.of(limit(used = 0.0, resetsAt = now + 300 * minute), now))
        assertEquals(0.0, start.elapsedPercent, 1e-9)
        assertEquals(Pace.ON_PACE, start.pace)
        // The last millisecond: almost all of it elapsed, and 100% used is on pace.
        assertEquals(Pace.ON_PACE, UsagePace.of(limit(used = 100.0, resetsAt = now + 1), now)!!.pace)
    }

    @Test
    fun `the clock is injected, so the same limit reads differently as time passes`() {
        val resetsAt = now + 300 * minute // a fresh 5h window, 60% already used
        val l = limit(used = 60.0, resetsAt = resetsAt)
        assertEquals(Pace.FASTER, UsagePace.of(l, now)!!.pace)
        assertEquals(Pace.ON_PACE, UsagePace.of(l, now + 180 * minute)!!.pace, "60% elapsed, 60% used")
        assertEquals(Pace.SLOWER, UsagePace.of(l, now + 270 * minute)!!.pace, "90% elapsed, 60% used")
        assertNull(UsagePace.of(l, resetsAt), "and nothing once it has reset")
    }

    @Test
    fun `hostile values from the hand-editable mirror are clamped or refused, never wrapped`() {
        assertEquals(100.0, UsagePace.of(limit(used = 250.0), now)!!.usedPercent)
        assertEquals(0.0, UsagePace.of(limit(used = -20.0), now)!!.usedPercent)
        assertNull(UsagePace.of(limit(used = Double.NaN), now))
        // Long arithmetic would wrap `resetsAt - now` and `minutes * 60000` to plausible values.
        assertNull(UsagePace.of(limit(resetsAt = Long.MIN_VALUE), now))
        assertNull(UsagePace.of(limit(resetsAt = Long.MAX_VALUE), now))
        val huge = assertNotNull(UsagePace.of(limit(resetsAt = now + minute, windowMinutes = Long.MAX_VALUE), now))
        assertEquals(Pace.SLOWER, huge.pace, "one minute left of an enormous window: nearly all of it has elapsed")
    }

    @Test
    fun `window labels are derived from minutes`() {
        assertEquals("5h", UsagePace.windowLabel(300))
        assertEquals("7d", UsagePace.windowLabel(10_080))
        assertEquals("1d", UsagePace.windowLabel(1_440))
        assertEquals("90m", UsagePace.windowLabel(90))
    }

    @Test
    fun `a mirror limit without windowMinutes still gets a pace line`() {
        // The desktop's buildMirrorUsage writes `windowMinutes: null` for every Claude limit
        // (agent-status-mirror.test.ts), which is why the kind defaults exist at all.
        val resetsAt = now + 60 * minute
        val snap = ProjectsParser.parseBlob(
            "--NT-STATUS-SPLIT--\n" +
                """{"v":1,"updatedAt":1,"nodes":{},"usage":{"updatedAt":1,"accounts":[{"accountId":null,"label":null,"email":null,"agentId":"claude","status":"ok","updatedAt":1,"limits":[{"kind":"session","group":"session","usedPercent":95,"severity":null,"resetsAt":$resetsAt,"windowMinutes":null,"scopeLabel":null,"isActive":true}]}]}}"""
        )
        val l = snap.status!!.usage!!.accounts.single().limits.single()
        assertNull(l.windowMinutes)
        val r = assertNotNull(UsagePace.of(l, now))
        assertEquals(80.0, r.elapsedPercent, 1e-9)
        assertEquals("5h usage pace faster", r.line)
    }

    @Test
    fun `context fill is clamped, rounded like the desktop, and banded like its meter`() {
        assertNull(ContextFill.label(null))
        assertNull(ContextFill.label(Double.NaN))
        assertEquals("42% context", ContextFill.label(41.6))
        assertEquals("42% context", ContextFill.label(42.4))
        assertEquals("43% context", ContextFill.label(42.5), "half rounds up, as Math.round")
        assertEquals("100% context", ContextFill.label(140.0))
        assertEquals("0% context", ContextFill.label(-3.0))
        assertEquals(ContextFill.Level.OK, ContextFill.level(59.9))
        assertEquals(ContextFill.Level.HIGH, ContextFill.level(60.0))
        assertEquals(ContextFill.Level.HIGH, ContextFill.level(85.0))
        assertEquals(ContextFill.Level.CRITICAL, ContextFill.level(85.1))
    }

    @Test
    fun `the context fill an event card shows is its node's, read from the parsed inbox`() {
        val snap = ProjectsParser.parseBlob(
            "--NT-STATUS-SPLIT--\n" +
                """{"v":1,"updatedAt":1,"nodes":{},"inbox":{"events":[{"id":"e1","ts":1,"nodeId":"n1","kind":"approval","title":"Approve"},{"id":"e2","ts":2,"nodeId":"n2","kind":"done","title":"Finished"}],"nodes":{"n1":{"contextPercent":73.4,"updatedAt":1}}}}"""
        )
        val inbox = snap.status!!.inbox!!
        val byEvent = inbox.events.associate { it.id to ContextFill.label(inbox.nodes[it.nodeId]?.contextPercent) }
        assertEquals(mapOf("e1" to "73% context", "e2" to null), byEvent)
    }
}
