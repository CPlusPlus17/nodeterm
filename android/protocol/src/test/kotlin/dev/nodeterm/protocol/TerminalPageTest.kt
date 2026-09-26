package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.RendererRecovery
import dev.nodeterm.protocol.host.RendererRecovery.Action
import dev.nodeterm.protocol.host.TerminalPage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Audit A45: the terminal WebView's renderer can go away (killed by the system, or crashed), and the
 * screen then builds a new WebView. The screen (TerminalController) is only type-checked; these pin
 * the rules it delegates to: which page's callbacks count, where queued JavaScript goes, and who
 * reattaches.
 */
class TerminalPageTest {
    // ---- the page generation -----------------------------------------------------------------

    @Test
    fun `JavaScript offered before the page is ready is run in order once it is`() {
        val page = TerminalPage()
        val gen = page.build()
        assertFalse(page.offer("a"))
        assertFalse(page.offer("b"))
        assertEquals(listOf("a", "b"), page.ready(gen))
        assertTrue(page.isReady)
        assertTrue(page.offer("c"), "a ready page runs JavaScript at once")
        assertEquals(emptyList(), page.ready(gen), "a second ready hands nothing over again")
    }

    @Test
    fun `a lost page's late ready neither marks the next page ready nor takes its queue`() {
        val page = TerminalPage()
        val dead = page.build()
        page.lost()
        val next = page.build()
        assertFalse(page.offer("paint"))
        // The dead page's onReady, posted before the loss and run after it.
        assertNull(page.ready(dead))
        assertFalse(page.isReady)
        assertFalse(page.isCurrent(dead))
        assertTrue(page.isCurrent(next))
        assertEquals(listOf("paint"), page.ready(next), "the queue is still there for the page it was meant for")
    }

    @Test
    fun `the renderer going away before the page was ready drops what was queued for it`() {
        val page = TerminalPage()
        val dead = page.build()
        page.offer("nt.write(old output)")
        page.lost()
        assertFalse(page.isCurrent(dead), "the dead page's callbacks no longer count")
        assertTrue(page.isReplacing)
        val next = page.build()
        page.offer("nt.setFontSize(13)")
        assertEquals(listOf("nt.setFontSize(13)"), page.ready(next))
        assertFalse(page.isReplacing)
    }

    @Test
    fun `a ready page that is lost stops running JavaScript until its replacement is ready`() {
        val page = TerminalPage()
        page.ready(page.build())
        assertTrue(page.offer("x"))
        page.lost()
        assertFalse(page.isReady)
        assertFalse(page.offer("y"), "no page to run it on: queued, not evaluated on a destroyed WebView")
    }

    @Test
    fun `JavaScript offered while there is no page at all is kept for the next one`() {
        val page = TerminalPage()
        page.ready(page.build())
        page.lost()
        // A reattach can land and paint before the replacement WebView has been built.
        assertFalse(page.offer("nt.paint(screen)"))
        val next = page.build()
        page.offer("nt.setFontSize(13)")
        assertEquals(listOf("nt.paint(screen)", "nt.setFontSize(13)"), page.ready(next))
    }

    @Test
    fun `only a replacement page is waited for, not the first one`() {
        val page = TerminalPage()
        val first = page.build()
        assertFalse(page.isReplacing, "the first attach is not held back for the first page")
        page.ready(first)
        page.lost()
        val next = page.build()
        assertTrue(page.isReplacing)
        page.ready(next)
        assertFalse(page.isReplacing)
    }

    // ---- who reattaches --------------------------------------------------------------------

    @Test
    fun `a crashed renderer is offered to the user, never reattached by itself`() {
        val recovery = RendererRecovery()
        assertEquals(Action.OFFER, recovery.onGone(didCrash = true, now = 0))
        assertEquals(Action.OFFER, recovery.onGone(didCrash = true, now = 3_600_000))
    }

    @Test
    fun `a renderer the system killed is reattached by itself`() {
        val recovery = RendererRecovery()
        assertEquals(Action.REATTACH, recovery.onGone(didCrash = false, now = 0))
    }

    @Test
    fun `repeated kills fall back to the offer, and recover once the window has passed`() {
        val recovery = RendererRecovery(windowMs = 60_000, maxAutomatic = 2)
        assertEquals(Action.REATTACH, recovery.onGone(didCrash = false, now = 0))
        assertEquals(Action.REATTACH, recovery.onGone(didCrash = false, now = 10_000))
        assertEquals(Action.OFFER, recovery.onGone(didCrash = false, now = 20_000))
        assertEquals(Action.OFFER, recovery.onGone(didCrash = false, now = 59_999))
        // The first automatic reattach has left the window: one more is allowed.
        assertEquals(Action.REATTACH, recovery.onGone(didCrash = false, now = 60_000))
        assertEquals(Action.OFFER, recovery.onGone(didCrash = false, now = 60_001))
    }

    @Test
    fun `an offer is not counted as an automatic reattach`() {
        val recovery = RendererRecovery(windowMs = 60_000, maxAutomatic = 1)
        assertEquals(Action.OFFER, recovery.onGone(didCrash = true, now = 0))
        assertEquals(Action.REATTACH, recovery.onGone(didCrash = false, now = 1))
    }
}
