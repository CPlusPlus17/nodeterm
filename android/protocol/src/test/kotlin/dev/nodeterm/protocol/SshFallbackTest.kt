package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.SshFallback
import dev.nodeterm.protocol.ssh.SshFallback.Next
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Audit A49/A74: what a connect does after the direct-SSH leg failed. */
class SshFallbackTest {
    private val changed = HostKeyChangedException("SHA256:paired", "SHA256:whoever-has-the-address-now")
    private val relaySetting = "“Only through the relay”"

    @Test
    fun `in Auto a changed host key goes on to the relay, and says so even when the relay works`() {
        val next = SshFallback.afterFailure(changed, relayAllowed = true, relayConfigured = true)
        assertIs<Next.TryRelay>(next)
        // Shown if the relay fails as well…
        assertTrue(next.error.startsWith("On your network: "))
        assertTrue(next.error.contains("SHA256:whoever-has-the-address-now"))
        // …and while connected through it, so the change never disappears behind a working relay.
        val warning = assertNotNull(next.warning)
        assertTrue(warning.contains("SHA256:paired") && warning.contains("SHA256:whoever-has-the-address-now"))
        assertTrue(warning.contains("through the relay instead"))
        assertTrue(warning.contains(relaySetting), warning)
    }

    @Test
    fun `Only on my network keeps the hard stop, and names the way out`() {
        val next = SshFallback.afterFailure(changed, relayAllowed = false, relayConfigured = true)
        assertIs<Next.Stop>(next)
        assertTrue(next.message.contains("SHA256:whoever-has-the-address-now"))
        assertTrue(next.message.contains(relaySetting), next.message)
        assertTrue(next.message.contains("Settings → How to reach each computer"))
    }

    @Test
    fun `with no relay leg a changed key stops, and says how to get one`() {
        for (allowed in listOf(true, false)) {
            val next = SshFallback.afterFailure(changed, relayAllowed = allowed, relayConfigured = false)
            assertIs<Next.Stop>(next)
            // The relay-only setting would not help here: do not send the user to it.
            assertFalse(next.message.contains(relaySetting), next.message)
            assertTrue(next.message.contains("turn on remote access"))
        }
    }

    @Test
    fun `re-pairing is offered as one way out, not as the only one`() {
        val texts = listOf(
            SshFallback.afterFailure(changed, relayAllowed = true, relayConfigured = true).let { it as Next.TryRelay }
                .let { listOf(it.error, it.warning!!) },
            listOf((SshFallback.afterFailure(changed, relayAllowed = false, relayConfigured = true) as Next.Stop).message)
        ).flatten()
        for (t in texts) {
            assertFalse(t.contains("remove and re-pair", ignoreCase = true), t)
            assertTrue(t.contains(relaySetting), t)
        }
        // The bare exception names the likely causes before the alarming one.
        val fact = changed.message!!
        assertTrue(fact.indexOf("network address") < fact.indexOf("intercepting"), fact)
    }

    @Test
    fun `an ordinary SSH failure falls through in Auto and stops on the SSH-only route, as before`() {
        val down = HostException("Couldn't connect over SSH to dev@10.0.0.2:22 (timeout).")
        assertEquals(
            Next.TryRelay("On your network: Couldn't connect over SSH to dev@10.0.0.2:22 (timeout)."),
            SshFallback.afterFailure(down, relayAllowed = true, relayConfigured = true)
        )
        assertNull((SshFallback.afterFailure(down, relayAllowed = true, relayConfigured = false) as Next.TryRelay).warning)
        assertEquals(
            Next.Stop("On your network: Couldn't connect over SSH to dev@10.0.0.2:22 (timeout)."),
            SshFallback.afterFailure(down, relayAllowed = false, relayConfigured = true)
        )
        // No message at all still says what failed.
        assertEquals(
            Next.TryRelay("On your network: IllegalStateException"),
            SshFallback.afterFailure(IllegalStateException(), relayAllowed = true, relayConfigured = true)
        )
    }
}
