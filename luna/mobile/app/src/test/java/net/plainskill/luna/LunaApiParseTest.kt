package net.plainskill.luna

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class LunaApiParseTest {
    @Test
    fun parseUserReadsUsername() {
        val user = LunaApi.parseUser("""{"id":"u1","username":"max","role":"admin"}""")
        assertEquals("u1", user.id)
        assertEquals("max", user.username)
    }

    @Test
    fun parseUserRejectsNullBody() {
        try {
            LunaApi.parseUser("null")
            fail("expected unauthorized")
        } catch (e: LunaApi.ApiException) {
            assertEquals(401, e.code)
        }
    }

    @Test
    fun parseDrivesSkipsBrokenRows() {
        val drives = LunaApi.parseDrives(
            """[{"id":"d1","label":"Photos"},{"label":"no-id"},{"id":"d2","label":""}]"""
        )
        assertEquals(2, drives.size)
        assertEquals("Photos", drives[0].label)
        assertEquals("d2", drives[1].label)
    }

    @Test
    fun parseFilesKeepsDirsAndFiles() {
        val entries = LunaApi.parseFiles(
            """[{"name":"Family","kind":"dir"},{"name":"pic.jpg","kind":"file"},{"name":"","kind":"dir"}]"""
        )
        assertEquals(2, entries.size)
        assertEquals("Family", entries[0].name)
        assertEquals(true, entries[0].isDir)
        assertEquals("pic.jpg", entries[1].name)
        assertEquals(false, entries[1].isDir)
    }

    @Test
    fun joinPathSkipsBlanksAndSlashes() {
        assertEquals("2026/08", LunaApi.joinPath("", "2026/08"))
        assertEquals("Photos/2026/08", LunaApi.joinPath("Photos", "2026/08"))
        assertEquals("Photos/2026/08", LunaApi.joinPath("/Photos/", "/2026/08/"))
        assertEquals("", LunaApi.joinPath("", "/", "  "))
    }

    @Test
    fun parentPathWalksUp() {
        assertEquals("Photos", LunaApi.parentPath("Photos/Family"))
        assertEquals("", LunaApi.parentPath("Photos"))
        assertEquals("", LunaApi.parentPath(""))
        assertEquals("a/b", LunaApi.parentPath("/a/b/c/"))
    }
}
