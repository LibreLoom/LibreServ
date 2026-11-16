package net.plainskill.luna

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * Append-only record of uploaded items: one `destination<TAB>item` line each.
 * Appending one line per photo keeps a long backup linear, where rewriting a
 * whole store per photo grew quadratically. Neither part ever contains a tab
 * or a newline (a URL-ish destination and a `content://…:size:date` item).
 */
internal class UploadedLog(private val file: File) {

    /** Every item recorded for [destination]. */
    fun items(destination: String): MutableSet<String> {
        val out = HashSet<String>()
        if (!file.exists()) return out
        val prefix = destination + SEP
        file.forEachLine(Charsets.UTF_8) { line ->
            if (line.startsWith(prefix)) out.add(line.substring(prefix.length))
        }
        return out
    }

    // Callers make a fresh instance per call, so lock on one shared object.
    fun add(destination: String, item: String) = synchronized(LOCK) {
        file.parentFile?.mkdirs()
        // A crash mid-append can leave a line without its newline; start a fresh
        // line so the next entry is not glued onto it.
        val lead = if (endsMidLine()) "\n" else ""
        FileOutputStream(file, true).use {
            it.write("$lead$destination$SEP$item\n".toByteArray(Charsets.UTF_8))
        }
    }

    fun clear() {
        synchronized(LOCK) { file.delete() }
    }

    private fun endsMidLine(): Boolean {
        if (!file.exists() || file.length() == 0L) return false
        RandomAccessFile(file, "r").use { raf ->
            raf.seek(raf.length() - 1)
            return raf.read() != '\n'.code
        }
    }

    companion object {
        private const val SEP = '\t'
        private val LOCK = Any()
    }
}
