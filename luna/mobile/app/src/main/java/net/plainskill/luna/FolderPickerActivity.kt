package net.plainskill.luna

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import java.util.Locale
import kotlin.concurrent.thread

class FolderPickerActivity : AppCompatActivity() {

    private lateinit var toolbar: MaterialToolbar
    private lateinit var pathLabel: TextView
    private lateinit var status: TextView
    private lateinit var list: ListView
    private lateinit var upButton: MaterialButton
    private lateinit var newFolder: MaterialButton
    private lateinit var useFolder: MaterialButton

    private lateinit var baseUrl: String
    private lateinit var token: String
    private var driveId: String = ""
    private var driveLabel: String = ""
    private var path: String = ""
    private var pickingDrive = false
    private var drives: List<LunaApi.Drive> = emptyList()
    private var folders: List<String> = emptyList()
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        baseUrl = intent.getStringExtra(EXTRA_URL).orEmpty()
        token = intent.getStringExtra(EXTRA_TOKEN).orEmpty()
        driveId = intent.getStringExtra(EXTRA_DRIVE_ID).orEmpty()
        driveLabel = intent.getStringExtra(EXTRA_DRIVE_LABEL).orEmpty()
        path = intent.getStringExtra(EXTRA_START_PATH).orEmpty()
        pickingDrive = intent.getBooleanExtra(EXTRA_PICK_DRIVE, false) || driveId.isBlank()

        if (baseUrl.isBlank() || token.isBlank()) {
            setResult(Activity.RESULT_CANCELED)
            finish()
            return
        }

        setContentView(R.layout.activity_folder_picker)
        toolbar = findViewById(R.id.folderToolbar)
        pathLabel = findViewById(R.id.folderPath)
        status = findViewById(R.id.folderStatus)
        list = findViewById(R.id.folderList)
        upButton = findViewById(R.id.folderUp)
        newFolder = findViewById(R.id.folderNew)
        useFolder = findViewById(R.id.folderUse)

        toolbar.setNavigationOnClickListener { finish() }
        upButton.setOnClickListener { goUp() }
        newFolder.setOnClickListener { promptNewFolder() }
        useFolder.setOnClickListener { useCurrentFolder() }
        list.setOnItemClickListener { _, _, position, _ -> onRow(position) }

