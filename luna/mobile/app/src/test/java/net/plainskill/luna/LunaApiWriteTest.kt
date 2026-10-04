package net.plainskill.luna

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The calls that change things on Luna — folders and uploads — against a real
 * HTTP server on the loopback address (cleartext is allowed there).
 */
class LunaApiWriteTest {
    private data class Seen(
        val method: String,
        val path: String,
        val auth: String?,
        val contentRange: String?,
        val body: ByteArray,
    )

    private lateinit var server: ServerSocket
    private val seen = CopyOnWriteArrayList<Seen>()

    /** Reply per "METHOD path"; anything unlisted is a 404 so a stray call is loud. */
    private val replies = HashMap<String, Pair<Int, String>>()
    private val base get() = "http://127.0.0.1:${server.localPort}"

    private fun readLine(input: InputStream): String? {
        val line = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) return if (line.size() == 0) null else line.toString(Charsets.ISO_8859_1)
            if (b == '\n'.code) return line.toString(Charsets.ISO_8859_1).trimEnd('\r')
            line.write(b)
        }
    }

    @Before
    fun start() {
        server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                socket.use { sock ->
                    val input = sock.getInputStream()
                    val request = readLine(input) ?: return@use
                    val (method, target) = request.split(" ").let { it[0] to it[1] }
                    val headers = HashMap<String, String>()
                    while (true) {
                        val line = readLine(input)
                        if (line.isNullOrEmpty()) break
                        val i = line.indexOf(':')
                        headers[line.substring(0, i).lowercase()] = line.substring(i + 1).trim()
                    }
                    val length = headers["content-length"]?.toInt() ?: 0
                    val body = ByteArray(length)
                    var got = 0
                    while (got < length) {
                        val n = input.read(body, got, length - got)
                        if (n < 0) break
                        got += n
                    }
                    val path = target.substringBefore('?')
                    seen += Seen(method, path, headers["authorization"], headers["content-range"], body)
                    val (code, text) = replies["$method $path"] ?: (404 to "{}")
                    val out = text.toByteArray()
                    val head = "HTTP/1.1 $code X\r\nContent-Type: application/json\r\n" +
                        "Content-Length: ${out.size}\r\nConnection: close\r\n\r\n"
                    sock.getOutputStream().apply {
                        write(head.toByteArray(Charsets.ISO_8859_1))
                        write(out)
                        flush()
                    }
                }
            }
        }.apply { isDaemon = true }.start()
    }

    @After
    fun stop() = server.close()

    private fun apiError(block: () -> Unit): LunaApi.ApiException {
        try {
            block()
        } catch (e: LunaApi.ApiException) {
            return e
        }
        fail("expected an ApiException")
        throw AssertionError()
    }

    @Test
    fun mkdirPostsThePathWithTheBearerToken() {
        replies["POST /api/v1/drives/d1/files/mkdir"] = 200 to "{}"
        LunaApi.mkdir(base, "tok", "d1", "Photos/2026")
        val call = seen.single()
        assertEquals("Bearer tok", call.auth)
        assertTrue(String(call.body).contains("\"path\":\"Photos\\/2026\"") || String(call.body).contains("\"path\":\"Photos/2026\""))
    }

    @Test
    fun mkdirEncodesTheDriveId() {
        replies["POST /api/v1/drives/my%20drive/files/mkdir"] = 200 to "{}"
        LunaApi.mkdir(base, "tok", "my drive", "x")
        assertEquals("/api/v1/drives/my%20drive/files/mkdir", seen.single().path)
    }

    @Test
    fun mkdirExplainsEachFailureInPlainWords() {
        val expected = mapOf(
            401 to "That access token didn't work",
            403 to "can't create a folder here",
            409 to "A folder with this name is already here",
            404 to "Luna can't find the parent folder",
            500 to "Luna couldn't create that folder",
        )
        for ((code, phrase) in expected) {
            replies["POST /api/v1/drives/d1/files/mkdir"] = code to "{\"error\":\"raw server text\"}"
            val e = apiError { LunaApi.mkdir(base, "tok", "d1", "x") }
            assertEquals(code, e.code)
            assertTrue("$code: ${e.message}", e.message!!.contains(phrase))
            assertTrue("never the raw server text", !e.message!!.contains("raw server text"))
        }
    }

    @Test
    fun uploadStreamSendsCreateThenEachChunkWithItsRangeThenComplete() {
        val size = LunaApi.CHUNK_SIZE + 500 // two chunks: one full, one short
        val data = ByteArray(size) { (it % 251).toByte() }
        replies["POST /api/v1/uploads"] = 200 to "{\"upload_id\":\"u1\"}"
        replies["PUT /api/v1/uploads/u1"] = 200 to "{}"
        replies["POST /api/v1/uploads/u1/complete"] = 200 to "{}"

        LunaApi.uploadStream(base, "tok", "d1", "Photos/2026/10", "a.jpg", size.toLong(), ByteArrayInputStream(data))

        assertEquals(
            listOf("POST /api/v1/uploads", "PUT /api/v1/uploads/u1", "PUT /api/v1/uploads/u1", "POST /api/v1/uploads/u1/complete"),
            seen.map { "${it.method} ${it.path}" },
        )
        val create = String(seen[0].body)
        assertTrue(create.contains("\"drive_id\":\"d1\"") && create.contains("\"name\":\"a.jpg\"") && create.contains("\"size\":$size"))
        assertEquals("bytes 0-${LunaApi.CHUNK_SIZE - 1}/$size", seen[1].contentRange)
        assertEquals("bytes ${LunaApi.CHUNK_SIZE}-${size - 1}/$size", seen[2].contentRange)
        // The chunks add back up to exactly the file.
        assertTrue((seen[1].body + seen[2].body).contentEquals(data))
        assertTrue(seen.all { it.auth == "Bearer tok" })
    }

    @Test
    fun aRejectedChunkStopsTheUploadWithoutCompleting() {
        replies["POST /api/v1/uploads"] = 200 to "{\"upload_id\":\"u1\"}"
        replies["PUT /api/v1/uploads/u1"] = 409 to "{\"error\":\"Out of order\"}"
        val e = apiError {
            LunaApi.uploadStream(base, "tok", "d1", "", "a.jpg", 3, ByteArrayInputStream(ByteArray(3)))
        }
        assertEquals(409, e.code)
        assertEquals("Out of order", e.message)
        assertTrue(seen.none { it.path.endsWith("/complete") })
    }

    @Test
    fun createUploadNeedsASessionBack() {
        replies["POST /api/v1/uploads"] = 200 to "{}"
        val e = apiError { LunaApi.createUpload(base, "tok", "d1", "", "a.jpg", 1) }
        assertEquals(500, e.code)
        assertTrue(e.message!!.contains("didn't return a session"))
    }

    @Test
    fun createUploadMapsAuthFailures() {
        replies["POST /api/v1/uploads"] = 401 to "{}"
        assertEquals(401, apiError { LunaApi.createUpload(base, "tok", "d1", "", "a.jpg", 1) }.code)
        replies["POST /api/v1/uploads"] = 403 to "{}"
        assertTrue(apiError { LunaApi.createUpload(base, "tok", "d1", "", "a.jpg", 1) }.message!!.contains("allow Write on this drive"))
        // Other failures keep the server's own plain message.
        replies["POST /api/v1/uploads"] = 507 to "{\"error\":\"The drive is full.\"}"
        assertEquals("The drive is full.", apiError { LunaApi.createUpload(base, "tok", "d1", "", "a.jpg", 1) }.message)
    }

    @Test
    fun probeWriteCreatesTheFolderStartsAOneByteUploadAndCancelsIt() {
        replies["POST /api/v1/drives/d1/files/mkdir"] = 409 to "{}" // already there: fine
        replies["POST /api/v1/uploads"] = 200 to "{\"upload_id\":\"probe1\"}"
        replies["DELETE /api/v1/uploads/probe1"] = 200 to "{}"
        LunaApi.probeWrite(base, "tok", "d1", "Photos")
        assertEquals(
            listOf("POST /api/v1/drives/d1/files/mkdir", "POST /api/v1/uploads", "DELETE /api/v1/uploads/probe1"),
            seen.map { "${it.method} ${it.path}" },
        )
        val create = String(seen[1].body)
        assertTrue(create.contains("\"size\":1") && create.contains("LunaWriteCheck_"))
    }

    @Test
    fun probeWriteSaysWhenTheTokenCanSeeButNotSave() {
        replies["POST /api/v1/uploads"] = 403 to "{}"
        val e = apiError { LunaApi.probeWrite(base, "tok", "d1", "") }
        assertEquals(403, e.code)
        assertTrue(e.message!!.contains("can see the folder but cannot save files there"))
        // An empty destination means "drive root": no mkdir is attempted.
        assertTrue(seen.none { it.path.endsWith("/mkdir") })
    }

    @Test
    fun probeWriteIgnoresAFailedCleanup() {
        replies["POST /api/v1/uploads"] = 200 to "{\"upload_id\":\"p\"}"
        replies["DELETE /api/v1/uploads/p"] = 500 to "{}"
        LunaApi.probeWrite(base, "tok", "d1", "")
    }

    @Test
    fun anUnreachableLunaIsAPlainNetworkMessage() {
        val dead = "http://127.0.0.1:1"
        try {
            LunaApi.mkdir(dead, "tok", "d1", "x")
            fail("expected a connection error")
        } catch (e: Exception) {
            assertTrue(LunaApi.describeError(e).startsWith("Luna couldn't be reached"))
        }
    }
}
