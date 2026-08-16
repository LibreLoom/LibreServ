package net.plainskill.luna

import android.Manifest
import android.bluetooth.BluetoothDevice
import android.content.Intent
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    private var bleManager: BleManager? = null
    private var proxyServer: ProxyServer? = null
    private var webView: WebView? = null
    private var connectPanel: View? = null
    private var setupCodeInput: EditText? = null
    private var connectButton: Button? = null
    private var progressBar: ProgressBar? = null
    private var statusText: TextView? = null
    private var banner: View? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        connectPanel = findViewById(R.id.connectPanel)
        setupCodeInput = findViewById(R.id.setupCodeInput)
        connectButton = findViewById(R.id.connectButton)
        progressBar = findViewById(R.id.progressBar)
        statusText = findViewById(R.id.statusText)
        banner = findViewById(R.id.connectionBanner)

        // Safety: if layout IDs are missing, show error and stop
        val missing = mutableListOf<String>()
        if (webView == null) missing.add("webView")
        if (connectPanel == null) missing.add("connectPanel")
        if (setupCodeInput == null) missing.add("setupCodeInput")
        if (connectButton == null) missing.add("connectButton")
        if (progressBar == null) missing.add("progressBar")
        if (statusText == null) missing.add("statusText")
        if (banner == null) missing.add("connectionBanner")
        if (missing.isNotEmpty()) {
            android.widget.Toast.makeText(
                this,
                "App layout error: missing views ${missing.joinToString(", ")}",
                android.widget.Toast.LENGTH_LONG
            ).show()
            return
        }

        bleManager = BleManager(this)

        findViewById<Button>(R.id.backupButton)?.setOnClickListener {
            startActivity(Intent(this, BackupActivity::class.java))
        }

        connectButton?.setOnClickListener {
            val input = setupCodeInput ?: return@setOnClickListener
            val status = statusText ?: return@setOnClickListener
            val code = input.text.toString().trim().uppercase()
            if (code.length != 6 && code.length != 8) {
                status.text = "Enter the code from your device (6 or 8 characters)"
                return@setOnClickListener
            }
            checkPermissionsAndScan(code)
        }

        val wv = webView ?: return
        val settings: WebSettings = wv.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
    }

    private fun checkPermissionsAndScan(code: String) {
        val perms = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
                perms.add(Manifest.permission.BLUETOOTH_SCAN)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                perms.add(Manifest.permission.BLUETOOTH_CONNECT)
            }
        } else {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH) != PackageManager.PERMISSION_GRANTED) {
                perms.add(Manifest.permission.BLUETOOTH)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                perms.add(Manifest.permission.ACCESS_FINE_LOCATION)
            }
        }

        if (perms.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, perms.toTypedArray(), 1)
            return
        }
        startScan(code)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 1) {
            val input = setupCodeInput ?: return
            if (grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
                startScan(input.text.toString().trim())
            } else {
                statusText?.text = "Bluetooth permissions are required to connect"
            }
        }
    }

    private fun startScan(code: String) {
        val btn = connectButton ?: return
        val input = setupCodeInput ?: return
        val prog = progressBar ?: return
        val status = statusText ?: return

        prog.visibility = View.VISIBLE
        status.text = "Scanning for your Luna or LibreServ…"
        btn.isEnabled = false
        input.isEnabled = false

        val adapter = (getSystemService(BLUETOOTH_SERVICE) as BluetoothManager).adapter
        if (adapter == null || !adapter.isEnabled) {
            status.text = "Bluetooth is turned off. Please enable it in Settings."
            resetConnectUI()
            return
        }
        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            status.text = "Bluetooth LE is not available on this device"
            resetConnectUI()
            return
        }

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                for (uuid in result.scanRecord?.serviceUuids ?: emptyList()) {
                    if (uuid.uuid == BleManager.SERVICE_UUID) {
                        scanner.stopScan(this)
                        status.text = "Found ${result.device.name ?: "LibreServ"} — connecting…"
                        connect(result.device, code)
                        return
                    }
                }
            }

            override fun onScanFailed(errorCode: Int) {
                runOnUiThread {
                    status.text = "Could not scan for devices. Make sure Bluetooth is on and location is enabled."
                    resetConnectUI()
                }
            }
        }

        scanner.startScan(callback)

        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            try { scanner.stopScan(callback) } catch (_: Exception) {}
            val panel = connectPanel
            if (panel != null && panel.visibility == View.VISIBLE && prog.visibility == View.VISIBLE) {
                status.text = "No Luna or LibreServ found nearby. Make sure it is powered on and within range."
                resetConnectUI()
            }
        }, 30_000)
    }

    private fun connect(device: BluetoothDevice, code: String) {
        val prog = progressBar ?: return
        val status = statusText ?: return
        val mgr = bleManager ?: return

        prog.visibility = View.VISIBLE
        status.text = "Connecting…"
        mgr.connect(device, code) { success, message ->
            runOnUiThread {
                prog.visibility = View.GONE
                if (success) {
                    status.text = "Connected!"
                    startProxyAndLoad()
                } else {
                    status.text = message.ifEmpty { "Connection failed. Check your setup code and try again." }
                    resetConnectUI()
                }
            }
        }
    }

    private fun startProxyAndLoad() {
        val mgr = bleManager ?: return
        val wv = webView ?: return
        val panel = connectPanel ?: return
        val bannerView = banner

        proxyServer = ProxyServer(mgr, 18080)
        proxyServer?.start()

        panel.visibility = View.GONE
        wv.visibility = View.VISIBLE
        wv.loadUrl("http://127.0.0.1:18080/")

        Thread {
            while (true) {
                if (!mgr.isConnected()) {
                    runOnUiThread {
                        bannerView?.visibility = View.VISIBLE
                    }
                    break
                }
                Thread.sleep(2000)
            }
        }.start()
    }

    private fun resetConnectUI() {
        connectButton?.isEnabled = true
        setupCodeInput?.isEnabled = true
        progressBar?.visibility = View.GONE
    }

    override fun onDestroy() {
        super.onDestroy()
        bleManager?.disconnect()
        proxyServer?.stop()
    }
}
