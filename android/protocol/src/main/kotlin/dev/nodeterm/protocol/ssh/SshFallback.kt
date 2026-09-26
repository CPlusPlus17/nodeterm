package dev.nodeterm.protocol.ssh

/**
 * What a connect does after the direct-SSH leg failed (audit A49/A74).
 *
 * The LAN leg dials the address the computer had when it was paired: usually a DHCP lease on a
 * private range. After the lease moved, or with the phone on another network that uses the same
 * range, a DIFFERENT machine running sshd can answer there, and its host key does not match the pin.
 * That machine is never used over SSH. But it is no reason to skip the relay: the relay leg
 * authenticates the computer on its own (the relay host key from pairing, then the SAS approval),
 * so going on to it loses no trust. Before this, a changed key stopped the Auto route outright, and
 * the only way out it named was re-pairing.
 *
 * Only the "Only on my network" route keeps the hard stop, because there is nothing else it may
 * try. Whether the relay leg may DIAL is not decided here: the caller still asks its
 * [dev.nodeterm.protocol.host.RelayApprovalGate], so a background check never makes a first relay
 * handshake because of this.
 *
 * Pure, so it is JVM-tested; the app's `HostSession` applies it.
 */
object SshFallback {
    sealed interface Next {
        /**
         * Go on to the relay leg. [error] joins what is shown if that fails too; [warning] is shown
         * even when it succeeds (a changed host key must not disappear behind a working relay).
         */
        data class TryRelay(val error: String, val warning: String? = null) : Next

        /** Try nothing else: fail with [message]. */
        data class Stop(val message: String) : Next
    }

    /** Where the per-computer route setting lives, as Settings names it. */
    const val RELAY_ONLY_SETTING =
        "choose “Only through the relay” for this computer in Settings → How to reach each computer."

    /** Re-pairing is one way out, not the only one: it resets the pin to the computer's current key. */
    const val REPAIR_NOTE = "If the computer was reinstalled, pairing it again trusts its new key."

    /** The relay is not an option yet: say how to get one. */
    const val NO_RELAY_ADVICE =
        "This phone has no relay connection to it yet: turn on remote access in nodeterm on the computer " +
            "(Settings → Phone) and pair again, which also trusts the computer's current key."

    /**
     * @param relayAllowed the route lets this connect use the relay (anything but "Only on my network").
     * @param relayConfigured the phone holds a relay leg for this computer (endpoint, relay host key and
     *   device token), i.e. a relay dial is possible at all.
     */
    fun afterFailure(error: Throwable, relayAllowed: Boolean, relayConfigured: Boolean): Next {
        if (error is HostKeyChangedException) {
            val fact = error.message ?: "This computer's SSH host key changed."
            return when {
                !relayConfigured -> Next.Stop("$fact $NO_RELAY_ADVICE")
                !relayAllowed -> Next.Stop("$fact To reach it through the relay instead, $RELAY_ONLY_SETTING $REPAIR_NOTE")
                else -> Next.TryRelay(
                    error = "On your network: $fact To reach it through the relay only, $RELAY_ONLY_SETTING $REPAIR_NOTE",
                    warning = "$fact The phone connected through the relay instead, which checks the computer's " +
                        "identity separately. To stop trying your network for it, $RELAY_ONLY_SETTING $REPAIR_NOTE"
                )
            }
        }
        val line = "On your network: ${error.message ?: error.javaClass.simpleName}"
        return if (relayAllowed) Next.TryRelay(line) else Next.Stop(line)
    }
}
