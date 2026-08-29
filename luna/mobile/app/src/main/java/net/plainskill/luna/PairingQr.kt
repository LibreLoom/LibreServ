package net.plainskill.luna

import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Phone pairing payload shared with Luna web. The QR (or a `luna://pair`
 * link) carries the Luna address and the access token so the login screen
 * can fill both fields.
 */
data class Pairing(val url: String, val token: String)

object PairingQr {
    fun encode(url: String, token: String): String {
        val cleanUrl = trimUrl(url)
        val cleanToken = token.trim()
        return "luna://pair?url=${enc(cleanUrl)}&token=${enc(cleanToken)}"
    }

    fun decode(raw: String?): Pairing? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        if (text.startsWith("{")) {
            val url = trimUrl(JsonFields.string(text, "url") ?: "")
            val token = (JsonFields.string(text, "token") ?: "").trim()
            return if (url.isEmpty() || token.isEmpty()) null else Pairing(url, token)
        }
        val lower = text.lowercase()
        if (!lower.startsWith("luna://pair") && !lower.startsWith("luna:pair")) {
            return null
        }
        val query = text.substringAfter('?', "")
        if (query.isEmpty()) return null
        val params = linkedMapOf<String, String>()
        for (part in query.split('&')) {
            val eq = part.indexOf('=')
            if (eq <= 0) continue
            params[dec(part.substring(0, eq))] = dec(part.substring(eq + 1))
        }
        val url = trimUrl(params["url"] ?: "")
        val token = (params["token"] ?: "").trim()
        if (url.isEmpty() || token.isEmpty()) return null
        return Pairing(url, token)
    }

    private fun trimUrl(url: String): String = url.trim().trimEnd('/')

    private fun enc(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20")

    private fun dec(value: String): String =
        URLDecoder.decode(value, StandardCharsets.UTF_8.name())
}
