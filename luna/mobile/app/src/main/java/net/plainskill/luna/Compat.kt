package net.plainskill.luna

/** What Luna says about its API on `GET /api/v1/health`. */
data class ApiInfo(val version: Int, val oldestSupported: Int)

enum class Compat {
    OK,
    LUNA_TOO_OLD,
    APP_TOO_OLD,
}

/** The Luna API version this app was written against. Defined once, here. */
const val CLIENT_API = 1

object Compatibility {
    /** A missing or unreadable `api` block means Luna predates the check. */
    fun check(api: ApiInfo?, clientApi: Int = CLIENT_API): Compat = when {
        api == null -> Compat.LUNA_TOO_OLD
        clientApi > api.version -> Compat.LUNA_TOO_OLD
        clientApi < api.oldestSupported -> Compat.APP_TOO_OLD
        else -> Compat.OK
    }

    /** Reads `"api": {"version": n, "oldest_supported": n}`; null if absent or malformed. */
    fun parseApi(healthBody: String): ApiInfo? {
        val block = Regex("\"api\"\\s*:\\s*\\{([^{}]*)\\}").find(healthBody)?.groupValues?.get(1)
            ?: return null
        val version = JsonFields.int(block, "version") ?: return null
        val oldest = JsonFields.int(block, "oldest_supported") ?: return null
        if (version < 1 || oldest < 1) return null
        return ApiInfo(version, oldest)
    }

    fun message(compat: Compat): String? = when (compat) {
        Compat.OK -> null
        Compat.LUNA_TOO_OLD ->
            "This Luna is too old for this app. Update Luna in Settings → About → System updates."
        Compat.APP_TOO_OLD ->
            "This app is too old for your Luna. Update Luna Android from F-Droid, or download the latest APK."
    }
}
