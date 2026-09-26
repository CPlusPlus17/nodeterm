package dev.nodeterm.android

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import androidx.core.content.ContextCompat
import dev.nodeterm.android.ui.HostScreen
import dev.nodeterm.android.ui.HostsScreen
import dev.nodeterm.android.ui.NodetermTheme
import dev.nodeterm.android.ui.PairScreen
import dev.nodeterm.android.ui.SettingsScreen
import dev.nodeterm.android.ui.TerminalScreen

/** The screens. A plain back stack: five destinations, one deep link (the pairing URL). */
sealed interface Route {
    data object Hosts : Route
    data class PairHost(val code: String? = null) : Route
    data object Settings : Route
    data class Host(val hostId: String, val tab: Int = 0) : Route
    data class Terminal(val hostId: String, val nodeId: String, val title: String) : Route
}

class Navigator(initial: List<Route>) {
    constructor(initial: Route) : this(listOf(initial))

    val stack = mutableStateListOf<Route>().apply { addAll(initial.ifEmpty { listOf(Route.Hosts) }) }
    val current: Route get() = stack.last()

    fun push(route: Route) {
        stack.add(route)
    }

    fun pop(): Boolean {
        if (stack.size <= 1) return false
        stack.removeAt(stack.lastIndex)
        return true
    }

    fun replaceAll(route: Route) {
        stack.clear()
        stack.add(route)
    }

    companion object {
        /**
         * Saves the back stack across activity recreation (a density, font-scale or locale change,
         * or process death) — it used to reset to the computers list (audit A22). Each route is a
         * JSON array of strings; an entry that no longer decodes is dropped, never guessed.
         */
        val Saver: Saver<Navigator, String> = Saver(
            save = { nav -> JsonArray(nav.stack.map { encode(it) }).toString() },
            restore = { raw ->
                val routes = runCatching { (Json.parseToJsonElement(raw) as JsonArray).mapNotNull { decode(it) } }.getOrNull()
                Navigator(routes ?: listOf(Route.Hosts))
            }
        )

        private fun encode(r: Route): JsonArray = JsonArray(
            when (r) {
                Route.Hosts -> listOf("hosts")
                is Route.PairHost -> listOfNotNull("pair", r.code)
                Route.Settings -> listOf("settings")
                is Route.Host -> listOf("host", r.hostId, r.tab.toString())
                is Route.Terminal -> listOf("terminal", r.hostId, r.nodeId, r.title)
            }.map { JsonPrimitive(it) }
        )

        private fun decode(e: JsonElement): Route? {
            val parts = (e as? JsonArray)?.map { (it as? JsonPrimitive)?.content ?: return null } ?: return null
            return when (parts.firstOrNull()) {
                "hosts" -> Route.Hosts
                // A pairing code is single-use: coming back to it would only fail. Drop it.
                "pair" -> null
                "settings" -> Route.Settings
                "host" -> parts.getOrNull(1)?.let { Route.Host(it, parts.getOrNull(2)?.toIntOrNull() ?: 0) }
                "terminal" -> if (parts.size == 4) Route.Terminal(parts[1], parts[2], parts[3]) else null
                else -> null
            }
        }
    }
}

class MainActivity : ComponentActivity() {
    /** A `nodeterm://pair?code=` link that arrived (at launch or while running) and awaits the UI. */
    private var incomingPairCode by mutableStateOf<String?>(null)

    private fun takePairLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (intent.action == Intent.ACTION_VIEW && data.scheme == "nodeterm" && data.host == "pair") {
            incomingPairCode = data.toString()
        }
    }

    /** A notification tap naming a computer (at launch or while running) that awaits the UI. */
    private var incomingHost by mutableStateOf<String?>(null)

    /**
     * A live activity gets later intents HERE, not in onCreate (it is `singleTask`): a notification
     * tapped while the app sat in the background used to open whatever screen was last showing
     * instead of that computer's Inbox (audit A11/A19).
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takePairLink(intent)
        intent.getStringExtra(EXTRA_HOST_ID)?.let { incomingHost = it }
    }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* the Settings switch reflects it */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val graph = NodetermApp.graph(this)
        // Asked on a fresh start only — not on every rotation or recreation (audit A21). Later asks
        // come from the Settings switch, which also offers the system settings once Android stops
        // showing the dialog.
        if (savedInstanceState == null && Build.VERSION.SDK_INT >= 33 && graph.hosts.notificationsEnabled &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        // The launch intent (a notification tap, a pairing link) is applied on a FRESH start only: on a
        // recreation the saved back stack already reflects it, and re-applying it would push the
        // same screen again (audit A22).
        val fresh = savedInstanceState == null
        val openHost = if (fresh) intent?.getStringExtra(EXTRA_HOST_ID) else null
        if (fresh) takePairLink(intent)
        setContent {
            NodetermTheme {
                val nav = rememberSaveable(saver = Navigator.Saver) {
                    Navigator(Route.Hosts).also { n ->
                        if (openHost != null && graph.hosts.get(openHost) != null) n.push(Route.Host(openHost, tab = 2))
                    }
                }
                // A restored stack may name a computer that was forgotten meanwhile.
                LaunchedEffect(Unit) {
                    val known = nav.stack.filter { r ->
                        when (r) {
                            is Route.Host -> graph.hosts.get(r.hostId) != null
                            is Route.Terminal -> graph.hosts.get(r.hostId) != null
                            else -> true
                        }
                    }
                    if (known.size != nav.stack.size) {
                        nav.stack.clear()
                        nav.stack.addAll(known.ifEmpty { listOf(Route.Hosts) })
                    }
                }
                val hostTap = incomingHost
                LaunchedEffect(hostTap) {
                    if (hostTap != null) {
                        incomingHost = null
                        if (graph.hosts.get(hostTap) != null) {
                            nav.replaceAll(Route.Hosts)
                            nav.push(Route.Host(hostTap, tab = 2))
                        }
                    }
                }
                val code = incomingPairCode
                LaunchedEffect(code) {
                    if (code != null) {
                        incomingPairCode = null
                        nav.push(Route.PairHost(code))
                    }
                }
                AppContent(nav)
            }
        }
    }

    companion object {
        const val EXTRA_HOST_ID = "hostId"
    }
}

@Composable
private fun AppContent(nav: Navigator) {
    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
    when (val r = nav.current) {
        Route.Hosts -> HostsScreen(nav)
        is Route.PairHost -> PairScreen(nav, r.code)
        Route.Settings -> SettingsScreen(nav)
        // Keyed on the route: a Host screen for another computer, or for the same one opened on a
        // different tab (a notification → Inbox), must not inherit the showing screen's saved state.
        is Route.Host -> key(r) { HostScreen(nav, r.hostId, r.tab) }
        is Route.Terminal -> TerminalScreen(nav, r.hostId, r.nodeId, r.title)
    }
}
