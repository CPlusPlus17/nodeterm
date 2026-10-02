package dev.nodeterm.android.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.conn.ConnState
import dev.nodeterm.android.conn.HostSession
import dev.nodeterm.protocol.host.Capability
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.AllComputers
import dev.nodeterm.protocol.model.NewSessionChoice

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostScreen(nav: Navigator, hostId: String, initialTab: Int) {
    val context = LocalContext.current
    val graph = NodetermApp.graph(context)
    val host = graph.hosts.get(hostId)
    if (host == null) {
        LaunchedEffect(hostId) { nav.pop() }
        return
    }
    val session = remember(hostId) { graph.connections.session(hostId) }
    val state by session.state.collectAsState()
    val snapshot by session.snapshot.collectAsState()
    // Saved under this back-stack entry's key (AppContent), so it survives a terminal pushed on top
    // and a recreation (audit A43); [initialTab] only picks the tab a NEW entry opens on.
    var tab by rememberSaveable { mutableIntStateOf(initialTab) }
    // Each tab's own saved state (scroll position, the Board's project, the Inbox's archive toggle),
    // kept while another tab shows. The holder itself lives in this entry's saved state.
    val tabStates = rememberSaveableStateHolder()
    var newSession by remember { mutableStateOf(false) }

    // Watch (the 8 s poll) only while the screen is STARTED: a backgrounded app used to keep
    // polling, and keep its relay stream open, for as long as the process ran (audit A18).
    LifecycleStartEffect(hostId) {
        session.startWatching()
        onStopOrDispose { session.stopWatching() }
    }

    // One count for this tab, the computer's row in the list and the All computers screen (A55).
    val needsYou = AllComputers.needsYou(snapshot)
    // New session goes through nodeterm the app (the relay's `projects.registerNode`): on the LAN
    // (direct SSH) that is the relay leg opened next to it, and where this phone has none the button
    // stays, disabled, with the reason (audit A26) — it used to vanish without a word.
    val offersNew = state is ConnState.Connected && NewSessionChoice.offeredProjects(snapshot).isNotEmpty()
    // Re-asked when what the routing reads changes: the connection, each listing (it says whether the
    // computer advertises its relay right now), and the stored relay leg — a late adoption stores a
    // token in the background, which moves the secrets' revision and the host record, not the listing.
    val secretsRevision by graph.secure.revision.collectAsState()
    val hostRecords by graph.hosts.hosts.collectAsState()
    val newRoute = remember(state, snapshot, secretsRevision, hostRecords) { session.route(Capability.REGISTER_NODE) }
    val newBlocked = (newRoute as? LegRouting.Leg.Unavailable)?.reason
    val relayApproval by session.relayApproval.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(host.name)
                        Text(
                            when (val s = state) {
                                is ConnState.Connected -> if (s.kind == TransportKind.SSH) host.sshLegName else "Through the relay · end-to-end encrypted"
                                is ConnState.Connecting -> s.detail
                                is ConnState.AwaitingApproval -> "Waiting for approval"
                                is ConnState.Failed -> "Offline"
                                ConnState.Idle -> ""
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                },
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = { IconButton(onClick = { session.refresh() }) { Icon(Icons.Filled.Refresh, "Refresh") } }
            )
        },
        floatingActionButton = {
            if (tab == 0 && offersNew) {
                if (newBlocked == null) {
                    ExtendedFloatingActionButton(
                        onClick = { newSession = true },
                        icon = { Icon(Icons.Filled.Add, null) },
                        text = { Text("New session") }
                    )
                } else {
                    // Kept as small as the FAB it stands in for: its reason is the Sessions list's
                    // first row (a floating box of five to seven lines covered the last sessions).
                    Button(onClick = {}, enabled = false) {
                        Icon(Icons.Filled.Add, null)
                        Text("New session")
                    }
                }
            }
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            ConnectionBanner(state, session)
            // The relay leg a board edit or New session opened next to the SSH connection is waiting
            // for the computer's approval dialog (its first dial on a desktop that has not pinned us).
            relayApproval?.let { if (state !is ConnState.AwaitingApproval) ApprovalCode(it) }
            // Connected through the relay because the server at the paired address presented a
            // different SSH host key (audit A49/A74): the relay proves the computer, but the change
            // itself must stay visible.
            val sshWarning by session.sshWarning.collectAsState()
            val warn = sshWarning
            if (state is ConnState.Connected && warn != null) {
                Text(
                    warn,
                    Modifier.fillMaxWidth().background(NtColors.warning.copy(alpha = 0.12f)).padding(12.dp),
                    style = MaterialTheme.typography.bodySmall
                )
            }
            // A listing that failed on a connection that is still up (e.g. nodeterm's data not found
            // over SSH) used to be invisible: the screen just stayed empty (audit A31). Also once the
            // failure dropped the connection (Idle): one the phone cannot parse fails every poll the
            // same way, and the screen showed nothing between them (the review of A55).
            val listError by session.lastError.collectAsState()
            val err = listError
            if (state.showsListError && err != null) {
                Text(
                    err,
                    Modifier.fillMaxWidth().background(NtColors.attention.copy(alpha = 0.12f)).padding(12.dp),
                    style = MaterialTheme.typography.bodySmall
                )
            }
            // A Server Edition's install metadata (the mirror's `server` block, A27): which version
            // this computer runs, the question an installed server's updates raise.
            snapshot.status?.server?.describe()?.let {
                Text(
                    it,
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1
                )
            }
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Sessions") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Board") })
                Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text(if (needsYou > 0) "Inbox ($needsYou)" else "Inbox") })
                Tab(selected = tab == 3, onClick = { tab = 3 }, text = { Text("Usage") })
            }
            tabStates.SaveableStateProvider(tab) {
                when (tab) {
                    0 -> SessionsTab(nav, hostId, session, snapshot, newSessionNote = newBlocked?.takeIf { offersNew })
                    1 -> BoardTab(nav, hostId, session, snapshot)
                    2 -> InboxTab(nav, hostId, session, snapshot)
                    else -> UsageTab(snapshot)
                }
            }
        }
    }

    if (newSession) {
        NewSessionDialog(
            snapshot = snapshot,
            onDismiss = { newSession = false },
            onCreate = { request ->
                newSession = false
                PendingLaunches.put(request)
                nav.push(dev.nodeterm.android.Route.Terminal(hostId, request.nodeId, request.title))
                Toast.makeText(context, "Starting ${request.title}…", Toast.LENGTH_SHORT).show()
            }
        )
    }
}

@Composable
private fun ConnectionBanner(state: ConnState, session: HostSession) {
    when (state) {
        is ConnState.AwaitingApproval -> ApprovalCode(state.sas)
        is ConnState.Failed -> Column(
            Modifier.fillMaxWidth().background(NtColors.attention.copy(alpha = 0.12f)).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(state.message, style = MaterialTheme.typography.bodySmall)
            Row { Button(onClick = { session.refresh() }) { Text("Try again") } }
        }
        else -> Unit
    }
}

@Composable
internal fun ApprovalCode(sas: String) {
    Column(
        Modifier.fillMaxWidth().background(NtColors.panel2).padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text("Approve this phone on your computer", fontWeight = FontWeight.SemiBold)
        Text(
            sas,
            fontSize = 34.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            color = NtColors.accent
        )
        Text(
            "nodeterm on your computer is showing a code. Approve only if it matches this one — a different code " +
                "means someone is in the middle. You only do this once per phone.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}
