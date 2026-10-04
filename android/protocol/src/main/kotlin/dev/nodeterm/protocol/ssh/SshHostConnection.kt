package dev.nodeterm.protocol.ssh

import com.hierynomus.sshj.userauth.certificate.Certificate
import dev.nodeterm.protocol.host.ApprovalOutcome
import dev.nodeterm.protocol.host.CardLabelEdit
import dev.nodeterm.protocol.host.GitVerb
import dev.nodeterm.protocol.host.HostCapabilities
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.LabelEditResult
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.NewNode
import dev.nodeterm.protocol.host.NewSessionHint
import dev.nodeterm.protocol.host.SshAuthRefusedException
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.host.TerminalStream
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.HookReplies
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.o
import dev.nodeterm.protocol.model.J.objects
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.model.KanbanColumn
import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.TmuxNames
import dev.nodeterm.protocol.pairing.SshIdentity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
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
import net.schmizz.sshj.userauth.UserAuthException
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

/**
 * The pin for the computer's SSH host key (`SHA256:<base64>`, OpenSSH's format).
 *
 * [pin] is called only once the server has ACCEPTED this phone's key (audit A49), never during the
 * key exchange: a machine that merely answered at the paired address — another computer that now
 * has that DHCP lease, or the same private range on another network — refuses our key, and it must
 * not become the pin.
 *
 * Before the first pin, [anchors] decides which keys may become it (audit A49-anchor): the
 * fingerprints the computer named in its sealed pairing answer ([HostKeyAnchors]). A server whose
 * key is none of them is refused during the key exchange, before this phone's key is offered. With no
 * anchors (an older or Windows desktop, keys it could not read, a computer added by its SSH address)
 * the first server that accepts our key becomes the pin: trust on first use.
 *
 * What is pinned is [SshHostConnection.hostKeyFingerprint]: for a host certificate, the key it
 * certifies, never the certificate itself (review of A74-refresh).
 */
interface HostKeyPin {
    /** The pinned fingerprint, or null until a connect has authenticated with this phone's key. */
    fun pinned(): String?

    /**
     * Called with the authenticated server's key when nothing is pinned, and once more to re-spell a
     * pin an older build took from a host certificate's own fingerprint as the key that certificate
     * certifies (the same key; review of A74-refresh). Both only after the server accepted our key.
     */
    fun pin(fingerprint: String)

    /** The fingerprints the first connect must present one of, from pairing; empty = trust on first use. */
    fun anchors(): List<String> = emptyList()
}

/**
 * The server at the paired address presented a key other than the pinned one. The message states
 * the fact and its likely causes; what the user can do about it depends on the route, and
 * [SshFallback] adds it.
 */
open class HostKeyChangedException protected constructor(
    val expected: String,
    val actual: String,
    message: String
) : Exception(message) {
    constructor(expected: String, actual: String) : this(
        expected,
        actual,
        "This computer's SSH host key changed (expected $expected, got $actual), so the phone did not connect " +
            "to it over your network. Another machine may now have its network address (a different Wi-Fi, or " +
            "a reassigned address), or the computer was reinstalled; if neither, someone may be intercepting " +
            "the connection."
    )
}

/**
 * The first SSH connect to a paired computer met a host key that is none of the keys the computer
 * named in its sealed pairing answer (audit A49-anchor), or reported since through the relay (audit
 * A74-refresh, [LanRefresh]). Nothing was pinned, and this phone's key was never offered. A
 * [HostKeyChangedException], so [SshFallback] routes it as one: never used over SSH, and in Auto the
 * relay leg, which checks the computer on its own, is still tried. Its advice differs
 * ([SshFallback.NOT_REPORTED_NOTE]): pairing again re-reads the same keys, so it is no way out when the
 * computer's SSH server uses a key nodeterm on it cannot read.
 */
