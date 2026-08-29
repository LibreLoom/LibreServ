package net.plainskill.luna

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

/**
 * Reads one HTTP/1.1 response without waiting for the socket to close.
 * LAN Luna keeps connections open; `readBytes()` would sit there until timeout.
 */
internal object HttpIo {
    data class Response(val code: Int, val body: ByteArray, val setCookie: String?)

    fun readResponse(input: InputStream): Response {
        val headerBytes = readHeaders(input)
        val head = String(headerBytes, Charsets.ISO_8859_1)
        val status = head.lineSequence().firstOrNull()
            ?.split(' ')
            ?.getOrNull(1)
            ?.toIntOrNull() ?: 0
        val setCookie = head.lineSequence()
            .firstOrNull { it.startsWith("Set-Cookie:", ignoreCase = true) }
            ?.substringAfter(':')
            ?.trim()
        val headers = headerMap(head)
        val chunked = headers["transfer-encoding"]?.contains("chunked") == true
        val length = headers["content-length"]?.toIntOrNull()
        val body = when {
            chunked -> readChunked(input)
            length != null -> if (length <= 0) ByteArray(0) else readExactly(input, length)
            else -> readLimited(input, 1024 * 1024)
        }
        return Response(status, body, setCookie)
    }

    internal fun parseComplete(raw: ByteArray): Response {
        return readResponse(raw.inputStream())
    }

    private fun headerMap(head: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (line in head.lineSequence().drop(1)) {
            val trimmed = line.trimEnd('\r')
            if (trimmed.isEmpty()) continue
            val colon = trimmed.indexOf(':')
            if (colon <= 0) continue
            out[trimmed.substring(0, colon).trim().lowercase()] = trimmed.substring(colon + 1).trim()
        }
        return out
    }

    private fun readHeaders(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        var matched = 0
        val end = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())
        while (matched < 4) {
            val b = input.read()
            if (b < 0) {
                throw IOException("Luna closed the connection before it finished answering.")
            }
            out.write(b)
            matched = if (b.toByte() == end[matched]) matched + 1 else if (b.toByte() == end[0]) 1 else 0
        }
        return out.toByteArray()
    }

    internal fun readExactly(input: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val read = input.read(buf, off, n - off)
            if (read < 0) {
                throw IOException("Luna closed the connection before the response finished.")
            }
            off += read
        }
        return buf
    }

    private fun readChunked(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        while (true) {
            val line = readLine(input)
            val size = line.substringBefore(';').trim().toIntOrNull(16)
                ?: throw IOException("Luna sent a broken chunked response.")
            if (size == 0) {
                while (true) {
                    if (readLine(input).isEmpty()) break
                }
                break
            }
            out.write(readExactly(input, size))
            if (readExactly(input, 2).contentEquals(byteArrayOf('\r'.code.toByte(), '\n'.code.toByte())).not()) {
                throw IOException("Luna sent a broken chunked response.")
            }
        }
        return out.toByteArray()
    }

    private fun readLine(input: InputStream): String {
        val out = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) throw IOException("Luna closed the connection before the response finished.")
            if (b == '\n'.code) break
            if (b != '\r'.code) out.write(b)
        }
        return String(out.toByteArray(), Charsets.ISO_8859_1)
    }

    private fun readLimited(input: InputStream, max: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        var total = 0
        while (total < max) {
            val read = try {
                input.read(buf, 0, minOf(buf.size, max - total))
            } catch (_: IOException) {
                break
            }
            if (read <= 0) break
            out.write(buf, 0, read)
            total += read
        }
        return out.toByteArray()
    }
}
