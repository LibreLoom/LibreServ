package net.plainskill.luna

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class BackupActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_backup)

        val baseUrl = findViewById<EditText>(R.id.baseUrl)
        val username = findViewById<EditText>(R.id.username)
        val password = findViewById<EditText>(R.id.password)
        val save = findViewById<Button>(R.id.saveButton)
        val status = findViewById<TextView>(R.id.backupStatus)

        baseUrl.setText(BackupPrefs.baseUrl(this) ?: "http://luna.local")
        if (BackupPrefs.token(this) != null) {
            status.text = "Backup is set up. Photos save when you're on Wi-Fi and charging."
        }

        save.setOnClickListener {
            val url = baseUrl.text.toString().trim().trimEnd('/')
            if (url.isEmpty() || username.text.isBlank() || password.text.isBlank()) {
                status.text = "Fill in the address, username, and password first."
                return@setOnClickListener
            }
            save.isEnabled = false
            status.text = "Signing in…"
            thread {
                try {
                    val token = LunaApi.login(url, username.text.toString().trim(), password.text.toString())
                    BackupPrefs.saveSession(this, url, token)
                    scheduleWorker()
                    runOnUiThread { status.text = "Backup is on. Photos save on Wi-Fi while charging." }
                } catch (e: Exception) {
                    runOnUiThread { status.text = e.message ?: "Could not sign in. Check the address and password." }
                } finally {
                    runOnUiThread { save.isEnabled = true }
                }
            }
        }
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
}
