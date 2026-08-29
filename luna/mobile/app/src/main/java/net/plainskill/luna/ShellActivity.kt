package net.plainskill.luna

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.GravityCompat
import androidx.drawerlayout.widget.DrawerLayout
import com.google.android.material.appbar.MaterialToolbar

class ShellActivity : AppCompatActivity() {

    private lateinit var drawer: DrawerLayout
    private lateinit var toolbar: MaterialToolbar
    private lateinit var navBackup: TextView
    private lateinit var navSettings: TextView
    private lateinit var usernameLabel: TextView

    private val mediaPermission = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!BackupPrefs.signedIn(this)) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.activity_shell)
        BackupNotifications.ensureChannels(this)
        requestRuntimePermissions()

        drawer = findViewById(R.id.drawer)
        toolbar = findViewById(R.id.toolbar)
        navBackup = findViewById(R.id.navBackup)
        navSettings = findViewById(R.id.navSettings)
        usernameLabel = findViewById(R.id.usernameLabel)

        toolbar.setNavigationOnClickListener { drawer.openDrawer(GravityCompat.START) }
        usernameLabel.text = BackupPrefs.username(this) ?: ""

        navBackup.setOnClickListener { showBackup() }
        navSettings.setOnClickListener { showSettings() }
        findViewById<TextView>(R.id.signOutButton).setOnClickListener { signOut() }

        if (!BackgroundAccess.isUnrestricted(this) && !BackupPrefs.askedBattery(this)) {
            BackupPrefs.setAskedBattery(this, true)
            BackgroundAccess.requestUnrestricted(this)
        }

        if (savedInstanceState == null) {
            showBackup()
        } else {
            highlight(if (supportFragmentManager.findFragmentById(R.id.content) is SettingsFragment) {
                navSettings
            } else {
                navBackup
            })
        }
    }

    override fun onResume() {
        super.onResume()
        if (!BackupPrefs.signedIn(this)) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
        }
    }

    private fun showBackup() {
        toolbar.title = "Backup"
        highlight(navBackup)
        supportFragmentManager.beginTransaction()
            .replace(R.id.content, BackupFragment())
            .commit()
        drawer.closeDrawer(GravityCompat.START)
    }

    private fun showSettings() {
        toolbar.title = "Settings"
        highlight(navSettings)
        supportFragmentManager.beginTransaction()
            .replace(R.id.content, SettingsFragment())
            .commit()
        drawer.closeDrawer(GravityCompat.START)
    }

    private fun highlight(selected: TextView) {
        navBackup.isSelected = selected === navBackup
        navSettings.isSelected = selected === navSettings
        navBackup.setTypeface(null, if (navBackup.isSelected) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
        navSettings.setTypeface(null, if (navSettings.isSelected) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
    }

    private fun signOut() {
        WorkScheduler.cancel(this)
        BackupPrefs.clearSession(this)
        startActivity(Intent(this, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }

    private fun requestRuntimePermissions() {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed.add(Manifest.permission.READ_MEDIA_IMAGES)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        } else if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        if (needed.isNotEmpty()) {
            mediaPermission.launch(needed.toTypedArray())
        }
    }
}
