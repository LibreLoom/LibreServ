package net.plainskill.luna

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Reachability + write check for the chosen drive/folder. Used after the user
 * picks a destination, after setup, and before Backup now.
 */
object BackupConfig {
    data class Result(val ok: Boolean, val message: String)

    private const val TEST_DEADLINE_MS = 15_000L
    const val TIMEOUT_MESSAGE =
        "Luna didn't finish checking that folder. The drive may be busy, or this phone lost the connection. Open Luna in a browser → Drives and confirm the drive works, then try again."

    fun hasPhotoAccess(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= 33) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_IMAGES) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            ContextCompat.checkSelfPermission(context, Manifest.permission.READ_EXTERNAL_STORAGE) ==
                PackageManager.PERMISSION_GRANTED
        }
    }

    fun photosNeeded(): Array<String> {
        return if (Build.VERSION.SDK_INT >= 33) {
            arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.POST_NOTIFICATIONS)
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    fun photosDeniedMessage(): String =
        "Luna needs access to photos on this phone to copy them. Tap Grant again, then choose Allow. " +
            "If you already picked Don't allow, open this phone's Settings → Apps → Luna → Permissions → Photos, and allow access."

    fun testSaved(context: Context): Result {
        val url = BackupPrefs.baseUrl(context)
        val token = BackupPrefs.token(context)
        val driveId = BackupPrefs.driveId(context)
        if (url.isNullOrBlank() || token.isNullOrBlank()) {
            return Result(
                false,
                "You're not signed in. Sign out, then sign in again with an access token from Luna → Settings → Apps and access tokens.",
            )
        }
        if (driveId.isNullOrBlank()) {
            return Result(
                false,
                "No drive is chosen yet. Open Settings and pick the drive and folder where photos should go.",
            )
        }
        return timed { testBlocking(url, token, driveId, BackupPrefs.folderPrefix(context)) }
    }

    fun testForBackupNow(context: Context): Result {
        if (!BackupPrefs.setupComplete(context)) {
            return Result(false, "Finish setup first. Luna needs a drive, a folder, and photo access before it can back up.")
        }
        if (!BackupPrefs.backupEnabled(context)) {
            return Result(false, "Backup is paused. Turn on Back up automatically on the Backup page, then try Backup now.")
        }
        if (!hasPhotoAccess(context)) {
            return Result(false, photosDeniedMessage())
        }
        return testSaved(context)
    }

    fun test(baseUrl: String, token: String, driveId: String, folder: String): Result {
        return timed { testBlocking(baseUrl, token, driveId, folder) }
    }

    private fun timed(block: () -> Result): Result {
        val exec = Executors.newSingleThreadExecutor()
        val future = exec.submit(Callable {
            LunaApi.withDeadline(TEST_DEADLINE_MS, block)
        })
        return try {
            future.get(TEST_DEADLINE_MS + 1_000L, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            future.cancel(true)
            Result(false, TIMEOUT_MESSAGE)
        } catch (e: ExecutionException) {
            val cause = e.cause
            Result(false, LunaApi.describeError(if (cause is Exception) cause else Exception(e.message)))
        } catch (e: Exception) {
            Result(false, LunaApi.describeError(e))
        } finally {
            exec.shutdownNow()
        }
    }

    internal fun testBlocking(baseUrl: String, token: String, driveId: String, folder: String): Result {
        return try {
            LunaApi.authMe(baseUrl, token)
            val drives = LunaApi.listDrives(baseUrl, token)
            if (drives.isEmpty()) {
                return Result(
                    false,
                    "No drives found on Luna. Open Luna in a browser → Drives → add a drive, then pick it here again.",
                )
            }
            val drive = drives.firstOrNull { it.id == driveId }
                ?: return Result(
                    false,
                    "The drive you picked is no longer on Luna. Pick another drive, then pick the folder again.",
                )
            LunaApi.listFiles(baseUrl, token, driveId, folder)
            LunaApi.probeWrite(baseUrl, token, driveId, folder)
            val where = if (folder.isEmpty()) "${drive.label} (drive root)" else "${drive.label} / $folder"
            Result(true, "Luna can save photos to $where.")
        } catch (e: Exception) {
            Result(false, LunaApi.describeError(e))
        }
    }
}
