package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ApprovalOutcome
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.HostKeyPin
import dev.nodeterm.protocol.ssh.SshHostConnection
import dev.nodeterm.protocol.ssh.SshScripts
import kotlinx.coroutines.runBlocking
import org.apache.sshd.server.Environment
import org.apache.sshd.server.ExitCallback
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.channel.ChannelSession
import org.apache.sshd.server.command.Command
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.TestInstance
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The direct-SSH transport end to end: a real SSH server (Apache MINA) running every command
 * through `/bin/sh` as the phone would get from sshd, against a fake HOME laid out like a desktop's
 * (a v3 workspace index + project files + agent-status.json) and a REAL tmux — on a private
 * `TMUX_TMPDIR`, so no test ever touches a tmux server a developer is using (issue #629's rule).
 *
 * A pty-requesting exec runs under `script`, standing in for sshd's pty allocation (MINA's process
 * bridge has none of its own); that wrapper is harness, the scripts it runs are the product's.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SshTransportTest {
    private lateinit var root: File
    private lateinit var home: File
    private lateinit var tmuxDir: File
    private lateinit var server: SshServer
    private val identity = SshIdentity.generate()
    private var port = 0

    private fun tmuxAvailable() = runCatching { ProcessBuilder("tmux", "-V").start().waitFor() == 0 }.getOrDefault(false) &&
        File("/usr/bin/script").exists()

    // No locale at all, like an sshd exec channel on a stock macOS host (audit A03): passing the JVM's
    // own LANG through is what hid that bug.
    private fun childEnv(): Map<String, String> = System.getenv().filterKeys {
        it != "TMUX" && it != "TMUX_PANE" && it != "LANG" && it != "LANGUAGE" && !it.startsWith("LC_")
    } +
        mapOf("HOME" to home.path, "TMUX_TMPDIR" to tmuxDir.path, "XDG_CONFIG_HOME" to File(home, ".config").path)

    private fun tmux(vararg args: String): Pair<Int, String> {
        val pb = ProcessBuilder(listOf("tmux", "-L", "node-terminal") + args).redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(childEnv())
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        return p.waitFor() to out
    }

    private inner class ShCommand(private val command: String) : Command {
        private lateinit var input: InputStream
        private lateinit var output: OutputStream
        private lateinit var error: OutputStream
        private lateinit var exit: ExitCallback
        private var process: Process? = null

        override fun setInputStream(`in`: InputStream) { input = `in` }
        override fun setOutputStream(out: OutputStream) { output = out }
        override fun setErrorStream(err: OutputStream) { error = err }
        override fun setExitCallback(callback: ExitCallback) { exit = callback }

        override fun start(channel: ChannelSession, env: Environment) {
            val cols = env.env["COLUMNS"] ?: "80"
            val lines = env.env["LINES"] ?: "24"
            val pty = env.env.containsKey("TERM")
            val argv = if (pty) listOf("script", "-qfec", "stty cols $cols rows $lines 2>/dev/null; $command", "/dev/null")
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
            // For a pty session, channel EOF must NOT become stdin EOF: util-linux `script` turns that
            // into a ^D typed into the pty (measured), which ends the pane's shell — a harness artifact
            // real sshd does not have (it closes the pty and the tmux client just detaches).
            pump(input, p.outputStream, !pty)
            Thread {
                val code = p.waitFor()
                outPump.join(2000)
                errPump.join(2000)
                exit.onExit(code)
            }.apply { isDaemon = true; start() }
        }

        override fun destroy(channel: ChannelSession) {
            process?.destroy()
        }
    }

    @BeforeAll
    fun setUp() {
        assumeTrue(tmuxAvailable(), "tmux + script are needed for the SSH transport tests")
        root = Files.createTempDirectory("nt-ssh").toFile()
        home = File(root, "home").apply { mkdirs() }
        tmuxDir = File(root, "tmux").apply { mkdirs() }
        server = SshServer.setUpDefaultServer()
        server.host = "127.0.0.1"
        server.port = 0
        server.keyPairProvider = SimpleGeneratorHostKeyProvider(File(root, "hostkey.ser").toPath())
        val expected = identity.keyPair.public.encoded
        server.publickeyAuthenticator = org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator { user, key, _ ->
            user == "dev" && key.encoded.contentEquals(expected)
        }
        server.commandFactory = org.apache.sshd.server.command.CommandFactory { _, command -> ShCommand(command) }
        server.start()
        port = server.port
        layOutDesktop()
    }

    @AfterAll
    fun tearDown() {
        if (!::server.isInitialized) return
        runCatching { tmux("kill-server") }
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

    private class MemoryPin(var value: String? = null) : HostKeyPin {
        override fun pinned() = value
        override fun pin(fingerprint: String) {
            value = fingerprint
        }
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
        // phone is told to use the relay, and nothing appears on the computer's tmux.
        connect().use { conn ->
            conn.listProjects()
            val e = assertFailsWith<NeedsRelayException> { conn.attach("term-z-9", 80, 24, Sink()) }
            assertEquals("term-z-9", e.nodeId)
            Thread.sleep(300)
            assertEquals(1, tmux("has-session", "-t", "=nt-term-z-9").first, "no session was created")
        }
    }

    @Test
    fun `the attach script itself refuses to create a missing session`() {
        // Belt and braces for the race where the session ends between the check and the attach.
        val (code, _) = run {
            val pb = ProcessBuilder("script", "-qfec", SshScripts.attach("term-y-8"), "/dev/null").directory(home)
            pb.environment().clear()
            pb.environment().putAll(childEnv())
            val p = pb.start()
            p.outputStream.close()
            p.waitFor(10, TimeUnit.SECONDS)
            p.exitValue() to p.inputStream.bufferedReader().readText()
        }
        assertEquals(SshScripts.NO_SESSION_EXIT, code)
        assertEquals(1, tmux("has-session", "-t", "=nt-term-y-8").first)
    }

    @Test
    fun `nodes of the desktop's SSH projects are never reached on the desktop's own tmux`() = runBlocking<Unit> {
        // A09: term-b-2 belongs to the ssh project "Server" (me@box). Its session, approvals and acks
        // live on that host; over direct SSH the phone refuses instead of acting on the wrong machine.
        connect().use { conn ->
            conn.listProjects()
            val e = assertFailsWith<NeedsRelayException> { conn.attach("term-b-2", 80, 24, Sink()) }
            assertTrue(e.message!!.contains("me@box"), e.message)
            assertFailsWith<NeedsRelayException> { conn.sendKeys("term-b-2", "1") }
            val ev = InboxEvent("e2", 1, "term-b-2", "claude", null, InboxKind.APPROVAL, "Approve", null, false, false, emptyList(), false, "term-b-2-1-1")
            assertFailsWith<NeedsRelayException> { conn.answerApproval(ev, allow = true) }
            conn.ackRead("term-b-2", "e2")
            assertFalse(File(home, ".nodeterm/acks/term-b-2.seen").exists(), "no ack written on the wrong machine")
            assertEquals(1, tmux("has-session", "-t", "=nt-term-b-2").first, "no phantom session")
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

    @Test
    fun `the host key is pinned on first use and a changed key is refused`() {
        val pin = MemoryPin()
        connect(pin).close()
        assertTrue(pin.value!!.startsWith("SHA256:"))
        connect(pin).close()
        assertFailsWith<HostKeyChangedException> { connect(MemoryPin("SHA256:not-this-host")) }
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
