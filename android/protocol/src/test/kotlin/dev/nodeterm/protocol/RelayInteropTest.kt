package dev.nodeterm.protocol

import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.host.CardLabelEdit
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.NewNode
import dev.nodeterm.protocol.host.QuickActions
import dev.nodeterm.protocol.host.RelayConnectStatus
import dev.nodeterm.protocol.host.RelayConnector
import dev.nodeterm.protocol.host.RelayApprovalRefusedException
import dev.nodeterm.protocol.host.RelayApprovalRequiredException
import dev.nodeterm.protocol.host.RelayApprovalTimeoutException
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.NodeKind
import dev.nodeterm.protocol.model.SessionBucket
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayOutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The Kotlin relay client against the DESKTOP's real host code: `connectHostSession` +
 * `createHostHandlers` (host-service.ts) over `connectRelay` (relay-socket.ts, host role), through a
 * local broker. Everything the phone does over the relay goes across this wire at least once.
 */
class RelayInteropTest {
    private val harnesses = ArrayList<InteropHarness>()

    @AfterTest
    fun tearDown() = harnesses.forEach { it.close() }

    private fun start(approveAfterMs: Long = 0, rejectAfterMs: Long = -1, extra: Map<String, String> = emptyMap()): InteropHarness =
        InteropHarness.start(
            "relay",
            mapOf("FIXTURE_APPROVE_AFTER_MS" to approveAfterMs.toString(), "FIXTURE_REJECT_AFTER_MS" to rejectAfterMs.toString()) + extra
        ).also { harnesses += it }

    private fun InteropHarness.str(key: String) = ready[key]!!.jsonPrimitive.content
    private fun JsonObject.str(key: String) = this[key]!!.jsonPrimitive.content

    private fun connect(
        h: InteropHarness,
        keys: BoxKeyPair = BoxKeyPair.generate(),
        statuses: MutableList<RelayConnectStatus>? = null,
        approvalTimeoutMs: Long = 20_000,
        requireApproved: Boolean = false
    ) =
        runBlocking {
            RelayConnector.connect(
                requireApproved = requireApproved,
                relayUrl = h.str("relayUrl"),
                token = h.str("clientToken"),
                deviceKeys = keys,
                hostPublicKeyB64 = h.str("hostPublicKeyB64"),
                onStatus = { statuses?.add(it) },
                approvalTimeoutMs = approvalTimeoutMs,
                approvalPollMs = 200
            )
        }

    private class RecordingSink : TerminalSink {
        val paints = CopyOnWriteArrayList<String>()
        val output = ByteArrayOutputStream()
        val resized = CopyOnWriteArrayList<Pair<Int, Int>>()
        val exited = CountDownLatch(1)
        @Volatile var exitCode: Int? = null

        override fun onPaint(text: String) {
            paints += text
        }

        override fun onOutput(bytes: ByteArray) {
            synchronized(output) { output.write(bytes) }
        }

        override fun onResized(cols: Int, rows: Int) {
            resized += cols to rows
        }

        override fun onExit(code: Int?) {
            exitCode = code
            exited.countDown()
        }

        fun text(): String = synchronized(output) { output.toString(Charsets.UTF_8) }

        fun awaitText(needle: String, timeoutMs: Long = 5_000) {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (!text().contains(needle)) {
                if (System.currentTimeMillis() > deadline) throw AssertionError("'$needle' not in output: ${text()}")
                Thread.sleep(20)
            }
        }
    }

    @Test
    fun `handshake, approval wait and SAS agree with the desktop`() {
        val h = start(approveAfterMs = 700)
        val keys = BoxKeyPair.generate()
        val statuses = ArrayList<RelayConnectStatus>()
        val connected = connect(h, keys, statuses)
        connected.connection.use {
            val peer = h.awaitEvent("peer-ready")
            assertEquals(peer.str("sas"), connected.sas, "both ends must show the same code")
            assertEquals(keys.publicKeyB64, peer.str("pub"), "the host pins exactly our box key")
            assertTrue(statuses.any { it is RelayConnectStatus.AwaitingApproval }, "the wait was surfaced: $statuses")
            h.awaitEvent("approved")
        }
    }

    @Test
    fun `an unapproved phone is told so and never served`() {
        val h = start(approveAfterMs = -1)
        val e = assertFailsWith<RelayApprovalTimeoutException> { connect(h, approvalTimeoutMs = 1_200) }
        assertTrue(e.message!!.contains("approved"), e.message)
    }

