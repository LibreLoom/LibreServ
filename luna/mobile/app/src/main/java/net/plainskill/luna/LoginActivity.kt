package net.plainskill.luna

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.io.IOException
import kotlin.concurrent.thread

class LoginActivity : AppCompatActivity() {

    private lateinit var baseUrl: EditText
    private lateinit var token: EditText
    private lateinit var status: TextView
    private lateinit var signIn: Button
    private lateinit var scanQr: Button

    private val cameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) launchScanner()
        else status.text = "Camera permission is needed to scan the QR code. You can still paste the access token."
    }

    private val qrLauncher = registerForActivityResult(ScanContract()) { result ->
        val raw = result.contents ?: return@registerForActivityResult
        val pairing = PairingQr.decode(raw)
        if (pairing != null) {
            baseUrl.setText(pairing.url)
            token.setText(pairing.token)
            status.text = "Address and access token filled in. Tap Sign in."
        } else {
            status.text =
                "That QR code is not a Luna sign-in code. In Luna, open Settings → Apps and access tokens → Show as QR code."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (BackupPrefs.signedIn(this) && intent?.data == null) {
            startActivity(Intent(this, ShellActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.activity_login)
        BackupNotifications.ensureChannels(this)

        baseUrl = findViewById(R.id.baseUrl)
        token = findViewById(R.id.accessToken)
        status = findViewById(R.id.loginStatus)
        signIn = findViewById(R.id.signInButton)
        scanQr = findViewById(R.id.scanQrButton)

        if (baseUrl.text.isNullOrBlank()) {
            baseUrl.setText(BackupPrefs.baseUrl(this) ?: "http://luna.local")
        }

        applyPairing(intent)
        scanQr.setOnClickListener { requestCameraAndScan() }
        signIn.setOnClickListener { attemptSignIn() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyPairing(intent)
    }

    private fun applyPairing(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        val pairing = PairingQr.decode(data) ?: return
        baseUrl.setText(pairing.url)
        token.setText(pairing.token)
        status.text = "Address and access token filled in. Tap Sign in."
    }

    private fun requestCameraAndScan() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) launchScanner()
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    private fun launchScanner() {
        val options = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Point at the QR code in Luna → Settings → Apps and access tokens")
            .setBeepEnabled(false)
            .setOrientationLocked(true)
            .setBarcodeImageEnabled(false)
        qrLauncher.launch(options)
    }

    private fun attemptSignIn() {
        val url = baseUrl.text.toString().trim().trimEnd('/')
        val accessToken = token.text.toString().trim()
        if (url.isEmpty()) {
            status.text = "Enter your Luna address (for example http://luna.local)."
            return
        }
        if (accessToken.isEmpty()) {
            status.text = "Paste an access token from Luna → Settings → Apps and access tokens."
            return
        }
        signIn.isEnabled = false
        scanQr.isEnabled = false
        status.text = "Signing in…"
        thread {
            try {
                val user = LunaApi.authMe(url, accessToken)
                val drives = LunaApi.listDrives(url, accessToken)
                if (drives.isEmpty()) {
                    runOnUiThread {
                        if (isFinishing) return@runOnUiThread
                        status.text = "No drives found on Luna. Add a drive in Luna first, then sign in again."
                        signIn.isEnabled = true
                        scanQr.isEnabled = true
                    }
                    return@thread
                }
                val drive = drives.first()
                BackupPrefs.saveSession(this, url, accessToken, user.username, drive.id, drive.label)
                WorkScheduler.sync(this)
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    startActivity(Intent(this, ShellActivity::class.java))
                    finish()
                }
            } catch (e: LunaApi.ApiException) {
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    status.text = e.message ?: "That access token didn't work. Create a new one in Luna → Settings → Apps and access tokens."
                    signIn.isEnabled = true
                    scanQr.isEnabled = true
                }
            } catch (e: IOException) {
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    status.text = "Luna couldn't be reached. Check the address and that this phone is on the same network."
                    signIn.isEnabled = true
                    scanQr.isEnabled = true
                }
            } catch (e: Exception) {
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    status.text = e.message ?: "Could not sign in."
                    signIn.isEnabled = true
                    scanQr.isEnabled = true
                }
            }
        }
    }
}
