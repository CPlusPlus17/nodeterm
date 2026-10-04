package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.host.HostCapabilities
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.HostUnansweredException
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.model.ProjectInfo
import kotlinx.serialization.json.*
import java.util.UUID as JavaUuid

/** Typed, instance-fenced calls to the selected profile's own WorkspaceStore process. */
internal class SshActions(private val execute: (String, Long, String?, Boolean, Int?) -> Pair<Int?, String>) {
    data class Advertisement(val instance: String, val updatedAt: Long, val methods: Set<String>, val remoteProjects: Boolean, val raw: String)
    @Volatile private var advertisement: Advertisement? = null
    @Volatile private var expiresAtNanos = 0L
    val capabilities: HostCapabilities get() {
        val a = advertisement?.takeIf { System.nanoTime() < expiresAtNanos }
        return HostCapabilities(git = false, boardWrites = a?.methods?.containsAll(BOARD) == true,
            nodeActions = a?.methods?.containsAll(NODE) == true, registerNode = false, answerApprovals = true)
    }
    fun clear() { advertisement = null; expiresAtNanos = 0 }
    fun probe(userData: String?): Advertisement? {
        clear()
        if (userData == null || !SshActionsScripts.validProfile(userData)) return null
        val (exit, raw) = execute(SshActionsScripts.probe(userData), 10, null, false, SshActionsScripts.MAX_BYTES + 128)
        if (exit != 0) return null
        val a = parseAdvertisement(raw) ?: return null
        val hostNow = raw.substringBefore('\n').substringAfter('\t').toLongOrNull() ?: return null
        advertisement = a
        expiresAtNanos = System.nanoTime() + (15_000 - (hostNow - a.updatedAt).coerceAtLeast(0)) * 1_000_000
        return a
    }
    fun call(userData: String?, method: String, params: JsonObject, targetId: String, owns: (Advertisement) -> Boolean): JsonElement {
        require(method in ALL)
        val a = probe(userData) ?: unavailable(targetId)
        if (method !in a.methods || !owns(a)) unavailable(targetId)
        val nonce = JavaUuid.randomUUID().toString()
        val request = buildJsonObject {
            put("version", 1); put("instance", a.instance); put("nonce", nonce); put("issuedAt", a.updatedAt)
            put("method", method); put("params", params)
        }.toString()
        require(request.toByteArray(Charsets.UTF_8).size <= SshActionsScripts.MAX_BYTES) { "SSH action is too large." }
        val (exit, raw) = execute(SshActionsScripts.submit(userData!!, a, nonce), 20, request, true, SshActionsScripts.MAX_BYTES + 128)
        if (exit == 3 && raw.trim() == SshActionsScripts.UNAVAILABLE) { clear(); unavailable(targetId) }
        if (exit != 0 || !raw.startsWith("NT-ACTIONS-REPLY\n")) uncertain()
        return parseResponse(raw.removePrefix("NT-ACTIONS-REPLY\n").trimEnd('\n'), a.instance, nonce)
    }
    private fun unavailable(id: String): Nothing = throw NeedsRelayException(id,
        "This desktop profile does not currently serve this action over SSH. Try it through the relay.",
        "This desktop profile does not currently serve this action over SSH.", "perform this action")
    companion object {
        val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        fun owns(projects: List<ProjectInfo>, projectId: String?, nodeId: String?, ad: Advertisement): Boolean {
            val candidates = projects.filter { !it.drivenRemotely && (projectId == null || it.id == projectId) &&
                (nodeId == null || it.nodes.count { n -> n.id == nodeId } == 1) }
            if (nodeId != null && projects.sumOf { p -> p.nodes.count { it.id == nodeId } } != 1) return false
            return candidates.size == 1 && (candidates.single().sshTarget == null || ad.remoteProjects)
        }
        val BOARD = setOf("projects.ensureBoard", "projects.setCardColumn", "projects.editCardLabels")
        val NODE = setOf("node.wake", "node.refresh", "node.rename")
        val ALL = BOARD + NODE
        fun parseAdvertisement(output: String): Advertisement? = runCatching {
            require(output.toByteArray().size <= SshActionsScripts.MAX_BYTES + 128)
            val header = output.substringBefore('\n').split('\t')
            require(header.size == 2 && header[0] == "NT-ACTIONS-1")
            val now = header[1].toLong()
            val raw = output.substringAfter('\n').trimEnd('\n')
            val o = Json.parseToJsonElement(raw).jsonObject
            require(o["version"]?.jsonPrimitive?.let { !it.isString && it.intOrNull == 1 } == true)
            val instance = o.getValue("instance").jsonPrimitive.content; require(UUID.matches(instance))
            require(o.getValue("pid").jsonPrimitive.let { !it.isString && it.long in 1..Int.MAX_VALUE })
            val stamp = o.getValue("updatedAt").jsonPrimitive; require(!stamp.isString)
            val at = stamp.long
            require(at > 0 && now > 0 && at <= now + 30_000 && at >= now - 15_000)
            val methods = o.getValue("methods").jsonArray.map { it.jsonPrimitive.also { p -> require(p.isString) }.content }.toSet()
            val remote = o["remoteProjects"]?.jsonPrimitive?.let { require(!it.isString); it.boolean } ?: false
            Advertisement(instance, at, methods.intersect(ALL), remote, raw)
        }.getOrNull()
        fun parseResponse(raw: String, instance: String, nonce: String): JsonElement {
            val o = runCatching {
                require(raw.toByteArray().size <= SshActionsScripts.MAX_BYTES)
                Json.parseToJsonElement(raw).jsonObject.also {
                    require(it["version"]?.jsonPrimitive?.let { p -> !p.isString && p.intOrNull == 1 } == true && it["instance"]?.jsonPrimitive?.content == instance && it["nonce"]?.jsonPrimitive?.content == nonce)
                    require(it["ok"]?.jsonPrimitive?.let { p -> !p.isString && p.booleanOrNull != null } == true)
                    require(it["uncertain"] == null || it["uncertain"]?.jsonPrimitive?.let { p -> !p.isString && p.booleanOrNull != null } == true)
                }
            }.getOrElse { uncertain() }
            if (o["uncertain"]?.jsonPrimitive?.booleanOrNull == true) uncertain()
            if (o.getValue("ok").jsonPrimitive.boolean) return o["result"] ?: uncertain()
            throw HostException((o["error"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "The desktop refused this action.")
        }
        fun uncertain(): Nothing = throw HostUnansweredException("No confirmed answer came back for this action. Check the computer before repeating it.")
    }
}
