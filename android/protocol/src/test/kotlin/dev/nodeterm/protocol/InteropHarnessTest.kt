package dev.nodeterm.protocol

import org.junit.jupiter.api.Assumptions.assumeTrue
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The interop harness itself (audit A60). The fixture must not load the real `electron` package,
 * whose first `require` downloads the Electron binary when it is missing (after any fresh `npm ci`),
 * inside the harness's ready wait. And a start whose ready wait fails must not leave the node process
 * behind: the caller never receives a handle to close.
 */
class InteropHarnessTest {
    private val needs = "node + repo node_modules (npm ci) are needed for interop tests"

    @Test
    fun `the fixture bundle resolves electron to the stub and never requires the package`() {
        assumeTrue(InteropHarness.available(), needs)
        val source = InteropHarness.bundle.readText()
        assertFalse(
            Regex("""require\(\s*["']electron["']\s*\)""").containsMatchIn(source),
            "the bundle requires the real electron package; alias it to ${InteropHarness.ELECTRON_STUB}"
        )
        assertTrue(
            source.contains("is not available in the Android interop fixture"),
            "the bundle does not carry ${InteropHarness.ELECTRON_STUB}"
        )
    }

    @Test
    fun `a start whose ready wait fails kills the fixture process`() {
        assumeTrue(InteropHarness.available(), needs)
        var spawned: Process? = null
        try {
            val err = assertFailsWith<AssertionError> {
                InteropHarness.start("never-ready", readyTimeoutMs = 500, onSpawn = { spawned = it })
            }
            assertTrue(err.message.orEmpty().contains("not seen within 500ms"), err.message)
            val process = assertNotNull(spawned, "the fixture was never spawned")
            assertFalse(process.isAlive, "a failed start left the node process running")
        } finally {
            spawned?.destroyForcibly()
        }
    }
}
