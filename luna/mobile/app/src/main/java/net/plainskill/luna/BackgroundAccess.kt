package net.plainskill.luna

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * Android's battery saver ("optimization") defers or kills background work.
 * Photo backup needs Luna set to Unrestricted / Don't optimize, or WorkManager
 * may not run for hours — or at all on some phones.
 */
object BackgroundAccess {
    fun isUnrestricted(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            ?: return true
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * Opens the system prompt to leave Luna unrestricted. If that screen is
     * missing (some phones), opens the app's battery settings instead.
     */
    fun requestUnrestricted(activity: Activity) {
        if (isUnrestricted(activity)) return
        val pkg = Uri.parse("package:${activity.packageName}")
        val prompt = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData(pkg)
        try {
            activity.startActivity(prompt)
            return
        } catch (_: ActivityNotFoundException) {
        } catch (_: SecurityException) {
        }
        openAppSettings(activity)
    }

    fun openAppSettings(context: Context) {
        val pkg = Uri.parse("package:${context.packageName}")
        val app = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(pkg)
        try {
            context.startActivity(app)
            return
        } catch (_: ActivityNotFoundException) {
        }
        try {
            context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (_: ActivityNotFoundException) {
        }
    }
}
