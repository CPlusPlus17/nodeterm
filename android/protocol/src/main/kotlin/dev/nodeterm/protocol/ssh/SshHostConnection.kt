package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.host.ApprovalOutcome
import dev.nodeterm.protocol.host.CardLabelEdit
import dev.nodeterm.protocol.host.GitVerb
import dev.nodeterm.protocol.host.HostCapabilities
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.LabelEditResult
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.NewNode
import dev.nodeterm.protocol.host.NewSessionHint
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.host.TerminalStream
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.o
import dev.nodeterm.protocol.model.J.objects
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.model.KanbanColumn
import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.pairing.SshIdentity
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import net.schmizz.keepalive.KeepAliveProvider
import net.schmizz.keepalive.KeepAliveRunner
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import java.io.OutputStream
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.util.Base64
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

/** Trust-on-first-use pin for the computer's SSH host key (`SHA256:<base64>`, OpenSSH's format). */
interface HostKeyPin {
    /** The pinned fingerprint, or null before the first successful connect. */
    fun pinned(): String?
    fun pin(fingerprint: String)
}

class HostKeyChangedException(val expected: String, val actual: String) :
    Exception("This computer's SSH host key changed (expected $expected, got $actual). If you reinstalled it, remove and re-pair it; otherwise someone may be intercepting the connection.")

/**
 * [HostConnection] over direct SSH (the LAN leg a pairing installs a key for). Everything is POSIX
 * sh + tmux on the computer ([SshScripts]); what needs the DESKTOP APP rather than the machine —
 * renderer nudges, board writes, node registration, git through the app — is the relay's, and this
 * transport reports it as unavailable instead of guessing.
 */
class SshHostConnection private constructor(private val client: SSHClient) : HostConnection {
    override val kind = TransportKind.SSH
    override val capabilities = HostCapabilities(
        boardWrites = false, git = false, nodeActions = false, registerNode = false, answerApprovals = true
    )

    @Volatile private var onClosed: ((String?) -> Unit)? = null
    @Volatile private var userData: String? = null

    @Volatile private var closedFired = false

    private fun fireClosed(reason: String?) {
        if (closedFired) return
        closedFired = true
        onClosed?.invoke(reason)
    }

    /** True while the SSH transport is up. */
    val isConnected: Boolean get() = client.isConnected && client.isAuthenticated && client.socket?.isClosed != true

    /**
     * Run a script through `/bin/sh -c` and return stdout (bounded wait). A dead transport is
     * reported through `onClosed` (so the owner reconnects) and surfaces as a [HostException] —
     * never as a raw sshj exception a caller would have to know about.
     */
    internal fun run(script: String, timeoutSec: Long = 20): Pair<Int?, String> {
        // A REAL deadline (audit A31): the read below waits on the channel with no timeout of its
        // own, so a peer that vanished mid-command (laptop asleep, IP or VPN change) blocked it for
        // as long as TCP took to give up — ~15 minutes. When the deadline passes, the connection is
        // treated as dead: the transport is torn down (which also wakes the blocked read) and the
        // drop is reported, so Auto falls back to the relay instead of sitting on "On your network".
        var timedOut = false
        val deadline = WATCHDOG.schedule({
            timedOut = true
            disconnectQuietly()
        }, timeoutSec, TimeUnit.SECONDS)
        try {
            client.startSession().use { session ->
                val cmd = session.exec("/bin/sh -c " + SshScripts.q(script))
                val out = cmd.inputStream.readBytes()
                cmd.join(5, TimeUnit.SECONDS)
                if (timedOut) throw java.util.concurrent.TimeoutException("no answer within ${timeoutSec}s")
                return cmd.exitStatus to String(out, Charsets.UTF_8)
            }
        } catch (e: HostException) {
            throw e
        } catch (e: Exception) {
            // A command that cannot even be run (the channel would not open, the transport timed out,
            // the deadline passed) says the CONNECTION is unusable, whatever `isConnected` claims:
            // drop it and report the drop, so the owner reconnects — or falls back to the relay.
            disconnectQuietly()
            fireClosed(e.message ?: e.javaClass.simpleName)
            throw HostException("The SSH connection failed: ${e.message ?: e.javaClass.simpleName}")
        } finally {
            deadline.cancel(false)
        }
    }

