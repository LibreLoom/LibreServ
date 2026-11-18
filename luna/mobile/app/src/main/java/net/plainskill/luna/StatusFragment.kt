package net.plainskill.luna

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.widget.SwitchCompat
import androidx.fragment.app.Fragment
import com.google.android.material.button.MaterialButton
import java.text.DateFormat
import java.util.Date
import kotlin.concurrent.thread

/**
 * The Photo upload page: what the upload is doing right now, Upload now, and
 * the few switches people reach for. It re-reads everything once a second, so
 * the last-upload time moves while a backup runs.
 */
class StatusFragment : Fragment() {

    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            bind()
            handler.postDelayed(this, 1000)
        }
    }
    private var switchBinding = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        return inflater.inflate(R.layout.fragment_status, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        view.findViewById<MaterialButton>(R.id.backupNow).setOnClickListener { backupNow() }
        view.findViewById<SwitchCompat>(R.id.backupSwitch).setOnCheckedChangeListener { _, isChecked ->
            if (switchBinding) return@setOnCheckedChangeListener
            val ctx = requireContext()
            BackupPrefs.setBackupEnabled(ctx, isChecked)
            WorkScheduler.sync(ctx)
            bind()
        }
        view.findViewById<MaterialButton>(R.id.backgroundAllow).setOnClickListener {
            BackgroundAccess.requestUnrestricted(requireActivity())
        }
        bind()
    }

    override fun onResume() {
        super.onResume()
        bind()
        handler.removeCallbacks(tick)
        handler.post(tick)
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
    }

    private fun bind() {
        val view = view ?: return
        val ctx = context ?: return
        val snap = BackupProgress.snapshot
        val enabled = BackupPrefs.backupEnabled(ctx)

        view.findViewById<TextView>(R.id.statusHeading).text = snap.heading
        val detail = view.findViewById<TextView>(R.id.statusDetail)
        val detailText = when {
            snap.running -> snap.detail
            snap.lastError.isNotBlank() -> ""
            !enabled -> getString(R.string.status_paused_hint)
            else -> getString(R.string.status_idle_hint)
        }
        detail.text = detailText
        detail.visibility = if (detailText.isBlank()) View.GONE else View.VISIBLE
        view.findViewById<ProgressBar>(R.id.statusSpinner).visibility =
            if (snap.running) View.VISIBLE else View.GONE
        val error = view.findViewById<TextView>(R.id.statusError)
        if (snap.lastError.isNotBlank()) {
            error.visibility = View.VISIBLE
            error.text = snap.lastError
        } else {
            error.visibility = View.GONE
        }
        view.findViewById<MaterialButton>(R.id.backupNow).isEnabled = !snap.running

        val toggle = view.findViewById<SwitchCompat>(R.id.backupSwitch)
        if (toggle.isChecked != enabled) {
            switchBinding = true
            toggle.isChecked = enabled
            switchBinding = false
        }

        val at = BackupPrefs.lastBackupAt(ctx)
        view.findViewById<TextView>(R.id.lastUploadValue).text = if (at <= 0L) {
            getString(R.string.last_upload_none)
        } else {
            DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(at))
        }

        val allowed = BackgroundAccess.isUnrestricted(ctx)
        view.findViewById<View>(R.id.backgroundValue).visibility = if (allowed) View.VISIBLE else View.GONE
        view.findViewById<View>(R.id.backgroundAllow).visibility = if (allowed) View.GONE else View.VISIBLE
    }

    private fun backupNow() {
        val button = view?.findViewById<MaterialButton>(R.id.backupNow) ?: return
        button.isEnabled = false
        BackupProgress.set(true, getString(R.string.checking_folder))
        bind()
        val ctx = requireContext().applicationContext
        thread {
            val result = BackupConfig.testForBackupNow(ctx)
            if (!isAdded) return@thread
            requireActivity().runOnUiThread {
                if (!isAdded) return@runOnUiThread
                if (!result.ok) {
                    BackupProgress.fail(result.message)
                    bind()
                    return@runOnUiThread
                }
                WorkScheduler.runSoon(ctx)
                bind()
            }
        }
    }
}