    @Test
    fun `pressing Deny on the desktop reads as a refusal, not a network error`() {
        // A30: the refusal has to be recognisable, or the phone re-dials and the dialog comes back.
        val h = start(approveAfterMs = -1, rejectAfterMs = 600)
        val statuses = ArrayList<RelayConnectStatus>()
        assertFailsWith<RelayApprovalRefusedException> { connect(h, statuses = statuses, approvalTimeoutMs = 10_000) }
        assertTrue(statuses.any { it is RelayConnectStatus.AwaitingApproval })
        h.awaitEvent("rejected")
    }

    @Test
    fun `a background dial gives up instead of waiting on an approval dialog`() {
        val h = start(approveAfterMs = -1)
        val statuses = ArrayList<RelayConnectStatus>()
        val t0 = System.currentTimeMillis()
        assertFailsWith<RelayApprovalRequiredException> {
            connect(h, statuses = statuses, approvalTimeoutMs = 20_000, requireApproved = true)
        }
        assertTrue(System.currentTimeMillis() - t0 < 10_000, "it did not wait out the approval window")
        assertTrue(statuses.none { it is RelayConnectStatus.AwaitingApproval }, "no code shown for a dial nobody watches")
    }

    @Test
    fun `projects list parses the desktop blob`() {
        val h = start()
        val connected = connect(h)
        connected.connection.use {
            val snap = connected.first
            val p = snap.projects.single()
            assertEquals("Demo", p.name)
            assertEquals(listOf("term-abc-1"), p.sessions.map { it.id })
            assertEquals(NodeKind.STICKY, p.nodes[1].kind)
            assertTrue(snap.isLive("term-abc-1"))
            val st = snap.statusOf("term-abc-1")!!
            assertEquals(AgentState.BLOCKED, st.state)
            assertEquals(SessionBucket.NEEDS_YOU, st.bucket)
            assertEquals("fix bug", st.name)
            val ev = snap.status!!.inbox!!.events.single()
            assertEquals(InboxKind.APPROVAL, ev.kind)
            assertEquals("term-abc-1-1700000000000-42", ev.pendingId)
            assertEquals("Running npm test", snap.status!!.inbox!!.nodes["term-abc-1"]!!.activity)
            val board = p.board!!
            assertEquals("c1", board.columnOf("term-abc-1"))
            assertEquals(listOf("l1"), board.metaOf("term-abc-1")!!.labels)
        }
    }

    @Test
    fun `attach paints the snapshot, streams output and carries input`() = runBlocking<Unit> {
        val h = start()
        val conn = connect(h).connection
        conn.use {
            val sink = RecordingSink()
            val stream = conn.attach("term-abc-1", 90, 30, sink)
            assertFalse(stream.fresh, "a live session is a warm join")
            val attach = h.awaitEvent("attach")
            assertEquals(90, attach.str("cols").toInt())
            assertEquals("false", attach.str("adaptsToSize"), "a phone is a size CEILING, like iOS")
            sink.awaitText("hello term-abc-1")
            assertEquals(listOf("screen of term-abc-1"), sink.paints)
            stream.write("ls -la\r")
            assertEquals("ls -la\r", h.awaitEvent("write").str("data"))
            sink.awaitText("echo:ls -la")
            stream.write("ünïcødé ✓\r")
            sink.awaitText("echo:ünïcødé ✓")
        }
    }

