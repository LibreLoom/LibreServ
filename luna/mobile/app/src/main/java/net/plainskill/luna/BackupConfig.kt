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
        "Luna didn't finish checking that folder in time. Check this phone's network connection and the drive on Luna's Files page, then try again."

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
        "Luna needs access to the photos on this phone. " +
            "Allow it in this phone's Settings → Apps → Luna → Permissions."

    fun testSaved(context: Context): Result {
        val url = BackupPrefs.baseUrl(context)
        val token = BackupPrefs.token(context)
        val driveId = BackupPrefs.driveId(context)
        if (url.isNullOrBlank() || token.isNullOrBlank()) {
            return Result(
                false,
                "You are not signed in. Tap Sign out, then sign in with an access token from Luna → Settings → Security.",
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
            return Result(false, "Finish setup first. Luna needs a drive, a folder, and photo access before it can upload.")
        }
        if (!BackupPrefs.backupEnabled(context)) {
            return Result(false, "Upload is paused. Turn on Upload automatically on the Photo upload page, then try Upload now.")
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
            LunaApi.requireCompatible(baseUrl)
            LunaApi.authMe(baseUrl, token)
            val drives = LunaApi.listDrives(baseUrl, token)
            if (drives.isEmpty()) {
                return Result(
                    false,
                    "No drives found on Luna. Make sure the drive is plugged in, or ask an Admin for access to a drive.",
                )
            }
            val drive = drives.firstOrNull { it.id == driveId }
                ?: return Result(
                    false,
                    "Luna no longer shows the drive you picked. Make sure it is plugged in, or ask an Admin for access to it.",
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
