package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.Capability
import dev.nodeterm.protocol.host.HostCapabilities
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.host.LegRouting.Leg
import dev.nodeterm.protocol.host.LegRouting.RelayLeg
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.ProjectInfo
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Audit A26: on the LAN connection `Auto` picks first, New session, board edits and node actions
 * were simply unavailable (the button hidden, the board read-only), although the same computer's
 * relay leg could do them. One pure decision says which leg answers each verb.
 */
class LegRoutingTest {
    /** What the direct-SSH transport serves (SshHostConnection.capabilities). */
    private val ssh = HostCapabilities(
        boardWrites = false, git = false, nodeActions = false, registerNode = false, answerApprovals = true
    )
    private val appVerbs = listOf(Capability.BOARD_WRITES, Capability.REGISTER_NODE, Capability.NODE_ACTIONS, Capability.GIT)

    @Test
    fun `on SSH the app's own verbs open the relay leg next to it`() {
        for (cap in appVerbs) {
            assertEquals(Leg.Relay, LegRouting.route(cap, TransportKind.SSH, ssh, RelayLeg.AVAILABLE), "$cap")
        }
    }

    @Test
    fun `a project another desktop drives over SSH answers only what the machine does (A27)`() {
        val driven = ProjectInfo("project-drv", "Driven", null, "/srv/drv", null, false, emptyList(), null, drivenRemotely = true)
        val own = driven.copy(drivenRemotely = false)
        for (cap in appVerbs) {
            for (leg in listOf(Leg.Primary, Leg.Relay)) {
                val refused = assertIs<Leg.Unavailable>(LegRouting.forProject(cap, driven, leg), "$cap via $leg")
                assertTrue(refused.reason.startsWith(cap.what) && refused.reason.contains("another computer"), refused.reason)
                assertEquals(leg, LegRouting.forProject(cap, own, leg), "a project of this computer keeps the computer's answer")
                assertEquals(leg, LegRouting.forProject(cap, null, leg))
            }
        }
        // A held approval is a file on THIS computer, written over SSH: still the primary leg.
        assertEquals(Leg.Primary, LegRouting.forProject(Capability.ANSWER_APPROVALS, driven, Leg.Primary))
        // Never "turn on remote access": the relay this phone holds is this computer's, not that desktop's.
        assertFalse(LegRouting.drivenElsewhere(Capability.NODE_ACTIONS).contains("remote access"))
    }

    @Test
    fun `what SSH does itself never opens the relay`() {
        assertEquals(Leg.Primary, LegRouting.route(Capability.ANSWER_APPROVALS, TransportKind.SSH, ssh, RelayLeg.AVAILABLE))
    }

    @Test
    fun `on the relay everything stays on the relay connection`() {
        for (cap in Capability.entries) {
            assertEquals(
                Leg.Primary,
                LegRouting.route(cap, TransportKind.RELAY, LegRouting.RELAY_CAPABILITIES, RelayLeg.NOT_SET_UP),
                "$cap"
            )
        }
    }

    @Test
    fun `with no relay leg the verb is unavailable with the reason, and that reason is not 'turn it on' when it is on`() {
        for (cap in appVerbs) {
            val notSetUp = assertIs<Leg.Unavailable>(LegRouting.route(cap, TransportKind.SSH, ssh, RelayLeg.NOT_SET_UP))
            assertTrue(notSetUp.reason.startsWith(cap.what), notSetUp.reason)
            assertTrue(notSetUp.reason.contains("Turn on remote access"), notSetUp.reason)

            // Remote access is on (the phone holds a relay leg); the user chose SSH only. Sending
            // them to turn remote access on would be the A26 error text again.
            val sshOnly = assertIs<Leg.Unavailable>(LegRouting.route(cap, TransportKind.SSH, ssh, RelayLeg.ROUTE_SSH_ONLY))
            assertFalse(sshOnly.reason.contains("remote access", ignoreCase = true), sshOnly.reason)
            assertTrue(sshOnly.reason.contains("Only on my network (SSH)"), sshOnly.reason)
            assertTrue(sshOnly.reason.contains("Settings → How to reach each computer"), sshOnly.reason)
        }
    }

