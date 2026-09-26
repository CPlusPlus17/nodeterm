package dev.nodeterm.protocol.relay

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The relay API address the user can edit under Settings → Advanced, and what leaving that screen
 * does with it (audit A44). The address is stored only when the user leaves the screen, never per
 * keystroke: a half-typed value such as `https://a` would otherwise be the one every relay call
 * used until the typing was done.
 *
 * Leaving without an edit stores nothing, and the built-in default is never stored as an address.
 * The app's store answers [RelayApi.DEFAULT_API_BASE] while it holds no address, so a phone that
 * holds none follows the default of whichever build it runs. Storing the default (as the first A44
 * fix did on every leave) would pin the phone to this build's default for good, and the field could
 * not show the difference: the pinned and the followed default read the same.
 */
object ApiBaseSetting {
    /** What leaving Settings does with the typed address. */
    sealed interface OnLeave {
        /** Store [value]. */
        data class Save(val value: String) : OnLeave

        /**
         * The built-in default: forget any stored address, so the phone follows the default,
         * including a later build's. It is also the answer for an unedited field on a phone that
         * stores no address, where forgetting one changes nothing.
         */
        data object UseDefault : OnLeave

        /**
         * What is already stored: nothing to store. That is an unedited address, or one we would
         * not accept that an older build saved, which a user who did not type it is not told about.
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

    /**
     * What leaving Settings does with [typed], given the address [stored] now ([RelayApi.DEFAULT_API_BASE]
     * when none is stored). The default is checked first: it heals a phone an earlier build pinned to it.
     */
    fun onLeave(typed: String, stored: String): OnLeave {
        val unchanged = normalize(typed) == normalize(stored)
        val accepted = accept(typed) ?: return if (unchanged) OnLeave.Keep else OnLeave.Rejected
        return when {
            accepted == RelayApi.DEFAULT_API_BASE -> OnLeave.UseDefault
            unchanged -> OnLeave.Keep
            else -> OnLeave.Save(accepted)
        }
    }

    /** The form the app stores an address in (HostStore's setter trims the same way). */
    private fun normalize(address: String): String = address.trim().trimEnd('/')
}
