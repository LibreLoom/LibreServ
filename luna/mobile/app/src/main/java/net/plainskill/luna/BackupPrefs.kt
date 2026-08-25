package net.plainskill.luna

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

object BackupPrefs {
    private const val NAME = "luna_backup"

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
        } catch (e: Exception) {
            null
        }
    }

    fun token(context: Context): String? = prefs(context)?.getString("token", null)
    fun tokenId(context: Context): String? = prefs(context)?.getString("token_id", null)
    fun deviceName(context: Context): String? = prefs(context)?.getString("device_name", null)
    fun baseUrl(context: Context): String? = prefs(context)?.getString("base_url", null)
    fun lastBackupAt(context: Context): Long = prefs(context)?.getLong("last_backup_at", 0L) ?: 0L

    fun saveSession(
        context: Context,
        baseUrl: String,
        token: String,
        deviceName: String? = null,
        tokenId: String? = null,
    ) {
        val p = prefs(context)
            ?: throw IllegalStateException("This phone couldn't store the sign-in safely. Photo backup can't start.")
        p.edit()
            .putString("base_url", baseUrl)
            .putString("token", token)
            .apply {
                if (deviceName != null) putString("device_name", deviceName)
                if (tokenId != null) putString("token_id", tokenId)
                apply()
            }
    }

    fun clearToken(context: Context) {
        prefs(context)?.edit()?.remove("token")?.remove("token_id")?.remove("device_name")?.apply()
    }

    fun markBackedUp(context: Context, time: Long) {
        prefs(context)?.edit()?.putLong("last_backup_at", time)?.apply()
    }
}