    @Test
    fun `not connected yet asks the relay leg when there is one`() {
        // connectionFor connects first, so this only matters for the UI's state before the first
        // listing: a control is not shown as impossible while the phone is still dialing.
        assertEquals(Leg.Relay, LegRouting.route(Capability.REGISTER_NODE, null, null, RelayLeg.AVAILABLE))
        assertIs<Leg.Unavailable>(LegRouting.route(Capability.REGISTER_NODE, null, null, RelayLeg.NOT_SET_UP))
    }

    @Test
    fun `the relay leg's availability`() {
        assertEquals(RelayLeg.AVAILABLE, LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = false))
        assertEquals(RelayLeg.ROUTE_SSH_ONLY, LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = true))
        assertEquals(RelayLeg.NOT_SET_UP, LegRouting.relayLeg(relayConfigured = false, sshOnlyRoute = false))
        assertEquals(RelayLeg.NOT_SET_UP, LegRouting.relayLeg(relayConfigured = false, sshOnlyRoute = true))
    }

    @Test
    fun `reach answers every capability from the same rule`() {
        val reach = LegRouting.reach(TransportKind.SSH, ssh, RelayLeg.AVAILABLE)
        assertEquals(Capability.entries.toSet(), reach.keys)
        for (cap in Capability.entries) assertEquals(LegRouting.route(cap, TransportKind.SSH, ssh, RelayLeg.AVAILABLE), reach[cap])
    }

    @Test
    fun `the SSH refusal names the relay, not a setting that may already be on`() {
        val msg = LegRouting.sshRefusal("Editing the board")
        assertTrue(msg.startsWith("Editing the board"))
        assertTrue(msg.contains("through the relay"))
        assertFalse(msg.contains("turn on remote access"))
    }

    /**
     * The app asks this decision instead of the transport kind. What only a device can run (the
     * Compose screens) is pinned in the source, like AppSourcePins does elsewhere.
     */
    @Test
    fun `the app's controls decide from the routing, and write through the leg it names`() {
        val host = AppSourcePins.ui("HostScreen.kt")
        // The FAB used to be gated on `kind == TransportKind.RELAY` and vanished on the LAN.
        assertFalse(host.contains("kind == TransportKind.RELAY"), "HostScreen gates New session on the transport kind")
        assertTrue(host.contains("session.route(Capability.REGISTER_NODE)"))
        assertTrue(host.contains("enabled = false"), "an unavailable New session is shown disabled, not hidden")

        val board = AppSourcePins.ui("BoardTab.kt")
        // Per project since A27: a project another desktop drives over SSH has its own answer.
        assertTrue(board.contains("session.route(Capability.BOARD_WRITES, project)"))
        assertTrue(board.contains("session.connectionFor(Capability.BOARD_WRITES, project = project)"))
        assertFalse(board.contains("ensureConnected().setCardColumn"), "a board write must not go to the SSH leg")
        assertFalse(board.contains("ensureConnected().editCardLabels"), "a label edit must not go to the SSH leg")

        val sessions = AppSourcePins.ui("SessionsTab.kt")
        assertTrue(sessions.contains("session.route(Capability.NODE_ACTIONS, project)"))
        assertFalse(sessions.contains("connectionFor(Capability.NODE_ACTIONS)"), "every node action names its project")
        assertFalse(sessions.contains("capabilities?.nodeActions"), "node actions decided from the primary leg alone")

        // A session the phone starts is created and registered through the leg that can register it.
        val term = AppSourcePins.ui("TerminalController.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(term, "private fun attach()"),
            "PendingLaunches.peek(nodeId) != null -> session.connectionFor(Capability.REGISTER_NODE"
        )

        // The side relay goes through the approval gate with the caller's trigger (never a first
        // handshake from the background), and connectionFor defaults to the user's tap.
        val conn = AppSourcePins.app("conn/ConnectionManager.kt")
        val viaRelay = AppSourcePins.blockAfter(conn.substring(conn.indexOf("suspend fun viaRelay(")), "return sideMutex.withLock")
        assertTrue(viaRelay.contains("graph.relayGate.decide(hostId, trigger)"))
        assertTrue(viaRelay.contains("requireApproved = requireApproved"))
        assertTrue(Regex("""fun connectionFor\(\s*cap: Capability,\s*trigger: Trigger = Trigger\.USER""").containsMatchIn(conn))
        // …and decides with the project's answer, the one the screens show (A27).
        val connectionFor = AppSourcePins.blockAfter(conn.substring(conn.indexOf("suspend fun connectionFor(")), "): HostConnection")
        assertTrue(connectionFor.contains("route(cap, project)"), connectionFor)
    }
}
