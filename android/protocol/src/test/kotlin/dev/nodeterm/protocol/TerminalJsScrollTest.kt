package dev.nodeterm.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Runs the app's real swipe handlers; tmux scrolling itself is exercised by SshTransportTest. */
class TerminalJsScrollTest {
    private fun gesture(vararg moves: Pair<Int, Int>, configure: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
        put("col", 2)
        put("row", 3)
        putJsonArray("moves") {
            for ((dx, dy) in moves) add(buildJsonArray { add(JsonPrimitive(dx)); add(JsonPrimitive(dy)) })
        }
        configure()
    }

    private fun run(vararg gestures: JsonObject, cellHeight: Int = 20, fontSize: Int = 13): List<JsonObject> =
        TerminalJsDriver.run(buildJsonObject {
            put("copyLimit", 8)
            put("fontSize", fontSize)
            put("screen", buildJsonObject {
                put("cols", 52)
                put("rows", 45)
                put("cellHeight", cellHeight)
            })
            putJsonArray("taps") { gestures.forEach { add(it) } }
        })["taps"]!!.jsonArray.map { it.jsonObject }

    private fun scrolls(gesture: JsonObject) = gesture["scrolls"]!!.jsonArray.map {
        it.jsonArray[0].jsonPrimitive.boolean to it.jsonArray[1].jsonPrimitive.int
    }

    private fun ntAction(fn: String, vararg args: String) = buildJsonObject {
        put("nt", fn)
        putJsonArray("args") { args.forEach { add(JsonPrimitive(it)) } }
    }

    @Test
    fun `finger distance matches history rows instead of multiplying it by the wheel gain`() {
        val gestures = run(gesture(0 to 200), gesture(0 to -200), gesture(200 to 0),
            gesture(0 to 99), gesture(0 to 200) { put("fingers", 2) })
        assertEquals(listOf(true to 2), scrolls(gestures[0]), "downward drag reveals earlier output")
        assertEquals(listOf(false to 2), scrolls(gestures[1]), "upward drag moves toward live output")
        assertTrue(gestures.take(2).all { it["movePrevented"]!!.jsonPrimitive.boolean },
            "the gesture belongs to tmux rather than the browser viewport")
        for (gesture in gestures.drop(2)) assertTrue(scrolls(gesture).isEmpty(),
            "horizontal, sub-notch and multi-touch gestures do not request history")
    }

    @Test
    fun `swipe gain uses the rendered row height with a font fallback before layout`() {
        assertEquals(listOf(true to 1), scrolls(run(gesture(0 to 200), cellHeight = 40).single()))
        assertEquals(listOf(true to 2), scrolls(run(gesture(0 to 280), cellHeight = 0, fontSize = 20).single()))
    }

    @Test
    fun `touch moves in one frame merge into one ordered request`() {
        val result = run(gesture(0 to 10, 0 to 50, 0 to 100, 0 to 200, 0 to 400)).single()
        assertEquals(listOf(true to 4), scrolls(result))
        assertTrue(result["scrollsBeforeFrame"]!!.jsonArray.isEmpty(), "touchmove sends nothing immediately")
        assertEquals(listOf(1), result["scrollFrames"]!!.jsonArray.map { it.jsonObject["frame"]!!.jsonPrimitive.int })
    }

    @Test
    fun `direction reversals during a gesture keep their order across frames`() {
        val result = run(gesture(0 to 200, 0 to -100)).single()
        assertEquals(listOf(true to 2, false to 3), scrolls(result))
        assertEquals(listOf(1, 2), result["scrollFrames"]!!.jsonArray.map { it.jsonObject["frame"]!!.jsonPrimitive.int })
    }

    @Test
    fun `a fast swipe retains its distance past the transport cap and drains after touchend`() {
        val result = run(gesture(0 to 4500)).single()
        assertEquals(listOf(true to 20, true to 20, true to 5), scrolls(result))
        assertTrue(result["scrollsBeforeFrame"]!!.jsonArray.isEmpty())
        assertEquals(listOf(1, 2, 3), result["scrollFrames"]!!.jsonArray.map { it.jsonObject["frame"]!!.jsonPrimitive.int })
    }

    @Test
    fun `reset new input and a hidden page discard an outstanding swipe`() {
        val actions = listOf(ntAction("reset"), ntAction("paint", "eA=="), ntAction("cancelScroll"),
            ntAction("key", "esc"), ntAction("raw", "Aw=="), ntAction("submit", "eA=="),
            buildJsonObject { put("data", "x") }, buildJsonObject { put("binary", "x") }) +
            listOf("blur", "pagehide", "hidden", "touchcancel", "multitouch")
                .map { buildJsonObject { put("event", it) } }
        for (action in actions) {
            val result = run(gesture(0 to 4500) { putJsonArray("after") { add(action) } }).single()
            assertTrue(scrolls(result).isEmpty(), "no stale scroll after $action")
            if (action == ntAction("raw", "Aw==")) {
                assertEquals(listOf("\u0003"), result["inputs"]!!.jsonArray.map { it.jsonPrimitive.content },
                    "the raw chip still sends its exact control byte")
            }
        }
    }

    @Test
    fun `cancellation after the first clamped frame drops the remainder`() {
        val cancels = listOf(ntAction("raw", "Gw=="),
            buildJsonObject { put("event", "touchcancel") }, buildJsonObject { put("event", "multitouch") })
        for (cancel in cancels) {
            val result = run(gesture(0 to 4500) {
                putJsonArray("after") {
                    add(buildJsonObject { put("frame", true) })
                    add(cancel)
                }
            }).single()
            assertEquals(listOf(true to 20), scrolls(result), "nothing queued after $cancel")
            if (cancel == ntAction("raw", "Gw==")) {
                assertEquals(listOf("\u001b"), result["inputs"]!!.jsonArray.map { it.jsonPrimitive.content })
            }
        }
    }

    @Test
    fun `suspending scroll cancels pending work and rejects gestures until attach resumes it`() {
        val results = run(
            gesture(0 to 4500) { putJsonArray("after") { add(ntAction("suspendScroll")) } },
            gesture(0 to 200),
            gesture(0 to 200) { putJsonArray("before") { add(ntAction("resumeScroll")) } },
        )
        assertTrue(scrolls(results[0]).isEmpty())
        assertTrue(scrolls(results[1]).isEmpty())
        assertEquals(listOf(true to 2), scrolls(results[2]))
    }

    @Test
    fun `a frame delayed by a page suspension drops stale input and the next gesture works`() {
        val results = run(gesture(0 to 200) { put("frameDelay", 251) }, gesture(0 to 200))
        assertTrue(scrolls(results[0]).isEmpty())
        assertEquals(listOf(true to 2), scrolls(results[1]))
    }
}
