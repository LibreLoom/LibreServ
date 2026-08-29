package net.plainskill.luna

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayInputStream

class HttpIoTest {
    @Test
    fun readsContentLengthAndIgnoresTrailingBytes() {
        val raw = (
            "HTTP/1.1 200 OK\r\n" +
                "Content-Length: 2\r\n" +
                "\r\n" +
                "OKEXTRA"
            ).toByteArray(Charsets.ISO_8859_1)
        val parsed = HttpIo.readResponse(ByteArrayInputStream(raw))
        assertEquals(200, parsed.code)
        assertEquals("OK", String(parsed.body, Charsets.UTF_8))
    }

    @Test
    fun readsChunkedBody() {
        val raw = (
            "HTTP/1.1 200 OK\r\n" +
                "Transfer-Encoding: chunked\r\n" +
                "\r\n" +
                "5\r\nhello\r\n" +
                "0\r\n\r\n"
            ).toByteArray(Charsets.ISO_8859_1)
        val parsed = HttpIo.parseComplete(raw)
        assertEquals(200, parsed.code)
        assertEquals("hello", String(parsed.body, Charsets.UTF_8))
    }

    @Test
    fun readsErrorStatus() {
        val raw = (
            "HTTP/1.1 403 Forbidden\r\n" +
                "Content-Length: 7\r\n" +
                "\r\n" +
                "no-save"
            ).toByteArray(Charsets.ISO_8859_1)
        val parsed = HttpIo.parseComplete(raw)
        assertEquals(403, parsed.code)
        assertEquals("no-save", String(parsed.body, Charsets.UTF_8))
    }
}
