package net.plainskill.luna

import android.content.Context
import android.provider.MediaStore
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Backs up photos taken since the last run to Luna's first drive under
 * `Phone Backup/<year>/<month>/`. Runs on unmetered networks while charging,
 * resumes across runs, and reports its outcome through the photo-backup
 * notification channel instead of failing silently.
 */
class PhotoBackupWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val context = applicationContext
        val token = BackupPrefs.token(context)
        val baseUrl = BackupPrefs.baseUrl(context)
        if (token == null || baseUrl == null) {
            return Result.success()
        }
        val notifier = BackupNotifications(context)

        return try {
            val driveId = LunaApi.firstDriveId(baseUrl, token)
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
                    val id = cursor.getLong(idCol)
                    val name = cursor.getString(nameCol).ifEmpty { "photo-$id.jpg" }
                    val size = cursor.getLong(sizeCol)
                    val date = cursor.getLong(dateCol)
                    val uri = android.content.ContentUris.withAppendedId(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id
                    )
                    if (remaining > 0) notifier.showProgress(remaining)
                    context.contentResolver.openInputStream(uri)?.use { stream ->
                        val month = java.text.SimpleDateFormat("yyyy/MM", java.util.Locale.US)
                            .format(java.util.Date(date * 1000))
                        LunaApi.uploadStream(baseUrl, token, driveId, "Phone Backup/$month", name, size, stream)
                        uploaded++
                        newest = maxOf(newest, date)
                    }
                    remaining--
                }
            }
            if (uploaded > 0) BackupPrefs.markBackedUp(context, newest * 1000)
            notifier.clearProgress()
            Result.success()
        } catch (e: LunaApi.ApiException) {
            if (e.unauthorized) {
                // The token was revoked or the account removed. Don't keep
                // retrying — clear the credential and tell the user to set up
                // again.
                BackupPrefs.clearToken(context)
                notifier.showFailure("Your Luna sign-in expired. Reconnect once to start backing up again.")
                Result.failure()
            } else {
                notifier.clearProgress()
                if (runAttemptCount < 3) Result.retry() else Result.failure()
            }
        } catch (e: Exception) {
            notifier.clearProgress()
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }
}
