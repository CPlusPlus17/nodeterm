package dev.nodeterm.android.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.Route
import dev.nodeterm.android.conn.HostSession
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.QuickActions
import dev.nodeterm.protocol.model.AccountNames
import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.AgentStatusFile
import dev.nodeterm.protocol.model.ContextFill
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.QuestionChoices
import dev.nodeterm.protocol.model.UsageAccount
import dev.nodeterm.protocol.model.UsageLimit
import dev.nodeterm.protocol.model.UsagePace
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The Agents feed (docs/mobile-usage-inbox.md): unresolved approvals and questions on top — with
 * deterministic Approve/Deny for a held hook-reply approval — then live activity, then the archive.
 * Read/unread is phone-local, like iOS; `resolved` from the computer only moves cards out of the
 * actionable list.
 */
@Composable
fun InboxTab(nav: Navigator, hostId: String, session: HostSession, snapshot: ProjectsSnapshot) {
    val context = LocalContext.current
    val graph = NodetermApp.graph(context)
    val scope = rememberCoroutineScope()
    // Saveable, so an open archive stays open after a terminal opened from it (audit A43).
    var showArchive by rememberSaveable { mutableStateOf(false) }
    val inbox = snapshot.status?.inbox
    val events = inbox?.events.orEmpty().sortedByDescending { it.ts }
    val actionable = events.filter { it.actionable }
    val archived = events.filterNot { it.actionable }
    val working = snapshot.status?.nodes.orEmpty()
        .filter { (id, st) -> st.state == AgentState.WORKING && inbox?.nodes?.get(id)?.activity != null }

    LaunchedEffect(actionable.map { it.id }) { graph.hosts.markSeen(actionable) }

    fun titleOf(nodeId: String): String =
        snapshot.findNode(nodeId)?.second?.let { displayTitle(it, snapshot) } ?: snapshot.statusOf(nodeId)?.name ?: "Session"

    fun open(nodeId: String) = nav.push(Route.Terminal(hostId, nodeId, titleOf(nodeId)))

    fun run(label: String, block: suspend (HostConnection) -> QuickActions.Result, nodeId: String) {
        scope.launch {
            try {
                val result = try {
                    block(session.ensureConnected())
                } catch (e: NeedsRelayException) {
                    // Direct SSH reaches only this computer; a node of one of its SSH projects is
                    // answered where it lives, through the relay (audit A09).
                    if (!session.hasRelay) throw e
                    block(session.viaRelay())
                }
                when (result) {
                    QuickActions.Result.SENT -> Toast.makeText(context, label, Toast.LENGTH_SHORT).show()
                    QuickActions.Result.ALREADY_HANDLED -> Toast.makeText(context, "Already handled.", Toast.LENGTH_SHORT).show()
                    QuickActions.Result.OPEN_SESSION -> open(nodeId)
                    QuickActions.Result.EXPIRED -> {
                        Toast.makeText(context, "The request timed out on the computer. Answer it in the session.", Toast.LENGTH_LONG).show()
                        open(nodeId)
                    }
                }
                session.refreshNow()
            } catch (e: Exception) {
                Toast.makeText(context, e.message ?: "Couldn't reach the computer.", Toast.LENGTH_LONG).show()
            }
        }
    }

    if (events.isEmpty() && working.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text("Nothing needs you right now.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(actionable, key = { "a-${it.id}" }) { ev ->
            EventCard(ev, titleOf(ev.nodeId), snapshot, inbox?.nodes?.get(ev.nodeId)?.contextPercent, highlight = true, onOpen = { open(ev.nodeId) }) {
                if (ev.kind == InboxKind.APPROVAL) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = {
                            run("Approved.", { c -> QuickActions.answerApproval(c, ev, allow = true) }, ev.nodeId)
                        }) { Text("Approve") }
                        OutlinedButton(onClick = {
                            run("Denied.", { c -> QuickActions.answerApproval(c, ev, allow = false) }, ev.nodeId)
                        }) { Text("Deny") }
                        TextButton(onClick = { open(ev.nodeId) }) { Text("Open") }
                    }
                } else {
                    // One rule for what the card offers and what the answer path accepts (audit A57).
                    when (val choices = QuestionChoices.of(ev)) {
                        is QuestionChoices.Answer -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            choices.rows.forEachIndexed { i, row ->
                                OutlinedButton(onClick = {
                                    run("Answered.", { c -> QuickActions.answerQuestion(c, ev, i) }, ev.nodeId)
                                }, modifier = Modifier.fillMaxWidth()) { Text(row, maxLines = 2) }
                            }
                        }
                        // Multi-select: shown so the card says what is asked, but plain text, not
                        // buttons. The picker's toggle/submit keys are unmeasured, so it is answered
                        // in the session (QuestionChoices says why).
                        is QuestionChoices.ReadOnly -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                QuestionChoices.SEVERAL_NOTE,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            choices.rows.forEach { row ->
                                Text(
                                    row,
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(start = 8.dp)
                                )
                            }
                            TextButton(onClick = { open(ev.nodeId) }) { Text("Open session") }
                        }
                        QuestionChoices.None -> TextButton(onClick = { open(ev.nodeId) }) { Text("Open session") }
                    }
                }
            }
        }
        items(working.keys.toList(), key = { "w-$it" }) { nodeId ->
            val now = inbox?.nodes?.get(nodeId)
            Column(
                Modifier.fillMaxWidth().background(NtColors.panel, RoundedCornerShape(10.dp)).clickable { open(nodeId) }.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusBadge(dev.nodeterm.protocol.model.SessionBucket.RUNNING)
                    Spacer(Modifier.width(8.dp))
                    Text(titleOf(nodeId), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                now?.prompt?.let { Text("You: $it", style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                now?.activity?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                ContextIndicator(now?.contextPercent)
            }
        }
        if (archived.isNotEmpty()) {
            item(key = "archive-toggle") {
                TextButton(onClick = { showArchive = !showArchive }) {
                    Text(if (showArchive) "Hide archive" else "Archive (${archived.size})")
                }
            }
            if (showArchive) {
                items(archived, key = { "r-${it.id}" }) { ev ->
                    EventCard(ev, titleOf(ev.nodeId), snapshot, inbox?.nodes?.get(ev.nodeId)?.contextPercent, highlight = false, onOpen = { open(ev.nodeId) }) {}
                }
            }
        }
    }
}

@Composable
private fun EventCard(
    ev: InboxEvent,
    title: String,
    snapshot: ProjectsSnapshot,
    /** The node's context-window fill (`inbox.nodes[nodeId].contextPercent`), when known. */
    contextPercent: Double?,
    highlight: Boolean,
    onOpen: () -> Unit,
    actions: @Composable () -> Unit
) {
    val accent = when (ev.kind) {
        InboxKind.APPROVAL -> NtColors.attention
        InboxKind.QUESTION -> NtColors.warning
        InboxKind.DONE -> NtColors.success
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(if (highlight) accent.copy(alpha = 0.10f) else NtColors.panel, RoundedCornerShape(10.dp))
            .clickable(onClick = onOpen)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                when (ev.kind) {
                    InboxKind.APPROVAL -> "NEEDS APPROVAL"
                    InboxKind.QUESTION -> "QUESTION"
                    InboxKind.DONE -> if (ev.interrupted) "INTERRUPTED" else "FINISHED"
                },
                color = accent,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold
            )
            Spacer(Modifier.width(8.dp))
            Text(title, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(relativeAge(ev.ts), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(ev.title, fontWeight = FontWeight.SemiBold)
        ev.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 4) }
        val agent = Agent.of(ev.agentId ?: snapshot.statusOf(ev.nodeId)?.agentId)
        if (agent != null || ContextFill.percent(contextPercent) != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                agent?.let { Text(it.label, style = MaterialTheme.typography.labelSmall, color = parseHex(it.color)) }
                ContextIndicator(contextPercent)
            }
        }
        actions()
    }
}

