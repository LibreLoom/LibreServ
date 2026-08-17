package net.plainskill.luna

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Switch
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class BackupActivity : AppCompatActivity() {
    private val notificationsCode = 1001

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_backup)

        val baseUrl = findViewById<EditText>(R.id.baseUrl)
        val deviceName = findViewById<EditText>(R.id.deviceName)
        val username = findViewById<EditText>(R.id.username)
        val password = findViewById<EditText>(R.id.password)
        val save = findViewById<Button>(R.id.saveButton)
        val turnOff = findViewById<Button>(R.id.turnOffButton)
        val backupSwitch = findViewById<Switch>(R.id.backupSwitch)
        val status = findViewById<TextView>(R.id.backupStatus)

        ensureNotificationChannel()

        baseUrl.setText(BackupPrefs.baseUrl(this) ?: "http://luna.local")
        deviceName.setText(BackupPrefs.deviceName(this) ?: Build.MODEL ?: "Android phone")

        val configured = BackupPrefs.token(this) != null
        backupSwitch.isChecked = configured
        backupSwitch.isEnabled = configured
        save.visibility = if (configured) android.view.View.GONE else android.view.View.VISIBLE
        turnOff.visibility = if (configured) android.view.View.VISIBLE else android.view.View.GONE
        if (configured) {
            status.text = "Backup is on. Photos save on Wi-Fi while this phone charges."
        }

        backupSwitch.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked && BackupPrefs.token(this) != null) {
                scheduleWorker()
                status.text = "Backup is on. Photos save on Wi-Fi while this phone charges."
            }
            // Turning off is handled by the dedicated button so the user
            // explicitly decides to remove this phone's access.
        }

        save.setOnClickListener {
            val url = baseUrl.text.toString().trim().trimEnd('/')
            val name = deviceName.text.toString().trim()
            if (url.isEmpty() || username.text.isBlank() || password.text.isBlank()) {
                status.text = "Fill in the address, username, and password first."
                return@setOnClickListener
            }
            if (name.isEmpty()) {
                status.text = "Give this phone a name so you can recognize it later."
                return@setOnClickListener
            }
            save.isEnabled = false
            status.text = "Signing in…"
            thread {
                try {
                    activate(this, url,
                        username.text.toString().trim(), password.text.toString(), name)
                } finally {
                    runOnUiThread { save.isEnabled = true }
                }
            }
        }

        turnOff.setOnClickListener {
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS), notificationsCode)
                return@setOnClickListener
            }
            deactivate()
        }
    }

    private fun activate(
        activity: BackupActivity,
        url: String,
        username: String,
        password: String,
        name: String,
    ) {
        try {
            val session = LunaApi.login(url, username, password)
            val device = LunaApi.createDeviceToken(url, session, name)
            BackupPrefs.saveSession(this, url, device.token, name)
            try {
                LunaApi.revokeToken(url, session, device.id)
            } catch (_: Exception) {
                // The device token is the durable credential; the temporary
                // session cookie will expire on its own.
            }
            scheduleWorker()

            val notifier = BackupNotifications(this)
            notifier.showActivated(url, name)
            runOnUiThread {
                findViewById<Switch>(R.id.backupSwitch).isChecked = true
                findViewById<Switch>(R.id.backupSwitch).isEnabled = true
                findViewById<Button>(R.id.saveButton).visibility = android.view.View.GONE
                findViewById<Button>(R.id.turnOffButton).visibility = android.view.View.VISIBLE
                findViewById<TextView>(R.id.backupStatus).text =
                    "Backup is on. Photos save on Wi-Fi while charging."
            }
        } catch (e: LunaApi.ApiException) {
            runOnUiThread {
                findViewById<TextView>(R.id.backupStatus).text =
                    if (e.unauthorized) "That username or password is wrong."
                    else e.message ?: "Could not sign in. Check the address and password."
            }
        } catch (e: IOException) {
            runOnUiThread {
                findViewById<TextView>(R.id.backupStatus).text =
                    "Could not reach Luna. Check the address and that this phone is on the same network."
            }
        } catch (e: Exception) {
            runOnUiThread {
                findViewById<TextView>(R.id.backupStatus).text = e.message ?: "Could not sign in."
            }
        }
    }

    private fun deactivate() {
        BackupPrefs.clearToken(this)
        WorkManager.getInstance(this).cancelUniqueWork("luna-photo-backup")
        BackupNotifications(this).showStopped()
        findViewById<Switch>(R.id.backupSwitch).isChecked = false
        findViewById<Switch>(R.id.backupSwitch).isEnabled = false
        findViewById<Button>(R.id.saveButton).visibility = android.view.View.VISIBLE
        findViewById<Button>(R.id.turnOffButton).visibility = android.view.View.GONE
        findViewById<TextView>(R.id.backupStatus).text =
            "Backup is off. Tap \"Turn photo backup on\" to set it up again."
    }

    private fun scheduleWorker() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .setRequiresCharging(true)
            .build()
        val request = PeriodicWorkRequestBuilder<PhotoBackupWorker>(6, TimeUnit.HOURS)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "luna-photo-backup",
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        )
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(
                "luna-backup",
                "Photo backup",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "Progress and status for Luna photo backup" }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}
