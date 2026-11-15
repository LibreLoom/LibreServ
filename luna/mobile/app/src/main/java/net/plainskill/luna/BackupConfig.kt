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

    /** Photos, videos, and the location Android hides from them, asked together. */
    fun mediaPermissions(): Array<String> {
        val list = ArrayList<String>()
        if (Build.VERSION.SDK_INT >= 33) {
            list += Manifest.permission.READ_MEDIA_IMAGES
            list += Manifest.permission.READ_MEDIA_VIDEO
        } else {
            list += Manifest.permission.READ_EXTERNAL_STORAGE
        }
        if (Build.VERSION.SDK_INT >= 29) list += Manifest.permission.ACCESS_MEDIA_LOCATION
        return list.toTypedArray()
    }

    /** Notifications only need asking on Android 13 and newer. */
    fun notificationPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray()

    /** True when photos keep their GPS location when Luna reads them. */
    fun canReadOriginals(context: Context): Boolean =
        Build.VERSION.SDK_INT >= 29 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_MEDIA_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** Media permissions this phone still lacks (videos and location can be missing after an update). */
    fun missingMediaPermissions(context: Context): List<String> =
        mediaPermissions().filter {
            ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
        }

    fun photosDeniedMessage(): String =
        "Luna needs access to the photos and videos on this phone. " +
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
