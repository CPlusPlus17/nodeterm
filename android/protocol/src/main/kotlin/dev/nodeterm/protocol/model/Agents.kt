package dev.nodeterm.protocol.model

import java.security.SecureRandom

/**
 * The builtin agents, as `AGENT_CONFIG` (src/shared/agents/config.ts) defines them — label, brand
 * colour, launch command — and the two command lines the phone types: a first launch and a resume.
 * The phone never invents a flag the desktop would not emit; where it cannot know a host fact it
 * emits the bare command (the desktop's own degrade direction).
 */
enum class Agent(val id: String, val label: String, val color: String, val launchCmd: String, val resumable: Boolean) {
    CLAUDE("claude", "Claude Code", "#d97757", "claude", true),
    CODEX("codex", "Codex", "#10a37f", "codex", true),
    GEMINI("gemini", "Gemini", "#4285f4", "gemini", true),
    OPENCODE("opencode", "opencode", "#a78bfa", "opencode", true),
    GROK("grok", "Grok", "#64748b", "grok", true),
    COPILOT("copilot", "GitHub Copilot", "#8957e5", "copilot", true);

    companion object {
        fun of(id: String?): Agent? = entries.firstOrNull { it.id == id }
    }
}

object Launch {
    /** `SAFE_SESSION_ID` (config.ts): only this charset ever reaches a command line. */
    private val SAFE_SESSION_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")
    private val PERMISSION_MODES = setOf("manual", "auto", "acceptEdits", "plan", "bypassPermissions")
    private val SAFE_DIR = Regex("^/[^\\u0000-\\u001f'\"`$\\\\]*$")

    /** `resumeCommandWith` (config.ts): each builtin's own resume grammar, or null. */
    fun resumeCommand(agent: Agent, sessionId: String): String? {
        val sid = sessionId.trim()
        if (!agent.resumable || sid.isEmpty() || !SAFE_SESSION_ID.matches(sid)) return null
        return when (agent) {
            Agent.CODEX -> "${agent.launchCmd} resume $sid"
            Agent.OPENCODE -> "${agent.launchCmd} --session $sid"
            Agent.COPILOT -> "${agent.launchCmd} --resume=$sid"
            Agent.CLAUDE, Agent.GEMINI, Agent.GROK -> "${agent.launchCmd} --resume $sid"
        }
    }

    /**
     * A first launch of [agent] on a host whose mirror advertised [settings]. Only CLAUDE gets a
     * permission-mode flag, and only as the desktop would emit it: `manual` = no flag, `auto` only
     * when the HOST's claude supports it (`autoSupported` answers for claude alone), and an unknown
     * value = no flag (the value came from a file; re-validated here like `permissionModeFlag`).
     * Every other agent launches bare — its own default — because the phone does not have the
     * per-agent approval table's host facts (codex's vocabulary moved between releases, #785).
     */
    fun launchCommand(agent: Agent, settings: MirrorSettings?, accountId: String?, cwd: String?): String {
        val parts = ArrayList<String>()
        if (!cwd.isNullOrBlank() && SAFE_DIR.matches(cwd)) parts += "cd '${cwd}' &&"
        val account = accountId?.let { id -> settings?.claudeAccounts?.firstOrNull { it.id == id } }
        if (agent == Agent.CLAUDE && account != null && SAFE_DIR.matches(account.dir)) {
            parts += "CLAUDE_CONFIG_DIR='${account.dir}'"
        }
        parts += agent.launchCmd
        if (agent == Agent.CLAUDE) {
            val mode = settings?.claudePermissionMode?.takeIf { it in PERMISSION_MODES } ?: "manual"
            val emit = when (mode) {
                "manual" -> false
                "auto" -> settings?.autoSupported == true
                else -> true
            }
            if (emit) parts += "--permission-mode $mode"
        }
        return parts.joinToString(" ")
    }

    /** A node id in the desktop's shape (`term-<base36 ms>-<token>`, project-node-append.ts
     *  `SAFE_NODE_ID`), so the host registrar accepts it and it is a boring tmux name. */
    fun newNodeId(now: Long = System.currentTimeMillis(), random: SecureRandom = SecureRandom()): String {
        val token = ByteArray(5).also(random::nextBytes).joinToString("") { "%02x".format(it) }
        return "term-${now.toString(36)}-$token"
    }
}
