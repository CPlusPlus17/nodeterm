package dev.nodeterm.protocol.pairing

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.l
import dev.nodeterm.protocol.model.J.o
import dev.nodeterm.protocol.model.J.s
import kotlinx.serialization.json.JsonObject
import java.net.URI

/** `RelayPairingBlock` (pairing-core.ts): how to reach this host over the relay. */
data class RelayBlock(val hostId: String, val hostPublicKeyB64: String, val relayEndpoint: String)

/**
 * The QR the desktop shows under Settings → Phone (`buildPairingPayload`, pairing-core.ts):
 * `{"v":1,"host":…,"port":22,"user":…,"token":…,"pairPort":N,"nodeterm":true,"name":…,
 *   "hostKey"?:…, "relay"?:{…}, "ssh"?:false}`.
 */
data class PairingPayload(
    val host: String,
    val port: Int,
    val user: String,
    val token: String,
    val pairPort: Int,
    val name: String,
    /** The host's NaCl box key: seal `/pair` to it. Also the relay host key. */
    val hostKey: String?,
    val relay: RelayBlock?,
    /** False on a Windows host: no SSH key is installed; the phone must use the relay. */
    val sshAvailable: Boolean
) {
    companion object {
        /** Null for anything that is not a nodeterm pairing payload — never throws. */
        fun parse(text: String): PairingPayload? {
            val o = J.obj(J.parse(text.trim())) ?: return null
            if (o.l("v") != 1L || o.b("nodeterm") != true) return null
            val host = o.s("host")?.takeIf { it.isNotBlank() } ?: return null
            val user = o.s("user")?.takeIf { it.isNotBlank() } ?: return null
            val token = o.s("token")?.takeIf { it.isNotBlank() } ?: return null
            val pairPort = o.l("pairPort")?.toInt()?.takeIf { it in 1..65535 } ?: return null
            val port = o.l("port")?.toInt()?.takeIf { it in 1..65535 } ?: 22
            val hostKey = o.s("hostKey")?.takeIf { B64.decode(it)?.size == 32 }
            return PairingPayload(
                host = host,
                port = port,
                user = user,
                token = token,
                pairPort = pairPort,
                name = o.s("name")?.takeIf { it.isNotBlank() } ?: host,
                hostKey = hostKey,
                relay = o.o("relay")?.let(::parseRelayBlock),
                sshAvailable = o.b("ssh") != false
            )
        }

        fun parseRelayBlock(r: JsonObject): RelayBlock? {
            val hostId = r.s("hostId")?.takeIf { it.isNotBlank() } ?: return null
            val pub = r.s("hostPublicKeyB64")?.takeIf { B64.decode(it)?.size == 32 } ?: return null
            val endpoint = r.s("relayEndpoint")?.takeIf(::isAllowedRelayEndpoint) ?: return null
            return RelayBlock(hostId, pub, endpoint)
        }

        /**
         * R5 (pairing.ts): the phone dials the relay endpoint verbatim, so a payload must not point
         * it at plaintext — `wss:` only, `ws:` solely for loopback (a local relay in dev/tests).
         */
        fun isAllowedRelayEndpoint(endpoint: String): Boolean {
            val uri = try {
                URI(endpoint)
            } catch (_: Exception) {
                return false
            }
            return when (uri.scheme) {
                "wss" -> !uri.host.isNullOrEmpty()
                "ws" -> uri.host in setOf("127.0.0.1", "localhost", "::1", "[::1]")
                else -> false
            }
        }
    }
}

/** What `/pair` answered: the host-minted identity plus, when remote access is on, a relay leg. */
data class PairingResult(
    val deviceId: String,
    val agentToken: String,
    val relay: RelayBlock?,
    val relayDeviceToken: String?
)
