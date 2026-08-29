package net.plainskill.luna

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ProgressBar
import android.widget.TextView
import androidx.fragment.app.Fragment
import com.google.android.material.button.MaterialButton
import kotlin.concurrent.thread

class StatusFragment : Fragment() {

    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            bind()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        return inflater.inflate(R.layout.fragment_status, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        view.findViewById<MaterialButton>(R.id.backupNow).setOnClickListener { backupNow() }
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
        val snap = BackupProgress.snapshot
        view.findViewById<TextView>(R.id.statusHeading).text = snap.heading
        val detail = view.findViewById<TextView>(R.id.statusDetail)
        if (snap.running) {
            detail.text = snap.detail.ifBlank { getString(R.string.status_blurb) }
        } else if (snap.lastError.isBlank()) {
            detail.text = getString(R.string.status_nothing_waiting)
        } else {
            detail.text = ""
        }
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
    }

    private fun backupNow() {
        val button = view?.findViewById<MaterialButton>(R.id.backupNow) ?: return
        val error = view?.findViewById<TextView>(R.id.statusError) ?: return
        button.isEnabled = false
        error.visibility = View.VISIBLE
        error.text = getString(R.string.checking_folder)
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
