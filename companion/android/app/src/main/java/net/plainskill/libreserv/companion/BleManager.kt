package net.plainskill.libreserv.companion

import android.bluetooth.*
import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import org.json.JSONObject
import java.util.*
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicInteger

/**
 * Manages the BLE connection to LibreServ, authentication, and request/response
 * proxying over the GATT characteristics.
 */
class BleManager(private val context: Context) {
    companion object {
        val SERVICE_UUID = UUID.fromString("5a494c42-6572-6572-7600-000000000000")
        val CHAR_AUTH = UUID.fromString("5a494c42-6572-6572-7600-000000000002")
        val CHAR_AUTH_STATUS = UUID.fromString("5a494c42-6572-6572-7600-000000000003")
        val CHAR_PROXY_REQ = UUID.fromString("5a494c42-6572-6572-7600-000000000004")
        val CHAR_PROXY_RESP = UUID.fromString("5a494c42-6572-6572-7600-000000000005")
        val CLIENT_CONFIG_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        const val TAG = "LibreServBLE"
    }

    private var gatt: BluetoothGatt? = null

    private var authChar: BluetoothGattCharacteristic? = null
    private var proxyReqChar: BluetoothGattCharacteristic? = null

    private val requestCounter = AtomicInteger(0)
    private val pending = ConcurrentHashMap<String, BlockingQueue<JSONObject>>()

    private val bleThread = HandlerThread("BLE").apply { start() }
    private val bleHandler = Handler(bleThread.looper)

    @Volatile private var connected = false
    @Volatile private var authed = false

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                Log.i(TAG, "GATT connected")
                connected = true
                g.requestMtu(512)
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                Log.w(TAG, "GATT disconnected")
                connected = false
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            Log.i(TAG, "MTU negotiated: $mtu (status=$status)")
            g.discoverServices()
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.e(TAG, "Service discovery failed: $status")
                return
            }

            val service = g.getService(SERVICE_UUID)
            if (service == null) {
                Log.e(TAG, "LibreServ service not found")
                return
            }

            authChar = service.getCharacteristic(CHAR_AUTH)
            val authStatusChar = service.getCharacteristic(CHAR_AUTH_STATUS)
            proxyReqChar = service.getCharacteristic(CHAR_PROXY_REQ)
            val proxyRespChar = service.getCharacteristic(CHAR_PROXY_RESP)

            enableNotify(g, authStatusChar)
            enableNotify(g, proxyRespChar)
        }

        override fun onDescriptorWrite(g: BluetoothGatt, desc: BluetoothGattDescriptor?, status: Int) {
            Log.i(TAG, "Descriptor written: ${desc?.uuid} status=$status")
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            val data = characteristic.value ?: return
            when (characteristic.uuid) {
                CHAR_AUTH_STATUS -> handleAuthStatus(data)
                CHAR_PROXY_RESP -> handleProxyResponse(data)
            }
        }
    }

    private fun enableNotify(g: BluetoothGatt, char: BluetoothGattCharacteristic?) {
        if (char == null) return
        g.setCharacteristicNotification(char, true)
        val desc = char.getDescriptor(CLIENT_CONFIG_UUID)
        if (desc != null) {
            desc.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            g.writeDescriptor(desc)
        } else {
            Log.w(TAG, "CCCD descriptor missing on ${char.uuid} — relying on setCharacteristicNotification only")
        }
    }

    private fun handleAuthStatus(data: ByteArray) {
        try {
            val json = JSONObject(String(data))
            authed = json.optBoolean("ok", false)
            Log.i(TAG, "Auth result: $authed")
        } catch (e: Exception) {
            Log.w(TAG, "Bad auth status", e)
        }
    }

    private fun handleProxyResponse(data: ByteArray) {
        try {
            val json = JSONObject(String(data))
            val id = json.getString("id")
            pending[id]?.put(json)
        } catch (e: Exception) {
            Log.w(TAG, "Bad proxy response", e)
        }
    }

    fun connect(device: BluetoothDevice, setupCode: String, onResult: (Boolean, String) -> Unit) {
        gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)

        bleHandler.post {
            try {
                // Wait for connection + MTU + services + notifications
                waitFor(10_000) { connected } ?: run {
                    onResult(false, "Connection timeout")
                    return@post
                }
                // Give a moment for notification descriptors to settle
                Thread.sleep(1000)

                // Authenticate
                authed = false
                authChar?.value = setupCode.toByteArray()
                gatt?.writeCharacteristic(authChar)

                // Wait for auth status notification (up to 10 seconds)
                val start = System.currentTimeMillis()
                while (!authed && System.currentTimeMillis() - start < 10_000) {
                    Thread.sleep(100)
                }

                if (authed) {
                    onResult(true, "")
                } else {
                    onResult(false, "Authentication failed — check your setup code")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Connection error", e)
                onResult(false, e.message ?: "Unknown error")
            }
        }
    }

    private fun waitFor(timeoutMs: Long, predicate: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return true
            Thread.sleep(50)
        }
        return false
    }

    /**
     * Proxies an HTTP request through BLE and returns the response.
     * This blocks the calling thread until the full response is received.
     */
    fun proxy(method: String, url: String, headers: Map<String, String>?, body: ByteArray? = null): ProxyResponse? {
        val id = "req-${requestCounter.incrementAndGet()}"
        val queue: BlockingQueue<JSONObject> = LinkedBlockingQueue()
        pending[id] = queue

        val json = JSONObject().apply {
            put("id", id)
            put("method", method)
            put("path", url)
            put("headers", JSONObject(headers ?: emptyMap<String, String>()))
            put("body", body?.let { android.util.Base64.encodeToString(it, android.util.Base64.NO_WRAP) } ?: "")
            put("chunk", 0)
            put("final", true)
        }

        proxyReqChar?.value = json.toString().toByteArray()
        gatt?.writeCharacteristic(proxyReqChar)

        try {
            val chunks = mutableListOf<JSONObject>()
            while (true) {
                val chunk = queue.poll(30, TimeUnit.SECONDS) ?: return null
                chunks.add(chunk)
                if (chunk.getBoolean("final")) break
            }

            val status = if (chunks.isNotEmpty()) chunks[0].optInt("status", 200) else 200
            val responseHeaders = mutableMapOf<String, String>()
            if (chunks.isNotEmpty() && !chunks[0].isNull("headers")) {
                val h = chunks[0].getJSONObject("headers")
                for (key in h.keys()) {
                    responseHeaders[key] = h.getString(key)
                }
            }

            val fullBody = chunks.fold(byteArrayOf()) { acc, c ->
                val part = android.util.Base64.decode(
                    c.getString("body"),
                    android.util.Base64.DEFAULT
                )
                acc + part
            }

            val statusText = if (chunks.isNotEmpty()) chunks[0].optString("statusText", "") else ""
            return ProxyResponse(status, statusText, responseHeaders, fullBody)
        } catch (e: Exception) {
            Log.w(TAG, "Proxy failed", e)
            return null
        } finally {
            pending.remove(id)
        }
    }

    fun isConnected(): Boolean {
        return connected
    }

    fun disconnect() {
        gatt?.disconnect()
        gatt?.close()
        gatt = null
        connected = false
    }

    data class ProxyResponse(
        val status: Int,
        val statusText: String,
        val headers: Map<String, String>,
        val body: ByteArray
    )
}
