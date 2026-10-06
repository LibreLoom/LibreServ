package net.plainskill.luna

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompatTest {
    private fun check(version: Int, oldest: Int, client: Int = 1) =
        Compatibility.check(ApiInfo(version, oldest), client)

    @Test
    fun missingApiMeansLunaIsTooOld() {
        assertEquals(Compat.LUNA_TOO_OLD, Compatibility.check(null))
    }

    @Test
    fun sameVersionIsFine() {
        assertEquals(Compat.OK, check(1, 1))
    }

    @Test
    fun newerLunaThatStillSupportsThisAppIsFine() {
        assertEquals(Compat.OK, check(3, 1, client = 2))
        assertEquals(Compat.OK, check(3, 2, client = 2))
    }

    @Test
    fun appNewerThanLunaMeansLunaIsTooOld() {
        assertEquals(Compat.LUNA_TOO_OLD, check(1, 1, client = 2))
    }

    @Test
    fun lunaNoLongerSupportingThisAppMeansAppIsTooOld() {
        assertEquals(Compat.APP_TOO_OLD, check(3, 2, client = 1))
    }

    @Test
    fun clientApiIsOne() {
        assertEquals(1, CLIENT_API)
    }

    @Test
    fun parsesApiFromHealth() {
        val body = """{"status":"ok","product":"Luna","api":{"version":2,"oldest_supported":1},"uptime_seconds":5}"""
        assertEquals(ApiInfo(2, 1), Compatibility.parseApi(body))
        assertEquals(ApiInfo(2, 1), Compatibility.parseApi("""{"api": { "oldest_supported": 1, "version": 2 }}"""))
    }

    @Test
    fun missingOrMalformedApiParsesToNull() {
        assertNull(Compatibility.parseApi("""{"status":"ok"}"""))
        assertNull(Compatibility.parseApi(""))
        assertNull(Compatibility.parseApi("not json"))
        assertNull(Compatibility.parseApi("""{"api":null}"""))
        assertNull(Compatibility.parseApi("""{"api":"1"}"""))
        assertNull(Compatibility.parseApi("""{"api":{"version":1}}"""))
        assertNull(Compatibility.parseApi("""{"api":{"version":"1","oldest_supported":1}}"""))
        assertNull(Compatibility.parseApi("""{"api":{"version":1.5,"oldest_supported":1}}"""))
        assertNull(Compatibility.parseApi("""{"api":{"version":-1,"oldest_supported":1}}"""))
        assertNull(Compatibility.parseApi("""{"api":{"version":0,"oldest_supported":0}}"""))
        assertNull(Compatibility.parseApi("""{"api":{"version":99999999999,"oldest_supported":1}}"""))
    }

    @Test
    fun messagesTellThePersonWhatToUpdate() {
        assertNull(Compatibility.message(Compat.OK))
        assertTrue(Compatibility.message(Compat.LUNA_TOO_OLD)!!.contains("Update Luna in Settings"))
        assertTrue(Compatibility.message(Compat.APP_TOO_OLD)!!.contains("F-Droid"))
    }
}
