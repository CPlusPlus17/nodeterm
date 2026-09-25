package dev.nodeterm.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Runs `src/test/interop/host-fixture.ts` — the DESKTOP's own relay host / pairing code — in a node
 * child process. Skips (never fails) when this checkout has no node or no `npm ci` yet, so a
 * JVM-only contributor still gets a green protocol build; CI installs both and runs everything.
 */
class InteropHarness private constructor(private val process: Process) : AutoCloseable {
    private val lines = LinkedBlockingQueue<JsonObject>()
    private val seen = ArrayList<JsonObject>()
    lateinit var ready: JsonObject
        private set

    private fun startReader() {
        Thread({
            process.inputStream.bufferedReader().forEachLine { line ->
                val obj = runCatching { Json.parseToJsonElement(line).jsonObject }.getOrNull()
                if (obj != null) lines.put(obj) else System.err.println("[fixture] $line")
            }
        }, "interop-stdout").apply { isDaemon = true }.start()
        Thread({
            process.errorStream.bufferedReader().forEachLine { System.err.println("[fixture:err] $it") }
        }, "interop-stderr").apply { isDaemon = true }.start()
    }

    /** Wait for the next event matching [predicate] (earlier non-matching events are kept for later waits). */
    fun await(timeoutMs: Long = 10_000, predicate: (JsonObject) -> Boolean): JsonObject {
        synchronized(seen) {
            seen.firstOrNull(predicate)?.let {
                seen.remove(it)
                return it
            }
        }
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) throw AssertionError("fixture event not seen within ${timeoutMs}ms; saw: ${synchronized(seen) { seen.toList() }}")
            val next = lines.poll(left, TimeUnit.MILLISECONDS) ?: continue
            if (next["event"]?.toString() == "\"fatal\"") throw AssertionError("fixture died: $next")
            if (predicate(next)) return next
            synchronized(seen) { seen.add(next) }
        }
    }

    fun awaitEvent(name: String, timeoutMs: Long = 10_000): JsonObject =
        await(timeoutMs) { it["event"]?.toString() == "\"$name\"" }

    override fun close() {
        process.destroy()
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly()
    }

    companion object {
        val repoRoot: File = File(System.getProperty("nodeterm.repoRoot") ?: "../..").canonicalFile

        private val bundle: File by lazy {
            val out = File(repoRoot, "android/protocol/build/interop/host-fixture.cjs")
            val esbuild = File(repoRoot, "node_modules/.bin/esbuild")
            val proc = ProcessBuilder(
                esbuild.path,
                "android/protocol/src/test/interop/host-fixture.ts",
                "--bundle", "--platform=node", "--format=cjs",
                "--outfile=${out.path}",
                "--external:electron", "--external:ws",
                "--alias:@shared=./src/shared", "--alias:@renderer=./src/renderer",
                "--log-level=warning"
            ).directory(repoRoot).redirectErrorStream(true).start()
            val log = proc.inputStream.bufferedReader().readText()
            check(proc.waitFor() == 0) { "esbuild failed: $log" }
            out
        }

        private fun available(): Boolean {
            val node = runCatching { ProcessBuilder("node", "--version").start().waitFor() == 0 }.getOrDefault(false)
            return node && File(repoRoot, "node_modules/.bin/esbuild").exists() &&
                File(repoRoot, "node_modules/ws").exists() && File(repoRoot, "node_modules/tweetnacl").exists()
        }

        fun start(mode: String, env: Map<String, String> = emptyMap()): InteropHarness {
            assumeTrue(available(), "node + repo node_modules (npm ci) are needed for interop tests")
            val pb = ProcessBuilder("node", bundle.path, mode).directory(repoRoot)
            pb.environment().putAll(env)
            val h = InteropHarness(pb.start())
            h.startReader()
            h.ready = h.await(20_000) { it["ready"] != null }
            return h
        }
    }
}
