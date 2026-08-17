package net.plainskill.luna

import android.content.Context
import android.content.SharedPreferences

object BackupPrefs {
    private const val NAME = "luna_backup"

    fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun token(context: Context): String? = prefs(context).getString("token", null)
    fun deviceName(context: Context): String? = prefs(context).getString("device_name", null)
    fun baseUrl(context: Context): String? = prefs(context).getString("base_url", null)
    fun lastBackupAt(context: Context): Long = prefs(context).getLong("last_backup_at", 0L)

    fun saveSession(context: Context, baseUrl: String, token: String, deviceName: String? = null) {
        prefs(context).edit()
            .putString("base_url", baseUrl)
            .putString("token", token)
            .apply {
                if (deviceName != null) putString("device_name", deviceName)
                apply()
            }
    }

    fun clearToken(context: Context) {
        prefs(context).edit().remove("token").remove("device_name").apply()
    }

    fun markBackedUp(context: Context, time: Long) {
        prefs(context).edit().putLong("last_backup_at", time).apply()
    }
}
