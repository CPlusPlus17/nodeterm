package dev.nodeterm.protocol.pairing

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.crypto.E2ee
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.o
import dev.nodeterm.protocol.model.J.s
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket

class PairingException(message: String) : Exception(message)

/**
 * The phone side of `src/main/pairing-service.ts`'s `/pair` listener.
 *
 * Request body `{token, publicKey, deviceName, deviceId, priorDeviceToken?, boxPublicKey?}`.
 * `boxPublicKey` (the phone's persistent relay identity) is sent ONLY inside the sealed body; a
 * desktop that knows it pins it on its standing host and answers `relayPinned: true`, so the first
 * relay connect needs no approval at the desk (audit A07). An older desktop ignores it. When the QR carried a
 * `hostKey`, the whole body is sealed to it — `{epk: <ephemeral box pubkey>, box: base64(nonce ‖
 * secretbox)}` under `box.before(hostKey, ephemeralSecret)` — and the answer comes back sealed the
 * same way, so the relay device token never crosses the LAN in the clear.
 *
 * Spoken over a RAW TCP socket rather than an HTTP client, like the iOS app: a bare-IP `http://`
 * URL is cleartext traffic Android's network security policy blocks by default for HTTP stacks,
 * and the desktop frames every response with an explicit Content-Length precisely so a minimal
 * reader works (pairing-service.ts `send`). A non-2xx body is plain text meant for the user.
 */
class PairingClient(private val connectTimeoutMs: Int = 8_000, private val readTimeoutMs: Int = 20_000) {

    suspend fun pair(
        payload: PairingPayload,
        sshPublicKeyLine: String,
        deviceName: String,
        deviceId: String,
        priorDeviceToken: String? = null,
        boxPublicKeyB64: String? = null
    ): PairingResult = withContext(Dispatchers.IO) {
        val inner = buildJsonObject {
            put("token", payload.token)
            put("publicKey", sshPublicKeyLine)
            put("deviceName", deviceName)
            put("deviceId", deviceId)
            priorDeviceToken?.let { put("priorDeviceToken", it) }
            // Only ever sealed: a plaintext body could be rewritten on the LAN, and the desktop
            // ignores the field there anyway.
            if (payload.hostKey != null) boxPublicKeyB64?.let { put("boxPublicKey", it) }
        }.toString()

        var shared: ByteArray? = null
        val body = if (payload.hostKey != null) {
            val eph = BoxKeyPair.generate()
            val key = E2ee.deriveSharedKey(payload.hostKey, eph.secretKey)
            shared = key
            buildJsonObject {
                put("epk", eph.publicKeyB64)
                put("box", B64.encode(E2ee.encrypt(inner.toByteArray(Charsets.UTF_8), key)))
            }.toString()
        } else {
            inner
        }

        val (status, text) = postRaw(payload.host, payload.pairPort, "/pair", body)
        if (status !in 200..299) {
            throw PairingException(
                if (text.isNotBlank()) "The computer rejected pairing: ${text.trim()}"
                else "The computer rejected pairing (HTTP $status)."
            )
        }
        var obj = J.obj(J.parse(text)) ?: throw PairingException("The computer answered with something that is not JSON.")
        if (shared != null) {
            val sealed = obj.s("box")?.let(B64::decode)
                ?: throw PairingException("The computer's answer was not encrypted as expected.")
            val plain = E2ee.decrypt(sealed, shared)
                ?: throw PairingException("Couldn't decrypt the computer's answer — was the QR code from this computer?")
            obj = J.obj(J.parse(String(plain, Charsets.UTF_8)))
                ?: throw PairingException("The computer's answer was not valid JSON.")
        }
        if (obj.b("ok") != true) throw PairingException("The computer did not confirm the pairing.")
        PairingResult(
            deviceId = obj.s("deviceId") ?: throw PairingException("The computer did not assign a device id."),
            agentToken = obj.s("agentToken") ?: "",
            relay = obj.o("relay")?.let(PairingPayload::parseRelayBlock),
            relayDeviceToken = obj.s("relayDeviceToken"),
            relayPinned = obj.b("relayPinned") == true
        )
    }

    private fun postRaw(host: String, port: Int, path: String, body: String): Pair<Int, String> {
        val bytes = body.toByteArray(Charsets.UTF_8)
        try {
            Socket().use { sock ->
                sock.connect(InetSocketAddress(host, port), connectTimeoutMs)
                sock.soTimeout = readTimeoutMs
                val hostHeader = if (host.contains(':')) "[$host]:$port" else "$host:$port"
                val head = "POST $path HTTP/1.1\r\n" +
                    "Host: $hostHeader\r\n" +
                    "Content-Type: application/json\r\n" +
                    "Content-Length: ${bytes.size}\r\n" +
                    "Connection: close\r\n\r\n"
                val out = sock.getOutputStream()
                out.write(head.toByteArray(Charsets.US_ASCII))
                out.write(bytes)
                out.flush()
                return readResponse(sock.getInputStream())
            }
        } catch (e: IOException) {
            throw PairingException(
                "Couldn't reach the computer at $host:$port (${e.message ?: e.javaClass.simpleName}). " +
                    "Is the phone on the same network, and is the pairing code still on screen?"
            )
        }
    }

    /** Minimal HTTP/1.1 response reader: status line, headers, then Content-Length (or EOF) body. */
    internal fun readResponse(input: InputStream): Pair<Int, String> {
        val headBytes = ByteArrayOutputStream()
        var last4 = 0
        while (true) {
            val c = input.read()
            if (c < 0) break
            headBytes.write(c)
            last4 = (last4 shl 8) or c
            if (last4 == 0x0d0a0d0a) break
            if (headBytes.size() > 64 * 1024) throw IOException("response header too large")
        }
        val head = headBytes.toString(Charsets.ISO_8859_1.name())
        val lines = head.split("\r\n")
        val status = lines.firstOrNull()?.split(' ')?.getOrNull(1)?.toIntOrNull()
            ?: throw IOException("malformed HTTP response")
        val length = lines.drop(1).firstNotNullOfOrNull { line ->
            val idx = line.indexOf(':')
            if (idx > 0 && line.substring(0, idx).trim().equals("content-length", ignoreCase = true)) {
                line.substring(idx + 1).trim().toIntOrNull()
            } else null
        }
        val body = if (length != null) {
            val buf = ByteArray(length)
            var off = 0
            while (off < length) {
                val n = input.read(buf, off, length - off)
                if (n < 0) break
                off += n
            }
            buf.copyOf(off)
        } else {
            input.readBytes()
        }
        return status to String(body, Charsets.UTF_8)
    }
}