/**
 * A node's context-window fill as a small ring and "42% context" (docs/mobile-usage-inbox.md: cards
 * show the node's `contextPercent` ring when known). Nothing at all when it is unknown. The ring's
 * colour follows the desktop context meter's bands ([ContextFill.level]).
 */
@Composable
private fun ContextIndicator(contextPercent: Double?) {
    val raw = contextPercent ?: return
    val pct = ContextFill.percent(raw) ?: return
    val label = ContextFill.label(raw) ?: return
    val color = when (ContextFill.level(raw)) {
        ContextFill.Level.CRITICAL -> NtColors.attention
        ContextFill.Level.HIGH -> NtColors.warning
        ContextFill.Level.OK -> NtColors.success
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        CircularProgressIndicator(
            progress = { pct / 100f },
            modifier = Modifier.size(12.dp),
            color = color,
            strokeWidth = 2.dp,
            trackColor = NtColors.panel2
        )
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * Usages (docs/mobile-usage-inbox.md): per account, each limit's consumption and reset. Colour is
 * the provider's severity when given, else derived (≥90 red, ≥70 amber, else green).
 */
@Composable
fun UsageTab(snapshot: ProjectsSnapshot) {
    val usage = snapshot.status?.usage
    if (usage == null || usage.accounts.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text(
                "This computer isn't reporting usage. (Usage is shared by nodeterm on the computer for its local accounts.)",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items(usage.accounts, key = { it.accountId ?: "system" }) { account -> UsageCard(account, snapshot.status) }
        item { Text("Updated ${relativeAge(usage.updatedAt)} ago", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun UsageCard(account: UsageAccount, status: AgentStatusFile?) {
    // The same resolver the sessions list uses, so a managed account is never titled by its UUID.
    val title = account.accountId?.let { AccountNames.managed(it, status) }
        ?: account.label ?: account.email ?: AccountNames.SYSTEM
    Column(
        Modifier.fillMaxWidth().background(NtColors.panel, RoundedCornerShape(10.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(title, fontWeight = FontWeight.SemiBold)
        account.email?.takeIf { it != title }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        if (account.status != "ok" && account.limits.isEmpty()) {
            Text(if (account.status == "error") "Could not read usage." else "Usage unavailable.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        account.limits.forEach { UsageBar(it, measuredAt = account.updatedAt) }
    }
}

@Composable
private fun UsageBar(limit: UsageLimit, measuredAt: Long, now: Long = System.currentTimeMillis()) {
    val pct = limit.usedPercent.coerceIn(0.0, 100.0)
    val color: Color = when (limit.severity) {
        "critical", "error", "red" -> NtColors.attention
        "warning", "amber", "yellow" -> NtColors.warning
        "ok", "normal", "green" -> NtColors.success
        else -> if (pct >= 90) NtColors.attention else if (pct >= 70) NtColors.warning else NtColors.success
    }
    val name = when (limit.kind) {
        "session" -> "Session window"
        "weekly_all" -> "Weekly (all models)"
        "weekly_scoped" -> "Weekly · ${limit.scopeLabel ?: "model"}"
        else -> limit.scopeLabel ?: limit.kind
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row {
            Text(name, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            Text("${pct.toInt()}%" + (limit.resetsAt?.let { " · resets ${resetLabel(it, now)}" } ?: ""), style = MaterialTheme.typography.bodySmall)
        }
        LinearProgressIndicator(
            progress = { (pct / 100.0).toFloat() },
            color = color,
            trackColor = NtColors.panel2,
            modifier = Modifier.fillMaxWidth().height(6.dp)
        )
        // Only when the window's end and length are known (UsagePace says why it would refuse),
        // judged at the time the percentage was measured, not now (UsagePace says why).
        UsagePace.of(limit, measuredAt = measuredAt, now = now)?.let { reading ->
            Text(
                reading.line,
                style = MaterialTheme.typography.labelSmall,
                color = if (reading.pace == UsagePace.Pace.FASTER) NtColors.warning else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/** `<24h → "16:40"` clock time, else `"3d 16h"` — the iOS usage tab's reset label. */
private fun resetLabel(resetsAt: Long, now: Long = System.currentTimeMillis()): String {
    val left = resetsAt - now
    if (left <= 0) return "now"
    return if (left < 86_400_000L) SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(resetsAt))
    else "${left / 86_400_000L}d ${(left % 86_400_000L) / 3_600_000L}h"
}
