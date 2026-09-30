package net.plainskill.luna

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import kotlin.concurrent.thread

class SetupActivity : AppCompatActivity() {

    private lateinit var driveStep: View
    private lateinit var permissionStep: View
    private lateinit var driveList: RadioGroup
    private lateinit var driveStatus: TextView
    private lateinit var driveContinue: MaterialButton
    private lateinit var grantStatus: TextView
    private lateinit var grantButton: MaterialButton

    private var drives: List<LunaApi.Drive> = emptyList()
    private var selected: LunaApi.Drive? = null
    private var waitingForBattery = false

    private val pickFolder = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@registerForActivityResult
        val data = result.data ?: return@registerForActivityResult
        val driveId = data.getStringExtra(FolderPickerActivity.RESULT_DRIVE_ID) ?: return@registerForActivityResult
        val driveLabel = data.getStringExtra(FolderPickerActivity.RESULT_DRIVE_LABEL).orEmpty()
        val folder = data.getStringExtra(FolderPickerActivity.RESULT_FOLDER).orEmpty()
        BackupPrefs.setDrive(this, driveId, driveLabel)
        BackupPrefs.setFolderPrefix(this, folder)
        showPermissions()
    }

    private val requestPerms = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        if (!BackupConfig.hasPhotoAccess(this)) {
            grantStatus.text = BackupConfig.photosDeniedMessage()
            grantButton.isEnabled = true
            return@registerForActivityResult
        }
        askBatteryThenFinish()
    }

    private val batteryPrompt = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        waitingForBattery = false
        finishSetup()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!BackupPrefs.signedIn(this)) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }
        if (BackupPrefs.setupComplete(this)) {
            startActivity(Intent(this, ShellActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.activity_setup)
        driveStep = findViewById(R.id.driveStep)
        permissionStep = findViewById(R.id.permissionStep)
        driveList = findViewById(R.id.driveList)
        driveStatus = findViewById(R.id.driveStatus)
        driveContinue = findViewById(R.id.driveContinue)
        grantStatus = findViewById(R.id.grantStatus)
        grantButton = findViewById(R.id.grantButton)

        driveContinue.isEnabled = false
        driveContinue.setOnClickListener {
            if (drives.isEmpty()) {
                loadDrives()
            } else {
                openFolderPicker()
            }
        }
        grantButton.setOnClickListener { startGrant() }
        findViewById<TextView>(R.id.setupSignOut).setOnClickListener { signOut() }
        findViewById<TextView>(R.id.permSignOut).setOnClickListener { signOut() }

        showDrives()
        loadDrives()
    }

    override fun onResume() {
        super.onResume()
        if (waitingForBattery) {
            waitingForBattery = false
            finishSetup()
        }
    }

    private fun showDrives() {
        driveStep.visibility = View.VISIBLE
        permissionStep.visibility = View.GONE
    }

    private fun showPermissions() {
        driveStep.visibility = View.GONE
        permissionStep.visibility = View.VISIBLE
        grantStatus.text = getString(R.string.perm_grant_help)
    }

    private fun loadDrives() {
        val url = BackupPrefs.baseUrl(this)
        val token = BackupPrefs.token(this)
        if (url == null || token == null) {
            driveStatus.text = getString(R.string.sign_in_again)
            return
        }
        driveStatus.text = getString(R.string.loading_drives)
        thread {
            try {
                val list = LunaApi.listDrives(url, token)
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    drives = list
                    bindDriveRows()
                    if (list.isEmpty()) {
                        driveStatus.text = getString(R.string.no_drives)
                        driveContinue.text = "Check again"
                        driveContinue.isEnabled = true
                    } else {
                        driveStatus.text = getString(R.string.tap_a_drive)
                        driveContinue.text = getString(R.string.continue_label)
                        driveContinue.isEnabled = selected != null
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    driveStatus.text = LunaApi.describeError(e)
                    driveContinue.text = "Check again"
                    driveContinue.isEnabled = true
                }
            }
        }
    }

    private fun bindDriveRows() {
        driveList.setOnCheckedChangeListener(null)
        driveList.removeAllViews()
        drives.forEach { drive ->
            val row = layoutInflater.inflate(R.layout.item_choice_row, driveList, false) as RadioButton
            row.id = View.generateViewId()
            row.text = drive.label
            row.tag = drive.id
            row.isChecked = selected?.id == drive.id
            driveList.addView(row)
        }
        if (drives.isEmpty()) {
            driveContinue.text = "Check again"
            driveContinue.isEnabled = true
        } else {
            driveContinue.text = getString(R.string.continue_label)
            driveContinue.isEnabled = selected != null
        }
        driveList.setOnCheckedChangeListener { group, checkedId ->
            val row = group.findViewById<RadioButton>(checkedId) ?: return@setOnCheckedChangeListener
            selected = drives.firstOrNull { it.id == row.tag }
            driveContinue.isEnabled = selected != null
        }
    }

    private fun openFolderPicker() {
        val drive = selected
        if (drive == null) {
            driveStatus.text = getString(R.string.pick_a_drive_first)
            return
        }
        BackupPrefs.setDrive(this, drive.id, drive.label)
        pickFolder.launch(
            FolderPickerActivity.intent(
                this,
                pickDrive = false,
                driveId = drive.id,
                driveLabel = drive.label,
                startPath = "",
            )
        )
    }

    private fun startGrant() {
        grantButton.isEnabled = false
        grantStatus.text = getString(R.string.asking_permissions)
        requestPerms.launch(BackupConfig.photosNeeded())
    }

    private fun askBatteryThenFinish() {
        if (BackgroundAccess.isUnrestricted(this)) {
            finishSetup()
            return
        }
        val prompt = BackgroundAccess.unrestrictedIntent(this)
        if (prompt == null) {
            finishSetup()
            return
        }
        grantStatus.text = getString(R.string.asking_battery)
        waitingForBattery = true
        try {
            batteryPrompt.launch(prompt)
        } catch (_: Exception) {
            waitingForBattery = false
            BackgroundAccess.requestUnrestricted(this)
        }
    }

    private fun finishSetup() {
        grantButton.isEnabled = false
        grantStatus.text = getString(R.string.checking_folder)
        thread {
            val result = BackupConfig.testSaved(this)
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                if (!result.ok) {
                    grantStatus.text = result.message
                    grantButton.isEnabled = true
                    return@runOnUiThread
                }
                BackupPrefs.setSetupComplete(this, true)
                BackupPrefs.setBackupEnabled(this, true)
                WorkScheduler.schedule(this)
                WorkScheduler.runSoon(this)
                startActivity(Intent(this, ShellActivity::class.java))
                finish()
            }
        }
    }

    private fun signOut() {
        WorkScheduler.cancel(this)
        BackupPrefs.clearSession(this)
        startActivity(Intent(this, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }
}
