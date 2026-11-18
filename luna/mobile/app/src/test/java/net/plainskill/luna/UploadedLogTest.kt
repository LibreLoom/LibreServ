package net.plainskill.luna

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class UploadedLogTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun itemsAreKeptPerDestinationAndSurviveANewInstance() {
        val file = tmp.root.resolve("uploaded-items.txt")
        val log = UploadedLog(file)
        log.add("http://luna/d1/Photos", "content://media/external/images/media/1:10:123")
        log.add("http://luna/d2/Photos", "content://media/external/images/media/1:10:123")
        log.add("http://luna/d1/Photos", "content://media/external/images/media/2:20:124")
        assertEquals(
            setOf("content://media/external/images/media/1:10:123", "content://media/external/images/media/2:20:124"),
            UploadedLog(file).items("http://luna/d1/Photos"),
        )
        assertEquals(1, UploadedLog(file).items("http://luna/d2/Photos").size)
        // A destination that is a prefix of another must not pick up its items.
        assertTrue(UploadedLog(file).items("http://luna/d1/Photo").isEmpty())
    }

    @Test
    fun aTornLastLineDoesNotSwallowTheNextEntry() {
        val file = tmp.root.resolve("uploaded-items.txt")
        file.writeText("http://luna/d1/Photos\tcontent://media/1:1:1\nhttp://luna/d1/Pho")
        UploadedLog(file).add("http://luna/d1/Photos", "content://media/2:2:2")
        assertEquals(
            setOf("content://media/1:1:1", "content://media/2:2:2"),
            UploadedLog(file).items("http://luna/d1/Photos"),
        )
    }

    @Test
    fun clearForgetsEverything() {
        val file = tmp.root.resolve("uploaded-items.txt")
        UploadedLog(file).add("d", "i")
        UploadedLog(file).clear()
        assertTrue(UploadedLog(file).items("d").isEmpty())
    }
}
