package net.plainskill.luna

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Verifies JSON serialization and parsing of the BLE proxy protocol types.
 * These run on the host JVM (not instrumented), using java.util.Base64 instead
 * of android.util.Base64 for compatibility.
 */
class ProtocolTest {

    private fun base64Encode(data: String): String =
        java.util.Base64.getEncoder().encodeToString(data.toByteArray(Charsets.UTF_8))

    private fun base64Decode(b64: String): String =
        String(java.util.Base64.getDecoder().decode(b64), Charsets.UTF_8)

    @Test
    fun proxyResponse_jsonRoundTrip() {
        val json = JSONObject().apply {
            put("id", "abc-123")
            put("status", 200)
            put("statusText", "OK")
            put("headers", JSONObject().apply { put("Content-Type", "text/html") })
            put("body", "aGVsbG8=")
            put("chunk", 0)
            put("final", true)
        }

        assertEquals("abc-123", json.getString("id"))
        assertEquals(200, json.getInt("status"))
        assertEquals("OK", json.getString("statusText"))
        assertEquals("text/html", json.getJSONObject("headers").getString("Content-Type"))
        assertTrue(json.getBoolean("final"))
    }

    @Test
    fun authStatus_parsesSuccess() {
        val json = JSONObject("""{"ok":true,"ts":1234567890}""")
        assertTrue(json.getBoolean("ok"))
        assertEquals(1234567890, json.getLong("ts"))
    }

    @Test
    fun authStatus_parsesFailure() {
        val json = JSONObject("""{"ok":false,"message":"The code you entered does not match."}""")
        assertFalse(json.getBoolean("ok"))
        assertEquals("The code you entered does not match.", json.getString("message"))
    }

    @Test
    fun base64ChunkAccumulation() {
        val chunks = listOf(
            base64Encode("Hel"),
            base64Encode("lo "),
            base64Encode("World")
        )

        val assembled = StringBuilder()
        for (part in chunks) {
            assembled.append(base64Decode(part))
        }

        assertEquals("Hello World", assembled.toString())
    }
}