class HostKeyNotPairedException(val paired: List<String>, actual: String) : HostKeyChangedException(
    paired.joinToString(" or "),
    actual,
    "This computer's SSH server presented a host key ($actual) that is " +
        (if (paired.size == 1) "not the key" else "none of the ${paired.size} keys") +
        " the computer reported to this phone (when it was paired, or since through the relay), so the phone did " +
        "not connect to it over your network. " +
        "Another machine may have its network address (a different Wi-Fi, or a reassigned address), or the " +
        "computer's SSH server uses a key nodeterm on it could not read; if neither, someone may be " +
        "intercepting the connection."
)

/**
 * The browse found nothing of nodeterm's on the computer: not an empty computer, but the wrong place
 * to look (audit A02). Its [message] ends by offering the relay; [said] picks the ending the phone can
 * stand behind for the relay leg it has (review of A27b) — a computer added by its SSH address has no
 * relay and never will, and one without a usable relay leg cannot be "connected through the relay".
 */
class NothingFoundException : HostException(SshHostConnection.NO_USER_DATA) {
    fun said(leg: LegRouting.RelayLeg): String = when (leg) {
        // The phone holds a relay leg: open, or one a route change opens.
        LegRouting.RelayLeg.AVAILABLE, LegRouting.RelayLeg.ROUTE_SSH_ONLY -> SshHostConnection.NO_USER_DATA
        LegRouting.RelayLeg.ADDED_OVER_SSH -> SshHostConnection.NO_USER_DATA_ADDED_OVER_SSH
        LegRouting.RelayLeg.NOT_SET_UP, LegRouting.RelayLeg.NOT_PICKED_UP, LegRouting.RelayLeg.REMOTE_ACCESS_OFF ->
            SshHostConnection.NO_USER_DATA_NO_RELAY
    }
}

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

    /**
     * Whether the computer advertised its relay (`~/.nodeterm/relay.json`) at the last listing: the
     * desktop writes that file while its phone host is registered at the relay and removes it when
     * remote access is turned off (src/main/remote/relay-advertise.ts). A relay token the phone holds
     * outlives that toggle, so this is what tells "remote access is off on the computer" apart from a
     * working relay leg (audit A26). Null before the first listing, or when the listing did not say.
     */
    @Volatile var relayAdvertised: Boolean? = null
        private set

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
    internal fun run(script: String, timeoutSec: Long = 20, stdin: String? = null): Pair<Int?, String> {
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
                if (stdin != null) cmd.outputStream.use { it.write(stdin.toByteArray(Charsets.UTF_8)) }
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

    override suspend fun listProjects(): ProjectsSnapshot = withContext(Dispatchers.IO) { browseNow() }

    /** [listProjects], blocking: one browse, and what it says about the computer's nodes remembered. */
    private fun browseNow(): ProjectsSnapshot {
        val now = System.currentTimeMillis()
        val (_, raw) = run(SshScripts.browse())
        val out = HostBrowse.split(raw)
        val ud = out.userData
        // Nothing found is not "a computer with no sessions": it means we are looking in the wrong
        // place (audit A02 shipped exactly that as an empty list), or at a nodeterm whose data dir we
        // cannot know (a Server Edition with another --data-dir). Say so instead.
        relayAdvertised = out.relayAdvertised
        if (out.nothingFound(now)) {
            // Still an answer about the nodes: none here is anyone's (no index, nothing driven).
            remember(ProjectsSnapshot.EMPTY)
            throw NothingFoundException()
        }
        userData = ud
        val base = ProjectsParser.parseBlob(out.blob)
        val wsText = out.blob.substringBefore(ProjectsParser.PROJECTS_MARK)
        val root = J.obj(J.parse(wsText))
        val own = if (root != null && J.long(root["version"]) == 3L) {
            base.copy(projects = resolveIndexV3(root, ud))
        } else {
            base
        }
        // What a desktop that drives this computer over SSH left here, next to the host's own (A27).
        val snapshot = HostBrowse.assemble(own, out, now)
        remember(snapshot, out.phoneTerminals.associate { it.id to it.creation })
        return snapshot
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

    /**
     * Explicitly start one independent plain shell, with no managed agent hook/account state.
     * A lost/cancelled reply may leave the shell running: retry the SAME id and folder to reconcile
     * it. Neither cancellation nor a viewer detach kills a successfully created terminal.
     */
    suspend fun createTerminal(nodeId: String, cwd: String? = null): Unit = withContext(Dispatchers.IO) {
        val script = SshScripts.createTerminal(nodeId, cwd)
        val (code, out) = run(script)
        if (code != 0 || out.trim() != "created") {
            val message = out.trim().takeIf { it.startsWith("nodeterm:") }
                ?: "Couldn't create the terminal over SSH (exit ${code ?: "unknown"}). Retry the same terminal."
            if (code == 2 && out.trim() in setOf(
                    "nodeterm: Choose an absolute folder.",
                    "nodeterm: That folder no longer exists or cannot be opened.",
                    "nodeterm: This terminal id is already in use.",
                    "nodeterm: This terminal id belongs to another session."
                )) throw SshTerminalCreationRefusedException(message)
            throw HostException(message)
        }
    }

    override suspend fun attach(nodeId: String, cols: Int, rows: Int, sink: TerminalSink, create: NewSessionHint?): TerminalStream {
        // The blocking open finishes even when the caller is cancelled meanwhile, and withContext
        // then drops its result: a tmux client attached for the life of the connection, which
        // nobody holds and nothing detaches (audit A40; the same shape as A20's dial).
        var opened: SshStream? = null
        try {
            return withContext(Dispatchers.IO) {
                ensureListed()
                refuseRemoteNode(nodeId)
                val phoneCreation = if (PhoneTerminals.validId(nodeId)) ownedPhoneCreation(nodeId) else null
                // Where the session is NOW, on either socket (A27): one exec that is also the
                // existence check, so a session listed on one socket is never attached on the other.
                val socket = run(SshScripts.whichSocket(nodeId, phoneCreation)).second.trim().takeIf { it in TmuxNames.SOCKETS }
                    ?: throw notRunning(nodeId)
                val session = client.startSession()
                try {
                    session.allocatePTY("xterm-256color", cols, rows, 0, 0, emptyMap())
                    val cmd = session.exec("/bin/sh -c " + SshScripts.q(SshScripts.attach(nodeId, socket, phoneCreation)))
                    SshStream(session, cmd, fresh = false, sink = sink, nodeId = nodeId, socket = socket).also {
                        opened = it
                        it.start()
                    }
                } catch (e: Exception) {
                    runCatching { session.close() }
                    throw HostException("Couldn't open the terminal over SSH: ${e.message}")
                }
            }
        } catch (e: CancellationException) {
            opened?.let { s -> withContext(NonCancellable) { s.detach() } }
            throw e
        }
    }

    /** Node ids of the desktop's SSH projects → `user@host`, from the latest listing. */
    @Volatile private var remoteNodes: Map<String, String> = emptyMap()

    /** Remember which nodes belong to the desktop's SSH projects (their tmux is on another host). */
    fun rememberRemoteNodes(snapshot: ProjectsSnapshot) {
        remoteNodes = snapshot.projects.filter { it.sshTarget != null }
            .flatMap { p -> p.nodes.map { it.id to p.sshTarget!! } }.toMap()
    }

    /** Session name → tmux socket, from the latest listing ([ProjectsSnapshot.sockets]). */
    @Volatile private var sockets: Map<String, String> = emptyMap()

    /** Nodes of projects a desktop elsewhere drives over SSH ([ProjectInfo.drivenRemotely]). */
    @Volatile private var drivenNodes: Set<String> = emptySet()

    /**
     * Nodes of the computer's OWN index (its folder and data projects, closed ones included; not its
     * SSH projects, whose nodes are [remoteNodes]): the only nodes the relay of this computer starts
     * as the computer's own sessions ([notRunning]).
     */
    @Volatile private var ownNodes: Set<String> = emptySet()
    /** Fingerprints validated from the atomic creation tuple, pinned before each phone action. */
    @Volatile private var phoneOwners: Map<String, String> = emptyMap()

    /** Whether a browse has answered on THIS connection ([ensureListed]). */
    @Volatile private var listed = false
    private val listLock = Any()

    private fun remember(snapshot: ProjectsSnapshot, phone: Map<String, String> = emptyMap()) {
        rememberRemoteNodes(snapshot)
        sockets = snapshot.sockets
        drivenNodes = snapshot.projects.filter { it.drivenRemotely }.flatMapTo(HashSet()) { p -> p.nodes.map { it.id } }
        ownNodes = snapshot.projects.filter { !it.drivenRemotely && it.sshTarget == null }
            .flatMapTo(HashSet()) { p -> p.nodes.map { it.id } }
        phoneOwners = phone
        listed = true
    }

    private fun ownedPhoneCreation(nodeId: String): String {
        phoneOwners[nodeId]?.let { return it }
        // A create may have followed this connection's last browse; discover it once before acting.
        try { browseNow() } catch (_: NothingFoundException) { /* no phone terminal is an answer */ }
        return phoneOwners[nodeId] ?: throw notRunning(nodeId)
    }

    /**
     * Settle what this connection knows of the computer's nodes before a node-scoped decision (the
     * review of A27a). Which nodes are the desktop's SSH projects' ([remoteNodes]), which a desktop
     * elsewhere drives ([drivenNodes]) and which are the computer's own ([ownNodes]) comes from a
     * listing, and a connection that has not listed yet knew none of them: a redial after a drop, or
     * a terminal restored after the process died, attaches at once. A node's refusal then took the
     * "nothing known" branch, which offered this computer's relay for a driven session that was not
     * running, and let a node of an SSH project through to this computer's tmux. So the first
     * node-scoped call on a connection lists, once; "nothing found" is an answer too. A failed
     * transport is not, and fails the call.
     */
    private fun ensureListed() {
        if (listed) return
        synchronized(listLock) {
            if (listed) return
            try {
                browseNow()
            } catch (e: HostException) {
                if (!listed) throw e
            }
        }
    }

    /**
     * The socket [nodeId]'s session is on (audit A27): the one the latest listing saw it on, else the
     * one it is on now ([SshScripts.whichSocket], one exec), else the socket a session of its kind
     * would be on — where the command then fails as "no such session", which is the truth.
     */
    private fun socketFor(nodeId: String): String {
        if (PhoneTerminals.validId(nodeId)) return TmuxNames.PHONE_SOCKET
        sockets[TmuxNames.sessionName(nodeId)]?.let { return it }
        run(SshScripts.whichSocket(nodeId)).second.trim().takeIf { it in TmuxNames.SOCKETS }?.let { return it }
        return if (nodeId in drivenNodes) TmuxNames.REMOTE_SOCKET else TmuxNames.SOCKET
    }

    /**
     * A node of one of the desktop's SSH projects lives on ANOTHER host: its tmux session, its
     * pending approvals and its read-acks are all there, not on this computer. Over direct SSH we can
     * only reach this computer, so every node-scoped action refuses (audit A09) — attaching would
     * create a phantom local session and offer to resume the agent on the wrong machine.
     */
    private fun refuseRemoteNode(nodeId: String) {
        if (PhoneTerminals.validId(nodeId)) return // never route a reserved phone id to a creating relay
        val where = remoteNodes[nodeId] ?: return
        throw NeedsRelayException(
            nodeId,
            "This session runs on $where, which the phone reaches through your computer: it opens through the relay, not over your network.",
            fact = "This session runs on $where, not on this computer, and the phone reaches it only through the relay."
        )
    }

    /**
     * Why [nodeId]'s session cannot be opened when it is not running. The relay is offered only for a
     * node of the computer's OWN index ([ownNodes]): there the relay's `pty.attach` is nodeterm on
     * this computer starting its own session (audit A08). For any other node it would make a bare
     * `nt-<id>` on this computer's `node-terminal` socket, a session of no project with no hook
     * environment, which later attaches then find first (host-service.ts `handleAttach` creates what
     * it does not find). That covers a driven project's node, and a node no listing names at all: a
     * driven project no longer listed (its desktop quit and its sessions ended), a deleted node.
     */
    private fun notRunning(nodeId: String): Exception = when {
        PhoneTerminals.validId(nodeId) -> HostException("This phone terminal has ended or is no longer owned by the phone. Start a new terminal over SSH.")
        // Its desktop is not the one behind this connection's relay: there is nothing to offer.
        nodeId in drivenNodes -> HostException(DRIVEN_NOT_RUNNING)
        nodeId in ownNodes -> NeedsRelayException(
            nodeId,
            "This session isn't running on the computer right now. Starting it over your network would leave it " +
                "without status reporting, so it opens through the relay instead (or open it in nodeterm on the computer).",
            fact = "This session isn't running on the computer right now, and the phone does not start it over " +
                "SSH: it would run without status reporting.",
            action = "start it"
        )
        else -> HostException(NOT_RUNNING_UNLISTED)
    }

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
        private val sink: TerminalSink,
        private val nodeId: String,
        private val socket: String
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

        override suspend fun searchHistory(query: String): dev.nodeterm.protocol.model.TerminalHistory.Result = withContext(Dispatchers.IO) {
            if (ended) throw HostException("This terminal is no longer attached.")
            if (!dev.nodeterm.protocol.model.TerminalHistory.validQuery(query)) throw HostException("Enter a single-line search of 1–256 characters.")
            val creation = if (PhoneTerminals.validId(nodeId)) ownedPhoneCreation(nodeId) else null
            val (code, out) = run(SshScripts.searchHistory(nodeId, query, socket, creation))
            if (ended) throw HostException("This terminal detached while its history was searched.")
            if (code != 0) throw HostException(if (code == 4) "Retained history exceeds the 50 MiB search limit." else "The computer could not capture this terminal's history.")
            dev.nodeterm.protocol.model.TerminalHistory.parseSsh(out, query) ?: throw HostException("The computer returned an invalid history search result.")
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
            if (socket != TmuxNames.PHONE_SOCKET) {
                throw HostException("Ending a session needs the relay connection (it also removes the node from the canvas).")
            }
            killSession(nodeId)
            detach()
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

    // The app routes these to the relay leg itself ([LegRouting.route], audit A26); a caller that
    // reaches them here skipped that routing, and is told where they go.
    override suspend fun wake(nodeId: String) { relayOnly("Waking a sleeping session") }
    override suspend fun refresh(nodeId: String) { relayOnly("Refreshing a terminal view") }
    override suspend fun rename(nodeId: String, title: String) { relayOnly("Renaming a session") }
    override suspend fun ensureBoard(projectId: String): List<KanbanColumn>? = relayOnly("Editing the board")
    override suspend fun setCardColumn(projectId: String, nodeId: String, columnId: String?): Boolean = relayOnly("Editing the board")
    override suspend fun editCardLabels(projectId: String, nodeId: String, edit: CardLabelEdit): LabelEditResult? = relayOnly("Editing labels")
    override suspend fun registerNode(projectId: String, node: NewNode): Boolean = relayOnly("Starting a new session")
    override suspend fun git(verb: GitVerb, cwd: String, args: Map<String, JsonElement>): JsonElement? = relayOnly("Source control")

    private fun relayOnly(what: String): Nothing =
        throw HostException(LegRouting.sshRefusal(what))

    override suspend fun answerApproval(event: InboxEvent, allow: Boolean): ApprovalOutcome = withContext(Dispatchers.IO) {
        ensureListed()
        refuseRemoteNode(event.nodeId)
        val pendingId = event.pendingId ?: return@withContext ApprovalOutcome.UNSUPPORTED
        if (!SshScripts.PENDING_ID.matches(pendingId)) return@withContext ApprovalOutcome.UNSUPPORTED
        when (run(SshScripts.answerApproval(pendingId, allow)).second.trim()) {
            "sent" -> ApprovalOutcome.SENT
            "gone" -> ApprovalOutcome.GONE
            else -> throw HostException("Couldn't write the answer on the computer.")
        }
    }

    override suspend fun rememberApproval(event: InboxEvent, suggestionIndex: Int): ApprovalOutcome =
        answerHook(event, event.pendingId) { HookReplies.remember(it, suggestionIndex) }

    override suspend fun answerQuestions(event: InboxEvent, selections: List<List<Int>>): ApprovalOutcome =
        answerHook(event, event.questionPendingId) { HookReplies.answerQuestions(it, selections) }

    private suspend fun answerHook(event: InboxEvent, ticket: String?, build: (JsonObject) -> String?): ApprovalOutcome = withContext(Dispatchers.IO) {
        ensureListed()
        refuseRemoteNode(event.nodeId)
        if (ticket == null || !HookReplies.belongsToNode(event.nodeId, ticket)) return@withContext ApprovalOutcome.UNSUPPORTED
        val (code, out) = run(SshScripts.readHookRequest(event.nodeId, ticket))
        if (code != 0) throw HostException("Couldn't read the held question or approval.")
        if (out.trim() == "gone") return@withContext ApprovalOutcome.GONE
        val split = out.indexOf('\n')
        if (split < 0) throw HostException("The computer sent an invalid held request.")
        val checksum = out.substring(0, split)
        val raw = out.substring(split + 1)
        if (!Regex("^[0-9]+ [0-9]+$").matches(checksum) || raw.toByteArray(Charsets.UTF_8).size > HookReplies.MAX_BYTES)
            throw HostException("The held request exceeds the supported limit.")
        val request = J.obj(J.parse(raw)) ?: throw HostException("The computer sent an invalid held request.")
        val reply = build(request) ?: return@withContext ApprovalOutcome.UNSUPPORTED
        val (writeCode, result) = run(SshScripts.answerHook(event.nodeId, ticket, checksum), stdin = reply)
        if (writeCode != 0) throw HostException("Couldn't write the answer on the computer.")
        when (result.trim()) {
            "sent" -> ApprovalOutcome.SENT
            "gone" -> ApprovalOutcome.GONE
            else -> throw HostException("The computer did not confirm the answer.")
        }
    }

    /** The phone→host read-ack (src/core/ack-sweep.ts): `~/.nodeterm/acks/<nodeId>.seen`. */
    override suspend fun ackRead(nodeId: String, eventId: String?) {
        withContext(Dispatchers.IO) {
            runCatching {
                ensureListed()
                // A remote node's read-ack belongs on ITS host; writing it here would ack nothing.
                if (!remoteNodes.containsKey(nodeId)) run(SshScripts.ackRead(nodeId, eventId ?: ""))
            }
        }
    }

    override suspend fun sendKeys(nodeId: String, keys: String) {
        withContext(Dispatchers.IO) {
            ensureListed()
            refuseRemoteNode(nodeId)
            val creation = if (PhoneTerminals.validId(nodeId)) ownedPhoneCreation(nodeId) else null
            val (code, _) = run(SshScripts.sendKeys(nodeId, keys, socketFor(nodeId), creation))
            if (code != 0) throw HostException("Couldn't type into the session (tmux exited ${code ?: "without a status"}).")
        }
    }

    override suspend fun paneCommand(nodeId: String): String? = withContext(Dispatchers.IO) {
        try {
            ensureListed()
            // A remote node's pane is on ITS host; this computer's tmux has nothing to say about it.
            if (remoteNodes.containsKey(nodeId)) return@withContext null
            val creation = if (PhoneTerminals.validId(nodeId)) ownedPhoneCreation(nodeId) else null
            val (code, out) = run(SshScripts.paneCommand(nodeId, socketFor(nodeId), creation))
            out.trim().takeIf { code == 0 && it.isNotEmpty() && '\n' !in it }
        } catch (e: HostException) {
            null // the transport dropped; `run` has already reported it through onClosed
        } catch (e: IllegalArgumentException) {
            null // not a node id this app generates: no tmux target is ever built from it
        }
    }

    /** Kill the node's tmux session (the node stays on the canvas; the desktop shows it as ended). */
    suspend fun killSession(nodeId: String) = withContext(Dispatchers.IO) {
        ensureListed()
        refuseRemoteNode(nodeId)
        val creation = if (PhoneTerminals.validId(nodeId)) ownedPhoneCreation(nodeId) else null
        val (code, _) = run(SshScripts.killSession(nodeId, socketFor(nodeId), creation))
        if (code != 0) throw HostException("Couldn't end the session (tmux exited ${code ?: "without a status"}).")
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

        /** What the browse looked for and did not find; [NothingFoundException] adds what to do about it. */
        const val NOT_FOUND = "nodeterm's data wasn't found on this computer over SSH. The phone looked for the " +
            "desktop app's (~/Library/Application Support/node-terminal, ~/.config/node-terminal), the Server Edition's " +
            "(~/.nodeterm-server), and sessions a desktop runs here over SSH. A Server Edition started with --data-dir " +
            "or NODETERM_DATA_DIR somewhere else is not found this way."

        /** [NOT_FOUND] for a computer this phone can also reach through the relay. */
        const val NO_USER_DATA = "$NOT_FOUND Open nodeterm on the computer once, or connect through the relay."

        /** [NOT_FOUND] for a paired computer with no relay leg to offer (remote access isn't set up, or is off). */
        const val NO_USER_DATA_NO_RELAY = "$NOT_FOUND Open nodeterm on the computer once."

        /**
         * [NOT_FOUND] for a computer added by its SSH address (audit A27): no relay, ever, and the user
         * typed the login, so the wrong user is a likely cause; a dev host shows a driving desktop's
         * sessions only once that desktop runs one there.
         */
        const val NO_USER_DATA_ADDED_OVER_SSH = "$NOT_FOUND Check that the computer was added as the user nodeterm " +
            "runs as there. If nodeterm on another computer runs sessions here over SSH, they show once one is running."

        /** A driven project's session that is not running (audit A27): only its own desktop starts it. */
        const val DRIVEN_NOT_RUNNING = "This session isn't running on this computer. It belongs to nodeterm on another " +
            "computer, which runs it here over SSH: open it there to start it again."

        /** A session that is not running, of a node the computer's listing does not name (review of A27a). */
        const val NOT_RUNNING_UNLISTED = "This session isn't running on this computer, and nodeterm on this computer " +
            "doesn't list it, so the phone has nothing to start it from. If nodeterm on another computer runs it here " +
            "over SSH, open it there."

        /**
         * Whether [e] is the server REFUSING this phone's key (or this user), as opposed to an
         * authentication that could not finish. sshj 0.39 reports both as a [UserAuthException]:
         * `SSHClient.auth` throws "Exhausted available authentication methods" whenever no method
         * succeeded, and its cause is what stopped the last one — `UserAuthImpl`'s promise chains an
         * auth timeout (`TimeoutException`) and a transport error delivered while it waited
         * (`TransportException`, a socket `IOException`) into a [UserAuthException]. A clean refusal
         * (the server answered `USERAUTH_FAILURE`) has nothing but [UserAuthException]s in its chain.
         * Telling a user whose VPN dropped mid-login that the computer refused the key sends them to
         * add the key again instead of checking the network.
         */
        internal fun isAuthRefusal(e: Throwable): Boolean = e is UserAuthException && authFailureCause(e) == null

        /** The first cause behind [e]'s [UserAuthException]s that is not one (a timeout, a dropped transport), if any. */
        internal fun authFailureCause(e: Throwable): Throwable? {
            var c: Throwable? = e
            var depth = 0
            while (c is UserAuthException && depth++ < MAX_CAUSE_DEPTH) c = c.cause
            return c?.takeIf { it !is UserAuthException }
        }

        private const val MAX_CAUSE_DEPTH = 16

        /**
         * `SHA256:<unpadded base64>` of the key blob as sshj encodes it: for a certificate, the
         * certificate's own blob. What names a host key is [hostKeyFingerprint].
         */
        fun fingerprint(key: PublicKey): String {
            val blob = Buffer.PlainBuffer().putPublicKey(key).compactData
            val digest = MessageDigest.getInstance("SHA-256").digest(blob)
            return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)
        }

        /**
         * The fingerprint that names a presented host key, as OpenSSH prints it: for a host CERTIFICATE
         * (sshd's `HostCertificate`, which sshj negotiates whenever the server offers one), the key it
         * certifies, which is how OpenSSH fingerprints a certificate too; for a plain key, [fingerprint].
         * It is what the desktop reports (it reads the plain `.pub` files, at pairing and in every relay
         * report), so a certificate matches the pairing's keys and the relay's report by it, and it is
         * what is pinned (review of A74-refresh): pinning the certificate's own blob made the pin a key
         * the computer never reports, so every relay report seemed to say the key had changed, and a
         * certificate reissued for the same key (they are often short-lived) would have been a changed
         * key. The server proves it holds that key's private half in the key exchange either way.
         */
        fun hostKeyFingerprint(key: PublicKey): String =
            (key as? Certificate<*>)?.let { cert -> runCatching { fingerprint(cert.key) }.getOrNull() } ?: fingerprint(key)

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
            // The key this connection's server presented, held until authentication proves it is
            // the computer we paired with; only then does it become the pin (audit A49).
            var presented: String? = null
            // A pin an older build took from a host certificate's own blob, which this server's
            // certificate matched: re-spelled as the certified key once we are in (review of A74-refresh).
            var certPin: String? = null
            client.addHostKeyVerifier(object : HostKeyVerifier {
                override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
                    val fp = hostKeyFingerprint(key)
                    // One server per connection: a re-key must present the same key as the first
                    // exchange, pinned or not.
                    val expected = pin.pinned() ?: presented
                    return when {
                        expected == null -> {
                            // Not pinned yet: a key the pairing named, if it named any (A49-anchor).
                            // Refused here, during the key exchange, so a stranger never sees our key.
                            val anchors = pin.anchors()
                            if (anchors.isEmpty() || fp in anchors) {
                                presented = fp
                                true
                            } else {
                                mismatch = HostKeyNotPairedException(anchors, fp)
                                false
                            }
                        }
                        expected == fp -> {
                            presented = fp
                            true
                        }
                        key is Certificate<*> && expected == fingerprint(key) -> {
                            presented = fp
                            certPin = expected
                            true
                        }
                        else -> {
                            mismatch = HostKeyChangedException(expected, fp)
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
                // Keys and wheel events are small packets. Nagle otherwise holds later input
                // behind an unacknowledged packet, adding visible stalls over a mobile VPN.
                client.socket.tcpNoDelay = true
                val kp = identity.keyPair
                client.authPublickey(user, object : KeyProvider {
                    override fun getPrivate(): PrivateKey = kp.private
                    override fun getPublic(): PublicKey = kp.public
                    override fun getType(): KeyType = KeyType.ED25519
                })
                // Authenticated: this server accepted the key the pairing installed, so its host key
                // is the computer's. A server that refused us never got here and pinned nothing.
                val seen = presented
                val pinned = pin.pinned()
                if (seen != null && (pinned == null || (pinned == certPin && pinned != seen))) pin.pin(seen)
                client.connection.keepAlive.keepAliveInterval = KEEPALIVE_INTERVAL_SEC
                (client.connection.keepAlive as? KeepAliveRunner)?.maxAliveCount = KEEPALIVE_MAX_MISSED
            } catch (e: Exception) {
                runCatching { client.disconnect() }
                if (client.isConnected) runCatching { client.socket?.close() }
                mismatch?.let { throw it }
                if (isAuthRefusal(e)) {
                    throw SshAuthRefusedException(
                        "Couldn't connect over SSH to $user@$host:$port: it did not accept this phone's key " +
                            "(${e.message ?: e.javaClass.simpleName})."
                    )
                }
                // An authentication that could not FINISH is a connection failure: say what stopped it
                // (the timeout, the dropped transport), not sshj's "Exhausted available authentication
                // methods" wrapped around it.
                val why = authFailureCause(e) ?: e
                throw HostException("Couldn't connect over SSH to $user@$host:$port (${why.message ?: why.javaClass.simpleName}).")
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