    override suspend fun listProjects(): ProjectsSnapshot = withContext(Dispatchers.IO) {
        val (_, raw) = run(SshScripts.browse())
        val metaEnd = raw.indexOf(SshScripts.META_END)
        val meta = if (metaEnd >= 0) raw.substring(0, metaEnd) else ""
        val blob = if (metaEnd >= 0) raw.substring(metaEnd + SshScripts.META_END.length).removePrefix("\n") else raw
        val ud = meta.lineSequence().firstOrNull { it.startsWith("ud=") }?.removePrefix("ud=")?.takeIf { it.isNotBlank() }
        // No userData dir is not "a computer with no sessions": it means we are looking in the wrong
        // place (audit A02 shipped exactly that as an empty list). Say so instead.
        if (ud == null && metaEnd >= 0) throw HostException(NO_USER_DATA)
        userData = ud
        val base = ProjectsParser.parseBlob(blob)
        val wsText = blob.substringBefore(ProjectsParser.PROJECTS_MARK)
        val root = J.obj(J.parse(wsText))
        val snapshot = if (root != null && J.long(root["version"]) == 3L) {
            base.copy(projects = resolveIndexV3(root, ud))
        } else {
            base
        }
        rememberRemoteNodes(snapshot)
        snapshot
    }

    /**
     * The on-disk workspace.json is a v3 INDEX: folder refs carry no nodes (their canvas is in
     * `<cwd>/.nodeterm/project.json`), SSH refs carry an offline `cache`, local-data refs a
     * `userData/inline-projects/<id>.json` (with `project` as its cache). One extra exec reads every
     * referenced file; an unreadable one keeps the entry with whatever the index itself had.
     */
    private fun resolveIndexV3(root: JsonObject, ud: String?): List<ProjectInfo> {
        val entries = root.objects("entries")
        val paths = ArrayList<String>()
        val fileIndex = HashMap<Int, Int>()
        for ((i, e) in entries.withIndex()) {
            val cwd = e.s("cwd")
            val path = when {
                cwd != null && e.o("ssh") == null -> "$cwd/.nodeterm/project.json"
                e.b("dataFile") == true && ud != null && e.s("id") != null -> "$ud/inline-projects/${e.s("id")}.json"
                else -> null
            }
            if (path != null) {
                fileIndex[i] = paths.size
                paths.add(path)
            }
        }
        val files = HashMap<Int, String>()
        if (paths.isNotEmpty()) {
            val (_, out) = run(SshScripts.catFiles(paths), timeoutSec = 30)
            val parts = out.split("\n" + SshScripts.FILE_MARK)
            for (part in parts.drop(1)) {
                val nl = part.indexOf('\n')
                val idx = (if (nl >= 0) part.substring(0, nl) else part).trim().toIntOrNull() ?: continue
                files[idx] = if (nl >= 0) part.substring(nl + 1) else ""
            }
        }
        return entries.withIndex().mapNotNull { (i, e) ->
            val id = e.s("id") ?: return@mapNotNull null
            val fileText = fileIndex[i]?.let { files[it] }
            val content: JsonObject? = J.obj(fileText?.let(J::parse)) ?: e.o("cache") ?: e.o("project")
            val merged = buildMap<String, JsonElement> {
                content?.let { putAll(it) }
                // The ENTRY is the identity and the machine-local half (#510): id, name, color, closed.
                for (k in listOf("id", "name", "color", "closed", "cwd", "ssh")) e[k]?.let { put(k, it) }
            }
            val project = ProjectsParser.parseProject(JsonObject(merged)) ?: return@mapNotNull null
            val cwd = e.s("cwd")
            // Folder-ref node cwds are stored portable ("./…") — resolve them against the root.
            if (cwd != null) project.copy(nodes = project.nodes.map { n ->
                val c = n.cwd
                if (c != null && (c == "." || c.startsWith("./"))) n.copy(cwd = cwd.trimEnd('/') + c.removePrefix(".")) else n
            }) else project
        }
    }

    override suspend fun attach(nodeId: String, cols: Int, rows: Int, sink: TerminalSink, create: NewSessionHint?): TerminalStream =
        withContext(Dispatchers.IO) {
            refuseRemoteNode(nodeId)
            if (run(SshScripts.hasSession(nodeId)).second.trim() != "yes") throw notRunning(nodeId)
            val session = client.startSession()
            try {
                session.allocatePTY("xterm-256color", cols, rows, 0, 0, emptyMap())
                val cmd = session.exec("/bin/sh -c " + SshScripts.q(SshScripts.attach(nodeId)))
                SshStream(session, cmd, fresh = false, sink = sink).also { it.start() }
            } catch (e: Exception) {
                runCatching { session.close() }
                throw HostException("Couldn't open the terminal over SSH: ${e.message}")
            }
        }

    /** Node ids of the desktop's SSH projects → `user@host`, from the latest listing. */
    @Volatile private var remoteNodes: Map<String, String> = emptyMap()

