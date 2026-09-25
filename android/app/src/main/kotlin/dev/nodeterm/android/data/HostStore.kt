package dev.nodeterm.android.data

import android.content.Context
import dev.nodeterm.protocol.model.PairedHost
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import java.util.UUID

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
        prefs.edit().remove("route.$id").apply()
    }

    fun route(id: String): RoutePreference =
        runCatching { RoutePreference.valueOf(prefs.getString("route.$id", null) ?: "AUTO") }.getOrDefault(RoutePreference.AUTO)

    fun setRoute(id: String, route: RoutePreference) {
        prefs.edit().putString("route.$id", route.name).apply()
    }

    /** The phone's own stable id — the key the relay backend stores its device row under. */
    val deviceId: String
        get() = prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("deviceId", it).apply()
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

    var notificationsEnabled: Boolean
        get() = prefs.getBoolean("notify", true)
        set(value) {
            prefs.edit().putBoolean("notify", value).apply()
        }

    var fontSize: Int
        get() = prefs.getInt("fontSize", 13)
        set(value) {
            prefs.edit().putInt("fontSize", value.coerceIn(8, 24)).apply()
        }

    /** Inbox events this phone has seen/read (phone-local, like iOS). Bounded. */
    fun seenEvents(): Set<String> = prefs.getStringSet("seenEvents", emptySet()) ?: emptySet()

    fun markSeen(ids: Collection<String>) {
        if (ids.isEmpty()) return
        val next = (seenEvents() + ids).toList().takeLast(500).toSet()
        prefs.edit().putStringSet("seenEvents", next).apply()
    }
}
