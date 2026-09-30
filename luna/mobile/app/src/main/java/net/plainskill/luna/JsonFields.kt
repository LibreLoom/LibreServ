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
