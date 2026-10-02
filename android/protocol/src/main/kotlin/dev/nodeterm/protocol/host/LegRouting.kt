package dev.nodeterm.protocol.host

/**
 * One thing a connection can do beyond browse + attach, as [HostCapabilities] names it. The verbs
 * under each are the host-service ones the relay serves.
 */
enum class Capability(val what: String) {
    /** `projects.ensureBoard`, `projects.setCardColumn`, `projects.editCardLabels`. */
    BOARD_WRITES("Editing the board"),
    /** `git.*`. */
    GIT("Source control"),
    /** `node.wake`, `node.refresh`, `node.rename`. */
    NODE_ACTIONS("Waking, refreshing and renaming a session"),
    /** `projects.registerNode` (a session the phone starts, put on the canvas). */
    REGISTER_NODE("Starting a new session"),
    /** `approvals.answer` / the `.answer` file. */
    ANSWER_APPROVALS("Answering an approval");

    fun of(c: HostCapabilities): Boolean = when (this) {
        BOARD_WRITES -> c.boardWrites
        GIT -> c.git
        NODE_ACTIONS -> c.nodeActions
        REGISTER_NODE -> c.registerNode
        ANSWER_APPROVALS -> c.answerApprovals
    }
}

/**
 * Which leg of a paired computer answers a verb (audit A26), decided in ONE place so the UI and the
 * call agree. The direct-SSH leg (the LAN one `Auto` picks first) is POSIX sh + tmux on the machine;
 * what needs nodeterm THE APP — board writes, registering a new session, node actions, git — is the
 * relay's. Before this, a phone on SSH simply had none of it (the New-session button vanished, the
 * board was read-only), although the same computer's relay leg was one tap away.
 *
 * The rule: the primary connection when it can; else the relay leg opened NEXT to it on demand, when
 * this phone holds one; else unavailable, with the reason the UI shows on a disabled control.
 *
 * The relay is opened only for a user's action (a tap): [dev.nodeterm.protocol.host.RelayApprovalGate]
 * still decides, so a background path never makes a first relay handshake.
 */
object LegRouting {
    /** What the relay leg serves: everything host-service has a verb for. */
    val RELAY_CAPABILITIES = HostCapabilities(
        boardWrites = true, git = true, nodeActions = true, registerNode = true, answerApprovals = true
    )

    /** Whether this phone can reach the computer's relay leg next to its primary connection. */
    enum class RelayLeg {
        /** A relay block, its host key and a stored device token, and the route allows the relay. */
        AVAILABLE,
        /** The phone holds no relay leg: remote access was off at pairing and has not been adopted since. */
        NOT_SET_UP,
        /** The phone has one, but the user set this computer to "Only on my network". */
        ROUTE_SSH_ONLY
    }

    sealed interface Leg {
        /** The connection already open does it. */
        data object Primary : Leg
        /** Open (or reuse) the relay connection held next to the primary one. */
        data object Relay : Leg
        /** Neither leg can; [reason] is what a disabled control says. */
        data class Unavailable(val reason: String) : Leg
    }

    /** Facts the relay leg's availability comes from. Pure, so the app and its tests agree. */
    fun relayLeg(relayConfigured: Boolean, sshOnlyRoute: Boolean): RelayLeg = when {
        !relayConfigured -> RelayLeg.NOT_SET_UP
        sshOnlyRoute -> RelayLeg.ROUTE_SSH_ONLY
        else -> RelayLeg.AVAILABLE
    }

    /**
     * Where [cap] goes. [primary] is the open connection's transport (null: not connected yet), with
     * its [primaryCaps].
     */
    fun route(cap: Capability, primary: TransportKind?, primaryCaps: HostCapabilities?, relay: RelayLeg): Leg {
        if (primary != null && primaryCaps != null && cap.of(primaryCaps)) return Leg.Primary
        if (primary == TransportKind.RELAY) {
            // The relay itself refused: nothing else to open.
            return Leg.Unavailable("${cap.what} isn't available on this computer.")
        }
        return when (relay) {
            RelayLeg.AVAILABLE -> Leg.Relay
            RelayLeg.NOT_SET_UP -> Leg.Unavailable(notSetUp(cap))
            RelayLeg.ROUTE_SSH_ONLY -> Leg.Unavailable(sshOnly(cap))
        }
    }

    /** What each capability can reach right now, for a screen deciding several controls at once. */
    fun reach(primary: TransportKind?, primaryCaps: HostCapabilities?, relay: RelayLeg): Map<Capability, Leg> =
        Capability.entries.associateWith { route(it, primary, primaryCaps, relay) }

    private fun notSetUp(cap: Capability) =
        "${cap.what} goes through nodeterm on the computer, which this phone reaches through the relay, and " +
            "this phone has no relay connection to it yet. Turn on remote access in nodeterm → Settings → Phone; " +
            "the phone picks it up the next time it connects on your network."

    private fun sshOnly(cap: Capability) =
        "${cap.what} goes through the relay, and this computer is set to \"Only on my network (SSH)\". Choose " +
            "\"Automatic\" or \"Only through the relay\" in Settings → How to reach each computer."

    /**
     * What the direct-SSH transport says when a relay verb is called on it anyway. The app routes
     * those to the relay ([route]), so this is the message of a caller that skipped the routing — and
     * it must not tell a user whose remote access is ON to turn it on (the phone merely picked SSH).
     */
    fun sshRefusal(what: String) =
        "$what isn't done over your network: it goes through nodeterm on the computer, which the phone " +
            "reaches through the relay."
}
