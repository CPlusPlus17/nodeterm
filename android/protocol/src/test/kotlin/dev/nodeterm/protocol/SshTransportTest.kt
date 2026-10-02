package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ApprovalOutcome
import dev.nodeterm.protocol.host.Capability
import dev.nodeterm.protocol.host.CardLabelEdit
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.host.NewNode
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.ResumeOffer
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.NewSessionChoice
import dev.nodeterm.protocol.model.Pane
import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.ssh.HostBrowse
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.HostKeyNotPairedException
import dev.nodeterm.protocol.ssh.HostKeyPin
import dev.nodeterm.protocol.ssh.NothingFoundException
import dev.nodeterm.protocol.ssh.SshHostConnection
import dev.nodeterm.protocol.ssh.SshScripts
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.apache.sshd.server.Environment
import org.apache.sshd.server.ExitCallback
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.channel.ChannelSession
import org.apache.sshd.server.command.Command
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assumptions.assumeTrue
import kotlin.test.assertIs
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.TestInstance
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The direct-SSH transport end to end: a real SSH server (Apache MINA) running every command
 * through a shell as the phone would get from sshd, against a fake HOME laid out like a desktop's
 * (a v3 workspace index + project files + agent-status.json) and a REAL tmux — on a private
 * `TMUX_TMPDIR`, so no test ever touches a tmux server a developer is using (issue #629's rule).
 *
 * An exec without a pty runs as `/bin/sh -c`. A pty-requesting exec runs under `script`, standing in
 * for sshd's pty allocation (MINA's process bridge has none of its own); that wrapper is harness, the
 * scripts it runs are the product's. Linux's util-linux `script` (which runs the command through
 * `$SHELL`) and macOS's BSD one take different arguments, and the macOS temp dir is too long for a
 * tmux socket: [PtyScript] and [ShortTmuxRoot] handle both (audit A62).
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SshTransportTest {
    private lateinit var root: File
    private lateinit var home: File
    private lateinit var tmuxDir: File
    private lateinit var server: SshServer
    private lateinit var ptyScript: PtyScript
    private val identity = SshIdentity.generate()
    private var port = 0
    /** Every public key the server was asked to accept, ours or not. */
    private val authAttempts = java.util.concurrent.atomic.AtomicInteger()

    private fun tmuxAvailable() = runCatching { ProcessBuilder("tmux", "-V").start().waitFor() == 0 }.getOrDefault(false)

    // No locale at all, like an sshd exec channel on a stock macOS host (audit A03): passing the JVM's
    // own LANG through is what hid that bug.
    // Nor any NODETERM_* of the developer's (the review of A27a): the browse reads NODETERM_DATA_DIR,
    // so an exported one pointed these tests at a real Server Edition's data dir.
    private fun childEnv(): Map<String, String> = System.getenv().filterKeys {
        it != "TMUX" && it != "TMUX_PANE" && it != "LANG" && it != "LANGUAGE" && !it.startsWith("LC_") &&
            !it.startsWith("NODETERM_")
    } +
        mapOf("HOME" to home.path, "TMUX_TMPDIR" to tmuxDir.path, "XDG_CONFIG_HOME" to File(home, ".config").path)

    private fun tmux(vararg args: String): Pair<Int, String> = tmuxOn("node-terminal", *args)

    /** tmux on [socket] — inside this class's private TMUX_TMPDIR, never a developer's server (#629). */
    private fun tmuxOn(socket: String, vararg args: String): Pair<Int, String> {
        val pb = ProcessBuilder(listOf("tmux", "-L", socket) + args).redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(childEnv())
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        return p.waitFor() to out
    }

    /** Called with each command the server is asked to run, before it runs (and before sshj hears back). */
    @Volatile private var onCommand: ((String, ShCommand) -> Unit)? = null

    private inner class ShCommand(private val command: String) : Command {
        private lateinit var input: InputStream
        private lateinit var output: OutputStream
        private lateinit var error: OutputStream
        private lateinit var exit: ExitCallback
        private var process: Process? = null
        /** Counted down once the command's process has exited (for a pty, `script` and what it ran). */
        val exited = java.util.concurrent.CountDownLatch(1)

        override fun setInputStream(`in`: InputStream) { input = `in` }
        override fun setOutputStream(out: OutputStream) { output = out }
        override fun setErrorStream(err: OutputStream) { error = err }
        override fun setExitCallback(callback: ExitCallback) { exit = callback }

        override fun start(channel: ChannelSession, env: Environment) {
            val cols = env.env["COLUMNS"] ?: "80"
            val lines = env.env["LINES"] ?: "24"
            val pty = env.env.containsKey("TERM")
            val argv = if (pty) ptyScript.argv("stty cols $cols rows $lines 2>/dev/null; $command")
            else listOf("/bin/sh", "-c", command)
            val pb = ProcessBuilder(argv).directory(home)
            pb.environment().clear()
            pb.environment().putAll(childEnv())
            val p = pb.start()
            process = p
            fun pump(from: InputStream, to: OutputStream, closeTo: Boolean) = Thread {
                runCatching {
                    val buf = ByteArray(8192)
                    while (true) {
                        val n = from.read(buf)
                        if (n < 0) break
                        to.write(buf, 0, n)
                        to.flush()
                    }
                }
                if (closeTo) runCatching { to.close() }
            }.apply { isDaemon = true; start() }
            val outPump = pump(p.inputStream, output, false)
            val errPump = pump(p.errorStream, error, false)
            // For a pty session, channel EOF must NOT become stdin EOF: `script` turns that into a ^D
            // typed into the pty (util-linux measured; FreeBSD's source does the same), which ends the
            // pane's shell — a harness artifact real sshd does not have (it closes the pty and the tmux
            // client just detaches).
            pump(input, p.outputStream, !pty)
            Thread {
                val code = p.waitFor()
                outPump.join(2000)
                errPump.join(2000)
                exited.countDown()
                exit.onExit(code)
            }.apply { isDaemon = true; start() }
        }

        override fun destroy(channel: ChannelSession) {
            process?.destroy()
        }
    }

    @BeforeAll
    fun setUp() {
        assumeTrue(tmuxAvailable(), "${PtyScript.SKIP_REASON}; no tmux on PATH")
        val script = PtyScript.detect()
        assumeTrue(script != null, "${PtyScript.SKIP_REASON}; `script` answered neither form")
        ptyScript = script!!
        // Short and resolved, so the tmux socket fits in sun_path on a Mac too (audit A62).
        root = ShortTmuxRoot.create("nt-ssh", "tmux", "node-terminal")
        home = File(root, "home").apply { mkdirs() }
        tmuxDir = File(root, "tmux").apply { mkdirs() }
        server = SshServer.setUpDefaultServer()
        server.host = "127.0.0.1"
        server.port = 0
        server.keyPairProvider = SimpleGeneratorHostKeyProvider(File(root, "hostkey.ser").toPath())
        val expected = identity.keyPair.public.encoded
        server.publickeyAuthenticator = org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator { user, key, _ ->
            authAttempts.incrementAndGet()
            user == "dev" && key.encoded.contentEquals(expected)
        }
        server.commandFactory = org.apache.sshd.server.command.CommandFactory { _, command ->
            ShCommand(command).also { onCommand?.invoke(command, it) }
        }
        server.start()
        port = server.port
        layOutDesktop()
    }

    @AfterAll
    fun tearDown() {
        if (!::server.isInitialized) return
        runCatching { tmux("kill-server") }
        runCatching { stopRmtServer() }
        server.stop(true)
        root.deleteRecursively()
    }

    private val repo get() = File(root, "repo")

    private fun layOutDesktop() {
        // The REAL directory name (audit A02): Electron's userData is package.json `name`.
        val ud = File(home, ".config/node-terminal").apply { mkdirs() }
        File(repo, ".nodeterm").mkdirs()
        File(repo, ".nodeterm/project.json").writeText(
            """{"version":1,"rev":3,"savedAt":"x","name":"file name ignored","color":"#000",
               "viewport":{"x":0,"y":0,"zoom":1},
               "nodes":[{"id":"term-a-1","kind":"terminal","title":"Claude","color":"#d97757","group":null,
                         "agentId":"claude","cwd":"./sub","position":{"x":0,"y":0},"size":{"width":1,"height":1}}],
               "kanban":{"columns":[{"id":"c1","title":"Doing","color":"#0a84ff"}],"assignments":[{"nodeId":"term-a-1","columnId":"c1"}]}}"""
        )
        File(ud, "inline-projects").mkdirs()
        File(ud, "inline-projects/p3.json").writeText(
            """{"version":1,"rev":2,"savedAt":"x","name":"n","color":"#000","viewport":{"x":0,"y":0,"zoom":1},
               "nodes":[{"id":"term-c-3","kind":"terminal","title":"From file","color":"#000","group":null,"position":{"x":0,"y":0},"size":{"width":1,"height":1}}]}"""
        )
        File(ud, "workspace.json").writeText(
            """{"version":3,"activeProjectId":"p1","entries":[
                 {"id":"p1","name":"Repo","color":"#0a84ff","cwd":"${repo.path}"},
                 {"id":"p2","name":"Server","color":"#ff9f0a","ssh":{"server":{"host":"box","user":"me"},"remoteCwd":"~"},
                  "cache":{"version":1,"rev":1,"savedAt":"x","name":"n","color":"#000","viewport":{"x":0,"y":0,"zoom":1},
                           "nodes":[{"id":"term-b-2","kind":"terminal","title":"Remote","color":"#000","group":null,"position":{"x":0,"y":0},"size":{"width":1,"height":1}}]}},
                 {"id":"p3","name":"Scratch","color":"#bf5af2","dataFile":true,
                  "project":{"id":"p3","name":"Scratch","color":"#bf5af2","viewport":{"x":0,"y":0,"zoom":1},
                             "nodes":[{"id":"term-c-3","kind":"terminal","title":"Stale cache","color":"#000","group":null,"position":{"x":0,"y":0},"size":{"width":1,"height":1}}]}},
                 {"id":"p4","name":"Parked","color":"#8e8e93","closed":true,"project":{"id":"p4","name":"Parked","color":"#8e8e93","viewport":{"x":0,"y":0,"zoom":1},"nodes":[]}}
               ]}"""
        )
        File(ud, "agent-status.json").writeText(
            """{"v":1,"updatedAt":1,"nodes":{"term-a-1":{"state":"working","agentId":"claude","updatedAt":5}},
               "inbox":{"events":[],"nodes":{}}}"""
        )
        File(ud, "tmux.conf").writeText("set -g status off\n")
        File(repo, "sub").mkdirs()
        val (code, out) = tmux("-f", File(ud, "tmux.conf").path, "new-session", "-d", "-s", "nt-term-a-1", "-c", File(repo, "sub").path)
        assertEquals(0, code, out)
    }

    private fun connect(pin: HostKeyPin = MemoryPin(), factory: javax.net.SocketFactory? = null) =
        SshHostConnection.connect("127.0.0.1", port, "dev", identity, pin, socketFactory = factory)

    /**
     * Android's StrictMode, reproduced on the JVM (which has no BlockGuard): a socket whose streams
     * throw a RuntimeException — like `NetworkOnMainThreadException` — when used from a thread marked
     * as "main". The JVM tests could not see audit A01/A04 without this.
     */
    private class MainThreadGuard : javax.net.SocketFactory() {
        val main = ThreadLocal.withInitial { false }
        val sockets = java.util.Collections.synchronizedList(ArrayList<java.net.Socket>())
        val violations = java.util.concurrent.atomic.AtomicInteger()
        @Volatile var poisonAll = false

        private fun check() {
            if (poisonAll) throw IllegalStateException("simulated failure after the cipher advanced")
            if (main.get()) {
                violations.incrementAndGet()
                throw IllegalStateException("NetworkOnMainThreadException (simulated)")
            }
        }

        private fun guarded(): java.net.Socket = object : java.net.Socket() {
            override fun getOutputStream(): OutputStream {
                val real = super.getOutputStream()
                return object : OutputStream() {
                    override fun write(b: Int) { check(); real.write(b) }
                    override fun write(b: ByteArray, off: Int, len: Int) { check(); real.write(b, off, len) }
                    override fun flush() { check(); real.flush() }
                    override fun close() = real.close()
                }
            }
        }.also { sockets.add(it) }

        override fun createSocket(): java.net.Socket = guarded()
        override fun createSocket(host: String, port: Int) = guarded().apply { connect(java.net.InetSocketAddress(host, port)) }
        override fun createSocket(host: String, port: Int, l: java.net.InetAddress, lp: Int) = createSocket(host, port)
        override fun createSocket(host: java.net.InetAddress, port: Int) = guarded().apply { connect(java.net.InetSocketAddress(host, port)) }
        override fun createSocket(a: java.net.InetAddress, p: Int, l: java.net.InetAddress, lp: Int) = createSocket(a, p)

        fun <T> onMain(block: () -> T): T {
            main.set(true)
            try { return block() } finally { main.set(false) }
        }
    }

    /**
     * What a screen shows for [e] when the phone has no relay leg to open (A27): no relay offered, and
     * the reason that is actually in the way for that leg (the review of A27b).
     */
    private fun assertNoRelayPromised(e: NeedsRelayException) {
        assertTrue(e.withoutRelay.contains("Remote access isn't set up for this computer"), e.withoutRelay)
        assertNull(e.refusal(LegRouting.RelayLeg.AVAILABLE), "a usable relay leg is offered, not refused")
        for (leg in LegRouting.RelayLeg.entries - LegRouting.RelayLeg.AVAILABLE) {
            val said = assertNotNull(e.refusal(leg), "$leg")
            assertTrue(said.startsWith(e.fact), "$leg: $said")
            assertFalse(said.contains("opens through the relay"), "$leg: $said")
        }
        assertEquals(e.withoutRelay, e.refusal(LegRouting.RelayLeg.ADDED_OVER_SSH))
        // A paired computer set to "Only on my network" HAS remote access: the refusal names the route
        // setting in the way, never "isn't set up" (what InboxTab and SessionsTab used to say).
        val sshOnly = e.refusal(LegRouting.RelayLeg.ROUTE_SSH_ONLY)!!
        assertTrue(sshOnly.contains("\"Only on my network (SSH)\"") && sshOnly.contains("How to reach each computer"), sshOnly)
        assertFalse(sshOnly.contains("isn't set up"), sshOnly)
        for (leg in listOf(LegRouting.RelayLeg.NOT_PICKED_UP, LegRouting.RelayLeg.REMOTE_ACCESS_OFF)) {
            assertFalse(e.refusal(leg)!!.contains("isn't set up"), "$leg: ${e.refusal(leg)}")
        }
    }

    private class MemoryPin(var value: String? = null, private val paired: List<String> = emptyList()) : HostKeyPin {
        override fun pinned() = value
        override fun pin(fingerprint: String) {
            value = fingerprint
        }
        override fun anchors() = paired
    }

    private class Sink : TerminalSink {
        val out = ByteArrayOutputStream()
        override fun onPaint(text: String) {}
        override fun onOutput(bytes: ByteArray) {
            synchronized(out) { out.write(bytes) }
        }
        override fun onExit(code: Int?) {}
        fun waitFor(needle: String, ms: Long = 8_000) {
            val end = System.currentTimeMillis() + ms
            while (!synchronized(out) { out.toString(Charsets.UTF_8) }.contains(needle)) {
                if (System.currentTimeMillis() > end) throw AssertionError("'$needle' never appeared: ${synchronized(out) { out.toString(Charsets.UTF_8) }.takeLast(400)}")
                Thread.sleep(50)
            }
        }
    }

    @Test
    fun `browse resolves the v3 index the way the desktop assembles it`() = runBlocking<Unit> {
        connect().use { conn ->
            val snap = conn.listProjects()
            assertEquals(listOf("Repo", "Server", "Scratch", "Parked"), snap.projects.map { it.name }, "names come from the ENTRY")
            val repoProject = snap.projects[0]
            val node = repoProject.nodes.single()
            assertEquals("term-a-1", node.id)
            assertEquals(repo.path + "/sub", node.cwd, "portable ./ cwds resolve against the folder")
            assertEquals("c1", repoProject.board!!.columnOf("term-a-1"))
            assertEquals("me@box", snap.projects[1].sshTarget)
            assertEquals(listOf("term-b-2"), snap.projects[1].nodes.map { it.id }, "an ssh ref reads its offline cache")
            assertEquals(listOf("From file"), snap.projects[2].nodes.map { it.title }, "the data file wins over the cache")
            assertTrue(snap.projects[3].closed)
            assertTrue(snap.isLive("term-a-1"))
            assertFalse(snap.isLive("term-b-2"))
            assertEquals(AgentState.WORKING, snap.statusOf("term-a-1")!!.state)
        }
    }

    @Test
    fun `attach joins the live tmux session and carries keystrokes both ways`() = runBlocking<Unit> {
        connect().use { conn ->
            conn.listProjects()
            val sink = Sink()
            val stream = conn.attach("term-a-1", 100, 30, sink)
            assertFalse(stream.fresh)
            Thread.sleep(400)
            stream.write("echo nt_\$((6*7))\r")
            sink.waitFor("nt_42")
            stream.detach()
            Thread.sleep(300)
            val (code, out) = tmux("has-session", "-t", "=nt-term-a-1")
            assertEquals(0, code, "detaching never ends the session: $out / ${tmux("ls").second}")
        }
    }

    @Test
    fun `an attach cancelled while it opens leaves no tmux client behind`() = runBlocking<Unit> {
        // A40 review: the blocking open finishes even when its caller is cancelled meanwhile, and
        // withContext then drops the stream. Nothing held it, so its tmux client stayed attached for
        // the life of the connection. The cancel lands exactly while the server starts the attach.
        connect().use { conn ->
            conn.listProjects()
            val attaching = AtomicReference<Job>()
            val attachCommand = AtomicReference<ShCommand>()
            onCommand = { command, cmd ->
                if (command.contains("attach-session")) {
                    attachCommand.set(cmd)
                    attaching.get().cancel()
                }
            }
            try {
                val job = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { conn.attach("term-a-1", 100, 30, Sink()) }
                attaching.set(job)
                job.start()
                job.join()
                assertTrue(job.isCancelled)
                val cmd = assertNotNull(attachCommand.get(), "the attach reached the server")
                assertTrue(cmd.exited.await(10, TimeUnit.SECONDS), "the stream nobody holds was closed")
                val deadline = System.currentTimeMillis() + 5_000
                while (tmux("list-clients", "-t", "=nt-term-a-1").second.isNotBlank()) {
                    if (System.currentTimeMillis() > deadline) throw AssertionError("a tmux client is still attached: ${tmux("list-clients").second}")
                    Thread.sleep(100)
                }
            } finally {
                onCommand = null
            }
            assertEquals(0, tmux("has-session", "-t", "=nt-term-a-1").first, "letting go never ends the session")
        }
    }

    @Test
    fun `resizes and key chips from the main thread never touch the socket there, and keep order`() = runBlocking<Unit> {
        // A01/A04: before the fix the resize threw on the "main" thread after sshj had advanced its
        // cipher state, and the next packet dropped the connection.
        val guard = MainThreadGuard()
        val conn = connect(factory = guard)
        var closedReason: String? = null
        conn.setOnClosed { closedReason = it ?: "closed" }
        try {
            conn.listProjects()
            val sink = Sink()
            val stream = conn.attach("term-a-1", 100, 30, sink)
            Thread.sleep(400)
            guard.onMain {
                stream.resize(90, 28)
                stream.write("echo ma")
                stream.write("in_\$((5*5))\r")
                stream.resize(100, 30)
            }
            sink.waitFor("main_25")
            // The connection is still usable for other work (listing, the Inbox) afterwards.
            conn.listProjects()
            assertEquals(0, guard.violations.get(), "no socket I/O ran on the main thread")
            assertEquals(null, closedReason)
            stream.detach()
        } finally {
            guard.onMain { conn.close() }
        }
        // close() from the main thread still really closes the socket (it used to leak).
        val end = System.currentTimeMillis() + 5_000
        while (guard.sockets.any { !it.isClosed } && System.currentTimeMillis() < end) Thread.sleep(50)
        assertTrue(guard.sockets.all { it.isClosed }, "close() from the main thread leaked the socket")
        assertEquals(0, guard.violations.get())
    }

    @Test
    fun `a write failure that corrupts the transport closes the connection instead of hiding it`() = runBlocking<Unit> {
        val guard = MainThreadGuard()
        val conn = connect(factory = guard)
        val closed = java.util.concurrent.CountDownLatch(1)
        conn.setOnClosed { closed.countDown() }
        try {
            conn.listProjects()
            val stream = conn.attach("term-a-1", 100, 30, Sink())
            Thread.sleep(300)
            // Every socket write now fails with a RuntimeException, on whatever thread it runs —
            // including the stream's own writer: the transport must be torn down, not ignored.
            guard.poisonAll = true
            stream.write("x")
            assertTrue(closed.await(10, TimeUnit.SECONDS), "the broken transport was reported through onClosed")
            // sshj's own disconnect listener may report first; the socket close lands right after.
            val end = System.currentTimeMillis() + 5_000
            while (conn.isConnected && System.currentTimeMillis() < end) Thread.sleep(20)
            assertFalse(conn.isConnected)
        } finally {
            guard.poisonAll = false
            conn.close()
        }
    }

    @Test
    fun `non-ASCII survives the attach even when the host sets no locale`() = runBlocking<Unit> {
        connect().use { conn ->
            val sink = Sink()
            val stream = conn.attach("term-a-1", 100, 30, sink)
            Thread.sleep(400)
            // ╭ (no ACS mapping) and é, built from octal escapes so the INPUT is pure ASCII.
            stream.write("printf 'u8:\\342\\225\\255\\303\\251:end\\n'\r")
            sink.waitFor("u8:╭é:end")
            stream.detach()
        }
    }

    @Test
    fun `a command that never answers drops the connection instead of hanging`() = runBlocking<Unit> {
        // A31: the read had no deadline, so a peer that vanished mid-command blocked it for as long
        // as TCP took to give up. A hung command stands in for the vanished peer here.
        val conn = connect()
        val closed = java.util.concurrent.CountDownLatch(1)
        conn.setOnClosed { closed.countDown() }
        val t0 = System.currentTimeMillis()
        assertFailsWith<HostException> { conn.run("sleep 30", timeoutSec = 1) }
        assertTrue(System.currentTimeMillis() - t0 < 10_000, "the deadline bounded the call")
        assertTrue(closed.await(5, TimeUnit.SECONDS), "the drop was reported, so the owner can fall back")
        conn.close()
    }

    @Test
    fun `a session that is not running is never created over SSH`() = runBlocking<Unit> {
        // A08: `new-session -A` over SSH created the desktop's session with no hook env. Now the
        // phone is told to use the relay, and nothing appears on the computer's tmux. term-c-3 is a
        // node of the computer's own index (the Scratch project) whose session is not running.
        connect().use { conn ->
            conn.listProjects()
            val e = assertFailsWith<NeedsRelayException> { conn.attach("term-c-3", 80, 24, Sink()) }
            assertEquals("term-c-3", e.nodeId)
            // With no relay leg to offer (remote access off, or a computer added by its SSH address,
            // A27), the refusal promises no relay and says remote access isn't set up.
            assertNoRelayPromised(e)
            Thread.sleep(300)
            assertEquals(1, tmux("has-session", "-t", "=nt-term-c-3").first, "no session was created")
        }
    }

    @Test
    fun `a node no listing names is not offered this computer's relay when its session is not running`() = runBlocking<Unit> {
        // The review of A27a: the relay's pty.attach creates what it does not find, so for a node the
        // computer's own index does not have (a deleted node, a driven project no longer listed) it
        // would make a bare nt-<id> of no project on node-terminal. Only the computer's own nodes get
        // the relay; this one is told why it cannot be started from here.
        connect().use { conn ->
            val e = assertFailsWith<HostException> { conn.attach("term-z-9", 80, 24, Sink()) }
            assertFalse(e is NeedsRelayException, "no relay offered for a node nobody lists")
            assertEquals(SshHostConnection.NOT_RUNNING_UNLISTED, e.message)
            Thread.sleep(300)
            assertEquals(1, tmux("has-session", "-t", "=nt-term-z-9").first, "no session was created")
        }
    }

    @Test
    fun `a fresh connection settles which nodes are whose before it refuses, with no listing first`() = runBlocking<Unit> {
        // The review of A27a: what a node is (the desktop's SSH project's, a driven one, the computer's
        // own) came only from a listing on the SAME connection, and a redial or a terminal restored
        // after the process died attaches at once. Each call below is the first on its connection.
        connect().use { conn ->
            // A09 with no listing: still the desktop's SSH project's node, not this computer's tmux.
            val e = assertFailsWith<NeedsRelayException> { conn.attach("term-b-2", 80, 24, Sink()) }
            assertTrue(e.message!!.contains("me@box"), e.message)
            assertEquals(1, tmux("has-session", "-t", "=nt-term-b-2").first, "no phantom session")
        }
        connect().use { conn ->
            val ev = InboxEvent("e2", 1, "term-b-2", "claude", null, InboxKind.APPROVAL, "Approve", null, false, false, emptyList(), false, "term-b-2-1-1")
            assertFailsWith<NeedsRelayException> { conn.answerApproval(ev, allow = true) }
        }
        connect().use { conn ->
            conn.ackRead("term-b-2", "e2")
            assertFalse(File(home, ".nodeterm/acks/term-b-2.seen").exists(), "no ack written on the wrong machine")
        }
        connect().use { conn ->
            // The computer's own node that is not running: the relay, as with a listing.
            assertFailsWith<NeedsRelayException> { conn.attach("term-c-3", 80, 24, Sink()) }
        }
    }

    @Test
    fun `a Sleeping session opened over SSH offers its wake line, which a tap types at the pane's own prompt (A76)`() = runBlocking<Unit> {
        // Eco exited the CLI: term-a-1's pane is a shell again, still in the node's folder, and the
        // mirror says Sleeping. Nothing tells the desktop about an SSH attach, so the phone offers it.
        val status = File(home, ".config/node-terminal/agent-status.json")
        val before = status.readText()
        // A stand-in CLI that reports where it ran and with what.
        val bin = File(root, "fake-bin").apply { mkdirs() }
        File(bin, "claude").apply {
            writeText("#!/bin/sh\necho \"woke:\$(pwd -P):\$*\"\n")
            setExecutable(true)
        }
        status.writeText(
            """{"v":1,"updatedAt":1,"nodes":{"term-a-1":{"agentId":"claude","sessionId":"sid-7","hibernated":true,"updatedAt":5}},
               "settings":{"claudePermissionMode":"plan","claudeAccounts":[]},"inbox":{"events":[],"nodes":{}}}"""
        )
        try {
            connect().use { conn ->
                val snap = conn.listProjects()
                val stream = conn.attach("term-a-1", 100, 30, Sink())
                assertTrue(ResumeOffer.wantsPane(stream.fresh, conn.kind, snap, "term-a-1"))
                val owner = conn.paneCommand("term-a-1")
                assertTrue(Pane.isShell(owner), "Eco's shell owns the pane: $owner")
                val offer = assertNotNull(ResumeOffer.afterAttach(stream.fresh, conn.kind, snap, "term-a-1", paneCommand = owner))
                assertEquals(ResumeOffer.Kind.WAKE, offer.kind)
                assertEquals("claude --resume sid-7 --permission-mode plan", offer.command, "no cd: the pane is already there")
                Thread.sleep(400)
                stream.write("PATH='${bin.path}':\$PATH; export PATH\r")
                // A line someone left half-typed at the Sleeping prompt: the wake clears it first,
                // or the shell would run `echo half_typedclaude …` and the CLI would never start.
                stream.write("echo half_typed")
                stream.write(offer.keys)
                val want = "woke:${File(repo, "sub").canonicalPath}:--resume sid-7 --permission-mode plan"
                val end = System.currentTimeMillis() + 8_000
                var pane = ""
                while (System.currentTimeMillis() < end) {
                    pane = tmux("capture-pane", "-p", "-J", "-t", "=nt-term-a-1:").second
                    if (pane.contains(want)) break
                    Thread.sleep(100)
                }
                assertTrue(pane.contains(want), pane)
                stream.detach()
            }
        } finally {
            status.writeText(before)
        }
    }

    /**
     * The A76 review: the mirror's `hibernated` flag outlives a CLI resumed outside the desktop's own
     * wake (here the desktop app is not running at all, so nothing hears the resumed CLI). The phone
     * wakes a Sleeping codex session, codex keeps running, and the node still reads Sleeping; the next
     * open must not offer `codex resume` into it, where it would be sent as a prompt.
     */
    @Test
    fun `a codex session the phone woke is not offered the wake again while it runs, though the flag stays`() = runBlocking<Unit> {
        val status = File(home, ".config/node-terminal/agent-status.json")
        val before = status.readText()
        // term-a-1 runs codex for this test.
        val project = File(repo, ".nodeterm/project.json")
        val projectBefore = project.readText()
        project.writeText(projectBefore.replace("\"agentId\":\"claude\"", "\"agentId\":\"codex\""))
        // A stand-in codex that stays in the foreground, like the real TUI (its argv[0] is not a shell).
        val bin = File(root, "fake-codex").apply { mkdirs() }
        File(bin, "codex").apply {
            writeText("#!/bin/sh\necho \"codex-up:\$*\"\nexec sleep 60\n")
            setExecutable(true)
        }
        status.writeText(
            """{"v":1,"updatedAt":1,"nodes":{"term-a-1":{"state":"done","agentId":"codex","sessionId":"t-9","hibernated":true,"updatedAt":5}},
               "inbox":{"events":[],"nodes":{}}}"""
        )
        fun paneOwner(): String = tmux("display-message", "-p", "-t", "=nt-term-a-1:", "#{pane_current_command}").second.trim()
        try {
            connect().use { conn ->
                val snap = conn.listProjects()
                assertEquals(true, snap.statusOf("term-a-1")?.hibernated)
                val first = conn.attach("term-a-1", 100, 30, Sink())
                val wake = assertNotNull(
                    ResumeOffer.afterAttach(first.fresh, conn.kind, snap, "term-a-1", paneCommand = conn.paneCommand("term-a-1"))
                )
                assertEquals("codex resume t-9", wake.command)
                Thread.sleep(400)
                first.write("PATH='${bin.path}':\$PATH; export PATH\r")
                first.write(wake.keys)
                val end = System.currentTimeMillis() + 8_000
                while (paneOwner() != "sleep" && System.currentTimeMillis() < end) Thread.sleep(100)
                assertEquals("sleep", paneOwner(), "the stand-in codex holds the pane")
                first.detach()

                // Nothing cleared the flag: the listing still says Sleeping. The next open reads the pane.
                val again = conn.listProjects()
                assertEquals(true, again.statusOf("term-a-1")?.hibernated, "the flag outlived the sleep")
                val second = conn.attach("term-a-1", 100, 30, Sink())
                assertTrue(ResumeOffer.wantsPane(second.fresh, conn.kind, again, "term-a-1"))
                val pane = conn.paneCommand("term-a-1")
                assertEquals("sleep", pane)
                assertNull(ResumeOffer.afterAttach(second.fresh, conn.kind, again, "term-a-1", paneCommand = pane), "no wake over a running CLI")
                // An offer still on screen from before is withdrawn at the tap by the same read.
                assertFalse(wake.stillOffered(again, "term-a-1", pane))
                second.detach()
            }
        } finally {
            status.writeText(before)
            project.writeText(projectBefore)
            // Hand the shared session back to its shell for the other tests.
            tmux("send-keys", "-t", "=nt-term-a-1:", "C-c")
            val end = System.currentTimeMillis() + 5_000
            while (!Pane.isShell(paneOwner()) && System.currentTimeMillis() < end) Thread.sleep(100)
        }
    }

    @Test
    fun `a pane that cannot be read is unknown, never a shell`() = runBlocking<Unit> {
        connect().use { conn ->
            // No such session, a node of the desktop's SSH projects (its pane is on another host), an id
            // no tmux target can be built from, and shell text (it becomes a session name that does not
            // exist): all null, none of them a shell.
            assertNull(conn.paneCommand("term-z-9"))
            conn.rememberRemoteNodes(conn.listProjects())
            assertNull(conn.paneCommand("term-b-2"))
            assertNull(conn.paneCommand(""))
            assertNull(conn.paneCommand("x; rm -rf ~"))
        }
    }

    @Test
    fun `the attach script itself refuses to create a missing session, on either socket`() {
        // Belt and braces for the race where the session ends between the check and the attach. On
        // nodeterm-rmt too (A27): a session a driving desktop makes there gets its remote tmux.conf
        // and hook env, which an attach from the phone would not. A live server on each socket, so
        // "missing" is a missing SESSION, not a socket nobody listens on.
        try {
            assertEquals(0, tmuxOn("nodeterm-rmt", "-f", "/dev/null", "new-session", "-d", "-s", "nt-keep-rmt").first)
            for (socket in listOf("node-terminal", "nodeterm-rmt")) {
                val (code, _) = run {
                    val pb = ProcessBuilder(ptyScript.argv(SshScripts.attach("term-y-8", socket))).directory(home)
                    pb.environment().clear()
                    pb.environment().putAll(childEnv())
                    val p = pb.start()
                    p.outputStream.close()
                    p.waitFor(10, TimeUnit.SECONDS)
                    p.exitValue() to p.inputStream.bufferedReader().readText()
                }
                assertEquals(SshScripts.NO_SESSION_EXIT, code, socket)
                assertEquals(1, tmuxOn(socket, "has-session", "-t", "=nt-term-y-8").first, socket)
            }
        } finally {
            stopRmtServer()
        }
    }

    @Test
    fun `nodes of the desktop's SSH projects are never reached on the desktop's own tmux`() = runBlocking<Unit> {
        // A09: term-b-2 belongs to the ssh project "Server" (me@box). Its session, approvals and acks
        // live on that host; over direct SSH the phone refuses instead of acting on the wrong machine.
        connect().use { conn ->
            conn.listProjects()
            val e = assertFailsWith<NeedsRelayException> { conn.attach("term-b-2", 80, 24, Sink()) }
            assertTrue(e.message!!.contains("me@box"), e.message)
            assertTrue(e.withoutRelay.contains("me@box"), e.withoutRelay)
            assertNoRelayPromised(e)
            assertFailsWith<NeedsRelayException> { conn.sendKeys("term-b-2", "1") }
            val ev = InboxEvent("e2", 1, "term-b-2", "claude", null, InboxKind.APPROVAL, "Approve", null, false, false, emptyList(), false, "term-b-2-1-1")
            assertFailsWith<NeedsRelayException> { conn.answerApproval(ev, allow = true) }
            conn.ackRead("term-b-2", "e2")
            assertFalse(File(home, ".nodeterm/acks/term-b-2.seen").exists(), "no ack written on the wrong machine")
            assertEquals(1, tmux("has-session", "-t", "=nt-term-b-2").first, "no phantom session")
        }
    }

    @Test
    fun `on the LAN the app's own verbs route to the relay leg, and SSH says where they go`() = runBlocking<Unit> {
        // A26: Auto keeps the SSH leg when it works, and board writes, a new session and node
        // actions need nodeterm the app. They go to the relay leg opened next to it — and a caller
        // that reaches the SSH transport anyway is not told to turn on remote access (it may be on).
        connect().use { conn ->
            for (cap in listOf(Capability.BOARD_WRITES, Capability.REGISTER_NODE, Capability.NODE_ACTIONS, Capability.GIT)) {
                assertEquals(LegRouting.Leg.Relay, LegRouting.route(cap, conn.kind, conn.capabilities, LegRouting.RelayLeg.AVAILABLE), "$cap")
            }
            // What SSH does itself stays on SSH.
            assertEquals(
                LegRouting.Leg.Primary,
                LegRouting.route(Capability.ANSWER_APPROVALS, conn.kind, conn.capabilities, LegRouting.RelayLeg.AVAILABLE)
            )
            val refusals = listOf<suspend () -> Unit>(
                { conn.registerNode("p1", NewNode("term-n-1", "x", null, null)) },
                { conn.ensureBoard("p1") },
                { conn.setCardColumn("p1", "term-a-1", null) },
                { conn.editCardLabels("p1", "term-a-1", CardLabelEdit()) },
                { conn.wake("term-a-1") },
                { conn.rename("term-a-1", "x") }
            )
            for (call in refusals) {
                val e = assertFailsWith<HostException> { call() }
                assertFalse(e.message!!.contains("turn on remote access"), e.message)
                assertTrue(e.message!!.contains("through the relay"), e.message)
            }
        }
    }

    /**
     * The review of A26: a relay token the phone holds outlives the computer's remote-access toggle.
     * Each listing says whether the computer advertises its relay right now (`~/.nodeterm/relay.json`,
     * written while the desktop's phone host is registered and removed when it stops), and with it
     * off the app's verbs are unavailable with that reason instead of a tap that waits out the relay.
     */
    @Test
    fun `each listing says whether the computer advertises its relay, and off takes the stored leg away`() = runBlocking<Unit> {
        val ad = File(dotNodeterm, "relay.json")
        try {
            relayAdvertisementRoundTrip(ad)
        } finally {
            ad.delete()
        }
    }

    private suspend fun relayAdvertisementRoundTrip(ad: File) {
        connect().use { conn ->
            assertNull(conn.relayAdvertised, "unknown before the first listing")
            conn.listProjects()
            assertEquals(false, conn.relayAdvertised, "no relay.json: remote access is off")
            val off = LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = false, relayAdvertised = conn.relayAdvertised)
            assertEquals(LegRouting.RelayLeg.REMOTE_ACCESS_OFF, off)
            for (cap in listOf(Capability.BOARD_WRITES, Capability.REGISTER_NODE, Capability.NODE_ACTIONS, Capability.GIT)) {
                val leg = assertIs<LegRouting.Leg.Unavailable>(LegRouting.route(cap, conn.kind, conn.capabilities, off), "$cap")
                assertTrue(leg.reason.contains("remote access is off on the computer"), leg.reason)
            }

            // Remote access turned on while the phone watches: the same connection's next listing sees it.
            dotNodeterm.mkdirs()
            ad.writeText("""{"v":1,"hostId":"h","hostPublicKeyB64":"k","relayEndpoint":"wss://relay.nodeterm.dev","hostDeviceId":"d"}""" + "\n")
            conn.listProjects()
            assertEquals(true, conn.relayAdvertised)
            assertEquals(LegRouting.RelayLeg.AVAILABLE, LegRouting.relayLeg(true, false, relayAdvertised = conn.relayAdvertised))
            // A phone without a token adopts it now, on the poll, without a new connection.
            assertTrue(LegRouting.adoptAfterListing(LegRouting.RelayLeg.NOT_PICKED_UP, false, conn.relayAdvertised, userAsked = false))

            // An empty file is no advertisement; a removed one is off again.
            ad.writeText("")
            conn.listProjects()
            assertEquals(false, conn.relayAdvertised)
            ad.delete()
            conn.listProjects()
            assertEquals(false, conn.relayAdvertised)
        }
    }

    @Test
    fun `send keys types literally, even text that starts with a dash`() = runBlocking<Unit> {
        connect().use { conn ->
            conn.sendKeys("term-a-1", "-R; echo sk_\$((2+3))")
            conn.sendKeys("term-a-1", "\r")
            val end = System.currentTimeMillis() + 5_000
            var pane = ""
            while (System.currentTimeMillis() < end) {
                pane = tmux("capture-pane", "-p", "-t", "=nt-term-a-1:").second
                if (pane.contains("sk_5")) break
                Thread.sleep(100)
            }
            assertTrue(pane.contains("sk_5"), pane)
        }
    }

    @Test
    fun `a held approval is answered through its answer file, exactly once`() = runBlocking<Unit> {
        val pending = File(home, ".nodeterm/pending").apply { mkdirs() }
        val id = "term-a-1-1700000000000-99"
        File(pending, "$id.json").writeText("{}")
        val event = InboxEvent("e1", 1, "term-a-1", "claude", null, InboxKind.APPROVAL, "Approve", null, false, false, emptyList(), false, id)
        connect().use { conn ->
            assertEquals(ApprovalOutcome.SENT, conn.answerApproval(event, allow = false))
            assertEquals("deny", File(pending, "$id.answer").readText())
            File(pending, "$id.json").delete()
            assertEquals(ApprovalOutcome.GONE, conn.answerApproval(event, allow = true))
            conn.ackRead("term-a-1", "e1")
            assertEquals("e1", File(home, ".nodeterm/acks/term-a-1.seen").readText())
        }
    }

    // ---- Audit A27: a computer a desktop drives over SSH, and the Server Edition ----------------------

    private val remoteRepo get() = File(root, "remote-repo")
    private val dotNodeterm get() = File(home, ".nodeterm")

    /**
     * What a desktop that drives this computer over SSH leaves here, written in the shapes its own
     * code writes them (hand-copied, like the rest of this class's layout — docs/android.md "Interop
     * tests"): an SSH project's canvas in `<remoteCwd>/.nodeterm/project.json` with the desktop's
     * project id as `id` (`projectToFile(p, …, p.id)`), the per-project status slices
     * `~/.nodeterm/agent-status-<projectId>.json` (`filterMirrorForNodes` + the host's settings block,
     * remote-status-push.ts) — one fresh, one a connected desktop's with no project file, one stale —
     * and sessions on the `nodeterm-rmt` socket started in the node's folder (`new-session -c`).
     */
    private fun layOutDrivenHost(now: Long) {
        File(remoteRepo, ".nodeterm").mkdirs()
        File(remoteRepo, "sub").mkdirs()
        File(remoteRepo, ".nodeterm/project.json").writeText(
            """{"version":1,"rev":4,"savedAt":"x","id":"project-drv","name":"Remote repo","color":"#30d158",
               "viewport":{"x":0,"y":0,"zoom":1},
               "nodes":[{"id":"term-r-1","kind":"terminal","title":"Claude here","color":"#d97757","group":null,
                         "agentId":"claude","cwd":"${File(remoteRepo, "sub").path}","position":{"x":0,"y":0},"size":{"width":1,"height":1}},
                        {"id":"term-r-2","kind":"terminal","title":"Shell here","color":"#000","group":null,
                         "position":{"x":0,"y":0},"size":{"width":1,"height":1}},
                        {"id":"term-r-3","kind":"terminal","title":"Not running","color":"#000","group":null,"agentId":"claude",
                         "position":{"x":0,"y":0},"size":{"width":1,"height":1}}],
               "kanban":{"columns":[{"id":"c9","title":"Doing","color":"#0a84ff"}],"assignments":[{"nodeId":"term-r-1","columnId":"c9"}]}}"""
        )
        dotNodeterm.mkdirs()
        File(dotNodeterm, "agent-status-project-drv.json").writeText(
            """{"v":1,"updatedAt":$now,"nodes":{"term-r-1":{"state":"working","agentId":"claude","sessionId":"sid-r1","updatedAt":$now}},
               "inbox":{"events":[{"id":"ev-r1","ts":$now,"nodeId":"term-r-1","agentId":"claude","kind":"approval",
                                   "title":"Run the tests?","pendingId":"term-r-1-1700000000000-7"}],"nodes":{}},
               "settings":{"claudePermissionMode":"plan","autoSupported":true,"claudeAccounts":[]}}"""
        )
        File(dotNodeterm, "agent-status-project-live2.json").writeText(
            """{"v":1,"updatedAt":$now,"nodes":{"term-s-7":{"state":"done","agentId":"codex","updatedAt":$now}}}"""
        )
        val old = now - 5 * 60_000
        File(dotNodeterm, "agent-status-project-gone.json").writeText(
            """{"v":1,"updatedAt":$old,"nodes":{"term-g-1":{"state":"blocked","agentId":"claude","updatedAt":$old}},
               "inbox":{"events":[{"id":"ev-g1","ts":$old,"nodeId":"term-g-1","kind":"approval","title":"Stale"}],"nodes":{}}}"""
        )
        val elsewhere = File(root, "elsewhere").apply { mkdirs() }
        for ((name, dir) in listOf("nt-term-r-1" to File(remoteRepo, "sub"), "nt-term-r-2" to remoteRepo, "nt-term-g-1" to elsewhere)) {
            val (code, out) = tmuxOn("nodeterm-rmt", "-f", "/dev/null", "new-session", "-d", "-s", name, "-c", dir.path)
            assertEquals(0, code, out)
        }
    }

    private fun clearDrivenHost() {
        stopRmtServer()
        dotNodeterm.listFiles()?.filter { it.name.startsWith("agent-status-") }?.forEach { it.delete() }
        remoteRepo.deleteRecursively()
    }

    /**
     * Stop this class's `nodeterm-rmt` server and wait until it is gone: a server exits AFTER
     * `kill-server` (or the end of its last session) returns, and a client that connects meanwhile
     * gets "server exited unexpectedly" instead of starting a new one.
     */
    private fun stopRmtServer() {
        tmuxOn("nodeterm-rmt", "kill-server")
        val end = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < end) {
            val (code, out) = tmuxOn("nodeterm-rmt", "list-sessions")
            if (code != 0 && !out.contains("server exited unexpectedly")) return
            Thread.sleep(50)
        }
    }

    /** Run [block] with the desktop app's userData moved away: a computer no nodeterm runs on. */
    private fun <T> withoutOwnData(block: () -> T): T {
        val ud = File(home, ".config/node-terminal")
        val aside = File(root, "ud-aside")
        check(ud.renameTo(aside))
        try {
            return block()
        } finally {
            check(aside.renameTo(ud))
        }
    }

    private fun waitForPane(socket: String, session: String, needle: String): String {
        val end = System.currentTimeMillis() + 8_000
        var pane = ""
        while (System.currentTimeMillis() < end) {
            pane = tmuxOn(socket, "capture-pane", "-p", "-J", "-t", "=$session:").second
            if (pane.contains(needle)) break
            Thread.sleep(100)
        }
        return pane
    }

    @Test
    fun `a computer another desktop drives over SSH lists its projects, sessions and status from what that desktop left there`() = runBlocking<Unit> {
        val now = System.currentTimeMillis()
        try {
            layOutDrivenHost(now)
            withoutOwnData {
                runBlocking {
                    connect().use { conn ->
                        val snap = conn.listProjects()
                        assertEquals(
                            listOf("Remote repo", "project-live2", HostBrowse.OTHER_SESSIONS_NAME),
                            snap.projects.map { it.name },
                            "the project file, a connected desktop's slice with no file, and the sessions nobody names"
                        )
                        assertTrue(snap.projects.all { it.drivenRemotely && it.sshTarget == null })
                        val drv = snap.projects[0]
                        assertEquals("project-drv", drv.id, "the desktop's project id, which its slice is named by")
                        assertEquals(remoteRepo.path, drv.cwd)
                        assertEquals(listOf("term-r-1", "term-r-2", "term-r-3"), drv.nodes.map { it.id })
                        assertEquals("c9", drv.board!!.columnOf("term-r-1"))
                        assertEquals(listOf("term-s-7"), snap.projects[1].nodes.map { it.id })
                        assertEquals(listOf("term-g-1"), snap.projects[2].nodes.map { it.id }, "a stale slice names no project")

                        assertTrue(snap.isLive("term-r-1") && snap.isLive("term-r-2") && snap.isLive("term-g-1"))
                        assertFalse(snap.isLive("term-r-3"))
                        assertEquals("nodeterm-rmt", snap.socketOf("term-r-1"))
                        assertEquals(AgentState.WORKING, snap.statusOf("term-r-1")!!.state)
                        assertEquals(AgentState.DONE, snap.statusOf("term-s-7")!!.state)
                        assertNull(snap.statusOf("term-g-1"), "a slice older than twice the heartbeat is no data")
                        assertEquals(listOf("ev-r1"), snap.status!!.inbox!!.events.map { it.id })
                        assertEquals("plan", snap.status!!.settings!!.claudePermissionMode, "the slice carries the host's settings")

                        // What needs nodeterm the app is that OTHER desktop's.
                        assertTrue(NewSessionChoice.offeredProjects(snap).isEmpty())
                        assertIs<LegRouting.Leg.Unavailable>(
                            LegRouting.forProject(Capability.BOARD_WRITES, drv, LegRouting.Leg.Relay)
                        )

                        // The session runs HERE, on nodeterm-rmt: attach, type, read its pane.
                        val sink = Sink()
                        val stream = conn.attach("term-r-1", 100, 30, sink)
                        assertFalse(stream.fresh)
                        Thread.sleep(400)
                        stream.write("echo rmt_\$((6*7))\r")
                        sink.waitFor("rmt_42")
                        assertTrue(waitForPane("nodeterm-rmt", "nt-term-r-1", "rmt_42").contains("rmt_42"), "typed into the rmt session")
                        stream.detach()
                        Thread.sleep(300)
                        assertEquals(0, tmuxOn("nodeterm-rmt", "has-session", "-t", "=nt-term-r-1").first, "detaching never ends it")

                        conn.sendKeys("term-r-2", "echo sk_rmt_\$((3*3))")
                        conn.sendKeys("term-r-2", "\r")
                        assertTrue(waitForPane("nodeterm-rmt", "nt-term-r-2", "sk_rmt_9").contains("sk_rmt_9"))
                        assertTrue(Pane.isShell(conn.paneCommand("term-r-2")), "the pane read reaches the rmt socket")

                        // Not running: only its own desktop starts it, and the phone's relay is not that
                        // desktop's, so there is nothing to offer — and nothing is created on either socket.
                        val e = assertFailsWith<HostException> { conn.attach("term-r-3", 80, 24, Sink()) }
                        assertFalse(e is NeedsRelayException)
                        assertEquals(SshHostConnection.DRIVEN_NOT_RUNNING, e.message)
                        // The same on a connection that has not listed yet (a redial, a terminal restored
                        // after the process died): the review of A27a.
                        connect().use { fresh ->
                            val e2 = assertFailsWith<HostException> { fresh.attach("term-r-3", 80, 24, Sink()) }
                            assertFalse(e2 is NeedsRelayException, "no relay offered on a connection that never listed")
                            assertEquals(SshHostConnection.DRIVEN_NOT_RUNNING, e2.message)
                        }
                        Thread.sleep(300)
                        assertEquals(1, tmuxOn("nodeterm-rmt", "has-session", "-t", "=nt-term-r-3").first)
                        assertEquals(1, tmux("has-session", "-t", "=nt-term-r-3").first)

                        // The held approval and the read-ack are files on THIS computer, where the driving
                        // desktop's SSH answer path and ack sweep look for them.
                        val pending = File(dotNodeterm, "pending").apply { mkdirs() }
                        val ev = snap.status!!.inbox!!.events.single()
                        File(pending, "${ev.pendingId}.json").writeText("{}")
                        assertEquals(ApprovalOutcome.SENT, conn.answerApproval(ev, allow = true))
                        assertEquals("allow", File(pending, "${ev.pendingId}.answer").readText())
                        conn.ackRead("term-r-1", "ev-r1")
                        assertEquals("ev-r1", File(dotNodeterm, "acks/term-r-1.seen").readText())

                        // Ending it stops the rmt session and nothing on the host's own socket.
                        conn.killSession("term-r-2")
                        assertEquals(1, tmuxOn("nodeterm-rmt", "has-session", "-t", "=nt-term-r-2").first)
                        assertEquals(0, tmux("has-session", "-t", "=nt-term-a-1").first)
                    }
                }
            }
        } finally {
            clearDrivenHost()
        }
    }

    @Test
    fun `with both sockets in use the host's own projects come first, and the paired desktop's SSH project stays its own (A09)`() = runBlocking<Unit> {
        val now = System.currentTimeMillis()
        // The paired desktop drives THIS computer as its SSH project "Server" (p2): that project's
        // file and session are here too, and must not turn into a second, directly reachable project.
        val selfSsh = File(root, "self-ssh/.nodeterm")
        try {
            layOutDrivenHost(now)
            selfSsh.mkdirs()
            File(selfSsh, "project.json").writeText(
                """{"version":1,"rev":1,"savedAt":"x","id":"p2","name":"Server again","color":"#000","viewport":{"x":0,"y":0,"zoom":1},
                   "nodes":[{"id":"term-b-2","kind":"terminal","title":"Remote","color":"#000","group":null,"position":{"x":0,"y":0},"size":{"width":1,"height":1}}]}"""
            )
            assertEquals(0, tmuxOn("nodeterm-rmt", "new-session", "-d", "-s", "nt-term-b-2", "-c", selfSsh.parentFile.path).first)
            // A name on BOTH sockets is the host's own session (first wins, as the desktop's sweep does).
            assertEquals(0, tmuxOn("nodeterm-rmt", "new-session", "-d", "-s", "nt-term-a-1", "-c", root.path).first)
            connect().use { conn ->
                val snap = conn.listProjects()
                assertEquals(
                    listOf("Repo", "Server", "Scratch", "Parked", "Remote repo", "project-live2", HostBrowse.OTHER_SESSIONS_NAME),
                    snap.projects.map { it.name }
                )
                assertEquals(listOf("term-g-1"), snap.projects.last().nodes.map { it.id }, "neither term-a-1 nor term-b-2 is an orphan")
                assertEquals("node-terminal", snap.socketOf("term-a-1"))
                assertEquals("nodeterm-rmt", snap.socketOf("term-r-1"))
                assertEquals(AgentState.WORKING, snap.statusOf("term-a-1")!!.state, "the host's own mirror")
                assertEquals(AgentState.WORKING, snap.statusOf("term-r-1")!!.state, "the slice")

                // The desktop's own SSH project: still reached through the desktop.
                val e = assertFailsWith<NeedsRelayException> { conn.attach("term-b-2", 80, 24, Sink()) }
                assertTrue(e.message!!.contains("me@box"), e.message)

                // term-a-1 is attached on node-terminal, never on the rmt session of the same name.
                val sink = Sink()
                val stream = conn.attach("term-a-1", 100, 30, sink)
                Thread.sleep(400)
                stream.write("echo own_\$((4*4))\r")
                sink.waitFor("own_16")
                assertTrue(waitForPane("node-terminal", "nt-term-a-1", "own_16").contains("own_16"))
                assertFalse(tmuxOn("nodeterm-rmt", "capture-pane", "-p", "-t", "=nt-term-a-1:").second.contains("own_16"))
                stream.detach()
            }
        } finally {
            clearDrivenHost()
            selfSsh.parentFile.deleteRecursively()
        }
    }

    @Test
    fun `a Server Edition's data dir is found, and its install metadata read`() = runBlocking<Unit> {
        val data = File(home, ".nodeterm-server").apply { mkdirs() }
        File(data, "workspace.json").writeText(
            """{"version":3,"activeProjectId":"p1","entries":[{"id":"p1","name":"Served repo","color":"#0a84ff","cwd":"${repo.path}"}]}"""
        )
        File(data, "agent-status.json").writeText(
            """{"v":1,"updatedAt":1,"nodes":{"term-a-1":{"state":"done","agentId":"claude","updatedAt":5}},
               "server":{"version":"0.2.17","commit":"1e56f83","installedAt":"2026-09-01T10:00:00.000Z"}}"""
        )
        try {
            withoutOwnData {
                runBlocking {
                    connect().use { conn ->
                        val snap = conn.listProjects()
                        assertEquals(listOf("Served repo"), snap.projects.map { it.name })
                        assertEquals(listOf("term-a-1"), snap.projects.single().nodes.map { it.id })
                        assertFalse(snap.projects.single().drivenRemotely)
                        assertEquals(AgentState.DONE, snap.statusOf("term-a-1")!!.state)
                        assertEquals("nodeterm server 0.2.17 · 1e56f83 · installed 2026-09-01", snap.status!!.server!!.describe())
                    }
                }
            }
        } finally {
            data.deleteRecursively()
        }
    }

    @Test
    fun `nothing of nodeterm's found is an error that says where it looked, not an empty computer`() = runBlocking<Unit> {
        withoutOwnData {
            runBlocking {
                connect().use { conn ->
                    val e = assertFailsWith<NothingFoundException> { conn.listProjects() }
                    assertEquals(SshHostConnection.NO_USER_DATA, e.message)
                    assertTrue(e.message!!.contains("~/.nodeterm-server") && e.message!!.contains("--data-dir"), e.message)
                    // The relay is offered only to a phone that holds a relay leg (the review of A27b):
                    // a computer added by its SSH address never has one.
                    for (leg in LegRouting.RelayLeg.entries) {
                        val said = e.said(leg)
                        assertTrue(said.startsWith(SshHostConnection.NOT_FOUND), "$leg: $said")
                        val offered = leg == LegRouting.RelayLeg.AVAILABLE || leg == LegRouting.RelayLeg.ROUTE_SSH_ONLY
                        assertEquals(offered, said.contains("relay"), "$leg: $said")
                    }
                    assertTrue(e.said(LegRouting.RelayLeg.ADDED_OVER_SSH).contains("added as the user"))
                }
            }
        }
    }

    @Test
    fun `a computer a desktop drove once, where only its stale slices remain, is still nothing found`() = runBlocking<Unit> {
        // The review of A27a: the desktop never deletes ~/.nodeterm/agent-status-<projectId>.json, so
        // once a desktop has driven a computer its slices stay. Old ones are no data, and must not
        // turn "not found, here is where the phone looked" into an empty computer.
        val old = System.currentTimeMillis() - 10 * 60_000
        dotNodeterm.mkdirs()
        File(dotNodeterm, "agent-status-project-gone.json").writeText(
            """{"v":1,"updatedAt":$old,"nodes":{"term-g-1":{"state":"blocked","agentId":"claude","updatedAt":$old}}}"""
        )
        try {
            withoutOwnData {
                runBlocking {
                    connect().use { conn ->
                        val e = assertFailsWith<HostException> { conn.listProjects() }
                        assertEquals(SshHostConnection.NO_USER_DATA, e.message)
                    }
                }
            }
        } finally {
            clearDrivenHost()
        }
    }

    @Test
    fun `the host key is pinned on first use and a changed key is refused`() {
        val pin = MemoryPin()
        connect(pin).close()
        assertTrue(pin.value!!.startsWith("SHA256:"))
        connect(pin).close()
        assertFailsWith<HostKeyChangedException> { connect(MemoryPin("SHA256:not-this-host")) }
    }

    @Test
    fun `a server that refuses our key never becomes the pin (A49)`() {
        // What answers at the paired address after the DHCP lease moved, or on another network that
        // uses the same private range: an sshd that completes the key exchange and then refuses the
        // phone's key. Pinning its host key during the exchange made the real computer "changed" on
        // the next connect.
        val pin = MemoryPin()
        assertFailsWith<HostException> {
            SshHostConnection.connect("127.0.0.1", port, "dev", SshIdentity.generate(), pin).close()
        }
        assertNull(pin.value, "a key exchange whose authentication failed must not pin")
        assertFailsWith<HostException> {
            SshHostConnection.connect("127.0.0.1", port, "someone-else", identity, pin).close()
        }
        assertNull(pin.value, "a refused user must not pin either")
        // The first connect that AUTHENTICATES pins exactly the server's host key.
        connect(pin).close()
        val serverKey = server.keyPairProvider.loadKeys(null).first().public
        assertEquals(SshHostConnection.fingerprint(serverKey), pin.value)
    }

    @Test
    fun `a first connect must present a key the pairing named, refused before our key is offered (A49-anchor)`() {
        val serverFp = SshHostConnection.fingerprint(server.keyPairProvider.loadKeys(null).first().public)
        val stranger = "SHA256:" + "A".repeat(43)
        // The computer named other keys at pairing: whatever answers here is not one of them.
        val pin = MemoryPin(paired = listOf(stranger))
        val before = authAttempts.get()
        val refused = assertFailsWith<HostKeyNotPairedException> { connect(pin).close() }
        assertNull(pin.value, "a key the pairing did not name must never become the pin")
        assertEquals(before, authAttempts.get(), "the phone's key must not be offered to a server the pairing did not name")
        assertEquals(serverFp, refused.actual)
        assertEquals(listOf(stranger), refused.paired)
        assertTrue(refused.message!!.contains("the computer reported to this phone (when it was paired, or since through the relay)"), refused.message)
        // A HostKeyChangedException, so SshFallback refuses SSH and in Auto still tries the relay.
        assertIs<HostKeyChangedException>(refused)

        // The computer named this server's key among others: it connects and pins exactly that key.
        val anchored = MemoryPin(paired = listOf(stranger, serverFp))
        connect(anchored).close()
        assertEquals(serverFp, anchored.value)
        // Later connects verify the pin, as they always did.
        connect(anchored).close()
    }

    @Test
    fun `a host certificate matches the pairing by the key it certifies (A49-anchor)`() {
        val inner = server.keyPairProvider.loadKeys(null).first().public
        val innerFp = SshHostConnection.fingerprint(inner)
        val cert = com.hierynomus.sshj.userauth.certificate.Certificate.getBuilder<java.security.PublicKey>().publicKey(inner).build()
        assertTrue(SshHostConnection.matchesAnchor(listOf(innerFp), "SHA256:the-certificate-itself", cert))
        assertFalse(SshHostConnection.matchesAnchor(listOf("SHA256:" + "B".repeat(43)), "SHA256:the-certificate-itself", cert))
        // A plain key matches by its own fingerprint only.
        assertTrue(SshHostConnection.matchesAnchor(listOf(innerFp), innerFp, inner))
        assertFalse(SshHostConnection.matchesAnchor(listOf("SHA256:" + "B".repeat(43)), innerFp, inner))
    }

    @Test
    fun `a key the computer does not know is refused`() {
        assertFailsWith<HostException> {
            SshHostConnection.connect("127.0.0.1", port, "dev", SshIdentity.generate(), MemoryPin()).close()
        }
        // …and the same session was never at risk.
        assertEquals(0, tmux("has-session", "-t", "=nt-term-a-1").first)
        TimeUnit.MILLISECONDS.sleep(1)
    }
}
