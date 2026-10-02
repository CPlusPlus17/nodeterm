package dev.nodeterm.protocol

import dev.nodeterm.protocol.git.GitDiff
import dev.nodeterm.protocol.git.GitDiff.Kind
import dev.nodeterm.protocol.git.GitFileChange
import dev.nodeterm.protocol.git.GitReplies
import dev.nodeterm.protocol.git.GitResult
import dev.nodeterm.protocol.git.GitStatus
import dev.nodeterm.protocol.git.SourceControl
import dev.nodeterm.protocol.git.SourceControlGate
import dev.nodeterm.protocol.git.SourceControlGate.Availability
import dev.nodeterm.protocol.host.ApprovalOutcome
import dev.nodeterm.protocol.host.CardLabelEdit
import dev.nodeterm.protocol.host.GIT_NETWORK_TIMEOUT_MS
import dev.nodeterm.protocol.host.GitVerb
import dev.nodeterm.protocol.host.HostCapabilities
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.LabelEditResult
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.host.NewNode
import dev.nodeterm.protocol.host.NewSessionHint
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.host.TerminalStream
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.KanbanColumn
import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.relay.RelaySocket
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Audit A29: the phone's Source Control over the desktop's typed, jailed git bridge. What the bridge
 * really answers is pinned by `RelayInteropTest` against the desktop's own `GitService`; this pins
 * how the phone reads it (including what it does with a shape it does not know), what it sends, when
 * it refuses before sending anything, and where the app's screen gets its connection.
 */
class SourceControlTest {
    // ---- reading the replies ----------------------------------------------------------------------

    /** `GitStatus` (src/shared/types.ts), every field the desktop sends. */
    private val statusJson = """
        {"hasRepo":true,"repoName":"me/app","branch":"main","branches":["main","dev"],"remoteBranches":["origin/main"],
         "ahead":2,"behind":1,"hasRemote":true,"hasOrigin":true,"hasUpstream":true,"ghAvailable":false,"ghAuthed":false,
         "staged":[{"path":"src/a.ts","status":"M","added":3,"deleted":1}],
         "changes":[{"path":"src/a.ts","status":"M","added":1,"deleted":0},
                    {"path":"docs/new.md","status":"U","added":0,"deleted":0},
                    {"path":"old.txt","status":"D","added":0,"deleted":7}]}
    """

    @Test
    fun `the status reads the desktop's shape and splits untracked files out of the changes`() {
        val st = GitReplies.status(Json.parseToJsonElement(statusJson))!!
        assertTrue(st.hasRepo)
        assertEquals("me/app", st.repoName)
        assertEquals("main", st.branch)
        assertEquals(2, st.ahead)
        assertEquals(1, st.behind)
        assertTrue(st.hasRemote && st.hasUpstream)
        assertEquals(listOf(GitFileChange("src/a.ts", "M", 3, 1)), st.staged)
        assertEquals(listOf("src/a.ts", "old.txt"), st.unstaged.map { it.path })
        assertEquals(listOf("docs/new.md"), st.untracked.map { it.path })
        assertTrue(st.untracked.single().untracked)
    }

    @Test
    fun `a folder that is not a repository is an answer, a reply of another shape is not`() {
        // What GitService.status answers for a plain folder.
        val plain = GitReplies.status(
            Json.parseToJsonElement("""{"hasRepo":false,"repoName":"demo","branch":"","branches":[],"ahead":0,"behind":0,
                "hasRemote":false,"hasOrigin":false,"hasUpstream":false,"ghAvailable":false,"ghAuthed":false,"staged":[],"changes":[]}""")
        )!!
        assertFalse(plain.hasRepo)

        assertNull(GitReplies.status(null))
        assertNull(GitReplies.status(JsonPrimitive("nope")))
        assertNull(GitReplies.status(Json.parseToJsonElement("""{"branch":"main"}""")), "no hasRepo: not a status")
        assertNull(GitReplies.result(Json.parseToJsonElement("""{"message":"x"}""")), "no ok: not a result")
        assertNull(GitReplies.history(Json.parseToJsonElement("""{"hasMore":false}""")), "no items: not a history")
        assertNull(GitReplies.diff(Json.parseToJsonElement("""{}""")), "a diff is the text itself")
        assertEquals("", GitReplies.diff(JsonPrimitive("")))
    }

