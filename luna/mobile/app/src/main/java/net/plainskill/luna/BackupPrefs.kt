package net.plainskill.luna

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

object BackupPrefs {
    private const val NAME = "luna_backup"
    const val DEFAULT_FOLDER = ""

    /**
     * The bearer token grants access to the user's files, so it is stored
     * encrypted at rest (Android Keystore-backed). If encryption is
     * unavailable we fail closed — never fall back to a plaintext file.
     */
    private fun prefs(context: Context): SharedPreferences? {
        return try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (_: Exception) {
            null
        }
    }

    fun token(context: Context): String? = prefs(context)?.getString("token", null)
    fun username(context: Context): String? = prefs(context)?.getString("username", null)
    fun baseUrl(context: Context): String? = prefs(context)?.getString("base_url", null)
    fun driveId(context: Context): String? = prefs(context)?.getString("drive_id", null)
    fun driveLabel(context: Context): String? = prefs(context)?.getString("drive_label", null)
    fun folderPrefix(context: Context): String =
        prefs(context)?.getString("folder_prefix", DEFAULT_FOLDER)?.trim()?.trim('/') ?: DEFAULT_FOLDER
    fun setupComplete(context: Context): Boolean =
        prefs(context)?.getBoolean("setup_complete", false) ?: false
    fun requireUnmetered(context: Context): Boolean =
        prefs(context)?.getBoolean("require_unmetered", true) ?: true
    fun requireCharging(context: Context): Boolean =
        prefs(context)?.getBoolean("require_charging", true) ?: true
    fun backupEnabled(context: Context): Boolean =
        prefs(context)?.getBoolean("backup_enabled", true) ?: true
    fun askedBattery(context: Context): Boolean =
        prefs(context)?.getBoolean("asked_battery", false) ?: false
    fun lastBackupAt(context: Context): Long = prefs(context)?.getLong("last_backup_at", 0L) ?: 0L

    fun signedIn(context: Context): Boolean = !token(context).isNullOrBlank()

    fun saveSession(
        context: Context,
        baseUrl: String,
        token: String,
        username: String,
        driveId: String? = null,
        driveLabel: String? = null,
    ) {
        val p = prefs(context)
            ?: throw IllegalStateException("This phone couldn't store the sign-in safely. Photo backup can't start.")
        p.edit()
            .putString("base_url", baseUrl)
            .putString("token", token)
            .putString("username", username)
            .putBoolean("backup_enabled", true)
            .putBoolean("setup_complete", false)
            .apply {
                if (driveId != null) putString("drive_id", driveId)
                if (driveLabel != null) putString("drive_label", driveLabel)
            }
            .apply()
    }

    fun setBackupEnabled(context: Context, enabled: Boolean) {
        prefs(context)?.edit()?.putBoolean("backup_enabled", enabled)?.apply()
    }

    fun setRequireUnmetered(context: Context, value: Boolean) {
        prefs(context)?.edit()?.putBoolean("require_unmetered", value)?.apply()
    }

    fun setRequireCharging(context: Context, value: Boolean) {
        prefs(context)?.edit()?.putBoolean("require_charging", value)?.apply()
    }

    fun setDrive(context: Context, id: String, label: String) {
        prefs(context)?.edit()?.putString("drive_id", id)?.putString("drive_label", label)?.apply()
    }

    fun setFolderPrefix(context: Context, folder: String) {
        prefs(context)?.edit()?.putString("folder_prefix", folder.trim().trim('/'))?.apply()
    }

    fun setSetupComplete(context: Context, complete: Boolean) {
        prefs(context)?.edit()?.putBoolean("setup_complete", complete)?.apply()
    }

    fun destinationLabel(context: Context): String {
        val drive = driveLabel(context)?.ifBlank { null } ?: "Drive"
        val folder = folderPrefix(context)
        return if (folder.isEmpty()) "$drive · Drive root" else "$drive · $folder"
    }

    fun setAskedBattery(context: Context, asked: Boolean) {
        prefs(context)?.edit()?.putBoolean("asked_battery", asked)?.apply()
    }

    fun clearSession(context: Context) {
        prefs(context)?.edit()?.clear()?.apply()
    }

    fun markBackedUp(context: Context, time: Long) {
        prefs(context)?.edit()?.putLong("last_backup_at", time)?.apply()
    }
}
