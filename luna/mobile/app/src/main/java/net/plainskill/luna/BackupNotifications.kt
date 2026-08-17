package net.plainskill.luna

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Small notification surface for photo backup. Keeps the user informed of the
 * worker's outcome without pulling them into the app.
 */
class BackupNotifications(private val context: Context) {

    private val manager: NotificationManager
        get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun allowed(): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED

    fun showActivated(address: String, deviceName: String) {
        if (!allowed()) return
        val note = NotificationCompat.Builder(context, "luna-backup")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Luna photo backup is on")
            .setContentText("$deviceName will back up new photos over Wi-Fi while charging.")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        try {
            manager.notify(STATUS_ID, note)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS permission revoked between check and post.
        }
    }

    fun showStopped() {
        if (!allowed()) return
        val note = NotificationCompat.Builder(context, "luna-backup")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Luna photo backup is off")
            .setContentText("New photos will stay only on this phone.")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        try {
            manager.notify(STATUS_ID, note)
        } catch (_: SecurityException) {
            // Same as above.
        }
    }

    fun showProgress(remaining: Int) {
        if (!allowed()) return
        val note = NotificationCompat.Builder(context, "luna-backup")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Backing up photos")
            .setContentText("Saving $remaining photo(s) to Luna…")
            .setProgress(0, 0, true)
            .setOngoing(true)
            .build()
        try {
            manager.notify(PROGRESS_ID, note)
        } catch (_: SecurityException) {
        }
    }

    fun showFailure(message: String) {
        if (!allowed()) return
        val note = NotificationCompat.Builder(context, "luna-backup")
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("Luna photo backup had a problem")
            .setContentText(message)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        try {
            manager.notify(STATUS_ID, note)
        } catch (_: SecurityException) {
        }
    }

    fun clearProgress() {
        try {
            manager.cancel(PROGRESS_ID)
        } catch (_: SecurityException) {
        }
    }

    companion object {
        private const val STATUS_ID = 2001
        private const val PROGRESS_ID = 2002

        fun safe(context: Context): BackupNotifications {
            return BackupNotifications(context)
        }
    }
}
