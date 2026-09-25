package dev.nodeterm.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.data.RoutePreference
import dev.nodeterm.android.notify.InboxNotifier
import dev.nodeterm.protocol.crypto.B64
import java.security.MessageDigest

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(nav: Navigator) {
    val context = LocalContext.current
    val graph = NodetermApp.graph(context)
    val hosts by graph.hosts.hosts.collectAsState()
    var name by remember { mutableStateOf(graph.hosts.deviceName) }
    var apiBase by remember { mutableStateOf(graph.hosts.apiBase) }
    var notify by remember { mutableStateOf(graph.hosts.notificationsEnabled) }
    var routes by remember { mutableStateOf(hosts.associate { it.id to graph.hosts.route(it.id) }) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = {
                        graph.hosts.deviceName = name
                        if (apiBase.startsWith("https://")) graph.hosts.apiBase = apiBase
                        nav.pop()
                    }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                }
            )
        }
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text("This phone", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(60) },
                label = { Text("Name shown on your computer") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Notifications")
                    Text(
                        "Checked about every 15 minutes in the background, and live while a computer is open.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Switch(checked = notify, onCheckedChange = {
                    notify = it
                    graph.hosts.notificationsEnabled = it
                    InboxNotifier.schedule(context, it)
                })
            }

            if (hosts.isNotEmpty()) {
                HorizontalDivider()
                Text("How to reach each computer", style = MaterialTheme.typography.titleMedium)
                hosts.forEach { host ->
                    Text(host.name, style = MaterialTheme.typography.labelLarge)
                    listOf(
                        RoutePreference.AUTO to "Automatic (network first, then relay)",
                        RoutePreference.SSH_ONLY to "Only on my network (SSH)",
                        RoutePreference.RELAY_ONLY to "Only through the relay"
                    ).forEach { (route, label) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = routes[host.id] == route, onClick = {
                                graph.hosts.setRoute(host.id, route)
                                graph.connections.session(host.id).disconnect()
                                routes = routes + (host.id to route)
                            })
                            Text(label)
                        }
                    }
                }
            }

            HorizontalDivider()
            Text("Identity", style = MaterialTheme.typography.titleMedium)
            Text(
                "SSH key: SHA256:" + B64.encode(MessageDigest.getInstance("SHA-256").digest(graph.sshIdentity.publicKeyBlob)).trimEnd('='),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall
            )
            Text(
                "Relay key: " + graph.boxKeys.publicKeyB64.take(16) + "…",
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall
            )
            Text(
                "Both keys were made on this phone and never leave it. Your computer keeps only their public halves.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            HorizontalDivider()
            Text("Advanced", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = apiBase,
                onValueChange = { apiBase = it.trim() },
                label = { Text("Relay API (https)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            TextButton(onClick = { apiBase = dev.nodeterm.protocol.relay.RelayApi.DEFAULT_API_BASE }) { Text("Reset to default") }

            HorizontalDivider()
            Text("About", style = MaterialTheme.typography.titleMedium)
            Text(
                "nodeterm for Android · open source components: xterm.js (MIT), ZXing (Apache-2.0), sshj (Apache-2.0), " +
                    "BouncyCastle (MIT), EdDSA-Java (CC0), OkHttp (Apache-2.0), kotlinx (Apache-2.0), AndroidX (Apache-2.0).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
