package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind

/**
 * The Inbox card actions (docs/mobile-usage-inbox.md "Quick approve", docs/hook-reply-approvals.md),
 * shared by every transport:
 *
 *  1. RE-READ the status before acting, and act only if the node is still waiting on exactly this
 *     (a card can be minutes old; typing `1` into a pane that moved on is typing into whatever is
 *     there now);
 *  2. a held hook-reply approval (it carries a `pendingId`) is answered DETERMINISTICALLY — the
 *     relay verb or the answer file — never with keys: while the hook holds the request, the prompt
 *     is not on screen and a keystroke would land in the agent's composer;
 *  3. only a claude approval with NO ticket falls back to keys (`1` allow / Esc deny), because only
 *     claude's prompt layout is known; anything else is "open the session".
 */
object QuickActions {
    /**
     * [EXPIRED]: the hook's hold ended before the answer arrived (audit A06) and the node still
     * waits, so the prompt is on screen in the session — open it (with an explanation).
     */
    enum class Result { SENT, ALREADY_HANDLED, OPEN_SESSION, EXPIRED }

    suspend fun answerApproval(conn: HostConnection, event: InboxEvent, allow: Boolean): Result {
        if (event.kind != InboxKind.APPROVAL) return Result.OPEN_SESSION
        if (!stillWaiting(conn, event, AgentState.BLOCKED)) return Result.ALREADY_HANDLED
        if (event.pendingId != null && conn.capabilities.answerApprovals) {
            when (conn.answerApproval(event, allow)) {
                ApprovalOutcome.SENT -> return Result.SENT
                // Nothing was written. If the node STILL waits, the hold timed out and the prompt is
                // on screen now: "already handled" would be false — send the user to the session.
                ApprovalOutcome.GONE, ApprovalOutcome.ALREADY_HANDLED ->
                    return if (stillWaiting(conn, event, AgentState.BLOCKED)) Result.EXPIRED else Result.ALREADY_HANDLED
                ApprovalOutcome.UNSUPPORTED -> Unit
            }
        }
        // A ticketed approval we could not answer deterministically: its prompt is not on screen
        // while the hook holds it, so keys are wrong. Send the user to the session instead.
        if (event.pendingId != null) return Result.OPEN_SESSION
        if (event.agentId != "claude") return Result.OPEN_SESSION
        conn.sendKeys(event.nodeId, if (allow) "1" else "\u001b")
        return Result.SENT
    }

    /** AskUserQuestion: choices are digits on screen (a hook cannot inject an answer value). */
    suspend fun answerQuestion(conn: HostConnection, event: InboxEvent, optionIndex: Int): Result {
        if (event.kind != InboxKind.QUESTION || event.multiSelect) return Result.OPEN_SESSION
        if (optionIndex !in event.options.indices || optionIndex > 8) return Result.OPEN_SESSION
        if (!stillWaiting(conn, event, AgentState.WAITING)) return Result.ALREADY_HANDLED
        conn.sendKeys(event.nodeId, (optionIndex + 1).toString())
        return Result.SENT
    }

    private suspend fun stillWaiting(conn: HostConnection, event: InboxEvent, expected: AgentState): Boolean {
        val snap = conn.listProjects()
        val status = snap.statusOf(event.nodeId) ?: return false
        if (status.state != expected) return false
        val fresh = snap.status?.inbox?.events?.firstOrNull { it.id == event.id }
        return fresh == null || !fresh.resolved
    }
}
