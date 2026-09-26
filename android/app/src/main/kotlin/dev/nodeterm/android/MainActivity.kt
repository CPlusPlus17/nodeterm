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
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.core.content.ContextCompat
import dev.nodeterm.android.ui.HostScreen
import dev.nodeterm.android.ui.HostsScreen
import dev.nodeterm.android.ui.NodetermTheme
import dev.nodeterm.android.ui.PairScreen
import dev.nodeterm.android.ui.SettingsScreen
import dev.nodeterm.android.ui.TerminalScreen
import dev.nodeterm.protocol.model.BackStack

/** The screens. A plain back stack: five destinations, one deep link (the pairing URL). */
sealed interface Route {
    data object Hosts : Route
    data class PairHost(val code: String? = null) : Route
    data object Settings : Route
    data class Host(val hostId: String, val tab: Int = 0) : Route
    data class Terminal(val hostId: String, val nodeId: String, val title: String) : Route
}

/**
 * The back stack. Each entry has its own key (audit A43): AppContent files the entry's saved UI state
 * (the Host screen's tab, scroll positions, the Board's project, the Inbox's archive toggle) under it,
 * so the screen below a terminal comes back as it was left. The rules live in [BackStack] (protocol,
 * tested); this is its observable holder. Used from the main thread only.
 */
class Navigator(initial: BackStack<Route>) {
    constructor(initial: Route) : this(BackStack.of(listOf(initial), Route.Hosts))

    private var backStack by mutableStateOf(initial)

    val size: Int get() = backStack.size

    /** The showing entry: its route, and the key its saved UI state is filed under. */
    val top: BackStack.Entry<Route> get() = backStack.entries.last()

    fun push(route: Route) {
        backStack = backStack.push(route)
    }

    fun pop(): Boolean {
        backStack = backStack.pop() ?: return false
        return true
    }

    fun replaceAll(route: Route) {
        backStack = backStack.replaceAll(route)
    }

    /** Keeps the entries [keep] accepts, each with its saved state; the computers list when none is left. */
    fun retain(keep: (Route) -> Boolean) {
        backStack = backStack.retain(Route.Hosts, keep = keep)
    }

    /** The keys of the entries that left the stack since the last call. Their saved state is to be dropped. */
    fun takeRetired(): List<String> {
        val keys = backStack.retired
        if (keys.isNotEmpty()) backStack = backStack.withoutRetired()
        return keys
    }

    companion object {
        /**
         * Saves the back stack across activity recreation (a density, font-scale or locale change,
         * or process death) — it used to reset to the computers list (audit A22). Each route is a
         * list of strings, saved with its entry's key (audit A43); an entry that no longer decodes is
         * dropped, never guessed.
         */
        val Saver: Saver<Navigator, String> = Saver(
            save = { nav -> nav.backStack.encode(::encode) },
            restore = { raw -> Navigator(BackStack.decode(raw, Route.Hosts, route = ::decode)) }
        )

        private fun encode(r: Route): List<String> = when (r) {
            Route.Hosts -> listOf("hosts")
            is Route.PairHost -> listOfNotNull("pair", r.code)
            Route.Settings -> listOf("settings")
            is Route.Host -> listOf("host", r.hostId, r.tab.toString())
            is Route.Terminal -> listOf("terminal", r.hostId, r.nodeId, r.title)
        }

        private fun decode(parts: List<String>): Route? = when (parts.firstOrNull()) {
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
                    nav.retain { r ->
                        when (r) {
                            is Route.Host -> graph.hosts.get(r.hostId) != null
                            is Route.Terminal -> graph.hosts.get(r.hostId) != null
                            else -> true
                        }
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
    // Only the top entry is composed, so without a holder a screen's saved state died the moment
    // another was pushed on it: back from a terminal, the Host screen was on its first tab, scrolled
    // to the top, on the Board's first project (audit A43). Each entry's state is filed under its own
    // key, which the saved back stack keeps across recreation, like the holder keeps the state.
    val saved = rememberSaveableStateHolder()
    // An entry that left the stack never comes back (a new push gets a new key): drop its state.
    SideEffect { nav.takeRetired().forEach { saved.removeState(it) } }
    BackHandler(enabled = nav.size > 1) { nav.pop() }
    val top = nav.top
    // Keyed per ENTRY, not per route: a Host screen for another computer, or for the same one opened
    // again (a notification → Inbox), starts from its own route, never from the showing screen's state.
    saved.SaveableStateProvider(top.key) {
        when (val r = top.value) {
            Route.Hosts -> HostsScreen(nav)
            is Route.PairHost -> PairScreen(nav, r.code)
            Route.Settings -> SettingsScreen(nav)
            is Route.Host -> HostScreen(nav, r.hostId, r.tab)
            is Route.Terminal -> TerminalScreen(nav, r.hostId, r.nodeId, r.title)
        }
    }
}
