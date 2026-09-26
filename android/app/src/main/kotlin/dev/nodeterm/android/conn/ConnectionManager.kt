package dev.nodeterm.android.conn

import dev.nodeterm.android.AppGraph
import dev.nodeterm.android.data.RoutePreference
import dev.nodeterm.android.data.SecureStore
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.RelayApprovalGate
import dev.nodeterm.protocol.host.RelayApprovalGate.Trigger
import dev.nodeterm.protocol.host.RelayConnectStatus
import dev.nodeterm.protocol.host.RelayConnector
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.RelayBlock
import dev.nodeterm.protocol.relay.RelayApi
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.HostKeyPin
import dev.nodeterm.protocol.ssh.SshHostConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

sealed interface ConnState {
    data object Idle : ConnState
    data class Connecting(val detail: String) : ConnState
    /** The desktop is showing its approval dialog; the human compares this code. */
    data class AwaitingApproval(val sas: String) : ConnState
    data class Connected(val kind: TransportKind) : ConnState
    data class Failed(val message: String) : ConnState
}

/**
 * One paired computer's live connection and latest listing. Route choice mirrors the iOS app: the
 * direct-SSH leg first when the computer installed a key for us (it is the LAN, it is fast, and it
 * needs no relay), the E2EE relay when that fails or the computer is relay-only (Windows).
 */
class HostSession(val hostId: String, private val graph: AppGraph) {
    private val scope: CoroutineScope get() = graph.scope
    private val _state = MutableStateFlow<ConnState>(ConnState.Idle)
    val state: StateFlow<ConnState> = _state.asStateFlow()
    private val _snapshot = MutableStateFlow(ProjectsSnapshot.EMPTY)
    val snapshot: StateFlow<ProjectsSnapshot> = _snapshot.asStateFlow()
    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    private val mutex = Mutex()
    @Volatile private var conn: HostConnection? = null
    private var pollJob: Job? = null
    private var watchers = 0

    val connection: HostConnection? get() = conn

    /** A screen is showing this computer right now (so its connection is worth keeping open). */
    val isWatched: Boolean get() = synchronized(this) { watchers > 0 }

    suspend fun ensureConnected(trigger: Trigger = Trigger.AUTO): HostConnection {
        conn?.let { return it }
        return mutex.withLock { conn ?: connectLocked(trigger) }
    }

    private suspend fun connectLocked(trigger: Trigger): HostConnection {
        val host = graph.hosts.get(hostId) ?: throw HostException("This computer is no longer paired.")
        val route = graph.hosts.route(hostId)
        val errors = ArrayList<String>()

        if (route != RoutePreference.RELAY_ONLY && host.sshAvailable) {
            _state.value = ConnState.Connecting("Connecting on your network…")
            try {
                val ssh = withContext(Dispatchers.IO) {
                    SshHostConnection.connect(
                        host.host, host.port, host.user, graph.sshIdentity, pinFor(host),
                        connectTimeoutMs = if (route == RoutePreference.AUTO) 4_000 else 10_000
                    )
                }
                adopt(ssh)
                scope.launch { runCatching { adoptRelayIfAdvertised(ssh, host) } }
                return ssh
            } catch (e: HostKeyChangedException) {
                // A changed host key is a security signal, not a network hiccup: say so, and do not
                // quietly route around it.
                val msg = e.message ?: "The computer's SSH host key changed."
                _state.value = ConnState.Failed(msg)
                throw HostException(msg)
            } catch (e: Exception) {
                errors += "On your network: ${e.message ?: e.javaClass.simpleName}"
            }
        }

        if (route != RoutePreference.SSH_ONLY) {
            val relay = host.relay
            val token = graph.secure.getString(SecureStore.relayTokenKey(host.id))
            val hostKey = host.relayHostKeyB64
            val decision = if (relay != null && token != null && hostKey != null) graph.relayGate.decide(hostId, trigger) else null
            if (decision is RelayApprovalGate.Decision.Skip) {
                errors += "Through the relay: ${decision.reason}"
            } else if (relay != null && token != null && hostKey != null) {
                val requireApproved = (decision as? RelayApprovalGate.Decision.Dial)?.requireApproved == true
                _state.value = ConnState.Connecting("Connecting through the relay…")
                try {
                    val join = RelayApi(graph.hosts.apiBase).join(token, relay.hostId)
                    val connected = RelayConnector.connect(
                        relayUrl = relay.relayEndpoint,
                        token = join.pairingToken,
                        deviceKeys = graph.boxKeys,
                        hostPublicKeyB64 = hostKey,
                        requireApproved = requireApproved,
                        onStatus = { st ->
                            when (st) {
                                is RelayConnectStatus.AwaitingApproval -> _state.value = ConnState.AwaitingApproval(st.sas)
                                RelayConnectStatus.Handshaking -> _state.value = ConnState.Connecting("Verifying your computer…")
                                RelayConnectStatus.MintingToken -> Unit
                            }
                        }
                    )
                    graph.relayGate.onConnected(hostId)
                    _snapshot.value = connected.first
                    adopt(connected.connection)
                    return connected.connection
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    graph.relayGate.onFailed(hostId, e)
                    errors += "Through the relay: ${e.message ?: e.javaClass.simpleName}"
                }
            } else if (route == RoutePreference.RELAY_ONLY || !host.sshAvailable) {
                errors += "Remote access isn't set up for this computer yet. In nodeterm on the computer, open " +
                    "Settings → Phone and turn on remote access, then pair again — or connect once on the same network."
            }
        }

        val msg = errors.joinToString("\n").ifEmpty { "Couldn't connect." }
        _state.value = ConnState.Failed(msg)
        throw HostException(msg)
    }

