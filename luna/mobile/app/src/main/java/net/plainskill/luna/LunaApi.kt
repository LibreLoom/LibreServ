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
    // Luna accepts at least 8 MiB per chunk (lunad's MIN_UPLOAD_CHUNK_BYTES, same as the
    // web app); bigger chunks mean fewer round trips per photo.
    const val CHUNK_SIZE = 8 * 1024 * 1024
    private val deadlineMs = ThreadLocal<Long?>()

    fun <T> withDeadline(ms: Long, block: () -> T): T {
        val previous = deadlineMs.get()
        deadlineMs.set(System.currentTimeMillis() + ms)
        return try {
            block()
        } finally {
            if (previous == null) deadlineMs.remove() else deadlineMs.set(previous)
        }
    }

    private fun remainingTimeoutMs(fallback: Int): Int {
        val deadline = deadlineMs.get() ?: return fallback
        val left = deadline - System.currentTimeMillis()
        if (left <= 0L) {
            throw java.io.IOException("timed out")
        }
        return left.toInt().coerceAtMost(fallback).coerceAtLeast(250)
    }

    class ApiException(val code: Int, message: String) : Exception(message) {
        val unauthorized get() = code == 401
    }

    data class UserInfo(val id: String, val username: String)
    data class Drive(val id: String, val label: String)
    data class FileEntry(val name: String, val kind: String) {
        val isDir: Boolean get() = kind == "dir"
    }

    /** Thrown when Luna and this app can't work together; not worth retrying. */
    class IncompatibleException(message: String) : Exception(message)

    /** Asks Luna (no sign-in needed) which API it speaks and compares it with [CLIENT_API]. */
    fun checkCompat(baseUrl: String): Compat {
        val result = exchange(baseUrl, "/api/v1/health", "GET", null, null, null)
        if (result.code !in 200..299) {
            throw ApiException(
                result.code,
                "That address did not answer like a Luna. Check the Luna address, then try again.",
            )
        }
        return Compatibility.check(Compatibility.parseApi(String(result.body, Charsets.UTF_8)))
    }

    /** Throws [IncompatibleException] with a plain message unless Luna and this app match. */
    fun requireCompatible(baseUrl: String) {
        Compatibility.message(checkCompat(baseUrl))?.let { throw IncompatibleException(it) }
    }

    fun authMe(baseUrl: String, token: String): UserInfo {
        val result = exchange(baseUrl, "/api/v1/auth/me", "GET", token, null, null)
        if (result.code == 401) {
            throw ApiException(401, badTokenMessage())
        }
        if (result.code !in 200..299) {
            throw ApiException(
                result.code,
                "Luna couldn't check that access token. Check the Luna address, then try again.",
            )
        }
        return parseUser(String(result.body, Charsets.UTF_8))
    }

    fun listDrives(baseUrl: String, token: String): List<Drive> {
        val result = exchange(baseUrl, "/api/v1/drives", "GET", token, null, null)
        if (result.code == 401) throw ApiException(401, badTokenMessage())
        if (result.code !in 200..299) {
            throw ApiException(
                result.code,
                "Luna couldn't list your drives. Try again.",
            )
        }
        return parseDrives(String(result.body, Charsets.UTF_8))
    }

    fun resolveDriveId(baseUrl: String, token: String, preferredId: String?): String {
        val drives = listDrives(baseUrl, token)
        if (drives.isEmpty()) {
            throw ApiException(
                404,
                "No drives found on Luna. Make sure the drive is plugged in, or ask an Admin for access to a drive.",
            )
        }
        if (!preferredId.isNullOrBlank()) {
            val match = drives.firstOrNull { it.id == preferredId }
            if (match != null) return match.id
            throw ApiException(
                404,
                "Luna no longer shows the drive you picked. Make sure it is plugged in, or ask an Admin for access to it.",
            )
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

    fun listFiles(baseUrl: String, token: String, driveId: String, path: String): List<FileEntry> {
        val encPath = java.net.URLEncoder.encode(path, Charsets.UTF_8.name()).replace("+", "%20")
        val encId = java.net.URLEncoder.encode(driveId, Charsets.UTF_8.name()).replace("+", "%20")
        val result = exchange(baseUrl, "/api/v1/drives/$encId/files?path=$encPath", "GET", token, null, null)
        if (result.code == 401) throw ApiException(401, badTokenMessage())
        if (result.code == 403) {
            throw ApiException(
                403,
                "Your Luna account can't open that folder. Ask an Admin for Read on it.",
            )
        }
        if (result.code == 404) {
            throw ApiException(
                404,
                "Luna can't find that folder. Pick another folder, or create a new one.",
            )
        }
        if (result.code !in 200..299) {
            throw ApiException(
                result.code,
                "Luna couldn't open that folder. Try again.",
            )
        }
        return parseFiles(String(result.body, Charsets.UTF_8))
    }

    fun mkdir(baseUrl: String, token: String, driveId: String, path: String) {
        val encId = java.net.URLEncoder.encode(driveId, Charsets.UTF_8.name()).replace("+", "%20")
        val body = JSONObject().apply { put("path", path) }
        try {
            post(baseUrl, "/api/v1/drives/$encId/files/mkdir", body.toString(), token)
        } catch (e: ApiException) {
            throw when (e.code) {
                401 -> ApiException(401, badTokenMessage())
                403 -> ApiException(
                    403,
                    "Your Luna account can't create a folder here. Ask an Admin for Write on this folder.",
                )
                409 -> ApiException(409, "A folder with this name is already here. Choose another name.")
                404 -> ApiException(404, "Luna can't find the parent folder. Tap Up one folder, then try again.")
                else -> ApiException(
                    e.code,
                    "Luna couldn't create that folder. Check the name, then try again.",
                )
            }
        }
    }

    fun joinPath(vararg parts: String): String =
        parts.map { it.trim().trim('/') }.filter { it.isNotEmpty() }.joinToString("/")

    fun parentPath(path: String): String {
        val trimmed = path.trim().trim('/')
        if (trimmed.isEmpty()) return ""
        val slash = trimmed.lastIndexOf('/')
        return if (slash <= 0) "" else trimmed.substring(0, slash)
    }

    fun cancelUpload(baseUrl: String, token: String, uploadId: String) {
        val enc = java.net.URLEncoder.encode(uploadId, Charsets.UTF_8.name()).replace("+", "%20")
        exchange(baseUrl, "/api/v1/uploads/$enc", "DELETE", token, null, null)
    }

    /**
     * Prove we can save to this folder: start a 1-byte upload (the server
     * checks write access here) then cancel so nothing is written.
     * Creates target path via mkdir if missing (e.g., custom folder prefix).
     */
    fun probeWrite(baseUrl: String, token: String, driveId: String, destPath: String) {
        if (destPath.isNotBlank()) {
            try {
                mkdir(baseUrl, token, driveId, destPath)
            } catch (e: ApiException) {
                // Ignore 409 Conflict (folder already exists)
                if (e.code != 409) {
                    // Ignore error if it's already a valid directory
                }
            }
        }
        val probeName = "LunaWriteCheck_${java.util.UUID.randomUUID()}.jpg"
        val id = try {
            createUpload(baseUrl, token, driveId, destPath, probeName, 1)
        } catch (e: ApiException) {
            throw when (e.code) {
                401 -> ApiException(401, badTokenMessage())
                403 -> ApiException(
                    403,
                    "Your Luna account can open this folder but can't save files in it. Ask an Admin for Write on this folder.",
                )
                404 -> ApiException(
                    404,
                    "Luna can't find that folder anymore. Pick the folder again.",
                )
                else -> ApiException(
                    e.code,
                    "Luna couldn't test saving to that folder. Try again.",
                )
            }
        }
        try {
            cancelUpload(baseUrl, token, id)
        } catch (_: Exception) {
            // Cancel is cleanup. The write check already passed.
        }
    }

    fun describeError(error: Exception): String = when (error) {
        is ApiException -> error.message ?: badTokenMessage()
        is IncompatibleException -> error.message.orEmpty()
        is java.io.IOException ->
            if (error.message == "timed out") {
                "Luna didn't answer in time. Check this phone's network connection and the drive on Luna's Files page, then try again."
            } else {
                "Luna couldn't be reached. Check the Luna address and this phone's network connection, then try again."
            }
        is IllegalStateException ->
            error.message
                ?: "This phone couldn't store the sign-in safely. Photo upload can't start. Try signing in again."
        // Other exceptions carry developer text (JSON parse errors and the like),
        // never a sentence for a person.
        else -> "Something unexpected went wrong. Try again."
    }

    fun parseFiles(body: String): List<FileEntry> {
        val out = ArrayList<FileEntry>()
        for (obj in JsonFields.objects(body)) {
            val name = JsonFields.string(obj, "name").orEmpty()
            if (name.isEmpty()) continue
            val kind = JsonFields.string(obj, "kind").orEmpty().ifEmpty { "file" }
            out.add(FileEntry(name, kind))
        }
        return out
    }

    fun createUpload(baseUrl: String, token: String, driveId: String, destPath: String, name: String, size: Long): String {
        val body = JSONObject().apply {
            put("drive_id", driveId)
            put("path", destPath)
            put("name", name)
            put("size", size)
            put("on_conflict", "overwrite")
        }
        val json = try {
            post(baseUrl, "/api/v1/uploads", body.toString(), token)
        } catch (e: ApiException) {
            throw when (e.code) {
                401 -> ApiException(401, badTokenMessage())
                403 -> ApiException(
                    403,
                    "Your Luna account can't save files in that folder. Ask an Admin for Write on this folder.",
                )
                else -> ApiException(
                    e.code,
                    e.message?.takeIf { it.isNotBlank() && it != genericError(e.code) }
                        ?: "Luna couldn't start the photo upload. Try again.",
                )
            }
        }
        return json.optString("upload_id").ifEmpty {
            throw ApiException(500, "Luna started the upload but sent an incomplete answer. Tap Upload now to try again.")
        }
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
        post(baseUrl, "/api/v1/uploads/$uploadId/complete?overwrite=1", "", token)
    }

    fun uploadStream(baseUrl: String, token: String, driveId: String, destPath: String, name: String, size: Long, stream: InputStream) {
        val uploadId = createUpload(baseUrl, token, driveId, destPath, name, size)
        val buf = ByteArray(CHUNK_SIZE)
        var start = 0L
        while (true) {
            val read = fill(stream, buf)
            if (read <= 0) break
            val chunk = if (read == buf.size) buf else buf.copyOf(read)
            putChunk(baseUrl, token, uploadId, start, chunk, size)
            start += read
        }
        completeUpload(baseUrl, token, uploadId)
    }

    /**
     * Reads until [buf] is full or the stream ends. A single read() may return less
     * (content providers often hand out 64 KiB at a time), which would send many
     * small chunks.
     */
    internal fun fill(stream: InputStream, buf: ByteArray): Int {
        var off = 0
        while (off < buf.size) {
            val n = stream.read(buf, off, buf.size - off)
            if (n < 0) break
            off += n
        }
        return off
    }

    private fun badTokenMessage() =
        "That access token didn't work. Create a new one in Luna → Settings → Security."

    /** Shown when Luna's reply has no plain `error` sentence to pass on. */
    private fun genericError(code: Int) = "Luna answered with an error (code $code). Try again."

    private data class HttpResult(val code: Int, val body: ByteArray, val setCookie: String? = null) {
        /** Luna's own `error` sentence, never a raw body (it may be HTML from a proxy). */
        fun errorText(): String {
            val text = String(body, Charsets.UTF_8)
            val error = try { JSONObject(text).optString("error") } catch (_: Exception) { "" }
            return error.ifBlank { LunaApi.genericError(code) }
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
            conn.connectTimeout = remainingTimeoutMs(15000)
            conn.readTimeout = remainingTimeoutMs(60000)
            conn.requestMethod = method
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            // Reading the body to the end and closing it hands the connection back
            // to the keep-alive pool, so the next chunk skips a new TLS handshake.
            val bytes = stream?.use { it.readBytes() } ?: ByteArray(0)
            val setCookie = conn.headerFields?.entries
                ?.firstOrNull { it.key.equals("Set-Cookie", ignoreCase = true) }
                ?.value
                ?.firstOrNull()
            return HttpResult(code, bytes, setCookie)
        } catch (e: Exception) {
            // A half-read connection must not go back to the pool.
            conn.disconnect()
            throw e
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
            sock.connect(InetSocketAddress(url.host, port), remainingTimeoutMs(15000))
            sock.soTimeout = remainingTimeoutMs(15000)
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
            // Buffered: the header parser reads one byte at a time. The same stream
            // reads the body, so nothing buffered past the headers is lost.
            val parsed = HttpIo.readResponse(java.io.BufferedInputStream(sock.getInputStream()))
            return HttpResult(parsed.code, parsed.body, parsed.setCookie)
        }
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
