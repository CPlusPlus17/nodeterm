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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
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

class Navigator(initial: Route) {
    val stack = mutableStateListOf(initial)
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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takePairLink(intent)
    }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* the Settings switch reflects it */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val graph = NodetermApp.graph(this)
        if (Build.VERSION.SDK_INT >= 33 && graph.hosts.notificationsEnabled &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        val openHost = intent?.getStringExtra(EXTRA_HOST_ID)
        takePairLink(intent)
        setContent {
            NodetermTheme {
                val nav = remember {
                    Navigator(Route.Hosts).also { n ->
                        if (openHost != null && graph.hosts.get(openHost) != null) n.push(Route.Host(openHost, tab = 2))
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
        is Route.Host -> HostScreen(nav, r.hostId, r.tab)
        is Route.Terminal -> TerminalScreen(nav, r.hostId, r.nodeId, r.title)
    }
}
