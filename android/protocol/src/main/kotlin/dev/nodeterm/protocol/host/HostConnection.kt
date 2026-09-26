package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.KanbanColumn
import dev.nodeterm.protocol.model.KanbanLabel
import dev.nodeterm.protocol.model.ProjectsSnapshot
import kotlinx.serialization.json.JsonElement
import java.io.Closeable

/** Receives one attached terminal's output. Called on a transport thread, in order. */
interface TerminalSink {
    /** The current screen to paint BEFORE any live output (the attach snapshot). */
    fun onPaint(text: String)
    /** Live terminal bytes (UTF-8; a chunk may end mid code point — decode statefully). */
    fun onOutput(bytes: ByteArray)
    /** The host reports the shared pty's real size (a desktop viewer sized it). */
    fun onResized(cols: Int, rows: Int) {}
    /** The pane's process exited, or the attach failed. The stream is gone. */
    fun onExit(code: Int?)
}

/** One phone view of a node's tmux session. Detaching never ends the session. */
interface TerminalStream {
    /** True when the attach had to CREATE the tmux session (cold start: reboot, or a new node). */
    val fresh: Boolean
    fun write(text: String)
    fun resize(cols: Int, rows: Int)
    /** Scroll tmux's own history (its mouse is on): `lines` wheel notches, clamped host-side. */
    suspend fun scroll(up: Boolean, lines: Int)
    /** Stop viewing. The session keeps running. */
    suspend fun detach()
    /** Permanently end the session and take the node off its canvas (the desktop ×). */
    suspend fun endSession()
}

enum class TransportKind { RELAY, SSH }

/** What a connection can do beyond browse + attach; the UI hides what is false and says why. */
data class HostCapabilities(
    val boardWrites: Boolean,
    val git: Boolean,
    val nodeActions: Boolean,
    val registerNode: Boolean,
    /** Can answer a held hook-reply approval (docs/hook-reply-approvals.md) without keystrokes. */
    val answerApprovals: Boolean
)

data class NewNode(val id: String, val title: String?, val agentId: String?, val accountId: String?)

/** `projects.editCardLabels` input (`parseCardLabelEdit` host-side). */
data class CardLabelEdit(
    val add: List<String> = emptyList(),
    val remove: List<String> = emptyList(),
    val create: List<Pair<String, String>> = emptyList()
)

data class LabelEditResult(val edited: Boolean, val labels: List<KanbanLabel>, val cardLabelIds: List<String>)

/**
 * What answering a held approval did. [GONE]: the hook's hold had already ended (it deletes its
 * request file when it times out after ~45 s, or someone else answered), so nothing was written —
 * the interactive prompt may be on screen now. [ALREADY_HANDLED]: a desktop that predates the
 * `reason` field said "not answered" without saying why. [FAILED] is never returned: a failed
 * write throws [HostException] so the UI can offer a retry.
 */
enum class ApprovalOutcome { SENT, GONE, ALREADY_HANDLED, UNSUPPORTED }

/**
 * One live connection to a paired computer, over either transport. Every call is honest about
 * failure: a verb the host does not serve throws [HostException] with the host's own message.
 */
interface HostConnection : Closeable {
    val kind: TransportKind
    val capabilities: HostCapabilities

    suspend fun listProjects(): ProjectsSnapshot

    /**
     * Open a terminal stream on [nodeId]'s session. Cancelling the caller while this is in flight
     * leaves nothing attached: a stream the transport opened anyway (the request was already on the
     * wire, or the blocking open finished) is detached, never handed to anyone (audit A40).
     */
    suspend fun attach(nodeId: String, cols: Int, rows: Int, sink: TerminalSink, create: NewSessionHint? = null): TerminalStream

    suspend fun wake(nodeId: String)
    suspend fun refresh(nodeId: String)
    suspend fun rename(nodeId: String, title: String)

    suspend fun ensureBoard(projectId: String): List<KanbanColumn>?
    suspend fun setCardColumn(projectId: String, nodeId: String, columnId: String?): Boolean
    suspend fun editCardLabels(projectId: String, nodeId: String, edit: CardLabelEdit): LabelEditResult?
    suspend fun registerNode(projectId: String, node: NewNode): Boolean

    /**
     * Answer a held hook-reply approval (one that carries a `pendingId`): the relay's
     * `approvals.answer` verb, or the `.answer` file over SSH. [ApprovalOutcome.UNSUPPORTED] means
     * this host cannot (an older desktop, no pendingId) — the caller falls back to keystrokes only
     * when the prompt is actually on screen.
     */
    suspend fun answerApproval(event: InboxEvent, allow: Boolean): ApprovalOutcome

    /** Tell the computer this phone READ a finished session (clears its unread, archives the card). */
    suspend fun ackRead(nodeId: String, eventId: String?)

    /** Type raw keys into a node's pane (quick approve / answer fallback). */
    suspend fun sendKeys(nodeId: String, keys: String)

    suspend fun git(verb: GitVerb, cwd: String, args: Map<String, JsonElement> = emptyMap()): JsonElement?

    /** Fires when the host signals a change worth a re-list (a canvas push, a reconnect). */
    fun setOnChanged(listener: (() -> Unit)?)
    /** Fires once when the connection drops on its own. */
    fun setOnClosed(listener: ((String?) -> Unit)?)
}

enum class GitVerb(val wire: String) {
    STATUS("git.status"), DIFF("git.diff"), STAGE("git.stage"), UNSTAGE("git.unstage"),
    COMMIT("git.commit"), PUSH("git.push"), PULL("git.pull"), HISTORY("git.history")
}

open class HostException(message: String) : Exception(message)

/**
 * The direct-SSH transport will not do this for [nodeId], and the relay should: the node's tmux
 * session is not running (creating it over SSH would give it no hook environment — audit A08), or
 * the node belongs to one of the desktop's SSH projects and lives on another host (audit A09). The
 * app offers to open it through the relay, where the desktop attaches it properly.
 */
class NeedsRelayException(val nodeId: String, message: String) : HostException(message)

/**
 * For an attach that STARTS a session the phone just created: which project it belongs to, and the
 * account/agent chosen. A current desktop creates the session in that project's folder under that
 * account itself (audit A33 — the phone's `cd`/env launch prefix is POSIX-only and cannot work on a
 * Windows host); an older one ignores it. Direct SSH never creates sessions, so it ignores it too.
 */
data class NewSessionHint(val projectId: String, val accountId: String?, val agentId: String?)
