package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.Launch
import dev.nodeterm.protocol.model.ManagedAccount
import dev.nodeterm.protocol.model.MirrorSettings
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.SessionBucket
import dev.nodeterm.protocol.model.TmuxNames
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.relay.Framing
import dev.nodeterm.protocol.relay.Op
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ModelTest {
    @Test
    fun `a hostile or broken blob degrades section by section, never throws`() {
        val snap = ProjectsParser.parseBlob("not json\n--NT-PROJECTS-SPLIT--\nnt-a\njunk\n--NT-STATUS-SPLIT--\n{\"nodes\":{\"a\":{\"state\":42,\"hibernated\":true}}}")
        assertTrue(snap.projects.isEmpty())
        assertEquals(setOf("nt-a"), snap.liveSessions)
        val st = snap.statusOf("a")!!
        assertNull(st.state, "a wrong-typed state is absent, not a crash")
        assertEquals(SessionBucket.SLEEPING, st.bucket)
        assertTrue(ProjectsParser.parseBlob("").projects.isEmpty())
    }

    @Test
    fun `nodes default to terminal and the legacy claude tag still means claude`() {
        val snap = ProjectsParser.parseBlob("""{"version":2,"projects":[{"id":"p","name":"P","nodes":[{"id":"n1","title":"t","tags":["claude"]},{"id":"n2","kind":"group"}],"kanban":{"columns":"garbage"}}]}""")
        val p = snap.projects.single()
        assertEquals(listOf("n1"), p.sessions.map { it.id })
        assertEquals("claude", p.sessions.single().agentId)
        assertNotNull(p.board, "columns present but malformed → an empty board, read tolerantly")
    }

    @Test
    fun `tmux names match tmux-naming ts`() {
        assertEquals("nt-term-abc-1", TmuxNames.sessionName("term-abc-1"))
        assertEquals("nt-a_b_c", TmuxNames.sessionName("a/b c"))
        assertTrue(TmuxNames.isSessionName("nt-a_b"))
    }

    @Test
    fun `frames round trip with the stable header`() {
        val f = Framing.decode(Framing.encode(Op.INPUT, 7, 0x1_0000_0002L, "hi".toByteArray()))!!
        assertEquals(Op.INPUT, f.op)
        assertEquals(7, f.streamId)
        assertEquals(0x1_0000_0002L, f.seq)
        assertEquals("hi", String(f.payload))
        assertNull(Framing.decode(ByteArray(15)))
        assertNull(Framing.decode(Framing.encode(99, 1, 0, ByteArray(0))), "unknown opcode")
        assertEquals(120 to 40, Framing.readSize(Framing.sizePayload(120, 40)))
    }

    @Test
    fun `pairing payloads parse like pairing-core builds them, and refuse plaintext relays`() {
        val p = PairingPayload.parse("""{"v":1,"host":"192.168.1.5","port":22,"user":"me","token":"t","pairPort":5555,"nodeterm":true,"name":"Mac","hostKey":"${"A".repeat(43)}=","relay":{"hostId":"h","hostPublicKeyB64":"${"A".repeat(43)}=","relayEndpoint":"ws://evil.example"},"ssh":false}""")!!
        assertEquals("Mac", p.name)
        assertEquals(false, p.sshAvailable)
        assertNull(p.relay, "ws:// to a non-loopback host is refused (pairing.ts R5)")
        assertNull(PairingPayload.parse("""{"v":2,"host":"x"}"""))
        assertNull(PairingPayload.parse("nodeterm://pair?code=abc"), "not a payload")
    }

    @Test
    fun `the URL and bare-code envelopes of pair-qr ts decode to the same payload`() {
        val json = """{"v":1,"host":"10.0.0.2","user":"u","token":"t","pairPort":1,"nodeterm":true,"name":"Box é"}"""
        val code = dev.nodeterm.protocol.crypto.B64.encodeUrl(json.toByteArray())
        val viaUrl = assertNotNull(PairingPayload.parse("nodeterm://pair?code=$code"))
        assertEquals("Box é", viaUrl.name)
        assertEquals(viaUrl, PairingPayload.parse(code))
        assertEquals(viaUrl, PairingPayload.parse(json))
        // A desktop-peer relay offer uses the same envelope with a different payload: refused.
        val offer = dev.nodeterm.protocol.crypto.B64.encodeUrl("""{"relayEndpoint":"wss://r","pairingToken":"x","hostPublicKeyB64":"y"}""".toByteArray())
        assertNull(PairingPayload.parse("nodeterm://pair?code=$offer"))
        assertNull(PairingPayload.parse("https://pair?code=$code"))
    }

    @Test
    fun `paired host survives a JSON round trip`() {
        val p = PairingPayload.parse("""{"v":1,"host":"10.0.0.2","user":"u","token":"t","pairPort":1,"nodeterm":true,"name":"Box"}""")!!
        val h = PairedHost.from(p, dev.nodeterm.protocol.pairing.PairingResult("dev-1", "tok", null, null), now = 5)
        assertEquals(h, PairedHost.fromJson(h.toJson()))
    }

    @Test
    fun `resume commands follow each agent's grammar and refuse unsafe ids`() {
        assertEquals("claude --resume abc-1", Launch.resumeCommand(Agent.CLAUDE, "abc-1"))
        assertEquals("codex resume abc", Launch.resumeCommand(Agent.CODEX, "abc"))
        assertEquals("copilot --resume=abc", Launch.resumeCommand(Agent.COPILOT, "abc"))
        assertEquals("opencode --session abc", Launch.resumeCommand(Agent.OPENCODE, "abc"))
        assertNull(Launch.resumeCommand(Agent.CLAUDE, "abc; rm -rf ~"))
        assertNull(Launch.resumeCommand(Agent.CLAUDE, "-flag"))
    }

    @Test
    fun `launch emits claude's permission mode only as the desktop would`() {
        val s = MirrorSettings("auto", autoSupported = false, claudeAccounts = listOf(ManagedAccount("a1", "/Users/me/Library/Application Support/nodeterm/claude-accounts/a1")), codexApprovalValues = emptyList())
        assertEquals("claude", Launch.launchCommand(Agent.CLAUDE, s, null, null), "auto on an old claude degrades to the bare command")
        assertEquals("claude --permission-mode auto", Launch.launchCommand(Agent.CLAUDE, s.copy(autoSupported = true), null, null))
        assertEquals("claude", Launch.launchCommand(Agent.CLAUDE, s.copy(claudePermissionMode = "constructor"), null, null))
        assertEquals(
            "cd '/w/p' && CLAUDE_CONFIG_DIR='/Users/me/Library/Application Support/nodeterm/claude-accounts/a1' claude --permission-mode plan",
            Launch.launchCommand(Agent.CLAUDE, s.copy(claudePermissionMode = "plan"), "a1", "/w/p")
        )
        assertEquals("codex", Launch.launchCommand(Agent.CODEX, s.copy(claudePermissionMode = "plan"), "a1", null))
        assertEquals("gemini", Launch.launchCommand(Agent.GEMINI, s, null, "/it's/unsafe"), "a quote-bearing cwd is dropped, not escaped")
        assertTrue(Regex("^term-[a-z0-9]+-[a-z0-9]{1,16}$").matches(Launch.newNodeId()))
    }
}
