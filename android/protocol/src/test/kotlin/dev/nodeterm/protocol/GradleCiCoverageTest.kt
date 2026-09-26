package dev.nodeterm.protocol

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Audit A69: the Gradle/Kotlin build had none of the supply-chain coverage the npm side has. This pins
 * the three pieces that closed it, all in CI config nothing else checks:
 *
 *  1. Every CI job that runs `./gradlew` runs `gradle/actions/setup-gradle` first, with wrapper
 *     validation on: it checks the committed `android/gradle/wrapper/gradle-wrapper.jar` against
 *     Gradle's published checksums before CI executes it. And exactly one job writes the Gradle cache
 *     the jobs share (android.yml says why).
 *  2. CodeQL analyses the Kotlin. A `java-kotlin` analysis with build mode `none` reads Java sources
 *     only, and everything under android/ is Kotlin, so it would scan nothing while looking like
 *     coverage; the Kotlin has to be compiled between CodeQL's `init` and `analyze`.
 *  3. Dependabot watches every Gradle build under android/ exactly once: a build another build
 *     includes is covered by that build's entry (Dependabot follows `includeBuild`), and a second
 *     entry would open each of its bumps twice. Except the builds in [notWatched].
 *
 * The YAML is read as text, in the block style this repo's workflows use, as [WorkflowPathFilterTest]
 * does; what these readers do not understand fails rather than being guessed.
 */
class GradleCiCoverageTest {
    private val workflows = listOf(
        File(InteropHarness.repoRoot, ".github/workflows/android.yml"),
        File(InteropHarness.repoRoot, ".github/workflows/security.yml"),
    )
    private val securityWorkflow = File(InteropHarness.repoRoot, ".github/workflows/security.yml")
    private val dependabot = File(InteropHarness.repoRoot, ".github/dependabot.yml")
    private val androidSettings = File(InteropHarness.repoRoot, "android/settings.gradle.kts")

    /** Gradle builds under android/ that Dependabot deliberately does not watch, with why. */
    private val notWatched = mapOf(
        "android/tools/typecheck" to "the offline type-check is not run by CI, and its pins mirror or stand in " +
            "for the app's, so they move by hand with the app's (see .github/dependabot.yml)",
    )

    @Test
    fun `every job that runs gradlew validates the wrapper first`() {
        var gradleJobs = 0
        for (file in workflows) {
            for ((id, job) in jobs(read(file))) {
                val steps = steps(job)
                val firstGradlew = steps.indexOfFirst(::runsGradlew)
                if (firstGradlew < 0) continue
                gradleJobs++
                val setup = steps.indexOfFirst(::isSetupGradle)
                assertTrue(
                    setup in 0 until firstGradlew,
                    "${file.name} job `$id` runs ./gradlew without a gradle/actions/setup-gradle step before it. That " +
                        "step validates android/gradle/wrapper/gradle-wrapper.jar, a committed binary CI is about " +
                        "to execute (audit A69)."
                )
                assertTrue(
                    steps[setup].none { Regex("""^validate-wrappers:\s*['"]?false""").containsMatchIn(it) },
                    "${file.name} job `$id` turns setup-gradle's wrapper validation off"
                )
            }
        }
        // android.yml's protocol, app and app-release jobs and security.yml's CodeQL (Kotlin) job.
        assertTrue(gradleJobs >= 4, "found only $gradleJobs jobs running ./gradlew; has the reader stopped seeing them?")
    }

