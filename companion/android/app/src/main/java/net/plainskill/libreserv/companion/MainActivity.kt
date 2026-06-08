package net.plainskill.libreserv.companion

import android.Manifest
import android.bluetooth.BluetoothDevice
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
    private lateinit var bleManager: BleManager
    private lateinit var proxyServer: ProxyServer
    private lateinit var webView: WebView
    private lateinit var connectPanel: View
    private lateinit var setupCodeInput: EditText
    private lateinit var connectButton: Button
    private lateinit var progressBar: ProgressBar
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        connectPanel = findViewById(R.id.connectPanel)
        setupCodeInput = findViewById(R.id.setupCodeInput)
        connectButton = findViewById(R.id.connectButton)
        progressBar = findViewById(R.id.progressBar)
        statusText = findViewById(R.id.statusText)

        bleManager = BleManager(this)

        connectButton.setOnClickListener {
            val code = setupCodeInput.text.toString().trim().uppercase()
            if (code.length != 6) {
                statusText.text = "Enter the 6-character setup code"
                return@setOnClickListener
            }
            checkPermissionsAndScan(code)
        }

        val settings: WebSettings = webView.settings
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
            if (grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
                startScan(setupCodeInput.text.toString().trim())
            } else {
                statusText.text = "Bluetooth permissions are required"
            }
        }
    }

    private fun startScan(code: String) {
        progressBar.visibility = View.VISIBLE
        statusText.text = "Scanning for LibreServ..."
        connectButton.isEnabled = false

        val adapter = (getSystemService(BLUETOOTH_SERVICE) as BluetoothManager).adapter
        val scanner = adapter.bluetoothLeScanner

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                for (uuid in result.scanRecord?.serviceUuids ?: emptyList()) {
                    if (uuid.uuid == BleManager.SERVICE_UUID) {
                        scanner.stopScan(this)
                        statusText.text = "Found ${result.device.name ?: "LibreServ"}"
                        connect(result.device, code)
                        return
                    }
                }
            }

            override fun onScanFailed(errorCode: Int) {
                runOnUiThread {
                    statusText.text = "Scan failed: error $errorCode"
                    connectButton.isEnabled = true
                    progressBar.visibility = View.GONE
                }
            }
        }

        scanner.startScan(callback)
    }

    private fun connect(device: BluetoothDevice, code: String) {
        statusText.text = "Connecting..."
        bleManager.connect(device, code) { success, message ->
            runOnUiThread {
                progressBar.visibility = View.GONE
                if (success) {
                    statusText.text = "Connected"
                    startProxyAndLoad()
                } else {
                    statusText.text = "Connection failed: $message"
                    connectButton.isEnabled = true
                }
            }
        }
    }

    private fun startProxyAndLoad() {
        proxyServer = ProxyServer(bleManager, 18080)
        proxyServer.start()

        connectPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl("http://127.0.0.1:18080/")
    }

    override fun onDestroy() {
        super.onDestroy()
        bleManager.disconnect()
        if (::proxyServer.isInitialized) {
            proxyServer.stop()
        }
    }
}
