package net.plainskill.luna

import org.json.JSONObject
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL

/**
 * Minimal Luna HTTP client for photo backup. Sign-in is a pasted (or scanned)
 * access token, same as Luna Desktop. Uploads use the chunked protocol:
 * create → PUT ranges → complete.
 */
object LunaApi {
    const val CHUNK_SIZE = 1024 * 1024 // 1 MiB

    class ApiException(val code: Int, message: String) : Exception(message) {
        val unauthorized get() = code == 401
    }

    data class UserInfo(val id: String, val username: String)
    data class Drive(val id: String, val label: String)

    fun authMe(baseUrl: String, token: String): UserInfo {
        val result = exchange(baseUrl, "/api/v1/auth/me", "GET", token, null, null)
        if (result.code == 401) {
            throw ApiException(401, badTokenMessage())
        }
        if (result.code !in 200..299) {
            throw ApiException(result.code, "Luna couldn't check that access token. Try again.")
        }
        return parseUser(String(result.body, Charsets.UTF_8))
    }

    fun listDrives(baseUrl: String, token: String): List<Drive> {
        val result = exchange(baseUrl, "/api/v1/drives", "GET", token, null, null)
        if (result.code == 401) throw ApiException(401, badTokenMessage())
        if (result.code !in 200..299) {
            throw ApiException(result.code, "Luna couldn't list your drives. Try again.")
        }
        return parseDrives(String(result.body, Charsets.UTF_8))
    }

    fun resolveDriveId(baseUrl: String, token: String, preferredId: String?): String {
        val drives = listDrives(baseUrl, token)
        if (drives.isEmpty()) {
            throw ApiException(404, "No drives found on Luna. Add a drive in Luna first.")
        }
        if (!preferredId.isNullOrBlank()) {
            val match = drives.firstOrNull { it.id == preferredId }
            if (match != null) return match.id
        }
        return drives[0].id
    }

    fun parseUser(body: String): UserInfo {
        val trimmed = body.trim()
        if (trimmed.isEmpty() || trimmed == "null") {
            throw ApiException(401, badTokenMessage())
        }
        val username = JsonFields.string(trimmed, "username").orEmpty()
        if (username.isEmpty()) throw ApiException(401, badTokenMessage())
        return UserInfo(JsonFields.string(trimmed, "id").orEmpty(), username)
    }

    fun parseDrives(body: String): List<Drive> {
        val out = ArrayList<Drive>()
        for (obj in JsonFields.objects(body)) {
            val id = JsonFields.string(obj, "id").orEmpty()
            if (id.isEmpty()) continue
            val label = JsonFields.string(obj, "label").orEmpty().ifEmpty { id }
            out.add(Drive(id, label))
        }
        return out
    }

    fun createUpload(baseUrl: String, token: String, driveId: String, destPath: String, name: String, size: Long): String {
        val body = JSONObject().apply {
            put("drive_id", driveId)
            put("path", destPath)
            put("name", name)
            put("size", size)
        }
        val json = post(baseUrl, "/api/v1/uploads", body.toString(), token)
        return json.optString("upload_id").ifEmpty { throw ApiException(500, "No upload session") }
    }

    fun putChunk(baseUrl: String, token: String, uploadId: String, start: Long, data: ByteArray, total: Long) {
        val extra = mapOf(
            "Content-Type" to "application/octet-stream",
            "Content-Range" to "bytes $start-${start + data.size - 1}/$total",
        )
        val result = exchange(baseUrl, "/api/v1/uploads/$uploadId", "PUT", token, data, extra)
        if (result.code !in 200..299) throw ApiException(result.code, result.errorText())
    }

    fun completeUpload(baseUrl: String, token: String, uploadId: String) {
        post(baseUrl, "/api/v1/uploads/$uploadId/complete", "", token)
    }

    fun uploadStream(baseUrl: String, token: String, driveId: String, destPath: String, name: String, size: Long, stream: InputStream) {
        val uploadId = createUpload(baseUrl, token, driveId, destPath, name, size)
        val buf = ByteArray(CHUNK_SIZE)
        var start = 0L
        while (true) {
            val read = stream.read(buf)
            if (read <= 0) break
            val chunk = if (read == buf.size) buf else buf.copyOf(read)
            putChunk(baseUrl, token, uploadId, start, chunk, size)
            start += read
        }
        completeUpload(baseUrl, token, uploadId)
    }