    @Test
    fun `exactly one job writes the Gradle cache the jobs share`() {
        // The basic provider's key is the same for every job (a hash of the build files), and the first
        // job to save a key keeps it: with several writers, whichever finished first decided what was
        // cached. The enhanced provider keys per job, so the rule applies to basic steps only.
        val basic = workflows.flatMap { file ->
            jobs(read(file)).flatMap { (id, job) ->
                steps(job).filter { isSetupGradle(it) && value(it, "cache-provider") == "basic" }.map { "${file.name}:$id" to it }
            }
        }
        if (basic.isEmpty()) return
        val writers = basic.filter { (_, step) -> value(step, "cache-read-only") != "true" && value(step, "cache-disabled") != "true" }
        assertEquals(
            1, writers.size,
            "setup-gradle steps with cache-provider: basic that write the shared cache: ${writers.map { it.first }}; " +
                "exactly one may (the others set cache-read-only: true; android.yml says why)"
        )
    }

    @Test
    fun `CodeQL compiles and analyses the app's and the protocol module's Kotlin`() {
        val kotlinJobs = jobs(read(securityWorkflow)).filter { (_, job) ->
            steps(job).any { isCodeqlInit(it) && "java-kotlin" in value(it, "languages").orEmpty() }
        }
        assertEquals(1, kotlinJobs.size, "security.yml must have one CodeQL job for java-kotlin (audit A69)")
        val (id, job) = kotlinJobs.entries.single()
        val steps = steps(job)
        val init = steps.indexOfFirst(::isCodeqlInit)
        val analyze = steps.indexOfFirst { uses(it)?.startsWith("github/codeql-action/analyze@") == true }
        assertTrue(analyze > init, "job `$id`: no github/codeql-action/analyze after init")
        val mode = value(steps[init], "build-mode")
        assertTrue(
            mode == "manual" || mode == "autobuild",
            "job `$id`: build-mode is ${mode ?: "not set"}; for java-kotlin only a build (manual or autobuild) " +
                "extracts Kotlin, and android/ holds no Java to read without one"
        )
        assertTrue(
            job.any { it.trim().replace(" ", "") == "security-events:write" },
            "job `$id` needs security-events: write to upload its results"
        )
        if (mode == "manual") {
            val build = steps.subList(init + 1, analyze).filter(::runsGradlew)
            assertTrue(build.isNotEmpty(), "job `$id`: build-mode manual, but no ./gradlew step between init and analyze")
            val command = build.joinToString(" ") { it.joinToString(" ") }
            assertTrue(Regex("""compile\w*Kotlin""").containsMatchIn(command), "job `$id` does not compile Kotlin: $command")
            // The app is compiled from android/ (the root build); the protocol module comes with it as an
            // included build, or has to be named on its own.
            val app = Regex(""":app:compile\w*Kotlin""").containsMatchIn(command)
            val protocolIncluded = "includeBuild(\"protocol\")" in stripComments(read(androidSettings))
            assertTrue(app, "job `$id` does not compile the app (its Keystore and WebView code): $command")
            assertTrue(
                protocolIncluded || "-p protocol" in command,
                "job `$id` compiles the app, but android/settings.gradle.kts no longer includes the protocol " +
                    "build, so the protocol module's Kotlin is not analysed: $command"
            )
        }
    }

    @Test
    fun `Dependabot watches each Gradle build under android once`() {
        val root = InteropHarness.repoRoot
        val androidDir = androidSettings.parentFile
        val builds = androidDir.walkTopDown()
            .onEnter { it.name != "build" && it.name != ".gradle" && it.name != "node_modules" }
            .filter { it.isFile && it.name.startsWith("settings.gradle") }
            .map { it.parentFile.relativeTo(root).invariantSeparatorsPath }
            .toSortedSet()
        assertTrue("android" in builds && "android/protocol" in builds, "found only these Gradle builds: $builds")

        val directories = gradleDirectories(read(dependabot))
        val covered = directories.flatMap { dir ->
            val build = File(root, dir.removePrefix("/"))
            assertTrue(
                File(build, "settings.gradle.kts").isFile || File(build, "build.gradle.kts").isFile,
                "Dependabot's gradle directory $dir holds no Gradle build"
            )
            coveredBuilds(build).map { it.relativeTo(root).invariantSeparatorsPath }
        }
        for (build in builds) {
            val times = covered.count { it == build }
            val reason = notWatched[build]
            if (reason != null) {
                assertEquals(0, times, "Dependabot watches $build, which is deliberately not watched: $reason")
            } else {
                assertEquals(
                    1, times,
                    "Dependabot's gradle entries (directories $directories) cover the Gradle build $build $times " +
                        "times; it must be exactly once (audit A69: none leaves it without update PRs, two open " +
                        "each of its bumps twice)"
                )
            }
        }
    }

