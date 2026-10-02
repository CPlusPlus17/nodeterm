package dev.nodeterm.protocol.git

import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.l
import dev.nodeterm.protocol.model.J.o
import dev.nodeterm.protocol.model.J.objects
import dev.nodeterm.protocol.model.J.s
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * One changed file, as the desktop's `GitService.status` reports it (`GitFileChange` in
 * src/shared/types.ts). [status] is git's one letter: `M`, `A`, `D`, `R`, `C`, … and `U` for an
 * UNTRACKED file (the desktop maps porcelain `??` to `U`; it is not git's "unmerged" here).
 */
data class GitFileChange(val path: String, val status: String, val added: Int, val deleted: Int) {
    val untracked: Boolean get() = status == "U"
}

/**
 * `git.status` (`GitStatus` in src/shared/types.ts). A folder that is not a repository answers
 * `hasRepo: false` with nothing else filled in. [changes] holds the working-tree changes AND the
 * untracked files, exactly as the desktop sends them; [unstaged] and [untracked] split them.
 */
data class GitStatus(
    val hasRepo: Boolean,
    val repoName: String,
    /** The current branch, or `HEAD` when detached. */
    val branch: String,
    val ahead: Int,
    val behind: Int,
    /** Any remote at all (a fork may have only `upstream`). */
    val hasRemote: Boolean,
    /** The current branch tracks an upstream (it has been pushed once). */
    val hasUpstream: Boolean,
    val staged: List<GitFileChange>,
    val changes: List<GitFileChange>
) {
    val unstaged: List<GitFileChange> get() = changes.filter { !it.untracked }
    val untracked: List<GitFileChange> get() = changes.filter { it.untracked }
}

/**
 * What a write verb (`git.stage|unstage|commit|push|pull`) answered: `GitResult` in
 * src/shared/types.ts. A git command that FAILED on the computer is an answer, not an RPC error:
 * `ok: false` with git's own message (`stderr`), which the screen shows as it is. Only a refused
 * request (no git bridge, a folder outside the shared roots) is an RPC error, i.e. a
 * [dev.nodeterm.protocol.host.HostException] carrying the host's sentence.
 */
data class GitResult(val ok: Boolean, val message: String)

/** One commit of `git.history` (`GitHistoryItem`, src/shared/git-history-types.ts). */
data class GitCommit(
    val id: String,
    /** The short hash the desktop shows; the first 7 characters of [id] when it sent none. */
    val shortId: String,
    val subject: String,
    val author: String?,
    /** Author time in ms since the epoch (the desktop converts git's seconds). */
    val timestampMs: Long?,
    /** Branch and tag names pointing at this commit. */
    val refs: List<String>
)

/** `git.history` (`GitHistoryResult`): the newest commits of the current branch first. */
data class GitHistory(
    val commits: List<GitCommit>,
    /** More commits exist past the host's limit (50 by default). */
    val hasMore: Boolean,
    val currentRef: String?,
    val remoteRef: String?,
    val hasIncomingChanges: Boolean,
    val hasOutgoingChanges: Boolean
)

/**
 * Reads the bodies the desktop's jailed git bridge sends back (`handleGit` in
 * src/main/remote/host-service.ts, which hands each verb to the real `GitService` in
 * src/core/git-service.ts and responds with its return value). A reply that is not the shape that
 * verb returns is null: the caller says so instead of showing an empty repository that is not
 * there. Field by field the reads are tolerant, like the rest of the phone's parsing. The status
 * fields the screen does not use (`branches`, `remoteBranches`, `hasOrigin`, `ghAvailable`,
 * `ghAuthed`) are left unread: the phone switches no branches and publishes nothing.
 */
object GitReplies {
    fun status(body: JsonElement?): GitStatus? {
        val o = J.obj(body) ?: return null
        val hasRepo = o.b("hasRepo") ?: return null
        return GitStatus(
            hasRepo = hasRepo,
            repoName = o.s("repoName") ?: "",
            branch = o.s("branch") ?: "",
            ahead = o.l("ahead")?.toInt()?.coerceAtLeast(0) ?: 0,
            behind = o.l("behind")?.toInt()?.coerceAtLeast(0) ?: 0,
            hasRemote = o.b("hasRemote") == true,
            hasUpstream = o.b("hasUpstream") == true,
            staged = o.objects("staged").mapNotNull(::change),
            changes = o.objects("changes").mapNotNull(::change)
        )
    }

    private fun change(c: JsonObject): GitFileChange? {
        val path = c.s("path")?.takeIf { it.isNotEmpty() } ?: return null
        return GitFileChange(
            path = path,
            status = c.s("status")?.takeIf { it.isNotEmpty() } ?: "M",
            added = c.l("added")?.toInt()?.coerceAtLeast(0) ?: 0,
            deleted = c.l("deleted")?.toInt()?.coerceAtLeast(0) ?: 0
        )
    }

    /** `git.diff` answers the diff text itself (a JSON string); empty when there is nothing to show. */
    fun diff(body: JsonElement?): String? = J.str(body)

    fun result(body: JsonElement?): GitResult? {
        val o = J.obj(body) ?: return null
        val ok = o.b("ok") ?: return null
        return GitResult(ok, o.s("message") ?: "")
    }

    fun history(body: JsonElement?): GitHistory? {
        val o = J.obj(body) ?: return null
        if (o["items"] !is JsonArray) return null
        return GitHistory(
            commits = o.objects("items").mapNotNull { c ->
                val id = c.s("id")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                GitCommit(
                    id = id,
                    shortId = c.s("displayId")?.takeIf { it.isNotEmpty() } ?: id.take(7),
                    subject = c.s("subject") ?: "",
                    author = c.s("author")?.takeIf { it.isNotBlank() },
                    timestampMs = c.l("timestamp")?.takeIf { it > 0 },
                    refs = c.objects("references").mapNotNull { it.s("name")?.takeIf(String::isNotEmpty) }
                )
            },
            hasMore = o.b("hasMore") == true,
            currentRef = o.o("currentRef")?.s("name"),
            remoteRef = o.o("remoteRef")?.s("name"),
            hasIncomingChanges = o.b("hasIncomingChanges") == true,
            hasOutgoingChanges = o.b("hasOutgoingChanges") == true
        )
    }
}