    @Test
    fun `wrong-typed fields degrade to absent instead of failing the whole status`() {
        val st = GitReplies.status(
            Json.parseToJsonElement("""{"hasRepo":true,"branch":7,"ahead":"2","behind":-3,
                "staged":[{"path":"a","status":"A","added":"x"},{"status":"M"},{"path":""},5],"changes":"no"}""")
        )!!
        assertEquals("", st.branch)
        assertEquals(0, st.ahead)
        assertEquals(0, st.behind)
        assertEquals(listOf(GitFileChange("a", "A", 0, 0)), st.staged, "entries with no path are dropped")
        assertTrue(st.changes.isEmpty())
    }

    @Test
    fun `history reads the commits, the short hash falling back to the id`() {
        val h = GitReplies.history(
            Json.parseToJsonElement(
                """{"items":[
                     {"id":"0123456789abcdef","parentIds":["aa"],"subject":"Fix it","message":"Fix it\n\nbody","displayId":"0123456",
                      "author":"Ann","authorEmail":"ann@x","timestamp":1700000000000,
                      "references":[{"id":"refs/heads/main","name":"main","category":"branches"},{"id":"refs/remotes/origin/main","name":"origin/main"}]},
                     {"id":"fedcba9876543210","subject":"Older"},
                     {"subject":"no id"}],
                   "currentRef":{"id":"refs/heads/main","name":"main"},"remoteRef":{"id":"refs/remotes/origin/main","name":"origin/main"},
                   "hasIncomingChanges":false,"hasOutgoingChanges":true,"hasMore":true,"limit":50}"""
            )
        )!!
        assertEquals(listOf("Fix it", "Older"), h.commits.map { it.subject })
        val head = h.commits.first()
        assertEquals("0123456", head.shortId)
        assertEquals("Ann", head.author)
        assertEquals(1_700_000_000_000, head.timestampMs)
        assertEquals(listOf("main", "origin/main"), head.refs)
        assertEquals("fedcba9", h.commits[1].shortId)
        assertNull(h.commits[1].author)
        assertTrue(h.hasMore && h.hasOutgoingChanges && !h.hasIncomingChanges)
        assertEquals("main", h.currentRef)
        assertEquals("origin/main", h.remoteRef)
    }

    // ---- the diff -----------------------------------------------------------------------------------

    @Test
    fun `file headers are told apart from added and removed lines that start with the same characters`() {
        val text = """
            diff --git a/x.txt b/x.txt
            index 1111111..2222222 100644
            --- a/x.txt
            +++ b/x.txt
            @@ -1,3 +1,3 @@ fun a()
             keep
            --- removed line that starts with two dashes
            +++ added line that starts with two pluses
            -old
            +new
            \ No newline at end of file
            diff --git a/y.bin b/y.bin
            Binary files a/y.bin and b/y.bin differ
        """.trimIndent() + "\n"
        val d = GitDiff.parse(text)
        assertEquals(0, d.omitted)
        assertEquals(
            listOf(
                Kind.META, Kind.META, Kind.META, Kind.META, Kind.HUNK, Kind.CONTEXT,
                Kind.DEL, Kind.ADD, Kind.DEL, Kind.ADD, Kind.NOTE, Kind.META, Kind.META
            ),
            d.lines.map { it.kind }
        )
        assertEquals("+++ added line that starts with two pluses", d.lines[7].text)
    }

    @Test
    fun `an untracked file's diff and a CRLF diff read the same way`() {
        // What `git diff --no-index -- /dev/null new.txt` prints, with Windows line endings.
        val text = "diff --git a/new.txt b/new.txt\r\nnew file mode 100644\r\n--- /dev/null\r\n+++ b/new.txt\r\n@@ -0,0 +1 @@\r\n+new file\r\n"
        val d = GitDiff.parse(text)
        assertEquals(listOf(Kind.META, Kind.META, Kind.META, Kind.META, Kind.HUNK, Kind.ADD), d.lines.map { it.kind })
        assertEquals("+new file", d.lines.last().text)
        assertTrue(GitDiff.parse("").isEmpty)
    }

