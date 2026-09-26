package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.TmuxNames

/**
 * The POSIX sh the direct-SSH transport runs on the paired computer. Generated shell, so every
 * interpolation is single-quoted with [q] and every target is checked against the shape this app
 * generates (`nt-[A-Za-z0-9_-]+`) before it is spliced.
 *
 * Three facts about the desktop these encode:
 *  - an ssh exec channel gets a NON-login shell, so Homebrew's tmux is not on PATH on a Mac: the
 *    PATH is APPENDED (never prepended — a PATH that already resolves tmux keeps that binary), the
 *    same rule as `remoteTmuxPathPrologue` in src/shared/ssh.ts; the tmux the macOS app ships
 *    (`Contents/Resources/bin/tmux`) is the last resort, as it is for the desktop's own `findTmux`;
 *  - the desktop's sessions live on the `-L node-terminal` socket (src/core/tmux-naming.ts), and its
 *    generated config is `<userData>/tmux.conf`;
 *  - userData is `~/Library/Application Support/node-terminal` on macOS and
 *    `$XDG_CONFIG_HOME/node-terminal` (default `~/.config/node-terminal`) on Linux: Electron names it
 *    after package.json `name`, and the desktop has no top-level `productName` (the desktop's own
 *    hook shell walks the same dirs, src/core/agents/hook-endpoint-failover-sh.ts). The `nodeterm`
 *    spelling is probed after it as a legacy fallback (audit A02).
 */
object SshScripts {
    const val META_START = "##NT-META"
    const val META_END = "##NT-META-END"
    const val FILE_MARK = "##NT-FILE "

    /** Single-quote for sh: `'` → `'\''`. */
    fun q(s: String): String = "'" + s.replace("'", "'\\''") + "'"

    private val PRELUDE = """
        PATH="${'$'}PATH:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:${'$'}HOME/.local/bin"; export PATH
        NT_TMUX=${'$'}(command -v tmux 2>/dev/null)
        if [ -z "${'$'}NT_TMUX" ]; then
          for c in /Applications/nodeterm.app/Contents/Resources/bin/tmux "${'$'}HOME/Applications/nodeterm.app/Contents/Resources/bin/tmux"; do
            if [ -x "${'$'}c" ]; then NT_TMUX="${'$'}c"; break; fi
          done
        fi
        NT_UD=""
        for d in "${'$'}HOME/Library/Application Support/node-terminal" "${'$'}{XDG_CONFIG_HOME:-${'$'}HOME/.config}/node-terminal" \
                 "${'$'}HOME/Library/Application Support/nodeterm" "${'$'}{XDG_CONFIG_HOME:-${'$'}HOME/.config}/nodeterm"; do
          if [ -f "${'$'}d/workspace.json" ]; then NT_UD="${'$'}d"; break; fi
        done
    """.trimIndent()

    /**
     * A UTF-8 locale for the tmux CLIENT (audit A03). An sshd exec channel on a stock macOS host
     * carries no LANG, and tmux draws every character with no ACS mapping (╭, é, CJK, emoji) as `_`
     * for a client it does not believe is UTF-8. The rule is the desktop's `resolveLocaleLang`
     * (src/core/pty-manager.ts): keep an inherited LC_ALL/LC_CTYPE/LANG that already says UTF-8,
     * otherwise export LANG — `en_US.UTF-8` on macOS (always present, and what the desktop uses),
     * `C.UTF-8` elsewhere (a Linux host may not have en_US generated, and shells would print setlocale
     * warnings). LANG also reaches the panes of a server this attach starts; `-u` on the client makes
     * the rendering UTF-8 even when an explicit non-UTF-8 LC_ALL wins over LANG.
     */
    private val LOCALE = """
        case "${'$'}{LC_ALL:-${'$'}{LC_CTYPE:-${'$'}{LANG:-}}}" in
          *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) ;;
          *) if [ "${'$'}(uname -s 2>/dev/null)" = Darwin ]; then LANG=en_US.UTF-8; else LANG=C.UTF-8; fi; export LANG ;;
        esac
    """.trimIndent()

    /**
     * Browse: emits a meta block, then EXACTLY the `projects.list` blob shape (workspace.json ·
     * live `nt-*` sessions · agent-status.json), so the relay and SSH paths share one parser.
     */
    fun browse(): String = """
        $PRELUDE
        printf '%s\n' '$META_START'
        printf 'ud=%s\n' "${'$'}NT_UD"
        printf 'tmux=%s\n' "${'$'}NT_TMUX"
        printf 'home=%s\n' "${'$'}HOME"
        printf '%s\n' '$META_END'
        if [ -n "${'$'}NT_UD" ]; then cat "${'$'}NT_UD/workspace.json" 2>/dev/null; fi
        printf '\n%s\n' '${ProjectsParser.PROJECTS_MARK}'
        if [ -n "${'$'}NT_TMUX" ]; then "${'$'}NT_TMUX" -L ${TmuxNames.SOCKET} list-sessions -F '#{session_name}' 2>/dev/null; fi
        printf '\n%s\n' '${ProjectsParser.STATUS_MARK}'
        if [ -n "${'$'}NT_UD" ]; then cat "${'$'}NT_UD/agent-status.json" 2>/dev/null; fi
        exit 0
    """.trimIndent()

    /** Cat each file behind a `##NT-FILE <i>` marker (a missing file yields an empty section). */
    fun catFiles(paths: List<String>): String = buildString {
        for ((i, p) in paths.withIndex()) {
            append("printf '\\n%s\\n' '").append(FILE_MARK).append(i).append("'\n")
            append("cat ").append(q(p)).append(" 2>/dev/null\n")
        }
        append("exit 0\n")
    }

