package net.plainskill.luna

import android.Manifest
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.ContentUris
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
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
import org.robolectric.shadows.ShadowContentResolver
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList

/** MediaStore fixture backed by actual streams, including images and videos. */
class UploadMediaProvider : ContentProvider() {
    data class Item(val uri: Uri, val name: String, val file: File, val date: Long)
    val items = ArrayList<Item>()
    override fun onCreate() = true
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val columns = projection ?: error("projection required")
        return MatrixCursor(columns).apply {
            items.filter { it.uri.toString().startsWith("$uri/") }.forEach { item ->
                addRow(columns.map { column ->
                    when (column) {
                        MediaStore.MediaColumns._ID -> ContentUris.parseId(item.uri)
                        MediaStore.MediaColumns.DISPLAY_NAME -> item.name
                        MediaStore.MediaColumns.SIZE -> item.file.length()
                        MediaStore.MediaColumns.DATE_ADDED -> item.date
                        else -> error("unexpected column $column")
                    }
                }.toTypedArray())
            }
        }
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(items.single { it.uri == uri }.file, ParcelFileDescriptor.MODE_READ_ONLY)
    override fun getType(uri: Uri) = "application/octet-stream"
    override fun insert(uri: Uri, values: ContentValues?): Uri? = error("unused")
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = error("unused")
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = error("unused")
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PhotoBackupWorkerTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private lateinit var media: UploadMediaProvider
    private val uploadNames = CopyOnWriteArrayList<String>()
    private val destinations = CopyOnWriteArrayList<String>()
    private val installed = ConcurrentHashMap<String, Boolean>()
    private var currentUpload = ""
    @Volatile private var failComplete = 0
    private var completeCount = 0
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
        media = UploadMediaProvider()
        media.attachInfo(context, android.content.pm.ProviderInfo().apply { authority = MediaStore.AUTHORITY })
        ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY, media)
        server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                socket.use { sock ->
                    val input = sock.getInputStream()
                    val request = readLine(input) ?: return@use
                    requests += request.substringBefore(" HTTP")
                    var length = 0
                    while (true) {
                        val header = readLine(input)
                        if (header.isNullOrEmpty()) break
                        if (header.startsWith("Content-Length:", ignoreCase = true)) length = header.substringAfter(':').trim().toInt()
                    }
                    val body = ByteArray(length)
                    var got = 0
                    while (got < length) {
                        val count = input.read(body, got, length - got)
                        if (count < 0) break
                        got += count
                    }
                    val (code, text) = when {
                        request.startsWith("GET /api/v1/drives ") -> driveReply
                        request.startsWith("GET /api/v1/health ") -> healthReply
                        request.startsWith("POST /api/v1/uploads ") -> {
                            val data = JSONObject(String(body))
                            assertEquals("overwrite", data.getString("on_conflict"))
                            currentUpload = data.getString("name")
                            uploadNames += currentUpload
                            destinations += data.getString("drive_id") + "/" + data.getString("path")
                            200 to "{\"upload_id\":\"u1\"}"
                        }
                        request.startsWith("PUT /api/v1/uploads/u1 ") -> 200 to "{}"
                        request.startsWith("POST /api/v1/uploads/u1/complete?overwrite=1 ") -> {
                            installed[currentUpload] = true
                            completeCount++
                            // Simulate a server commit whose acknowledgment failed.
                            if (completeCount == failComplete) 503 to "{\"error\":\"Try again\"}" else 200 to "{}"
                        }
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

    private fun addPhoto(id: Long, name: String = "photo.jpg", date: Long = 123L, video: Boolean = false) {
        val collection = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val file = File(context.cacheDir, "upload-$id-$video").apply { writeText("photo bytes $id $video") }
        val uri = ContentUris.withAppendedId(collection, id)
        media.items += UploadMediaProvider.Item(uri, name, file, date)
        shadowOf(context.contentResolver).registerInputStreamSupplier(uri) { file.inputStream() }
    }

    @Test
    fun retriesAnInterruptedBatchWithoutRepeatingCompletedItemsOrLosingSameDateMedia() {
        signInReady()
        grantPhotos()
        addPhoto(1)
        addPhoto(2)
        addPhoto(3, video = true)
        failComplete = 2
        assertEquals(ListenableWorker.Result.retry(), run())
        assertEquals(2, uploadNames.size)
        assertEquals(ListenableWorker.Result.success(), run())
        assertEquals(4, uploadNames.size)
        assertEquals(uploadNames[1], uploadNames[2])
        assertEquals(3, installed.size)
        assertEquals(3, uploadNames.distinct().size)
        assertEquals(ListenableWorker.Result.success(), run())
        assertEquals("all completed items skipped", 4, uploadNames.size)
    }

    @Test
    fun switchingDestinationCopiesOldMediaAndRecordsActualUploadTime() {
        signInReady()
        grantPhotos()
        addPhoto(1, date = 123L)
        val before = System.currentTimeMillis()
        val outcome = run()
        assertEquals(BackupProgress.snapshot.lastError, ListenableWorker.Result.success(), outcome)
        assertTrue(BackupPrefs.lastBackupAt(context) >= before)
        assertTrue(BackupPrefs.lastBackupAt(context) <= System.currentTimeMillis())
        BackupPrefs.setFolderPrefix(context, "Other")
        assertEquals(ListenableWorker.Result.success(), run())
        assertEquals(2, uploadNames.size)
        assertEquals(uploadNames[0], uploadNames[1])
        assertTrue(destinations[1].startsWith("d1/Other/"))
        driveReply = 200 to "[{\"id\":\"d2\",\"label\":\"Replacement\"}]"
        BackupPrefs.setDrive(context, "d2", "Replacement")
        assertEquals(ListenableWorker.Result.success(), run())
        assertEquals(3, uploadNames.size)
        assertTrue(destinations[2].startsWith("d2/Other/"))
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
        assertEquals("Upload could not finish.", BackupProgress.snapshot.heading)
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
