package dev.nodeterm.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Audit A63: `.github/workflows/android.yml` runs only when a changed file matches the `paths` filter
 * of its `push` or `pull_request` trigger. The interop tests run the desktop's own code, bundled from
 * `host-fixture.ts`, so a change to any file in that bundle changes what they test. The first filter
 * covered `android/`, `src/main/remote/` and the `src/main/pairing-*.ts` files only: 35 of the 49 desktop
 * sources in the bundle (all of src/core and src/shared, and `src/main/windows-ssh-keys.ts`) could
 * change with no Android run at all.
 *
 * This reads the inputs of the very bundle the interop tests run (the bundler writes esbuild's
 * metafile beside it) and checks that both filters match each one, plus the files the workflow uses
 * without bundling them. It holds by induction: a change that adds a file to the bundle has to edit a
 * file already in it (an import), the bundler's aliases (under android/) or tsconfig.json, so it runs
 * the workflow, and this test then fails until the new path is listed.
 *
 * The filter semantics are GitHub's (`*` stays within one path segment, `**` crosses them); syntax this
 * reader does not implement is refused rather than guessed.
 */
class WorkflowPathFilterTest {
    private val root = InteropHarness.repoRoot
    private val workflowPath = ".github/workflows/android.yml"
    private val workflow by lazy { File(root, workflowPath).readText().replace("\r\n", "\n") }
    private val triggers = listOf("push", "pull_request")

    /**
     * Files the workflow depends on that are not in the bundle's metafile, with why:
     * - tsconfig.json: esbuild applies the root tsconfig's compilerOptions to every file it bundles
     *   (it does not follow the references, so tsconfig.node.json is not read);
     * - package.json, package-lock.json: `npm ci` installs esbuild, ws and tweetnacl from them, and
     *   they stand in for every node_modules input of the bundle;
     * - the workflow file itself.
     */
    private val unbundledInputs = listOf("tsconfig.json", "package.json", "package-lock.json", workflowPath)

    @Test
    fun `every file the fixture bundle is built from runs the workflow`() {
        assumeTrue(InteropHarness.available(), "node + repo node_modules (npm ci) are needed for interop tests")
        // Reading it builds the bundle first; the bundler writes the metafile beside it.
        val meta = Json.parseToJsonElement(InteropHarness.bundleMeta.readText()).jsonObject
        val inputs = meta.getValue("inputs").jsonObject.keys
        assertTrue(inputs.any { it.startsWith("src/main/remote/") }, "the metafile names no desktop source: $inputs")
        val required = inputs.map { input ->
            if (input.startsWith("node_modules/")) {
                "package-lock.json"
            } else {
                assertTrue(File(root, input).isFile, "metafile input $input is not a repo file")
                input
            }
        }.toSortedSet()
        assertCovered(required, "bundled into host-fixture.ts")
    }

    @Test
    fun `the files the workflow uses without bundling them run it`() {
        // Repo files the protocol tests read by a literal path (ResumeOfferTest reads a src/shared file).
        val testSources = File(root, "android/protocol/src/test/kotlin")
        val literalReads = testSources.walkTopDown().filter { it.extension == "kt" }.flatMap { file ->
            Regex("""File\(\s*InteropHarness\.repoRoot\s*,\s*"([^"$]+)"\s*\)""").findAll(file.readText()).map { it.groupValues[1] }
        }.toSortedSet()
        assertTrue(literalReads.isNotEmpty(), "found no File(InteropHarness.repoRoot, \"…\") read in $testSources")
        val required = (unbundledInputs + literalReads).toSortedSet()
        for (path in required) assertTrue(File(root, path).exists(), "$path does not exist; update this test")
        assertCovered(required, "read by the workflow or its tests")
    }

    @Test
    fun `the glob matcher follows GitHub's path filter syntax`() {
        assertTrue(globRegex("android/**").matches("android/protocol/src/test/interop/host-fixture.ts"))
        assertTrue(globRegex("src/main/*.ts").matches("src/main/windows-ssh-keys.ts"))
        assertFalse(globRegex("src/main/*.ts").matches("src/main/remote/host-service.ts"), "* must not cross /")
        assertFalse(globRegex("src/main/pairing-*.ts").matches("src/main/windows-ssh-keys.ts"))
        assertFalse(globRegex("tsconfig.json").matches("tsconfigXjson"), ". is literal")
        assertFalse(globRegex("tsconfig.json").matches("sub/tsconfig.json"), "a pattern is anchored")
        for (bad in listOf("src/**/*.ts?", "src/[ab].ts", "!src/**", "src/+.ts", "src/{a,b}.ts")) {
            assertFailsWith<IllegalArgumentException>(bad) { globRegex(bad) }
        }
    }

