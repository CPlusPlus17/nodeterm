package dev.nodeterm.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.protocol.model.OnScreen

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(nav: Navigator, hostId: String, nodeId: String, title: String) {
    val graph = NodetermApp.graph(LocalContext.current)
    val session = remember(hostId) { graph.connections.session(hostId) }
    val controller = remember(hostId, nodeId) { TerminalController(graph, session, nodeId) }
    var draft by remember { mutableStateOf("") }

    // Attached and watching only while the screen is STARTED (audit A18): in the background the
    // relay stream kept the desktop treating the session as watched (Eco shield, and the phone's
    // size as a ceiling) and kept the radio busy. Stop detaches; start reattaches.
    // While the pane shows, this session's Inbox events are in front of the user: the live refresh
    // records them as seen instead of announcing them (A73). Only while it shows (the A73 review):
    // the refresh asks controller.pane each time, so an overlay over the pane, or a terminal still
    // connecting, records nothing. Registered before the watch starts, so its first listing knows.
    LifecycleStartEffect(controller) {
        val showing = session.onScreen.showNode(nodeId) { controller.pane }
        session.startWatching()
        controller.onStart()
        onStopOrDispose {
            controller.onStop()
            session.stopWatching()
            showing.close()
        }
    }
    // The pane just came on screen: what it shows of the latest listing is seen now. That listing
    // arrived while the terminal was connecting and left this session's events waiting (A73 review).
    val pane = controller.pane
    LaunchedEffect(controller, pane) {
        if (pane == OnScreen.Pane.SHOWN) session.notePaneShown(nodeId)
    }
    DisposableEffect(controller) {
        onDispose { controller.dispose() }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1) },
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    TextButton(onClick = { controller.setFontSize(graph.hosts.fontSize - 1) }) { Text("A−") }
                    TextButton(onClick = { controller.setFontSize(graph.hosts.fontSize + 1) }) { Text("A+") }
                }
            )
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().aboveKeyboard(padding)) {
            Box(Modifier.weight(1f).fillMaxWidth().background(NtColors.canvas)) {
                // A new key = a new WebView: the old one was destroyed with its renderer (audit A45).
                // None at all after a loss until the next attach is asked for (the review of A45).
                if (controller.hasWebView) {
                    key(controller.webViewKey) {
                        AndroidView(factory = { ctx -> controller.createWebView(ctx) }, modifier = Modifier.fillMaxSize())
                    }
                }
                when (val st = controller.state) {
                    TermState.Connecting -> Row(
                        Modifier.align(Alignment.Center).background(NtColors.panel, RoundedCornerShape(8.dp)).padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        CircularProgressIndicator(Modifier.padding(2.dp))
                        Text("Opening terminal…")
                    }
                    is TermState.Ended -> Column(
                        Modifier.align(Alignment.Center).background(NtColors.panel, RoundedCornerShape(8.dp)).padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text(st.message)
                        Button(onClick = { controller.reattach() }) { Text("Reattach") }
                    }
                    is TermState.RelayOffer -> Column(
                        Modifier.align(Alignment.Center).background(NtColors.panel, RoundedCornerShape(8.dp)).padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text(st.message)
                        Button(onClick = { controller.openThroughRelay() }) { Text("Open through the relay") }
                    }
                    is TermState.ViewLost -> Column(
                        Modifier.align(Alignment.Center).background(NtColors.panel, RoundedCornerShape(8.dp)).padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text(st.message)
                        Button(onClick = { controller.reopenTerminal() }) { Text("Reopen terminal") }
                    }
                    is TermState.AwaitingApproval -> Column(
                        Modifier.align(Alignment.Center).background(NtColors.panel, RoundedCornerShape(8.dp)).padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text("Approve this phone on your computer")
                        Text(st.sas, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.headlineMedium, color = NtColors.accent)
                        Text(
                            "Approve only if the code on the computer matches this one.",
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                    TermState.Attached -> Unit
                }
                controller.resumeOffer?.let { offer ->
                    Column(
                        Modifier.align(Alignment.TopCenter).fillMaxWidth().background(NtColors.panel2).padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Text(offer.message)
                        Text(offer.command, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { controller.acceptResume() }, enabled = controller.canResume) { Text(offer.button) }
                            OutlinedButton(onClick = { controller.dismissResume() }) { Text("Not now") }
                        }
                    }
                }
                controller.notice?.let { msg ->
                    Row(
                        Modifier.align(Alignment.TopCenter).fillMaxWidth().background(NtColors.panel2).padding(horizontal = 12.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(msg, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { controller.notice = null }) { Text("OK") }
                    }
                }
                controller.sizedElsewhere?.let { (c, r) ->
                    Row(
                        Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(NtColors.panel2).padding(horizontal = 12.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Sized to another screen (${c}×$r)", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { controller.fitHere() }) { Text("Fit this screen") }
                    }
                }
            }
            KeyRow(controller)
            // The draft is cleared only once it was sent: while nothing is attached (connecting,
            // disconnected, ended) Send is disabled and the keyboard's Send leaves the text in place,
            // with the overlay above saying why (A41). Typing a draft meanwhile stays possible.
            val send: () -> Unit = { if (controller.submit(draft, enter = true)) draft = "" }
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Type a command or a prompt") },
                    maxLines = 4,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { send() })
                )
                IconButton(onClick = send, enabled = controller.attached) { Icon(Icons.AutoMirrored.Filled.Send, "Send") }
            }
        }
    }
}

/**
 * The keys a phone keyboard does not have, one tap each. Arrows honour the pane's cursor mode. The
 * sending keys are disabled while nothing is attached (A41): they used to look sent and reach nothing.
 * Ctrl (a modifier for the next key) and ⌨ (opens the keyboard) send nothing themselves.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun KeyRow(controller: TerminalController) {
    val on = controller.attached
    val focusManager = LocalFocusManager.current
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        FilterChip(selected = controller.ctrlArmed, onClick = { controller.ctrlArmed = !controller.ctrlArmed }, label = { Text("Ctrl") })
        KeyChip("Esc", on) { controller.key("esc") }
        KeyChip("Tab", on) { controller.key("tab") }
        KeyChip("⇧Tab", on) { controller.key("stab") }
        KeyChip("↑", on) { controller.key("up") }
        KeyChip("↓", on) { controller.key("down") }
        KeyChip("←", on) { controller.key("left") }
        KeyChip("→", on) { controller.key("right") }
        KeyChip("⏎", on) { controller.key("enter") }
        KeyChip("⇧⏎", on) { controller.key("nl") }
        KeyChip("^C", on) { controller.raw("\u0003") }
        KeyChip("^D", on) { controller.raw("\u0004") }
        KeyChip("^R", on) { controller.raw("\u0012") }
        KeyChip("^L", on) { controller.raw("\u000c") }
        KeyChip("Home", on) { controller.key("home") }
        KeyChip("End", on) { controller.key("end") }
        KeyChip("PgUp", on) { controller.key("pgup") }
        KeyChip("PgDn", on) { controller.key("pgdn") }
        // The input bar's field lets go of focus first, or it keeps the keyboard (audit A46).
        KeyChip("⌨") {
            focusManager.clearFocus()
            controller.showKeyboard()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun KeyChip(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    FilterChip(selected = false, onClick = onClick, enabled = enabled, label = { Text(label, fontFamily = FontFamily.Monospace) })
}