    private fun badTokenMessage() =
        "That access token didn't work. Create a new one in Luna → Settings → Apps and access tokens."

    private data class HttpResult(val code: Int, val body: ByteArray, val setCookie: String? = null) {
        fun errorText(): String {
            val text = String(body, Charsets.UTF_8)
            return try { JSONObject(text).optString("error") } catch (_: Exception) {
                text.ifBlank { "Request failed ($code)" }
            }
        }
    }

    private fun exchange(
        baseUrl: String,
        path: String,
        method: String,
        token: String?,
        body: ByteArray?,
        extraHeaders: Map<String, String>?,
        cookie: String? = null,
    ): HttpResult {
        val url = URL(baseUrl.trimEnd('/') + path)
        val headers = linkedMapOf(
            "Accept" to "application/json",
        )
        if (token != null) headers["Authorization"] = "Bearer $token"
        if (cookie != null) headers["Cookie"] = cookie
        extraHeaders?.forEach { (k, v) -> headers[k] = v }
        if (url.protocol == "http" && PrivateLan.allowsCleartext(url.host)) {
            return socketHttp(url, method, headers, body)
        }
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 15000
            conn.readTimeout = 60000
            conn.requestMethod = method
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val bytes = stream?.readBytes() ?: ByteArray(0)
            val setCookie = conn.headerFields?.entries
                ?.firstOrNull { it.key.equals("Set-Cookie", ignoreCase = true) }
                ?.value
                ?.firstOrNull()
            return HttpResult(code, bytes, setCookie)
        } finally {
            conn.disconnect()
        }
    }

    private fun socketHttp(
        url: URL,
        method: String,
        headers: Map<String, String>,
        body: ByteArray?,
    ): HttpResult {
        val port = if (url.port == -1) 80 else url.port
        Socket().use { sock ->
            sock.connect(InetSocketAddress(url.host, port), 15000)
            sock.soTimeout = 60000
            val path = if (url.file.isNullOrEmpty()) "/" else url.file
            val hdr = StringBuilder()
            headers.forEach { (k, v) -> hdr.append("$k: $v\r\n") }
            if (body != null) hdr.append("Content-Length: ${body.size}\r\n")
            val hostHeader = if (url.port == -1) url.host else "${url.host}:${url.port}"
            val req = "$method $path HTTP/1.1\r\nHost: $hostHeader\r\nConnection: close\r\n$hdr\r\n"
            val out = sock.getOutputStream()
            out.write(req.toByteArray(Charsets.ISO_8859_1))
            if (body != null) out.write(body)
            out.flush()
            val raw = sock.getInputStream().readBytes()
            val split = indexOfHeaderEnd(raw)
            val head = String(raw, 0, split.coerceAtLeast(0), Charsets.ISO_8859_1)
            val rest = if (split >= 0) raw.copyOfRange(split + 4, raw.size) else ByteArray(0)
            val status = head.lineSequence().firstOrNull()
                ?.split(' ')
                ?.getOrNull(1)
                ?.toIntOrNull() ?: 0
            val setCookie = head.lineSequence()
                .firstOrNull { it.startsWith("Set-Cookie:", ignoreCase = true) }
                ?.substringAfter(':')
                ?.trim()
            return HttpResult(status, rest, setCookie)
        }
    }

    private fun indexOfHeaderEnd(raw: ByteArray): Int {
        var i = 0
        while (i + 3 < raw.size) {
            if (raw[i] == '\r'.code.toByte() && raw[i + 1] == '\n'.code.toByte()
                && raw[i + 2] == '\r'.code.toByte() && raw[i + 3] == '\n'.code.toByte()
            ) {
                return i
            }
            i++
        }
        return -1
    }

    private fun post(
        baseUrl: String,
        path: String,
        body: String,
        bearer: String?,
        cookie: String? = null,
    ): JSONObject {
        val bytes = if (body.isEmpty()) null else body.toByteArray(Charsets.UTF_8)
        val extra = mapOf("Content-Type" to "application/json")
        val result = exchange(baseUrl, path, "POST", bearer, bytes, extra, cookie)
        if (result.code !in 200..299) throw ApiException(result.code, result.errorText())
        val text = String(result.body, Charsets.UTF_8)
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }
}
