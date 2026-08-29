package net.plainskill.luna

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

object WorkScheduler {
    const val UNIQUE_WORK = "luna-photo-backup"

    fun sync(context: Context) {
        if (!BackupPrefs.signedIn(context) || !BackupPrefs.backupEnabled(context)) {
            cancel(context)
            return
        }
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(
                if (BackupPrefs.requireUnmetered(context)) NetworkType.UNMETERED
                else NetworkType.CONNECTED
            )
            .apply {
                if (BackupPrefs.requireCharging(context)) {
                    setRequiresCharging(true)
                }
            }
            .build()
        val request = PeriodicWorkRequestBuilder<PhotoBackupWorker>(6, TimeUnit.HOURS)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            UNIQUE_WORK,
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        )
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_WORK)
    }
}
