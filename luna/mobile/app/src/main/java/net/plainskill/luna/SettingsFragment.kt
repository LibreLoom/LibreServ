package net.plainskill.luna

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.widget.SwitchCompat
import androidx.fragment.app.Fragment
import kotlin.concurrent.thread

class SettingsFragment : Fragment() {

    private var drives: List<LunaApi.Drive> = emptyList()
    private var suppressDriveCallback = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        return inflater.inflate(R.layout.fragment_settings, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val ctx = requireContext()
        val wifi = view.findViewById<SwitchCompat>(R.id.requireWifi)
        val charging = view.findViewById<SwitchCompat>(R.id.requireCharging)
        val folder = view.findViewById<EditText>(R.id.folderPrefix)
        val driveSpinner = view.findViewById<Spinner>(R.id.driveSpinner)
        val driveStatus = view.findViewById<TextView>(R.id.driveStatus)
        val batteryHint = view.findViewById<TextView>(R.id.batteryHint)
        val batteryButton = view.findViewById<TextView>(R.id.batteryButton)

        wifi.isChecked = BackupPrefs.requireUnmetered(ctx)
        charging.isChecked = BackupPrefs.requireCharging(ctx)
        folder.setText(BackupPrefs.folderPrefix(ctx))

        wifi.setOnCheckedChangeListener { _, isChecked ->
            BackupPrefs.setRequireUnmetered(ctx, isChecked)
            WorkScheduler.sync(ctx)
        }
        charging.setOnCheckedChangeListener { _, isChecked ->
            BackupPrefs.setRequireCharging(ctx, isChecked)
            WorkScheduler.sync(ctx)
        }
        folder.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) {
                BackupPrefs.setFolderPrefix(ctx, folder.text.toString())
            }
        }

        driveSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, v: View?, position: Int, id: Long) {
                if (suppressDriveCallback) return
                val drive = drives.getOrNull(position) ?: return
                BackupPrefs.setDrive(ctx, drive.id, drive.label)
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        batteryButton.setOnClickListener {
            BackgroundAccess.requestUnrestricted(requireActivity())
        }
        bindBattery(batteryHint, batteryButton)
        loadDrives(driveSpinner, driveStatus)
    }

    override fun onResume() {
        super.onResume()
        val view = view ?: return
        bindBattery(view.findViewById(R.id.batteryHint), view.findViewById(R.id.batteryButton))
    }

    override fun onPause() {
        super.onPause()
        val folder = view?.findViewById<EditText>(R.id.folderPrefix) ?: return
        BackupPrefs.setFolderPrefix(requireContext(), folder.text.toString())
    }

    private fun bindBattery(hint: TextView, button: TextView) {
        if (BackgroundAccess.isUnrestricted(requireContext())) {
            hint.text = "Android is allowing Luna to run in the background."
            button.visibility = View.GONE
        } else {
            hint.text =
                "Android can pause apps to save battery. That stops photo backup. Tap Allow background backup, then choose Unrestricted (or Don't optimize) for Luna."
            button.visibility = View.VISIBLE
        }
    }

    private fun loadDrives(spinner: Spinner, status: TextView) {
        val url = BackupPrefs.baseUrl(requireContext())
        val token = BackupPrefs.token(requireContext())
        if (url == null || token == null) {
            status.text = "Sign in again to choose a drive."
            return
        }
        status.text = "Loading drives…"
        thread {
            try {
                val list = LunaApi.listDrives(url, token)
                val activity = activity ?: return@thread
                activity.runOnUiThread {
                    if (!isAdded) return@runOnUiThread
                    drives = list
                    if (list.isEmpty()) {
                        status.text = "No drives found. Add a drive in Luna first."
                        return@runOnUiThread
                    }
                    suppressDriveCallback = true
                    spinner.adapter = ArrayAdapter(
                        requireContext(),
                        android.R.layout.simple_spinner_dropdown_item,
                        list.map { it.label },
                    )
                    val selectedId = BackupPrefs.driveId(requireContext())
                    val index = list.indexOfFirst { it.id == selectedId }.takeIf { it >= 0 } ?: 0
                    spinner.setSelection(index)
                    BackupPrefs.setDrive(requireContext(), list[index].id, list[index].label)
                    suppressDriveCallback = false
                    status.text = "Photos save on this drive, in the folder below, then year and month."
                }
            } catch (e: Exception) {
                val activity = activity ?: return@thread
                activity.runOnUiThread {
                    if (!isAdded) return@runOnUiThread
                    val label = BackupPrefs.driveLabel(requireContext())
                    status.text = if (label != null) {
                        "Could not refresh drives. Using $label until Luna is reachable."
                    } else {
                        "Could not load drives. Check that this phone can reach Luna."
                    }
                }
            }
        }
    }
}
