package net.plainskill.luna

import org.json.JSONObject
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL

/**
 * Minimal Luna HTTP client for photo backup. Sign-in is a pasted (or scanned)
 * access token, same as Luna for Linux. Uploads use the chunked protocol:
 * create → PUT ranges → complete.
 */
object LunaApi {
    const val CHUNK_SIZE = 1024 * 1024 // 1 MiB
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

    fun authMe(baseUrl: String, token: String): UserInfo {
        val result = exchange(baseUrl, "/api/v1/auth/me", "GET", token, null, null)
        if (result.code == 401) {
            throw ApiException(401, badTokenMessage())
        }
        if (result.code !in 200..299) {
            throw ApiException(
                result.code,
                "Luna couldn't check that access token. Check the address, then try again. If it still fails, create a new token in Luna → Settings → Apps and access tokens.",
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
                "Luna couldn't list your drives. Check that this phone can reach Luna, then try again. If it keeps failing, open Luna in a browser and add a drive first.",
            )
        }
        return parseDrives(String(result.body, Charsets.UTF_8))
    }

    fun resolveDriveId(baseUrl: String, token: String, preferredId: String?): String {
        val drives = listDrives(baseUrl, token)
        if (drives.isEmpty()) {
            throw ApiException(
                404,
                "No drives found on Luna. Open Luna in a browser → Drives → add a drive, then try again.",
            )
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

    fun listFiles(baseUrl: String, token: String, driveId: String, path: String): List<FileEntry> {
        val encPath = java.net.URLEncoder.encode(path, Charsets.UTF_8.name()).replace("+", "%20")
        val encId = java.net.URLEncoder.encode(driveId, Charsets.UTF_8.name()).replace("+", "%20")
        val result = exchange(baseUrl, "/api/v1/drives/$encId/files?path=$encPath", "GET", token, null, null)
        if (result.code == 401) throw ApiException(401, badTokenMessage())
        if (result.code == 403) {
            throw ApiException(
                403,
                "This access token can't open that folder. Create a new token in Luna → Settings → Apps and access tokens, and allow access to this drive.",
            )
        }
        if (result.code == 404) {
            throw ApiException(
                404,
                "That folder is gone. Pick another folder, or create a new one.",
            )
        }
        if (result.code !in 200..299) {
            throw ApiException(
                result.code,
                "Luna couldn't open that folder. Check that this phone can reach Luna, then try again.",
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
                    "This access token can't create a folder here. Create a new token in Luna → Settings → Apps and access tokens, and allow Write on this drive.",
                )
                409 -> ApiException(409, "A folder with this name is already here. Choose another name.")
                404 -> ApiException(404, "Luna can't find the parent folder. Open it and try again.")
                else -> ApiException(
                    e.code,
                    "Luna couldn't create that folder. Check the name and that this phone can reach Luna, then try again.",
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
                    "This access token can see the folder but cannot save files there. Create a new token in Luna → Settings → Apps and access tokens, and allow Write on this drive.",
                )
                404 -> ApiException(
                    404,
                    "Luna can't find that folder anymore. Pick the folder again.",
                )
                else -> ApiException(
                    e.code,
                    "Luna couldn't test saving to that folder. Check that this phone can reach Luna, then try again.",
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
        is java.io.IOException ->
            if (error.message == "timed out") {
                "Luna didn't finish answering in time. Check that this phone is on the same network as Luna, and that the drive is working in Luna's Drives page, then try again."
            } else {
                "Luna couldn't be reached. Check the address and that this phone is on the same network as Luna, then try again."
            }
        is IllegalStateException ->
            error.message
                ?: "This phone couldn't store the sign-in safely. Photo backup can't start. Try signing in again."
        else ->
            error.message
                ?: "Something went wrong. Try again. If it keeps happening, sign out and sign in with a new access token from Luna → Settings → Apps and access tokens."
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
        }
        val json = try {
            post(baseUrl, "/api/v1/uploads", body.toString(), token)
        } catch (e: ApiException) {
            throw when (e.code) {
                401 -> ApiException(401, badTokenMessage())
                403 -> ApiException(
                    403,
                    "This access token cannot save files to that folder. Create a new token in Luna → Settings → Apps and access tokens, and allow Write on this drive.",
                )
                else -> ApiException(
                    e.code,
                    e.message?.takeIf { it.isNotBlank() && it != "Request failed (${e.code})" }
                        ?: "Luna couldn't start the photo upload. Check that this phone can reach Luna, then try again.",
                )
            }
        }
        return json.optString("upload_id").ifEmpty {
            throw ApiException(500, "Luna started the upload but didn't return a session. Try Backup now again.")
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
            conn.connectTimeout = remainingTimeoutMs(15000)
            conn.readTimeout = remainingTimeoutMs(60000)
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
            val parsed = HttpIo.readResponse(sock.getInputStream())
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
