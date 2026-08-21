package net.plainskill.luna

/**
 * Household LAN addresses where cleartext HTTP is accepted. The public
 * internet stays on HTTPS (`base-config cleartextTrafficPermitted=false`).
 */
object PrivateLan {
    @JvmStatic
    fun allowsCleartext(host: String): Boolean {
        val h = host.trim().lowercase().removePrefix("[").removeSuffix("]")
        if (h == "localhost" || h == "::1" || h.endsWith(".local")
            || h.endsWith(".lan") || h.endsWith(".home")) {
            return true
        }
        val parts = h.split('.')
        if (parts.size != 4) return false
        val a = parts[0].toIntOrNull() ?: return false
        val b = parts[1].toIntOrNull() ?: return false
        val c = parts[2].toIntOrNull() ?: return false
        val d = parts[3].toIntOrNull() ?: return false
        if (listOf(a, b, c, d).any { it !in 0..255 }) return false
        if (a == 10) return true
        if (a == 127) return true
        if (a == 169 && b == 254) return true
        if (a == 192 && b == 168) return true
        if (a == 172 && b in 16..31) return true
        return false
    }
}
