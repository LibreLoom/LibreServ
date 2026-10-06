package net.plainskill.luna

import android.Manifest
import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PhotoBackupWorkerTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private lateinit var server: ServerSocket
    private val requests = CopyOnWriteArrayList<String>()
    private var driveReply: Pair<Int, String> = 200 to "[{\"id\":\"d1\",\"label\":\"Photos\"}]"
    private var healthReply: Pair<Int, String> =
        200 to "{\"status\":\"ok\",\"api\":{\"version\":1,\"oldest_supported\":1}}"
    private val base get() = "http://127.0.0.1:${server.localPort}"

    private fun readLine(input: InputStream): String? {
        val line = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) return if (line.size() == 0) null else line.toString(Charsets.ISO_8859_1)
            if (b == '\n'.code) return line.toString(Charsets.ISO_8859_1).trimEnd('\r')
            line.write(b)
        }
    }

    @Before
    fun setUp() {
        BackupPrefs.storeFactory = { it.getSharedPreferences("test_worker", Context.MODE_PRIVATE) }
        BackupPrefs.clearSession(context)
        BackupProgress.idle()
        requests.clear()
        server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                socket.use { sock ->
                    val input = sock.getInputStream()
                    val request = readLine(input) ?: return@use
                    requests += request.substringBefore(" HTTP")
                    while (true) if (readLine(input).isNullOrEmpty()) break
                    val (code, text) = when {
                        request.startsWith("GET /api/v1/drives ") -> driveReply
                        request.startsWith("GET /api/v1/health ") -> healthReply
                        else -> 404 to "{}"
                    }
                    val out = text.toByteArray()
                    val head = "HTTP/1.1 $code X\r\nContent-Type: application/json\r\n" +
                        "Content-Length: ${out.size}\r\nConnection: close\r\n\r\n"
                    sock.getOutputStream().apply { write(head.toByteArray(Charsets.ISO_8859_1)); write(out); flush() }
                }
            }
        }.apply { isDaemon = true }.start()
    }

    @After
    fun tearDown() {
        server.close()
        BackupPrefs.clearSession(context)
        BackupPrefs.storeFactory = { null }
    }

    private fun signInReady() {
        BackupPrefs.saveSession(context, base, "tok", "max", "d1", "Photos")
        BackupPrefs.setSetupComplete(context, true)
    }

    private fun grantPhotos() {
        shadowOf(context as Application).grantPermissions(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_EXTERNAL_STORAGE,
        )
    }

    private fun run(): ListenableWorker.Result = runBlocking {
        TestListenableWorkerBuilder<PhotoBackupWorker>(context).build().doWork()
    }

    @Test
    fun doesNothingWhenSignedOut() {
        assertEquals(ListenableWorker.Result.success(), run())
        assertTrue(requests.isEmpty())
        assertFalse(BackupProgress.snapshot.running)
    }

    @Test
    fun doesNothingBeforeSetupIsFinished() {
        BackupPrefs.saveSession(context, base, "tok", "max", "d1", "Photos")
        assertEquals(ListenableWorker.Result.success(), run())
        assertTrue(requests.isEmpty())
    }

    @Test
    fun doesNothingWhenBackupIsSwitchedOff() {
        signInReady()
        BackupPrefs.setBackupEnabled(context, false)
        assertEquals(ListenableWorker.Result.success(), run())
        assertTrue(requests.isEmpty())
    }

    @Test
    fun withoutPhotoAccessItFailsAndSaysHowToFixIt() {
        signInReady()
        assertEquals(ListenableWorker.Result.failure(), run())
        assertTrue(requests.isEmpty())
        assertEquals("Backup could not finish.", BackupProgress.snapshot.heading)
        assertEquals(BackupConfig.photosDeniedMessage(), BackupProgress.snapshot.lastError)
    }

    @Test
    fun aRevokedTokenSignsThePhoneOutAndStopsRetrying() {
        signInReady()
        grantPhotos()
        driveReply = 401 to "{}"
        assertEquals(ListenableWorker.Result.failure(), run())
        assertFalse("the dead token is forgotten", BackupPrefs.signedIn(context))
        assertTrue(BackupProgress.snapshot.lastError.contains("access token didn't work"))
    }

    @Test
    fun aNetworkProblemIsRetriedNotGivenUp() {
        signInReady()
        grantPhotos()
        BackupPrefs.saveSession(context, "http://127.0.0.1:1", "tok", "max", "d1", "Photos")
        BackupPrefs.setSetupComplete(context, true)
        assertEquals(ListenableWorker.Result.retry(), run())
        assertTrue("still signed in", BackupPrefs.signedIn(context))
        assertTrue(BackupProgress.snapshot.lastError.startsWith("Luna couldn't be reached"))
    }

    @Test
    fun aMissingDriveIsRetriedWithAPlainMessage() {
        signInReady()
        grantPhotos()
        driveReply = 200 to "[]"
        assertEquals(ListenableWorker.Result.retry(), run())
        assertTrue(BackupProgress.snapshot.lastError.contains("No drives found on Luna"))
        assertTrue(BackupPrefs.signedIn(context))
    }

    @Test
    fun withNothingNewItFinishesCleanlyAndLeavesTheLastBackupTimeAlone() {
        signInReady()
        grantPhotos()
        BackupPrefs.markBackedUp(context, 5_000L)
        assertEquals(ListenableWorker.Result.success(), run())
        assertTrue(requests.any { it.startsWith("GET /api/v1/drives") })
        assertEquals(5_000L, BackupPrefs.lastBackupAt(context))
        assertFalse(BackupProgress.snapshot.running)
        assertEquals("Everything is up to date.", BackupProgress.snapshot.heading)
    }

    @Test
    fun aLunaThatIsTooOldStopsBackupWithoutRetryOrSignOut() {
        signInReady()
        grantPhotos()
        healthReply = 200 to "{\"status\":\"ok\"}"
        assertEquals(ListenableWorker.Result.failure(), run())
        assertTrue("still signed in", BackupPrefs.signedIn(context))
        assertTrue(requests.none { it.startsWith("GET /api/v1/drives") })
        assertEquals(Compatibility.message(Compat.LUNA_TOO_OLD), BackupProgress.snapshot.lastError)
    }

    @Test
    fun anAppThatIsTooOldStopsBackup() {
        signInReady()
        grantPhotos()
        healthReply = 200 to "{\"api\":{\"version\":4,\"oldest_supported\":3}}"
        assertEquals(ListenableWorker.Result.failure(), run())
        assertEquals(Compatibility.message(Compat.APP_TOO_OLD), BackupProgress.snapshot.lastError)
    }
}
