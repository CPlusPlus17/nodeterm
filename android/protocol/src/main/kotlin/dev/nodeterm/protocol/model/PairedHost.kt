package dev.nodeterm.protocol.model

import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.l
import dev.nodeterm.protocol.model.J.o
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.PairingResult
import dev.nodeterm.protocol.pairing.RelayBlock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * One paired computer, as the phone keeps it. Public facts only — the phone's own secrets (its box
 * key, its SSH seed) live in the app's Keystore-backed store, never in this record — except the
 * relay device token, which is a bearer credential and is therefore persisted by the app through
 * the same encrypted store (see the app's `SecureStore`).
 */
data class PairedHost(
    /** Local id for this pairing (the host-assigned deviceId — unique per pairing). */
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val user: String,
    val sshAvailable: Boolean,
    /** The host's box key from the QR (`hostKey`): the relay identity pinned at pairing. */
    val hostKeyB64: String?,
    val relay: RelayBlock?,
    /** `SHA256:…` of the SSH host key, pinned on first connect (TOFU). */
    val sshHostKeyFingerprint: String?,
    val pairedAt: Long
) {
    /** The relay host key: the relay block's when present, else the QR's `hostKey` (same key). */
    val relayHostKeyB64: String? get() = relay?.hostPublicKeyB64 ?: hostKeyB64

    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("name", name)
        put("host", host)
        put("port", port)
        put("user", user)
        put("sshAvailable", sshAvailable)
        hostKeyB64?.let { put("hostKeyB64", it) }
        relay?.let { r ->
            put("relay", buildJsonObject {
                put("hostId", r.hostId)
                put("hostPublicKeyB64", r.hostPublicKeyB64)
                put("relayEndpoint", r.relayEndpoint)
            })
        }
        sshHostKeyFingerprint?.let { put("sshHostKeyFingerprint", it) }
        put("pairedAt", pairedAt)
    }

    companion object {
        fun fromJson(o: JsonObject): PairedHost? {
            val id = o.s("id") ?: return null
            return PairedHost(
                id = id,
                name = o.s("name") ?: "Computer",
                host = o.s("host") ?: return null,
                port = o.l("port")?.toInt() ?: 22,
                user = o.s("user") ?: return null,
                sshAvailable = o.b("sshAvailable") != false,
                hostKeyB64 = o.s("hostKeyB64"),
                relay = o.o("relay")?.let(PairingPayload::parseRelayBlock),
                sshHostKeyFingerprint = o.s("sshHostKeyFingerprint"),
                pairedAt = o.l("pairedAt") ?: 0
            )
        }

        fun from(payload: PairingPayload, result: PairingResult, now: Long = System.currentTimeMillis()) = PairedHost(
            id = result.deviceId,
            name = payload.name,
            host = payload.host,
            port = payload.port,
            user = payload.user,
            sshAvailable = payload.sshAvailable,
            hostKeyB64 = payload.hostKey,
            relay = result.relay ?: payload.relay,
            sshHostKeyFingerprint = null,
            pairedAt = now
        )
    }
}