    @Test
    fun `the filter reader finds each trigger's paths and nothing else`() {
        val yaml = """
            name: x
            # a comment
            on:
              push:
                branches: [main]
                paths:
                  # a comment inside the list
                  - 'a/**'

                  - "b/*.ts"
                  - c.json
              pull_request:
              workflow_dispatch:
            jobs:
              paths:
                - 'not/a/trigger'
        """.trimIndent()
        assertEquals(listOf("a/**", "b/*.ts", "c.json"), pathFilter(yaml, "push"))
        assertNull(pathFilter(yaml, "pull_request"), "a trigger without paths runs on every change")
        assertFailsWith<AssertionError> { pathFilter(yaml, "merge_group") }
        val ignoring = "on:\n  push:\n    paths-ignore:\n      - 'docs/**'\n"
        assertFailsWith<AssertionError> { pathFilter(ignoring, "push") }
    }

    private fun assertCovered(required: Set<String>, what: String) {
        for (trigger in triggers) {
            val patterns = pathFilter(workflow, trigger) ?: continue // no filter: every change runs it
            val regexes = patterns.map { globRegex(it) }
            val missed = required.filter { path -> regexes.none { it.matches(path) } }
            assertTrue(
                missed.isEmpty(),
                "$workflowPath: the $trigger paths filter does not match these files $what, so a change to " +
                    "one runs no Android test (audit A63). Add them (or a glob) to the push and pull_request " +
                    "paths and to the comment above them:\n  ${missed.joinToString("\n  ")}"
            )
        }
    }

    companion object {
        /**
         * The `paths:` list of [trigger] under the workflow's top-level `on:`, or null when the trigger
         * has none (it then runs on every change). Only the block style this repo's workflows use is
         * understood; `paths-ignore` is refused.
         */
        internal fun pathFilter(yaml: String, trigger: String): List<String>? {
            fun indent(line: String) = line.length - line.trimStart().length
            fun skip(line: String) = line.isBlank() || line.trimStart().startsWith("#")
            val lines = yaml.lines()
            val on = lines.indexOfFirst { it.trimEnd() == "on:" }
            if (on < 0) throw AssertionError("no top-level `on:` block")
            var i = on + 1
            var triggerIndent = -1
            while (i < lines.size) {
                val line = lines[i]
                if (!skip(line)) {
                    if (indent(line) == 0) break
                    if (line.trim() == "$trigger:") {
                        triggerIndent = indent(line)
                        break
                    }
                }
                i++
            }
            if (triggerIndent < 0) throw AssertionError("no `$trigger:` trigger under `on:`")
            var paths: MutableList<String>? = null
            var pathsIndent = -1
            i++
            while (i < lines.size) {
                val line = lines[i]
                i++
                if (skip(line)) continue
                val ind = indent(line)
                if (ind <= triggerIndent) break
                val text = line.trim()
                if (paths != null && ind > pathsIndent) {
                    if (!text.startsWith("- ")) throw AssertionError("unexpected line in the $trigger paths list: $line")
                    paths.add(text.removePrefix("- ").trim().removeSurrounding("'").removeSurrounding("\""))
                    continue
                }
                if (text.startsWith("paths-ignore:")) throw AssertionError("paths-ignore is not understood by this reader")
                if (text == "paths:") {
                    paths = ArrayList()
                    pathsIndent = ind
                } else if (text.startsWith("paths:")) {
                    throw AssertionError("only a block `paths:` list is understood: $line")
                }
            }
            return paths
        }

        /** A GitHub Actions path pattern as a regex over a repo-relative, `/`-separated path. */
        internal fun globRegex(pattern: String): Regex {
            val unsupported = pattern.firstOrNull { it in "?+[]!{}" }
            require(unsupported == null) { "path filter syntax '$unsupported' in $pattern is not implemented here" }
            val out = StringBuilder()
            var i = 0
            while (i < pattern.length) {
                if (pattern.startsWith("**", i)) {
                    out.append(".*")
                    i += 2
                } else if (pattern[i] == '*') {
                    out.append("[^/]*")
                    i++
                } else {
                    out.append(Regex.escape(pattern[i].toString()))
                    i++
                }
            }
            return Regex(out.toString())
        }
    }
}
