package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.QuestionChoices

/**
 * The Inbox card actions (docs/mobile-usage-inbox.md "Quick approve", docs/hook-reply-approvals.md),
 * shared by every transport:
 *
 *  1. RE-READ the status before acting, and act only if what the card asks is still open (a card
 *     can be minutes old; typing `1` into a pane that moved on is typing into whatever is there now);
 *  2. a held hook-reply approval (it carries a `pendingId`) is answered DETERMINISTICALLY — the
 *     relay verb or the answer file — never with keys: while the hook holds the request, the prompt
 *     is not on screen and a keystroke would land in the agent's composer;
 *  3. keys are typed only for a claude approval with NO ticket (`1` allow / Esc deny), because only
 *     claude's prompt layout is known, and for a single-select question (its digit); anything else is
 *     "open the session" (a multi-select question's options are shown, not answered: [QuestionChoices]).
 *
 * What "still open" means differs by path, on purpose (audit A38). KEYS need the node to show
 * exactly the prompt they answer: `1` on a node whose AskUserQuestion picker is on screen picks
 * option 1 of the question instead of approving anything, so a keyed approval needs [AgentState.BLOCKED]
 * and a keyed question [AgentState.WAITING]. A TICKET does not: the desktop publishes a concurrent
 * approval (a subagent's permission) with its `pendingId` while the node keeps the parent's WAITING
 * badge for a held question (`recordAgentEvent`, src/core/agent-status-mirror.ts; pinned by
 * src/core/pending-question.test.ts), so a ticketed answer is judged by its CARD, and the host
 * refuses it ("gone") once the hook's hold has ended.
 *
 * There is deliberately NO "Always allow" here (audit A56), although iOS types `2` for it
 * (docs/hook-reply-approvals.md, "Digit `2`/Always allow keeps using send-keys"). That line is the
 * only place the repo states the digit: no desktop code types it, and no captured prompt pins it.
 * What option 2 IS depends on the ask. Read from the Claude Code 2.1.283 bundle (not run against a
 * live prompt): the Bash prompt is `Yes`, then a "don't ask again" row only when Claude offers one
 * (it is withheld when `suppressAlwaysAllowRule` is set, and feature-gated), then an optional
 * "Yes, and switch to auto mode", then `No`. So a blind `2` can DENY the request or switch the
 * whole session to auto mode, and a ticketed approval has no prompt on screen to type into at all.
 * The phone cannot see the prompt, and a guess must degrade to nothing: docs/android.md "Known
 * gaps" names the layout-independent route (the hook's `updatedPermissions`).
 */
object QuickActions {
    /**
     * [EXPIRED]: the hook's hold ended before the answer arrived (audit A06) and the request is still
     * open, so the prompt is on screen in the session — open it (with an explanation).
     */
    enum class Result { SENT, ALREADY_HANDLED, OPEN_SESSION, EXPIRED }

    suspend fun answerApproval(conn: HostConnection, event: InboxEvent, allow: Boolean): Result {
        if (event.kind != InboxKind.APPROVAL) return Result.OPEN_SESSION
        if (event.pendingId != null) return answerTicket(conn, event, allow)
        if (!stillWaiting(conn, event, AgentState.BLOCKED)) return Result.ALREADY_HANDLED
        if (!answersApproval(event)) return Result.OPEN_SESSION
        return typeOrOpen(conn, event, if (allow) "1" else "\u001b")
    }

    /**
     * Whether [answerApproval] can answer [event] from outside its session at all: a held hook-reply
     * ticket, or a claude prompt (the only prompt layout known). Anything else goes to the session.
     * The Inbox notification offers Approve / Deny by this rule (audit A25), so it never offers an
     * answer this path would turn into "open the session".
     */
    fun answersApproval(event: InboxEvent): Boolean =
        event.kind == InboxKind.APPROVAL && (event.pendingId != null || event.agentId == "claude")

    /**
     * AskUserQuestion: choices are digits on screen (a hook cannot inject an answer value). Only a
     * question [QuestionChoices] lists as [QuestionChoices.Answer] is typed, the rule the Inbox card
     * draws its buttons by. A multi-select question is shown read-only and answered in the session
     * (audit A57): how its picker toggles and submits has not been measured, so it gets no keys.
     */
    suspend fun answerQuestion(conn: HostConnection, event: InboxEvent, optionIndex: Int): Result {
        val choices = QuestionChoices.of(event) as? QuestionChoices.Answer ?: return Result.OPEN_SESSION
        if (optionIndex !in choices.rows.indices || optionIndex > 8) return Result.OPEN_SESSION
        if (!stillWaiting(conn, event, AgentState.WAITING)) return Result.ALREADY_HANDLED
        return typeOrOpen(conn, event, (optionIndex + 1).toString())
    }

    /** A held hook-reply approval: answered through its ticket or not at all — never with keys. */
    private suspend fun answerTicket(conn: HostConnection, event: InboxEvent, allow: Boolean): Result {
        if (!ticketStillOpen(conn.listProjects(), event)) return Result.ALREADY_HANDLED
        if (conn.capabilities.answerApprovals) {
            when (conn.answerApproval(event, allow)) {
                ApprovalOutcome.SENT -> return Result.SENT
                // Nothing was written. If the request is STILL open, the hold timed out and the prompt
                // is on screen now: "already handled" would be false — send the user to the session.
                ApprovalOutcome.GONE, ApprovalOutcome.ALREADY_HANDLED ->
                    return if (ticketStillOpen(conn.listProjects(), event)) Result.EXPIRED else Result.ALREADY_HANDLED
                ApprovalOutcome.UNSUPPORTED -> Unit
            }
        }
        // A ticketed approval we could not answer deterministically: its prompt is not on screen
        // while the hook holds it, so keys are wrong. Send the user to the session instead.
        return Result.OPEN_SESSION
    }

    /** Keys the host could not deliver are not "sent": the prompt is on screen, so open it. A
     *  [NeedsRelayException] propagates — the caller retries through the relay. */
    private suspend fun typeOrOpen(conn: HostConnection, event: InboxEvent, keys: String): Result = try {
        conn.sendKeys(event.nodeId, keys)
        Result.SENT
    } catch (e: NeedsRelayException) {
        throw e
    } catch (_: HostException) {
        Result.OPEN_SESSION
    }

    /** The KEYS gate: the node shows exactly [expected], and the card has not been settled. */
    private suspend fun stillWaiting(conn: HostConnection, event: InboxEvent, expected: AgentState): Boolean {
        val snap = conn.listProjects()
        val status = snap.statusOf(event.nodeId) ?: return false
        if (status.state != expected) return false
        val fresh = freshCard(snap, event)
        return fresh == null || !fresh.resolved
    }

    /**
     * The TICKET gate: the card decides, whatever the node's badge says (a concurrent approval rides a
     * WAITING node). Only when the fresh feed no longer lists the card (the host trims its feed, and a
     * snapshot may carry none) is the node's state the remaining evidence — either needs-you state,
     * since nothing is typed on this path and the host itself refuses a hold that has ended.
     */
    private fun ticketStillOpen(snap: ProjectsSnapshot, event: InboxEvent): Boolean {
        freshCard(snap, event)?.let { return !it.resolved }
        val state = snap.statusOf(event.nodeId)?.state
        return state == AgentState.BLOCKED || state == AgentState.WAITING
    }

    private fun freshCard(snap: ProjectsSnapshot, event: InboxEvent): InboxEvent? =
        snap.status?.inbox?.events?.firstOrNull { it.id == event.id }
}
