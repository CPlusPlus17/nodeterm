package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.relay.OkHttpRelayTransport
import dev.nodeterm.protocol.relay.RelaySocket
import dev.nodeterm.protocol.relay.RelayTransportFactory
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

/** Where a relay connect is, for the UI. */
sealed interface RelayConnectStatus {
    data object MintingToken : RelayConnectStatus
    data object Handshaking : RelayConnectStatus
    /** The handshake completed; the desktop must approve this phone (first connect only — pin-once). */
    data class AwaitingApproval(val sas: String) : RelayConnectStatus
}

/** The host message the standing host answers every request with until it approves this device. */
const val AWAITING_APPROVAL_MESSAGE = "Awaiting host approval."

/**
 * Connect to a paired computer over the relay and wait until it serves us.
 *
 * The standing phone host is PIN-ONCE (standing-host.ts): the first connect from this phone's box
 * key puts the SAS approval dialog on the desktop; once approved the key is pinned and every later
 * connect auto-approves silently. Until then every request answers [AWAITING_APPROVAL_MESSAGE], so
 * approval is observed by retrying `projects.list` — which is also the first thing the UI needs.
 */
object RelayConnector {
    class Connected(val connection: RelayHostConnection, val sas: String, val first: ProjectsSnapshot)

    suspend fun connect(
        relayUrl: String,
        token: String,
        deviceKeys: BoxKeyPair,
        hostPublicKeyB64: String,
        onStatus: (RelayConnectStatus) -> Unit = {},
        transport: RelayTransportFactory = OkHttpRelayTransport.factory(),
        handshakeTimeoutMs: Long = 20_000,
        approvalTimeoutMs: Long = 5 * 60_000,
        approvalPollMs: Long = 1_500
    ): Connected {
        onStatus(RelayConnectStatus.Handshaking)
        val ready = CompletableDeferred<String>()
        val closed = CompletableDeferred<String?>()
        val conn = RelayHostConnection.open(
            build = { listener -> RelaySocket(relayUrl, token, deviceKeys, hostPublicKeyB64, transport, listener) },
            onReady = { sas -> ready.complete(sas) }
        )
        conn.setOnClosed { reason -> closed.complete(reason) }
        try {
            val sas = withTimeoutOrNull(handshakeTimeoutMs) {
                kotlinx.coroutines.selects.select<String> {
                    ready.onAwait { it }
                    closed.onAwait { reason ->
                        throw HostException(
                            "The relay closed the connection before your computer answered" +
                                (reason?.let { " ($it)" } ?: "") +
                                ". Is remote access on in nodeterm → Settings → Phone?"
                        )
                    }
                }
            } ?: throw HostException("Your computer did not answer through the relay. Is nodeterm running with remote access on?")

            val deadline = System.currentTimeMillis() + approvalTimeoutMs
            var announced = false
            while (true) {
                if (closed.isCompleted) throw HostException("The connection closed while waiting for approval.")
                try {
                    val snapshot = conn.listProjects()
                    conn.setOnClosed(null)
                    return Connected(conn, sas, snapshot)
                } catch (e: HostException) {
                    if (e.message != AWAITING_APPROVAL_MESSAGE) throw e
                    if (!announced) {
                        announced = true
                        onStatus(RelayConnectStatus.AwaitingApproval(sas))
                    }
                    if (System.currentTimeMillis() > deadline) {
                        throw HostException("Nobody approved this phone on your computer in time.")
                    }
                    delay(approvalPollMs)
                }
            }
        } catch (e: Throwable) {
            conn.close()
            throw e
        }
    }
}
