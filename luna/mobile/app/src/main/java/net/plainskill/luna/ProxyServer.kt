package net.plainskill.luna

import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayInputStream

/**
 * A tiny embedded HTTP proxy that forwards requests to Luna or LibreServ over BLE.
 * The WebView loads http://127.0.0.1:18080/ and every request is piped through
 * the [BleManager].
 */
class ProxyServer(private val bleManager: BleManager, port: Int) : NanoHTTPD(port) {

    override fun serve(session: IHTTPSession): Response {
        val method = session.method.name
        val path = session.uri
        val query = session.queryParameterString?.let { "?$it" } ?: ""
        val fullPath = if (query.isNotEmpty()) "$path$query" else path

        val requestHeaders = mutableMapOf<String, String>()
        session.headers.forEach { (k, v) -> requestHeaders[k] = v }

        val body = try {
            val map = mutableMapOf<String, String>()
            session.parseBody(map)
            map["postData"]?.toByteArray(Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }

        val response = bleManager.proxy(method, fullPath, requestHeaders, body)
            ?: return newFixedLengthResponse("Could not reach your device over Bluetooth")

        val status = CustomStatus(response.status, response.statusText)
        val mimeType = response.headers["Content-Type"] ?: "application/octet-stream"

        return newFixedLengthResponse(
            status,
            mimeType,
            ByteArrayInputStream(response.body),
            response.body.size.toLong()
        )
    }

    private data class CustomStatus(private val code: Int, private val description: String) : Response.IStatus {
        override fun getDescription(): String = description
        override fun getRequestStatus(): Int = code
    }
}
