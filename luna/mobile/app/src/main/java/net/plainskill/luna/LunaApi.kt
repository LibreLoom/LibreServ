package net.plainskill.luna

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Minimal Luna HTTP client for the backup worker. Speaks the same chunked
 * upload protocol as the web app: create → PUT ranges → complete.
 */
object LunaApi {
    const val CHUNK_SIZE = 1024 * 1024 // 1 MiB

    class ApiException(val code: Int, message: String) : Exception(message)

    fun login(baseUrl: String, username: String, password: String): String {
        val body = JSONObject().apply {
            put("username", username)
            put("password", password)
        }
        val json = post(baseUrl, "/api/v1/auth/login", body.toString(), null)
        return json.optString("token").ifEmpty { throw ApiException(401, "No session token in reply") }
    }

    fun firstDriveId(baseUrl: String, token: String): String {
        val drives = getArray(baseUrl, "/api/v1/drives", token)
        val first = drives.optJSONObject(0) ?: throw ApiException(404, "No drives found on Luna")
        return first.optString("id").ifEmpty { throw ApiException(404, "No drives found on Luna") }
    }

    private fun getArray(baseUrl: String, path: String, token: String): JSONArray {
        val conn = open(baseUrl, path, token)
        try {
            conn.requestMethod = "GET"
            val code = conn.responseCode
            if (code !in 200..299) throw ApiException(code, readError(conn))
            return JSONArray(conn.inputStream.readText())
        } finally {
            conn.disconnect()
        }
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
        val conn = open(baseUrl, "/api/v1/uploads/$uploadId", token)
        try {
            conn.requestMethod = "PUT"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/octet-stream")
            conn.setRequestProperty("Content-Range", "bytes $start-${start + data.size - 1}/$total")
            conn.outputStream.use { it.write(data) }
            if (conn.responseCode !in 200..299) throw ApiException(conn.responseCode, readError(conn))
        } finally {
            conn.disconnect()
        }
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

    private fun open(baseUrl: String, path: String, token: String?): HttpURLConnection {
        val url = URL(baseUrl.trimEnd('/') + path)
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 60000
        conn.setRequestProperty("Accept", "application/json")
        if (token != null) conn.setRequestProperty("Authorization", "Bearer $token")
        return conn
    }

    private fun post(baseUrl: String, path: String, body: String, token: String?): JSONObject {
        val conn = open(baseUrl, path, token)
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            if (body.isNotEmpty()) conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) throw ApiException(code, readError(conn))
            val text = conn.inputStream.readText()
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }

    private fun readError(conn: HttpURLConnection): String {
        return try {
            val stream = conn.errorStream ?: return "Request failed (${conn.responseCode})"
            val text = stream.readText()
            try { JSONObject(text).optString("error") } catch (_: Exception) { text }
        } catch (_: Exception) {
            "Request failed (${conn.responseCode})"
        }
    }

    private fun InputStream.readText(): String = ByteArrayOutputStream().use { out ->
        use { copyTo(out) }
        out.toString("UTF-8")
    }
}
