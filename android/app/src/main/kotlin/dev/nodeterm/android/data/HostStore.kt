package dev.nodeterm.android.data

import android.content.Context
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.OnScreen
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.SeenLog
import dev.nodeterm.protocol.secure.PlainStorage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** How to reach a computer. Auto = direct SSH on the LAN first, the relay when that fails. */
enum class RoutePreference { AUTO, SSH_ONLY, RELAY_ONLY }

/**
 * The paired computers (public facts only — see [PairedHost]) plus phone-level preferences. Secrets
 * are in [SecureStore].
 */
class HostStore(context: Context) {
    private val prefs = context.getSharedPreferences("nodeterm.hosts", Context.MODE_PRIVATE)
    private val _hosts = MutableStateFlow(load())
    val hosts: StateFlow<List<PairedHost>> = _hosts.asStateFlow()

    private fun load(): List<PairedHost> {
        val raw = prefs.getString("hosts", null) ?: return emptyList()
        return try {
            (Json.parseToJsonElement(raw) as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(PairedHost::fromJson) } ?: emptyList()
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun save(list: List<PairedHost>) {
        prefs.edit().putString("hosts", JsonArray(list.map { it.toJson() }).toString()).apply()
        _hosts.value = list
    }

    fun get(id: String): PairedHost? = _hosts.value.firstOrNull { it.id == id }

    /** Re-pairing the same computer (same host + user) replaces the old record. */
    @Synchronized
    fun upsert(host: PairedHost) {
        save(_hosts.value.filterNot { it.id == host.id || (it.host == host.host && it.user == host.user && it.name == host.name) } + host)
    }

    @Synchronized
    fun update(id: String, change: (PairedHost) -> PairedHost) {
        save(_hosts.value.map { if (it.id == id) change(it) else it })
    }

    @Synchronized
    fun remove(id: String) {
        save(_hosts.value.filterNot { it.id == id })
        prefs.edit().remove("route.$id").remove("relayApproved.$id").apply()
    }

    /**
     * This computer serves this phone over the relay without an approval dialog: a relay connect has
     * succeeded (its standing host pinned our box key), or pairing pinned it. Gates the background
     * worker's relay leg (dev.nodeterm.protocol.host.RelayApprovalGate, audit A05).
     */
    fun relayApproved(id: String): Boolean = prefs.getBoolean("relayApproved.$id", false)

    fun setRelayApproved(id: String, approved: Boolean) {
        prefs.edit().putBoolean("relayApproved.$id", approved).apply()
    }

    fun route(id: String): RoutePreference =
        runCatching { RoutePreference.valueOf(prefs.getString("route.$id", null) ?: "AUTO") }.getOrDefault(RoutePreference.AUTO)

    fun setRoute(id: String, route: RoutePreference) {
        prefs.edit().putString("route.$id", route.name).apply()
    }

    /**
     * Where the phone's relay deviceId is kept (under `deviceId`, as before). It is read and minted
     * only through dev.nodeterm.protocol.secure.PhoneIdentity (`AppGraph.identity`), which keeps it
     * coupled to the box key it belongs to (audit A51). Durable writes use commit() and throw when it
     * fails: the deviceId must be gone from disk before a new box key is written to the other
     * preferences file, and a failed removal must stop that key from being written.
     */
    val identityStorage: PlainStorage = object : PlainStorage {
        override fun get(name: String): String? = prefs.getString(name, null)
        override fun put(name: String, value: String, durable: Boolean) =
            write(prefs.edit().putString(name, value), durable)
        override fun remove(name: String, durable: Boolean) =
            write(prefs.edit().remove(name), durable)

        private fun write(edit: android.content.SharedPreferences.Editor, durable: Boolean) {
            if (!durable) return edit.apply()
            if (!edit.commit()) throw java.io.IOException("Couldn't save the phone's relay id.")
        }
    }

    var deviceName: String
        get() = prefs.getString("deviceName", null) ?: (android.os.Build.MODEL ?: "Android phone")
        set(value) {
            prefs.edit().putString("deviceName", value.trim().ifEmpty { android.os.Build.MODEL ?: "Android phone" }).apply()
        }

    var apiBase: String
        get() = prefs.getString("apiBase", null) ?: dev.nodeterm.protocol.relay.RelayApi.DEFAULT_API_BASE
        set(value) {
            prefs.edit().putString("apiBase", value.trim().trimEnd('/')).apply()
        }

    /**
     * Forget the stored relay address, so [apiBase] answers the built-in default, a later build's
     * included (dev.nodeterm.protocol.relay.ApiBaseSetting.OnLeave.UseDefault). Removing a key
     * that is not there changes nothing.
     */
    fun useDefaultApiBase() {
        prefs.edit().remove("apiBase").apply()
    }

    var notificationsEnabled: Boolean
        get() = prefs.getBoolean("notify", true)
        set(value) {
            prefs.edit().putBoolean("notify", value).apply()
        }

    /**
     * "Show details in notifications": put the event's own text (the command, file or question and
     * the agent's last message) in its notification. OFF by default, because Android shows a
     * notification's full content on a secure lock screen unless the user hides sensitive content
     * (audit A52; the words are dev.nodeterm.protocol.model.InboxNotificationText's).
     */
    var notificationDetails: Boolean
        get() = prefs.getBoolean("notifyDetails", false)
        set(value) {
            prefs.edit().putBoolean("notifyDetails", value).apply()
        }

    var fontSize: Int
        get() = prefs.getInt("fontSize", 13)
        set(value) {
            prefs.edit().putInt("fontSize", value.coerceIn(8, 24)).apply()
        }

    /**
     * Inbox events this phone has announced, read or had on screen (phone-local, like iOS), trimmed
     * by age and locked across each update — see [SeenLog] (audit A48). The pre-A48 build kept a bare
     * id set under `seenEvents`; [SeenLog] migrates it on first use and the same edit removes it.
     */
    private val seenLog = SeenLog(object : SeenLog.Storage {
        override fun read(): String? = prefs.getString(SEEN_LOG_KEY, null)
        override fun readLegacy(): Set<String>? = prefs.getStringSet(LEGACY_SEEN_KEY, null)
        override fun write(encoded: String) {
            // apply() publishes to the in-memory map before it returns; SeenLog holds the lock.
            prefs.edit().putString(SEEN_LOG_KEY, encoded).remove(LEGACY_SEEN_KEY).apply()
        }
    })

    /** The phone has seen [events]: the user read them here. */
    fun markSeen(events: Collection<InboxEvent>) = seenLog.markSeen(events)

    /**
     * The events of a fresh listing to notify about now, recorded as announced in the same locked
     * step; what [onScreen] shows is recorded as seen instead (audit A73) — see [SeenLog.claimLive].
     */
    fun claimLive(events: List<InboxEvent>, onScreen: OnScreen, notify: Boolean): List<InboxEvent> =
        seenLog.claimLive(events, onScreen, notify)

    private companion object {
        const val SEEN_LOG_KEY = "seenEvents.v2"
        const val LEGACY_SEEN_KEY = "seenEvents"
    }
}
