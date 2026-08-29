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
}
