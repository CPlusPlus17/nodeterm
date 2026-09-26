package dev.nodeterm.protocol.model

/**
 * What an Inbox question card shows under the question (audit A57), and the one rule
 * [dev.nodeterm.protocol.host.QuickActions.answerQuestion] answers by, so the card never offers an
 * answer the action would refuse.
 *
 * A single-select AskUserQuestion is answered from the card: row N types the digit N into the picker.
 * A MULTI-select one (`multiSelect`, which the desktop publishes beside the options so the phone can
 * show them: src/core/agent-status-mirror.ts, src/core/push-notify.ts) is NOT. Nothing in this repo
 * measures how Claude Code's multi-select picker toggles an option or submits the selection, and a
 * guessed key sequence typed into a picker the phone cannot see could submit the wrong set, or none.
 * Its options are still shown, numbered and read-only, under a line that says the question takes
 * several and is answered in the session: before this the card showed only "Open session", so it
 * did not say what was being asked. Answering from the Inbox waits for the picker's keys to be
 * measured on a live CLI, and would keep the still-waiting re-check `QuickActions` does before typing.
 */
sealed interface QuestionChoices {
    /** Each row is a quick answer: tapping row i types the digit i + 1 (`QuickActions.answerQuestion`). */
    data class Answer(val rows: List<String>) : QuestionChoices

    /** The picker takes several options: the rows are shown under [SEVERAL_NOTE] and never answered. */
    data class ReadOnly(val rows: List<String>) : QuestionChoices

    /** No options to show: an approval, a finished turn, or a question the desktop sent without a picker. */
    data object None : QuestionChoices

    companion object {
        /** Marks a [ReadOnly] card: its rows are not buttons, and the answer is given in the session. */
        const val SEVERAL_NOTE = "Choose several — answer in the session."

        fun of(event: InboxEvent): QuestionChoices {
            if (event.kind != InboxKind.QUESTION || event.options.isEmpty()) return None
            // Numbered in the order the question lists them (the desktop keeps that order).
            val rows = event.options.mapIndexed { i, option -> "${i + 1}. $option" }
            return if (event.multiSelect) ReadOnly(rows) else Answer(rows)
        }
    }
}