    @Test
    fun `the readers find what they are asked for and refuse what they do not understand`() {
        val workflow = """
            name: x
            on:
              push:
            jobs:
              # a comment
              one:
                runs-on: ubuntu-latest
                permissions:
                  security-events: write
                steps:
                  - uses: actions/checkout@v7
                  # a comment naming ./gradlew
                  - uses: gradle/actions/setup-gradle@v6
                    with:
                      cache-read-only: true
                  - name: Build
                    run: |
                      # a shell comment naming ./gradlew
                      ./gradlew build
              two:
                steps:
                  - name: Build ./gradlew in the name only
                    run: echo nothing
        """.trimIndent()
        val jobs = jobs(workflow)
        assertEquals(listOf("one", "two"), jobs.keys.toList())
        val steps = steps(jobs.getValue("one"))
        assertEquals(3, steps.size)
        assertEquals(listOf(false, false, true), steps.map(::runsGradlew))
        assertEquals("true", value(steps[1], "cache-read-only"))
        assertEquals(listOf(false), steps(jobs.getValue("two")).map(::runsGradlew))

        val config = """
            version: 2
            updates:
              - package-ecosystem: npm
                directory: /
                ignore:
                  - dependency-name: electron
              - package-ecosystem: "gradle"
                directory: '/android'
        """.trimIndent()
        assertEquals(listOf("/android"), gradleDirectories(config))
        assertFailsWith<AssertionError> {
            gradleDirectories("updates:\n  - package-ecosystem: gradle\n    directories:\n      - /android\n")
        }
        assertEquals(
            listOf("protocol", "../x"),
            includedBuilds("// includeBuild(\"commented\")\nincludeBuild(\"protocol\")\n  includeBuild('../x')\ninclude(\":app\")\n")
        )
    }

