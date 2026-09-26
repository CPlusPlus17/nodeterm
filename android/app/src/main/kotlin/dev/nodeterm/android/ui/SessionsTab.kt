package dev.nodeterm.android.ui

import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.Route
import dev.nodeterm.android.conn.HostSession
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.Launch
import dev.nodeterm.protocol.model.NodeInfo
import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.SessionBucket
import dev.nodeterm.protocol.ssh.SshHostConnection
import kotlinx.coroutines.launch

/** A phone-started session waiting for its terminal screen to type the launch line and register it. */
data class LaunchRequest(
    val nodeId: String,
    val projectId: String,
    val title: String,
    val agentId: String?,
    val accountId: String?,
    val command: String?
)

/** Hand-off from the New-session dialog to the terminal screen that performs the launch. */
object PendingLaunches {
    private val byNode = HashMap<String, LaunchRequest>()

    @Synchronized
    fun put(r: LaunchRequest) {
        byNode[r.nodeId] = r
    }

    @Synchronized
    fun take(nodeId: String): LaunchRequest? = byNode.remove(nodeId)
}

private val BUCKET_ORDER = listOf(SessionBucket.NEEDS_YOU, SessionBucket.RUNNING, SessionBucket.SLEEPING, SessionBucket.UNKNOWN)

private fun bucketTitle(b: SessionBucket) = when (b) {
    SessionBucket.NEEDS_YOU -> "Waiting for your response"
    SessionBucket.RUNNING -> "Running"
    SessionBucket.SLEEPING -> "Sleeping"
    SessionBucket.UNKNOWN -> "Other sessions"
}

/** What a session row is called: the agent's own session name, else the node title, else the agent. */
fun displayTitle(node: NodeInfo, snapshot: ProjectsSnapshot): String =
    snapshot.statusOf(node.id)?.name?.takeIf { it.isNotBlank() }
        ?: node.title.takeIf { it.isNotBlank() }
        ?: Agent.of(node.agentId)?.label
        ?: "Terminal"

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionsTab(nav: Navigator, hostId: String, session: HostSession, snapshot: ProjectsSnapshot) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var menuFor by remember { mutableStateOf<NodeInfo?>(null) }
    var renaming by remember { mutableStateOf<NodeInfo?>(null) }
    var ending by remember { mutableStateOf<NodeInfo?>(null) }

    fun act(label: String, block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
                session.refreshNow()
            } catch (e: Exception) {
                Toast.makeText(context, "$label: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    val projects = snapshot.openProjects().filter { it.sessions.isNotEmpty() }
    if (projects.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text(
                if (snapshot.fetchedAt == 0L) "Loading sessions…" else "No sessions on this computer yet.",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        return
    }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
        for (project in projects) {
            item(key = "p-${project.id}") { ProjectHeader(project) }
            val grouped = project.sessions.groupBy { snapshot.statusOf(it.id)?.bucket ?: SessionBucket.UNKNOWN }
            for (bucket in BUCKET_ORDER) {
                val rows = grouped[bucket].orEmpty().sortedByDescending { snapshot.statusOf(it.id)?.updatedAt ?: 0 }
                if (rows.isEmpty()) continue
                item(key = "b-${project.id}-$bucket") {
                    Text(
                        bucketTitle(bucket).uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 16.dp, top = 10.dp, bottom = 4.dp)
                    )
                }
                items(rows, key = { "n-${project.id}-${it.id}" }) { node ->
                    Box {
                        SessionRow(
                            node, snapshot,
                            onClick = { nav.push(Route.Terminal(hostId, node.id, displayTitle(node, snapshot))) },
                            onLongClick = { menuFor = node }
                        )
                        DropdownMenu(expanded = menuFor?.id == node.id, onDismissRequest = { menuFor = null }) {
                            val conn = session.connection
                            DropdownMenuItem(text = { Text("Open") }, onClick = {
                                menuFor = null
                                nav.push(Route.Terminal(hostId, node.id, displayTitle(node, snapshot)))
                            })
                            if (conn?.capabilities?.nodeActions == true) {
                                if (snapshot.statusOf(node.id)?.hibernated == true) {
                                    DropdownMenuItem(text = { Text("Wake") }, onClick = {
                                        menuFor = null
                                        act("Wake") { conn.wake(node.id) }
                                    })
                                }
                                DropdownMenuItem(text = { Text("Refresh view on computer") }, onClick = {
                                    menuFor = null
                                    act("Refresh") { conn.refresh(node.id) }
                                })
                                DropdownMenuItem(text = { Text("Rename…") }, onClick = {
                                    menuFor = null
                                    renaming = node
                                })
                            }
                            DropdownMenuItem(text = { Text("End session…", color = NtColors.attention) }, onClick = {
                                menuFor = null
                                ending = node
                            })
                        }
                    }
                }
            }
        }
    }

    renaming?.let { node ->
        var title by remember(node.id) { mutableStateOf(displayTitle(node, snapshot)) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Rename session") },
            text = { OutlinedTextField(value = title, onValueChange = { title = it }, singleLine = true) },
            confirmButton = {
                TextButton(enabled = title.isNotBlank(), onClick = {
                    renaming = null
                    val conn = session.connection ?: return@TextButton
                    act("Rename") { conn.rename(node.id, title.trim()) }
                }) { Text("Rename") }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } }
        )
    }

    ending?.let { node ->
        val conn = session.connection
        val viaSsh = conn?.kind == TransportKind.SSH
        AlertDialog(
            onDismissRequest = { ending = null },
            title = { Text("End ${displayTitle(node, snapshot)}?") },
            text = {
                Text(
                    if (viaSsh) "This stops the session's tmux session on the computer, and everything running in it. " +
                        "The node stays on the canvas until you remove it there."
                    else "This permanently ends the session and removes the node from the canvas — like its × on the computer."
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    ending = null
                    val c = conn ?: return@TextButton
                    act("End session") {
                        val quiet = object : TerminalSink {
                            override fun onPaint(text: String) {}
                            override fun onOutput(bytes: ByteArray) {}
                            override fun onExit(code: Int?) {}
                        }
                        if (c is SshHostConnection) {
                            try {
                                c.killSession(node.id)
                            } catch (e: NeedsRelayException) {
                                // A node of an SSH project lives on its host: end it through the
                                // relay, where the desktop reaches that host (audit A09).
                                if (!session.hasRelay) throw e
                                session.viaRelay().attach(node.id, 80, 24, quiet).endSession()
                            }
                        } else {
                            c.attach(node.id, 80, 24, quiet).endSession()
                        }
                    }
                }) { Text("End session", color = NtColors.attention) }
            },
            dismissButton = { TextButton(onClick = { ending = null }) { Text("Cancel") } }
        )
    }
}