        if (pickingDrive) {
            showDriveStep()
            loadDrives()
        } else {
            showFolderStep()
            loadFolders()
        }
    }

    private fun showDriveStep() {
        toolbar.title = getString(R.string.setup_drive_title)
        pathLabel.text = getString(R.string.setup_drive_help)
        upButton.visibility = View.GONE
        newFolder.visibility = View.GONE
        useFolder.visibility = View.GONE
    }

    private fun showFolderStep() {
        pickingDrive = false
        toolbar.title = getString(R.string.setup_folder_title)
        upButton.visibility = View.VISIBLE
        newFolder.visibility = View.VISIBLE
        useFolder.visibility = View.VISIBLE
        bindPath()
    }

    private fun bindPath() {
        val where = if (path.isEmpty()) getString(R.string.drive_root) else path
        pathLabel.text = getString(R.string.folder_path_fmt, driveLabel.ifBlank { getString(R.string.drive_label) }, where)
        upButton.isEnabled = path.isNotEmpty() && !busy
    }

    private fun setBusy(value: Boolean) {
        busy = value
        upButton.isEnabled = !value && path.isNotEmpty() && !pickingDrive
        newFolder.isEnabled = !value && !pickingDrive
        useFolder.isEnabled = !value && !pickingDrive
        list.isEnabled = !value
    }

    private fun onRow(position: Int) {
        if (busy) return
        if (pickingDrive) {
            val drive = drives.getOrNull(position) ?: return
            driveId = drive.id
            driveLabel = drive.label
            path = ""
            showFolderStep()
            loadFolders()
            return
        }
        val name = folders.getOrNull(position) ?: return
        path = LunaApi.joinPath(path, name)
        loadFolders()
    }

    private fun goUp() {
        if (busy || pickingDrive) return
        path = LunaApi.parentPath(path)
        loadFolders()
    }

    private fun promptNewFolder() {
        if (busy || pickingDrive) return
        val input = EditText(this).apply {
            hint = getString(R.string.folder_name_hint)
            setPadding(48, 32, 48, 32)
            setTextColor(getColor(R.color.luna_ink))
            setHintTextColor(getColor(R.color.luna_hint))
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.new_folder)
            .setMessage(R.string.new_folder_help)
            .setView(input)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.create) { _, _ ->
                createFolder(input.text.toString())
            }
            .show()
    }

    private fun createFolder(rawName: String) {
        val name = rawName.trim()
        if (name.isEmpty()) {
            status.text = getString(R.string.folder_name_empty)
            return
        }
        if (name.contains('/') || name.contains('\\') || name == "." || name == "..") {
            status.text = getString(R.string.folder_name_invalid)
            return
        }
        setBusy(true)
        status.text = getString(R.string.creating_folder)
        val dest = LunaApi.joinPath(path, name)
        thread {
            try {
                LunaApi.mkdir(baseUrl, token, driveId, dest)
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    path = dest
                    setBusy(false)
                    loadFolders()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    setBusy(false)
                    status.text = LunaApi.describeError(e)
                }
            }
        }
    }

    private fun useCurrentFolder() {
        if (busy || pickingDrive || driveId.isBlank()) return
        setBusy(true)
        status.text = getString(R.string.checking_folder)
        val chosenDrive = driveId
        val chosenLabel = driveLabel
        val chosenPath = path
        thread {
            val result = BackupConfig.test(baseUrl, token, chosenDrive, chosenPath)
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                if (!result.ok) {
                    setBusy(false)
                    status.text = result.message
                    return@runOnUiThread
                }
                setResult(
                    Activity.RESULT_OK,
                    Intent()
                        .putExtra(RESULT_DRIVE_ID, chosenDrive)
                        .putExtra(RESULT_DRIVE_LABEL, chosenLabel)
                        .putExtra(RESULT_FOLDER, chosenPath),
                )
                finish()
            }
        }
    }

    private fun loadDrives() {
        setBusy(true)
        status.text = getString(R.string.loading_drives)
        thread {
            try {
                val listDrives = LunaApi.listDrives(baseUrl, token)
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    drives = listDrives
                    folders = emptyList()
                    if (listDrives.isEmpty()) {
                        bindRows(emptyList())
                        status.text = getString(R.string.no_drives)
                    } else {
                        bindRows(listDrives.map { it.label })
                        status.text = getString(R.string.tap_a_drive)
                    }
                    setBusy(false)
                }
            } catch (e: Exception) {
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    bindRows(emptyList())
                    status.text = LunaApi.describeError(e)
                    setBusy(false)
                }
            }
        }
    }

    private fun loadFolders() {
        setBusy(true)
        bindPath()
        status.text = getString(R.string.loading_folders)
        thread {
            try {
                val entries = LunaApi.listFiles(baseUrl, token, driveId, path)
                    .filter { it.isDir }
                    .map { it.name }
                    .sortedWith { a, b -> a.lowercase(Locale.US).compareTo(b.lowercase(Locale.US)) }
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    folders = entries
                    bindRows(entries)
                    status.text = if (entries.isEmpty()) {
                        getString(R.string.folder_empty)
                    } else {
                        getString(R.string.tap_a_folder)
                    }
                    setBusy(false)
                }
            } catch (e: Exception) {
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    folders = emptyList()
                    bindRows(emptyList())
                    status.text = LunaApi.describeError(e)
                    setBusy(false)
                }
            }
        }
    }

    private fun bindRows(labels: List<String>) {
        list.adapter = object : ArrayAdapter<String>(this, R.layout.item_browse_row, R.id.rowLabel, labels) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val view = super.getView(position, convertView, parent)
                view.findViewById<TextView>(R.id.rowLabel).text = getItem(position)
                return view
            }
        }
    }

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_DRIVE_ID = "drive_id"
        const val EXTRA_DRIVE_LABEL = "drive_label"
        const val EXTRA_START_PATH = "start_path"
        const val EXTRA_PICK_DRIVE = "pick_drive"
        const val RESULT_DRIVE_ID = "drive_id"
        const val RESULT_DRIVE_LABEL = "drive_label"
        const val RESULT_FOLDER = "folder"

        fun intent(
            activity: Activity,
            pickDrive: Boolean,
            driveId: String? = BackupPrefs.driveId(activity),
            driveLabel: String? = BackupPrefs.driveLabel(activity),
            startPath: String = BackupPrefs.folderPrefix(activity),
        ): Intent {
            return Intent(activity, FolderPickerActivity::class.java)
                .putExtra(EXTRA_URL, BackupPrefs.baseUrl(activity))
                .putExtra(EXTRA_TOKEN, BackupPrefs.token(activity))
                .putExtra(EXTRA_DRIVE_ID, driveId.orEmpty())
                .putExtra(EXTRA_DRIVE_LABEL, driveLabel.orEmpty())
                .putExtra(EXTRA_START_PATH, startPath)
                .putExtra(EXTRA_PICK_DRIVE, pickDrive)
        }
    }
}
