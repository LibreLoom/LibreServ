package net.plainskill.luna

/**
 * Tiny JSON field reader for Luna's flat objects. Host JVM unit tests cannot
 * use Android's stubbed `org.json.JSONObject` (it throws at runtime).
 */
internal object JsonFields {
    fun string(json: String, key: String): String? {
        val pattern = Regex("\"${Regex.escape(key)}\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"")
        val raw = pattern.find(json)?.groupValues?.get(1) ?: return null
        return raw.replace("\\\"", "\"").replace("\\\\", "\\")
    }

    /** The nested object under [key], or null when it is missing or `null`. */
    fun obj(json: String, key: String): String? {
        val start = Regex("\"${Regex.escape(key)}\"\\s*:\\s*\\{").find(json) ?: return null
        val from = start.range.last
        var depth = 0
        for (i in from until json.length) {
            if (json[i] == '{') depth++
            if (json[i] == '}') {
                depth--
                if (depth == 0) return json.substring(from, i + 1)
            }
        }
        return null
    }

    fun objects(arrayJson: String): List<String> {
        val out = ArrayList<String>()
        val s = arrayJson
        var i = 0
        while (i < s.length) {
            if (s[i] == '{') {
                var depth = 0
                val start = i
                while (i < s.length) {
                    if (s[i] == '{') depth++
                    if (s[i] == '}') {
                        depth--
                        if (depth == 0) {
                            out.add(s.substring(start, i + 1))
                            break
                        }
                    }
                    i++
                }
            }
            i++
        }
        return out
    }
}
