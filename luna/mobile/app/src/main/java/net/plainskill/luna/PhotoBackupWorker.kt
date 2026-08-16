package net.plainskill.luna

import android.content.Context
import android.provider.MediaStore
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Backs up photos taken since the last run to Luna's first drive under
 * `Phone Backup/<year>/<month>/`. Runs on unmetered networks while charging.
 */
class PhotoBackupWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val context = applicationContext
        val token = BackupPrefs.token(context) ?: return Result.success()
        val baseUrl = BackupPrefs.baseUrl(context) ?: return Result.success()

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
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(idCol)
                    val name = cursor.getString(nameCol).ifEmpty { "photo-$id.jpg" }
                    val size = cursor.getLong(sizeCol)
                    val date = cursor.getLong(dateCol)
                    val uri = android.content.ContentUris.withAppendedId(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id
                    )
                    context.contentResolver.openInputStream(uri)?.use { stream ->
                        val month = java.text.SimpleDateFormat("yyyy/MM", java.util.Locale.US)
                            .format(java.util.Date(date * 1000))
                        LunaApi.uploadStream(baseUrl, token, driveId, "Phone Backup/$month", name, size, stream)
                        uploaded++
                        newest = maxOf(newest, date)
                    }
                }
            }
            if (uploaded > 0) BackupPrefs.markBackedUp(context, newest * 1000)
            Result.success()
        } catch (e: Exception) {
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }
}
