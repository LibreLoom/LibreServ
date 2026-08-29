package net.plainskill.luna

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Quiet photo-backup notifications. Progress is silent and updates in place.
 * Alerts fire only when backup cannot continue (expired token or last retry).
 */
class BackupNotifications(private val context: Context) {

    private val manager: NotificationManager
        get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun allowed(): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED

    fun showProgress(remaining: Int) {
        if (!allowed()) return
        val note = NotificationCompat.Builder(context, PROGRESS_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Backing up photos")
            .setContentText(
                if (remaining == 1) "Saving 1 photo to Luna…"
                else "Saving $remaining photos to Luna…"
            )
            .setProgress(0, 0, true)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        notify(PROGRESS_ID, note)
    }

    fun showFailure(message: String) {
        if (!allowed()) return
        val note = NotificationCompat.Builder(context, ALERT_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("Luna photo backup had a problem")
            .setContentText(message)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        notify(STATUS_ID, note)
    }

    fun clearProgress() {
        try {
            manager.cancel(PROGRESS_ID)
        } catch (_: SecurityException) {
        }
    }

    private fun notify(id: Int, note: android.app.Notification) {
        try {
            manager.notify(id, note)
        } catch (_: SecurityException) {
        }
    }

    companion object {
        const val PROGRESS_CHANNEL = "luna-backup-progress"
        const val ALERT_CHANNEL = "luna-backup-alerts"
        private const val STATUS_ID = 2001
        private const val PROGRESS_ID = 2002

        fun ensureChannels(context: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(
                    PROGRESS_CHANNEL,
                    "Photo backup progress",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Quiet progress while photos save to Luna"
                    setShowBadge(false)
                }
            )
            manager.createNotificationChannel(
                NotificationChannel(
                    ALERT_CHANNEL,
                    "Photo backup alerts",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "Only when photo backup needs you to sign in again"
                }
            )
        }
    }
}
