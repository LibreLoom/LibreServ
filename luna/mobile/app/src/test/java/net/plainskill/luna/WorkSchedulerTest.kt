package net.plainskill.luna

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class WorkSchedulerTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val wm: WorkManager get() = WorkManager.getInstance(context)

    @Before
    fun setUp() {
        BackupPrefs.storeFactory = { it.getSharedPreferences("test_sched", Context.MODE_PRIVATE) }
        BackupPrefs.clearSession(context)
        WorkManagerTestInitHelper.initializeTestWorkManager(
            context,
            Configuration.Builder().setMinimumLoggingLevel(android.util.Log.DEBUG).build(),
        )
        BackupProgress.idle()
    }

    @After
    fun tearDown() {
        BackupPrefs.clearSession(context)
        BackupPrefs.storeFactory = { null }
    }

    private fun periodic(): List<WorkInfo> = wm.getWorkInfosForUniqueWork("luna-photo-backup").get()
    private fun now(): List<WorkInfo> = wm.getWorkInfosForUniqueWork("luna-photo-backup-now").get()
    private fun live(list: List<WorkInfo>) = list.filter { !it.state.isFinished }

    @Test
    fun nothingIsScheduledUntilSetupIsDone() {
        WorkScheduler.schedule(context)
        assertTrue(periodic().isEmpty())
    }

    @Test
    fun finishingSetupSchedulesTheWi_FiAndChargingBackup() {
        BackupPrefs.setSetupComplete(context, true)
        WorkScheduler.schedule(context)
        val work = live(periodic()).single()
        assertEquals(NetworkType.UNMETERED, work.constraints.requiredNetworkType)
        assertTrue(work.constraints.requiresCharging())
    }

    @Test
    fun theConstraintsFollowThePersonsChoices() {
        BackupPrefs.setSetupComplete(context, true)
        BackupPrefs.setRequireUnmetered(context, false)
        BackupPrefs.setRequireCharging(context, false)
        WorkScheduler.sync(context)
        val work = live(periodic()).single()
        assertEquals(NetworkType.CONNECTED, work.constraints.requiredNetworkType)
        assertTrue(!work.constraints.requiresCharging())
    }

    @Test
    fun changingASettingReplacesTheScheduleInsteadOfAddingAnother() {
        BackupPrefs.setSetupComplete(context, true)
        WorkScheduler.schedule(context)
        BackupPrefs.setRequireUnmetered(context, false)
        WorkScheduler.schedule(context)
        val work = live(periodic())
        assertEquals(1, work.size)
        assertEquals(NetworkType.CONNECTED, work.single().constraints.requiredNetworkType)
    }

    @Test
    fun undoingSetupStopsTheSchedule() {
        BackupPrefs.setSetupComplete(context, true)
        WorkScheduler.schedule(context)
        BackupPrefs.setSetupComplete(context, false)
        WorkScheduler.schedule(context)
        assertTrue(live(periodic()).isEmpty())
    }

    @Test
    fun backupNowDoesNothingBeforeSetup() {
        WorkScheduler.runSoon(context)
        assertTrue(now().isEmpty())
        assertTrue(!BackupProgress.snapshot.running)
    }

    @Test
    fun backupNowStartsAtOnceWithoutWaitingForWi_FiOrCharging() {
        BackupPrefs.setSetupComplete(context, true)
        WorkScheduler.runSoon(context)
        val work = now().single()
        assertEquals(NetworkType.NOT_REQUIRED, work.constraints.requiredNetworkType)
        assertTrue(!work.constraints.requiresCharging())
        // (The test WorkManager runs constraint-free work immediately, so the
        // worker has already finished by now.)
        // It also makes sure the regular schedule exists.
        assertEquals(1, live(periodic()).size)
    }

    @Test
    fun cancelStopsBoth() {
        BackupPrefs.setSetupComplete(context, true)
        WorkScheduler.runSoon(context)
        WorkScheduler.cancel(context)
        assertTrue(live(periodic()).isEmpty())
        assertTrue(live(now()).isEmpty())
    }
}
