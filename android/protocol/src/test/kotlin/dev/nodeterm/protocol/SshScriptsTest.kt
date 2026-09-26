package dev.nodeterm.protocol

import dev.nodeterm.protocol.ssh.SshScripts
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The generated shell run for real under `/bin/sh` against fake HOMEs laid out the way a desktop
 * lays them out — no SSH involved, so each case can have its own HOME.
 */
class SshScriptsTest {
    private fun sh(script: String, home: File, extraEnv: Map<String, String> = emptyMap()): String {
        val pb = ProcessBuilder("/bin/sh", "-c", script).redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(mapOf("HOME" to home.path, "PATH" to "/usr/bin:/bin") + extraEnv)
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        p.waitFor()
        return out
    }

    private fun udOf(home: File, env: Map<String, String> = emptyMap()): String =
        sh(SshScripts.browse(), home, env).lineSequence().first { it.startsWith("ud=") }.removePrefix("ud=")

    private fun freshHome(): File = Files.createTempDirectory("nt-home").toFile()

    @Test
    fun `the desktop's real userData dir (node-terminal) is found on Linux and macOS layouts`() {
        assumeTrue(File("/bin/sh").canExecute())
        // A02: the desktop's userData is named after package.json `name` = node-terminal.
        val linux = freshHome()
        File(linux, ".config/node-terminal").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(linux, ".config/node-terminal").path, udOf(linux))

        val mac = freshHome()
        File(mac, "Library/Application Support/node-terminal").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(mac, "Library/Application Support/node-terminal").path, udOf(mac))

        val xdg = freshHome()
        val cfg = File(xdg, "cfg")
        File(cfg, "node-terminal").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(cfg, "node-terminal").path, udOf(xdg, mapOf("XDG_CONFIG_HOME" to cfg.path)))
        listOf(linux, mac, xdg).forEach { it.deleteRecursively() }
    }

    @Test
    fun `the legacy nodeterm spelling is a fallback, never preferred`() {
        assumeTrue(File("/bin/sh").canExecute())
        val legacy = freshHome()
        File(legacy, ".config/nodeterm").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(legacy, ".config/nodeterm").path, udOf(legacy))

        val both = freshHome()
        File(both, ".config/nodeterm").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        File(both, ".config/node-terminal").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(both, ".config/node-terminal").path, udOf(both))

        val none = freshHome()
        assertEquals("", udOf(none))
        listOf(legacy, both, none).forEach { it.deleteRecursively() }
    }
}
