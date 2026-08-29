package net.plainskill.luna

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

object WorkScheduler {
    private const val UNIQUE = "luna-photo-backup"
    private const val UNIQUE_NOW = "luna-photo-backup-now"

    fun sync(context: Context) = schedule(context)

    fun schedule(context: Context) {
        val wm = WorkManager.getInstance(context)
        if (!BackupPrefs.setupComplete(context)) {
            wm.cancelUniqueWork(UNIQUE)
            return
        }
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(
                if (BackupPrefs.requireUnmetered(context)) NetworkType.UNMETERED else NetworkType.CONNECTED,
            )
            .setRequiresCharging(BackupPrefs.requireCharging(context))
            .build()
        val request = PeriodicWorkRequestBuilder<PhotoBackupWorker>(6, TimeUnit.HOURS)
            .setConstraints(constraints)
            .build()
        wm.enqueueUniquePeriodicWork(UNIQUE, ExistingPeriodicWorkPolicy.UPDATE, request)
    }

    /** Start a backup now. No Wi-Fi/charging wait. */
    fun runSoon(context: Context) {
        if (!BackupPrefs.setupComplete(context)) return
        BackupProgress.set(true, "Starting backup…", "Checking for new photos")
        val request = OneTimeWorkRequestBuilder<PhotoBackupWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            UNIQUE_NOW,
            ExistingWorkPolicy.REPLACE,
            request,
        )
        schedule(context)
    }

    fun cancel(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.cancelUniqueWork(UNIQUE)
        wm.cancelUniqueWork(UNIQUE_NOW)
    }
}
