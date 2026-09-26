package dev.nodeterm.protocol

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A46: the key row's ⌨ chip must bring up the soft keyboard for the terminal. It used to run only
 * `term.focus()` in the page, which does nothing on the textarea that already has focus (Blink returns
 * early), cannot ask Android for the keyboard, and leaves Android's focus (and so the keyboard) with
 * the input bar's text field.
 *
 * The page half runs the app's real terminal.js ([TerminalJsDriver]) against a textarea stub that
 * follows Blink's rule. The Android half (Compose focus, the WebView's focus, InputMethodManager)
 * cannot run on a JVM, so its order is pinned in the app's source instead; what it does on a device
 * has not been checked.
 */
class TerminalKeyboardChipTest {
    private data class Focus(val changes: List<String>, val focusedAfter: Boolean)

    private fun focusForKeyboard(textareaFocused: Boolean): Focus {
        val reply = TerminalJsDriver.run(
            buildJsonObject {
                put("copyLimit", 8)
                put("textareaFocused", textareaFocused)
                putJsonArray("nt") { add(JsonPrimitive("focusForKeyboard")) }
            }
        )
        val r = reply["nt"]!!.jsonArray.single().jsonObject
        return Focus(r["focusChanges"]!!.jsonArray.map { it.jsonPrimitive.content }, r["focusedAfter"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `the page's focus really moves onto the textarea when it already had focus`() {
        // The normal state once the terminal has been tapped: a bare focus() would change nothing.
        assertEquals(Focus(listOf("blur", "focus"), focusedAfter = true), focusForKeyboard(textareaFocused = true))
    }

    @Test
    fun `the page's focus moves onto the textarea when it did not have focus`() {
        assertEquals(Focus(listOf("focus"), focusedAfter = true), focusForKeyboard(textareaFocused = false))
    }

    private val appSrc = File(InteropHarness.repoRoot, "android/app/src/main/kotlin/dev/nodeterm/android/ui")

    /** The block that follows the first occurrence of [start] in [source], braces balanced. */
    private fun blockAfter(source: String, start: String): String {
        val at = source.indexOf(start)
        assertTrue(at >= 0, "not found: $start")
        val open = source.indexOf('{', at)
        var depth = 0
        for (i in open until source.length) {
            when (source[i]) {
                '{' -> depth++
                '}' -> if (--depth == 0) return source.substring(open, i + 1)
            }
        }
        error("unbalanced block after $start")
    }

    private fun assertInOrder(block: String, vararg parts: String) {
        var from = 0
        for (p in parts) {
            val at = block.indexOf(p, from)
            assertTrue(at >= 0, "expected `$p` after `${parts.takeWhile { it != p }.lastOrNull()}` in:\n$block")
            from = at + p.length
        }
    }

    @Test
    fun `the chip releases Compose's focus before it asks for the keyboard`() {
        val chip = blockAfter(File(appSrc, "TerminalScreen.kt").readText(), "KeyChip(\"⌨\")")
        assertInOrder(chip, "focusManager.clearFocus()", "controller.showKeyboard()")
    }

    @Test
    fun `the WebView takes focus, then the page, then the keyboard is asked for after the focus change`() {
        val body = blockAfter(File(appSrc, "TerminalController.kt").readText(), "fun showKeyboard()")
        assertInOrder(body, ".requestFocus()", "js(\"nt.focusForKeyboard()\")", ".post {", "showSoftInput(", "InputMethodManager.SHOW_IMPLICIT")
        // Only the deferred call: a synchronous request right after requestFocus races the focus change.
        assertEquals(1, Regex("""showSoftInput\(""").findAll(body).count())
    }
}
