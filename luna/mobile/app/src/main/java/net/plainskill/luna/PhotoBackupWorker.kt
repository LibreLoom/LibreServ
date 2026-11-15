package net.plainskill.luna

import android.content.Context
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters

/**
 * Backs up photos and videos not yet copied to this destination to the chosen drive under
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
            LunaApi.requireCompatible(baseUrl)
            val driveId = LunaApi.resolveDriveId(baseUrl, token, BackupPrefs.driveId(context))
            val folder = BackupPrefs.folderPrefix(context)
            // History belongs to the destination, not a global media timestamp.
            val destination = "$baseUrl/$driveId/$folder"
            val since = 0L

            data class MediaCol(val id: Int, val name: Int, val size: Int, val date: Int)

            suspend fun backupUri(collection: Uri, projection: Array<String>, selection: String, args: Array<String>, sort: String): Result? {
                val media = context.contentResolver.query(collection, projection, selection, args, sort)
                    ?: throw java.io.IOException("This phone couldn't list your photos. Try again.")
                media.use { cursor ->
                    val cols = MediaCol(
                        cursor.getColumnIndexOrThrow(projection[0]),
                        cursor.getColumnIndexOrThrow(projection[1]),
                        cursor.getColumnIndexOrThrow(projection[2]),
                        cursor.getColumnIndexOrThrow(projection[3]),
                    )
                    var remaining = cursor.count
                    while (cursor.moveToNext()) {
                        if (isStopped) {
                            BackupProgress.idle("Backup paused. Open Luna and tap Backup now to finish.")
                            return Result.retry()
                        }
                        val id = cursor.getLong(cols.id)
                        val name = cursor.getString(cols.name).orEmpty().ifEmpty {
                            if (collection == MediaStore.Video.Media.EXTERNAL_CONTENT_URI) "video-$id.mp4" else "photo-$id.jpg"
                        }
                        val size = cursor.getLong(cols.size)
                        val date = cursor.getLong(cols.date)
                        val uri = android.content.ContentUris.withAppendedId(collection, id)
                        val item = "$uri:$size:$date"
                        if (BackupPrefs.uploaded(context, destination, item)) {
                            remaining--
                            continue
                        }
                        BackupProgress.set(true, "Copying photos to Luna", name)
                        if (remaining > 0) {
                            try {
                                setForeground(foregroundInfo(progressText(remaining)))
                            } catch (_: Exception) {
                                notifier.showProgress(remaining)
                            }
                        }
                        val source = context.contentResolver.openInputStream(uri)
                            ?: throw java.io.IOException("This photo couldn't be opened. Try again.")
                        source.use { stream ->
                            val month = java.text.SimpleDateFormat("yyyy/MM", java.util.Locale.US)
                                .format(java.util.Date(date * 1000))
                            // A content-derived name is stable across retries and cannot collide
                            // with a different photo sharing the camera's filename.
                            val digest = java.security.MessageDigest.getInstance("SHA-256")
                            sourceDigest(context, uri, digest)
                            val hash = digest.digest().joinToString("") { "%02x".format(it) }
                            val stem = name.substringBeforeLast('.', name).take(24)
                            val ext = name.substringAfterLast('.', "").take(12)
                            val remoteName = "$stem-$hash" + if (ext.isEmpty()) "" else ".$ext"
                            LunaApi.uploadStream(baseUrl, token, driveId, LunaApi.joinPath(folder, month), remoteName, size, stream)
                            BackupPrefs.markUploaded(context, destination, item)
                        }
                        remaining--
                    }
                }
                return null
            }

            val imageProjection = arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.SIZE,
                MediaStore.Images.Media.DATE_ADDED,
            )
            backupUri(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                imageProjection,
                "${MediaStore.Images.Media.DATE_ADDED} >= ?",
                arrayOf(since.toString()),
                "${MediaStore.Images.Media.DATE_ADDED} ASC",
            )?.let { return it }

            val videoProjection = arrayOf(
                MediaStore.Video.Media._ID,
                MediaStore.Video.Media.DISPLAY_NAME,
                MediaStore.Video.Media.SIZE,
                MediaStore.Video.Media.DATE_ADDED,
            )
            backupUri(
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                videoProjection,
                "${MediaStore.Video.Media.DATE_ADDED} >= ?",
                arrayOf(since.toString()),
                "${MediaStore.Video.Media.DATE_ADDED} ASC",
            )?.let { return it }

            notifier.clearProgress()
            BackupProgress.idle()
            Result.success()
        } catch (e: LunaApi.IncompatibleException) {
            // Retrying won't help; the person has to update Luna or this app.
            val message = LunaApi.describeError(e)
            BackupProgress.fail(message)
            notifier.clearProgress()
            notifier.showFailure(message)
            Result.failure()
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

    private fun sourceDigest(context: Context, uri: Uri, digest: java.security.MessageDigest) {
        val source = context.contentResolver.openInputStream(uri)
            ?: throw java.io.IOException("This photo couldn't be opened. Try again.")
        source.use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
    }

    private fun progressText(remaining: Int): String =
        if (remaining == 1) "Saving 1 item to Luna…"
        else "Saving $remaining items to Luna…"

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
