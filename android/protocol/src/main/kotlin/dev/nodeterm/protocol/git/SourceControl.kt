package dev.nodeterm.protocol.git

import dev.nodeterm.protocol.host.GitVerb
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.model.ProjectInfo
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * The project's source control over the desktop's typed, jailed git bridge (audit A29): the `git.*`
 * verbs `createHostHandlers` serves (src/main/remote/host-service.ts), each one handed to the real
 * `GitService` in src/core/git-service.ts. There is no free-form git: the phone can read the status,
 * a file's diff and the recent history, stage and unstage files, commit what is staged, and push or
 * pull the current branch, which is what the bridge serves and nothing more.
 *
 * [cwd] is the project's folder as `projects.list` names it. The desktop refuses any other folder
 * ("cwd is outside the shared project roots."), and a desktop without the bridge refuses every verb
 * ("git is not served on this host."); both arrive as a [HostException] carrying that sentence, for
 * the screen to show as it is.
 *
 * Over direct SSH the verbs go through the relay leg next to the SSH connection (audit A26,
 * [LegRouting]); the SSH transport has no git of its own.
 */
class SourceControl(private val conn: HostConnection, val cwd: String) {
    suspend fun status(): GitStatus = GitReplies.status(conn.git(GitVerb.STATUS, cwd)) ?: throw unreadable()

    /**
     * The diff of [file] on one side: [staged] = the index against HEAD (`--cached`), else the working
     * tree against the index, or the whole file for an untracked one.
     */
    suspend fun diff(file: GitFileChange, staged: Boolean): GitDiff {
        val body = conn.git(
            GitVerb.DIFF, cwd,
            mapOf(
                "path" to JsonPrimitive(file.path),
                "staged" to JsonPrimitive(staged),
                "untracked" to JsonPrimitive(!staged && file.untracked)
            )
        )
        return GitDiff.parse(GitReplies.diff(body) ?: throw unreadable())
    }

    suspend fun stage(paths: List<String>): GitResult = write(GitVerb.STAGE, mapOf("paths" to JsonArray(paths.map(::JsonPrimitive))))

    suspend fun unstage(paths: List<String>): GitResult = write(GitVerb.UNSTAGE, mapOf("paths" to JsonArray(paths.map(::JsonPrimitive))))

    /** Commits what is STAGED (the desktop adds nothing on its own). */
    suspend fun commit(message: String): GitResult = write(GitVerb.COMMIT, mapOf("message" to JsonPrimitive(message)))

    /** `git push`; a branch with no upstream is pushed to `origin` with `-u` by the desktop. */
    suspend fun push(): GitResult = write(GitVerb.PUSH)

    suspend fun pull(): GitResult = write(GitVerb.PULL)

    suspend fun history(): GitHistory = GitReplies.history(conn.git(GitVerb.HISTORY, cwd)) ?: throw unreadable()

    private suspend fun write(verb: GitVerb, args: Map<String, JsonElement> = emptyMap()): GitResult =
        GitReplies.result(conn.git(verb, cwd, args)) ?: throw unreadable()

    private fun unreadable() = HostException("The computer's answer to a source-control request could not be read.")

    companion object {
        /**
         * Why a commit cannot be made yet, or null when it can. The desktop commits only what is
         * staged and refuses an empty message ("Commit message is empty."); the button says so first.
         */
        fun commitBlocker(status: GitStatus?, message: String): String? = when {
            status == null || !status.hasRepo -> "There is no repository to commit to."
            status.staged.isEmpty() -> "Stage the changes to commit first."
            message.isBlank() -> "Write a commit message."
            else -> null
        }

        /** Why Push and Pull cannot run, or null when they can. */
        fun syncBlocker(status: GitStatus?): String? = when {
            status == null || !status.hasRepo -> "There is no repository."
            !status.hasRemote -> "This repository has no remote to push to or pull from."
            else -> null
        }

        /**
         * What the screen says after a write verb: git's own message as the desktop returned it, as an
         * error when the command failed there. A success that said nothing (staging) says nothing.
         */
        fun outcome(result: GitResult): Outcome? = when {
            !result.ok -> Outcome(error = true, text = result.message.ifBlank { "git failed on the computer." })
            result.message.isBlank() -> null
            else -> Outcome(error = false, text = result.message)
        }
    }

    data class Outcome(val error: Boolean, val text: String)
}

/**
 * Whether a project's source control can be opened from the phone at all, and if not, why — decided
 * before any request, so a control can say it instead of failing on a tap (audit A29).
 */
object SourceControlGate {
    sealed interface Availability {
        /** Open it: [cwd] is the project's folder on the computer. */
        data class Available(val cwd: String) : Availability
        data class Unavailable(val reason: String) : Availability
    }

    /**
     * [leg] is where `git.*` goes right now (`LegRouting.route(Capability.GIT, …)`).
     *
     * An SSH project of the desktop is refused here rather than by the host: its folder is on another
     * machine (the desktop's own Source Control reaches it over its ControlMaster), the listing does
     * not carry that folder's path, and the bridge's jail is the computer's own project folders.
     */
    fun of(project: ProjectInfo?, leg: LegRouting.Leg): Availability {
        if (project == null) return Availability.Unavailable("This project is no longer on the computer.")
        project.sshTarget?.let {
            return Availability.Unavailable(
                "This project's folder is on $it, which the computer reaches over SSH. Source control from the " +
                    "phone covers folders on the computer itself; use Source Control in nodeterm on the computer."
            )
        }
        val cwd = project.cwd?.takeIf { it.isNotBlank() }
            ?: return Availability.Unavailable("This project has no folder on the computer, so it has no repository.")
        return when (leg) {
            is LegRouting.Leg.Unavailable -> Availability.Unavailable(leg.reason)
            LegRouting.Leg.Primary, LegRouting.Leg.Relay -> Availability.Available(cwd)
        }
    }
}
