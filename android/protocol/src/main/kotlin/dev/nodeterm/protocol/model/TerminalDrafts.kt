package dev.nodeterm.protocol.model

import dev.nodeterm.protocol.host.ComposedCompletion
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Full editor values belong to a live navigation entry, not to its current composition. Kept only
 * in this process: no command text goes into the Activity Bundle or a file. Popping/replacing an
 * entry, forgetting its host, or starting a different stack retires it and releases its value.
 */
class TerminalDrafts<V>(private val empty: V) {
    data class State<V>(val value: V, val revision: Long = 0, val ctrl: CtrlModifier = CtrlModifier())

    class Entry<V> internal constructor(val owner: String, private val empty: V) {
        private val lock = Any()
        private var retired = false
        private val current = MutableStateFlow(State(empty))
        val state: StateFlow<State<V>> = current.asStateFlow()

        /** Even an edit away and back to identical text is a new draft. */
        fun edit(value: V): Boolean = synchronized(lock) {
            if (retired) return false
            current.value = current.value.copy(value = value, revision = current.value.revision + 1)
            true
        }

        fun setCtrl(value: CtrlModifier): Boolean = synchronized(lock) {
            if (retired) return false
            current.value = current.value.copy(ctrl = value)
            true
        }

        /** The callback reads this entry now, including edits accepted before UI recomposition. */
        fun clearUnchangedDraft(sentRevision: Long): Boolean = synchronized(lock) {
            if (retired) return false
            ComposedCompletion.clearUnchangedDraft(sentRevision, current.value.revision) { edit(empty) }
        }

        internal fun retire() = synchronized(lock) {
            retired = true
            current.value = State(empty, current.value.revision + 1)
        }
    }

    private val entries = mutableMapOf<String, Entry<V>>()

    @Synchronized
    fun entry(key: String, owner: String): Entry<V> {
        val previous = entries[key]
        if (previous != null && previous.owner == owner) return previous
        previous?.retire()
        return Entry(owner, empty).also { entries[key] = it }
    }

    /** Reconcile against the whole live stack, including a newly restored or fresh Activity. */
    @Synchronized
    fun retain(keys: Set<String>) {
        val removed = entries.keys.filter { it !in keys }
        removed.forEach { entries.remove(it)?.retire() }
    }

    @Synchronized
    fun retireOwner(owner: String) {
        val removed = entries.filterValues { it.owner == owner }.keys.toList()
        removed.forEach { entries.remove(it)?.retire() }
    }
}
