package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.Launch
import dev.nodeterm.protocol.model.ProjectsParser
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class AgentLaunchInteropTest {
    @TempDir lateinit var scratch: File

    @Test
    fun `real host mirror facts drive Android launch cold resume and wake exactly like desktop`() {
        val vocabularies = listOf("untrusted, on-request, never", "on-request, never", "", "never")
        for ((index, values) in vocabularies.withIndex()) for (auto in listOf(false, true)) {
            val data = File(scratch, "$index-$auto").apply { mkdirs() }
            val help = if (values.isEmpty()) "unknown help" else "  -a, --ask-for-approval <APPROVAL_POLICY>\n    [possible values: $values]\n  --sandbox <SANDBOX>"
            InteropHarness.start("launch-parity", mapOf("FIXTURE_USERDATA" to data.path, "FIXTURE_CODEX_HELP" to help, "FIXTURE_CLAUDE_AUTO" to auto.toString())).use { fixture ->
                val snapshot = ProjectsParser.parseBlob(fixture.ready.getValue("blob").jsonPrimitive.content)
                val settings = assertNotNull(snapshot.status?.settings).let { snapshot.status!!.settings!! }
                assertEquals(auto, settings.autoSupported)
                assertEquals(if (values.isEmpty()) emptyList() else values.split(", "), settings.codexApprovalValues)
                val commands = fixture.ready.getValue("commands").jsonArray
                assertEquals(30, commands.size)
                for (entry in commands) {
                    val row = entry.jsonObject
                    val agent = Agent.of(row.getValue("agent").jsonPrimitive.content)!!
                    val mode = row.getValue("mode").jsonPrimitive.content
                    val host = settings.copy(claudePermissionMode = mode)
                    val launch = row.getValue("launch").jsonPrimitive.content
                    val resume = row.getValue("resume").jsonPrimitive.content
                    assertEquals(launch, Launch.launchCommand(agent, host, null, null), "$values $auto $agent $mode launch")
                    assertEquals(resume, Launch.resumeLine(agent, "interop-session", host, null, null), "$values $auto $agent $mode cold")
                    assertEquals(resume, Launch.wakeLine(agent, "interop-session", host), "$values $auto $agent $mode wake")
                }
            }
        }
    }
}
