package net.plainskill.luna

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters

/**
 * Backs up photos taken since the last run to the chosen drive under
 * `<folder>/<year>/<month>/`. Runs under WorkManager constraints, promotes
 * itself to a data-sync foreground job so Android does not kill the upload,
 * and only alerts when backup cannot continue.
 */
class PhotoBackupWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val context = applicationContext
        val token = BackupPrefs.token(context)
        val baseUrl = BackupPrefs.baseUrl(context)
        if (token == null || baseUrl == null || !BackupPrefs.backupEnabled(context) || !BackupPrefs.setupComplete(context)) {
            BackupProgress.idle()
            return Result.success()
        }
        if (!BackupConfig.hasPhotoAccess(context)) {
            val message = BackupConfig.photosDeniedMessage()
            BackupProgress.fail(message)
            return Result.failure()
        }
        val notifier = BackupNotifications(context)
        BackupProgress.set(true, "Copying photos to Luna", "Checking for new photos")
        try {
            setForeground(foregroundInfo("Checking for new photos…"))
        } catch (_: Exception) {
            // Notification permission denied — still try the backup.
        }

        return try {
            val driveId = LunaApi.resolveDriveId(baseUrl, token, BackupPrefs.driveId(context))
            val folder = BackupPrefs.folderPrefix(context)
            val since = BackupPrefs.lastBackupAt(context) / 1000
            val projection = arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.SIZE,
                MediaStore.Images.Media.DATE_ADDED,
            )
            val selection = "${MediaStore.Images.Media.DATE_ADDED} > ?"
            val args = arrayOf(since.toString())
            var uploaded = 0
            var newest = since
            context.contentResolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection, selection, args,
                "${MediaStore.Images.Media.DATE_ADDED} ASC"
            )?.use { cursor ->
                val idCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
                val nameCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
                val sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
                val dateCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
                var remaining = cursor.count
                while (cursor.moveToNext()) {
                    if (isStopped) {
                        BackupProgress.idle("Backup paused. Open Luna and tap Backup now to finish.")
                        return Result.retry()
                    }
                    val id = cursor.getLong(idCol)
                    val name = cursor.getString(nameCol).ifEmpty { "photo-$id.jpg" }
                    val size = cursor.getLong(sizeCol)
                    val date = cursor.getLong(dateCol)
                    val uri = android.content.ContentUris.withAppendedId(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id
                    )
                    BackupProgress.set(true, "Copying photos to Luna", name)
                    if (remaining > 0) {
                        try {
                            setForeground(foregroundInfo(progressText(remaining)))
                        } catch (_: Exception) {
                            notifier.showProgress(remaining)
                        }
                    }
                    context.contentResolver.openInputStream(uri)?.use { stream ->
                        val month = java.text.SimpleDateFormat("yyyy/MM", java.util.Locale.US)
                            .format(java.util.Date(date * 1000))
                        LunaApi.uploadStream(baseUrl, token, driveId, LunaApi.joinPath(folder, month), name, size, stream)
                        uploaded++
                        newest = maxOf(newest, date)
                    }
                    remaining--
                }
            }
            if (uploaded > 0) BackupPrefs.markBackedUp(context, newest * 1000)
            notifier.clearProgress()
            BackupProgress.idle()
            Result.success()
        } catch (e: LunaApi.ApiException) {
            val message = LunaApi.describeError(e)
            BackupProgress.fail(message)
            if (e.unauthorized) {
                BackupPrefs.clearSession(context)
                notifier.clearProgress()
                notifier.showFailure(message)
                Result.failure()
            } else {
                notifier.clearProgress()
                if (runAttemptCount < 3) Result.retry() else {
                    notifier.showFailure(message)
                    Result.failure()
                }
            }
        } catch (e: Exception) {
            val message = LunaApi.describeError(e)
            BackupProgress.fail(message)
            notifier.clearProgress()
            if (runAttemptCount < 3) Result.retry() else {
                notifier.showFailure(message)
                Result.failure()
            }
        }
    }

    private fun progressText(remaining: Int): String =
        if (remaining == 1) "Saving 1 photo to Luna…"
        else "Saving $remaining photos to Luna…"

    private fun foregroundInfo(text: String): ForegroundInfo {
        val note = NotificationCompat.Builder(applicationContext, BackupNotifications.PROGRESS_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Backing up photos")
            .setContentText(text)
            .setProgress(0, 0, true)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        return if (Build.VERSION.SDK_INT >= 29) {
            ForegroundInfo(FOREGROUND_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(FOREGROUND_ID, note)
        }
    }

    companion object {
        private const val FOREGROUND_ID = 2002
    }
}
