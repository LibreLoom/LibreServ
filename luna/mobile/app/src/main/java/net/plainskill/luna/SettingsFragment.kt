package net.plainskill.luna

import android.app.Activity
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.widget.SwitchCompat
import androidx.fragment.app.Fragment
import com.google.android.material.button.MaterialButton
import kotlin.concurrent.thread

class SettingsFragment : Fragment() {

    private val pickFolder = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@registerForActivityResult
        val data = result.data ?: return@registerForActivityResult
        val driveId = data.getStringExtra(FolderPickerActivity.RESULT_DRIVE_ID) ?: return@registerForActivityResult
        val driveLabel = data.getStringExtra(FolderPickerActivity.RESULT_DRIVE_LABEL).orEmpty()
        val folder = data.getStringExtra(FolderPickerActivity.RESULT_FOLDER).orEmpty()
        val ctx = requireContext()
        BackupPrefs.setDrive(ctx, driveId, driveLabel)
        BackupPrefs.setFolderPrefix(ctx, folder)
        WorkScheduler.sync(ctx)
        bindDestination()
        testDestination()
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        return inflater.inflate(R.layout.fragment_settings, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val ctx = requireContext()
        val wifi = view.findViewById<SwitchCompat>(R.id.requireWifi)
        val charging = view.findViewById<SwitchCompat>(R.id.requireCharging)

        wifi.isChecked = BackupPrefs.requireUnmetered(ctx)
        charging.isChecked = BackupPrefs.requireCharging(ctx)

        wifi.setOnCheckedChangeListener { _, isChecked ->
            BackupPrefs.setRequireUnmetered(ctx, isChecked)
            WorkScheduler.sync(ctx)
        }
        charging.setOnCheckedChangeListener { _, isChecked ->
            BackupPrefs.setRequireCharging(ctx, isChecked)
            WorkScheduler.sync(ctx)
        }

        view.findViewById<MaterialButton>(R.id.chooseFolder).setOnClickListener {
            pickFolder.launch(FolderPickerActivity.intent(requireActivity(), pickDrive = true))
        }
        view.findViewById<TextView>(R.id.batteryButton).setOnClickListener {
            BackgroundAccess.requestUnrestricted(requireActivity())
        }
        bindDestination()
        bindBattery()
        testDestination()
    }

    override fun onResume() {
        super.onResume()
        bindBattery()
        bindDestination()
    }

    private fun bindDestination() {
        val view = view ?: return
        view.findViewById<TextView>(R.id.destinationLabel).text =
            getString(R.string.folder_help) + "\n\n" + BackupPrefs.destinationLabel(requireContext())
    }

    private fun bindBattery() {
        val view = view ?: return
        val hint = view.findViewById<TextView>(R.id.batteryHint)
        val button = view.findViewById<TextView>(R.id.batteryButton)
        if (BackgroundAccess.isUnrestricted(requireContext())) {
            hint.text = "Android is allowing Luna to run in the background."
            button.visibility = View.GONE
        } else {
            hint.text =
                "Android can pause apps set to Optimized, so photo backup may not run. Tap Allow background backup, then choose Unrestricted (or Don't optimize) for Luna."
            button.visibility = View.VISIBLE
        }
    }

    private fun testDestination() {
        val status = view?.findViewById<TextView>(R.id.destinationStatus) ?: return
        status.text = getString(R.string.checking_folder)
        val ctx = requireContext().applicationContext
        thread {
            val result = BackupConfig.testSaved(ctx)
            if (!isAdded) return@thread
            requireActivity().runOnUiThread {
                if (!isAdded) return@runOnUiThread
                status.text = result.message
            }
        }
    }
}
