package net.plainskill.luna

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.widget.SwitchCompat
import androidx.fragment.app.Fragment
import java.text.DateFormat
import java.util.Date

class BackupFragment : Fragment() {

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        return inflater.inflate(R.layout.fragment_backup, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val enabled = view.findViewById<SwitchCompat>(R.id.backupSwitch)
        val status = view.findViewById<TextView>(R.id.backupStatus)
        val last = view.findViewById<TextView>(R.id.lastBackup)
        val battery = view.findViewById<TextView>(R.id.batteryHint)
        val batteryButton = view.findViewById<TextView>(R.id.batteryButton)

        enabled.isChecked = BackupPrefs.backupEnabled(requireContext())
        enabled.setOnCheckedChangeListener { _, isChecked ->
            BackupPrefs.setBackupEnabled(requireContext(), isChecked)
            WorkScheduler.sync(requireContext())
            bindStatus(status, last)
        }

        batteryButton.setOnClickListener {
            BackgroundAccess.requestUnrestricted(requireActivity())
        }
        bindStatus(status, last)
        bindBattery(battery, batteryButton)
    }

    override fun onResume() {
        super.onResume()
        val view = view ?: return
        bindStatus(view.findViewById(R.id.backupStatus), view.findViewById(R.id.lastBackup))
        bindBattery(view.findViewById(R.id.batteryHint), view.findViewById(R.id.batteryButton))
    }

    private fun bindStatus(status: TextView, last: TextView) {
        val ctx = requireContext()
        status.text = if (BackupPrefs.backupEnabled(ctx)) {
            "Backup is on. New photos save when the conditions in Settings are met."
        } else {
            "Backup is paused. Turn it on to save new photos to Luna."
        }
        val at = BackupPrefs.lastBackupAt(ctx)
        last.text = if (at <= 0L) {
            "Last backup: none yet"
        } else {
            "Last backup: ${DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(at))}"
        }
    }

    private fun bindBattery(hint: TextView, button: TextView) {
        val unrestricted = BackgroundAccess.isUnrestricted(requireContext())
        if (unrestricted) {
            hint.text = "Android is allowing Luna to run in the background."
            button.visibility = View.GONE
        } else {
            hint.text =
                "Android can pause apps to save battery. That stops photo backup. Tap Allow background backup, then choose Unrestricted (or Don't optimize) for Luna."
            button.visibility = View.VISIBLE
        }
    }
}
