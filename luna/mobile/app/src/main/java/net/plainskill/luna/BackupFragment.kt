package net.plainskill.luna

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.widget.SwitchCompat
import androidx.fragment.app.Fragment
import com.google.android.material.button.MaterialButton
import java.text.DateFormat
import java.util.Date
import kotlin.concurrent.thread

class BackupFragment : Fragment() {

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        return inflater.inflate(R.layout.fragment_backup, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val enabled = view.findViewById<SwitchCompat>(R.id.backupSwitch)
        enabled.isChecked = BackupPrefs.backupEnabled(requireContext())
        enabled.setOnCheckedChangeListener { _, isChecked ->
            BackupPrefs.setBackupEnabled(requireContext(), isChecked)
            WorkScheduler.sync(requireContext())
            bindStatus()
        }
        view.findViewById<MaterialButton>(R.id.backupNow).setOnClickListener { backupNow() }
        view.findViewById<TextView>(R.id.batteryButton).setOnClickListener {
            BackgroundAccess.requestUnrestricted(requireActivity())
        }
        bindStatus()
        bindBattery()
    }

    override fun onResume() {
        super.onResume()
        bindStatus()
        bindBattery()
    }

    private fun bindStatus() {
        val view = view ?: return
        val ctx = requireContext()
        view.findViewById<TextView>(R.id.backupStatus).text = if (BackupPrefs.backupEnabled(ctx)) {
            "Backup is on. New photos save when the conditions in Settings are met, or when you tap Backup now."
        } else {
            "Backup is paused. Turn it on to save new photos automatically, or tap Backup now after you turn it on."
        }
        val at = BackupPrefs.lastBackupAt(ctx)
        view.findViewById<TextView>(R.id.lastBackup).text = if (at <= 0L) {
            "Last backup: none yet"
        } else {
            "Last backup: ${DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(at))}"
        }
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

    private fun backupNow() {
        val button = view?.findViewById<MaterialButton>(R.id.backupNow) ?: return
        val status = view?.findViewById<TextView>(R.id.backupNowStatus) ?: return
        button.isEnabled = false
        status.text = getString(R.string.checking_folder)
        val ctx = requireContext().applicationContext
        thread {
            val result = BackupConfig.testForBackupNow(ctx)
            if (!isAdded) return@thread
            requireActivity().runOnUiThread {
                if (!isAdded) return@runOnUiThread
                if (!result.ok) {
                    status.text = result.message
                    button.isEnabled = true
                    return@runOnUiThread
                }
                WorkScheduler.runSoon(ctx)
                status.text = "Backup started. Open Status to watch it."
                button.isEnabled = true
                bindStatus()
            }
        }
    }
}
