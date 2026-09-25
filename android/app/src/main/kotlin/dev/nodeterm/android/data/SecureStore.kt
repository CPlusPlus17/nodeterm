package dev.nodeterm.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secrets at rest: AES-256-GCM under a key that lives in the Android Keystore (it never leaves the
 * secure hardware / keystore daemon), ciphertext in app-private SharedPreferences. What it holds is
 * exactly what the iOS app keeps in its Keychain:
 *
 *  - the phone's persistent NaCl box secret key — the identity the desktop PINS on first approval,
 *    so it must survive restarts (a fresh key per launch would re-prompt every time and break pinning);
 *  - the phone's Ed25519 SSH seed (its public half sits in the computer's authorized_keys);
 *  - relay device tokens, one per paired computer (bearer credentials for `/v1/relay/join`).
 *
 * `allowBackup="false"` in the manifest keeps the ciphertext off cloud backups too; a restored
 * copy could not be decrypted on another device anyway.
 */
class SecureStore(context: Context) {
    private val prefs = context.getSharedPreferences("nodeterm.secure", Context.MODE_PRIVATE)

    private val key: SecretKey by lazy {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            .apply {
                init(
                    KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .build()
                )
            }
            .generateKey()
    }

    @Synchronized
    fun putBytes(name: String, value: ByteArray) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val sealed = cipher.iv + cipher.doFinal(value)
        prefs.edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }

    @Synchronized
    fun getBytes(name: String): ByteArray? {
        val raw = prefs.getString(name, null) ?: return null
        return try {
            val sealed = Base64.decode(raw, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed, 0, IV_BYTES))
            cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
        } catch (_: Exception) {
            // A value we cannot open (keystore wiped, restored onto another device) is not a crash:
            // the caller regenerates / asks the user to re-pair.
            null
        }
    }

    fun putString(name: String, value: String) = putBytes(name, value.toByteArray(Charsets.UTF_8))
    fun getString(name: String): String? = getBytes(name)?.toString(Charsets.UTF_8)

    @Synchronized
    fun remove(name: String) {
        prefs.edit().remove(name).apply()
    }

    /** Get-or-create 32 random bytes under [name] (the box secret, the SSH seed). */
    @Synchronized
    fun getOrCreate32(name: String): ByteArray {
        getBytes(name)?.takeIf { it.size == 32 }?.let { return it }
        val fresh = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
        putBytes(name, fresh)
        return fresh
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "nodeterm.secure.v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12

        const val BOX_SECRET = "box.secret"
        const val SSH_SEED = "ssh.seed"
        fun relayTokenKey(hostId: String) = "relay.token.$hostId"
    }
}
