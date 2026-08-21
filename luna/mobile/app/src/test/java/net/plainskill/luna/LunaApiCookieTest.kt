package net.plainskill.luna

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LunaApiCookieTest {
    @Test
    fun parsesLunaSessionFromSetCookie() {
        val raw = "luna_session=abc.def; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"
        assertEquals("luna_session=abc.def", LunaApi.parseLunaSessionCookie(raw))
    }

    @Test
    fun ignoresOtherCookies() {
        assertNull(LunaApi.parseLunaSessionCookie("other=value; Path=/"))
        assertNull(LunaApi.parseLunaSessionCookie(null))
        assertNull(LunaApi.parseLunaSessionCookie(""))
    }
}
