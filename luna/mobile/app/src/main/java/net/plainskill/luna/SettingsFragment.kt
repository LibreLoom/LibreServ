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
        bindDestination()
        testDestination()
    }

    override fun onResume() {
        super.onResume()
        bindDestination()
    }

    private fun bindDestination() {
        val view = view ?: return
        val ctx = requireContext()
        view.findViewById<TextView>(R.id.driveValue).text =
            BackupPrefs.driveLabel(ctx)?.ifBlank { null } ?: getString(R.string.drive_label)
        view.findViewById<TextView>(R.id.folderValue).text =
            BackupPrefs.folderPrefix(ctx).ifEmpty { getString(R.string.drive_root) }
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
