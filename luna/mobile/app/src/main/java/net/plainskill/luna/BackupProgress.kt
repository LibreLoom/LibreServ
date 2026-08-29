package net.plainskill.luna

/**
 * In-memory snapshot of the current backup. Status page polls this the way
 * desktop reads the live session list.
 */
object BackupProgress {
    data class Snapshot(
        val running: Boolean,
        val heading: String,
        val detail: String,
        val lastError: String,
        val updatedAtMs: Long,
    )

    @Volatile
    var snapshot: Snapshot = Snapshot(
        running = false,
        heading = "Everything is up to date.",
        detail = "",
        lastError = "",
        updatedAtMs = 0L,
    )
        private set

    fun set(running: Boolean, heading: String, detail: String = "", lastError: String = "") {
        snapshot = Snapshot(running, heading, detail, lastError, System.currentTimeMillis())
    }

    fun idle(heading: String = "Everything is up to date.", lastError: String = "") {
        set(false, heading, "", lastError)
    }

    fun fail(message: String) {
        idle("Backup could not finish.", message)
    }
}
