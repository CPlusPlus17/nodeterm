package dev.nodeterm.protocol.model

import dev.nodeterm.protocol.model.J.a

/**
 * The terminal screen's Copy sheet (audit A32). tmux runs `mouse on`, so xterm's own selection never
 * runs on the phone, and tmux's copy-mode (which would copy through OSC 52) is out of reach of a touch
 * screen. The sheet is the copy path that depends on neither: the page (terminal.js `nt.copySheet`)
 * hands over the lines its buffer holds (the visible screen; under tmux the alternate screen keeps no
 * scrollback, otherwise up to 500 rows of it) and the http(s) links in them; the user selects lines and
 * copies or shares them, or opens or copies a link.
 *
 * The JSON comes from the page and is read like any other input: a wrong-typed field degrades, and
 * sizes are bounded here too.
 */
object TerminalCopy {
    /** Lines kept from a snapshot, the last ones (the page sends at most 500 rows' worth). */
    const val MAX_LINES = 1_000

    /** Links kept from a snapshot, the last ones (the page sends at most 50). */
    const val MAX_LINKS = 50

    /** A snapshot larger than this is refused unread: 1,000 lines of 1,000 columns, escaped. */
    const val MAX_JSON = 4_000_000

    /**
     * What the page's buffer held: its [lines] (soft wraps joined, each right-trimmed), the http(s)
     * [links] in them, and [firstVisible], the line at the top of the screen the user was looking at
     * (where the sheet opens).
     */
    data class Snapshot(val lines: List<String>, val links: List<ExternalLink>, val firstVisible: Int)

    /** Null when [json] is not a snapshot at all. */
    fun parse(json: String): Snapshot? {
        if (json.length > MAX_JSON) return null
        val o = J.obj(J.parse(json)) ?: return null
        val raw = J.arr(o["lines"]) ?: return null
        val all = raw.map { J.str(it) ?: "" }
        val lines = all.takeLast(MAX_LINES)
        val dropped = all.size - lines.size
        val first = (J.long(o["firstVisible"]) ?: 0L) - dropped
        val firstVisible = first.coerceIn(0L, maxOf(0, lines.size - 1).toLong()).toInt()
        val links = o.a("links").mapNotNull { J.str(it)?.let(ExternalLink::parse) }
            .distinctBy { it.url }
            .takeLast(MAX_LINKS)
        return Snapshot(lines, links, firstVisible)
    }

    /**
     * Which lines are selected. A tap toggles one line and makes it the [anchor]; a long-press selects
     * every line from the anchor to the pressed one (a range, without tapping each line).
     */
    data class Selection(val selected: Set<Int> = emptySet(), val anchor: Int? = null) {
        fun toggle(line: Int): Selection = copy(selected = if (line in selected) selected - line else selected + line, anchor = line)

        fun extendTo(line: Int): Selection {
            val from = anchor ?: return copy(selected = selected + line, anchor = line)
            return copy(selected = selected + (minOf(from, line)..maxOf(from, line)), anchor = line)
        }

        fun all(count: Int): Selection = Selection((0 until count).toSet())

        fun clear(): Selection = Selection()
    }

    sealed interface Text {
        /** Copy or share [text], [lines] lines of it. Never empty and never over [Osc52.MAX_TEXT_CHARS]. */
        data class Copy(val text: String, val lines: Int) : Text

        /** Nothing selected, or only empty lines. */
        data object Empty : Text

        /**
         * Over [Osc52.MAX_TEXT_CHARS]: the clipboard write, like a share, is a binder call whose shared
         * buffer is about 1 MB (audit A53), so the sheet keeps to the OSC 52 copy's cap.
         */
        data object TooLarge : Text
    }

    /** The selected [lines], in screen order whatever order they were selected in, one per line. */
    fun text(lines: List<String>, selection: Selection): Text {
        val picked = selection.selected.filter { it in lines.indices }.sorted()
        if (picked.isEmpty()) return Text.Empty
        var length = picked.size - 1L
        for (i in picked) length += lines[i].length
        if (length > Osc52.MAX_TEXT_CHARS) return Text.TooLarge
        val text = picked.joinToString("\n") { lines[it] }
        if (text.isBlank()) return Text.Empty
        return Text.Copy(text, picked.size)
    }
}