    fun hasSession(nodeId: String): String {
        val target = target(nodeId)
        return """
            $PRELUDE
            if [ -n "${'$'}NT_TMUX" ] && "${'$'}NT_TMUX" -L ${TmuxNames.SOCKET} has-session -t ${q("=$target")} 2>/dev/null; then echo yes; else echo no; fi
        """.trimIndent()
    }

    /**
     * Attach a pty to the node's EXISTING session — `attach-session`, never `new-session`: a session
     * created over SSH gets none of the hook environment the desktop gives it (`NODETERM_NODE_ID`,
     * the hook endpoint), so an agent resumed there never reports status, and the desktop never
     * repairs it because tmux reads `-e` only at creation — or it inherits ANOTHER node's id from the
     * tmux server's global env (audit A08). A missing session exits [NO_SESSION_EXIT] instead, and
     * the app offers the relay, where the desktop creates it properly. Without `-d`: the desktop's
     * own client must stay attached (`-d` is what "[detached]" dead terminals are made of).
     */
    fun attach(nodeId: String): String {
        val target = target(nodeId)
        return """
            $PRELUDE
            if [ -z "${'$'}NT_TMUX" ]; then echo 'nodeterm: tmux was not found on this computer.' >&2; exit 127; fi
            "${'$'}NT_TMUX" -L ${TmuxNames.SOCKET} has-session -t ${q("=$target")} 2>/dev/null || exit $NO_SESSION_EXIT
            TERM=xterm-256color; export TERM
            $LOCALE
            exec "${'$'}NT_TMUX" -u -L ${TmuxNames.SOCKET} attach-session -t ${q("=$target")}
        """.trimIndent()
    }

    /** [attach]'s exit status when the node's session is not running. */
    const val NO_SESSION_EXIT = 3

    fun killSession(nodeId: String): String {
        val target = target(nodeId)
        return """
            $PRELUDE
            [ -n "${'$'}NT_TMUX" ] || exit 127
            "${'$'}NT_TMUX" -L ${TmuxNames.SOCKET} kill-session -t ${q("=$target")}
        """.trimIndent()
    }

    /**
     * Type into a pane. `-l --` so text is literal and a leading `-` is never an option (the
     * leading-dash hazard documented in tmux-naming.ts). A lone ESC is sent as the `Escape` key.
     */
    fun sendKeys(nodeId: String, keys: String): String {
        // A PANE target: `=name` alone is refused ("can't find pane", measured on tmux 3.4); the
        // exact-session form for a pane command is `=name:` — the session's current window/pane.
        val pane = q("=" + target(nodeId) + ":")
        val send = when (keys) {
            "\u001b" -> "\"${'$'}NT_TMUX\" -L ${TmuxNames.SOCKET} send-keys -t $pane Escape"
            "\r" -> "\"${'$'}NT_TMUX\" -L ${TmuxNames.SOCKET} send-keys -t $pane Enter"
            else -> "\"${'$'}NT_TMUX\" -L ${TmuxNames.SOCKET} send-keys -t $pane -l -- ${q(keys)}"
        }
        return """
            $PRELUDE
            [ -n "${'$'}NT_TMUX" ] || exit 127
            $send
        """.trimIndent()
    }

    /**
     * Answer a held PermissionRequest hook (docs/hook-reply-approvals.md): write `allow`/`deny` to
     * `~/.nodeterm/pending/<id>.answer` atomically (temp + mv). Prints `gone` when the request file
     * is no longer there — the hook already timed out or someone else answered.
     */
    fun answerApproval(pendingId: String, allow: Boolean): String {
        require(PENDING_ID.matches(pendingId)) { "unsafe pending id" }
        val decision = if (allow) "allow" else "deny"
        return """
            d="${'$'}HOME/.nodeterm/pending"
            if [ ! -f "${'$'}d/$pendingId.json" ]; then echo gone; exit 0; fi
            umask 077
            printf '%s' '$decision' > "${'$'}d/$pendingId.answer.tmp.${'$'}${'$'}" && mv -f "${'$'}d/$pendingId.answer.tmp.${'$'}${'$'}" "${'$'}d/$pendingId.answer" && echo sent
        """.trimIndent()
    }

    /** The read-ack the host's ack sweep consumes (src/core/ack-sweep.ts): content = event id,
     *  atomic, umask 077. The node id becomes a file name, so it is held to the tmux-name alphabet. */
    fun ackRead(nodeId: String, eventId: String): String {
        require(Regex("^[A-Za-z0-9_-]{1,200}$").matches(nodeId)) { "unsafe node id" }
        return """
            d="${'$'}HOME/.nodeterm/acks"
            umask 077
            mkdir -p "${'$'}d" && printf '%s' ${q(eventId)} > "${'$'}d/$nodeId.seen.tmp.${'$'}${'$'}" && mv -f "${'$'}d/$nodeId.seen.tmp.${'$'}${'$'}" "${'$'}d/$nodeId.seen"
        """.trimIndent()
    }

    /** `~/.nodeterm/relay.json` (relay-advertise.ts) for late relay adoption. */
    fun readRelayAdvertisement(): String = "cat \"\$HOME/.nodeterm/relay.json\" 2>/dev/null; exit 0"

    val PENDING_ID = Regex("^[A-Za-z0-9_-]{1,160}$")

    private fun target(nodeId: String): String {
        val t = TmuxNames.sessionName(nodeId)
        require(TmuxNames.isSessionName(t)) { "unsafe session target" }
        return t
    }
}