    @Test
    fun `a huge diff is cut to a bounded view that says how much it left out`() {
        val text = "@@ -1 +1 @@\n" + (1..10).joinToString("\n") { "+line $it" } + "\n"
        val d = GitDiff.parse(text, maxLines = 4)
        assertEquals(4, d.lines.size)
        assertEquals(7, d.omitted)

        val long = GitDiff.parse("@@ -1 +1 @@\n+" + "x".repeat(GitDiff.MAX_LINE_CHARS * 2))
        assertEquals(GitDiff.MAX_LINE_CHARS + 2, long.lines[1].text.length, "cut to the cap plus \" …\"")
        assertTrue(long.lines[1].text.endsWith(" …"))
    }

    // ---- what the screen allows ---------------------------------------------------------------------

    private fun status(staged: Int = 0, hasRemote: Boolean = true, hasRepo: Boolean = true) = GitStatus(
        hasRepo = hasRepo, repoName = "", branch = "main", ahead = 0, behind = 0, hasRemote = hasRemote, hasUpstream = hasRemote,
        staged = List(staged) { GitFileChange("f$it", "M", 1, 0) }, changes = emptyList()
    )

    @Test
    fun `a commit needs something staged and a message, which is what the desktop commits`() {
        assertEquals("Stage the changes to commit first.", SourceControl.commitBlocker(status(staged = 0), "msg"))
        assertEquals("Write a commit message.", SourceControl.commitBlocker(status(staged = 1), "   "))
        assertNull(SourceControl.commitBlocker(status(staged = 1), "msg"))
        assertEquals("There is no repository to commit to.", SourceControl.commitBlocker(status(hasRepo = false), "msg"))
        assertEquals("There is no repository to commit to.", SourceControl.commitBlocker(null, "msg"))
    }

    @Test
    fun `push and pull need a remote`() {
        assertNull(SourceControl.syncBlocker(status()))
        assertEquals("This repository has no remote to push to or pull from.", SourceControl.syncBlocker(status(hasRemote = false)))
    }

    @Test
    fun `what a write verb answered is shown as the computer said it`() {
        val stderr = "fatal: pathspec 'x' did not match any files"
        assertEquals(SourceControl.Outcome(error = true, text = stderr), SourceControl.outcome(GitResult(false, stderr)))
        assertEquals(SourceControl.Outcome(error = false, text = "Pushed."), SourceControl.outcome(GitResult(true, "Pushed.")))
        assertNull(SourceControl.outcome(GitResult(true, "")), "staging says nothing on success")
        assertTrue(SourceControl.outcome(GitResult(false, ""))!!.error)
    }

    // ---- whether it can open at all -----------------------------------------------------------------

    private fun project(cwd: String? = "/work/app", ssh: String? = null) =
        ProjectInfo(id = "p1", name = "App", color = null, cwd = cwd, sshTarget = ssh, closed = false, nodes = emptyList(), board = null)

    @Test
    fun `the gate opens on the project's folder through either leg`() {
        assertEquals(Availability.Available("/work/app"), SourceControlGate.of(project(), LegRouting.Leg.Primary))
        assertEquals(Availability.Available("/work/app"), SourceControlGate.of(project(), LegRouting.Leg.Relay))
        // A Windows computer's folder goes as it is: the desktop's jail resolves it, not the phone.
        assertEquals(Availability.Available("C:\\work\\app"), SourceControlGate.of(project("C:\\work\\app"), LegRouting.Leg.Primary))
    }

    @Test
    fun `the gate says why it cannot open, and never sends a request it knows will be refused`() {
        val noLeg = LegRouting.route(
            dev.nodeterm.protocol.host.Capability.GIT, TransportKind.SSH,
            HostCapabilities(boardWrites = false, git = false, nodeActions = false, registerNode = false, answerApprovals = true),
            LegRouting.RelayLeg.NOT_SET_UP
        )
        val reason = assertIs<Availability.Unavailable>(SourceControlGate.of(project(), noLeg)).reason
        assertEquals((noLeg as LegRouting.Leg.Unavailable).reason, reason)
        assertTrue(reason.startsWith("Source control"), reason)

        val ssh = assertIs<Availability.Unavailable>(SourceControlGate.of(project(cwd = null, ssh = "me@box"), LegRouting.Leg.Primary))
        assertTrue(ssh.reason.contains("me@box"), ssh.reason)
        val inline = assertIs<Availability.Unavailable>(SourceControlGate.of(project(cwd = null), LegRouting.Leg.Primary))
        assertTrue(inline.reason.contains("no folder"), inline.reason)
        assertIs<Availability.Unavailable>(SourceControlGate.of(project(cwd = "  "), LegRouting.Leg.Primary))
        assertIs<Availability.Unavailable>(SourceControlGate.of(null, LegRouting.Leg.Primary))

        // A27: a project another desktop drives over SSH has its folder HERE, but its git bridge is that
        // desktop's; this computer's relay would refuse the folder (or worse, answer for its own).
        val driven = assertIs<Availability.Unavailable>(
            SourceControlGate.of(project().copy(drivenRemotely = true), LegRouting.Leg.Relay)
        )
        assertTrue(driven.reason.contains("another computer"), driven.reason)
    }