    /** Remember which nodes belong to the desktop's SSH projects (their tmux is on another host). */
    fun rememberRemoteNodes(snapshot: ProjectsSnapshot) {
        remoteNodes = snapshot.projects.filter { it.sshTarget != null }
            .flatMap { p -> p.nodes.map { it.id to p.sshTarget!! } }.toMap()
    }

    /**
     * A node of one of the desktop's SSH projects lives on ANOTHER host: its tmux session, its
     * pending approvals and its read-acks are all there, not on this computer. Over direct SSH we can
     * only reach this computer, so every node-scoped action refuses (audit A09) — attaching would
     * create a phantom local session and offer to resume the agent on the wrong machine.
     */
    private fun refuseRemoteNode(nodeId: String) {
        val where = remoteNodes[nodeId] ?: return
        throw NeedsRelayException(
            nodeId,
            "This session runs on $where, which the phone reaches through your computer: it opens through the relay, not over your network."
        )
    }

    private fun notRunning(nodeId: String) = NeedsRelayException(
        nodeId,
        "This session isn't running on the computer right now. Starting it over your network would leave it " +
            "without status reporting, so it opens through the relay instead (or open it in nodeterm on the computer)."
    )

    /**
     * The terminal stream over one exec'd pty channel.
     *
     * EVERY socket write goes through ONE serial executor owned by the stream ([io]), never the
     * caller's thread (audit A01/A04). [TerminalStream] is a non-suspend contract, and its callers
     * include the Android MAIN thread (resize on a keyboard/rotation/A−/A+, the ^C key chips, Resume,
     * Fit) as well as the WebView's JavaBridge thread (typed input). A socket write on the main thread
     * throws `NetworkOnMainThreadException` — and it throws AFTER sshj's `Encoder.encode` has advanced
     * the packet sequence number and the cipher stream, so the transport is corrupt from then on and
     * the very next packet drops the connection. One executor also keeps the two producers IN ORDER
     * (a ^C chip can neither overtake nor split typed bytes), which fixing each call site would not.
     *
     * Failures are never swallowed: a [RuntimeException] out of the write path means the transport's
     * state is unknown, so the whole connection is torn down ([breakTransport]) and reported through
     * `onClosed`; an [java.io.IOException] with the transport still up is only this CHANNEL closing
     * (tmux exited), which the reader thread reports as the stream's exit.
     */
    private inner class SshStream(
        private val session: Session,
        private val cmd: Session.Command,
        override val fresh: Boolean,
        private val sink: TerminalSink
    ) : TerminalStream {
        private val stdin: OutputStream = cmd.outputStream
        private val io: ExecutorService = Executors.newSingleThreadExecutor { r ->
            Thread(r, "nodeterm-ssh-writer").apply { isDaemon = true }
        }
        @Volatile private var ended = false

        fun start() {
            Thread({
                val buf = ByteArray(16 * 1024)
                val input = cmd.inputStream
                try {
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (n > 0) sink.onOutput(buf.copyOf(n))
                    }
                } catch (_: Exception) {
                    // channel closed
                }
                runCatching { cmd.join(2, TimeUnit.SECONDS) }
                ended = true
                io.shutdown()
                sink.onExit(cmd.exitStatus)
                runCatching { session.close() }
            }, "nodeterm-ssh-stream").apply { isDaemon = true }.start()
        }

        /** Queue [block] on the stream's writer; a stream that has ended drops it. */
        private fun enqueue(block: () -> Unit) {
            if (ended) return
            try {
                io.execute {
                    if (ended) return@execute
                    try {
                        block()
                    } catch (e: java.io.IOException) {
                        if (!isConnected) fireClosed(e.message)
                        // else: this channel closed under us; the reader thread reports the exit.
                    } catch (e: Throwable) {
                        ended = true
                        breakTransport(e)
                    }
                }
            } catch (_: RejectedExecutionException) {
                // detached or exited: nothing left to write to
            }
        }

        override fun write(text: String) {
            val bytes = text.toByteArray(Charsets.UTF_8)
            enqueue {
                stdin.write(bytes)
                stdin.flush()
            }
        }

        override fun resize(cols: Int, rows: Int) {
            // The exec'd channel is a SessionChannel, which is also a Session.Shell (the window-change owner).
            enqueue { (session as Session.Shell).changeWindowDimensions(cols.coerceAtLeast(1), rows.coerceAtLeast(1), 0, 0) }
        }

