package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.ssh.NothingFoundException
import kotlinx.coroutines.CancellationException

/** Which cached listing survives a failed refresh, independently of its error message or route. */
object ListingFailure {
    fun snapshot(previous: ProjectsSnapshot, error: Exception): ProjectsSnapshot {
        if (error is CancellationException) throw error
        // SSH found no workspace, driven nodes or phone shells. This is an empty answer, even
        // though A02 still reports where it looked. Other failures cannot prove cached nodes ended.
        return if (error is NothingFoundException) ProjectsSnapshot.EMPTY else previous
    }
}
