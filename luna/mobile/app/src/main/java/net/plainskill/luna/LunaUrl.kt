package net.plainskill.luna

/**
 * Normalize user-typed Luna addresses into a canonical base URL (origin).
 *
 * Rules (mirrored from Luna Desktop `luna_url.rs`):
 * 1. Trim leading/trailing whitespace; collapse internal whitespace from messy pastes.
 * 2. Repair common scheme typos (`HTTP://`, `http:/`, `https//`, `http:host`, …).
 * 3. If no scheme: use `http` for localhost / loopback / private LAN / `.local`
 *    (and `.lan` / `.home`); use `https` for public hosts.
 * 4. Lowercase the host; keep an explicit port when present.
 * 5. Drop path, query, and fragment — companions talk to the Luna origin only.
 * 6. No trailing slash.
 */
object LunaUrl {
    const val ADDRESS_PLACEHOLDER = "kitchen.luna.servers.libreloom.org"

    fun emptyAddressMessage(): String =
        "Enter your Luna address (for example $ADDRESS_PLACEHOLDER)."

    fun badAddressMessage(): String =
        "That Luna address does not look right. Try something like $ADDRESS_PLACEHOLDER."

    /**
     * @return canonical `scheme://host[:port]`, or null when [raw] is blank/invalid
     */
    @JvmStatic
    fun normalize(raw: String): String? {
        val collapsed = collapseWhitespace(raw)
        if (collapsed.isEmpty()) return null

        val (schemeHint, afterScheme) = takeScheme(collapsed)
        val authority = authorityOnly(afterScheme)
        if (authority.isEmpty()) return null

        val (hostRaw, port) = splitHostPort(authority) ?: return null
        val host = normalizeHost(hostRaw)
        if (host.isEmpty()) return null

        val scheme = schemeHint ?: defaultSchemeForHost(host)
        return buildString {
            append(scheme)
            append("://")
            append(host)
            if (port != null) {
                append(':')
                append(port)
            }
        }
    }

    private fun collapseWhitespace(raw: String): String =
        raw.trim().split(Regex("\\s+")).joinToString("")

    private fun takeScheme(input: String): Pair<String?, String> {
        val lower = input.lowercase()
        for ((name, constScheme) in listOf("https" to "https", "http" to "http")) {
            if (!lower.startsWith(name)) continue
            val rest = lower.substring(name.length)
            val originalRest = input.substring(name.length)
            var i = 0
            var sawColon = false
            var slashCount = 0
            if (rest.startsWith(":")) {
                sawColon = true
                i = 1
            }
            while (i < rest.length && rest[i] == '/') {
                slashCount++
                i++
            }
            if (sawColon || slashCount > 0) {
                return constScheme to originalRest.substring(i)
            }
        }
        return null to input
    }

    private fun authorityOnly(afterScheme: String): String {
        var s = afterScheme
        while (s.startsWith("/")) s = s.substring(1)
        val end = s.indexOfFirst { it == '/' || it == '?' || it == '#' }
        return if (end < 0) s else s.substring(0, end)
    }

    private fun splitHostPort(authority: String): Pair<String, String?>? {
        val auth = authority.substringAfterLast('@', authority)
        if (auth.startsWith("[")) {
            val close = auth.indexOf(']')
            if (close < 0) return null
            val host = auth.substring(0, close + 1)
            val rest = auth.substring(close + 1)
            if (rest.isEmpty()) return host to null
            if (!rest.startsWith(":")) return null
            val port = validatePort(rest.substring(1)) ?: return null
            return host to port
        }
        val colon = auth.lastIndexOf(':')
        if (colon > 0) {
            val host = auth.substring(0, colon)
            val port = auth.substring(colon + 1)
            if (host.contains(':')) return null
            if (port.isNotEmpty() && port.all { it.isDigit() }) {
                val ok = validatePort(port) ?: return null
                return host to ok
            }
        }
        return auth to null
    }

    private fun validatePort(port: String): String? {
        val n = port.toIntOrNull() ?: return null
        return if (n in 1..65535) port else null
    }

    private fun normalizeHost(host: String): String {
        val trimmed = host.trim()
        return if (trimmed.startsWith("[")) {
            val inner = trimmed.trim('[', ']').lowercase()
            if (inner.isEmpty()) "" else "[$inner]"
        } else {
            val h = trimmed.lowercase()
            // Reject leftovers like ":" from ":///" after authority parsing.
            if (h.isEmpty() || h == ":" || h.none { it.isLetterOrDigit() }) "" else h
        }
    }

    private fun defaultSchemeForHost(host: String): String {
        val bare = host.trim('[', ']')
        return if (PrivateLan.allowsCleartext(bare)) "http" else "https"
    }
}
