package net.plainskill.luna

import android.content.Intent
import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.GravityCompat
import androidx.drawerlayout.widget.DrawerLayout
import androidx.fragment.app.Fragment
import com.google.android.material.appbar.MaterialToolbar

class ShellActivity : AppCompatActivity() {

    private lateinit var drawer: DrawerLayout
    private lateinit var toolbar: MaterialToolbar
    private lateinit var navStatus: TextView
    private lateinit var navBackup: TextView
    private lateinit var navSettings: TextView
    private lateinit var usernameLabel: TextView

    private var currentPage = PAGE_STATUS
    private var pendingPage: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!BackupPrefs.signedIn(this)) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }
        if (!BackupPrefs.setupComplete(this)) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.activity_shell)
        BackupNotifications.ensureChannels(this)

        drawer = findViewById(R.id.drawer)
        toolbar = findViewById(R.id.toolbar)
        navStatus = findViewById(R.id.navStatus)
        navBackup = findViewById(R.id.navBackup)
        navSettings = findViewById(R.id.navSettings)
        usernameLabel = findViewById(R.id.usernameLabel)

        toolbar.setNavigationOnClickListener { drawer.openDrawer(GravityCompat.START) }
        usernameLabel.text = BackupPrefs.username(this) ?: ""

        navStatus.setOnClickListener { requestPage(PAGE_STATUS) }
        navBackup.setOnClickListener { requestPage(PAGE_BACKUP) }
        navSettings.setOnClickListener { requestPage(PAGE_SETTINGS) }
        findViewById<TextView>(R.id.signOutButton).setOnClickListener { signOut() }

        drawer.addDrawerListener(object : DrawerLayout.SimpleDrawerListener() {
            override fun onDrawerClosed(drawerView: android.view.View) {
                applyPendingPage()
            }
        })

        currentPage = savedInstanceState?.getString(STATE_PAGE) ?: PAGE_STATUS
        if (savedInstanceState == null) {
            showPage(currentPage)
        }
        highlight(currentPage)
        toolbar.title = titleFor(currentPage)
        WorkScheduler.schedule(this)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_PAGE, currentPage)
    }

    override fun onResume() {
        super.onResume()
        if (!BackupPrefs.signedIn(this)) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }
        if (!BackupPrefs.setupComplete(this)) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
        }
    }

    private fun requestPage(page: String) {
        if (page == currentPage) {
            if (drawer.isDrawerOpen(GravityCompat.START)) {
                drawer.closeDrawer(GravityCompat.START)
            }
            return
        }
        pendingPage = page
        if (drawer.isDrawerOpen(GravityCompat.START)) {
            drawer.closeDrawer(GravityCompat.START)
        } else {
            applyPendingPage()
        }
    }

    private fun applyPendingPage() {
        val page = pendingPage ?: return
        pendingPage = null
        if (page == currentPage) return
        currentPage = page
        showPage(page)
        highlight(page)
        toolbar.title = titleFor(page)
    }

    private fun showPage(page: String) {
        val fm = supportFragmentManager
        val tx = fm.beginTransaction()
        for (tag in PAGES) {
            val existing = fm.findFragmentByTag(tag)
            if (tag == page) {
                if (existing == null) {
                    tx.add(R.id.content, createPage(tag), tag)
                } else {
                    tx.show(existing)
                }
            } else if (existing != null) {
                tx.hide(existing)
            }
        }
        tx.commit()
    }

    private fun createPage(page: String): Fragment = when (page) {
        PAGE_BACKUP -> BackupFragment()
        PAGE_SETTINGS -> SettingsFragment()
        else -> StatusFragment()
    }

    private fun titleFor(page: String): String = when (page) {
        PAGE_BACKUP -> getString(R.string.nav_backup)
        PAGE_SETTINGS -> getString(R.string.nav_settings)
        else -> getString(R.string.nav_status)
    }

    private fun highlight(page: String) {
        val items = listOf(
            PAGE_STATUS to navStatus,
            PAGE_BACKUP to navBackup,
            PAGE_SETTINGS to navSettings,
        )
        for ((id, view) in items) {
            view.isSelected = id == page
        }
    }

    private fun signOut() {
        WorkScheduler.cancel(this)
        BackupPrefs.clearSession(this)
        startActivity(Intent(this, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }

    companion object {
        const val PAGE_STATUS = "status"
        const val PAGE_BACKUP = "backup"
        const val PAGE_SETTINGS = "settings"
        private const val STATE_PAGE = "page"
        private val PAGES = listOf(PAGE_STATUS, PAGE_BACKUP, PAGE_SETTINGS)
    }
}