    companion object {
        private fun read(file: File) = file.readText().replace("\r\n", "\n")

        private fun indent(line: String) = line.length - line.trimStart().length
        private fun skip(line: String) = line.isBlank() || line.trimStart().startsWith("#")

        /** The top-level `jobs:` of a workflow, as each job's non-comment lines (its id line excluded). */
        internal fun jobs(yaml: String): Map<String, List<String>> {
            val lines = yaml.lines()
            val start = lines.indexOfFirst { it.trimEnd() == "jobs:" }
            if (start < 0) throw AssertionError("no top-level `jobs:`")
            val out = LinkedHashMap<String, MutableList<String>>()
            var jobIndent = -1
            for (line in lines.drop(start + 1)) {
                if (skip(line)) continue
                val ind = indent(line)
                if (ind == 0) break
                if (jobIndent < 0) jobIndent = ind
                if (ind == jobIndent) {
                    val id = Regex("""([A-Za-z0-9_-]+):""").matchEntire(line.trim())?.groupValues?.get(1)
                        ?: throw AssertionError("unexpected line in jobs: $line")
                    out[id] = ArrayList()
                } else if (ind > jobIndent) {
                    out.values.last().add(line)
                } else {
                    throw AssertionError("unexpected indentation in jobs: $line")
                }
            }
            return out
        }

        /** A job's steps, each as its trimmed lines (the first without its `- `). */
        internal fun steps(job: List<String>): List<List<String>> {
            val s = job.indexOfFirst { it.trim() == "steps:" }
            if (s < 0) return emptyList()
            val stepsIndent = indent(job[s])
            val out = ArrayList<MutableList<String>>()
            var itemIndent = -1
            for (line in job.drop(s + 1)) {
                if (skip(line)) continue
                val ind = indent(line)
                if (ind <= stepsIndent) break
                if (itemIndent < 0) itemIndent = ind
                val text = line.trim()
                if (ind == itemIndent) {
                    if (!text.startsWith("- ")) throw AssertionError("unexpected line in steps: $line")
                    out.add(arrayListOf(text.removePrefix("- ").trim()))
                } else if (ind > itemIndent) {
                    out.last().add(text)
                } else {
                    throw AssertionError("unexpected indentation in steps: $line")
                }
            }
            return out
        }

        /** The value of `key:` among a step's (or an update entry's) lines, unquoted; null when absent. */
        internal fun value(lines: List<String>, key: String): String? =
            lines.firstOrNull { it.startsWith("$key:") }?.removePrefix("$key:")?.trim()?.removeSurrounding("'")?.removeSurrounding("\"")

        private fun uses(step: List<String>) = value(step, "uses")
        private fun isSetupGradle(step: List<String>) = uses(step)?.startsWith("gradle/actions/setup-gradle@") == true
        private fun isCodeqlInit(step: List<String>) = uses(step)?.startsWith("github/codeql-action/init@") == true

        /** Whether a step's `run:` invokes the wrapper (a step's name does not count). */
        internal fun runsGradlew(step: List<String>): Boolean {
            val run = step.indexOfFirst { it.startsWith("run:") }
            return run >= 0 && step.drop(run).any { "gradlew" in it }
        }

        /** The `directory:` of each `package-ecosystem: gradle` entry of a dependabot.yml. */
        internal fun gradleDirectories(yaml: String): List<String> {
            val lines = yaml.lines().filterNot(::skip)
            val start = lines.indexOfFirst { it.trimEnd() == "updates:" }
            if (start < 0) throw AssertionError("no top-level `updates:`")
            val entries = ArrayList<MutableList<String>>()
            var itemIndent = -1
            for (line in lines.drop(start + 1)) {
                val ind = indent(line)
                if (ind == 0) break
                if (itemIndent < 0) itemIndent = ind
                val text = line.trim()
                if (ind == itemIndent) {
                    if (!text.startsWith("- ")) throw AssertionError("unexpected line in updates: $line")
                    entries.add(arrayListOf(text.removePrefix("- ").trim()))
                } else {
                    entries.last().add(text)
                }
            }
            return entries.filter { value(it, "package-ecosystem") == "gradle" }.map { entry ->
                if (entry.any { it.startsWith("directories:") }) {
                    throw AssertionError("`directories:` is not understood by this reader; extend it")
                }
                value(entry, "directory") ?: throw AssertionError("a gradle entry without a directory: $entry")
            }
        }

        private fun stripComments(kts: String) =
            kts.replace(Regex("""(?s)/\*.*?\*/"""), "").lines().joinToString("\n") { it.replace(Regex("""(^|\s)//.*$"""), "") }

        /** The builds a settings script includes with `includeBuild(...)`, as written (Dependabot's reading). */
        internal fun includedBuilds(settings: String): List<String> =
            Regex("""(?:^|\s)includeBuild\s*\(\s*["']([^"']+)["']\s*\)""").findAll(stripComments(settings)).map { it.groupValues[1] }.toList()

        /** [build] and every build it includes, transitively: what one Dependabot gradle entry covers. */
        private fun coveredBuilds(build: File, seen: MutableSet<File> = HashSet()): List<File> {
            val dir = build.canonicalFile
            if (!seen.add(dir)) return emptyList()
            val settings = listOf("settings.gradle.kts", "settings.gradle").map { File(dir, it) }.firstOrNull { it.isFile }
                ?: return listOf(dir)
            return listOf(dir) + includedBuilds(read(settings)).flatMap { coveredBuilds(File(dir, it), seen) }
        }
    }
}
