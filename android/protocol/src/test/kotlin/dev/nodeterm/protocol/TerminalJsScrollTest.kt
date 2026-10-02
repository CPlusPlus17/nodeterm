package dev.nodeterm.protocol

import kotlinx.serialization.json.JsonObject
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
    @Test
    fun `dragging down requests older tmux history and dragging up returns toward live output`() {
        val reply = TerminalJsDriver.run(buildJsonObject {
            put("copyLimit", 8)
            putJsonArray("taps") {
                val moves = listOf(Triple(0, 40, 1), Triple(0, -40, 1),
                    Triple(40, 0, 1), Triple(0, 10, 1), Triple(0, 40, 2))
                for ((dx, dy, fingers) in moves) {
                    add(buildJsonObject {
                        put("col", 2)
                        put("row", 3)
                        put("fingers", fingers)
                        put("move", buildJsonArray { add(JsonPrimitive(dx)); add(JsonPrimitive(dy)) })
                    })
                }
            }
        })
        val gestures = reply["taps"]!!.jsonArray.map { it.jsonObject }
        fun scrolls(gesture: JsonObject) = gesture["scrolls"]!!.jsonArray.map {
            it.jsonArray[0].jsonPrimitive.boolean to it.jsonArray[1].jsonPrimitive.int
        }
        assertEquals(listOf(true to 2), scrolls(gestures[0]), "downward drag reveals earlier output")
        assertEquals(listOf(false to 2), scrolls(gestures[1]), "upward drag moves toward live output")
        assertTrue(gestures.take(2).all { it["movePrevented"]!!.jsonPrimitive.boolean },
            "the gesture belongs to tmux rather than the browser viewport")
        for (gesture in gestures.drop(2)) assertTrue(scrolls(gesture).isEmpty(),
            "horizontal, sub-row and multi-touch gestures do not request history")
    }
}
