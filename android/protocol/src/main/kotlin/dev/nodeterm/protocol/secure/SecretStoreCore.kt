package dev.nodeterm.protocol.secure

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.AEADBadTagException

/** Where sealed values are kept (app-private preferences on Android). */
interface SecretStorage {
    fun get(name: String): String?
    /** [durable] = do not return before the value is on disk (the phone's identity secrets). */
    fun put(name: String, value: String, durable: Boolean)
    fun remove(name: String)
}

/** Seals and opens values (AES-GCM under an Android Keystore key). [open] throws on failure. */
interface Sealer {
    fun seal(plain: ByteArray): ByteArray
    fun open(sealed: ByteArray): ByteArray
}

/**
 * A stored secret cannot be read RIGHT NOW (the keystore is busy, locked, or threw something we do
 * not recognise). It is not evidence the value is gone, so nothing is overwritten; try again later.
 */
class SecretUnavailableException(name: String, cause: Throwable) :
    Exception("A stored secret ($name) can't be read right now: ${cause.message ?: cause.javaClass.simpleName}", cause)

/**
 * The phone's secrets at rest, with one rule the first version got wrong (audit A24): a value is
 * replaced only on POSITIVE evidence it can never be read again. That version turned ANY decrypt
 * error into "absent", and `getOrCreate32` then wrote fresh random bytes over the phone's relay and
 * SSH identities — after which every paired computer had to approve the phone again (someone at
 * the desk) and direct SSH failed until a re-pair.
 *
 * Positive evidence is: nothing stored; a stored blob that is malformed (not base64, or too short to
 * hold a nonce and a tag); or the cipher's own authentication failing (`AEADBadTagException` — the
 * key that sealed it is gone). Anything else is [SecretUnavailableException], and nothing is written.
 */
class SecretStoreCore(private val storage: SecretStorage, private val sealer: Sealer) {
    sealed interface Read {
        data object Absent : Read
        class Value(val bytes: ByteArray) : Read
        /** Stored, but provably never readable again. */
        data class Lost(val reason: String) : Read
    }

    @Synchronized
    fun read(name: String): Read {
        val raw = storage.get(name) ?: return Read.Absent
        val sealed = try {
            Base64.getDecoder().decode(raw)
        } catch (_: IllegalArgumentException) {
            return Read.Lost("not base64")
        }
        if (sealed.size < MIN_SEALED_BYTES) return Read.Lost("too short")
        return try {
            Read.Value(sealer.open(sealed))
        } catch (_: AEADBadTagException) {
            Read.Lost("authentication failed")
        } catch (e: Exception) {
            throw SecretUnavailableException(name, e)
        }
    }

    /** The value, or null when absent or lost. Throws [SecretUnavailableException] when unreadable NOW. */
    fun getBytes(name: String): ByteArray? = (read(name) as? Read.Value)?.bytes

    @Synchronized
    fun putBytes(name: String, value: ByteArray, durable: Boolean = false) {
        storage.put(name, Base64.getEncoder().encodeToString(sealer.seal(value)), durable)
    }

    @Synchronized
    fun remove(name: String) = storage.remove(name)

    /**
     * Get-or-create 32 random bytes under [name] (the box secret, the SSH seed). Creates only when
     * nothing is stored or the stored value is provably lost; the first write is durable.
     */
    @Synchronized
    fun getOrCreate32(name: String): ByteArray {
        when (val r = read(name)) {
            is Read.Value -> if (r.bytes.size == 32) return r.bytes
            Read.Absent, is Read.Lost -> Unit
        }
        val fresh = ByteArray(32).also { SecureRandom().nextBytes(it) }
        putBytes(name, fresh, durable = true)
        return fresh
    }

    companion object {
        /** A 12-byte GCM nonce plus a 16-byte tag: anything shorter was never a sealed value. */
        const val MIN_SEALED_BYTES = 12 + 16
    }
}