@Composable
private fun ProjectHeader(project: ProjectInfo) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 18.dp), verticalAlignment = Alignment.CenterVertically) {
        ColorDot(parseHex(project.color, NtColors.accent), 12)
        Spacer(Modifier.width(10.dp))
        Text(project.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        project.sshTarget?.let {
            Spacer(Modifier.width(8.dp))
            Text("on $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(node: NodeInfo, snapshot: ProjectsSnapshot, onClick: () -> Unit, onLongClick: () -> Unit) {
    val status = snapshot.statusOf(node.id)
    val now = snapshot.status?.inbox?.nodes?.get(node.id)
    val agent = Agent.of(node.agentId ?: status?.agentId)
    val live = snapshot.isLive(node.id)
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (node.iconEmoji != null) Text(node.iconEmoji!!) else ColorDot(parseHex(node.color ?: agent?.color, NtColors.muted), 12)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(displayTitle(node, snapshot), maxLines = 1, overflow = TextOverflow.Ellipsis)
            val detail = buildList {
                add(agent?.label ?: "Terminal")
                now?.activity?.let { add(it) }
                now?.contextPercent?.let { add("${it.toInt()}% context") }
                status?.accountLabel?.let { add(it) }
                if (!live) add("not running")
            }.joinToString(" · ")
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Spacer(Modifier.width(8.dp))
        Column(horizontalAlignment = Alignment.End) {
            StatusBadge(status?.bucket)
            status?.updatedAt?.let {
                Text(relativeAge(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** New session: a project on THIS computer, an agent (or a plain shell), and for Claude an account. */
@Composable
fun NewSessionDialog(snapshot: ProjectsSnapshot, onDismiss: () -> Unit, onCreate: (LaunchRequest) -> Unit) {
    val projects = snapshot.openProjects().filter { it.sshTarget == null }
    var projectId by remember { mutableStateOf(projects.firstOrNull()?.id) }
    var agent by remember { mutableStateOf<Agent?>(Agent.CLAUDE) }
    val accounts = snapshot.status?.settings?.claudeAccounts.orEmpty()
    var accountId by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New session") },
        text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                item { Text("Project", style = MaterialTheme.typography.labelLarge) }
                items(projects, key = { "proj-${it.id}" }) { p ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = projectId == p.id, onClick = { projectId = p.id })
                        Text(p.name)
                    }
                }
                item { Text("Run", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 8.dp)) }
                items(listOf<Agent?>(null) + Agent.entries, key = { "agent-${it?.id ?: "shell"}" }) { a ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = agent == a, onClick = { agent = a })
                        Text(a?.label ?: "Terminal (shell)")
                    }
                }
                if (agent == Agent.CLAUDE && accounts.isNotEmpty()) {
                    item { Text("Claude account", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 8.dp)) }
                    items(listOf<String?>(null) + accounts.map { it.id }, key = { "acct-${it ?: "system"}" }) { id ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = accountId == id, onClick = { accountId = id })
                            Text(id ?: "System account")
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = projectId != null, onClick = {
                val p = projects.first { it.id == projectId }
                val a = agent
                val acct = if (a == Agent.CLAUDE) accountId else null
                val cmd = if (a != null) Launch.launchCommand(a, snapshot.status?.settings, acct, p.cwd)
                else p.cwd?.let { if (Regex("^/[^'\\u0000-\\u001f]*$").matches(it)) "cd '$it'" else null }
                onCreate(
                    LaunchRequest(
                        nodeId = Launch.newNodeId(),
                        projectId = p.id,
                        title = a?.label ?: "Terminal",
                        agentId = a?.id,
                        accountId = acct,
                        command = cmd
                    )
                )
            }) { Text("Start") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}