    // ---- what goes on the wire ----------------------------------------------------------------------

    private class RecordingConn(private val answer: (GitVerb) -> JsonElement?) : HostConnection {
        val calls = mutableListOf<Triple<GitVerb, String, Map<String, JsonElement>>>()
        override val kind = TransportKind.RELAY
        override val capabilities = LegRouting.RELAY_CAPABILITIES
        override suspend fun git(verb: GitVerb, cwd: String, args: Map<String, JsonElement>): JsonElement? {
            calls += Triple(verb, cwd, args)
            return answer(verb)
        }

        override suspend fun listProjects(): ProjectsSnapshot = error("unused")
        override suspend fun attach(nodeId: String, cols: Int, rows: Int, sink: TerminalSink, create: NewSessionHint?): TerminalStream =
            error("unused")
        override suspend fun wake(nodeId: String) { error("unused") }
        override suspend fun refresh(nodeId: String) { error("unused") }
        override suspend fun rename(nodeId: String, title: String) { error("unused") }
        override suspend fun ensureBoard(projectId: String): List<KanbanColumn>? = error("unused")
        override suspend fun setCardColumn(projectId: String, nodeId: String, columnId: String?): Boolean = error("unused")
        override suspend fun editCardLabels(projectId: String, nodeId: String, edit: CardLabelEdit): LabelEditResult? = error("unused")
        override suspend fun registerNode(projectId: String, node: NewNode): Boolean = error("unused")
        override suspend fun answerApproval(event: InboxEvent, allow: Boolean): ApprovalOutcome = error("unused")
        override suspend fun ackRead(nodeId: String, eventId: String?) { error("unused") }
        override suspend fun sendKeys(nodeId: String, keys: String) { error("unused") }
        override fun setOnChanged(listener: (() -> Unit)?) {}
        override fun setOnClosed(listener: ((String?) -> Unit)?) {}
        override fun close() {}
    }

    private val ok = Json.parseToJsonElement("""{"ok":true,"message":""}""")

    @Test
    fun `each verb sends the parameters host-service reads, and only those`() = runBlocking<Unit> {
        val conn = RecordingConn { verb -> if (verb == GitVerb.DIFF) JsonPrimitive("") else ok }
        val git = SourceControl(conn, "/work/app")
        val untracked = GitFileChange("new.txt", "U", 0, 0)
        val changed = GitFileChange("a.ts", "M", 1, 1)
        git.diff(untracked, staged = false)
        git.diff(changed, staged = false)
        git.diff(changed, staged = true)
        git.stage(listOf("a.ts", "new.txt"))
        git.unstage(listOf("a.ts"))
        git.commit("msg")
        git.push()
        git.pull()

        val bool = { b: Boolean -> JsonPrimitive(b) }
        assertEquals(
            listOf(
                GitVerb.DIFF to mapOf("path" to JsonPrimitive("new.txt"), "staged" to bool(false), "untracked" to bool(true)),
                GitVerb.DIFF to mapOf("path" to JsonPrimitive("a.ts"), "staged" to bool(false), "untracked" to bool(false)),
                GitVerb.DIFF to mapOf("path" to JsonPrimitive("a.ts"), "staged" to bool(true), "untracked" to bool(false)),
                GitVerb.STAGE to mapOf("paths" to JsonArray(listOf(JsonPrimitive("a.ts"), JsonPrimitive("new.txt")))),
                GitVerb.UNSTAGE to mapOf("paths" to JsonArray(listOf(JsonPrimitive("a.ts")))),
                GitVerb.COMMIT to mapOf("message" to JsonPrimitive("msg")),
                GitVerb.PUSH to emptyMap(),
                GitVerb.PULL to emptyMap()
            ),
            conn.calls.map { it.first to it.third }
        )
        assertTrue(conn.calls.all { it.second == "/work/app" }, "every verb names the project's folder")
        assertEquals(
            listOf("git.status", "git.diff", "git.stage", "git.unstage", "git.commit", "git.push", "git.pull", "git.history"),
            GitVerb.entries.map { it.wire },
            "the verbs host-service.ts routes to handleGit"
        )
    }

