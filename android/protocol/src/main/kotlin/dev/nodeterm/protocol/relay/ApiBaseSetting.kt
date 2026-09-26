package dev.nodeterm.protocol.relay

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The relay API address the user can edit under Settings → Advanced, and what leaving that screen
 * does with it (audit A44). The address is stored only when the user leaves the screen, never per
 * keystroke: a half-typed value such as `https://a` would otherwise be the one every relay call
 * used until the typing was done.
 */
object ApiBaseSetting {
    /** What leaving Settings does with the typed address. */
    sealed interface OnLeave {
        /** Store [value]. */
        data class Save(val value: String) : OnLeave

        /**
         * Not an address we accept, but it is what is already stored (a value an older build
         * saved): nothing to store, and nothing to tell a user who did not type it.
         */
        data object Keep : OnLeave

        /** Not an address we accept: nothing is stored, and the user must be told so. */
        data object Rejected : OnLeave
    }

    /**
     * [typed] as it is to be stored (trimmed, without a trailing slash), or null when it is not an
     * address the phone will use. It must start with `https://` (the device token and the relay
     * tokens ride it), and be a URL with a host and without a query or fragment. The old rule was
     * only the prefix check. It let `https://` through, which is stored as `https:` and which OkHttp
     * then reads, with the `/v1/…` path [RelayApi] appends, as a host named `v1`. It let
     * `https://?x`, `https://:443` and `https://a b` through, and with those every relay call threw
     * IllegalArgumentException from OkHttp's `Request.Builder.url`, which [RelayApi] does not turn
     * into a [RelayApiException] (measured with okhttp 4.12.0). A query or fragment swallows the
     * appended path.
     */
    fun accept(typed: String): String? {
        val base = normalize(typed)
        if (!base.startsWith("https://", ignoreCase = true)) return null
        val url = base.toHttpUrlOrNull() ?: return null
        if (!url.isHttps || url.query != null || url.fragment != null) return null
        return base
    }

    /** What leaving Settings does with [typed], given the address [stored] now. */
    fun onLeave(typed: String, stored: String): OnLeave {
        accept(typed)?.let { return OnLeave.Save(it) }
        return if (normalize(typed) == normalize(stored)) OnLeave.Keep else OnLeave.Rejected
    }

    /** The form the app stores an address in (HostStore's setter trims the same way). */
    private fun normalize(address: String): String = address.trim().trimEnd('/')
}
