package net.plainskill.luna

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class BackupPrefsTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before
    fun usePlainStore() {
        BackupPrefs.storeFactory = { it.getSharedPreferences("test_backup", Context.MODE_PRIVATE) }
        BackupPrefs.clearSession(context)
    }

    @After
    fun resetStore() {
        BackupPrefs.clearSession(context)
        BackupPrefs.storeFactory = { null }
    }

    @Test
    fun aFreshInstallIsSignedOutWithSafeDefaults() {
        assertFalse(BackupPrefs.signedIn(context))
        assertNull(BackupPrefs.token(context))
        assertFalse(BackupPrefs.setupComplete(context))
        // Backup waits for Wi-Fi and charging unless the person says otherwise.
        assertTrue(BackupPrefs.requireUnmetered(context))
        assertTrue(BackupPrefs.requireCharging(context))
        assertTrue(BackupPrefs.backupEnabled(context))
        assertFalse(BackupPrefs.askedBattery(context))
        assertEquals(0L, BackupPrefs.lastBackupAt(context))
        assertEquals(BackupPrefs.DEFAULT_FOLDER, BackupPrefs.folderPrefix(context))
    }

    @Test
    fun savingASessionSignsInAndRestartsSetup() {
        BackupPrefs.setSetupComplete(context, true)
        BackupPrefs.setBackupEnabled(context, false)
        BackupPrefs.saveSession(context, "http://luna.local", "tok", "max", "d1", "Photos")
        assertTrue(BackupPrefs.signedIn(context))
        assertEquals("tok", BackupPrefs.token(context))
        assertEquals("max", BackupPrefs.username(context))
        assertEquals("http://luna.local", BackupPrefs.baseUrl(context))
        assertEquals("d1", BackupPrefs.driveId(context))
        assertEquals("Photos", BackupPrefs.driveLabel(context))
        // A new sign-in turns backup on but makes the person confirm the destination again.
        assertTrue(BackupPrefs.backupEnabled(context))
        assertFalse(BackupPrefs.setupComplete(context))
    }

    @Test
    fun signingInWithoutADriveKeepsTheOneAlreadyChosen() {
        BackupPrefs.setDrive(context, "d9", "Spare")
        BackupPrefs.saveSession(context, "http://luna.local", "tok2", "max")
        assertEquals("d9", BackupPrefs.driveId(context))
        assertEquals("Spare", BackupPrefs.driveLabel(context))
    }

    @Test
    fun clearingTheSessionForgetsEverything() {
        BackupPrefs.saveSession(context, "http://luna.local", "tok", "max", "d1", "Photos")
        BackupPrefs.markBackedUp(context, 1234L)
        BackupPrefs.clearSession(context)
        assertFalse(BackupPrefs.signedIn(context))
        assertNull(BackupPrefs.driveId(context))
        assertEquals(0L, BackupPrefs.lastBackupAt(context))
    }

    @Test
    fun aBlankTokenCountsAsSignedOut() {
        BackupPrefs.saveSession(context, "http://luna.local", "   ", "max")
        assertFalse(BackupPrefs.signedIn(context))
    }

    @Test
    fun theFolderIsStoredWithoutSurroundingSlashesOrSpaces() {
        BackupPrefs.setFolderPrefix(context, " /Phone/Camera/ ")
        assertEquals("Phone/Camera", BackupPrefs.folderPrefix(context))
        BackupPrefs.setFolderPrefix(context, "/")
        assertEquals("", BackupPrefs.folderPrefix(context))
    }

    @Test
    fun theDestinationReadsInPlainWords() {
        assertEquals("Drive · Drive root", BackupPrefs.destinationLabel(context))
        BackupPrefs.setDrive(context, "d1", "Photos")
        assertEquals("Photos · Drive root", BackupPrefs.destinationLabel(context))
        BackupPrefs.setFolderPrefix(context, "Camera")
        assertEquals("Photos · Camera", BackupPrefs.destinationLabel(context))
        BackupPrefs.setDrive(context, "d1", "")
        assertEquals("Drive · Camera", BackupPrefs.destinationLabel(context))
    }

    @Test
    fun theSwitchesAndTimestampsStick() {
        BackupPrefs.setRequireUnmetered(context, false)
        BackupPrefs.setRequireCharging(context, false)
        BackupPrefs.setAskedBattery(context, true)
        BackupPrefs.markBackedUp(context, 99L)
        assertFalse(BackupPrefs.requireUnmetered(context))
        assertFalse(BackupPrefs.requireCharging(context))
        assertTrue(BackupPrefs.askedBattery(context))
        assertEquals(99L, BackupPrefs.lastBackupAt(context))
    }

    @Test
    fun withoutSecureStorageItFailsClosed() {
        BackupPrefs.storeFactory = { null }
        assertNull(BackupPrefs.token(context))
        assertFalse(BackupPrefs.signedIn(context))
        // Reads fall back to defaults and writes are dropped, never sent to a plain file.
        BackupPrefs.setBackupEnabled(context, false)
        assertTrue(BackupPrefs.backupEnabled(context))
        try {
            BackupPrefs.saveSession(context, "http://luna.local", "tok", "max")
            fail("saving a token with no secure storage must refuse")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("couldn't store the sign-in safely"))
        }
    }
}
