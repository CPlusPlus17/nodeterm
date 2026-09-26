package dev.nodeterm.protocol

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.pairing.PairingClient
import dev.nodeterm.protocol.pairing.PairingException
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.SshIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The phone's `/pair` exchange against the DESKTOP's real `createPairingService`
 * (src/main/pairing-service.ts), with HOME pointed at a temp dir so the authorized_keys line it
 * writes can be inspected. Covers the E2EE-sealed exchange (the QR carries `hostKey`) with and
 * without a relay leg.
 */
class PairingInteropTest {
    private val cleanup = ArrayList<AutoCloseable>()

    @AfterTest
    fun tearDown() = cleanup.forEach { it.close() }

    private fun start(withRelay: Boolean): Pair<InteropHarness, File> {
        val home = Files.createTempDirectory("nt-pair-home").toFile()
        cleanup += AutoCloseable { home.deleteRecursively() }
        val h = InteropHarness.start(
            "pair",
            mapOf("HOME" to home.path, "FIXTURE_USERDATA" to home.path, "FIXTURE_RELAY" to if (withRelay) "1" else "0")
        )
        cleanup += h
        return h to home
    }

    private fun payloadOf(h: InteropHarness): PairingPayload =
        assertNotNull(PairingPayload.parse(h.ready["payload"]!!.jsonPrimitive.content), "the desktop's QR must parse")

    @Test
    fun `an E2EE pairing installs our key under the desktop's attributable comment`() = runBlocking<Unit> {
        val (h, home) = start(withRelay = false)
        val payload = payloadOf(h)
        assertEquals(h.ready["hostPublicKeyB64"]!!.jsonPrimitive.content, payload.hostKey, "QR carries the host box key")
        assertTrue(payload.sshAvailable)
        assertNull(payload.relay)
        val identity = SshIdentity.generate()
        val result = PairingClient().pair(payload, identity.authorizedKeysLine(), "Pixel Test", "android-device-1")
        assertTrue(result.deviceId.isNotBlank())
        assertTrue(result.agentToken.isNotBlank())
        assertNull(result.relayDeviceToken)
        val done = h.awaitEvent("done")
        assertEquals("true", done["ok"]!!.jsonPrimitive.content)
        val keys = File(home, ".ssh/authorized_keys").readText()
        assertTrue(
            keys.contains("ssh-ed25519 ${B64.encode(identity.publicKeyBlob)} nodeterm-ios-${result.deviceId}"),
            "authorized_keys: $keys"
        )
        val agent = File(home, ".nodeterm/agent.json").readText()
        assertTrue(agent.contains("\"name\": \"Pixel Test\""), agent)
        assertTrue(agent.contains("\"relayDeviceId\": \"android-device-1\""), agent)
    }

    @Test
    fun `with remote access on, the sealed answer carries the relay leg`() = runBlocking<Unit> {
        val (h, _) = start(withRelay = true)
        val payload = payloadOf(h)
        val relay = assertNotNull(payload.relay, "QR relay block")
        assertEquals("wss://relay.example.test", relay.relayEndpoint)
        val result = PairingClient().pair(payload, SshIdentity.generate().authorizedKeysLine(), "Pixel", "android-device-2", priorDeviceToken = "old-token")
        assertEquals("device-token-xyz", result.relayDeviceToken)
        assertEquals("minted-host-id", result.relay?.hostId)
        val api = h.awaitEvent("api")
        val body = api["body"]!!.jsonObject
        assertEquals("android-device-2", body["deviceId"]!!.jsonPrimitive.content, "the backend row is keyed by OUR id")
        assertEquals("old-token", body["priorDeviceToken"]!!.jsonPrimitive.content)
        assertEquals("Pixel", body["label"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a wrong token is refused with the desktop's own words`() = runBlocking<Unit> {
        val (h, home) = start(withRelay = false)
        val forged = payloadOf(h).copy(token = "not-the-token")
        val e = assertFailsWith<PairingException> {
            PairingClient().pair(forged, SshIdentity.generate().authorizedKeysLine(), "x", "y")
        }
        assertTrue(e.message!!.contains("bad token"), e.message)
        assertTrue(!File(home, ".ssh/authorized_keys").exists())
    }

    @Test
    fun `the phone's relay key rides the sealed body and the desktop pins it`() = runBlocking<Unit> {
        // A07: approving at the scan, so the first remote connect needs nobody at the desk.
        val (h, _) = start(withRelay = true)
        val box = dev.nodeterm.protocol.crypto.BoxKeyPair.generate()
        val result = PairingClient().pair(
            payloadOf(h), SshIdentity.generate().authorizedKeysLine(), "Pixel", "android-device-3", boxPublicKeyB64 = box.publicKeyB64
        )
        assertTrue(result.relayPinned)
        assertEquals(box.publicKeyB64, h.awaitEvent("pin")["pub"]!!.jsonPrimitive.content)
    }

    @Test
    fun `without a relay leg nothing is pinned and the answer says so`() = runBlocking<Unit> {
        val (h, _) = start(withRelay = false)
        val box = dev.nodeterm.protocol.crypto.BoxKeyPair.generate()
        val result = PairingClient().pair(
            payloadOf(h), SshIdentity.generate().authorizedKeysLine(), "Pixel", "android-device-4", boxPublicKeyB64 = box.publicKeyB64
        )
        assertTrue(!result.relayPinned)
    }
}