    @Test
    fun `a reply the phone cannot read is said so, never shown as an empty repository`() = runBlocking<Unit> {
        val conn = RecordingConn { JsonPrimitive(42) }
        val git = SourceControl(conn, "/work/app")
        assertFailsWith<HostException> { git.status() }
        assertFailsWith<HostException> { git.history() }
        assertFailsWith<HostException> { git.stage(listOf("a")) }
        assertFailsWith<HostException> { git.diff(GitFileChange("a", "M", 0, 0), staged = false) }
    }

    @Test
    fun `push and pull wait for the remote longer than the usual request`() {
        // The desktop sets no limit on `git push`; a slow remote must not read as a failed push.
        assertEquals(GIT_NETWORK_TIMEOUT_MS, GitVerb.PUSH.timeoutMs)
        assertEquals(GIT_NETWORK_TIMEOUT_MS, GitVerb.PULL.timeoutMs)
        assertTrue(GIT_NETWORK_TIMEOUT_MS > RelaySocket.RPC_TIMEOUT_MS)
        for (v in GitVerb.entries - setOf(GitVerb.PUSH, GitVerb.PULL)) assertEquals(RelaySocket.RPC_TIMEOUT_MS, v.timeoutMs, "$v")
        val relay = java.io.File(InteropHarness.repoRoot, "android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/RelayHostConnection.kt").readText()
        assertTrue(relay.contains("verb.timeoutMs"), "the relay connection must pass the verb's timeout on")
    }

    // ---- the app ------------------------------------------------------------------------------------

    /**
     * The screen cannot run on a JVM, so its wiring is pinned in the source ([AppSourcePins]): it
     * decides from the one routing decision and the gate, and every git call goes through the leg
     * that routing names, so on the LAN it is the relay leg next to SSH, never the SSH connection.
     */
    @Test
    fun `the screen asks the routing and the gate, and sends git through the leg they name`() {
        val screen = AppSourcePins.ui("SourceControlScreen.kt")
        assertTrue(screen.contains("SourceControlGate.of(project, session.route(Capability.GIT))"))
        assertTrue(screen.contains("SourceControl(session.connectionFor(Capability.GIT), dir)"))
        assertFalse(screen.contains("ensureConnected()"), "git must not go to whatever connection is open")
        assertFalse(Regex("""connection\??\.git\(""").containsMatchIn(screen), "git must not go to whatever connection is open")
        // The cwd is the gate's (the project's folder from projects.list), never typed or derived.
        assertTrue(screen.contains("(gate as? SourceControlGate.Availability.Available)?.cwd"))
        // A git failure on the computer, and a refused request, are shown in its own words.
        assertTrue(screen.contains("result?.let(SourceControl::outcome)"))
        assertTrue(screen.contains("e.message ?:"))
    }

    @Test
    fun `the Sessions and Board project headers open it, and the back stack keeps it`() {
        assertTrue(AppSourcePins.ui("SessionsTab.kt").contains("nav.push(Route.SourceControl(hostId, project.id))"))
        assertTrue(AppSourcePins.ui("BoardTab.kt").contains("nav.push(Route.SourceControl(hostId, project.id))"))
        val main = AppSourcePins.app("MainActivity.kt")
        assertTrue(main.contains("is Route.SourceControl -> listOf(\"git\", r.hostId, r.projectId)"))
        assertTrue(main.contains("\"git\" -> if (parts.size == 3) Route.SourceControl(parts[1], parts[2]) else null"))
        assertTrue(main.contains("is Route.SourceControl -> graph.hosts.get(r.hostId) != null"), "a forgotten computer's screen is dropped")
        assertTrue(main.contains("is Route.SourceControl -> SourceControlScreen(nav, r.hostId, r.projectId)"))
    }
}