    @Test
    fun `a multi-chunk snapshot survives a code point split across chunks`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val sink = RecordingSink()
            conn.attach("term-big-1", 80, 24, sink)
            sink.awaitText("hello term-big-1")
            assertEquals("SNAP-" + "€".repeat(100_000) + "-END", sink.paints.single())
        }
    }

    @Test
    fun `fresh reports a cold start, and resize round-trips a Resized frame`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val sink = RecordingSink()
            val stream = conn.attach("term-new-1", 80, 24, sink)
            assertTrue(stream.fresh)
            sink.awaitText("hello term-new-1")
            stream.resize(100, 30)
            val r = h.awaitEvent("resize")
            assertEquals(100, r.str("cols").toInt())
            assertEquals(30, r.str("rows").toInt())
            val deadline = System.currentTimeMillis() + 3_000
            while (sink.resized.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(20)
            assertEquals(listOf(132 to 43), sink.resized.toList())
        }
    }

    @Test
    fun `the pane exiting reaches the sink with its code`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val sink = RecordingSink()
            val stream = conn.attach("term-abc-1", 80, 24, sink)
            sink.awaitText("hello")
            stream.write("exit\r")
            assertTrue(sink.exited.await(5, TimeUnit.SECONDS))
            assertEquals(7, sink.exitCode)
        }
    }

    @Test
    fun `detach, end session, scroll and node actions reach the host`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val a = conn.attach("term-abc-1", 80, 24, RecordingSink())
            a.scroll(up = true, lines = 3)
            repeat(3) { assertEquals("\u001b[<64;1;1M", h.awaitEvent("write").str("data")) }
            a.detach()
            h.awaitEvent("kill")

            val b = conn.attach("term-new-1", 80, 24, RecordingSink())
            b.endSession()
            assertEquals("term-new-1", h.awaitEvent("destroyNode").str("nodeId"))

            conn.wake("term-abc-1")
            assertEquals("term-abc-1", h.awaitEvent("wake").str("nodeId"))
            conn.refresh("term-abc-1")
            h.awaitEvent("refresh")
            conn.rename("term-abc-1", "new\u001b[31m name")
            assertEquals("new [31m name", h.awaitEvent("rename").str("title"), "control chars are stripped host-side")
        }
    }

    @Test
    fun `board verbs carry null as the Ungrouped column`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            assertEquals(listOf("To Do"), conn.ensureBoard("p1")!!.map { it.title })
            assertTrue(conn.setCardColumn("p1", "term-abc-1", null))
            val moved = h.awaitEvent("setCardColumn")
            assertEquals(JsonNull, moved["columnId"])
            assertTrue(conn.setCardColumn("p1", "term-abc-1", "c1"))
            assertEquals("c1", h.awaitEvent("setCardColumn").str("columnId"))
            val res = conn.editCardLabels("p1", "term-abc-1", CardLabelEdit(add = listOf("l1"), create = listOf("urgent" to "red")))!!
            assertTrue(res.edited)
            assertEquals(listOf("l1"), res.cardLabelIds)
            val edit = h.awaitEvent("editCardLabels")["edit"].toString()
            assertTrue(edit.contains("urgent"), edit)
            assertTrue(conn.registerNode("p1", NewNode("term-kx1-abc", "Claude Code", "claude", null)))
            assertEquals("p1", h.awaitEvent("registerNode").str("projectId"))
        }
    }

    @Test
    fun `quick approve answers the held hook through the relay verb, never with keys`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val event = conn.listProjects().status!!.inbox!!.events.single()
            assertEquals(QuickActions.Result.SENT, QuickActions.answerApproval(conn, event, allow = true))
            val answer = h.awaitEvent("answer")
            assertEquals("allow", answer.str("decision"))
            assertEquals("term-abc-1-1700000000000-42", answer.str("pendingId"))
            conn.ackRead("term-abc-1", event.id)
            assertEquals("term-abc-1", h.awaitEvent("ack").str("nodeId"))
            assertNotNull(event)
        }
    }

    @Test
    fun `an answer that arrives after the hold ended opens the session instead of claiming success`() = runBlocking<Unit> {
        // A06/A35 against the desktop's real verb: `{answered:false, reason:"gone"}`, and the node is
        // still blocked, so the prompt is on screen now.
        val h = start()
        connect(h).connection.use { conn ->
            val live = conn.listProjects().status!!.inbox!!.events.single()
            val late = live.copy(id = "e-late", pendingId = "term-abc-1-1700000000000-43-expired")
            assertEquals(dev.nodeterm.protocol.host.ApprovalOutcome.GONE, conn.answerApproval(late, allow = true))
            assertEquals(QuickActions.Result.EXPIRED, QuickActions.answerApproval(conn, late, allow = false))
        }
    }

    @Test
    fun `quick answers are typed through the node's session, not a throwaway client`() = runBlocking<Unit> {
        // A12: node.sendKeys through the desktop's real verb handler.
        val h = start()
        connect(h).connection.use { conn ->
            conn.sendKeys("term-abc-1", "\u001b")
            val ev = h.awaitEvent("sendKeys")
            assertEquals("term-abc-1", ev.str("nodeId"))
            assertEquals("\u001b", ev.str("keys"))
            // Not delivered is not "sent": the caller opens the session instead.
            assertFailsWith<HostException> { conn.sendKeys("term-gone-1", "1") }
        }
    }

    @Test
    fun `an older desktop without the verb still gets the keys, after the pane painted`() = runBlocking<Unit> {
        val h = start(extra = mapOf("FIXTURE_NO_SENDKEYS" to "1"))
        connect(h).connection.use { conn ->
            conn.sendKeys("term-abc-1", "2")
            assertEquals("2", h.awaitEvent("write").str("data"))
        }
    }
}