        /** The same SGR wheel event the relay host writes (host-service.ts `handleScroll`): tmux's
         *  mouse is on, so the wheel enters copy-mode and scrolls its own history. */
        override suspend fun scroll(up: Boolean, lines: Int) {
            val seq = "\u001b[<${if (up) 64 else 65};1;1M"
            write(seq.repeat(lines.coerceIn(1, 20)))
        }

        override suspend fun detach() {
            // Close BEHIND the writes already queued, so a keystroke typed just before leaving lands.
            val done = CompletableDeferred<Unit>()
            try {
                io.execute {
                    runCatching { session.close() }
                    done.complete(Unit)
                }
                io.shutdown()
                withTimeoutOrNull(3_000) { done.await() }
            } catch (_: RejectedExecutionException) {
                // already ended
            }
            ended = true
            withContext(Dispatchers.IO) { runCatching { session.close() } }
        }

        override suspend fun endSession() {
            throw HostException("Ending a session needs the relay connection (it also removes the node from the canvas).")
        }
    }

    /**
     * An exception escaped sshj's write path that was not a plain I/O failure: the packet sequence
     * number and cipher may already have advanced, so every later packet would be garbage to the
     * server. Tear the transport down now and say so, rather than leaving a connection that looks
     * alive until its next packet.
     */
    private fun breakTransport(e: Throwable) {
        disconnectQuietly()
        fireClosed("the SSH connection broke (${e.message ?: e.javaClass.simpleName})")
    }

    /** `client.disconnect()`, and if that could not finish (its own write failed), the socket itself. */
    private fun disconnectQuietly() {
        try {
            client.disconnect()
        } catch (_: Throwable) {
            // fall through: make sure the socket and sshj's reader thread do not leak
        }
        // Idempotent, and `Socket.isConnected` stays true after a close, so do not gate on it.
        runCatching { client.socket?.close() }
    }

    override suspend fun wake(nodeId: String) { relayOnly("Waking a sleeping session") }
    override suspend fun refresh(nodeId: String) { relayOnly("Refreshing a terminal view") }
    override suspend fun rename(nodeId: String, title: String) { relayOnly("Renaming a session") }
    override suspend fun ensureBoard(projectId: String): List<KanbanColumn>? = relayOnly("Editing the board")
    override suspend fun setCardColumn(projectId: String, nodeId: String, columnId: String?): Boolean = relayOnly("Editing the board")
    override suspend fun editCardLabels(projectId: String, nodeId: String, edit: CardLabelEdit): LabelEditResult? = relayOnly("Editing labels")
    override suspend fun registerNode(projectId: String, node: NewNode): Boolean = relayOnly("Starting a new session")
    override suspend fun git(verb: GitVerb, cwd: String, args: Map<String, JsonElement>): JsonElement? = relayOnly("Source control")

    private fun relayOnly(what: String): Nothing =
        throw HostException("$what needs the relay connection (turn on remote access in nodeterm → Settings → Phone).")

    override suspend fun answerApproval(event: InboxEvent, allow: Boolean): ApprovalOutcome = withContext(Dispatchers.IO) {
        refuseRemoteNode(event.nodeId)
        val pendingId = event.pendingId ?: return@withContext ApprovalOutcome.UNSUPPORTED
        if (!SshScripts.PENDING_ID.matches(pendingId)) return@withContext ApprovalOutcome.UNSUPPORTED
        when (run(SshScripts.answerApproval(pendingId, allow)).second.trim()) {
            "sent" -> ApprovalOutcome.SENT
            "gone" -> ApprovalOutcome.GONE
            else -> throw HostException("Couldn't write the answer on the computer.")
        }
    }

    /** The phone→host read-ack (src/core/ack-sweep.ts): `~/.nodeterm/acks/<nodeId>.seen`. */
    override suspend fun ackRead(nodeId: String, eventId: String?) {
        // A remote node's read-ack belongs on ITS host; writing it here would ack nothing.
        if (remoteNodes.containsKey(nodeId)) return
        withContext(Dispatchers.IO) { runCatching { run(SshScripts.ackRead(nodeId, eventId ?: "")) } }
    }

    override suspend fun sendKeys(nodeId: String, keys: String) {
        withContext(Dispatchers.IO) {
            refuseRemoteNode(nodeId)
            val (code, _) = run(SshScripts.sendKeys(nodeId, keys))
            if (code != null && code != 0) throw HostException("Couldn't type into the session (tmux exited $code).")
        }
    }

    /** Kill the node's tmux session (the node stays on the canvas; the desktop shows it as ended). */
    suspend fun killSession(nodeId: String) = withContext(Dispatchers.IO) {
        refuseRemoteNode(nodeId)
        run(SshScripts.killSession(nodeId))
    }

    /** `~/.nodeterm/relay.json`, when the computer advertises its relay identity (late adoption). */
    suspend fun readRelayAdvertisement(): JsonObject? = withContext(Dispatchers.IO) {
        J.obj(J.parse(run(SshScripts.readRelayAdvertisement()).second))
    }

    override fun setOnChanged(listener: (() -> Unit)?) {
        // SSH has no push channel; the UI polls (every 8 s while foregrounded, like iOS).
    }

    override fun setOnClosed(listener: ((String?) -> Unit)?) {
        onClosed = listener
    }

    /**
     * Intentional close. Never on the caller's thread: it is called from click handlers (Forget, a
     * route change, re-pairing) on the Android main thread, where `SSH_MSG_DISCONNECT` would throw
     * `NetworkOnMainThreadException` before sshj closes the socket — leaking it and its reader thread.
     */
    override fun close() {
        closedFired = true // an intentional close is not a drop
        Thread({ disconnectQuietly() }, "nodeterm-ssh-close").apply { isDaemon = true }.start()
    }

    companion object {
        /** A dead peer is noticed within about interval × missed (≈45 s). */
        const val KEEPALIVE_INTERVAL_SEC = 15
        const val KEEPALIVE_MAX_MISSED = 3

        /** One daemon timer for every [run] deadline. */
        private val WATCHDOG = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "nodeterm-ssh-watchdog").apply { isDaemon = true }
        }

        const val NO_USER_DATA = "nodeterm's data wasn't found on this computer over SSH (looked for " +
            "~/Library/Application Support/node-terminal and ~/.config/node-terminal). Open nodeterm on the computer " +
            "once, or connect through the relay."

        /** OpenSSH-style `SHA256:<unpadded base64>` of the host key blob. */
        fun fingerprint(key: PublicKey): String {
            val blob = Buffer.PlainBuffer().putPublicKey(key).compactData
            val digest = MessageDigest.getInstance("SHA-256").digest(blob)
            return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)
        }

        fun connect(
            host: String,
            port: Int,
            user: String,
            identity: SshIdentity,
            pin: HostKeyPin,
            connectTimeoutMs: Int = 8_000,
            socketFactory: SocketFactory? = null
        ): SshHostConnection {
            // KEEP_ALIVE, not sshj's default HEARTBEAT: a heartbeat is an SSH_MSG_IGNORE that expects
            // no reply, so it never notices a dead peer. keepalive@openssh.com wants a reply and
            // kills the transport after [KEEPALIVE_MAX_MISSED] misses, which fires the disconnect
            // listener below → onClosed → the owner reconnects or falls back (audit A31).
            val client = SSHClient(DefaultConfig().apply { keepAliveProvider = KeepAliveProvider.KEEP_ALIVE })
            if (socketFactory != null) client.socketFactory = socketFactory
            var mismatch: HostKeyChangedException? = null
            client.addHostKeyVerifier(object : HostKeyVerifier {
                override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
                    val fp = fingerprint(key)
                    val pinned = pin.pinned()
                    return when {
                        pinned == null -> {
                            pin.pin(fp)
                            true
                        }
                        pinned == fp -> true
                        else -> {
                            mismatch = HostKeyChangedException(pinned, fp)
                            false
                        }
                    }
                }

                override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
            })
            client.connectTimeout = connectTimeoutMs
            client.timeout = 30_000
            try {
                client.connect(host, port)
                val kp = identity.keyPair
                client.authPublickey(user, object : KeyProvider {
                    override fun getPrivate(): PrivateKey = kp.private
                    override fun getPublic(): PublicKey = kp.public
                    override fun getType(): KeyType = KeyType.ED25519
                })
                client.connection.keepAlive.keepAliveInterval = KEEPALIVE_INTERVAL_SEC
                (client.connection.keepAlive as? KeepAliveRunner)?.maxAliveCount = KEEPALIVE_MAX_MISSED
            } catch (e: Exception) {
                runCatching { client.disconnect() }
                if (client.isConnected) runCatching { client.socket?.close() }
                mismatch?.let { throw it }
                throw HostException("Couldn't connect over SSH to $user@$host:$port (${e.message ?: e.javaClass.simpleName}).")
            }
            val conn = SshHostConnection(client)
            // The transport dying (network change, sleep, the computer going away) is the one event
            // nothing else would report: without this the owner keeps a dead connection forever.
            client.transport.disconnectListener = net.schmizz.sshj.transport.DisconnectListener { _, message ->
                conn.fireClosed(message)
            }
            return conn
        }
    }
}
