package net.plainskill.luna

import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL

/**
 * Minimal Luna HTTP client for the backup worker. Speaks the same chunked
 * upload protocol as the web app: create → PUT ranges → complete.
 */
object LunaApi {
    const val CHUNK_SIZE = 1024 * 1024 // 1 MiB

    class ApiException(val code: Int, message: String) : Exception(message) {
        val unauthorized get() = code == 401
    }

    /** A named token the server tracks so it can be revoked separately from the password. */
    class DeviceToken(val id: String, val token: String)

    /**
     * Sign in with a one-shot cookie session, mint a long-lived access token,
     * then drop the cookie session. Only the access token is kept.
     */
    fun mintAccessToken(baseUrl: String, username: String, password: String, name: String): DeviceToken {
        val cookie = loginSessionCookie(baseUrl, username, password)
        val device = createDeviceToken(baseUrl, cookie, name)
        try {
            post(baseUrl, "/api/v1/auth/logout", "", bearer = null, cookie = cookie)
        } catch (_: Exception) {
            // Cookie session is unused after mint; ignore logout failures.
        }
        return device
    }

    fun loginSessionCookie(baseUrl: String, username: String, password: String): String {
        val body = JSONObject().apply {
            put("username", username)
            put("password", password)
        }
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        val extra = mapOf("Content-Type" to "application/json")
        val result = exchange(baseUrl, "/api/v1/auth/login", "POST", null, bytes, extra, null)
        if (result.code !in 200..299) throw ApiException(result.code, result.errorText())
        return parseLunaSessionCookie(result.setCookie)
            ?: throw ApiException(401, "Luna did not set a session cookie")
    }

    fun createDeviceToken(baseUrl: String, cookie: String, name: String): DeviceToken {
        val body = JSONObject().apply { put("name", name) }
        val json = post(baseUrl, "/api/v1/device-tokens", body.toString(), bearer = null, cookie = cookie)
        val id = json.optString("id").ifEmpty { throw ApiException(500, "No device-token id in reply") }
        val raw = json.optString("token").ifEmpty { throw ApiException(500, "No device-token value in reply") }
        return DeviceToken(id, raw)
    }

    fun parseLunaSessionCookie(setCookie: String?): String? {
        if (setCookie.isNullOrBlank()) return null
        val pair = setCookie.split(';').first().trim()
        return if (pair.startsWith("luna_session=")) pair else null
    }

    fun revokeToken(baseUrl: String, sessionToken: String, deviceId: String): Boolean {
        val result = exchange(baseUrl, "/api/v1/device-tokens/$deviceId", "DELETE", sessionToken, null, null)
        return result.code in 200..299
    }

    fun firstDriveId(baseUrl: String, token: String): String {
        val drives = getArray(baseUrl, "/api/v1/drives", token)
        val first = drives.optJSONObject(0) ?: throw ApiException(404, "No drives found on Luna")
        return first.optString("id").ifEmpty { throw ApiException(404, "No drives found on Luna") }
    }

    private fun getArray(baseUrl: String, path: String, token: String): JSONArray {
        val result = exchange(baseUrl, path, "GET", token, null, null)
        if (result.code !in 200..299) throw ApiException(result.code, result.errorText())
        return JSONArray(String(result.body, Charsets.UTF_8))
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
