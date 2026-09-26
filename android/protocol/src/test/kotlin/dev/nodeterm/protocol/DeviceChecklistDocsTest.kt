package dev.nodeterm.protocol

import org.junit.jupiter.api.Assumptions
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * What the docs admit about the app that has never run on a phone, pinned against the files that make
 * it true:
 *
 *  - Audit A65: android/README.md marked every feature ✓ with no word that nothing had been checked on
 *    a device, and docs/android.md had no device checklist, although CLAUDE.md asks for a numbered one
 *    for whatever could not be run. The checklist must exist, be numbered, name the finding each item
 *    checks, and cover every finding the design notes leave to a device ("a device check", "only
 *    type-checked", "on a device"); the README's feature table must point at it.
 *  - Audit A50: the only APK to install is the debug build, which AGP marks debuggable, so adb access
 *    to the phone yields its pairing credentials. While the release build type has no signing config
 *    (so there is no release to install instead), the README must say so.
 *
 * The audit and the handover are logs, so only the audit's section headings are read (for the ids).
 */
class DeviceChecklistDocsTest {
    // Read by literal paths, so WorkflowPathFilterTest makes the Android workflow run when one changes.
    private val notes = read(File(InteropHarness.repoRoot, "docs/android.md"))
    private val readme = read(File(InteropHarness.repoRoot, "android/README.md"))

    @Test
    fun `the device checklist is numbered from 1 and every item names a finding the audit has`() {
        val items = checklistItems()
        assertTrue(
            items.size >= 23,
            "the checklist has ${items.size} items; it started from the handover's 23, so has it been gutted?"
        )
        assertEquals((1..items.size).toList(), items.map { it.first }, "checklist items must be numbered 1, 2, 3, … in order")
        val known = auditIds()
        for ((n, text) in items) {
            val ids = findingIds(text)
            assertTrue(ids.isNotEmpty(), "checklist item $n names no audit finding (A65 marks a baseline check):\n$text")
            val unknown = ids - known
            assertTrue(unknown.isEmpty(), "checklist item $n names $unknown, which the audit does not have:\n$text")
        }
    }

    @Test
    fun `every finding the design notes leave to a device has a checklist item`() {
        val listed = checklistItems().flatMap { findingIds(it.second) }.toSet()
        val outside = notes.replace(checklistSection(), "")
        var deferring = 0
        for (paragraph in outside.split(Regex("""\n\s*\n"""))) {
            if (!leftToDevice.containsMatchIn(paragraph)) continue
            deferring++
            val missing = findingIds(paragraph) - listed
            assertTrue(
                missing.isEmpty(),
                "docs/android.md leaves $missing to a device, but the device checklist has no item for it:\n$paragraph"
            )
        }
        // The notes defer the ⌨ chip, Settings back, the lock screen, live notifications, device
        // transfer, the keyboard insets and more; if none is found, the reader has stopped seeing them.
        assertTrue(deferring >= 6, "found only $deferring paragraphs that leave something to a device")
    }

    @Test
    fun `the README's feature table points at the device checklist`() {
        assertTrue(
            notes.lines().any { it == "## Device checklist" },
            "docs/android.md has no `## Device checklist` heading, which the README's #device-checklist link needs"
        )
        val section = section(readme, "## What it does")
        val table = section.indexOf("\n|")
        assertTrue(table >= 0, "android/README.md's \"What it does\" has no table")
        assertTrue(
            section.substring(0, table).contains("../docs/android.md#device-checklist"),
            "android/README.md's feature table must say, before its first row, that no row has been checked on " +
                "a device, and link the device checklist (audit A65):\n$section"
        )
    }

    @Test
    fun `while no release build is signed, the README says the debug APK is debuggable`() {
        val gradle = read(File(InteropHarness.repoRoot, "android/app/build.gradle.kts")).lines().joinToString("\n") { it.substringBefore("//") }
        val release = AppSourcePins.blockAfter(gradle, "release {")
        Assumptions.assumeFalse(
            Regex("""\bsigningConfig\b""").containsMatchIn(release),
            "the release build type is signed now: point the README at the release instead of this warning"
        )
        val security = section(readme, "## Security")
        assertTrue(
            Regex("""debuggable""").containsMatchIn(security) && "run-as" in security,
            "android/README.md's Security section must warn that the debug APK is debuggable, so adb access " +
                "(`run-as`, a debugger) yields the phone's pairing credentials (audit A50):\n$security"
        )
    }

    /** (number, text) for each item of docs/android.md's device checklist, continuation lines included. */
    private fun checklistItems(): List<Pair<Int, String>> {
        val items = mutableListOf<Pair<Int, StringBuilder>>()
        var open = false
        for (line in checklistSection().lines()) {
            val start = itemStart.find(line)
            when {
                start != null -> {
                    items += start.groupValues[1].toInt() to StringBuilder(line)
                    open = true
                }
                open && line.isNotBlank() && line.first().isWhitespace() -> items.last().second.append('\n').append(line)
                else -> open = false
            }
        }
        if (items.isEmpty()) fail("docs/android.md's device checklist has no numbered items")
        return items.map { it.first to it.second.toString() }
    }

    private fun checklistSection(): String = section(notes, "## Device checklist")

    /** From the line [heading] to the next `## ` heading (subsections included). */
    private fun section(text: String, heading: String): String {
        val start = text.lines().indexOf(heading)
        if (start < 0) fail("no `$heading` heading")
        val lines = text.lines()
        val end = (start + 1 until lines.size).firstOrNull { lines[it].startsWith("## ") } ?: lines.size
        return lines.subList(start, end).joinToString("\n")
    }

    private fun auditIds(): Set<String> =
        read(File(InteropHarness.repoRoot, "docs/android-audit-2026-09.md")).lines()
            .mapNotNull { Regex("""^## (A\d{2})$""").find(it)?.groupValues?.get(1) }
            .toSet()
            .also { assertTrue(it.size >= 70, "found only ${it.size} findings in the audit; has its heading format changed?") }

    private fun findingIds(text: String): Set<String> = Regex("""\bA\d{2}\b""").findAll(text).map { it.value }.toSet()

    private fun read(file: File) = file.readText().replace("\r\n", "\n")

    private companion object {
        val itemStart = Regex("""^(\d+)\.\s""")

        /** How docs/android.md says that only a phone can settle something. */
        val leftToDevice = Regex("""device check|type-checked|on a device""", RegexOption.IGNORE_CASE)
    }
}