    private fun adopt(c: HostConnection) {
        conn = c
        _lastError.value = null
        _state.value = ConnState.Connected(c.kind)
        c.setOnClosed { reason ->
            if (conn === c) {
                conn = null
                _state.value = ConnState.Failed("Disconnected" + (reason?.let { " ($it)" } ?: "") + ".")
                if (watchers > 0) scope.launch {
                    delay(1_500)
                    refreshNow()
                }
            }
        }
        c.setOnChanged { scope.launch { refreshNow() } }
    }

    private fun pinFor(host: PairedHost) = object : HostKeyPin {
        override fun pinned(): String? = graph.hosts.get(host.id)?.sshHostKeyFingerprint
        override fun pin(fingerprint: String) = graph.hosts.update(host.id) { it.copy(sshHostKeyFingerprint = fingerprint) }
    }

    /**
     * LATE ADOPTION (relay-advertise.ts): a phone paired while remote access was off has no relay leg.
     * While the standing host is up, the computer advertises its relay identity in
     * `~/.nodeterm/relay.json`; read it over this TOFU-verified SSH connection and mint our own device
     * token, so the phone can reach the computer from anywhere without re-pairing.
     */
    private suspend fun adoptRelayIfAdvertised(ssh: SshHostConnection, host: PairedHost) {
        val tokenKey = SecureStore.relayTokenKey(host.id)
        if (host.relay != null && graph.secure.getString(tokenKey) != null) return
        val ad = ssh.readRelayAdvertisement() ?: return
        val hostIdAd = J.str(ad["hostId"]) ?: return
        val pub = J.str(ad["hostPublicKeyB64"]) ?: return
        val endpoint = J.str(ad["relayEndpoint"])?.takeIf(PairingPayload::isAllowedRelayEndpoint) ?: return
        val hostDeviceId = J.str(ad["hostDeviceId"]) ?: return
        // The QR's host key is the identity we paired with: an advertisement naming another key is
        // not this computer's relay identity.
        if (host.hostKeyB64 != null && host.hostKeyB64 != pub) return
        val minted = RelayApi(graph.hosts.apiBase).mintDevice(
            deviceId = graph.hosts.deviceId,
            hostDeviceId = hostDeviceId,
            hostPublicKeyB64 = pub,
            label = graph.hosts.deviceName,
            priorDeviceToken = graph.secure.getString(tokenKey)
        )
        graph.secure.putString(tokenKey, minted.deviceToken)
        graph.hosts.update(host.id) {
            it.copy(relay = RelayBlock(minted.hostId.ifEmpty { hostIdAd }, pub, endpoint))
        }
    }

    /**
     * Re-list now. Connects first when needed; failures land in [state]/[lastError], never throw.
     * [trigger] says who asked: a [Trigger.USER] refresh releases a held relay approval, a
     * [Trigger.BACKGROUND] one never makes a first relay handshake (see [RelayApprovalGate]).
     */
    suspend fun refreshNow(trigger: Trigger = Trigger.AUTO) {
        try {
            val c = ensureConnected(trigger)
            _snapshot.value = c.listProjects()
            _lastError.value = null
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            _lastError.value = e.message
            // A HostException is an ANSWER (the host refused, or the connection already reported its
            // own drop). Anything else is an unexpected transport failure: drop the connection so the
            // next refresh dials a fresh one instead of reusing a dead socket.
            if (e !is HostException) disconnect()
        }
    }

    /** A refresh the USER asked for (Refresh, Try again). */
    fun refresh() {
        scope.launch { refreshNow(Trigger.USER) }
    }

    /** While a screen shows this computer, re-list every 8 s (the iOS foreground cadence). */
    @Synchronized
    fun startWatching() {
        watchers++
        if (pollJob == null) {
            pollJob = scope.launch {
                // Opening the computer is the user asking; the polls after it are the app's own.
                var trigger = Trigger.USER
                while (isActive) {
                    refreshNow(trigger)
                    trigger = Trigger.AUTO
                    delay(POLL_MS)
                }
            }
        }
    }

    @Synchronized
    fun stopWatching() {
        watchers = (watchers - 1).coerceAtLeast(0)
        if (watchers == 0) {
            pollJob?.cancel()
            pollJob = null
        }
    }

    /**
     * Drop the connection. Callers include click handlers on the MAIN thread (Forget, a route change,
     * re-pairing), so the close itself runs on [Dispatchers.IO]: a socket write there throws
     * `NetworkOnMainThreadException` and would leak the socket (audit A01).
     */
    fun disconnect() {
        val c = conn
        conn = null
        if (c != null) scope.launch(Dispatchers.IO) { runCatching { c.close() } }
        _state.value = ConnState.Idle
    }

    companion object {
        const val POLL_MS = 8_000L
    }
}

class ConnectionManager(private val graph: AppGraph) {
    private val sessions = HashMap<String, HostSession>()

    @Synchronized
    fun session(hostId: String): HostSession = sessions.getOrPut(hostId) { HostSession(hostId, graph) }

    @Synchronized
    fun forget(hostId: String) {
        graph.relayGate.forget(hostId)
        sessions.remove(hostId)?.disconnect()
    }

    @Synchronized
    fun all(): List<HostSession> = sessions.values.toList()
}
